/**
 * Cursor-based pagination utility for GitHub GraphQL API.
 *
 * Handles automatic pagination for any GraphQL connection,
 * including nested connections within Projects V2 queries.
 */
/**
 * Extract a nested value from an object using a dot-separated path.
 * For example, getNestedValue(obj, "node.projectV2.items") returns obj.node.projectV2.items.
 */
function getNestedValue(obj, path) {
    const parts = path.split(".");
    let current = obj;
    for (const part of parts) {
        if (current == null || typeof current !== "object")
            return undefined;
        current = current[part];
    }
    return current;
}
/**
 * Set a nested value on an object using a dot-separated path.
 */
function setNestedValue(obj, path, value) {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}
/**
 * Paginate a GraphQL connection query.
 *
 * @param executeQuery - Function that executes a GraphQL query with variables
 * @param query - The GraphQL query string (must include $cursor variable and pageInfo fragment)
 * @param variables - Variables for the query (cursor will be added/updated automatically)
 * @param connectionPath - Dot-separated path to the connection in the response (e.g., "node.projectV2.items")
 * @param options - Pagination options
 * @returns All accumulated nodes from all pages
 */
export async function paginateConnection(executeQuery, query, variables, connectionPath, options = {}) {
    const pageSize = options.pageSize ?? 100;
    const maxItems = options.maxItems ?? Infinity;
    const allNodes = [];
    let cursor = null;
    let totalCount;
    while (allNodes.length < maxItems) {
        const queryVars = {
            ...variables,
            cursor,
            first: Math.min(pageSize, maxItems - allNodes.length),
        };
        const response = await executeQuery(query, queryVars);
        const connection = getNestedValue(response, connectionPath);
        if (!connection) {
            throw new Error(`Connection not found at path "${connectionPath}" in GraphQL response`);
        }
        if (connection.totalCount !== undefined) {
            totalCount = connection.totalCount;
        }
        allNodes.push(...connection.nodes);
        if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
            break;
        }
        cursor = connection.pageInfo.endCursor;
    }
    return { nodes: allNodes, totalCount };
}
//# sourceMappingURL=pagination.js.map