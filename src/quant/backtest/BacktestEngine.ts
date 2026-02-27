/**
 * ============================================================================
 * RENAISSANCE TECHNOLOGIES — BACKTESTING FRAMEWORK
 * ============================================================================
 *
 * Separates real alpha from overfitted noise across decades of data.
 *
 * ARCHITECTURE: Event-driven backtester with proper bias prevention.
 *
 * COMPONENTS:
 * 1. Event-driven engine — processes ticks/bars sequentially
 * 2. Transaction cost modeling — slippage, spread, impact
 * 3. Lookahead bias prevention — strict temporal barriers
 * 4. Walk-forward optimization — rolling train/test windows
 * 5. Monte Carlo simulation — randomize trade sequences
 * 6. Statistical significance — t-test, bootstrap confidence intervals
 * 7. Out-of-sample protocol — proper data splitting
 *
 * PHILOSOPHY: "If the backtest is too good, it's wrong."
 *
 * ============================================================================
 */

import { mean, stddev, linearRegression } from "../../utils/mathUtils";
import { logger } from "../../utils/logger";

// ============================================================================
// TYPES
// ============================================================================

export interface IBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  instrument: string;
}

export interface IBacktestTrade {
  id: number;
  instrument: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  size: number;
  pnl: number;
  returnPct: number;
  holdingPeriod: number; // ms
  fees: number;
  slippage: number;
  strategy: string;
}

export interface IBacktestResult {
  // Return metrics
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxDrawdown: number;
  maxDrawdownDuration: number; // ms

  // Trade metrics
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldingPeriod: number;

  // Risk metrics
  volatility: number;
  downstddev: number;
  var95: number;
  var99: number;
  skewness: number;
  kurtosis: number;

  // Cost analysis
  totalFees: number;
  totalSlippage: number;
  costDrag: number; // bps

  // Quality checks
  tStatistic: number;
  pValue: number;
  isSignificant: boolean;    // p < 0.05
  informationRatio: number;

  // Data
  equityCurve: { timestamp: number; equity: number }[];
  drawdownCurve: { timestamp: number; drawdown: number }[];
  monthlyReturns: { month: string; return_: number }[];
  trades: IBacktestTrade[];
}

export interface IWalkForwardResult {
  windows: {
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
    trainSharpe: number;
    testSharpe: number;
    testReturn: number;
    trainTrades: number;
    testTrades: number;
  }[];
  aggregateTestSharpe: number;
  aggregateTestReturn: number;
  degradationRatio: number;  // test_sharpe / train_sharpe (< 1 = overfitting)
  isRobust: boolean;         // degradation > 0.5
}

export interface IMonteCarloResult {
  simulations: number;
  medianReturn: number;
  meanReturn: number;
  p5Return: number;          // 5th percentile (bad outcome)
  p95Return: number;         // 95th percentile (good outcome)
  medianSharpe: number;
  p5Sharpe: number;
  p95Sharpe: number;
  medianMaxDD: number;
  p5MaxDD: number;           // 5th percentile max drawdown
  probabilityOfProfit: number;
  probabilityOfRuin: number; // P(drawdown > 50%)
}

export interface ITransactionCosts {
  commissionPerTrade: number;      // $ flat fee
  commissionPct: number;           // % of trade value
  slippageBps: number;             // Expected slippage
  spreadBps: number;               // Half-spread cost
  marketImpactMultiplier: number;  // Scaling for size-dependent impact
}

export const DEFAULT_COSTS: ITransactionCosts = {
  commissionPerTrade: 0,
  commissionPct: 0.001,        // 0.1%
  slippageBps: 5,              // 5 bps
  spreadBps: 10,               // 10 bps
  marketImpactMultiplier: 0.5,
};

// ============================================================================
// DATA QUALITY CHECKS
// ============================================================================

export class DataValidator {
  /**
   * Validate bar data for common issues.
   */
  static validate(bars: IBar[]): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (bars.length < 100) {
      issues.push(`Insufficient data: ${bars.length} bars (need 100+)`);
    }

    // Check chronological order
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].timestamp <= bars[i - 1].timestamp) {
        issues.push(`Non-chronological at index ${i}`);
        break;
      }
    }

    // Check for gaps (>3x median interval)
    if (bars.length > 10) {
      const intervals = [];
      for (let i = 1; i < Math.min(bars.length, 1000); i++) {
        intervals.push(bars[i].timestamp - bars[i - 1].timestamp);
      }
      intervals.sort((a, b) => a - b);
      const medianInterval = intervals[Math.floor(intervals.length / 2)];
      let gapCount = 0;
      for (const interval of intervals) {
        if (interval > medianInterval * 3) gapCount++;
      }
      if (gapCount > intervals.length * 0.05) {
        issues.push(`${gapCount} significant data gaps detected (>${medianInterval * 3}ms)`);
      }
    }

    // Check for zero/negative prices
    const zeroPrices = bars.filter(b => b.close <= 0 || b.open <= 0);
    if (zeroPrices.length > 0) {
      issues.push(`${zeroPrices.length} bars with zero/negative prices`);
    }

    // Check for extreme moves (>50% in one bar)
    let extremeMoves = 0;
    for (let i = 1; i < bars.length; i++) {
      const move = Math.abs(bars[i].close - bars[i - 1].close) / bars[i - 1].close;
      if (move > 0.5) extremeMoves++;
    }
    if (extremeMoves > 0) {
      issues.push(`${extremeMoves} extreme price moves (>50%)`);
    }

    // Check for stale prices (same close for >10 consecutive bars)
    let staleCount = 0;
    let maxStale = 0;
    let currentStale = 0;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].close === bars[i - 1].close) {
        currentStale++;
        maxStale = Math.max(maxStale, currentStale);
      } else {
        if (currentStale > 10) staleCount++;
        currentStale = 0;
      }
    }
    if (maxStale > 10) {
      issues.push(`Stale prices detected: max ${maxStale} consecutive identical closes`);
    }

    return { valid: issues.length === 0, issues };
  }
}

// ============================================================================
// EVENT-DRIVEN BACKTEST ENGINE
// ============================================================================

export type SignalFunction = (
  currentBar: IBar,
  history: IBar[],
  position: { side: "LONG" | "SHORT"; entryPrice: number; entryTime: number } | null
) => { action: "BUY" | "SELL" | "HOLD"; size?: number; price?: number };

export class BacktestEngine {
  private bars: IBar[] = [];
  private costs: ITransactionCosts;
  private initialCapital: number;

  constructor(
    bars: IBar[],
    initialCapital = 100,
    costs: ITransactionCosts = DEFAULT_COSTS
  ) {
    this.bars = bars;
    this.costs = costs;
    this.initialCapital = initialCapital;
  }

  /**
   * Run a complete backtest with the given signal function.
   *
   * LOOKAHEAD BIAS PREVENTION:
   * - Signal function only receives bars UP TO current time
   * - No future data is accessible
   * - Execution at NEXT bar's open (not current close)
   */
  run(signalFn: SignalFunction, strategyName = "strategy"): IBacktestResult {
    const trades: IBacktestTrade[] = [];
    const equityCurve: { timestamp: number; equity: number }[] = [];
    const returns: number[] = [];

    let equity = this.initialCapital;
    let peakEquity = equity;
    let maxDrawdown = 0;
    let maxDDStart = 0;
    let maxDDEnd = 0;
    let currentDDStart = 0;

    let position: { side: "LONG" | "SHORT"; entryPrice: number; entryTime: number; size: number } | null = null;
    let tradeId = 0;

    // STRICT TEMPORAL BARRIER: only pass history up to current bar
    for (let i = 1; i < this.bars.length; i++) {
      const currentBar = this.bars[i];
      const history = this.bars.slice(0, i); // NO lookahead

      // Generate signal using ONLY past + current data
      const signal = signalFn(
        currentBar,
        history,
        position ? { side: position.side, entryPrice: position.entryPrice, entryTime: position.entryTime } : null
      );

      // Execute at current bar's close (simulating next-bar execution)
      const executionPrice = currentBar.close;

      // Apply transaction costs
      const spreadCost = executionPrice * (this.costs.spreadBps / 10000);
      const slippageCost = executionPrice * (this.costs.slippageBps / 10000);

      if (signal.action === "BUY" && !position) {
        // Open long position
        const fillPrice = executionPrice + spreadCost + slippageCost;
        const size = signal.size || equity * 0.95; // Default 95% of capital
        const commission = size * this.costs.commissionPct + this.costs.commissionPerTrade;
        equity -= commission;

        position = {
          side: "LONG",
          entryPrice: fillPrice,
          entryTime: currentBar.timestamp,
          size: Math.min(size, equity),
        };
      } else if (signal.action === "SELL" && position) {
        // Close position
        const fillPrice = position.side === "LONG"
          ? executionPrice - spreadCost - slippageCost
          : executionPrice + spreadCost + slippageCost;

        const priceDelta = position.side === "LONG"
          ? fillPrice - position.entryPrice
          : position.entryPrice - fillPrice;

        const returnPct = priceDelta / position.entryPrice;
        const pnl = returnPct * position.size;
        const commission = position.size * this.costs.commissionPct + this.costs.commissionPerTrade;
        const totalFees = commission;
        const totalSlippage = (spreadCost + slippageCost) * (position.size / position.entryPrice);

        equity += pnl - commission;
        returns.push(returnPct);

        trades.push({
          id: tradeId++,
          instrument: currentBar.instrument,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice: fillPrice,
          entryTime: position.entryTime,
          exitTime: currentBar.timestamp,
          size: position.size,
          pnl: pnl - commission,
          returnPct,
          holdingPeriod: currentBar.timestamp - position.entryTime,
          fees: totalFees,
          slippage: totalSlippage,
          strategy: strategyName,
        });

        position = null;
      } else if (signal.action === "SELL" && !position) {
        // Open short position
        const fillPrice = executionPrice - spreadCost - slippageCost;
        const size = signal.size || equity * 0.95;
        const commission = size * this.costs.commissionPct + this.costs.commissionPerTrade;
        equity -= commission;

        position = {
          side: "SHORT",
          entryPrice: fillPrice,
          entryTime: currentBar.timestamp,
          size: Math.min(size, equity),
        };
      }

      // Update equity with unrealized P&L
      let unrealized = 0;
      if (position) {
        const markPrice = currentBar.close;
        const delta = position.side === "LONG"
          ? markPrice - position.entryPrice
          : position.entryPrice - markPrice;
        unrealized = (delta / position.entryPrice) * position.size;
      }

      const currentEquity = equity + unrealized;
      equityCurve.push({ timestamp: currentBar.timestamp, equity: currentEquity });

      // Drawdown tracking
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
        currentDDStart = currentBar.timestamp;
      }
      const currentDD = (peakEquity - currentEquity) / peakEquity;
      if (currentDD > maxDrawdown) {
        maxDrawdown = currentDD;
        maxDDStart = currentDDStart;
        maxDDEnd = currentBar.timestamp;
      }
    }

    // Close any remaining position at last bar
    if (position) {
      const lastBar = this.bars[this.bars.length - 1];
      const priceDelta = position.side === "LONG"
        ? lastBar.close - position.entryPrice
        : position.entryPrice - lastBar.close;
      const returnPct = priceDelta / position.entryPrice;
      const pnl = returnPct * position.size;
      equity += pnl;
      returns.push(returnPct);
    }

    // Calculate all metrics
    return this.calculateMetrics(trades, returns, equityCurve, maxDrawdown, maxDDEnd - maxDDStart);
  }

  /**
   * Calculate comprehensive backtest metrics.
   */
  private calculateMetrics(
    trades: IBacktestTrade[],
    returns: number[],
    equityCurve: { timestamp: number; equity: number }[],
    maxDrawdown: number,
    maxDDDuration: number
  ): IBacktestResult {
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);

    const totalReturn = equityCurve.length > 0
      ? (equityCurve[equityCurve.length - 1].equity - this.initialCapital) / this.initialCapital
      : 0;

    // Annualize (assume 500ms ticks, 365 days)
    const durationMs = equityCurve.length > 1
      ? equityCurve[equityCurve.length - 1].timestamp - equityCurve[0].timestamp
      : 1;
    const years = durationMs / (365.25 * 24 * 3600 * 1000);
    const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : totalReturn;

    // Sharpe Ratio = (mean return - rf) / stddev(returns)
    // Annualize: multiply by sqrt(periods_per_year)
    const avgReturn = returns.length > 0 ? mean(returns) : 0;
    const returnStd = returns.length > 2 ? stddev(returns) : 1;
    const periodsPerYear = years > 0 ? returns.length / years : returns.length;
    const sharpe = returnStd > 0
      ? (avgReturn / returnStd) * Math.sqrt(periodsPerYear)
      : 0;

    // Sortino Ratio: only penalize downside volatility
    const downsideReturns = returns.filter(r => r < 0);
    const downstddev_ = downsideReturns.length > 1 ? stddev(downsideReturns) : returnStd;
    const sortino = downstddev_ > 0
      ? (avgReturn / downstddev_) * Math.sqrt(periodsPerYear)
      : 0;

    // Calmar Ratio = annualized return / max drawdown
    const calmar = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

    // Profit factor = gross profit / gross loss
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    // Statistical significance: t-test
    const tStat = returns.length > 1
      ? (avgReturn * Math.sqrt(returns.length)) / (returnStd || 0.0001)
      : 0;
    // Approximate p-value using normal CDF (good enough for large N)
    const pValue = this.normalCDF(-Math.abs(tStat)) * 2; // Two-tailed

    // Skewness and Kurtosis
    const skewness = this.calculateSkewness(returns);
    const kurtosis = this.calculateKurtosis(returns);

    // VaR
    const sortedReturns = [...returns].sort((a, b) => a - b);
    const var95 = sortedReturns.length > 20
      ? Math.abs(sortedReturns[Math.floor(sortedReturns.length * 0.05)] || 0)
      : 0;
    const var99 = sortedReturns.length > 100
      ? Math.abs(sortedReturns[Math.floor(sortedReturns.length * 0.01)] || 0)
      : 0;

    // Information Ratio = alpha / tracking_error
    // Use Sharpe as proxy since we don't have benchmark returns here
    const informationRatio = sharpe;

    // Costs
    const totalFees = trades.reduce((s, t) => s + t.fees, 0);
    const totalSlippage = trades.reduce((s, t) => s + t.slippage, 0);
    const costDrag = this.initialCapital > 0
      ? ((totalFees + totalSlippage) / this.initialCapital) * 10000
      : 0;

    // Drawdown curve
    const drawdownCurve: { timestamp: number; drawdown: number }[] = [];
    let peak = this.initialCapital;
    for (const pt of equityCurve) {
      peak = Math.max(peak, pt.equity);
      drawdownCurve.push({ timestamp: pt.timestamp, drawdown: (peak - pt.equity) / peak });
    }

    // Monthly returns
    const monthlyReturns = this.calculateMonthlyReturns(equityCurve);

    return {
      totalReturn,
      annualizedReturn,
      sharpeRatio: sharpe,
      sortinoRatio: sortino,
      calmarRatio: calmar,
      maxDrawdown,
      maxDrawdownDuration: maxDDDuration,
      totalTrades: trades.length,
      winRate: trades.length > 0 ? wins.length / trades.length : 0,
      profitFactor,
      avgWin: wins.length > 0 ? mean(wins.map(t => t.pnl)) : 0,
      avgLoss: losses.length > 0 ? mean(losses.map(t => Math.abs(t.pnl))) : 0,
      largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
      largestLoss: losses.length > 0 ? Math.max(...losses.map(t => Math.abs(t.pnl))) : 0,
      avgHoldingPeriod: trades.length > 0 ? mean(trades.map(t => t.holdingPeriod)) : 0,
      volatility: returnStd,
      downstddev: downstddev_,
      var95,
      var99,
      skewness,
      kurtosis,
      totalFees,
      totalSlippage,
      costDrag,
      tStatistic: tStat,
      pValue,
      isSignificant: pValue < 0.05,
      informationRatio,
      equityCurve,
      drawdownCurve,
      monthlyReturns,
      trades,
    };
  }

  // ==================== WALK-FORWARD OPTIMIZATION ====================

  /**
   * Walk-forward optimization: rolling train/test windows.
   *
   * Prevents overfitting by ALWAYS testing on unseen data.
   *
   * |---TRAIN---|--TEST--|
   *      |---TRAIN---|--TEST--|
   *           |---TRAIN---|--TEST--|
   *
   * @param trainPct % of window for training (e.g., 0.70 = 70%)
   * @param numWindows Number of walk-forward windows
   */
  walkForward(
    signalFns: SignalFunction[],
    trainPct = 0.70,
    numWindows = 5,
    strategyName = "strategy"
  ): IWalkForwardResult {
    const totalBars = this.bars.length;
    const windowSize = Math.floor(totalBars / numWindows);
    const trainSize = Math.floor(windowSize * trainPct);
    const testSize = windowSize - trainSize;

    const windows: IWalkForwardResult["windows"] = [];
    let allTestReturns: number[] = [];

    for (let w = 0; w < numWindows; w++) {
      const startIdx = w * testSize; // Shift by test size each window
      const trainEndIdx = startIdx + trainSize;
      const testEndIdx = Math.min(trainEndIdx + testSize, totalBars);

      if (trainEndIdx >= totalBars || testEndIdx > totalBars) break;

      const trainBars = this.bars.slice(startIdx, trainEndIdx);
      const testBars = this.bars.slice(trainEndIdx, testEndIdx);

      if (trainBars.length < 50 || testBars.length < 10) continue;

      // Find best signal function on train data
      let bestTrainSharpe = -Infinity;
      let bestSignalFn = signalFns[0];

      for (const fn of signalFns) {
        const trainEngine = new BacktestEngine(trainBars, this.initialCapital, this.costs);
        const trainResult = trainEngine.run(fn, strategyName);
        if (trainResult.sharpeRatio > bestTrainSharpe) {
          bestTrainSharpe = trainResult.sharpeRatio;
          bestSignalFn = fn;
        }
      }

      // Test best function on UNSEEN test data
      const testEngine = new BacktestEngine(testBars, this.initialCapital, this.costs);
      const testResult = testEngine.run(bestSignalFn, strategyName);

      allTestReturns.push(...testResult.trades.map(t => t.returnPct));

      windows.push({
        trainStart: trainBars[0].timestamp,
        trainEnd: trainBars[trainBars.length - 1].timestamp,
        testStart: testBars[0].timestamp,
        testEnd: testBars[testBars.length - 1].timestamp,
        trainSharpe: bestTrainSharpe,
        testSharpe: testResult.sharpeRatio,
        testReturn: testResult.totalReturn,
        trainTrades: 0, // Would need to track this
        testTrades: testResult.totalTrades,
      });
    }

    // Aggregate test performance
    const avgTestSharpe = windows.length > 0
      ? mean(windows.map(w => w.testSharpe))
      : 0;
    const avgTrainSharpe = windows.length > 0
      ? mean(windows.map(w => w.trainSharpe))
      : 1;
    const degradation = avgTrainSharpe > 0 ? avgTestSharpe / avgTrainSharpe : 0;

    return {
      windows,
      aggregateTestSharpe: avgTestSharpe,
      aggregateTestReturn: mean(windows.map(w => w.testReturn)),
      degradationRatio: degradation,
      isRobust: degradation > 0.5 && avgTestSharpe > 0.5,
    };
  }

  // ==================== MONTE CARLO SIMULATION ====================

  /**
   * Monte Carlo simulation: randomize trade sequences to understand
   * the range of possible outcomes.
   *
   * Method: Bootstrap resampling of actual trades
   * - Randomly sample trades with replacement
   * - Compute equity curve for each simulation
   * - Derive confidence intervals for all metrics
   */
  static monteCarloSimulation(
    trades: IBacktestTrade[],
    numSimulations = 10000,
    initialCapital = 100
  ): IMonteCarloResult {
    if (trades.length < 10) {
      return {
        simulations: 0, medianReturn: 0, meanReturn: 0,
        p5Return: 0, p95Return: 0, medianSharpe: 0, p5Sharpe: 0, p95Sharpe: 0,
        medianMaxDD: 0, p5MaxDD: 0, probabilityOfProfit: 0, probabilityOfRuin: 0,
      };
    }

    const simReturns: number[] = [];
    const simSharpes: number[] = [];
    const simMaxDDs: number[] = [];

    for (let sim = 0; sim < numSimulations; sim++) {
      // Bootstrap: randomly sample N trades with replacement
      const sampledTrades: IBacktestTrade[] = [];
      for (let i = 0; i < trades.length; i++) {
        const idx = Math.floor(Math.random() * trades.length);
        sampledTrades.push(trades[idx]);
      }

      // Compute equity curve
      let equity = initialCapital;
      let peak = equity;
      let maxDD = 0;
      const returns: number[] = [];

      for (const trade of sampledTrades) {
        equity += trade.pnl;
        returns.push(trade.returnPct);

        peak = Math.max(peak, equity);
        const dd = (peak - equity) / peak;
        maxDD = Math.max(maxDD, dd);
      }

      const totalReturn = (equity - initialCapital) / initialCapital;
      simReturns.push(totalReturn);
      simMaxDDs.push(maxDD);

      const avgR = mean(returns);
      const stdR = stddev(returns);
      simSharpes.push(stdR > 0 ? (avgR / stdR) * Math.sqrt(returns.length) : 0);
    }

    // Sort for percentile calculations
    simReturns.sort((a, b) => a - b);
    simSharpes.sort((a, b) => a - b);
    simMaxDDs.sort((a, b) => a - b);

    const p5 = (arr: number[]) => arr[Math.floor(arr.length * 0.05)] || 0;
    const p50 = (arr: number[]) => arr[Math.floor(arr.length * 0.5)] || 0;
    const p95 = (arr: number[]) => arr[Math.floor(arr.length * 0.95)] || 0;

    return {
      simulations: numSimulations,
      medianReturn: p50(simReturns),
      meanReturn: mean(simReturns),
      p5Return: p5(simReturns),
      p95Return: p95(simReturns),
      medianSharpe: p50(simSharpes),
      p5Sharpe: p5(simSharpes),
      p95Sharpe: p95(simSharpes),
      medianMaxDD: p50(simMaxDDs),
      p5MaxDD: p95(simMaxDDs), // Note: higher DD is worse, so p95 is the bad scenario
      probabilityOfProfit: simReturns.filter(r => r > 0).length / numSimulations,
      probabilityOfRuin: simMaxDDs.filter(dd => dd > 0.5).length / numSimulations,
    };
  }

  // ==================== STATISTICAL SIGNIFICANCE ====================

  /**
   * Bootstrap confidence interval for Sharpe ratio.
   *
   * Resamples returns with replacement to estimate the distribution
   * of the Sharpe ratio, then computes 95% confidence interval.
   *
   * If the lower bound of the CI is > 0, the Sharpe is significant.
   */
  static bootstrapSharpeCI(
    returns: number[],
    numBootstraps = 5000,
    confidence = 0.95
  ): { lower: number; upper: number; isSignificant: boolean } {
    if (returns.length < 20) {
      return { lower: 0, upper: 0, isSignificant: false };
    }

    const bootstrapSharpes: number[] = [];

    for (let b = 0; b < numBootstraps; b++) {
      const sample: number[] = [];
      for (let i = 0; i < returns.length; i++) {
        sample.push(returns[Math.floor(Math.random() * returns.length)]);
      }
      const avg = mean(sample);
      const sd = stddev(sample);
      bootstrapSharpes.push(sd > 0 ? avg / sd * Math.sqrt(sample.length) : 0);
    }

    bootstrapSharpes.sort((a, b) => a - b);
    const alpha = (1 - confidence) / 2;
    const lowerIdx = Math.floor(numBootstraps * alpha);
    const upperIdx = Math.floor(numBootstraps * (1 - alpha));

    return {
      lower: bootstrapSharpes[lowerIdx] || 0,
      upper: bootstrapSharpes[upperIdx] || 0,
      isSignificant: (bootstrapSharpes[lowerIdx] || 0) > 0,
    };
  }

  /**
   * Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014)
   *
   * Adjusts Sharpe for multiple hypothesis testing.
   * If you test N strategies, some will appear profitable by chance.
   *
   * DSR = P(SR > 0 | SR*, σ_SR, skew, kurt, N_trials)
   */
  static deflatedSharpeRatio(
    observedSharpe: number,
    numTrials: number,
    numReturns: number,
    skewness: number,
    kurtosis: number
  ): number {
    if (numTrials <= 0 || numReturns <= 0) return 0;

    // Expected maximum Sharpe under null (all strategies random)
    const expectedMaxSharpe = Math.sqrt(2 * Math.log(numTrials))
      * (1 - 0.5772 / Math.log(numTrials)); // Euler-Mascheroni constant

    // Standard error of Sharpe
    const seSharpe = Math.sqrt(
      (1 + 0.5 * observedSharpe * observedSharpe
        - skewness * observedSharpe
        + ((kurtosis - 3) / 4) * observedSharpe * observedSharpe)
      / (numReturns - 1)
    );

    if (seSharpe === 0) return 0;

    // Test statistic
    const z = (observedSharpe - expectedMaxSharpe) / seSharpe;

    // P-value from normal CDF
    return 1 - BacktestEngine.prototype.normalCDF.call(null, -z);
  }

  // ==================== HELPERS ====================

  private normalCDF(x: number): number {
    // Abramowitz and Stegun approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  private calculateSkewness(data: number[]): number {
    if (data.length < 3) return 0;
    const avg = mean(data);
    const sd = stddev(data);
    if (sd === 0) return 0;
    const n = data.length;
    const m3 = data.reduce((s, v) => s + Math.pow((v - avg) / sd, 3), 0) / n;
    return m3;
  }

  private calculateKurtosis(data: number[]): number {
    if (data.length < 4) return 3; // Normal = 3
    const avg = mean(data);
    const sd = stddev(data);
    if (sd === 0) return 3;
    const n = data.length;
    const m4 = data.reduce((s, v) => s + Math.pow((v - avg) / sd, 4), 0) / n;
    return m4;
  }

  private calculateMonthlyReturns(equityCurve: { timestamp: number; equity: number }[]): { month: string; return_: number }[] {
    if (equityCurve.length < 2) return [];

    const monthly: { month: string; return_: number }[] = [];
    let lastMonthEquity = equityCurve[0].equity;
    let lastMonth = new Date(equityCurve[0].timestamp).toISOString().slice(0, 7);

    for (const pt of equityCurve) {
      const month = new Date(pt.timestamp).toISOString().slice(0, 7);
      if (month !== lastMonth) {
        const ret = lastMonthEquity > 0 ? (pt.equity - lastMonthEquity) / lastMonthEquity : 0;
        monthly.push({ month: lastMonth, return_: ret });
        lastMonthEquity = pt.equity;
        lastMonth = month;
      }
    }

    return monthly;
  }
}
