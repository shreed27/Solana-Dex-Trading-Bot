import { BaseStrategy } from "../BaseStrategy";
import { IAutonomousStrategy } from "../IStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { WebSocketService } from "../../services/WebSocketService";
import { RiskGate } from "../../engine/RiskGate";
import { IPoolCreationEvent } from "../../types/market.types";
import { logger } from "../../utils/logger";

export class LiquidityPoolSniperStrategy
  extends BaseStrategy
  implements IAutonomousStrategy
{
  readonly id = "liquidity-pool-sniper";
  readonly name = "Liquidity Pool Block-0 Sniper";
  readonly category = StrategyCategory.AUTONOMOUS;
  readonly tier = StrategyTier.FAST;

  private wsService: WebSocketService | null = null;
  private riskGate: RiskGate;
  private running = false;
  private snipedPools: Set<string> = new Set();

  constructor() {
    super();
    this.riskGate = new RiskGate(70); // Lower threshold for sniping (speed > caution)
  }

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);
    this.wsService = new WebSocketService();
  }

  async start(): Promise<void> {
    this.running = true;
    if (!this.wsService) return;

    logger.info("Pool sniper: subscribing to new pool events...");

    this.wsService.subscribeNewPools(async (event: IPoolCreationEvent) => {
      if (!this.running) return;
      if (!event.baseMint || this.snipedPools.has(event.baseMint)) return;

      const startTime = Date.now();
      logger.info(
        `New pool detected: ${event.baseMint} | sig: ${event.signature.slice(0, 16)}...`
      );

      try {
        // Quick risk check
        const riskScore = await this.riskGate.quickAssess(
          event.baseMint
        );
        if (riskScore < (this.config.params.minRiskScore || 70)) {
          logger.warning(
            `Pool sniper: ${event.baseMint} failed risk check (${riskScore})`
          );
          return;
        }

        const snipeAmount =
          this.config.params.snipeAmountUsdc || 15;

        // Mark as sniped to prevent duplicates
        this.snipedPools.add(event.baseMint);

        const latencyMs = Date.now() - startTime;
        logger.success(
          `Pool sniper: targeting ${event.baseMint} | risk: ${riskScore} | latency: ${latencyMs}ms | size: $${snipeAmount}`
        );

        // In production: execute buy through ExecutionEngine with Jito bundle
        // await this.executionEngine.executeSnipe(event, snipeAmount);
      } catch (err) {
        logger.error("Pool snipe error:", err);
      }
    });
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async getActivePositions(): Promise<any[]> {
    return [];
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
