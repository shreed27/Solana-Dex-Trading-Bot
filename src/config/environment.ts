import { config } from "dotenv";

// Load environment variables from .env file
config();

interface EnvironmentConfig {
  botMode: string;
  mongoUri: string;
  // Polymarket config
  polygonPrivateKey?: string;
  polymarketApiKey?: string;
  polymarketApiSecret?: string;
  polymarketPassphrase?: string;
  // Solana config (legacy)
  solanaPrivateKey?: string;
  solanaRpcUrl?: string;
  // Optional: External API keys
  heliusApiKey?: string;
  twitterBearerToken?: string;
  discordBotToken?: string;
  discordChannelIds?: string;
  jitoBlockEngineUrl?: string;
  onnxModelPath?: string;
}

function validateEnvironment(): EnvironmentConfig {
  const mongoUri = process.env.MONGODB_URI;
  const botMode = process.env.BOT_MODE || "polymarket";

  if (!mongoUri) {
    throw new Error("MONGODB_URI is not set in environment variables");
  }

  // Validate mode-specific requirements
  if (botMode === "solana") {
    if (!process.env.SOLANA_PRIVATE_KEY) {
      throw new Error("SOLANA_PRIVATE_KEY is required for Solana mode");
    }
    if (!process.env.SOLANA_RPC_URL) {
      throw new Error("SOLANA_RPC_URL is required for Solana mode");
    }
  }

  return {
    botMode,
    mongoUri,
    // Polymarket
    polygonPrivateKey: process.env.POLYGON_PRIVATE_KEY,
    polymarketApiKey: process.env.POLYMARKET_API_KEY,
    polymarketApiSecret: process.env.POLYMARKET_API_SECRET,
    polymarketPassphrase: process.env.POLYMARKET_PASSPHRASE,
    // Solana (legacy)
    solanaPrivateKey: process.env.SOLANA_PRIVATE_KEY,
    solanaRpcUrl: process.env.SOLANA_RPC_URL,
    // Optional keys
    heliusApiKey: process.env.HELIUS_API_KEY,
    twitterBearerToken: process.env.TWITTER_BEARER_TOKEN,
    discordBotToken: process.env.DISCORD_BOT_TOKEN,
    discordChannelIds: process.env.DISCORD_CHANNEL_IDS,
    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL,
    onnxModelPath: process.env.ONNX_MODEL_PATH,
  };
}

export const env = validateEnvironment();
