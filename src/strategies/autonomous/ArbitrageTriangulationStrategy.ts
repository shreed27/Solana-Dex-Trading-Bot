import { BaseStrategy } from "../BaseStrategy";
import { IAutonomousStrategy } from "../IStrategy";
import {
  IStrategyResult,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { SwapService } from "../../services/SwapService";
import { WalletService } from "../../services/WalletService";
import { USDC_MINT_ADDRESS, SOL_MINT_ADDRESS } from "../../utils/constants";
import { logger } from "../../utils/logger";

// Common token mints for triangular arb paths
const ARB_TOKENS = [
  USDC_MINT_ADDRESS, // USDC
  SOL_MINT_ADDRESS, // SOL
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", // HNT
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
];

export class ArbitrageTriangulationStrategy
  extends BaseStrategy
  implements IAutonomousStrategy
{
  readonly id = "arbitrage-triangulation";
  readonly name = "Multi-hop Triangular Arbitrage";
  readonly category = StrategyCategory.AUTONOMOUS;
  readonly tier = StrategyTier.FAST;

  private running = false;
  private trianglePaths: [string, string, string][] = [];

  async initialize(config: any): Promise<void> {
    await super.initialize(config);
    this.buildTrianglePaths();
  }

  private buildTrianglePaths(): void {
    // Generate all possible triangular paths
    for (let i = 0; i < ARB_TOKENS.length; i++) {
      for (let j = 0; j < ARB_TOKENS.length; j++) {
        if (i === j) continue;
        for (let k = 0; k < ARB_TOKENS.length; k++) {
          if (k === i || k === j) continue;
          // Only use USDC as start/end for simplicity
          if (ARB_TOKENS[i] === USDC_MINT_ADDRESS) {
            this.trianglePaths.push([
              ARB_TOKENS[i],
              ARB_TOKENS[j],
              ARB_TOKENS[k],
            ]);
          }
        }
      }
    }
    logger.info(
      `Arb triangulation: ${this.trianglePaths.length} paths configured`
    );
  }

  async start(): Promise<void> {
    this.running = true;
    this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    const intervalMs = this.config.params.scanIntervalMs || 2000;
    const minProfitBps = this.config.params.minProfitBps || 20;

    while (this.running) {
      try {
        for (const [a, b, c] of this.trianglePaths) {
          if (!this.running) break;

          // Check USDC -> B -> C -> USDC profitability
          const profit = await this.checkTriangleProfit(
            a,
            b,
            c,
            1000_000_000 // 1000 USDC
          );

          if (profit !== null && profit > minProfitBps) {
            logger.success(
              `ARB OPPORTUNITY: ${profit.toFixed(1)} bps | ${a.slice(0, 6)}->${b.slice(0, 6)}->${c.slice(0, 6)}`
            );
            // In production, would execute the 3-leg swap atomically via Jito bundle
          }
        }

        await new Promise((r) => setTimeout(r, intervalMs));
      } catch (err) {
        logger.error("Arb scan error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async checkTriangleProfit(
    a: string,
    b: string,
    c: string,
    amountIn: number
  ): Promise<number | null> {
    try {
      const walletService = new WalletService();
      const taker = walletService.getPublicKey().toString();

      // Leg 1: A -> B
      const quote1 = await SwapService.getUltraSwap({
        inputMint: a,
        outputMint: b,
        amount: amountIn.toString(),
        taker,
        swapMode: "ExactIn",
      });
      if (!quote1 || quote1.errorMessage) return null;

      // Leg 2: B -> C
      const quote2 = await SwapService.getUltraSwap({
        inputMint: b,
        outputMint: c,
        amount: quote1.outAmount,
        taker,
        swapMode: "ExactIn",
      });
      if (!quote2 || quote2.errorMessage) return null;

      // Leg 3: C -> A
      const quote3 = await SwapService.getUltraSwap({
        inputMint: c,
        outputMint: a,
        amount: quote2.outAmount,
        taker,
        swapMode: "ExactIn",
      });
      if (!quote3 || quote3.errorMessage) return null;

      const finalAmount = parseInt(quote3.outAmount);
      const profitBps =
        ((finalAmount - amountIn) / amountIn) * 10000;

      return profitBps;
    } catch {
      return null;
    }
  }

  async getActivePositions(): Promise<any[]> {
    return []; // Arb positions are atomic/instant
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    // Autonomous strategy - execute is a no-op for cron
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
