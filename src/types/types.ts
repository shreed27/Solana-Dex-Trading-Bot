export interface UltraSwapRoutePlan {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

export interface UltraSwapPlatformFee {
  amount: string;
  feeBps: number;
}

export interface UltraSwapResponse {
  mode: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: UltraSwapRoutePlan[];
  feeBps: number;
  transaction: string;
  gasless: boolean;
  prioritizationFeeLamports: number;
  requestId: string;
  swapType: string;
  router: string;
  quoteId: string;
  maker: string;
  taker: string;
  expireAt: string;
  platformFee: UltraSwapPlatformFee;
  inUsdValue: number;
  outUsdValue: number;
  priceImpact: number;
  swapUsdValue: number;
  totalTime: number;
  errorMessage?: string;
}

export interface UltraSwapRequest {
  inputMint: string;
  outputMint: string;
  amount: string | number;
  taker: string;
  swapMode: string;
}

export interface Position {
  tokenAddress: string;
  tokenInfo: {
    name: string;
    symbol: string;
    decimals: number;
    logoURI: string;
    mcap: number;
  };
  amount: number;
  avgBuyPrice: number;
  openTimestamp: Date;
  closeTimestamp?: Date;
  status: "open" | "closed";
  realizedPnl?: number;
  lastPrice?: number;
}
