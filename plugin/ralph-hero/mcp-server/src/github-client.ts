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
import type { DebugLogger } from "./lib/debug-logger.js";
import { extractOperationName, sanitize } from "./lib/debug-logger.js";
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
  /** Execute a GraphQL query for REPO operations. */
  query: <T = unknown>(
    queryString: string,
    variables?: Record<string, unknown>,
    options?: { cache?: boolean; cacheTtlMs?: number },
  ) => Promise<T>;

  /** Execute a GraphQL query for PROJECT operations. Uses project token if configured. */
  projectQuery: <T = unknown>(
    queryString: string,
    variables?: Record<string, unknown>,
    options?: { cache?: boolean; cacheTtlMs?: number },
  ) => Promise<T>;

  /** Execute a GraphQL mutation for REPO operations (never cached). */
  mutate: <T = unknown>(
    mutation: string,
    variables?: Record<string, unknown>,
  ) => Promise<T>;

  /** Execute a GraphQL mutation for PROJECT operations (never cached). Uses project token if configured. */
  projectMutate: <T = unknown>(
    mutation: string,
    variables?: Record<string, unknown>,
  ) => Promise<T>;

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
export function createGitHubClient(
  clientConfig: GitHubClientConfig,
  debugLogger?: DebugLogger | null,
): GitHubClient {
  const graphqlWithAuth = graphql.defaults({
    headers: {
      authorization: `token ${clientConfig.token}`,
    },
  });

  // Create a separate graphql instance for project operations if a different token is configured
  const hasProjectToken =
    clientConfig.projectToken &&
    clientConfig.projectToken !== clientConfig.token;
  const projectGraphqlWithAuth = hasProjectToken
    ? graphql.defaults({
        headers: {
          authorization: `token ${clientConfig.projectToken}`,
        },
      })
    : graphqlWithAuth;

  const rateLimiter = new RateLimiter();
  const cache = new SessionCache();

  /**
   * Execute a raw GraphQL request and handle rate limit tracking.
   */
  async function executeGraphQL<T>(
    queryString: string,
    variables?: Record<string, unknown>,
    graphqlFn: typeof graphqlWithAuth = graphqlWithAuth,
  ): Promise<T> {
    await rateLimiter.checkBeforeRequest();

    // Inject rateLimit fragment if not already present (queries only, not mutations)
    let fullQuery = queryString;
    const isMutation = /^\s*mutation\b/i.test(queryString.trim());
    if (!isMutation && !queryString.includes("rateLimit")) {
      // Insert rateLimit into the query's top-level selection set
      const match = fullQuery.match(/(query)\s*(\([^)]*\))?\s*\{/);
      if (match) {
        const insertPos =
          fullQuery.indexOf("{", fullQuery.indexOf(match[0])) + 1;
        fullQuery =
          fullQuery.slice(0, insertPos) +
          "\n  " +
          RATE_LIMIT_FRAGMENT +
          fullQuery.slice(insertPos);
      }
    }

    const t0 = Date.now();
    try {
      const response = await graphqlFn<T & { rateLimit?: RateLimitInfo }>(
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

      debugLogger?.logGraphQL({
        operation: extractOperationName(fullQuery),
        variables: sanitize(variables),
        durationMs: Date.now() - t0,
        status: 200,
        rateLimitRemaining: (response as { rateLimit?: RateLimitInfo }).rateLimit?.remaining,
        rateLimitCost: (response as { rateLimit?: RateLimitInfo }).rateLimit?.cost,
      });

      return response as T;
    } catch (error: unknown) {
      debugLogger?.logGraphQL({
        operation: extractOperationName(fullQuery),
        variables: sanitize(variables),
        durationMs: Date.now() - t0,
        status: error && typeof error === "object" && "status" in error
          ? (error as { status: number }).status
          : 500,
        error: error instanceof Error ? error.message : String(error),
      });

      // Handle rate limit errors (403)
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        (error as { status: number }).status === 403
      ) {
        const retryAfter =
          error && typeof error === "object" && "headers" in error
            ? (error as { headers?: Record<string, string> }).headers?.[
                "retry-after"
              ]
            : undefined;

        if (retryAfter) {
          const waitMs = parseInt(retryAfter, 10) * 1000;
          console.error(
            `[github-client] Rate limited. Waiting ${retryAfter}s before retry.`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          return executeGraphQL<T>(queryString, variables, graphqlFn);
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

    async projectQuery<T>(
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

        const result = await executeGraphQL<T>(
          queryString,
          variables,
          projectGraphqlWithAuth,
        );
        cache.set(cacheKey, result, options.cacheTtlMs);
        return result;
      }

      return executeGraphQL<T>(queryString, variables, projectGraphqlWithAuth);
    },

    async mutate<T>(
      mutation: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      // Invalidate cached query results but preserve stable node ID lookups
      // (issue-node-id and project-item-id entries remain valid across mutations)
      cache.invalidatePrefix("query:");
      const result = await executeGraphQL<T>(mutation, variables);
      return result;
    },

    async projectMutate<T>(
      mutation: string,
      variables?: Record<string, unknown>,
    ): Promise<T> {
      cache.invalidatePrefix("query:");
      const result = await executeGraphQL<T>(
        mutation,
        variables,
        projectGraphqlWithAuth,
      );
      return result;
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
