// ==================== KALSHI MARKET TYPES ====================

export interface IKalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  mutually_exclusive: boolean;
  markets: IKalshiMarket[];
}

export interface IKalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  yes_bid: number;    // 1-99 cents
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  status: "open" | "closed" | "settled";
  close_time: string; // ISO datetime
  result: string;
  floor_strike?: number;
  cap_strike?: number;
}

export interface IKalshiBookLevel {
  price: number;   // 1-99 cents
  quantity: number; // number of contracts
}

export interface IKalshiOrderbook {
  ticker: string;
  yes: IKalshiBookLevel[];
  no: IKalshiBookLevel[];
  timestamp: number;
}

export interface IKalshiOrder {
  order_id: string;
  ticker: string;
  side: "yes" | "no";
  type: "market" | "limit";
  yes_price: number;
  no_price: number;
  count: number;
  status: "resting" | "canceled" | "executed" | "pending";
  created_time: string;
}

export interface IKalshiPosition {
  ticker: string;
  market_exposure: number;
  resting_orders_count: number;
  position: number; // positive = long yes, negative = long no
  total_traded: number;
}

// Kalshi crypto series identifiers
export const KALSHI_CRYPTO_SERIES: Record<string, string> = {
  BTC: "KXBTC",
  ETH: "KXETH",
  SOL: "KXSOL",
};
