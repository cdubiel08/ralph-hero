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
export declare class RateLimiter {
    private remaining;
    private resetAt;
    private warningThreshold;
    private blockThreshold;
    constructor(options?: RateLimiterOptions);
    /**
     * Update rate limit state from a GraphQL response's rateLimit field.
     * Call this after every query.
     */
    update(rateLimitInfo: RateLimitInfo): void;
    /**
     * Check rate limit before making a request.
     * Delays if approaching the limit, throws if exhausted.
     */
    checkBeforeRequest(): Promise<void>;
    /**
     * Get current rate limit status.
     */
    getStatus(): {
        remaining: number;
        resetAt: Date;
        isLow: boolean;
        isCritical: boolean;
    };
    private sleep;
}
//# sourceMappingURL=rate-limiter.d.ts.map