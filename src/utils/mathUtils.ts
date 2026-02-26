/**
 * Statistical and mathematical utilities for trading strategies.
 */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(squaredDiffs.reduce((sum, v) => sum + v, 0) / (values.length - 1));
}

export function zScore(value: number, avg: number, sd: number): number {
  if (sd === 0) return 0;
  return (value - avg) / sd;
}

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * multiplier + result[i - 1] * (1 - multiplier));
  }
  return result;
}

export function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    const slice = values.slice(i - period + 1, i + 1);
    result.push(mean(slice));
  }
  return result;
}

/**
 * Pearson correlation coefficient between two arrays.
 */
export function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] - mx;
    const yi = y[i] - my;
    num += xi * yi;
    dx += xi * xi;
    dy += yi * yi;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Augmented Dickey-Fuller test statistic (simplified).
 * Tests whether a time series is stationary.
 * Returns the t-statistic; more negative = more likely stationary.
 */
export function adfTestStatistic(series: number[]): number {
  if (series.length < 10) return 0;
  // Compute first differences
  const diffs: number[] = [];
  const lagged: number[] = [];
  for (let i = 1; i < series.length; i++) {
    diffs.push(series[i] - series[i - 1]);
    lagged.push(series[i - 1]);
  }
  // Simple OLS: diffs = alpha + beta * lagged + error
  const n = diffs.length;
  const avgDiff = mean(diffs);
  const avgLag = mean(lagged);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (lagged[i] - avgLag) * (diffs[i] - avgDiff);
    den += (lagged[i] - avgLag) ** 2;
  }
  if (den === 0) return 0;
  const beta = num / den;
  // Residuals for standard error
  const alpha = avgDiff - beta * avgLag;
  let ssResid = 0;
  for (let i = 0; i < n; i++) {
    const residual = diffs[i] - alpha - beta * lagged[i];
    ssResid += residual ** 2;
  }
  const se = Math.sqrt(ssResid / (n - 2) / den);
  return se === 0 ? 0 : beta / se;
}

/**
 * Half-life of mean reversion from an AR(1) model.
 */
export function halfLife(series: number[]): number {
  if (series.length < 10) return Infinity;
  const diffs: number[] = [];
  const lagged: number[] = [];
  for (let i = 1; i < series.length; i++) {
    diffs.push(series[i] - series[i - 1]);
    lagged.push(series[i - 1]);
  }
  const avgDiff = mean(diffs);
  const avgLag = mean(lagged);
  let num = 0;
  let den = 0;
  for (let i = 0; i < diffs.length; i++) {
    num += (lagged[i] - avgLag) * (diffs[i] - avgDiff);
    den += (lagged[i] - avgLag) ** 2;
  }
  if (den === 0) return Infinity;
  const beta = num / den;
  if (beta >= 0) return Infinity;
  return -Math.log(2) / Math.log(1 + beta);
}

/**
 * Linear regression: returns { slope, intercept, r2 }
 */
export function linearRegression(
  x: number[],
  y: number[]
): { slope: number; intercept: number; r2: number } {
  const n = Math.min(x.length, y.length);
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = my - slope * mx;
  // R-squared
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (y[i] - my) ** 2;
    ssRes += (y[i] - (slope * x[i] + intercept)) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}
