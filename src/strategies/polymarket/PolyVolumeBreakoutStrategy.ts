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
import { VolumeProfile } from "../../indicators/VolumeProfile";

/**
 * Volume breakout strategy adapted for Polymarket.
 * Detects volume spikes on Binance as directional signals.
 */
export class PolyVolumeBreakoutStrategy extends BaseStrategy {
  readonly id = "poly-volume-breakout";
  readonly name = "Polymarket Volume Surge Breakout";
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
      const spikeMultiplier = this.config.params.spikeMultiplier || 3;
      const priceChangeThreshold =
        this.config.params.priceChangeThreshold || 0.001; // 0.1% for crypto

      for (const asset of assets) {
        if (!this.priceFeed.hasEnoughData(asset, 20)) continue;

        const candles = this.priceFeed.getCandles(asset, 30);
        if (candles.length < 20) continue;

        const volumes = candles.map((c) => c.volume);
        const closes = candles.map((c) => c.close);
        const analysis = VolumeProfile.analyze(volumes, 20, spikeMultiplier);

        if (!analysis.isSpike) continue;

        // Check price direction with volume
        const recentClose = closes[closes.length - 1];
        const priorClose = closes[Math.max(0, closes.length - 4)];
        const priceChange = (recentClose - priorClose) / priorClose;

        // Volume trend adds conviction
        const volumeTrend = VolumeProfile.trend(volumes, 10);

        if (priceChange > priceChangeThreshold) {
          const confidence = Math.min(
            1.0,
            (analysis.volumeRatio / 8) * 0.7 +
              Math.min(1, Math.abs(priceChange) * 100) * 0.3
          );
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.BUY,
              confidence,
              {
                indicator: "Volume",
                volumeRatio: analysis.volumeRatio,
                priceChange,
                volumeTrend,
                asset,
              },
              2 * 60 * 1000 // 2 min TTL
            )
          );
        } else if (priceChange < -priceChangeThreshold) {
          const confidence = Math.min(
            1.0,
            (analysis.volumeRatio / 8) * 0.7 +
              Math.min(1, Math.abs(priceChange) * 100) * 0.3
          );
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.SELL,
              confidence,
              {
                indicator: "Volume",
                volumeRatio: analysis.volumeRatio,
                priceChange,
                volumeTrend,
                asset,
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
