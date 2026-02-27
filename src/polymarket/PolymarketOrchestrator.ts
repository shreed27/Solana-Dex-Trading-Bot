import cron from "node-cron";
import { connectToDatabase } from "../config/mongoose";
import { PolymarketClient } from "./PolymarketClient";
import { PriceFeedService } from "./PriceFeedService";
import { MarketDiscoveryService } from "./MarketDiscoveryService";
import { PolymarketRiskManager } from "./PolymarketRiskManager";
import { PolymarketExecutionEngine } from "./PolymarketExecutionEngine";
import { PolymarketPositionManager } from "./PolymarketPositionManager";
import { HFTTickEngine } from "./HFTTickEngine";
import { SignalAggregator } from "../engine/SignalAggregator";
import { IStrategy } from "../strategies/IStrategy";
import {
  IStrategyConfig,
  StrategyCategory,
  StrategyTier,
  SignalDirection,
} from "../types/strategy.types";
import { PolymarketAsset, PolymarketInterval } from "../types/polymarket.types";
import { logger } from "../utils/logger";

// Multi-exchange imports
import { KalshiClient } from "../exchange/KalshiClient";
import { KalshiMarketDiscovery } from "../exchange/KalshiMarketDiscovery";
import { HyperliquidClient } from "../exchange/HyperliquidClient";
import { HyperliquidMarketData } from "../exchange/HyperliquidMarketData";
import { MultiExchangeTickEngine } from "../exchange/MultiExchangeTickEngine";
import { DemoWallet } from "../exchange/DemoWallet";
import { DashboardServer } from "../dashboard/DashboardServer";
import { env } from "../config/environment";

// Polymarket strategies
import { PolyMACDMomentumStrategy } from "../strategies/polymarket/PolyMACDMomentumStrategy";
import { PolyVolumeBreakoutStrategy } from "../strategies/polymarket/PolyVolumeBreakoutStrategy";
import { PolyMeanReversionBBStrategy } from "../strategies/polymarket/PolyMeanReversionBBStrategy";
import { ProbabilityEdgeStrategy } from "../strategies/polymarket/ProbabilityEdgeStrategy";
import { MomentumScalperStrategy } from "../strategies/polymarket/MomentumScalperStrategy";
import { VolatilityRegimeStrategy } from "../strategies/polymarket/VolatilityRegimeStrategy";
import { OrderFlowStrategy } from "../strategies/polymarket/OrderFlowStrategy";

// Strategy configs for Polymarket
const POLYMARKET_STRATEGY_CONFIGS: IStrategyConfig[] = [
  {
    id: "poly-probability-edge",
    name: "Probability Edge Detector",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.NORMAL,
    enabled: true,
    weight: 0.25,
    intervalMs: 30000,
    params: { minEdge: 0.08 },
    circuitBreakerThreshold: 5,
  },
  {
    id: "poly-momentum-scalper",
    name: "Momentum Scalper",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.FAST,
    enabled: true,
    weight: 0.20,
    intervalMs: 10000,
    params: {},
    circuitBreakerThreshold: 5,
  },
  {
    id: "poly-macd-momentum",
    name: "MACD & RSI Momentum",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.NORMAL,
    enabled: true,
    weight: 0.15,
    intervalMs: 30000,
    params: {},
    circuitBreakerThreshold: 5,
  },
  {
    id: "poly-volume-breakout",
    name: "Volume Surge Breakout",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.NORMAL,
    enabled: true,
    weight: 0.10,
    intervalMs: 30000,
    params: { spikeMultiplier: 3, priceChangeThreshold: 0.001 },
    circuitBreakerThreshold: 5,
  },
  {
    id: "poly-mean-reversion-bb",
    name: "BB Mean Reversion",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.NORMAL,
    enabled: true,
    weight: 0.10,
    intervalMs: 60000,
    params: { bbPeriod: 20, bbStdDev: 2, adxThreshold: 25 },
    circuitBreakerThreshold: 5,
  },
  {
    id: "poly-volatility-regime",
    name: "Volatility Regime",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.SLOW,
    enabled: true,
    weight: 0.10,
    intervalMs: 120000,
    params: {},
    circuitBreakerThreshold: 5,
  },
  {
    id: "poly-order-flow",
    name: "Order Flow Analysis",
    category: StrategyCategory.SIGNAL,
    tier: StrategyTier.FAST,
    enabled: true,
    weight: 0.10,
    intervalMs: 15000,
    params: { imbalanceThreshold: 0.15 },
    circuitBreakerThreshold: 5,
  },
];

export class PolymarketOrchestrator {
  private client: PolymarketClient;
  private priceFeed: PriceFeedService;
  private discovery: MarketDiscoveryService;
  private riskManager: PolymarketRiskManager;
  private executionEngine: PolymarketExecutionEngine;
  private positionManager: PolymarketPositionManager;
  private signalAggregator: SignalAggregator;
  private hftEngine: HFTTickEngine;

  // Multi-exchange components
  private kalshiClient: KalshiClient;
  private kalshiDiscovery: KalshiMarketDiscovery;
  private hyperliquidClient: HyperliquidClient;
  private hyperliquidData: HyperliquidMarketData;
  private multiExchangeEngine: MultiExchangeTickEngine;
  private demoWallet: DemoWallet;
  private dashboardServer: DashboardServer;

  private strategies: Map<string, IStrategy> = new Map();
  private cronJobs: ReturnType<typeof cron.schedule>[] = [];

  constructor() {
    this.client = new PolymarketClient();
    this.priceFeed = new PriceFeedService();
    this.discovery = new MarketDiscoveryService(this.client);
    this.riskManager = new PolymarketRiskManager(this.client, this.discovery);
    this.positionManager = new PolymarketPositionManager(
      this.client,
      this.riskManager
    );
    this.executionEngine = new PolymarketExecutionEngine(
      this.client,
      this.discovery,
      this.riskManager,
      this.positionManager
    );
    this.signalAggregator = new SignalAggregator();
    this.hftEngine = new HFTTickEngine(
      this.client,
      this.priceFeed,
      this.discovery
    );

    // Multi-exchange setup
    this.kalshiClient = new KalshiClient(env.kalshiApiKey);
    this.kalshiDiscovery = new KalshiMarketDiscovery(this.kalshiClient);
    this.hyperliquidClient = new HyperliquidClient();
    this.hyperliquidData = new HyperliquidMarketData(this.hyperliquidClient);
    this.demoWallet = new DemoWallet(env.demoStartingBalance);

    const perfTracker = this.hftEngine.getPerformanceTracker();
    this.multiExchangeEngine = new MultiExchangeTickEngine(
      this.kalshiClient,
      this.kalshiDiscovery,
      this.hyperliquidClient,
      this.hyperliquidData,
      this.demoWallet,
      perfTracker,
      this.hftEngine
    );

    this.dashboardServer = new DashboardServer(
      this.demoWallet,
      perfTracker,
      this.multiExchangeEngine,
      this.hftEngine,
      env.dashboardPort
    );
  }

  async start(): Promise<void> {
    logger.info("=== Polymarket Trading Bot Starting ===");

    // 1. Connect to MongoDB
    await connectToDatabase();
    logger.success("MongoDB connected");

    // 2. Initialize Polymarket client
    const polygonKey = process.env.POLYGON_PRIVATE_KEY;
    if (polygonKey) {
      await this.client.initialize(polygonKey);
      logger.success(`Polymarket client initialized (auth: ${this.client.isAuthenticated()})`);
    } else {
      logger.warning("POLYGON_PRIVATE_KEY not set - running in read-only mode");
    }

    // 3. Initialize price feed (Binance)
    await this.priceFeed.initialize();

    // 4. Initialize market discovery (Gamma API)
    await this.discovery.initialize();

    // 5. Initialize position manager
    await this.positionManager.initialize();

    // 6. Initialize strategies
    await this.initializeStrategies();

    // 7. Schedule cron jobs
    this.scheduleCronJobs();

    // 8. Start HFT tick engine (500ms sub-second loop)
    await this.hftEngine.start();

    // 9. Start multi-exchange engine (Kalshi + Hyperliquid)
    await this.multiExchangeEngine.start();

    // 10. Start dashboard server
    await this.dashboardServer.start();

    // 11. Log status
    const stats = await this.positionManager.getStats();
    const mexStats = this.multiExchangeEngine.getStats();
    logger.success(
      `=== Trading Bot Ready | ${this.strategies.size} strategies + 4 HFT | ${stats.openCount} open positions ===`
    );
    logger.success(
      `=== Multi-Exchange: Kalshi (${mexStats.kalshiMarkets} markets) + Hyperliquid (${mexStats.hyperliquidCoins} perps) ===`
    );
    logger.success(
      `=== Dashboard: http://localhost:${env.dashboardPort} | Demo Wallet: $${this.demoWallet.getBalance().toFixed(2)} ===`
    );
  }

  private async initializeStrategies(): Promise<void> {
    // Create strategy instances with dependency injection
    const strategyInstances: IStrategy[] = [
      new ProbabilityEdgeStrategy(this.priceFeed, this.discovery),
      new MomentumScalperStrategy(this.priceFeed),
      new PolyMACDMomentumStrategy(this.priceFeed),
      new PolyVolumeBreakoutStrategy(this.priceFeed),
      new PolyMeanReversionBBStrategy(this.priceFeed),
      new VolatilityRegimeStrategy(this.priceFeed),
      new OrderFlowStrategy(this.client, this.discovery),
    ];

    for (const strategy of strategyInstances) {
      const config = POLYMARKET_STRATEGY_CONFIGS.find(
        (c) => c.id === strategy.id
      );
      if (!config) continue;

      try {
        await strategy.initialize(config);
        this.strategies.set(strategy.id, strategy);
        this.signalAggregator.setWeight(config.id, config.weight);
        logger.info(
          `Strategy loaded: ${config.name} (weight: ${config.weight})`
        );
      } catch (err) {
        logger.error(`Failed to init strategy ${strategy.id}:`, err);
      }
    }
  }

  private scheduleCronJobs(): void {
    // FAST tier: every 10 seconds
    this.cronJobs.push(
      cron.schedule("*/10 * * * * *", () =>
        this.runTier(StrategyTier.FAST)
      )
    );

    // NORMAL tier: every 30 seconds
    this.cronJobs.push(
      cron.schedule("*/30 * * * * *", () =>
        this.runTier(StrategyTier.NORMAL)
      )
    );

    // SLOW tier: every 2 minutes
    this.cronJobs.push(
      cron.schedule("*/2 * * * *", () =>
        this.runTier(StrategyTier.SLOW)
      )
    );

    // Signal processing + execution: every 15 seconds
    this.cronJobs.push(
      cron.schedule("*/15 * * * * *", () => this.processSignals())
    );

    // Signal cleanup: every 5 minutes
    this.cronJobs.push(
      cron.schedule("*/5 * * * *", () =>
        this.signalAggregator.pruneExpired()
      )
    );

    // Stats logging: every 5 minutes
    this.cronJobs.push(
      cron.schedule("*/5 * * * *", () => this.logStats())
    );

    logger.info("Cron jobs scheduled for Polymarket trading");
  }

  /**
   * Run all strategies in a given tier.
   * Token addresses are replaced by asset symbols for Polymarket.
   */
  private async runTier(tier: StrategyTier): Promise<void> {
    const strategies = [...this.strategies.values()].filter(
      (s) => s.tier === tier && s.isHealthy()
    );
    if (strategies.length === 0) return;

    // For Polymarket, "tokens" are asset symbols
    const assets = this.discovery.getActiveAssets();
    if (assets.length === 0) return;

    const results = await Promise.allSettled(
      strategies.map((s) => s.execute(assets))
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.signals) {
        for (const signal of result.value.signals) {
          this.signalAggregator.ingestSignal(signal);
        }
      }
    }
  }

  /**
   * Process aggregated signals and execute Polymarket trades.
   */
  private async processSignals(): Promise<void> {
    try {
      const assets: PolymarketAsset[] = ["BTC", "ETH", "XRP"];
      const intervals: PolymarketInterval[] = ["5M", "15M"];

      for (const asset of assets) {
        // Get aggregated signal for this asset
        const aggregated = this.signalAggregator.getAggregatedSignal(asset);
        if (!aggregated) continue;
        if (aggregated.direction === SignalDirection.NEUTRAL) continue;
        if (aggregated.compositeScore < 0.60) continue;

        for (const interval of intervals) {
          const market = this.discovery.getCurrentMarket(asset, interval);
          if (!market) continue;

          // Execute trade
          const result = await this.executionEngine.executeTrade(
            asset,
            interval,
            aggregated
          );

          if (result.success) {
            logger.success(
              `Trade executed: ${result.direction} ${asset} ${interval} @ ${result.entryPrice.toFixed(3)} | $${result.size.toFixed(2)} | score: ${result.compositeScore.toFixed(3)} | strategies: ${result.strategies.join(", ")}`
            );
          } else if (result.error && !result.error.includes("Risk denied")) {
            logger.warning(
              `Trade skipped: ${asset} ${interval} - ${result.error}`
            );
          }
        }
      }
    } catch (err) {
      logger.error("Signal processing error:", err);
    }
  }

  private async logStats(): Promise<void> {
    const stats = await this.positionManager.getStats();
    const dailyPnl = this.riskManager.getDailyPnl();
    const signalStats = this.signalAggregator.getStats();

    logger.info(
      `[Stats] Open: ${stats.openCount} | Exposure: $${stats.totalExposure.toFixed(0)} | ` +
        `Resolved: ${stats.resolvedCount} | Total P&L: $${stats.totalPnl.toFixed(2)} | ` +
        `Win rate: ${(stats.winRate * 100).toFixed(1)}% | Daily P&L: $${dailyPnl.toFixed(2)} | ` +
        `Signals: ${signalStats.totalSignals}`
    );

    // HFT metrics
    const hftMetrics = this.hftEngine.getPerformanceMetrics();
    if (hftMetrics.totalTrades > 0) {
      logger.info(
        `[HFT] Trades: ${hftMetrics.totalTrades} | WR: ${(hftMetrics.winRate * 100).toFixed(1)}% | ` +
          `PF: ${hftMetrics.profitFactor} | Sharpe: ${hftMetrics.sharpeRatio} | ` +
          `Sortino: ${hftMetrics.sortinoRatio} | PnL: $${hftMetrics.totalPnl} | DD: $${hftMetrics.maxDrawdown}`
      );
    }

    const hftStats = this.hftEngine.getStats();
    logger.info(
      `[HFT Engine] Ticks: ${hftStats.ticksProcessed} | Opps: ${hftStats.opportunitiesFound} | Trades: ${hftStats.tradesExecuted} | Open Orders: ${hftStats.openOrders}`
    );

    // Multi-exchange metrics
    const mexStats = this.multiExchangeEngine.getStats();
    const walletState = this.demoWallet.getState();
    logger.info(
      `[Multi-Exchange] Ticks: ${mexStats.tickCount} | Cross-Opps: ${mexStats.crossExchangeOpps} | Cross-Trades: ${mexStats.crossExchangeTrades} | ` +
        `Kalshi: ${mexStats.kalshiBooksCount}/${mexStats.kalshiMarkets} | Hyperliquid: ${mexStats.hyperliquidBooksCount}/${mexStats.hyperliquidCoins}`
    );
    logger.info(
      `[DemoWallet] Balance: $${walletState.totalBalance.toFixed(2)} | Equity: $${walletState.totalEquity.toFixed(2)} | ` +
        `Positions: ${walletState.positions.length} | Realized PnL: $${walletState.totalRealizedPnl.toFixed(2)} | ` +
        `Dashboard clients: ${this.dashboardServer.getClientCount()}`
    );
  }

  // Public accessors for dashboard/test
  getDemoWallet(): DemoWallet { return this.demoWallet; }
  getMultiExchangeEngine(): MultiExchangeTickEngine { return this.multiExchangeEngine; }
  getDashboardServer(): DashboardServer { return this.dashboardServer; }
  getHFTEngine(): HFTTickEngine { return this.hftEngine; }

  async shutdown(): Promise<void> {
    logger.info("Orchestrator shutting down...");

    // Stop dashboard first
    this.dashboardServer.stop();

    // Stop multi-exchange engine
    await this.multiExchangeEngine.stop();

    // Stop HFT engine (cancels all open orders)
    await this.hftEngine.stop();

    for (const job of this.cronJobs) {
      job.stop();
    }

    for (const [id, strategy] of this.strategies) {
      try {
        await strategy.shutdown();
      } catch (err) {
        logger.error(`Error shutting down ${id}:`, err);
      }
    }

    await this.positionManager.shutdown();
    await this.discovery.shutdown();
    await this.priceFeed.shutdown();

    const walletState = this.demoWallet.getState();
    logger.info(
      `Final Demo Wallet: $${walletState.totalEquity.toFixed(2)} | Realized PnL: $${walletState.totalRealizedPnl.toFixed(2)}`
    );
    logger.info("Orchestrator shutdown complete");
  }
}
