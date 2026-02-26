import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { PriceFeedService } from "../../polymarket/PriceFeedService";
import { PolymarketAsset } from "../../types/polymarket.types";
import { EMA } from "../../indicators/EMA";
import { RSI } from "../../indicators/RSI";
import { ATR } from "../../indicators/ATR";

/**
 * Fast momentum scalper for short-timeframe Polymarket markets.
 * Uses EMA(5) vs EMA(15) crossover with ATR-normalized momentum.
 *
 * Weight: 0.20
 */
export class MomentumScalperStrategy extends BaseStrategy {
  readonly id = "poly-momentum-scalper";
  readonly name = "Polymarket Momentum Scalper";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.FAST;

  private priceFeed: PriceFeedService;

  constructor(priceFeed: PriceFeedService) {
    super();
    this.priceFeed = priceFeed;
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const assets: PolymarketAsset[] = ["BTC", "ETH", "XRP"];

      for (const asset of assets) {
        if (!this.priceFeed.hasEnoughData(asset, 20)) continue;

        const candles = this.priceFeed.getCandles(asset, 30);
        const closes = candles.map((c) => c.close);
        if (closes.length < 15) continue;

        const ema5 = EMA.calculate(closes, 5);
        const ema15 = EMA.calculate(closes, 15);

        const currEma5 = ema5[ema5.length - 1];
        const currEma15 = ema15[ema15.length - 1];
        const prevEma5 = ema5[ema5.length - 2];
        const prevEma15 = ema15[ema15.length - 2];

        // Detect crossover
        const bullishCross = prevEma5 <= prevEma15 && currEma5 > currEma15;
        const bearishCross = prevEma5 >= prevEma15 && currEma5 < currEma15;

        // ATR for volatility-adjusted confidence
        const atr = ATR.latest(candles, 14);
        const currentPrice = closes[closes.length - 1];
        const atrPct = !isNaN(atr) && currentPrice > 0 ? atr / currentPrice : 0;

        // RSI filter
        const rsi = RSI.latest(closes, 14);

        // EMA spread strength
        const spread = Math.abs(currEma5 - currEma15) / currEma15;

        if (bullishCross && !isNaN(rsi) && rsi < 72) {
          // Confidence based on spread strength and volatility
          const confidence = Math.min(
            1.0,
            0.5 + spread * 200 + (atrPct > 0.002 ? 0.1 : 0)
          );
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.BUY,
              confidence,
              {
                indicator: "MomentumScalper",
                crossover: "bullish",
                ema5: currEma5,
                ema15: currEma15,
                spread,
                rsi,
                atrPct,
                asset,
              },
              2 * 60 * 1000 // 2 min TTL for scalping
            )
          );
        }

        if (bearishCross && !isNaN(rsi) && rsi > 28) {
          const confidence = Math.min(
            1.0,
            0.5 + spread * 200 + (atrPct > 0.002 ? 0.1 : 0)
          );
          signals.push(
            this.createSignal(
              asset,
              SignalDirection.SELL,
              confidence,
              {
                indicator: "MomentumScalper",
                crossover: "bearish",
                ema5: currEma5,
                ema15: currEma15,
                spread,
                rsi,
                atrPct,
                asset,
              },
              2 * 60 * 1000
            )
          );
        }

        // Continuous momentum: EMA5 above/below EMA15 with acceleration
        if (!bullishCross && !bearishCross) {
          const isAbove = currEma5 > currEma15;
          const spreadGrowing =
            Math.abs(currEma5 - currEma15) >
            Math.abs(prevEma5 - prevEma15);

          if (spreadGrowing && spread > 0.0005) {
            const dir = isAbove ? SignalDirection.BUY : SignalDirection.SELL;
            signals.push(
              this.createSignal(
                asset,
                dir,
                0.45 + spread * 100, // Lower base confidence for continuation
                {
                  indicator: "MomentumScalper",
                  type: "continuation",
                  spread,
                  accelerating: true,
                  asset,
                },
                1.5 * 60 * 1000
              )
            );
          }
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }
}
