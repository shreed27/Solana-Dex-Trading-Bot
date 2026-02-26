import mongoose, { Schema, Document } from "mongoose";

export interface IPolymarketPositionDoc extends Document {
  marketId: string;
  conditionId: string;
  asset: string;
  interval: string;
  direction: "YES" | "NO";
  tokenId: string;
  entryPrice: number;
  size: number;
  shares: number;
  marketStartTime: Date;
  marketEndTime: Date;
  resolved: boolean;
  outcome?: "UP" | "DOWN";
  pnl?: number;
  entrySignals: {
    strategyId: string;
    confidence: number;
    timestamp: Date;
  }[];
  compositeScore: number;
  openedAt: Date;
  closedAt?: Date;
  orderId?: string;
  exitOrderId?: string;
  exitPrice?: number;
  status: "open" | "closed" | "resolved";
}

const PolymarketPositionSchema: Schema = new Schema({
  marketId: { type: String, required: true },
  conditionId: { type: String, required: true },
  asset: { type: String, required: true },
  interval: { type: String, required: true },
  direction: { type: String, enum: ["YES", "NO"], required: true },
  tokenId: { type: String, required: true },
  entryPrice: { type: Number, required: true },
  size: { type: Number, required: true },
  shares: { type: Number, required: true },
  marketStartTime: { type: Date, required: true },
  marketEndTime: { type: Date, required: true },
  resolved: { type: Boolean, default: false },
  outcome: { type: String, enum: ["UP", "DOWN"] },
  pnl: { type: Number },
  entrySignals: [
    {
      strategyId: { type: String },
      confidence: { type: Number },
      timestamp: { type: Date },
    },
  ],
  compositeScore: { type: Number, required: true },
  openedAt: { type: Date, default: Date.now },
  closedAt: { type: Date },
  orderId: { type: String },
  exitOrderId: { type: String },
  exitPrice: { type: Number },
  status: {
    type: String,
    enum: ["open", "closed", "resolved"],
    default: "open",
  },
});

PolymarketPositionSchema.index({ status: 1, asset: 1 });
PolymarketPositionSchema.index({ conditionId: 1 });

export const PolymarketPositionModel =
  mongoose.model<IPolymarketPositionDoc>(
    "PolymarketPosition",
    PolymarketPositionSchema
  );
