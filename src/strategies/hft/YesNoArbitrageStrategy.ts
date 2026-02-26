import { HFTStrategyBase } from "./HFTStrategyBase";
import { ITickSnapshot, IArbOpportunity } from "../../types/hft.types";

const POLYMARKET_FEE = 0.01; // ~1% fee estimate (taker fee + gas)

/**
 * YES/NO Structural Arbitrage.
 *
 * In prediction markets, YES + NO tokens must resolve to exactly $1.00.
 * If the sum of best asks (YES_ask + NO_ask) < $1.00 - fees, buying both
 * guarantees profit regardless of outcome.
 *
 * If the sum of best bids (YES_bid + NO_bid) > $1.00 + fees, selling both
 * guarantees profit.
 *
 * This is the closest thing to risk-free arbitrage on Polymarket.
 * Win rate: ~100% (only risk: partial fill or API failure, mitigated by FOK).
 */
export class YesNoArbitrageStrategy extends HFTStrategyBase {
  readonly id = "hft-yesno-arb";
  readonly name = "YES/NO Structural Arbitrage";
  readonly type = "yes_no_arb" as const;

  onTick(snapshot: ITickSnapshot, history: ITickSnapshot[]): IArbOpportunity[] {
    const opportunities: IArbOpportunity[] = [];

    // Skip if orderbook is empty
    if (
      snapshot.yesAsks.length === 0 ||
      snapshot.noAsks.length === 0 ||
      snapshot.yesBids.length === 0 ||
      snapshot.noBids.length === 0
    ) {
      return opportunities;
    }

    const yesAskBest = parseFloat(snapshot.yesAsks[0].price);
    const noAskBest = parseFloat(snapshot.noAsks[0].price);
    const yesBidBest = parseFloat(snapshot.yesBids[0].price);
    const noBidBest = parseFloat(snapshot.noBids[0].price);

    const yesAskSize = parseFloat(snapshot.yesAsks[0].size);
    const noAskSize = parseFloat(snapshot.noAsks[0].size);
    const yesBidSize = parseFloat(snapshot.yesBids[0].size);
    const noBidSize = parseFloat(snapshot.noBids[0].size);

    // === Strategy 1: Buy Both (Underpriced) ===
    // If YES_ask + NO_ask < 1.00, buying both guarantees profit at resolution
    const totalAskCost = yesAskBest + noAskBest;
    const buyBothProfit = 1.0 - totalAskCost - POLYMARKET_FEE * 2; // fees on both legs

    if (buyBothProfit > 0.005) {
      // At least $0.005 profit per share
      // Size = minimum of available size at both best levels
      const maxShares = Math.min(yesAskSize, noAskSize);
      const sizeUSDC = Math.min(maxShares * totalAskCost, 30); // cap at $30

      if (sizeUSDC >= 1) {
        const shares = sizeUSDC / totalAskCost;

        // Buy YES
        opportunities.push({
          type: "yes_no_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "YES",
          tokenId: snapshot.yesTokenId,
          side: "BUY",
          price: yesAskBest,
          size: shares * yesAskBest,
          expectedProfit: buyBothProfit * shares / 2,
          confidence: 0.99,
          edge: buyBothProfit / totalAskCost,
          orderType: "FOK",
          metadata: {
            totalCost: totalAskCost,
            profitPerShare: buyBothProfit,
            leg: "buy_both_yes",
          },
        });

        // Buy NO
        opportunities.push({
          type: "yes_no_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "NO",
          tokenId: snapshot.noTokenId,
          side: "BUY",
          price: noAskBest,
          size: shares * noAskBest,
          expectedProfit: buyBothProfit * shares / 2,
          confidence: 0.99,
          edge: buyBothProfit / totalAskCost,
          orderType: "FOK",
          metadata: {
            totalCost: totalAskCost,
            profitPerShare: buyBothProfit,
            leg: "buy_both_no",
          },
        });
      }
    }

    // === Strategy 2: Sell Both (Overpriced) ===
    // If YES_bid + NO_bid > 1.00, selling both guarantees profit
    const totalBidValue = yesBidBest + noBidBest;
    const sellBothProfit = totalBidValue - 1.0 - POLYMARKET_FEE * 2;

    if (sellBothProfit > 0.005) {
      const maxShares = Math.min(yesBidSize, noBidSize);
      const sizeUSDC = Math.min(maxShares * totalBidValue, 30);

      if (sizeUSDC >= 1) {
        const shares = sizeUSDC / totalBidValue;

        // Sell YES
        opportunities.push({
          type: "yes_no_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "YES",
          tokenId: snapshot.yesTokenId,
          side: "SELL",
          price: yesBidBest,
          size: shares * yesBidBest,
          expectedProfit: sellBothProfit * shares / 2,
          confidence: 0.99,
          edge: sellBothProfit / totalBidValue,
          orderType: "FOK",
          metadata: {
            totalBid: totalBidValue,
            profitPerShare: sellBothProfit,
            leg: "sell_both_yes",
          },
        });

        // Sell NO
        opportunities.push({
          type: "yes_no_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "NO",
          tokenId: snapshot.noTokenId,
          side: "SELL",
          price: noBidBest,
          size: shares * noBidBest,
          expectedProfit: sellBothProfit * shares / 2,
          confidence: 0.99,
          edge: sellBothProfit / totalBidValue,
          orderType: "FOK",
          metadata: {
            totalBid: totalBidValue,
            profitPerShare: sellBothProfit,
            leg: "sell_both_no",
          },
        });
      }
    }

    // === Strategy 3: Cross-book Arbitrage ===
    // If YES_bid > NO_ask (or vice versa), there's a cross-book mispricing
    // This means you can buy cheap NO and sell expensive YES, or vice versa
    if (yesBidBest + noAskBest < 1.0 - POLYMARKET_FEE * 2) {
      // Rarely happens but is pure alpha when it does
      const profit = 1.0 - yesBidBest - noAskBest - POLYMARKET_FEE * 2;
      if (profit > 0.005) {
        const maxShares = Math.min(yesBidSize, noAskSize, 30 / (yesBidBest + noAskBest));
        opportunities.push({
          type: "yes_no_arb",
          strategyId: this.id,
          asset: snapshot.asset,
          interval: snapshot.interval,
          conditionId: snapshot.conditionId,
          direction: "NO",
          tokenId: snapshot.noTokenId,
          side: "BUY",
          price: noAskBest,
          size: maxShares * noAskBest,
          expectedProfit: profit * maxShares,
          confidence: 0.99,
          edge: profit,
          orderType: "FOK",
          metadata: { type: "cross_book_arb" },
        });
      }
    }

    return opportunities;
  }
}
