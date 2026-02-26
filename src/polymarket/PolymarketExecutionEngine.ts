import {
  IPolymarketTradeResult,
  IPolymarketRiskCheck,
  PolymarketAsset,
  PolymarketInterval,
  PolymarketDirection,
} from "../types/polymarket.types";
import { IAggregatedSignal, SignalDirection } from "../types/strategy.types";
import { PolymarketClient } from "./PolymarketClient";
import { MarketDiscoveryService } from "./MarketDiscoveryService";
import { PolymarketRiskManager } from "./PolymarketRiskManager";
import { PolymarketPositionManager } from "./PolymarketPositionManager";
import { logger } from "../utils/logger";

/**
 * Converts aggregated signals into Polymarket orders.
 * BUY signal → buy YES token (betting price goes UP)
 * SELL signal → buy NO token (betting price goes DOWN)
 */
export class PolymarketExecutionEngine {
  private client: PolymarketClient;
  private discovery: MarketDiscoveryService;
  private riskManager: PolymarketRiskManager;
  private positionManager: PolymarketPositionManager;
  private defaultSizeUSDC: number;

  constructor(
    client: PolymarketClient,
    discovery: MarketDiscoveryService,
    riskManager: PolymarketRiskManager,
    positionManager: PolymarketPositionManager,
    defaultSizeUSDC: number = 25
  ) {
    this.client = client;
    this.discovery = discovery;
    this.riskManager = riskManager;
    this.positionManager = positionManager;
    this.defaultSizeUSDC = defaultSizeUSDC;
  }

  /**
   * Execute a trade based on aggregated signal for an asset.
   */
  async executeTrade(
    asset: PolymarketAsset,
    interval: PolymarketInterval,
    aggregatedSignal: IAggregatedSignal
  ): Promise<IPolymarketTradeResult> {
    const { direction, compositeScore, contributingSignals } =
      aggregatedSignal;

    // Determine YES or NO
    const polyDirection: PolymarketDirection =
      direction === SignalDirection.BUY ? "YES" : "NO";

    logger.info(
      `Execution: ${asset} ${interval} → ${polyDirection} (score: ${compositeScore.toFixed(3)})`
    );

    // Risk check
    const riskCheck = await this.riskManager.checkRisk(
      asset,
      interval,
      compositeScore,
      this.defaultSizeUSDC
    );

    if (!riskCheck.allowed) {
      return {
        success: false,
        asset,
        direction: polyDirection,
        entryPrice: 0,
        size: 0,
        shares: 0,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
        error: `Risk denied: ${riskCheck.reason}`,
      };
    }

    // Get current market
    const market = this.discovery.getCurrentMarket(asset, interval);
    if (!market) {
      return {
        success: false,
        asset,
        direction: polyDirection,
        entryPrice: 0,
        size: 0,
        shares: 0,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
        error: "No active market",
      };
    }

    const tokenId =
      polyDirection === "YES" ? market.yesTokenId : market.noTokenId;
    if (!tokenId) {
      return {
        success: false,
        asset,
        direction: polyDirection,
        entryPrice: 0,
        size: 0,
        shares: 0,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
        error: "Token ID not available",
      };
    }

    // Get current price
    const currentPrice = await this.client.getMidPrice(tokenId);
    if (!currentPrice || currentPrice <= 0 || currentPrice >= 1) {
      return {
        success: false,
        asset,
        direction: polyDirection,
        entryPrice: 0,
        size: 0,
        shares: 0,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
        error: `Invalid price: ${currentPrice}`,
      };
    }

    // Calculate size and shares
    const sizeUSDC = riskCheck.suggestedSize;
    const shares = sizeUSDC / currentPrice;

    // Check edge: ensure we have positive expected value
    const edgeCheck = this.checkEdge(
      polyDirection,
      currentPrice,
      compositeScore
    );
    if (!edgeCheck.hasEdge) {
      return {
        success: false,
        asset,
        direction: polyDirection,
        entryPrice: currentPrice,
        size: sizeUSDC,
        shares,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
        error: `No edge: ${edgeCheck.reason}`,
      };
    }

    // Place order
    if (!this.client.isAuthenticated()) {
      logger.warning("Dry run (not authenticated): would place order");
      // Still record position for tracking
      await this.positionManager.openPosition({
        marketId: market.conditionId,
        conditionId: market.conditionId,
        asset,
        interval,
        direction: polyDirection,
        tokenId,
        entryPrice: currentPrice,
        size: sizeUSDC,
        shares,
        marketStartTime: market.startTime,
        marketEndTime: market.endTime,
        entrySignals: contributingSignals.map((s) => ({
          strategyId: s.strategyId,
          confidence: s.confidence,
          timestamp: s.timestamp,
        })),
        compositeScore,
      });

      return {
        success: true,
        asset,
        direction: polyDirection,
        entryPrice: currentPrice,
        size: sizeUSDC,
        shares,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
      };
    }

    // Live order
    const orderResult = await this.client.placeMarketOrder(
      tokenId,
      "BUY",
      shares
    );

    if (!orderResult.success) {
      return {
        success: false,
        asset,
        direction: polyDirection,
        entryPrice: currentPrice,
        size: sizeUSDC,
        shares,
        compositeScore,
        strategies: contributingSignals.map((s) => s.strategyId),
        error: `Order failed: ${orderResult.errorMsg}`,
      };
    }

    // Record position
    await this.positionManager.openPosition({
      marketId: market.conditionId,
      conditionId: market.conditionId,
      asset,
      interval,
      direction: polyDirection,
      tokenId,
      entryPrice: currentPrice,
      size: sizeUSDC,
      shares,
      marketStartTime: market.startTime,
      marketEndTime: market.endTime,
      entrySignals: contributingSignals.map((s) => ({
        strategyId: s.strategyId,
        confidence: s.confidence,
        timestamp: s.timestamp,
      })),
      compositeScore,
      orderId: orderResult.orderID,
    });

    logger.success(
      `Order placed: ${polyDirection} ${asset} @ ${currentPrice.toFixed(3)} | $${sizeUSDC.toFixed(2)} | ${shares.toFixed(2)} shares`
    );

    return {
      success: true,
      orderId: orderResult.orderID,
      asset,
      direction: polyDirection,
      entryPrice: currentPrice,
      size: sizeUSDC,
      shares,
      compositeScore,
      strategies: contributingSignals.map((s) => s.strategyId),
    };
  }

  /**
   * Check if trade has positive expected value.
   * If confidence = 0.7 and YES price = 0.55, implied edge = 0.7 - 0.55 = 15%
   */
  private checkEdge(
    direction: PolymarketDirection,
    tokenPrice: number,
    compositeScore: number
  ): { hasEdge: boolean; reason: string } {
    // Our confidence is our estimate of the true probability
    // Token price is the market's estimate
    // Edge = our estimate - market estimate
    const ourProbability = compositeScore;

    // For YES: we think UP probability is compositeScore
    // For NO: we think DOWN probability is compositeScore
    const impliedProbability = tokenPrice;
    const edge = ourProbability - impliedProbability;

    // Require at least 5% edge to cover fees and slippage
    const minEdge = 0.05;

    if (edge < minEdge) {
      return {
        hasEdge: false,
        reason: `Edge ${(edge * 100).toFixed(1)}% < min ${(minEdge * 100).toFixed(1)}% (our: ${(ourProbability * 100).toFixed(1)}% vs market: ${(impliedProbability * 100).toFixed(1)}%)`,
      };
    }

    return { hasEdge: true, reason: "" };
  }
}
