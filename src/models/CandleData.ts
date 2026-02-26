import mongoose, { Schema, Document } from "mongoose";

export interface ICandleData extends Document {
  tokenAddress: string;
  interval: string; // "1m", "5m", "15m", "1h"
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const CandleDataSchema: Schema = new Schema({
  tokenAddress: { type: String, required: true, index: true },
  interval: { type: String, required: true, index: true },
  timestamp: { type: Date, required: true, index: true },
  open: { type: Number, required: true },
  high: { type: Number, required: true },
  low: { type: Number, required: true },
  close: { type: Number, required: true },
  volume: { type: Number, required: true },
});

CandleDataSchema.index(
  { tokenAddress: 1, interval: 1, timestamp: 1 },
  { unique: true }
);

// Auto-expire candles older than 7 days
CandleDataSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export const CandleData = mongoose.model<ICandleData>(
  "CandleData",
  CandleDataSchema
);
