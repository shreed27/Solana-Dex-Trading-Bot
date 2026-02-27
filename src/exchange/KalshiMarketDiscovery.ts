import { KalshiClient } from "./KalshiClient";
import { IKalshiMarket, IKalshiEvent, KALSHI_CRYPTO_SERIES } from "../types/kalshi.types";
import { logger } from "../utils/logger";

interface ActiveKalshiMarket {
  ticker: string;
  eventTicker: string;
  asset: string;
  title: string;
  yesBid: number;
  yesAsk: number;
  volume: number;
  closeTime: string;
}

export class KalshiMarketDiscovery {
  private client: KalshiClient;
  private activeMarkets: Map<string, ActiveKalshiMarket[]> = new Map();
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  private refreshMs: number;

  constructor(client: KalshiClient, refreshMs = 60000) {
    this.client = client;
    this.refreshMs = refreshMs;
  }

  async start(): Promise<void> {
    await this.discoverActiveMarkets();
    this.refreshInterval = setInterval(() => this.discoverActiveMarkets(), this.refreshMs);
    logger.info("[KalshiDiscovery] Started market discovery");
  }

  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async discoverActiveMarkets(): Promise<void> {
    for (const [asset, seriesTicker] of Object.entries(KALSHI_CRYPTO_SERIES)) {
      try {
        const events = await this.client.getEvents(seriesTicker, "open");

        const markets: ActiveKalshiMarket[] = [];
        for (const event of events) {
          if (!event.markets) continue;

          for (const market of event.markets) {
            if (market.status === "open") {
              markets.push({
                ticker: market.ticker,
                eventTicker: market.event_ticker,
                asset,
                title: market.title,
                yesBid: market.yes_bid,
                yesAsk: market.yes_ask,
                volume: market.volume,
                closeTime: market.close_time,
              });
            }
          }
        }

        this.activeMarkets.set(asset, markets);

        if (markets.length > 0) {
          logger.info(`[KalshiDiscovery] ${asset}: ${markets.length} active markets`);
        }
      } catch (error: any) {
        logger.error(`[KalshiDiscovery] Failed to discover ${asset}: ${error.message}`);
      }
    }
  }

  getCurrentMarkets(): Map<string, ActiveKalshiMarket[]> {
    return this.activeMarkets;
  }

  getMarketsForAsset(asset: string): ActiveKalshiMarket[] {
    return this.activeMarkets.get(asset) || [];
  }

  getAllActiveTickers(): string[] {
    const tickers: string[] = [];
    for (const markets of this.activeMarkets.values()) {
      for (const m of markets) {
        tickers.push(m.ticker);
      }
    }
    return tickers;
  }

  getTotalActiveCount(): number {
    let count = 0;
    for (const markets of this.activeMarkets.values()) {
      count += markets.length;
    }
    return count;
  }
}
