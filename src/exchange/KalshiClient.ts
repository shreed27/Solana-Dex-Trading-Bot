import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { IExchangeClient, IUnifiedOrderbook, IUnifiedBookLevel } from "../types/exchange.types";
import { IKalshiMarket, IKalshiOrderbook, IKalshiEvent } from "../types/kalshi.types";
import { logger } from "../utils/logger";

const KALSHI_BASE_URL = "https://trading-api.kalshi.com/trade-api/v2";

export class KalshiClient implements IExchangeClient {
  readonly id = "kalshi";
  readonly name = "Kalshi";

  private apiKey: string;
  private privateKey: string | null;
  private http: AxiosInstance;
  private connected = false;

  constructor(apiKey?: string, privateKeyPem?: string) {
    this.apiKey = apiKey || "";
    this.privateKey = privateKeyPem || null;

    this.http = axios.create({
      baseURL: KALSHI_BASE_URL,
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });

    // Always "connected" for public endpoints
    this.connected = true;
  }

  private signRequest(method: string, path: string, timestamp: number): string {
    if (!this.privateKey) return "";

    const message = `${timestamp}${method.toUpperCase()}${path}`;
    try {
      const sign = crypto.createSign("RSA-SHA256");
      sign.update(message);
      sign.end();
      return sign.sign(
        { key: this.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
        "base64"
      );
    } catch {
      return "";
    }
  }

  private getAuthHeaders(method: string, path: string): Record<string, string> {
    if (!this.apiKey || !this.privateKey) return {};

    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this.signRequest(method, `/trade-api/v2${path}`, timestamp);

    return {
      "KALSHI-ACCESS-KEY": this.apiKey,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp.toString(),
    };
  }

  // ==================== PUBLIC ENDPOINTS ====================

  async getEvents(seriesTicker?: string, status?: string): Promise<IKalshiEvent[]> {
    try {
      const params: Record<string, string> = {};
      if (seriesTicker) params.series_ticker = seriesTicker;
      if (status) params.status = status;

      const resp = await this.http.get("/events", { params });
      return resp.data.events || [];
    } catch (error: any) {
      logger.error(`[Kalshi] Failed to get events: ${error.message}`);
      return [];
    }
  }

  async getMarkets(eventTicker?: string): Promise<IKalshiMarket[]> {
    try {
      const params: Record<string, string> = {};
      if (eventTicker) params.event_ticker = eventTicker;

      const resp = await this.http.get("/markets", { params });
      return resp.data.markets || [];
    } catch (error: any) {
      logger.error(`[Kalshi] Failed to get markets: ${error.message}`);
      return [];
    }
  }

  async getMarket(ticker: string): Promise<IKalshiMarket | null> {
    try {
      const resp = await this.http.get(`/markets/${ticker}`);
      return resp.data.market || null;
    } catch (error: any) {
      logger.error(`[Kalshi] Failed to get market ${ticker}: ${error.message}`);
      return null;
    }
  }

  async getKalshiOrderbook(ticker: string): Promise<IKalshiOrderbook | null> {
    try {
      const resp = await this.http.get(`/markets/${ticker}/orderbook`);
      const book = resp.data.orderbook;
      if (!book) return null;

      return {
        ticker,
        yes: (book.yes || []).map((l: [number, number]) => ({ price: l[0], quantity: l[1] })),
        no: (book.no || []).map((l: [number, number]) => ({ price: l[0], quantity: l[1] })),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      logger.error(`[Kalshi] Failed to get orderbook ${ticker}: ${error.message}`);
      return null;
    }
  }

  // ==================== IExchangeClient INTERFACE ====================

  async getOrderbook(symbol: string): Promise<IUnifiedOrderbook | null> {
    const book = await this.getKalshiOrderbook(symbol);
    if (!book) return null;

    // Kalshi prices are in cents (1-99), normalize to 0-1 dollar range
    const bids: IUnifiedBookLevel[] = book.yes
      .sort((a, b) => b.price - a.price) // highest bid first
      .map((l) => ({ price: l.price / 100, size: l.quantity }));

    const asks: IUnifiedBookLevel[] = book.no
      .sort((a, b) => a.price - b.price) // lowest ask first... but for unified, use yes ask
      .map((l) => ({ price: l.price / 100, size: l.quantity }));

    // For Kalshi: yes_ask = 100 - no_bid (complement pricing)
    // Convert to unified: bids = yes bids, asks derived from no side
    const yesBids = book.yes.sort((a, b) => b.price - a.price);
    const noBids = book.no.sort((a, b) => b.price - a.price);

    const unifiedBids: IUnifiedBookLevel[] = yesBids.map((l) => ({
      price: l.price / 100,
      size: l.quantity,
    }));

    // yes ask = (100 - no_bid) in cents
    const unifiedAsks: IUnifiedBookLevel[] = noBids.map((l) => ({
      price: (100 - l.price) / 100,
      size: l.quantity,
    })).sort((a, b) => a.price - b.price);

    const bestBid = unifiedBids[0]?.price || 0;
    const bestAsk = unifiedAsks[0]?.price || 1;

    return {
      exchange: this.id,
      symbol,
      bids: unifiedBids,
      asks: unifiedAsks,
      midPrice: (bestBid + bestAsk) / 2,
      spread: bestAsk - bestBid,
      timestamp: book.timestamp,
    };
  }

  async placeLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    price: number,
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.apiKey || !this.privateKey) {
      return { success: false, error: "No Kalshi credentials configured" };
    }

    try {
      const path = "/portfolio/orders";
      const headers = this.getAuthHeaders("POST", path);
      const body = {
        ticker: symbol,
        action: side.toLowerCase(),
        side: "yes",
        type: "limit",
        yes_price: Math.round(price * 100), // convert to cents
        count: Math.round(size),
      };

      const resp = await this.http.post(path, body, { headers });
      return { success: true, orderId: resp.data.order?.order_id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    if (!this.apiKey || !this.privateKey) {
      return { success: false, error: "No Kalshi credentials configured" };
    }

    try {
      const path = "/portfolio/orders";
      const headers = this.getAuthHeaders("POST", path);
      const body = {
        ticker: symbol,
        action: side.toLowerCase(),
        side: "yes",
        type: "market",
        count: Math.round(size),
      };

      const resp = await this.http.post(path, body, { headers });
      return { success: true, orderId: resp.data.order?.order_id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.apiKey || !this.privateKey) return false;

    try {
      const path = `/portfolio/orders/${orderId}`;
      const headers = this.getAuthHeaders("DELETE", path);
      await this.http.delete(path, { headers });
      return true;
    } catch {
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
