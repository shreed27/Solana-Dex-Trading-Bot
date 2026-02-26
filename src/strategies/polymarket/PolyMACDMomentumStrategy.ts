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
import { MACD } from "../../indicators/MACD";
import { RSI } from "../../indicators/RSI";

/**
 * MACD + RSI strategy adapted for Polymarket.
 * Uses Binance candles for BTC/ETH/XRP.
 * BUY = price going UP → buy YES token
 * SELL = price going DOWN → buy NO token
 */
export class PolyMACDMomentumStrategy extends BaseStrategy {
  readonly id = "poly-macd-momentum";
  readonly name = "Polymarket MACD & RSI Momentum";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.NORMAL;

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

        const candles = this.priceFeed.getCandles(asset, 50);
        const closes = candles.map((c) => c.close);
        if (closes.length < 26) continue;

        const macdResult = MACD.calculate(closes, 12, 26, 9);
        const rsiValues = RSI.calculate(closes, 14);
        const currentRsi = rsiValues[rsiValues.length - 1];
        if (isNaN(currentRsi)) continue;

        const histogram = macdResult.histogram;
        const lastHist = histogram[histogram.length - 1];
        const prevHist = histogram[histogram.length - 2];

        // BUY (UP): Bullish MACD crossover + RSI confirmation
        if (
          MACD.isBullishCrossover(histogram) &&
          currentRsi > 40 &&
          currentRsi < 70
        ) {
          const confidence = this.calcConfidence(histogram, currentRsi, "buy");
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.BUY,
              confidence,
              {
                indicator: "MACD",
                macdHistogram: histogram.slice(-3),
                rsi: currentRsi,
                crossoverType: "bullish",
                asset,
              },
              3 * 60 * 1000 // 3 min TTL for 5M markets
            )
          );
        }

        // SELL (DOWN): Bearish MACD crossover + RSI confirmation
        if (
          MACD.isBearishCrossover(histogram) &&
          currentRsi > 30 &&
          currentRsi < 60
        ) {
          const confidence = this.calcConfidence(histogram, currentRsi, "sell");
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.SELL,
              confidence,
              {
                indicator: "MACD",
                macdHistogram: histogram.slice(-3),
                rsi: currentRsi,
                crossoverType: "bearish",
                asset,
              },
              3 * 60 * 1000
            )
          );
        }

        // Strong momentum (no crossover needed if histogram is extreme)
        if (Math.abs(lastHist) > Math.abs(prevHist) * 1.5 && !isNaN(prevHist)) {
          const direction =
            lastHist > 0 ? SignalDirection.BUY : SignalDirection.SELL;
          const rsiAligned =
            direction === SignalDirection.BUY
              ? currentRsi > 50 && currentRsi < 75
              : currentRsi < 50 && currentRsi > 25;

          if (rsiAligned) {
            signals.push(
              this.createSignal(
                asset,
                direction,
                0.55, // Lower confidence for momentum-only
                {
                  indicator: "MACD",
                  type: "strong-momentum",
                  histAcceleration: Math.abs(lastHist / (prevHist || 0.001)),
                  rsi: currentRsi,
                  asset,
                },
                2 * 60 * 1000
              )
            );
          }
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }

  private calcConfidence(
    histogram: number[],
    rsi: number,
    direction: "buy" | "sell"
  ): number {
    const histStrength = Math.min(
      1,
      Math.abs(histogram[histogram.length - 1]) * 50
    );
    const rsiConf =
      direction === "buy"
        ? (70 - rsi) / 40
        : (rsi - 30) / 40;
    return Math.min(1.0, histStrength * 0.6 + rsiConf * 0.4);
  }
}
