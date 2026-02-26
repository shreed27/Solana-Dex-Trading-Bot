export interface IOHLCV {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IOrderbookLevel {
  price: number;
  size: number;
}

export interface IOrderbook {
  tokenAddress: string;
  bids: IOrderbookLevel[];
  asks: IOrderbookLevel[];
  timestamp: Date;
}

export interface IPoolCreationEvent {
  poolAddress: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  lpMint: string;
  initialLiquidity: number;
  timestamp: Date;
  signature: string;
}

export interface IWhaleTransaction {
  walletAddress: string;
  signature: string;
  tokenMint: string;
  direction: "buy" | "sell";
  amountUsd: number;
  timestamp: number;
}

export interface IVestingSchedule {
  tokenAddress: string;
  contractAddress: string;
  totalAmount: number;
  releasedAmount: number;
  nextUnlockTimestamp: number;
  nextUnlockAmount: number;
  recipientAddress: string;
}

export interface IGridLevel {
  level: number;
  buyPrice: number;
  sellPrice: number;
  status: "pending" | "bought" | "sold";
  amount: number;
}

export interface IPairRelation {
  tokenA: string;
  tokenB: string;
  cointegrationPValue: number;
  halfLife: number;
  currentSpread: number;
  meanSpread: number;
  stdSpread: number;
  zScore: number;
  lastUpdated: Date;
}
