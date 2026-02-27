// ==================== HYPERLIQUID L2 BOOK ====================

// Raw API response: levels are objects { px, sz, n }
export interface IHyperliquidRawLevel {
  px: string;
  sz: string;
  n: number;
}

export interface IHyperliquidL2Book {
  coin: string;
  levels: [IHyperliquidRawLevel[], IHyperliquidRawLevel[]]; // [bids, asks]
  time: number;
}

// ==================== METADATA ====================

export interface IHyperliquidAssetInfo {
  name: string;
  szDecimals: number;
  maxLeverage: number;
}

export interface IHyperliquidMeta {
  universe: IHyperliquidAssetInfo[];
}

// ==================== ORDERS ====================

export interface IHyperliquidOrderRequest {
  coin: string;
  is_buy: boolean;
  sz: string;
  limit_px: string;
  order_type: { limit: { tif: "Gtc" | "Ioc" | "Alo" } } | { trigger: { triggerPx: string; isMarket: boolean; tpsl: "tp" | "sl" } };
  reduce_only: boolean;
}

export interface IHyperliquidOrderResponse {
  status: "ok" | "err";
  response?: {
    type: "order";
    data: {
      statuses: Array<{ resting?: { oid: number }; filled?: { totalSz: string; avgPx: string }; error?: string }>;
    };
  };
}

// ==================== POSITIONS ====================

export interface IHyperliquidPosition {
  coin: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  leverage: { type: string; value: number };
  szi: string; // signed size (negative = short)
  liquidationPx: string | null;
}

export interface IHyperliquidUserState {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
  };
  assetPositions: Array<{
    position: IHyperliquidPosition;
    type: string;
  }>;
}

// ==================== WEBSOCKET ====================

export interface IHyperliquidWsMessage {
  channel: string;
  data: any;
}

export interface IHyperliquidWsSubscription {
  method: "subscribe" | "unsubscribe";
  subscription: {
    type: "l2Book" | "trades" | "allMids" | "userEvents";
    coin?: string;
    user?: string;
  };
}

// Target coins for HL perp trading (12 max to avoid 429 rate limiting)
export const HYPERLIQUID_COINS = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "AVAX",
  "LINK", "SUI", "NEAR", "APT", "ARB", "OP",
] as const;
export type HyperliquidCoin = (typeof HYPERLIQUID_COINS)[number];
