/**
 * ============================================================================
 * MILLENNIUM MANAGEMENT — LIVE TRADING SYSTEM
 * ============================================================================
 *
 * Production trading system that executes algorithmic strategies in real-time.
 *
 * COMPONENTS:
 * 1. Order Management System (OMS) — State machine for order lifecycle
 * 2. Position Tracker — Real-time portfolio state
 * 3. Kill Switch — Emergency shutdown
 * 4. Reconciliation Engine — Internal vs broker state
 * 5. Alert System — Real-time notifications
 * 6. Audit Logger — Complete decision trail
 *
 * ============================================================================
 */

import { v4 as uuidv4 } from "uuid";
import { logger } from "../../utils/logger";
import { IDemoPosition } from "../../types/exchange.types";

// ============================================================================
// ORDER MANAGEMENT SYSTEM
// ============================================================================

export type OrderState =
  | "CREATED"        // Order object created
  | "VALIDATED"      // Passed pre-trade risk checks
  | "SUBMITTED"      // Sent to exchange
  | "ACKNOWLEDGED"   // Exchange confirmed receipt
  | "PARTIAL_FILL"   // Partially filled
  | "FILLED"         // Completely filled
  | "CANCELLED"      // Cancelled (by us or exchange)
  | "REJECTED"       // Rejected by exchange
  | "EXPIRED"        // Timed out
  | "ERROR";         // System error

export interface IOrder {
  id: string;
  clientOrderId: string;
  instrument: string;
  exchange: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET" | "STOP" | "STOP_LIMIT";
  price: number;
  size: number;
  filledSize: number;
  avgFillPrice: number;
  state: OrderState;
  strategy: string;
  signalId: string;

  // Timestamps
  createdAt: number;
  submittedAt?: number;
  acknowledgedAt?: number;
  firstFillAt?: number;
  completedAt?: number;

  // Metadata
  stateHistory: { state: OrderState; timestamp: number; reason?: string }[];
  fills: IFill[];
  parentOrderId?: string;    // For child orders
  tags: Record<string, string>;
}

export interface IFill {
  id: string;
  orderId: string;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
  exchange: string;
}

// Valid state transitions
const VALID_TRANSITIONS: Record<OrderState, OrderState[]> = {
  CREATED: ["VALIDATED", "CANCELLED", "ERROR"],
  VALIDATED: ["SUBMITTED", "CANCELLED", "ERROR"],
  SUBMITTED: ["ACKNOWLEDGED", "REJECTED", "CANCELLED", "ERROR"],
  ACKNOWLEDGED: ["PARTIAL_FILL", "FILLED", "CANCELLED", "EXPIRED", "ERROR"],
  PARTIAL_FILL: ["PARTIAL_FILL", "FILLED", "CANCELLED", "ERROR"],
  FILLED: [],          // Terminal state
  CANCELLED: [],       // Terminal state
  REJECTED: [],        // Terminal state
  EXPIRED: [],         // Terminal state
  ERROR: ["CREATED"],  // Can retry
};

export class OrderManagementSystem {
  private orders: Map<string, IOrder> = new Map();
  private ordersByExchange: Map<string, Map<string, IOrder>> = new Map();
  private auditLog: IAuditEntry[] = [];

  /**
   * Create a new order. Returns order ID.
   */
  createOrder(
    instrument: string,
    exchange: string,
    side: "BUY" | "SELL",
    type: "LIMIT" | "MARKET",
    price: number,
    size: number,
    strategy: string,
    signalId: string,
    tags: Record<string, string> = {}
  ): IOrder {
    const order: IOrder = {
      id: uuidv4(),
      clientOrderId: `${strategy}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      instrument,
      exchange,
      side,
      type,
      price,
      size,
      filledSize: 0,
      avgFillPrice: 0,
      state: "CREATED",
      strategy,
      signalId,
      createdAt: Date.now(),
      stateHistory: [{ state: "CREATED", timestamp: Date.now() }],
      fills: [],
      tags,
    };

    this.orders.set(order.id, order);
    this.logAudit("ORDER_CREATED", order.id, { instrument, exchange, side, type, price, size, strategy });

    return order;
  }

  /**
   * Transition order to a new state.
   * Validates the transition is legal.
   */
  transitionState(orderId: string, newState: OrderState, reason?: string): boolean {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.error(`[OMS] Order ${orderId} not found`);
      return false;
    }

    const validNext = VALID_TRANSITIONS[order.state];
    if (!validNext.includes(newState)) {
      logger.error(`[OMS] Invalid transition: ${order.state} → ${newState} for order ${orderId}`);
      this.logAudit("INVALID_TRANSITION", orderId, { from: order.state, to: newState, reason });
      return false;
    }

    const previousState = order.state;
    order.state = newState;
    order.stateHistory.push({ state: newState, timestamp: Date.now(), reason });

    // Update timestamps
    if (newState === "SUBMITTED") order.submittedAt = Date.now();
    if (newState === "ACKNOWLEDGED") order.acknowledgedAt = Date.now();
    if (newState === "FILLED" || newState === "CANCELLED" || newState === "REJECTED" || newState === "EXPIRED") {
      order.completedAt = Date.now();
    }

    this.logAudit("STATE_TRANSITION", orderId, { from: previousState, to: newState, reason });

    return true;
  }

  /**
   * Record a fill on an order.
   */
  recordFill(orderId: string, price: number, size: number, fee: number): boolean {
    const order = this.orders.get(orderId);
    if (!order) return false;

    if (order.state !== "ACKNOWLEDGED" && order.state !== "PARTIAL_FILL") {
      logger.error(`[OMS] Cannot fill order in state ${order.state}`);
      return false;
    }

    const fill: IFill = {
      id: uuidv4(),
      orderId,
      price,
      size,
      fee,
      timestamp: Date.now(),
      exchange: order.exchange,
    };

    order.fills.push(fill);
    if (!order.firstFillAt) order.firstFillAt = Date.now();

    // Update fill tracking
    const prevFilled = order.filledSize;
    order.filledSize += size;
    order.avgFillPrice = order.filledSize > 0
      ? (prevFilled * order.avgFillPrice + size * price) / order.filledSize
      : price;

    // Determine next state
    if (order.filledSize >= order.size * 0.999) {
      this.transitionState(orderId, "FILLED", "Fully filled");
    } else {
      this.transitionState(orderId, "PARTIAL_FILL", `Filled ${order.filledSize}/${order.size}`);
    }

    this.logAudit("FILL", orderId, { price, size, fee, totalFilled: order.filledSize });

    return true;
  }

  /**
   * Cancel an order.
   */
  cancelOrder(orderId: string, reason = "User requested"): boolean {
    return this.transitionState(orderId, "CANCELLED", reason);
  }

  /**
   * Cancel ALL open orders.
   */
  cancelAllOrders(reason = "Kill switch"): number {
    let cancelled = 0;
    for (const [id, order] of this.orders) {
      if (!["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "ERROR"].includes(order.state)) {
        if (this.transitionState(id, "CANCELLED", reason)) {
          cancelled++;
        }
      }
    }
    return cancelled;
  }

  getOrder(orderId: string): IOrder | undefined {
    return this.orders.get(orderId);
  }

  getOpenOrders(): IOrder[] {
    return Array.from(this.orders.values()).filter(o =>
      !["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "ERROR"].includes(o.state)
    );
  }

  getRecentOrders(n = 50): IOrder[] {
    return Array.from(this.orders.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, n);
  }

  getOrderStats(): {
    total: number;
    open: number;
    filled: number;
    cancelled: number;
    rejected: number;
    avgFillLatency: number;
  } {
    const orders = Array.from(this.orders.values());
    const filled = orders.filter(o => o.state === "FILLED");
    const fillLatencies = filled
      .filter(o => o.submittedAt && o.firstFillAt)
      .map(o => o.firstFillAt! - o.submittedAt!);

    return {
      total: orders.length,
      open: orders.filter(o => !["FILLED", "CANCELLED", "REJECTED", "EXPIRED", "ERROR"].includes(o.state)).length,
      filled: filled.length,
      cancelled: orders.filter(o => o.state === "CANCELLED").length,
      rejected: orders.filter(o => o.state === "REJECTED").length,
      avgFillLatency: fillLatencies.length > 0 ? fillLatencies.reduce((s, v) => s + v, 0) / fillLatencies.length : 0,
    };
  }

  // ==================== AUDIT LOGGING ====================

  private logAudit(event: string, orderId: string, data: Record<string, any>): void {
    const entry: IAuditEntry = {
      timestamp: Date.now(),
      event,
      orderId,
      data,
    };
    this.auditLog.push(entry);
    if (this.auditLog.length > 10000) this.auditLog.splice(0, this.auditLog.length - 10000);
  }

  getAuditLog(n = 100): IAuditEntry[] {
    return this.auditLog.slice(-n);
  }
}

export interface IAuditEntry {
  timestamp: number;
  event: string;
  orderId: string;
  data: Record<string, any>;
}

// ============================================================================
// POSITION TRACKER
// ============================================================================

export class PositionTracker {
  private positions: Map<string, ITrackedPosition> = new Map();
  private closedPositions: ITrackedPosition[] = [];
  private dailyPnl = 0;
  private totalRealizedPnl = 0;

  openPosition(
    instrument: string,
    exchange: string,
    side: "LONG" | "SHORT",
    size: number,
    entryPrice: number,
    strategy: string,
    orderId: string
  ): ITrackedPosition {
    const key = `${exchange}:${instrument}:${strategy}`;

    const position: ITrackedPosition = {
      id: uuidv4(),
      instrument,
      exchange,
      side,
      size,
      entryPrice,
      currentPrice: entryPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
      strategy,
      orderId,
      openedAt: Date.now(),
      maxPrice: entryPrice,
      minPrice: entryPrice,
      maxUnrealizedPnl: 0,
      minUnrealizedPnl: 0,
    };

    this.positions.set(position.id, position);
    return position;
  }

  updatePrice(positionId: string, price: number): void {
    const pos = this.positions.get(positionId);
    if (!pos) return;

    pos.currentPrice = price;
    pos.maxPrice = Math.max(pos.maxPrice, price);
    pos.minPrice = Math.min(pos.minPrice, price);

    const priceDelta = pos.side === "LONG" ? price - pos.entryPrice : pos.entryPrice - price;
    pos.unrealizedPnl = (priceDelta / pos.entryPrice) * pos.size;
    pos.maxUnrealizedPnl = Math.max(pos.maxUnrealizedPnl, pos.unrealizedPnl);
    pos.minUnrealizedPnl = Math.min(pos.minUnrealizedPnl, pos.unrealizedPnl);
  }

  closePosition(positionId: string, exitPrice: number): number {
    const pos = this.positions.get(positionId);
    if (!pos) return 0;

    const priceDelta = pos.side === "LONG" ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnl = (priceDelta / pos.entryPrice) * pos.size;

    pos.realizedPnl = pnl;
    pos.currentPrice = exitPrice;
    pos.unrealizedPnl = 0;

    this.totalRealizedPnl += pnl;
    this.dailyPnl += pnl;

    this.positions.delete(positionId);
    this.closedPositions.push({ ...pos, closedAt: Date.now() });

    if (this.closedPositions.length > 1000) {
      this.closedPositions.splice(0, this.closedPositions.length - 1000);
    }

    return pnl;
  }

  getOpenPositions(): ITrackedPosition[] {
    return Array.from(this.positions.values());
  }

  getTotalExposure(): number {
    return Array.from(this.positions.values()).reduce((s, p) => s + p.size, 0);
  }

  getTotalUnrealizedPnl(): number {
    return Array.from(this.positions.values()).reduce((s, p) => s + p.unrealizedPnl, 0);
  }

  getExposureByExchange(): Record<string, number> {
    const exposure: Record<string, number> = {};
    for (const pos of this.positions.values()) {
      exposure[pos.exchange] = (exposure[pos.exchange] || 0) + pos.size;
    }
    return exposure;
  }

  getDailyPnl(): number { return this.dailyPnl; }
  getTotalRealizedPnl(): number { return this.totalRealizedPnl; }

  resetDaily(): void { this.dailyPnl = 0; }
}

export interface ITrackedPosition {
  id: string;
  instrument: string;
  exchange: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  strategy: string;
  orderId: string;
  openedAt: number;
  closedAt?: number;
  maxPrice: number;
  minPrice: number;
  maxUnrealizedPnl: number;
  minUnrealizedPnl: number;
}

// ============================================================================
// KILL SWITCH
// ============================================================================

export class KillSwitch {
  private armed = false;
  private triggered = false;
  private triggerReason = "";
  private triggerTime = 0;
  private oms: OrderManagementSystem;
  private positionTracker: PositionTracker;

  constructor(oms: OrderManagementSystem, positionTracker: PositionTracker) {
    this.oms = oms;
    this.positionTracker = positionTracker;
  }

  /**
   * EMERGENCY SHUTDOWN
   *
   * 1. Cancel all open orders immediately
   * 2. Close all positions at market
   * 3. Halt all trading
   * 4. Log everything
   */
  trigger(reason: string): {
    ordersCancelled: number;
    positionsClosed: number;
    estimatedPnl: number;
  } {
    this.triggered = true;
    this.triggerReason = reason;
    this.triggerTime = Date.now();

    logger.warning(`[KILL SWITCH] TRIGGERED: ${reason}`);

    // 1. Cancel all open orders
    const ordersCancelled = this.oms.cancelAllOrders(`KILL SWITCH: ${reason}`);

    // 2. Close all positions
    const positions = this.positionTracker.getOpenPositions();
    let estimatedPnl = 0;
    for (const pos of positions) {
      const pnl = this.positionTracker.closePosition(pos.id, pos.currentPrice);
      estimatedPnl += pnl;
    }

    logger.warning(`[KILL SWITCH] Cancelled ${ordersCancelled} orders, closed ${positions.length} positions`);
    logger.warning(`[KILL SWITCH] Estimated P&L impact: $${estimatedPnl.toFixed(4)}`);

    return {
      ordersCancelled,
      positionsClosed: positions.length,
      estimatedPnl,
    };
  }

  reset(): void {
    this.triggered = false;
    this.triggerReason = "";
    logger.info("[KILL SWITCH] Reset — trading can resume");
  }

  isTriggered(): boolean { return this.triggered; }
  getTriggerReason(): string { return this.triggerReason; }
  getTriggerTime(): number { return this.triggerTime; }
}

// ============================================================================
// RECONCILIATION ENGINE
// ============================================================================

export class ReconciliationEngine {
  private discrepancies: IDiscrepancy[] = [];

  /**
   * Compare internal position state against broker/exchange state.
   */
  reconcile(
    internalPositions: ITrackedPosition[],
    externalPositions: { instrument: string; exchange: string; size: number; price: number }[]
  ): IDiscrepancy[] {
    const newDiscrepancies: IDiscrepancy[] = [];

    // Check all internal positions exist externally
    for (const internal of internalPositions) {
      const external = externalPositions.find(
        e => e.instrument === internal.instrument && e.exchange === internal.exchange
      );

      if (!external) {
        newDiscrepancies.push({
          type: "MISSING_EXTERNAL",
          instrument: internal.instrument,
          exchange: internal.exchange,
          internalSize: internal.size,
          externalSize: 0,
          difference: internal.size,
          timestamp: Date.now(),
          severity: "HIGH",
        });
      } else if (Math.abs(internal.size - external.size) > 0.01) {
        newDiscrepancies.push({
          type: "SIZE_MISMATCH",
          instrument: internal.instrument,
          exchange: internal.exchange,
          internalSize: internal.size,
          externalSize: external.size,
          difference: Math.abs(internal.size - external.size),
          timestamp: Date.now(),
          severity: Math.abs(internal.size - external.size) > 1 ? "HIGH" : "LOW",
        });
      }
    }

    // Check for external positions not tracked internally
    for (const external of externalPositions) {
      const internal = internalPositions.find(
        i => i.instrument === external.instrument && i.exchange === external.exchange
      );

      if (!internal && external.size > 0.01) {
        newDiscrepancies.push({
          type: "MISSING_INTERNAL",
          instrument: external.instrument,
          exchange: external.exchange,
          internalSize: 0,
          externalSize: external.size,
          difference: external.size,
          timestamp: Date.now(),
          severity: "HIGH",
        });
      }
    }

    this.discrepancies.push(...newDiscrepancies);
    if (this.discrepancies.length > 1000) {
      this.discrepancies.splice(0, this.discrepancies.length - 1000);
    }

    return newDiscrepancies;
  }

  getRecentDiscrepancies(n = 50): IDiscrepancy[] {
    return this.discrepancies.slice(-n);
  }

  hasHighSeverity(): boolean {
    const recent = this.discrepancies.slice(-10);
    return recent.some(d => d.severity === "HIGH");
  }
}

export interface IDiscrepancy {
  type: "MISSING_EXTERNAL" | "MISSING_INTERNAL" | "SIZE_MISMATCH" | "PRICE_MISMATCH";
  instrument: string;
  exchange: string;
  internalSize: number;
  externalSize: number;
  difference: number;
  timestamp: number;
  severity: "LOW" | "MEDIUM" | "HIGH";
}

// ============================================================================
// ALERT SYSTEM
// ============================================================================

export class AlertSystem {
  private alerts: IAlert[] = [];
  private alertHandlers: ((alert: IAlert) => void)[] = [];

  registerHandler(handler: (alert: IAlert) => void): void {
    this.alertHandlers.push(handler);
  }

  emit(
    level: "INFO" | "WARNING" | "CRITICAL",
    category: string,
    message: string,
    data?: Record<string, any>
  ): void {
    const alert: IAlert = {
      id: uuidv4(),
      timestamp: Date.now(),
      level,
      category,
      message,
      data,
      acknowledged: false,
    };

    this.alerts.push(alert);
    if (this.alerts.length > 500) this.alerts.splice(0, this.alerts.length - 500);

    // Notify handlers
    for (const handler of this.alertHandlers) {
      try { handler(alert); } catch { /* Don't let handler errors crash the system */ }
    }

    // Log
    if (level === "CRITICAL") {
      logger.error(`[ALERT] ${category}: ${message}`);
    } else if (level === "WARNING") {
      logger.warning(`[ALERT] ${category}: ${message}`);
    }
  }

  getUnacknowledged(): IAlert[] {
    return this.alerts.filter(a => !a.acknowledged);
  }

  acknowledge(alertId: string): void {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) alert.acknowledged = true;
  }

  getRecent(n = 50): IAlert[] {
    return this.alerts.slice(-n);
  }
}

export interface IAlert {
  id: string;
  timestamp: number;
  level: "INFO" | "WARNING" | "CRITICAL";
  category: string;
  message: string;
  data?: Record<string, any>;
  acknowledged: boolean;
}
