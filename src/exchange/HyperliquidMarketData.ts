import { HyperliquidClient } from "./HyperliquidClient";
import { IUnifiedOrderbook } from "../types/exchange.types";
import { HYPERLIQUID_COINS, HyperliquidCoin } from "../types/hyperliquid.types";
import { logger } from "../utils/logger";

interface CachedBook {
  orderbook: IUnifiedOrderbook;
  fetchedAt: number;
}

export class HyperliquidMarketData {
  private client: HyperliquidClient;
  private books: Map<string, CachedBook> = new Map();
  private mids: Map<string, number> = new Map();
  private metaRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private initialized = false;

  constructor(client: HyperliquidClient) {
    this.client = client;
  }

  async start(): Promise<void> {
    // Load metadata
    await this.client.getMeta();
    // Initial mid prices
    await this.refreshMids();
    this.initialized = true;

    // Refresh metadata every 5 minutes
    this.metaRefreshInterval = setInterval(() => this.client.getMeta(), 5 * 60 * 1000);

    logger.info(`[HyperliquidData] Started — tracking ${HYPERLIQUID_COINS.length} coins`);
  }

  stop(): void {
    if (this.metaRefreshInterval) {
      clearInterval(this.metaRefreshInterval);
      this.metaRefreshInterval = null;
    }
  }

  async refreshMids(): Promise<void> {
    const allMids = await this.client.getAllMids();
    if (!allMids) return;

    for (const coin of HYPERLIQUID_COINS) {
      const mid = allMids[coin];
      if (mid) {
        this.mids.set(coin, parseFloat(mid));
      }
    }
  }

  async fetchOrderbook(coin: HyperliquidCoin): Promise<IUnifiedOrderbook | null> {
    const book = await this.client.getOrderbook(coin);
    if (!book) return null;

    this.books.set(coin, { orderbook: book, fetchedAt: Date.now() });
    return book;
  }

  async fetchAllOrderbooks(): Promise<Map<string, IUnifiedOrderbook>> {
    const results = new Map<string, IUnifiedOrderbook>();

    const promises = HYPERLIQUID_COINS.map(async (coin) => {
      const book = await this.fetchOrderbook(coin);
      if (book) results.set(coin, book);
    });

    await Promise.allSettled(promises);
    return results;
  }

  getCachedOrderbook(coin: string): IUnifiedOrderbook | null {
    const cached = this.books.get(coin);
    if (!cached) return null;
    // Stale after 5 seconds
    if (Date.now() - cached.fetchedAt > 5000) return null;
    return cached.orderbook;
  }

  getMidPrice(coin: string): number {
    return this.mids.get(coin) || 0;
  }

  getActiveCoins(): readonly string[] {
    return HYPERLIQUID_COINS;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
