/**
 * Simple token-bucket rate limiter.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number,
    private refillRate: number, // tokens per second
    private refillIntervalMs: number = 1000
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = (elapsed / this.refillIntervalMs) * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }

  canProceed(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  async acquire(): Promise<void> {
    while (!this.canProceed()) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.tokens -= 1;
  }

  getAvailableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
}
