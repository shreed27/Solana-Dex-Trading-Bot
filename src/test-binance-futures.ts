/**
 * BINANCE FUTURES — Momentum Trading (Testnet or Live)
 *
 * Flow:
 * 1. Connect to Binance Futures API (testnet)
 * 2. Start Binance WebSocket for real-time prices
 * 3. Detect momentum signals
 * 4. Execute leveraged trades via REST API
 * 5. Manage positions with trailing stop + hard SL
 *
 * Usage: npx ts-node src/test-binance-futures.ts
 */

import { BinanceFuturesClient } from "./exchange/BinanceFuturesClient";
import { BinanceWebSocketFeed } from "./exchange/BinanceWebSocketFeed";
import { logger } from "./utils/logger";

async function main() {
  console.log("=".repeat(60));
  console.log("  BINANCE FUTURES — MOMENTUM TRADING");
  console.log("=".repeat(60));

  const client = new BinanceFuturesClient();

  // 1. Connect
  const ok = await client.connect();
  if (!ok) {
    console.error("\nFailed to connect. Check your .env file:");
    console.error("  BINANCE_API_KEY=your_key");
    console.error("  BINANCE_API_SECRET=your_secret");
    console.error("  BINANCE_TESTNET=true");
    console.error("\nGet testnet keys at: https://testnet.binancefuture.com");
    process.exit(1);
  }

  // 2. Check balance
  const balance = await client.getBalance();
  console.log(`\nBalance: $${balance.total.toFixed(2)} USDT (free: $${balance.free.toFixed(2)})`);

  if (balance.free < 10) {
    console.error("Insufficient balance.");
    process.exit(1);
  }

  // 3. Setup assets
  const assets = ["BTC", "ETH", "SOL"];
  const symbols = assets.map(a => `${a}USDT`);
  const leverage = 20;

  for (const sym of symbols) {
    await client.setLeverage(sym, leverage);
    await client.setMarginMode(sym, "CROSSED");
    console.log(`  ${sym}: ${leverage}x cross`);
  }

  // 4. Quick test: get BTC price
  const btcPrice = await client.getPrice("BTCUSDT");
  console.log(`\nBTC: $${btcPrice.toFixed(2)}`);

  // ===== STRATEGY CONFIG =====
  const equityPct = 0.10;     // 10% of free balance per trade
  const hardSlPct = 0.007;    // 0.7% hard SL (= 14% on 20x)
  const trailActivate = 0.005;
  const trailGiveback = 0.30;
  const cooldownMs = 3000;
  const maxPositions = 3;     // Max simultaneous positions

  // ===== STRATEGY STATE =====
  const lastTrade: Map<string, number> = new Map();
  const activePositions: Map<string, {
    symbol: string;
    side: "long" | "short";
    size: number;
    entryPrice: number;
    maxPrice: number;
    minPrice: number;
    trailActive: boolean;
  }> = new Map();
  let totalPnl = 0;
  let trades = 0;
  let wins = 0;

  // ===== BINANCE WS FOR MOMENTUM DETECTION =====
  const feed = new BinanceWebSocketFeed();
  feed.connect();

  const tickBuffers: Map<string, { price: number; ts: number }[]> = new Map();
  let lastStatusLog = Date.now();

  feed.onPrice(async (asset, price, _change10s, _change30s) => {
    // Buffer ticks
    let buf = tickBuffers.get(asset);
    if (!buf) { buf = []; tickBuffers.set(asset, buf); }
    buf.push({ price, ts: Date.now() });
    if (buf.length > 20) buf.splice(0, buf.length - 20);

    if (!assets.includes(asset)) return;

    const sym = `${asset}USDT`;

    // ===== MANAGE EXISTING POSITION =====
    if (activePositions.has(asset)) {
      const pos = activePositions.get(asset)!;
      const isLong = pos.side === "long";

      // Update extremes
      if (isLong) pos.maxPrice = Math.max(pos.maxPrice, price);
      else pos.minPrice = Math.min(pos.minPrice, price);

      // Hard SL
      const slHit = isLong
        ? price <= pos.entryPrice * (1 - hardSlPct)
        : price >= pos.entryPrice * (1 + hardSlPct);

      if (slHit) {
        const close = await client.closePosition(sym, pos.side, pos.size);
        if (close) {
          const pnl = isLong
            ? (close.price - pos.entryPrice) * pos.size
            : (pos.entryPrice - close.price) * pos.size;
          totalPnl += pnl;
          trades++;
          logger.info(`[SL] ${pos.side.toUpperCase()} ${asset} | Entry=$${pos.entryPrice.toFixed(2)} Exit=$${close.price.toFixed(2)} | PnL: $${pnl.toFixed(2)}`);
        }
        activePositions.delete(asset);
        return;
      }

      // Trailing stop
      const profitPct = isLong
        ? (price - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - price) / pos.entryPrice;

      if (profitPct >= trailActivate) pos.trailActive = true;

      if (pos.trailActive) {
        const maxProfit = isLong
          ? pos.maxPrice - pos.entryPrice
          : pos.entryPrice - pos.minPrice;
        const currentProfit = isLong
          ? price - pos.entryPrice
          : pos.entryPrice - price;
        const gaveBack = maxProfit - currentProfit;

        if (maxProfit > 0 && gaveBack > maxProfit * trailGiveback) {
          const close = await client.closePosition(sym, pos.side, pos.size);
          if (close) {
            const pnl = isLong
              ? (close.price - pos.entryPrice) * pos.size
              : (pos.entryPrice - close.price) * pos.size;
            totalPnl += pnl;
            trades++;
            if (pnl > 0) wins++;
            logger.info(`[TRAIL] ${pos.side.toUpperCase()} ${asset} | Entry=$${pos.entryPrice.toFixed(2)} Exit=$${close.price.toFixed(2)} | PnL: $${pnl.toFixed(2)}`);
          }
          activePositions.delete(asset);
          return;
        }
      }

      return; // Already in position, don't open more
    }

    // ===== DETECT MOMENTUM =====
    const last = lastTrade.get(asset) || 0;
    if (Date.now() - last < cooldownMs) return;
    if (activePositions.size >= maxPositions) return;
    if (buf.length < 4) return;

    const recent = buf.slice(-8);
    const changes: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      changes.push(recent[i].price - recent[i - 1].price);
    }

    let consecutive = 0;
    const lastChange = changes[changes.length - 1];
    if (lastChange === 0) return;
    const dir = lastChange > 0 ? 1 : -1;
    for (let i = changes.length - 1; i >= 0; i--) {
      if (changes[i] * dir > 0) consecutive++;
      else break;
    }
    if (consecutive < 2) return;

    const streakStart = recent[recent.length - 1 - consecutive].price;
    const streakEnd = recent[recent.length - 1].price;
    const moveSize = Math.abs(streakEnd - streakStart) / streakStart;
    if (moveSize < 0.0002) return; // Min 0.02% move

    // ===== OPEN POSITION =====
    const bal = await client.getBalance();
    const margin = Math.max(10, bal.free * equityPct);
    if (margin > bal.free - 10) return; // Keep $10 reserve

    const side: "BUY" | "SELL" = dir > 0 ? "BUY" : "SELL";
    const notional = margin * leverage;
    const qty = client.usdToQty(sym, notional, price);
    if (qty <= 0) return;

    const order = await client.marketOrder(sym, side, qty);
    if (!order) return;

    activePositions.set(asset, {
      symbol: sym,
      side: dir > 0 ? "long" : "short",
      size: qty,
      entryPrice: order.price,
      maxPrice: order.price,
      minPrice: order.price,
      trailActive: false,
    });

    lastTrade.set(asset, Date.now());

    const actualNotional = qty * order.price;
    logger.info(
      `[OPEN] ${side} ${asset} ${leverage}x | ` +
      `Margin: $${margin.toFixed(2)} Notional: $${actualNotional.toFixed(0)} | ` +
      `Qty: ${qty} @ $${order.price.toFixed(2)} | Move: ${(moveSize * 100).toFixed(3)}%`
    );
  });

  // ===== STATUS EVERY 30s =====
  setInterval(async () => {
    const bal = await client.getBalance();
    const posStr = [...activePositions.entries()]
      .map(([a, p]) => `${p.side[0].toUpperCase()}${a}`)
      .join(" ");

    const wr = trades > 0 ? ((wins / trades) * 100).toFixed(0) : "-";
    logger.info(
      `[STATUS] $${bal.total.toFixed(2)} (free: $${bal.free.toFixed(2)}) | ` +
      `${trades}T/${wins}W ${wr}%WR | PnL: $${totalPnl.toFixed(2)} | ` +
      `Pos: ${activePositions.size}/${maxPositions} ${posStr || "none"}`
    );
  }, 30_000);

  console.log("\n  Strategy running. Ctrl+C to stop.\n");

  // ===== GRACEFUL SHUTDOWN =====
  process.on("SIGINT", async () => {
    console.log("\n\nShutting down...");
    feed.disconnect();

    for (const [asset, pos] of activePositions) {
      console.log(`  Closing ${pos.side} ${asset}...`);
      await client.closePosition(pos.symbol, pos.side, pos.size);
    }

    const final = await client.getBalance();
    console.log(`\n  Trades: ${trades} | Wins: ${wins} | PnL: $${totalPnl.toFixed(2)}`);
    console.log(`  Final balance: $${final.total.toFixed(2)} USDT\n`);
    process.exit(0);
  });
}

main().catch(console.error);
