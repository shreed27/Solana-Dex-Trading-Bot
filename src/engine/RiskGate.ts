import { IRiskAssessment } from "../types/strategy.types";
import { OnChainAnalyzer } from "../services/OnChainAnalyzer";
import { logger } from "../utils/logger";

export class RiskGate {
  private analyzer: OnChainAnalyzer;
  private minSafetyScore: number;

  constructor(minSafetyScore: number = 85) {
    this.analyzer = new OnChainAnalyzer();
    this.minSafetyScore = minSafetyScore;
  }

  async initialize(): Promise<void> {
    logger.info(`RiskGate initialized with min safety score: ${this.minSafetyScore}`);
  }

  /**
   * Assess risk for a token. Returns IRiskAssessment.
   * All trades must pass through this gate.
   */
  async assess(tokenAddress: string): Promise<IRiskAssessment> {
    const analysis = await this.analyzer.analyzeToken(tokenAddress);

    // Calculate overall score (100 = safe, 0 = dangerous)
    let score = 100;
    const flags: string[] = [...analysis.flags];

    if (analysis.hasMintAuthority) score -= 20;
    if (analysis.hasFreezeAuthority) score -= 25;

    if (analysis.topHolderConcentration > 0.5) {
      score -= 30;
    } else if (analysis.topHolderConcentration > 0.3) {
      score -= 15;
    }

    if (!analysis.isLpLocked && !analysis.isLpBurned) {
      score -= 15;
    }

    if (!analysis.canSell) {
      score -= 50; // Honeypot = massive penalty
      flags.push("CANNOT_SELL");
    }

    score = Math.max(0, score);

    return {
      tokenAddress,
      overallScore: score,
      isHoneypot: !analysis.canSell,
      isRugPull: analysis.topHolderConcentration > 0.8 && analysis.hasMintAuthority,
      hasLiquidityLock: analysis.isLpLocked || analysis.isLpBurned,
      ownerConcentration: analysis.topHolderConcentration,
      mintAuthority: analysis.hasMintAuthority,
      freezeAuthority: analysis.hasFreezeAuthority,
      flags,
      timestamp: new Date(),
    };
  }

  /**
   * Quick risk assessment (less thorough, faster).
   * Used by pool sniper where speed matters.
   */
  async quickAssess(tokenAddress: string): Promise<number> {
    try {
      const assessment = await this.assess(tokenAddress);
      return assessment.overallScore;
    } catch {
      return 50; // Unknown risk = medium score
    }
  }

  /**
   * Check if a token passes the risk gate.
   */
  async passes(tokenAddress: string): Promise<boolean> {
    const assessment = await this.assess(tokenAddress);
    if (assessment.overallScore < this.minSafetyScore) {
      logger.warning(
        `Risk gate BLOCKED ${tokenAddress}: score ${assessment.overallScore} < ${this.minSafetyScore} | flags: ${assessment.flags.join(", ")}`
      );
      return false;
    }
    return true;
  }

  setMinSafetyScore(score: number): void {
    this.minSafetyScore = score;
  }
}
