import { VersionedTransaction } from "@solana/web3.js";
import { SwapService } from "../services/SwapService";
import { WalletService } from "../services/WalletService";
import { JitoClient } from "../external/JitoClient";
import { IAggregatedSignal, IRiskAssessment } from "../types/strategy.types";
import { UltraSwapRequest, UltraSwapResponse } from "../types/types";
import { USDC_MINT_ADDRESS } from "../utils/constants";
import { logger } from "../utils/logger";
import { PositionManager } from "./PositionManager";

export class ExecutionEngine {
  private walletService: WalletService;
  private jitoClient: JitoClient | null = null;
  private positionManager: PositionManager;
  private mevProtectionEnabled: boolean = true;

  constructor(
    walletService: WalletService,
    positionManager: PositionManager,
    jitoBlockEngineUrl?: string
  ) {
    this.walletService = walletService;
    this.positionManager = positionManager;
    if (jitoBlockEngineUrl) {
      this.jitoClient = new JitoClient(
        jitoBlockEngineUrl,
        process.env.SOLANA_RPC_URL || ""
      );
    }
  }

  async initialize(): Promise<void> {
    logger.info("ExecutionEngine initialized");
    if (this.jitoClient) {
      logger.info("MEV protection via Jito enabled");
    } else {
      logger.warning("Jito not configured - MEV protection disabled");
      this.mevProtectionEnabled = false;
    }
  }

  /**
   * Execute a buy based on aggregated signal.
   */
  async executeBuy(
    signal: IAggregatedSignal,
    riskAssessment: IRiskAssessment,
    positionSizeUsdc: number = 25
  ): Promise<string | null> {
    const owner = this.walletService.getPublicKey().toString();
    const tokenAmount = Math.floor(positionSizeUsdc * 10 ** 6);

    const request: UltraSwapRequest = {
      inputMint: USDC_MINT_ADDRESS,
      outputMint: signal.tokenAddress,
      amount: tokenAmount.toString(),
      taker: owner,
      swapMode: "ExactIn",
    };

    const swapResponse = await SwapService.getUltraSwap(request);
    if (swapResponse?.errorMessage || !swapResponse?.transaction) {
      logger.error(
        `Buy execution failed for ${signal.tokenAddress}:`,
        swapResponse?.errorMessage || "No transaction"
      );
      return null;
    }

    // Execute through MEV protection or direct
    const signature = await this.executeTransaction(
      swapResponse.transaction,
      "medium"
    );

    if (signature) {
      // Open position with strategy attribution
      const priceData = await new SwapService().getTokenPrice([
        signal.tokenAddress,
      ]);
      const currentPrice = priceData?.prices?.[signal.tokenAddress] || 0;

      await this.positionManager.openSignalPosition(
        signal,
        riskAssessment,
        {
          tokenAddress: signal.tokenAddress,
          amount:
            Number(swapResponse.outAmount) /
            10 ** 6, // Will need actual decimals
          avgBuyPrice: currentPrice,
          signature,
        }
      );

      logger.success(
        `BUY executed: ${signal.tokenAddress} | score: ${signal.compositeScore.toFixed(2)} | strategies: ${signal.contributingSignals.map((s) => s.strategyId).join(", ")}`
      );
    }

    return signature;
  }

  /**
   * Execute a sell for a position.
   */
  async executeSell(
    tokenAddress: string,
    amount: number,
    positionId: string,
    avgBuyPrice: number
  ): Promise<string | null> {
    const owner = this.walletService.getPublicKey().toString();

    const request: UltraSwapRequest = {
      inputMint: tokenAddress,
      outputMint: USDC_MINT_ADDRESS,
      amount: amount.toString(),
      taker: owner,
      swapMode: "ExactIn",
    };

    const swapResponse = await SwapService.getUltraSwap(request);
    if (swapResponse?.errorMessage || !swapResponse?.transaction) {
      logger.error(
        `Sell execution failed for ${tokenAddress}:`,
        swapResponse?.errorMessage || "No transaction"
      );
      return null;
    }

    const signature = await this.executeTransaction(
      swapResponse.transaction,
      "high" // Higher priority for sells
    );

    if (signature) {
      const sellPrice =
        swapResponse.outUsdValue /
        Number(swapResponse.inAmount) /
        10 ** 6;
      const pnl =
        ((sellPrice - avgBuyPrice) / avgBuyPrice) * 100;

      await this.positionManager.closePosition(
        positionId,
        pnl,
        sellPrice,
        signature
      );

      logger.success(
        `SELL executed: ${tokenAddress} | PnL: ${pnl.toFixed(2)}%`
      );
    }

    return signature;
  }

  /**
   * Execute a transaction with optional MEV protection.
   */
  private async executeTransaction(
    txBase64: string,
    priority: "low" | "medium" | "high"
  ): Promise<string | null> {
    try {
      if (this.mevProtectionEnabled && this.jitoClient) {
        return await this.executeViaJito(txBase64, priority);
      }
      return await this.executeDirect(txBase64);
    } catch (err) {
      logger.error("Transaction execution error:", err);
      return null;
    }
  }

  private async executeViaJito(
    txBase64: string,
    priority: "low" | "medium" | "high"
  ): Promise<string | null> {
    const tipLamports =
      priority === "high"
        ? 50000
        : priority === "medium"
        ? 25000
        : 10000;

    const txBuf = Buffer.from(txBase64, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([this.walletService.getWallet()]);

    // Add tip instruction would require modifying the transaction
    // For now, submit the signed tx as a Jito bundle
    const result = await this.jitoClient!.sendAndConfirm(
      [tx],
      tipLamports
    );

    if (result.status === "accepted" && result.signature) {
      return result.signature;
    }

    // Fallback to direct execution
    logger.warning("Jito bundle failed, falling back to direct execution");
    return await this.executeDirect(txBase64);
  }

  private async executeDirect(txBase64: string): Promise<string | null> {
    try {
      return await this.walletService.executeSwap(txBase64);
    } catch (err) {
      logger.error("Direct execution error:", err);
      return null;
    }
  }
}
