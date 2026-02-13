/**
 * Session-scoped cache with TTL for GitHub API responses.
 *
 * Simple Map-based cache used for field option ID lookups,
 * project metadata, and issue node ID resolution. Cache is
 * session-scoped -- it lives as long as the MCP server process.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SessionCache {
  private store = new Map<string, CacheEntry<unknown>>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 5 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Get a cached value. Returns undefined if not found or expired.
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * Set a value in the cache with optional TTL override.
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /**
   * Remove a specific key from the cache.
   */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /**
   * Invalidate all keys matching a prefix.
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get the number of entries in the cache (including expired ones not yet evicted).
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Generate a cache key from a query string and variables.
   */
  static queryKey(query: string, variables?: Record<string, unknown>): string {
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
  private fields = new Map<string, Map<string, string>>();

  /** fieldName -> fieldId */
  private fieldIds = new Map<string, string>();

  /** projectId for the cached fields */
  private projectId: string | undefined;

  /**
   * Populate the cache from project field data.
   */
  populate(
    projectId: string,
    fields: Array<{
      id: string;
      name: string;
      options?: Array<{ id: string; name: string }>;
    }>,
  ): void {
    this.projectId = projectId;
    this.fields.clear();
    this.fieldIds.clear();

    for (const field of fields) {
      this.fieldIds.set(field.name, field.id);
      if (field.options) {
        const optionMap = new Map<string, string>();
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
  resolveOptionId(fieldName: string, optionName: string): string | undefined {
    return this.fields.get(fieldName)?.get(optionName);
  }

  /**
   * Get the field ID for a field name.
   */
  getFieldId(fieldName: string): string | undefined {
    return this.fieldIds.get(fieldName);
  }

  /**
   * Get the project ID for the cached fields.
   */
  getProjectId(): string | undefined {
    return this.projectId;
  }

  /**
   * Check if the cache has been populated.
   */
  isPopulated(): boolean {
    return this.fields.size > 0;
  }

  /**
   * Get all option names for a field.
   */
  getOptionNames(fieldName: string): string[] {
    const optionMap = this.fields.get(fieldName);
    return optionMap ? Array.from(optionMap.keys()) : [];
  }

  /**
   * Get all field names.
   */
  getFieldNames(): string[] {
    return Array.from(this.fieldIds.keys());
  }

  /**
   * Clear the cache.
   */
  clear(): void {
    this.fields.clear();
    this.fieldIds.clear();
    this.projectId = undefined;
  }
}
