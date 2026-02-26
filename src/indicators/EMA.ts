export class EMA {
  /**
   * Calculate Exponential Moving Average.
   * Returns array same length as input; first value = first input value.
   */
  static calculate(values: number[], period: number): number[] {
    if (values.length === 0) return [];
    if (period <= 0) return [...values];

    const multiplier = 2 / (period + 1);
    const result: number[] = [values[0]];

    for (let i = 1; i < values.length; i++) {
      result.push(values[i] * multiplier + result[i - 1] * (1 - multiplier));
    }
    return result;
  }

  /**
   * Get the latest EMA value.
   */
  static latest(values: number[], period: number): number {
    const ema = EMA.calculate(values, period);
    return ema[ema.length - 1] ?? 0;
  }
}
