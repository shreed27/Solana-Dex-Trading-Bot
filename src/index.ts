import { DexScreenerClient } from "./services/DexScreenerClient";
import { WalletService } from "./services/WalletService";
import { logger } from "./utils/logger";
import { connectToDatabase } from "./config/mongoose";
import cron from "node-cron";
import { BuyStrategyService } from "./services/BuyStrategyService";
import { PositionService } from "./services/PositionService";
import { USDC_MINT_ADDRESS } from "./utils/constants";

async function main() {
  let dexScreener: DexScreenerClient | null = null;
  const walletService = new WalletService();
  const owner = walletService.getPublicKey().toString();

  (async () => {
    await connectToDatabase();

    // Schedule buy strategy to run every 2 minutes
    cron.schedule("*/1 * * * *", async () => {
      try {
        await BuyStrategyService.run(owner);
      } catch (err) {
        console.error("Buy strategy error:", err);
      }
    });

    // Schedule sell/exit logic to run every 2 minutes
    cron.schedule("*/2 * * * *", async () => {
      try {
        const openPositions = await PositionService.getOpenPositions();
        if (openPositions.length === 0) return;
        for (const pos of openPositions) {
          // Run PnL check and handle sell/exit for each position
          await PositionService.checkAndHandlePnL(
            owner,
            pos.tokenAddress,
            USDC_MINT_ADDRESS
          );
        }
      } catch (err) {
        console.error("PnL check error:", err);
      }
    });

    // Initialize wallet
    logger.success(`Wallet loaded: ${owner}`);
    const solBalance = await walletService.getSolBalance();
    const usdcBalance = await walletService.getUsdcBalance();
    logger.info(`My Sol balance: ${solBalance}`);
    logger.info(`My USDC balance: ${usdcBalance}`);

    // Initialize and connect to DexScreener
    dexScreener = new DexScreenerClient();
    await dexScreener.connect();
    process.on("SIGINT", async () => {
      logger.info("Shutting down...");
      if (dexScreener) {
        await dexScreener.disconnect();
      }
      process.exit(0);
    });
  })();
}

main();
