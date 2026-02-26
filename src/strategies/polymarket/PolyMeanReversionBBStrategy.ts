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
import { BollingerBands } from "../../indicators/BollingerBands";
import { ADX } from "../../indicators/ADX";

/**
 * Mean reversion with Bollinger Bands adapted for Polymarket.
 * Trades reversals when price hits BB extremes in ranging markets.
 */
export class PolyMeanReversionBBStrategy extends BaseStrategy {
  readonly id = "poly-mean-reversion-bb";
  readonly name = "Polymarket BB Mean Reversion";
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
      const bbPeriod = this.config.params.bbPeriod || 20;
      const bbStdDev = this.config.params.bbStdDev || 2;
      const adxThreshold = this.config.params.adxThreshold || 25;

      for (const asset of assets) {
        if (!this.priceFeed.hasEnoughData(asset, bbPeriod + 5)) continue;

        const candles = this.priceFeed.getCandles(asset, 50);
        if (candles.length < bbPeriod) continue;

        const closes = candles.map((c) => c.close);
        const currentPrice = closes[closes.length - 1];

        // Only trade in ranging markets (low ADX)
        const adxValue = ADX.latest(candles, 14);
        if (isNaN(adxValue) || adxValue > adxThreshold) continue;

        const bb = BollingerBands.latest(closes, bbPeriod, bbStdDev);
        if (isNaN(bb.upper)) continue;

        // BUY (expecting bounce UP): price at lower band
        if (currentPrice <= bb.lower) {
          const distFromLower =
            bb.middle === bb.lower
              ? 0.5
              : (bb.middle - currentPrice) / (bb.middle - bb.lower);
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.BUY,
              Math.min(1.0, distFromLower * 0.75),
              {
                indicator: "BollingerBands",
                adx: adxValue,
                bbPosition: "lower",
                percentB: bb.percentB,
                bandwidth: bb.bandwidth,
                price: currentPrice,
                bands: { upper: bb.upper, middle: bb.middle, lower: bb.lower },
                asset,
              },
              4 * 60 * 1000
            )
          );
        }

        // SELL (expecting reversal DOWN): price at upper band
        if (currentPrice >= bb.upper) {
          const distFromUpper =
            bb.upper === bb.middle
              ? 0.5
              : (currentPrice - bb.middle) / (bb.upper - bb.middle);
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.SELL,
              Math.min(1.0, distFromUpper * 0.75),
              {
                indicator: "BollingerBands",
                adx: adxValue,
                bbPosition: "upper",
                percentB: bb.percentB,
                bandwidth: bb.bandwidth,
                price: currentPrice,
                bands: { upper: bb.upper, middle: bb.middle, lower: bb.lower },
                asset,
              },
              4 * 60 * 1000
            )
          );
        }

        // Squeeze detection: bandwidth contracting significantly
        if (bb.bandwidth > 0) {
          const allBB = BollingerBands.calculate(closes, bbPeriod, bbStdDev);
          const recentBandwidths = allBB.slice(-10).map((b) => b.bandwidth);
          const validBandwidths = recentBandwidths.filter((b) => !isNaN(b));
          if (validBandwidths.length >= 5) {
            const avgBandwidth =
              validBandwidths.reduce((s, v) => s + v, 0) /
              validBandwidths.length;
            const currentBW = validBandwidths[validBandwidths.length - 1];
            // Squeeze = current bandwidth < 60% of recent average
            if (currentBW < avgBandwidth * 0.6) {
              // Squeeze breakout imminent, use price direction for signal
              const last3 = closes.slice(-3);
              const trend = last3[2] - last3[0];
              const dir =
                trend > 0 ? SignalDirection.BUY : SignalDirection.SELL;
              signals.push(
                this.createSignal(
                  asset,
                  dir,
                  0.50, // Lower confidence for squeeze prediction
                  {
                    indicator: "BollingerBands",
                    type: "squeeze",
                    squeezeRatio: currentBW / avgBandwidth,
                    asset,
                  },
                  3 * 60 * 1000
                )
              );
            }
          }
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }
}
