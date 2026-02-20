import mongoose from "mongoose";
import { env } from "./environment";

export const connectToDatabase = async () => {
  try {
    await mongoose.connect(env.mongoUri);
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};
