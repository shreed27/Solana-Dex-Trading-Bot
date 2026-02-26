import { logger } from "../utils/logger";
import { IMLPrediction } from "../types/risk.types";
import { IOHLCV } from "../types/market.types";

// Dynamic import for onnxruntime-node (optional dependency)
let ort: any = null;

export class OnnxRuntime {
  private session: any = null;
  private modelPath: string;
  private modelVersion: string = "1.0.0";

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  async initialize(): Promise<boolean> {
    try {
      ort = await import("onnxruntime-node");
      this.session = await ort.InferenceSession.create(this.modelPath);
      logger.success(`ONNX model loaded from ${this.modelPath}`);
      return true;
    } catch (err) {
      logger.warning(
        `ONNX runtime not available or model not found at ${this.modelPath}. ML strategy will be disabled.`
      );
      return false;
    }
  }

  isReady(): boolean {
    return this.session !== null;
  }

  /**
   * Run prediction on OHLCV candle data.
   * Input: last N candles (default 30)
   * Output: predicted price change % and confidence
   */
  async predict(candles: IOHLCV[]): Promise<IMLPrediction | null> {
    if (!this.session || !ort) return null;

    try {
      // Normalize features
      const features = this.prepareFeatures(candles);
      const sequenceLength = candles.length;
      const featureCount = 5; // OHLCV

      // Create input tensor [batch=1, sequence, features]
      const inputTensor = new ort.Tensor(
        "float32",
        new Float32Array(features),
        [1, sequenceLength, featureCount]
      );

      // Run inference
      const results = await this.session.run({ input: inputTensor });
      const output = results.output?.data as Float32Array;

      if (!output || output.length < 2) return null;

      return {
        tokenAddress: "", // Set by caller
        predictedChange: output[0],
        confidence: Math.min(1.0, Math.max(0, output[1])),
        horizon: "2-3 candles",
        modelVersion: this.modelVersion,
        timestamp: new Date(),
      };
    } catch (err) {
      logger.error("ONNX inference error:", err);
      return null;
    }
  }

  /**
   * Prepare normalized feature matrix from OHLCV candles.
   * Normalizes using min-max scaling.
   */
  private prepareFeatures(candles: IOHLCV[]): number[] {
    if (candles.length === 0) return [];

    // Extract raw values
    const opens = candles.map((c) => c.open);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    // Min-max normalize each feature
    const normalize = (values: number[]): number[] => {
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;
      if (range === 0) return values.map(() => 0.5);
      return values.map((v) => (v - min) / range);
    };

    const normOpens = normalize(opens);
    const normHighs = normalize(highs);
    const normLows = normalize(lows);
    const normCloses = normalize(closes);
    const normVolumes = normalize(volumes);

    // Interleave: [o1, h1, l1, c1, v1, o2, h2, l2, c2, v2, ...]
    const features: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      features.push(
        normOpens[i],
        normHighs[i],
        normLows[i],
        normCloses[i],
        normVolumes[i]
      );
    }
    return features;
  }

  async shutdown(): Promise<void> {
    this.session = null;
  }
}
