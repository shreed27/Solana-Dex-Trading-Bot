import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { MarketDataService } from "../../services/MarketDataService";
import { MACD } from "../../indicators/MACD";
import { RSI } from "../../indicators/RSI";
import { Token } from "../../models/Token";

export class MACDMomentumStrategy extends BaseStrategy {
  readonly id = "macd-momentum";
  readonly name = "MACD & RSI Momentum Crossover";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.NORMAL;

  private marketData = new MarketDataService();

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];

      // Filter to mid-cap tokens ($10M-$50M)
      const mcapMin = this.config.params.mcapMin || 10_000_000;
      const mcapMax = this.config.params.mcapMax || 50_000_000;
      const midCapTokens = await Token.find({
        address: { $in: tokens },
        mcap: { $gte: mcapMin, $lte: mcapMax },
      }).exec();

      for (const token of midCapTokens) {
        const candles = await this.marketData.getCandles(
          token.address,
          "1m",
          50
        );
        if (candles.length < 26) continue;

        const closes = candles.map((c) => c.close);
        const macdResult = MACD.calculate(closes, 12, 26, 9);
        const rsiValues = RSI.calculate(closes, 14);
        const currentRsi = rsiValues[rsiValues.length - 1];

        if (isNaN(currentRsi)) continue;

        // BUY: MACD bullish crossover + RSI not overbought
        if (
          MACD.isBullishCrossover(macdResult.histogram) &&
          currentRsi < 70 &&
          currentRsi > 30
        ) {
          const confidence = this.calcConfidence(
            macdResult.histogram,
            currentRsi,
            "buy"
          );
          signals.push(
            this.createSignal(
              token.address,
              SignalDirection.BUY,
              confidence,
              {
                macdHistogram: macdResult.histogram.slice(-3),
                rsi: currentRsi,
                crossoverType: "bullish",
              },
              5 * 60 * 1000 // 5 min TTL
            )
          );
        }

        // SELL: MACD bearish crossover + RSI elevated
        if (
          MACD.isBearishCrossover(macdResult.histogram) &&
          currentRsi > 60
        ) {
          const confidence = this.calcConfidence(
            macdResult.histogram,
            currentRsi,
            "sell"
          );
          signals.push(
            this.createSignal(
              token.address,
              SignalDirection.SELL,
              confidence,
              {
                macdHistogram: macdResult.histogram.slice(-3),
                rsi: currentRsi,
                crossoverType: "bearish",
              },
              5 * 60 * 1000
            )
          );
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
    // Stronger histogram divergence = higher confidence
    const histStrength = Math.min(
      1,
      Math.abs(histogram[histogram.length - 1]) * 100
    );
    // RSI distance from extremes = higher confidence
    const rsiConf =
      direction === "buy"
        ? (70 - rsi) / 40 // Further from overbought = better
        : (rsi - 30) / 40; // Further from oversold = better for sell

    return Math.min(1.0, (histStrength * 0.6 + rsiConf * 0.4));
  }
}
