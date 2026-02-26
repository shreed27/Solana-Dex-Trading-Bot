import { EMA } from "./EMA";

export interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export class MACD {
  /**
   * Calculate MACD (Moving Average Convergence Divergence).
   * Default: fast=12, slow=26, signal=9
   */
  static calculate(
    closes: number[],
    fastPeriod: number = 12,
    slowPeriod: number = 26,
    signalPeriod: number = 9
  ): MACDResult {
    const fastEma = EMA.calculate(closes, fastPeriod);
    const slowEma = EMA.calculate(closes, slowPeriod);

    // MACD line = Fast EMA - Slow EMA
    const macdLine = fastEma.map((f, i) => f - slowEma[i]);

    // Signal line = EMA of MACD line
    const signalLine = EMA.calculate(macdLine, signalPeriod);

    // Histogram = MACD line - Signal line
    const histogram = macdLine.map((m, i) => m - signalLine[i]);

    return { macdLine, signalLine, histogram };
  }

  /**
   * Detect if a bullish crossover just occurred (histogram went from <= 0 to > 0).
   */
  static isBullishCrossover(histogram: number[]): boolean {
    if (histogram.length < 2) return false;
    return (
      histogram[histogram.length - 1] > 0 &&
      histogram[histogram.length - 2] <= 0
    );
  }

  /**
   * Detect if a bearish crossover just occurred (histogram went from >= 0 to < 0).
   */
  static isBearishCrossover(histogram: number[]): boolean {
    if (histogram.length < 2) return false;
    return (
      histogram[histogram.length - 1] < 0 &&
      histogram[histogram.length - 2] >= 0
    );
  }
}
