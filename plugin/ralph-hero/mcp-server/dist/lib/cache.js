/**
 * Session-scoped cache with TTL for GitHub API responses.
 *
 * Simple Map-based cache used for field option ID lookups,
 * project metadata, and issue node ID resolution. Cache is
 * session-scoped -- it lives as long as the MCP server process.
 */
export class SessionCache {
    store = new Map();
    defaultTtlMs;
    constructor(defaultTtlMs = 5 * 60 * 1000) {
        this.defaultTtlMs = defaultTtlMs;
    }
    /**
     * Get a cached value. Returns undefined if not found or expired.
     */
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return undefined;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return undefined;
        }
        return entry.value;
    }
    /**
     * Set a value in the cache with optional TTL override.
     */
    set(key, value, ttlMs) {
        this.store.set(key, {
            value,
            expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
        });
    }
    /**
     * Remove a specific key from the cache.
     */
    invalidate(key) {
        this.store.delete(key);
    }
    /**
     * Invalidate all keys matching a prefix.
     */
    invalidatePrefix(prefix) {
        for (const key of this.store.keys()) {
            if (key.startsWith(prefix)) {
                this.store.delete(key);
            }
        }
    }
    /**
     * Clear all cached entries.
     */
    clear() {
        this.store.clear();
    }
    /**
     * Get the number of entries in the cache (including expired ones not yet evicted).
     */
    get size() {
        return this.store.size;
    }
    /**
     * Generate a cache key from a query string and variables.
     */
    static queryKey(query, variables) {
        const normalized = query.replace(/\s+/g, " ").trim();
        const varsKey = variables ? JSON.stringify(variables, Object.keys(variables).sort()) : "";
        return `query:${normalized}:${varsKey}`;
    }
}
// ---------------------------------------------------------------------------
// Field Option Cache
// ---------------------------------------------------------------------------
/**
 * Maps field names to option names to option IDs for Projects V2
 * single-select fields. Populated by get_project, consumed by tools
 * that need to resolve human-readable names to GraphQL node IDs.
 */
export class FieldOptionCache {
    /** fieldName -> optionName -> optionId */
    fields = new Map();
    /** fieldName -> fieldId */
    fieldIds = new Map();
    /** projectId for the cached fields */
    projectId;
    /**
     * Populate the cache from project field data.
     */
    populate(projectId, fields) {
        this.projectId = projectId;
        this.fields.clear();
        this.fieldIds.clear();
        for (const field of fields) {
            this.fieldIds.set(field.name, field.id);
            if (field.options) {
                const optionMap = new Map();
                for (const option of field.options) {
                    optionMap.set(option.name, option.id);
                }
                this.fields.set(field.name, optionMap);
            }
        }
    }
    /**
     * Resolve an option name to its ID for a given field.
     * Returns undefined if field or option not found.
     */
    resolveOptionId(fieldName, optionName) {
        return this.fields.get(fieldName)?.get(optionName);
    }
    /**
     * Get the field ID for a field name.
     */
    getFieldId(fieldName) {
        return this.fieldIds.get(fieldName);
    }
    /**
     * Get the project ID for the cached fields.
     */
    getProjectId() {
        return this.projectId;
    }
    /**
     * Check if the cache has been populated.
     */
    isPopulated() {
        return this.fields.size > 0;
    }
    /**
     * Get all option names for a field.
     */
    getOptionNames(fieldName) {
        const optionMap = this.fields.get(fieldName);
        return optionMap ? Array.from(optionMap.keys()) : [];
    }
    /**
     * Get all field names.
     */
    getFieldNames() {
        return Array.from(this.fieldIds.keys());
    }
    /**
     * Clear the cache.
     */
    clear() {
        this.fields.clear();
        this.fieldIds.clear();
        this.projectId = undefined;
    }
}
//# sourceMappingURL=cache.js.map