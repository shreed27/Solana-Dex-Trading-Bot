import { IPerformanceMetrics, IHFTTrade } from "./hft.types";

// ==================== UNIFIED EXCHANGE INTERFACE ====================

export interface IExchangeClient {
  id: string;
  name: string;
  getOrderbook(symbol: string): Promise<IUnifiedOrderbook | null>;
  placeLimitOrder(
    symbol: string,
    side: "BUY" | "SELL",
    price: number,
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }>;
  placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    size: number
  ): Promise<{ success: boolean; orderId?: string; error?: string }>;
  cancelOrder(orderId: string): Promise<boolean>;
  isConnected(): boolean;
}

// ==================== UNIFIED ORDERBOOK ====================

export interface IUnifiedBookLevel {
  price: number;
  size: number;
}

export interface IUnifiedOrderbook {
  exchange: string;
  symbol: string;
  bids: IUnifiedBookLevel[];
  asks: IUnifiedBookLevel[];
  midPrice: number;
  spread: number;
  timestamp: number;
}

// ==================== DEMO WALLET ====================

export interface IDemoPosition {
  id: string;
  exchange: string;
  symbol: string;
  side: "LONG" | "SHORT";
  size: number; // USDC margin posted
  leverage: number; // leverage multiplier (1x = spot, 20x = perp)
  notional: number; // size * leverage = actual exposure
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  strategy: string;
  openedAt: number;
}

export interface IEquityPoint {
  timestamp: number;
  equity: number;
}

export interface IDemoWalletState {
  totalBalance: number;
  availableBalance: number;
  unrealizedPnl: number;
  totalEquity: number;
  positions: IDemoPosition[];
  equityCurve: IEquityPoint[];
  perExchangePnl: Record<string, number>;
  totalRealizedPnl: number;
}

// ==================== DASHBOARD ====================

export interface IDashboardPayload {
  wallet: IDemoWalletState;
  performance: IPerformanceMetrics;
  perStrategyMetrics: Record<string, IPerformanceMetrics>;
  perExchangeMetrics: Record<string, { trades: number; pnl: number; winRate: number }>;
  positions: IDemoPosition[];
  recentTrades: IHFTTrade[];
  orderbooks: IUnifiedOrderbook[];
  ticksPerSecond: number;
  uptime: number;
  connectedExchanges: string[];
  timestamp: number;
}

// ==================== MULTI-EXCHANGE TICK ====================

export interface IMultiExchangeTick {
  exchange: string;
  symbol: string;
  orderbook: IUnifiedOrderbook;
  timestamp: number;
}

export interface ICrossExchangeOpportunity {
  type: "cross_exchange_arb" | "perp_prediction_divergence";
  exchangeA: string;
  exchangeB: string;
  symbol: string;
  priceA: number;
  priceB: number;
  spread: number;
  expectedProfit: number;
  confidence: number;
  direction: "BUY_A_SELL_B" | "BUY_B_SELL_A";
}
