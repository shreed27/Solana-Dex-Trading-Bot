import mongoose, { Schema, Document } from "mongoose";

export interface ISignalDoc extends Document {
  strategyId: string;
  tokenAddress: string;
  direction: "BUY" | "SELL" | "NEUTRAL";
  confidence: number;
  weight: number;
  metadata: Record<string, any>;
  expiresAt: Date;
  actedUpon: boolean;
  compositeScoreAtAction?: number;
  createdAt: Date;
}

const SignalSchema: Schema = new Schema({
  strategyId: { type: String, required: true, index: true },
  tokenAddress: { type: String, required: true, index: true },
  direction: { type: String, enum: ["BUY", "SELL", "NEUTRAL"], required: true },
  confidence: { type: Number, required: true },
  weight: { type: Number, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
  expiresAt: { type: Date, required: true },
  actedUpon: { type: Boolean, default: false },
  compositeScoreAtAction: { type: Number },
  createdAt: { type: Date, default: Date.now },
});

// Auto-expire signals after TTL
SignalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SignalModel = mongoose.model<ISignalDoc>("Signal", SignalSchema);
