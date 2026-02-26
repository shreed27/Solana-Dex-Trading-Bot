import {
  IStrategyConfig,
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../types/strategy.types";
import { IStrategy } from "./IStrategy";
import { CircuitBreaker } from "../utils/circuitBreaker";
import { logger } from "../utils/logger";

export abstract class BaseStrategy implements IStrategy {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly category: StrategyCategory;
  abstract readonly tier: StrategyTier;

  protected config!: IStrategyConfig;
  protected circuitBreaker!: CircuitBreaker;
  protected initialized = false;

  async initialize(config: IStrategyConfig): Promise<void> {
    this.config = config;
    this.circuitBreaker = new CircuitBreaker(
      config.id,
      config.circuitBreakerThreshold
    );
    this.initialized = true;
    logger.info(`Strategy ${this.id} initialized with weight ${config.weight}`);
  }

  abstract execute(tokens: string[]): Promise<IStrategyResult>;

  async shutdown(): Promise<void> {
    this.initialized = false;
    logger.info(`Strategy ${this.id} shut down`);
  }

  isHealthy(): boolean {
    return this.initialized && this.circuitBreaker.isAllowed();
  }

  getConfig(): IStrategyConfig {
    return this.config;
  }

  protected createSignal(
    tokenAddress: string,
    direction: SignalDirection,
    confidence: number,
    metadata: Record<string, any>,
    ttlMs: number
  ): ISignal {
    return {
      strategyId: this.id,
      tokenAddress,
      direction,
      confidence: Math.min(1.0, Math.max(0, confidence)),
      weight: this.config.weight,
      metadata,
      timestamp: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
    };
  }

  protected wrapExecution(
    fn: () => Promise<IStrategyResult>
  ): Promise<IStrategyResult> {
    if (!this.circuitBreaker.isAllowed()) {
      return Promise.resolve({
        strategyId: this.id,
        signals: [],
        executionTimeMs: 0,
        error: "Circuit breaker open",
      });
    }

    const start = Date.now();
    return fn()
      .then((result) => {
        this.circuitBreaker.recordSuccess();
        result.executionTimeMs = Date.now() - start;
        return result;
      })
      .catch((err) => {
        this.circuitBreaker.recordFailure();
        logger.error(`Strategy ${this.id} execution error:`, err);
        return {
          strategyId: this.id,
          signals: [],
          executionTimeMs: Date.now() - start,
          error: err.message,
        };
      });
  }
}
