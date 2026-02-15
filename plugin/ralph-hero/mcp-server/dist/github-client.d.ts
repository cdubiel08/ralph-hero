/**
 * GitHub GraphQL client with authentication, rate limiting, and caching.
 *
 * Wraps @octokit/graphql with proactive rate limit tracking and
 * session-scoped caching. All queries automatically include the
 * rateLimit fragment for continuous tracking.
 */
import { SessionCache } from "./lib/cache.js";
import type { GitHubClientConfig } from "./types.js";
export interface GitHubClient {
    /** Execute a GraphQL query for REPO operations. */
    query: <T = unknown>(queryString: string, variables?: Record<string, unknown>, options?: {
        cache?: boolean;
        cacheTtlMs?: number;
    }) => Promise<T>;
    /** Execute a GraphQL query for PROJECT operations. Uses project token if configured. */
    projectQuery: <T = unknown>(queryString: string, variables?: Record<string, unknown>, options?: {
        cache?: boolean;
        cacheTtlMs?: number;
    }) => Promise<T>;
    /** Execute a GraphQL mutation for REPO operations (never cached). */
    mutate: <T = unknown>(mutation: string, variables?: Record<string, unknown>) => Promise<T>;
    /** Execute a GraphQL mutation for PROJECT operations (never cached). Uses project token if configured. */
    projectMutate: <T = unknown>(mutation: string, variables?: Record<string, unknown>) => Promise<T>;
    /** Get rate limit status. */
    getRateLimitStatus: () => {
        remaining: number;
        resetAt: Date;
        isLow: boolean;
        isCritical: boolean;
    };
    /** Get the session cache instance. */
    getCache: () => SessionCache;
    /** Get the authenticated user's login. */
    getAuthenticatedUser: () => Promise<string>;
    /** Configuration. */
    config: GitHubClientConfig;
}
/**
 * Create an authenticated GitHub GraphQL client.
 */
export declare function createGitHubClient(clientConfig: GitHubClientConfig): GitHubClient;
//# sourceMappingURL=github-client.d.ts.map