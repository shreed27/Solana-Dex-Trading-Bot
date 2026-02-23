import { TokenService } from "./TokenService";
import { PositionService } from "./PositionService";
import { TokenSwap } from "./TokenSwap";
import { logger } from "../utils/logger";
import { SwapService } from "./SwapService";
import { WalletService } from "./WalletService";

const usdAmountPerToken = 25; // $30 per token
export class BuyStrategyService {
  static walletService = new WalletService();
  static async run(owner: string) {
    // 1. Get tokens from DB with required filters
    const tokens = await TokenService.getAllTokens(
      {
        liquidity: { $gt: 20000 },
        mcap: { $gt: 40000, $lt: 5000000 },
        timestamp: { $gt: new Date(Date.now() - 1000 * 60 * 60 * 24) }, // 24 hours ago
      },
      20
    );

    if (tokens.length === 0) {
      logger.info("No eligible tokens found to buy");
      return;
    }

    logger.info(`Eligible tokens for buying: ${tokens.length}`);

    let openPositions = 0;
    const maxPositions = 3;

    for (const token of tokens) {
      if (openPositions >= maxPositions) break;

      const usdcBalance =
        await BuyStrategyService.walletService.getUsdcBalance();
      console.log("usdcBalance", usdcBalance);
      if (usdcBalance < usdAmountPerToken) {
        logger.info("Not enough USDC balance to buy token");
        continue;
      }
      // Check if already have a position in this token
      const position = await PositionService.getOpenPositions();
      if (position.find((p) => p.tokenAddress === token.address)) continue;
      // Buy logic
      const priceData = await new SwapService().getTokenPrice([token.address]);
      console.log("priceData for token", priceData);
      const currentPrice = priceData?.prices?.[token.address];
      if (!currentPrice) continue;
      const tokenAmount = Math.floor(usdAmountPerToken * 10 ** 6);
      logger.info(
        `Buying ${usdAmountPerToken} of ${token.symbol} (${token.address})`
      );

      await TokenSwap.buyToken(owner, tokenAmount, {
        name: token.name || token.symbol,
        symbol: token.symbol,
        decimals: token.decimals || 6,
        logoURI: token.logoURI || "",
        mcap: token.mcap || 0,
        address: token.address,
        price: currentPrice,
      });
      openPositions++;
    }
    logger.info(
      `Buy strategy completed. Opened ${openPositions} new positions.`
    );
  }
}
