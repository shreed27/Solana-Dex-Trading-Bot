import { IDemoPosition, IDemoWalletState, IEquityPoint } from "../types/exchange.types";
import { logger } from "../utils/logger";
import { v4 as uuidv4 } from "uuid";

const MAX_EQUITY_POINTS = 10000;
const DEFAULT_POSITION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

  openPosition(
    exchange: string,
    symbol: string,
    side: "LONG" | "SHORT",
    size: number,
    entryPrice: number,
    strategy: string
  ): IDemoPosition | null {
    if (size <= 0 || size > this.balance) {
      return null;
    }

    const position: IDemoPosition = {
      id: uuidv4(),
      exchange,
      symbol,
      side,
      size,
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

  closePosition(positionId: string, exitPrice: number): number {
    const pos = this.positions.get(positionId);
    if (!pos) return 0;

    const priceDelta = pos.side === "LONG"
      ? exitPrice - pos.entryPrice
      : pos.entryPrice - exitPrice;
    const pnl = (priceDelta / pos.entryPrice) * pos.size;

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
    pos.unrealizedPnl = (priceDelta / pos.entryPrice) * pos.size;
  }

  checkAndCloseExpiredPositions(getCurrentPrice: (exchange: string, symbol: string) => number): number {
    const now = Date.now();
    let totalClosed = 0;

    for (const [id, pos] of this.positions) {
      if (now - pos.openedAt > this.positionTimeoutMs) {
        const price = getCurrentPrice(pos.exchange, pos.symbol);
        const pnl = this.closePosition(id, price);
        totalClosed++;
        logger.info(`[DemoWallet] Auto-closed expired position ${pos.symbol}@${pos.exchange}: PnL $${pnl.toFixed(4)}`);
      }
    }

    return totalClosed;
  }

  recordEquity(): void {
    const equity = this.getEquity();
    this.equityCurve.push({ timestamp: Date.now(), equity });

    // Ring buffer — keep last N points
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
    // Note: balance was already reduced when opening, size is tracked separately
    // Equity = balance + sum(size + unrealizedPnl) for each position
    return 0; // size already subtracted from balance, unrealized tracked separately
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
      equityCurve: this.equityCurve.slice(-500), // send last 500 to dashboard
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
