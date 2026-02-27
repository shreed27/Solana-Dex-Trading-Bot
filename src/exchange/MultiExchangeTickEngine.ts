/**
 * ============================================================================
 * MULTI-EXCHANGE QUANT ENGINE — HIGH CONVICTION MODE
 * ============================================================================
 *
 * Target: $1/minute from $100 starting capital.
 *
 * STRATEGY 1: LEVERAGED MOMENTUM RIDING (Hyperliquid, 20x)
 *   - Detect BTC/ETH/SOL micro-trends from Binance WebSocket
 *   - Confirm with HL orderbook imbalance
 *   - Open 45% equity as margin × 20x = 900% notional
 *   - Ride trend with trailing stop (give back only 30% of peak profit)
 *   - Hard stop: 0.07% against entry = 1.4% on margin
 *
 * STRATEGY 2: POLYMARKET UP/DOWN BINARY BETS (no leverage, 1:2+ R/R)
 *   - Rolling 5m/15m markets: "Will BTC/ETH/SOL/XRP go Up or Down?"
 *   - Entry 30-65¢ + SL at -18% = always ≥1:2 R/R vs $1.00 resolution
 *   - HOLD winners to resolution ($1.00). SL losers at -18% via real-time WS.
 *   - Momentum signal from Binance WS drives direction
 *   - Size: 12% of equity per bet
 *
 * MATH:
 *   Momentum trade: $45 margin × 20x = $900 notional
 *   BTC moves 0.11% = $1.00 profit ✓
 *   PM bet: $10 on Up@$0.45 → resolves to $1.00 = $12.22 profit (122%) ✓ (R/R = 1:2.2)
 * ============================================================================
 */

import { KalshiClient } from "./KalshiClient";
import { KalshiMarketDiscovery } from "./KalshiMarketDiscovery";
import { HyperliquidClient } from "./HyperliquidClient";
import { HyperliquidMarketData } from "./HyperliquidMarketData";
import { DemoWallet } from "./DemoWallet";
import { BinanceWebSocketFeed } from "./BinanceWebSocketFeed";
import { PolymarketWebSocketFeed } from "./PolymarketWebSocketFeed";
import { HFTTickEngine } from "../polymarket/HFTTickEngine";
import { PerformanceTracker } from "../polymarket/PerformanceTracker";
import {
  IUnifiedOrderbook,
  IDemoPosition,
} from "../types/exchange.types";
import { IHFTTrade, HFTStrategyType } from "../types/hft.types";
import { HYPERLIQUID_COINS } from "../types/hyperliquid.types";

import {
  QuantStrategyEngine,
  PriceHistory,
  StrategyType,
} from "../quant/strategy/QuantStrategyEngine";
import { InstitutionalRiskManager } from "../quant/risk/InstitutionalRiskManager";
import { MarketMakingEngine } from "../quant/market-making/MarketMakingEngine";
import { PreTradeRiskControls } from "../quant/compliance/ComplianceFramework";
import { MarketDataPipeline } from "../quant/data/DataPipeline";

import { logger } from "../utils/logger";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";

// ============================================================================
// STRATEGY PARAMETERS
// ============================================================================

const TICK_INTERVAL_MS = 500;
const MAX_POSITIONS = 20;

// === LEVERAGE ===
const HL_LEVERAGE = 20;
const PM_LEVERAGE = 1;

// === POSITION SIZING (% of equity — auto-compounds) ===
const MOM_SIZE_PCT = 0.45;     // 45% of equity per momentum trade (AGGRESSIVE)
const PM_BET_SIZE_PCT = 0.12;  // 12% of equity per PM bet — reduced to improve R/R ratio
const MIN_TRADE_SIZE = 5;      // $5 minimum per trade
const PM_RESERVED_CASH = 250;  // Reserve $250 cash for PM bets

// === MOMENTUM DETECTION (Binance WS) ===
const MOM_TICK_WINDOW = 8;
const MOM_CONSECUTIVE = 2;
const MOM_MIN_MOVE_PCT = 0.0002;
const MOM_COOLDOWN_MS = 1_000;

// === MOMENTUM EXIT (HL Perps) ===
const MOM_HARD_SL_PCT = 0.0007;
const MOM_TRAIL_ACTIVATE = 0.0005;
const MOM_TRAIL_GIVEBACK = 0.30;
const MOM_MAX_HOLD = 300_000;

// === POLYMARKET UP/DOWN BINARY BETS ===
// Rolling 5m/15m markets: buy Up/Down shares, hold until resolution or early exit
const PM_UPDOWN_REFRESH_MS = 30_000;   // Refresh market discovery every 30s
const PM_MIN_MOMENTUM_STRENGTH = 0.20; // Lowered: consensus filter prevents bad entries, this gates flow
const PM_UPDOWN_COOLDOWN_MS = 3_000;   // 3s cooldown per asset (faster recycling, consensus filter protects)
// Complete-set arb: buy UP+DOWN on same market if combined ask < threshold
const PM_COMPLETE_SET_THRESHOLD = 0.96; // Buy both if UP_ask + DOWN_ask < 96¢ (4¢+ locked profit)
// Flash crash: sudden probability drop → buy the dip
const PM_FLASH_CRASH_DROP = 0.15;      // 15%+ drop from recent price → flash crash signal
const PM_FLASH_CRASH_WINDOW = 10_000;  // Look at last 10 seconds of price history

// ============================================================================
// TYPES
// ============================================================================

interface MomentumSignal {
  asset: string;
  direction: "LONG" | "SHORT";
  strength: number;
  moveSize: number;
  confirmed: boolean;
}

interface PositionMeta {
  strategy: "momentum" | "pm_updown" | "pm_arb" | "pm_flash_crash" | "quant";
  exchange: string;
  maxPrice: number;
  minPrice: number;
  trailActive: boolean;
  tpPrice: number;
  slPrice: number;
}

/** A Polymarket Up/Down binary resolution market */
interface UpDownMarket {
  asset: string;           // "BTC", "ETH", "SOL", "XRP"
  timeframe: "5m" | "15m";
  slug: string;            // e.g. "btc-updown-5m-1772177700"
  startTs: number;         // Unix ms — window open
  endTs: number;           // Unix ms — resolution time
  upTokenId: string;       // CLOB token for "Up" outcome
  downTokenId: string;     // CLOB token for "Down" outcome
  upPrice: number;         // Current Up share price
  downPrice: number;       // Current Down share price
  startPrice: number;      // Binance price at window start (for resolution)
}

/** Tracks an active Up/Down bet */
interface UpDownBet {
  positionId: string;      // DemoWallet position ID
  marketSlug: string;
  asset: string;
  side: "Up" | "Down";
  tokenId: string;
  entrySharePrice: number; // ~$0.50
  costBasis: number;       // Total $ spent
  resolutionTs: number;    // When to settle
}

// ============================================================================
// ENGINE
// ============================================================================

export class MultiExchangeTickEngine {
  // Dependencies
  private kalshiClient: KalshiClient;
  private kalshiDiscovery: KalshiMarketDiscovery;
  private hyperliquidClient: HyperliquidClient;
  private hyperliquidData: HyperliquidMarketData;
  private demoWallet: DemoWallet;
  private perfTracker: PerformanceTracker;
  private hftEngine: HFTTickEngine | null;

  // Engine state
  private tickHandle: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private startTime = 0;

  // Orderbook caches
  private kalshiBooks: Map<string, IUnifiedOrderbook> = new Map();
  private hyperliquidBooks: Map<string, IUnifiedOrderbook> = new Map();
  private polymarketBooks: Map<string, IUnifiedOrderbook> = new Map();

  // WebSocket feeds
  private binanceFeed = new BinanceWebSocketFeed();
  private polymarketFeed = new PolymarketWebSocketFeed();

  // Quant subsystems
  private strategyEngine = new QuantStrategyEngine();
  private riskManager: InstitutionalRiskManager;
  private marketMaker = new MarketMakingEngine();
  private compliance = new PreTradeRiskControls();
  private dataPipeline = new MarketDataPipeline();

  // Price histories
  private perpHistories: Map<string, PriceHistory> = new Map();

  // Momentum tick buffers
  private tickBuffers: Map<string, { price: number; ts: number }[]> = new Map();

  // Polymarket Up/Down markets
  private upDownMarkets: Map<string, UpDownMarket> = new Map(); // key = slug
  private upDownBets: Map<string, UpDownBet> = new Map();       // key = positionId
  private bettedSlugs: Set<string> = new Set();
  private polyRefreshTimer: NodeJS.Timeout | null = null;

  // Legacy PM token tracking (for WS subscription)
  private polymarketTokens: { id: string; label: string }[] = [];

  // Position metadata
  private positionMeta: Map<string, PositionMeta> = new Map();

  // Cooldowns
  private lastMomentumTrade: Map<string, number> = new Map();
  private lastPmUpdownBet: Map<string, number> = new Map();

  // PM token price history (for flash crash detection)
  private pmPriceHistory: Map<string, { price: number; ts: number }[]> = new Map();

  // Complete-set arb tracking (avoid double-arbing same market)
  private completedSetArbs: Set<string> = new Set();

  // Tracking
  private recentPnlWindow: { ts: number; pnl: number }[] = [];
  private recentOrderTimestamps: number[] = [];

  // Stats
  private crossExchangeOpps = 0;
  private crossExchangeTrades = 0;
  private quantSignals = 0;
  private quantBlocked = 0;
  private quantTrades = 0;

  // Strategy stats
  private scalpTrades = 0;
  private scalpWins = 0;
  private scalpPnl = 0;
  private momentumTrades = 0;
  private momentumWins = 0;
  private momentumPnl = 0;
  private bookImbTrades = 0;
  private bookImbWins = 0;
  private bookImbPnl = 0;
  private pmBetTrades = 0;
  private pmBetWins = 0;
  private pmBetPnl = 0;

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

    this.riskManager = new InstitutionalRiskManager(demoWallet.getBalance());

    for (const coin of HYPERLIQUID_COINS) {
      this.dataPipeline.registerInstruments([`hl:${coin}`]);
      this.perpHistories.set(coin, new PriceHistory(2000));
      this.tickBuffers.set(coin, []);
    }

    this.marketMaker.start();
  }

  // ==================== LIFECYCLE ====================

  async start(): Promise<void> {
    if (this.running) return;
    logger.info("=== HIGH CONVICTION ENGINE STARTING ===");
    logger.info(`Strategy 1: Leveraged momentum (HL ${HL_LEVERAGE}x, ${(MOM_SIZE_PCT*100)}% equity/trade)`);
    logger.info(`Strategy 2: PM Up/Down binary bets (${(PM_BET_SIZE_PCT*100)}% equity/bet, 5m/15m)`);
    logger.info(`Target: $1/min from $100`);

    // 1. Discover Polymarket Up/Down markets
    await this.discoverUpDownMarkets();

    // 2. Binance WebSocket
    this.binanceFeed.connect();
    this.binanceFeed.onPrice((asset, price, change10s, change30s) => {
      this.onBinancePrice(asset, price, change10s, change30s);
    });

    // 3. Polymarket WebSocket (real-time book prices on up/down tokens)
    if (this.polymarketTokens.length > 0) {
      const tokenIds = this.polymarketTokens.map((t) => t.id);
      const labels = new Map(this.polymarketTokens.map((t) => [t.id, t.label]));
      this.polymarketFeed.connect(tokenIds, labels);
      this.polymarketFeed.onBookUpdate((tokenId, book) => {
        this.polymarketBooks.set(tokenId, book);
        // Real-time SL check on every book update (faster than 500ms tick)
        this.checkPmSlRealtime(tokenId, book);
      });
    }

    // 4. Start REST exchanges
    await this.kalshiDiscovery.start();
    await this.hyperliquidData.start();

    // 5. Market refresh — every 30s (markets rotate every 5 min)
    this.polyRefreshTimer = setInterval(
      () => this.discoverUpDownMarkets(),
      PM_UPDOWN_REFRESH_MS
    );

    // 6. 500ms tick
    this.running = true;
    this.startTime = Date.now();
    this.tickHandle = setInterval(() => this.onTick(), TICK_INTERVAL_MS);

    logger.success(
      `ENGINE LIVE | BIN WS: ${this.binanceFeed.isConnected() ? "OK" : "..."} | ` +
      `PM: ${this.upDownMarkets.size} up/down mkts | ` +
      `HL: ${HYPERLIQUID_COINS.length} perps @ ${HL_LEVERAGE}x`
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; }
    if (this.polyRefreshTimer) { clearInterval(this.polyRefreshTimer); this.polyRefreshTimer = null; }

    this.binanceFeed.disconnect();
    this.polymarketFeed.disconnect();
    this.kalshiDiscovery.stop();
    this.hyperliquidData.stop();
    this.marketMaker.stop();

    const eq = this.demoWallet.getEquity();
    logger.info(
      `ENGINE STOPPED | Mom: ${this.momentumTrades}T ${this.momentumWins}W $${this.momentumPnl.toFixed(2)} | ` +
      `PM: ${this.pmBetTrades}T ${this.pmBetWins}W $${this.pmBetPnl.toFixed(2)} | ` +
      `Equity: $${eq.toFixed(2)}`
    );
  }

  // ==================== STRATEGY 1: LEVERAGED MOMENTUM ====================

  private onBinancePrice(
    asset: string,
    price: number,
    change10s: number,
    _change30s: number
  ): void {
    // Always update perp history
    const perpHist = this.perpHistories.get(asset);
    if (perpHist) perpHist.push(price, 0);

    // Buffer ticks for momentum detection
    let buffer = this.tickBuffers.get(asset);
    if (!buffer) {
      buffer = [];
      this.tickBuffers.set(asset, buffer);
    }
    buffer.push({ price, ts: Date.now() });
    if (buffer.length > MOM_TICK_WINDOW * 2) {
      buffer.splice(0, buffer.length - MOM_TICK_WINDOW * 2);
    }

    // Detect momentum signal
    const signal = this.detectMomentum(asset, buffer);
    if (signal && signal.confirmed) {
      this.executeMomentumTrade(signal);

      // Also try PM Up/Down bet on the same momentum signal
      this.tryUpDownBet(signal);
    }

    // Cross-asset: significant Binance move → try PM bets for that asset
    // Require stronger move (0.3%+ in 10s) to avoid noise-triggered PM bets
    if (Math.abs(change10s) > 0.003) {
      this.crossExchangeOpps++;
      const direction: "LONG" | "SHORT" = change10s > 0 ? "LONG" : "SHORT";
      this.tryUpDownBet({
        asset,
        direction,
        strength: Math.min(1, Math.abs(change10s) * 300),
        moveSize: Math.abs(change10s),
        confirmed: true,
      });
    }
  }

  private detectMomentum(
    asset: string,
    buffer: { price: number; ts: number }[]
  ): MomentumSignal | null {
    if (buffer.length < MOM_CONSECUTIVE + 1) return null;

    const recent = buffer.slice(-MOM_TICK_WINDOW);
    if (recent.length < MOM_CONSECUTIVE + 1) return null;

    const changes: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      changes.push(recent[i].price - recent[i - 1].price);
    }

    let consecutive = 0;
    const lastChange = changes[changes.length - 1];
    if (lastChange === 0) return null;

    const direction = lastChange > 0 ? 1 : -1;
    for (let i = changes.length - 1; i >= 0; i--) {
      if (changes[i] * direction > 0) {
        consecutive++;
      } else {
        break;
      }
    }

    if (consecutive < MOM_CONSECUTIVE) return null;

    const streakStart = recent[recent.length - 1 - consecutive].price;
    const streakEnd = recent[recent.length - 1].price;
    const moveSize = Math.abs(streakEnd - streakStart) / streakStart;

    if (moveSize < MOM_MIN_MOVE_PCT) return null;

    const hlBook = this.hyperliquidBooks.get(asset);
    let bookConfirms = true;
    if (hlBook && hlBook.bids.length > 0 && hlBook.asks.length > 0) {
      const bidDepth = hlBook.bids.slice(0, 5).reduce((s, l) => s + l.size * l.price, 0);
      const askDepth = hlBook.asks.slice(0, 5).reduce((s, l) => s + l.size * l.price, 0);
      const imbalance = (bidDepth - askDepth) / (bidDepth + askDepth);
      bookConfirms = direction > 0 ? imbalance > -0.1 : imbalance < 0.1;
    }

    return {
      asset,
      direction: direction > 0 ? "LONG" : "SHORT",
      strength: Math.min(1, consecutive / MOM_TICK_WINDOW),
      moveSize,
      confirmed: bookConfirms,
    };
  }

  private executeMomentumTrade(signal: MomentumSignal): void {
    const lastTrade = this.lastMomentumTrade.get(signal.asset) || 0;
    if (Date.now() - lastTrade < MOM_COOLDOWN_MS) return;

    const hlBook = this.hyperliquidBooks.get(signal.asset);
    if (!hlBook || hlBook.midPrice <= 0) return;

    const positions = this.demoWallet.getPositions();
    if (positions.length >= MAX_POSITIONS) return;

    const assetPositions = positions.filter(
      (p) => p.symbol === signal.asset && p.exchange === "hyperliquid" &&
        this.positionMeta.get(p.id)?.strategy === "momentum"
    );
    if (assetPositions.length >= 3) return;

    const equity = this.demoWallet.getEquity();
    const strengthScale = 0.5 + signal.strength * 0.5;
    const margin = Math.max(MIN_TRADE_SIZE, equity * MOM_SIZE_PCT * strengthScale);

    // Reserve cash for PM bets — don't let momentum consume everything
    const cashAfterTrade = this.demoWallet.getBalance() - margin;
    if (!this.demoWallet.canAfford(margin) || cashAfterTrade < PM_RESERVED_CASH) return;

    const entryPrice = hlBook.midPrice;
    const slPrice = signal.direction === "LONG"
      ? entryPrice * (1 - MOM_HARD_SL_PCT)
      : entryPrice * (1 + MOM_HARD_SL_PCT);

    const pos = this.demoWallet.openPosition(
      "hyperliquid",
      signal.asset,
      signal.direction,
      margin,
      entryPrice,
      "momentum",
      HL_LEVERAGE
    );

    if (!pos) return;

    this.positionMeta.set(pos.id, {
      strategy: "momentum",
      exchange: "hyperliquid",
      maxPrice: entryPrice,
      minPrice: entryPrice,
      trailActive: false,
      tpPrice: 0,
      slPrice,
    });

    this.riskManager.registerStopLoss(pos, 0.02, MOM_MAX_HOLD);
    this.lastMomentumTrade.set(signal.asset, Date.now());
    this.recentOrderTimestamps.push(Date.now());
    this.momentumTrades++;
    this.quantTrades++;

    const notional = margin * HL_LEVERAGE;
    logger.info(
      `[MOMENTUM] ${signal.direction} ${signal.asset} ${HL_LEVERAGE}x | ` +
      `Margin: $${margin.toFixed(2)} Notional: $${notional.toFixed(0)} @ ${entryPrice.toFixed(2)} | ` +
      `Move: ${(signal.moveSize * 100).toFixed(3)}% Strength: ${(signal.strength * 100).toFixed(0)}% | ` +
      `SL: ${slPrice.toFixed(2)}`
    );
  }

  // ==================== STRATEGY 2: POLYMARKET UP/DOWN BETS ====================

  /**
   * POLYMARKET UP/DOWN BINARY BETS
   *
   * These are rolling 5m/15m markets on Polymarket:
   *   "Bitcoin Up or Down - Feb 27, 2:35AM-2:40AM ET"
   *
   * Mechanics:
   * - Buy "Up" shares at ~$0.50 if we predict price goes up
   * - Buy "Down" shares at ~$0.50 if we predict price goes down
   * - Resolution: if BTC closes up → "Up" shares pay $1.00, "Down" = $0
   *              if BTC closes down → "Down" shares pay $1.00, "Up" = $0
   * - Risk/reward: ~1:1 at 50¢ entry. Win = +$1 profit per share.
   * - Our momentum signals have 80%+ WR → highly profitable
   */
  private tryUpDownBet(signal: MomentumSignal): void {
    // Strength filter
    if (signal.strength < PM_MIN_MOMENTUM_STRENGTH) return;

    // Cooldown per asset
    const lastBet = this.lastPmUpdownBet.get(signal.asset) || 0;
    if (Date.now() - lastBet < PM_UPDOWN_COOLDOWN_MS) return;

    const now = Date.now();
    const positions = this.demoWallet.getPositions();
    if (positions.length >= MAX_POSITIONS) return;

    // Conviction-scaled sizing: stronger signals → bigger bets (10%-20% of equity)
    // Also applies time-based scaling per-candidate below
    const baseSizePct = PM_BET_SIZE_PCT + (signal.strength - 0.2) * 0.0625;
    const equity = this.demoWallet.getEquity();
    const cashAvailable = this.demoWallet.getBalance();
    if (cashAvailable < MIN_TRADE_SIZE) return;

    // ── Score ALL eligible markets and pick the best one ──
    // Lower entry price = better R/R (buy at $0.40 → win pays 2.5:1 vs 1:1 at $0.50)
    // 15m markets preferred over 5m (more time for momentum to play out)
    interface Candidate {
      slug: string;
      market: any;
      tokenId: string;
      buyUp: boolean;
      sharePrice: number;
      liquidity: number; // shares available at best ask
      score: number;
      timeToEnd: number;
    }
    const candidates: Candidate[] = [];

    for (const [slug, market] of this.upDownMarkets) {
      if (market.asset !== signal.asset) continue;
      if (this.bettedSlugs.has(slug)) continue;

      // Market timing checks
      const windowDuration = market.endTs - market.startTs;
      const elapsed = now - market.startTs;
      const timeToEnd = market.endTs - now;

      if (elapsed < 0 || timeToEnd < 0) continue;
      // 5m: need 60s left. 15m: need 90s left.
      const minTimeLeft = market.timeframe === "5m" ? 60_000 : 90_000;
      if (timeToEnd < minTimeLeft) continue;
      if (elapsed > windowDuration * 0.80) continue;  // No entries past 80% of window

      // Check the MOMENTUM side at two price tiers:
      // 1. Cheap entry (10-45¢): momentum side hasn't repriced yet → buy cheap, sell on CLOB at +80%
      //    e.g. LONG BTC → UP token still at 15¢ from prior down → rides repricing to 60¢+
      // 2. Moderate entry (45-65¢): market agrees → hold to $1.00 resolution, SL at -18%
      const momentumBuyUp = signal.direction === "LONG";
      const momentumTokenId = momentumBuyUp ? market.upTokenId : market.downTokenId;

      const wsBook = this.polymarketBooks.get(momentumTokenId);
      if (!wsBook || wsBook.asks.length === 0) continue;
      const sharePrice = wsBook.asks[0].price;
      const availableLiquidity = wsBook.asks[0].size;
      if (availableLiquidity < 10) continue;

      // Determine entry tier
      let isCheapPlay = false;
      if (sharePrice > 0.10 && sharePrice <= 0.45) {
        // CHEAP PLAY: Momentum side is dirt cheap — market hasn't repriced yet
        // Skip if signal is weak (need strong momentum to justify buying unrepriced token)
        if (signal.strength < 0.40) continue;
        isCheapPlay = true;
      } else if (sharePrice > 0.45 && sharePrice <= 0.65) {
        // MODERATE PLAY: Market agrees with momentum → consensus entry
        if (wsBook.midPrice < 0.48) continue;
      } else {
        // Outside both ranges — skip (too cheap <10¢ = dead, or >65¢ = poor R/R)
        continue;
      }

      {

        // ── SCORING ──
        const payoutMultiple = 1.0 / sharePrice;
        const priceScore = payoutMultiple;
        const tfBonus = market.timeframe === "15m" ? 0.3 : 0;
        const wDuration = market.endTs - market.startTs;
        const timeRemainingPct = timeToEnd / wDuration;
        const timeBonus = timeRemainingPct * 0.2;
        const strengthBonus = signal.strength * 0.5;
        // Cheap plays get a +1.0 bonus (we WANT to buy these — best R/R)
        const cheapBonus = isCheapPlay ? 1.0 : 0;

        const score = priceScore + tfBonus + timeBonus + strengthBonus + cheapBonus;

        candidates.push({
          slug, market,
          tokenId: momentumTokenId,
          buyUp: momentumBuyUp,
          sharePrice, liquidity: availableLiquidity,
          score, timeToEnd,
        });
      } // end block
    } // end upDownMarkets loop

    // No valid candidates — log why for debugging
    if (candidates.length === 0) {
      // Check what's blocking
      let matchingAsset = 0, alreadyBet = 0, noBook = 0, priceFilt = 0, lowLiq = 0, timeFilt = 0, weakSig = 0;
      for (const [slug, market] of this.upDownMarkets) {
        if (market.asset !== signal.asset) continue;
        matchingAsset++;
        if (this.bettedSlugs.has(slug)) { alreadyBet++; continue; }
        const timeToEnd = market.endTs - now;
        if (timeToEnd < 60_000 || timeToEnd < 0) { timeFilt++; continue; }
        const buyUp = signal.direction === "LONG";
        const tokenId = buyUp ? market.upTokenId : market.downTokenId;
        const wsBook = this.polymarketBooks.get(tokenId);
        if (!wsBook || wsBook.asks.length === 0) { noBook++; continue; }
        const sp = wsBook.asks[0].price;
        if (sp <= 0.10 || sp > 0.65) { priceFilt++; continue; }
        if (sp <= 0.45 && signal.strength < 0.40) { weakSig++; continue; }
        if (sp > 0.45 && wsBook.midPrice < 0.48) { priceFilt++; continue; }
        if (wsBook.asks[0].size < 10) { lowLiq++; continue; }
      }
      if (matchingAsset > 0) {
        logger.info(
          `[PM SKIP] ${signal.asset} ${signal.direction} str=${(signal.strength*100).toFixed(0)}% | ` +
          `markets=${matchingAsset} bet=${alreadyBet} time=${timeFilt} noBook=${noBook} weakSig=${weakSig} price=${priceFilt} liq=${lowLiq}`
        );
      }
      return;
    }

    // Pick the best scoring candidate
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Get current Binance reference price for resolution
    const buffer = this.tickBuffers.get(signal.asset);
    const refPrice = buffer && buffer.length > 0
      ? buffer[buffer.length - 1].price
      : 0;

    if (best.market.startPrice <= 0 && refPrice > 0) {
      best.market.startPrice = refPrice;
    }

    // Time-based sizing: bigger bets early in window (from Gabagool discrete buckets)
    const bestWindowDuration = best.market.endTs - best.market.startTs;
    const timeElapsedPct = 1 - (best.timeToEnd / bestWindowDuration);
    // Scale: 100% size at start → 60% size at 80% through window
    const timeScale = Math.max(0.6, 1.0 - timeElapsedPct * 0.5);
    const sizePct = Math.min(baseSizePct * timeScale, 0.20);
    const rawBetSize = Math.max(MIN_TRADE_SIZE, Math.min(equity * sizePct, cashAvailable - 1));
    if (rawBetSize < MIN_TRADE_SIZE) return;

    // Cap bet size to available liquidity at best ask
    const maxFromLiquidity = best.liquidity * best.sharePrice;
    const betSize = Math.min(rawBetSize, maxFromLiquidity);
    if (betSize < MIN_TRADE_SIZE) return;

    // Open position in demo wallet
    const pos = this.demoWallet.openPosition(
      "polymarket", best.tokenId, "LONG", betSize, best.sharePrice, "pm_updown", PM_LEVERAGE
    );
    if (!pos) return;

    this.positionMeta.set(pos.id, {
      strategy: "pm_updown",
      exchange: "polymarket",
      maxPrice: best.sharePrice,
      minPrice: best.sharePrice,
      trailActive: false,
      tpPrice: 1.0,
      slPrice: 0.001,
    });

    this.upDownBets.set(pos.id, {
      positionId: pos.id,
      marketSlug: best.slug,
      asset: signal.asset,
      side: best.buyUp ? "Up" : "Down",
      tokenId: best.tokenId,
      entrySharePrice: best.sharePrice,
      costBasis: betSize,
      resolutionTs: best.market.endTs,
    });

    this.bettedSlugs.add(best.slug);
    this.lastPmUpdownBet.set(signal.asset, Date.now());
    this.recentOrderTimestamps.push(Date.now());
    this.pmBetTrades++;
    this.quantTrades++;

    const timeLeft = (best.timeToEnd / 1000).toFixed(0);
    const shares = (betSize / best.sharePrice).toFixed(1);
    const payout = (betSize / best.sharePrice).toFixed(2);
    const rr = (1.0 / best.sharePrice).toFixed(1);
    const entryType = best.sharePrice <= 0.45 ? "CHEAP" : "MODERATE";
    logger.info(
      `[PM ${entryType}] ${best.buyUp ? "UP" : "DOWN"} ${signal.asset} ${best.market.timeframe} | ` +
      `$${betSize.toFixed(2)} → ${shares} shares @ $${best.sharePrice.toFixed(2)} (${rr}:1 R/R) | ` +
      `Win=$${payout} Loss=$0 | Liq=${best.liquidity.toFixed(0)} shares | Score=${best.score.toFixed(2)} [${candidates.length} candidates] | ` +
      `Resolves in ${timeLeft}s | ${best.slug}`
    );
  }

  // ==================== STRATEGY 3: COMPLETE-SET ARBITRAGE ====================

  /**
   * COMPLETE-SET ARB (from Gabagool/polybot)
   *
   * If we can buy UP + DOWN shares on the same market for < $1.00 combined,
   * we lock in guaranteed profit regardless of outcome.
   * Example: UP ask = 45¢, DOWN ask = 48¢ → cost = 93¢ → guaranteed 7¢ profit per share.
   *
   * Called every tick from the main loop.
   */
  private tryCompleteSetArb(): void {
    const now = Date.now();
    const positions = this.demoWallet.getPositions();
    if (positions.length >= MAX_POSITIONS - 1) return; // Need room for 2 positions

    const equity = this.demoWallet.getEquity();
    const cashAvailable = this.demoWallet.getBalance();
    if (cashAvailable < MIN_TRADE_SIZE * 2) return;

    for (const [slug, market] of this.upDownMarkets) {
      if (this.completedSetArbs.has(slug)) continue;

      // Need time left for the trade to settle
      const timeToEnd = market.endTs - now;
      if (timeToEnd < 20_000 || timeToEnd < 0) continue;

      // Get REAL best ask prices from WS for both tokens
      const upBook = this.polymarketBooks.get(market.upTokenId);
      const downBook = this.polymarketBooks.get(market.downTokenId);
      if (!upBook || !downBook) continue;
      if (upBook.asks.length === 0 || downBook.asks.length === 0) continue;

      const upAsk = upBook.asks[0].price;
      const downAsk = downBook.asks[0].price;
      const combinedCost = upAsk + downAsk;

      // Skip if no arb edge (both tokens cost >= $1.00 combined)
      if (combinedCost >= PM_COMPLETE_SET_THRESHOLD) continue;

      const edge = 1.0 - combinedCost; // Guaranteed profit per $1 of shares
      const upLiq = upBook.asks[0].size;
      const downLiq = downBook.asks[0].size;
      const maxShares = Math.min(upLiq, downLiq); // Limited by smaller side

      // Size: use up to 15% equity, capped by liquidity
      const maxBet = Math.min(equity * 0.15, cashAvailable * 0.4);
      const sharesToBuy = Math.min(maxShares, maxBet / combinedCost);
      if (sharesToBuy < 5) continue; // Need at least 5 shares

      const upCost = sharesToBuy * upAsk;
      const downCost = sharesToBuy * downAsk;
      const totalCost = upCost + downCost;
      const lockedProfit = sharesToBuy * edge;

      if (totalCost < MIN_TRADE_SIZE || lockedProfit < 0.50) continue; // Need $0.50+ profit

      // Open UP position
      const upPos = this.demoWallet.openPosition(
        "polymarket", market.upTokenId, "LONG", upCost, upAsk, "pm_arb_up", PM_LEVERAGE
      );
      if (!upPos) continue;

      // Open DOWN position
      const downPos = this.demoWallet.openPosition(
        "polymarket", market.downTokenId, "LONG", downCost, downAsk, "pm_arb_down", PM_LEVERAGE
      );
      if (!downPos) {
        this.demoWallet.closePosition(upPos.id, upAsk); // Rollback
        continue;
      }

      // Track both as arb set
      this.positionMeta.set(upPos.id, {
        strategy: "pm_arb", exchange: "polymarket",
        maxPrice: upAsk, minPrice: upAsk, trailActive: false,
        tpPrice: 1.0, slPrice: 0.001,
      });
      this.positionMeta.set(downPos.id, {
        strategy: "pm_arb", exchange: "polymarket",
        maxPrice: downAsk, minPrice: downAsk, trailActive: false,
        tpPrice: 1.0, slPrice: 0.001,
      });

      // Track as UP/DOWN bets for settlement
      this.upDownBets.set(upPos.id, {
        positionId: upPos.id, marketSlug: slug, asset: market.asset,
        side: "Up", tokenId: market.upTokenId,
        entrySharePrice: upAsk, costBasis: upCost, resolutionTs: market.endTs,
      });
      this.upDownBets.set(downPos.id, {
        positionId: downPos.id, marketSlug: slug, asset: market.asset,
        side: "Down", tokenId: market.downTokenId,
        entrySharePrice: downAsk, costBasis: downCost, resolutionTs: market.endTs,
      });

      this.completedSetArbs.add(slug);
      this.pmBetTrades += 2;
      this.quantTrades += 2;

      logger.info(
        `[PM ARB] Complete set ${market.asset} ${market.timeframe} | ` +
        `UP@$${upAsk.toFixed(2)} + DOWN@$${downAsk.toFixed(2)} = $${combinedCost.toFixed(2)} | ` +
        `${sharesToBuy.toFixed(0)} shares × ${(edge * 100).toFixed(1)}¢ edge = $${lockedProfit.toFixed(2)} locked profit | ` +
        `${slug}`
      );
    }
  }

  // ==================== STRATEGY 4: FLASH CRASH DETECTION ====================

  /**
   * FLASH CRASH: Sudden probability drop on PM orderbook → buy the dip.
   *
   * From discountry/polymarket-trading-bot strategy.
   * If UP token drops from 60¢ to 40¢ in 10 seconds, the crash is likely
   * an overreaction → buy at 40¢ for mean-reversion profit.
   *
   * Called from PM WS book update callbacks.
   */
  private checkFlashCrash(tokenId: string, book: IUnifiedOrderbook): void {
    const now = Date.now();
    const positions = this.demoWallet.getPositions();
    if (positions.length >= MAX_POSITIONS) return;

    // Mid price as current reference
    if (book.midPrice <= 0.05 || book.midPrice >= 0.95) return;

    // Update price history for this token
    let history = this.pmPriceHistory.get(tokenId);
    if (!history) {
      history = [];
      this.pmPriceHistory.set(tokenId, history);
    }
    history.push({ price: book.midPrice, ts: now });

    // Keep last 30 seconds of history
    while (history.length > 0 && now - history[0].ts > 30_000) {
      history.shift();
    }
    if (history.length < 3) return; // Need some history

    // Find max price in last 10 seconds
    const lookback = history.filter(h => now - h.ts <= PM_FLASH_CRASH_WINDOW);
    if (lookback.length < 2) return;
    const recentMax = Math.max(...lookback.map(h => h.price));
    const currentPrice = book.midPrice;
    const drop = (recentMax - currentPrice) / recentMax;

    // Not a flash crash
    if (drop < PM_FLASH_CRASH_DROP) return;

    // Find which market this token belongs to
    let matchedSlug: string | null = null;
    let matchedMarket: UpDownMarket | null = null;
    let isUpToken = false;

    for (const [slug, market] of this.upDownMarkets) {
      if (market.upTokenId === tokenId) {
        matchedSlug = slug; matchedMarket = market; isUpToken = true; break;
      }
      if (market.downTokenId === tokenId) {
        matchedSlug = slug; matchedMarket = market; isUpToken = false; break;
      }
    }
    if (!matchedSlug || !matchedMarket) return;
    if (this.bettedSlugs.has(matchedSlug)) return;

    // Time check
    const timeToEnd = matchedMarket.endTs - now;
    if (timeToEnd < 30_000) return;

    // Cooldown: use asset cooldown
    const lastBet = this.lastPmUpdownBet.get(matchedMarket.asset) || 0;
    if (now - lastBet < PM_UPDOWN_COOLDOWN_MS) return;

    // Buy at best ask (the crashed price)
    if (book.asks.length === 0) return;
    const bestAsk = book.asks[0].price;
    if (bestAsk >= 0.90 || bestAsk <= 0.05) return;

    const equity = this.demoWallet.getEquity();
    const cashAvailable = this.demoWallet.getBalance();
    // Flash crash = high conviction → bigger size (20% equity)
    const betSize = Math.max(MIN_TRADE_SIZE, Math.min(equity * 0.20, cashAvailable - 1));
    if (betSize < MIN_TRADE_SIZE) return;

    const pos = this.demoWallet.openPosition(
      "polymarket", tokenId, "LONG", betSize, bestAsk, "pm_flash_crash", PM_LEVERAGE
    );
    if (!pos) return;

    this.positionMeta.set(pos.id, {
      strategy: "pm_flash_crash", exchange: "polymarket",
      maxPrice: bestAsk, minPrice: bestAsk, trailActive: false,
      tpPrice: 1.0, slPrice: 0.001,
    });

    this.upDownBets.set(pos.id, {
      positionId: pos.id, marketSlug: matchedSlug, asset: matchedMarket.asset,
      side: isUpToken ? "Up" : "Down", tokenId,
      entrySharePrice: bestAsk, costBasis: betSize,
      resolutionTs: matchedMarket.endTs,
    });

    this.bettedSlugs.add(matchedSlug);
    this.lastPmUpdownBet.set(matchedMarket.asset, now);
    this.pmBetTrades++;
    this.quantTrades++;

    const shares = (betSize / bestAsk).toFixed(1);
    logger.info(
      `[PM CRASH] ${isUpToken ? "UP" : "DOWN"} ${matchedMarket.asset} ${matchedMarket.timeframe} | ` +
      `Crash: $${recentMax.toFixed(2)} → $${currentPrice.toFixed(2)} (-${(drop*100).toFixed(1)}%) | ` +
      `$${betSize.toFixed(2)} → ${shares} shares @ $${bestAsk.toFixed(2)} | ` +
      `${matchedSlug}`
    );
  }

  /**
   * PM EARLY EXIT — DUAL STRATEGY
   *
   * CHEAP ENTRIES (≤45¢): Buy low, sell on CLOB for +80%+ profit.
   *   - User's approach: buy at 15¢, sell at 62¢ = 312% return.
   *   - TP at +80% (sell to other traders). SL at -30%.
   *   - Trailing stop at +50% with 35% giveback to ride the reprice.
   *   - R/R: risk 30% of cost, reward 80%+ = 1:2.7+
   *
   * MODERATE ENTRIES (45-65¢): Hold to binary resolution ($1.00).
   *   - TP is the resolution itself. SL at -18%.
   *   - R/R: risk 18%, reward 54-122% = 1:3+
   */
  private checkPmEarlyExit(): void {
    const toRemove: string[] = [];

    for (const [posId, bet] of this.upDownBets) {
      const now = Date.now();
      if (now >= bet.resolutionTs) continue;

      const meta = this.positionMeta.get(posId);
      if (!meta) continue;
      if (meta.strategy === "pm_arb") continue;

      const wsBook = this.polymarketBooks.get(bet.tokenId);
      if (!wsBook || wsBook.bids.length === 0) continue;
      const bestBid = wsBook.bids[0].price;

      const entry = bet.entrySharePrice;
      const gain = (bestBid - entry) / entry;
      const timeToEnd = bet.resolutionTs - now;

      // Update high-water mark
      if (bestBid > meta.maxPrice) meta.maxPrice = bestBid;

      const isCheapEntry = entry <= 0.45;

      if (isCheapEntry) {
        // ═══ CHEAP ENTRY STRATEGY: Sell on CLOB for profit ═══

        // TAKE PROFIT at +80%: buy at 30¢ → sell at 54¢
        if (gain >= 0.80) {
          const pos = this.findPosition(posId);
          const pnl = this.demoWallet.closePosition(posId, bestBid);
          if (pos) this.recordClosedTrade(pos, pnl, bestBid, "pm_take_profit");
          logger.info(
            `[PM TP] ${bet.side} ${bet.asset} | Entry=$${entry.toFixed(2)} Exit=$${bestBid.toFixed(2)} (+${(gain*100).toFixed(0)}%) | ` +
            `PnL: $${pnl.toFixed(2)} | CLOB sell | ${bet.marketSlug}`
          );
          toRemove.push(posId);
          continue;
        }

        // TRAILING STOP: lock in gains after +50% move
        const peakGain = (meta.maxPrice - entry) / entry;
        if (peakGain >= 0.50) {
          const trailPrice = entry + (meta.maxPrice - entry) * 0.65; // Give back 35%
          if (bestBid <= trailPrice) {
            const pos = this.findPosition(posId);
            const pnl = this.demoWallet.closePosition(posId, bestBid);
            if (pos) this.recordClosedTrade(pos, pnl, bestBid, "pm_trail");
            logger.info(
              `[PM TRAIL] ${bet.side} ${bet.asset} | Entry=$${entry.toFixed(2)} Peak=$${meta.maxPrice.toFixed(2)} Exit=$${bestBid.toFixed(2)} | ` +
              `PnL: $${pnl.toFixed(2)} | ${bet.marketSlug}`
            );
            toRemove.push(posId);
            continue;
          }
        }

        // STOP LOSS at -30%: cheap tokens are volatile
        if (gain <= -0.30) {
          const pos = this.findPosition(posId);
          const pnl = this.demoWallet.closePosition(posId, bestBid);
          if (pos) this.recordClosedTrade(pos, pnl, bestBid, "pm_stop_loss");
          logger.info(
            `[PM SL] ${bet.side} ${bet.asset} | Entry=$${entry.toFixed(2)} Exit=$${bestBid.toFixed(2)} (${(gain*100).toFixed(0)}%) | ` +
            `PnL: $${pnl.toFixed(2)} | ${bet.marketSlug}`
          );
          toRemove.push(posId);
          continue;
        }
      } else {
        // ═══ MODERATE ENTRY STRATEGY: Hold to resolution ═══

        // STOP LOSS at -18%: caps downside, rest rides to $1.00
        if (gain <= -0.18 && timeToEnd > 60_000) {
          const pos = this.findPosition(posId);
          const pnl = this.demoWallet.closePosition(posId, bestBid);
          if (pos) this.recordClosedTrade(pos, pnl, bestBid, "pm_stop_loss");
          logger.info(
            `[PM SL] ${bet.side} ${bet.asset} | Entry=$${entry.toFixed(2)} Exit=$${bestBid.toFixed(2)} (${(gain*100).toFixed(0)}%) | ` +
            `PnL: $${pnl.toFixed(2)} | ${bet.marketSlug}`
          );
          toRemove.push(posId);
          continue;
        }

        // NEAR-EXPIRY: deeply losing in last 30s → cut
        if (timeToEnd < 30_000 && gain < -0.25) {
          const pos = this.findPosition(posId);
          const pnl = this.demoWallet.closePosition(posId, bestBid);
          if (pos) this.recordClosedTrade(pos, pnl, bestBid, "pm_expiry_cut");
          logger.info(
            `[PM CUT] ${bet.side} ${bet.asset} | Entry=$${entry.toFixed(2)} Exit=$${bestBid.toFixed(2)} (${(gain*100).toFixed(0)}%) | ` +
            `PnL: $${pnl.toFixed(2)} | ${bet.marketSlug}`
          );
          toRemove.push(posId);
          continue;
        }

        // Hold to resolution — $1.00 payout is the TP
      }
    }

    for (const id of toRemove) {
      this.upDownBets.delete(id);
    }
  }

  /**
   * REAL-TIME SL CHECK — fires on every PM WS book update (sub-100ms).
   * Prevents gap slippage that the 500ms tick loop can miss.
   * Uses -30% for cheap entries (≤45¢), -18% for moderate entries.
   */
  private checkPmSlRealtime(tokenId: string, book: IUnifiedOrderbook): void {
    if (book.bids.length === 0) return;
    const bestBid = book.bids[0].price;

    for (const [posId, bet] of this.upDownBets) {
      if (bet.tokenId !== tokenId) continue;
      const meta = this.positionMeta.get(posId);
      if (!meta || meta.strategy === "pm_arb") continue;

      const gain = (bestBid - bet.entrySharePrice) / bet.entrySharePrice;
      const isCheap = bet.entrySharePrice <= 0.45;
      const timeToEnd = bet.resolutionTs - Date.now();
      // Cheap entries: wider SL (-30%). Moderate: tighter (-18%).
      // Near expiry: widen to avoid panic exits.
      const slThreshold = isCheap ? -0.30 : (timeToEnd > 60_000 ? -0.18 : -0.35);

      if (gain <= slThreshold) {
        const pos = this.findPosition(posId);
        const pnl = this.demoWallet.closePosition(posId, bestBid);
        if (pos) {
          this.recordClosedTrade(pos, pnl, bestBid, "pm_stop_loss_rt");
        }
        logger.info(
          `[PM SL-RT] ${bet.side} ${bet.asset} | Entry=$${bet.entrySharePrice.toFixed(2)} Exit=$${bestBid.toFixed(2)} (${(gain*100).toFixed(1)}%) | ` +
          `PnL: $${pnl.toFixed(2)} | ${bet.marketSlug}`
        );
        this.upDownBets.delete(posId);
        break;
      }
    }
  }

  /**
   * SETTLE UP/DOWN BETS
   *
   * Called every tick. Checks if any bets have reached their resolution time.
   * Resolution: compare Binance price at end of window to start of window.
   * - If price went up → "Up" wins ($1.00), "Down" loses ($0)
   * - If price went down → "Down" wins ($1.00), "Up" loses ($0)
   */
  private settleUpDownBets(): void {
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [posId, bet] of this.upDownBets) {
      if (now < bet.resolutionTs) continue;

      // Get current Binance price for the asset
      const buffer = this.tickBuffers.get(bet.asset);
      if (!buffer || buffer.length === 0) continue;
      const currentPrice = buffer[buffer.length - 1].price;

      // Get the market's start price
      const market = this.upDownMarkets.get(bet.marketSlug);
      const startPrice = market?.startPrice || 0;
      if (startPrice <= 0) {
        // Can't resolve without reference — wait a bit more or use entry price
        if (now - bet.resolutionTs > 30_000) {
          // Force close as loss after 30s timeout
          const pnl = this.demoWallet.closePosition(posId, 0.001);
          this.recordClosedTrade(
            this.findPosition(posId), pnl, 0.001, "resolution_timeout"
          );
          toRemove.push(posId);
        }
        continue;
      }

      // Determine outcome: did price go up or down over the window?
      const priceWentUp = currentPrice >= startPrice;
      const betWon = (bet.side === "Up" && priceWentUp) ||
                     (bet.side === "Down" && !priceWentUp);

      // Settle: winning shares → $1.00, losing → $0.001
      const settlementPrice = betWon ? 1.0 : 0.001;
      const pos = this.findPosition(posId);
      const pnl = this.demoWallet.closePosition(posId, settlementPrice);

      if (pos) {
        this.recordClosedTrade(pos, pnl, settlementPrice,
          betWon ? "resolution_win" : "resolution_loss"
        );
      }

      const priceDelta = ((currentPrice - startPrice) / startPrice * 100).toFixed(3);
      const tag = betWon ? "WIN" : "LOSS";
      logger.info(
        `[PM ${tag}] ${bet.side} ${bet.asset} | ` +
        `PnL: $${pnl.toFixed(2)} | ` +
        `Price: ${startPrice.toFixed(2)} → ${currentPrice.toFixed(2)} (${priceDelta}%) | ` +
        `${bet.marketSlug}`
      );

      toRemove.push(posId);
    }

    for (const id of toRemove) {
      this.upDownBets.delete(id);
    }
  }

  private findPosition(posId: string): IDemoPosition | null {
    return this.demoWallet.getPositions().find((p) => p.id === posId) || null;
  }

  // ==================== UP/DOWN MARKET DISCOVERY ====================

  /**
   * Discover active Polymarket Up/Down 5m/15m markets.
   *
   * DETERMINISTIC SLUG CONSTRUCTION (from echandsome/polybot repos):
   *   5m slug:  {asset}-updown-5m-{floor(now/300)*300}
   *   15m slug: {asset}-updown-15m-{floor(now/900)*900}
   *
   * Then fetch token IDs from: GET gamma-api.polymarket.com/markets?slug={slug}
   * This is much more reliable than tag-based search which returns future markets.
   */
  private async discoverUpDownMarkets(): Promise<void> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const now = Date.now();

      // Generate candidate slugs for current + next window
      const assets = ["btc", "eth", "sol", "xrp"];
      const windows: { tf: "5m" | "15m"; period: number }[] = [
        { tf: "5m", period: 300 },
        { tf: "15m", period: 900 },
      ];

      const candidateSlugs: { slug: string; asset: string; tf: "5m" | "15m"; startSec: number }[] = [];
      for (const asset of assets) {
        for (const { tf, period } of windows) {
          // Current window
          const currentStart = Math.floor(nowSec / period) * period;
          candidateSlugs.push({ slug: `${asset}-updown-${tf}-${currentStart}`, asset: asset.toUpperCase(), tf, startSec: currentStart });
          // Previous window (might still be resolving)
          const prevStart = currentStart - period;
          candidateSlugs.push({ slug: `${asset}-updown-${tf}-${prevStart}`, asset: asset.toUpperCase(), tf, startSec: prevStart });
        }
      }

      let newCount = 0;
      const tokenEntries: { id: string; label: string }[] = [];

      // Fetch token IDs for each candidate slug (batch with Promise.allSettled)
      const fetchPromises = candidateSlugs.map(async ({ slug, asset, tf, startSec }) => {
        // Skip if already tracked and not expired
        const existing = this.upDownMarkets.get(slug);
        if (existing && existing.endTs > now) {
          // Still valid, just re-add tokens for WS
          tokenEntries.push(
            { id: existing.upTokenId, label: `${asset} Up ${tf}` },
            { id: existing.downTokenId, label: `${asset} Down ${tf}` }
          );
          return;
        }

        try {
          const resp = await axios.get(
            `https://gamma-api.polymarket.com/markets?slug=${slug}`,
            { timeout: 5000 }
          );

          const data = Array.isArray(resp.data) ? resp.data[0] : resp.data;
          if (!data) return;

          const outcomes = JSON.parse(data.outcomes || "[]");
          const tokens = JSON.parse(data.clobTokenIds || "[]");
          const prices = JSON.parse(data.outcomePrices || "[]");

          if (outcomes.length !== 2 || tokens.length !== 2) return;
          if (outcomes[0] !== "Up" || outcomes[1] !== "Down") return;

          const windowMs = tf === "5m" ? 300_000 : 900_000;
          const startTs = startSec * 1000;
          const endTs = startTs + windowMs;

          // Skip expired
          if (endTs < now) return;

          const upPrice = parseFloat(prices[0]) || 0.50;
          const downPrice = parseFloat(prices[1]) || 0.50;

          // Get Binance reference price
          let startPrice = 0;
          const buffer = this.tickBuffers.get(asset);
          if (buffer && buffer.length > 0) {
            startPrice = buffer[buffer.length - 1].price;
          }

          const market: UpDownMarket = {
            asset,
            timeframe: tf,
            slug,
            startTs,
            endTs,
            upTokenId: tokens[0],
            downTokenId: tokens[1],
            upPrice,
            downPrice,
            startPrice,
          };

          if (!this.upDownMarkets.has(slug)) newCount++;
          this.upDownMarkets.set(slug, market);

          tokenEntries.push(
            { id: tokens[0], label: `${asset} Up ${tf}` },
            { id: tokens[1], label: `${asset} Down ${tf}` }
          );
        } catch (_) {
          // Slug may not exist yet — normal for next window
        }
      });

      await Promise.allSettled(fetchPromises);

      // Update PM WS subscriptions
      this.polymarketTokens = tokenEntries;
      if (this.polymarketFeed.isConnected() && tokenEntries.length > 0) {
        const ids = tokenEntries.map((t) => t.id);
        const labels = new Map(tokenEntries.map((t) => [t.id, t.label]));
        this.polymarketFeed.addMarkets(ids, labels);
      }

      // Cleanup expired markets and old betted slugs
      for (const [slug, market] of this.upDownMarkets) {
        if (market.endTs < now - 60_000) {
          this.upDownMarkets.delete(slug);
          this.bettedSlugs.delete(slug);
        }
      }

      if (newCount > 0 || this.upDownMarkets.size > 0) {
        const assetSet = new Set([...this.upDownMarkets.values()].map((m) => m.asset));
        const nowDebug = Math.floor(Date.now() / 1000);
        const activeList = [...this.upDownMarkets.values()].map(m => {
          const tte = ((m.endTs - Date.now()) / 1000).toFixed(0);
          return `${m.slug}(${tte}s left)`;
        });
        logger.info(
          `[PM] ${this.upDownMarkets.size} markets (${newCount} new) for ${[...assetSet].join(",")} | epoch=${nowDebug} | ${activeList.join(", ")}`
        );
      }
    } catch (_err) {
      // Silently retry next cycle
    }
  }

  // ==================== 500ms TICK ====================

  private async onTick(): Promise<void> {
    if (!this.running) return;
    try {
      this.tickCount++;

      // 1. Fetch HL books in batches
      await Promise.allSettled([
        this.fetchHyperliquidBooksBatch(),
        this.fetchKalshiBooks(),
      ]);

      // 2. Equity tracking
      this.demoWallet.recordEquity();
      this.riskManager.updateEquity(this.demoWallet.getEquity());

      // 3. Update HL perp histories
      for (const [coin, book] of this.hyperliquidBooks) {
        const perpHist = this.perpHistories.get(coin);
        if (perpHist && book.midPrice > 0) {
          perpHist.push(book.midPrice, book.bids.reduce((s, l) => s + l.size, 0));
        }
      }

      // 4. Mark-to-market + manage momentum positions
      this.updatePositionPrices();
      this.managePositions();

      // 5. Check for complete-set arbitrage opportunities
      this.tryCompleteSetArb();

      // 6. Check PM positions for early exit (TP/SL/Trail) before resolution
      this.checkPmEarlyExit();

      // 7. Settle Up/Down bets that have reached resolution time
      this.settleUpDownBets();

      // 6. Cleanup stale timestamps
      const cutoff = Date.now() - 60_000;
      this.recentOrderTimestamps = this.recentOrderTimestamps.filter((t) => t > cutoff);
    } catch (_err) {
      // Never crash
    }
  }

  // ==================== POSITION MANAGEMENT ====================

  private updatePositionPrices(): void {
    for (const pos of this.demoWallet.getPositions()) {
      const meta = this.positionMeta.get(pos.id);
      // Skip PM up/down positions — their price is resolved at settlement
      if (meta?.strategy === "pm_updown") continue;

      const price = this.getCurrentMidPrice(pos.exchange, pos.symbol);
      if (price > 0) this.demoWallet.updatePositionPrice(pos.id, price);
    }
  }

  /**
   * MOMENTUM POSITION EXIT MANAGEMENT
   * Trailing stop + hard SL + time exit
   */
  private managePositions(): void {
    const positions = Array.from(this.demoWallet.getPositions());
    const now = Date.now();

    for (const pos of positions) {
      const meta = this.positionMeta.get(pos.id);
      if (!meta) continue;

      // Skip PM up/down bets — managed by settleUpDownBets()
      if (meta.strategy === "pm_updown") continue;

      const price = this.getCurrentMidPrice(pos.exchange, pos.symbol);
      if (price <= 0) continue;

      const isLong = pos.side === "LONG";
      const priceDelta = isLong ? price - pos.entryPrice : pos.entryPrice - price;

      // Check liquidation for leveraged positions
      if (pos.leverage > 1 && this.demoWallet.checkLiquidation(pos.id, price)) {
        this.recordClosedTrade(pos, -pos.size, price, "liquidation");
        continue;
      }

      // === MOMENTUM POSITIONS ===
      if (meta.strategy === "momentum") {
        // Update max/min for trailing
        if (isLong) meta.maxPrice = Math.max(meta.maxPrice, price);
        else meta.minPrice = Math.min(meta.minPrice, price);

        // Hard SL
        if (isLong && price <= meta.slPrice) {
          const pnl = this.demoWallet.closePosition(pos.id, price);
          this.riskManager.removeStopLoss(pos.id);
          this.recordClosedTrade(pos, pnl, price, "hard_sl");
          continue;
        }
        if (!isLong && price >= meta.slPrice) {
          const pnl = this.demoWallet.closePosition(pos.id, price);
          this.riskManager.removeStopLoss(pos.id);
          this.recordClosedTrade(pos, pnl, price, "hard_sl");
          continue;
        }

        // Activate trailing stop
        const profitPct = priceDelta / pos.entryPrice;
        if (profitPct >= MOM_TRAIL_ACTIVATE) {
          meta.trailActive = true;
        }

        // Trailing stop exit
        if (meta.trailActive) {
          const maxProfit = isLong
            ? meta.maxPrice - pos.entryPrice
            : pos.entryPrice - meta.minPrice;
          const currentProfit = priceDelta;
          const gaveBack = maxProfit - currentProfit;

          if (maxProfit > 0 && gaveBack > maxProfit * MOM_TRAIL_GIVEBACK) {
            const pnl = this.demoWallet.closePosition(pos.id, price);
            this.riskManager.removeStopLoss(pos.id);
            this.recordClosedTrade(pos, pnl, price, "trailing_stop");
            continue;
          }
        }

        // Time exit
        if (now - pos.openedAt > MOM_MAX_HOLD) {
          const pnl = this.demoWallet.closePosition(pos.id, price);
          this.riskManager.removeStopLoss(pos.id);
          this.recordClosedTrade(pos, pnl, price, "time_exit");
          continue;
        }
        continue;
      }

      // === FALLBACK: unknown positions ===
      if (now - pos.openedAt > 120_000) {
        const pnl = this.demoWallet.closePosition(pos.id, price);
        this.riskManager.removeStopLoss(pos.id);
        this.recordClosedTrade(pos, pnl, price, "time_exit");
      }
    }
  }

  // ==================== DATA FETCHING ====================

  private async fetchKalshiBooks(): Promise<void> {
    const tickers = this.kalshiDiscovery.getAllActiveTickers();
    await Promise.allSettled(
      tickers.slice(0, 6).map(async (ticker) => {
        const book = await this.kalshiClient.getOrderbook(ticker);
        if (book) this.kalshiBooks.set(ticker, book);
      })
    );
  }

  private hlBatchIndex = 0;

  private async fetchHyperliquidBooksBatch(): Promise<void> {
    const batchSize = 6;
    const start = this.hlBatchIndex * batchSize;
    const batch = HYPERLIQUID_COINS.slice(start, start + batchSize);
    this.hlBatchIndex = (this.hlBatchIndex + 1) % Math.ceil(HYPERLIQUID_COINS.length / batchSize);

    await Promise.allSettled(
      batch.map(async (coin) => {
        const book = await this.hyperliquidData.fetchOrderbook(coin);
        if (book) this.hyperliquidBooks.set(coin, book);
      })
    );
  }

  // ==================== TRADE RECORDING ====================

  private recordClosedTrade(
    pos: IDemoPosition | null,
    pnl: number,
    exitPrice: number,
    exitReason: string
  ): void {
    if (!pos) return;

    const meta = this.positionMeta.get(pos.id);
    const strategyName = meta?.strategy || "quant";

    const stratMap: Record<string, HFTStrategyType> = {
      momentum: "latency_arb",
      pm_updown: "spread_capture",
      quant: "microstructure",
    };

    const trade: IHFTTrade = {
      id: uuidv4(),
      strategy: stratMap[strategyName] || "microstructure",
      strategyId: `quant_${strategyName}`,
      asset: (pos.symbol.length <= 4 ? pos.symbol : "BTC") as any,
      interval: "5M" as any,
      conditionId: pos.symbol,
      direction: pos.side === "LONG" ? "YES" : "NO",
      tokenId: pos.symbol,
      side: pos.side === "LONG" ? "BUY" : "SELL",
      entryPrice: pos.entryPrice,
      size: pos.notional,
      shares: pos.entryPrice > 0 ? pos.notional / pos.entryPrice : 0,
      pnl,
      holdTimeMs: Date.now() - pos.openedAt,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
      exchange: pos.exchange,
    };

    this.perfTracker.recordTrade(trade);
    this.strategyEngine.recordCompletedTrade(pnl, strategyName as StrategyType);
    this.recentPnlWindow.push({ ts: Date.now(), pnl });
    this.positionMeta.delete(pos.id);

    // Strategy-specific tracking
    if (strategyName === "momentum") {
      this.momentumPnl += pnl;
      if (pnl > 0) this.momentumWins++;
    } else if (strategyName === "pm_updown") {
      this.pmBetPnl += pnl;
      if (pnl > 0) this.pmBetWins++;
    } else {
      this.scalpPnl += pnl;
      if (pnl > 0) this.scalpWins++;
    }

    const leverageTag = pos.leverage > 1 ? ` ${pos.leverage}x` : "";
    const tag = pnl > 0 ? "WIN" : "LOSS";
    const holdSec = ((Date.now() - pos.openedAt) / 1000).toFixed(1);

    logger.info(
      `[${tag}] ${strategyName}${leverageTag} ${pos.symbol.slice(0, 30)}@${pos.exchange} | ` +
      `PnL: $${pnl.toFixed(2)} | Exit: ${exitReason} | Hold: ${holdSec}s`
    );
  }

  // ==================== HELPERS ====================

  private getCurrentMidPrice(exchange: string, symbol: string): number {
    if (exchange === "polymarket") {
      const book = this.polymarketBooks.get(symbol);
      return book?.midPrice || 0.5;
    }
    if (exchange === "hyperliquid") {
      const book = this.hyperliquidBooks.get(symbol);
      return book?.midPrice || 0;
    }
    if (exchange === "kalshi") {
      const book = this.kalshiBooks.get(symbol);
      return book?.midPrice || 0.5;
    }
    return 0.5;
  }

  // ==================== DASHBOARD GETTERS ====================

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
    polymarketBooksCount: number;
    quantSignals: number;
    quantBlocked: number;
    quantTrades: number;
    scalpTrades: number;
    scalpWins: number;
    scalpPnl: number;
    momentumTrades: number;
    momentumWins: number;
    momentumPnl: number;
    bookImbTrades: number;
    bookImbWins: number;
    bookImbPnl: number;
    pmBetTrades: number;
    pmBetWins: number;
    pmBetPnl: number;
    binanceConnected: boolean;
    polymarketWsConnected: boolean;
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
      polymarketBooksCount: this.polymarketBooks.size,
      quantSignals: this.quantSignals,
      quantBlocked: this.quantBlocked,
      quantTrades: this.quantTrades,
      scalpTrades: this.scalpTrades,
      scalpWins: this.scalpWins,
      scalpPnl: this.scalpPnl,
      momentumTrades: this.momentumTrades,
      momentumWins: this.momentumWins,
      momentumPnl: this.momentumPnl,
      bookImbTrades: this.bookImbTrades,
      bookImbWins: this.bookImbWins,
      bookImbPnl: this.bookImbPnl,
      pmBetTrades: this.pmBetTrades,
      pmBetWins: this.pmBetWins,
      pmBetPnl: this.pmBetPnl,
      binanceConnected: this.binanceFeed.isConnected(),
      polymarketWsConnected: this.polymarketFeed.isConnected(),
    };
  }

  getAllOrderbooks(): IUnifiedOrderbook[] {
    const books: IUnifiedOrderbook[] = [];
    for (const book of this.polymarketBooks.values()) books.push(book);
    for (const book of this.hyperliquidBooks.values()) books.push(book);
    for (const book of this.kalshiBooks.values()) books.push(book);
    return books;
  }

  getConnectedExchanges(): string[] {
    const exchanges: string[] = [];
    if (this.polymarketFeed.isConnected()) exchanges.push("polymarket");
    if (this.kalshiClient.isConnected()) exchanges.push("kalshi");
    if (this.hyperliquidClient.isConnected()) exchanges.push("hyperliquid");
    if (this.binanceFeed.isConnected()) exchanges.push("binance");
    if (exchanges.length === 0) exchanges.push("polymarket");
    return exchanges;
  }

  getTicksPerSecond(): number {
    if (!this.running || this.tickCount === 0) return 0;
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    return elapsedSec > 0 ? this.tickCount / elapsedSec : 0;
  }
}
