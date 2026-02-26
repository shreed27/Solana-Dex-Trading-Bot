import {
  IHFTRiskLimits,
  IHFTRiskCheck,
  IArbOpportunity,
  IHFTTrade,
  IInventoryState,
  HFTStrategyType,
} from "../types/hft.types";
import { PolymarketAsset } from "../types/polymarket.types";
import { logger } from "../utils/logger";

const DEFAULT_HFT_LIMITS: IHFTRiskLimits = {
  maxInventoryPerAsset: 100,
  maxTotalExposure: 500,
  maxLossPerMinute: 20,
  maxLossPerHour: 50,
  maxConcurrentOrders: 10,
  minTimeToResolution: 60,
  maxTradeSize: 30,
  minEdge: {
    yes_no_arb: 0.01,       // 1% for risk-free arb
    latency_arb: 0.03,      // 3% for latency arb
    spread_capture: 0.01,   // 1% spread after fees
    microstructure: 0.02,   // 2% for microstructure signals
  },
};

/**
 * Per-tick risk manager for HFT strategies.
 * Evaluates every opportunity before execution.
 * Kill switch pauses all HFT when loss thresholds are breached.
 */
export class HFTRiskManager {
  private limits: IHFTRiskLimits;
  private inventory: Map<PolymarketAsset, IInventoryState> = new Map();
  private recentTrades: IHFTTrade[] = [];
  private openOrderCount: number = 0;
  private killSwitchUntil: number = 0;
  private totalHFTExposure: number = 0;

  constructor(limits?: Partial<IHFTRiskLimits>) {
    this.limits = { ...DEFAULT_HFT_LIMITS, ...limits };
    for (const asset of ["BTC", "ETH", "XRP"] as PolymarketAsset[]) {
      this.inventory.set(asset, {
        asset,
        yesShares: 0,
        noShares: 0,
        yesValue: 0,
        noValue: 0,
        netExposure: 0,
        totalValue: 0,
      });
    }
  }

  /**
   * Check if an opportunity passes all risk gates.
   */
  checkRisk(opportunity: IArbOpportunity, timeToResolution: number): IHFTRiskCheck {
    const now = Date.now();

    // 1. Kill switch active?
    if (now < this.killSwitchUntil) {
      const remaining = ((this.killSwitchUntil - now) / 1000).toFixed(0);
      return this.deny(`Kill switch active (${remaining}s remaining)`);
    }

    // 2. Minimum edge check
    const minEdge = this.limits.minEdge[opportunity.type];
    if (opportunity.edge < minEdge) {
      return this.deny(
        `Edge ${(opportunity.edge * 100).toFixed(2)}% < min ${(minEdge * 100).toFixed(2)}%`
      );
    }

    // 3. Time to resolution
    if (timeToResolution < this.limits.minTimeToResolution) {
      return this.deny(`Time to resolution ${timeToResolution}s < min ${this.limits.minTimeToResolution}s`);
    }

    // 4. Trade size
    if (opportunity.size > this.limits.maxTradeSize) {
      opportunity.size = this.limits.maxTradeSize;
    }

    // 5. Inventory check
    const inv = this.inventory.get(opportunity.asset);
    if (inv && inv.totalValue + opportunity.size > this.limits.maxInventoryPerAsset) {
      return this.deny(
        `Inventory ${opportunity.asset}: $${inv.totalValue.toFixed(0)} + $${opportunity.size.toFixed(0)} > max $${this.limits.maxInventoryPerAsset}`
      );
    }

    // 6. Total exposure
    if (this.totalHFTExposure + opportunity.size > this.limits.maxTotalExposure) {
      return this.deny(
        `Total HFT exposure: $${this.totalHFTExposure.toFixed(0)} + $${opportunity.size.toFixed(0)} > max $${this.limits.maxTotalExposure}`
      );
    }

    // 7. Concurrent orders
    if (this.openOrderCount >= this.limits.maxConcurrentOrders) {
      return this.deny(`Concurrent orders: ${this.openOrderCount} >= max ${this.limits.maxConcurrentOrders}`);
    }

    // 8. Recent loss checks
    const pnl1m = this.getRecentPnl(60_000);
    if (pnl1m < -this.limits.maxLossPerMinute) {
      this.activateKillSwitch(60_000);
      return this.deny(`1-min loss $${Math.abs(pnl1m).toFixed(2)} > max $${this.limits.maxLossPerMinute}`);
    }

    const pnl1h = this.getRecentPnl(3_600_000);
    if (pnl1h < -this.limits.maxLossPerHour) {
      this.activateKillSwitch(300_000); // 5 min pause
      return this.deny(`1-hr loss $${Math.abs(pnl1h).toFixed(2)} > max $${this.limits.maxLossPerHour}`);
    }

    return {
      allowed: true,
      currentInventory: inv?.totalValue || 0,
      currentExposure: this.totalHFTExposure,
      recentPnl1m: pnl1m,
      recentPnl1h: pnl1h,
      openOrderCount: this.openOrderCount,
      suggestedSize: Math.min(opportunity.size, this.limits.maxTradeSize),
    };
  }

  /**
   * Record a completed HFT trade.
   */
  recordTrade(trade: IHFTTrade): void {
    this.recentTrades.push(trade);
    // Keep last 1000 trades in memory
    if (this.recentTrades.length > 1000) {
      this.recentTrades = this.recentTrades.slice(-1000);
    }
  }

  /**
   * Update inventory after a fill.
   */
  updateInventory(
    asset: PolymarketAsset,
    direction: "YES" | "NO",
    side: "BUY" | "SELL",
    shares: number,
    price: number
  ): void {
    const inv = this.inventory.get(asset);
    if (!inv) return;

    const value = shares * price;

    if (direction === "YES") {
      if (side === "BUY") {
        inv.yesShares += shares;
        inv.yesValue += value;
        this.totalHFTExposure += value;
      } else {
        inv.yesShares -= shares;
        inv.yesValue -= value;
        this.totalHFTExposure -= value;
      }
    } else {
      if (side === "BUY") {
        inv.noShares += shares;
        inv.noValue += value;
        this.totalHFTExposure += value;
      } else {
        inv.noShares -= shares;
        inv.noValue -= value;
        this.totalHFTExposure -= value;
      }
    }

    inv.netExposure = inv.yesValue - inv.noValue;
    inv.totalValue = inv.yesValue + inv.noValue;
    this.totalHFTExposure = Math.max(0, this.totalHFTExposure);
  }

  setOpenOrderCount(count: number): void {
    this.openOrderCount = count;
  }

  getInventory(asset: PolymarketAsset): IInventoryState | undefined {
    return this.inventory.get(asset);
  }

  getTotalExposure(): number {
    return this.totalHFTExposure;
  }

  isKillSwitchActive(): boolean {
    return Date.now() < this.killSwitchUntil;
  }

  private activateKillSwitch(durationMs: number): void {
    this.killSwitchUntil = Date.now() + durationMs;
    logger.warning(
      `HFT KILL SWITCH activated for ${(durationMs / 1000).toFixed(0)}s`
    );
  }

  private getRecentPnl(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.recentTrades
      .filter((t) => t.closedAt >= cutoff)
      .reduce((sum, t) => sum + t.pnl, 0);
  }

  private deny(reason: string): IHFTRiskCheck {
    return {
      allowed: false,
      reason,
      currentInventory: 0,
      currentExposure: this.totalHFTExposure,
      recentPnl1m: this.getRecentPnl(60_000),
      recentPnl1h: this.getRecentPnl(3_600_000),
      openOrderCount: this.openOrderCount,
      suggestedSize: 0,
    };
  }
}
