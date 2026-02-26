import axios from "axios";
import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimit";
import { IWhaleTransaction } from "../types/market.types";

export interface EnhancedTransaction {
  signature: string;
  timestamp: number;
  type: string;
  source: string;
  tokenTransfers: {
    mint: string;
    fromUserAccount: string;
    toUserAccount: string;
    tokenAmount: number;
  }[];
  nativeTransfers: {
    fromUserAccount: string;
    toUserAccount: string;
    amount: number;
  }[];
  accountData: any[];
}

export class HeliusClient {
  private apiKey: string;
  private baseUrl: string;
  private rateLimiter: RateLimiter;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.helius.xyz";
    // Helius: 50 req/s on standard plan
    this.rateLimiter = new RateLimiter(50, 50);
  }

  /**
   * Get enhanced transaction history for a wallet.
   */
  async getEnhancedTransactions(
    address: string,
    options: { limit?: number; type?: string } = {}
  ): Promise<EnhancedTransaction[]> {
    if (!this.apiKey) return [];

    await this.rateLimiter.acquire();

    try {
      const response = await axios.get(
        `${this.baseUrl}/v0/addresses/${address}/transactions`,
        {
          params: {
            "api-key": this.apiKey,
            limit: options.limit || 20,
            type: options.type || "SWAP",
          },
          timeout: 10000,
        }
      );

      return response.data || [];
    } catch (err) {
      logger.error(`Helius transaction fetch error for ${address}:`, err);
      return [];
    }
  }

  /**
   * Parse whale transactions from enhanced tx data.
   */
  parseWhaleTransactions(
    walletAddress: string,
    transactions: EnhancedTransaction[],
    usdcMint: string
  ): IWhaleTransaction[] {
    const results: IWhaleTransaction[] = [];

    for (const tx of transactions) {
      if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) continue;

      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint === usdcMint) continue; // Skip USDC transfers

        const isBuy = transfer.toUserAccount === walletAddress;
        const isSell = transfer.fromUserAccount === walletAddress;

        if (!isBuy && !isSell) continue;

        // Estimate USD value from native transfers
        const nativeAmount = tx.nativeTransfers?.reduce(
          (sum, nt) => sum + nt.amount,
          0
        ) || 0;

        results.push({
          walletAddress,
          signature: tx.signature,
          tokenMint: transfer.mint,
          direction: isBuy ? "buy" : "sell",
          amountUsd: nativeAmount / 1e9, // Rough SOL estimate
          timestamp: tx.timestamp,
        });
      }
    }

    return results;
  }

  /**
   * Get token metadata via Helius DAS API.
   */
  async getTokenMetadata(
    mintAddress: string
  ): Promise<Record<string, any> | null> {
    if (!this.apiKey) return null;

    await this.rateLimiter.acquire();

    try {
      const response = await axios.post(
        `${this.baseUrl}/v0/token-metadata`,
        {
          mintAccounts: [mintAddress],
          includeOffChain: true,
        },
        {
          params: { "api-key": this.apiKey },
          timeout: 10000,
        }
      );
      return response.data?.[0] || null;
    } catch (err) {
      logger.error(`Helius metadata error for ${mintAddress}:`, err);
      return null;
    }
  }
}
