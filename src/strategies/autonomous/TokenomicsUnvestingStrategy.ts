import { BaseStrategy } from "../BaseStrategy";
import { IAutonomousStrategy } from "../IStrategy";
import {
  IStrategyResult,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "../../config/environment";
import { IVestingSchedule } from "../../types/market.types";
import { logger } from "../../utils/logger";

// Known vesting program IDs on Solana
const VESTING_PROGRAMS = {
  streamflow: "strmRqUCoQUgGUFGvQ2nexEbGgNMnLSkvTKk6FJUMNM",
  meanFinance: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
};

export class TokenomicsUnvestingStrategy
  extends BaseStrategy
  implements IAutonomousStrategy
{
  readonly id = "tokenomics-unvesting";
  readonly name = "Tokenomics Vesting Hedge Automation";
  readonly category = StrategyCategory.AUTONOMOUS;
  readonly tier = StrategyTier.SLOW;

  private running = false;
  private connection: Connection;
  private trackedSchedules: IVestingSchedule[] = [];

  constructor() {
    super();
    this.connection = new Connection(env.solanaRpcUrl!);
  }

  async start(): Promise<void> {
    this.running = true;
    this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    const intervalMs = this.config.params.checkIntervalMs || 3600000; // 1 hour

    while (this.running) {
      try {
        // 1. Discover vesting contracts for tracked tokens
        await this.scanVestingContracts();

        // 2. Check for upcoming unlocks
        await this.checkUpcomingUnlocks();

        await new Promise((r) => setTimeout(r, intervalMs));
      } catch (err) {
        logger.error("Tokenomics unvesting error:", err);
        await new Promise((r) => setTimeout(r, 60000));
      }
    }
  }

  private async scanVestingContracts(): Promise<void> {
    // Scan known vesting program accounts for upcoming unlocks
    for (const [name, programId] of Object.entries(VESTING_PROGRAMS)) {
      try {
        const programPubkey = new PublicKey(programId);
        const accounts =
          await this.connection.getProgramAccounts(programPubkey, {
            filters: [{ dataSize: 400 }], // Approximate vesting account size
          });

        for (const account of accounts.slice(0, 50)) {
          // Parse vesting account data
          const schedule = this.parseVestingAccount(
            account.pubkey.toString(),
            account.account.data,
            name
          );
          if (schedule) {
            this.trackedSchedules.push(schedule);
          }
        }
      } catch (err) {
        // Some programs may not be accessible
      }
    }
  }

  private parseVestingAccount(
    contractAddress: string,
    data: Buffer,
    program: string
  ): IVestingSchedule | null {
    try {
      // Simplified parsing - actual layout depends on the vesting program
      // StreamFlow vesting accounts have a specific layout
      if (data.length < 200) return null;

      // Read basic fields (these offsets are approximate)
      const tokenMint = new PublicKey(data.subarray(8, 40)).toString();
      const totalAmount = Number(data.readBigUInt64LE(72));
      const releasedAmount = Number(data.readBigUInt64LE(80));
      const nextUnlockTimestamp = Number(data.readBigUInt64LE(88));
      const recipient = new PublicKey(data.subarray(40, 72)).toString();

      // Only track future unlocks
      if (nextUnlockTimestamp * 1000 < Date.now()) return null;

      return {
        tokenAddress: tokenMint,
        contractAddress,
        totalAmount,
        releasedAmount,
        nextUnlockTimestamp: nextUnlockTimestamp * 1000,
        nextUnlockAmount: totalAmount - releasedAmount,
        recipientAddress: recipient,
      };
    } catch {
      return null;
    }
  }

  private async checkUpcomingUnlocks(): Promise<void> {
    const windowHours =
      this.config.params.unlockWindowHours || 48;
    const windowMs = windowHours * 60 * 60 * 1000;
    const now = Date.now();
    const minUnlockUsd = this.config.params.minUnlockUsd || 50000;

    for (const schedule of this.trackedSchedules) {
      const timeToUnlock = schedule.nextUnlockTimestamp - now;

      if (timeToUnlock > 0 && timeToUnlock <= windowMs) {
        // Unlock is approaching within our window
        const hoursUntil = Math.round(timeToUnlock / (60 * 60 * 1000));
        logger.info(
          `Vesting unlock approaching: ${schedule.tokenAddress.slice(0, 8)}... | ${hoursUntil}h away | amount: ${schedule.nextUnlockAmount}`
        );

        // In production:
        // 1. Check if we hold this token -> exit position before unlock
        // 2. Consider shorting via lending protocol
        // 3. Or simply avoid buying this token
      }
    }
  }

  async getActivePositions(): Promise<any[]> {
    return this.trackedSchedules;
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
