import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import { env } from "../config/environment";
import { logger } from "../utils/logger";
import bs58 from "bs58";
import { USDC_MINT_ADDRESS } from "../utils/constants";

export class WalletService {
  private wallet: Keypair;
  private connection: Connection;

  constructor() {
    this.wallet = this.loadWalletFromPrivateKey(env.solanaPrivateKey);
    this.connection = new Connection(env.solanaRpcUrl);
  }

  private loadWalletFromPrivateKey(privateKeyString: string): Keypair {
    try {
      // First try to decode as base58
      try {
        const decodedKey = bs58.decode(privateKeyString);
        return Keypair.fromSecretKey(decodedKey);
      } catch {
        // If base58 fails, try comma-separated format
        const privateKeyArray = new Uint8Array(
          privateKeyString.split(",").map((num) => parseInt(num.trim()))
        );
        return Keypair.fromSecretKey(privateKeyArray);
      }
    } catch (error) {
      logger.error("Failed to load wallet from private key", error);
      throw new Error(
        "Invalid private key format. Must be either base58 or comma-separated numbers"
      );
    }
  }

  public getPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  public getWallet(): Keypair {
    return this.wallet;
  }

  public async getSolBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.getPublicKey());
    return balance / LAMPORTS_PER_SOL;
  }

  public async getUsdcBalance(): Promise<number> {
    try {
      // Get all token accounts for the wallet
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.getPublicKey(),
        {
          mint: new PublicKey(USDC_MINT_ADDRESS),
        }
      );

      if (tokenAccounts.value.length === 0) {
        return 0;
      }

      // Get the balance of the first USDC token account
      const balance = await this.connection.getTokenAccountBalance(
        tokenAccounts.value[0].pubkey
      );

      // USDC has 6 decimal places
      return (
        Number(balance.value.amount) / Math.pow(10, balance.value.decimals)
      );
    } catch (error) {
      logger.error("Failed to get USDC balance", error);
      return 0;
    }
  }

  public async executeSwap(swapTransaction: string) {
    // Deserialize transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, "base64");
    let transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    const { blockhash, lastValidBlockHeight } =
      await this.connection!.getLatestBlockhash();

    transaction.sign([this.wallet]);
    const signature = await this.connection.sendRawTransaction(
      transaction.serialize(),
      {
        skipPreflight: true,
        maxRetries: 2,
      }
    );
    console.log("signature", signature);
    let confirmed = false;
    let retries = 0;
    const MAX_RETRIES = 3;
    while (!confirmed && retries < MAX_RETRIES) {
      const statuses = await this.connection.getSignatureStatuses([signature]);
      const status = statuses && statuses.value && statuses.value[0];

      if (
        status &&
        (status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized")
      ) {
        console.log("Transaction confirmed!");
        confirmed = true;
      }

      // Check if the blockhash has expired
      const currentBlockHeight = await this.connection.getBlockHeight();
      if (currentBlockHeight > lastValidBlockHeight) {
        break;
      }

      // Wait for a short period before polling again
      await new Promise((resolve) => setTimeout(resolve, 2000));
      retries++;
    }
    if (!confirmed) {
      throw new Error("Transaction failed");
    }
    return signature;
  }
}
