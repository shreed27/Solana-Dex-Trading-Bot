import { IStrategy, IAutonomousStrategy } from "./IStrategy";
import { StrategyCategory } from "../types/strategy.types";

// Signal strategies
import { MACDMomentumStrategy } from "./signal/MACDMomentumStrategy";
import { VolumeBreakoutStrategy } from "./signal/VolumeBreakoutStrategy";
import { SentimentAnalysisStrategy } from "./signal/SentimentAnalysisStrategy";
import { MeanReversionBBStrategy } from "./signal/MeanReversionBBStrategy";
import { OrderbookImbalanceStrategy } from "./signal/OrderbookImbalanceStrategy";
import { MLTensorPredictorStrategy } from "./signal/MLTensorPredictorStrategy";
import { WhaleCopyTradingStrategy } from "./signal/WhaleCopyTradingStrategy";

// Autonomous strategies
import { ArbitrageTriangulationStrategy } from "./autonomous/ArbitrageTriangulationStrategy";
import { FlashLoanSniperStrategy } from "./autonomous/FlashLoanSniperStrategy";
import { LiquidityPoolSniperStrategy } from "./autonomous/LiquidityPoolSniperStrategy";
import { GridTradingStrategy } from "./autonomous/GridTradingStrategy";
import { StatArbPairsStrategy } from "./autonomous/StatArbPairsStrategy";
import { TokenomicsUnvestingStrategy } from "./autonomous/TokenomicsUnvestingStrategy";

// Risk/Execution strategies
import { SmartContractRiskScorer } from "./risk/SmartContractRiskScorer";
import { MEVSubmarineRouter } from "./risk/MEVSubmarineRouter";

type StrategyConstructor = new () => IStrategy;

const registry: Map<string, StrategyConstructor> = new Map();

function registerAll() {
  // Signal strategies
  registry.set("macd-momentum", MACDMomentumStrategy);
  registry.set("volume-breakout", VolumeBreakoutStrategy);
  registry.set("sentiment-analysis", SentimentAnalysisStrategy);
  registry.set("mean-reversion-bb", MeanReversionBBStrategy);
  registry.set("orderbook-imbalance", OrderbookImbalanceStrategy);
  registry.set("ml-tensor-predictor", MLTensorPredictorStrategy);
  registry.set("whale-copy-trading", WhaleCopyTradingStrategy);

  // Autonomous strategies
  registry.set("arbitrage-triangulation", ArbitrageTriangulationStrategy);
  registry.set("flash-loan-sniper", FlashLoanSniperStrategy);
  registry.set("liquidity-pool-sniper", LiquidityPoolSniperStrategy);
  registry.set("grid-trading-volatility", GridTradingStrategy);
  registry.set("stat-arb-pairs", StatArbPairsStrategy);
  registry.set("tokenomics-unvesting", TokenomicsUnvestingStrategy);

  // Risk/Execution
  registry.set("smart-contract-risk", SmartContractRiskScorer);
  registry.set("mev-submarine-routing", MEVSubmarineRouter);
}

registerAll();

export class StrategyRegistry {
  static create(strategyId: string): IStrategy {
    const Constructor = registry.get(strategyId);
    if (!Constructor) {
      throw new Error(`Unknown strategy: ${strategyId}`);
    }
    return new Constructor();
  }

  static getAll(): string[] {
    return Array.from(registry.keys());
  }

  static has(strategyId: string): boolean {
    return registry.has(strategyId);
  }

  static getByCategory(category: StrategyCategory): string[] {
    return Array.from(registry.entries())
      .filter(([_, Ctor]) => {
        const instance = new Ctor();
        return instance.category === category;
      })
      .map(([id]) => id);
  }
}
