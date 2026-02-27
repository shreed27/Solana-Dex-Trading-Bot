/**
 * BINANCE FUTURES CLIENT — Direct REST API (no ccxt)
 *
 * Works with both testnet and live. Uses HMAC-SHA256 signing.
 * Testnet: https://testnet.binancefuture.com
 * Live:    https://fapi.binance.com
 */

import * as crypto from "crypto";
import { logger } from "../utils/logger";
import * as dotenv from "dotenv";

dotenv.config();

export interface BinanceFuturesPosition {
  symbol: string;
  side: "long" | "short";
  size: number;
  notional: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number;
}

export interface BinanceFuturesOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  price: number;
  amount: number;
  filled: number;
  status: string;
  timestamp: number;
}

export class BinanceFuturesClient {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private isTestnet: boolean;
  private connected = false;

  // Symbol precision cache (loaded once)
  private symbolInfo: Map<string, { pricePrecision: number; quantityPrecision: number; minQty: number }> = new Map();

  constructor() {
    this.apiKey = process.env.BINANCE_API_KEY || "";
    this.apiSecret = process.env.BINANCE_API_SECRET || "";
    this.isTestnet = process.env.BINANCE_TESTNET === "true";
    this.baseUrl = this.isTestnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";
  }

  private sign(query: string): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query).digest("hex");
  }

  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    params: Record<string, string | number> = {},
    signed = true
  ): Promise<any> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      qs.set(k, String(v));
    }

    if (signed) {
      qs.set("timestamp", String(Date.now()));
      qs.set("recvWindow", "5000");
      const sig = this.sign(qs.toString());
      qs.set("signature", sig);
    }

    const url = method === "GET" || method === "DELETE"
      ? `${this.baseUrl}${path}?${qs.toString()}`
      : `${this.baseUrl}${path}`;

    const opts: RequestInit = {
      method,
      headers: {
        "X-MBX-APIKEY": this.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };

    if (method === "POST" || method === "PUT") {
      opts.body = qs.toString();
    }

    const resp = await fetch(url, opts);
    const data = await resp.json();

    if (data.code && data.code < 0) {
      throw new Error(`Binance API error ${data.code}: ${data.msg}`);
    }

    return data;
  }

  async connect(): Promise<boolean> {
    try {
      // 1. Test time sync
      const time = await this.request("GET", "/fapi/v1/time", {}, false);
      logger.info(`[BINANCE] Server time: ${new Date(time.serverTime).toISOString()}`);

      // 2. Load symbol info for precision
      const info = await this.request("GET", "/fapi/v1/exchangeInfo", {}, false);
      for (const sym of info.symbols) {
        const lotFilter = sym.filters.find((f: any) => f.filterType === "LOT_SIZE");
        this.symbolInfo.set(sym.symbol, {
          pricePrecision: sym.pricePrecision,
          quantityPrecision: sym.quantityPrecision,
          minQty: parseFloat(lotFilter?.minQty || "0.001"),
        });
      }

      // 3. Test auth with balance
      const balances = await this.request("GET", "/fapi/v2/balance");
      const usdt = balances.find((b: any) => b.asset === "USDT");
      const usdtBalance = usdt ? parseFloat(usdt.balance) : 0;

      this.connected = true;
      logger.success(
        `[BINANCE] Connected to ${this.isTestnet ? "TESTNET" : "LIVE"} | ` +
        `USDT: $${usdtBalance.toFixed(2)} | ` +
        `Symbols: ${this.symbolInfo.size}`
      );
      return true;
    } catch (err: any) {
      logger.error(`[BINANCE] Connection failed: ${err.message}`);
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ==================== BALANCE ====================

  async getBalance(): Promise<{ total: number; free: number; used: number }> {
    try {
      const balances = await this.request("GET", "/fapi/v2/balance");
      const usdt = balances.find((b: any) => b.asset === "USDT");
      if (!usdt) return { total: 0, free: 0, used: 0 };
      const total = parseFloat(usdt.balance);
      const free = parseFloat(usdt.availableBalance);
      return { total, free, used: total - free };
    } catch (err: any) {
      logger.error(`[BINANCE] Balance fetch failed: ${err.message}`);
      return { total: 0, free: 0, used: 0 };
    }
  }

  // ==================== LEVERAGE ====================

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      await this.request("POST", "/fapi/v1/leverage", { symbol, leverage });
      return true;
    } catch (err: any) {
      if (err.message?.includes("No need to change")) return true;
      logger.error(`[BINANCE] Set leverage failed: ${err.message}`);
      return false;
    }
  }

  async setMarginMode(symbol: string, mode: "CROSSED" | "ISOLATED"): Promise<boolean> {
    try {
      await this.request("POST", "/fapi/v1/marginType", { symbol, marginType: mode });
      return true;
    } catch (err: any) {
      if (err.message?.includes("No need to change")) return true;
      logger.error(`[BINANCE] Set margin mode failed: ${err.message}`);
      return false;
    }
  }

  // ==================== ORDERS ====================

  async marketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number
  ): Promise<BinanceFuturesOrder | null> {
    try {
      const info = this.symbolInfo.get(symbol);
      const precision = info?.quantityPrecision || 3;
      const qty = parseFloat(quantity.toFixed(precision));

      const order = await this.request("POST", "/fapi/v1/order", {
        symbol,
        side,
        type: "MARKET",
        quantity: qty,
      });

      const avgPrice = parseFloat(order.avgPrice || order.price || "0");
      const result: BinanceFuturesOrder = {
        id: String(order.orderId),
        symbol: order.symbol,
        side: order.side.toLowerCase() as "buy" | "sell",
        type: "MARKET",
        price: avgPrice,
        amount: parseFloat(order.origQty),
        filled: parseFloat(order.executedQty),
        status: order.status,
        timestamp: order.updateTime,
      };

      logger.info(
        `[BINANCE] ${side} ${symbol} | Qty: ${qty} @ $${avgPrice.toFixed(2)} | ` +
        `Filled: ${result.filled} | ID: ${result.id}`
      );
      return result;
    } catch (err: any) {
      logger.error(`[BINANCE] Market order failed ${side} ${symbol}: ${err.message}`);
      return null;
    }
  }

  async stopMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    stopPrice: number,
    closePosition = true
  ): Promise<BinanceFuturesOrder | null> {
    try {
      const info = this.symbolInfo.get(symbol);
      const pricePrecision = info?.pricePrecision || 2;

      const params: Record<string, any> = {
        symbol,
        side,
        type: "STOP_MARKET",
        stopPrice: parseFloat(stopPrice.toFixed(pricePrecision)),
        closePosition: closePosition ? "true" : "false",
      };

      const order = await this.request("POST", "/fapi/v1/order", params);
      logger.info(`[BINANCE] STOP ${side} ${symbol} @ $${stopPrice.toFixed(2)} | ID: ${order.orderId}`);

      return {
        id: String(order.orderId),
        symbol: order.symbol,
        side: side.toLowerCase() as "buy" | "sell",
        type: "STOP_MARKET",
        price: stopPrice,
        amount: 0,
        filled: 0,
        status: order.status,
        timestamp: order.updateTime,
      };
    } catch (err: any) {
      logger.error(`[BINANCE] Stop order failed: ${err.message}`);
      return null;
    }
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    try {
      await this.request("DELETE", "/fapi/v1/allOpenOrders", { symbol });
      return true;
    } catch (err: any) {
      logger.error(`[BINANCE] Cancel orders failed: ${err.message}`);
      return false;
    }
  }

  // ==================== POSITIONS ====================

  async getPositions(): Promise<BinanceFuturesPosition[]> {
    try {
      const data = await this.request("GET", "/fapi/v2/positionRisk");
      return data
        .filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0)
        .map((p: any) => ({
          symbol: p.symbol,
          side: parseFloat(p.positionAmt) > 0 ? "long" : "short",
          size: Math.abs(parseFloat(p.positionAmt)),
          notional: Math.abs(parseFloat(p.notional || "0")),
          entryPrice: parseFloat(p.entryPrice),
          markPrice: parseFloat(p.markPrice),
          unrealizedPnl: parseFloat(p.unRealizedProfit),
          leverage: parseInt(p.leverage),
          liquidationPrice: parseFloat(p.liquidationPrice),
        }));
    } catch (err: any) {
      logger.error(`[BINANCE] Positions fetch failed: ${err.message}`);
      return [];
    }
  }

  async closePosition(symbol: string, side: "long" | "short", size: number): Promise<BinanceFuturesOrder | null> {
    const closeSide = side === "long" ? "SELL" : "BUY";
    return this.marketOrder(symbol, closeSide, size);
  }

  // ==================== MARKET DATA ====================

  async getPrice(symbol: string): Promise<number> {
    try {
      const data = await this.request("GET", "/fapi/v1/ticker/price", { symbol }, false);
      return parseFloat(data.price);
    } catch {
      return 0;
    }
  }

  // ==================== HELPERS ====================

  /**
   * Convert USD amount to contract quantity for a symbol
   */
  usdToQty(symbol: string, usdAmount: number, price: number): number {
    const info = this.symbolInfo.get(symbol);
    const precision = info?.quantityPrecision || 3;
    const minQty = info?.minQty || 0.001;

    const rawQty = usdAmount / price;
    const step = Math.pow(10, -precision);
    const qty = Math.floor(rawQty / step) * step;
    return qty >= minQty ? parseFloat(qty.toFixed(precision)) : 0;
  }

  getPricePrecision(symbol: string): number {
    return this.symbolInfo.get(symbol)?.pricePrecision || 2;
  }
}
