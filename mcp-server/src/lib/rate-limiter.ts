/**
 * Rate limit tracker for GitHub GraphQL API.
 *
 * GitHub GraphQL uses a point-based rate limit system (5000 points/hour).
 * Each query has a variable cost based on complexity. This module tracks
 * remaining points proactively using the `rateLimit` field included in
 * every query response.
 */

import type { RateLimitInfo } from "../types.js";

export interface RateLimiterOptions {
  /** Minimum remaining points before blocking (default: 100) */
  warningThreshold?: number;
  /** Minimum remaining points before hard-blocking with backoff (default: 50) */
  blockThreshold?: number;
}

export class RateLimiter {
  private remaining: number = 5000;
  private resetAt: Date = new Date();
  private warningThreshold: number;
  private blockThreshold: number;

  constructor(options: RateLimiterOptions = {}) {
    this.warningThreshold = options.warningThreshold ?? 100;
    this.blockThreshold = options.blockThreshold ?? 50;
  }

  /**
   * Update rate limit state from a GraphQL response's rateLimit field.
   * Call this after every query.
   */
  update(rateLimitInfo: RateLimitInfo): void {
    this.remaining = rateLimitInfo.remaining;
    this.resetAt = new Date(rateLimitInfo.resetAt);
  }

  /**
   * Check rate limit before making a request.
   * Delays if approaching the limit, throws if exhausted.
   */
  async checkBeforeRequest(): Promise<void> {
    if (this.remaining > this.warningThreshold) {
      return;
    }

    const now = new Date();
    const msUntilReset = this.resetAt.getTime() - now.getTime();

    if (this.remaining <= this.blockThreshold) {
      if (msUntilReset > 0) {
        const waitMs = Math.min(msUntilReset, 60_000); // Wait at most 60s
        console.error(
          `[rate-limiter] Rate limit critically low (${this.remaining} remaining). ` +
          `Waiting ${Math.ceil(waitMs / 1000)}s until reset at ${this.resetAt.toISOString()}`
        );
        await this.sleep(waitMs);
      }
    } else {
      // Warning zone: log but don't block
      console.error(
        `[rate-limiter] Rate limit approaching threshold (${this.remaining} remaining). ` +
        `Resets at ${this.resetAt.toISOString()}`
      );
    }
  }

  /**
   * Get current rate limit status.
   */
  getStatus(): { remaining: number; resetAt: Date; isLow: boolean; isCritical: boolean } {
    return {
      remaining: this.remaining,
      resetAt: this.resetAt,
      isLow: this.remaining <= this.warningThreshold,
      isCritical: this.remaining <= this.blockThreshold,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
