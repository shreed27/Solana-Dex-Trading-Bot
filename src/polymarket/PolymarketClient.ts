import axios, { AxiosInstance } from "axios";
import { ethers } from "ethers";
import {
  IPolymarketOrder,
  IPolymarketOrderResponse,
  IPolymarketOrderbook,
} from "../types/polymarket.types";
import { logger } from "../utils/logger";

const CLOB_BASE_URL = "https://clob.polymarket.com";
const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

export class PolymarketClient {
  private clobApi: AxiosInstance;
  private gammaApi: AxiosInstance;
  private wallet: ethers.Wallet | null = null;
  private apiKey: string = "";
  private apiSecret: string = "";
  private passphrase: string = "";
  private authenticated = false;

  constructor() {
    this.clobApi = axios.create({
      baseURL: CLOB_BASE_URL,
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });

    this.gammaApi = axios.create({
      baseURL: GAMMA_BASE_URL,
      timeout: 10000,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Initialize with Polygon private key and derive API credentials.
   */
  async initialize(privateKey: string): Promise<void> {
    try {
      this.wallet = new ethers.Wallet(privateKey);
      logger.info(
        `Polymarket wallet: ${this.wallet.address.slice(0, 10)}...`
      );

      // Check if we have pre-derived API credentials
      const apiKey = process.env.POLYMARKET_API_KEY;
      const apiSecret = process.env.POLYMARKET_API_SECRET;
      const passphrase = process.env.POLYMARKET_PASSPHRASE;

      if (apiKey && apiSecret && passphrase) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.passphrase = passphrase;
        this.authenticated = true;
        logger.success("Polymarket L2 credentials loaded from env");
      } else {
        // Derive API credentials via L1 auth
        await this.deriveApiCredentials();
      }
    } catch (err) {
      logger.error("Failed to initialize Polymarket client:", err);
      throw err;
    }
  }

  /**
   * Derive L2 API credentials using L1 EIP-712 signature.
   */
  private async deriveApiCredentials(): Promise<void> {
    if (!this.wallet) throw new Error("Wallet not initialized");

    try {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = "0";

      // EIP-712 domain and types for Polymarket
      const domain = {
        name: "ClobAuthDomain",
        version: "1",
        chainId: 137, // Polygon
      };

      const types = {
        ClobAuth: [
          { name: "address", type: "address" },
          { name: "timestamp", type: "string" },
          { name: "nonce", type: "uint256" },
          { name: "message", type: "string" },
        ],
      };

      const message = {
        address: this.wallet.address,
        timestamp,
        nonce,
        message: "This message attests that I control the given wallet",
      };

      const signature = await this.wallet.signTypedData(
        domain,
        types,
        message
      );

      // Request API key derivation
      const response = await this.clobApi.post("/auth/derive-api-key", null, {
        headers: {
          POLY_ADDRESS: this.wallet.address,
          POLY_SIGNATURE: signature,
          POLY_TIMESTAMP: timestamp,
          POLY_NONCE: nonce,
        },
      });

      if (response.data?.apiKey) {
        this.apiKey = response.data.apiKey;
        this.apiSecret = response.data.secret;
        this.passphrase = response.data.passphrase;
        this.authenticated = true;
        logger.success("Polymarket L2 API credentials derived");
        logger.info(
          `Save these to .env: POLYMARKET_API_KEY=${this.apiKey}`
        );
        logger.info(
          `POLYMARKET_API_SECRET=${this.apiSecret}`
        );
        logger.info(
          `POLYMARKET_PASSPHRASE=${this.passphrase}`
        );
      }
    } catch (err) {
      logger.error("Failed to derive API credentials:", err);
      logger.warning(
        "Running in read-only mode (no order placement)"
      );
    }
  }

  /**
   * Generate L2 HMAC headers for authenticated requests.
   */
  private getL2Headers(
    method: string,
    path: string,
    body: string = ""
  ): Record<string, string> {
    if (!this.authenticated) return {};

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method.toUpperCase() + path + body;

    const hmac = require("crypto")
      .createHmac("sha256", Buffer.from(this.apiSecret, "base64"))
      .update(message)
      .digest("base64");

    return {
      POLY_ADDRESS: this.wallet?.address || "",
      POLY_SIGNATURE: hmac,
      POLY_TIMESTAMP: timestamp,
      POLY_API_KEY: this.apiKey,
      POLY_PASSPHRASE: this.passphrase,
    };
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  getAddress(): string {
    return this.wallet?.address || "";
  }

  // ==================== PUBLIC ENDPOINTS ====================

  /**
   * Get orderbook for a specific token (YES or NO).
   */
  async getOrderbook(tokenId: string): Promise<IPolymarketOrderbook | null> {
    try {
      const response = await this.clobApi.get("/book", {
        params: { token_id: tokenId },
      });
      return response.data;
    } catch (err) {
      logger.error(`Failed to get orderbook for ${tokenId}:`, err);
      return null;
    }
  }

  /**
   * Get mid-market price for a token.
   */
  async getMidPrice(tokenId: string): Promise<number | null> {
    try {
      const response = await this.clobApi.get("/midpoint", {
        params: { token_id: tokenId },
      });
      return parseFloat(response.data?.mid || "0") || null;
    } catch {
      return null;
    }
  }

  /**
   * Get price for a specific token.
   */
  async getPrice(tokenId: string): Promise<number | null> {
    try {
      const response = await this.clobApi.get("/price", {
        params: { token_id: tokenId, side: "buy" },
      });
      return parseFloat(response.data?.price || "0") || null;
    } catch {
      return null;
    }
  }

  /**
   * Get spread for a token.
   */
  async getSpread(tokenId: string): Promise<number | null> {
    try {
      const response = await this.clobApi.get("/spread", {
        params: { token_id: tokenId },
      });
      return parseFloat(response.data?.spread || "0") || null;
    } catch {
      return null;
    }
  }

  /**
   * Get price history for candle data (YES/NO token price over time).
   */
  async getPriceHistory(
    tokenId: string,
    interval: string = "1m",
    fidelity: number = 60
  ): Promise<any[]> {
    try {
      const response = await this.clobApi.get("/prices-history", {
        params: { market: tokenId, interval, fidelity },
      });
      return response.data?.history || [];
    } catch {
      return [];
    }
  }

  // ==================== GAMMA API (Market Discovery) ====================

  /**
   * Search for markets by query string.
   */
  async searchMarkets(query: string, active: boolean = true): Promise<any[]> {
    try {
      const response = await this.gammaApi.get("/events", {
        params: {
          ...(active ? { active: true, closed: false } : {}),
          limit: 50,
        },
      });
      const events = response.data || [];
      // Filter by query (BTC, ETH, XRP in title)
      return events.filter(
        (e: any) =>
          e.title?.toLowerCase().includes(query.toLowerCase()) ||
          e.slug?.toLowerCase().includes(query.toLowerCase())
      );
    } catch (err) {
      logger.error("Failed to search markets:", err);
      return [];
    }
  }

  /**
   * Get all active markets with their details.
   */
  async getActiveMarkets(): Promise<any[]> {
    try {
      const response = await this.gammaApi.get("/markets", {
        params: { active: true, closed: false, limit: 100 },
      });
      return response.data || [];
    } catch (err) {
      logger.error("Failed to get active markets:", err);
      return [];
    }
  }

  /**
   * Get specific market details by condition ID.
   */
  async getMarket(conditionId: string): Promise<any | null> {
    try {
      const response = await this.gammaApi.get(`/markets/${conditionId}`);
      return response.data;
    } catch {
      return null;
    }
  }

  // ==================== AUTHENTICATED ENDPOINTS ====================

  /**
   * Place a market order (FOK - Fill or Kill).
   */
  async placeMarketOrder(
    tokenId: string,
    side: "BUY" | "SELL",
    amount: number
  ): Promise<IPolymarketOrderResponse> {
    if (!this.authenticated) {
      return { success: false, errorMsg: "Not authenticated" };
    }

    const order: IPolymarketOrder = {
      tokenId,
      side,
      price: side === "BUY" ? 0.99 : 0.01, // Aggressive price for market orders
      size: amount,
      orderType: "FOK",
    };

    return this.placeOrder(order);
  }

  /**
   * Place a limit order (GTC).
   */
  async placeLimitOrder(
    tokenId: string,
    side: "BUY" | "SELL",
    price: number,
    size: number
  ): Promise<IPolymarketOrderResponse> {
    if (!this.authenticated) {
      return { success: false, errorMsg: "Not authenticated" };
    }

    const order: IPolymarketOrder = {
      tokenId,
      side,
      price,
      size,
      orderType: "GTC",
    };

    return this.placeOrder(order);
  }

  private async placeOrder(
    order: IPolymarketOrder
  ): Promise<IPolymarketOrderResponse> {
    try {
      const body = JSON.stringify(order);
      const headers = this.getL2Headers("POST", "/order", body);

      const response = await this.clobApi.post("/order", order, { headers });

      return {
        success: response.data?.success ?? true,
        orderID: response.data?.orderID,
        status: response.data?.status,
      };
    } catch (err: any) {
      const msg =
        err.response?.data?.errorMsg ||
        err.response?.data?.message ||
        err.message;
      logger.error(`Order placement failed: ${msg}`);
      return { success: false, errorMsg: msg };
    }
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    if (!this.authenticated) return false;

    try {
      const headers = this.getL2Headers(
        "DELETE",
        `/order/${orderId}`
      );
      await this.clobApi.delete(`/order/${orderId}`, { headers });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Place a typed limit order with optional expiration (GTD support).
   * Used by HFT market making for time-limited passive orders.
   */
  async placeLimitOrderTyped(
    tokenId: string,
    side: "BUY" | "SELL",
    price: number,
    size: number,
    orderType: "GTC" | "GTD" | "FOK" | "FAK" = "GTC",
    expiration?: number // UTC seconds for GTD
  ): Promise<IPolymarketOrderResponse> {
    if (!this.authenticated) {
      return { success: false, errorMsg: "Not authenticated" };
    }

    const order: IPolymarketOrder = {
      tokenId,
      side,
      price,
      size,
      orderType,
      ...(expiration ? { expiration } : {}),
    };

    return this.placeOrder(order);
  }

  /**
   * Get open orders.
   */
  async getOpenOrders(): Promise<any[]> {
    if (!this.authenticated) return [];

    try {
      const headers = this.getL2Headers("GET", "/orders");
      const response = await this.clobApi.get("/orders", { headers });
      return response.data || [];
    } catch {
      return [];
    }
  }
}
