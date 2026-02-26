import { HFTStrategyBase } from "./HFTStrategyBase";
import { ITickSnapshot, IArbOpportunity } from "../../types/hft.types";
import { mean, stddev } from "../../utils/mathUtils";

/**
 * Deep Level-2 Orderbook Microstructure Analysis.
 *
 * Detects institutional flow and smart money positioning through:
 * 1. Book Imbalance Momentum — rate of change of bid/ask depth ratio
 * 2. Sweep Detection — multiple ask/bid levels cleared in sequence
 * 3. Large Resting Orders — abnormally large orders as support/resistance
 * 4. VPIN — Volume-Synchronized Probability of Informed Trading
 *
 * Extreme selectivity: only fires when 2+ signals align.
 * Win rate target: 95%+ through high conviction filtering.
 */
export class OrderbookMicrostructureStrategy extends HFTStrategyBase {
  readonly id = "hft-microstructure";
  readonly name = "Orderbook Microstructure Analysis";
  readonly type = "microstructure" as const;

  // Rolling imbalance history for momentum
  private imbalanceHistory: number[] = [];
  // Rolling depth history for sweep detection
  private yesAskLevelCountHistory: number[] = [];
  private noAskLevelCountHistory: number[] = [];
  private yesBidLevelCountHistory: number[] = [];
  private noBidLevelCountHistory: number[] = [];
  // VPIN estimation buckets
  private vpinBuyVolume: number[] = [];
  private vpinSellVolume: number[] = [];

  onTick(snapshot: ITickSnapshot, history: ITickSnapshot[]): IArbOpportunity[] {
    const opportunities: IArbOpportunity[] = [];

    // === Signal 1: Book Imbalance Momentum ===
    const imbalanceSignal = this.detectImbalanceMomentum(snapshot);

    // === Signal 2: Sweep Detection ===
    const sweepSignal = this.detectSweep(snapshot);

    // === Signal 3: Large Resting Orders ===
    const largeOrderSignal = this.detectLargeOrders(snapshot);

    // === Signal 4: VPIN ===
    const vpinSignal = this.estimateVPIN(snapshot, history);

    // === Confluence Filter ===
    // Only trade when 2+ signals agree on direction
    const signals = [imbalanceSignal, sweepSignal, largeOrderSignal, vpinSignal];
    const activeSignals = signals.filter((s) => s.active);

    if (activeSignals.length < 2) return opportunities;

    // Check directional agreement
    const bullishCount = activeSignals.filter((s) => s.direction === "BUY").length;
    const bearishCount = activeSignals.filter((s) => s.direction === "SELL").length;

    if (bullishCount < 2 && bearishCount < 2) return opportunities;

    const isBullish = bullishCount >= bearishCount;
    const direction = isBullish ? "BUY" as const : "SELL" as const;
    const tokenDirection = isBullish ? "YES" as const : "NO" as const;
    const tokenId = isBullish ? snapshot.yesTokenId : snapshot.noTokenId;
    const asks = isBullish ? snapshot.yesAsks : snapshot.noAsks;

    if (asks.length === 0) return opportunities;

    const askPrice = parseFloat(asks[0].price);
    const askSize = parseFloat(asks[0].size);

    // Confidence based on signal strength and confluence count
    const avgConfidence =
      activeSignals
        .filter((s) => s.direction === direction)
        .reduce((sum, s) => sum + s.confidence, 0) /
      Math.max(1, activeSignals.filter((s) => s.direction === direction).length);

    const confluenceBonus = activeSignals.length >= 3 ? 0.1 : 0;
    const confidence = Math.min(0.95, avgConfidence + confluenceBonus);

    const edge = (confidence - askPrice) * 0.5; // Conservative edge estimate
    if (edge < 0.02) return opportunities;

    const sizeUSDC = Math.min(askSize * askPrice, 20);
    if (sizeUSDC < 2) return opportunities;

    opportunities.push({
      type: "microstructure",
      strategyId: this.id,
      asset: snapshot.asset,
      interval: snapshot.interval,
      conditionId: snapshot.conditionId,
      direction: tokenDirection,
      tokenId,
      side: "BUY",
      price: askPrice,
      size: sizeUSDC,
      expectedProfit: edge * (sizeUSDC / askPrice),
      confidence,
      edge,
      orderType: "FOK",
      metadata: {
        confluenceCount: activeSignals.length,
        signals: activeSignals.map((s) => s.name),
        bullishCount,
        bearishCount,
      },
    });

    return opportunities;
  }

  /**
   * Signal 1: Detect momentum in orderbook imbalance.
   * Not just the level, but how fast it's changing.
   */
  private detectImbalanceMomentum(
    snapshot: ITickSnapshot
  ): { active: boolean; direction: "BUY" | "SELL"; confidence: number; name: string } {
    const yesBidDepth = snapshot.yesBidDepth;
    const noBidDepth = snapshot.noBidDepth;
    const totalDepth = yesBidDepth + noBidDepth;

    if (totalDepth === 0) {
      return { active: false, direction: "BUY", confidence: 0, name: "imbalance_momentum" };
    }

    const currentImbalance = yesBidDepth / totalDepth;
    this.imbalanceHistory.push(currentImbalance);
    if (this.imbalanceHistory.length > 20) {
      this.imbalanceHistory.shift();
    }

    if (this.imbalanceHistory.length < 10) {
      return { active: false, direction: "BUY", confidence: 0, name: "imbalance_momentum" };
    }

    // Rate of change: compare current to 5 ticks ago (~2.5s)
    const prevImbalance = this.imbalanceHistory[this.imbalanceHistory.length - 6];
    const imbalanceChange = currentImbalance - prevImbalance;

    // Significant shift threshold: 10%
    if (Math.abs(imbalanceChange) < 0.10) {
      return { active: false, direction: "BUY", confidence: 0, name: "imbalance_momentum" };
    }

    const direction = imbalanceChange > 0 ? "BUY" as const : "SELL" as const;
    const confidence = Math.min(0.90, 0.65 + Math.abs(imbalanceChange) * 2);

    return { active: true, direction, confidence, name: "imbalance_momentum" };
  }

  /**
   * Signal 2: Detect aggressive sweeps (multiple levels cleared).
   */
  private detectSweep(
    snapshot: ITickSnapshot
  ): { active: boolean; direction: "BUY" | "SELL"; confidence: number; name: string } {
    const yesAskLevels = snapshot.yesAsks.filter(
      (l) => parseFloat(l.size) > 0
    ).length;
    const noAskLevels = snapshot.noAsks.filter(
      (l) => parseFloat(l.size) > 0
    ).length;
    const yesBidLevels = snapshot.yesBids.filter(
      (l) => parseFloat(l.size) > 0
    ).length;
    const noBidLevels = snapshot.noBids.filter(
      (l) => parseFloat(l.size) > 0
    ).length;

    this.yesAskLevelCountHistory.push(yesAskLevels);
    this.noAskLevelCountHistory.push(noAskLevels);
    this.yesBidLevelCountHistory.push(yesBidLevels);
    this.noBidLevelCountHistory.push(noBidLevels);

    // Keep last 10 ticks
    for (const arr of [
      this.yesAskLevelCountHistory,
      this.noAskLevelCountHistory,
      this.yesBidLevelCountHistory,
      this.noBidLevelCountHistory,
    ]) {
      if (arr.length > 10) arr.shift();
    }

    if (this.yesAskLevelCountHistory.length < 3) {
      return { active: false, direction: "BUY", confidence: 0, name: "sweep" };
    }

    const prevYesAsk =
      this.yesAskLevelCountHistory[this.yesAskLevelCountHistory.length - 2];
    const prevNoAsk =
      this.noAskLevelCountHistory[this.noAskLevelCountHistory.length - 2];

    // YES ask levels cleared = aggressive buying of YES → bullish
    if (prevYesAsk - yesAskLevels >= 3) {
      return { active: true, direction: "BUY", confidence: 0.88, name: "sweep_yes_ask" };
    }

    // NO ask levels cleared = aggressive buying of NO → bearish
    if (prevNoAsk - noAskLevels >= 3) {
      return { active: true, direction: "SELL", confidence: 0.88, name: "sweep_no_ask" };
    }

    // YES bid levels cleared = aggressive selling → bearish
    const prevYesBid =
      this.yesBidLevelCountHistory[this.yesBidLevelCountHistory.length - 2];
    if (prevYesBid - yesBidLevels >= 3) {
      return { active: true, direction: "SELL", confidence: 0.85, name: "sweep_yes_bid" };
    }

    return { active: false, direction: "BUY", confidence: 0, name: "sweep" };
  }

  /**
   * Signal 3: Detect abnormally large resting orders.
   */
  private detectLargeOrders(
    snapshot: ITickSnapshot
  ): { active: boolean; direction: "BUY" | "SELL"; confidence: number; name: string } {
    const allYesBidSizes = snapshot.yesBids.map((l) => parseFloat(l.size));
    const allYesAskSizes = snapshot.yesAsks.map((l) => parseFloat(l.size));

    if (allYesBidSizes.length < 3 || allYesAskSizes.length < 3) {
      return { active: false, direction: "BUY", confidence: 0, name: "large_order" };
    }

    const bidMean = mean(allYesBidSizes);
    const bidStd = stddev(allYesBidSizes);
    const askMean = mean(allYesAskSizes);
    const askStd = stddev(allYesAskSizes);

    // Large bid = support (bullish)
    const maxBid = Math.max(...allYesBidSizes);
    if (bidStd > 0 && maxBid > bidMean + 3 * bidStd) {
      return { active: true, direction: "BUY", confidence: 0.75, name: "large_bid_support" };
    }

    // Large ask = resistance (bearish)
    const maxAsk = Math.max(...allYesAskSizes);
    if (askStd > 0 && maxAsk > askMean + 3 * askStd) {
      return { active: true, direction: "SELL", confidence: 0.75, name: "large_ask_resistance" };
    }

    return { active: false, direction: "BUY", confidence: 0, name: "large_order" };
  }

  /**
   * Signal 4: VPIN estimation.
   * Measures probability of informed trading from order flow.
   */
  private estimateVPIN(
    snapshot: ITickSnapshot,
    history: ITickSnapshot[]
  ): { active: boolean; direction: "BUY" | "SELL"; confidence: number; name: string } {
    if (history.length < 5) {
      return { active: false, direction: "BUY", confidence: 0, name: "vpin" };
    }

    // Estimate buy/sell volume from price changes and depth changes
    const prev = history[history.length - 2];
    if (!prev) {
      return { active: false, direction: "BUY", confidence: 0, name: "vpin" };
    }

    const midChange = snapshot.yesMid - prev.yesMid;
    const depthChange = snapshot.yesBidDepth - prev.yesBidDepth;

    // Positive mid change + decreasing ask depth = buy pressure
    // Negative mid change + decreasing bid depth = sell pressure
    if (midChange > 0) {
      this.vpinBuyVolume.push(Math.abs(midChange) * 100);
      this.vpinSellVolume.push(0);
    } else if (midChange < 0) {
      this.vpinBuyVolume.push(0);
      this.vpinSellVolume.push(Math.abs(midChange) * 100);
    }

    // Keep last 20 buckets
    if (this.vpinBuyVolume.length > 20) {
      this.vpinBuyVolume.shift();
      this.vpinSellVolume.shift();
    }

    if (this.vpinBuyVolume.length < 10) {
      return { active: false, direction: "BUY", confidence: 0, name: "vpin" };
    }

    const totalBuy = this.vpinBuyVolume.reduce((s, v) => s + v, 0);
    const totalSell = this.vpinSellVolume.reduce((s, v) => s + v, 0);
    const total = totalBuy + totalSell;

    if (total === 0) {
      return { active: false, direction: "BUY", confidence: 0, name: "vpin" };
    }

    const vpin = Math.abs(totalBuy - totalSell) / total;

    // VPIN > 0.7 = highly informed flow
    if (vpin < 0.7) {
      return { active: false, direction: "BUY", confidence: 0, name: "vpin" };
    }

    const direction = totalBuy > totalSell ? "BUY" as const : "SELL" as const;
    const confidence = Math.min(0.90, 0.65 + vpin * 0.3);

    return { active: true, direction, confidence, name: `vpin_${vpin.toFixed(2)}` };
  }
}
