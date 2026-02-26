import {
  IPolymarketRiskCheck,
  PolymarketAsset,
  PolymarketInterval,
} from "../types/polymarket.types";
import { PolymarketClient } from "./PolymarketClient";
import { MarketDiscoveryService } from "./MarketDiscoveryService";
import { PolymarketPositionModel } from "../models/PolymarketPosition";
import { logger } from "../utils/logger";

interface RiskLimits {
  maxPositionUSDC: number;
  maxTotalExposure: number;
  maxPositionsPerAsset: number;
  maxConcurrentPositions: number;
  minLiquidity: number;
  maxSpread: number;
  minTimeToResolution: number; // seconds
  maxTimeToResolution: number; // seconds
  minConfidenceScore: number;
  maxDailyLoss: number;
  cooldownAfterLossMs: number;
}

const DEFAULT_LIMITS: RiskLimits = {
  maxPositionUSDC: 50,
  maxTotalExposure: 200,
  maxPositionsPerAsset: 2,
  maxConcurrentPositions: 6,
  minLiquidity: 500,
  maxSpread: 0.08,
  minTimeToResolution: 30, // at least 30s left
  maxTimeToResolution: 900, // 15 minutes max
  minConfidenceScore: 0.60,
  maxDailyLoss: 100,
  cooldownAfterLossMs: 60_000,
};

/**
 * Risk gating for Polymarket trades.
 * Checks liquidity, spread, exposure, timing, and daily P&L limits.
 */
export class PolymarketRiskManager {
  private client: PolymarketClient;
  private discovery: MarketDiscoveryService;
  private limits: RiskLimits;
  private dailyPnl: number = 0;
  private lastLossTime: number = 0;
  private dailyResetTime: number = 0;

  constructor(
    client: PolymarketClient,
    discovery: MarketDiscoveryService,
    limits?: Partial<RiskLimits>
  ) {
    this.client = client;
    this.discovery = discovery;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.dailyResetTime = this.getNextMidnight();
  }

  /**
   * Evaluate whether a trade should be allowed.
   */
  async checkRisk(
    asset: PolymarketAsset,
    interval: PolymarketInterval,
    compositeScore: number,
    requestedSize: number
  ): Promise<IPolymarketRiskCheck> {
    this.resetDailyIfNeeded();

    const market = this.discovery.getCurrentMarket(asset, interval);
    if (!market) {
      return this.deny("No active market found", 0, 0, 0, 0);
    }

    // 1. Confidence threshold
    if (compositeScore < this.limits.minConfidenceScore) {
      return this.deny(
        `Score ${compositeScore.toFixed(2)} below threshold ${this.limits.minConfidenceScore}`,
        0, 0, 0, 0
      );
    }

    // 2. Time to resolution check
    const timeToResolution = (market.endTime.getTime() - Date.now()) / 1000;
    if (timeToResolution < this.limits.minTimeToResolution) {
      return this.deny(
        `Only ${timeToResolution.toFixed(0)}s to resolution (min ${this.limits.minTimeToResolution}s)`,
        0, 0, timeToResolution, 0
      );
    }
    if (timeToResolution > this.limits.maxTimeToResolution) {
      return this.deny(
        `${timeToResolution.toFixed(0)}s to resolution exceeds max ${this.limits.maxTimeToResolution}s`,
        0, 0, timeToResolution, 0
      );
    }

    // 3. Liquidity check
    const liquidity = market.liquidity;
    if (liquidity < this.limits.minLiquidity) {
      return this.deny(
        `Liquidity $${liquidity.toFixed(0)} below minimum $${this.limits.minLiquidity}`,
        liquidity, 0, timeToResolution, 0
      );
    }

    // 4. Spread check via orderbook
    let spread = 0;
    if (market.yesTokenId) {
      const spreadVal = await this.client.getSpread(market.yesTokenId);
      spread = spreadVal ?? 0;
    }
    if (spread > this.limits.maxSpread) {
      return this.deny(
        `Spread ${(spread * 100).toFixed(1)}% exceeds max ${(this.limits.maxSpread * 100).toFixed(1)}%`,
        liquidity, spread, timeToResolution, 0
      );
    }

    // 5. Current exposure check
    const openPositions = await PolymarketPositionModel.find({
      status: "open",
    });
    const currentExposure = openPositions.reduce(
      (sum, p) => sum + p.size,
      0
    );

    if (currentExposure + requestedSize > this.limits.maxTotalExposure) {
      return this.deny(
        `Total exposure $${(currentExposure + requestedSize).toFixed(0)} exceeds max $${this.limits.maxTotalExposure}`,
        liquidity, spread, timeToResolution, currentExposure
      );
    }

    // 6. Max concurrent positions
    if (openPositions.length >= this.limits.maxConcurrentPositions) {
      return this.deny(
        `${openPositions.length} open positions (max ${this.limits.maxConcurrentPositions})`,
        liquidity, spread, timeToResolution, currentExposure
      );
    }

    // 7. Per-asset position limit
    const assetPositions = openPositions.filter((p) => p.asset === asset);
    if (assetPositions.length >= this.limits.maxPositionsPerAsset) {
      return this.deny(
        `${assetPositions.length} ${asset} positions (max ${this.limits.maxPositionsPerAsset})`,
        liquidity, spread, timeToResolution, currentExposure
      );
    }

    // 8. Daily loss limit
    if (this.dailyPnl < -this.limits.maxDailyLoss) {
      return this.deny(
        `Daily loss $${Math.abs(this.dailyPnl).toFixed(0)} exceeds max $${this.limits.maxDailyLoss}`,
        liquidity, spread, timeToResolution, currentExposure
      );
    }

    // 9. Cooldown after loss
    if (
      this.lastLossTime > 0 &&
      Date.now() - this.lastLossTime < this.limits.cooldownAfterLossMs
    ) {
      const remaining = (
        (this.limits.cooldownAfterLossMs - (Date.now() - this.lastLossTime)) /
        1000
      ).toFixed(0);
      return this.deny(
        `Loss cooldown: ${remaining}s remaining`,
        liquidity, spread, timeToResolution, currentExposure
      );
    }

    // Calculate suggested size (Kelly-inspired)
    const suggestedSize = this.calculatePositionSize(
      compositeScore,
      requestedSize,
      currentExposure
    );

    return {
      allowed: true,
      liquidity,
      spread,
      timeToResolution,
      currentExposure,
      maxExposure: this.limits.maxTotalExposure,
      suggestedSize,
    };
  }

  /**
   * Kelly-inspired position sizing: higher confidence → bigger position.
   */
  private calculatePositionSize(
    confidence: number,
    requestedSize: number,
    currentExposure: number
  ): number {
    // Scale size by confidence: base at 0.6 confidence, max at 1.0
    const scaleFactor = Math.max(0, (confidence - 0.5) / 0.5);
    const maxAllowable = Math.min(
      this.limits.maxPositionUSDC,
      this.limits.maxTotalExposure - currentExposure
    );
    const sized = Math.min(requestedSize * scaleFactor, maxAllowable);
    return Math.max(1, Math.round(sized * 100) / 100);
  }

  /**
   * Record trade result for daily P&L tracking.
   */
  recordPnl(pnl: number): void {
    this.dailyPnl += pnl;
    if (pnl < 0) {
      this.lastLossTime = Date.now();
    }
    logger.info(
      `Risk Manager: daily P&L = $${this.dailyPnl.toFixed(2)}`
    );
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }

  private deny(
    reason: string,
    liquidity: number,
    spread: number,
    timeToResolution: number,
    currentExposure: number
  ): IPolymarketRiskCheck {
    logger.warning(`Risk denied: ${reason}`);
    return {
      allowed: false,
      reason,
      liquidity,
      spread,
      timeToResolution,
      currentExposure,
      maxExposure: this.limits.maxTotalExposure,
      suggestedSize: 0,
    };
  }

  private resetDailyIfNeeded(): void {
    if (Date.now() >= this.dailyResetTime) {
      logger.info(
        `Daily risk reset: previous P&L = $${this.dailyPnl.toFixed(2)}`
      );
      this.dailyPnl = 0;
      this.dailyResetTime = this.getNextMidnight();
    }
  }

  private getNextMidnight(): number {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
}
