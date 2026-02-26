import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { MarketDataService } from "../../services/MarketDataService";
import { BollingerBands } from "../../indicators/BollingerBands";
import { ADX } from "../../indicators/ADX";

export class MeanReversionBBStrategy extends BaseStrategy {
  readonly id = "mean-reversion-bb";
  readonly name = "Mean Reversion with Bollinger Bands";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.NORMAL;

  private marketData = new MarketDataService();

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const bbPeriod = this.config.params.bbPeriod || 20;
      const bbStdDev = this.config.params.bbStdDev || 2;
      const adxThreshold = this.config.params.adxThreshold || 25;

      for (const token of tokens) {
        const candles = await this.marketData.getCandles(token, "5m", 50);
        if (candles.length < bbPeriod) continue;

        const closes = candles.map((c) => c.close);
        const currentPrice = closes[closes.length - 1];

        // Check ADX - only trade in ranging markets
        const adxValue = ADX.latest(candles, 14);
        if (isNaN(adxValue) || adxValue > adxThreshold) continue;

        const bb = BollingerBands.latest(closes, bbPeriod, bbStdDev);
        if (isNaN(bb.upper)) continue;

        // BUY: price at or below lower band (oversold in range)
        if (currentPrice <= bb.lower) {
          const distFromLower =
            bb.middle === bb.lower
              ? 0.5
              : (bb.middle - currentPrice) /
                (bb.middle - bb.lower);
          signals.push(
            this.createSignal(
              token,
              SignalDirection.BUY,
              Math.min(1.0, distFromLower * 0.8),
              {
                adx: adxValue,
                bbPosition: "lower",
                percentB: bb.percentB,
                bandwidth: bb.bandwidth,
                price: currentPrice,
                lowerBand: bb.lower,
                middleBand: bb.middle,
              },
              5 * 60 * 1000
            )
          );
        }

        // SELL: price at or above upper band (overbought in range)
        if (currentPrice >= bb.upper) {
          const distFromUpper =
            bb.upper === bb.middle
              ? 0.5
              : (currentPrice - bb.middle) /
                (bb.upper - bb.middle);
          signals.push(
            this.createSignal(
              token,
              SignalDirection.SELL,
              Math.min(1.0, distFromUpper * 0.8),
              {
                adx: adxValue,
                bbPosition: "upper",
                percentB: bb.percentB,
                bandwidth: bb.bandwidth,
                price: currentPrice,
                upperBand: bb.upper,
                middleBand: bb.middle,
              },
              5 * 60 * 1000
            )
          );
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }
}
