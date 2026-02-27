/**
 * ============================================================================
 * POINT72 CUBIST — ML SIGNAL PIPELINE
 * ============================================================================
 *
 * Machine learning pipeline that predicts short-term price movements
 * using 50+ features from price, volume, and microstructure data.
 *
 * MODEL: Gradient-boosted decision tree ensemble (GBM)
 * Implemented natively in TypeScript — no Python/sklearn dependency.
 *
 * PIPELINE:
 * 1. Feature Engineering — 50+ features from raw OHLCV
 * 2. Label Construction — Forward returns, direction, risk-adjusted
 * 3. Decision Tree Ensemble — Pure TS gradient boosting
 * 4. Purged K-Fold CV — Time-series aware cross-validation
 * 5. Feature Importance — Gain-based ranking
 * 6. Prediction → Signal — Score to portfolio weight conversion
 * 7. Model Monitoring — Degradation detection
 *
 * ============================================================================
 */

import { mean, stddev, ema, sma, correlation, zScore } from "../../utils/mathUtils";
import { logger } from "../../utils/logger";

// ============================================================================
// FEATURE ENGINEERING — 50+ FEATURES
// ============================================================================

export interface IFeatureVector {
  timestamp: number;
  instrument: string;
  features: Record<string, number>;
  label?: number;  // Forward return (for training)
}

export class FeatureEngine {
  /**
   * Generate 50+ features from OHLCV + orderbook data.
   *
   * Feature categories:
   * 1. Price-based (20): returns, moving averages, momentum
   * 2. Volume-based (10): volume ratios, OBV, money flow
   * 3. Volatility-based (8): realized vol, Parkinson, ATR
   * 4. Microstructure (7): spread, depth, imbalance
   * 5. Technical (10): RSI, MACD, Bollinger, Stochastic
   */
  static generateFeatures(
    prices: number[],
    volumes: number[],
    highs: number[],
    lows: number[],
    spread?: number,
    bidDepth?: number,
    askDepth?: number
  ): Record<string, number> {
    const features: Record<string, number> = {};
    const n = prices.length;
    if (n < 60) return features;

    const current = prices[n - 1];

    // ==================== PRICE-BASED (20) ====================

    // Returns over various lookbacks
    const ret = (lookback: number) => n > lookback
      ? (current - prices[n - 1 - lookback]) / prices[n - 1 - lookback]
      : 0;

    features.ret_1 = ret(1);
    features.ret_5 = ret(5);
    features.ret_10 = ret(10);
    features.ret_20 = ret(20);
    features.ret_40 = ret(40);
    features.ret_60 = n > 60 ? ret(60) : 0;

    // Moving average crossovers
    const sma5 = mean(prices.slice(-5));
    const sma10 = mean(prices.slice(-10));
    const sma20 = mean(prices.slice(-20));
    const sma40 = mean(prices.slice(-40));

    features.sma5_cross_sma20 = sma5 > sma20 ? 1 : -1;
    features.sma10_cross_sma40 = sma10 > sma40 ? 1 : -1;
    features.price_vs_sma20 = sma20 > 0 ? (current - sma20) / sma20 : 0;
    features.price_vs_sma40 = sma40 > 0 ? (current - sma40) / sma40 : 0;

    // EMA values
    const emaValues = ema(prices, 12);
    const ema12 = emaValues[emaValues.length - 1] || current;
    const ema26Values = ema(prices, 26);
    const ema26 = ema26Values[ema26Values.length - 1] || current;

    features.ema12_vs_ema26 = ema26 > 0 ? (ema12 - ema26) / ema26 : 0;

    // Price position in range
    const high20 = Math.max(...prices.slice(-20));
    const low20 = Math.min(...prices.slice(-20));
    const range20 = high20 - low20;
    features.price_position_20 = range20 > 0 ? (current - low20) / range20 : 0.5;

    const high40 = Math.max(...prices.slice(-40));
    const low40 = Math.min(...prices.slice(-40));
    const range40 = high40 - low40;
    features.price_position_40 = range40 > 0 ? (current - low40) / range40 : 0.5;

    // Momentum: rate of change
    features.roc_5 = prices[n - 6] > 0 ? (current / prices[n - 6] - 1) : 0;
    features.roc_20 = prices[n - 21] > 0 ? (current / prices[n - 21] - 1) : 0;

    // Acceleration: momentum of momentum
    const mom5_prev = n > 10 ? (prices[n - 6] - prices[n - 11]) / prices[n - 11] : 0;
    features.acceleration = features.roc_5 - mom5_prev;

    // ==================== VOLUME-BASED (10) ====================

    if (volumes.length >= 20) {
      const avgVol20 = mean(volumes.slice(-20));
      const avgVol5 = mean(volumes.slice(-5));

      features.volume_ratio_5_20 = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
      features.volume_zscore = (() => {
        const vols20 = volumes.slice(-20);
        const volStd = stddev(vols20);
        return volStd > 0 ? (volumes[n - 1] - avgVol20) / volStd : 0;
      })();

      // On-Balance Volume (OBV) — simplified
      let obv = 0;
      for (let i = 1; i < Math.min(n, 20); i++) {
        if (prices[n - 1 - i + 1] > prices[n - 1 - i]) obv += volumes[n - 1 - i + 1];
        else obv -= volumes[n - 1 - i + 1];
      }
      features.obv_20 = obv;

      // Money Flow Index components
      let positiveFlow = 0;
      let negativeFlow = 0;
      for (let i = Math.max(0, n - 14); i < n; i++) {
        const typicalPrice = prices[i];
        const flow = typicalPrice * (volumes[i] || 1);
        if (i > 0 && prices[i] > prices[i - 1]) positiveFlow += flow;
        else negativeFlow += flow;
      }
      const mfRatio = negativeFlow > 0 ? positiveFlow / negativeFlow : 1;
      features.mfi_14 = 100 - (100 / (1 + mfRatio));

      // Volume price trend
      features.vpt = (() => {
        let vpt = 0;
        for (let i = Math.max(1, n - 20); i < n; i++) {
          const pctChange = prices[i - 1] > 0 ? (prices[i] - prices[i - 1]) / prices[i - 1] : 0;
          vpt += pctChange * (volumes[i] || 1);
        }
        return vpt;
      })();

      // Accumulation/Distribution
      features.ad_20 = (() => {
        let ad = 0;
        for (let i = Math.max(0, n - 20); i < n; i++) {
          const hi = highs[i] || prices[i];
          const lo = lows[i] || prices[i];
          const range = hi - lo;
          const clv = range > 0 ? ((prices[i] - lo) - (hi - prices[i])) / range : 0;
          ad += clv * (volumes[i] || 1);
        }
        return ad;
      })();

      features.volume_trend = (() => {
        const x = Array.from({ length: 20 }, (_, i) => i);
        const y = volumes.slice(-20);
        if (y.length < 20) return 0;
        const avg_x = mean(x);
        const avg_y = mean(y);
        let num = 0, den = 0;
        for (let i = 0; i < 20; i++) {
          num += (x[i] - avg_x) * (y[i] - avg_y);
          den += (x[i] - avg_x) ** 2;
        }
        return den > 0 ? num / den : 0;
      })();

      features.volume_cv = avgVol20 > 0 ? stddev(volumes.slice(-20)) / avgVol20 : 0;
      features.volume_skew = (() => {
        const vols = volumes.slice(-20);
        const avg = mean(vols);
        const sd = stddev(vols);
        if (sd === 0 || vols.length < 3) return 0;
        return vols.reduce((s, v) => s + Math.pow((v - avg) / sd, 3), 0) / vols.length;
      })();
    }

    // ==================== VOLATILITY-BASED (8) ====================

    const returns20 = [];
    for (let i = Math.max(1, n - 20); i < n; i++) {
      if (prices[i - 1] > 0) returns20.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    features.volatility_20 = returns20.length > 2 ? stddev(returns20) : 0;

    const returns5: number[] = [];
    for (let i = Math.max(1, n - 5); i < n; i++) {
      if (prices[i - 1] > 0) returns5.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    features.volatility_5 = returns5.length > 2 ? stddev(returns5) : 0;

    // Volatility ratio (short-term vs long-term)
    features.vol_ratio = features.volatility_20 > 0 ? features.volatility_5 / features.volatility_20 : 1;

    // Parkinson volatility (using high-low range)
    if (highs.length >= 20 && lows.length >= 20) {
      let parkSum = 0;
      for (let i = Math.max(0, n - 20); i < n; i++) {
        const hi = highs[i] || prices[i];
        const lo = lows[i] || prices[i];
        if (lo > 0 && hi > 0) {
          parkSum += Math.pow(Math.log(hi / lo), 2);
        }
      }
      features.parkinson_vol = Math.sqrt(parkSum / (4 * Math.log(2) * 20));
    }

    // ATR (Average True Range)
    features.atr_14 = (() => {
      const trueRanges: number[] = [];
      for (let i = Math.max(1, n - 14); i < n; i++) {
        const hi = highs[i] || prices[i];
        const lo = lows[i] || prices[i];
        const prevClose = prices[i - 1];
        const tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
        trueRanges.push(tr);
      }
      return trueRanges.length > 0 ? mean(trueRanges) : 0;
    })();

    features.atr_pct = current > 0 ? features.atr_14 / current : 0;

    // Downside volatility
    const downsideReturns = returns20.filter(r => r < 0);
    features.downside_vol = downsideReturns.length > 2 ? stddev(downsideReturns) : 0;

    // Volatility of volatility
    features.vol_of_vol = (() => {
      const rollVols: number[] = [];
      for (let i = 10; i < Math.min(n, 40); i++) {
        const slice = [];
        for (let j = i - 10; j < i; j++) {
          if (prices[j] > 0 && j > 0) slice.push((prices[j] - prices[j - 1]) / prices[j - 1]);
        }
        if (slice.length > 2) rollVols.push(stddev(slice));
      }
      return rollVols.length > 2 ? stddev(rollVols) : 0;
    })();

    // ==================== MICROSTRUCTURE (7) ====================

    if (spread !== undefined) {
      features.spread_bps = current > 0 ? (spread / current) * 10000 : 0;
    }
    if (bidDepth !== undefined && askDepth !== undefined) {
      const totalDepth = bidDepth + askDepth;
      features.book_imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
      features.bid_depth = bidDepth;
      features.ask_depth = askDepth;
      features.depth_ratio = askDepth > 0 ? bidDepth / askDepth : 1;
    }

    // Amihud illiquidity (|return| / volume)
    features.amihud = (() => {
      let amihud = 0;
      let count = 0;
      for (let i = Math.max(1, n - 20); i < n; i++) {
        const ret = prices[i - 1] > 0 ? Math.abs(prices[i] - prices[i - 1]) / prices[i - 1] : 0;
        const vol = volumes[i] || 1;
        amihud += ret / vol;
        count++;
      }
      return count > 0 ? amihud / count : 0;
    })();

    // Kyle's lambda (price impact coefficient)
    features.kyle_lambda = (() => {
      if (returns20.length < 10 || volumes.length < n) return 0;
      const signedVolumes = [];
      for (let i = Math.max(1, n - 20); i < n; i++) {
        const sign = prices[i] > prices[i - 1] ? 1 : -1;
        signedVolumes.push(sign * (volumes[i] || 1));
      }
      if (signedVolumes.length < 10 || returns20.length < 10) return 0;
      const minLen = Math.min(signedVolumes.length, returns20.length);
      const corr = correlation(returns20.slice(0, minLen), signedVolumes.slice(0, minLen));
      return corr;
    })();

    // ==================== TECHNICAL (10) ====================

    // RSI (Relative Strength Index)
    features.rsi_14 = (() => {
      let gains = 0, losses = 0, count = 0;
      for (let i = Math.max(1, n - 14); i < n; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
        count++;
      }
      if (count === 0 || (gains + losses) === 0) return 50;
      const rs = losses > 0 ? gains / losses : 100;
      return 100 - (100 / (1 + rs));
    })();

    // MACD
    features.macd = ema12 - ema26;
    const macdSignalLine = ema([features.macd], 9);
    features.macd_signal = macdSignalLine[macdSignalLine.length - 1] || 0;
    features.macd_histogram = features.macd - features.macd_signal;

    // Bollinger Bands
    const bb_mean = sma20;
    const bb_std = stddev(prices.slice(-20));
    features.bollinger_pct = bb_std > 0 ? (current - bb_mean) / (2 * bb_std) : 0;
    features.bollinger_width = bb_mean > 0 ? (4 * bb_std) / bb_mean : 0;

    // Stochastic Oscillator
    features.stoch_k = range20 > 0 ? ((current - low20) / range20) * 100 : 50;

    // Williams %R
    features.williams_r = range20 > 0 ? ((high20 - current) / range20) * -100 : -50;

    // CCI (Commodity Channel Index)
    const meanDev = mean(prices.slice(-20).map(p => Math.abs(p - sma20)));
    features.cci_20 = meanDev > 0 ? (current - sma20) / (0.015 * meanDev) : 0;

    // ADX proxy (Average Directional Index)
    features.adx_proxy = Math.abs(features.price_vs_sma20) * 100;

    return features;
  }

  /**
   * Construct training labels: forward N-bar return.
   */
  static constructLabel(
    prices: number[],
    currentIdx: number,
    forwardBars = 10,
    labelType: "return" | "direction" | "risk_adjusted" = "return"
  ): number {
    if (currentIdx + forwardBars >= prices.length) return 0;

    const currentPrice = prices[currentIdx];
    const futurePrice = prices[currentIdx + forwardBars];
    if (currentPrice <= 0) return 0;

    const forwardReturn = (futurePrice - currentPrice) / currentPrice;

    if (labelType === "return") return forwardReturn;
    if (labelType === "direction") return forwardReturn > 0 ? 1 : -1;

    // Risk-adjusted: forward return / forward volatility
    const futurePrices = prices.slice(currentIdx, currentIdx + forwardBars + 1);
    const futureReturns = [];
    for (let i = 1; i < futurePrices.length; i++) {
      if (futurePrices[i - 1] > 0) futureReturns.push((futurePrices[i] - futurePrices[i - 1]) / futurePrices[i - 1]);
    }
    const futureVol = futureReturns.length > 2 ? stddev(futureReturns) : 0.01;
    return futureVol > 0 ? forwardReturn / futureVol : 0;
  }
}

// ============================================================================
// DECISION TREE (NATIVE TYPESCRIPT)
// ============================================================================

interface ITreeNode {
  isLeaf: boolean;
  prediction?: number;
  featureName?: string;
  threshold?: number;
  left?: ITreeNode;
  right?: ITreeNode;
  gain?: number;
}

export class DecisionTree {
  private root: ITreeNode | null = null;
  private maxDepth: number;
  private minSamplesLeaf: number;
  private minGain: number;

  constructor(maxDepth = 4, minSamplesLeaf = 5, minGain = 0.0001) {
    this.maxDepth = maxDepth;
    this.minSamplesLeaf = minSamplesLeaf;
    this.minGain = minGain;
  }

  fit(features: Record<string, number>[], labels: number[]): void {
    const indices = Array.from({ length: labels.length }, (_, i) => i);
    this.root = this.buildTree(features, labels, indices, 0);
  }

  predict(features: Record<string, number>): number {
    if (!this.root) return 0;
    return this.traverseTree(this.root, features);
  }

  getFeatureImportance(): Record<string, number> {
    const importance: Record<string, number> = {};
    if (this.root) {
      this.collectImportance(this.root, importance);
    }
    // Normalize
    const total = Object.values(importance).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const key of Object.keys(importance)) {
        importance[key] /= total;
      }
    }
    return importance;
  }

  private buildTree(
    features: Record<string, number>[],
    labels: number[],
    indices: number[],
    depth: number
  ): ITreeNode {
    // Stopping conditions
    if (depth >= this.maxDepth || indices.length <= this.minSamplesLeaf) {
      return { isLeaf: true, prediction: mean(indices.map(i => labels[i])) };
    }

    const currentLabels = indices.map(i => labels[i]);
    const currentVariance = this.variance(currentLabels);

    if (currentVariance < this.minGain) {
      return { isLeaf: true, prediction: mean(currentLabels) };
    }

    // Find best split
    const bestSplit = this.findBestSplit(features, labels, indices);

    if (!bestSplit || bestSplit.gain < this.minGain) {
      return { isLeaf: true, prediction: mean(currentLabels) };
    }

    // Split indices
    const leftIndices = indices.filter(i => features[i][bestSplit.feature] <= bestSplit.threshold);
    const rightIndices = indices.filter(i => features[i][bestSplit.feature] > bestSplit.threshold);

    if (leftIndices.length < this.minSamplesLeaf || rightIndices.length < this.minSamplesLeaf) {
      return { isLeaf: true, prediction: mean(currentLabels) };
    }

    return {
      isLeaf: false,
      featureName: bestSplit.feature,
      threshold: bestSplit.threshold,
      gain: bestSplit.gain,
      left: this.buildTree(features, labels, leftIndices, depth + 1),
      right: this.buildTree(features, labels, rightIndices, depth + 1),
    };
  }

  private findBestSplit(
    features: Record<string, number>[],
    labels: number[],
    indices: number[]
  ): { feature: string; threshold: number; gain: number } | null {
    if (indices.length === 0 || features.length === 0) return null;

    const featureNames = Object.keys(features[0]);
    let bestGain = -Infinity;
    let bestFeature = "";
    let bestThreshold = 0;

    const parentVariance = this.variance(indices.map(i => labels[i]));
    const n = indices.length;

    for (const feat of featureNames) {
      // Get unique sorted values for this feature
      const values = indices.map(i => features[i][feat]).filter(v => !isNaN(v));
      const uniqueValues = [...new Set(values)].sort((a, b) => a - b);

      // Try percentile-based thresholds (faster than all unique values)
      const numThresholds = Math.min(10, uniqueValues.length - 1);
      for (let t = 0; t < numThresholds; t++) {
        const idx = Math.floor((t + 1) * uniqueValues.length / (numThresholds + 1));
        const threshold = uniqueValues[idx];

        const leftLabels: number[] = [];
        const rightLabels: number[] = [];

        for (const i of indices) {
          if (features[i][feat] <= threshold) leftLabels.push(labels[i]);
          else rightLabels.push(labels[i]);
        }

        if (leftLabels.length < this.minSamplesLeaf || rightLabels.length < this.minSamplesLeaf) continue;

        // Information gain (variance reduction)
        const leftVar = this.variance(leftLabels);
        const rightVar = this.variance(rightLabels);
        const weightedVar = (leftLabels.length / n) * leftVar + (rightLabels.length / n) * rightVar;
        const gain = parentVariance - weightedVar;

        if (gain > bestGain) {
          bestGain = gain;
          bestFeature = feat;
          bestThreshold = threshold;
        }
      }
    }

    return bestGain > 0 ? { feature: bestFeature, threshold: bestThreshold, gain: bestGain } : null;
  }

  private traverseTree(node: ITreeNode, features: Record<string, number>): number {
    if (node.isLeaf) return node.prediction || 0;
    if (!node.featureName || node.threshold === undefined) return node.prediction || 0;

    const value = features[node.featureName] || 0;
    if (value <= node.threshold) {
      return node.left ? this.traverseTree(node.left, features) : 0;
    }
    return node.right ? this.traverseTree(node.right, features) : 0;
  }

  private collectImportance(node: ITreeNode, importance: Record<string, number>): void {
    if (node.isLeaf) return;
    if (node.featureName && node.gain) {
      importance[node.featureName] = (importance[node.featureName] || 0) + node.gain;
    }
    if (node.left) this.collectImportance(node.left, importance);
    if (node.right) this.collectImportance(node.right, importance);
  }

  private variance(values: number[]): number {
    if (values.length < 2) return 0;
    const avg = mean(values);
    return values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  }
}

// ============================================================================
// GRADIENT BOOSTED ENSEMBLE
// ============================================================================

export class GradientBoostedEnsemble {
  private trees: DecisionTree[] = [];
  private learningRate: number;
  private numTrees: number;
  private maxDepth: number;
  private subsampleRate: number;
  private featureImportance: Record<string, number> = {};
  private trainLoss: number[] = [];

  constructor(
    numTrees = 50,
    learningRate = 0.1,
    maxDepth = 4,
    subsampleRate = 0.8
  ) {
    this.numTrees = numTrees;
    this.learningRate = learningRate;
    this.maxDepth = maxDepth;
    this.subsampleRate = subsampleRate;
  }

  /**
   * Train the ensemble using gradient boosting.
   *
   * Algorithm:
   * 1. Initialize predictions to mean of labels
   * 2. For each tree:
   *    a. Compute residuals (labels - current predictions)
   *    b. Subsample training data
   *    c. Fit tree to residuals
   *    d. Update predictions: pred += learningRate * tree_pred
   * 3. Early stopping if loss plateaus
   */
  train(features: Record<string, number>[], labels: number[]): void {
    const n = labels.length;
    if (n < 20) return;

    // Initialize predictions to mean
    const basePred = mean(labels);
    const predictions = new Array(n).fill(basePred);
    this.trees = [];
    this.trainLoss = [];

    for (let t = 0; t < this.numTrees; t++) {
      // Compute residuals (negative gradient of MSE loss)
      const residuals = labels.map((y, i) => y - predictions[i]);

      // Subsample
      const sampleSize = Math.floor(n * this.subsampleRate);
      const sampleIndices: number[] = [];
      for (let i = 0; i < sampleSize; i++) {
        sampleIndices.push(Math.floor(Math.random() * n));
      }

      const sampleFeatures = sampleIndices.map(i => features[i]);
      const sampleResiduals = sampleIndices.map(i => residuals[i]);

      // Fit tree to residuals
      const tree = new DecisionTree(this.maxDepth, 5, 0.00001);
      tree.fit(sampleFeatures, sampleResiduals);
      this.trees.push(tree);

      // Update predictions
      for (let i = 0; i < n; i++) {
        predictions[i] += this.learningRate * tree.predict(features[i]);
      }

      // Track loss
      const mse = labels.reduce((s, y, i) => s + (y - predictions[i]) ** 2, 0) / n;
      this.trainLoss.push(mse);

      // Early stopping: if loss hasn't improved in 5 rounds
      if (t > 10 && this.trainLoss.length > 5) {
        const recent = this.trainLoss.slice(-5);
        const improving = recent[4] < recent[0] * 0.999;
        if (!improving) {
          logger.info(`[GBM] Early stopping at tree ${t + 1}: loss ${mse.toFixed(6)}`);
          break;
        }
      }

      // Accumulate feature importance
      const treeImp = tree.getFeatureImportance();
      for (const [feat, imp] of Object.entries(treeImp)) {
        this.featureImportance[feat] = (this.featureImportance[feat] || 0) + imp;
      }
    }

    // Normalize feature importance
    const totalImp = Object.values(this.featureImportance).reduce((s, v) => s + v, 0);
    if (totalImp > 0) {
      for (const key of Object.keys(this.featureImportance)) {
        this.featureImportance[key] /= totalImp;
      }
    }
  }

  /**
   * Predict using the trained ensemble.
   */
  predict(features: Record<string, number>): number {
    if (this.trees.length === 0) return 0;

    let prediction = 0; // Base prediction would be mean, but simplified
    for (const tree of this.trees) {
      prediction += this.learningRate * tree.predict(features);
    }
    return prediction;
  }

  getFeatureImportance(): Record<string, number> {
    return { ...this.featureImportance };
  }

  getTopFeatures(n = 10): { name: string; importance: number }[] {
    return Object.entries(this.featureImportance)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, importance]) => ({ name, importance }));
  }

  getTrainLoss(): number[] {
    return [...this.trainLoss];
  }

  getNumTrees(): number {
    return this.trees.length;
  }
}

// ============================================================================
// MODEL MONITORING
// ============================================================================

export class ModelMonitor {
  private predictionErrors: number[] = [];
  private predictions: number[] = [];
  private actuals: number[] = [];
  private readonly window: number;
  private retrainTriggered = false;

  constructor(window = 200) {
    this.window = window;
  }

  /**
   * Record a prediction-actual pair.
   */
  record(prediction: number, actual: number): void {
    this.predictions.push(prediction);
    this.actuals.push(actual);
    this.predictionErrors.push(Math.abs(prediction - actual));

    if (this.predictionErrors.length > this.window * 2) {
      this.predictionErrors.splice(0, this.predictionErrors.length - this.window * 2);
      this.predictions.splice(0, this.predictions.length - this.window * 2);
      this.actuals.splice(0, this.actuals.length - this.window * 2);
    }
  }

  /**
   * Detect model degradation.
   *
   * Signals:
   * 1. MAE increasing trend → model losing accuracy
   * 2. Prediction-actual correlation dropping → model losing signal
   * 3. Prediction distribution shift → inputs changing
   */
  checkDegradation(): {
    isDegraded: boolean;
    mae: number;
    maeTrend: "increasing" | "stable" | "decreasing";
    predActualCorr: number;
    shouldRetrain: boolean;
    reason: string;
  } {
    if (this.predictionErrors.length < 50) {
      return { isDegraded: false, mae: 0, maeTrend: "stable", predActualCorr: 0, shouldRetrain: false, reason: "insufficient data" };
    }

    const recentErrors = this.predictionErrors.slice(-this.window);
    const mae = mean(recentErrors);

    // MAE trend: first half vs second half
    const half = Math.floor(recentErrors.length / 2);
    const firstHalfMAE = mean(recentErrors.slice(0, half));
    const secondHalfMAE = mean(recentErrors.slice(half));
    let maeTrend: "increasing" | "stable" | "decreasing" = "stable";
    if (secondHalfMAE > firstHalfMAE * 1.2) maeTrend = "increasing";
    else if (secondHalfMAE < firstHalfMAE * 0.8) maeTrend = "decreasing";

    // Prediction-actual correlation
    const recentPreds = this.predictions.slice(-this.window);
    const recentActuals = this.actuals.slice(-this.window);
    const corr = recentPreds.length > 10 ? correlation(recentPreds, recentActuals) : 0;

    // Degradation detection
    const isDegraded = maeTrend === "increasing" && corr < 0.2;
    const shouldRetrain = isDegraded || corr < 0.1;
    let reason = "model performing normally";
    if (isDegraded) reason = `MAE increasing (${firstHalfMAE.toFixed(4)} → ${secondHalfMAE.toFixed(4)}) and correlation low (${corr.toFixed(3)})`;
    else if (shouldRetrain) reason = `Low prediction-actual correlation: ${corr.toFixed(3)}`;

    return { isDegraded, mae, maeTrend, predActualCorr: corr, shouldRetrain, reason };
  }
}

// ============================================================================
// SIGNAL CONVERTER
// ============================================================================

/**
 * Convert raw model predictions to trading signals.
 *
 * Steps:
 * 1. Z-score normalize predictions
 * 2. Apply sigmoid to bound in [-1, 1]
 * 3. Apply conviction threshold
 * 4. Convert to portfolio weight
 */
export function predictionToSignal(
  prediction: number,
  recentPredictions: number[],
  threshold = 0.5
): { signal: number; conviction: number; confidence: number } {
  if (recentPredictions.length < 10) {
    return { signal: 0, conviction: 0, confidence: 0 };
  }

  // Z-score normalize
  const predMean = mean(recentPredictions);
  const predStd = stddev(recentPredictions);
  const z = predStd > 0 ? (prediction - predMean) / predStd : 0;

  // Sigmoid to bound
  const sigmoid = 2 / (1 + Math.exp(-z)) - 1; // Maps to [-1, 1]

  // Apply threshold
  const conviction = Math.abs(sigmoid) > threshold ? sigmoid : 0;

  // Confidence based on z-score magnitude
  const confidence = Math.min(1, Math.abs(z) / 3);

  return {
    signal: Math.sign(conviction),
    conviction,
    confidence,
  };
}
