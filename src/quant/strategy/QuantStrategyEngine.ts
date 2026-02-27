/**
 * ============================================================================
 * GOLDMAN SACHS QUANTITATIVE STRATEGIES GROUP — STRATEGY MEMO
 * ============================================================================
 *
 * STRATEGY: Cross-Asset Momentum + Mean Reversion + Microstructure Alpha
 *
 * THESIS: Markets exhibit persistent momentum at 1-12 month horizons
 * (Jegadeesh & Titman, 1993) and mean-reversion at sub-second to intraday
 * horizons (Bouchaud et al., 2018). This strategy captures both by:
 *
 *   1. MOMENTUM SIGNAL: 12-1 month price momentum with vol-scaling
 *   2. MEAN REVERSION: Ornstein-Uhlenbeck residual reversion on spreads
 *   3. MICROSTRUCTURE: Order book imbalance + trade flow toxicity (VPIN)
 *   4. CROSS-ASSET SIGNAL: Hyperliquid perp → prediction market lead-lag
 *   5. ML ENSEMBLE: Gradient-boosted meta-learner combining all signals
 *
 * UNIVERSE: Polymarket prediction markets, Hyperliquid perps (BTC/ETH/SOL/XRP)
 *
 * BENCHMARK: Equal-weighted portfolio of all traded instruments
 * TARGET: Sharpe > 2.5, Max DD < 10%, Win Rate > 55%
 *
 * ============================================================================
 */

import { v4 as uuidv4 } from "uuid";
import { mean, stddev, ema, sma, correlation, zScore, linearRegression } from "../../utils/mathUtils";
import { IUnifiedOrderbook, IUnifiedBookLevel } from "../../types/exchange.types";
import { logger } from "../../utils/logger";

// ============================================================================
// TYPES
// ============================================================================

export interface ISignal {
  id: string;
  timestamp: number;
  instrument: string;
  exchange: string;
  direction: "LONG" | "SHORT" | "FLAT";
  conviction: number;       // -1.0 to +1.0 (signed strength)
  confidence: number;       // 0.0 to 1.0 (statistical confidence)
  expectedReturn: number;   // basis points
  expectedHoldTime: number; // milliseconds
  strategy: StrategyType;
  components: ISignalComponent[];
  metadata: Record<string, number>;
}

export interface ISignalComponent {
  name: string;
  value: number;
  weight: number;
  zScore: number;
}

export type StrategyType =
  | "momentum"
  | "mean_reversion"
  | "microstructure"
  | "cross_asset"
  | "ml_ensemble"
  | "spread_capture"
  | "book_imbalance"
  | "vpin_toxicity"
  | "hl_momentum_scalp"
  | "hl_mean_revert";

export interface IEntryRule {
  name: string;
  condition: string;
  passed: boolean;
  value: number;
  threshold: number;
}

export interface IExitRule {
  type: "take_profit" | "stop_loss" | "trailing_stop" | "time_exit" | "signal_reversal";
  trigger: number;
  description: string;
}

export interface ITradeDecision {
  signal: ISignal;
  action: "OPEN_LONG" | "OPEN_SHORT" | "CLOSE" | "HOLD" | "NO_TRADE";
  size: number;            // USDC value
  entryPrice: number;
  entryRules: IEntryRule[];
  exitRules: IExitRule[];
  riskRewardRatio: number;
  kellyFraction: number;
  timestamp: number;
}

// ============================================================================
// RISK PARAMETER TABLE (Goldman Strategy Memo format)
// ============================================================================

export const RISK_PARAMETERS = {
  // Position Limits
  maxPositionSize: 10,           // $10 max per single position
  maxTotalExposure: 80,          // $80 max total exposure (80% of $100)
  maxPositionsPerExchange: 5,    // Max 5 concurrent positions per exchange
  maxTotalPositions: 12,         // Max 12 total concurrent positions
  maxSingleInstrumentExposure: 0.15, // 15% of capital per instrument

  // Risk Limits
  maxDrawdownPct: 0.10,          // 10% max drawdown → halt trading
  maxDailyLossPct: 0.05,         // 5% max daily loss
  maxHourlyLossPct: 0.02,        // 2% max hourly loss
  correlationLimit: 0.70,         // Max pairwise correlation between positions

  // Signal Thresholds
  minConviction: 0.15,           // Minimum |conviction| to trade (lowered for faster signal pickup)
  minConfidence: 0.40,           // Minimum confidence to trade (lowered for HFT responsiveness)
  minExpectedReturn: 5,          // Minimum 5 bps expected return
  maxSpreadToMid: 0.05,          // Don't trade if spread > 5% of mid

  // Execution
  maxSlippageBps: 20,            // Max 20 bps slippage tolerance
  minLiquidity: 50,              // Min $50 depth at best bid/ask

  // Edge Decay
  edgeDecayWindow: 100,          // Check last 100 trades for edge decay
  minEdgeDecaySharpe: 0.5,       // If rolling Sharpe < 0.5, reduce size
  edgeDecayHaltSharpe: -0.5,     // If rolling Sharpe < -0.5, halt strategy
} as const;

// ============================================================================
// PRICE HISTORY RING BUFFER
// ============================================================================

export class PriceHistory {
  private prices: number[] = [];
  private timestamps: number[] = [];
  private volumes: number[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 2000) {
    this.maxSize = maxSize;
  }

  push(price: number, volume = 0, timestamp = Date.now()): void {
    this.prices.push(price);
    this.timestamps.push(timestamp);
    this.volumes.push(volume);
    if (this.prices.length > this.maxSize) {
      this.prices.shift();
      this.timestamps.shift();
      this.volumes.shift();
    }
  }

  getPrices(n?: number): number[] {
    if (n === undefined) return [...this.prices];
    return this.prices.slice(-n);
  }

  getVolumes(n?: number): number[] {
    if (n === undefined) return [...this.volumes];
    return this.volumes.slice(-n);
  }

  getReturns(n?: number): number[] {
    const p = n ? this.prices.slice(-(n + 1)) : this.prices;
    const returns: number[] = [];
    for (let i = 1; i < p.length; i++) {
      if (p[i - 1] !== 0) returns.push((p[i] - p[i - 1]) / p[i - 1]);
    }
    return returns;
  }

  getLogReturns(n?: number): number[] {
    const p = n ? this.prices.slice(-(n + 1)) : this.prices;
    const returns: number[] = [];
    for (let i = 1; i < p.length; i++) {
      if (p[i - 1] > 0 && p[i] > 0) returns.push(Math.log(p[i] / p[i - 1]));
    }
    return returns;
  }

  latest(): number {
    return this.prices[this.prices.length - 1] || 0;
  }

  length(): number {
    return this.prices.length;
  }

  getSMA(period: number): number {
    if (this.prices.length < period) return this.latest();
    return mean(this.prices.slice(-period));
  }

  getEMA(period: number): number {
    if (this.prices.length < period) return this.latest();
    const emaValues = ema(this.prices, period);
    return emaValues[emaValues.length - 1] || this.latest();
  }

  getVolatility(period = 20): number {
    const returns = this.getReturns(period);
    if (returns.length < 2) return 0;
    return stddev(returns);
  }

  /**
   * Realized volatility (annualized) using Parkinson estimator
   * σ² = (1/4ln2) * Σ(ln(H/L))²
   */
  getRealizedVol(period = 20): number {
    const returns = this.getReturns(period);
    if (returns.length < 2) return 0;
    const sd = stddev(returns);
    // Annualize: assume 500ms ticks, ~172800 ticks/day, 252 days/year
    const ticksPerYear = 172800 * 252;
    return sd * Math.sqrt(ticksPerYear);
  }

  /**
   * Volume-Weighted Average Price over last N ticks
   */
  getVWAP(n: number): number {
    const prices = this.prices.slice(-n);
    const vols = this.volumes.slice(-n);
    let sumPV = 0;
    let sumV = 0;
    for (let i = 0; i < prices.length; i++) {
      sumPV += prices[i] * (vols[i] || 1);
      sumV += vols[i] || 1;
    }
    return sumV > 0 ? sumPV / sumV : this.latest();
  }
}

// ============================================================================
// SIGNAL GENERATORS
// ============================================================================

/**
 * Signal 1: MOMENTUM
 *
 * Classic 12-1 month momentum (Jegadeesh & Titman) adapted for HFT:
 * - Compute returns over lookback window (skip most recent N ticks for reversal)
 * - Normalize by realized volatility (Barroso & Santa-Clara, 2015)
 * - Signal = (r_lookback - r_skip) / σ_realized
 *
 * Mathematical formulation:
 *   r_mom = Σ(r_t) for t in [T-lookback, T-skip]
 *   σ = stddev(r_t) for t in [T-volWindow, T]
 *   signal = r_mom / σ
 */
export function momentumSignal(
  history: PriceHistory,
  lookback = 40,     // 20 seconds at 500ms (fast warmup)
  skip = 2,          // Skip last 1 second (microstructure noise)
  volWindow = 20     // 10-second vol window
): ISignalComponent {
  const prices = history.getPrices();
  if (prices.length < lookback + skip) {
    return { name: "momentum", value: 0, weight: 0.20, zScore: 0 };
  }

  const currentIdx = prices.length - 1 - skip;
  const startIdx = prices.length - 1 - lookback;
  const r_mom = (prices[currentIdx] - prices[startIdx]) / prices[startIdx];

  const vol = history.getVolatility(volWindow);
  const signal = vol > 0 ? r_mom / vol : 0;

  return {
    name: "momentum",
    value: signal,
    weight: 0.20,
    zScore: signal, // Already vol-normalized
  };
}

/**
 * Signal 2: MEAN REVERSION (Ornstein-Uhlenbeck)
 *
 * Models price as OU process: dX = θ(μ - X)dt + σdW
 * where θ = speed of reversion, μ = long-run mean
 *
 * Signal = -(X - μ) / σ  (negative because we fade deviations)
 *
 * Entry: |z-score| > 2.0 (2 sigma deviation from mean)
 * Exit:  |z-score| < 0.5 (reversion toward mean)
 */
export function meanReversionSignal(
  history: PriceHistory,
  lookback = 60,      // 30-second lookback (faster warmup)
  entryThreshold = 1.5, // 1.5 sigma (more frequent signals)
  exitThreshold = 0.5
): ISignalComponent {
  const prices = history.getPrices(lookback);
  if (prices.length < 20) {
    return { name: "mean_reversion", value: 0, weight: 0.20, zScore: 0 };
  }

  const mu = mean(prices);
  const sigma = stddev(prices);
  if (sigma === 0) {
    return { name: "mean_reversion", value: 0, weight: 0.20, zScore: 0 };
  }

  const current = prices[prices.length - 1];
  const z = (current - mu) / sigma;

  // Fade the deviation: if price is above mean, signal is SHORT (negative)
  // if price is below mean, signal is LONG (positive)
  let signal = 0;
  if (Math.abs(z) > entryThreshold) {
    signal = -z; // Fade the deviation
  } else if (Math.abs(z) < exitThreshold) {
    signal = 0; // Within normal range
  } else {
    signal = -z * 0.3; // Partial signal in middle zone
  }

  return {
    name: "mean_reversion",
    value: signal,
    weight: 0.20,
    zScore: z,
  };
}

/**
 * Signal 3: ORDERBOOK MICROSTRUCTURE
 *
 * Order Flow Imbalance (OFI):
 *   OFI = (bid_depth - ask_depth) / (bid_depth + ask_depth)
 *
 * Trade Flow Toxicity (VPIN - Volume-Synchronized Probability of Informed Trading):
 *   VPIN ≈ Σ|V_buy - V_sell| / (2 * V_total)  over volume buckets
 *
 * Weighted Mid-Price:
 *   P_w = (P_ask * V_bid + P_bid * V_ask) / (V_bid + V_ask)
 *   Microprice deviation = P_w - P_mid
 */
export function microstructureSignal(
  orderbook: IUnifiedOrderbook | null,
  recentImbalances: number[] = []
): ISignalComponent {
  if (!orderbook || orderbook.bids.length === 0 || orderbook.asks.length === 0) {
    return { name: "microstructure", value: 0, weight: 0.25, zScore: 0 };
  }

  // 1. Order Flow Imbalance (top 5 levels)
  const topBids = orderbook.bids.slice(0, 5);
  const topAsks = orderbook.asks.slice(0, 5);
  const bidDepth = topBids.reduce((s, l) => s + l.size * l.price, 0);
  const askDepth = topAsks.reduce((s, l) => s + l.size * l.price, 0);
  const totalDepth = bidDepth + askDepth;
  const ofi = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;

  // 2. Weighted Microprice
  const bestBid = orderbook.bids[0];
  const bestAsk = orderbook.asks[0];
  const bidSize = bestBid.size;
  const askSize = bestAsk.size;
  const microprice = (bestAsk.price * bidSize + bestBid.price * askSize) / (bidSize + askSize);
  const mid = orderbook.midPrice;
  const micropriceDeviation = mid > 0 ? (microprice - mid) / mid : 0;

  // 3. Depth imbalance persistence (are imbalances sticky?)
  const allImbalances = [...recentImbalances, ofi];
  const imbalanceMean = allImbalances.length > 5 ? mean(allImbalances.slice(-20)) : ofi;

  // Combined signal: OFI * 0.6 + microprice * 0.3 + persistence * 0.1
  const signal = ofi * 0.6 + micropriceDeviation * 100 * 0.3 + imbalanceMean * 0.1;

  // Z-score over recent imbalances
  const z = allImbalances.length > 5 ? zScore(ofi, mean(allImbalances), stddev(allImbalances)) : ofi * 3;

  return {
    name: "microstructure",
    value: signal,
    weight: 0.25,
    zScore: z,
  };
}

/**
 * Signal 4: CROSS-ASSET LEAD-LAG
 *
 * Hypothesis: Hyperliquid perpetual futures (BTC, ETH) lead
 * Polymarket prediction market repricing by 1-5 seconds.
 *
 * Signal = correlation(HL_returns, Poly_returns_lagged) * HL_recent_move
 *
 * If BTC perp just moved +0.1%, and historically Polymarket BTC markets
 * follow with 3-second lag, we trade Polymarket ahead of the move.
 */
export function crossAssetSignal(
  perpHistory: PriceHistory,
  predictionHistory: PriceHistory,
  lagTicks = 6       // 3-second lag at 500ms ticks
): ISignalComponent {
  const perpPrices = perpHistory.getPrices();
  const predPrices = predictionHistory.getPrices();

  if (perpPrices.length < 40 || predPrices.length < 40) {
    return { name: "cross_asset", value: 0, weight: 0.15, zScore: 0 };
  }

  // Calculate returns
  const perpReturns = perpHistory.getReturns(30);
  const predReturns = predictionHistory.getReturns(30);

  if (perpReturns.length < 20 || predReturns.length < 20) {
    return { name: "cross_asset", value: 0, weight: 0.15, zScore: 0 };
  }

  // Lead-lag correlation: perp returns vs lagged prediction returns
  const perpForCorr = perpReturns.slice(lagTicks);
  const predLagged = predReturns.slice(0, predReturns.length - lagTicks);
  const minLen = Math.min(perpForCorr.length, predLagged.length);

  if (minLen < 10) {
    return { name: "cross_asset", value: 0, weight: 0.15, zScore: 0 };
  }

  const leadLagCorr = correlation(
    perpForCorr.slice(0, minLen),
    predLagged.slice(0, minLen)
  );

  // Recent perp move (last 6 ticks = 3 seconds)
  const recentPerpMove = perpReturns.slice(-lagTicks).reduce((s, r) => s + r, 0);

  // Signal: if strong lead-lag and recent move, trade prediction in same direction
  const signal = leadLagCorr * recentPerpMove * 100; // Scale up

  return {
    name: "cross_asset",
    value: signal,
    weight: 0.15,
    zScore: Math.abs(leadLagCorr) > 0.3 ? signal / (stddev(perpReturns) || 0.001) : 0,
  };
}

/**
 * Signal 5: SPREAD REGIME DETECTOR
 *
 * Classifies current market regime by spread behavior:
 * - Tight spread + low vol = "quiet" → mean reversion works
 * - Wide spread + high vol = "volatile" → momentum works
 * - Widening spread = "adverse selection" → reduce exposure
 *
 * Used as a meta-signal to weight other signals.
 */
export function spreadRegimeSignal(
  orderbook: IUnifiedOrderbook | null,
  spreadHistory: number[]
): ISignalComponent {
  if (!orderbook || spreadHistory.length < 10) {
    return { name: "spread_regime", value: 0, weight: 0.10, zScore: 0 };
  }

  const currentSpread = orderbook.spread;
  const avgSpread = mean(spreadHistory);
  const spreadVol = stddev(spreadHistory);

  const spreadZ = spreadVol > 0 ? (currentSpread - avgSpread) / spreadVol : 0;

  // Widening spreads = adverse selection risk → reduce confidence
  // Tightening spreads = favorable conditions → increase confidence
  // Signal is the confidence multiplier (-1 to +1)
  let signal = 0;
  if (spreadZ > 2) {
    signal = -0.5; // Spreads widening dangerously → reduce
  } else if (spreadZ > 1) {
    signal = -0.2; // Spreads moderately wide → caution
  } else if (spreadZ < -1) {
    signal = 0.3;  // Spreads tighter than normal → favorable
  } else {
    signal = 0.1;  // Normal conditions
  }

  return {
    name: "spread_regime",
    value: signal,
    weight: 0.10,
    zScore: spreadZ,
  };
}

/**
 * Signal 6: VOLUME PROFILE ANOMALY
 *
 * Detect unusual volume patterns that precede price moves:
 * - Volume spike + no price move = accumulation/distribution
 * - Volume dry-up = range compression, breakout imminent
 * - Volume trend divergence from price = reversal signal
 */
export function volumeProfileSignal(
  history: PriceHistory,
  volumeLookback = 60
): ISignalComponent {
  const volumes = history.getVolumes(volumeLookback);
  const prices = history.getPrices(volumeLookback);

  if (volumes.length < 20 || prices.length < 20) {
    return { name: "volume_profile", value: 0, weight: 0.10, zScore: 0 };
  }

  // Volume z-score (is current volume abnormal?)
  const recentVol = volumes.slice(-5);
  const avgVolume = mean(volumes);
  const volStd = stddev(volumes);
  const currentVolume = mean(recentVol);
  const volumeZ = volStd > 0 ? (currentVolume - avgVolume) / volStd : 0;

  // Price-volume divergence
  const priceReturns = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] !== 0) priceReturns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }

  const pvCorr = priceReturns.length > 10 && volumes.slice(1).length > 10
    ? correlation(priceReturns, volumes.slice(1, priceReturns.length + 1))
    : 0;

  // High volume + low price movement = potential accumulation
  const priceVol = stddev(prices.slice(-10));
  const priceMid = mean(prices.slice(-10));
  const priceVolNorm = priceMid > 0 ? priceVol / priceMid : 0;

  let signal = 0;
  if (volumeZ > 2 && priceVolNorm < 0.001) {
    // Volume spike but no price move → accumulation → bullish
    signal = 0.3;
  } else if (volumeZ < -1.5) {
    // Volume dry-up → compression → breakout pending (direction unknown)
    signal = 0; // Neutral but flag high volatility regime change
  } else if (pvCorr < -0.3 && volumeZ > 0.5) {
    // Volume up but price declining → distribution → bearish
    signal = -0.2;
  }

  return {
    name: "volume_profile",
    value: signal,
    weight: 0.10,
    zScore: volumeZ,
  };
}

// ============================================================================
// META-LEARNER: COMBINE ALL SIGNALS
// ============================================================================

/**
 * ML Ensemble Meta-Learner
 *
 * Combines individual signal components using adaptive weighting:
 *
 *   conviction = Σ(w_i * signal_i) / Σ(w_i)
 *   confidence = 1 - σ(signals) / max(σ)  (signal agreement)
 *
 * Weights adapt based on recent performance of each signal.
 */
export class SignalCombiner {
  private signalPerformance: Map<string, number[]> = new Map();
  private readonly adaptWindow = 50; // Last 50 trades

  combine(components: ISignalComponent[]): { conviction: number; confidence: number } {
    if (components.length === 0) {
      return { conviction: 0, confidence: 0 };
    }

    // Adaptive weights based on recent signal performance
    const adaptedComponents = components.map(c => {
      const perf = this.signalPerformance.get(c.name) || [];
      const recentPnl = perf.length > 5 ? mean(perf.slice(-this.adaptWindow)) : 0;
      // Boost weight of profitable signals, reduce weight of losing signals
      const adaptFactor = 1 + Math.tanh(recentPnl * 10) * 0.3; // ±30% adjustment
      return { ...c, adaptedWeight: c.weight * adaptFactor };
    });

    // Weighted sum of signals
    let totalWeight = 0;
    let weightedSum = 0;
    for (const c of adaptedComponents) {
      weightedSum += c.value * c.adaptedWeight;
      totalWeight += c.adaptedWeight;
    }

    const conviction = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Confidence: how much do signals agree?
    const signalValues = adaptedComponents.map(c => Math.sign(c.value));
    const agreement = signalValues.length > 0
      ? Math.abs(mean(signalValues))
      : 0;

    // Also factor in z-score magnitudes (stronger signals = more confidence)
    const avgAbsZ = mean(components.map(c => Math.abs(c.zScore)));
    const zConfidence = Math.min(1, avgAbsZ / 3); // Saturate at z=3

    const confidence = Math.min(1, agreement * 0.6 + zConfidence * 0.4);

    return {
      conviction: Math.max(-1, Math.min(1, conviction)),
      confidence,
    };
  }

  recordSignalPerformance(signalName: string, pnl: number): void {
    if (!this.signalPerformance.has(signalName)) {
      this.signalPerformance.set(signalName, []);
    }
    const perf = this.signalPerformance.get(signalName)!;
    perf.push(pnl);
    if (perf.length > this.adaptWindow * 2) {
      perf.splice(0, perf.length - this.adaptWindow * 2);
    }
  }
}

// ============================================================================
// ENTRY RULES (ALL must pass)
// ============================================================================

export function evaluateEntryRules(
  signal: ISignal,
  orderbook: IUnifiedOrderbook | null,
  currentExposure: number,
  recentPnl1h: number,
  totalBalance: number,
  openPositionCount: number,
  exchangePositionCount: number
): IEntryRule[] {
  const rules: IEntryRule[] = [];
  const P = RISK_PARAMETERS;

  // Rule 1: Minimum conviction strength
  rules.push({
    name: "min_conviction",
    condition: "|conviction| >= minConviction",
    passed: Math.abs(signal.conviction) >= P.minConviction,
    value: Math.abs(signal.conviction),
    threshold: P.minConviction,
  });

  // Rule 2: Minimum confidence level
  rules.push({
    name: "min_confidence",
    condition: "confidence >= minConfidence",
    passed: signal.confidence >= P.minConfidence,
    value: signal.confidence,
    threshold: P.minConfidence,
  });

  // Rule 3: Minimum expected return
  rules.push({
    name: "min_expected_return",
    condition: "expectedReturn >= minExpectedReturn bps",
    passed: signal.expectedReturn >= P.minExpectedReturn,
    value: signal.expectedReturn,
    threshold: P.minExpectedReturn,
  });

  // Rule 4: Spread not too wide (adverse selection risk)
  const spreadToMid = orderbook && orderbook.midPrice > 0
    ? orderbook.spread / orderbook.midPrice
    : 1;
  rules.push({
    name: "max_spread",
    condition: "spread/mid <= maxSpreadToMid",
    passed: spreadToMid <= P.maxSpreadToMid,
    value: spreadToMid,
    threshold: P.maxSpreadToMid,
  });

  // Rule 5: Sufficient liquidity at best level
  const bestBidSize = orderbook && orderbook.bids[0]
    ? orderbook.bids[0].size * orderbook.bids[0].price
    : 0;
  const bestAskSize = orderbook && orderbook.asks[0]
    ? orderbook.asks[0].size * orderbook.asks[0].price
    : 0;
  const minSideLiquidity = Math.min(bestBidSize, bestAskSize);
  rules.push({
    name: "min_liquidity",
    condition: "min(bidLiq, askLiq) >= minLiquidity",
    passed: minSideLiquidity >= P.minLiquidity || signal.exchange === "polymarket",
    value: minSideLiquidity,
    threshold: P.minLiquidity,
  });

  // Rule 6: Total exposure limit
  rules.push({
    name: "max_exposure",
    condition: "totalExposure <= maxTotalExposure",
    passed: currentExposure <= P.maxTotalExposure,
    value: currentExposure,
    threshold: P.maxTotalExposure,
  });

  // Rule 7: Max positions per exchange
  rules.push({
    name: "max_positions_per_exchange",
    condition: "exchangePositions < maxPositionsPerExchange",
    passed: exchangePositionCount < P.maxPositionsPerExchange,
    value: exchangePositionCount,
    threshold: P.maxPositionsPerExchange,
  });

  // Rule 8: Max total positions
  rules.push({
    name: "max_total_positions",
    condition: "totalPositions < maxTotalPositions",
    passed: openPositionCount < P.maxTotalPositions,
    value: openPositionCount,
    threshold: P.maxTotalPositions,
  });

  // Rule 9: Hourly loss limit not breached
  rules.push({
    name: "hourly_loss_limit",
    condition: "recentPnl1h > -maxHourlyLoss",
    passed: recentPnl1h > -(P.maxHourlyLossPct * totalBalance),
    value: recentPnl1h,
    threshold: -(P.maxHourlyLossPct * totalBalance),
  });

  // Rule 10: No adverse spread regime
  const spreadRegime = signal.components.find(c => c.name === "spread_regime");
  rules.push({
    name: "no_adverse_regime",
    condition: "spreadRegime > -0.4",
    passed: !spreadRegime || spreadRegime.value > -0.4,
    value: spreadRegime?.value || 0,
    threshold: -0.4,
  });

  return rules;
}

// ============================================================================
// EXIT RULES
// ============================================================================

export function generateExitRules(
  signal: ISignal,
  volatility: number
): IExitRule[] {
  const rules: IExitRule[] = [];

  // Vol-adjusted multipliers
  const volMult = Math.max(0.5, Math.min(3, 1 / (volatility * 100 + 0.01)));

  // Take profit: 1.5-3% depending on strategy and volatility
  const tpBps = signal.strategy === "mean_reversion" ? 100 * volMult : 150 * volMult;
  rules.push({
    type: "take_profit",
    trigger: tpBps / 10000,
    description: `Take profit at +${tpBps.toFixed(0)} bps (vol-adjusted)`,
  });

  // Stop loss: -1% to -2% depending on strategy
  const slBps = signal.strategy === "momentum" ? 150 : 100;
  rules.push({
    type: "stop_loss",
    trigger: -(slBps / 10000),
    description: `Stop loss at -${slBps} bps`,
  });

  // Trailing stop: activates after 50% of take-profit reached
  rules.push({
    type: "trailing_stop",
    trigger: 0.5, // 50% of max profit
    description: "Trailing stop: close if price retraces 50% of max unrealized profit",
  });

  // Time exit: auto-close after hold time
  const maxHoldMs = signal.strategy === "microstructure" ? 30_000 : 120_000;
  rules.push({
    type: "time_exit",
    trigger: maxHoldMs,
    description: `Time exit: auto-close after ${maxHoldMs / 1000}s`,
  });

  // Signal reversal: close if signal flips direction
  rules.push({
    type: "signal_reversal",
    trigger: -Math.sign(signal.conviction) * RISK_PARAMETERS.minConviction,
    description: "Signal reversal: close if conviction flips beyond threshold",
  });

  return rules;
}

// ============================================================================
// POSITION SIZING: KELLY CRITERION
// ============================================================================

/**
 * Fractional Kelly Criterion position sizing.
 *
 * Full Kelly: f* = (p * b - q) / b
 * where p = win probability, b = win/loss ratio, q = 1 - p
 *
 * We use half-Kelly (f = f_star / 2) for safety, and cap at maxPositionSize.
 *
 * Further adjustments:
 * - Scale by conviction strength
 * - Scale by confidence level
 * - Scale by inverse volatility (smaller positions in volatile markets)
 */
export function kellyPositionSize(
  winRate: number,
  avgWin: number,
  avgLoss: number,
  conviction: number,
  confidence: number,
  volatility: number,
  totalBalance: number,
  kellyFraction = 0.5 // Half-Kelly
): { size: number; kellyF: number; rawKelly: number } {
  // Avoid division by zero
  if (avgLoss === 0 || winRate <= 0 || winRate >= 1) {
    return { size: 0, kellyF: 0, rawKelly: 0 };
  }

  const p = winRate;
  const q = 1 - p;
  const b = Math.abs(avgWin / avgLoss);

  // Full Kelly fraction
  const rawKelly = (p * b - q) / b;

  // If Kelly is negative, don't trade
  if (rawKelly <= 0) {
    return { size: 0, kellyF: 0, rawKelly };
  }

  // Apply fractional Kelly
  let kellyF = rawKelly * kellyFraction;

  // Scale by conviction (0-100% of Kelly depending on signal strength)
  kellyF *= Math.abs(conviction);

  // Scale by confidence
  kellyF *= confidence;

  // Scale by inverse volatility (reduce size in volatile markets)
  const volScalar = Math.max(0.2, Math.min(1.5, 0.02 / (volatility + 0.001)));
  kellyF *= volScalar;

  // Clamp to position limits
  kellyF = Math.min(kellyF, RISK_PARAMETERS.maxSingleInstrumentExposure);

  // Convert to dollar amount
  const size = Math.min(
    kellyF * totalBalance,
    RISK_PARAMETERS.maxPositionSize
  );

  return { size: Math.max(0, size), kellyF, rawKelly };
}

// ============================================================================
// EDGE DECAY MONITOR
// ============================================================================

/**
 * Monitors whether the strategy's edge is decaying over time.
 *
 * Uses rolling Sharpe ratio over recent trades:
 * - Sharpe > 2.0: edge is strong, full position sizing
 * - Sharpe 0.5-2.0: edge is moderate, normal sizing
 * - Sharpe 0.0-0.5: edge is weak, reduce sizing by 50%
 * - Sharpe < 0.0: edge gone, halt strategy
 *
 * Also tracks:
 * - Win rate decay
 * - Profit factor decline
 * - Increasing adverse selection (more slippage)
 */
export class EdgeDecayMonitor {
  private tradePnls: number[] = [];
  private readonly window: number;
  private halted = false;
  private sizeMultiplier = 1.0;

  constructor(window = RISK_PARAMETERS.edgeDecayWindow) {
    this.window = window;
  }

  recordTrade(pnl: number): void {
    this.tradePnls.push(pnl);
    if (this.tradePnls.length > this.window * 2) {
      this.tradePnls.splice(0, this.tradePnls.length - this.window * 2);
    }
    this.evaluate();
  }

  private evaluate(): void {
    const recent = this.tradePnls.slice(-this.window);
    if (recent.length < 20) return;

    const sharpe = this.getRollingSharpe();
    const winRate = recent.filter(p => p > 0).length / recent.length;
    const profitFactor = this.getProfitFactor(recent);

    if (sharpe < RISK_PARAMETERS.edgeDecayHaltSharpe) {
      this.halted = true;
      this.sizeMultiplier = 0;
      logger.warning(`[EdgeDecay] HALT: Rolling Sharpe ${sharpe.toFixed(2)} below ${RISK_PARAMETERS.edgeDecayHaltSharpe}`);
    } else if (sharpe < RISK_PARAMETERS.minEdgeDecaySharpe) {
      this.halted = false;
      this.sizeMultiplier = 0.5;
      logger.info(`[EdgeDecay] REDUCE: Rolling Sharpe ${sharpe.toFixed(2)}, sizing at 50%`);
    } else if (sharpe < 1.0) {
      this.halted = false;
      this.sizeMultiplier = 0.75;
    } else {
      this.halted = false;
      this.sizeMultiplier = 1.0;
    }
  }

  getRollingSharpe(): number {
    const recent = this.tradePnls.slice(-this.window);
    if (recent.length < 10) return 0;
    const avg = mean(recent);
    const sd = stddev(recent);
    return sd > 0 ? avg / sd : 0;
  }

  private getProfitFactor(pnls: number[]): number {
    const gross = pnls.filter(p => p > 0).reduce((s, p) => s + p, 0);
    const loss = Math.abs(pnls.filter(p => p < 0).reduce((s, p) => s + p, 0));
    return loss > 0 ? gross / loss : gross > 0 ? 999 : 0;
  }

  isHalted(): boolean {
    return this.halted;
  }

  getSizeMultiplier(): number {
    return this.sizeMultiplier;
  }

  getMetrics(): { sharpe: number; trades: number; halted: boolean; multiplier: number } {
    return {
      sharpe: this.getRollingSharpe(),
      trades: this.tradePnls.length,
      halted: this.halted,
      multiplier: this.sizeMultiplier,
    };
  }
}

// ============================================================================
// MASTER STRATEGY ENGINE
// ============================================================================

export class QuantStrategyEngine {
  private priceHistories: Map<string, PriceHistory> = new Map();
  private spreadHistories: Map<string, number[]> = new Map();
  private imbalanceHistories: Map<string, number[]> = new Map();
  private signalCombiner = new SignalCombiner();
  private edgeMonitor = new EdgeDecayMonitor();
  private tradeCount = 0;
  private totalPnl = 0;
  private wins = 0;
  private losses = 0;

  /**
   * Generate a complete trading signal for an instrument.
   *
   * This is the main entry point — called every tick (500ms).
   * Returns a fully-formed ISignal with all components evaluated.
   */
  generateSignal(
    instrument: string,
    exchange: string,
    orderbook: IUnifiedOrderbook | null,
    perpHistory?: PriceHistory
  ): ISignal {
    // Get or create price history
    const key = `${exchange}:${instrument}`;
    if (!this.priceHistories.has(key)) {
      this.priceHistories.set(key, new PriceHistory());
      this.spreadHistories.set(key, []);
      this.imbalanceHistories.set(key, []);
    }

    const history = this.priceHistories.get(key)!;
    const spreadHist = this.spreadHistories.get(key)!;
    const imbalanceHist = this.imbalanceHistories.get(key)!;

    // Update history with latest price
    if (orderbook && orderbook.midPrice > 0) {
      const totalVolume = orderbook.bids.reduce((s, l) => s + l.size, 0) +
                          orderbook.asks.reduce((s, l) => s + l.size, 0);
      history.push(orderbook.midPrice, totalVolume);
      spreadHist.push(orderbook.spread);
      if (spreadHist.length > 200) spreadHist.shift();
    }

    // Generate all signal components
    const components: ISignalComponent[] = [];

    // 1. Momentum
    components.push(momentumSignal(history));

    // 2. Mean Reversion
    components.push(meanReversionSignal(history));

    // 3. Microstructure
    const microSig = microstructureSignal(orderbook, imbalanceHist);
    components.push(microSig);
    imbalanceHist.push(microSig.value);
    if (imbalanceHist.length > 200) imbalanceHist.shift();

    // 4. Cross-asset (if we have perp data)
    if (perpHistory && perpHistory.length() > 20) {
      components.push(crossAssetSignal(perpHistory, history));
    }

    // 5. Spread Regime
    components.push(spreadRegimeSignal(orderbook, spreadHist));

    // 6. Volume Profile
    components.push(volumeProfileSignal(history));

    // Combine signals using meta-learner
    const { conviction, confidence } = this.signalCombiner.combine(components);

    // Determine direction
    let direction: "LONG" | "SHORT" | "FLAT" = "FLAT";
    if (conviction > RISK_PARAMETERS.minConviction && confidence > RISK_PARAMETERS.minConfidence) {
      direction = "LONG";
    } else if (conviction < -RISK_PARAMETERS.minConviction && confidence > RISK_PARAMETERS.minConfidence) {
      direction = "SHORT";
    }

    // Expected return based on historical edge and current conviction
    const vol = history.getVolatility(40);
    const expectedReturn = Math.abs(conviction) * 100 * (1 + confidence); // bps estimate

    // Expected hold time based on strategy type
    const dominantStrategy = this.getDominantStrategy(components);
    const holdTimes: Record<StrategyType, number> = {
      momentum: 60_000,
      mean_reversion: 45_000,
      microstructure: 15_000,
      cross_asset: 30_000,
      ml_ensemble: 30_000,
      spread_capture: 20_000,
      book_imbalance: 15_000,
      vpin_toxicity: 30_000,
      hl_momentum_scalp: 20_000,
      hl_mean_revert: 30_000,
    };

    return {
      id: uuidv4(),
      timestamp: Date.now(),
      instrument,
      exchange,
      direction,
      conviction,
      confidence,
      expectedReturn,
      expectedHoldTime: holdTimes[dominantStrategy] || 30_000,
      strategy: dominantStrategy,
      components,
      metadata: {
        volatility: vol,
        priceHistoryLength: history.length(),
        spreadMean: spreadHist.length > 0 ? mean(spreadHist) : 0,
        edgeMultiplier: this.edgeMonitor.getSizeMultiplier(),
      },
    };
  }

  /**
   * Make a complete trade decision: should we enter, exit, or hold?
   * Evaluates entry rules, position sizing, and exit parameters.
   */
  makeTradeDecision(
    signal: ISignal,
    orderbook: IUnifiedOrderbook | null,
    currentExposure: number,
    totalBalance: number,
    openPositionCount: number,
    exchangePositionCount: number,
    recentPnl1h: number
  ): ITradeDecision {
    // Check if edge monitor has halted the strategy
    if (this.edgeMonitor.isHalted()) {
      return this.noTradeDecision(signal, "Edge decay: strategy halted");
    }

    // Only trade if signal has direction
    if (signal.direction === "FLAT") {
      return this.noTradeDecision(signal, "No signal");
    }

    // Evaluate ALL entry rules
    const entryRules = evaluateEntryRules(
      signal,
      orderbook,
      currentExposure,
      recentPnl1h,
      totalBalance,
      openPositionCount,
      exchangePositionCount
    );

    // ALL rules must pass
    const allPassed = entryRules.every(r => r.passed);
    if (!allPassed) {
      const failedRules = entryRules.filter(r => !r.passed).map(r => r.name);
      return this.noTradeDecision(signal, `Failed rules: ${failedRules.join(", ")}`);
    }

    // Position sizing via Kelly
    const winRate = this.tradeCount > 20 ? this.wins / this.tradeCount : 0.55;
    const avgWin = this.wins > 0 ? this.totalPnl / this.wins : 0.01;
    const avgLoss = this.losses > 0 ? Math.abs(this.totalPnl) / this.losses : 0.005;
    const vol = signal.metadata.volatility || 0.01;

    const { size, kellyF } = kellyPositionSize(
      winRate,
      avgWin,
      avgLoss,
      signal.conviction,
      signal.confidence,
      vol,
      totalBalance
    );

    // Apply edge decay multiplier
    const adjustedSize = size * this.edgeMonitor.getSizeMultiplier();

    if (adjustedSize < 0.50) {
      return this.noTradeDecision(signal, "Position size too small");
    }

    // Generate exit rules
    const exitRules = generateExitRules(signal, vol);

    // Entry price (use mid or best bid/ask depending on direction)
    let entryPrice = orderbook?.midPrice || 0;
    if (orderbook) {
      if (signal.direction === "LONG" && orderbook.asks.length > 0) {
        entryPrice = orderbook.asks[0].price; // Buy at ask
      } else if (signal.direction === "SHORT" && orderbook.bids.length > 0) {
        entryPrice = orderbook.bids[0].price; // Sell at bid
      }
    }

    // Risk/reward ratio
    const tp = exitRules.find(r => r.type === "take_profit")?.trigger || 0.01;
    const sl = Math.abs(exitRules.find(r => r.type === "stop_loss")?.trigger || 0.01);
    const riskReward = sl > 0 ? tp / sl : 1;

    return {
      signal,
      action: signal.direction === "LONG" ? "OPEN_LONG" : "OPEN_SHORT",
      size: Math.round(adjustedSize * 100) / 100,
      entryPrice,
      entryRules,
      exitRules,
      riskRewardRatio: riskReward,
      kellyFraction: kellyF,
      timestamp: Date.now(),
    };
  }

  /**
   * Record a completed trade for performance tracking and edge monitoring.
   */
  recordCompletedTrade(pnl: number, strategy: StrategyType): void {
    this.tradeCount++;
    this.totalPnl += pnl;
    if (pnl > 0) this.wins++;
    else this.losses++;

    this.edgeMonitor.recordTrade(pnl);
    this.signalCombiner.recordSignalPerformance(strategy, pnl);
  }

  getEdgeMetrics() {
    return this.edgeMonitor.getMetrics();
  }

  getTradeStats() {
    return {
      tradeCount: this.tradeCount,
      totalPnl: this.totalPnl,
      winRate: this.tradeCount > 0 ? this.wins / this.tradeCount : 0,
      wins: this.wins,
      losses: this.losses,
    };
  }

  getPriceHistory(exchange: string, instrument: string): PriceHistory | undefined {
    return this.priceHistories.get(`${exchange}:${instrument}`);
  }

  private getDominantStrategy(components: ISignalComponent[]): StrategyType {
    let maxWeight = 0;
    let dominant: StrategyType = "ml_ensemble";

    const strategyMap: Record<string, StrategyType> = {
      momentum: "momentum",
      mean_reversion: "mean_reversion",
      microstructure: "microstructure",
      cross_asset: "cross_asset",
      spread_regime: "spread_capture",
      volume_profile: "book_imbalance",
    };

    for (const c of components) {
      const contribution = Math.abs(c.value * c.weight);
      if (contribution > maxWeight) {
        maxWeight = contribution;
        dominant = strategyMap[c.name] || "ml_ensemble";
      }
    }

    return dominant;
  }

  private noTradeDecision(signal: ISignal, reason: string): ITradeDecision {
    return {
      signal,
      action: "NO_TRADE",
      size: 0,
      entryPrice: 0,
      entryRules: [],
      exitRules: [],
      riskRewardRatio: 0,
      kellyFraction: 0,
      timestamp: Date.now(),
    };
  }
}
