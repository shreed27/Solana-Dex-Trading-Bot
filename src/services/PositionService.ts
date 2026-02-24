import { Position, IPosition } from "../models/Position";
import { TokenSwap } from "./TokenSwap";
import { SwapService } from "./SwapService";

export class PositionService {
  static async openPosition(
    positionData: Partial<IPosition>
  ): Promise<IPosition> {
    const position = new Position({
      ...positionData,
      status: "open",
      openTimestamp: new Date(),
    });
    return await position.save();
  }

  static async closePosition(
    positionId: string,
    realizedPnl: number,
    lastPrice: number,
    signature: string
  ): Promise<IPosition | null> {
    const position = await Position.findById(positionId);
    if (!position) return null;
    return Position.findByIdAndUpdate(
      positionId,
      {
        status: "closed",
        closeTimestamp: new Date(),
        realizedPnl,
        lastPrice,
        // push signature to the array
        signature: [...(position.signature || []), signature],
      },
      { new: true }
    ).exec();
  }

  static async updatePosition(
    positionId: string,
    update: Partial<IPosition>
  ): Promise<IPosition | null> {
    return Position.findByIdAndUpdate(positionId, update, { new: true }).exec();
  }

  static async getOpenPositions(): Promise<IPosition[]> {
    return Position.find({ status: "open" }).sort({ openTimestamp: -1 }).exec();
  }

  static calculatePnL(avgBuyPrice: number, currentPrice: number): number {
    return ((currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
  }

  /**
   * This method is intended to be run as a cron job to check all open positions,
   * calculate PnL, and trigger a sell if PnL > 30% or < -25%.
   */
  static async checkAndHandlePnL(
    owner: string,
    inputAccount: string,
    outputAccount: string
  ) {
    const openPositions = await this.getOpenPositions();
    for (const pos of openPositions) {
      // Fetch current price (assume USDC output)
      const priceData = await new SwapService().getTokenPrice([
        pos.tokenAddress,
      ]);
      const currentPrice = priceData?.prices?.[pos.tokenAddress];
      if (!currentPrice) continue;
      const pnl = this.calculatePnL(pos.avgBuyPrice, currentPrice);
      if (pnl > 30) {
        // Sell all
        await TokenSwap.sellToken(
          owner,
          inputAccount,
          outputAccount,
          pos.amount,
          String(pos._id),
          { ...pos.tokenInfo, address: pos.tokenAddress },
          pos.avgBuyPrice
        );
      } else if (pnl < -25) {
        // Sell all
        await TokenSwap.sellToken(
          owner,
          inputAccount,
          outputAccount,
          pos.amount,
          String(pos._id),
          { ...pos.tokenInfo, address: pos.tokenAddress },
          pos.avgBuyPrice
        );
      }
    }
  }
}
