import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
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
  signature?: string[];
  totalBuyAmount?: number;
}

const PositionSchema: Schema = new Schema({
  tokenAddress: { type: String, required: true },
  tokenInfo: {
    name: { type: String, required: true },
    symbol: { type: String, required: true },
    decimals: { type: Number, required: true },
    logoURI: { type: String, required: true },
    mcap: { type: Number, required: true },
  },
  amount: { type: Number, required: true },
  avgBuyPrice: { type: Number, required: true },
  openTimestamp: { type: Date, required: true },
  closeTimestamp: { type: Date },
  status: { type: String, enum: ["open", "closed"], required: true },
  realizedPnl: { type: Number },
  lastPrice: { type: Number },
  signature: { type: [String] },
  totalBuyAmount: { type: Number },
});

export const Position = mongoose.model<IPosition>("Position", PositionSchema);
