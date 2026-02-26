export enum SignalDirection {
  BUY = "BUY",
  SELL = "SELL",
  NEUTRAL = "NEUTRAL",
}

export enum StrategyCategory {
  SIGNAL = "signal",
  AUTONOMOUS = "autonomous",
  RISK = "risk",
  EXECUTION = "execution",
}

export enum StrategyTier {
  FAST = "fast", // Every tick / <5s (orderbook, pool sniper)
  NORMAL = "normal", // Every 1-2 min (MACD, volume, whale)
  SLOW = "slow", // Every 5-15 min (sentiment, ML, cointegration)
}

export interface ISignal {
  strategyId: string;
  tokenAddress: string;
  direction: SignalDirection;
  confidence: number; // 0.0 to 1.0
  weight: number; // from StrategyConfig
  metadata: Record<string, any>;
  timestamp: Date;
  expiresAt: Date;
}

export interface IAggregatedSignal {
  tokenAddress: string;
  direction: SignalDirection;
  compositeScore: number;
  contributingSignals: ISignal[];
  requiredConfidence: number;
  passedRiskGate: boolean;
  riskScore?: number;
  timestamp: Date;
}

export interface IStrategyResult {
  strategyId: string;
  signals: ISignal[];
  executionTimeMs: number;
  error?: string;
}

export interface IStrategyConfig {
  id: string;
  name: string;
  category: StrategyCategory;
  tier: StrategyTier;
  enabled: boolean;
  weight: number;
  intervalMs: number;
  params: Record<string, any>;
  circuitBreakerThreshold: number;
}

export interface IRiskAssessment {
  tokenAddress: string;
  overallScore: number; // 0-100
  isHoneypot: boolean;
  isRugPull: boolean;
  hasLiquidityLock: boolean;
  ownerConcentration: number;
  mintAuthority: boolean;
  freezeAuthority: boolean;
  flags: string[];
  timestamp: Date;
}

export interface IExitStrategy {
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct?: number;
  trailingStopActivatedAt?: number;
  timeoutMinutes?: number;
}

export interface IEntrySignal {
  strategyId: string;
  confidence: number;
  direction: SignalDirection;
  timestamp: Date;
}

export interface IExitSignal {
  strategyId: string;
  confidence: number;
  reason: string;
  timestamp: Date;
}
