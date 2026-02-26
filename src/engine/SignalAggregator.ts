import {
  ISignal,
  IAggregatedSignal,
  SignalDirection,
} from "../types/strategy.types";
import { SignalModel } from "../models/Signal";
import { logger } from "../utils/logger";

export class SignalAggregator {
  // In-memory signal buffer, keyed by tokenAddress
  private signalBuffer: Map<string, ISignal[]> = new Map();

  // Strategy weights (loaded from StrategyConfig)
  private weights: Map<string, number> = new Map();

  // Default weights
  private static readonly DEFAULT_WEIGHTS: Record<string, number> = {
    "macd-momentum": 0.15,
    "volume-breakout": 0.2,
    "sentiment-analysis": 0.12,
    "mean-reversion-bb": 0.1,
    "orderbook-imbalance": 0.08,
    "ml-tensor-predictor": 0.18,
    "whale-copy-trading": 0.17,
  };

  constructor(weights?: Map<string, number>) {
    if (weights) {
      this.weights = weights;
    } else {
      for (const [id, w] of Object.entries(
        SignalAggregator.DEFAULT_WEIGHTS
      )) {
        this.weights.set(id, w);
      }
    }
  }

  setWeight(strategyId: string, weight: number): void {
    this.weights.set(strategyId, weight);
  }

  /**
   * Ingest a signal from any strategy.
   * Replaces any previous signal from same strategy for same token.
   */
  ingestSignal(signal: ISignal): void {
    const existing = this.signalBuffer.get(signal.tokenAddress) || [];
    const filtered = existing.filter(
      (s) => s.strategyId !== signal.strategyId
    );
    filtered.push(signal);
    this.signalBuffer.set(signal.tokenAddress, filtered);

    // Persist to MongoDB for audit trail (fire and forget)
    SignalModel.create({
      strategyId: signal.strategyId,
      tokenAddress: signal.tokenAddress,
      direction: signal.direction,
      confidence: signal.confidence,
      weight: signal.weight,
      metadata: signal.metadata,
      expiresAt: signal.expiresAt,
    }).catch(() => {});
  }

  /**
   * Get the current aggregated signal for a token.
   */
  getAggregatedSignal(tokenAddress: string): IAggregatedSignal | null {
    const signals = this.signalBuffer.get(tokenAddress);
    if (!signals || signals.length === 0) return null;

    const now = new Date();
    const activeSignals = signals.filter((s) => s.expiresAt > now);
    if (activeSignals.length === 0) return null;

    const buySignals = activeSignals.filter(
      (s) => s.direction === SignalDirection.BUY
    );
    const sellSignals = activeSignals.filter(
      (s) => s.direction === SignalDirection.SELL
    );

    const buyScore = this.calculateCompositeScore(buySignals);
    const sellScore = this.calculateCompositeScore(sellSignals);

    const direction =
      buyScore > sellScore
        ? SignalDirection.BUY
        : sellScore > buyScore
        ? SignalDirection.SELL
        : SignalDirection.NEUTRAL;

    return {
      tokenAddress,
      direction,
      compositeScore: Math.max(buyScore, sellScore),
      contributingSignals: activeSignals,
      requiredConfidence: 0.65,
      passedRiskGate: false,
      timestamp: now,
    };
  }

  /**
   * Calculate weighted composite score with confluence bonus.
   */
  private calculateCompositeScore(signals: ISignal[]): number {
    if (signals.length === 0) return 0;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const signal of signals) {
      const weight =
        this.weights.get(signal.strategyId) || signal.weight;
      weightedSum += signal.confidence * weight;
      totalWeight += weight;
    }

    const baseScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Confluence bonus
    const confluenceMultiplier =
      signals.length >= 5
        ? 1.2
        : signals.length >= 3
        ? 1.1
        : 1.0;

    return Math.min(1.0, baseScore * confluenceMultiplier);
  }

  /**
   * Get all tokens with buy signals above threshold.
   */
  getBuyableTokens(minScore: number = 0.65): IAggregatedSignal[] {
    const results: IAggregatedSignal[] = [];
    for (const tokenAddress of this.signalBuffer.keys()) {
      const agg = this.getAggregatedSignal(tokenAddress);
      if (
        agg &&
        agg.direction === SignalDirection.BUY &&
        agg.compositeScore >= minScore
      ) {
        results.push(agg);
      }
    }
    return results.sort((a, b) => b.compositeScore - a.compositeScore);
  }

  /**
   * Get all tokens with sell signals above threshold.
   */
  getSellableTokens(minScore: number = 0.6): IAggregatedSignal[] {
    const results: IAggregatedSignal[] = [];
    for (const tokenAddress of this.signalBuffer.keys()) {
      const agg = this.getAggregatedSignal(tokenAddress);
      if (
        agg &&
        agg.direction === SignalDirection.SELL &&
        agg.compositeScore >= minScore
      ) {
        results.push(agg);
      }
    }
    return results.sort((a, b) => b.compositeScore - a.compositeScore);
  }

  /**
   * Remove expired signals.
   */
  pruneExpired(): void {
    const now = new Date();
    let pruned = 0;
    for (const [tokenAddress, signals] of this.signalBuffer) {
      const active = signals.filter((s) => s.expiresAt > now);
      if (active.length === 0) {
        this.signalBuffer.delete(tokenAddress);
      } else {
        this.signalBuffer.set(tokenAddress, active);
      }
      pruned += signals.length - active.length;
    }
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} expired signals`);
    }
  }

  /**
   * Get signal count stats.
   */
  getStats(): { totalTokens: number; totalSignals: number } {
    let totalSignals = 0;
    for (const signals of this.signalBuffer.values()) {
      totalSignals += signals.length;
    }
    return { totalTokens: this.signalBuffer.size, totalSignals };
  }
}
