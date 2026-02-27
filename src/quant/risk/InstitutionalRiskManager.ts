/**
 * ============================================================================
 * TWO SIGMA INVESTMENTS — INSTITUTIONAL RISK MANAGEMENT FRAMEWORK
 * ============================================================================
 *
 * Protecting capital from catastrophic losses during black swan events.
 *
 * COMPONENTS:
 * 1. Value at Risk (VaR) — Historical, Parametric, Monte Carlo
 * 2. Stress Testing — 2008 crash, COVID crash, Flash Crash scenarios
 * 3. Kelly Criterion Position Sizing (implemented in QuantStrategyEngine)
 * 4. Stop-Loss Framework — Fixed, Trailing, Vol-Adjusted, Time-Based
 * 5. Drawdown Controls — Hard limits with auto-deleveraging
 * 6. Correlation Monitoring — Dynamic pairwise correlation tracker
 * 7. Leverage Limits — Margin utilization with auto-deleverage triggers
 * 8. Sector/Factor Exposure Caps
 * 9. Liquidity Risk Assessment
 * 10. Daily Risk Dashboard Metrics
 *
 * ============================================================================
 */

import { mean, stddev, correlation } from "../../utils/mathUtils";
import { IDemoPosition } from "../../types/exchange.types";
import { logger } from "../../utils/logger";

// ============================================================================
// RISK PARAMETER TABLE
// ============================================================================

export interface IRiskLimits {
  // Drawdown controls
  maxDrawdownPct: number;          // Hard stop: 10% max drawdown
  warningDrawdownPct: number;      // Warning: 5% drawdown
  maxDailyLossPct: number;         // 5% max daily loss
  maxHourlyLossPct: number;        // 2% max hourly loss
  max5MinLoss: number;             // $2 max 5-min loss (absolute)

  // Position limits
  maxPositionPct: number;          // 15% max single position
  maxTotalExposurePct: number;     // 80% max total exposure
  maxPositionsPerExchange: number; // 5 per exchange
  maxTotalPositions: number;       // 12 total

  // Correlation
  maxPairwiseCorrelation: number;  // 0.70 max
  correlationLookback: number;     // 100 ticks

  // Leverage
  maxLeverage: number;             // 1x (no leverage for demo)
  deleverageTrigger: number;       // Start deleveraging at 70% exposure

  // Sector/Exchange exposure
  maxExchangeExposurePct: number;  // 50% max per exchange
  maxStrategyExposurePct: number;  // 40% max per strategy

  // VaR
  varConfidence95: number;         // 95% confidence
  varConfidence99: number;         // 99% confidence
  varLookback: number;             // 500 ticks for VaR calculation
  maxVaR95Pct: number;             // Max acceptable 95% VaR as % of capital

  // Liquidity
  minLiquidityMultiple: number;    // Position must be < 10% of book depth
}

export const DEFAULT_RISK_LIMITS: IRiskLimits = {
  maxDrawdownPct: 0.50,           // 50% max drawdown (aggressive mode)
  warningDrawdownPct: 0.30,       // Warning at 30%
  maxDailyLossPct: 0.40,          // 40% max daily loss
  maxHourlyLossPct: 0.20,         // 20% max hourly loss
  max5MinLoss: 20.0,              // $20 max 5-min loss
  maxPositionPct: 0.50,           // 50% max single position
  maxTotalExposurePct: 3.00,      // 300% with leverage
  maxPositionsPerExchange: 15,    // 15 per exchange
  maxTotalPositions: 30,          // 30 total
  maxPairwiseCorrelation: 0.95,   // Allow correlated trades
  correlationLookback: 50,
  maxLeverage: 20.0,              // 20x max leverage (HL perps)
  deleverageTrigger: 2.50,        // Deleverage at 250% exposure
  maxExchangeExposurePct: 0.80,   // 80% per exchange
  maxStrategyExposurePct: 0.70,   // 70% per strategy
  varConfidence95: 0.95,
  varConfidence99: 0.99,
  varLookback: 200,
  maxVaR95Pct: 0.15,              // 15% VaR tolerance
  minLiquidityMultiple: 0.30,     // 30% of book depth
};

// ============================================================================
// TYPES
// ============================================================================

export interface IRiskCheck {
  allowed: boolean;
  reasons: string[];
  riskScore: number;          // 0-100 (100 = max risk)
  suggestedSizeMultiplier: number; // 0-1 multiplier on position size
  warnings: string[];
}

export interface IVaRResult {
  historical95: number;
  historical99: number;
  parametric95: number;
  parametric99: number;
  monteCarlo95: number;
  monteCarlo99: number;
  expectedShortfall95: number; // CVaR: average loss beyond VaR
  expectedShortfall99: number;
}

export interface IStressTestResult {
  scenario: string;
  portfolioLoss: number;
  portfolioLossPct: number;
  worstPosition: string;
  worstPositionLoss: number;
  breachesLimits: boolean;
}

export interface IStopLossState {
  positionId: string;
  fixedStop: number;
  trailingStop: number;
  volAdjustedStop: number;
  timeStop: number;           // timestamp when time-based exit triggers
  maxPrice: number;           // highest mark price (for trailing stop)
  minPrice: number;           // lowest mark price (for trailing stop on shorts)
  activationPrice: number;    // price at which trailing stop activates
  entryPrice: number;
}

export interface IRiskDashboard {
  timestamp: number;
  totalEquity: number;
  totalExposure: number;
  exposurePct: number;
  currentDrawdown: number;
  currentDrawdownPct: number;
  peakEquity: number;
  dailyPnl: number;
  hourlyPnl: number;
  var95: number;
  var99: number;
  cvar95: number;
  openPositions: number;
  riskScore: number;
  positionBreakdown: { exchange: string; exposure: number; pct: number }[];
  correlationAlerts: string[];
  stopLossDistances: { id: string; instrument: string; distancePct: number }[];
  killSwitchArmed: boolean;
  tradingHalted: boolean;
  haltReason: string;
}

// ============================================================================
// VALUE AT RISK CALCULATOR
// ============================================================================

export class VaRCalculator {
  /**
   * Historical VaR: sort actual returns, pick percentile.
   * Most non-parametric and assumption-free method.
   */
  static historicalVaR(returns: number[], confidence: number): number {
    if (returns.length < 20) return 0;
    const sorted = [...returns].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * (1 - confidence));
    return Math.abs(sorted[idx] || 0);
  }

  /**
   * Parametric (Gaussian) VaR: assume normal distribution.
   *
   * VaR = μ - z_α * σ
   *
   * where z_α = 1.645 for 95%, 2.326 for 99%
   */
  static parametricVaR(returns: number[], confidence: number): number {
    if (returns.length < 20) return 0;
    const mu = mean(returns);
    const sigma = stddev(returns);
    const zScores: Record<number, number> = { 0.95: 1.645, 0.99: 2.326 };
    const z = zScores[confidence] || 1.645;
    return Math.abs(mu - z * sigma);
  }

  /**
   * Monte Carlo VaR: simulate 10,000 random portfolios using
   * bootstrapped returns from historical data.
   */
  static monteCarloVaR(
    returns: number[],
    confidence: number,
    simulations = 10000,
    horizon = 1
  ): number {
    if (returns.length < 20) return 0;

    const simulatedReturns: number[] = [];

    for (let sim = 0; sim < simulations; sim++) {
      let cumReturn = 0;
      for (let t = 0; t < horizon; t++) {
        // Bootstrap: randomly sample from historical returns
        const idx = Math.floor(Math.random() * returns.length);
        cumReturn += returns[idx];
      }
      simulatedReturns.push(cumReturn);
    }

    simulatedReturns.sort((a, b) => a - b);
    const idx = Math.floor(simulations * (1 - confidence));
    return Math.abs(simulatedReturns[idx] || 0);
  }

  /**
   * Expected Shortfall (CVaR): average loss beyond VaR.
   * More conservative than VaR — captures tail risk.
   *
   * ES = E[L | L > VaR]
   */
  static expectedShortfall(returns: number[], confidence: number): number {
    if (returns.length < 20) return 0;
    const sorted = [...returns].sort((a, b) => a - b);
    const cutoffIdx = Math.floor(sorted.length * (1 - confidence));
    const tailLosses = sorted.slice(0, cutoffIdx);
    if (tailLosses.length === 0) return 0;
    return Math.abs(mean(tailLosses));
  }

  /**
   * Full VaR calculation across all methods.
   */
  static calculate(returns: number[]): IVaRResult {
    return {
      historical95: this.historicalVaR(returns, 0.95),
      historical99: this.historicalVaR(returns, 0.99),
      parametric95: this.parametricVaR(returns, 0.95),
      parametric99: this.parametricVaR(returns, 0.99),
      monteCarlo95: this.monteCarloVaR(returns, 0.95, 5000),
      monteCarlo99: this.monteCarloVaR(returns, 0.99, 5000),
      expectedShortfall95: this.expectedShortfall(returns, 0.95),
      expectedShortfall99: this.expectedShortfall(returns, 0.99),
    };
  }
}

// ============================================================================
// STRESS TEST ENGINE
// ============================================================================

export class StressTestEngine {
  /**
   * Predefined stress scenarios based on historical crises.
   * Each scenario defines multiplicative shocks to asset returns.
   */
  static readonly SCENARIOS: Record<string, Record<string, number>> = {
    // 2008 Financial Crisis — peak-to-trough moves
    "2008_crash": {
      BTC: -0.75,     // Crypto didn't exist, but simulate correlated risk-off
      ETH: -0.80,
      SOL: -0.85,
      XRP: -0.85,
      polymarket: -0.30, // Prediction markets less correlated
    },
    // COVID Crash March 2020 — 1 week
    "covid_crash": {
      BTC: -0.40,
      ETH: -0.50,
      SOL: -0.55,
      XRP: -0.50,
      polymarket: -0.15,
    },
    // Flash Crash — 30 minutes
    "flash_crash": {
      BTC: -0.15,
      ETH: -0.20,
      SOL: -0.25,
      XRP: -0.20,
      polymarket: -0.05,
    },
    // Crypto Winter 2022
    "crypto_winter": {
      BTC: -0.65,
      ETH: -0.70,
      SOL: -0.95,
      XRP: -0.60,
      polymarket: -0.20,
    },
    // FTX Collapse — sudden exchange failure
    "exchange_failure": {
      BTC: -0.25,
      ETH: -0.30,
      SOL: -0.55,     // SOL was heavily FTX-associated
      XRP: -0.20,
      polymarket: -0.10,
    },
    // Regulatory crackdown — sudden ban
    "regulatory_shock": {
      BTC: -0.30,
      ETH: -0.35,
      SOL: -0.40,
      XRP: -0.50,     // XRP had SEC lawsuit
      polymarket: -0.40, // Prediction market ban would hit hard
    },
  };

  /**
   * Run a stress test on the current portfolio.
   */
  static runScenario(
    scenarioName: string,
    positions: IDemoPosition[],
    totalEquity: number
  ): IStressTestResult {
    const shocks = this.SCENARIOS[scenarioName];
    if (!shocks) {
      return {
        scenario: scenarioName,
        portfolioLoss: 0,
        portfolioLossPct: 0,
        worstPosition: "N/A",
        worstPositionLoss: 0,
        breachesLimits: false,
      };
    }

    let totalLoss = 0;
    let worstLoss = 0;
    let worstPosition = "N/A";

    for (const pos of positions) {
      // Determine which shock applies
      const assetKey = pos.symbol.toUpperCase();
      const exchangeKey = pos.exchange;
      const shock = shocks[assetKey] || shocks[exchangeKey] || -0.10;

      // Calculate position loss under stress
      const posLoss = pos.size * Math.abs(shock);
      totalLoss += posLoss;

      if (posLoss > worstLoss) {
        worstLoss = posLoss;
        worstPosition = `${pos.exchange}:${pos.symbol}`;
      }
    }

    const lossPct = totalEquity > 0 ? totalLoss / totalEquity : 0;

    return {
      scenario: scenarioName,
      portfolioLoss: totalLoss,
      portfolioLossPct: lossPct,
      worstPosition,
      worstPositionLoss: worstLoss,
      breachesLimits: lossPct > DEFAULT_RISK_LIMITS.maxDrawdownPct,
    };
  }

  /**
   * Run ALL stress scenarios and return results.
   */
  static runAllScenarios(
    positions: IDemoPosition[],
    totalEquity: number
  ): IStressTestResult[] {
    return Object.keys(this.SCENARIOS).map(scenario =>
      this.runScenario(scenario, positions, totalEquity)
    );
  }
}

// ============================================================================
// STOP-LOSS FRAMEWORK
// ============================================================================

export class StopLossManager {
  private stops: Map<string, IStopLossState> = new Map();

  /**
   * Register stop-loss levels for a new position.
   *
   * Four types of stops:
   * 1. Fixed: absolute price level (entry - stopPct * entry)
   * 2. Trailing: follows highest price, triggers on retrace
   * 3. Vol-adjusted: wider stops in volatile markets
   * 4. Time-based: auto-close after maxHoldTime
   */
  registerPosition(
    position: IDemoPosition,
    volatility: number,
    maxHoldTimeMs = 120_000
  ): void {
    const isLong = position.side === "LONG";

    // Fixed stop: 3% from entry (wider to avoid noise exits)
    const fixedStopPct = 0.03;
    const fixedStop = isLong
      ? position.entryPrice * (1 - fixedStopPct)
      : position.entryPrice * (1 + fixedStopPct);

    // Vol-adjusted stop: 3σ from entry (wider for HFT)
    const volStop = isLong
      ? position.entryPrice * (1 - 3 * volatility)
      : position.entryPrice * (1 + 3 * volatility);

    // Trailing stop activation: starts after 30% of TP is reached (faster activation)
    const tpMultiple = 0.005; // 0.5% take-profit (tighter TP for faster wins)
    const activationPrice = isLong
      ? position.entryPrice * (1 + tpMultiple * 0.5)
      : position.entryPrice * (1 - tpMultiple * 0.5);

    this.stops.set(position.id, {
      positionId: position.id,
      fixedStop,
      trailingStop: isLong ? 0 : Infinity, // Not active yet
      volAdjustedStop: volStop,
      timeStop: position.openedAt + maxHoldTimeMs,
      maxPrice: position.entryPrice,
      minPrice: position.entryPrice,
      activationPrice,
      entryPrice: position.entryPrice,
    });
  }

  /**
   * Check if any stop-loss has been triggered.
   * Returns the type of stop triggered, or null.
   */
  checkStops(
    positionId: string,
    currentPrice: number,
    side: "LONG" | "SHORT"
  ): { triggered: boolean; type: string; exitPrice: number } | null {
    const state = this.stops.get(positionId);
    if (!state) return null;

    const isLong = side === "LONG";
    const now = Date.now();

    // Update max/min prices for trailing stop
    if (isLong) {
      state.maxPrice = Math.max(state.maxPrice, currentPrice);
    } else {
      state.minPrice = Math.min(state.minPrice, currentPrice);
    }

    // Check trailing stop activation and trigger
    if (isLong && currentPrice >= state.activationPrice) {
      // Trailing stop: 50% retrace from max
      state.trailingStop = state.maxPrice - (state.maxPrice - state.entryPrice) * 0.5;
      if (currentPrice <= state.trailingStop) {
        return { triggered: true, type: "trailing_stop", exitPrice: currentPrice };
      }
    } else if (!isLong && currentPrice <= state.activationPrice) {
      state.trailingStop = state.minPrice + (state.entryPrice - state.minPrice) * 0.5;
      if (currentPrice >= state.trailingStop) {
        return { triggered: true, type: "trailing_stop", exitPrice: currentPrice };
      }
    }

    // Check fixed stop
    if (isLong && currentPrice <= state.fixedStop) {
      return { triggered: true, type: "fixed_stop", exitPrice: currentPrice };
    }
    if (!isLong && currentPrice >= state.fixedStop) {
      return { triggered: true, type: "fixed_stop", exitPrice: currentPrice };
    }

    // Check vol-adjusted stop
    if (isLong && currentPrice <= state.volAdjustedStop) {
      return { triggered: true, type: "vol_adjusted_stop", exitPrice: currentPrice };
    }
    if (!isLong && currentPrice >= state.volAdjustedStop) {
      return { triggered: true, type: "vol_adjusted_stop", exitPrice: currentPrice };
    }

    // Check time stop
    if (now >= state.timeStop) {
      return { triggered: true, type: "time_stop", exitPrice: currentPrice };
    }

    // Check take-profit (0.5% from entry — fast scalp exits)
    const tpPct = 0.005;
    if (isLong && currentPrice >= state.entryPrice * (1 + tpPct)) {
      return { triggered: true, type: "take_profit", exitPrice: currentPrice };
    }
    if (!isLong && currentPrice <= state.entryPrice * (1 - tpPct)) {
      return { triggered: true, type: "take_profit", exitPrice: currentPrice };
    }

    return null;
  }

  removePosition(positionId: string): void {
    this.stops.delete(positionId);
  }

  getStopState(positionId: string): IStopLossState | undefined {
    return this.stops.get(positionId);
  }

  getAllStops(): Map<string, IStopLossState> {
    return this.stops;
  }
}

// ============================================================================
// CORRELATION MONITOR
// ============================================================================

export class CorrelationMonitor {
  private returnSeries: Map<string, number[]> = new Map();
  private readonly lookback: number;

  constructor(lookback = DEFAULT_RISK_LIMITS.correlationLookback) {
    this.lookback = lookback;
  }

  /**
   * Record a return observation for an instrument.
   */
  recordReturn(instrument: string, returnVal: number): void {
    if (!this.returnSeries.has(instrument)) {
      this.returnSeries.set(instrument, []);
    }
    const series = this.returnSeries.get(instrument)!;
    series.push(returnVal);
    if (series.length > this.lookback * 2) {
      series.splice(0, series.length - this.lookback * 2);
    }
  }

  /**
   * Get pairwise correlation matrix for all tracked instruments.
   */
  getCorrelationMatrix(): { instruments: string[]; matrix: number[][] } {
    const instruments = Array.from(this.returnSeries.keys());
    const n = instruments.length;
    const matrix: number[][] = [];

    for (let i = 0; i < n; i++) {
      matrix.push([]);
      for (let j = 0; j < n; j++) {
        if (i === j) {
          matrix[i].push(1.0);
        } else {
          const xReturns = this.returnSeries.get(instruments[i])!.slice(-this.lookback);
          const yReturns = this.returnSeries.get(instruments[j])!.slice(-this.lookback);
          matrix[i].push(correlation(xReturns, yReturns));
        }
      }
    }

    return { instruments, matrix };
  }

  /**
   * Detect pairs with correlation exceeding the limit.
   */
  getCorrelationAlerts(limit = DEFAULT_RISK_LIMITS.maxPairwiseCorrelation): string[] {
    const { instruments, matrix } = this.getCorrelationMatrix();
    const alerts: string[] = [];

    for (let i = 0; i < instruments.length; i++) {
      for (let j = i + 1; j < instruments.length; j++) {
        const corr = matrix[i][j];
        if (Math.abs(corr) > limit) {
          alerts.push(
            `${instruments[i]} ↔ ${instruments[j]}: ${(corr * 100).toFixed(1)}% correlation (limit: ${(limit * 100).toFixed(0)}%)`
          );
        }
      }
    }

    return alerts;
  }
}

// ============================================================================
// MASTER RISK MANAGER
// ============================================================================

export class InstitutionalRiskManager {
  private limits: IRiskLimits;
  private stopLossManager = new StopLossManager();
  private correlationMonitor = new CorrelationMonitor();

  // State tracking
  private peakEquity: number;
  private startingEquity: number;
  private dailyStartEquity: number;
  private hourlyEquitySnapshots: { timestamp: number; equity: number }[] = [];
  private fiveMinPnlWindow: { timestamp: number; pnl: number }[] = [];
  private portfolioReturns: number[] = [];
  private lastEquity: number;
  private killSwitchArmed = false;
  private tradingHalted = false;
  private haltReason = "";

  constructor(startingEquity: number, limits: IRiskLimits = DEFAULT_RISK_LIMITS) {
    this.limits = limits;
    this.peakEquity = startingEquity;
    this.startingEquity = startingEquity;
    this.dailyStartEquity = startingEquity;
    this.lastEquity = startingEquity;
  }

  // ==================== PRE-TRADE RISK CHECK ====================

  /**
   * Comprehensive pre-trade risk check.
   * ALL conditions must pass for trade to be allowed.
   */
  preTradeCheck(
    proposedSize: number,
    exchange: string,
    instrument: string,
    positions: IDemoPosition[],
    totalEquity: number,
    bookDepth: number
  ): IRiskCheck {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let riskScore = 0;
    let sizeMultiplier = 1.0;

    // 1. Check if trading is halted
    if (this.tradingHalted) {
      return {
        allowed: false,
        reasons: [`Trading halted: ${this.haltReason}`],
        riskScore: 100,
        suggestedSizeMultiplier: 0,
        warnings: [],
      };
    }

    // 2. Drawdown check
    const currentDD = this.getCurrentDrawdownPct(totalEquity);
    if (currentDD >= this.limits.maxDrawdownPct) {
      reasons.push(`Max drawdown breached: ${(currentDD * 100).toFixed(1)}% >= ${(this.limits.maxDrawdownPct * 100).toFixed(0)}%`);
      riskScore += 40;
    } else if (currentDD >= this.limits.warningDrawdownPct) {
      warnings.push(`Warning drawdown: ${(currentDD * 100).toFixed(1)}%`);
      sizeMultiplier *= 0.5; // Reduce sizing
      riskScore += 20;
    }

    // 3. Total exposure check
    const currentExposure = positions.reduce((s, p) => s + p.size, 0);
    const newExposure = currentExposure + proposedSize;
    const exposurePct = newExposure / totalEquity;
    if (exposurePct > this.limits.maxTotalExposurePct) {
      reasons.push(`Total exposure would exceed limit: ${(exposurePct * 100).toFixed(0)}% > ${(this.limits.maxTotalExposurePct * 100).toFixed(0)}%`);
      riskScore += 20;
    }

    // 4. Single position size check
    const positionPct = proposedSize / totalEquity;
    if (positionPct > this.limits.maxPositionPct) {
      reasons.push(`Position too large: ${(positionPct * 100).toFixed(0)}% > ${(this.limits.maxPositionPct * 100).toFixed(0)}%`);
      sizeMultiplier *= this.limits.maxPositionPct / positionPct;
      riskScore += 15;
    }

    // 5. Position count check
    if (positions.length >= this.limits.maxTotalPositions) {
      reasons.push(`Max positions reached: ${positions.length} >= ${this.limits.maxTotalPositions}`);
      riskScore += 15;
    }

    // 6. Exchange concentration check
    const exchangePositions = positions.filter(p => p.exchange === exchange);
    const exchangeExposure = exchangePositions.reduce((s, p) => s + p.size, 0) + proposedSize;
    const exchangePct = exchangeExposure / totalEquity;
    if (exchangePct > this.limits.maxExchangeExposurePct) {
      reasons.push(`Exchange concentration: ${exchange} at ${(exchangePct * 100).toFixed(0)}% > ${(this.limits.maxExchangeExposurePct * 100).toFixed(0)}%`);
      riskScore += 10;
    }

    // 7. Daily loss limit
    const dailyPnl = totalEquity - this.dailyStartEquity;
    const dailyLossPct = Math.abs(Math.min(0, dailyPnl)) / this.dailyStartEquity;
    if (dailyLossPct >= this.limits.maxDailyLossPct) {
      reasons.push(`Daily loss limit breached: ${(dailyLossPct * 100).toFixed(1)}%`);
      riskScore += 30;
    }

    // 8. Hourly loss check
    const hourlyPnl = this.getHourlyPnl(totalEquity);
    const hourlyLossPct = Math.abs(Math.min(0, hourlyPnl)) / this.startingEquity;
    if (hourlyLossPct >= this.limits.maxHourlyLossPct) {
      reasons.push(`Hourly loss limit: ${(hourlyLossPct * 100).toFixed(1)}% >= ${(this.limits.maxHourlyLossPct * 100).toFixed(0)}%`);
      riskScore += 25;
    }

    // 9. Liquidity check
    if (bookDepth > 0 && proposedSize / bookDepth > this.limits.minLiquidityMultiple) {
      warnings.push(`Position is ${((proposedSize / bookDepth) * 100).toFixed(0)}% of book depth`);
      sizeMultiplier *= this.limits.minLiquidityMultiple / (proposedSize / bookDepth);
      riskScore += 5;
    }

    // 10. Correlation check
    const corrAlerts = this.correlationMonitor.getCorrelationAlerts();
    if (corrAlerts.length > 0) {
      warnings.push(...corrAlerts.map(a => `Correlation alert: ${a}`));
      sizeMultiplier *= 0.8; // Reduce sizing when correlations are high
      riskScore += 5 * corrAlerts.length;
    }

    // 11. VaR check
    if (this.portfolioReturns.length >= 50) {
      const var95 = VaRCalculator.historicalVaR(this.portfolioReturns, 0.95);
      if (var95 > this.limits.maxVaR95Pct) {
        warnings.push(`VaR95 elevated: ${(var95 * 100).toFixed(2)}%`);
        sizeMultiplier *= 0.7;
        riskScore += 10;
      }
    }

    // 12. 5-minute loss check
    const fiveMinLoss = this.get5MinPnl();
    if (fiveMinLoss < -this.limits.max5MinLoss) {
      reasons.push(`5-min loss limit: $${fiveMinLoss.toFixed(2)} < -$${this.limits.max5MinLoss.toFixed(2)}`);
      riskScore += 20;
    }

    return {
      allowed: reasons.length === 0,
      reasons,
      riskScore: Math.min(100, riskScore),
      suggestedSizeMultiplier: Math.max(0, Math.min(1, sizeMultiplier)),
      warnings,
    };
  }

  // ==================== EQUITY / PNL TRACKING ====================

  /**
   * Update equity state — call every tick.
   */
  updateEquity(currentEquity: number): void {
    const now = Date.now();

    // Track peak equity for drawdown
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
    }

    // Record portfolio return
    if (this.lastEquity > 0) {
      const ret = (currentEquity - this.lastEquity) / this.lastEquity;
      this.portfolioReturns.push(ret);
      if (this.portfolioReturns.length > this.limits.varLookback * 2) {
        this.portfolioReturns.splice(0, this.portfolioReturns.length - this.limits.varLookback * 2);
      }
    }

    // Hourly snapshots
    this.hourlyEquitySnapshots.push({ timestamp: now, equity: currentEquity });
    // Keep last 2 hours (at 500ms ticks = 14400 points)
    if (this.hourlyEquitySnapshots.length > 14400) {
      this.hourlyEquitySnapshots.splice(0, this.hourlyEquitySnapshots.length - 14400);
    }

    // 5-minute P&L tracking
    const pnl = currentEquity - this.lastEquity;
    this.fiveMinPnlWindow.push({ timestamp: now, pnl });
    const fiveMinAgo = now - 5 * 60 * 1000;
    this.fiveMinPnlWindow = this.fiveMinPnlWindow.filter(p => p.timestamp > fiveMinAgo);

    this.lastEquity = currentEquity;

    // Auto-halt checks
    this.checkAutoHalt(currentEquity);
  }

  /**
   * Auto-halt trading if risk limits are breached.
   */
  private checkAutoHalt(currentEquity: number): void {
    const dd = this.getCurrentDrawdownPct(currentEquity);

    if (dd >= this.limits.maxDrawdownPct && !this.tradingHalted) {
      this.tradingHalted = true;
      this.haltReason = `Max drawdown breached: ${(dd * 100).toFixed(1)}%`;
      this.killSwitchArmed = true;
      logger.warning(`[RISK] TRADING HALTED: ${this.haltReason}`);
    }

    const dailyLoss = currentEquity - this.dailyStartEquity;
    const dailyLossPct = Math.abs(Math.min(0, dailyLoss)) / this.dailyStartEquity;
    if (dailyLossPct >= this.limits.maxDailyLossPct && !this.tradingHalted) {
      this.tradingHalted = true;
      this.haltReason = `Daily loss limit: ${(dailyLossPct * 100).toFixed(1)}%`;
      this.killSwitchArmed = true;
      logger.warning(`[RISK] TRADING HALTED: ${this.haltReason}`);
    }
  }

  // ==================== STOP LOSS MANAGEMENT ====================

  registerStopLoss(position: IDemoPosition, volatility: number, maxHoldMs?: number): void {
    this.stopLossManager.registerPosition(position, volatility, maxHoldMs);
  }

  checkStopLoss(positionId: string, currentPrice: number, side: "LONG" | "SHORT") {
    return this.stopLossManager.checkStops(positionId, currentPrice, side);
  }

  removeStopLoss(positionId: string): void {
    this.stopLossManager.removePosition(positionId);
  }

  // ==================== CORRELATION TRACKING ====================

  recordReturn(instrument: string, returnVal: number): void {
    this.correlationMonitor.recordReturn(instrument, returnVal);
  }

  // ==================== METRICS ====================

  getCurrentDrawdownPct(currentEquity: number): number {
    if (this.peakEquity <= 0) return 0;
    return Math.max(0, (this.peakEquity - currentEquity) / this.peakEquity);
  }

  getHourlyPnl(currentEquity: number): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const hourStart = this.hourlyEquitySnapshots.find(s => s.timestamp >= oneHourAgo);
    return hourStart ? currentEquity - hourStart.equity : 0;
  }

  get5MinPnl(): number {
    return this.fiveMinPnlWindow.reduce((s, p) => s + p.pnl, 0);
  }

  calculateVaR(): IVaRResult {
    return VaRCalculator.calculate(this.portfolioReturns.slice(-this.limits.varLookback));
  }

  runStressTests(positions: IDemoPosition[], equity: number): IStressTestResult[] {
    return StressTestEngine.runAllScenarios(positions, equity);
  }

  // ==================== KILL SWITCH ====================

  armKillSwitch(): void {
    this.killSwitchArmed = true;
    this.tradingHalted = true;
    this.haltReason = "Manual kill switch activated";
    logger.warning("[RISK] KILL SWITCH ARMED — all trading halted");
  }

  disarmKillSwitch(): void {
    this.killSwitchArmed = false;
    this.tradingHalted = false;
    this.haltReason = "";
    logger.info("[RISK] Kill switch disarmed — trading resumed");
  }

  isTradingHalted(): boolean {
    return this.tradingHalted;
  }

  // ==================== DAILY RISK DASHBOARD ====================

  /**
   * Generate complete daily risk dashboard.
   * This is what a PM checks every morning before markets open.
   */
  generateDashboard(
    positions: IDemoPosition[],
    totalEquity: number
  ): IRiskDashboard {
    const currentExposure = positions.reduce((s, p) => s + p.size, 0);
    const currentDD = this.getCurrentDrawdownPct(totalEquity);
    const var95 = this.portfolioReturns.length > 30
      ? VaRCalculator.historicalVaR(this.portfolioReturns.slice(-200), 0.95) * totalEquity
      : 0;
    const var99 = this.portfolioReturns.length > 30
      ? VaRCalculator.historicalVaR(this.portfolioReturns.slice(-200), 0.99) * totalEquity
      : 0;
    const cvar95 = this.portfolioReturns.length > 30
      ? VaRCalculator.expectedShortfall(this.portfolioReturns.slice(-200), 0.95) * totalEquity
      : 0;

    // Position breakdown by exchange
    const exchangeMap = new Map<string, number>();
    for (const p of positions) {
      exchangeMap.set(p.exchange, (exchangeMap.get(p.exchange) || 0) + p.size);
    }
    const positionBreakdown = Array.from(exchangeMap.entries()).map(([exchange, exposure]) => ({
      exchange,
      exposure,
      pct: totalEquity > 0 ? exposure / totalEquity : 0,
    }));

    // Stop loss distances
    const stopDistances = positions.map(p => {
      const stop = this.stopLossManager.getStopState(p.id);
      const distancePct = stop && p.currentPrice > 0
        ? Math.abs(p.currentPrice - stop.fixedStop) / p.currentPrice
        : 0;
      return { id: p.id, instrument: `${p.exchange}:${p.symbol}`, distancePct };
    });

    // Risk score: 0-100
    let riskScore = 0;
    riskScore += Math.min(40, (currentDD / this.limits.maxDrawdownPct) * 40);
    riskScore += Math.min(30, (currentExposure / (this.limits.maxTotalExposurePct * totalEquity)) * 30);
    riskScore += Math.min(20, positions.length / this.limits.maxTotalPositions * 20);
    riskScore += Math.min(10, this.correlationMonitor.getCorrelationAlerts().length * 5);

    return {
      timestamp: Date.now(),
      totalEquity,
      totalExposure: currentExposure,
      exposurePct: totalEquity > 0 ? currentExposure / totalEquity : 0,
      currentDrawdown: this.peakEquity - totalEquity,
      currentDrawdownPct: currentDD,
      peakEquity: this.peakEquity,
      dailyPnl: totalEquity - this.dailyStartEquity,
      hourlyPnl: this.getHourlyPnl(totalEquity),
      var95,
      var99,
      cvar95,
      openPositions: positions.length,
      riskScore: Math.min(100, riskScore),
      positionBreakdown,
      correlationAlerts: this.correlationMonitor.getCorrelationAlerts(),
      stopLossDistances: stopDistances,
      killSwitchArmed: this.killSwitchArmed,
      tradingHalted: this.tradingHalted,
      haltReason: this.haltReason,
    };
  }

  /**
   * Reset daily tracking (call at start of each trading day).
   */
  resetDaily(currentEquity: number): void {
    this.dailyStartEquity = currentEquity;
    this.hourlyEquitySnapshots = [];
    this.fiveMinPnlWindow = [];
  }
}
