import { BaseStrategy } from "../BaseStrategy";
import { IRiskGateStrategy } from "../IStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  IRiskAssessment,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { OnChainAnalyzer } from "../../services/OnChainAnalyzer";
import { logger } from "../../utils/logger";

export class SmartContractRiskScorer
  extends BaseStrategy
  implements IRiskGateStrategy
{
  readonly id = "smart-contract-risk";
  readonly name = "Smart Contract Risk Scorer";
  readonly category = StrategyCategory.RISK;
  readonly tier = StrategyTier.NORMAL;

  private analyzer: OnChainAnalyzer | null = null;

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);
    const cacheTtl = config.params.cacheTtlMs || 300000;
    this.analyzer = new OnChainAnalyzer(cacheTtl);
    logger.info(
      `Smart Contract Risk Scorer initialized | min score: ${config.params.minSafetyScore || 85} | cache TTL: ${cacheTtl}ms`
    );
  }

  /**
   * Assess risk for a token.
   * Called by RiskGate before every trade.
   */
  async assessRisk(tokenAddress: string): Promise<IRiskAssessment> {
    if (!this.analyzer) {
      return this.defaultAssessment(tokenAddress);
    }

    const analysis = await this.analyzer.analyzeToken(tokenAddress);

    let score = 100;
    const flags: string[] = [...analysis.flags];

    // Scoring penalties
    if (analysis.hasMintAuthority) score -= 20;
    if (analysis.hasFreezeAuthority) score -= 25;

    if (analysis.topHolderConcentration > 0.5) {
      score -= 30;
      flags.push("TOP_HOLDER_>50%");
    } else if (analysis.topHolderConcentration > 0.3) {
      score -= 15;
      flags.push("TOP_HOLDER_>30%");
    }

    if (analysis.top10HolderConcentration > 0.8) {
      score -= 10;
      flags.push("TOP10_HOLD_>80%");
    }

    if (!analysis.isLpLocked && !analysis.isLpBurned) {
      score -= 15;
      flags.push("LP_NOT_LOCKED");
    }

    if (!analysis.canSell) {
      score -= 50;
      flags.push("HONEYPOT");
    }

    score = Math.max(0, score);

    const isRugPull =
      analysis.topHolderConcentration > 0.8 &&
      analysis.hasMintAuthority;

    return {
      tokenAddress,
      overallScore: score,
      isHoneypot: !analysis.canSell,
      isRugPull,
      hasLiquidityLock: analysis.isLpLocked || analysis.isLpBurned,
      ownerConcentration: analysis.topHolderConcentration,
      mintAuthority: analysis.hasMintAuthority,
      freezeAuthority: analysis.hasFreezeAuthority,
      flags,
      timestamp: new Date(),
    };
  }

  private defaultAssessment(tokenAddress: string): IRiskAssessment {
    return {
      tokenAddress,
      overallScore: 50,
      isHoneypot: false,
      isRugPull: false,
      hasLiquidityLock: false,
      ownerConcentration: 0,
      mintAuthority: false,
      freezeAuthority: false,
      flags: ["ANALYZER_UNAVAILABLE"],
      timestamp: new Date(),
    };
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    // Risk strategy doesn't produce signals - it gates trades
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
