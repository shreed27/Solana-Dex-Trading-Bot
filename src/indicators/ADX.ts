import { IOHLCV } from "../types/market.types";

export class ADX {
  /**
   * Calculate Average Directional Index.
   * Measures trend strength (regardless of direction).
   * ADX > 25 = strong trend, ADX < 20 = weak/no trend (ranging).
   */
  static calculate(candles: IOHLCV[], period: number = 14): number[] {
    if (candles.length < period + 1) return candles.map(() => NaN);

    const trueRanges: number[] = [];
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevHigh = candles[i - 1].high;
      const prevLow = candles[i - 1].low;
      const prevClose = candles[i - 1].close;

      // True Range
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);

      // Directional Movement
      const upMove = high - prevHigh;
      const downMove = prevLow - low;
      plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    // Smoothed averages using Wilder's smoothing
    const smoothedTR = ADX.wilderSmooth(trueRanges, period);
    const smoothedPlusDM = ADX.wilderSmooth(plusDMs, period);
    const smoothedMinusDM = ADX.wilderSmooth(minusDMs, period);

    // DI+ and DI-
    const diPlus: number[] = [];
    const diMinus: number[] = [];
    for (let i = 0; i < smoothedTR.length; i++) {
      diPlus.push(smoothedTR[i] === 0 ? 0 : (smoothedPlusDM[i] / smoothedTR[i]) * 100);
      diMinus.push(smoothedTR[i] === 0 ? 0 : (smoothedMinusDM[i] / smoothedTR[i]) * 100);
    }

    // DX
    const dx: number[] = [];
    for (let i = 0; i < diPlus.length; i++) {
      const sum = diPlus[i] + diMinus[i];
      dx.push(sum === 0 ? 0 : (Math.abs(diPlus[i] - diMinus[i]) / sum) * 100);
    }

    // ADX = smoothed DX
    const adx = ADX.wilderSmooth(dx, period);

    // Pad with NaN for the initial candle
    return [NaN, ...adx];
  }

  private static wilderSmooth(values: number[], period: number): number[] {
    if (values.length < period) return values.map(() => 0);
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += values[i];
    }
    result.push(sum / period);
    for (let i = period; i < values.length; i++) {
      result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
    }
    return result;
  }

  static latest(candles: IOHLCV[], period: number = 14): number {
    const adx = ADX.calculate(candles, period);
    return adx[adx.length - 1] ?? NaN;
  }
}
