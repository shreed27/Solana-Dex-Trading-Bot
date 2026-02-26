import {
  IStrategyConfig,
  IStrategyResult,
  IRiskAssessment,
  StrategyCategory,
  StrategyTier,
} from "../types/strategy.types";

export interface IStrategy {
  readonly id: string;
  readonly name: string;
  readonly category: StrategyCategory;
  readonly tier: StrategyTier;

  initialize(config: IStrategyConfig): Promise<void>;
  execute(tokens: string[]): Promise<IStrategyResult>;
  shutdown(): Promise<void>;
  isHealthy(): boolean;
  getConfig(): IStrategyConfig;
}

export interface IAutonomousStrategy extends IStrategy {
  start(): Promise<void>;
  stop(): Promise<void>;
  getActivePositions(): Promise<any[]>;
}

export interface IRiskGateStrategy extends IStrategy {
  assessRisk(tokenAddress: string): Promise<IRiskAssessment>;
}

export interface IExecutionWrapper extends IStrategy {
  wrapTransaction(
    txBase64: string,
    priorityLevel: "low" | "medium" | "high"
  ): Promise<string>;
}
