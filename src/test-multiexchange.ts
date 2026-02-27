/**
 * Multi-Exchange Live Test
 *
 * Tests all 3 exchange clients with real data:
 * - Polymarket: CLOB orderbooks for prediction markets
 * - Kalshi: Binary event markets (crypto 15-min rolling)
 * - Hyperliquid: Perpetual CLOB (BTC/ETH/SOL/XRP)
 *
 * Starts DemoWallet with $100, runs MultiExchangeTickEngine for 60 seconds,
 * and launches the dashboard at http://localhost:3847
 */

import axios from "axios";
import { KalshiClient } from "./exchange/KalshiClient";
import { KalshiMarketDiscovery } from "./exchange/KalshiMarketDiscovery";
import { HyperliquidClient } from "./exchange/HyperliquidClient";
import { HyperliquidMarketData } from "./exchange/HyperliquidMarketData";
import { MultiExchangeTickEngine } from "./exchange/MultiExchangeTickEngine";
import { DemoWallet } from "./exchange/DemoWallet";
import { PerformanceTracker } from "./polymarket/PerformanceTracker";
import { DashboardServer } from "./dashboard/DashboardServer";
import { DashboardPayloadBuilder } from "./dashboard/DashboardPayloadBuilder";
import { HFTRiskManager } from "./polymarket/HFTRiskManager";
import { IUnifiedOrderbook } from "./types/exchange.types";
import { HYPERLIQUID_COINS } from "./types/hyperliquid.types";
import { logger } from "./utils/logger";

const TEST_DURATION_MS = 60_000; // 60 seconds
const DASHBOARD_PORT = 3847;

// ==================== POLYMARKET DIRECT FETCH ====================

interface PolymarketBook {
  exchange: string;
  symbol: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  midPrice: number;
  spread: number;
  timestamp: number;
}

async function fetchPolymarketOrderbook(tokenId: string, label: string): Promise<PolymarketBook | null> {
  try {
    const resp = await axios.get(`https://clob.polymarket.com/book?token_id=${tokenId}`, { timeout: 5000 });
    const book = resp.data;

    const bids = (book.bids || [])
      .map((l: any) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a: any, b: any) => b.price - a.price);

    const asks = (book.asks || [])
      .map((l: any) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
      .sort((a: any, b: any) => a.price - b.price);

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 1;

    return {
      exchange: "polymarket",
      symbol: label,
      bids,
      asks,
      midPrice: (bestBid + bestAsk) / 2,
      spread: bestAsk - bestBid,
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

// ==================== MAIN ====================

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  MULTI-EXCHANGE LIVE TEST");
  console.log("  Polymarket + Kalshi + Hyperliquid | $100 Demo Wallet | 60 seconds");
  console.log("=".repeat(70) + "\n");

  // 1. Initialize exchange clients
  logger.info("Initializing exchange clients...");

  const kalshiClient = new KalshiClient();
  const kalshiDiscovery = new KalshiMarketDiscovery(kalshiClient);
  const hyperliquidClient = new HyperliquidClient();
  const hyperliquidData = new HyperliquidMarketData(hyperliquidClient);
  const demoWallet = new DemoWallet(100);
  const perfTracker = new PerformanceTracker();
  perfTracker.initialize();

  // 2. Test each exchange independently
  console.log("\n--- Testing Exchange Connections ---\n");

  // Polymarket
  // Auto-discover active Polymarket markets with highest liquidity
  let polyTokens: { id: string; label: string }[] = [];
  try {
    const marketsResp = await axios.get("https://gamma-api.polymarket.com/markets?limit=3&active=true&order=liquidity&ascending=false", { timeout: 5000 });
    for (const m of marketsResp.data) {
      const tokens = JSON.parse(m.clobTokenIds || "[]");
      if (tokens.length > 0) {
        polyTokens.push({ id: tokens[0], label: m.question?.substring(0, 40) || "Unknown" });
      }
    }
  } catch {
    logger.warning("Failed to auto-discover Polymarket markets, using fallback");
    polyTokens = [
      { id: "36492660659256805751819092668425694525338049897837902414703354946397645285694", label: "UFC Fight" },
    ];
  }

  for (const token of polyTokens) {
    const book = await fetchPolymarketOrderbook(token.id, token.label);
    if (book) {
      logger.success(`Polymarket [${token.label}]: bid=${book.bids[0]?.price.toFixed(3)} ask=${book.asks[0]?.price.toFixed(3)} spread=${book.spread.toFixed(4)} levels=${book.bids.length}/${book.asks.length}`);
    } else {
      logger.error(`Polymarket [${token.label}]: Failed to fetch`);
    }
  }

  // Kalshi
  const kalshiEvents = await kalshiClient.getEvents("KXBTC", "open");
  if (kalshiEvents.length > 0) {
    logger.success(`Kalshi: Found ${kalshiEvents.length} KXBTC events`);
    for (const event of kalshiEvents.slice(0, 2)) {
      logger.info(`  Event: ${event.title} (${event.markets?.length || 0} markets)`);
      if (event.markets && event.markets.length > 0) {
        const market = event.markets[0];
        const book = await kalshiClient.getOrderbook(market.ticker);
        if (book) {
          logger.success(`  Kalshi [${market.ticker}]: mid=${book.midPrice.toFixed(4)} spread=${book.spread.toFixed(4)}`);
        }
      }
    }
  } else {
    logger.warning("Kalshi: No KXBTC events found (may be outside market hours)");
    // Try general markets
    const markets = await kalshiClient.getMarkets();
    logger.info(`Kalshi: ${markets.length} total markets available`);
  }

  // Hyperliquid
  const hlMeta = await hyperliquidClient.getMeta();
  if (hlMeta) {
    logger.success(`Hyperliquid: ${hlMeta.universe.length} perpetual markets`);
  }

  for (const coin of HYPERLIQUID_COINS) {
    const book = await hyperliquidClient.getOrderbook(coin);
    if (book) {
      logger.success(`Hyperliquid [${coin}]: mid=$${book.midPrice.toFixed(2)} spread=$${book.spread.toFixed(2)} levels=${book.bids.length}/${book.asks.length}`);
    } else {
      logger.error(`Hyperliquid [${coin}]: Failed to fetch`);
    }
  }

  // 3. Start MultiExchangeTickEngine
  console.log("\n--- Starting Multi-Exchange Tick Engine ---\n");

  const multiEngine = new MultiExchangeTickEngine(
    kalshiClient,
    kalshiDiscovery,
    hyperliquidClient,
    hyperliquidData,
    demoWallet,
    perfTracker
  );

  await multiEngine.start();

  // 4. Start Dashboard
  const dashboardServer = new DashboardServer(
    demoWallet,
    perfTracker,
    multiEngine,
    null as any, // No HFT engine in standalone test
    DASHBOARD_PORT
  );

  await dashboardServer.start();
  logger.success(`Dashboard: http://localhost:${DASHBOARD_PORT}`);

  // 5. Run for TEST_DURATION_MS
  console.log(`\n--- Running for ${TEST_DURATION_MS / 1000} seconds ---\n`);

  const startEquity = demoWallet.getEquity();
  const startTime = Date.now();

  // Progress logging every 10 seconds
  const progressInterval = setInterval(() => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const stats = multiEngine.getStats();
    const wallet = demoWallet.getState();
    const metrics = perfTracker.getOverallMetrics();

    console.log(
      `  [${elapsed}s] Ticks: ${stats.tickCount} | ` +
      `Opps: ${stats.crossExchangeOpps} | Trades: ${stats.crossExchangeTrades} | ` +
      `Equity: $${wallet.totalEquity.toFixed(2)} | PnL: $${wallet.totalRealizedPnl.toFixed(4)} | ` +
      `Kalshi: ${stats.kalshiBooksCount} books | HL: ${stats.hyperliquidBooksCount} books | ` +
      `Dashboard: ${dashboardServer.getClientCount()} clients`
    );
  }, 10_000);

  // Wait for test duration
  await new Promise((resolve) => setTimeout(resolve, TEST_DURATION_MS));

  clearInterval(progressInterval);

  // 6. Report Results
  console.log("\n" + "=".repeat(70));
  console.log("  TEST RESULTS");
  console.log("=".repeat(70) + "\n");

  const endEquity = demoWallet.getEquity();
  const walletState = demoWallet.getState();
  const finalMetrics = perfTracker.getOverallMetrics();
  const engineStats = multiEngine.getStats();

  console.log("--- Demo Wallet ---");
  console.log(`  Starting Balance: $100.00`);
  console.log(`  Final Equity:     $${endEquity.toFixed(2)}`);
  console.log(`  Realized PnL:     $${walletState.totalRealizedPnl.toFixed(4)}`);
  console.log(`  Unrealized PnL:   $${walletState.unrealizedPnl.toFixed(4)}`);
  console.log(`  Open Positions:   ${walletState.positions.length}`);
  console.log(`  ROI:              ${((endEquity - 100) / 100 * 100).toFixed(2)}%`);

  console.log("\n--- Per Exchange P&L ---");
  for (const [exchange, pnl] of Object.entries(walletState.perExchangePnl)) {
    console.log(`  ${exchange}: $${(pnl as number).toFixed(4)}`);
  }

  console.log("\n--- Performance Metrics ---");
  console.log(`  Total Trades:   ${finalMetrics.totalTrades}`);
  console.log(`  Win Rate:       ${(finalMetrics.winRate * 100).toFixed(1)}%`);
  console.log(`  Profit Factor:  ${finalMetrics.profitFactor}`);
  console.log(`  Sharpe Ratio:   ${finalMetrics.sharpeRatio}`);
  console.log(`  Sortino Ratio:  ${finalMetrics.sortinoRatio}`);
  console.log(`  Max Drawdown:   $${finalMetrics.maxDrawdown.toFixed(4)}`);

  console.log("\n--- Engine Stats ---");
  console.log(`  Total Ticks:        ${engineStats.tickCount}`);
  console.log(`  Cross-Exchange Opps: ${engineStats.crossExchangeOpps}`);
  console.log(`  Cross-Exchange Trades: ${engineStats.crossExchangeTrades}`);
  console.log(`  Kalshi Markets:     ${engineStats.kalshiMarkets}`);
  console.log(`  Kalshi Books:       ${engineStats.kalshiBooksCount}`);
  console.log(`  Hyperliquid Coins:  ${engineStats.hyperliquidCoins}`);
  console.log(`  Hyperliquid Books:  ${engineStats.hyperliquidBooksCount}`);

  console.log("\n" + "=".repeat(70));
  console.log("  Test complete. Dashboard still running at http://localhost:" + DASHBOARD_PORT);
  console.log("  Press Ctrl+C to exit.");
  console.log("=".repeat(70) + "\n");

  // Keep running for dashboard access
  process.on("SIGINT", async () => {
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
