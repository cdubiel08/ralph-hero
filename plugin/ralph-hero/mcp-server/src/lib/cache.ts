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
    const varsKey = variables
      ? JSON.stringify(variables, Object.keys(variables).sort())
      : "";
    return `query:${normalized}:${varsKey}`;
  }
}

// ---------------------------------------------------------------------------
// Field Option Cache
// ---------------------------------------------------------------------------

interface ProjectCacheData {
  projectId: string;
  fields: Map<string, Map<string, string>>;
  fieldIds: Map<string, string>;
}

/**
 * Maps field names to option names to option IDs for Projects V2
 * single-select fields. Populated by get_project, consumed by tools
 * that need to resolve human-readable names to GraphQL node IDs.
 *
 * Supports multiple projects keyed by project number. When projectNumber
 * is omitted from method calls, the first populated project is used
 * (backward compatible with single-project callers).
 */
export class FieldOptionCache {
  private projects = new Map<number, ProjectCacheData>();
  /** Track the first populated project number for backward compat */
  private defaultProjectNumber: number | undefined;

  /**
   * Populate the cache from project field data.
   */
  populate(
    projectNumber: number,
    projectId: string,
    fields: Array<{
      id: string;
      name: string;
      options?: Array<{ id: string; name: string }>;
    }>,
  ): void {
    const fieldMap = new Map<string, Map<string, string>>();
    const fieldIdMap = new Map<string, string>();

    for (const field of fields) {
      fieldIdMap.set(field.name, field.id);
      if (field.options) {
        const optionMap = new Map<string, string>();
        for (const option of field.options) {
          optionMap.set(option.name, option.id);
        }
        fieldMap.set(field.name, optionMap);
      }
    }

    this.projects.set(projectNumber, {
      projectId,
      fields: fieldMap,
      fieldIds: fieldIdMap,
    });

    if (this.defaultProjectNumber === undefined) {
      this.defaultProjectNumber = projectNumber;
    }
  }

  /**
   * Resolve an option name to its ID for a given field.
   * Returns undefined if field or option not found.
   */
  resolveOptionId(
    fieldName: string,
    optionName: string,
    projectNumber?: number,
  ): string | undefined {
    const entry = this.resolveEntry(projectNumber);
    return entry?.fields.get(fieldName)?.get(optionName);
  }

  /**
   * Get the field ID for a field name.
   */
  getFieldId(fieldName: string, projectNumber?: number): string | undefined {
    const entry = this.resolveEntry(projectNumber);
    return entry?.fieldIds.get(fieldName);
  }

  /**
   * Get the project ID for the cached fields.
   */
  getProjectId(projectNumber?: number): string | undefined {
    const entry = this.resolveEntry(projectNumber);
    return entry?.projectId;
  }

  /**
   * Check if the cache has been populated.
   * When projectNumber is provided, checks that specific project.
   * When omitted, checks if any project is populated.
   */
  isPopulated(projectNumber?: number): boolean {
    if (projectNumber !== undefined) {
      return this.projects.has(projectNumber);
    }
    return this.projects.size > 0;
  }

  /**
   * Get all option names for a field.
   */
  getOptionNames(fieldName: string, projectNumber?: number): string[] {
    const entry = this.resolveEntry(projectNumber);
    const optionMap = entry?.fields.get(fieldName);
    return optionMap ? Array.from(optionMap.keys()) : [];
  }

  /**
   * Get all field names.
   */
  getFieldNames(projectNumber?: number): string[] {
    const entry = this.resolveEntry(projectNumber);
    return entry ? Array.from(entry.fieldIds.keys()) : [];
  }

  /**
   * Clear the cache (all projects).
   */
  clear(): void {
    this.projects.clear();
    this.defaultProjectNumber = undefined;
  }

  /**
   * Resolve the cache entry for a project number.
   * Falls back to the first populated project when projectNumber is omitted.
   */
  private resolveEntry(
    projectNumber?: number,
  ): ProjectCacheData | undefined {
    if (projectNumber !== undefined) {
      return this.projects.get(projectNumber);
    }
    if (this.defaultProjectNumber !== undefined) {
      return this.projects.get(this.defaultProjectNumber);
    }
    return undefined;
  }
}
