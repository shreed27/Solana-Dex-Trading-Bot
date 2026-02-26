import mongoose, { Schema, Document } from "mongoose";

export interface IWhaleWallet extends Document {
  address: string;
  label?: string;
  profitFactor: number;
  winRate: number;
  totalTrades: number;
  totalPnlUsd: number;
  active: boolean;
  lastTradeAt?: Date;
  trackedSince: Date;
}

const WhaleWalletSchema: Schema = new Schema({
  address: { type: String, required: true, unique: true },
  label: { type: String },
  profitFactor: { type: Number, default: 1.0 },
  winRate: { type: Number, default: 0.5 },
  totalTrades: { type: Number, default: 0 },
  totalPnlUsd: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
  lastTradeAt: { type: Date },
  trackedSince: { type: Date, default: Date.now },
});

export const WhaleWallet = mongoose.model<IWhaleWallet>(
  "WhaleWallet",
  WhaleWalletSchema
);
