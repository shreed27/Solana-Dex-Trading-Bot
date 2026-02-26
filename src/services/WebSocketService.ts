import { Connection, PublicKey, Logs } from "@solana/web3.js";
import { env } from "../config/environment";
import { IOrderbook, IPoolCreationEvent } from "../types/market.types";
import { logger } from "../utils/logger";

type LogCallback = (log: Logs) => void;
type PoolCallback = (event: IPoolCreationEvent) => void;

export class WebSocketService {
  private connection: Connection;
  private subscriptions: Map<string, number> = new Map();
  private orderbookCache: Map<string, IOrderbook> = new Map();
  private poolCallbacks: PoolCallback[] = [];

  constructor() {
    // Use WebSocket URL if available, otherwise derive from RPC URL
    const wsUrl = env.solanaRpcUrl!.replace("https://", "wss://").replace("http://", "ws://");
    this.connection = new Connection(wsUrl, {
      wsEndpoint: wsUrl,
      commitment: "confirmed",
    });
  }

  async initialize(): Promise<void> {
    logger.info("WebSocketService initializing...");
    logger.success("WebSocketService initialized");
  }

  async shutdown(): Promise<void> {
    for (const [key, subId] of this.subscriptions) {
      try {
        await this.connection.removeAccountChangeListener(subId);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.subscriptions.clear();
    logger.info("WebSocketService shut down");
  }

  /**
   * Subscribe to program logs (used by pool sniper, whale tracker, etc.)
   */
  subscribeProgramLogs(programId: PublicKey, callback: LogCallback): void {
    const subId = this.connection.onLogs(
      programId,
      (logs) => {
        callback(logs);
      },
      "confirmed"
    );
    this.subscriptions.set(`logs:${programId.toString()}`, subId);
    logger.info(`Subscribed to logs for program ${programId.toString().slice(0, 8)}...`);
  }

  /**
   * Subscribe to new pool creation events on Raydium.
   */
  subscribeNewPools(callback: PoolCallback): void {
    this.poolCallbacks.push(callback);
    // Raydium V4 AMM program
    const raydiumProgramId = new PublicKey(
      "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
    );
    this.subscribeProgramLogs(raydiumProgramId, (logs) => {
      // Check for InitializeInstruction in the log messages
      const isNewPool = logs.logs.some(
        (log) =>
          log.includes("InitializeInstruction") ||
          log.includes("initialize2")
      );
      if (!isNewPool) return;

      const event: IPoolCreationEvent = {
        poolAddress: "", // Parsed from account keys
        baseMint: "",
        quoteMint: "",
        baseVault: "",
        quoteVault: "",
        lpMint: "",
        initialLiquidity: 0,
        timestamp: new Date(),
        signature: logs.signature,
      };

      // Parse inner instructions for mint addresses
      // The full parsing requires fetching the transaction details
      this.enrichPoolEvent(logs.signature, event).then((enriched) => {
        for (const cb of this.poolCallbacks) {
          cb(enriched);
        }
      });
    });
  }

  private async enrichPoolEvent(
    signature: string,
    event: IPoolCreationEvent
  ): Promise<IPoolCreationEvent> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.transaction?.message?.accountKeys) return event;

      const keys = tx.transaction.message.accountKeys;
      // Raydium V4 pool init typically has base mint at index 8, quote mint at index 9
      if (keys.length > 9) {
        event.baseMint = keys[8]?.pubkey?.toString() || "";
        event.quoteMint = keys[9]?.pubkey?.toString() || "";
        event.poolAddress = keys[4]?.pubkey?.toString() || "";
      }
      return event;
    } catch {
      return event;
    }
  }

  /**
   * Get cached orderbook for a token (updated by subscription).
   */
  getOrderbook(tokenAddress: string): IOrderbook | null {
    return this.orderbookCache.get(tokenAddress) || null;
  }

  /**
   * Subscribe to orderbook updates for a specific market.
   */
  async subscribeOrderbook(marketAddress: string): Promise<void> {
    const marketPubkey = new PublicKey(marketAddress);
    const subId = this.connection.onAccountChange(
      marketPubkey,
      (accountInfo) => {
        // Parse orderbook from account data
        // This is a simplified version - real implementation would parse
        // OpenBook/Serum market account data layout
        const orderbook: IOrderbook = {
          tokenAddress: marketAddress,
          bids: [],
          asks: [],
          timestamp: new Date(),
        };
        this.orderbookCache.set(marketAddress, orderbook);
      },
      "confirmed"
    );
    this.subscriptions.set(`orderbook:${marketAddress}`, subId);
  }

  getConnection(): Connection {
    return this.connection;
  }
}
