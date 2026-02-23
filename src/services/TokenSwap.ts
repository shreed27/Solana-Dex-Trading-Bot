import { SwapService } from "./SwapService";
import { UltraSwapRequest, UltraSwapResponse } from "../types/types";
import { PositionService } from "./PositionService";
import { USDC_MINT_ADDRESS } from "../utils/constants";
import { logger } from "../utils/logger";
import { WalletService } from "./WalletService";

const USDC_MINT = USDC_MINT_ADDRESS;

const walletService = new WalletService();
export class TokenSwap {
  static async buyToken(
    owner: string,
    amount: number,
    tokenInfo: {
      name: string;
      symbol: string;
      decimals: number;
      logoURI: string;
      mcap: number;
      address: string;
      price: number;
    }
  ) {
    const inputMint = USDC_MINT;
    const outputMint = tokenInfo.address;
    const taker = owner;
    const swapMode = "ExactIn";
    const tokenAmount = Math.floor(Number(amount));
    const ultraSwapRequest: UltraSwapRequest = {
      inputMint,
      outputMint,
      amount: tokenAmount.toString(),
      taker,
      swapMode,
    };

    const ultraSwapResponse: UltraSwapResponse | null =
      await SwapService.getUltraSwap(ultraSwapRequest);

    if (ultraSwapResponse?.errorMessage || !ultraSwapResponse?.transaction) {
      logger.error(
        "Error swapping tokens",
        ultraSwapResponse?.errorMessage || "No transaction"
      );
      return;
    }

    const signature = await walletService.executeSwap(
      ultraSwapResponse.transaction
    );
    console.log("signature", signature);
    if (signature) {
      // Open a position
      await PositionService.openPosition({
        tokenAddress: outputMint,
        tokenInfo: {
          name: tokenInfo.name,
          symbol: tokenInfo.symbol,
          decimals: tokenInfo.decimals,
          logoURI: tokenInfo.logoURI,
          mcap: tokenInfo.mcap,
        },
        amount: Number(ultraSwapResponse.outAmount) / 10 ** tokenInfo.decimals,
        avgBuyPrice: tokenInfo.price,
        totalBuyAmount: tokenInfo.price * Number(ultraSwapResponse.outAmount),
        status: "open",
        openTimestamp: new Date(),
        signature: [signature],
      });
    }
    // return ultraSwapResponse;
  }

  static async sellToken(
    owner: string,
    inputAccount: string,
    outputAccount: string,
    amount: number,
    positionId: string,
    tokenInfo: {
      name: string;
      symbol: string;
      decimals: number;
      logoURI: string;
      mcap: number;
      address: string;
    },
    avgBuyPrice: number
  ) {
    const inputMint = tokenInfo.address;
    const outputMint = USDC_MINT;
    const taker = owner;
    const swapMode = "ExactIn";
    const ultraSwapRequest: UltraSwapRequest = {
      inputMint,
      outputMint,
      amount: amount.toString(),
      taker,
      swapMode,
    };
    const ultraSwapResponse: UltraSwapResponse | null =
      await SwapService.getUltraSwap(ultraSwapRequest);
    if (ultraSwapResponse?.errorMessage || !ultraSwapResponse?.transaction) {
      logger.error(
        "Error swapping tokens",
        ultraSwapResponse?.errorMessage || "No transaction"
      );
      return;
    }

    // Calculate PnL
    const sellPrice =
      ultraSwapResponse.outUsdValue /
      Number(ultraSwapResponse.inAmount) /
      10 ** tokenInfo.decimals;
    const pnl = PositionService.calculatePnL(avgBuyPrice, sellPrice);
    // Close the position

    const signature = await walletService.executeSwap(
      ultraSwapResponse.transaction
    );

    console.log("signature", signature);

    if (signature) {
      await PositionService.closePosition(
        positionId,
        pnl,
        sellPrice,
        signature
      );
    }

    return ultraSwapResponse;
  }
}
