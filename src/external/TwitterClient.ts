import axios from "axios";
import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimit";

export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  createdAt: string;
  publicMetrics?: {
    retweetCount: number;
    likeCount: number;
    replyCount: number;
  };
}

export class TwitterClient {
  private bearerToken: string;
  private rateLimiter: RateLimiter;

  constructor(bearerToken: string) {
    this.bearerToken = bearerToken;
    // Twitter API v2: 300 requests per 15 minutes = 20/min
    this.rateLimiter = new RateLimiter(20, 20 / 60);
  }

  /**
   * Search recent tweets mentioning a query.
   */
  async searchRecent(
    query: string,
    options: { maxResults?: number; sinceMinutes?: number } = {}
  ): Promise<Tweet[]> {
    if (!this.bearerToken) return [];

    await this.rateLimiter.acquire();

    try {
      const sinceTime = options.sinceMinutes
        ? new Date(
            Date.now() - options.sinceMinutes * 60 * 1000
          ).toISOString()
        : undefined;

      const params: Record<string, string> = {
        query: `${query} -is:retweet lang:en`,
        max_results: String(Math.min(options.maxResults || 100, 100)),
        "tweet.fields": "created_at,public_metrics,author_id",
      };
      if (sinceTime) params.start_time = sinceTime;

      const response = await axios.get(
        "https://api.twitter.com/2/tweets/search/recent",
        {
          params,
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
          },
          timeout: 10000,
        }
      );

      const data = response.data?.data;
      if (!Array.isArray(data)) return [];

      return data.map((t: any) => ({
        id: t.id,
        text: t.text,
        authorId: t.author_id,
        createdAt: t.created_at,
        publicMetrics: t.public_metrics
          ? {
              retweetCount: t.public_metrics.retweet_count,
              likeCount: t.public_metrics.like_count,
              replyCount: t.public_metrics.reply_count,
            }
          : undefined,
      }));
    } catch (err) {
      logger.error("Twitter search error:", err);
      return [];
    }
  }

  /**
   * Simple engagement-weighted sentiment from tweet text.
   */
  static calculateEngagementWeight(tweet: Tweet): number {
    if (!tweet.publicMetrics) return 1;
    const { retweetCount, likeCount, replyCount } = tweet.publicMetrics;
    return 1 + Math.log10(1 + retweetCount * 3 + likeCount + replyCount * 2);
  }
}
