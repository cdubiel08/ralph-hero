/**
 * GitHub GraphQL client with authentication, rate limiting, and caching.
 *
 * Wraps @octokit/graphql with proactive rate limit tracking and
 * session-scoped caching. All queries automatically include the
 * rateLimit fragment for continuous tracking.
 */

import { graphql } from "@octokit/graphql";
import { RateLimiter } from "./lib/rate-limiter.js";
import { SessionCache } from "./lib/cache.js";
import type { RateLimitInfo, GitHubClientConfig } from "./types.js";

/**
 * The rateLimit fragment to include in every query for proactive tracking.
 */
const RATE_LIMIT_FRAGMENT = `
  rateLimit {
    limit
    remaining
    resetAt
    cost
    nodeCount
  }
`;

export interface GitHubClient {
  /** Execute a GraphQL query with automatic rate limit tracking and optional caching. */
  query: <T = unknown>(
    queryString: string,
    variables?: Record<string, unknown>,
    options?: { cache?: boolean; cacheTtlMs?: number },
  ) => Promise<T>;

  /** Execute a GraphQL mutation (never cached). */
  mutate: <T = unknown>(
    mutation: string,
    variables?: Record<string, unknown>,
  ) => Promise<T>;

  /** Get rate limit status. */
  getRateLimitStatus: () => { remaining: number; resetAt: Date; isLow: boolean; isCritical: boolean };

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
export function createGitHubClient(clientConfig: GitHubClientConfig): GitHubClient {
  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${clientConfig.token}`,
    },
  });

  const rateLimiter = new RateLimiter();
  const cache = new SessionCache();

  /**
   * Execute a raw GraphQL request and handle rate limit tracking.
   */
  async function executeGraphQL<T>(
    queryString: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    await rateLimiter.checkBeforeRequest();

    // Inject rateLimit fragment if not already present (queries only, not mutations)
    let fullQuery = queryString;
    const isMutation = /^\s*mutation\b/i.test(queryString.trim());
    if (!isMutation && !queryString.includes("rateLimit")) {
      // Insert rateLimit into the query's top-level selection set
      const match = fullQuery.match(/(query)\s*(\([^)]*\))?\s*\{/);
      if (match) {
        const insertPos = fullQuery.indexOf("{", fullQuery.indexOf(match[0])) + 1;
        fullQuery =
          fullQuery.slice(0, insertPos) +
          "\n  " + RATE_LIMIT_FRAGMENT +
          fullQuery.slice(insertPos);
      }
    }

    try {
      const response = await graphqlWithAuth<T & { rateLimit?: RateLimitInfo }>(
        fullQuery,
        variables || {},
      );

      // Update rate limit tracker from response
      if (response && typeof response === "object" && "rateLimit" in response) {
        const rl = (response as { rateLimit?: RateLimitInfo }).rateLimit;
        if (rl) {
          rateLimiter.update(rl);
        }
      }

      return response as T;
    } catch (error: unknown) {
      // Handle rate limit errors (403)
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 403
      ) {
        const retryAfter = error && typeof error === "object" && "headers" in error
          ? ((error as { headers?: Record<string, string> }).headers?.["retry-after"])
          : undefined;

        if (retryAfter) {
          const waitMs = parseInt(retryAfter, 10) * 1000;
          console.error(`[github-client] Rate limited. Waiting ${retryAfter}s before retry.`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          return executeGraphQL<T>(queryString, variables);
        }
      }

      throw error;
    }
  }

  return {
    config: clientConfig,

    async query<T>(
      queryString: string,
      variables?: Record<string, unknown>,
      options?: { cache?: boolean; cacheTtlMs?: number },
    ): Promise<T> {
      if (options?.cache) {
        const cacheKey = SessionCache.queryKey(queryString, variables);
        const cached = cache.get<T>(cacheKey);
        if (cached !== undefined) {
          return cached;
        }

        const result = await executeGraphQL<T>(queryString, variables);
        cache.set(cacheKey, result, options.cacheTtlMs);
        return result;
      }

      return executeGraphQL<T>(queryString, variables);
    },

    async mutate<T>(
      mutation: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      // Invalidate related cache entries on mutations
      // (conservative: clear all cache on any mutation)
      cache.clear();
      return executeGraphQL<T>(mutation, variables);
    },

    getRateLimitStatus() {
      return rateLimiter.getStatus();
    },

    getCache() {
      return cache;
    },

    async getAuthenticatedUser(): Promise<string> {
      const cacheKey = "authenticated-user";
      const cached = cache.get<string>(cacheKey);
      if (cached) return cached;

      const result = await executeGraphQL<{ viewer: { login: string } }>(
        `query { viewer { login } }`,
      );

      const login = result.viewer.login;
      cache.set(cacheKey, login, 60 * 60 * 1000); // Cache for 1 hour
      return login;
    },
  };
}
