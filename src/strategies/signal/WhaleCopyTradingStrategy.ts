import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { HeliusClient } from "../../external/HeliusClient";
import { WhaleWallet, IWhaleWallet } from "../../models/WhaleWallet";
import { USDC_MINT_ADDRESS } from "../../utils/constants";
import { logger } from "../../utils/logger";

export class WhaleCopyTradingStrategy extends BaseStrategy {
  readonly id = "whale-copy-trading";
  readonly name = "Whale Wallet Copy Trading";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.NORMAL;

  private heliusClient: HeliusClient | null = null;
  private trackedWallets: IWhaleWallet[] = [];

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);

    const apiKey = process.env.HELIUS_API_KEY;
    if (apiKey) {
      this.heliusClient = new HeliusClient(apiKey);
    } else {
      logger.warning(
        "Whale Copy Trading: HELIUS_API_KEY not configured"
      );
    }

    // Load tracked whale wallets
    this.trackedWallets = await WhaleWallet.find({ active: true })
      .sort({ profitFactor: -1 })
      .limit(config.params.maxWhales || 50)
      .exec();

    logger.info(
      `Whale Copy Trading: Tracking ${this.trackedWallets.length} wallets`
    );
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];

      if (!this.heliusClient || this.trackedWallets.length === 0) {
        return { strategyId: this.id, signals, executionTimeMs: 0 };
      }

      const lookbackMinutes =
        this.config.params.lookbackMinutes || 5;
      const lookbackMs = lookbackMinutes * 60 * 1000;
      const now = Date.now();

      for (const whale of this.trackedWallets) {
        try {
          const txs =
            await this.heliusClient.getEnhancedTransactions(
              whale.address,
              { limit: 20, type: "SWAP" }
            );

          // Filter to recent swaps
          const recentSwaps = txs.filter(
            (tx) => now - tx.timestamp * 1000 < lookbackMs
          );

          const whaleTxs = this.heliusClient.parseWhaleTransactions(
            whale.address,
            recentSwaps,
            USDC_MINT_ADDRESS
          );

          for (const wtx of whaleTxs) {
            if (!wtx.tokenMint) continue;

            // Confidence based on whale's historical performance
            const confidence = Math.min(
              1.0,
              whale.profitFactor / 3.0
            );

            signals.push(
              this.createSignal(
                wtx.tokenMint,
                wtx.direction === "buy"
                  ? SignalDirection.BUY
                  : SignalDirection.SELL,
                confidence,
                {
                  whaleAddress:
                    whale.address.slice(0, 8) + "...",
                  whaleProfitFactor: whale.profitFactor,
                  whaleWinRate: whale.winRate,
                  txSignature: wtx.signature,
                  amountUsd: wtx.amountUsd,
                },
                3 * 60 * 1000 // 3 min TTL
              )
            );
          }
        } catch (err) {
          // Continue to next whale on individual errors
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }
}
