import axios from "axios";
import { logger } from "../utils/logger";
import { RateLimiter } from "../utils/rateLimit";

export interface DiscordMessage {
  id: string;
  content: string;
  authorId: string;
  channelId: string;
  timestamp: string;
}

export class DiscordClient {
  private botToken: string;
  private channelIds: string[];
  private rateLimiter: RateLimiter;

  constructor(botToken: string, channelIds: string[]) {
    this.botToken = botToken;
    this.channelIds = channelIds;
    // Discord: 50 requests per second (conservative)
    this.rateLimiter = new RateLimiter(50, 50);
  }

  /**
   * Search messages across configured channels for a keyword.
   */
  async searchMessages(
    keyword: string,
    options: { limit?: number; sinceMinutes?: number } = {}
  ): Promise<DiscordMessage[]> {
    if (!this.botToken || this.channelIds.length === 0) return [];

    const messages: DiscordMessage[] = [];
    const since = options.sinceMinutes
      ? new Date(Date.now() - options.sinceMinutes * 60 * 1000)
      : new Date(Date.now() - 30 * 60 * 1000);

    for (const channelId of this.channelIds) {
      await this.rateLimiter.acquire();
      try {
        const response = await axios.get(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            params: { limit: options.limit || 100 },
            headers: {
              Authorization: `Bot ${this.botToken}`,
            },
            timeout: 10000,
          }
        );

        const channelMsgs: any[] = response.data || [];
        for (const msg of channelMsgs) {
          const msgTime = new Date(msg.timestamp);
          if (msgTime < since) continue;
          const content: string = msg.content || "";
          if (
            content.toLowerCase().includes(keyword.toLowerCase()) ||
            content.includes(`$${keyword}`)
          ) {
            messages.push({
              id: msg.id,
              content,
              authorId: msg.author?.id || "",
              channelId,
              timestamp: msg.timestamp,
            });
          }
        }
      } catch (err) {
        logger.error(`Discord search error for channel ${channelId}:`, err);
      }
    }

    return messages;
  }
}
