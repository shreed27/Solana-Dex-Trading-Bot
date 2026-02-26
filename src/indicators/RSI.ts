export class RSI {
  /**
   * Calculate Relative Strength Index.
   * Returns array where first (period) values are NaN.
   */
  static calculate(closes: number[], period: number = 14): number[] {
    if (closes.length < period + 1) return closes.map(() => NaN);

    const result: number[] = new Array(period).fill(NaN);
    let avgGain = 0;
    let avgLoss = 0;

    // Initial average gain/loss
    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss += Math.abs(change);
    }
    avgGain /= period;
    avgLoss /= period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));

    // Subsequent values using smoothed averages
    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      const currentRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      result.push(100 - 100 / (1 + currentRs));
    }

    return result;
  }

  static latest(closes: number[], period: number = 14): number {
    const rsi = RSI.calculate(closes, period);
    return rsi[rsi.length - 1] ?? NaN;
  }
}
