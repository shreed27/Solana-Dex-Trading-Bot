export interface IContractAnalysis {
  tokenAddress: string;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  topHolderConcentration: number;
  top10HolderConcentration: number;
  isLpLocked: boolean;
  isLpBurned: boolean;
  canSell: boolean;
  totalSupply: number;
  circulatingSupply: number;
  creatorBalance: number;
  creatorBalancePct: number;
  flags: string[];
}

export interface ISentimentScore {
  tokenAddress: string;
  symbol: string;
  twitterScore: number; // 0-1
  discordScore: number; // 0-1
  blendedScore: number; // 0-1
  tweetCount: number;
  messageCount: number;
  timestamp: Date;
}

export interface IMLPrediction {
  tokenAddress: string;
  predictedChange: number; // percentage
  confidence: number; // 0-1
  horizon: string; // e.g., "2-3 candles"
  modelVersion: string;
  timestamp: Date;
}

export interface ICircuitBreakerState {
  strategyId: string;
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  lastFailureAt?: Date;
  lastSuccessAt?: Date;
  cooldownUntil?: Date;
}
