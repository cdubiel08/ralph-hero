/**
 * GitHub GraphQL client with authentication, rate limiting, and caching.
 *
 * Wraps @octokit/graphql with proactive rate limit tracking and
 * session-scoped caching. All queries automatically include the
 * rateLimit fragment for continuous tracking.
 */

import { graphql } from "@octokit/graphql";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { RateLimiter } from "./lib/rate-limiter.js";
import { SessionCache } from "./lib/cache.js";
import type { DebugLogger } from "./lib/debug-logger.js";
import { extractOperationName, sanitize } from "./lib/debug-logger.js";
import type { RateLimitInfo, GitHubClientConfig } from "./types.js";

/**
 * Classify a GraphQL error into one of: "rate_limit" | "network" | "graphql".
 *
 * - `rate_limit` — HTTP 403 with a `retry-after` header (GitHub's secondary
 *   rate limit signal). Plain 403s without retry-after fall through to
 *   `graphql` since they're more commonly permission errors.
 * - `network` — no `status` field on the error (fetch-level failure, DNS,
 *   socket reset, etc.)
 * - `graphql` — everything else (GraphQL validation errors, 4xx, 5xx).
 */
function classifyGraphQLError(error: unknown): "rate_limit" | "network" | "graphql" {
  if (!error || typeof error !== "object") {
    return "graphql";
  }
  const e = error as { status?: number; headers?: Record<string, string> };
  if (typeof e.status !== "number") {
    return "network";
  }
  if (e.status === 403 && e.headers?.["retry-after"]) {
    return "rate_limit";
  }
  return "graphql";
}

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

  /** Execute a REST API POST request. Uses project token by default. */
  restPost: <T = unknown>(
    path: string,
    body: unknown,
    useProjectToken?: boolean,
  ) => Promise<T>;

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
   *
   * Wraps the request in a `ralph_hero.graphql` OpenTelemetry span when a
   * tracer is available. When `RALPH_DEBUG` is unset and the SDK has not been
   * initialized, `@opentelemetry/api` returns a no-op tracer/span — calls are
   * essentially free.
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

    const tracer = trace.getTracer("ralph-hero");
    const operation = extractOperationName(fullQuery);

    return tracer.startActiveSpan(
      "ralph_hero.graphql",
      async (span: Span): Promise<T> => {
        if (operation) {
          span.setAttribute("ralph_hero.operation", operation);
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
              if (typeof rl.remaining === "number") {
                span.setAttribute("ralph_hero.rate_limit.remaining", rl.remaining);
              }
              if (typeof rl.cost === "number") {
                span.setAttribute("ralph_hero.rate_limit.cost", rl.cost);
              }
            }
          }

          debugLogger?.logGraphQL({
            operation,
            variables: sanitize(variables),
            durationMs: Date.now() - t0,
            status: 200,
            rateLimitRemaining: (response as { rateLimit?: RateLimitInfo })
              .rateLimit?.remaining,
            rateLimitCost: (response as { rateLimit?: RateLimitInfo }).rateLimit
              ?.cost,
          });

          return response as T;
        } catch (error: unknown) {
          // Detect rate-limit retry-able case FIRST. On the retry path we
          // intentionally do NOT mark this span ERROR (or log a 500-shaped
          // entry) — the retry may succeed and we don't want Langfuse to
          // show a permanently-failed parent for a request that eventually
          // returned 200. Only the non-retry path mutates span status.
          const is403 =
            error &&
            typeof error === "object" &&
            "status" in error &&
            (error as { status: number }).status === 403;
          const retryAfter =
            is403 && error && typeof error === "object" && "headers" in error
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
            // `await` is critical: in an async fn, `finally { span.end() }`
            // runs as soon as the return expression evaluates. Without
            // `await`, the inner Promise would still be pending while
            // `span.end()` fires, exporting a half-finished outer span.
            return await executeGraphQL<T>(queryString, variables, graphqlFn);
          }

          // Non-retry error path: mark span ERROR, log, rethrow.
          const errorType = classifyGraphQLError(error);
          span.setAttribute("ralph_hero.error_type", errorType);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof Error) {
            span.recordException(error);
          }

          debugLogger?.logGraphQL({
            operation,
            variables: sanitize(variables),
            durationMs: Date.now() - t0,
            status:
              error && typeof error === "object" && "status" in error
                ? (error as { status: number }).status
                : 500,
            error: error instanceof Error ? error.message : String(error),
          });

          throw error;
        } finally {
          span.end();
        }
      },
    );
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

    async restPost<T>(
      path: string,
      body: unknown,
      useProjectToken = true,
    ): Promise<T> {
      const token = useProjectToken
        ? (clientConfig.projectToken ?? clientConfig.token)
        : clientConfig.token;

      const url = `https://api.github.com${path}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `GitHub REST API error ${response.status} for ${path}: ${text}`,
        );
      }

      return response.json() as Promise<T>;
    },
  };
}
