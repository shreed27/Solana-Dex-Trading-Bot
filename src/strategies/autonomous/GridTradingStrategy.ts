import { BaseStrategy } from "../BaseStrategy";
import { IAutonomousStrategy } from "../IStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { GridOrder, IGridOrder } from "../../models/GridOrder";
import { SwapService } from "../../services/SwapService";
import { IGridLevel } from "../../types/market.types";
import { logger } from "../../utils/logger";
import { stddev, mean } from "../../utils/mathUtils";
import { v4 as uuidv4 } from "uuid";

export class GridTradingStrategy
  extends BaseStrategy
  implements IAutonomousStrategy
{
  readonly id = "grid-trading-volatility";
  readonly name = "Geometric Grid Trading";
  readonly category = StrategyCategory.AUTONOMOUS;
  readonly tier = StrategyTier.NORMAL;

  private running = false;
  private activeGrids: Map<string, IGridLevel[]> = new Map();

  async start(): Promise<void> {
    this.running = true;

    // Restore any active grids from DB
    const activeOrders = await GridOrder.find({
      status: { $in: ["pending", "bought"] },
    }).exec();

    for (const order of activeOrders) {
      const grid = this.activeGrids.get(order.gridId) || [];
      grid.push({
        level: order.level,
        buyPrice: order.buyPrice,
        sellPrice: order.sellPrice,
        status: order.status as any,
        amount: order.amount,
      });
      this.activeGrids.set(order.gridId, grid);
    }

    logger.info(
      `Grid trading: restored ${this.activeGrids.size} active grids`
    );
    this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    const intervalMs = this.config.params.checkIntervalMs || 10000;

    while (this.running) {
      try {
        // Check each active grid
        for (const [gridId, levels] of this.activeGrids) {
          await this.checkGrid(gridId, levels);
        }

        await new Promise((r) => setTimeout(r, intervalMs));
      } catch (err) {
        logger.error("Grid trading loop error:", err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async checkGrid(
    gridId: string,
    levels: IGridLevel[]
  ): Promise<void> {
    if (levels.length === 0) return;

    // Get the token address from the grid order in DB
    const gridOrder = await GridOrder.findOne({ gridId }).exec();
    if (!gridOrder) return;

    const tokenAddress = gridOrder.tokenAddress;
    const swapService = new SwapService();
    const priceData = await swapService.getTokenPrice([tokenAddress]);
    const currentPrice = priceData?.prices?.[tokenAddress];
    if (!currentPrice) return;

    // Kill switch: check if price has moved too far (extreme deviation)
    const killSwitchStdDev =
      this.config.params.killSwitchStdDev || 3;
    const prices = levels.map((l) => l.buyPrice);
    const priceStdDev = stddev(prices);
    const priceMean = mean(prices);
    if (
      priceStdDev > 0 &&
      Math.abs(currentPrice - priceMean) >
        killSwitchStdDev * priceStdDev
    ) {
      logger.warning(
        `Grid ${gridId}: kill switch activated | price ${currentPrice} is ${killSwitchStdDev}+ std devs from grid mean`
      );
      // Cancel all pending orders
      await GridOrder.updateMany(
        { gridId, status: "pending" },
        { status: "cancelled" }
      );
      this.activeGrids.delete(gridId);
      return;
    }

    for (const level of levels) {
      if (level.status === "pending" && currentPrice <= level.buyPrice) {
        // Price hit buy level
        logger.info(
          `Grid ${gridId}: BUY at level ${level.level} | price: ${currentPrice}`
        );
        level.status = "bought";
        await GridOrder.updateOne(
          { gridId, level: level.level },
          { status: "bought" }
        );
        // Execute buy through ExecutionEngine in production
      } else if (
        level.status === "bought" &&
        currentPrice >= level.sellPrice
      ) {
        // Price hit sell level
        logger.info(
          `Grid ${gridId}: SELL at level ${level.level} | price: ${currentPrice}`
        );
        level.status = "sold";
        await GridOrder.updateOne(
          { gridId, level: level.level },
          { status: "sold" }
        );
        // Execute sell through ExecutionEngine in production
      }
    }
  }

  /**
   * Create a new grid for a token.
   */
  async createGrid(
    tokenAddress: string,
    currentPrice: number,
    investmentUsdc: number
  ): Promise<string> {
    const gridCount = this.config.params.gridCount || 25;
    const upperMult =
      this.config.params.upperBoundMultiplier || 1.5;
    const lowerMult =
      this.config.params.lowerBoundMultiplier || 0.5;

    const upperPrice = currentPrice * upperMult;
    const lowerPrice = currentPrice * lowerMult;
    const gridId = uuidv4();

    // Geometric grid spacing
    const ratio = Math.pow(upperPrice / lowerPrice, 1 / gridCount);
    const amountPerLevel = investmentUsdc / gridCount;
    const levels: IGridLevel[] = [];

    for (let i = 0; i < gridCount; i++) {
      const buyPrice = lowerPrice * Math.pow(ratio, i);
      const sellPrice = buyPrice * ratio;
      levels.push({
        level: i,
        buyPrice,
        sellPrice,
        status: "pending",
        amount: amountPerLevel,
      });

      await GridOrder.create({
        gridId,
        tokenAddress,
        level: i,
        buyPrice,
        sellPrice,
        amount: amountPerLevel,
        status: "pending",
      });
    }

    this.activeGrids.set(gridId, levels);
    logger.success(
      `Grid created: ${gridId} | ${gridCount} levels | ${lowerPrice.toFixed(6)} - ${upperPrice.toFixed(6)}`
    );
    return gridId;
  }

  async getActivePositions(): Promise<any[]> {
    return GridOrder.find({
      status: { $in: ["pending", "bought"] },
    }).exec();
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return { strategyId: this.id, signals: [], executionTimeMs: 0 };
  }
}
