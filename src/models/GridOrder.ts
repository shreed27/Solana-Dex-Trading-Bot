import mongoose, { Schema, Document } from "mongoose";

export interface IGridOrder extends Document {
  gridId: string;
  tokenAddress: string;
  level: number;
  buyPrice: number;
  sellPrice: number;
  amount: number;
  status: "pending" | "bought" | "sold" | "cancelled";
  buySignature?: string;
  sellSignature?: string;
  createdAt: Date;
  updatedAt: Date;
}

const GridOrderSchema: Schema = new Schema(
  {
    gridId: { type: String, required: true, index: true },
    tokenAddress: { type: String, required: true },
    level: { type: Number, required: true },
    buyPrice: { type: Number, required: true },
    sellPrice: { type: Number, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "bought", "sold", "cancelled"],
      default: "pending",
    },
    buySignature: { type: String },
    sellSignature: { type: String },
  },
  { timestamps: true }
);

GridOrderSchema.index({ gridId: 1, level: 1 }, { unique: true });

export const GridOrder = mongoose.model<IGridOrder>(
  "GridOrder",
  GridOrderSchema
);
