/**
 * Multi-Exchange LIVE Trading — AGGRESSIVE MODE
 *
 * Target: 1% equity growth per minute ($100 → $20,000 in ~12hrs)
 *
 * Strategy:
 * - Hyperliquid: 20x leveraged BTC/ETH/SOL/XRP perp momentum + scalps
 * - Polymarket: Binary token trading (5-15min prediction markets, no leverage)
 * - Binance: Real-time price feed (signal detection for cross-exchange trades)
 * - Kalshi: Event markets (REST)
 *
 * Dashboard at http://localhost:3847
 */

import { KalshiClient } from "./exchange/KalshiClient";
import { KalshiMarketDiscovery } from "./exchange/KalshiMarketDiscovery";
import { HyperliquidClient } from "./exchange/HyperliquidClient";
import { HyperliquidMarketData } from "./exchange/HyperliquidMarketData";
import { MultiExchangeTickEngine } from "./exchange/MultiExchangeTickEngine";
import { DemoWallet } from "./exchange/DemoWallet";
import { PerformanceTracker } from "./polymarket/PerformanceTracker";
import { DashboardServer } from "./dashboard/DashboardServer";
import { HYPERLIQUID_COINS } from "./types/hyperliquid.types";
import { logger } from "./utils/logger";

const DASHBOARD_PORT = 3847;

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  AGGRESSIVE QUANT ENGINE — LIVE");
  console.log("  Target: 1% equity growth per minute");
  console.log("  HL: 20x leveraged perps | PM: Binary tokens | BIN: WS signals");
  console.log("  $1,000 Demo Wallet | Run until Ctrl+C");
  console.log("=".repeat(70) + "\n");

  logger.info("Initializing exchange clients...");

  const kalshiClient = new KalshiClient();
  const kalshiDiscovery = new KalshiMarketDiscovery(kalshiClient);
  const hyperliquidClient = new HyperliquidClient();
  const hyperliquidData = new HyperliquidMarketData(hyperliquidClient);
  const demoWallet = new DemoWallet(1000); // $1,000 demo wallet
  const perfTracker = new PerformanceTracker();
  perfTracker.initialize();

  // Pre-flight checks
  console.log("\n--- Pre-flight Exchange Checks ---\n");

  const hlMeta = await hyperliquidClient.getMeta();
  if (hlMeta) {
    logger.success(`Hyperliquid: ${hlMeta.universe.length} perpetual markets (20x leverage)`);
  } else {
    logger.warning("Hyperliquid: Meta fetch failed (will retry in engine)");
  }

  for (const coin of HYPERLIQUID_COINS) {
    const book = await hyperliquidClient.getOrderbook(coin);
    if (book) {
      logger.success(
        `Hyperliquid [${coin}]: mid=$${book.midPrice.toFixed(2)} spread=$${book.spread.toFixed(2)} levels=${book.bids.length}/${book.asks.length}`
      );
    } else {
      logger.warning(`Hyperliquid [${coin}]: Failed (will retry)`);
    }
  }

  // Start engine
  console.log("\n--- Starting Aggressive Trading Engine ---\n");

  const multiEngine = new MultiExchangeTickEngine(
    kalshiClient,
    kalshiDiscovery,
    hyperliquidClient,
    hyperliquidData,
    demoWallet,
    perfTracker
  );

  await multiEngine.start();

  // Dashboard
  const dashboardServer = new DashboardServer(
    demoWallet,
    perfTracker,
    multiEngine,
    null as any,
    DASHBOARD_PORT
  );

  await dashboardServer.start();

  console.log("\n" + "=".repeat(70));
  logger.success(`ENGINE LIVE | Dashboard: http://localhost:${DASHBOARD_PORT}`);
  console.log("  Press Ctrl+C for full shutdown report");
  console.log("=".repeat(70) + "\n");

  const startTime = Date.now();

  // Progress logging every 5 seconds (more frequent for aggressive trading)
  const progressInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const elapsedMin = ((Date.now() - startTime) / 60_000).toFixed(1);
    const stats = multiEngine.getStats();
    const wallet = demoWallet.getState();
    const metrics = perfTracker.getOverallMetrics();
    const equity = demoWallet.getEquity();

    const binTag = stats.binanceConnected ? "BIN=WS" : "BIN=...";
    const pmTag = stats.polymarketWsConnected
      ? `PM=${stats.polymarketBooksCount}(ws)`
      : "PM=...";
    const hlTag = `HL=${stats.hyperliquidBooksCount}`;

    const wr = metrics.totalTrades > 0
      ? `${(metrics.winRate * 100).toFixed(1)}%`
      : "-";

    const momTag = stats.momentumTrades > 0
      ? `Mom:${stats.momentumTrades}T/${stats.momentumWins}W/$${stats.momentumPnl.toFixed(2)}`
      : "Mom:wait";

    const pmTag2 = stats.pmBetTrades > 0
      ? `PM:${stats.pmBetTrades}T/${stats.pmBetWins}W/$${stats.pmBetPnl.toFixed(2)}`
      : "PM:wait";

    const roi = (((equity - 1000) / 1000) * 100).toFixed(1);
    const growthPerMin = parseFloat(elapsedMin) > 0
      ? ((equity / 1000 - 1) / parseFloat(elapsedMin) * 100).toFixed(2)
      : "0";

    console.log(
      `  [${elapsed}s] ${binTag} ${pmTag} ${hlTag} | T:${stats.quantTrades} WR:${wr} | ` +
        `${momTag} | ${pmTag2} | ` +
        `$${equity.toFixed(2)} (${roi}%ROI ${growthPerMin}%/min) PnL:$${wallet.totalRealizedPnl.toFixed(2)}`
    );
  }, 5_000);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    clearInterval(progressInterval);

    console.log("\n\n" + "=".repeat(70));
    console.log("  SHUTDOWN REPORT — AGGRESSIVE MODE");
    console.log("=".repeat(70));

    const runtime = ((Date.now() - startTime) / 1000).toFixed(0);
    const runtimeMin = ((Date.now() - startTime) / 60_000).toFixed(1);
    const stats = multiEngine.getStats();
    const wallet = demoWallet.getState();
    const metrics = perfTracker.getOverallMetrics();
    const equity = demoWallet.getEquity();

    console.log(`\n--- Runtime: ${runtime}s (${runtimeMin} min) ---`);

    console.log("\n--- Connections ---");
    console.log(`  Binance WS:     ${stats.binanceConnected ? "CONNECTED" : "DISCONNECTED"}`);
    console.log(`  Polymarket WS:  ${stats.polymarketWsConnected ? "CONNECTED" : "DISCONNECTED"} (${stats.polymarketBooksCount} books)`);
    console.log(`  Hyperliquid:    ${stats.hyperliquidBooksCount} books (REST, 20x leverage)`);
    console.log(`  Kalshi:         ${stats.kalshiBooksCount} books (REST)`);

    console.log("\n--- Demo Wallet ---");
    console.log(`  Starting Balance: $1,000.00`);
    console.log(`  Final Equity:     $${equity.toFixed(2)}`);
    console.log(`  Realized PnL:     $${wallet.totalRealizedPnl.toFixed(2)}`);
    console.log(`  Unrealized PnL:   $${wallet.unrealizedPnl.toFixed(2)}`);
    console.log(`  Open Positions:   ${wallet.positions.length}`);
    console.log(`  ROI:              ${(((equity - 1000) / 1000) * 100).toFixed(2)}%`);
    console.log(`  Growth/min:       ${parseFloat(runtimeMin) > 0 ? ((equity / 1000 - 1) / parseFloat(runtimeMin) * 100).toFixed(2) : "0"}%`);

    console.log("\n--- Per Exchange P&L ---");
    for (const [exchange, pnl] of Object.entries(wallet.perExchangePnl)) {
      console.log(`  ${exchange}: $${(pnl as number).toFixed(2)}`);
    }

    console.log("\n--- Strategy Breakdown ---");
    console.log(`  Momentum (HL 20x):   ${stats.momentumTrades} trades | ${stats.momentumWins}W | P&L: $${stats.momentumPnl.toFixed(2)}`);
    console.log(`  PM Up/Down Bets:     ${stats.pmBetTrades} trades | ${stats.pmBetWins}W | P&L: $${stats.pmBetPnl.toFixed(2)}`);
    console.log(`  Quant signals:       ${stats.quantSignals} (${stats.quantBlocked} blocked)`);

    console.log("\n--- Performance Metrics ---");
    console.log(`  Total Trades:   ${metrics.totalTrades}`);
    console.log(`  Win Rate:       ${(metrics.winRate * 100).toFixed(1)}%`);
    console.log(`  Profit Factor:  ${metrics.profitFactor}`);
    console.log(`  Sharpe Ratio:   ${metrics.sharpeRatio}`);
    console.log(`  Max Drawdown:   $${metrics.maxDrawdown.toFixed(2)}`);

    console.log("\n--- Engine Stats ---");
    console.log(`  Total Ticks:           ${stats.tickCount}`);
    console.log(`  Cross-Exchange Opps:   ${stats.crossExchangeOpps}`);
    console.log(`  Cross-Exchange Trades: ${stats.crossExchangeTrades}`);

    const strategyMetrics = perfTracker.getStrategyMetrics();
    if (strategyMetrics.size > 0) {
      console.log("\n--- Per Strategy Detail ---");
      for (const [id, sm] of strategyMetrics) {
        console.log(
          `  ${id}: ${sm.totalTrades} trades | WR: ${(sm.winRate * 100).toFixed(1)}% | PnL: $${sm.totalPnl.toFixed(2)}`
        );
      }
    }

    console.log("\n" + "=".repeat(70) + "\n");

    await multiEngine.stop();
    dashboardServer.stop();
    perfTracker.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error("Test failed:", err);
  process.exit(1);
});
