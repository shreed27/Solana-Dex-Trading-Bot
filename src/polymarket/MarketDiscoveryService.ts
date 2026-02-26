import { PolymarketClient } from "./PolymarketClient";
import {
  IPolymarketMarket,
  PolymarketAsset,
  PolymarketInterval,
} from "../types/polymarket.types";
import { PolymarketMarketModel } from "../models/PolymarketMarket";
import { logger } from "../utils/logger";

const ASSET_KEYWORDS: Record<PolymarketAsset, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth"],
  XRP: ["xrp", "ripple"],
};

const INTERVAL_KEYWORDS: Record<PolymarketInterval, string[]> = {
  "5M": ["5 min", "5-min", "5m", "five min"],
  "15M": ["15 min", "15-min", "15m", "fifteen min"],
};

/**
 * Discovers and tracks active Polymarket 5M and 15M rolling markets
 * for BTC, ETH, and XRP.
 */
export class MarketDiscoveryService {
  private client: PolymarketClient;
  private activeMarkets: Map<string, IPolymarketMarket> = new Map();
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(client: PolymarketClient) {
    this.client = client;
  }

  async initialize(): Promise<void> {
    logger.info("MarketDiscoveryService initializing...");
    await this.discoverMarkets();

    // Poll every 30 seconds for new markets
    this.intervalHandle = setInterval(
      () => this.discoverMarkets(),
      30000
    );

    logger.success(
      `MarketDiscoveryService initialized | ${this.activeMarkets.size} active markets`
    );
  }

  async shutdown(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Discover active rolling markets from Gamma API.
   */
  private async discoverMarkets(): Promise<void> {
    try {
      // Search for crypto markets
      const allMarkets = await this.client.getActiveMarkets();

      let found = 0;
      for (const market of allMarkets) {
        const parsed = this.parseMarket(market);
        if (!parsed) continue;

        // Only track unresolved markets
        if (parsed.resolved) continue;

        // Check if market is still in the future (hasn't ended)
        if (parsed.endTime.getTime() < Date.now()) continue;

        this.activeMarkets.set(parsed.conditionId, parsed);
        found++;

        // Persist to DB
        await PolymarketMarketModel.findOneAndUpdate(
          { conditionId: parsed.conditionId },
          {
            $set: {
              asset: parsed.asset,
              interval: parsed.interval,
              yesTokenId: parsed.yesTokenId,
              noTokenId: parsed.noTokenId,
              question: parsed.question,
              startTime: parsed.startTime,
              endTime: parsed.endTime,
              liquidity: parsed.liquidity,
              volume: parsed.volume,
              lastYesPrice: parsed.yesPrice,
              lastNoPrice: parsed.noPrice,
              resolved: parsed.resolved,
              updatedAt: new Date(),
            },
          },
          { upsert: true }
        ).catch(() => {});
      }

      // Purge expired markets from active set
      const now = Date.now();
      for (const [id, market] of this.activeMarkets) {
        if (market.endTime.getTime() < now) {
          this.activeMarkets.delete(id);
        }
      }

      if (found > 0) {
        logger.info(
          `Market discovery: ${found} new markets found | ${this.activeMarkets.size} active total`
        );
      }
    } catch (err) {
      logger.error("Market discovery error:", err);
    }
  }

  /**
   * Parse a raw Gamma API market into our typed structure.
   */
  private parseMarket(raw: any): IPolymarketMarket | null {
    const title = (
      raw.question ||
      raw.title ||
      ""
    ).toLowerCase();

    // Determine asset
    let asset: PolymarketAsset | null = null;
    for (const [a, keywords] of Object.entries(ASSET_KEYWORDS)) {
      if (keywords.some((kw) => title.includes(kw))) {
        asset = a as PolymarketAsset;
        break;
      }
    }
    if (!asset) return null;

    // Determine interval
    let interval: PolymarketInterval | null = null;
    for (const [i, keywords] of Object.entries(INTERVAL_KEYWORDS)) {
      if (keywords.some((kw) => title.includes(kw))) {
        interval = i as PolymarketInterval;
        break;
      }
    }
    // Also check for time range in title (e.g., "7:50AM-7:55AM" = 5M)
    if (!interval) {
      const timeRangeMatch = title.match(
        /(\d{1,2}:\d{2})\s*(?:am|pm)?\s*-\s*(\d{1,2}:\d{2})\s*(?:am|pm)?/i
      );
      if (timeRangeMatch) {
        // Parse time difference to determine interval
        // For now, check "up" or "down" keywords to confirm it's a rolling market
        if (
          title.includes("up") ||
          title.includes("down") ||
          title.includes("higher") ||
          title.includes("lower")
        ) {
          interval = "5M"; // Default assumption; refine based on time math
        }
      }
    }
    if (!interval) return null;

    // Extract token IDs from market outcomes
    const outcomes = raw.outcomes || raw.markets?.[0]?.outcomes || [];
    const tokens = raw.tokens || raw.markets?.[0]?.tokens || [];
    let yesTokenId = "";
    let noTokenId = "";

    if (tokens.length >= 2) {
      // Tokens are typically [YES, NO]
      yesTokenId = tokens[0]?.token_id || tokens[0]?.tokenId || "";
      noTokenId = tokens[1]?.token_id || tokens[1]?.tokenId || "";
    }

    // If nested in markets array
    if (!yesTokenId && raw.markets?.length > 0) {
      const m = raw.markets[0];
      yesTokenId = m.clobTokenIds?.[0] || "";
      noTokenId = m.clobTokenIds?.[1] || "";
    }

    const conditionId =
      raw.conditionId ||
      raw.condition_id ||
      raw.markets?.[0]?.conditionId ||
      raw.id ||
      "";

    if (!conditionId) return null;

    return {
      conditionId,
      asset,
      interval,
      yesTokenId,
      noTokenId,
      question: raw.question || raw.title || "",
      startTime: raw.startDate
        ? new Date(raw.startDate)
        : new Date(),
      endTime: raw.endDate
        ? new Date(raw.endDate)
        : new Date(Date.now() + 5 * 60 * 1000),
      yesPrice: parseFloat(raw.outcomePrices?.[0] || "0.5"),
      noPrice: parseFloat(raw.outcomePrices?.[1] || "0.5"),
      liquidity: parseFloat(raw.liquidity || "0"),
      volume: parseFloat(raw.volume || "0"),
      resolved: raw.resolved || raw.closed || false,
      outcome: raw.outcome === "Yes" || raw.outcome === "Up"
        ? "UP"
        : raw.outcome === "No" || raw.outcome === "Down"
        ? "DOWN"
        : undefined,
    };
  }

  // ==================== PUBLIC API ====================

  /**
   * Get all active markets, optionally filtered by asset and interval.
   */
  getActiveMarkets(
    asset?: PolymarketAsset,
    interval?: PolymarketInterval
  ): IPolymarketMarket[] {
    let markets = Array.from(this.activeMarkets.values());
    if (asset) markets = markets.filter((m) => m.asset === asset);
    if (interval)
      markets = markets.filter((m) => m.interval === interval);
    return markets;
  }

  /**
   * Get the current active market for a given asset and interval.
   * Returns the one closest to resolution that hasn't expired yet.
   */
  getCurrentMarket(
    asset: PolymarketAsset,
    interval: PolymarketInterval
  ): IPolymarketMarket | null {
    const markets = this.getActiveMarkets(asset, interval);
    if (markets.length === 0) return null;

    const now = Date.now();
    // Sort by end time ascending, return the first one that hasn't ended
    return (
      markets
        .filter((m) => m.endTime.getTime() > now)
        .sort(
          (a, b) => a.endTime.getTime() - b.endTime.getTime()
        )[0] || null
    );
  }

  /**
   * Get all active asset symbols that have tradeable markets.
   */
  getActiveAssets(): PolymarketAsset[] {
    const assets = new Set<PolymarketAsset>();
    for (const market of this.activeMarkets.values()) {
      assets.add(market.asset);
    }
    return Array.from(assets);
  }

  /**
   * Update YES/NO prices for a market.
   */
  async refreshMarketPrices(
    conditionId: string
  ): Promise<void> {
    const market = this.activeMarkets.get(conditionId);
    if (!market || !market.yesTokenId) return;

    const yesPrice = await this.client.getMidPrice(
      market.yesTokenId
    );
    const noPrice = await this.client.getMidPrice(
      market.noTokenId
    );

    if (yesPrice !== null) market.yesPrice = yesPrice;
    if (noPrice !== null) market.noPrice = noPrice;
  }
}
