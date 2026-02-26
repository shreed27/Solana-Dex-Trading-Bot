import axios from "axios";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { logger } from "../utils/logger";

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiNPLowzU",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSLbTfaQ9VRM2MxVqVhp",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export interface BundleResult {
  bundleId: string;
  signature?: string;
  status: "accepted" | "rejected" | "failed";
  error?: string;
}

export class JitoClient {
  private blockEngineUrl: string;
  private connection: Connection;

  constructor(blockEngineUrl: string, rpcUrl: string) {
    this.blockEngineUrl =
      blockEngineUrl || "https://mainnet.block-engine.jito.wtf";
    this.connection = new Connection(rpcUrl);
  }

  /**
   * Get a random Jito tip account.
   */
  getRandomTipAccount(): PublicKey {
    const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
    return new PublicKey(JITO_TIP_ACCOUNTS[index]);
  }

  /**
   * Create a tip instruction.
   */
  createTipInstruction(
    from: PublicKey,
    tipLamports: number
  ): TransactionInstruction {
    return SystemProgram.transfer({
      fromPubkey: from,
      toPubkey: this.getRandomTipAccount(),
      lamports: tipLamports,
    });
  }

  /**
   * Send a bundle of transactions through Jito block engine.
   * Transactions are sent privately (not visible in public mempool).
   */
  async sendBundle(
    transactions: VersionedTransaction[],
    options: { tipLamports?: number; maxRetries?: number } = {}
  ): Promise<BundleResult> {
    const maxRetries = options.maxRetries || 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Serialize transactions to base58
        const encodedTxs = transactions.map((tx) =>
          Buffer.from(tx.serialize()).toString("base64")
        );

        const response = await axios.post(
          `${this.blockEngineUrl}/api/v1/bundles`,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [encodedTxs],
          },
          {
            headers: { "Content-Type": "application/json" },
            timeout: 30000,
          }
        );

        const bundleId = response.data?.result;
        if (!bundleId) {
          logger.error("Jito bundle rejected:", response.data?.error);
          continue;
        }

        logger.info(`Jito bundle submitted: ${bundleId}`);
        return { bundleId, status: "accepted" };
      } catch (err) {
        logger.error(`Jito bundle attempt ${attempt + 1} failed:`, err);
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    return { bundleId: "", status: "failed", error: "Max retries exceeded" };
  }

  /**
   * Check bundle status.
   */
  async getBundleStatus(
    bundleId: string
  ): Promise<{ status: string; signature?: string }> {
    try {
      const response = await axios.post(
        `${this.blockEngineUrl}/api/v1/bundles`,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        },
        {
          headers: { "Content-Type": "application/json" },
          timeout: 10000,
        }
      );

      const statuses = response.data?.result?.value;
      if (statuses && statuses.length > 0) {
        const status = statuses[0];
        return {
          status: status.confirmation_status || "unknown",
          signature: status.transactions?.[0],
        };
      }
    } catch (err) {
      logger.error("Jito status check error:", err);
    }
    return { status: "unknown" };
  }

  /**
   * Send bundle and wait for confirmation.
   */
  async sendAndConfirm(
    transactions: VersionedTransaction[],
    tipLamports: number = 10000,
    timeoutMs: number = 30000
  ): Promise<BundleResult> {
    const result = await this.sendBundle(transactions, { tipLamports });
    if (result.status !== "accepted") return result;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getBundleStatus(result.bundleId);
      if (
        status.status === "confirmed" ||
        status.status === "finalized"
      ) {
        return {
          ...result,
          signature: status.signature,
          status: "accepted",
        };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    return { ...result, status: "failed", error: "Bundle confirmation timeout" };
  }
}
