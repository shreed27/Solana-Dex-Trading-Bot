import {
  IArbOpportunity,
  ITrackedOrder,
  IHFTTrade,
  HFTStrategyType,
} from "../types/hft.types";
import { PolymarketClient } from "./PolymarketClient";
import { HFTRiskManager } from "./HFTRiskManager";
import { PerformanceTracker } from "./PerformanceTracker";
import { logger } from "../utils/logger";

/**
 * Fast order lifecycle management for HFT.
 * - Places orders (FOK for arb, GTC for market making)
 * - Tracks open orders
 * - Handles fills and cancellations
 * - Prevents duplicate orders
 */
export class HFTOrderManager {
  private client: PolymarketClient;
  private riskManager: HFTRiskManager;
  private perfTracker: PerformanceTracker;
  private openOrders: Map<string, ITrackedOrder> = new Map();
  private recentOpportunityKeys: Set<string> = new Set();
  private dedupWindowMs: number = 2000; // Don't resubmit same opportunity within 2s

  constructor(
    client: PolymarketClient,
    riskManager: HFTRiskManager,
    perfTracker: PerformanceTracker
  ) {
    this.client = client;
    this.riskManager = riskManager;
    this.perfTracker = perfTracker;
  }

  /**
   * Execute an approved arbitrage opportunity.
   */
  async executeOpportunity(opp: IArbOpportunity): Promise<IHFTTrade | null> {
    // Dedup check
    const dedupKey = `${opp.strategyId}:${opp.tokenId}:${opp.side}:${opp.price}`;
    if (this.recentOpportunityKeys.has(dedupKey)) {
      return null;
    }
    this.recentOpportunityKeys.add(dedupKey);
    setTimeout(() => this.recentOpportunityKeys.delete(dedupKey), this.dedupWindowMs);

    const startTime = Date.now();
    const shares = opp.size / opp.price;

    if (!this.client.isAuthenticated()) {
      // Dry run — simulate the trade
      const simulatedTrade = this.createTradeRecord(opp, shares, startTime, opp.price);
      this.perfTracker.recordTrade(simulatedTrade);
      this.riskManager.recordTrade(simulatedTrade);

      logger.info(
        `[HFT DRY] ${opp.type} ${opp.side} ${opp.asset} @ ${opp.price.toFixed(3)} | $${opp.size.toFixed(2)} | edge: ${(opp.edge * 100).toFixed(2)}% | profit: $${opp.expectedProfit.toFixed(3)}`
      );
      return simulatedTrade;
    }

    // Live execution
    try {
      let result;

      if (opp.orderType === "FOK") {
        // Market order (Fill or Kill) — for arb and latency trades
        result = await this.client.placeMarketOrder(opp.tokenId, opp.side, shares);
      } else {
        // Limit order (GTC) — for market making
        result = await this.client.placeLimitOrder(
          opp.tokenId,
          opp.side,
          opp.price,
          shares
        );
      }

      const fillLatency = Date.now() - startTime;

      if (result.success) {
        const trade = this.createTradeRecord(opp, shares, startTime, opp.price);
        trade.orderId = result.orderID;

        // Track open order if GTC (passive)
        if (opp.orderType === "GTC" && result.orderID) {
          this.openOrders.set(result.orderID, {
            orderId: result.orderID,
            strategyId: opp.strategyId,
            tokenId: opp.tokenId,
            side: opp.side,
            price: opp.price,
            size: opp.size,
            orderType: opp.orderType,
            placedAt: startTime,
            filled: false,
            cancelled: false,
            fillLatencyMs: fillLatency,
          });
        } else {
          // FOK orders are immediately filled or dead
          this.perfTracker.recordTrade(trade);
          this.riskManager.recordTrade(trade);
          this.riskManager.updateInventory(
            opp.asset,
            opp.direction,
            opp.side,
            shares,
            opp.price
          );
        }

        this.riskManager.setOpenOrderCount(this.openOrders.size);

        logger.success(
          `[HFT] ${opp.type} ${opp.side} ${opp.asset} @ ${opp.price.toFixed(3)} | $${opp.size.toFixed(2)} | edge: ${(opp.edge * 100).toFixed(2)}% | latency: ${fillLatency}ms`
        );

        return trade;
      } else {
        logger.warning(`[HFT] Order failed: ${result.errorMsg}`);
        return null;
      }
    } catch (err) {
      logger.error("[HFT] Execution error:", err);
      return null;
    }
  }

  /**
   * Cancel a specific open order.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    const order = this.openOrders.get(orderId);
    if (!order) return false;

    const success = await this.client.cancelOrder(orderId);
    if (success) {
      order.cancelled = true;
      this.openOrders.delete(orderId);
      this.riskManager.setOpenOrderCount(this.openOrders.size);
    }
    return success;
  }

  /**
   * Cancel all open orders.
   */
  async cancelAllOrders(): Promise<number> {
    let cancelled = 0;
    for (const [orderId] of this.openOrders) {
      const success = await this.client.cancelOrder(orderId);
      if (success) cancelled++;
    }
    this.openOrders.clear();
    this.riskManager.setOpenOrderCount(0);
    return cancelled;
  }

  /**
   * Cancel stale orders older than maxAgeMs.
   */
  async cancelStaleOrders(maxAgeMs: number = 30_000): Promise<number> {
    const now = Date.now();
    let cancelled = 0;
    for (const [orderId, order] of this.openOrders) {
      if (now - order.placedAt > maxAgeMs) {
        const success = await this.client.cancelOrder(orderId);
        if (success) {
          this.openOrders.delete(orderId);
          cancelled++;
        }
      }
    }
    this.riskManager.setOpenOrderCount(this.openOrders.size);
    return cancelled;
  }

  /**
   * Cancel orders that have drifted too far from current mid price.
   */
  async cancelDriftedOrders(currentMid: number, maxDrift: number = 0.02): Promise<number> {
    let cancelled = 0;
    for (const [orderId, order] of this.openOrders) {
      if (Math.abs(order.price - currentMid) > maxDrift) {
        const success = await this.client.cancelOrder(orderId);
        if (success) {
          this.openOrders.delete(orderId);
          cancelled++;
        }
      }
    }
    this.riskManager.setOpenOrderCount(this.openOrders.size);
    return cancelled;
  }

  getOpenOrderCount(): number {
    return this.openOrders.size;
  }

  getOpenOrders(): ITrackedOrder[] {
    return Array.from(this.openOrders.values());
  }

  private createTradeRecord(
    opp: IArbOpportunity,
    shares: number,
    startTime: number,
    fillPrice: number
  ): IHFTTrade {
    return {
      id: `hft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      strategy: opp.type,
      strategyId: opp.strategyId,
      asset: opp.asset,
      interval: opp.interval,
      conditionId: opp.conditionId,
      direction: opp.direction,
      tokenId: opp.tokenId,
      side: opp.side,
      entryPrice: fillPrice,
      size: opp.size,
      shares,
      pnl: opp.expectedProfit,
      holdTimeMs: 0, // Instant for FOK, tracked by position manager for GTC
      openedAt: startTime,
      closedAt: Date.now(),
    };
  }
}
