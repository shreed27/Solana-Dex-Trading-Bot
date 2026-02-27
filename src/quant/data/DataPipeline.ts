/**
 * ============================================================================
 * BLOOMBERG — MARKET DATA PIPELINE
 * ============================================================================
 *
 * Real-time and historical data infrastructure feeding trading systems.
 *
 * COMPONENTS:
 * 1. Feature Store — Pre-computed technical indicators ready for signals
 * 2. Data Validator — Automated quality checks
 * 3. Ring Buffer Storage — Efficient in-memory time series
 * 4. OHLCV Aggregator — Build bars from tick data
 * 5. Corporate Action Adjuster — Handle splits/dividends
 *
 * ============================================================================
 */

import { mean, stddev, ema } from "../../utils/mathUtils";
import { IUnifiedOrderbook } from "../../types/exchange.types";
import { logger } from "../../utils/logger";

// ============================================================================
// RING BUFFER TIME SERIES
// ============================================================================

export class TimeSeriesBuffer<T> {
  private data: T[] = [];
  private timestamps: number[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  push(value: T, timestamp = Date.now()): void {
    this.data.push(value);
    this.timestamps.push(timestamp);
    if (this.data.length > this.maxSize) {
      this.data.shift();
      this.timestamps.shift();
    }
  }

  get(n?: number): T[] {
    return n ? this.data.slice(-n) : [...this.data];
  }

  getWithTimestamps(n?: number): { value: T; timestamp: number }[] {
    const data = n ? this.data.slice(-n) : this.data;
    const ts = n ? this.timestamps.slice(-n) : this.timestamps;
    return data.map((v, i) => ({ value: v, timestamp: ts[i] }));
  }

  latest(): T | undefined {
    return this.data[this.data.length - 1];
  }

  length(): number {
    return this.data.length;
  }

  getRange(startTime: number, endTime: number): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.timestamps.length; i++) {
      if (this.timestamps[i] >= startTime && this.timestamps[i] <= endTime) {
        result.push(this.data[i]);
      }
    }
    return result;
  }

  clear(): void {
    this.data = [];
    this.timestamps = [];
  }
}

// ============================================================================
// OHLCV BAR AGGREGATOR
// ============================================================================

export interface IOHLCVBar {
  timestamp: number;       // Bar open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;          // Number of ticks in this bar
  vwap: number;
  instrument: string;
}

export class OHLCVAggregator {
  private barDurationMs: number;
  private currentBar: IOHLCVBar | null = null;
  private completedBars: TimeSeriesBuffer<IOHLCVBar>;
  private instrument: string;
  private sumPriceVolume = 0;
  private sumVolume = 0;

  constructor(instrument: string, barDurationMs = 60000, maxBars = 5000) {
    this.instrument = instrument;
    this.barDurationMs = barDurationMs;
    this.completedBars = new TimeSeriesBuffer(maxBars);
  }

  /**
   * Process a tick. Aggregates into OHLCV bars.
   */
  processTick(price: number, volume: number, timestamp = Date.now()): IOHLCVBar | null {
    // Calculate bar boundary
    const barStart = Math.floor(timestamp / this.barDurationMs) * this.barDurationMs;

    if (!this.currentBar || this.currentBar.timestamp !== barStart) {
      // New bar — complete the old one
      let completedBar: IOHLCVBar | null = null;
      if (this.currentBar) {
        this.currentBar.vwap = this.sumVolume > 0 ? this.sumPriceVolume / this.sumVolume : this.currentBar.close;
        this.completedBars.push(this.currentBar, this.currentBar.timestamp);
        completedBar = this.currentBar;
      }

      // Start new bar
      this.currentBar = {
        timestamp: barStart,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: volume,
        trades: 1,
        vwap: price,
        instrument: this.instrument,
      };
      this.sumPriceVolume = price * volume;
      this.sumVolume = volume;

      return completedBar;
    }

    // Update current bar
    this.currentBar.high = Math.max(this.currentBar.high, price);
    this.currentBar.low = Math.min(this.currentBar.low, price);
    this.currentBar.close = price;
    this.currentBar.volume += volume;
    this.currentBar.trades++;
    this.sumPriceVolume += price * volume;
    this.sumVolume += volume;

    return null; // Bar not yet complete
  }

  getBars(n?: number): IOHLCVBar[] {
    return this.completedBars.get(n);
  }

  getCurrentBar(): IOHLCVBar | null {
    return this.currentBar;
  }

  getBarCount(): number {
    return this.completedBars.length();
  }
}

// ============================================================================
// FEATURE STORE
// ============================================================================

export interface IFeatureStoreEntry {
  timestamp: number;
  instrument: string;
  features: Record<string, number>;
}

export class FeatureStore {
  private stores: Map<string, TimeSeriesBuffer<IFeatureStoreEntry>> = new Map();
  private aggregators: Map<string, OHLCVAggregator> = new Map();

  /**
   * Register an instrument for feature tracking.
   */
  registerInstrument(instrument: string, barDurationMs = 60000): void {
    if (!this.stores.has(instrument)) {
      this.stores.set(instrument, new TimeSeriesBuffer(2000));
      this.aggregators.set(instrument, new OHLCVAggregator(instrument, barDurationMs));
    }
  }

  /**
   * Process a tick and update features.
   */
  processTick(instrument: string, price: number, volume: number, orderbook?: IUnifiedOrderbook): void {
    const aggregator = this.aggregators.get(instrument);
    if (!aggregator) return;

    const completedBar = aggregator.processTick(price, volume);

    // When a bar completes, compute features
    if (completedBar) {
      const bars = aggregator.getBars();
      if (bars.length >= 20) {
        const features = this.computeFeatures(bars, orderbook);
        const entry: IFeatureStoreEntry = {
          timestamp: completedBar.timestamp,
          instrument,
          features,
        };
        this.stores.get(instrument)?.push(entry, completedBar.timestamp);
      }
    }
  }

  /**
   * Get latest features for an instrument.
   */
  getLatestFeatures(instrument: string): Record<string, number> | null {
    const store = this.stores.get(instrument);
    if (!store) return null;
    const latest = store.latest();
    return latest?.features || null;
  }

  /**
   * Get feature history for training.
   */
  getFeatureHistory(instrument: string, n?: number): IFeatureStoreEntry[] {
    const store = this.stores.get(instrument);
    if (!store) return [];
    return store.get(n);
  }

  /**
   * Compute technical features from OHLCV bars.
   */
  private computeFeatures(bars: IOHLCVBar[], orderbook?: IUnifiedOrderbook): Record<string, number> {
    const features: Record<string, number> = {};
    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const n = closes.length;
    const current = closes[n - 1];

    // Returns
    const ret = (lb: number) => n > lb && closes[n - 1 - lb] > 0
      ? (current - closes[n - 1 - lb]) / closes[n - 1 - lb] : 0;
    features.ret_1bar = ret(1);
    features.ret_5bar = ret(5);
    features.ret_10bar = ret(10);
    features.ret_20bar = n > 20 ? ret(20) : 0;

    // Moving averages
    features.sma_5 = mean(closes.slice(-5));
    features.sma_20 = mean(closes.slice(-20));
    features.price_vs_sma5 = features.sma_5 > 0 ? (current - features.sma_5) / features.sma_5 : 0;
    features.price_vs_sma20 = features.sma_20 > 0 ? (current - features.sma_20) / features.sma_20 : 0;

    // Volatility
    const returns: number[] = [];
    for (let i = 1; i < Math.min(n, 21); i++) {
      if (closes[n - 1 - i] > 0) returns.push((closes[n - i] - closes[n - 1 - i]) / closes[n - 1 - i]);
    }
    features.volatility = returns.length > 2 ? stddev(returns) : 0;

    // Volume features
    features.volume_sma5 = mean(volumes.slice(-5));
    features.volume_sma20 = mean(volumes.slice(-20));
    features.volume_ratio = features.volume_sma20 > 0 ? features.volume_sma5 / features.volume_sma20 : 1;

    // ATR
    const trs: number[] = [];
    for (let i = Math.max(0, n - 14); i < n; i++) {
      const prevClose = i > 0 ? closes[i - 1] : closes[i];
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - prevClose), Math.abs(lows[i] - prevClose)));
    }
    features.atr = trs.length > 0 ? mean(trs) : 0;
    features.atr_pct = current > 0 ? features.atr / current : 0;

    // RSI
    let gains = 0, losses_ = 0;
    for (let i = Math.max(1, n - 14); i < n; i++) {
      const chg = closes[i] - closes[i - 1];
      if (chg > 0) gains += chg; else losses_ -= chg;
    }
    const rs = losses_ > 0 ? gains / losses_ : 100;
    features.rsi = 100 - (100 / (1 + rs));

    // Bollinger
    const bb_mean = features.sma_20;
    const bb_std = stddev(closes.slice(-20));
    features.bollinger_pct = bb_std > 0 ? (current - bb_mean) / (2 * bb_std) : 0;

    // High/Low range position
    const high20 = Math.max(...closes.slice(-20));
    const low20 = Math.min(...closes.slice(-20));
    const range = high20 - low20;
    features.range_position = range > 0 ? (current - low20) / range : 0.5;

    // Orderbook features
    if (orderbook) {
      features.spread_bps = orderbook.midPrice > 0 ? (orderbook.spread / orderbook.midPrice) * 10000 : 0;
      const bidDepth = orderbook.bids.slice(0, 5).reduce((s, l) => s + l.size * l.price, 0);
      const askDepth = orderbook.asks.slice(0, 5).reduce((s, l) => s + l.size * l.price, 0);
      features.book_imbalance = (bidDepth + askDepth) > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : 0;
    }

    return features;
  }

  /**
   * Get all registered instruments.
   */
  getInstruments(): string[] {
    return Array.from(this.stores.keys());
  }
}

// ============================================================================
// DATA VALIDATOR
// ============================================================================

export class DataValidator {
  private validationResults: Map<string, IValidationResult> = new Map();

  /**
   * Validate incoming tick data.
   */
  validateTick(
    instrument: string,
    price: number,
    volume: number,
    lastKnownPrice: number
  ): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    // Zero/negative price
    if (price <= 0) {
      issues.push("Zero or negative price");
    }

    // Extreme move (>20% from last known)
    if (lastKnownPrice > 0 && Math.abs(price - lastKnownPrice) / lastKnownPrice > 0.20) {
      issues.push(`Extreme move: ${((price / lastKnownPrice - 1) * 100).toFixed(1)}% from last price`);
    }

    // Negative volume
    if (volume < 0) {
      issues.push("Negative volume");
    }

    // NaN/Infinity
    if (!isFinite(price) || !isFinite(volume)) {
      issues.push("NaN or Infinity value");
    }

    const valid = issues.length === 0;

    // Track validation stats
    if (!this.validationResults.has(instrument)) {
      this.validationResults.set(instrument, { total: 0, valid: 0, invalid: 0, issues: [] });
    }
    const stats = this.validationResults.get(instrument)!;
    stats.total++;
    if (valid) stats.valid++;
    else {
      stats.invalid++;
      stats.issues.push(...issues);
      if (stats.issues.length > 100) stats.issues.splice(0, stats.issues.length - 100);
    }

    return { valid, issues };
  }

  getValidationStats(): Map<string, IValidationResult> {
    return this.validationResults;
  }
}

interface IValidationResult {
  total: number;
  valid: number;
  invalid: number;
  issues: string[];
}

// ============================================================================
// CORPORATE ACTION ADJUSTER
// ============================================================================

export class CorporateActionAdjuster {
  /**
   * Adjust historical prices for a stock split.
   * Example: 2-for-1 split → divide all pre-split prices by 2
   */
  static adjustForSplit(
    prices: { timestamp: number; price: number }[],
    splitDate: number,
    splitRatio: number // e.g., 2 for 2-for-1 split
  ): { timestamp: number; price: number }[] {
    return prices.map(p => ({
      timestamp: p.timestamp,
      price: p.timestamp < splitDate ? p.price / splitRatio : p.price,
    }));
  }

  /**
   * Adjust for dividend: reduce pre-dividend prices by dividend amount.
   */
  static adjustForDividend(
    prices: { timestamp: number; price: number }[],
    exDivDate: number,
    dividendAmount: number
  ): { timestamp: number; price: number }[] {
    return prices.map(p => ({
      timestamp: p.timestamp,
      price: p.timestamp < exDivDate ? p.price - dividendAmount : p.price,
    }));
  }
}

// ============================================================================
// MASTER DATA PIPELINE
// ============================================================================

export class MarketDataPipeline {
  private featureStore = new FeatureStore();
  private validator = new DataValidator();
  private lastPrices: Map<string, number> = new Map();
  private tickCount = 0;
  private invalidTickCount = 0;

  /**
   * Register instruments to track.
   */
  registerInstruments(instruments: string[], barDurationMs = 60000): void {
    for (const inst of instruments) {
      this.featureStore.registerInstrument(inst, barDurationMs);
    }
  }

  /**
   * Process incoming tick data through the full pipeline.
   *
   * Pipeline stages:
   * 1. Validate data quality
   * 2. Store raw tick
   * 3. Aggregate into OHLCV bars
   * 4. Compute features
   * 5. Make available to strategies
   */
  processTick(
    instrument: string,
    price: number,
    volume: number,
    orderbook?: IUnifiedOrderbook
  ): boolean {
    this.tickCount++;

    // 1. Validate
    const lastPrice = this.lastPrices.get(instrument) || 0;
    const validation = this.validator.validateTick(instrument, price, volume, lastPrice);

    if (!validation.valid) {
      this.invalidTickCount++;
      return false;
    }

    // 2. Update last known price
    this.lastPrices.set(instrument, price);

    // 3. Process through feature store (aggregation + feature computation)
    this.featureStore.processTick(instrument, price, volume, orderbook);

    return true;
  }

  /**
   * Get latest features for signal generation.
   */
  getFeatures(instrument: string): Record<string, number> | null {
    return this.featureStore.getLatestFeatures(instrument);
  }

  /**
   * Get feature history for ML training.
   */
  getTrainingData(instrument: string, n?: number): IFeatureStoreEntry[] {
    return this.featureStore.getFeatureHistory(instrument, n);
  }

  getStats(): {
    ticksProcessed: number;
    invalidTicks: number;
    instruments: number;
    validationRate: number;
  } {
    return {
      ticksProcessed: this.tickCount,
      invalidTicks: this.invalidTickCount,
      instruments: this.featureStore.getInstruments().length,
      validationRate: this.tickCount > 0 ? 1 - this.invalidTickCount / this.tickCount : 1,
    };
  }

  getFeatureStore(): FeatureStore { return this.featureStore; }
  getValidator(): DataValidator { return this.validator; }
}
