import cron from "node-cron";
import { connectToDatabase } from "../config/mongoose";
import { WalletService } from "../services/WalletService";
import { DexScreenerClient } from "../services/DexScreenerClient";
import { MarketDataService } from "../services/MarketDataService";
import { WebSocketService } from "../services/WebSocketService";
import { Token } from "../models/Token";
import {
  StrategyConfigModel,
  DEFAULT_STRATEGY_CONFIGS,
} from "../models/StrategyConfig";
import { IStrategy, IAutonomousStrategy } from "../strategies/IStrategy";
import { StrategyRegistry } from "../strategies/StrategyRegistry";
import { SignalAggregator } from "./SignalAggregator";
import { RiskGate } from "./RiskGate";
import { ExecutionEngine } from "./ExecutionEngine";
import { PositionManager } from "./PositionManager";
import {
  IStrategyConfig,
  StrategyCategory,
  StrategyTier,
} from "../types/strategy.types";
import { USDC_MINT_ADDRESS } from "../utils/constants";
import { logger } from "../utils/logger";

export class Orchestrator {
  private walletService: WalletService;
  private dexScreener: DexScreenerClient | null = null;
  private marketData: MarketDataService;
  private webSocket: WebSocketService;
  private signalAggregator: SignalAggregator;
  private riskGate: RiskGate;
  private executionEngine: ExecutionEngine;
  private positionManager: PositionManager;

  private signalStrategies: Map<string, IStrategy> = new Map();
  private autonomousStrategies: Map<string, IAutonomousStrategy> = new Map();
  private cronJobs: ReturnType<typeof cron.schedule>[] = [];

  constructor() {
    this.walletService = new WalletService();
    this.marketData = new MarketDataService();
    this.webSocket = new WebSocketService();
    this.signalAggregator = new SignalAggregator();
    this.riskGate = new RiskGate();
    this.positionManager = new PositionManager();
    this.executionEngine = new ExecutionEngine(
      this.walletService,
      this.positionManager,
      process.env.JITO_BLOCK_ENGINE_URL
    );
  }

  async start(): Promise<void> {
    const owner = this.walletService.getPublicKey().toString();

    // 1. Connect to MongoDB
    await connectToDatabase();
    logger.success("MongoDB connected");

    // 2. Seed default strategy configs if needed
    await this.seedStrategyConfigs();

    // 3. Log wallet info
    logger.success(`Wallet loaded: ${owner}`);
    const solBalance = await this.walletService.getSolBalance();
    const usdcBalance = await this.walletService.getUsdcBalance();
    logger.info(`SOL balance: ${solBalance}`);
    logger.info(`USDC balance: ${usdcBalance}`);

    // 4. Initialize infrastructure
    await this.marketData.initialize();
    await this.webSocket.initialize();
    await this.riskGate.initialize();
    await this.executionEngine.initialize();

    // 5. Start DexScreener (existing token discovery)
    this.dexScreener = new DexScreenerClient();
    await this.dexScreener.connect();

    // 6. Load and initialize strategies
    await this.initializeStrategies();

    // 7. Start autonomous strategies
    await this.startAutonomousStrategies();

    // 8. Schedule cron jobs
    this.scheduleCronJobs();

    logger.success(
      `Orchestrator started | ${this.signalStrategies.size} signal strategies | ${this.autonomousStrategies.size} autonomous strategies`
    );
  }

  private async seedStrategyConfigs(): Promise<void> {
    for (const config of DEFAULT_STRATEGY_CONFIGS) {
      await StrategyConfigModel.findOneAndUpdate(
        { strategyId: config.strategyId },
        { $setOnInsert: config },
        { upsert: true }
      );
    }
  }

  private async initializeStrategies(): Promise<void> {
    const configs = await StrategyConfigModel.find({
      enabled: true,
    }).exec();

    for (const configDoc of configs) {
      const strategyId = configDoc.strategyId;
      if (!StrategyRegistry.has(strategyId)) continue;

      try {
        const strategy = StrategyRegistry.create(strategyId);
        const config: IStrategyConfig = {
          id: configDoc.strategyId,
          name: configDoc.name,
          category: configDoc.category as StrategyCategory,
          tier: configDoc.tier as StrategyTier,
          enabled: configDoc.enabled,
          weight: configDoc.weight,
          intervalMs: configDoc.intervalMs,
          params: configDoc.params || {},
          circuitBreakerThreshold: configDoc.circuitBreakerThreshold,
        };

        await strategy.initialize(config);

        // Update aggregator weights
        if (config.category === StrategyCategory.SIGNAL) {
          this.signalAggregator.setWeight(config.id, config.weight);
        }

        if (config.category === StrategyCategory.AUTONOMOUS) {
          this.autonomousStrategies.set(
            strategyId,
            strategy as IAutonomousStrategy
          );
        } else if (
          config.category === StrategyCategory.SIGNAL
        ) {
          this.signalStrategies.set(strategyId, strategy);
        }
        // Risk and execution strategies are handled by RiskGate and ExecutionEngine
      } catch (err) {
        logger.error(`Failed to initialize strategy ${strategyId}:`, err);
      }
    }
  }

  private async startAutonomousStrategies(): Promise<void> {
    for (const [id, strategy] of this.autonomousStrategies) {
      try {
        await strategy.start();
        logger.success(`Autonomous strategy started: ${id}`);
      } catch (err) {
        logger.error(`Failed to start autonomous strategy ${id}:`, err);
      }
    }
  }

  private scheduleCronJobs(): void {
    // FAST tier: every 5 seconds
    this.cronJobs.push(
      cron.schedule("*/5 * * * * *", () =>
        this.runTier(StrategyTier.FAST)
      )
    );

    // NORMAL tier: every 60 seconds
    this.cronJobs.push(
      cron.schedule("*/1 * * * *", () =>
        this.runTier(StrategyTier.NORMAL)
      )
    );

    // SLOW tier: every 5 minutes
    this.cronJobs.push(
      cron.schedule("*/5 * * * *", () =>
        this.runTier(StrategyTier.SLOW)
      )
    );

    // Signal processing + execution: every 30 seconds
    this.cronJobs.push(
      cron.schedule("*/30 * * * * *", () => this.processSignals())
    );

    // Position PnL monitoring: every 2 minutes
    this.cronJobs.push(
      cron.schedule("*/2 * * * *", () =>
        this.positionManager.checkAllPositions(
          this.executionEngine.executeSell.bind(this.executionEngine)
        )
      )
    );

    // Signal cleanup: every 10 minutes
    this.cronJobs.push(
      cron.schedule("*/10 * * * *", () =>
        this.signalAggregator.pruneExpired()
      )
    );

    logger.info("Cron jobs scheduled");
  }

  /**
   * Run all signal strategies in a given tier.
   */
  private async runTier(tier: StrategyTier): Promise<void> {
    const strategies = [...this.signalStrategies.values()].filter(
      (s) => s.tier === tier && s.isHealthy()
    );

    if (strategies.length === 0) return;

    const tokens = await this.getTokenAddresses();
    if (tokens.length === 0) return;

    const results = await Promise.allSettled(
      strategies.map((s) => s.execute(tokens))
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
   * Process aggregated signals and execute trades.
   */
  private async processSignals(): Promise<void> {
    try {
      // Process buy signals
      const buySignals = this.signalAggregator.getBuyableTokens(0.65);

      for (const signal of buySignals) {
        // Risk gate
        const riskAssessment = await this.riskGate.assess(
          signal.tokenAddress
        );
        if (riskAssessment.overallScore < 85) {
          continue;
        }
        signal.passedRiskGate = true;
        signal.riskScore = riskAssessment.overallScore;

        // Check if we can open
        if (!(await this.positionManager.canOpenPosition(signal))) continue;

        // Calculate position size
        const positionSize =
          this.positionManager.calculatePositionSize(signal);

        // Check USDC balance
        const usdcBalance = await this.walletService.getUsdcBalance();
        if (usdcBalance < positionSize) continue;

        // Execute
        await this.executionEngine.executeBuy(
          signal,
          riskAssessment,
          positionSize
        );
      }

      // Process sell signals
      const sellSignals = this.signalAggregator.getSellableTokens(0.6);
      for (const signal of sellSignals) {
        await this.positionManager.processExitSignal(
          signal,
          this.executionEngine.executeSell.bind(this.executionEngine)
        );
      }

      // Log stats periodically
      const stats = this.signalAggregator.getStats();
      if (stats.totalSignals > 0) {
        logger.info(
          `Signals: ${stats.totalSignals} across ${stats.totalTokens} tokens | Buy candidates: ${buySignals.length} | Sell candidates: ${sellSignals.length}`
        );
      }
    } catch (err) {
      logger.error("Signal processing error:", err);
    }
  }

  private async getTokenAddresses(): Promise<string[]> {
    const tokens = await Token.find({})
      .sort({ timestamp: -1 })
      .limit(50)
      .exec();
    return tokens
      .map((t) => t.address)
      .filter(Boolean);
  }

  async shutdown(): Promise<void> {
    logger.info("Orchestrator shutting down...");

    // Stop cron jobs
    for (const job of this.cronJobs) {
      job.stop();
    }

    // Stop autonomous strategies
    for (const [id, strategy] of this.autonomousStrategies) {
      try {
        await strategy.stop();
      } catch (err) {
        logger.error(`Error stopping ${id}:`, err);
      }
    }

    // Shutdown signal strategies
    for (const [id, strategy] of this.signalStrategies) {
      try {
        await strategy.shutdown();
      } catch (err) {
        logger.error(`Error shutting down ${id}:`, err);
      }
    }

    // Shutdown infrastructure
    await this.marketData.shutdown();
    await this.webSocket.shutdown();
    if (this.dexScreener) {
      await this.dexScreener.disconnect();
    }

    logger.info("Orchestrator shut down complete");
  }
}
