import mongoose, { Schema, Document } from "mongoose";

export interface IPairRelationDoc extends Document {
  tokenA: string;
  tokenB: string;
  cointegrationPValue: number;
  halfLife: number;
  currentSpread: number;
  meanSpread: number;
  stdSpread: number;
  zScore: number;
  hedgeRatio: number;
  active: boolean;
  lastUpdated: Date;
}

const PairRelationSchema: Schema = new Schema({
  tokenA: { type: String, required: true },
  tokenB: { type: String, required: true },
  cointegrationPValue: { type: Number, required: true },
  halfLife: { type: Number, required: true },
  currentSpread: { type: Number, default: 0 },
  meanSpread: { type: Number, default: 0 },
  stdSpread: { type: Number, default: 0 },
  zScore: { type: Number, default: 0 },
  hedgeRatio: { type: Number, default: 1 },
  active: { type: Boolean, default: true },
  lastUpdated: { type: Date, default: Date.now },
});

PairRelationSchema.index({ tokenA: 1, tokenB: 1 }, { unique: true });

export const PairRelationModel = mongoose.model<IPairRelationDoc>(
  "PairRelation",
  PairRelationSchema
);
