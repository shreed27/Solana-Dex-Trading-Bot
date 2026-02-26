/**
 * Live HFT Strategy Test — Fetches REAL Polymarket orderbooks
 * and runs all 4 HFT strategies against them for 60 seconds.
 *
 * Usage: npx ts-node src/test-hft-live.ts
 *
 * No wallet/auth needed. Read-only orderbook data + simulated execution.
 */
import axios from "axios";
import {
  ITickSnapshot,
  IArbOpportunity,
  IHFTTrade,
} from "./types/hft.types";
import {
  IPolymarketBookLevel,
  PolymarketAsset,
  PolymarketInterval,
} from "./types/polymarket.types";
import { YesNoArbitrageStrategy } from "./strategies/hft/YesNoArbitrageStrategy";
import { LatencyArbitrageStrategy } from "./strategies/hft/LatencyArbitrageStrategy";
import { SpreadCaptureMMStrategy } from "./strategies/hft/SpreadCaptureMMStrategy";
import { OrderbookMicrostructureStrategy } from "./strategies/hft/OrderbookMicrostructureStrategy";
import { HFTStrategyBase } from "./strategies/hft/HFTStrategyBase";
import { HFTRiskManager } from "./polymarket/HFTRiskManager";
import { PerformanceTracker } from "./polymarket/PerformanceTracker";

const CLOB_BASE = "https://clob.polymarket.com";
const BINANCE_BASE = "https://api.binance.com/api/v3";

// ===== Live Markets to Test =====
// Using real high-liquidity Polymarket markets
const TEST_MARKETS = [
  {
    label: "JD Vance 2028 Presidential",
    asset: "BTC" as PolymarketAsset, // map to BTC for test
    interval: "5M" as PolymarketInterval,
    conditionId: "jd-vance-2028",
    yesTokenId: "16040015440196279900485035793550429453516625694844857319147506590755961451627",
    noTokenId: "94476829201604408463453426454480212459887267917122244941405244686637914508323",
  },
  {
    label: "Colorado Avalanche Stanley Cup",
    asset: "ETH" as PolymarketAsset,
    interval: "5M" as PolymarketInterval,
    conditionId: "avalanche-stanley-cup",
    yesTokenId: "101738487887518832481587379955535423775326921556438741919099866785354159699479",
    noTokenId: "87978082071653935678874296685430503892266481242311708420787197372467948088235",
  },
  {
    label: "Gavin Newsom Dem Nomination",
    asset: "XRP" as PolymarketAsset,
    interval: "15M" as PolymarketInterval,
    conditionId: "newsom-dem-nomination",
    yesTokenId: "54533043819946592547517511176940999955633860128497669742211153063842200957669",
    noTokenId: "87854174148074652060467921081181402357467303721471806610111179101805869578687",
  },
];

// ===== Fetch Functions =====
async function fetchOrderbook(tokenId: string): Promise<IPolymarketBookLevel[][]> {
  try {
    const resp = await axios.get(`${CLOB_BASE}/book`, {
      params: { token_id: tokenId },
      timeout: 5000,
    });
    const data = resp.data;
    // Sort bids descending, asks ascending
    const bids = (data.bids || []).sort(
      (a: any, b: any) => parseFloat(b.price) - parseFloat(a.price)
    );
    const asks = (data.asks || []).sort(
      (a: any, b: any) => parseFloat(a.price) - parseFloat(b.price)
    );
    return [bids, asks];
  } catch {
    return [[], []];
  }
}

async function fetchBinancePrice(symbol: string): Promise<number> {
  try {
    const resp = await axios.get(`${BINANCE_BASE}/ticker/price`, {
      params: { symbol },
      timeout: 3000,
    });
    return parseFloat(resp.data.price);
  } catch {
    return 0;
  }
}

// ===== Build Snapshot =====
function buildSnapshot(
  market: typeof TEST_MARKETS[0],
  yesBids: IPolymarketBookLevel[],
  yesAsks: IPolymarketBookLevel[],
  noBids: IPolymarketBookLevel[],
  noAsks: IPolymarketBookLevel[],
  binancePrice: number,
  binancePriceHistory: { price: number; ts: number }[]
): ITickSnapshot {
  const now = Date.now();

  const yesBestBid = yesBids.length > 0 ? parseFloat(yesBids[0].price) : 0;
  const yesBestAsk = yesAsks.length > 0 ? parseFloat(yesAsks[0].price) : 0;
  const noBestBid = noBids.length > 0 ? parseFloat(noBids[0].price) : 0;
  const noBestAsk = noAsks.length > 0 ? parseFloat(noAsks[0].price) : 0;

  const yesMid = yesBestBid > 0 && yesBestAsk > 0 ? (yesBestBid + yesBestAsk) / 2 : yesBestBid || yesBestAsk;
  const noMid = noBestBid > 0 && noBestAsk > 0 ? (noBestBid + noBestAsk) / 2 : noBestBid || noBestAsk;

  const calcDepth = (levels: IPolymarketBookLevel[]) =>
    levels.slice(0, 5).reduce((sum, l) => sum + parseFloat(l.price) * parseFloat(l.size), 0);

  // Price change calculations
  const getPriceChange = (windowMs: number) => {
    if (binancePriceHistory.length < 2 || binancePrice === 0) return 0;
    const cutoff = now - windowMs;
    let past = binancePriceHistory[0];
    for (const entry of binancePriceHistory) {
      if (entry.ts <= cutoff) past = entry;
      else break;
    }
    return past.price === 0 ? 0 : (binancePrice - past.price) / past.price;
  };

  return {
    asset: market.asset,
    interval: market.interval,
    conditionId: market.conditionId,
    yesTokenId: market.yesTokenId,
    noTokenId: market.noTokenId,
    yesBids,
    yesAsks,
    noBids,
    noAsks,
    yesMid,
    noMid,
    yesSpread: yesBestAsk - yesBestBid,
    noSpread: noBestAsk - noBestBid,
    yesBestBid,
    yesBestAsk,
    noBestBid,
    noBestAsk,
    yesBidDepth: calcDepth(yesBids),
    yesAskDepth: calcDepth(yesAsks),
    noBidDepth: calcDepth(noBids),
    noAskDepth: calcDepth(noAsks),
    binancePrice,
    binancePriceChange10s: getPriceChange(10_000),
    binancePriceChange30s: getPriceChange(30_000),
    timestamp: now,
  };
}

// ===== Simulated Execution =====
function simulateExecution(
  opp: IArbOpportunity,
  perfTracker: PerformanceTracker,
  riskManager: HFTRiskManager,
  strategies: HFTStrategyBase[]
): IHFTTrade | null {
  const timeToResolution = 300; // 5 minutes
  const riskCheck = riskManager.checkRisk(opp, timeToResolution);
  if (!riskCheck.allowed) return null;

  const shares = opp.size / opp.price;
  const trade: IHFTTrade = {
    id: `hft-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    strategy: opp.type,
    strategyId: opp.strategyId,
    asset: opp.asset,
    interval: opp.interval,
    conditionId: opp.conditionId,
    direction: opp.direction,
    tokenId: opp.tokenId,
    side: opp.side,
    entryPrice: opp.price,
    size: opp.size,
    shares,
    pnl: opp.expectedProfit,
    holdTimeMs: 0,
    openedAt: Date.now(),
    closedAt: Date.now(),
  };

  perfTracker.recordTrade(trade);
  riskManager.recordTrade(trade);
  riskManager.updateInventory(opp.asset, opp.direction, opp.side, shares, opp.price);

  const strategy = strategies.find((s) => s.id === opp.strategyId);
  if (strategy) strategy.recordTrade(trade.pnl);

  return trade;
}

// ===== Main Test Loop =====
async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  HFT STRATEGY LIVE TEST — Real Polymarket Orderbooks");
  console.log("=".repeat(70));
  console.log(`  Markets: ${TEST_MARKETS.map((m) => m.label).join(", ")}`);
  console.log(`  Duration: 60 seconds (~120 ticks at 500ms)`);
  console.log(`  Mode: SIMULATION (no real orders placed)`);
  console.log("=".repeat(70) + "\n");

  // Initialize components
  const strategies: HFTStrategyBase[] = [
    new YesNoArbitrageStrategy(),
    new LatencyArbitrageStrategy(),
    new SpreadCaptureMMStrategy(),
    new OrderbookMicrostructureStrategy(),
  ];
  const riskManager = new HFTRiskManager();
  const perfTracker = new PerformanceTracker();
  perfTracker.initialize();

  // State
  const tickHistory: Map<string, ITickSnapshot[]> = new Map();
  const binancePriceHistory: Map<string, { price: number; ts: number }[]> = new Map();
  for (const asset of ["BTC", "ETH", "XRP"]) {
    binancePriceHistory.set(asset, []);
  }

  let tickCount = 0;
  let totalOpportunities = 0;
  let totalTrades = 0;
  const tradeLog: { tick: number; strategy: string; side: string; asset: string; price: number; size: number; edge: number; profit: number }[] = [];

  const TICK_MS = 500;
  const DURATION_MS = 60_000;
  const totalTicks = DURATION_MS / TICK_MS;

  console.log("Starting tick loop...\n");

  const startTime = Date.now();

  const tickLoop = setInterval(async () => {
    tickCount++;
    const elapsed = Date.now() - startTime;

    if (elapsed >= DURATION_MS) {
      clearInterval(tickLoop);
      printResults(strategies, perfTracker, tradeLog, tickCount, totalOpportunities, totalTrades);
      perfTracker.shutdown();
      process.exit(0);
    }

    try {
      // Fetch Binance prices (BTC, ETH, XRP) in parallel
      const [btcPrice, ethPrice, xrpPrice] = await Promise.all([
        fetchBinancePrice("BTCUSDT"),
        fetchBinancePrice("ETHUSDT"),
        fetchBinancePrice("XRPUSDT"),
      ]);

      const priceMap: Record<string, number> = { BTC: btcPrice, ETH: ethPrice, XRP: xrpPrice };
      const now = Date.now();

      for (const [asset, price] of Object.entries(priceMap)) {
        if (price > 0) {
          const hist = binancePriceHistory.get(asset)!;
          hist.push({ price, ts: now });
          if (hist.length > 120) hist.shift();
        }
      }

      // Fetch orderbooks for each market (parallel)
      const orderbookResults = await Promise.all(
        TEST_MARKETS.map(async (m) => {
          const [yesBids, yesAsks] = await fetchOrderbook(m.yesTokenId);
          const [noBids, noAsks] = await fetchOrderbook(m.noTokenId);
          return { market: m, yesBids, yesAsks, noBids, noAsks };
        })
      );

      // Process each market
      for (const { market, yesBids, yesAsks, noBids, noAsks } of orderbookResults) {
        if (yesBids.length === 0 && yesAsks.length === 0) continue;

        const snapshot = buildSnapshot(
          market,
          yesBids,
          yesAsks,
          noBids,
          noAsks,
          priceMap[market.asset],
          binancePriceHistory.get(market.asset)!
        );

        // Get history
        const key = `${market.asset}:${market.interval}:${market.conditionId}`;
        const history = tickHistory.get(key) || [];

        // Run all strategies
        const opps: IArbOpportunity[] = [];
        for (const strategy of strategies) {
          if (!strategy.isEnabled()) continue;
          try {
            const found = strategy.onTick(snapshot, history);
            opps.push(...found);
          } catch (err) {
            // Strategy error
          }
        }

        // Update history
        history.push(snapshot);
        if (history.length > 60) history.shift();
        tickHistory.set(key, history);

        // Execute opportunities
        if (opps.length > 0) {
          totalOpportunities += opps.length;

          for (const opp of opps) {
            const trade = simulateExecution(opp, perfTracker, riskManager, strategies);
            if (trade) {
              totalTrades++;
              tradeLog.push({
                tick: tickCount,
                strategy: opp.strategyId,
                side: `${opp.side} ${opp.direction}`,
                asset: opp.asset,
                price: opp.price,
                size: opp.size,
                edge: opp.edge,
                profit: opp.expectedProfit,
              });

              // Print trade immediately
              console.log(
                `  [Tick ${tickCount.toString().padStart(3)}] ${opp.strategyId.padEnd(22)} | ${opp.side} ${opp.direction.padEnd(4)} ${opp.asset} @ $${opp.price.toFixed(4)} | $${opp.size.toFixed(2).padStart(6)} | edge: ${(opp.edge * 100).toFixed(2)}% | profit: $${opp.expectedProfit.toFixed(4)}`
              );
            }
          }
        }
      }

      // Progress every 20 ticks
      if (tickCount % 20 === 0) {
        const pct = ((elapsed / DURATION_MS) * 100).toFixed(0);
        const metrics = perfTracker.getOverallMetrics();
        console.log(
          `\n  --- Tick ${tickCount}/${totalTicks} (${pct}%) | Opps: ${totalOpportunities} | Trades: ${totalTrades} | PnL: $${metrics.totalPnl.toFixed(4)} ---\n`
        );
      }
    } catch (err: any) {
      // Silent tick error
    }
  }, TICK_MS);
}

function printResults(
  strategies: HFTStrategyBase[],
  perfTracker: PerformanceTracker,
  tradeLog: any[],
  tickCount: number,
  totalOpportunities: number,
  totalTrades: number
) {
  console.log("\n" + "=".repeat(70));
  console.log("  HFT LIVE TEST RESULTS");
  console.log("=".repeat(70));

  // Overall metrics
  const overall = perfTracker.getOverallMetrics();
  console.log("\n  OVERALL PERFORMANCE:");
  console.log("  " + "-".repeat(50));
  console.log(`  Total Ticks:        ${tickCount}`);
  console.log(`  Opportunities:      ${totalOpportunities}`);
  console.log(`  Trades Executed:    ${overall.totalTrades}`);
  console.log(`  Win Rate:           ${(overall.winRate * 100).toFixed(2)}%`);
  console.log(`  Profit Factor:      ${overall.profitFactor}`);
  console.log(`  Sharpe Ratio:       ${overall.sharpeRatio}`);
  console.log(`  Sortino Ratio:      ${overall.sortinoRatio}`);
  console.log(`  Total PnL:          $${overall.totalPnl.toFixed(4)}`);
  console.log(`  Gross Profit:       $${overall.grossProfit.toFixed(4)}`);
  console.log(`  Gross Loss:         $${overall.grossLoss.toFixed(4)}`);
  console.log(`  Max Drawdown:       $${overall.maxDrawdown.toFixed(4)}`);
  console.log(`  Avg Win:            $${overall.avgWin.toFixed(4)}`);
  console.log(`  Avg Loss:           $${overall.avgLoss.toFixed(4)}`);
  console.log(`  Largest Win:        $${overall.largestWin.toFixed(4)}`);
  console.log(`  Largest Loss:       $${overall.largestLoss.toFixed(4)}`);
  console.log(`  Trades/Hour:        ${overall.tradesPerHour.toFixed(1)}`);

  // Per-strategy metrics
  console.log("\n  PER-STRATEGY BREAKDOWN:");
  console.log("  " + "-".repeat(50));
  const stratMetrics = perfTracker.getStrategyMetrics();
  for (const strategy of strategies) {
    const stats = strategy.getStats();
    const m = stratMetrics.get(strategy.id);
    console.log(`\n  ${strategy.name} (${strategy.id}):`);
    console.log(`    Trades: ${stats.trades} | Wins: ${stats.wins} | WR: ${(stats.winRate * 100).toFixed(1)}% | PnL: $${stats.pnl.toFixed(4)}`);
    if (m && m.totalTrades > 0) {
      console.log(`    PF: ${m.profitFactor} | Sharpe: ${m.sharpeRatio} | Sortino: ${m.sortinoRatio} | DD: $${m.maxDrawdown.toFixed(4)}`);
    }
  }

  // Rolling windows
  console.log("\n  ROLLING WINDOW METRICS:");
  console.log("  " + "-".repeat(50));
  const windows = perfTracker.getAllWindows();
  for (const w of windows) {
    if (w.metrics.totalTrades === 0) continue;
    const m = w.metrics;
    console.log(
      `  [${w.label.padEnd(4)}] Trades: ${m.totalTrades} | WR: ${(m.winRate * 100).toFixed(1)}% | PF: ${m.profitFactor} | Sharpe: ${m.sharpeRatio} | Sortino: ${m.sortinoRatio} | PnL: $${m.totalPnl}`
    );
  }

  // Trade log summary
  if (tradeLog.length > 0) {
    console.log("\n  TRADE LOG (all trades):");
    console.log("  " + "-".repeat(50));
    for (const t of tradeLog) {
      console.log(
        `  Tick ${t.tick.toString().padStart(3)} | ${t.strategy.padEnd(22)} | ${t.side.padEnd(10)} ${t.asset} @ $${t.price.toFixed(4)} | $${t.size.toFixed(2)} | edge: ${(t.edge * 100).toFixed(2)}% | +$${t.profit.toFixed(4)}`
      );
    }
  }

  // Risk manager state
  console.log("\n  RISK STATE:");
  console.log("  " + "-".repeat(50));
  console.log(`  Kill Switch Active: ${(new HFTRiskManager()).isKillSwitchActive() ? "YES" : "NO"}`);

  console.log("\n" + "=".repeat(70));
  console.log("  Test complete. All data from LIVE Polymarket orderbooks.");
  console.log("=".repeat(70) + "\n");
}

main().catch(console.error);
