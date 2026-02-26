import { BaseStrategy } from "../BaseStrategy";
import {
  IStrategyConfig,
  IStrategyResult,
  ISignal,
  SignalDirection,
  StrategyCategory,
  StrategyTier,
} from "../../types/strategy.types";
import { TwitterClient, Tweet } from "../../external/TwitterClient";
import { DiscordClient, DiscordMessage } from "../../external/DiscordClient";
import { Token } from "../../models/Token";
import { logger } from "../../utils/logger";

// Simple keyword-based sentiment scoring
const BULLISH_WORDS = [
  "moon", "pump", "bullish", "buy", "long", "gem", "100x",
  "launch", "breakout", "lfg", "send", "rocket", "diamond",
  "alpha", "undervalued", "accumulate", "strong",
];
const BEARISH_WORDS = [
  "dump", "bearish", "sell", "short", "scam", "rug", "dead",
  "crash", "exit", "avoid", "honeypot", "hack", "exploit",
  "overvalued", "weak", "rekt",
];

export class SentimentAnalysisStrategy extends BaseStrategy {
  readonly id = "sentiment-analysis";
  readonly name = "NLP Sentiment Analysis";
  readonly category = StrategyCategory.SIGNAL;
  readonly tier = StrategyTier.SLOW;

  private twitterClient: TwitterClient | null = null;
  private discordClient: DiscordClient | null = null;

  async initialize(config: IStrategyConfig): Promise<void> {
    await super.initialize(config);

    const twitterToken = process.env.TWITTER_BEARER_TOKEN;
    const discordToken = process.env.DISCORD_BOT_TOKEN;
    const channelIds = (process.env.DISCORD_CHANNEL_IDS || "")
      .split(",")
      .filter(Boolean);

    if (twitterToken) {
      this.twitterClient = new TwitterClient(twitterToken);
    }
    if (discordToken && channelIds.length > 0) {
      this.discordClient = new DiscordClient(discordToken, channelIds);
    }

    if (!this.twitterClient && !this.discordClient) {
      logger.warning(
        "Sentiment strategy: No Twitter or Discord credentials configured"
      );
    }
  }

  async execute(tokens: string[]): Promise<IStrategyResult> {
    return this.wrapExecution(async () => {
      const signals: ISignal[] = [];
      const twitterWeight = this.config.params.twitterWeight || 0.6;
      const discordWeight = this.config.params.discordWeight || 0.4;
      const bullThreshold = this.config.params.bullThreshold || 0.65;
      const bearThreshold = this.config.params.bearThreshold || 0.35;

      // Only analyze top 10 tokens to respect API rate limits
      const tokenDocs = await Token.find({
        address: { $in: tokens.slice(0, 10) },
      }).exec();

      for (const token of tokenDocs) {
        const symbol = token.symbol;
        if (!symbol) continue;

        let twitterScore = 0.5; // neutral default
        let discordScore = 0.5;
        let tweetCount = 0;
        let messageCount = 0;

        // Twitter sentiment
        if (this.twitterClient) {
          const tweets = await this.twitterClient.searchRecent(
            `$${symbol} OR ${token.address}`,
            { maxResults: 100, sinceMinutes: 30 }
          );
          tweetCount = tweets.length;
          if (tweets.length > 0) {
            twitterScore = this.analyzeSentiment(
              tweets.map((t) => t.text),
              tweets.map((t) =>
                TwitterClient.calculateEngagementWeight(t)
              )
            );
          }
        }

        // Discord sentiment
        if (this.discordClient) {
          const messages = await this.discordClient.searchMessages(
            symbol,
            { sinceMinutes: 30 }
          );
          messageCount = messages.length;
          if (messages.length > 0) {
            discordScore = this.analyzeSentiment(
              messages.map((m) => m.content)
            );
          }
        }

        // Weighted blend
        const blended =
          twitterScore * twitterWeight + discordScore * discordWeight;

        if (blended > bullThreshold && (tweetCount + messageCount) >= 3) {
          signals.push(
            this.createSignal(
              token.address,
              SignalDirection.BUY,
              (blended - 0.5) * 2, // normalize 0.5-1.0 -> 0-1
              {
                twitterScore,
                discordScore,
                blendedScore: blended,
                tweetCount,
                messageCount,
              },
              15 * 60 * 1000 // 15 min TTL
            )
          );
        } else if (blended < bearThreshold && (tweetCount + messageCount) >= 3) {
          signals.push(
            this.createSignal(
              token.address,
              SignalDirection.SELL,
              (0.5 - blended) * 2,
              {
                twitterScore,
                discordScore,
                blendedScore: blended,
                tweetCount,
                messageCount,
              },
              15 * 60 * 1000
            )
          );
        }
      }

      return { strategyId: this.id, signals, executionTimeMs: 0 };
    });
  }

  /**
   * Simple keyword-based sentiment scoring.
   * Returns 0-1 (0 = very bearish, 0.5 = neutral, 1 = very bullish).
   */
  private analyzeSentiment(
    texts: string[],
    weights?: number[]
  ): number {
    let bullishScore = 0;
    let bearishScore = 0;
    let totalWeight = 0;

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i].toLowerCase();
      const w = weights?.[i] || 1;
      totalWeight += w;

      for (const word of BULLISH_WORDS) {
        if (text.includes(word)) bullishScore += w;
      }
      for (const word of BEARISH_WORDS) {
        if (text.includes(word)) bearishScore += w;
      }
    }

    const total = bullishScore + bearishScore;
    if (total === 0) return 0.5; // neutral
    return bullishScore / total;
  }
}
