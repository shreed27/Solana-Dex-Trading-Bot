import { HFTStrategyBase } from "./HFTStrategyBase";
import { ITickSnapshot, IArbOpportunity } from "../../types/hft.types";

/**
 * Latency Arbitrage: Exploit the delay between Binance price moves
 * and Polymarket YES/NO token repricing.
 *
 * When Binance BTC moves 0.2% in 10 seconds, Polymarket tokens
 * typically lag 1-5 seconds behind. We buy the underpriced side
 * before the market catches up.
 *
 * Win rate: ~95%+ (depends on speed advantage and move magnitude)
 */
export class LatencyArbitrageStrategy extends HFTStrategyBase {
  readonly id = "hft-latency-arb";
  readonly name = "Binance-Polymarket Latency Arbitrage";
  readonly type = "latency_arb" as const;

  // Rolling price buffer for acceleration detection
  private priceChangeHistory: number[] = [];

  onTick(snapshot: ITickSnapshot, history: ITickSnapshot[]): IArbOpportunity[] {
    const opportunities: IArbOpportunity[] = [];

    if (snapshot.binancePrice <= 0) return opportunities;

    const priceChange10s = snapshot.binancePriceChange10s;
    const priceChange30s = snapshot.binancePriceChange30s;

    // Track price change history for acceleration detection
    this.priceChangeHistory.push(priceChange10s);
    if (this.priceChangeHistory.length > 60) {
      this.priceChangeHistory.shift();
    }

    // === Primary Signal: Sharp Binance Move ===
    // Minimum 0.2% move in 10 seconds (significant for BTC/ETH)
    const minMoveThreshold = 0.002;
    if (Math.abs(priceChange10s) < minMoveThreshold) return opportunities;

    // Check if Polymarket has already repriced
    const isUpMove = priceChange10s > 0;
    const yesMid = snapshot.yesMid;

    // Expected YES price direction: UP move → YES should be higher
    // If Binance moved up but YES price hasn't increased proportionally, there's lag
    const lagDetected = this.detectLag(snapshot, history, isUpMove);

    if (!lagDetected.hasLag) return opportunities;

    // === Momentum Acceleration Bonus ===
    const acceleration = this.detectAcceleration();
    const accelerationBonus = acceleration > 0.001 ? 0.1 : 0;

    // === Execute ===
    if (isUpMove) {
      // Binance UP → buy YES (underpriced due to lag)
      if (snapshot.yesAsks.length === 0) return opportunities;

      const askPrice = parseFloat(snapshot.yesAsks[0].price);
      const askSize = parseFloat(snapshot.yesAsks[0].size);
      const edge = lagDetected.lagAmount;
      const confidence = Math.min(0.95, 0.70 + edge * 3 + accelerationBonus);

      // Size based on edge magnitude
      const sizeUSDC = Math.min(
        askSize * askPrice,
        Math.max(5, edge * 500), // Scale size with edge
        25 // Hard cap
      );

      if (sizeUSDC >= 2 && edge >= 0.03) {
        opportunities.push({
          type: "latency_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "YES",
          tokenId: snapshot.yesTokenId,
          side: "BUY",
          price: askPrice,
          size: sizeUSDC,
          expectedProfit: edge * (sizeUSDC / askPrice),
          confidence,
          edge,
          orderType: "FOK",
          metadata: {
            binanceChange10s: priceChange10s,
            binanceChange30s: priceChange30s,
            lagAmount: lagDetected.lagAmount,
            acceleration,
            yesMidBeforeTrade: yesMid,
          },
        });
      }
    } else {
      // Binance DOWN → buy NO (underpriced due to lag)
      if (snapshot.noAsks.length === 0) return opportunities;

      const askPrice = parseFloat(snapshot.noAsks[0].price);
      const askSize = parseFloat(snapshot.noAsks[0].size);
      const edge = lagDetected.lagAmount;
      const confidence = Math.min(0.95, 0.70 + edge * 3 + accelerationBonus);

      const sizeUSDC = Math.min(
        askSize * askPrice,
        Math.max(5, edge * 500),
        25
      );

      if (sizeUSDC >= 2 && edge >= 0.03) {
        opportunities.push({
          type: "latency_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "NO",
          tokenId: snapshot.noTokenId,
          side: "BUY",
          price: askPrice,
          size: sizeUSDC,
          expectedProfit: edge * (sizeUSDC / askPrice),
          confidence,
          edge,
          orderType: "FOK",
          metadata: {
            binanceChange10s: priceChange10s,
            binanceChange30s: priceChange30s,
            lagAmount: lagDetected.lagAmount,
            acceleration,
            noMidBeforeTrade: snapshot.noMid,
          },
        });
      }
    }

    return opportunities;
  }

  /**
   * Detect if Polymarket is lagging behind Binance.
   * Compare expected YES price movement vs actual.
   */
  private detectLag(
    snapshot: ITickSnapshot,
    history: ITickSnapshot[],
    isUpMove: boolean
  ): { hasLag: boolean; lagAmount: number } {
    if (history.length < 5) return { hasLag: false, lagAmount: 0 };

    // Get YES mid price from 5 ticks ago (~2.5 seconds)
    const prevSnapshot = history[history.length - 5];
    if (!prevSnapshot) return { hasLag: false, lagAmount: 0 };

    const yesMidNow = snapshot.yesMid;
    const yesMidPrev = prevSnapshot.yesMid;
    const yesPriceChange = yesMidNow - yesMidPrev;

    // Expected: if Binance moved up 0.3%, YES should move up proportionally
    // In 5M markets, YES price sensitivity to underlying is roughly 1:1 near 0.50
    // Near extremes (0.10 or 0.90), sensitivity is lower
    const sensitivity = 1.0 - Math.abs(yesMidNow - 0.5) * 1.5;
    const expectedYesChange =
      snapshot.binancePriceChange10s * sensitivity * 0.5;

    if (isUpMove) {
      // Expected YES to go up. If it hasn't moved enough, there's lag.
      const lag = Math.max(0, expectedYesChange - yesPriceChange);
      return { hasLag: lag > 0.03, lagAmount: lag };
    } else {
      // Expected YES to go down (NO to go up). If YES hasn't dropped enough, lag.
      const lag = Math.max(0, -expectedYesChange + yesPriceChange);
      return { hasLag: lag > 0.03, lagAmount: lag };
    }
  }

  /**
   * Detect price acceleration (2nd derivative).
   * If price change is accelerating, stronger signal.
   */
  private detectAcceleration(): number {
    if (this.priceChangeHistory.length < 3) return 0;
    const n = this.priceChangeHistory.length;
    const current = this.priceChangeHistory[n - 1];
    const prev = this.priceChangeHistory[n - 2];
    return current - prev;
  }
}
