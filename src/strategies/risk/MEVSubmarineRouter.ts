import { VersionedTransaction } from "@solana/web3.js";
import { BaseStrategy } from "../BaseStrategy";
import { IExecutionWrapper } from "../IStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { JitoClient } from "../../external/JitoClient";
import { WalletService } from "../../services/WalletService";
import { logger } from "../../utils/logger";

export class MEVSubmarineRouter
  extends BaseStrategy
  implements IExecutionWrapper
{
  readonly id = "mev-submarine-routing";
  readonly name = "MEV Submarine Routing via Jito";
  readonly category = StrategyCategory.EXECUTION;
  readonly tier = StrategyTier.FAST;

  private jitoClient: JitoClient | null = null;
  private walletService: WalletService;

  constructor() {
    super();
    this.walletService = new WalletService();
  }

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);

    const blockEngineUrl = process.env.JITO_BLOCK_ENGINE_URL;
    const rpcUrl = process.env.SOLANA_RPC_URL || "";

    if (blockEngineUrl) {
      this.jitoClient = new JitoClient(blockEngineUrl, rpcUrl);
      logger.success("MEV Submarine Router initialized with Jito");
    } else {
      logger.warning(
        "JITO_BLOCK_ENGINE_URL not set - MEV protection disabled, using direct RPC"
      );
    }
  }

  /**
   * Wrap a transaction with MEV protection via Jito bundle.
   */
  async wrapTransaction(
    txBase64: string,
    priorityLevel: "low" | "medium" | "high"
  ): Promise<string> {
    if (!this.jitoClient) {
      // Fallback: direct execution without MEV protection
      return await this.walletService.executeSwap(txBase64);
    }

    const tipLamports = this.getTipAmount(priorityLevel);

    try {
      // Deserialize and sign transaction
      const txBuf = Buffer.from(txBase64, "base64");
      const tx = VersionedTransaction.deserialize(txBuf);
      tx.sign([this.walletService.getWallet()]);

      // Submit as Jito bundle (private mempool)
      const result = await this.jitoClient.sendAndConfirm(
        [tx],
        tipLamports,
        30000 // 30s timeout
      );

      if (result.status === "accepted" && result.signature) {
        logger.info(
          `MEV protected tx landed: ${result.signature.slice(0, 16)}... | tip: ${tipLamports} lamports`
        );
        return result.signature;
      }

      // Fallback to direct if Jito fails
      logger.warning(
        "Jito bundle failed, falling back to direct execution"
      );
      return await this.walletService.executeSwap(txBase64);
    } catch (err) {
      logger.error("MEV router error:", err);
      // Fallback
      return await this.walletService.executeSwap(txBase64);
    }
  }

  private getTipAmount(
    priority: "low" | "medium" | "high"
  ): number {
    const defaultTip =
      this.config?.params?.defaultTipLamports || 10000;
    const maxTip =
      this.config?.params?.maxTipLamports || 100000;

    switch (priority) {
      case "high":
        return maxTip;
      case "medium":
        return Math.round((defaultTip + maxTip) / 2);
      case "low":
        return defaultTip;
    }
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    // Execution wrapper doesn't produce signals
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
