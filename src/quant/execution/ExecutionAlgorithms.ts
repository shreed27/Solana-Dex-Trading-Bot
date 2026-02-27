/**
 * ============================================================================
 * VIRTU FINANCIAL — EXECUTION ALGORITHMS
 * ============================================================================
 *
 * Smart order routing and execution algorithms that minimize market impact
 * and slippage for institutional-sized orders.
 *
 * ALGORITHMS:
 * 1. TWAP — Time-Weighted Average Price
 * 2. VWAP — Volume-Weighted Average Price
 * 3. Implementation Shortfall — Balance urgency vs. impact
 * 4. Iceberg — Hide true order size
 * 5. Smart Order Router — Choose best venue
 *
 * ANALYTICS:
 * - Slippage measurement
 * - Market impact model (Almgren-Chriss)
 * - Pre-trade cost estimation
 * - Post-trade TCA (Transaction Cost Analysis)
 *
 * ============================================================================
 */

import { IUnifiedOrderbook } from "../../types/exchange.types";
import { mean, stddev } from "../../utils/mathUtils";
import { logger } from "../../utils/logger";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// TYPES
// ============================================================================

export interface IExecutionOrder {
  id: string;
  parentOrderId: string;
  instrument: string;
  exchange: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  type: "LIMIT" | "MARKET" | "ICEBERG";
  algorithm: ExecutionAlgorithm;
  status: "PENDING" | "PARTIAL" | "FILLED" | "CANCELLED";
  filledSize: number;
  filledAvgPrice: number;
  createdAt: number;
  updatedAt: number;
  slicedOrders: IChildOrder[];
}

export interface IChildOrder {
  id: string;
  size: number;
  price: number;
  scheduledTime: number;
  executedTime?: number;
  executedPrice?: number;
  executedSize?: number;
  status: "PENDING" | "SENT" | "FILLED" | "CANCELLED";
}

export type ExecutionAlgorithm = "TWAP" | "VWAP" | "IS" | "ICEBERG" | "SMART";

export interface ITWAPParams {
  totalSize: number;
  duration: number;        // Total duration in ms
  numSlices: number;       // Number of child orders
  randomize: boolean;      // Add random jitter to timing
  maxSlippage: number;     // Max acceptable slippage in bps
}

export interface IVWAPParams {
  totalSize: number;
  duration: number;
  volumeProfile: number[]; // Relative volume per bucket (sums to 1)
  numBuckets: number;
  participationRate: number; // Max % of volume to consume (0.05 = 5%)
}

export interface IISParams {
  totalSize: number;
  urgency: number;         // 0 = passive, 1 = aggressive
  riskAversion: number;
  volatility: number;
  adv: number;             // Average daily volume
}

export interface IIcebergParams {
  totalSize: number;
  displaySize: number;     // Visible portion
  priceLimit: number;
  refillDelay: number;     // ms between refills
}

export interface ISlippageReport {
  orderId: string;
  signalPrice: number;     // Price when signal generated
  decisionPrice: number;   // Price when order decided
  arrivalPrice: number;    // Price when first slice hits market
  executionVwap: number;   // Volume-weighted avg fill price
  lastPrice: number;       // Price when order completed
  totalSlippageBps: number;
  timingCostBps: number;   // Decision → arrival delay cost
  impactCostBps: number;   // Our order moving the price
  spreadCostBps: number;   // Bid-ask crossing cost
  opportunityCostBps: number; // Unfilled portion cost
}

export interface IMarketImpactEstimate {
  temporaryImpact: number;  // Price impact during execution (reverts)
  permanentImpact: number;  // Price impact that persists
  totalImpactBps: number;
  estimatedCost: number;    // $ cost
  optimalDuration: number;  // ms — optimal execution time
}

export interface IPreTradeCostEstimate {
  spreadCost: number;
  impactCost: number;
  timingRisk: number;
  totalEstimatedCost: number;
  totalEstimatedCostBps: number;
  confidence: number;
  recommendation: ExecutionAlgorithm;
}

export interface IPostTradeTCA {
  orderId: string;
  instrument: string;
  side: string;
  totalSize: number;
  totalCost: number;
  vwap: number;
  arrivalPrice: number;
  implementationShortfall: number;
  implementationShortfallBps: number;
  components: {
    delayComponent: number;      // Cost of waiting to trade
    tradingImpact: number;       // Market impact of our trading
    timingComponent: number;     // Cost from unfavorable price moves
    spreadComponent: number;     // Bid-ask spread cost
    commissionComponent: number; // Transaction fees
  };
  benchmarkComparison: {
    vsVwap: number;              // Performance vs VWAP
    vsTwap: number;              // Performance vs TWAP
    vsArrival: number;           // Performance vs arrival price
    vsClose: number;             // Performance vs close price
  };
  executionQualityScore: number; // 0-100
}

// ============================================================================
// TWAP — TIME-WEIGHTED AVERAGE PRICE
// ============================================================================

/**
 * TWAP splits a large order evenly across a time window.
 *
 * Algorithm:
 * 1. Divide total size by number of slices
 * 2. Space slices evenly across duration
 * 3. Add random jitter (±10% of interval) to avoid detection
 * 4. Execute each slice as a limit order at mid ± buffer
 *
 * Optimal for: Low-urgency orders in liquid markets
 * Weakness: Does not adapt to volume patterns
 */
export class TWAPExecutor {
  /**
   * Generate TWAP child order schedule.
   */
  static generateSchedule(
    instrument: string,
    exchange: string,
    side: "BUY" | "SELL",
    params: ITWAPParams,
    currentMid: number
  ): IExecutionOrder {
    const parentId = uuidv4();
    const sliceSize = params.totalSize / params.numSlices;
    const intervalMs = params.duration / params.numSlices;

    const children: IChildOrder[] = [];
    const now = Date.now();

    for (let i = 0; i < params.numSlices; i++) {
      // Base time for this slice
      let scheduledTime = now + i * intervalMs;

      // Add random jitter ±10% of interval
      if (params.randomize) {
        const jitter = (Math.random() - 0.5) * intervalMs * 0.2;
        scheduledTime += jitter;
      }

      // Price: mid ± buffer (trade at slightly better than mid)
      const buffer = currentMid * (params.maxSlippage / 10000);
      const price = side === "BUY"
        ? currentMid + buffer * 0.5  // Willing to pay slightly above mid
        : currentMid - buffer * 0.5; // Willing to sell slightly below mid

      children.push({
        id: uuidv4(),
        size: Math.round(sliceSize * 100) / 100,
        price: Math.round(price * 10000) / 10000,
        scheduledTime: Math.round(scheduledTime),
        status: "PENDING",
      });
    }

    return {
      id: parentId,
      parentOrderId: parentId,
      instrument,
      exchange,
      side,
      price: currentMid,
      size: params.totalSize,
      type: "LIMIT",
      algorithm: "TWAP",
      status: "PENDING",
      filledSize: 0,
      filledAvgPrice: 0,
      createdAt: now,
      updatedAt: now,
      slicedOrders: children,
    };
  }

  /**
   * Execution quality: compare fill VWAP to theoretical TWAP.
   */
  static measureQuality(order: IExecutionOrder, twapBenchmark: number): number {
    if (order.filledSize === 0 || twapBenchmark === 0) return 0;
    const slippageBps = ((order.filledAvgPrice - twapBenchmark) / twapBenchmark) * 10000;
    // Score: 100 = perfect, lower = worse. Penalize slippage.
    return Math.max(0, 100 - Math.abs(slippageBps));
  }
}

// ============================================================================
// VWAP — VOLUME-WEIGHTED AVERAGE PRICE
// ============================================================================

/**
 * VWAP executes proportional to historical volume patterns.
 *
 * Algorithm:
 * 1. Divide trading period into buckets
 * 2. Assign volume percentage to each bucket (from historical data)
 * 3. Execute proportional to expected volume in each bucket
 * 4. Cap participation rate to avoid excessive impact
 *
 * For crypto/prediction markets, volume profile is more uniform,
 * so we use a slightly modified approach based on recent volume patterns.
 */
export class VWAPExecutor {
  /**
   * Generate VWAP execution schedule.
   *
   * @param volumeProfile Relative volume per bucket. If not provided,
   *   generates a default U-shaped profile (higher at open/close).
   */
  static generateSchedule(
    instrument: string,
    exchange: string,
    side: "BUY" | "SELL",
    params: IVWAPParams,
    currentMid: number
  ): IExecutionOrder {
    const parentId = uuidv4();
    const now = Date.now();
    const bucketDuration = params.duration / params.numBuckets;

    // Default volume profile: slightly U-shaped for crypto
    let profile = params.volumeProfile;
    if (!profile || profile.length !== params.numBuckets) {
      profile = this.generateDefaultProfile(params.numBuckets);
    }

    // Normalize profile to sum to 1
    const profileSum = profile.reduce((s, v) => s + v, 0);
    profile = profile.map(v => v / profileSum);

    const children: IChildOrder[] = [];

    for (let i = 0; i < params.numBuckets; i++) {
      const bucketSize = params.totalSize * profile[i];

      // Cap at participation rate
      const maxBucketSize = params.totalSize * params.participationRate;
      const adjustedSize = Math.min(bucketSize, maxBucketSize);

      if (adjustedSize < 0.10) continue; // Skip tiny slices

      const scheduledTime = now + i * bucketDuration + bucketDuration * 0.5;
      const buffer = currentMid * 0.001; // 10 bps buffer
      const price = side === "BUY" ? currentMid + buffer : currentMid - buffer;

      children.push({
        id: uuidv4(),
        size: Math.round(adjustedSize * 100) / 100,
        price: Math.round(price * 10000) / 10000,
        scheduledTime: Math.round(scheduledTime),
        status: "PENDING",
      });
    }

    return {
      id: parentId,
      parentOrderId: parentId,
      instrument,
      exchange,
      side,
      price: currentMid,
      size: params.totalSize,
      type: "LIMIT",
      algorithm: "VWAP",
      status: "PENDING",
      filledSize: 0,
      filledAvgPrice: 0,
      createdAt: now,
      updatedAt: now,
      slicedOrders: children,
    };
  }

  /**
   * Generate default U-shaped volume profile.
   * Higher volume at start and end, lower in middle.
   */
  private static generateDefaultProfile(numBuckets: number): number[] {
    const profile: number[] = [];
    for (let i = 0; i < numBuckets; i++) {
      const x = i / (numBuckets - 1); // 0 to 1
      // U-shape: higher at edges
      const value = 0.5 + 0.5 * Math.cos(Math.PI * (2 * x - 1));
      profile.push(Math.max(0.3, value));
    }
    return profile;
  }
}

// ============================================================================
// IMPLEMENTATION SHORTFALL OPTIMIZER
// ============================================================================

/**
 * Almgren-Chriss Implementation Shortfall Model
 *
 * Balances urgency (opportunity cost of not trading) against
 * market impact (cost of trading aggressively).
 *
 * Total cost = opportunity_cost + market_impact_cost
 *
 * Optimal trajectory minimizes:
 *   E[cost] + λ * Var[cost]
 *
 * where λ = risk aversion parameter
 *
 * For high urgency: execute quickly, accept higher impact
 * For low urgency: execute slowly, minimize impact
 */
export class ImplementationShortfallOptimizer {
  /**
   * Almgren-Chriss market impact model:
   *
   * Temporary impact: η * |v|    (linear in trade rate)
   * Permanent impact: γ * |v|    (linear in trade rate)
   *
   * where v = trade rate (shares/time), η = temporary impact coefficient,
   * γ = permanent impact coefficient
   *
   * Optimal execution trajectory:
   *   n_j = n_0 * sinh(κ * (T-j)) / sinh(κ * T)
   *
   * where κ = √(λ * σ² / η) and T = total time
   */
  static calculateOptimalTrajectory(params: IISParams): {
    schedule: { time: number; size: number; cumSize: number }[];
    optimalDuration: number;
    expectedCost: number;
    costVariance: number;
  } {
    // Market impact parameters (estimated from volatility and ADV)
    const eta = 0.001 * params.volatility * Math.sqrt(params.adv || 1000); // Temporary impact
    const gamma = eta * 0.5; // Permanent impact (typically half of temporary)

    // Optimal execution time based on urgency
    // Higher urgency = shorter execution time
    const baseTimeMs = 60_000; // 1 minute base
    const optimalDuration = baseTimeMs * (1 - params.urgency * 0.8);

    // Number of time steps
    const numSteps = Math.max(5, Math.ceil(optimalDuration / 5000)); // Every 5 seconds
    const dt = optimalDuration / numSteps;

    // Kappa: balance between risk and impact
    const sigma = params.volatility;
    const kappa = Math.sqrt(params.riskAversion * sigma * sigma / (eta + 0.0001));

    // Generate optimal trajectory using sinh formula
    const T = numSteps;
    const schedule: { time: number; size: number; cumSize: number }[] = [];
    let remaining = params.totalSize;
    let cumSize = 0;

    for (let j = 0; j < numSteps; j++) {
      // Almgren-Chriss optimal schedule
      let fraction: number;
      const sinhKT = Math.sinh(kappa * T);
      if (Math.abs(sinhKT) > 0.0001) {
        fraction = Math.sinh(kappa * (T - j)) / sinhKT;
      } else {
        fraction = (T - j) / T; // Linear fallback
      }

      const stepSize = params.totalSize * Math.max(0, fraction - (j > 0 ?
        Math.sinh(kappa * (T - j + 1)) / (sinhKT || 1) : 1));

      const adjustedSize = Math.min(Math.abs(stepSize), remaining);
      cumSize += adjustedSize;
      remaining -= adjustedSize;

      schedule.push({
        time: j * dt,
        size: Math.round(adjustedSize * 100) / 100,
        cumSize: Math.round(cumSize * 100) / 100,
      });
    }

    // If remaining due to rounding, add to last slice
    if (remaining > 0.01 && schedule.length > 0) {
      schedule[schedule.length - 1].size += remaining;
      schedule[schedule.length - 1].cumSize += remaining;
    }

    // Expected cost: temporary impact * total size + permanent impact * total size
    const avgTradeRate = params.totalSize / (optimalDuration / 1000);
    const expectedCost = eta * avgTradeRate * params.totalSize + gamma * params.totalSize;
    const costVariance = sigma * sigma * params.totalSize * params.totalSize * optimalDuration / 1000;

    return { schedule, optimalDuration, expectedCost, costVariance };
  }
}

// ============================================================================
// ICEBERG ORDER
// ============================================================================

/**
 * Iceberg orders show only a small portion of the total order
 * to hide the true size from other market participants.
 *
 * Algorithm:
 * 1. Place visible "display" order at limit price
 * 2. When display portion fills, wait refillDelay
 * 3. Replace with another display-sized slice
 * 4. Repeat until total order is filled
 * 5. Add random size variation to avoid detection
 */
export class IcebergExecutor {
  static generateSchedule(
    instrument: string,
    exchange: string,
    side: "BUY" | "SELL",
    params: IIcebergParams
  ): IExecutionOrder {
    const parentId = uuidv4();
    const now = Date.now();

    const numSlices = Math.ceil(params.totalSize / params.displaySize);
    const children: IChildOrder[] = [];

    let remainingSize = params.totalSize;

    for (let i = 0; i < numSlices; i++) {
      // Random size variation: ±20% of display size
      const variation = 1 + (Math.random() - 0.5) * 0.4;
      const sliceSize = Math.min(
        params.displaySize * variation,
        remainingSize
      );
      remainingSize -= sliceSize;

      children.push({
        id: uuidv4(),
        size: Math.round(sliceSize * 100) / 100,
        price: params.priceLimit,
        scheduledTime: now + i * params.refillDelay,
        status: "PENDING",
      });

      if (remainingSize <= 0) break;
    }

    return {
      id: parentId,
      parentOrderId: parentId,
      instrument,
      exchange,
      side,
      price: params.priceLimit,
      size: params.totalSize,
      type: "ICEBERG",
      algorithm: "ICEBERG",
      status: "PENDING",
      filledSize: 0,
      filledAvgPrice: 0,
      createdAt: now,
      updatedAt: now,
      slicedOrders: children,
    };
  }
}

// ============================================================================
// SMART ORDER ROUTER
// ============================================================================

/**
 * Routes orders to the best execution venue based on:
 * - Price (best bid/ask across venues)
 * - Liquidity (depth at best level)
 * - Fees (maker/taker fee differences)
 * - Latency (speed of execution)
 * - Fill probability (historical fill rates)
 */
export class SmartOrderRouter {
  private venueStats: Map<string, {
    avgFillRate: number;
    avgSlippageBps: number;
    avgLatencyMs: number;
    makerFeeBps: number;
    takerFeeBps: number;
    fillCount: number;
  }> = new Map();

  /**
   * Score each venue and return ranked list.
   *
   * Score = w1*price_score + w2*liquidity_score + w3*fee_score + w4*speed_score
   */
  routeOrder(
    side: "BUY" | "SELL",
    size: number,
    venues: { exchange: string; orderbook: IUnifiedOrderbook }[]
  ): { exchange: string; score: number; reasons: string[] }[] {
    const results: { exchange: string; score: number; reasons: string[] }[] = [];

    for (const venue of venues) {
      const book = venue.orderbook;
      const reasons: string[] = [];
      let score = 0;

      // 1. Price score (0-40 points): best execution price
      const bestPrice = side === "BUY"
        ? book.asks[0]?.price || Infinity
        : book.bids[0]?.price || 0;

      const allBestPrices = venues.map(v =>
        side === "BUY" ? v.orderbook.asks[0]?.price || Infinity : v.orderbook.bids[0]?.price || 0
      );

      const idealPrice = side === "BUY" ? Math.min(...allBestPrices) : Math.max(...allBestPrices);
      const priceDeviation = idealPrice > 0 ? Math.abs(bestPrice - idealPrice) / idealPrice : 0;
      const priceScore = Math.max(0, 40 * (1 - priceDeviation * 100));
      score += priceScore;
      reasons.push(`price: ${priceScore.toFixed(0)}/40`);

      // 2. Liquidity score (0-25 points): depth at best level
      const depth = side === "BUY"
        ? book.asks.slice(0, 3).reduce((s, l) => s + l.size * l.price, 0)
        : book.bids.slice(0, 3).reduce((s, l) => s + l.size * l.price, 0);

      const canFillCompletely = depth >= size;
      const liquidityScore = canFillCompletely ? 25 : 25 * (depth / size);
      score += liquidityScore;
      reasons.push(`liquidity: ${liquidityScore.toFixed(0)}/25`);

      // 3. Fee score (0-20 points): lower fees = higher score
      const stats = this.venueStats.get(venue.exchange);
      const feeBps = stats?.takerFeeBps || 10; // Default 10 bps
      const feeScore = Math.max(0, 20 * (1 - feeBps / 30)); // 30 bps = 0 score
      score += feeScore;
      reasons.push(`fees: ${feeScore.toFixed(0)}/20`);

      // 4. Speed/reliability score (0-15 points)
      const fillRate = stats?.avgFillRate || 0.8;
      const speedScore = 15 * fillRate;
      score += speedScore;
      reasons.push(`speed: ${speedScore.toFixed(0)}/15`);

      results.push({ exchange: venue.exchange, score, reasons });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  /**
   * Record fill outcome for venue learning.
   */
  recordFill(exchange: string, slippageBps: number, latencyMs: number, filled: boolean): void {
    if (!this.venueStats.has(exchange)) {
      this.venueStats.set(exchange, {
        avgFillRate: 0.8,
        avgSlippageBps: 0,
        avgLatencyMs: 100,
        makerFeeBps: 5,
        takerFeeBps: 10,
        fillCount: 0,
      });
    }

    const stats = this.venueStats.get(exchange)!;
    stats.fillCount++;

    // Exponential moving average for stats
    const alpha = 0.1;
    stats.avgFillRate = stats.avgFillRate * (1 - alpha) + (filled ? 1 : 0) * alpha;
    stats.avgSlippageBps = stats.avgSlippageBps * (1 - alpha) + slippageBps * alpha;
    stats.avgLatencyMs = stats.avgLatencyMs * (1 - alpha) + latencyMs * alpha;
  }
}

// ============================================================================
// MARKET IMPACT MODEL (Almgren-Chriss)
// ============================================================================

export class MarketImpactModel {
  /**
   * Estimate market impact of an order.
   *
   * Square-root model (industry standard):
   *   impact = σ * √(Q/ADV) * spread_factor
   *
   * where:
   *   σ = daily volatility
   *   Q = order size
   *   ADV = average daily volume
   *   spread_factor = adjustment for current spread conditions
   */
  static estimate(
    orderSize: number,
    volatility: number,
    adv: number,
    currentSpread: number,
    mid: number
  ): IMarketImpactEstimate {
    if (adv === 0 || mid === 0) {
      return { temporaryImpact: 0, permanentImpact: 0, totalImpactBps: 0, estimatedCost: 0, optimalDuration: 60000 };
    }

    // Participation rate
    const participationRate = orderSize / adv;

    // Square-root impact model
    const sqrtImpact = volatility * Math.sqrt(participationRate);

    // Spread adjustment
    const spreadBps = (currentSpread / mid) * 10000;
    const spreadAdjustment = 1 + spreadBps / 100;

    // Temporary impact: reverts after execution
    const temporaryImpact = sqrtImpact * 0.6 * spreadAdjustment * mid;

    // Permanent impact: persists (information leakage)
    const permanentImpact = sqrtImpact * 0.4 * mid;

    const totalImpactBps = ((temporaryImpact + permanentImpact) / mid) * 10000;
    const estimatedCost = (temporaryImpact + permanentImpact) * orderSize / mid;

    // Optimal duration: longer for larger orders
    const optimalDuration = Math.max(10_000, Math.min(300_000, 60_000 * Math.sqrt(participationRate) * 10));

    return {
      temporaryImpact,
      permanentImpact,
      totalImpactBps,
      estimatedCost,
      optimalDuration,
    };
  }
}

// ============================================================================
// PRE-TRADE COST ESTIMATOR
// ============================================================================

export class PreTradeCostEstimator {
  /**
   * Estimate total execution cost before placing the order.
   * Used to decide whether a trade is worth executing.
   */
  static estimate(
    size: number,
    side: "BUY" | "SELL",
    orderbook: IUnifiedOrderbook,
    volatility: number,
    estimatedAdv: number
  ): IPreTradeCostEstimate {
    const mid = orderbook.midPrice;
    if (mid <= 0) {
      return {
        spreadCost: 0, impactCost: 0, timingRisk: 0,
        totalEstimatedCost: 0, totalEstimatedCostBps: 0,
        confidence: 0, recommendation: "TWAP",
      };
    }

    // 1. Spread cost: half-spread crossing cost
    const halfSpread = orderbook.spread / 2;
    const spreadCost = halfSpread * (size / mid);

    // 2. Impact cost
    const impact = MarketImpactModel.estimate(size, volatility, estimatedAdv, orderbook.spread, mid);
    const impactCost = impact.estimatedCost;

    // 3. Timing risk: volatility * holding period * size
    const holdingPeriodDays = impact.optimalDuration / (24 * 3600 * 1000);
    const timingRisk = volatility * Math.sqrt(holdingPeriodDays) * size * 0.1;

    const totalCost = spreadCost + impactCost + timingRisk;
    const totalCostBps = mid > 0 ? (totalCost / size) * 10000 : 0;

    // Recommend algorithm based on characteristics
    let recommendation: ExecutionAlgorithm = "TWAP";
    const participationRate = estimatedAdv > 0 ? size / estimatedAdv : 1;

    if (participationRate < 0.01) {
      recommendation = "SMART"; // Small order, just route to best venue
    } else if (participationRate < 0.05) {
      recommendation = "TWAP"; // Medium order, spread over time
    } else if (participationRate < 0.15) {
      recommendation = "VWAP"; // Larger order, match volume profile
    } else {
      recommendation = "IS"; // Large order, optimize urgency vs impact
    }

    // Confidence based on data quality
    const confidence = Math.min(1,
      (orderbook.bids.length > 3 ? 0.3 : 0.1) +
      (orderbook.asks.length > 3 ? 0.3 : 0.1) +
      (volatility > 0 ? 0.2 : 0) +
      (estimatedAdv > 0 ? 0.2 : 0)
    );

    return {
      spreadCost,
      impactCost,
      timingRisk,
      totalEstimatedCost: totalCost,
      totalEstimatedCostBps: totalCostBps,
      confidence,
      recommendation,
    };
  }
}

// ============================================================================
// POST-TRADE TRANSACTION COST ANALYSIS
// ============================================================================

export class PostTradeTCA {
  /**
   * Complete post-trade TCA report.
   *
   * Implementation Shortfall decomposition:
   *   IS = (execution_price - decision_price) * side_sign
   *   IS = delay + impact + timing + spread + commission
   */
  static analyze(
    order: IExecutionOrder,
    decisionPrice: number,
    arrivalPrice: number,
    vwapBenchmark: number,
    twapBenchmark: number,
    closePrice: number,
    commissionPaid: number
  ): IPostTradeTCA {
    const sideSign = order.side === "BUY" ? 1 : -1;
    const execVwap = order.filledAvgPrice;

    // Implementation Shortfall = (execution_price - decision_price) * side
    const is_ = (execVwap - decisionPrice) * sideSign * order.filledSize;
    const isBps = decisionPrice > 0 ? ((execVwap - decisionPrice) / decisionPrice) * sideSign * 10000 : 0;

    // Component decomposition
    const delayComponent = (arrivalPrice - decisionPrice) * sideSign * order.filledSize;
    const tradingImpact = (execVwap - arrivalPrice) * sideSign * order.filledSize;
    const spreadComponent = order.filledSize > 0
      ? (order.slicedOrders[0]?.price || 0) * 0.001 * order.filledSize // Estimated half-spread
      : 0;
    const timingComponent = is_ - delayComponent - tradingImpact - spreadComponent - commissionPaid;

    // Benchmark comparisons (positive = outperformed benchmark)
    const vsMid = (mid: number) => mid > 0 ? ((mid - execVwap) / mid) * sideSign * 10000 : 0;

    // Quality score: 100 = zero slippage, lower = worse
    const qualityScore = Math.max(0, Math.min(100, 100 - Math.abs(isBps) * 2));

    return {
      orderId: order.id,
      instrument: order.instrument,
      side: order.side,
      totalSize: order.filledSize,
      totalCost: is_,
      vwap: execVwap,
      arrivalPrice,
      implementationShortfall: is_,
      implementationShortfallBps: isBps,
      components: {
        delayComponent,
        tradingImpact,
        timingComponent,
        spreadComponent,
        commissionComponent: commissionPaid,
      },
      benchmarkComparison: {
        vsVwap: vsMid(vwapBenchmark),
        vsTwap: vsMid(twapBenchmark),
        vsArrival: vsMid(arrivalPrice),
        vsClose: vsMid(closePrice),
      },
      executionQualityScore: qualityScore,
    };
  }
}

// ============================================================================
// SLIPPAGE TRACKER
// ============================================================================

export class SlippageTracker {
  private reports: ISlippageReport[] = [];

  /**
   * Calculate slippage for a completed order.
   */
  recordSlippage(
    orderId: string,
    signalPrice: number,
    decisionPrice: number,
    arrivalPrice: number,
    executionVwap: number,
    lastPrice: number,
    side: "BUY" | "SELL"
  ): ISlippageReport {
    const sideSign = side === "BUY" ? 1 : -1;

    const totalSlippageBps = signalPrice > 0
      ? ((executionVwap - signalPrice) / signalPrice) * sideSign * 10000
      : 0;

    const timingCostBps = signalPrice > 0
      ? ((arrivalPrice - decisionPrice) / signalPrice) * sideSign * 10000
      : 0;

    const impactCostBps = arrivalPrice > 0
      ? ((executionVwap - arrivalPrice) / arrivalPrice) * sideSign * 10000
      : 0;

    const spreadCostBps = Math.abs(executionVwap - arrivalPrice) / (arrivalPrice || 1) * 5000;

    const report: ISlippageReport = {
      orderId,
      signalPrice,
      decisionPrice,
      arrivalPrice,
      executionVwap,
      lastPrice,
      totalSlippageBps,
      timingCostBps,
      impactCostBps,
      spreadCostBps,
      opportunityCostBps: 0,
    };

    this.reports.push(report);
    if (this.reports.length > 1000) this.reports.shift();

    return report;
  }

  /**
   * Execution quality analytics over time.
   */
  getAnalytics(): {
    avgSlippageBps: number;
    medianSlippageBps: number;
    p95SlippageBps: number;
    avgImpactBps: number;
    totalReports: number;
    trend: "improving" | "stable" | "degrading";
  } {
    if (this.reports.length === 0) {
      return { avgSlippageBps: 0, medianSlippageBps: 0, p95SlippageBps: 0, avgImpactBps: 0, totalReports: 0, trend: "stable" };
    }

    const slippages = this.reports.map(r => r.totalSlippageBps);
    const sorted = [...slippages].sort((a, b) => a - b);

    const p95Idx = Math.floor(sorted.length * 0.95);

    // Trend: compare first half vs second half
    const half = Math.floor(slippages.length / 2);
    const firstHalf = mean(slippages.slice(0, half));
    const secondHalf = mean(slippages.slice(half));
    let trend: "improving" | "stable" | "degrading" = "stable";
    if (secondHalf < firstHalf * 0.9) trend = "improving";
    else if (secondHalf > firstHalf * 1.1) trend = "degrading";

    return {
      avgSlippageBps: mean(slippages),
      medianSlippageBps: sorted[Math.floor(sorted.length / 2)] || 0,
      p95SlippageBps: sorted[p95Idx] || 0,
      avgImpactBps: mean(this.reports.map(r => r.impactCostBps)),
      totalReports: this.reports.length,
      trend,
    };
  }
}
