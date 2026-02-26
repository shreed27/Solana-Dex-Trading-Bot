import { ICircuitBreakerState } from "../types/risk.types";
import { logger } from "./logger";

export class CircuitBreaker {
  private state: ICircuitBreakerState;
  private readonly cooldownMs: number;

  constructor(
    strategyId: string,
    private threshold: number = 5,
    cooldownMs: number = 5 * 60 * 1000
  ) {
    this.cooldownMs = cooldownMs;
    this.state = {
      strategyId,
      state: "closed",
      consecutiveFailures: 0,
    };
  }

  isAllowed(): boolean {
    if (this.state.state === "closed") return true;

    if (this.state.state === "open") {
      if (
        this.state.cooldownUntil &&
        Date.now() > this.state.cooldownUntil.getTime()
      ) {
        this.state.state = "half-open";
        logger.info(
          `Circuit breaker ${this.state.strategyId}: open -> half-open`
        );
        return true;
      }
      return false;
    }

    // half-open: allow one attempt
    return true;
  }

  recordSuccess(): void {
    if (this.state.state === "half-open") {
      logger.info(
        `Circuit breaker ${this.state.strategyId}: half-open -> closed`
      );
    }
    this.state.state = "closed";
    this.state.consecutiveFailures = 0;
    this.state.lastSuccessAt = new Date();
  }

  recordFailure(): void {
    this.state.consecutiveFailures++;
    this.state.lastFailureAt = new Date();

    if (this.state.state === "half-open") {
      this.state.state = "open";
      this.state.cooldownUntil = new Date(Date.now() + this.cooldownMs);
      logger.warning(
        `Circuit breaker ${this.state.strategyId}: half-open -> open (cooldown ${this.cooldownMs}ms)`
      );
      return;
    }

    if (this.state.consecutiveFailures >= this.threshold) {
      this.state.state = "open";
      this.state.cooldownUntil = new Date(Date.now() + this.cooldownMs);
      logger.warning(
        `Circuit breaker ${this.state.strategyId}: closed -> open after ${this.state.consecutiveFailures} failures`
      );
    }
  }

  getState(): ICircuitBreakerState {
    return { ...this.state };
  }

  reset(): void {
    this.state.state = "closed";
    this.state.consecutiveFailures = 0;
    this.state.cooldownUntil = undefined;
  }
}
