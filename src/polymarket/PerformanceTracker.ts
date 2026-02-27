import {
  IHFTTrade,
  IPerformanceMetrics,
  IPerformanceWindow,
  HFTStrategyType,
} from "../types/hft.types";
import { mean, stddev } from "../utils/mathUtils";
import { logger } from "../utils/logger";

const EMPTY_METRICS: IPerformanceMetrics = {
  totalTrades: 0,
  wins: 0,
  losses: 0,
  profitFactor: 0,
  sharpeRatio: 0,
  sortinoRatio: 0,
  winRate: 0,
  totalPnl: 0,
  grossProfit: 0,
  grossLoss: 0,
  maxDrawdown: 0,
  avgWin: 0,
  avgLoss: 0,
  tradesPerHour: 0,
  avgHoldTimeMs: 0,
  largestWin: 0,
  largestLoss: 0,
};

/**
 * Real-time performance metrics calculator.
 * Tracks PF, Sharpe, Sortino, Win Rate, Max Drawdown
 * across rolling time windows and per-strategy.
 */
export class PerformanceTracker {
  private allTrades: IHFTTrade[] = [];
  private intervalHandle: NodeJS.Timeout | null = null;
  private startTime: number = Date.now();

  initialize(): void {
    this.startTime = Date.now();

    // Log performance every 5 minutes
    this.intervalHandle = setInterval(() => this.logPerformance(), 5 * 60_000);
  }

  shutdown(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  recordTrade(trade: IHFTTrade): void {
    this.allTrades.push(trade);
    // Keep last 5000 trades
    if (this.allTrades.length > 5000) {
      this.allTrades = this.allTrades.slice(-5000);
    }
  }

  /**
   * Get metrics for all trades.
   */
  getOverallMetrics(): IPerformanceMetrics {
    return this.calculateMetrics(this.allTrades);
  }

  /**
   * Get metrics for a specific time window.
   */
  getWindowMetrics(windowMs: number): IPerformanceMetrics {
    const cutoff = Date.now() - windowMs;
    const windowTrades = this.allTrades.filter((t) => t.closedAt >= cutoff);
    return this.calculateMetrics(windowTrades);
  }

  /**
   * Get metrics broken down by strategy.
   */
  getStrategyMetrics(): Map<string, IPerformanceMetrics> {
    const byStrategy = new Map<string, IHFTTrade[]>();
    for (const trade of this.allTrades) {
      const existing = byStrategy.get(trade.strategyId) || [];
      existing.push(trade);
      byStrategy.set(trade.strategyId, existing);
    }

    const result = new Map<string, IPerformanceMetrics>();
    for (const [id, trades] of byStrategy) {
      result.set(id, this.calculateMetrics(trades));
    }
    return result;
  }

  /**
   * Get metrics for a specific exchange.
   */
  getExchangeMetrics(exchange: string): IPerformanceMetrics {
    const exchangeTrades = this.allTrades.filter((t) => t.exchange === exchange);
    return this.calculateMetrics(exchangeTrades);
  }

  /**
   * Get recent trades (last N).
   */
  getRecentTrades(count = 50): IHFTTrade[] {
    return this.allTrades.slice(-count);
  }

  /**
   * Get all rolling window metrics.
   */
  getAllWindows(): IPerformanceWindow[] {
    return [
      { label: "1H", windowMs: 3_600_000, metrics: this.getWindowMetrics(3_600_000) },
      { label: "4H", windowMs: 14_400_000, metrics: this.getWindowMetrics(14_400_000) },
      { label: "24H", windowMs: 86_400_000, metrics: this.getWindowMetrics(86_400_000) },
      { label: "ALL", windowMs: Date.now() - this.startTime, metrics: this.getOverallMetrics() },
    ];
  }

  private calculateMetrics(trades: IHFTTrade[]): IPerformanceMetrics {
    if (trades.length === 0) return { ...EMPTY_METRICS };

    const pnls = trades.map((t) => t.pnl);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);

    const grossProfit = wins.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
    const totalPnl = grossProfit - grossLoss;

    // Profit Factor
    const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLoss;

    // Win Rate
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;

    // Sharpe Ratio (annualized from per-trade returns)
    // Using trade-by-trade returns, annualize assuming 8760 hours/year
    const returns = pnls;
    const meanReturn = mean(returns);
    const stdReturn = stddev(returns);

    // Calculate trades per hour for annualization
    const timeSpanMs =
      trades.length >= 2
        ? trades[trades.length - 1].closedAt - trades[0].closedAt
        : 3_600_000;
    const hoursElapsed = Math.max(timeSpanMs / 3_600_000, 1 / 60);
    const tradesPerHour = trades.length / hoursElapsed;
    const annualizationFactor = Math.sqrt(tradesPerHour * 8760);

    const sharpeRatio =
      stdReturn === 0
        ? meanReturn > 0
          ? 999
          : 0
        : (meanReturn / stdReturn) * annualizationFactor;

    // Sortino Ratio (only downside deviation)
    const negativeReturns = returns.filter((r) => r < 0);
    const downsideDev =
      negativeReturns.length > 0
        ? Math.sqrt(
            negativeReturns.reduce((s, r) => s + r * r, 0) /
              negativeReturns.length
          )
        : 0;
    const sortinoRatio =
      downsideDev === 0
        ? meanReturn > 0
          ? 999
          : 0
        : (meanReturn / downsideDev) * annualizationFactor;

    // Max Drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let cumPnl = 0;
    for (const pnl of pnls) {
      cumPnl += pnl;
      if (cumPnl > peak) peak = cumPnl;
      const drawdown = peak - cumPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Hold time
    const holdTimes = trades.map((t) => t.holdTimeMs);
    const avgHoldTimeMs = holdTimes.length > 0 ? mean(holdTimes) : 0;

    return {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      profitFactor: Math.round(profitFactor * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      sortinoRatio: Math.round(sortinoRatio * 100) / 100,
      winRate: Math.round(winRate * 10000) / 10000,
      totalPnl: Math.round(totalPnl * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      grossLoss: Math.round(grossLoss * 100) / 100,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      avgWin: wins.length > 0 ? Math.round((grossProfit / wins.length) * 100) / 100 : 0,
      avgLoss: losses.length > 0 ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
      tradesPerHour: Math.round(tradesPerHour * 100) / 100,
      avgHoldTimeMs: Math.round(avgHoldTimeMs),
      largestWin: wins.length > 0 ? Math.max(...wins) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses) : 0,
    };
  }

  private logPerformance(): void {
    const windows = this.getAllWindows();
    const stratMetrics = this.getStrategyMetrics();

    for (const w of windows) {
      if (w.metrics.totalTrades === 0) continue;
      const m = w.metrics;
      logger.info(
        `[HFT ${w.label}] Trades: ${m.totalTrades} | WR: ${(m.winRate * 100).toFixed(1)}% | PF: ${m.profitFactor} | Sharpe: ${m.sharpeRatio} | Sortino: ${m.sortinoRatio} | PnL: $${m.totalPnl} | DD: $${m.maxDrawdown}`
      );
    }

    for (const [id, m] of stratMetrics) {
      if (m.totalTrades === 0) continue;
      logger.info(
        `  [${id}] Trades: ${m.totalTrades} | WR: ${(m.winRate * 100).toFixed(1)}% | PF: ${m.profitFactor} | PnL: $${m.totalPnl}`
      );
    }
  }
}
