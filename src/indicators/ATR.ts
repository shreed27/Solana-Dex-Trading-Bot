import { IOHLCV } from "../types/market.types";

export class ATR {
  /**
   * Calculate Average True Range.
   * Measures volatility.
   */
  static calculate(candles: IOHLCV[], period: number = 14): number[] {
    if (candles.length < 2) return candles.map(() => NaN);

    const trueRanges: number[] = [candles[0].high - candles[0].low];

    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      trueRanges.push(
        Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
      );
    }

    // Wilder's smoothing for ATR
    const result: number[] = new Array(period - 1).fill(NaN);
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += trueRanges[i];
    }
    result.push(sum / period);

    for (let i = period; i < trueRanges.length; i++) {
      const prev = result[result.length - 1];
      result.push((prev * (period - 1) + trueRanges[i]) / period);
    }

    return result;
  }

  static latest(candles: IOHLCV[], period: number = 14): number {
    const atr = ATR.calculate(candles, period);
    return atr[atr.length - 1] ?? NaN;
  }
}
