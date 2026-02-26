import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { WebSocketService } from "../../services/WebSocketService";

export class OrderbookImbalanceStrategy extends BaseStrategy {
  readonly id = "orderbook-imbalance";
  readonly name = "Orderbook Imbalance Micro-Scalping";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.FAST;

  private wsService: WebSocketService | null = null;

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);
    this.wsService = new WebSocketService();
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      if (!this.wsService) return { strategyId: this.id, signals, executionTimeMs: 0 };

      const imbalanceThreshold =
        this.config.params.imbalanceThreshold || 0.6;
      const levels = this.config.params.levels || 5;

      for (const token of tokens) {
        const orderbook = this.wsService.getOrderbook(token);
        if (
          !orderbook ||
          orderbook.bids.length === 0 ||
          orderbook.asks.length === 0
        )
          continue;

        // Calculate bid/ask imbalance in top N levels
        const topBids = orderbook.bids.slice(0, levels);
        const topAsks = orderbook.asks.slice(0, levels);
        const bidVolume = topBids.reduce((sum, b) => sum + b.size, 0);
        const askVolume = topAsks.reduce((sum, a) => sum + a.size, 0);
        const total = bidVolume + askVolume;
        if (total === 0) continue;

        const imbalance = (bidVolume - askVolume) / total;

        // Strong buying pressure
        if (imbalance > imbalanceThreshold) {
          signals.push(
            this.createSignal(
              token,
              SignalDirection.BUY,
              Math.min(1.0, imbalance),
              {
                bidVolume,
                askVolume,
                imbalance,
                levels,
              },
              15 * 1000 // 15 second TTL - extremely short-lived
            )
          );
        }

        // Strong selling pressure
        if (imbalance < -imbalanceThreshold) {
          signals.push(
            this.createSignal(
              token,
              SignalDirection.SELL,
              Math.min(1.0, Math.abs(imbalance)),
              {
                bidVolume,
                askVolume,
                imbalance,
                levels,
              },
              15 * 1000
            )
          );
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }
}
