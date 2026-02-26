import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { MarketDataService } from "../../services/MarketDataService";
import { VolumeProfile } from "../../indicators/VolumeProfile";

export class VolumeBreakoutStrategy extends BaseStrategy {
  readonly id = "volume-breakout";
  readonly name = "Volume Surge Breakout Detection";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.NORMAL;

  private marketData = new MarketDataService();

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const spikeMultiplier = this.config.params.spikeMultiplier || 5;
      const priceChangeThreshold =
        this.config.params.priceChangeThreshold || 0.02;

      for (const token of tokens) {
        const candles = await this.marketData.getCandles(token, "1m", 60);
        if (candles.length < 20) continue;

        const volumes = candles.map((c) => c.volume);
        const analysis = VolumeProfile.analyze(
          volumes,
          20,
          spikeMultiplier
        );

        if (!analysis.isSpike) continue;

        // Confirm price is moving with volume
        const closes = candles.map((c) => c.close);
        const recentClose = closes[closes.length - 1];
        const priorClose = closes[closes.length - 4] || closes[0]; // 3 candles back
        const priceChange = (recentClose - priorClose) / priorClose;

        if (priceChange > priceChangeThreshold) {
          // Volume spike + price up = bullish breakout
          const confidence = Math.min(
            1.0,
            analysis.volumeRatio / 10
          );
          signals.push(
            this.createSignal(
              token,
              SignalDirection.BUY,
              confidence,
              {
                volumeRatio: analysis.volumeRatio,
                priceChange,
                currentVolume: analysis.currentVolume,
                emaVolume: analysis.emaVolume,
              },
              2 * 60 * 1000 // 2 min TTL - volume spikes are fleeting
            )
          );
        } else if (priceChange < -priceChangeThreshold) {
          // Volume spike + price down = distribution / sell signal
          const confidence = Math.min(
            1.0,
            analysis.volumeRatio / 10
          );
          signals.push(
            this.createSignal(
              token,
              SignalDirection.SELL,
              confidence,
              {
                volumeRatio: analysis.volumeRatio,
                priceChange,
              },
              2 * 60 * 1000
            )
          );
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }
}
