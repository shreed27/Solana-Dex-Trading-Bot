/**
 * ============================================================================
 * JANE STREET — MARKET MAKING ENGINE
 * ============================================================================
 *
 * Profits from bid-ask spreads while managing inventory risk.
 *
 * SPREAD MODEL (Avellaneda-Stoikov, 2008):
 *   reservation_price = mid - q * γ * σ² * T
 *   optimal_spread = γ * σ² * T + (2/γ) * ln(1 + γ/κ)
 *
 *   where:
 *     q = current inventory (positive = long, negative = short)
 *     γ = risk aversion parameter
 *     σ = volatility
 *     T = time remaining
 *     κ = order arrival intensity
 *
 * INVENTORY MANAGEMENT:
 *   - Target: delta-neutral (inventory → 0)
 *   - Skew quotes toward reducing inventory
 *   - Hard limits with auto-hedge
 *
 * ADVERSE SELECTION:
 *   - VPIN (Volume-Synchronized Probability of Informed Trading)
 *   - Trade flow toxicity detection
 *   - Auto-widen when toxicity detected
 *
 * ============================================================================
 */

import { IUnifiedOrderbook, IUnifiedBookLevel } from "../../types/exchange.types";
import { mean, stddev } from "../../utils/mathUtils";
import { logger } from "../../utils/logger";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// TYPES
// ============================================================================

export interface IMarketMakingQuote {
  id: string;
  instrument: string;
  exchange: string;
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;
  spread: number;
  spreadBps: number;
  reservationPrice: number;
  inventorySkew: number;     // How much we skewed from mid
  toxicityScore: number;     // 0-1 adverse selection risk
  timestamp: number;
}

export interface IInventoryState {
  instrument: string;
  exchange: string;
  position: number;          // Signed: +long, -short
  positionValue: number;     // Absolute $ value
  entryVwap: number;         // Volume-weighted average entry
  unrealizedPnl: number;
  maxPosition: number;       // Hard limit
  utilizationPct: number;    // |position| / maxPosition
}

export interface IMMPnLDecomposition {
  totalPnl: number;
  spreadCapturePnl: number;  // From bid-ask spread
  inventoryPnl: number;      // From directional moves on held inventory
  hedgingCost: number;       // Cost of hedging trades
  rebatePnl: number;         // Maker rebates earned
  adverseSelectionCost: number; // Losses from informed flow
}

export interface IMMPerformance {
  totalTrades: number;
  spreadsCaptured: number;
  avgSpreadCaptureBps: number;
  fillRate: number;          // % of quotes that got filled
  inventoryTurnover: number; // How many times inventory cycled
  sharpeRatio: number;
  maxInventory: number;
  maxDrawdown: number;
  timeAtMaxInventory: number; // % of time at inventory limits
  vpinAlerts: number;        // Times VPIN triggered widen
}

export interface IMMConfig {
  // Spread parameters
  riskAversion: number;      // γ: higher = wider spreads, less risk
  orderArrivalRate: number;  // κ: estimated order arrival intensity
  minSpreadBps: number;      // Floor: never quote tighter than this
  maxSpreadBps: number;      // Ceiling: never quote wider than this
  baseSpreadBps: number;     // Normal conditions spread

  // Inventory parameters
  maxInventory: number;      // Hard limit ($ value)
  inventoryHalfLife: number; // Ticks to halve inventory
  hedgeThreshold: number;    // Inventory level triggering hedge

  // Size parameters
  quoteSize: number;         // $ per side
  minQuoteSize: number;      // Minimum quote size
  maxQuoteSize: number;      // Maximum quote size

  // Adverse selection
  vpinWindow: number;        // VPIN calculation window (ticks)
  vpinThreshold: number;     // VPIN level to widen spreads
  toxicWidenMultiple: number; // Multiply spread by this when toxic

  // Risk limits
  maxDailyLoss: number;      // $ daily loss limit
  maxPositionAge: number;    // Max ms to hold inventory
  autoHedgeEnabled: boolean;

  // Speed requirements
  quoteUpdateInterval: number;  // ms between quote updates
  cancelLatencyBudget: number;  // Max ms to cancel stale quotes
}

export const DEFAULT_MM_CONFIG: IMMConfig = {
  riskAversion: 0.5,
  orderArrivalRate: 2.0,
  minSpreadBps: 5,
  maxSpreadBps: 500,
  baseSpreadBps: 30,
  maxInventory: 15,
  inventoryHalfLife: 60,    // 30 seconds at 500ms ticks
  hedgeThreshold: 10,
  quoteSize: 3,
  minQuoteSize: 1,
  maxQuoteSize: 8,
  vpinWindow: 50,
  vpinThreshold: 0.7,
  toxicWidenMultiple: 2.5,
  maxDailyLoss: 5,
  maxPositionAge: 120_000,  // 2 minutes
  autoHedgeEnabled: true,
  quoteUpdateInterval: 500,
  cancelLatencyBudget: 100,
};

// ============================================================================
// VPIN (Volume-Synchronized Probability of Informed Trading)
// ============================================================================

export class VPINCalculator {
  private buyVolumes: number[] = [];
  private sellVolumes: number[] = [];
  private totalVolumes: number[] = [];
  private readonly window: number;

  constructor(window = 50) {
    this.window = window;
  }

  /**
   * Classify a trade as buy or sell using tick rule:
   * - Price > previous price → buyer-initiated
   * - Price < previous price → seller-initiated
   * - Price = previous → keep last classification
   */
  recordTrade(price: number, prevPrice: number, volume: number): void {
    const isBuy = price >= prevPrice; // Tick rule
    this.buyVolumes.push(isBuy ? volume : 0);
    this.sellVolumes.push(isBuy ? 0 : volume);
    this.totalVolumes.push(volume);

    if (this.buyVolumes.length > this.window * 2) {
      this.buyVolumes.shift();
      this.sellVolumes.shift();
      this.totalVolumes.shift();
    }
  }

  /**
   * VPIN = Σ|V_buy - V_sell| / (2 * V_total)
   *
   * Range: 0 to 1
   * High VPIN (>0.7) = informed traders active → widen spreads
   * Low VPIN (<0.3) = normal market → tighten spreads
   */
  calculate(): number {
    const n = Math.min(this.buyVolumes.length, this.window);
    if (n < 10) return 0.5; // Not enough data

    const recentBuys = this.buyVolumes.slice(-n);
    const recentSells = this.sellVolumes.slice(-n);
    const recentTotal = this.totalVolumes.slice(-n);

    let sumAbsDiff = 0;
    let sumTotal = 0;

    for (let i = 0; i < n; i++) {
      sumAbsDiff += Math.abs(recentBuys[i] - recentSells[i]);
      sumTotal += recentTotal[i];
    }

    return sumTotal > 0 ? sumAbsDiff / (2 * sumTotal) : 0.5;
  }
}

// ============================================================================
// SPREAD CALCULATOR (Avellaneda-Stoikov Model)
// ============================================================================

export class SpreadCalculator {
  /**
   * Avellaneda-Stoikov reservation price and optimal spread.
   *
   * reservation_price = mid - q * γ * σ² * T
   * optimal_spread = γ * σ² * T + (2/γ) * ln(1 + γ/κ)
   *
   * @param mid Current mid price
   * @param inventory Current inventory (signed)
   * @param volatility Recent realized volatility
   * @param gamma Risk aversion (higher = wider spreads)
   * @param kappa Order arrival intensity
   * @param timeRemaining Fraction of trading period remaining
   */
  static calculateOptimalQuotes(
    mid: number,
    inventory: number,
    volatility: number,
    gamma: number,
    kappa: number,
    timeRemaining: number
  ): { reservationPrice: number; optimalSpread: number; bidPrice: number; askPrice: number } {
    // Reservation price: where the market maker is indifferent to trading
    // Shifts away from inventory to encourage reducing it
    const reservationPrice = mid - inventory * gamma * volatility * volatility * timeRemaining;

    // Optimal spread: balances capturing spread vs. getting filled
    const optimalSpread = gamma * volatility * volatility * timeRemaining
      + (2 / gamma) * Math.log(1 + gamma / kappa);

    // Quote prices centered around reservation price
    const halfSpread = optimalSpread / 2;
    const bidPrice = reservationPrice - halfSpread;
    const askPrice = reservationPrice + halfSpread;

    return { reservationPrice, optimalSpread, bidPrice, askPrice };
  }

  /**
   * Inventory skew: adjust quotes to reduce inventory.
   *
   * When long: lower bid (discourage more buying), lower ask (encourage selling)
   * When short: raise ask (discourage selling), raise bid (encourage buying)
   *
   * Skew = α * inventory / maxInventory * mid
   * where α controls skew aggressiveness
   */
  static inventorySkew(
    inventory: number,
    maxInventory: number,
    mid: number,
    aggressiveness = 0.3
  ): number {
    if (maxInventory === 0) return 0;
    const utilization = inventory / maxInventory; // -1 to +1
    return -aggressiveness * utilization * mid * 0.01; // Skew in price units
  }
}

// ============================================================================
// MARKET MAKING ENGINE
// ============================================================================

export class MarketMakingEngine {
  private config: IMMConfig;

  // State per instrument
  private inventories: Map<string, IInventoryState> = new Map();
  private vpinCalculators: Map<string, VPINCalculator> = new Map();
  private priceHistories: Map<string, number[]> = new Map();
  private lastQuotes: Map<string, IMarketMakingQuote> = new Map();

  // Global state
  private activeQuotes: Map<string, IMarketMakingQuote> = new Map();
  private pnlHistory: number[] = [];
  private dailyPnl = 0;
  private totalTrades = 0;
  private spreadsCaptured = 0;
  private totalSpreadBps = 0;
  private vpinAlerts = 0;
  private running = false;

  // P&L decomposition
  private spreadCapturePnl = 0;
  private inventoryPnl = 0;
  private hedgingCost = 0;
  private adverseSelectionCost = 0;

  constructor(config: IMMConfig = DEFAULT_MM_CONFIG) {
    this.config = config;
  }

  // ==================== QUOTE GENERATION ====================

  /**
   * Generate optimal two-sided quotes for an instrument.
   *
   * This is the core market-making algorithm:
   * 1. Calculate Avellaneda-Stoikov optimal spread
   * 2. Apply inventory skew
   * 3. Check adverse selection (VPIN)
   * 4. Apply spread floors/ceilings
   * 5. Size quotes based on inventory and risk
   */
  generateQuotes(
    instrument: string,
    exchange: string,
    orderbook: IUnifiedOrderbook
  ): IMarketMakingQuote | null {
    if (!this.running) return null;
    if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) return null;

    const mid = orderbook.midPrice;
    if (mid <= 0) return null;

    const key = `${exchange}:${instrument}`;

    // Initialize state if needed
    if (!this.inventories.has(key)) {
      this.inventories.set(key, {
        instrument,
        exchange,
        position: 0,
        positionValue: 0,
        entryVwap: 0,
        unrealizedPnl: 0,
        maxPosition: this.config.maxInventory,
        utilizationPct: 0,
      });
      this.vpinCalculators.set(key, new VPINCalculator(this.config.vpinWindow));
      this.priceHistories.set(key, []);
    }

    const inventory = this.inventories.get(key)!;
    const vpinCalc = this.vpinCalculators.get(key)!;
    const priceHist = this.priceHistories.get(key)!;

    // Update price history
    priceHist.push(mid);
    if (priceHist.length > 500) priceHist.shift();

    // Record trade data for VPIN
    const prevPrice = priceHist.length > 1 ? priceHist[priceHist.length - 2] : mid;
    const tradeVolume = orderbook.bids[0].size + orderbook.asks[0].size;
    vpinCalc.recordTrade(mid, prevPrice, tradeVolume);

    // 1. Calculate volatility
    const vol = this.calculateVolatility(priceHist);

    // 2. Calculate VPIN (adverse selection)
    const vpin = vpinCalc.calculate();
    const isToxic = vpin > this.config.vpinThreshold;
    if (isToxic) this.vpinAlerts++;

    // 3. Avellaneda-Stoikov optimal quotes
    const normalizedInventory = inventory.position / (this.config.maxInventory || 1);
    const timeRemaining = 1.0; // Continuous market

    const { reservationPrice, optimalSpread, bidPrice: asBid, askPrice: asAsk } =
      SpreadCalculator.calculateOptimalQuotes(
        mid,
        normalizedInventory,
        vol,
        this.config.riskAversion,
        this.config.orderArrivalRate,
        timeRemaining
      );

    // 4. Apply inventory skew
    const skew = SpreadCalculator.inventorySkew(
      inventory.position,
      this.config.maxInventory,
      mid
    );

    // 5. Calculate final spread
    let spreadBps = mid > 0 ? (optimalSpread / mid) * 10000 : this.config.baseSpreadBps;

    // Apply toxicity multiplier
    if (isToxic) {
      spreadBps *= this.config.toxicWidenMultiple;
    }

    // Clamp to min/max
    spreadBps = Math.max(this.config.minSpreadBps, Math.min(this.config.maxSpreadBps, spreadBps));

    const finalSpread = mid * (spreadBps / 10000);
    const halfSpread = finalSpread / 2;

    // 6. Final quote prices (reservation price + skew)
    let bidPrice = reservationPrice - halfSpread + skew;
    let askPrice = reservationPrice + halfSpread + skew;

    // Ensure bid < ask and both positive
    if (bidPrice >= askPrice) {
      bidPrice = mid - halfSpread;
      askPrice = mid + halfSpread;
    }
    bidPrice = Math.max(0.001, bidPrice);
    askPrice = Math.max(bidPrice + 0.001, askPrice);

    // 7. Size quotes — reduce on side where inventory is building
    let bidSize = this.config.quoteSize;
    let askSize = this.config.quoteSize;

    // If long, reduce bid size (discourage more buying)
    if (inventory.position > 0) {
      const reduceRatio = 1 - Math.abs(inventory.position / this.config.maxInventory) * 0.7;
      bidSize *= Math.max(0.1, reduceRatio);
      askSize *= Math.min(2.0, 2 - reduceRatio); // Increase ask to encourage selling
    }
    // If short, reduce ask size
    else if (inventory.position < 0) {
      const reduceRatio = 1 - Math.abs(inventory.position / this.config.maxInventory) * 0.7;
      askSize *= Math.max(0.1, reduceRatio);
      bidSize *= Math.min(2.0, 2 - reduceRatio);
    }

    bidSize = Math.max(this.config.minQuoteSize, Math.min(this.config.maxQuoteSize, bidSize));
    askSize = Math.max(this.config.minQuoteSize, Math.min(this.config.maxQuoteSize, askSize));

    // 8. Check if we're at inventory limits
    if (inventory.position >= this.config.maxInventory * 0.9) {
      bidSize = 0; // Stop buying
    }
    if (inventory.position <= -this.config.maxInventory * 0.9) {
      askSize = 0; // Stop selling
    }

    // 9. Check daily loss limit
    if (this.dailyPnl <= -this.config.maxDailyLoss) {
      return null; // Stop quoting
    }

    const quote: IMarketMakingQuote = {
      id: uuidv4(),
      instrument,
      exchange,
      bidPrice: Math.round(bidPrice * 10000) / 10000,
      askPrice: Math.round(askPrice * 10000) / 10000,
      bidSize: Math.round(bidSize * 100) / 100,
      askSize: Math.round(askSize * 100) / 100,
      spread: askPrice - bidPrice,
      spreadBps,
      reservationPrice,
      inventorySkew: skew,
      toxicityScore: vpin,
      timestamp: Date.now(),
    };

    this.lastQuotes.set(key, quote);
    this.activeQuotes.set(quote.id, quote);

    return quote;
  }

  // ==================== FILL PROCESSING ====================

  /**
   * Process a fill (simulated for demo mode).
   * Updates inventory, records P&L.
   */
  processFill(
    instrument: string,
    exchange: string,
    side: "BUY" | "SELL",
    price: number,
    size: number
  ): void {
    const key = `${exchange}:${instrument}`;
    const inv = this.inventories.get(key);
    if (!inv) return;

    const signedSize = side === "BUY" ? size : -size;

    // Update inventory
    const oldPosition = inv.position;
    inv.position += signedSize;
    inv.positionValue = Math.abs(inv.position) * price;
    inv.utilizationPct = Math.abs(inv.position) / inv.maxPosition;

    // Update VWAP
    if (side === "BUY") {
      if (inv.position > 0) {
        inv.entryVwap = oldPosition > 0
          ? (inv.entryVwap * oldPosition + price * size) / (oldPosition + size)
          : price;
      }
    } else {
      if (inv.position < 0) {
        inv.entryVwap = oldPosition < 0
          ? (inv.entryVwap * Math.abs(oldPosition) + price * size) / (Math.abs(oldPosition) + size)
          : price;
      }
    }

    // P&L: if we're reducing inventory, realize P&L
    if (Math.abs(inv.position) < Math.abs(oldPosition)) {
      const pnl = side === "SELL"
        ? (price - inv.entryVwap) * size
        : (inv.entryVwap - price) * size;
      this.dailyPnl += pnl;
      this.pnlHistory.push(pnl);

      // Classify P&L source
      const lastQuote = this.lastQuotes.get(key);
      if (lastQuote) {
        // Spread capture: we filled on one side of our quote
        this.spreadCapturePnl += lastQuote.spread * size * 0.5;
        this.spreadsCaptured++;
        this.totalSpreadBps += lastQuote.spreadBps;
      }
    }

    this.totalTrades++;

    // Update unrealized P&L
    const marketPrice = price; // Use last fill as current price
    if (inv.position > 0) {
      inv.unrealizedPnl = (marketPrice - inv.entryVwap) * inv.position;
    } else if (inv.position < 0) {
      inv.unrealizedPnl = (inv.entryVwap - marketPrice) * Math.abs(inv.position);
    } else {
      inv.unrealizedPnl = 0;
    }
  }

  // ==================== HEDGING ====================

  /**
   * Determine if inventory needs hedging.
   * Returns hedge trade parameters or null.
   */
  checkHedgeNeeded(
    instrument: string,
    exchange: string
  ): { side: "BUY" | "SELL"; size: number; urgency: "normal" | "urgent" } | null {
    if (!this.config.autoHedgeEnabled) return null;

    const key = `${exchange}:${instrument}`;
    const inv = this.inventories.get(key);
    if (!inv) return null;

    const absPosition = Math.abs(inv.position);

    // Urgent hedge: at 90% of max inventory
    if (absPosition >= this.config.maxInventory * 0.9) {
      return {
        side: inv.position > 0 ? "SELL" : "BUY",
        size: absPosition * 0.5, // Hedge half
        urgency: "urgent",
      };
    }

    // Normal hedge: at hedge threshold
    if (absPosition >= this.config.hedgeThreshold) {
      const targetReduction = absPosition - this.config.hedgeThreshold * 0.5;
      return {
        side: inv.position > 0 ? "SELL" : "BUY",
        size: Math.max(0, targetReduction),
        urgency: "normal",
      };
    }

    return null;
  }

  // ==================== ADVERSE SELECTION ====================

  /**
   * Detect adverse selection: are informed traders picking off our quotes?
   *
   * Signals:
   * 1. Fills consistently on one side → informed directional flow
   * 2. Fill price moves against us quickly → toxic flow
   * 3. Large fills at our quotes → likely informed
   */
  detectAdverseSelection(instrument: string, exchange: string): {
    isAdverse: boolean;
    toxicityScore: number;
    recommendation: string;
  } {
    const key = `${exchange}:${instrument}`;
    const vpinCalc = this.vpinCalculators.get(key);
    const inv = this.inventories.get(key);

    if (!vpinCalc || !inv) {
      return { isAdverse: false, toxicityScore: 0, recommendation: "normal" };
    }

    const vpin = vpinCalc.calculate();
    const inventoryBuildup = Math.abs(inv.position) / this.config.maxInventory;

    // Adverse if: VPIN high AND inventory building on one side
    const isAdverse = vpin > this.config.vpinThreshold && inventoryBuildup > 0.5;
    const toxicityScore = vpin * 0.6 + inventoryBuildup * 0.4;

    let recommendation = "normal";
    if (toxicityScore > 0.8) {
      recommendation = "pause_quoting"; // Pull quotes entirely
    } else if (toxicityScore > 0.6) {
      recommendation = "widen_2x"; // Double the spread
    } else if (toxicityScore > 0.4) {
      recommendation = "widen_1.5x"; // 50% wider
    }

    return { isAdverse, toxicityScore, recommendation };
  }

  // ==================== P&L DECOMPOSITION ====================

  /**
   * Decompose total P&L into components:
   * - Spread capture: profit from bid-ask spread
   * - Inventory P&L: directional moves on held inventory
   * - Hedging cost: cost of reducing inventory
   * - Adverse selection: losses from informed flow
   */
  getPnLDecomposition(): IMMPnLDecomposition {
    const totalPnl = this.dailyPnl;
    return {
      totalPnl,
      spreadCapturePnl: this.spreadCapturePnl,
      inventoryPnl: this.inventoryPnl,
      hedgingCost: this.hedgingCost,
      rebatePnl: 0, // No exchange rebates in prediction markets
      adverseSelectionCost: this.adverseSelectionCost,
    };
  }

  // ==================== PERFORMANCE METRICS ====================

  getPerformance(): IMMPerformance {
    const returns = this.pnlHistory;
    const avgReturn = returns.length > 0 ? mean(returns) : 0;
    const returnStd = returns.length > 2 ? stddev(returns) : 1;

    // Sharpe ratio (annualized from per-trade returns)
    const tradesPerDay = 172800 / (this.config.quoteUpdateInterval / 500); // Rough estimate
    const sharpe = returnStd > 0 ? (avgReturn / returnStd) * Math.sqrt(tradesPerDay) : 0;

    // Max drawdown
    let maxDD = 0;
    let peak = 0;
    let cumPnl = 0;
    for (const pnl of returns) {
      cumPnl += pnl;
      peak = Math.max(peak, cumPnl);
      maxDD = Math.max(maxDD, peak - cumPnl);
    }

    // Fill rate estimate
    const fillRate = this.totalTrades > 0
      ? Math.min(1, this.totalTrades / (this.activeQuotes.size * 2 + 1))
      : 0;

    // Inventory turnover
    let totalInventoryTraded = 0;
    for (const inv of this.inventories.values()) {
      totalInventoryTraded += inv.positionValue;
    }
    const avgInventory = this.config.maxInventory / 2;
    const inventoryTurnover = avgInventory > 0 ? totalInventoryTraded / avgInventory : 0;

    return {
      totalTrades: this.totalTrades,
      spreadsCaptured: this.spreadsCaptured,
      avgSpreadCaptureBps: this.spreadsCaptured > 0 ? this.totalSpreadBps / this.spreadsCaptured : 0,
      fillRate,
      inventoryTurnover,
      sharpeRatio: sharpe,
      maxInventory: Math.max(...Array.from(this.inventories.values()).map(i => Math.abs(i.position)), 0),
      maxDrawdown: maxDD,
      timeAtMaxInventory: 0, // Would need tick-level tracking
      vpinAlerts: this.vpinAlerts,
    };
  }

  // ==================== LIFECYCLE ====================

  start(): void {
    this.running = true;
    logger.info("[MarketMaker] Engine started");
  }

  stop(): void {
    this.running = false;
    this.activeQuotes.clear();
    logger.info(`[MarketMaker] Engine stopped | Trades: ${this.totalTrades} | P&L: $${this.dailyPnl.toFixed(4)}`);
  }

  isRunning(): boolean {
    return this.running;
  }

  getInventory(exchange: string, instrument: string): IInventoryState | undefined {
    return this.inventories.get(`${exchange}:${instrument}`);
  }

  getAllInventories(): IInventoryState[] {
    return Array.from(this.inventories.values());
  }

  getDailyPnl(): number {
    return this.dailyPnl;
  }

  // ==================== HELPERS ====================

  private calculateVolatility(prices: number[]): number {
    if (prices.length < 10) return 0.01;
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    return returns.length > 2 ? stddev(returns) : 0.01;
  }

  resetDaily(): void {
    this.dailyPnl = 0;
    this.spreadCapturePnl = 0;
    this.inventoryPnl = 0;
    this.hedgingCost = 0;
    this.adverseSelectionCost = 0;
    this.pnlHistory = [];
    this.totalTrades = 0;
    this.spreadsCaptured = 0;
    this.totalSpreadBps = 0;
    this.vpinAlerts = 0;
  }
}
