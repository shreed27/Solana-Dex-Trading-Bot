import {
  PolymarketAsset,
  PolymarketDirection,
  PolymarketInterval,
  PolymarketOutcome,
} from "../types/polymarket.types";
import { PolymarketPositionModel } from "../models/PolymarketPosition";
import { PolymarketClient } from "./PolymarketClient";
import { PolymarketRiskManager } from "./PolymarketRiskManager";
import { logger } from "../utils/logger";

interface OpenPositionParams {
  marketId: string;
  conditionId: string;
  asset: PolymarketAsset;
  interval: PolymarketInterval;
  direction: PolymarketDirection;
  tokenId: string;
  entryPrice: number;
  size: number;
  shares: number;
  marketStartTime: Date;
  marketEndTime: Date;
  entrySignals: {
    strategyId: string;
    confidence: number;
    timestamp: Date;
  }[];
  compositeScore: number;
  orderId?: string;
}

/**
 * Manages Polymarket position lifecycle:
 * - Opening positions
 * - Tracking open positions
 * - Resolving positions when markets settle
 * - Computing P&L
 */
export class PolymarketPositionManager {
  private client: PolymarketClient;
  private riskManager: PolymarketRiskManager;
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    client: PolymarketClient,
    riskManager: PolymarketRiskManager
  ) {
    this.client = client;
    this.riskManager = riskManager;
  }

  async initialize(): Promise<void> {
    // Check for positions that should have resolved while we were offline
    await this.resolveExpiredPositions();

    // Poll every 15 seconds to resolve expired positions
    this.intervalHandle = setInterval(
      () => this.resolveExpiredPositions(),
      15_000
    );

    logger.info("PolymarketPositionManager initialized");
  }

  async shutdown(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Record a new open position.
   */
  async openPosition(params: OpenPositionParams): Promise<string> {
    const doc = await PolymarketPositionModel.create({
      marketId: params.marketId,
      conditionId: params.conditionId,
      asset: params.asset,
      interval: params.interval,
      direction: params.direction,
      tokenId: params.tokenId,
      entryPrice: params.entryPrice,
      size: params.size,
      shares: params.shares,
      marketStartTime: params.marketStartTime,
      marketEndTime: params.marketEndTime,
      resolved: false,
      entrySignals: params.entrySignals,
      compositeScore: params.compositeScore,
      orderId: params.orderId,
      status: "open",
    });

    logger.info(
      `Position opened: ${params.direction} ${params.asset} ${params.interval} | $${params.size.toFixed(2)} @ ${params.entryPrice.toFixed(3)}`
    );

    return doc.id;
  }

  /**
   * Close a position early (sell tokens before resolution).
   */
  async closePosition(positionId: string): Promise<number> {
    const position = await PolymarketPositionModel.findById(positionId);
    if (!position || position.status !== "open") {
      return 0;
    }

    // Get current token price
    const currentPrice = await this.client.getMidPrice(position.tokenId);
    if (!currentPrice) {
      logger.error(`Cannot get price for position ${positionId}`);
      return 0;
    }

    // Sell tokens if authenticated
    if (this.client.isAuthenticated()) {
      const result = await this.client.placeMarketOrder(
        position.tokenId,
        "SELL",
        position.shares
      );
      if (!result.success) {
        logger.error(`Failed to sell position: ${result.errorMsg}`);
        return 0;
      }
      position.exitOrderId = result.orderID;
    }

    // Calculate P&L
    const exitValue = position.shares * currentPrice;
    const pnl = exitValue - position.size;

    position.exitPrice = currentPrice;
    position.pnl = pnl;
    position.closedAt = new Date();
    position.status = "closed";
    await position.save();

    this.riskManager.recordPnl(pnl);

    logger.info(
      `Position closed: ${position.direction} ${position.asset} | P&L: $${pnl.toFixed(2)} (${((pnl / position.size) * 100).toFixed(1)}%)`
    );

    return pnl;
  }

  /**
   * Resolve positions whose markets have ended.
   * In prediction markets, tokens pay $1 (correct) or $0 (wrong).
   */
  async resolveExpiredPositions(): Promise<void> {
    const now = new Date();
    const expiredPositions = await PolymarketPositionModel.find({
      status: "open",
      marketEndTime: { $lte: now },
    });

    for (const position of expiredPositions) {
      try {
        // Try to get resolution from the market
        const marketData = await this.client.getMarket(
          position.conditionId
        );

        if (marketData?.resolved || marketData?.closed) {
          // Determine outcome
          const outcome = this.determineOutcome(marketData);
          const won = this.didPositionWin(position.direction as PolymarketDirection, outcome);

          // Calculate P&L: winning = shares * $1 - cost; losing = -cost
          const pnl = won
            ? position.shares * 1.0 - position.size
            : -position.size;

          position.resolved = true;
          position.outcome = outcome;
          position.pnl = pnl;
          position.closedAt = new Date();
          position.status = "resolved";
          await position.save();

          this.riskManager.recordPnl(pnl);

          const emoji = won ? "WIN" : "LOSS";
          logger.info(
            `Position resolved [${emoji}]: ${position.direction} ${position.asset} ${position.interval} | outcome: ${outcome} | P&L: $${pnl.toFixed(2)}`
          );
        } else {
          // Market hasn't resolved yet, mark stale but keep checking
          // Add 30s grace period before marking as timed out
          const graceMs = 30_000;
          if (
            now.getTime() - position.marketEndTime.getTime() > graceMs &&
            !marketData
          ) {
            // Can't determine outcome, assume worst case
            position.resolved = true;
            position.pnl = -position.size;
            position.closedAt = new Date();
            position.status = "resolved";
            await position.save();
            this.riskManager.recordPnl(-position.size);
            logger.warning(
              `Position timed out (no resolution data): ${position.conditionId}`
            );
          }
        }
      } catch (err) {
        logger.error(
          `Error resolving position ${position.conditionId}:`,
          err
        );
      }
    }
  }

  /**
   * Determine market outcome from raw market data.
   */
  private determineOutcome(
    marketData: any
  ): PolymarketOutcome {
    // Check various outcome formats from Polymarket
    const outcome = marketData.outcome || marketData.resolution;
    if (outcome === "Yes" || outcome === "Up" || outcome === "YES") {
      return "UP";
    }
    if (outcome === "No" || outcome === "Down" || outcome === "NO") {
      return "DOWN";
    }

    // Check by token prices: winning token goes to ~1.0
    const yesPrice = parseFloat(
      marketData.outcomePrices?.[0] || "0.5"
    );
    if (yesPrice > 0.9) return "UP";
    if (yesPrice < 0.1) return "DOWN";

    // Fallback based on title keywords or default
    return "DOWN";
  }

  /**
   * Check if a position won based on direction and outcome.
   * YES + UP = win, YES + DOWN = lose
   * NO + DOWN = win, NO + UP = lose
   */
  private didPositionWin(
    direction: PolymarketDirection,
    outcome: PolymarketOutcome
  ): boolean {
    if (direction === "YES" && outcome === "UP") return true;
    if (direction === "NO" && outcome === "DOWN") return true;
    return false;
  }

  // ==================== PUBLIC QUERIES ====================

  async getOpenPositions() {
    return PolymarketPositionModel.find({ status: "open" }).sort({
      openedAt: -1,
    });
  }

  async getPositionsByAsset(asset: PolymarketAsset) {
    return PolymarketPositionModel.find({
      asset,
      status: "open",
    });
  }

  async getRecentResults(limit: number = 20) {
    return PolymarketPositionModel.find({
      status: { $in: ["closed", "resolved"] },
    })
      .sort({ closedAt: -1 })
      .limit(limit);
  }

  async getStats(): Promise<{
    openCount: number;
    totalExposure: number;
    resolvedCount: number;
    totalPnl: number;
    winRate: number;
  }> {
    const openPositions = await PolymarketPositionModel.find({
      status: "open",
    });
    const resolvedPositions = await PolymarketPositionModel.find({
      status: { $in: ["closed", "resolved"] },
    });

    const totalExposure = openPositions.reduce(
      (sum, p) => sum + p.size,
      0
    );
    const totalPnl = resolvedPositions.reduce(
      (sum, p) => sum + (p.pnl || 0),
      0
    );
    const wins = resolvedPositions.filter(
      (p) => (p.pnl || 0) > 0
    ).length;

    return {
      openCount: openPositions.length,
      totalExposure,
      resolvedCount: resolvedPositions.length,
      totalPnl,
      winRate:
        resolvedPositions.length > 0
          ? wins / resolvedPositions.length
          : 0,
    };
  }
}
