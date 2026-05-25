/**
 * Tests for `paginateConnection` and the new GH-1171 options:
 *   - `scanUntilExhausted`: ignore `maxItems`, paginate until exhaustion.
 *   - `until`: per-node predicate for early stop at page boundaries.
 *   - `truncated`: return-shape flag set when `maxItems` was hit while
 *     `hasNextPage` was still true. A `console.warn` also fires.
 *
 * Existing behavior (loops until `maxItems` or exhaustion, accumulates
 * `totalCount` from the first page) must remain byte-identical for callers
 * that only pass `pageSize`/`maxItems`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { paginateConnection } from "../lib/pagination.js";
import type { PaginateOptions } from "../lib/pagination.js";

interface TestNode {
  id: number;
}

interface MockPage {
  nodes: TestNode[];
  hasNextPage: boolean;
  totalCount?: number;
}

/**
 * Build a vi.fn that returns `pages` in order, each shaped as the
 * connection-path response expected by `paginateConnection`. The connection
 * is reachable at path `node.items` to mirror the real Projects V2 query.
 */
function makeMockConnectionResponse(pages: MockPage[]) {
  let callCount = 0;
  return vi.fn(async (_query: string, _vars: Record<string, unknown>) => {
    const page = pages[callCount];
    callCount += 1;
    if (!page) {
      throw new Error(
        `Mock exhausted: caller asked for page ${callCount} but only ${pages.length} were provided`,
      );
    }
    return {
      node: {
        items: {
          totalCount: page.totalCount,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            endCursor: page.hasNextPage ? `cursor-${callCount}` : null,
          },
          nodes: page.nodes,
        },
      },
    };
  });
}

function makeNodes(start: number, count: number): TestNode[] {
  return Array.from({ length: count }, (_, i) => ({ id: start + i }));
}

describe("paginateConnection", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("existing behavior preserved", () => {
    it("paginates until exhaustion when only pageSize is set", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 350 },
        { nodes: makeNodes(101, 100), hasNextPage: true },
        { nodes: makeNodes(201, 100), hasNextPage: true },
        { nodes: makeNodes(301, 50), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
      );

      expect(result.nodes).toHaveLength(350);
      expect(result.totalCount).toBe(350);
      expect(result.truncated).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("respects pageSize when fetching", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 50), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { pageSize: 50 },
      );

      expect(exec).toHaveBeenCalledTimes(1);
      // Second arg is the query variables. `first` should be the pageSize.
      const firstCallVars = exec.mock.calls[0]![1] as { first: number };
      expect(firstCallVars.first).toBe(50);
    });

    it("captures totalCount from first page and preserves it across pages", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 734 },
        // totalCount intentionally absent on subsequent pages
        { nodes: makeNodes(101, 100), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
      );

      expect(result.totalCount).toBe(734);
    });

    it("throws when connectionPath is missing in response", async () => {
      const exec = vi.fn(async () => ({}));

      await expect(
        paginateConnection<TestNode>(exec, "query", {}, "node.items"),
      ).rejects.toThrow(/Connection not found at path "node.items"/);
    });
  });

  describe("truncation signal (cap-without-exhaustion)", () => {
    it("stops at maxItems and sets truncated: true when more pages exist", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 500 },
        { nodes: makeNodes(101, 100), hasNextPage: true },
        // Third page would exist but caller's cap of 200 means we stop here.
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { maxItems: 200 },
      );

      expect(result.nodes).toHaveLength(200);
      expect(result.truncated).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0]![0];
      expect(warnMessage).toContain("node.items");
      expect(warnMessage).toContain("maxItems=200");
      expect(warnMessage).toContain("totalCount=500");
    });

    it("stops at maxItems and sets truncated: false when connection exhausts at the cap", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 200 },
        { nodes: makeNodes(101, 100), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { maxItems: 200 },
      );

      expect(result.nodes).toHaveLength(200);
      expect(result.truncated).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("emits warning without totalCount suffix when first page lacks totalCount", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true },
        { nodes: makeNodes(101, 100), hasNextPage: true },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { maxItems: 200 },
      );

      expect(result.truncated).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = warnSpy.mock.calls[0]![0] as string;
      expect(warnMessage).not.toContain("totalCount=");
    });
  });

  describe("scanUntilExhausted: true", () => {
    it("ignores maxItems and fetches until hasNextPage is false", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 450 },
        { nodes: makeNodes(101, 100), hasNextPage: true },
        { nodes: makeNodes(201, 100), hasNextPage: true },
        { nodes: makeNodes(301, 100), hasNextPage: true },
        { nodes: makeNodes(401, 50), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { maxItems: 200, scanUntilExhausted: true },
      );

      expect(result.nodes).toHaveLength(450);
      expect(result.truncated).toBe(false);
      expect(exec).toHaveBeenCalledTimes(5);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("works without maxItems (default Infinity cap) and exhausts the connection", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 150 },
        { nodes: makeNodes(101, 50), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { scanUntilExhausted: true },
      );

      expect(result.nodes).toHaveLength(150);
      expect(result.truncated).toBe(false);
    });

    it("requests full pageSize even when in scanUntilExhausted mode (no remaining-cap math)", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { pageSize: 100, maxItems: 50, scanUntilExhausted: true },
      );

      const firstCallVars = exec.mock.calls[0]![1] as { first: number };
      // Should request the full pageSize, not the smaller maxItems.
      expect(firstCallVars.first).toBe(100);
    });
  });

  describe("until predicate", () => {
    it("stops early after the page that triggered the predicate", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 300 },
        { nodes: makeNodes(101, 100), hasNextPage: true },
        // Page 3 must NOT be fetched because page 2 contains node 150 which trips the predicate.
        { nodes: makeNodes(201, 100), hasNextPage: false },
      ];
      const exec = makeMockConnectionResponse(pages);

      const options: PaginateOptions<TestNode> = {
        until: (node) => node.id < 150,
      };

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        options,
      );

      // Page 1 (1..100) and page 2 (101..200) both fully appended;
      // page 3 not fetched. The predicate triggered mid-page-2 but the
      // remaining nodes from that page are still kept (page-boundary stop).
      expect(result.nodes).toHaveLength(200);
      expect(result.nodes[result.nodes.length - 1]!.id).toBe(200);
      expect(result.truncated).toBe(false);
      expect(exec).toHaveBeenCalledTimes(2);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("runs to exhaustion when predicate never returns false", async () => {
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 50), hasNextPage: false, totalCount: 50 },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { until: () => true },
      );

      expect(result.nodes).toHaveLength(50);
      expect(result.truncated).toBe(false);
    });

    it("does NOT mark truncated when predicate stops mid-connection", async () => {
      // This is the explicit semantic: `until` is caller intent, not silent
      // truncation. Even if more pages exist, `truncated` stays false.
      const pages: MockPage[] = [
        { nodes: makeNodes(1, 100), hasNextPage: true, totalCount: 1000 },
      ];
      const exec = makeMockConnectionResponse(pages);

      const result = await paginateConnection<TestNode>(
        exec,
        "query",
        {},
        "node.items",
        { until: (node) => node.id < 50 },
      );

      expect(result.truncated).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
