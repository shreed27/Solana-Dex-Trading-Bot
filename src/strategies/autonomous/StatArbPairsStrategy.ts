import { BaseStrategy } from "../BaseStrategy";
import { IAutonomousStrategy } from "../IStrategy";
import {
  IStrategyResult,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { MarketDataService } from "../../services/MarketDataService";
import {
  PairRelationModel,
  IPairRelationDoc,
} from "../../models/PairRelation";
import {
  correlation,
  adfTestStatistic,
  halfLife,
  zScore,
  mean,
  stddev,
  linearRegression,
} from "../../utils/mathUtils";
import { logger } from "../../utils/logger";

export class StatArbPairsStrategy
  extends BaseStrategy
  implements IAutonomousStrategy
{
  readonly id = "stat-arb-pairs";
  readonly name = "Statistical Arbitrage Pairs Trading";
  readonly category = StrategyCategory.AUTONOMOUS;
  readonly tier = StrategyTier.SLOW;

  private running = false;
  private marketData = new MarketDataService();
  private activePairs: IPairRelationDoc[] = [];

  async start(): Promise<void> {
    this.running = true;

    // Load active pairs
    this.activePairs = await PairRelationModel.find({
      active: true,
    }).exec();

    logger.info(
      `Stat arb: monitoring ${this.activePairs.length} pairs`
    );
    this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    const intervalMs = this.config.params.checkIntervalMs || 300000; // 5 min

    while (this.running) {
      try {
        // 1. Update cointegration tests for existing pairs
        await this.updatePairStatistics();

        // 2. Check for trading signals
        await this.checkPairSignals();

        await new Promise((r) => setTimeout(r, intervalMs));
      } catch (err) {
        logger.error("Stat arb loop error:", err);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }

  private async updatePairStatistics(): Promise<void> {
    for (const pair of this.activePairs) {
      try {
        const candlesA = await this.marketData.getCandles(
          pair.tokenA,
          "5m",
          100
        );
        const candlesB = await this.marketData.getCandles(
          pair.tokenB,
          "5m",
          100
        );

        const minLen = Math.min(candlesA.length, candlesB.length);
        if (minLen < 30) continue;

        const pricesA = candlesA.slice(-minLen).map((c) => c.close);
        const pricesB = candlesB.slice(-minLen).map((c) => c.close);

        // Calculate hedge ratio via linear regression
        const x = Array.from({ length: minLen }, (_, i) => i);
        const reg = linearRegression(pricesB, pricesA);
        const hedgeRatio = reg.slope;

        // Calculate spread
        const spread = pricesA.map(
          (a, i) => a - hedgeRatio * pricesB[i]
        );

        // Test stationarity of spread (simplified ADF)
        const adf = adfTestStatistic(spread);
        // ADF < -2.86 (5% critical value for ~100 obs) suggests stationarity
        const isCointegrated = adf < -2.86;

        const hl = halfLife(spread);
        const spreadMean = mean(spread);
        const spreadStd = stddev(spread);
        const currentSpread = spread[spread.length - 1];
        const currentZ = zScore(currentSpread, spreadMean, spreadStd);

        // Update in DB
        await PairRelationModel.updateOne(
          { _id: pair._id },
          {
            cointegrationPValue: isCointegrated ? 0.01 : 0.5,
            halfLife: hl,
            currentSpread,
            meanSpread: spreadMean,
            stdSpread: spreadStd,
            zScore: currentZ,
            hedgeRatio,
            active: isCointegrated, // Deactivate if cointegration breaks
            lastUpdated: new Date(),
          }
        );

        if (!isCointegrated) {
          logger.warning(
            `Pair ${pair.tokenA.slice(0, 6)}/${pair.tokenB.slice(0, 6)}: cointegration broken, deactivating`
          );
        }
      } catch (err) {
        // Continue to next pair
      }
    }

    // Refresh active pairs
    this.activePairs = await PairRelationModel.find({
      active: true,
    }).exec();
  }

  private async checkPairSignals(): Promise<void> {
    const entryZ = this.config.params.zScoreEntry || 2.0;
    const exitZ = this.config.params.zScoreExit || 0.5;

    for (const pair of this.activePairs) {
      const z = pair.zScore;

      if (Math.abs(z) > entryZ) {
        // Spread is extended - enter mean reversion trade
        const direction = z > 0 ? "short_A_long_B" : "long_A_short_B";
        logger.info(
          `Stat arb signal: ${pair.tokenA.slice(0, 6)}/${pair.tokenB.slice(0, 6)} | z-score: ${z.toFixed(2)} | ${direction}`
        );
        // Would execute paired trades through ExecutionEngine
      } else if (Math.abs(z) < exitZ) {
        // Spread reverted to mean - exit
        logger.info(
          `Stat arb exit: ${pair.tokenA.slice(0, 6)}/${pair.tokenB.slice(0, 6)} | z-score: ${z.toFixed(2)} | mean reverted`
        );
      }
    }
  }

  async getActivePositions(): Promise<any[]> {
    return this.activePairs;
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
