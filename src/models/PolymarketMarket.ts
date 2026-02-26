import mongoose, { Schema, Document } from "mongoose";

export interface IPolymarketMarketDoc extends Document {
  conditionId: string;
  asset: string;
  interval: string;
  yesTokenId: string;
  noTokenId: string;
  question: string;
  startTime: Date;
  endTime: Date;
  startPrice?: number;
  endPrice?: number;
  resolved: boolean;
  outcome?: "UP" | "DOWN";
  liquidity: number;
  volume: number;
  lastYesPrice: number;
  lastNoPrice: number;
  updatedAt: Date;
}

const PolymarketMarketSchema: Schema = new Schema({
  conditionId: { type: String, required: true, unique: true },
  asset: { type: String, required: true },
  interval: { type: String, required: true },
  yesTokenId: { type: String, required: true },
  noTokenId: { type: String, required: true },
  question: { type: String, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date, required: true },
  startPrice: { type: Number },
  endPrice: { type: Number },
  resolved: { type: Boolean, default: false },
  outcome: { type: String, enum: ["UP", "DOWN"] },
  liquidity: { type: Number, default: 0 },
  volume: { type: Number, default: 0 },
  lastYesPrice: { type: Number, default: 0.5 },
  lastNoPrice: { type: Number, default: 0.5 },
  updatedAt: { type: Date, default: Date.now },
});

PolymarketMarketSchema.index({ asset: 1, interval: 1, resolved: 1 });

export const PolymarketMarketModel =
  mongoose.model<IPolymarketMarketDoc>(
    "PolymarketMarket",
    PolymarketMarketSchema
  );
