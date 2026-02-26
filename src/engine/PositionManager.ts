import { PositionService } from "../services/PositionService";
import { SwapService } from "../services/SwapService";
import {
  IAggregatedSignal,
  IRiskAssessment,
  IExitStrategy,
  SignalDirection,
} from "../types/strategy.types";
import { USDC_MINT_ADDRESS } from "../utils/constants";
import { logger } from "../utils/logger";

export class PositionManager {
  private maxSignalPositions: number;
  private basePositionSize: number;

  constructor(
    maxSignalPositions: number = 5,
    basePositionSize: number = 25
  ) {
    this.maxSignalPositions = maxSignalPositions;
    this.basePositionSize = basePositionSize;
  }

  /**
   * Dynamic position sizing based on signal strength.
   */
  calculatePositionSize(signal: IAggregatedSignal): number {
    // Scale from base to 2x base based on composite score
    return this.basePositionSize * (0.5 + signal.compositeScore);
  }

  /**
   * Dynamic exit strategy based on entry quality and risk.
   */
  calculateExitStrategy(
    signal: IAggregatedSignal,
    riskScore: number
  ): IExitStrategy {
    const baseTP = 30;
    const baseSL = 25;

    return {
      takeProfitPct: baseTP + (signal.compositeScore - 0.65) * 50,
      stopLossPct: baseSL * (riskScore / 100),
      trailingStopPct:
        signal.compositeScore > 0.85 ? 10 : undefined,
      timeoutMinutes: 120,
    };
  }

  /**
   * Check if we can open a new signal-based position.
   */
  async canOpenPosition(signal: IAggregatedSignal): Promise<boolean> {
    const openPositions = await PositionService.getOpenPositions();

    // Check max positions
    const signalPositions = openPositions.filter(
      (p) =>
        (p as any).positionType === "signal" ||
        !(p as any).positionType // Legacy positions count too
    );
    if (signalPositions.length >= this.maxSignalPositions) return false;

    // No duplicate tokens
    if (openPositions.find((p) => p.tokenAddress === signal.tokenAddress))
      return false;

    return true;
  }

  /**
   * Open a position with signal attribution.
   */
  async openSignalPosition(
    signal: IAggregatedSignal,
    riskAssessment: IRiskAssessment,
    tradeData: {
      tokenAddress: string;
      amount: number;
      avgBuyPrice: number;
      signature: string;
    }
  ): Promise<void> {
    const exitStrategy = this.calculateExitStrategy(
      signal,
      riskAssessment.overallScore
    );

    await PositionService.openPosition({
      tokenAddress: tradeData.tokenAddress,
      tokenInfo: {
        name: "",
        symbol: "",
        decimals: 6,
        logoURI: "",
        mcap: 0,
      },
      amount: tradeData.amount,
      avgBuyPrice: tradeData.avgBuyPrice,
      status: "open",
      openTimestamp: new Date(),
      signature: [tradeData.signature],
      // Extended fields stored in metadata
      // These would be stored if Position model is extended
    } as any);
  }

  /**
   * Close a position.
   */
  async closePosition(
    positionId: string,
    pnl: number,
    exitPrice: number,
    signature: string
  ): Promise<void> {
    await PositionService.closePosition(positionId, pnl, exitPrice, signature);
  }

  /**
   * Check all positions for exit conditions.
   * Called on a 2-minute cron.
   */
  async checkAllPositions(
    executeSell: (
      tokenAddress: string,
      amount: number,
      positionId: string,
      avgBuyPrice: number
    ) => Promise<string | null>
  ): Promise<void> {
    const positions = await PositionService.getOpenPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
      try {
        const priceData = await new SwapService().getTokenPrice([
          pos.tokenAddress,
        ]);
        const currentPrice = priceData?.prices?.[pos.tokenAddress];
        if (!currentPrice) continue;

        const pnl = PositionService.calculatePnL(
          pos.avgBuyPrice,
          currentPrice
        );

        // Dynamic exit thresholds
        // Default to 30% TP / -25% SL if no strategy data
        const takeProfitPct = 30;
        const stopLossPct = -25;

        if (pnl > takeProfitPct) {
          logger.info(
            `Take profit triggered for ${pos.tokenAddress}: ${pnl.toFixed(2)}%`
          );
          await executeSell(
            pos.tokenAddress,
            pos.amount,
            String(pos._id),
            pos.avgBuyPrice
          );
        } else if (pnl < stopLossPct) {
          logger.info(
            `Stop loss triggered for ${pos.tokenAddress}: ${pnl.toFixed(2)}%`
          );
          await executeSell(
            pos.tokenAddress,
            pos.amount,
            String(pos._id),
            pos.avgBuyPrice
          );
        }

        // Timeout check (2 hours default)
        const holdTimeMs =
          Date.now() - new Date(pos.openTimestamp).getTime();
        if (holdTimeMs > 120 * 60 * 1000) {
          logger.info(
            `Timeout exit for ${pos.tokenAddress}: held for ${Math.round(holdTimeMs / 60000)}min`
          );
          await executeSell(
            pos.tokenAddress,
            pos.amount,
            String(pos._id),
            pos.avgBuyPrice
          );
        }
      } catch (err) {
        logger.error(
          `Position check error for ${pos.tokenAddress}:`,
          err
        );
      }
    }
  }

  /**
   * Process exit signals from the aggregator.
   */
  async processExitSignal(
    signal: IAggregatedSignal,
    executeSell: (
      tokenAddress: string,
      amount: number,
      positionId: string,
      avgBuyPrice: number
    ) => Promise<string | null>
  ): Promise<void> {
    const positions = await PositionService.getOpenPositions();
    const pos = positions.find(
      (p) => p.tokenAddress === signal.tokenAddress
    );
    if (!pos) return;

    logger.info(
      `Sell signal for ${signal.tokenAddress}: score ${signal.compositeScore.toFixed(2)} | strategies: ${signal.contributingSignals.map((s) => s.strategyId).join(", ")}`
    );
    await executeSell(
      pos.tokenAddress,
      pos.amount,
      String(pos._id),
      pos.avgBuyPrice
    );
  }
}
