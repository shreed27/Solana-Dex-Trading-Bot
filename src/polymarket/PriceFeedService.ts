import axios from "axios";
import { IOHLCV } from "../types/market.types";
import { PolymarketAsset } from "../types/polymarket.types";
import { logger } from "../utils/logger";

const BINANCE_BASE = "https://api.binance.com/api/v3";

// Map assets to Binance symbols
const BINANCE_SYMBOLS: Record<PolymarketAsset, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  XRP: "XRPUSDT",
};

/**
 * Fetches real-time price data for BTC, ETH, XRP from Binance.
 * Builds OHLCV candles for indicator analysis.
 */
export class PriceFeedService {
  // In-memory candle ring buffers per asset
  private candles: Map<PolymarketAsset, IOHLCV[]> = new Map();
  private maxCandles: number;
  private intervalHandles: NodeJS.Timeout[] = [];
  private latestPrices: Map<PolymarketAsset, number> = new Map();
  private assets: PolymarketAsset[] = ["BTC", "ETH", "XRP"];

  constructor(maxCandles: number = 200) {
    this.maxCandles = maxCandles;
    for (const asset of this.assets) {
      this.candles.set(asset, []);
    }
  }

  async initialize(): Promise<void> {
    logger.info("PriceFeedService initializing...");

    // Load initial historical candles (1-minute, last 100)
    for (const asset of this.assets) {
      await this.loadHistoricalCandles(asset, 100);
    }

    // Start collecting live candles every 10 seconds
    const priceHandle = setInterval(() => this.collectPrices(), 10000);
    this.intervalHandles.push(priceHandle);

    // Build 1-minute candles every 60 seconds
    const candleHandle = setInterval(() => this.buildCandles(), 60000);
    this.intervalHandles.push(candleHandle);

    logger.success(
      `PriceFeedService initialized for ${this.assets.join(", ")}`
    );
  }

  async shutdown(): Promise<void> {
    this.intervalHandles.forEach((h) => clearInterval(h));
    this.intervalHandles = [];
  }

  /**
   * Load historical 1-minute candles from Binance.
   */
  private async loadHistoricalCandles(
    asset: PolymarketAsset,
    limit: number
  ): Promise<void> {
    try {
      const symbol = BINANCE_SYMBOLS[asset];
      const response = await axios.get(`${BINANCE_BASE}/klines`, {
        params: { symbol, interval: "1m", limit },
      });

      const candles: IOHLCV[] = (response.data || []).map(
        (k: any[]) => ({
          timestamp: new Date(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        })
      );

      this.candles.set(asset, candles);
      if (candles.length > 0) {
        this.latestPrices.set(
          asset,
          candles[candles.length - 1].close
        );
      }

      logger.info(
        `Loaded ${candles.length} candles for ${asset}`
      );
    } catch (err) {
      logger.error(`Failed to load candles for ${asset}:`, err);
    }
  }

  /**
   * Collect latest prices from Binance.
   */
  private async collectPrices(): Promise<void> {
    try {
      const symbols = this.assets.map((a) => BINANCE_SYMBOLS[a]);
      const response = await axios.get(`${BINANCE_BASE}/ticker/price`, {
        params: {
          symbols: JSON.stringify(symbols),
        },
      });

      for (const ticker of response.data || []) {
        const asset = this.assets.find(
          (a) => BINANCE_SYMBOLS[a] === ticker.symbol
        );
        if (asset) {
          this.latestPrices.set(asset, parseFloat(ticker.price));
        }
      }
    } catch {
      // Fallback: fetch individually
      for (const asset of this.assets) {
        try {
          const symbol = BINANCE_SYMBOLS[asset];
          const response = await axios.get(
            `${BINANCE_BASE}/ticker/price`,
            { params: { symbol } }
          );
          this.latestPrices.set(
            asset,
            parseFloat(response.data.price)
          );
        } catch {
          // Skip on error
        }
      }
    }
  }

  /**
   * Build a 1-minute candle from the latest price tick.
   */
  private buildCandles(): void {
    for (const asset of this.assets) {
      const price = this.latestPrices.get(asset);
      if (!price) continue;

      const existingCandles = this.candles.get(asset) || [];
      const now = new Date();
      const candleTime = new Date(
        Math.floor(now.getTime() / 60000) * 60000
      );

      // Check if we should update the last candle or start a new one
      const lastCandle = existingCandles[existingCandles.length - 1];
      if (
        lastCandle &&
        lastCandle.timestamp.getTime() === candleTime.getTime()
      ) {
        // Update existing candle
        lastCandle.close = price;
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
      } else {
        // New candle
        existingCandles.push({
          timestamp: candleTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0, // Will be updated from Binance klines
        });

        // Trim to max size
        if (existingCandles.length > this.maxCandles) {
          existingCandles.shift();
        }
      }

      this.candles.set(asset, existingCandles);
    }
  }

  // ==================== PUBLIC API ====================

  /**
   * Get OHLCV candles for an asset.
   */
  getCandles(asset: PolymarketAsset, limit: number = 50): IOHLCV[] {
    const candles = this.candles.get(asset) || [];
    return candles.slice(-limit);
  }

  /**
   * Get the latest price for an asset.
   */
  getLatestPrice(asset: PolymarketAsset): number | null {
    return this.latestPrices.get(asset) || null;
  }

  /**
   * Get all tracked assets.
   */
  getAssets(): PolymarketAsset[] {
    return [...this.assets];
  }

  /**
   * Check if we have enough data for indicator calculation.
   */
  hasEnoughData(
    asset: PolymarketAsset,
    minCandles: number = 26
  ): boolean {
    const candles = this.candles.get(asset) || [];
    return candles.length >= minCandles;
  }
}
