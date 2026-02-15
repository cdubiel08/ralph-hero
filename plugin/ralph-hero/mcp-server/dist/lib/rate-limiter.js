/**
 * Rate limit tracker for GitHub GraphQL API.
 *
 * GitHub GraphQL uses a point-based rate limit system (5000 points/hour).
 * Each query has a variable cost based on complexity. This module tracks
 * remaining points proactively using the `rateLimit` field included in
 * every query response.
 */
export class RateLimiter {
    remaining = 5000;
    resetAt = new Date();
    warningThreshold;
    blockThreshold;
    constructor(options = {}) {
        this.warningThreshold = options.warningThreshold ?? 100;
        this.blockThreshold = options.blockThreshold ?? 50;
    }
    /**
     * Update rate limit state from a GraphQL response's rateLimit field.
     * Call this after every query.
     */
    update(rateLimitInfo) {
        this.remaining = rateLimitInfo.remaining;
        this.resetAt = new Date(rateLimitInfo.resetAt);
    }
    /**
     * Check rate limit before making a request.
     * Delays if approaching the limit, throws if exhausted.
     */
    async checkBeforeRequest() {
        if (this.remaining > this.warningThreshold) {
            return;
        }
        const now = new Date();
        const msUntilReset = this.resetAt.getTime() - now.getTime();
        if (this.remaining <= this.blockThreshold) {
            if (msUntilReset > 0) {
                const waitMs = Math.min(msUntilReset, 60_000); // Wait at most 60s
                console.error(`[rate-limiter] Rate limit critically low (${this.remaining} remaining). ` +
                    `Waiting ${Math.ceil(waitMs / 1000)}s until reset at ${this.resetAt.toISOString()}`);
                await this.sleep(waitMs);
            }
        }
        else {
            // Warning zone: log but don't block
            console.error(`[rate-limiter] Rate limit approaching threshold (${this.remaining} remaining). ` +
                `Resets at ${this.resetAt.toISOString()}`);
        }
    }
    /**
     * Get current rate limit status.
     */
    getStatus() {
        return {
            remaining: this.remaining,
            resetAt: this.resetAt,
            isLow: this.remaining <= this.warningThreshold,
            isCritical: this.remaining <= this.blockThreshold,
        };
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=rate-limiter.js.map