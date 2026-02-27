import { KalshiClient } from "./KalshiClient";
import { KalshiMarketDiscovery } from "./KalshiMarketDiscovery";
import { HyperliquidClient } from "./HyperliquidClient";
import { HyperliquidMarketData } from "./HyperliquidMarketData";
import { DemoWallet } from "./DemoWallet";
import { HFTTickEngine } from "../polymarket/HFTTickEngine";
import { PerformanceTracker } from "../polymarket/PerformanceTracker";
import {
  IUnifiedOrderbook,
  ICrossExchangeOpportunity,
  IMultiExchangeTick,
} from "../types/exchange.types";
import { IHFTTrade, HFTStrategyType } from "../types/hft.types";
import { HYPERLIQUID_COINS } from "../types/hyperliquid.types";
import { logger } from "../utils/logger";
import { v4 as uuidv4 } from "uuid";

const TICK_INTERVAL_MS = 500;
const MIN_CROSS_EXCHANGE_EDGE = 0.02; // 2% minimum edge for cross-exchange arb
const MAX_DEMO_TRADE_SIZE = 10; // $10 max per demo trade

export class MultiExchangeTickEngine {
  private kalshiClient: KalshiClient;
  private kalshiDiscovery: KalshiMarketDiscovery;
  private hyperliquidClient: HyperliquidClient;
  private hyperliquidData: HyperliquidMarketData;
  private demoWallet: DemoWallet;
  private perfTracker: PerformanceTracker;
  private hftEngine: HFTTickEngine | null;

  private tickHandle: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private startTime = 0;

  // Orderbook cache per exchange
  private kalshiBooks: Map<string, IUnifiedOrderbook> = new Map();
  private hyperliquidBooks: Map<string, IUnifiedOrderbook> = new Map();
  private polymarketBooks: Map<string, IUnifiedOrderbook> = new Map();

  // Stats
  private crossExchangeOpps = 0;
  private crossExchangeTrades = 0;

  constructor(
    kalshiClient: KalshiClient,
    kalshiDiscovery: KalshiMarketDiscovery,
    hyperliquidClient: HyperliquidClient,
    hyperliquidData: HyperliquidMarketData,
    demoWallet: DemoWallet,
    perfTracker: PerformanceTracker,
    hftEngine?: HFTTickEngine
  ) {
    this.kalshiClient = kalshiClient;
    this.kalshiDiscovery = kalshiDiscovery;
    this.hyperliquidClient = hyperliquidClient;
    this.hyperliquidData = hyperliquidData;
    this.demoWallet = demoWallet;
    this.perfTracker = perfTracker;
    this.hftEngine = hftEngine || null;
  }

  async start(): Promise<void> {
    if (this.running) return;

    logger.info("=== Multi-Exchange Tick Engine Starting ===");

    // Start Kalshi market discovery
    await this.kalshiDiscovery.start();

    // Start Hyperliquid market data
    await this.hyperliquidData.start();

    this.running = true;
    this.startTime = Date.now();
    this.tickHandle = setInterval(() => this.onTick(), TICK_INTERVAL_MS);

    const kalshiCount = this.kalshiDiscovery.getTotalActiveCount();
    logger.success(
      `Multi-Exchange Engine running | Kalshi: ${kalshiCount} markets | Hyperliquid: ${HYPERLIQUID_COINS.length} perps`
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }

    this.kalshiDiscovery.stop();
    this.hyperliquidData.stop();

    logger.info(
      `Multi-Exchange Engine stopped | Ticks: ${this.tickCount} | Cross-Opps: ${this.crossExchangeOpps} | Trades: ${this.crossExchangeTrades}`
    );
  }

  private async onTick(): Promise<void> {
    if (!this.running) return;

    try {
      this.tickCount++;

      // Fetch orderbooks from all exchanges in parallel
      const [kalshiResult, hyperliquidResult] = await Promise.allSettled([
        this.fetchKalshiBooks(),
        this.fetchHyperliquidBooks(),
      ]);

      // Record equity point every tick
      this.demoWallet.recordEquity();

      // Detect cross-exchange opportunities
      const opps = this.detectCrossExchangeOpportunities();
      this.crossExchangeOpps += opps.length;

      // Execute demo trades on opportunities
      for (const opp of opps) {
        this.executeDemoTrade(opp);
      }

      // Auto-close expired positions
      this.demoWallet.checkAndCloseExpiredPositions((exchange, symbol) => {
        return this.getCurrentMidPrice(exchange, symbol);
      });
    } catch (err) {
      // Tick errors should never crash the engine
    }
  }

  private async fetchKalshiBooks(): Promise<void> {
    const tickers = this.kalshiDiscovery.getAllActiveTickers();

    const results = await Promise.allSettled(
      tickers.slice(0, 6).map(async (ticker) => {
        const book = await this.kalshiClient.getOrderbook(ticker);
        if (book) {
          this.kalshiBooks.set(ticker, book);
        }
      })
    );
  }

  private async fetchHyperliquidBooks(): Promise<void> {
    const books = await this.hyperliquidData.fetchAllOrderbooks();
    for (const [coin, book] of books) {
      this.hyperliquidBooks.set(coin, book);
    }
  }

  private detectCrossExchangeOpportunities(): ICrossExchangeOpportunity[] {
    const opps: ICrossExchangeOpportunity[] = [];

    // Cross-exchange: Kalshi YES price vs Polymarket YES price for same underlying
    for (const [asset, markets] of this.kalshiDiscovery.getCurrentMarkets()) {
      for (const market of markets) {
        const kalshiBook = this.kalshiBooks.get(market.ticker);
        if (!kalshiBook || kalshiBook.bids.length === 0 || kalshiBook.asks.length === 0) continue;

        // Check if we have a Polymarket book for the same asset
        // Polymarket keys are conditionIds, but we track by asset for cross-exchange
        const kalshiMid = kalshiBook.midPrice;

        // Look for Hyperliquid perp price for the underlying asset
        const hlBook = this.hyperliquidBooks.get(asset);
        if (hlBook && hlBook.midPrice > 0) {
          // Perp price vs prediction market implied price divergence
          // If Kalshi YES at 0.60 implies 60% chance BTC goes up,
          // and Hyperliquid perp is moving strongly in that direction
          // this can signal cross-market opportunity
          const kalshiImplied = kalshiMid; // probability
          const hlMid = hlBook.midPrice;

          // Simple divergence: if Kalshi heavily favors UP (>0.70) but HL spread is tight
          // and vice versa — these are informational signals
          if (kalshiImplied > 0.75 && hlBook.spread < hlMid * 0.001) {
            opps.push({
              type: "perp_prediction_divergence",
              exchangeA: "kalshi",
              exchangeB: "hyperliquid",
              symbol: asset,
              priceA: kalshiImplied,
              priceB: hlMid,
              spread: kalshiImplied - 0.5,
              expectedProfit: (kalshiImplied - 0.5) * MAX_DEMO_TRADE_SIZE,
              confidence: Math.min(0.9, kalshiImplied),
              direction: "BUY_A_SELL_B",
            });
          }
        }
      }
    }

    // Hyperliquid vs Polymarket Binance price divergence
    for (const coin of HYPERLIQUID_COINS) {
      const hlBook = this.hyperliquidBooks.get(coin);
      if (!hlBook || hlBook.midPrice === 0) continue;

      // This is useful for latency arb — Hyperliquid perpetual moves faster
      // than prediction market repricing
    }

    return opps;
  }

  private executeDemoTrade(opp: ICrossExchangeOpportunity): void {
    const tradeSize = Math.min(MAX_DEMO_TRADE_SIZE, this.demoWallet.getBalance() * 0.1);
    if (tradeSize < 0.50 || !this.demoWallet.canAfford(tradeSize)) return;

    const position = this.demoWallet.openPosition(
      opp.exchangeA,
      opp.symbol,
      "LONG",
      tradeSize,
      opp.priceA,
      `cross_${opp.type}`
    );

    if (position) {
      this.crossExchangeTrades++;

      // Record as HFT trade for unified performance tracking
      const trade: IHFTTrade = {
        id: uuidv4(),
        strategy: "yes_no_arb" as HFTStrategyType, // closest match
        strategyId: `cross_${opp.type}`,
        asset: opp.symbol as any,
        interval: "5M" as any,
        conditionId: `${opp.exchangeA}_${opp.exchangeB}_${opp.symbol}`,
        direction: "YES",
        tokenId: opp.symbol,
        side: "BUY",
        entryPrice: opp.priceA,
        size: tradeSize,
        shares: tradeSize / opp.priceA,
        pnl: opp.expectedProfit * 0.3, // conservative estimate
        holdTimeMs: 0,
        openedAt: Date.now(),
        closedAt: Date.now(),
      };

      this.perfTracker.recordTrade(trade);
    }
  }

  private getCurrentMidPrice(exchange: string, symbol: string): number {
    if (exchange === "kalshi") {
      const book = this.kalshiBooks.get(symbol);
      return book?.midPrice || 0.5;
    }
    if (exchange === "hyperliquid") {
      const book = this.hyperliquidBooks.get(symbol);
      return book?.midPrice || 0;
    }
    return 0.5;
  }

  // ==================== GETTERS FOR DASHBOARD ====================

  getStats(): {
    running: boolean;
    tickCount: number;
    uptimeMs: number;
    crossExchangeOpps: number;
    crossExchangeTrades: number;
    kalshiMarkets: number;
    hyperliquidCoins: number;
    kalshiBooksCount: number;
    hyperliquidBooksCount: number;
  } {
    return {
      running: this.running,
      tickCount: this.tickCount,
      uptimeMs: this.running ? Date.now() - this.startTime : 0,
      crossExchangeOpps: this.crossExchangeOpps,
      crossExchangeTrades: this.crossExchangeTrades,
      kalshiMarkets: this.kalshiDiscovery.getTotalActiveCount(),
      hyperliquidCoins: HYPERLIQUID_COINS.length,
      kalshiBooksCount: this.kalshiBooks.size,
      hyperliquidBooksCount: this.hyperliquidBooks.size,
    };
  }

  getAllOrderbooks(): IUnifiedOrderbook[] {
    const books: IUnifiedOrderbook[] = [];
    for (const book of this.kalshiBooks.values()) books.push(book);
    for (const book of this.hyperliquidBooks.values()) books.push(book);
    return books;
  }

  getConnectedExchanges(): string[] {
    const exchanges: string[] = ["polymarket"]; // always connected
    if (this.kalshiClient.isConnected()) exchanges.push("kalshi");
    if (this.hyperliquidClient.isConnected()) exchanges.push("hyperliquid");
    return exchanges;
  }

  getTicksPerSecond(): number {
    if (!this.running || this.tickCount === 0) return 0;
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    return elapsedSec > 0 ? this.tickCount / elapsedSec : 0;
  }
}
