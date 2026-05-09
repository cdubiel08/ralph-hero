/**
 * Cursor-based pagination utility for GitHub GraphQL API.
 *
 * Handles automatic pagination for any GraphQL connection,
 * including nested connections within Projects V2 queries.
 */

import type { PageInfo } from "../types.js";

export interface PaginatedResponse<T> {
  nodes: T[];
  totalCount?: number;
  /**
   * `true` when the loop stopped because `maxItems` was hit AND the connection
   * still had more pages (`pageInfo.hasNextPage === true`). Always `false`
   * when:
   * - `scanUntilExhausted: true` (the contract is full exhaustion),
   * - the connection exhausted naturally before reaching `maxItems`,
   * - the `until` predicate returned `false` early (caller intent, not
   *   truncation).
   *
   * Callers can use this flag to surface silent data loss to users without
   * having to compare `nodes.length` against `totalCount` themselves. A
   * matching `console.warn` is also emitted when this becomes `true`.
   */
  truncated: boolean;
}

/**
 * Extract a nested value from an object using a dot-separated path.
 * For example, getNestedValue(obj, "node.projectV2.items") returns obj.node.projectV2.items.
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface PaginateOptions<T = unknown> {
  /** Maximum number of items per page (default: 100) */
  pageSize?: number;
  /**
   * Maximum total items to fetch across all pages (default: unlimited).
   *
   * When `maxItems` is hit and the connection still has more pages,
   * `paginateConnection` sets `truncated: true` on the return shape and emits
   * a `console.warn`. Pass `scanUntilExhausted: true` to opt out of the cap
   * entirely (recommended for project-wide reads where bounded memory is
   * acceptable).
   */
  maxItems?: number;
  /**
   * When `true`, ignore `maxItems` and keep fetching pages until the
   * connection's `pageInfo.hasNextPage` is `false`. The loop is then bounded
   * only by total connection size. Use this for project-wide reads where
   * partial results would silently mislead consumers (see GH-1171/1168).
   *
   * If both `scanUntilExhausted: true` and `maxItems: N` are passed,
   * `scanUntilExhausted` wins and `maxItems` is treated as advisory (no
   * error). Under `scanUntilExhausted: true`, `truncated` is always `false`
   * because full exhaustion is the contract.
   *
   * Default: `false`.
   */
  scanUntilExhausted?: boolean;
  /**
   * Optional per-node predicate. After each page is fetched, the helper
   * iterates through `connection.nodes` and calls
   * `until(node, pageNodes, allNodes)` for each node. The first node where
   * `until` returns `false` triggers the loop to stop AFTER the current page
   * is fully appended to `allNodes` — subsequent nodes from the same page are
   * still kept. Stop happens at the page boundary, not mid-page, so callers
   * always receive a coherent set of pages.
   *
   * Use this when you want to walk the connection until a condition is met
   * (e.g., "stop once we've seen N matching items in a row"). Early stop via
   * `until` does NOT set `truncated: true` — it represents caller intent, not
   * silent data loss.
   *
   * Note: `until` runs alongside `scanUntilExhausted` and `maxItems`. The
   * loop terminates as soon as ANY of them say stop.
   */
  until?: (node: T, pageNodes: readonly T[], allNodes: readonly T[]) => boolean;
}

/**
 * Paginate a GraphQL connection query.
 *
 * @param executeQuery - Function that executes a GraphQL query with variables
 * @param query - The GraphQL query string (must include $cursor variable and pageInfo fragment)
 * @param variables - Variables for the query (cursor will be added/updated automatically)
 * @param connectionPath - Dot-separated path to the connection in the response (e.g., "node.projectV2.items")
 * @param options - Pagination options
 * @returns All accumulated nodes from all pages, plus a `truncated` flag.
 */
export async function paginateConnection<T>(
  executeQuery: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<unknown>,
  query: string,
  variables: Record<string, unknown>,
  connectionPath: string,
  options: PaginateOptions<T> = {},
): Promise<PaginatedResponse<T>> {
  const pageSize = options.pageSize ?? 100;
  const maxItems = options.maxItems ?? Infinity;
  const scanUntilExhausted = options.scanUntilExhausted ?? false;
  const until = options.until;

  const allNodes: T[] = [];
  let cursor: string | null = null;
  let totalCount: number | undefined;
  let truncated = false;
  let untilStopped = false;

  // When scanUntilExhausted is true, ignore the maxItems cap entirely.
  // Otherwise, use maxItems as the upper bound.
  const effectiveCap = scanUntilExhausted ? Infinity : maxItems;

  while (allNodes.length < effectiveCap) {
    // `first` is bounded by pageSize, but also by remaining capacity when a
    // finite cap is in play. Under scanUntilExhausted, cap is Infinity so we
    // always request a full page.
    const remaining = effectiveCap === Infinity
      ? pageSize
      : Math.min(pageSize, effectiveCap - allNodes.length);

    const queryVars = {
      ...variables,
      cursor,
      first: remaining,
    };

    const response = await executeQuery(query, queryVars);

    const connection = getNestedValue(response, connectionPath) as
      | {
          nodes: T[];
          pageInfo: PageInfo;
          totalCount?: number;
        }
      | undefined;

    if (!connection) {
      throw new Error(
        `Connection not found at path "${connectionPath}" in GraphQL response`,
      );
    }

    if (connection.totalCount !== undefined) {
      totalCount = connection.totalCount;
    }

    const pageNodes = connection.nodes;
    allNodes.push(...pageNodes);

    // Predicate-based early stop: evaluated AFTER appending the page so the
    // caller always gets the page that triggered the stop fully included.
    if (until) {
      for (const node of pageNodes) {
        if (!until(node, pageNodes, allNodes)) {
          untilStopped = true;
          break;
        }
      }
    }

    if (untilStopped) {
      break;
    }

    if (!connection.pageInfo.hasNextPage || !connection.pageInfo.endCursor) {
      break;
    }

    // Detect cap-without-exhaustion truncation: we filled to maxItems but the
    // connection still has more pages. Only meaningful when the caller is
    // using a finite cap and is NOT in scan-until-exhausted mode.
    if (
      !scanUntilExhausted &&
      maxItems !== Infinity &&
      allNodes.length >= maxItems &&
      connection.pageInfo.hasNextPage
    ) {
      truncated = true;
      const totalSuffix =
        totalCount !== undefined ? `, totalCount=${totalCount}` : "";
      console.warn(
        `paginateConnection: truncated at maxItems=${maxItems} for connectionPath="${connectionPath}"${totalSuffix}; more pages available but not fetched. Pass { scanUntilExhausted: true } to fetch all items.`,
      );
      break;
    }

    cursor = connection.pageInfo.endCursor;
  }

  return { nodes: allNodes, totalCount, truncated };
}
