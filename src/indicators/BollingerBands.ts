import { mean, stddev } from "../utils/mathUtils";

export interface BollingerBandPoint {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number; // position of price within bands (0 = lower, 1 = upper)
}

export class BollingerBands {
  /**
   * Calculate Bollinger Bands.
   * Returns array where first (period-1) values have NaN bandwidth.
   */
  static calculate(
    closes: number[],
    period: number = 20,
    numStdDev: number = 2
  ): BollingerBandPoint[] {
    const result: BollingerBandPoint[] = [];

    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) {
        result.push({
          upper: NaN,
          middle: NaN,
          lower: NaN,
          bandwidth: NaN,
          percentB: NaN,
        });
        continue;
      }

      const slice = closes.slice(i - period + 1, i + 1);
      const sma = mean(slice);
      const sd = stddev(slice);
      const upper = sma + numStdDev * sd;
      const lower = sma - numStdDev * sd;
      const bandwidth = upper - lower;
      const percentB = bandwidth === 0 ? 0.5 : (closes[i] - lower) / bandwidth;

      result.push({ upper, middle: sma, lower, bandwidth, percentB });
    }

    return result;
  }

  static latest(
    closes: number[],
    period: number = 20,
    numStdDev: number = 2
  ): BollingerBandPoint {
    const bands = BollingerBands.calculate(closes, period, numStdDev);
    return bands[bands.length - 1];
  }
}
