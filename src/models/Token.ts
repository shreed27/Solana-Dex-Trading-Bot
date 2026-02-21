import mongoose, { Schema, Document } from "mongoose";

export interface IToken extends Document {
  symbol: string;
  address: string;
  price: number;
  volume24h: number;
  age: string;
  priceChange1h: string;
  timestamp: Date;
  name?: string;
  decimals?: number;
  logoURI?: string;
  mcap?: number;
  liquidity?: number;
  createdAt?: Date;
}

const TokenSchema: Schema = new Schema({
  symbol: { type: String, required: true },
  address: { type: String, required: true, unique: true },
  price: { type: Number, required: true },
  volume24h: { type: Number, required: true },
  age: { type: String, required: true },
  priceChange1h: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  name: { type: String },
  decimals: { type: Number },
  logoURI: { type: String },
  mcap: { type: Number },
  liquidity: { type: Number },
  createdAt: { type: Date },
});

export const Token = mongoose.model<IToken>("Token", TokenSchema);
