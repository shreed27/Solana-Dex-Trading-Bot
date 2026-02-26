export type PolymarketAsset = "BTC" | "ETH" | "XRP";
export type PolymarketInterval = "5M" | "15M";
export type PolymarketOutcome = "UP" | "DOWN";
export type PolymarketDirection = "YES" | "NO";
export type PolymarketOrderType = "GTC" | "GTD" | "FOK" | "FAK";

export interface IPolymarketMarket {
  conditionId: string;
  asset: PolymarketAsset;
  interval: PolymarketInterval;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  startTime: Date;
  endTime: Date;
  yesPrice: number;
  noPrice: number;
  liquidity: number;
  volume: number;
  resolved: boolean;
  outcome?: PolymarketOutcome;
}

export interface IPolymarketOrder {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  orderType: PolymarketOrderType;
  expiration?: number; // UTC seconds for GTD
}

export interface IPolymarketOrderResponse {
  success: boolean;
  orderID?: string;
  status?: "live" | "matched" | "delayed" | "unmatched";
  errorMsg?: string;
}

export interface IPolymarketPosition {
  id?: string;
  marketId: string;
  conditionId: string;
  asset: PolymarketAsset;
  interval: PolymarketInterval;
  direction: PolymarketDirection;
  tokenId: string;
  entryPrice: number;
  size: number; // USDC spent
  shares: number; // tokens received
  marketStartTime: Date;
  marketEndTime: Date;
  resolved: boolean;
  outcome?: PolymarketOutcome;
  pnl?: number;
  entrySignals: {
    strategyId: string;
    confidence: number;
    timestamp: Date;
  }[];
  compositeScore: number;
  openedAt: Date;
  closedAt?: Date;
}

export interface IPolymarketBookLevel {
  price: string;
  size: string;
}

export interface IPolymarketOrderbook {
  market: string;
  asset_id: string;
  bids: IPolymarketBookLevel[];
  asks: IPolymarketBookLevel[];
  timestamp: number;
}

export interface IPolymarketRiskCheck {
  allowed: boolean;
  reason?: string;
  liquidity: number;
  spread: number;
  timeToResolution: number; // seconds
  currentExposure: number;
  maxExposure: number;
  suggestedSize: number;
}

export interface IPolymarketTradeResult {
  success: boolean;
  orderId?: string;
  asset: PolymarketAsset;
  direction: PolymarketDirection;
  entryPrice: number;
  size: number;
  shares: number;
  compositeScore: number;
  strategies: string[];
  error?: string;
}
