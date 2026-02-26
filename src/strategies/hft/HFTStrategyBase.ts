import { ITickSnapshot, IArbOpportunity, HFTStrategyType } from "../../types/hft.types";

/**
 * Abstract base for HFT strategies.
 * Unlike BaseStrategy (cron-driven), HFT strategies are tick-driven.
 * The HFTTickEngine calls onTick() every 500ms with fresh orderbook data.
 */
export abstract class HFTStrategyBase {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly type: HFTStrategyType;

  protected enabled: boolean = true;
  protected tradeCount: number = 0;
  protected winCount: number = 0;
  protected totalPnl: number = 0;

  /**
   * Called every tick (~500ms) with fresh market data.
   * Returns array of opportunities found (may be empty).
   * Must be fast — no async API calls inside onTick.
   * All data needed is pre-fetched in the snapshot.
   */
  abstract onTick(
    snapshot: ITickSnapshot,
    history: ITickSnapshot[]
  ): IArbOpportunity[];

  isEnabled(): boolean {
    return this.enabled;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  recordTrade(pnl: number): void {
    this.tradeCount++;
    this.totalPnl += pnl;
    if (pnl > 0) this.winCount++;
  }

  getStats(): { trades: number; wins: number; pnl: number; winRate: number } {
    return {
      trades: this.tradeCount,
      wins: this.winCount,
      pnl: this.totalPnl,
      winRate: this.tradeCount > 0 ? this.winCount / this.tradeCount : 0,
    };
  }

  /**
   * Helper: Calculate total depth from orderbook levels.
   */
  protected calcDepth(levels: { price: string; size: string }[], topN: number = 5): number {
    return levels
      .slice(0, topN)
      .reduce((sum, l) => sum + parseFloat(l.price) * parseFloat(l.size), 0);
  }

  /**
   * Helper: Get best price from levels.
   */
  protected bestPrice(levels: { price: string; size: string }[]): number {
    if (levels.length === 0) return 0;
    return parseFloat(levels[0].price);
  }

  /**
   * Helper: Get available size at best price level.
   */
  protected bestSize(levels: { price: string; size: string }[]): number {
    if (levels.length === 0) return 0;
    return parseFloat(levels[0].size);
  }
}
