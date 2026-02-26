import { HFTStrategyBase } from "./HFTStrategyBase";
import { ITickSnapshot, IArbOpportunity } from "../../types/hft.types";
import { PolymarketAsset } from "../../types/polymarket.types";

const POLYMARKET_FEE = 0.005; // ~0.5% per side for limit orders (maker)

/**
 * Spread Capture / Market Making Strategy.
 *
 * Places passive limit orders on both bid and ask sides of the YES token.
 * Captures the bid-ask spread on every round-trip.
 *
 * Inventory management keeps us delta-neutral: if we accumulate too many
 * YES tokens, we skew quotes (widen bid, tighten ask) to reduce inventory.
 *
 * Win rate: Very high per completed round-trip (spread > fees = profit).
 * Risk: Adverse selection (holding inventory when price moves against us).
 */
export class SpreadCaptureMMStrategy extends HFTStrategyBase {
  readonly id = "hft-spread-capture";
  readonly name = "Spread Capture Market Making";
  readonly type = "spread_capture" as const;

  // Track our inventory per asset for quote skewing
  private yesInventory: Map<PolymarketAsset, number> = new Map();
  private maxInventory: number = 50; // Max $50 inventory per side
  private activeQuotes: Map<string, { bidPlacedAt: number; askPlacedAt: number }> = new Map();

  onTick(snapshot: ITickSnapshot, history: ITickSnapshot[]): IArbOpportunity[] {
    const opportunities: IArbOpportunity[] = [];

    if (snapshot.yesBids.length === 0 || snapshot.yesAsks.length === 0) {
      return opportunities;
    }

    const bestBid = parseFloat(snapshot.yesBids[0].price);
    const bestAsk = parseFloat(snapshot.yesAsks[0].price);
    const currentSpread = bestAsk - bestBid;

    // Minimum spread to be profitable after fees (both sides)
    const minProfitableSpread = POLYMARKET_FEE * 2 + 0.005; // fees + minimum profit

    if (currentSpread < minProfitableSpread) return opportunities;

    const inventory = this.yesInventory.get(snapshot.asset) || 0;

    // Calculate quote prices
    // Improve best bid/ask by 1 cent to get priority
    let ourBid = bestBid + 0.01;
    let ourAsk = bestAsk - 0.01;

    // Inventory skew: if we have too many YES tokens, lower bid / aggressive ask
    const inventoryRatio = inventory / this.maxInventory;
    if (inventoryRatio > 0.5) {
      // Heavy inventory — skew to sell (lower bid, aggressive ask)
      ourBid -= 0.01 * inventoryRatio;
      ourAsk -= 0.005 * inventoryRatio;
    } else if (inventoryRatio < -0.5) {
      // Short inventory — skew to buy (aggressive bid, raise ask)
      ourBid += 0.005 * Math.abs(inventoryRatio);
      ourAsk += 0.01 * Math.abs(inventoryRatio);
    }

    // Ensure our spread is still profitable
    const ourSpread = ourAsk - ourBid;
    if (ourSpread < POLYMARKET_FEE * 2 + 0.002) return opportunities;

    // Check market is not too volatile (use history)
    if (history.length >= 10) {
      const recentMids = history.slice(-10).map((s) => s.yesMid);
      const midRange = Math.max(...recentMids) - Math.min(...recentMids);
      if (midRange > 0.08) {
        // Market moved >8 cents in 5 seconds — too volatile for MM
        return opportunities;
      }
    }

    const sizeUSDC = 10; // Small size for market making

    // Place bid (buy side) if inventory not too long
    if (inventory < this.maxInventory) {
      opportunities.push({
        type: "spread_capture",
        strategyId: this.id,
        asset: snapshot.asset,
        interval: snapshot.interval,
        conditionId: snapshot.conditionId,
        direction: "YES",
        tokenId: snapshot.yesTokenId,
        side: "BUY",
        price: Math.round(ourBid * 100) / 100, // Round to cents
        size: sizeUSDC,
        expectedProfit: ourSpread * (sizeUSDC / ourBid) / 2 - POLYMARKET_FEE * sizeUSDC,
        confidence: 0.85,
        edge: ourSpread - POLYMARKET_FEE * 2,
        orderType: "GTC",
        metadata: {
          spread: currentSpread,
          ourSpread,
          inventorySkew: inventoryRatio,
          role: "bid",
        },
      });
    }

    // Place ask (sell side) if inventory not too short
    if (inventory > -this.maxInventory) {
      opportunities.push({
        type: "spread_capture",
        strategyId: this.id,
        asset: snapshot.asset,
        interval: snapshot.interval,
        conditionId: snapshot.conditionId,
        direction: "YES",
        tokenId: snapshot.yesTokenId,
        side: "SELL",
        price: Math.round(ourAsk * 100) / 100,
        size: sizeUSDC,
        expectedProfit: ourSpread * (sizeUSDC / ourAsk) / 2 - POLYMARKET_FEE * sizeUSDC,
        confidence: 0.85,
        edge: ourSpread - POLYMARKET_FEE * 2,
        orderType: "GTC",
        metadata: {
          spread: currentSpread,
          ourSpread,
          inventorySkew: inventoryRatio,
          role: "ask",
        },
      });
    }

    return opportunities;
  }

  /**
   * Update inventory after a fill. Called by HFTOrderManager.
   */
  updateInventory(asset: PolymarketAsset, side: "BUY" | "SELL", value: number): void {
    const current = this.yesInventory.get(asset) || 0;
    if (side === "BUY") {
      this.yesInventory.set(asset, current + value);
    } else {
      this.yesInventory.set(asset, current - value);
    }
  }

  getInventory(asset: PolymarketAsset): number {
    return this.yesInventory.get(asset) || 0;
  }
}
