import { CandleData, ICandleData } from "../models/CandleData";
import { Token } from "../models/Token";
import { SwapService } from "./SwapService";
import { IOHLCV } from "../types/market.types";
import { logger } from "../utils/logger";

export class MarketDataService {
  private swapService: SwapService;
  private collectingTokens: Set<string> = new Set();
  private intervalHandles: NodeJS.Timeout[] = [];

  constructor() {
    this.swapService = new SwapService();
  }

  async initialize(): Promise<void> {
    logger.info("MarketDataService initializing...");
    // Start collecting 1m candles for active tokens
    const handle = setInterval(() => this.collectCandles(), 60000);
    this.intervalHandles.push(handle);
    // Initial collection
    await this.collectCandles();
    logger.success("MarketDataService initialized");
  }

  async shutdown(): Promise<void> {
    this.intervalHandles.forEach((h) => clearInterval(h));
    this.intervalHandles = [];
  }

  private async collectCandles(): Promise<void> {
    try {
      // Get tokens we're interested in from the DB
      const tokens = await Token.find({})
        .sort({ timestamp: -1 })
        .limit(50)
        .exec();

      for (const token of tokens) {
        if (!token.address || !token.price) continue;
        this.collectingTokens.add(token.address);

        // Fetch current price and build a candle
        const priceData = await this.swapService.getTokenPrice([token.address]);
        const currentPrice = priceData?.prices?.[token.address];
        if (!currentPrice) continue;

        const now = new Date();
        // Floor to minute
        const candleTime = new Date(
          Math.floor(now.getTime() / 60000) * 60000
        );

        // Upsert candle - update high/low/close, keep open
        await CandleData.findOneAndUpdate(
          {
            tokenAddress: token.address,
            interval: "1m",
            timestamp: candleTime,
          },
          {
            $setOnInsert: {
              open: currentPrice,
              volume: token.volume24h || 0,
            },
            $set: {
              close: currentPrice,
            },
            $max: { high: currentPrice },
            $min: { low: currentPrice },
          },
          { upsert: true }
        );
      }
    } catch (err) {
      logger.error("MarketDataService candle collection error:", err);
    }
  }

  /**
   * Get OHLCV candles for a token.
   */
  async getCandles(
    tokenAddress: string,
    interval: string = "1m",
    limit: number = 50
  ): Promise<IOHLCV[]> {
    const candles = await CandleData.find({
      tokenAddress,
      interval,
    })
      .sort({ timestamp: -1 })
      .limit(limit)
      .exec();

    // Return in chronological order
    return candles.reverse().map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  /**
   * Get latest price for a token from candle data.
   */
  async getLatestPrice(tokenAddress: string): Promise<number | null> {
    const candle = await CandleData.findOne({ tokenAddress, interval: "1m" })
      .sort({ timestamp: -1 })
      .exec();
    return candle?.close ?? null;
  }

  /**
   * Get all tokens being tracked.
   */
  getTrackedTokens(): string[] {
    return Array.from(this.collectingTokens);
  }
}
