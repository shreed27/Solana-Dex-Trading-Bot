/**
 * ============================================================================
 * DFA — FACTOR INVESTING ENGINE
 * ============================================================================
 *
 * Systematic factor-based investment framework.
 *
 * COMPONENTS:
 * 1. Factor Constructor — Build value, momentum, quality, size, vol, liquidity factors
 * 2. Factor Analyzer — IC, premium analysis, decay profiles
 * 3. Regime Detector — Identify factor regime shifts
 * 4. Crowding Detector — Detect overcrowded factor trades
 * 5. Multi-Factor Portfolio — Combine factors with optimal weights
 * 6. Tear Sheet Generator — Institutional-grade performance reports
 *
 * ============================================================================
 */

import { mean, stddev, correlation, linearRegression } from "../../utils/mathUtils";
import { logger } from "../../utils/logger";

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type FactorCategory =
  | "value"
  | "momentum"
  | "quality"
  | "size"
  | "volatility"
  | "liquidity";

export interface IFactorDefinition {
  name: string;
  category: FactorCategory;
  compute: (universe: IAssetData[]) => Map<string, number>;
}

export interface IAssetData {
  id: string;
  prices: number[];
  volumes: number[];
  marketCap: number;
  floatMarketCap?: number;
  bookValue?: number;
  earnings?: number;
  cashFlow?: number;
  dividends?: number;
  sales?: number;
  totalAssets?: number;
  equity?: number;
  grossProfit?: number;
  earningsHistory?: number[];
  accruals?: number;
  sharesOutstanding?: number;
  bidAskSpread?: number;
  shortInterest?: number;
  benchmarkReturns?: number[];
}

export interface IFactorReturn {
  factorName: string;
  returns: number[];
  cumulativeReturn: number;
  sharpe: number;
}

export type RegimeType = "momentum" | "value" | "quality" | "mixed";

export interface IRegimeState {
  regime: RegimeType;
  strength: number;
  duration: number;
  transitionProb: Map<RegimeType, number>;
}

export interface ICrowdingSignal {
  factor: string;
  shortInterestScore: number;
  valuationSpreadPctl: number;
  crowdedCorrelation: number;
  overallCrowdingScore: number;
}

export interface IRebalanceSignal {
  assetId: string;
  currentWeight: number;
  targetWeight: number;
  tradeSize: number;
  direction: "buy" | "sell";
}

export interface ITearSheet {
  cagr: number;
  sharpe: number;
  sortino: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  calmar: number;
  skewness: number;
  kurtosis: number;
  tailRatio: number;
  bestMonth: number;
  worstMonth: number;
  pctPositiveMonths: number;
  rollingSharpe12m: number[];
  rollingReturns12m: number[];
  rollingVol12m: number[];
  topDrawdowns: IDrawdownEvent[];
}

export interface IDrawdownEvent {
  startIndex: number;
  endIndex: number;
  recoveryIndex: number;
  depth: number;
  duration: number;
}

// ============================================================================
// HELPER UTILITIES (internal)
// ============================================================================

function rankArray(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length);
  for (let r = 0; r < indexed.length; r++) {
    ranks[indexed[r].i] = r / Math.max(indexed.length - 1, 1);
  }
  return ranks;
}

function spearmanCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const rx = rankArray(x.slice(0, n));
  const ry = rankArray(y.slice(0, n));
  return correlation(rx, ry);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push(prices[i - 1] === 0 ? 0 : (prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

function zScoreNormalize(values: number[]): number[] {
  const m = mean(values);
  const s = stddev(values);
  if (s === 0) return values.map(() => 0);
  return values.map((v) => (v - m) / s);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// 1. FACTOR CONSTRUCTOR
// ============================================================================

export class FactorConstructor {
  // ---- VALUE FACTORS ----

  static bookToMarket(): IFactorDefinition {
    return {
      name: "book_to_market",
      category: "value",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.bookValue !== undefined && asset.marketCap > 0) {
            result.set(asset.id, asset.bookValue / asset.marketCap);
          }
        }
        return result;
      },
    };
  }

  static earningsYield(): IFactorDefinition {
    return {
      name: "earnings_yield",
      category: "value",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.earnings !== undefined && asset.marketCap > 0) {
            result.set(asset.id, asset.earnings / asset.marketCap);
          }
        }
        return result;
      },
    };
  }

  static cashFlowYield(): IFactorDefinition {
    return {
      name: "cash_flow_yield",
      category: "value",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.cashFlow !== undefined && asset.marketCap > 0) {
            result.set(asset.id, asset.cashFlow / asset.marketCap);
          }
        }
        return result;
      },
    };
  }

  static dividendYield(): IFactorDefinition {
    return {
      name: "dividend_yield",
      category: "value",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.dividends !== undefined && asset.marketCap > 0) {
            result.set(asset.id, asset.dividends / asset.marketCap);
          }
        }
        return result;
      },
    };
  }

  static salesToPrice(): IFactorDefinition {
    return {
      name: "sales_to_price",
      category: "value",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.sales !== undefined && asset.marketCap > 0) {
            result.set(asset.id, asset.sales / asset.marketCap);
          }
        }
        return result;
      },
    };
  }

  // ---- MOMENTUM FACTORS ----

  static momentum12m1m(): IFactorDefinition {
    return {
      name: "momentum_12_1",
      category: "momentum",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          const p = asset.prices;
          if (p.length < 252) continue;
          const start = p[p.length - 252];
          const skipRecent = p[p.length - 21];
          if (start === 0) continue;
          result.set(asset.id, (skipRecent - start) / start);
        }
        return result;
      },
    };
  }

  static momentum6m1m(): IFactorDefinition {
    return {
      name: "momentum_6_1",
      category: "momentum",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          const p = asset.prices;
          if (p.length < 126) continue;
          const start = p[p.length - 126];
          const skipRecent = p[p.length - 21];
          if (start === 0) continue;
          result.set(asset.id, (skipRecent - start) / start);
        }
        return result;
      },
    };
  }

  static shortTermReversal(): IFactorDefinition {
    return {
      name: "reversal_1m",
      category: "momentum",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          const p = asset.prices;
          if (p.length < 21) continue;
          const start = p[p.length - 21];
          const end = p[p.length - 1];
          if (start === 0) continue;
          // Negative of recent return (reversal signal)
          result.set(asset.id, -(end - start) / start);
        }
        return result;
      },
    };
  }

  static fiftyTwoWeekHighRatio(): IFactorDefinition {
    return {
      name: "52w_high_ratio",
      category: "momentum",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          const p = asset.prices;
          if (p.length < 252) continue;
          const window = p.slice(p.length - 252);
          const high = Math.max(...window);
          if (high === 0) continue;
          result.set(asset.id, p[p.length - 1] / high);
        }
        return result;
      },
    };
  }

  // ---- QUALITY FACTORS ----

  static returnOnEquity(): IFactorDefinition {
    return {
      name: "roe",
      category: "quality",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.earnings !== undefined && asset.equity !== undefined && asset.equity > 0) {
            result.set(asset.id, asset.earnings / asset.equity);
          }
        }
        return result;
      },
    };
  }

  static returnOnAssets(): IFactorDefinition {
    return {
      name: "roa",
      category: "quality",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.earnings !== undefined && asset.totalAssets !== undefined && asset.totalAssets > 0) {
            result.set(asset.id, asset.earnings / asset.totalAssets);
          }
        }
        return result;
      },
    };
  }

  static grossProfitability(): IFactorDefinition {
    return {
      name: "gross_profitability",
      category: "quality",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.grossProfit !== undefined && asset.totalAssets !== undefined && asset.totalAssets > 0) {
            result.set(asset.id, asset.grossProfit / asset.totalAssets);
          }
        }
        return result;
      },
    };
  }

  static earningsStability(): IFactorDefinition {
    return {
      name: "earnings_stability",
      category: "quality",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.earningsHistory && asset.earningsHistory.length >= 4) {
            const vol = stddev(asset.earningsHistory);
            const avg = mean(asset.earningsHistory);
            // Lower volatility relative to mean = higher stability
            result.set(asset.id, avg === 0 ? 0 : -vol / Math.abs(avg));
          }
        }
        return result;
      },
    };
  }

  static lowAccruals(): IFactorDefinition {
    return {
      name: "low_accruals",
      category: "quality",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.accruals !== undefined && asset.totalAssets !== undefined && asset.totalAssets > 0) {
            // Negative accruals-to-assets: lower accruals = higher quality
            result.set(asset.id, -asset.accruals / asset.totalAssets);
          }
        }
        return result;
      },
    };
  }

  // ---- SIZE FACTORS ----

  static logMarketCap(): IFactorDefinition {
    return {
      name: "log_market_cap",
      category: "size",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.marketCap > 0) {
            // Negative: small cap premium (lower cap = higher factor score)
            result.set(asset.id, -Math.log(asset.marketCap));
          }
        }
        return result;
      },
    };
  }

  static floatAdjustedMarketCap(): IFactorDefinition {
    return {
      name: "float_adjusted_cap",
      category: "size",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          const cap = asset.floatMarketCap ?? asset.marketCap;
          if (cap > 0) {
            result.set(asset.id, -Math.log(cap));
          }
        }
        return result;
      },
    };
  }

  // ---- VOLATILITY FACTORS ----

  static realizedVolatility(): IFactorDefinition {
    return {
      name: "realized_vol",
      category: "volatility",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.prices.length < 21) continue;
          const rets = computeReturns(asset.prices.slice(-63));
          // Low vol factor: negative vol means low-vol premium
          result.set(asset.id, -stddev(rets) * Math.sqrt(252));
        }
        return result;
      },
    };
  }

  static idiosyncraticVolatility(): IFactorDefinition {
    return {
      name: "idiosyncratic_vol",
      category: "volatility",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (!asset.benchmarkReturns || asset.prices.length < 63) continue;
          const assetRets = computeReturns(asset.prices.slice(-63));
          const benchRets = asset.benchmarkReturns.slice(-62);
          const n = Math.min(assetRets.length, benchRets.length);
          if (n < 10) continue;
          const reg = linearRegression(benchRets.slice(0, n), assetRets.slice(0, n));
          // Residual volatility
          const residuals: number[] = [];
          for (let i = 0; i < n; i++) {
            residuals.push(assetRets[i] - (reg.slope * benchRets[i] + reg.intercept));
          }
          result.set(asset.id, -stddev(residuals) * Math.sqrt(252));
        }
        return result;
      },
    };
  }

  static beta(): IFactorDefinition {
    return {
      name: "beta",
      category: "volatility",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (!asset.benchmarkReturns || asset.prices.length < 63) continue;
          const assetRets = computeReturns(asset.prices.slice(-252));
          const benchRets = asset.benchmarkReturns.slice(-251);
          const n = Math.min(assetRets.length, benchRets.length);
          if (n < 20) continue;
          const reg = linearRegression(benchRets.slice(0, n), assetRets.slice(0, n));
          // Low-beta premium: negative beta = higher score
          result.set(asset.id, -reg.slope);
        }
        return result;
      },
    };
  }

  static downsideBeta(): IFactorDefinition {
    return {
      name: "downside_beta",
      category: "volatility",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (!asset.benchmarkReturns || asset.prices.length < 63) continue;
          const assetRets = computeReturns(asset.prices.slice(-252));
          const benchRets = asset.benchmarkReturns.slice(-251);
          const n = Math.min(assetRets.length, benchRets.length);
          if (n < 20) continue;
          // Only use observations where benchmark is negative
          const downAsset: number[] = [];
          const downBench: number[] = [];
          for (let i = 0; i < n; i++) {
            if (benchRets[i] < 0) {
              downAsset.push(assetRets[i]);
              downBench.push(benchRets[i]);
            }
          }
          if (downBench.length < 10) continue;
          const reg = linearRegression(downBench, downAsset);
          result.set(asset.id, -reg.slope);
        }
        return result;
      },
    };
  }

  // ---- LIQUIDITY FACTORS ----

  static amihudIlliquidity(): IFactorDefinition {
    return {
      name: "amihud_illiquidity",
      category: "liquidity",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.prices.length < 21 || asset.volumes.length < 21) continue;
          const rets = computeReturns(asset.prices.slice(-21));
          const vols = asset.volumes.slice(-20);
          const n = Math.min(rets.length, vols.length);
          let sumRatio = 0;
          let validDays = 0;
          for (let i = 0; i < n; i++) {
            if (vols[i] > 0) {
              sumRatio += Math.abs(rets[i]) / vols[i];
              validDays++;
            }
          }
          if (validDays === 0) continue;
          // Negative: more liquid assets score higher (or use positive for illiquidity premium)
          result.set(asset.id, sumRatio / validDays);
        }
        return result;
      },
    };
  }

  static turnover(): IFactorDefinition {
    return {
      name: "turnover",
      category: "liquidity",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.volumes.length < 21 || !asset.sharesOutstanding) continue;
          const avgVol = mean(asset.volumes.slice(-21));
          if (asset.sharesOutstanding > 0) {
            result.set(asset.id, avgVol / asset.sharesOutstanding);
          }
        }
        return result;
      },
    };
  }

  static bidAskSpread(): IFactorDefinition {
    return {
      name: "bid_ask_spread",
      category: "liquidity",
      compute: (universe: IAssetData[]): Map<string, number> => {
        const result = new Map<string, number>();
        for (const asset of universe) {
          if (asset.bidAskSpread !== undefined) {
            // Tighter spread = more liquid = higher score
            result.set(asset.id, -asset.bidAskSpread);
          }
        }
        return result;
      },
    };
  }

  /** Returns all classic factor definitions. */
  static allFactors(): IFactorDefinition[] {
    return [
      // Value
      FactorConstructor.bookToMarket(),
      FactorConstructor.earningsYield(),
      FactorConstructor.cashFlowYield(),
      FactorConstructor.dividendYield(),
      FactorConstructor.salesToPrice(),
      // Momentum
      FactorConstructor.momentum12m1m(),
      FactorConstructor.momentum6m1m(),
      FactorConstructor.shortTermReversal(),
      FactorConstructor.fiftyTwoWeekHighRatio(),
      // Quality
      FactorConstructor.returnOnEquity(),
      FactorConstructor.returnOnAssets(),
      FactorConstructor.grossProfitability(),
      FactorConstructor.earningsStability(),
      FactorConstructor.lowAccruals(),
      // Size
      FactorConstructor.logMarketCap(),
      FactorConstructor.floatAdjustedMarketCap(),
      // Volatility
      FactorConstructor.realizedVolatility(),
      FactorConstructor.idiosyncraticVolatility(),
      FactorConstructor.beta(),
      FactorConstructor.downsideBeta(),
      // Liquidity
      FactorConstructor.amihudIlliquidity(),
      FactorConstructor.turnover(),
      FactorConstructor.bidAskSpread(),
    ];
  }
}

// ============================================================================
// 2. FACTOR ANALYZER
// ============================================================================

export class FactorAnalyzer {
  /**
   * Compute long-short portfolio returns: top quintile minus bottom quintile.
   * factorValues: Map<assetId, factorScore>
   * assetReturns: Map<assetId, number[]> (return series)
   * Returns array of period returns for the long-short portfolio.
   */
  static computeFactorReturns(
    factorValues: Map<string, number>,
    assetReturns: Map<string, number[]>
  ): number[] {
    const entries = Array.from(factorValues.entries())
      .filter(([id]) => assetReturns.has(id))
      .sort((a, b) => a[1] - b[1]);

    if (entries.length < 5) {
      logger.warning("FactorAnalyzer: insufficient assets for quintile sort");
      return [];
    }

    const quintileSize = Math.max(1, Math.floor(entries.length / 5));
    const bottomIds = entries.slice(0, quintileSize).map(([id]) => id);
    const topIds = entries.slice(-quintileSize).map(([id]) => id);

    // Determine minimum return series length
    const allIds = [...bottomIds, ...topIds];
    let minLen = Infinity;
    for (const id of allIds) {
      const r = assetReturns.get(id)!;
      if (r.length < minLen) minLen = r.length;
    }
    if (minLen === Infinity || minLen === 0) return [];

    const lsReturns: number[] = [];
    for (let t = 0; t < minLen; t++) {
      let longRet = 0;
      for (const id of topIds) longRet += assetReturns.get(id)![t];
      longRet /= topIds.length;

      let shortRet = 0;
      for (const id of bottomIds) shortRet += assetReturns.get(id)![t];
      shortRet /= bottomIds.length;

      lsReturns.push(longRet - shortRet);
    }

    return lsReturns;
  }

  /**
   * Information Coefficient: rank correlation between factor values and forward returns.
   */
  static factorIC(
    factorValues: Map<string, number>,
    forwardReturns: Map<string, number>
  ): number {
    const commonIds = Array.from(factorValues.keys()).filter((id) =>
      forwardReturns.has(id)
    );
    if (commonIds.length < 5) return 0;

    const fv = commonIds.map((id) => factorValues.get(id)!);
    const fr = commonIds.map((id) => forwardReturns.get(id)!);
    return spearmanCorrelation(fv, fr);
  }

  /**
   * Factor decay analysis: compute IC at multiple forward horizons.
   * factorValues: Map<assetId, factorScore>
   * returns: Map<assetId, number[]> (daily return series going forward)
   * horizons: array of forward day counts, e.g. [1, 5, 10, 21, 63]
   * Returns Map<horizon, IC>
   */
  static factorDecayAnalysis(
    factorValues: Map<string, number>,
    returns: Map<string, number[]>,
    horizons: number[]
  ): Map<number, number> {
    const decay = new Map<number, number>();

    for (const h of horizons) {
      const forwardRets = new Map<string, number>();
      for (const [id, rets] of returns.entries()) {
        if (rets.length >= h) {
          let cumRet = 1;
          for (let i = 0; i < h; i++) cumRet *= 1 + rets[i];
          forwardRets.set(id, cumRet - 1);
        }
      }
      decay.set(h, FactorAnalyzer.factorIC(factorValues, forwardRets));
    }

    logger.info(
      `FactorAnalyzer: decay profile computed for ${horizons.length} horizons`
    );
    return decay;
  }

  /**
   * Factor turnover: percentage of names that changed quintile between periods.
   */
  static factorTurnover(
    prevRanking: Map<string, number>,
    currRanking: Map<string, number>
  ): number {
    const commonIds = Array.from(prevRanking.keys()).filter((id) =>
      currRanking.has(id)
    );
    if (commonIds.length < 5) return 0;

    const quintileOf = (rank: number, total: number): number =>
      Math.min(4, Math.floor((rank / total) * 5));

    const prevEntries = Array.from(prevRanking.entries())
      .filter(([id]) => currRanking.has(id))
      .sort((a, b) => a[1] - b[1]);
    const currEntries = Array.from(currRanking.entries())
      .filter(([id]) => prevRanking.has(id))
      .sort((a, b) => a[1] - b[1]);

    const prevQuintile = new Map<string, number>();
    const currQuintile = new Map<string, number>();

    prevEntries.forEach(([id], i) =>
      prevQuintile.set(id, quintileOf(i, prevEntries.length))
    );
    currEntries.forEach(([id], i) =>
      currQuintile.set(id, quintileOf(i, currEntries.length))
    );

    let changed = 0;
    for (const id of commonIds) {
      if (prevQuintile.get(id) !== currQuintile.get(id)) changed++;
    }

    return changed / commonIds.length;
  }
}

// ============================================================================
// 3. REGIME DETECTOR
// ============================================================================

export class RegimeDetector {
  private regimeHistory: RegimeType[] = [];
  private regimeStrengthHistory: number[] = [];
  private readonly lookback: number;

  constructor(lookback: number = 63) {
    this.lookback = lookback;
  }

  /**
   * Detect the current factor regime based on rolling factor returns.
   * factorReturns: Map<factorCategory, number[]> — return series per factor category.
   */
  detectRegime(factorReturns: Map<string, number[]>): RegimeType {
    const momRets = factorReturns.get("momentum") ?? [];
    const valRets = factorReturns.get("value") ?? [];
    const qualRets = factorReturns.get("quality") ?? [];

    const momPerf = this.rollingCumReturn(momRets);
    const valPerf = this.rollingCumReturn(valRets);
    const qualPerf = this.rollingCumReturn(qualRets);

    const scores: [RegimeType, number][] = [
      ["momentum", momPerf],
      ["value", valPerf],
      ["quality", qualPerf],
    ];
    scores.sort((a, b) => b[1] - a[1]);

    const best = scores[0];
    const second = scores[1];
    const spread = best[1] - second[1];

    // If spread is too narrow, regime is mixed
    let regime: RegimeType;
    if (spread < 0.01) {
      regime = "mixed";
    } else {
      regime = best[0];
    }

    const strength = clamp(spread * 100, 0, 1);
    this.regimeHistory.push(regime);
    this.regimeStrengthHistory.push(strength);

    logger.info(
      `RegimeDetector: regime=${regime}, strength=${strength.toFixed(3)}, ` +
        `mom=${momPerf.toFixed(4)}, val=${valPerf.toFixed(4)}, qual=${qualPerf.toFixed(4)}`
    );

    return regime;
  }

  /**
   * Compute the transition matrix: P(next regime | current regime).
   * Returns Map<fromRegime, Map<toRegime, probability>>.
   */
  regimeTransitionMatrix(): Map<RegimeType, Map<RegimeType, number>> {
    const allRegimes: RegimeType[] = ["momentum", "value", "quality", "mixed"];
    const counts = new Map<RegimeType, Map<RegimeType, number>>();

    for (const from of allRegimes) {
      const inner = new Map<RegimeType, number>();
      for (const to of allRegimes) inner.set(to, 0);
      counts.set(from, inner);
    }

    for (let i = 0; i < this.regimeHistory.length - 1; i++) {
      const from = this.regimeHistory[i];
      const to = this.regimeHistory[i + 1];
      const inner = counts.get(from)!;
      inner.set(to, (inner.get(to) ?? 0) + 1);
    }

    // Normalize rows to probabilities
    const matrix = new Map<RegimeType, Map<RegimeType, number>>();
    for (const from of allRegimes) {
      const inner = counts.get(from)!;
      let rowSum = 0;
      for (const v of inner.values()) rowSum += v;

      const probs = new Map<RegimeType, number>();
      for (const to of allRegimes) {
        probs.set(to, rowSum === 0 ? 1 / allRegimes.length : (inner.get(to) ?? 0) / rowSum);
      }
      matrix.set(from, probs);
    }

    return matrix;
  }

  /**
   * How strong is the current regime signal?
   * Returns 0..1 where 1 = maximum conviction.
   */
  currentRegimeStrength(): number {
    if (this.regimeStrengthHistory.length === 0) return 0;
    return this.regimeStrengthHistory[this.regimeStrengthHistory.length - 1];
  }

  /** Get the full regime history. */
  getRegimeHistory(): RegimeType[] {
    return [...this.regimeHistory];
  }

  private rollingCumReturn(returns: number[]): number {
    const window = returns.slice(-this.lookback);
    if (window.length === 0) return 0;
    let cum = 1;
    for (const r of window) cum *= 1 + r;
    return cum - 1;
  }
}

// ============================================================================
// 4. FACTOR CROWDING DETECTOR
// ============================================================================

export class FactorCrowdingDetector {
  /**
   * Short interest concentration: are too many participants on the same side?
   * positions: Map<assetId, shortInterest as fraction of float>
   * Returns 0..1 crowding score (1 = extremely crowded).
   */
  static shortInterestConcentration(positions: Map<string, number>): number {
    const values = Array.from(positions.values());
    if (values.length === 0) return 0;

    const avg = mean(values);
    const sd = stddev(values);
    const sorted = [...values].sort((a, b) => a - b);
    const p90 = percentile(sorted, 90);

    // Crowding score: combination of mean level, dispersion, and tail concentration
    const levelScore = clamp(avg / 0.20, 0, 1); // 20% short interest = maxed
    const tailScore = clamp(p90 / 0.30, 0, 1);  // 30% in top decile = maxed
    const dispersionScore = sd > 0 ? clamp(1 - sd / avg, 0, 1) : 1; // Low dispersion = crowded

    return levelScore * 0.4 + tailScore * 0.3 + dispersionScore * 0.3;
  }

  /**
   * Where does the current factor valuation spread sit in historical distribution?
   * factorSpread: current long-short factor spread
   * history: historical spread values
   * Returns percentile 0..100 (>90 or <10 = extreme).
   */
  static valuationSpreadPercentile(
    factorSpread: number,
    history: number[]
  ): number {
    if (history.length === 0) return 50;
    const sorted = [...history].sort((a, b) => a - b);
    let below = 0;
    for (const h of sorted) {
      if (h < factorSpread) below++;
      else break;
    }
    return (below / sorted.length) * 100;
  }

  /**
   * Correlation between a return stream and a basket of known crowded names.
   * High correlation = your factor is exposed to crowded trades.
   */
  static correlationWithCrowdedBasket(
    returns: number[],
    crowdedReturns: number[]
  ): number {
    return correlation(returns, crowdedReturns);
  }

  /**
   * Pairwise correlation between factor portfolios.
   * When factor portfolios become highly correlated, diversification breaks down.
   * factorPortfolios: Map<factorName, return series>
   * Returns the average pairwise correlation (higher = more crowded / correlated).
   */
  static pairwiseCorrelation(
    factorPortfolios: Map<string, number[]>
  ): number {
    const keys = Array.from(factorPortfolios.keys());
    if (keys.length < 2) return 0;

    let totalCorr = 0;
    let pairCount = 0;

    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const ri = factorPortfolios.get(keys[i])!;
        const rj = factorPortfolios.get(keys[j])!;
        totalCorr += Math.abs(correlation(ri, rj));
        pairCount++;
      }
    }

    return pairCount === 0 ? 0 : totalCorr / pairCount;
  }

  /**
   * Comprehensive crowding assessment for a single factor.
   */
  static assessCrowding(
    factorName: string,
    positions: Map<string, number>,
    factorSpread: number,
    spreadHistory: number[],
    factorReturns: number[],
    crowdedBasketReturns: number[]
  ): ICrowdingSignal {
    const siScore = FactorCrowdingDetector.shortInterestConcentration(positions);
    const spreadPctl = FactorCrowdingDetector.valuationSpreadPercentile(
      factorSpread,
      spreadHistory
    );
    const crowdedCorr = FactorCrowdingDetector.correlationWithCrowdedBasket(
      factorReturns,
      crowdedBasketReturns
    );

    // Normalize spread percentile to 0..1 (extreme = close to 0 or 100)
    const spreadScore = Math.abs(spreadPctl - 50) / 50;

    const overall =
      siScore * 0.3 +
      spreadScore * 0.3 +
      Math.abs(crowdedCorr) * 0.4;

    const signal: ICrowdingSignal = {
      factor: factorName,
      shortInterestScore: siScore,
      valuationSpreadPctl: spreadPctl,
      crowdedCorrelation: crowdedCorr,
      overallCrowdingScore: clamp(overall, 0, 1),
    };

    if (overall > 0.7) {
      logger.warning(
        `CrowdingDetector: ${factorName} crowding score ${overall.toFixed(3)} — HIGH ALERT`
      );
    }

    return signal;
  }
}

// ============================================================================
// 5. MULTI-FACTOR PORTFOLIO
// ============================================================================

export class MultiFactorPortfolio {
  /**
   * Compute composite factor score as a weighted z-score combination.
   * assets: array of asset IDs
   * factors: Map<factorName, Map<assetId, rawScore>>
   * weights: Map<factorName, weight>
   * Returns Map<assetId, compositeZScore>
   */
  static compositeScore(
    assets: string[],
    factors: Map<string, Map<string, number>>,
    weights: Map<string, number>
  ): Map<string, number> {
    // Step 1: z-score normalize each factor cross-sectionally
    const zFactors = new Map<string, Map<string, number>>();

    for (const [factorName, factorMap] of factors.entries()) {
      const vals = assets
        .filter((id) => factorMap.has(id))
        .map((id) => factorMap.get(id)!);
      const m = mean(vals);
      const s = stddev(vals);

      const zMap = new Map<string, number>();
      for (const id of assets) {
        if (factorMap.has(id)) {
          zMap.set(id, s === 0 ? 0 : (factorMap.get(id)! - m) / s);
        }
      }
      zFactors.set(factorName, zMap);
    }

    // Step 2: weighted combination
    const composite = new Map<string, number>();
    let totalWeight = 0;
    for (const w of weights.values()) totalWeight += Math.abs(w);
    if (totalWeight === 0) totalWeight = 1;

    for (const id of assets) {
      let score = 0;
      let usedWeight = 0;
      for (const [factorName, w] of weights.entries()) {
        const zMap = zFactors.get(factorName);
        if (zMap && zMap.has(id)) {
          score += (w / totalWeight) * zMap.get(id)!;
          usedWeight += Math.abs(w);
        }
      }
      if (usedWeight > 0) {
        composite.set(id, score);
      }
    }

    return composite;
  }

  /**
   * Mean-variance optimal factor tilts.
   * factorReturns: Map<factorName, number[]> — historical return series per factor
   * factorCovariance: 2D array [i][j] — covariance matrix
   * Returns Map<factorName, optimalWeight>
   */
  static optimizedWeights(
    factorReturns: Map<string, number[]>,
    factorCovariance: number[][]
  ): Map<string, number> {
    const factorNames = Array.from(factorReturns.keys());
    const n = factorNames.length;
    const weights = new Map<string, number>();

    if (n === 0 || factorCovariance.length !== n) {
      return weights;
    }

    // Compute expected returns (mean of historical)
    const mu: number[] = factorNames.map((f) => mean(factorReturns.get(f)!));

    // Inverse-variance weighting as a robust approximation to MVO
    // (Full MVO with matrix inversion requires a linear algebra library)
    const invVar: number[] = [];
    for (let i = 0; i < n; i++) {
      const v = factorCovariance[i][i];
      invVar.push(v > 1e-10 ? 1 / v : 0);
    }

    // Risk-adjusted: scale by expected return sign and magnitude
    const rawWeights: number[] = [];
    for (let i = 0; i < n; i++) {
      rawWeights.push(invVar[i] * mu[i]);
    }

    // Normalize to sum to 1
    let sumAbs = 0;
    for (const w of rawWeights) sumAbs += Math.abs(w);
    if (sumAbs === 0) sumAbs = 1;

    for (let i = 0; i < n; i++) {
      weights.set(factorNames[i], rawWeights[i] / sumAbs);
    }

    logger.info(
      `MultiFactorPortfolio: optimized weights for ${n} factors, ` +
        `sum(|w|)=${sumAbs.toFixed(4)}`
    );

    return weights;
  }

  /**
   * Apply risk budget constraints to composite scores to produce portfolio tilts.
   * compositeScores: Map<assetId, compositeZScore>
   * riskBudget: max total active risk (e.g. 0.05 = 5%)
   * Returns Map<assetId, constrainedTilt> where tilts sum to ~0 (market-neutral).
   */
  static riskAdjustedTilts(
    compositeScores: Map<string, number>,
    riskBudget: number
  ): Map<string, number> {
    const ids = Array.from(compositeScores.keys());
    const scores = ids.map((id) => compositeScores.get(id)!);

    // Demean scores for market neutrality
    const m = mean(scores);
    const demeaned = scores.map((s) => s - m);

    // Scale so sum of absolute tilts equals risk budget
    let sumAbs = 0;
    for (const d of demeaned) sumAbs += Math.abs(d);
    const scale = sumAbs === 0 ? 0 : riskBudget / sumAbs;

    const tilts = new Map<string, number>();
    for (let i = 0; i < ids.length; i++) {
      tilts.set(ids[i], demeaned[i] * scale);
    }

    return tilts;
  }

  /**
   * Generate rebalance signals: trades needed to move from current to target portfolio.
   * currentPortfolio: Map<assetId, currentWeight>
   * targetPortfolio: Map<assetId, targetWeight>
   * threshold: minimum absolute difference to trigger a trade
   * Returns array of rebalance signals.
   */
  static rebalanceSignals(
    currentPortfolio: Map<string, number>,
    targetPortfolio: Map<string, number>,
    threshold: number
  ): IRebalanceSignal[] {
    const signals: IRebalanceSignal[] = [];
    const allIds = new Set([
      ...currentPortfolio.keys(),
      ...targetPortfolio.keys(),
    ]);

    for (const id of allIds) {
      const current = currentPortfolio.get(id) ?? 0;
      const target = targetPortfolio.get(id) ?? 0;
      const diff = target - current;

      if (Math.abs(diff) >= threshold) {
        signals.push({
          assetId: id,
          currentWeight: current,
          targetWeight: target,
          tradeSize: Math.abs(diff),
          direction: diff > 0 ? "buy" : "sell",
        });
      }
    }

    // Sort by trade size descending (largest trades first)
    signals.sort((a, b) => b.tradeSize - a.tradeSize);

    logger.info(
      `MultiFactorPortfolio: ${signals.length} rebalance signals generated ` +
        `(threshold=${threshold})`
    );

    return signals;
  }
}

// ============================================================================
// 6. TEAR SHEET GENERATOR
// ============================================================================

export class TearSheetGenerator {
  /**
   * Generate a complete performance tear sheet from a return series.
   * returns: array of periodic returns (e.g. monthly returns).
   * periodsPerYear: annualization factor (12 for monthly, 252 for daily).
   */
  static generateTearSheet(
    returns: number[],
    periodsPerYear: number = 12
  ): ITearSheet {
    if (returns.length === 0) {
      return TearSheetGenerator.emptyTearSheet();
    }

    const cagr = TearSheetGenerator.computeCAGR(returns, periodsPerYear);
    const vol = stddev(returns) * Math.sqrt(periodsPerYear);
    const sharpe = vol === 0 ? 0 : cagr / vol;
    const sortino = TearSheetGenerator.computeSortino(returns, periodsPerYear);
    const { maxDrawdown, maxDrawdownDuration, topDrawdowns } =
      TearSheetGenerator.drawdownAnalysis(returns);
    const calmar =
      maxDrawdown === 0 ? 0 : Math.abs(cagr / maxDrawdown);
    const skew = TearSheetGenerator.computeSkewness(returns);
    const kurt = TearSheetGenerator.computeKurtosis(returns);
    const tailRatio = TearSheetGenerator.computeTailRatio(returns);
    const bestMonth = Math.max(...returns);
    const worstMonth = Math.min(...returns);
    const positiveCount = returns.filter((r) => r > 0).length;
    const pctPositiveMonths = (positiveCount / returns.length) * 100;

    const rollingSharpe12m = TearSheetGenerator.rollingSharpe(
      returns,
      12,
      periodsPerYear
    );
    const rollingReturns12m = TearSheetGenerator.rollingCumReturns(returns, 12);
    const rollingVol12m = TearSheetGenerator.rollingVol(
      returns,
      12,
      periodsPerYear
    );

    const sheet: ITearSheet = {
      cagr,
      sharpe,
      sortino,
      maxDrawdown,
      maxDrawdownDuration,
      calmar,
      skewness: skew,
      kurtosis: kurt,
      tailRatio,
      bestMonth,
      worstMonth,
      pctPositiveMonths,
      rollingSharpe12m,
      rollingReturns12m,
      rollingVol12m,
      topDrawdowns: topDrawdowns.slice(0, 5),
    };

    logger.info(
      `TearSheet: CAGR=${(cagr * 100).toFixed(2)}%, Sharpe=${sharpe.toFixed(2)}, ` +
        `Sortino=${sortino.toFixed(2)}, MaxDD=${(maxDrawdown * 100).toFixed(2)}%, ` +
        `Calmar=${calmar.toFixed(2)}, Skew=${skew.toFixed(2)}, Kurt=${kurt.toFixed(2)}`
    );

    return sheet;
  }

  // ---- Internal Metrics ----

  private static computeCAGR(returns: number[], periodsPerYear: number): number {
    let cumReturn = 1;
    for (const r of returns) cumReturn *= 1 + r;
    const years = returns.length / periodsPerYear;
    if (years <= 0 || cumReturn <= 0) return 0;
    return Math.pow(cumReturn, 1 / years) - 1;
  }

  private static computeSortino(
    returns: number[],
    periodsPerYear: number
  ): number {
    const m = mean(returns) * periodsPerYear;
    const downside = returns.filter((r) => r < 0);
    if (downside.length === 0) return m > 0 ? Infinity : 0;
    const downsideDev =
      Math.sqrt(mean(downside.map((d) => d * d))) * Math.sqrt(periodsPerYear);
    return downsideDev === 0 ? 0 : m / downsideDev;
  }

  private static computeSkewness(values: number[]): number {
    const n = values.length;
    if (n < 3) return 0;
    const m = mean(values);
    const s = stddev(values);
    if (s === 0) return 0;
    let sum3 = 0;
    for (const v of values) sum3 += Math.pow((v - m) / s, 3);
    return (n / ((n - 1) * (n - 2))) * sum3;
  }

  private static computeKurtosis(values: number[]): number {
    const n = values.length;
    if (n < 4) return 0;
    const m = mean(values);
    const s = stddev(values);
    if (s === 0) return 0;
    let sum4 = 0;
    for (const v of values) sum4 += Math.pow((v - m) / s, 4);
    const raw = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * sum4;
    const correction = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
    return raw - correction; // excess kurtosis
  }

  private static computeTailRatio(values: number[]): number {
    if (values.length < 20) return 1;
    const sorted = [...values].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    const p5 = percentile(sorted, 5);
    if (p5 === 0) return p95 > 0 ? Infinity : 1;
    return Math.abs(p95 / p5);
  }

  private static drawdownAnalysis(returns: number[]): {
    maxDrawdown: number;
    maxDrawdownDuration: number;
    topDrawdowns: IDrawdownEvent[];
  } {
    // Build equity curve
    const equity: number[] = [1];
    for (let i = 0; i < returns.length; i++) {
      equity.push(equity[i] * (1 + returns[i]));
    }

    // Track running high water mark and drawdown series
    let hwm = equity[0];
    const ddSeries: number[] = [];
    for (let i = 0; i < equity.length; i++) {
      if (equity[i] > hwm) hwm = equity[i];
      ddSeries.push(hwm === 0 ? 0 : (equity[i] - hwm) / hwm);
    }

    // Find drawdown events
    const events: IDrawdownEvent[] = [];
    let inDrawdown = false;
    let startIdx = 0;
    let worstIdx = 0;
    let worstDD = 0;

    for (let i = 0; i < ddSeries.length; i++) {
      if (ddSeries[i] < 0 && !inDrawdown) {
        inDrawdown = true;
        startIdx = i;
        worstDD = ddSeries[i];
        worstIdx = i;
      } else if (ddSeries[i] < 0 && inDrawdown) {
        if (ddSeries[i] < worstDD) {
          worstDD = ddSeries[i];
          worstIdx = i;
        }
      } else if (ddSeries[i] >= 0 && inDrawdown) {
        inDrawdown = false;
        events.push({
          startIndex: startIdx,
          endIndex: worstIdx,
          recoveryIndex: i,
          depth: worstDD,
          duration: i - startIdx,
        });
      }
    }

    // Handle ongoing drawdown at end of series
    if (inDrawdown) {
      events.push({
        startIndex: startIdx,
        endIndex: worstIdx,
        recoveryIndex: -1, // not yet recovered
        depth: worstDD,
        duration: ddSeries.length - startIdx,
      });
    }

    // Sort by depth (most negative first)
    events.sort((a, b) => a.depth - b.depth);

    const maxDrawdown = events.length > 0 ? Math.abs(events[0].depth) : 0;
    const maxDrawdownDuration = events.length > 0 ? events[0].duration : 0;

    return { maxDrawdown, maxDrawdownDuration, topDrawdowns: events };
  }

  private static rollingSharpe(
    returns: number[],
    window: number,
    periodsPerYear: number
  ): number[] {
    const result: number[] = [];
    for (let i = window - 1; i < returns.length; i++) {
      const slice = returns.slice(i - window + 1, i + 1);
      const m = mean(slice) * periodsPerYear;
      const s = stddev(slice) * Math.sqrt(periodsPerYear);
      result.push(s === 0 ? 0 : m / s);
    }
    return result;
  }

  private static rollingCumReturns(
    returns: number[],
    window: number
  ): number[] {
    const result: number[] = [];
    for (let i = window - 1; i < returns.length; i++) {
      const slice = returns.slice(i - window + 1, i + 1);
      let cum = 1;
      for (const r of slice) cum *= 1 + r;
      result.push(cum - 1);
    }
    return result;
  }

  private static rollingVol(
    returns: number[],
    window: number,
    periodsPerYear: number
  ): number[] {
    const result: number[] = [];
    for (let i = window - 1; i < returns.length; i++) {
      const slice = returns.slice(i - window + 1, i + 1);
      result.push(stddev(slice) * Math.sqrt(periodsPerYear));
    }
    return result;
  }

  private static emptyTearSheet(): ITearSheet {
    return {
      cagr: 0,
      sharpe: 0,
      sortino: 0,
      maxDrawdown: 0,
      maxDrawdownDuration: 0,
      calmar: 0,
      skewness: 0,
      kurtosis: 0,
      tailRatio: 1,
      bestMonth: 0,
      worstMonth: 0,
      pctPositiveMonths: 0,
      rollingSharpe12m: [],
      rollingReturns12m: [],
      rollingVol12m: [],
      topDrawdowns: [],
    };
  }
}
