import { IDemoPosition, IDemoWalletState, IEquityPoint } from "../types/exchange.types";
import { logger } from "../utils/logger";
import { v4 as uuidv4 } from "uuid";

const MAX_EQUITY_POINTS = 10000;
const DEFAULT_POSITION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export class DemoWallet {
  private balance: number;
  private startingBalance: number;
  private positions: Map<string, IDemoPosition> = new Map();
  private equityCurve: IEquityPoint[] = [];
  private perExchangePnl: Map<string, number> = new Map();
  private totalRealizedPnl = 0;
  private positionTimeoutMs: number;

  constructor(startingBalance = 100, positionTimeoutMs = DEFAULT_POSITION_TIMEOUT_MS) {
    this.balance = startingBalance;
    this.startingBalance = startingBalance;
    this.positionTimeoutMs = positionTimeoutMs;
    this.recordEquity();
    logger.info(`[DemoWallet] Initialized with $${startingBalance.toFixed(2)}`);
  }

  /**
   * Open a position with optional leverage.
   * - margin = size (deducted from balance)
   * - notional = size * leverage (actual market exposure)
   * - PnL is calculated on notional, not margin
   *
   * Polymarket: leverage=1 (tokens are binary, no leverage)
   * Hyperliquid: leverage=1-20x (perp futures)
   */
  openPosition(
    exchange: string,
    symbol: string,
    side: "LONG" | "SHORT",
    size: number,
    entryPrice: number,
    strategy: string,
    leverage = 1
  ): IDemoPosition | null {
    if (size <= 0 || size > this.balance) {
      return null;
    }

    const position: IDemoPosition = {
      id: uuidv4(),
      exchange,
      symbol,
      side,
      size,           // margin posted
      leverage,
      notional: size * leverage,  // actual exposure
      entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      strategy,
      openedAt: Date.now(),
    };

    this.balance -= size;
    this.positions.set(position.id, position);
    return position;
  }

  /**
   * Close position. PnL is calculated on NOTIONAL (leveraged) exposure.
   * Returns realized PnL (can be >> margin for leveraged trades).
   * Liquidation: if loss >= margin, position is wiped (max loss = margin).
   */
  closePosition(positionId: string, exitPrice: number): number {
    const pos = this.positions.get(positionId);
    if (!pos) return 0;

    const priceDelta = pos.side === "LONG"
      ? exitPrice - pos.entryPrice
      : pos.entryPrice - exitPrice;

    // PnL on NOTIONAL exposure (leveraged)
    let pnl = (priceDelta / pos.entryPrice) * pos.notional;

    // Liquidation protection: max loss = margin posted
    if (pnl < -pos.size) {
      pnl = -pos.size;
    }

    this.balance += pos.size + pnl;
    this.totalRealizedPnl += pnl;

    const exchangePnl = this.perExchangePnl.get(pos.exchange) || 0;
    this.perExchangePnl.set(pos.exchange, exchangePnl + pnl);

    this.positions.delete(positionId);
    return pnl;
  }

  updatePositionPrice(positionId: string, currentPrice: number): void {
    const pos = this.positions.get(positionId);
    if (!pos) return;

    pos.currentPrice = currentPrice;
    const priceDelta = pos.side === "LONG"
      ? currentPrice - pos.entryPrice
      : pos.entryPrice - currentPrice;

    // Unrealized PnL on NOTIONAL (leveraged)
    let pnl = (priceDelta / pos.entryPrice) * pos.notional;
    // Cap loss at margin
    if (pnl < -pos.size) pnl = -pos.size;
    pos.unrealizedPnl = pnl;
  }

  checkAndCloseExpiredPositions(getCurrentPrice: (exchange: string, symbol: string) => number): number {
    const now = Date.now();
    let totalClosed = 0;

    const entries = Array.from(this.positions.entries());
    for (const [id, pos] of entries) {
      if (now - pos.openedAt > this.positionTimeoutMs) {
        const price = getCurrentPrice(pos.exchange, pos.symbol);
        const pnl = this.closePosition(id, price);
        totalClosed++;
        logger.info(`[DemoWallet] Auto-closed expired position ${pos.symbol}@${pos.exchange}: PnL $${pnl.toFixed(4)}`);
      }
    }

    return totalClosed;
  }

  /**
   * Check if position should be liquidated (loss >= margin).
   * Returns true if liquidated.
   */
  checkLiquidation(positionId: string, currentPrice: number): boolean {
    const pos = this.positions.get(positionId);
    if (!pos || pos.leverage <= 1) return false;

    const priceDelta = pos.side === "LONG"
      ? currentPrice - pos.entryPrice
      : pos.entryPrice - currentPrice;
    const pnl = (priceDelta / pos.entryPrice) * pos.notional;

    // Liquidation: loss exceeds 90% of margin (leave 10% for fees)
    if (pnl <= -pos.size * 0.9) {
      this.closePosition(positionId, currentPrice);
      logger.warning(`[LIQUIDATED] ${pos.symbol}@${pos.exchange} ${pos.leverage}x | Margin: $${pos.size.toFixed(2)}`);
      return true;
    }
    return false;
  }

  recordEquity(): void {
    const equity = this.getEquity();
    this.equityCurve.push({ timestamp: Date.now(), equity });

    if (this.equityCurve.length > MAX_EQUITY_POINTS) {
      this.equityCurve = this.equityCurve.slice(-MAX_EQUITY_POINTS);
    }
  }

  canAfford(size: number): boolean {
    return size > 0 && size <= this.balance;
  }

  getEquity(): number {
    let unrealized = 0;
    for (const pos of this.positions.values()) {
      unrealized += pos.unrealizedPnl;
    }
    return this.balance + this.getPositionsValue() + unrealized;
  }

  private getPositionsValue(): number {
    let total = 0;
    for (const pos of this.positions.values()) {
      total += pos.size;
    }
    return total;
  }

  getState(): IDemoWalletState {
    const positions = Array.from(this.positions.values());
    let unrealizedPnl = 0;
    for (const pos of positions) {
      unrealizedPnl += pos.unrealizedPnl;
    }

    const positionsValue = positions.reduce((sum, p) => sum + p.size, 0);

    return {
      totalBalance: this.balance,
      availableBalance: this.balance,
      unrealizedPnl,
      totalEquity: this.balance + positionsValue + unrealizedPnl,
      positions,
      equityCurve: this.equityCurve.slice(-500),
      perExchangePnl: Object.fromEntries(this.perExchangePnl),
      totalRealizedPnl: this.totalRealizedPnl,
    };
  }

  getBalance(): number {
    return this.balance;
  }

  getStartingBalance(): number {
    return this.startingBalance;
  }

  getPositionCount(): number {
    return this.positions.size;
  }

  getPositions(): IDemoPosition[] {
    return Array.from(this.positions.values());
  }

  getFullEquityCurve(): IEquityPoint[] {
    return this.equityCurve;
  }
}
