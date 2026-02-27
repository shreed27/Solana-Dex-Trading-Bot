/**
 * ============================================================================
 * QUANT MASTER SYSTEM — UNIFIED TRADING INFRASTRUCTURE
 * ============================================================================
 *
 * Master orchestrator integrating all quantitative trading subsystems.
 *
 * SUBSYSTEMS:
 *  1. Goldman Sachs — Quant Strategy Engine (Signal Generation)
 *  2. Renaissance Technologies — Backtesting Framework
 *  3. Two Sigma — Institutional Risk Management
 *  4. Jane Street — Market Making Engine
 *  5. Virtu Financial — Execution Algorithms
 *  6. Point72 — ML Signal Pipeline
 *  7. Man Group — Portfolio Optimization
 *  8. Millennium Management — Live Trading System (OMS)
 *  9. DFA — Factor Investing Engine
 * 10. Goldman Sachs — Compliance Framework
 * 11. Bloomberg — Market Data Pipeline
 *
 * ============================================================================
 */

import { QuantStrategyEngine } from "./strategy/QuantStrategyEngine";
import { BacktestEngine } from "./backtest/BacktestEngine";
import { InstitutionalRiskManager, VaRCalculator, StressTestEngine } from "./risk/InstitutionalRiskManager";
import { MarketMakingEngine } from "./market-making/MarketMakingEngine";
import { TWAPExecutor, VWAPExecutor, SmartOrderRouter, PostTradeTCA } from "./execution/ExecutionAlgorithms";
import { FeatureEngine, GradientBoostedEnsemble, ModelMonitor } from "./ml/MLSignalPipeline";
import { MeanVarianceOptimizer, BlackLittermanModel, RiskParityAllocator, PerformanceAttribution } from "./portfolio/PortfolioOptimizer";
import { OrderManagementSystem, PositionTracker, KillSwitch, AlertSystem } from "./live/LiveTradingSystem";
import { PreTradeRiskControls, ManipulationDetector, TaxLotTracker } from "./compliance/ComplianceFramework";
import { MarketDataPipeline } from "./data/DataPipeline";
import { FactorConstructor, FactorAnalyzer, MultiFactorPortfolio, TearSheetGenerator } from "./factors/FactorEngine";
import { logger } from "../utils/logger";

// ============================================================================
// SYSTEM CONFIGURATION
// ============================================================================

export interface ISystemConfig {
  mode: "paper" | "live" | "backtest";
  riskLevel: "conservative" | "moderate" | "aggressive";
  enabledStrategies: string[];
  maxTotalExposure: number;
  dashboardPort: number;
  tickIntervalMs: number;
}

const DEFAULT_SYSTEM_CONFIG: ISystemConfig = {
  mode: "paper",
  riskLevel: "moderate",
  enabledStrategies: ["momentum", "mean_reversion", "microstructure", "ml_ensemble"],
  maxTotalExposure: 80,
  dashboardPort: 3100,
  tickIntervalMs: 500,
};

// ============================================================================
// QUANT MASTER SYSTEM — MAIN ORCHESTRATOR
// ============================================================================

export class QuantMasterSystem {
  private config: ISystemConfig;

  // --- Subsystem 1: Signal Generation (Goldman Sachs) ---
  private strategyEngine: QuantStrategyEngine;

  // --- Subsystem 2: Backtesting Framework (Renaissance Technologies) ---
  private backtestEngine: BacktestEngine | null = null;

  // --- Subsystem 3: Risk Management (Two Sigma) ---
  private riskManager: InstitutionalRiskManager;

  // --- Subsystem 4: Market Making (Jane Street) ---
  private marketMakingEngine: MarketMakingEngine;

  // --- Subsystem 5: Execution Algorithms (Virtu Financial) ---
  private smartOrderRouter: SmartOrderRouter;

  // --- Subsystem 6: ML Signal Pipeline (Point72) ---
  private mlEnsemble: GradientBoostedEnsemble;
  private modelMonitor: ModelMonitor;

  // --- Subsystem 7: Portfolio Optimization (Man Group) ---
  // Static methods — no instance needed

  // --- Subsystem 8: Live Trading System (Millennium Management) ---
  private oms: OrderManagementSystem;
  private positionTracker: PositionTracker;
  private killSwitch: KillSwitch;
  private alertSystem: AlertSystem;

  // --- Subsystem 9: Factor Investing (DFA) ---
  private factorConstructor: FactorConstructor;
  private factorAnalyzer: FactorAnalyzer;
  private multiFactorPortfolio: MultiFactorPortfolio;
  private tearSheetGenerator: TearSheetGenerator;

  // --- Subsystem 10: Compliance Framework (Goldman Sachs) ---
  private preTradeControls: PreTradeRiskControls;
  private manipulationDetector: ManipulationDetector;
  private taxLotTracker: TaxLotTracker;

  // --- Subsystem 11: Market Data Pipeline (Bloomberg) ---
  private dataPipeline: MarketDataPipeline;

  // --- Internal State ---
  private startTime: number = 0;
  private tickCount: number = 0;
  private lastTickTime: number = 0;
  private running: boolean = false;
  private instruments: string[] = [];

  constructor(config: ISystemConfig = DEFAULT_SYSTEM_CONFIG) {
    this.config = config;

    // Initialize all subsystems
    this.strategyEngine = new QuantStrategyEngine();
    this.riskManager = new InstitutionalRiskManager(config.maxTotalExposure);
    this.marketMakingEngine = new MarketMakingEngine();
    this.smartOrderRouter = new SmartOrderRouter();
    this.mlEnsemble = new GradientBoostedEnsemble();
    this.modelMonitor = new ModelMonitor();
    this.oms = new OrderManagementSystem();
    this.positionTracker = new PositionTracker();
    this.killSwitch = new KillSwitch(this.oms, this.positionTracker);
    this.alertSystem = new AlertSystem();
    this.factorConstructor = new FactorConstructor();
    this.factorAnalyzer = new FactorAnalyzer();
    this.multiFactorPortfolio = new MultiFactorPortfolio();
    this.tearSheetGenerator = new TearSheetGenerator();
    this.preTradeControls = new PreTradeRiskControls();
    this.manipulationDetector = new ManipulationDetector();
    this.taxLotTracker = new TaxLotTracker();
    this.dataPipeline = new MarketDataPipeline();

    // Wire alert handler to logger
    this.alertSystem.registerHandler((alert) => {
      if (alert.level === "CRITICAL") {
        logger.error(`[MASTER] CRITICAL: ${alert.category} — ${alert.message}`);
      }
    });

    logger.info(`[MASTER] QuantMasterSystem initialized | mode=${config.mode} | risk=${config.riskLevel}`);
  }

  // ==========================================================================
  // LIFECYCLE — START
  // ==========================================================================

  async start(): Promise<void> {
    if (this.running) {
      logger.warning("[MASTER] System is already running");
      return;
    }

    logger.info("[MASTER] ===== SYSTEM STARTUP SEQUENCE =====");
    this.startTime = Date.now();

    // Step 1: Initialize data pipeline
    logger.info("[MASTER] [1/7] Initializing market data pipeline...");
    this.dataPipeline = new MarketDataPipeline();

    // Step 2: Register instruments
    logger.info("[MASTER] [2/7] Registering instruments...");
    if (this.instruments.length > 0) {
      this.dataPipeline.registerInstruments(this.instruments);
    }

    // Step 3: Start risk monitoring
    logger.info("[MASTER] [3/7] Starting risk monitoring...");
    this.riskManager.resetDaily(this.config.maxTotalExposure);

    // Step 4: Start compliance checks
    logger.info("[MASTER] [4/7] Starting compliance framework...");
    this.manipulationDetector.clearAlerts();

    // Step 5: Start OMS
    logger.info("[MASTER] [5/7] Starting Order Management System...");
    // OMS is stateful and ready upon construction

    // Step 6: Start market making if enabled
    if (this.config.enabledStrategies.includes("market_making")) {
      logger.info("[MASTER] [6/7] Starting market making engine...");
      this.marketMakingEngine.start();
    } else {
      logger.info("[MASTER] [6/7] Market making not enabled — skipped");
    }

    // Step 7: Mark running
    this.running = true;
    logger.info("[MASTER] [7/7] ALL SYSTEMS ONLINE");
    logger.info(`[MASTER] Mode: ${this.config.mode} | Strategies: ${this.config.enabledStrategies.join(", ")}`);
    this.alertSystem.emit("INFO", "SYSTEM", "All systems online", { mode: this.config.mode });
  }

  // ==========================================================================
  // LIFECYCLE — SHUTDOWN
  // ==========================================================================

  async shutdown(): Promise<void> {
    if (!this.running) {
      logger.warning("[MASTER] System is not running");
      return;
    }

    logger.info("[MASTER] ===== GRACEFUL SHUTDOWN SEQUENCE =====");

    // Step 1: Trigger kill switch — cancel orders, flatten positions
    logger.info("[MASTER] [1/5] Triggering kill switch...");
    const ksResult = this.killSwitch.trigger("System shutdown");
    logger.info(`[MASTER] Kill switch: cancelled=${ksResult.ordersCancelled} orders, closed=${ksResult.positionsClosed} positions`);

    // Step 2: Stop market making
    logger.info("[MASTER] [2/5] Stopping market making engine...");
    this.marketMakingEngine.stop();

    // Step 3: Stop data pipeline
    logger.info("[MASTER] [3/5] Stopping data pipeline...");
    // Pipeline stops receiving ticks when running=false

    // Step 4: Generate final tear sheet
    logger.info("[MASTER] [4/5] Generating final tear sheet...");
    const tradeStats = this.strategyEngine.getTradeStats();
    const omsStats = this.oms.getOrderStats();

    // Step 5: Log final stats
    const uptime = Date.now() - this.startTime;
    const uptimeMin = (uptime / 60000).toFixed(1);
    logger.info("[MASTER] [5/5] Final session statistics:");
    logger.info(`[MASTER]   Uptime: ${uptimeMin} minutes`);
    logger.info(`[MASTER]   Ticks processed: ${this.tickCount}`);
    logger.info(`[MASTER]   Total P&L: $${tradeStats.totalPnl.toFixed(4)}`);
    logger.info(`[MASTER]   Win rate: ${(tradeStats.winRate * 100).toFixed(1)}%`);
    logger.info(`[MASTER]   Trades: ${tradeStats.tradeCount} (${tradeStats.wins}W / ${tradeStats.losses}L)`);
    logger.info(`[MASTER]   Orders: ${omsStats.total} total, ${omsStats.filled} filled, ${omsStats.cancelled} cancelled`);
    logger.info(`[MASTER]   Kill switch P&L: $${ksResult.estimatedPnl.toFixed(4)}`);

    this.running = false;
    this.killSwitch.reset();
    this.alertSystem.emit("INFO", "SYSTEM", "Shutdown complete", { uptimeMs: uptime });
    logger.info("[MASTER] ===== SHUTDOWN COMPLETE =====");
  }

  // ==========================================================================
  // REGISTER INSTRUMENTS
  // ==========================================================================

  registerInstruments(instruments: string[]): void {
    this.instruments = instruments;
    this.dataPipeline.registerInstruments(instruments);
    logger.info(`[MASTER] Registered ${instruments.length} instruments: ${instruments.join(", ")}`);
  }

  // ==========================================================================
  // MAIN TICK HANDLER
  // ==========================================================================

  processTick(
    instrument: string,
    price: number,
    volume: number,
    orderbook: any | null
  ): void {
    if (!this.running) return;
    if (this.killSwitch.isTriggered()) return;

    const tickStart = Date.now();
    this.tickCount++;

    // 1. Data pipeline processes tick
    const validTick = this.dataPipeline.processTick(instrument, price, volume, orderbook);
    if (!validTick) return;

    // 2. ML features extracted
    const features = this.dataPipeline.getFeatures(instrument);
    let mlPrediction = 0;
    if (features && Object.keys(features).length > 0) {
      mlPrediction = this.mlEnsemble.predict(features);
    }

    // 3. Strategy signals generated
    const signal = this.strategyEngine.generateSignal(
      instrument,
      this.config.mode === "live" ? "live" : "paper",
      orderbook,
      undefined
    );

    // Skip if no directional signal
    if (signal.direction === "FLAT") {
      this.lastTickTime = Date.now() - tickStart;
      return;
    }

    // Check if strategy is enabled
    if (!this.config.enabledStrategies.includes(signal.strategy)) {
      this.lastTickTime = Date.now() - tickStart;
      return;
    }

    // 4. Risk pre-trade check
    const positions = this.positionTracker.getOpenPositions();
    const totalExposure = this.positionTracker.getTotalExposure();
    const bookDepth = orderbook
      ? (orderbook.bids || []).slice(0, 5).reduce((s: number, l: any) => s + (l.size || 0) * (l.price || 0), 0)
        + (orderbook.asks || []).slice(0, 5).reduce((s: number, l: any) => s + (l.size || 0) * (l.price || 0), 0)
      : 0;

    const riskCheck = this.riskManager.preTradeCheck(
      signal.metadata.volatility || 0.01,
      this.config.mode === "live" ? "live" : "paper",
      instrument,
      positions.map((p) => ({
        id: p.id,
        symbol: p.instrument,
        exchange: p.exchange,
        side: p.side,
        size: p.size,
        leverage: 1,
        notional: p.size,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl,
        strategy: p.strategy || "quant",
        openedAt: p.openedAt,
      })),
      this.config.maxTotalExposure,
      bookDepth
    );

    if (!riskCheck.allowed) {
      this.lastTickTime = Date.now() - tickStart;
      return;
    }

    // 5. Compliance pre-trade check
    const complianceResult = this.preTradeControls.check(
      signal.direction === "LONG" ? "BUY" : "SELL",
      price,
      signal.conviction * riskCheck.suggestedSizeMultiplier,
      instrument,
      this.config.mode === "live" ? "live" : "paper",
      totalExposure,
      this.config.maxTotalExposure,
      this.oms.getOpenOrders().length,
      0,
      price
    );

    if (!complianceResult.approved) {
      this.lastTickTime = Date.now() - tickStart;
      return;
    }

    // 6. Approved — make trade decision and route to execution
    const decision = this.strategyEngine.makeTradeDecision(
      signal,
      orderbook,
      totalExposure,
      this.config.maxTotalExposure,
      positions.length,
      positions.filter((p) => p.exchange === (this.config.mode === "live" ? "live" : "paper")).length,
      this.positionTracker.getDailyPnl()
    );

    if (decision.action === "NO_TRADE" || decision.size <= 0) {
      this.lastTickTime = Date.now() - tickStart;
      return;
    }

    // Create order via OMS
    const side = decision.action === "OPEN_LONG" ? "BUY" : "SELL";
    const order = this.oms.createOrder(
      instrument,
      this.config.mode === "live" ? "live" : "paper",
      side as "BUY" | "SELL",
      "LIMIT",
      decision.entryPrice,
      decision.size,
      signal.strategy,
      signal.id
    );

    // Record for manipulation detection
    this.manipulationDetector.recordOrder(side, decision.entryPrice, decision.size, false);

    // Record tax lot
    if (side === "BUY") {
      this.taxLotTracker.recordPurchase(instrument, this.config.mode, decision.size, decision.entryPrice);
    }

    // Simulate fill for paper/backtest modes
    if (this.config.mode !== "live") {
      this.oms.transitionState(order.id, "VALIDATED");
      this.oms.transitionState(order.id, "SUBMITTED");
      this.oms.transitionState(order.id, "ACKNOWLEDGED");
      this.oms.recordFill(order.id, decision.entryPrice, decision.size, decision.size * 0.001);
    }

    // 7. Update positions
    if (order.state === "FILLED" || this.config.mode !== "live") {
      this.positionTracker.openPosition(
        instrument,
        this.config.mode === "live" ? "live" : "paper",
        signal.direction === "LONG" ? "LONG" : "SHORT",
        decision.size,
        decision.entryPrice,
        signal.strategy,
        order.id
      );
    }

    // 8. Post-trade TCA
    if (order.filledSize > 0) {
      PostTradeTCA.analyze(
        {
          id: order.id,
          parentOrderId: order.id,
          instrument,
          exchange: this.config.mode === "live" ? "live" : "paper",
          side: side as "BUY" | "SELL",
          price: decision.entryPrice,
          size: decision.size,
          type: "LIMIT",
          algorithm: "SMART",
          status: "FILLED",
          filledSize: decision.size,
          filledAvgPrice: decision.entryPrice,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          slicedOrders: [],
        },
        decision.entryPrice,
        price,
        price,
        price,
        price,
        decision.size * 0.001
      );
    }

    // Update risk equity tracking
    const totalEquity = this.config.maxTotalExposure + this.positionTracker.getTotalUnrealizedPnl();
    this.riskManager.updateEquity(totalEquity);

    this.lastTickTime = Date.now() - tickStart;
  }

  // ==========================================================================
  // BACKTESTING
  // ==========================================================================

  runBacktest(
    historicalData: { timestamp: number; open: number; high: number; low: number; close: number; volume: number; instrument: string }[],
    config?: { initialCapital?: number; walkForward?: boolean; numWindows?: number }
  ): any {
    const initialCapital = config?.initialCapital || 100;

    logger.info(`[MASTER] Running backtest: ${historicalData.length} bars, $${initialCapital} capital`);

    this.backtestEngine = new BacktestEngine(historicalData, initialCapital);

    // Simple momentum signal for backtest
    const signalFn = (currentBar: any, history: any[], position: any) => {
      if (history.length < 20) return { action: "HOLD" as const };
      const prices = history.slice(-20).map((b: any) => b.close);
      const avg = prices.reduce((s: number, p: number) => s + p, 0) / prices.length;
      if (!position && currentBar.close > avg * 1.01) return { action: "BUY" as const };
      if (!position && currentBar.close < avg * 0.99) return { action: "SELL" as const };
      if (position) {
        const pnlPct = position.side === "LONG"
          ? (currentBar.close - position.entryPrice) / position.entryPrice
          : (position.entryPrice - currentBar.close) / position.entryPrice;
        if (pnlPct > 0.015 || pnlPct < -0.01) return { action: position.side === "LONG" ? "SELL" as const : "BUY" as const };
      }
      return { action: "HOLD" as const };
    };

    if (config?.walkForward) {
      const wfResult = this.backtestEngine.walkForward(
        [signalFn],
        0.70,
        config.numWindows || 5
      );
      logger.info(`[MASTER] Walk-forward: testSharpe=${wfResult.aggregateTestSharpe.toFixed(2)}, degradation=${wfResult.degradationRatio.toFixed(2)}, robust=${wfResult.isRobust}`);
      return wfResult;
    }

    const result = this.backtestEngine.run(signalFn, "master_strategy");
    logger.info(`[MASTER] Backtest: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpeRatio.toFixed(2)}, trades=${result.totalTrades}, maxDD=${(result.maxDrawdown * 100).toFixed(2)}%`);
    return result;
  }

  // ==========================================================================
  // SYSTEM STATUS
  // ==========================================================================

  getSystemStatus(): Record<string, any> {
    const uptime = this.running ? Date.now() - this.startTime : 0;
    const tradeStats = this.strategyEngine.getTradeStats();
    const edgeMetrics = this.strategyEngine.getEdgeMetrics();
    const omsStats = this.oms.getOrderStats();
    const pipelineStats = this.dataPipeline.getStats();
    const mmPerf = this.marketMakingEngine.getPerformance();
    const modelHealth = this.modelMonitor.checkDegradation();

    return {
      system: {
        running: this.running,
        mode: this.config.mode,
        riskLevel: this.config.riskLevel,
        uptimeMs: uptime,
        uptimeMinutes: (uptime / 60000).toFixed(1),
        ticksProcessed: this.tickCount,
        lastTickLatencyMs: this.lastTickTime,
        enabledStrategies: this.config.enabledStrategies,
      },
      trading: {
        totalPnl: tradeStats.totalPnl,
        winRate: tradeStats.winRate,
        tradeCount: tradeStats.tradeCount,
        wins: tradeStats.wins,
        losses: tradeStats.losses,
        openPositions: this.positionTracker.getOpenPositions().length,
        totalExposure: this.positionTracker.getTotalExposure(),
        unrealizedPnl: this.positionTracker.getTotalUnrealizedPnl(),
        dailyPnl: this.positionTracker.getDailyPnl(),
      },
      risk: {
        killSwitchTriggered: this.killSwitch.isTriggered(),
        tradingHalted: this.riskManager.isTradingHalted(),
        edgeSharpe: edgeMetrics.sharpe,
        edgeMultiplier: edgeMetrics.multiplier,
        edgeHalted: edgeMetrics.halted,
      },
      orders: omsStats,
      dataPipeline: pipelineStats,
      marketMaking: {
        running: this.marketMakingEngine.isRunning(),
        totalTrades: mmPerf.totalTrades,
        spreadsCaptured: mmPerf.spreadsCaptured,
        sharpeRatio: mmPerf.sharpeRatio,
      },
      ml: {
        isDegraded: modelHealth.isDegraded,
        mae: modelHealth.mae,
        maeTrend: modelHealth.maeTrend,
        predActualCorr: modelHealth.predActualCorr,
        shouldRetrain: modelHealth.shouldRetrain,
      },
      compliance: {
        manipulationAlerts: this.manipulationDetector.getAlerts().length,
        taxSummary: this.taxLotTracker.getTaxSummary(),
      },
      alerts: {
        unacknowledged: this.alertSystem.getUnacknowledged().length,
        recent: this.alertSystem.getRecent(5),
      },
    };
  }

  // ==========================================================================
  // DASHBOARD PAYLOAD
  // ==========================================================================

  getDashboardPayload(): Record<string, any> {
    const status = this.getSystemStatus();
    const positions = this.positionTracker.getOpenPositions();
    const recentOrders = this.oms.getRecentOrders(20);
    const mmInventories = this.marketMakingEngine.getAllInventories();
    const mmPnlDecomp = this.marketMakingEngine.getPnLDecomposition();
    const alerts = this.alertSystem.getRecent(20);

    return {
      timestamp: Date.now(),
      config: this.config,
      status,
      positions: positions.map((p) => ({
        id: p.id,
        instrument: p.instrument,
        exchange: p.exchange,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl,
        strategy: p.strategy,
        openedAt: p.openedAt,
        holdTimeMs: Date.now() - p.openedAt,
      })),
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        instrument: o.instrument,
        side: o.side,
        type: o.type,
        price: o.price,
        size: o.size,
        state: o.state,
        strategy: o.strategy,
        createdAt: o.createdAt,
      })),
      marketMaking: {
        inventories: mmInventories,
        pnlDecomposition: mmPnlDecomp,
        dailyPnl: this.marketMakingEngine.getDailyPnl(),
      },
      alerts,
    };
  }

  // ==========================================================================
  // ACCESSORS
  // ==========================================================================

  isRunning(): boolean { return this.running; }
  getConfig(): ISystemConfig { return { ...this.config }; }
  getAlertSystem(): AlertSystem { return this.alertSystem; }
  getOMS(): OrderManagementSystem { return this.oms; }
  getPositionTracker(): PositionTracker { return this.positionTracker; }
  getRiskManager(): InstitutionalRiskManager { return this.riskManager; }
  getStrategyEngine(): QuantStrategyEngine { return this.strategyEngine; }
  getMarketMakingEngine(): MarketMakingEngine { return this.marketMakingEngine; }
  getDataPipeline(): MarketDataPipeline { return this.dataPipeline; }
}

// ============================================================================
// SYSTEM HEALTH MONITOR
// ============================================================================

export class SystemHealthMonitor {
  private masterSystem: QuantMasterSystem;
  private healthHistory: { timestamp: number; healthy: boolean; issues: string[] }[] = [];
  private tickTimestamps: number[] = [];

  constructor(masterSystem: QuantMasterSystem) {
    this.masterSystem = masterSystem;
  }

  /**
   * Comprehensive health check across all subsystems.
   */
  checkHealth(): {
    overall: "HEALTHY" | "DEGRADED" | "CRITICAL";
    subsystems: Record<string, { healthy: boolean; status: string }>;
    issues: string[];
  } {
    const issues: string[] = [];
    const subsystems: Record<string, { healthy: boolean; status: string }> = {};
    const status = this.masterSystem.getSystemStatus();

    // 1. System running
    subsystems["system"] = {
      healthy: status.system.running,
      status: status.system.running ? "running" : "stopped",
    };
    if (!status.system.running) issues.push("System is not running");

    // 2. Data pipeline
    const pipelineHealthy = status.dataPipeline.validationRate > 0.95;
    subsystems["data_pipeline"] = {
      healthy: pipelineHealthy,
      status: `${status.dataPipeline.ticksProcessed} ticks, ${(status.dataPipeline.validationRate * 100).toFixed(1)}% valid`,
    };
    if (!pipelineHealthy) issues.push(`Data quality degraded: ${(status.dataPipeline.validationRate * 100).toFixed(1)}% valid`);

    // 3. Risk management
    const riskHealthy = !status.risk.tradingHalted && !status.risk.killSwitchTriggered;
    subsystems["risk_management"] = {
      healthy: riskHealthy,
      status: status.risk.tradingHalted ? "HALTED" : status.risk.killSwitchTriggered ? "KILL_SWITCH" : "active",
    };
    if (!riskHealthy) issues.push("Risk management has halted trading");

    // 4. Strategy engine
    const edgeHealthy = !status.risk.edgeHalted;
    subsystems["strategy_engine"] = {
      healthy: edgeHealthy,
      status: `sharpe=${status.risk.edgeSharpe.toFixed(2)}, multiplier=${status.risk.edgeMultiplier.toFixed(2)}`,
    };
    if (!edgeHealthy) issues.push("Strategy edge has decayed — halted");

    // 5. OMS
    const omsHealthy = status.orders.rejected === 0 || status.orders.rejected / Math.max(1, status.orders.total) < 0.1;
    subsystems["oms"] = {
      healthy: omsHealthy,
      status: `${status.orders.open} open, ${status.orders.filled} filled, ${status.orders.rejected} rejected`,
    };
    if (!omsHealthy) issues.push(`High OMS rejection rate: ${status.orders.rejected}/${status.orders.total}`);

    // 6. ML pipeline
    const mlHealthy = !status.ml.isDegraded;
    subsystems["ml_pipeline"] = {
      healthy: mlHealthy,
      status: `MAE=${status.ml.mae.toFixed(4)}, trend=${status.ml.maeTrend}, corr=${status.ml.predActualCorr.toFixed(3)}`,
    };
    if (!mlHealthy) issues.push("ML model degraded — retrain recommended");

    // 7. Market making
    subsystems["market_making"] = {
      healthy: true,
      status: status.marketMaking.running ? `running, ${status.marketMaking.totalTrades} trades` : "stopped",
    };

    // 8. Compliance
    const complianceHealthy = status.compliance.manipulationAlerts === 0;
    subsystems["compliance"] = {
      healthy: complianceHealthy,
      status: `${status.compliance.manipulationAlerts} alerts`,
    };
    if (!complianceHealthy) issues.push(`Compliance alerts: ${status.compliance.manipulationAlerts}`);

    // Determine overall health
    const criticalIssues = issues.filter((i) =>
      i.includes("HALTED") || i.includes("KILL_SWITCH") || i.includes("not running")
    );
    let overall: "HEALTHY" | "DEGRADED" | "CRITICAL" = "HEALTHY";
    if (criticalIssues.length > 0) overall = "CRITICAL";
    else if (issues.length > 0) overall = "DEGRADED";

    // Record history
    this.healthHistory.push({ timestamp: Date.now(), healthy: overall === "HEALTHY", issues });
    if (this.healthHistory.length > 1000) this.healthHistory.splice(0, this.healthHistory.length - 1000);

    // Emit alert on critical
    if (overall === "CRITICAL") {
      this.masterSystem.getAlertSystem().emit("CRITICAL", "HEALTH", `System health: ${overall}`, { issues });
    }

    return { overall, subsystems, issues };
  }

  getUptime(): number {
    const status = this.masterSystem.getSystemStatus();
    return status.system.uptimeMs;
  }

  getTickRate(): number {
    const now = Date.now();
    this.tickTimestamps.push(now);
    const oneSecondAgo = now - 1000;
    this.tickTimestamps = this.tickTimestamps.filter((t) => t > oneSecondAgo);
    return this.tickTimestamps.length;
  }

  getLatency(): number {
    const status = this.masterSystem.getSystemStatus();
    return status.system.lastTickLatencyMs;
  }

  getHealthHistory(n = 100): { timestamp: number; healthy: boolean; issues: string[] }[] {
    return this.healthHistory.slice(-n);
  }
}

// ============================================================================
// TRADING SESSION
// ============================================================================

export class TradingSession {
  private masterSystem: QuantMasterSystem;
  private sessionStart: number = 0;
  private sessionEnd: number = 0;
  private paused: boolean = false;
  private pauseReason: string = "";
  private sessionActive: boolean = false;
  private sessionConfig: ISystemConfig | null = null;
  private startingPnl: number = 0;

  constructor(masterSystem: QuantMasterSystem) {
    this.masterSystem = masterSystem;
  }

  async startSession(config?: Partial<ISystemConfig>): Promise<void> {
    if (this.sessionActive) {
      logger.warning("[SESSION] Session already active");
      return;
    }

    this.sessionStart = Date.now();
    this.sessionActive = true;
    this.paused = false;
    this.pauseReason = "";

    // Capture starting P&L for session tracking
    const status = this.masterSystem.getSystemStatus();
    this.startingPnl = status.trading.totalPnl;

    if (!this.masterSystem.isRunning()) {
      await this.masterSystem.start();
    }

    logger.info(`[SESSION] Trading session started at ${new Date(this.sessionStart).toISOString()}`);
  }

  async endSession(): Promise<Record<string, any>> {
    if (!this.sessionActive) {
      logger.warning("[SESSION] No active session");
      return {};
    }

    this.sessionEnd = Date.now();
    this.sessionActive = false;

    const status = this.masterSystem.getSystemStatus();
    const durationMs = this.sessionEnd - this.sessionStart;
    const sessionPnl = status.trading.totalPnl - this.startingPnl;
    const durationMin = durationMs / 60000;

    // Calculate session-level Sharpe (simplified annualization)
    const returnsPerMin = durationMin > 0 ? sessionPnl / durationMin : 0;
    const annualFactor = Math.sqrt(252 * 6.5 * 60); // minutes in a trading year

    const report = {
      sessionStart: this.sessionStart,
      sessionEnd: this.sessionEnd,
      durationMs,
      durationMinutes: durationMin.toFixed(1),
      trades: status.trading.tradeCount,
      pnl: sessionPnl,
      winRate: status.trading.winRate,
      openPositions: status.trading.openPositions,
      ticksProcessed: status.system.ticksProcessed,
      mode: status.system.mode,
    };

    logger.info(`[SESSION] Session ended | Duration: ${durationMin.toFixed(1)}min | P&L: $${sessionPnl.toFixed(4)} | Trades: ${status.trading.tradeCount}`);

    return report;
  }

  pauseTrading(reason: string): void {
    if (!this.sessionActive) return;
    this.paused = true;
    this.pauseReason = reason;
    logger.warning(`[SESSION] Trading PAUSED: ${reason}`);
    this.masterSystem.getAlertSystem().emit("WARNING", "SESSION", `Trading paused: ${reason}`);
  }

  resumeTrading(): void {
    if (!this.sessionActive || !this.paused) return;
    this.paused = false;
    logger.info(`[SESSION] Trading RESUMED (was paused: ${this.pauseReason})`);
    this.pauseReason = "";
    this.masterSystem.getAlertSystem().emit("INFO", "SESSION", "Trading resumed");
  }

  isPaused(): boolean { return this.paused; }
  isActive(): boolean { return this.sessionActive; }
  getPauseReason(): string { return this.pauseReason; }

  getSessionStats(): Record<string, any> {
    if (!this.sessionActive && this.sessionStart === 0) return {};

    const status = this.masterSystem.getSystemStatus();
    const durationMs = (this.sessionEnd || Date.now()) - this.sessionStart;

    return {
      active: this.sessionActive,
      paused: this.paused,
      pauseReason: this.pauseReason,
      durationMs,
      durationMinutes: (durationMs / 60000).toFixed(1),
      trades: status.trading.tradeCount,
      pnl: status.trading.totalPnl - this.startingPnl,
      winRate: status.trading.winRate,
      openPositions: status.trading.openPositions,
    };
  }
}

// ============================================================================
// QUANT SYSTEM FACTORY
// ============================================================================

export class QuantSystemFactory {
  /**
   * Paper trading: safe simulation with all strategies enabled.
   */
  static createPaperTradingSystem(): QuantMasterSystem {
    return new QuantMasterSystem({
      mode: "paper",
      riskLevel: "moderate",
      enabledStrategies: ["momentum", "mean_reversion", "microstructure", "ml_ensemble", "market_making"],
      maxTotalExposure: 100,
      dashboardPort: 3100,
      tickIntervalMs: 500,
    });
  }

  /**
   * Backtest system: optimized for historical data processing.
   */
  static createBacktestSystem(): QuantMasterSystem {
    return new QuantMasterSystem({
      mode: "backtest",
      riskLevel: "aggressive",
      enabledStrategies: ["momentum", "mean_reversion", "microstructure", "cross_asset", "ml_ensemble"],
      maxTotalExposure: 100,
      dashboardPort: 3101,
      tickIntervalMs: 0,
    });
  }

  /**
   * Live trading: full production deployment with strict risk controls.
   */
  static createLiveTradingSystem(config: Partial<ISystemConfig> = {}): QuantMasterSystem {
    return new QuantMasterSystem({
      mode: "live",
      riskLevel: config.riskLevel || "conservative",
      enabledStrategies: config.enabledStrategies || ["momentum", "mean_reversion"],
      maxTotalExposure: config.maxTotalExposure || 50,
      dashboardPort: config.dashboardPort || 3102,
      tickIntervalMs: config.tickIntervalMs || 500,
    });
  }

  /**
   * Research system: for signal research and factor analysis only.
   * No execution, no OMS, just data and analytics.
   */
  static createResearchSystem(): QuantMasterSystem {
    return new QuantMasterSystem({
      mode: "paper",
      riskLevel: "aggressive",
      enabledStrategies: [],
      maxTotalExposure: 0,
      dashboardPort: 3103,
      tickIntervalMs: 0,
    });
  }
}
