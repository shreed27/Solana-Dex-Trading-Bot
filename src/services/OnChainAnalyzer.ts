import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "../config/environment";
import { IContractAnalysis } from "../types/risk.types";
import { logger } from "../utils/logger";

export class OnChainAnalyzer {
  private connection: Connection;
  private cache: Map<string, { data: IContractAnalysis; expiresAt: number }> =
    new Map();
  private cacheTtlMs: number;

  constructor(cacheTtlMs: number = 300000) {
    this.connection = new Connection(env.solanaRpcUrl!);
    this.cacheTtlMs = cacheTtlMs;
  }

  /**
   * Analyze a token's on-chain properties for safety scoring.
   */
  async analyzeToken(tokenAddress: string): Promise<IContractAnalysis> {
    // Check cache first
    const cached = this.cache.get(tokenAddress);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const mintPubkey = new PublicKey(tokenAddress);
    const flags: string[] = [];

    let hasMintAuthority = false;
    let hasFreezeAuthority = false;
    let totalSupply = 0;

    try {
      // Fetch mint account info
      const mintAccountInfo =
        await this.connection.getAccountInfo(mintPubkey);
      if (mintAccountInfo?.data) {
        // Parse mint data layout (SPL Token Mint is 82 bytes)
        const data = mintAccountInfo.data;
        if (data.length >= 82) {
          // Mint authority: bytes 0-35 (4 byte option + 32 byte pubkey)
          const mintAuthOption = data[0];
          hasMintAuthority = mintAuthOption === 1;
          if (hasMintAuthority) flags.push("MINT_AUTHORITY_ACTIVE");

          // Supply: bytes 36-43 (u64 LE)
          totalSupply = Number(data.readBigUInt64LE(36));

          // Freeze authority: bytes 46-81 (4 byte option + 32 byte pubkey)
          const freezeAuthOption = data[46];
          hasFreezeAuthority = freezeAuthOption === 1;
          if (hasFreezeAuthority) flags.push("FREEZE_AUTHORITY_ACTIVE");
        }
      }
    } catch (err) {
      logger.error(`Failed to parse mint for ${tokenAddress}:`, err);
      flags.push("MINT_PARSE_ERROR");
    }

    // Check top holder concentration
    let topHolderConcentration = 0;
    let top10Concentration = 0;
    let creatorBalance = 0;

    try {
      const largestAccounts =
        await this.connection.getTokenLargestAccounts(mintPubkey);
      if (largestAccounts.value.length > 0 && totalSupply > 0) {
        topHolderConcentration =
          Number(largestAccounts.value[0].amount) / totalSupply;
        const top10Sum = largestAccounts.value
          .slice(0, 10)
          .reduce((sum, acc) => sum + Number(acc.amount), 0);
        top10Concentration = top10Sum / totalSupply;
        creatorBalance = Number(largestAccounts.value[0].amount);
      }

      if (topHolderConcentration > 0.5) flags.push("HIGH_HOLDER_CONCENTRATION");
      if (top10Concentration > 0.8) flags.push("TOP10_OWNS_80PCT");
    } catch (err) {
      logger.error(`Failed to get largest accounts for ${tokenAddress}:`, err);
      flags.push("ACCOUNT_QUERY_ERROR");
    }

    // Simulate sellability (honeypot check) - check if Jupiter can quote a sell
    let canSell = true;
    try {
      const axios = (await import("axios")).default;
      const quoteResponse = await axios.get(
        `https://ultra-api.jup.ag/order`,
        {
          params: {
            inputMint: tokenAddress,
            outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
            amount: "1000000",
            taker: "11111111111111111111111111111111",
            swapMode: "ExactIn",
          },
          timeout: 5000,
        }
      );
      if (quoteResponse.data?.errorMessage) {
        canSell = false;
        flags.push("HONEYPOT_SUSPECTED");
      }
    } catch {
      // If quote fails, might be honeypot or just low liquidity
      canSell = false;
      flags.push("SELL_QUOTE_FAILED");
    }

    const analysis: IContractAnalysis = {
      tokenAddress,
      hasMintAuthority,
      hasFreezeAuthority,
      topHolderConcentration,
      top10HolderConcentration: top10Concentration,
      isLpLocked: false, // Would require checking specific lock programs
      isLpBurned: false,
      canSell,
      totalSupply,
      circulatingSupply: totalSupply, // Simplified
      creatorBalance,
      creatorBalancePct: totalSupply > 0 ? creatorBalance / totalSupply : 0,
      flags,
    };

    // Cache result
    this.cache.set(tokenAddress, {
      data: analysis,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return analysis;
  }

  /**
   * Check if liquidity is locked by checking known lock program accounts.
   */
  async checkLiquidityLock(tokenAddress: string): Promise<boolean> {
    // Known lock programs: Team Finance, Unicrypt, etc.
    // For Solana: Check if LP tokens are held by known lock contracts
    // This is a simplified version
    try {
      const mintPubkey = new PublicKey(tokenAddress);
      const largestAccounts =
        await this.connection.getTokenLargestAccounts(mintPubkey);

      // Known lock program addresses on Solana
      const lockPrograms = new Set([
        "8qxwew8U4CVHh7RQUH2GNpFXfU5GuaWuYxgBJgdKiR9x", // StreamFlow
      ]);

      for (const account of largestAccounts.value) {
        const accountInfo = await this.connection.getAccountInfo(
          account.address
        );
        if (accountInfo?.owner && lockPrograms.has(accountInfo.owner.toString())) {
          return true;
        }
      }
    } catch {
      // Ignore errors in lock check
    }
    return false;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
