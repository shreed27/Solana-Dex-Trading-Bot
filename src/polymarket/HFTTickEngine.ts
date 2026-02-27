import { PolymarketClient } from "./PolymarketClient";
import { PriceFeedService } from "./PriceFeedService";
import { MarketDiscoveryService } from "./MarketDiscoveryService";
import { HFTRiskManager } from "./HFTRiskManager";
import { HFTOrderManager } from "./HFTOrderManager";
import { PerformanceTracker } from "./PerformanceTracker";
import { HFTStrategyBase } from "../strategies/hft/HFTStrategyBase";
import { YesNoArbitrageStrategy } from "../strategies/hft/YesNoArbitrageStrategy";
import { LatencyArbitrageStrategy } from "../strategies/hft/LatencyArbitrageStrategy";
import { SpreadCaptureMMStrategy } from "../strategies/hft/SpreadCaptureMMStrategy";
import { OrderbookMicrostructureStrategy } from "../strategies/hft/OrderbookMicrostructureStrategy";
import {
  ITickSnapshot,
  IArbOpportunity,
  IPerformanceMetrics,
} from "../types/hft.types";
import {
  PolymarketAsset,
  PolymarketInterval,
  IPolymarketMarket,
  IPolymarketOrderbook,
} from "../types/polymarket.types";
import { logger } from "../utils/logger";

const TICK_INTERVAL_MS = 500;
const MAX_HISTORY_TICKS = 60; // 30 seconds of history at 500ms/tick
const STALE_ORDER_CHECK_INTERVAL = 10; // Every 10 ticks (5 seconds)

/**
 * HFT Tick Engine — Core sub-second trading loop.
 *
 * Runs on setInterval(500ms), NOT cron. Each tick:
 * 1. Fetch orderbooks for all active markets (parallel)
 * 2. Read Binance prices from PriceFeedService (in-memory, no API)
 * 3. Build ITickSnapshot per market
 * 4. Pass to each HFT strategy's onTick()
 * 5. Risk-check returned opportunities
 * 6. Execute approved opportunities
 * 7. Record performance metrics
 */
export class HFTTickEngine {
  private client: PolymarketClient;
  private priceFeed: PriceFeedService;
  private discovery: MarketDiscoveryService;
  private riskManager: HFTRiskManager;
  private orderManager: HFTOrderManager;
  private perfTracker: PerformanceTracker;

  private strategies: HFTStrategyBase[] = [];
  private tickHistory: Map<string, ITickSnapshot[]> = new Map();
  private binancePriceHistory: Map<PolymarketAsset, { price: number; ts: number }[]> = new Map();

  private tickHandle: NodeJS.Timeout | null = null;
  private tickCount: number = 0;
  private running: boolean = false;
  private ticksProcessed: number = 0;
  private opportunitiesFound: number = 0;
  private tradesExecuted: number = 0;

  constructor(
    client: PolymarketClient,
    priceFeed: PriceFeedService,
    discovery: MarketDiscoveryService
  ) {
    this.client = client;
    this.priceFeed = priceFeed;
    this.discovery = discovery;
    this.riskManager = new HFTRiskManager();
    this.perfTracker = new PerformanceTracker();
    this.orderManager = new HFTOrderManager(
      client,
      this.riskManager,
      this.perfTracker
    );

    // Initialize Binance price history buffers
    for (const asset of ["BTC", "ETH", "XRP"] as PolymarketAsset[]) {
      this.binancePriceHistory.set(asset, []);
    }
  }

  /**
   * Start the HFT tick engine.
   */
  async start(): Promise<void> {
    if (this.running) return;

    logger.info("=== HFT Tick Engine Starting ===");

    // Initialize performance tracker
    this.perfTracker.initialize();

    // Load all 4 HFT strategies
    this.strategies = [
      new YesNoArbitrageStrategy(),
      new LatencyArbitrageStrategy(),
      new SpreadCaptureMMStrategy(),
      new OrderbookMicrostructureStrategy(),
    ];

    logger.info(
      `HFT strategies loaded: ${this.strategies.map((s) => s.name).join(", ")}`
    );

    // Start the tick loop
    this.running = true;
    this.tickHandle = setInterval(() => this.onTick(), TICK_INTERVAL_MS);

    logger.success(
      `HFT Tick Engine running at ${TICK_INTERVAL_MS}ms intervals | ${this.strategies.length} strategies`
    );
  }

  /**
   * Stop the HFT tick engine and cancel all open orders.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }

    // Cancel all open HFT orders
    const cancelled = await this.orderManager.cancelAllOrders();
    if (cancelled > 0) {
      logger.info(`Cancelled ${cancelled} open HFT orders`);
    }

    this.perfTracker.shutdown();

    logger.info(
      `HFT Tick Engine stopped | Ticks: ${this.ticksProcessed} | Opps: ${this.opportunitiesFound} | Trades: ${this.tradesExecuted}`
    );
  }

  /**
   * Get current performance metrics.
   */
  getPerformanceMetrics(): IPerformanceMetrics {
    return this.perfTracker.getOverallMetrics();
  }

  /**
   * Get per-strategy metrics.
   */
  getStrategyMetrics(): Map<string, IPerformanceMetrics> {
    return this.perfTracker.getStrategyMetrics();
  }

  /**
   * Core tick handler — called every 500ms.
   */
  private async onTick(): Promise<void> {
    if (!this.running) return;

    try {
      this.tickCount++;
      this.ticksProcessed++;

      // 1. Get active markets
      const markets = this.getActiveMarketsForHFT();
      if (markets.length === 0) return;

      // 2. Fetch orderbooks + Binance prices in parallel
      const snapshots = await this.buildSnapshots(markets);
      if (snapshots.length === 0) return;

      // 3. Run all strategies on each snapshot
      const allOpportunities: IArbOpportunity[] = [];

      for (const snapshot of snapshots) {
        // Get history for this market
        const marketKey = `${snapshot.asset}:${snapshot.interval}:${snapshot.conditionId}`;
        const history = this.tickHistory.get(marketKey) || [];

        // Run each enabled strategy
        for (const strategy of this.strategies) {
          if (!strategy.isEnabled()) continue;

          try {
            const opps = strategy.onTick(snapshot, history);
            allOpportunities.push(...opps);
          } catch (err) {
            // Strategy error should never crash the tick loop
            logger.error(`[HFT] Strategy ${strategy.id} error:`, err);
          }
        }

        // Update history
        history.push(snapshot);
        if (history.length > MAX_HISTORY_TICKS) {
          history.shift();
        }
        this.tickHistory.set(marketKey, history);
      }

      if (allOpportunities.length === 0) return;

      this.opportunitiesFound += allOpportunities.length;

      // 4. Risk-check and execute each opportunity
      for (const opp of allOpportunities) {
        // Calculate time to resolution
        const market = this.discovery.getCurrentMarket(opp.asset, opp.interval);
        const timeToResolution = market
          ? (market.endTime.getTime() - Date.now()) / 1000
          : 0;

        const riskCheck = this.riskManager.checkRisk(opp, timeToResolution);

        if (!riskCheck.allowed) {
          continue; // Silently skip — risk manager logs when kill switch triggers
        }

        // Cap size to risk manager suggestion
        if (riskCheck.suggestedSize > 0 && riskCheck.suggestedSize < opp.size) {
          opp.size = riskCheck.suggestedSize;
        }

        // Execute
        const trade = await this.orderManager.executeOpportunity(opp);
        if (trade) {
          this.tradesExecuted++;

          // Update strategy stats
          const strategy = this.strategies.find((s) => s.id === opp.strategyId);
          if (strategy) {
            strategy.recordTrade(trade.pnl);
          }
        }
      }

      // 5. Periodic maintenance
      if (this.tickCount % STALE_ORDER_CHECK_INTERVAL === 0) {
        await this.orderManager.cancelStaleOrders(30_000);
      }
    } catch (err) {
      logger.error("[HFT] Tick error:", err);
    }
  }

  /**
   * Get active markets suitable for HFT.
   * Filters for markets with enough time to resolution and valid token IDs.
   */
  private getActiveMarketsForHFT(): IPolymarketMarket[] {
    const allMarkets: IPolymarketMarket[] = [];

    for (const asset of ["BTC", "ETH", "XRP"] as PolymarketAsset[]) {
      for (const interval of ["5M", "15M"] as PolymarketInterval[]) {
        const market = this.discovery.getCurrentMarket(asset, interval);
        if (!market) continue;

        // Must have valid token IDs
        if (!market.yesTokenId || !market.noTokenId) continue;

        // Must have at least 60 seconds to resolution
        const timeToResolution = (market.endTime.getTime() - Date.now()) / 1000;
        if (timeToResolution < 60) continue;

        allMarkets.push(market);
      }
    }

    return allMarkets;
  }

  /**
   * Build tick snapshots for all active markets.
   * Fetches orderbooks in parallel and combines with Binance price data.
   */
  private async buildSnapshots(
    markets: IPolymarketMarket[]
  ): Promise<ITickSnapshot[]> {
    const now = Date.now();
    const snapshots: ITickSnapshot[] = [];

    // Record current Binance prices for history tracking
    for (const asset of ["BTC", "ETH", "XRP"] as PolymarketAsset[]) {
      const price = this.priceFeed.getLatestPrice(asset);
      if (price !== null) {
        const history = this.binancePriceHistory.get(asset)!;
        history.push({ price, ts: now });
        // Keep last 120 entries (~60 seconds at 500ms)
        if (history.length > 120) {
          history.shift();
        }
      }
    }

    // Fetch orderbooks in parallel (2 per market: YES + NO)
    const orderbookPromises = markets.flatMap((m) => [
      this.client.getOrderbook(m.yesTokenId).then((ob) => ({
        market: m,
        token: "yes" as const,
        orderbook: ob,
      })),
      this.client.getOrderbook(m.noTokenId).then((ob) => ({
        market: m,
        token: "no" as const,
        orderbook: ob,
      })),
    ]);

    const orderbookResults = await Promise.allSettled(orderbookPromises);

    // Group results by market
    const orderbooksByMarket = new Map<
      string,
      { yes: IPolymarketOrderbook | null; no: IPolymarketOrderbook | null }
    >();

    for (const result of orderbookResults) {
      if (result.status !== "fulfilled") continue;
      const { market, token, orderbook } = result.value;
      const key = market.conditionId;

      if (!orderbooksByMarket.has(key)) {
        orderbooksByMarket.set(key, { yes: null, no: null });
      }
      const entry = orderbooksByMarket.get(key)!;
      entry[token] = orderbook;
    }

    // Build snapshots
    for (const market of markets) {
      const obs = orderbooksByMarket.get(market.conditionId);
      if (!obs || !obs.yes || !obs.no) continue;

      const yesBids = obs.yes.bids || [];
      const yesAsks = obs.yes.asks || [];
      const noBids = obs.no.bids || [];
      const noAsks = obs.no.asks || [];

      // Calculate mid prices
      const yesBestBid = yesBids.length > 0 ? parseFloat(yesBids[0].price) : 0;
      const yesBestAsk = yesAsks.length > 0 ? parseFloat(yesAsks[0].price) : 0;
      const noBestBid = noBids.length > 0 ? parseFloat(noBids[0].price) : 0;
      const noBestAsk = noAsks.length > 0 ? parseFloat(noAsks[0].price) : 0;

      const yesMid =
        yesBestBid > 0 && yesBestAsk > 0
          ? (yesBestBid + yesBestAsk) / 2
          : yesBestBid || yesBestAsk;
      const noMid =
        noBestBid > 0 && noBestAsk > 0
          ? (noBestBid + noBestAsk) / 2
          : noBestBid || noBestAsk;

      // Calculate depths (top 5 levels)
      const calcDepth = (levels: { price: string; size: string }[]) =>
        levels
          .slice(0, 5)
          .reduce(
            (sum, l) => sum + parseFloat(l.price) * parseFloat(l.size),
            0
          );

      // Get Binance price data
      const binancePrice = this.priceFeed.getLatestPrice(market.asset) || 0;
      const priceChange10s = this.getBinancePriceChange(market.asset, 10_000);
      const priceChange30s = this.getBinancePriceChange(market.asset, 30_000);

      const snapshot: ITickSnapshot = {
        asset: market.asset,
        interval: market.interval,
        conditionId: market.conditionId,
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesBids,
        yesAsks,
        noBids,
        noAsks,
        yesMid,
        noMid,
        yesSpread: yesBestAsk - yesBestBid,
        noSpread: noBestAsk - noBestBid,
        yesBestBid,
        yesBestAsk,
        noBestBid,
        noBestAsk,
        yesBidDepth: calcDepth(yesBids),
        yesAskDepth: calcDepth(yesAsks),
        noBidDepth: calcDepth(noBids),
        noAskDepth: calcDepth(noAsks),
        binancePrice,
        binancePriceChange10s: priceChange10s,
        binancePriceChange30s: priceChange30s,
        timestamp: now,
      };

      snapshots.push(snapshot);
    }

    return snapshots;
  }

  /**
   * Calculate Binance price change over a time window.
   * Returns percentage change (e.g., 0.002 = 0.2%).
   */
  private getBinancePriceChange(
    asset: PolymarketAsset,
    windowMs: number
  ): number {
    const history = this.binancePriceHistory.get(asset);
    if (!history || history.length < 2) return 0;

    const now = Date.now();
    const cutoff = now - windowMs;
    const current = history[history.length - 1];

    // Find the entry closest to the cutoff time
    let pastEntry = history[0];
    for (const entry of history) {
      if (entry.ts <= cutoff) {
        pastEntry = entry;
      } else {
        break;
      }
    }

    if (pastEntry.price === 0) return 0;
    return (current.price - pastEntry.price) / pastEntry.price;
  }

  /**
   * Get engine stats for logging.
   */
  getStats(): {
    running: boolean;
    ticksProcessed: number;
    opportunitiesFound: number;
    tradesExecuted: number;
    openOrders: number;
    strategies: { id: string; trades: number; wins: number; pnl: number; winRate: number }[];
  } {
    return {
      running: this.running,
      ticksProcessed: this.ticksProcessed,
      opportunitiesFound: this.opportunitiesFound,
      tradesExecuted: this.tradesExecuted,
      openOrders: this.orderManager.getOpenOrderCount(),
      strategies: this.strategies.map((s) => ({
        id: s.id,
        ...s.getStats(),
      })),
    };
  }

  /**
   * Get latest tick snapshots for all markets.
   * Used by MultiExchangeTickEngine to access Polymarket data.
   */
  getLatestSnapshots(): Map<string, ITickSnapshot> {
    const latest = new Map<string, ITickSnapshot>();
    for (const [key, history] of this.tickHistory) {
      if (history.length > 0) {
        latest.set(key, history[history.length - 1]);
      }
    }
    return latest;
  }

  /**
   * Get the internal performance tracker for shared access.
   */
  getPerformanceTracker(): PerformanceTracker {
    return this.perfTracker;
  }
}
