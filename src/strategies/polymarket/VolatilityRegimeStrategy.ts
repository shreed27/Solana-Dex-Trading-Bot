import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { PriceFeedService } from "../../polymarket/PriceFeedService";
import { PolymarketAsset } from "../../types/polymarket.types";
import { ATR } from "../../indicators/ATR";
import { ADX } from "../../indicators/ADX";
import { RSI } from "../../indicators/RSI";
import { EMA } from "../../indicators/EMA";

/**
 * Volatility regime detection strategy.
 * Classifies market into regimes and adapts signals accordingly:
 * - Low vol + trending: follow trend (momentum)
 * - High vol + trending: stronger trend signals
 * - Low vol + ranging: mean reversion
 * - High vol + ranging: avoid trading (uncertain)
 *
 * Weight: 0.15
 */
export class VolatilityRegimeStrategy extends BaseStrategy {
  readonly id = "poly-volatility-regime";
  readonly name = "Polymarket Volatility Regime";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.SLOW;

  private priceFeed: PriceFeedService;

  constructor(priceFeed: PriceFeedService) {
    super();
    this.priceFeed = priceFeed;
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const assets: PolymarketAsset[] = ["BTC", "ETH", "XRP"];

      for (const asset of assets) {
        if (!this.priceFeed.hasEnoughData(asset, 30)) continue;

        const candles = this.priceFeed.getCandles(asset, 60);
        const closes = candles.map((c) => c.close);
        if (candles.length < 20) continue;

        // Classify volatility regime
        const regime = this.classifyRegime(candles, closes);

        if (regime.action === "skip") continue;

        const direction =
          regime.direction === "up"
            ? SignalDirection.BUY
            : SignalDirection.SELL;

        signals.push(
          this.createSignal(
            asset,
            direction,
            regime.confidence,
            {
              indicator: "VolatilityRegime",
              regime: regime.type,
              adx: regime.adx,
              atrPct: regime.atrPct,
              atrPercentile: regime.atrPercentile,
              rsi: regime.rsi,
              asset,
            },
            4 * 60 * 1000
          )
        );
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }

  private classifyRegime(
    candles: { timestamp: Date; open: number; high: number; low: number; close: number; volume: number }[],
    closes: number[]
  ): {
    type: string;
    direction: "up" | "down";
    confidence: number;
    action: "trade" | "skip";
    adx: number;
    atrPct: number;
    atrPercentile: number;
    rsi: number;
  } {
    const currentPrice = closes[closes.length - 1];
    const adx = ADX.latest(candles, 14);
    const atr = ATR.latest(candles, 14);
    const rsi = RSI.latest(closes, 14);
    const atrPct = atr / currentPrice;

    // Calculate ATR percentile over recent history
    const atrValues = ATR.calculate(candles, 14).filter((v) => !isNaN(v));
    const sortedAtr = [...atrValues].sort((a, b) => a - b);
    const atrPercentile =
      sortedAtr.length > 0
        ? sortedAtr.indexOf(
            sortedAtr.reduce((closest, v) =>
              Math.abs(v - atr) < Math.abs(closest - atr) ? v : closest
            )
          ) / sortedAtr.length
        : 0.5;

    const isTrending = !isNaN(adx) && adx > 25;
    const isHighVol = atrPercentile > 0.7;
    const isLowVol = atrPercentile < 0.3;

    // Determine price direction
    const ema5 = EMA.latest(closes, 5);
    const ema15 = EMA.latest(closes, 15);
    const goingUp = ema5 > ema15;
    const direction = goingUp ? "up" as const : "down" as const;

    // Regime classification
    if (isTrending && isHighVol) {
      // Strong trend with high volatility: high conviction trend follow
      return {
        type: "trend-highvol",
        direction,
        confidence: Math.min(0.85, 0.6 + (adx - 25) * 0.01),
        action: "trade",
        adx: adx || 0,
        atrPct,
        atrPercentile,
        rsi: rsi || 50,
      };
    }

    if (isTrending && !isHighVol) {
      // Trending with normal/low volatility: moderate trend follow
      return {
        type: "trend-lowvol",
        direction,
        confidence: Math.min(0.7, 0.5 + (adx - 25) * 0.008),
        action: "trade",
        adx: adx || 0,
        atrPct,
        atrPercentile,
        rsi: rsi || 50,
      };
    }

    if (!isTrending && isLowVol) {
      // Ranging and quiet: mean reversion opportunity
      // Use RSI for direction in range
      if (!isNaN(rsi)) {
        if (rsi < 35) {
          return {
            type: "range-lowvol",
            direction: "up",
            confidence: 0.55,
            action: "trade",
            adx: adx || 0,
            atrPct,
            atrPercentile,
            rsi,
          };
        }
        if (rsi > 65) {
          return {
            type: "range-lowvol",
            direction: "down",
            confidence: 0.55,
            action: "trade",
            adx: adx || 0,
            atrPct,
            atrPercentile,
            rsi,
          };
        }
      }
    }

    // High vol + no trend = uncertain, skip
    return {
      type: "uncertain",
      direction,
      confidence: 0,
      action: "skip",
      adx: adx || 0,
      atrPct,
      atrPercentile,
      rsi: rsi || 50,
    };
  }
}
