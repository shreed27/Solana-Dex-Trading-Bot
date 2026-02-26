import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { PriceFeedService } from "../../polymarket/PriceFeedService";
import { MarketDiscoveryService } from "../../polymarket/MarketDiscoveryService";
import { PolymarketAsset, PolymarketInterval } from "../../types/polymarket.types";
import { MACD } from "../../indicators/MACD";
import { RSI } from "../../indicators/RSI";
import { EMA } from "../../indicators/EMA";
import { ADX } from "../../indicators/ADX";

/**
 * Core Polymarket strategy: compares indicator-based probability estimate
 * against YES/NO token pricing to find edges.
 *
 * If indicators suggest 70% chance UP but YES token priced at 0.55 (55%),
 * there's a 15% probability edge.
 *
 * Weight: 0.25 (highest)
 */
export class ProbabilityEdgeStrategy extends BaseStrategy {
  readonly id = "poly-probability-edge";
  readonly name = "Probability Edge Detector";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.NORMAL;

  private priceFeed: PriceFeedService;
  private discovery: MarketDiscoveryService;

  constructor(
    priceFeed: PriceFeedService,
    discovery: MarketDiscoveryService
  ) {
    super();
    this.priceFeed = priceFeed;
    this.discovery = discovery;
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const assets: PolymarketAsset[] = ["BTC", "ETH", "XRP"];
      const intervals: PolymarketInterval[] = ["5M", "15M"];

      for (const asset of assets) {
        if (!this.priceFeed.hasEnoughData(asset, 30)) continue;

        const candles = this.priceFeed.getCandles(asset, 60);
        const closes = candles.map((c) => c.close);
        if (closes.length < 26) continue;

        // Calculate our probability estimate from multiple indicators
        const upProbability = this.estimateUpProbability(candles, closes);

        for (const interval of intervals) {
          const market = this.discovery.getCurrentMarket(asset, interval);
          if (!market) continue;

          const marketYesPrice = market.yesPrice;
          const marketNoPrice = market.noPrice;

          // Edge on YES side (betting UP)
          const yesEdge = upProbability - marketYesPrice;
          // Edge on NO side (betting DOWN)
          const noEdge = (1 - upProbability) - marketNoPrice;

          const minEdge = this.config.params.minEdge || 0.08;

          if (yesEdge > minEdge) {
            // Our model says UP is more likely than the market thinks
            const confidence = Math.min(
              1.0,
              0.5 + yesEdge * 2 // Scale edge to confidence
            );
            signals.push(
              this.createSignal(
                asset,
                SignalDirection.BUY,
                confidence,
                {
                  indicator: "ProbabilityEdge",
                  ourEstimate: upProbability,
                  marketPrice: marketYesPrice,
                  edge: yesEdge,
                  interval,
                  conditionId: market.conditionId,
                  asset,
                },
                3 * 60 * 1000
              )
            );
          }

          if (noEdge > minEdge) {
            // Our model says DOWN is more likely than the market thinks
            const confidence = Math.min(
              1.0,
              0.5 + noEdge * 2
            );
            signals.push(
              this.createSignal(
                asset,
                SignalDirection.SELL,
                confidence,
                {
                  indicator: "ProbabilityEdge",
                  ourEstimate: 1 - upProbability,
                  marketPrice: marketNoPrice,
                  edge: noEdge,
                  interval,
                  conditionId: market.conditionId,
                  asset,
                },
                3 * 60 * 1000
              )
            );
          }
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }

  /**
   * Estimate probability of price going UP using multiple indicators.
   * Returns 0.0 to 1.0.
   */
  private estimateUpProbability(
    candles: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[],
    closes: number[]
  ): number {
    let upVotes = 0;
    let totalWeight = 0;

    // 1. MACD direction (weight: 0.3)
    const macd = MACD.calculate(closes, 12, 26, 9);
    const lastHist = macd.histogram[macd.histogram.length - 1];
    const prevHist = macd.histogram[macd.histogram.length - 2];
    if (!isNaN(lastHist) && !isNaN(prevHist)) {
      const macdScore =
        lastHist > 0
          ? 0.5 + Math.min(0.5, lastHist * 20)
          : 0.5 - Math.min(0.5, Math.abs(lastHist) * 20);
      // Acceleration bonus
      const accel = lastHist > prevHist ? 0.05 : -0.05;
      upVotes += (macdScore + accel) * 0.3;
      totalWeight += 0.3;
    }

    // 2. RSI (weight: 0.2)
    const rsi = RSI.latest(closes, 14);
    if (!isNaN(rsi)) {
      // RSI 50 = neutral, <30 = oversold (likely up), >70 = overbought (likely down)
      let rsiScore: number;
      if (rsi < 30) rsiScore = 0.7; // Oversold = more likely up
      else if (rsi > 70) rsiScore = 0.3; // Overbought = more likely down
      else rsiScore = 0.3 + (rsi - 30) * 0.01; // Linear in the middle
      upVotes += rsiScore * 0.2;
      totalWeight += 0.2;
    }

    // 3. EMA trend (weight: 0.25)
    const ema5 = EMA.latest(closes, 5);
    const ema15 = EMA.latest(closes, 15);
    if (ema5 > 0 && ema15 > 0) {
      const emaTrend = (ema5 - ema15) / ema15;
      const emaScore = 0.5 + Math.min(0.4, Math.max(-0.4, emaTrend * 100));
      upVotes += emaScore * 0.25;
      totalWeight += 0.25;
    }

    // 4. Price momentum (weight: 0.15)
    if (closes.length >= 5) {
      const momentum =
        (closes[closes.length - 1] - closes[closes.length - 5]) /
        closes[closes.length - 5];
      const momScore = 0.5 + Math.min(0.4, Math.max(-0.4, momentum * 50));
      upVotes += momScore * 0.15;
      totalWeight += 0.15;
    }

    // 5. ADX trend strength (weight: 0.1)
    const adx = ADX.latest(candles, 14);
    if (!isNaN(adx)) {
      // High ADX with upward momentum = stronger conviction
      if (adx > 25 && closes[closes.length - 1] > closes[closes.length - 3]) {
        upVotes += 0.65 * 0.1; // Trending up
      } else if (adx > 25) {
        upVotes += 0.35 * 0.1; // Trending down
      } else {
        upVotes += 0.5 * 0.1; // No trend = coin flip
      }
      totalWeight += 0.1;
    }

    return totalWeight > 0
      ? Math.min(0.95, Math.max(0.05, upVotes / totalWeight))
      : 0.5;
  }
}
