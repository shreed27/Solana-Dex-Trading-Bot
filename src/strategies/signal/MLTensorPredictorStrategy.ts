import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { MarketDataService } from "../../services/MarketDataService";
import { OnnxRuntime } from "../../external/OnnxRuntime";
import { logger } from "../../utils/logger";

export class MLTensorPredictorStrategy extends BaseStrategy {
  readonly id = "ml-tensor-predictor";
  readonly name = "ML LSTM Trajectory Predictor";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.SLOW;

  private marketData = new MarketDataService();
  private onnx: OnnxRuntime | null = null;
  private modelReady = false;

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);

    const modelPath =
      config.params.modelPath || "./models/lstm_price_predictor.onnx";
    this.onnx = new OnnxRuntime(modelPath);
    this.modelReady = await this.onnx.initialize();

    if (!this.modelReady) {
      logger.warning(
        "ML Tensor Predictor: ONNX model not available. Strategy will emit no signals."
      );
    }
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];

      if (!this.modelReady || !this.onnx) {
        return { strategyId: this.id, signals, executionTimeMs: 0 };
      }

      const maxTokens = this.config.params.maxTokens || 10;
      const topTokens = tokens.slice(0, maxTokens);

      for (const token of topTokens) {
        const candles = await this.marketData.getCandles(
          token,
          "1m",
          30
        );
        if (candles.length < 30) continue;

        const prediction = await this.onnx.predict(candles);
        if (!prediction) continue;

        prediction.tokenAddress = token;

        // Only emit signals above confidence threshold
        if (prediction.confidence < 0.6) continue;

        if (prediction.predictedChange > 0.02) {
          // >2% up predicted
          signals.push(
            this.createSignal(
              token,
              SignalDirection.BUY,
              prediction.confidence,
              {
                predictedChange: prediction.predictedChange,
                modelConfidence: prediction.confidence,
                horizon: prediction.horizon,
                modelVersion: prediction.modelVersion,
              },
              10 * 60 * 1000 // 10 min TTL
            )
          );
        } else if (prediction.predictedChange < -0.02) {
          // >2% down predicted
          signals.push(
            this.createSignal(
              token,
              SignalDirection.SELL,
              prediction.confidence,
              {
                predictedChange: prediction.predictedChange,
                modelConfidence: prediction.confidence,
                horizon: prediction.horizon,
                modelVersion: prediction.modelVersion,
              },
              10 * 60 * 1000
            )
          );
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }

  async shutdown(): Promise<void> {
    if (this.onnx) {
      await this.onnx.shutdown();
    }
    await super.shutdown();
  }
}
