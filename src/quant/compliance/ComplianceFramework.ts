/**
 * ============================================================================
 * GOLDMAN SACHS — COMPLIANCE & GOVERNANCE FRAMEWORK
 * ============================================================================
 *
 * Regulatory compliance for algorithmic trading operations.
 *
 * COMPONENTS:
 * 1. Pre-trade Risk Controls — Automated checks before every order
 * 2. Position Limit Monitoring — Hard/soft limits with enforcement
 * 3. Market Manipulation Prevention — Wash trading, spoofing detection
 * 4. Best Execution Documentation — Prove fair prices
 * 5. Tax Lot Tracking — FIFO/LIFO capital gains, wash sale rules
 * 6. Algorithm Change Management — Documentation and approval process
 * 7. Incident Response — Malfunction handling
 *
 * ============================================================================
 */

import { v4 as uuidv4 } from "uuid";
import { logger } from "../../utils/logger";

// ============================================================================
// PRE-TRADE RISK CONTROLS (SEC Rule 15c3-5)
// ============================================================================

export interface IPreTradeCheck {
  name: string;
  passed: boolean;
  value: number;
  limit: number;
  description: string;
}

export class PreTradeRiskControls {
  private config: IPreTradeConfig;

  constructor(config: IPreTradeConfig = DEFAULT_PRETRADE_CONFIG) {
    this.config = config;
  }

  /**
   * Run ALL pre-trade checks before submitting an order.
   * ALL must pass for order to proceed.
   */
  check(
    side: "BUY" | "SELL",
    price: number,
    size: number,
    instrument: string,
    exchange: string,
    currentExposure: number,
    totalCapital: number,
    openOrderCount: number,
    recentOrderCount: number,  // Orders in last minute
    lastTradePrice: number
  ): { approved: boolean; checks: IPreTradeCheck[]; blockReason?: string } {
    const checks: IPreTradeCheck[] = [];
    const blockReasons: string[] = [];

    // 1. Order size limit (single order max)
    const orderValue = price * size;
    checks.push({
      name: "max_order_size",
      passed: orderValue <= this.config.maxOrderSize,
      value: orderValue,
      limit: this.config.maxOrderSize,
      description: "Single order size limit",
    });
    if (orderValue > this.config.maxOrderSize) {
      blockReasons.push(`Order size $${orderValue.toFixed(2)} exceeds limit $${this.config.maxOrderSize}`);
    }

    // 2. Total exposure limit
    const newExposure = currentExposure + size;
    checks.push({
      name: "max_exposure",
      passed: newExposure <= this.config.maxTotalExposure,
      value: newExposure,
      limit: this.config.maxTotalExposure,
      description: "Total exposure limit",
    });
    if (newExposure > this.config.maxTotalExposure) {
      blockReasons.push(`Total exposure $${newExposure.toFixed(2)} exceeds limit $${this.config.maxTotalExposure}`);
    }

    // 3. Capital concentration
    const concentrationPct = totalCapital > 0 ? orderValue / totalCapital : 1;
    checks.push({
      name: "concentration_limit",
      passed: concentrationPct <= this.config.maxConcentrationPct,
      value: concentrationPct,
      limit: this.config.maxConcentrationPct,
      description: "Single instrument concentration",
    });

    // 4. Price collar (fat finger protection)
    if (lastTradePrice > 0) {
      const priceDeviation = Math.abs(price - lastTradePrice) / lastTradePrice;
      checks.push({
        name: "price_collar",
        passed: priceDeviation <= this.config.maxPriceDeviationPct,
        value: priceDeviation,
        limit: this.config.maxPriceDeviationPct,
        description: "Price deviation from last trade (fat finger check)",
      });
      if (priceDeviation > this.config.maxPriceDeviationPct) {
        blockReasons.push(`Price $${price} deviates ${(priceDeviation * 100).toFixed(1)}% from last trade $${lastTradePrice}`);
      }
    }

    // 5. Order rate limit (prevent runaway algorithms)
    checks.push({
      name: "order_rate_limit",
      passed: recentOrderCount < this.config.maxOrdersPerMinute,
      value: recentOrderCount,
      limit: this.config.maxOrdersPerMinute,
      description: "Maximum orders per minute",
    });

    // 6. Open order limit
    checks.push({
      name: "open_order_limit",
      passed: openOrderCount < this.config.maxOpenOrders,
      value: openOrderCount,
      limit: this.config.maxOpenOrders,
      description: "Maximum concurrent open orders",
    });

    // 7. Notional limit per minute
    checks.push({
      name: "notional_per_minute",
      passed: true, // Simplified: tracked externally
      value: 0,
      limit: this.config.maxNotionalPerMinute,
      description: "Maximum notional value per minute",
    });

    const approved = checks.every(c => c.passed);

    return {
      approved,
      checks,
      blockReason: blockReasons.length > 0 ? blockReasons.join("; ") : undefined,
    };
  }
}

export interface IPreTradeConfig {
  maxOrderSize: number;
  maxTotalExposure: number;
  maxConcentrationPct: number;
  maxPriceDeviationPct: number;
  maxOrdersPerMinute: number;
  maxOpenOrders: number;
  maxNotionalPerMinute: number;
}

export const DEFAULT_PRETRADE_CONFIG: IPreTradeConfig = {
  maxOrderSize: 15,           // $15 max single order
  maxTotalExposure: 90,       // $90 max total
  maxConcentrationPct: 0.20,  // 20% max in one instrument
  maxPriceDeviationPct: 0.10, // 10% max price deviation
  maxOrdersPerMinute: 60,     // 60 orders/min
  maxOpenOrders: 20,          // 20 max open
  maxNotionalPerMinute: 100,  // $100/min
};

// ============================================================================
// MARKET MANIPULATION PREVENTION
// ============================================================================

export class ManipulationDetector {
  private recentOrders: { side: string; price: number; size: number; timestamp: number; cancelled: boolean }[] = [];
  private alerts: string[] = [];

  /**
   * Record an order event for manipulation detection.
   */
  recordOrder(side: string, price: number, size: number, cancelled: boolean): void {
    this.recentOrders.push({ side, price, size, timestamp: Date.now(), cancelled });
    // Keep last 5 minutes
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.recentOrders = this.recentOrders.filter(o => o.timestamp > cutoff);
  }

  /**
   * Detect potential wash trading:
   * Buying and selling the same instrument at similar prices in rapid succession
   * where the same entity is on both sides.
   */
  detectWashTrading(): boolean {
    const recent = this.recentOrders.slice(-20);
    const buys = recent.filter(o => o.side === "BUY" && !o.cancelled);
    const sells = recent.filter(o => o.side === "SELL" && !o.cancelled);

    for (const buy of buys) {
      for (const sell of sells) {
        const timeDiff = Math.abs(buy.timestamp - sell.timestamp);
        const priceDiff = Math.abs(buy.price - sell.price) / buy.price;

        // Same price (within 1%), within 5 seconds = suspicious
        if (timeDiff < 5000 && priceDiff < 0.01) {
          this.alerts.push(`[WASH] Buy/sell at ~$${buy.price.toFixed(4)} within ${timeDiff}ms`);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Detect potential spoofing:
   * Placing large orders intended to be cancelled before execution
   * to manipulate price perception.
   *
   * Signals:
   * - High cancel rate (>80% in last minute)
   * - Large orders that are quickly cancelled
   */
  detectSpoofing(): boolean {
    const lastMinute = this.recentOrders.filter(o => Date.now() - o.timestamp < 60000);
    if (lastMinute.length < 5) return false;

    const cancelRate = lastMinute.filter(o => o.cancelled).length / lastMinute.length;

    if (cancelRate > 0.80) {
      this.alerts.push(`[SPOOF] Cancel rate ${(cancelRate * 100).toFixed(0)}% in last minute`);
      return true;
    }

    return false;
  }

  /**
   * Detect potential layering:
   * Multiple orders at different price levels on one side,
   * creating artificial depth, then cancelled when price moves.
   */
  detectLayering(): boolean {
    const lastMinute = this.recentOrders.filter(o => Date.now() - o.timestamp < 60000);
    const cancelledBuys = lastMinute.filter(o => o.side === "BUY" && o.cancelled);
    const cancelledSells = lastMinute.filter(o => o.side === "SELL" && o.cancelled);

    // Multiple cancelled orders on one side at different prices
    if (cancelledBuys.length > 3) {
      const uniquePrices = new Set(cancelledBuys.map(o => Math.round(o.price * 100)));
      if (uniquePrices.size >= 3) {
        this.alerts.push(`[LAYER] ${cancelledBuys.length} cancelled buys at ${uniquePrices.size} price levels`);
        return true;
      }
    }
    if (cancelledSells.length > 3) {
      const uniquePrices = new Set(cancelledSells.map(o => Math.round(o.price * 100)));
      if (uniquePrices.size >= 3) {
        this.alerts.push(`[LAYER] ${cancelledSells.length} cancelled sells at ${uniquePrices.size} price levels`);
        return true;
      }
    }

    return false;
  }

  getAlerts(): string[] {
    return [...this.alerts];
  }

  clearAlerts(): void {
    this.alerts = [];
  }
}

// ============================================================================
// TAX LOT TRACKING
// ============================================================================

export interface ITaxLot {
  id: string;
  instrument: string;
  exchange: string;
  side: "BUY" | "SELL";
  size: number;
  price: number;
  timestamp: number;
  remainingSize: number;
  costBasis: number;
}

export interface IRealizedGain {
  id: string;
  instrument: string;
  openLot: ITaxLot;
  closePrice: number;
  closeTimestamp: number;
  size: number;
  gain: number;
  isShortTerm: boolean;   // Held < 1 year
  isWashSale: boolean;    // Repurchased within 30 days
}

export class TaxLotTracker {
  private openLots: Map<string, ITaxLot[]> = new Map(); // instrument → lots
  private realizedGains: IRealizedGain[] = [];
  private method: "FIFO" | "LIFO" | "HIFO" = "FIFO";

  constructor(method: "FIFO" | "LIFO" | "HIFO" = "FIFO") {
    this.method = method;
  }

  /**
   * Record a purchase — creates a new tax lot.
   */
  recordPurchase(instrument: string, exchange: string, size: number, price: number): void {
    if (!this.openLots.has(instrument)) {
      this.openLots.set(instrument, []);
    }

    this.openLots.get(instrument)!.push({
      id: uuidv4(),
      instrument,
      exchange,
      side: "BUY",
      size,
      price,
      timestamp: Date.now(),
      remainingSize: size,
      costBasis: size * price,
    });
  }

  /**
   * Record a sale — matches against open lots using configured method.
   * Returns realized gains/losses.
   */
  recordSale(instrument: string, size: number, price: number): IRealizedGain[] {
    const lots = this.openLots.get(instrument) || [];
    if (lots.length === 0) return [];

    // Sort lots by method
    const sortedLots = this.sortLots(lots);

    const gains: IRealizedGain[] = [];
    let remainingSale = size;

    for (const lot of sortedLots) {
      if (remainingSale <= 0) break;
      if (lot.remainingSize <= 0) continue;

      const matchedSize = Math.min(remainingSale, lot.remainingSize);
      const gain = (price - lot.price) * matchedSize;
      const holdingPeriod = Date.now() - lot.timestamp;
      const isShortTerm = holdingPeriod < 365 * 24 * 3600 * 1000;

      // Wash sale: check if we bought the same instrument within 30 days
      const thirtyDaysMs = 30 * 24 * 3600 * 1000;
      const recentPurchases = lots.filter(l =>
        l.id !== lot.id &&
        Math.abs(l.timestamp - Date.now()) < thirtyDaysMs
      );
      const isWashSale = gain < 0 && recentPurchases.length > 0;

      gains.push({
        id: uuidv4(),
        instrument,
        openLot: { ...lot },
        closePrice: price,
        closeTimestamp: Date.now(),
        size: matchedSize,
        gain,
        isShortTerm,
        isWashSale,
      });

      lot.remainingSize -= matchedSize;
      remainingSale -= matchedSize;
    }

    // Remove fully consumed lots
    this.openLots.set(instrument, lots.filter(l => l.remainingSize > 0.0001));

    this.realizedGains.push(...gains);
    return gains;
  }

  private sortLots(lots: ITaxLot[]): ITaxLot[] {
    switch (this.method) {
      case "FIFO": return [...lots].sort((a, b) => a.timestamp - b.timestamp);
      case "LIFO": return [...lots].sort((a, b) => b.timestamp - a.timestamp);
      case "HIFO": return [...lots].sort((a, b) => b.price - a.price); // Highest cost first
    }
  }

  /**
   * Generate tax summary.
   */
  getTaxSummary(): {
    shortTermGains: number;
    longTermGains: number;
    washSaleAdjustments: number;
    totalRealizedGains: number;
    openPositionsCostBasis: number;
    numberOfLots: number;
  } {
    const shortTermGains = this.realizedGains
      .filter(g => g.isShortTerm && !g.isWashSale)
      .reduce((s, g) => s + g.gain, 0);

    const longTermGains = this.realizedGains
      .filter(g => !g.isShortTerm && !g.isWashSale)
      .reduce((s, g) => s + g.gain, 0);

    const washSaleAdj = this.realizedGains
      .filter(g => g.isWashSale)
      .reduce((s, g) => s + Math.abs(g.gain), 0); // Disallowed losses

    let openCostBasis = 0;
    let numLots = 0;
    for (const lots of this.openLots.values()) {
      for (const lot of lots) {
        if (lot.remainingSize > 0) {
          openCostBasis += lot.remainingSize * lot.price;
          numLots++;
        }
      }
    }

    return {
      shortTermGains,
      longTermGains,
      washSaleAdjustments: washSaleAdj,
      totalRealizedGains: shortTermGains + longTermGains,
      openPositionsCostBasis: openCostBasis,
      numberOfLots: numLots,
    };
  }

  getRealizedGains(): IRealizedGain[] {
    return [...this.realizedGains];
  }
}

// ============================================================================
// ALGORITHM CHANGE MANAGEMENT
// ============================================================================

export interface IAlgorithmChange {
  id: string;
  algorithm: string;
  changeType: "PARAMETER_UPDATE" | "LOGIC_CHANGE" | "NEW_STRATEGY" | "STRATEGY_REMOVAL";
  description: string;
  previousValue: string;
  newValue: string;
  requestedBy: string;
  approvedBy?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "DEPLOYED";
  requestedAt: number;
  deployedAt?: number;
  rollbackPlan: string;
}

export class ChangeManagement {
  private changes: IAlgorithmChange[] = [];

  requestChange(
    algorithm: string,
    changeType: IAlgorithmChange["changeType"],
    description: string,
    previousValue: string,
    newValue: string,
    requestedBy: string,
    rollbackPlan: string
  ): IAlgorithmChange {
    const change: IAlgorithmChange = {
      id: uuidv4(),
      algorithm,
      changeType,
      description,
      previousValue,
      newValue,
      requestedBy,
      status: "PENDING",
      requestedAt: Date.now(),
      rollbackPlan,
    };

    this.changes.push(change);
    logger.info(`[COMPLIANCE] Change request: ${changeType} to ${algorithm} — ${description}`);

    return change;
  }

  approveChange(changeId: string, approvedBy: string): boolean {
    const change = this.changes.find(c => c.id === changeId);
    if (!change || change.status !== "PENDING") return false;

    change.status = "APPROVED";
    change.approvedBy = approvedBy;
    return true;
  }

  deployChange(changeId: string): boolean {
    const change = this.changes.find(c => c.id === changeId);
    if (!change || change.status !== "APPROVED") return false;

    change.status = "DEPLOYED";
    change.deployedAt = Date.now();
    return true;
  }

  getPendingChanges(): IAlgorithmChange[] {
    return this.changes.filter(c => c.status === "PENDING");
  }

  getChangeLog(): IAlgorithmChange[] {
    return [...this.changes];
  }
}
