import axios, { AxiosInstance } from "axios";
import { IExchangeClient, IUnifiedOrderbook, IUnifiedBookLevel } from "../types/exchange.types";
import {
  IHyperliquidL2Book,
  IHyperliquidMeta,
  IHyperliquidRawLevel,
  IHyperliquidUserState,
} from "../types/hyperliquid.types";
import { logger } from "../utils/logger";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const HYPERLIQUID_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";

export class HyperliquidClient implements IExchangeClient {
  readonly id = "hyperliquid";
  readonly name = "Hyperliquid";

  private http: AxiosInstance;
  private meta: IHyperliquidMeta | null = null;
  private connected = false;

  constructor() {
    this.http = axios.create({ timeout: 10000 });
    this.connected = true;
  }

  // ==================== INFO ENDPOINTS ====================

  async getMeta(): Promise<IHyperliquidMeta | null> {
    try {
      const resp = await this.http.post(HYPERLIQUID_INFO_URL, { type: "meta" });
      this.meta = resp.data;
      return this.meta;
    } catch (error: any) {
      logger.error(`[Hyperliquid] Failed to get meta: ${error.message}`);
      return null;
    }
  }

  async getL2Book(coin: string, nSigFigs = 5): Promise<IHyperliquidL2Book | null> {
    try {
      const resp = await this.http.post(HYPERLIQUID_INFO_URL, {
        type: "l2Book",
        coin,
        nSigFigs,
      });
      return resp.data;
    } catch (error: any) {
      logger.error(`[Hyperliquid] Failed to get L2 book for ${coin}: ${error.message}`);
      return null;
    }
  }

  async getAllMids(): Promise<Record<string, string> | null> {
    try {
      const resp = await this.http.post(HYPERLIQUID_INFO_URL, { type: "allMids" });
      return resp.data;
    } catch (error: any) {
      logger.error(`[Hyperliquid] Failed to get all mids: ${error.message}`);
      return null;
    }
  }

  async getUserState(address: string): Promise<IHyperliquidUserState | null> {
    try {
      const resp = await this.http.post(HYPERLIQUID_INFO_URL, {
        type: "clearinghouseState",
        user: address,
      });
      return resp.data;
    } catch (error: any) {
      logger.error(`[Hyperliquid] Failed to get user state: ${error.message}`);
      return null;
    }
  }

  // ==================== IExchangeClient INTERFACE ====================

  async getOrderbook(symbol: string): Promise<IUnifiedOrderbook | null> {
    const book = await this.getL2Book(symbol);
    if (!book || !book.levels) return null;

    const [rawBids, rawAsks] = book.levels;

    const bids: IUnifiedBookLevel[] = rawBids.map((l: IHyperliquidRawLevel) => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
    }));

    const asks: IUnifiedBookLevel[] = rawAsks.map((l: IHyperliquidRawLevel) => ({
      price: parseFloat(l.px),
      size: parseFloat(l.sz),
    }));

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 0;

    return {
      exchange: this.id,
      symbol,
      bids,
      asks,
      midPrice: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0,
      spread: bestAsk && bestBid ? bestAsk - bestBid : 0,
      timestamp: Date.now(),
    };
  }

  async placeLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    price: number,
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    // Hyperliquid requires EVM wallet signing for orders
    // For demo/read-only mode, return simulated success
    return { success: false, error: "Hyperliquid order signing not configured (demo mode)" };
  }

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    return { success: false, error: "Hyperliquid order signing not configured (demo mode)" };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ==================== HELPERS ====================

  getAssetIndex(coin: string): number {
    if (!this.meta) return -1;
    return this.meta.universe.findIndex((a) => a.name === coin);
  }
}
