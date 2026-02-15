/**
 * Cursor-based pagination utility for GitHub GraphQL API.
 *
 * Handles automatic pagination for any GraphQL connection,
 * including nested connections within Projects V2 queries.
 */
export interface PaginatedResponse<T> {
    nodes: T[];
    totalCount?: number;
}
export interface PaginateOptions {
    /** Maximum number of items per page (default: 100) */
    pageSize?: number;
    /** Maximum total items to fetch across all pages (default: unlimited) */
    maxItems?: number;
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
export declare function paginateConnection<T>(executeQuery: (query: string, variables: Record<string, unknown>) => Promise<unknown>, query: string, variables: Record<string, unknown>, connectionPath: string, options?: PaginateOptions): Promise<PaginatedResponse<T>>;
//# sourceMappingURL=pagination.d.ts.map