import { DemoWallet } from "../exchange/DemoWallet";
import { PerformanceTracker } from "../polymarket/PerformanceTracker";
import { MultiExchangeTickEngine } from "../exchange/MultiExchangeTickEngine";
import { HFTTickEngine } from "../polymarket/HFTTickEngine";
import { IDashboardPayload } from "../types/exchange.types";

export class DashboardPayloadBuilder {
  private demoWallet: DemoWallet;
  private perfTracker: PerformanceTracker;
  private multiExchangeEngine: MultiExchangeTickEngine;
  private hftEngine: HFTTickEngine;
  private startTime: number;

  constructor(
    demoWallet: DemoWallet,
    perfTracker: PerformanceTracker,
    multiExchangeEngine: MultiExchangeTickEngine,
    hftEngine: HFTTickEngine
  ) {
    this.demoWallet = demoWallet;
    this.perfTracker = perfTracker;
    this.multiExchangeEngine = multiExchangeEngine;
    this.hftEngine = hftEngine;
    this.startTime = Date.now();
  }

  build(): IDashboardPayload {
    const walletState = this.demoWallet.getState();
    const performance = this.perfTracker.getOverallMetrics();
    const strategyMetrics = this.perfTracker.getStrategyMetrics();
    const recentTrades = this.perfTracker.getRecentTrades(50);
    const orderbooks = this.multiExchangeEngine.getAllOrderbooks();
    const mexStats = this.multiExchangeEngine.getStats();
    const connectedExchanges = this.multiExchangeEngine.getConnectedExchanges();

    // Per-strategy metrics as plain object
    const perStrategyMetrics: Record<string, any> = {};
    for (const [id, metrics] of strategyMetrics) {
      perStrategyMetrics[id] = metrics;
    }

    // Per-exchange metrics
    const perExchangeMetrics: Record<string, { trades: number; pnl: number; winRate: number }> = {};
    for (const exchange of connectedExchanges) {
      const em = this.perfTracker.getExchangeMetrics(exchange);
      perExchangeMetrics[exchange] = {
        trades: em.totalTrades,
        pnl: em.totalPnl,
        winRate: em.winRate,
      };
    }

    return {
      wallet: walletState,
      performance,
      perStrategyMetrics,
      perExchangeMetrics,
      positions: walletState.positions,
      recentTrades,
      orderbooks: orderbooks.slice(0, 10), // Top 10 books
      ticksPerSecond: this.multiExchangeEngine.getTicksPerSecond(),
      uptime: Date.now() - this.startTime,
      connectedExchanges,
      timestamp: Date.now(),
    };
  }
}
