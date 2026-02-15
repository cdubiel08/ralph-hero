/**
 * Session-scoped cache with TTL for GitHub API responses.
 *
 * Simple Map-based cache used for field option ID lookups,
 * project metadata, and issue node ID resolution. Cache is
 * session-scoped -- it lives as long as the MCP server process.
 */
export declare class SessionCache {
    private store;
    private defaultTtlMs;
    constructor(defaultTtlMs?: number);
    /**
     * Get a cached value. Returns undefined if not found or expired.
     */
    get<T>(key: string): T | undefined;
    /**
     * Set a value in the cache with optional TTL override.
     */
    set<T>(key: string, value: T, ttlMs?: number): void;
    /**
     * Remove a specific key from the cache.
     */
    invalidate(key: string): void;
    /**
     * Invalidate all keys matching a prefix.
     */
    invalidatePrefix(prefix: string): void;
    /**
     * Clear all cached entries.
     */
    clear(): void;
    /**
     * Get the number of entries in the cache (including expired ones not yet evicted).
     */
    get size(): number;
    /**
     * Generate a cache key from a query string and variables.
     */
    static queryKey(query: string, variables?: Record<string, unknown>): string;
}
/**
 * Maps field names to option names to option IDs for Projects V2
 * single-select fields. Populated by get_project, consumed by tools
 * that need to resolve human-readable names to GraphQL node IDs.
 */
export declare class FieldOptionCache {
    /** fieldName -> optionName -> optionId */
    private fields;
    /** fieldName -> fieldId */
    private fieldIds;
    /** projectId for the cached fields */
    private projectId;
    /**
     * Populate the cache from project field data.
     */
    populate(projectId: string, fields: Array<{
        id: string;
        name: string;
        options?: Array<{
            id: string;
            name: string;
        }>;
    }>): void;
    /**
     * Resolve an option name to its ID for a given field.
     * Returns undefined if field or option not found.
     */
    resolveOptionId(fieldName: string, optionName: string): string | undefined;
    /**
     * Get the field ID for a field name.
     */
    getFieldId(fieldName: string): string | undefined;
    /**
     * Get the project ID for the cached fields.
     */
    getProjectId(): string | undefined;
    /**
     * Check if the cache has been populated.
     */
    isPopulated(): boolean;
    /**
     * Get all option names for a field.
     */
    getOptionNames(fieldName: string): string[];
    /**
     * Get all field names.
     */
    getFieldNames(): string[];
    /**
     * Clear the cache.
     */
    clear(): void;
}
//# sourceMappingURL=cache.d.ts.map