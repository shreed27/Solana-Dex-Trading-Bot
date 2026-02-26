import { PolymarketOrchestrator } from "./polymarket/PolymarketOrchestrator";
import { logger } from "./utils/logger";

async function main() {
  const mode = process.env.BOT_MODE || "polymarket";

  if (mode === "polymarket") {
    const orchestrator = new PolymarketOrchestrator();

    try {
      await orchestrator.start();
      logger.success(
        "Polymarket trading bot started (BTC/ETH/XRP 5M/15M)"
      );
    } catch (err) {
      logger.error("Failed to start Polymarket bot", err);
      process.exit(1);
    }

    process.on("SIGINT", async () => {
      logger.info("Shutting down...");
      await orchestrator.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM, shutting down...");
      await orchestrator.shutdown();
      process.exit(0);
    });
  } else {
    // Legacy Solana DEX mode
    const { Orchestrator } = await import("./engine/Orchestrator");
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      logger.success("Solana DEX trading bot started with all 15 strategies");
    } catch (err) {
      logger.error("Failed to start trading bot", err);
      process.exit(1);
    }

    process.on("SIGINT", async () => {
      logger.info("Shutting down...");
      await orchestrator.shutdown();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM, shutting down...");
      await orchestrator.shutdown();
      process.exit(0);
    });
  }
}

main();
