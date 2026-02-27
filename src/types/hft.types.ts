import { PolymarketAsset, PolymarketInterval, PolymarketDirection, IPolymarketBookLevel } from "./polymarket.types";

// ==================== TICK ENGINE ====================

export interface ITickSnapshot {
  asset: PolymarketAsset;
  interval: PolymarketInterval;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  yesBids: IPolymarketBookLevel[];
  yesAsks: IPolymarketBookLevel[];
  noBids: IPolymarketBookLevel[];
  noAsks: IPolymarketBookLevel[];
  yesMid: number;
  noMid: number;
  yesSpread: number;
  noSpread: number;
  yesBestBid: number;
  yesBestAsk: number;
  noBestBid: number;
  noBestAsk: number;
  yesBidDepth: number;   // Total $ depth on bid side
  yesAskDepth: number;
  noBidDepth: number;
  noAskDepth: number;
  binancePrice: number;
  binancePriceChange10s: number; // % change over 10s
  binancePriceChange30s: number; // % change over 30s
  timestamp: number;
}

// ==================== OPPORTUNITIES ====================

export type HFTStrategyType =
  | "yes_no_arb"
  | "latency_arb"
  | "spread_capture"
  | "microstructure";

export interface IArbOpportunity {
  type: HFTStrategyType;
  strategyId: string;
  asset: PolymarketAsset;
  interval: PolymarketInterval;
  conditionId: string;
  direction: PolymarketDirection;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;         // USDC
  expectedProfit: number;
  confidence: number;   // 0-1
  edge: number;         // % edge over fair value
  orderType: "FOK" | "GTC" | "GTD" | "FAK";
  expiration?: number;  // UTC seconds for GTD
  metadata: Record<string, any>;
}

// ==================== TRADE RECORDS ====================

export interface IHFTTrade {
  id: string;
  strategy: HFTStrategyType;
  strategyId: string;
  asset: PolymarketAsset;
  interval: PolymarketInterval;
  conditionId: string;
  direction: PolymarketDirection;
  tokenId: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  size: number;
  shares: number;
  pnl: number;
  holdTimeMs: number;
  orderId?: string;
  openedAt: number;
  closedAt: number;
  exchange?: string; // "polymarket" | "kalshi" | "hyperliquid"
}

// ==================== PERFORMANCE ====================

export interface IPerformanceMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  winRate: number;
  totalPnl: number;
  grossProfit: number;
  grossLoss: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  tradesPerHour: number;
  avgHoldTimeMs: number;
  largestWin: number;
  largestLoss: number;
}

export interface IPerformanceWindow {
  label: string;
  windowMs: number;
  metrics: IPerformanceMetrics;
}

// ==================== RISK ====================

export interface IHFTRiskLimits {
  maxInventoryPerAsset: number;   // $ max inventory per asset
  maxTotalExposure: number;       // $ max total HFT exposure
  maxLossPerMinute: number;       // $ max loss in 1 minute
  maxLossPerHour: number;         // $ max loss in 1 hour
  maxConcurrentOrders: number;
  minTimeToResolution: number;    // seconds
  maxTradeSize: number;           // $ per trade
  minEdge: Record<HFTStrategyType, number>; // min edge per strategy type
}

export interface IHFTRiskCheck {
  allowed: boolean;
  reason?: string;
  currentInventory: number;
  currentExposure: number;
  recentPnl1m: number;
  recentPnl1h: number;
  openOrderCount: number;
  suggestedSize: number;
}

// ==================== ORDER TRACKING ====================

export interface ITrackedOrder {
  orderId: string;
  strategyId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  orderType: "FOK" | "GTC" | "GTD" | "FAK";
  placedAt: number;
  filled: boolean;
  cancelled: boolean;
  fillPrice?: number;
  fillLatencyMs?: number;
}

// ==================== INVENTORY ====================

export interface IInventoryState {
  asset: PolymarketAsset;
  yesShares: number;
  noShares: number;
  yesValue: number;    // shares * current mid price
  noValue: number;
  netExposure: number; // yesValue - noValue (0 = delta neutral)
  totalValue: number;  // yesValue + noValue
}
