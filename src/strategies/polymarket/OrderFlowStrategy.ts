import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { PolymarketClient } from "../../polymarket/PolymarketClient";
import { MarketDiscoveryService } from "../../polymarket/MarketDiscoveryService";
import { PolymarketAsset, PolymarketInterval } from "../../types/polymarket.types";
import { logger } from "../../utils/logger";

/**
 * Analyzes CLOB orderbook imbalance for YES/NO tokens.
 * If YES bid depth >> NO bid depth, smart money is betting UP.
 *
 * Weight: 0.15
 */
export class OrderFlowStrategy extends BaseStrategy {
  readonly id = "poly-order-flow";
  readonly name = "Polymarket Order Flow Analysis";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.FAST;

  private client: PolymarketClient;
  private discovery: MarketDiscoveryService;

  constructor(
    client: PolymarketClient,
    discovery: MarketDiscoveryService
  ) {
    super();
    this.client = client;
    this.discovery = discovery;
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const assets: PolymarketAsset[] = ["BTC", "ETH", "XRP"];
      const intervals: PolymarketInterval[] = ["5M", "15M"];

      for (const asset of assets) {
        for (const interval of intervals) {
          const market = this.discovery.getCurrentMarket(asset, interval);
          if (!market || !market.yesTokenId || !market.noTokenId) continue;

          try {
            const [yesBook, noBook] = await Promise.all([
              this.client.getOrderbook(market.yesTokenId),
              this.client.getOrderbook(market.noTokenId),
            ]);

            if (!yesBook || !noBook) continue;

            // Calculate bid-side depth (buying pressure)
            const yesBidDepth = this.calcDepth(yesBook.bids, 5);
            const noBidDepth = this.calcDepth(noBook.bids, 5);

            // Calculate ask-side depth (selling pressure)
            const yesAskDepth = this.calcDepth(yesBook.asks, 5);
            const noAskDepth = this.calcDepth(noBook.asks, 5);

            // Imbalance analysis
            const totalBids = yesBidDepth + noBidDepth;
            if (totalBids === 0) continue;

            const yesBidRatio = yesBidDepth / totalBids;
            const noBidRatio = noBidDepth / totalBids;

            // Orderbook imbalance: more YES bids = bullish
            const imbalance = yesBidRatio - noBidRatio;
            const imbalanceThreshold =
              this.config.params.imbalanceThreshold || 0.15;

            // Also check bid vs ask within each token (buying vs selling)
            const yesBidAskRatio =
              yesAskDepth > 0 ? yesBidDepth / yesAskDepth : 1;
            const noBidAskRatio =
              noAskDepth > 0 ? noBidDepth / noAskDepth : 1;

            if (imbalance > imbalanceThreshold) {
              // More buying pressure on YES side → bullish
              const confidence = Math.min(
                0.85,
                0.45 + imbalance * 1.5 + (yesBidAskRatio > 1.5 ? 0.1 : 0)
              );
              signals.push(
                this.createSignal(
                  asset,
                  SignalDirection.BUY,
                  confidence,
                  {
                    indicator: "OrderFlow",
                    yesBidDepth,
                    noBidDepth,
                    imbalance,
                    yesBidAskRatio,
                    interval,
                    conditionId: market.conditionId,
                    asset,
                  },
                  2 * 60 * 1000
                )
              );
            } else if (imbalance < -imbalanceThreshold) {
              // More buying pressure on NO side → bearish
              const confidence = Math.min(
                0.85,
                0.45 + Math.abs(imbalance) * 1.5 +
                  (noBidAskRatio > 1.5 ? 0.1 : 0)
              );
              signals.push(
                this.createSignal(
                  asset,
                  SignalDirection.SELL,
                  confidence,
                  {
                    indicator: "OrderFlow",
                    yesBidDepth,
                    noBidDepth,
                    imbalance,
                    noBidAskRatio,
                    interval,
                    conditionId: market.conditionId,
                    asset,
                  },
                  2 * 60 * 1000
                )
              );
            }
          } catch (err) {
            // Skip on API error
          }
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }

  /**
   * Calculate total depth from top N levels of orderbook.
   */
  private calcDepth(
    levels: { price: string; size: string }[],
    topN: number
  ): number {
    return levels
      .slice(0, topN)
      .reduce(
        (sum, level) =>
          sum + parseFloat(level.price) * parseFloat(level.size),
        0
      );
  }
}
