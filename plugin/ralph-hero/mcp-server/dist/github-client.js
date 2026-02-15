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
/**
 * Create an authenticated GitHub GraphQL client.
 */
export function createGitHubClient(clientConfig) {
    const graphqlWithAuth = graphql.defaults({
        headers: {
            authorization: `token ${clientConfig.token}`,
        },
    });
    // Create a separate graphql instance for project operations if a different token is configured
    const hasProjectToken = clientConfig.projectToken && clientConfig.projectToken !== clientConfig.token;
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
    async function executeGraphQL(queryString, variables, graphqlFn = graphqlWithAuth) {
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
            const response = await graphqlFn(fullQuery, variables || {});
            // Update rate limit tracker from response
            if (response && typeof response === "object" && "rateLimit" in response) {
                const rl = response.rateLimit;
                if (rl) {
                    rateLimiter.update(rl);
                }
            }
            return response;
        }
        catch (error) {
            // Handle rate limit errors (403)
            if (error &&
                typeof error === "object" &&
                "status" in error &&
                error.status === 403) {
                const retryAfter = error && typeof error === "object" && "headers" in error
                    ? (error.headers?.["retry-after"])
                    : undefined;
                if (retryAfter) {
                    const waitMs = parseInt(retryAfter, 10) * 1000;
                    console.error(`[github-client] Rate limited. Waiting ${retryAfter}s before retry.`);
                    await new Promise((resolve) => setTimeout(resolve, waitMs));
                    return executeGraphQL(queryString, variables, graphqlFn);
                }
            }
            throw error;
        }
    }
    return {
        config: clientConfig,
        async query(queryString, variables, options) {
            if (options?.cache) {
                const cacheKey = SessionCache.queryKey(queryString, variables);
                const cached = cache.get(cacheKey);
                if (cached !== undefined) {
                    return cached;
                }
                const result = await executeGraphQL(queryString, variables);
                cache.set(cacheKey, result, options.cacheTtlMs);
                return result;
            }
            return executeGraphQL(queryString, variables);
        },
        async projectQuery(queryString, variables, options) {
            if (options?.cache) {
                const cacheKey = SessionCache.queryKey(queryString, variables);
                const cached = cache.get(cacheKey);
                if (cached !== undefined) {
                    return cached;
                }
                const result = await executeGraphQL(queryString, variables, projectGraphqlWithAuth);
                cache.set(cacheKey, result, options.cacheTtlMs);
                return result;
            }
            return executeGraphQL(queryString, variables, projectGraphqlWithAuth);
        },
        async mutate(mutation, variables) {
            // Invalidate cached query results but preserve stable node ID lookups
            // (issue-node-id and project-item-id entries remain valid across mutations)
            cache.invalidatePrefix("query:");
            const result = await executeGraphQL(mutation, variables);
            return result;
        },
        async projectMutate(mutation, variables) {
            cache.invalidatePrefix("query:");
            const result = await executeGraphQL(mutation, variables, projectGraphqlWithAuth);
            return result;
        },
        getRateLimitStatus() {
            return rateLimiter.getStatus();
        },
        getCache() {
            return cache;
        },
        async getAuthenticatedUser() {
            const cacheKey = "authenticated-user";
            const cached = cache.get(cacheKey);
            if (cached)
                return cached;
            const result = await executeGraphQL(`query { viewer { login } }`);
            const login = result.viewer.login;
            cache.set(cacheKey, login, 60 * 60 * 1000); // Cache for 1 hour
            return login;
        },
    };
}
//# sourceMappingURL=github-client.js.map