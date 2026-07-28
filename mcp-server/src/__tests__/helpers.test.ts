import { describe, it, expect, vi } from "vitest";
import { resolveFullConfig, getFieldValueDetail, getCurrentFieldValue } from "../lib/helpers.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";
import { FieldOptionCache } from "../lib/cache.js";

function mockClient(config: Partial<GitHubClientConfig>): GitHubClient {
  return {
    config: {
      token: "test-token",
      owner: "test-owner",
      repo: "test-repo",
      projectNumber: 3,
      projectOwner: "test-owner",
      ...config,
    },
  } as unknown as GitHubClient;
}

describe("resolveFullConfig", () => {
  it("uses client.config.projectNumber when args has no projectNumber", () => {
    const client = mockClient({ projectNumber: 3 });
    const result = resolveFullConfig(client, {});
    expect(result.projectNumber).toBe(3);
  });

  it("uses args.projectNumber when provided (override)", () => {
    const client = mockClient({ projectNumber: 3 });
    const result = resolveFullConfig(client, { projectNumber: 7 });
    expect(result.projectNumber).toBe(7);
  });

  it("falls back to client.config.projectNumber when args.projectNumber is undefined", () => {
    const client = mockClient({ projectNumber: 5 });
    const result = resolveFullConfig(client, { projectNumber: undefined });
    expect(result.projectNumber).toBe(5);
  });

  it("throws when no projectNumber available anywhere", () => {
    const client = mockClient({ projectNumber: undefined });
    expect(() => resolveFullConfig(client, {})).toThrow(
      /projectNumber is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// getFieldValueDetail / getCurrentFieldValue (GH-1616)
// ---------------------------------------------------------------------------

describe("getFieldValueDetail", () => {
  interface DetailMockOpts {
    fieldValueNode?: Record<string, unknown> | null;
    failOnCreatorField?: boolean;
    failFieldValueQueryAlways?: boolean;
  }

  function makeDetailMockClient(opts: DetailMockOpts): { client: GitHubClient; query: ReturnType<typeof vi.fn> } {
    const cacheStore = new Map<string, { value: unknown; expiry: number }>();
    const query = vi.fn(async (q: string) => {
      if (q.includes("... on Issue {") && q.includes("projectItems(first:")) {
        return { node: { projectItems: { nodes: [{ id: "item-1", project: { id: "proj-1" } }] } } };
      }
      if (q.includes("repository(owner:") && q.includes("issue(number:")) {
        return { repository: { issue: { id: "issue-node-1" } } };
      }
      if (q.includes("... on ProjectV2Item {") && q.includes("fieldValues(first: 20)")) {
        if (opts.failFieldValueQueryAlways) {
          throw new Error("transient API error");
        }
        if (opts.failOnCreatorField && q.includes("creator { login }")) {
          throw new Error("simulated: creator field not readable by this token");
        }
        const nodes = opts.fieldValueNode ? [opts.fieldValueNode] : [];
        return { node: { fieldValues: { nodes } } };
      }
      throw new Error(`Unmocked query: ${q.slice(0, 80)}`);
    });

    const client = {
      config: { token: "t", owner: "o", repo: "r", projectNumber: 1, projectOwner: "o" },
      query,
      // getFieldValueDetail reads ProjectV2Item field values through the
      // PROJECT endpoint (split-token setups route project reads to
      // RALPH_GH_PROJECT_TOKEN), so the detail-shape mocks above must be
      // reachable from here too.
      projectQuery: vi.fn(query),
      mutate: vi.fn(),
      projectMutate: vi.fn(),
      getCache: () => ({
        get: <T>(key: string): T | undefined => {
          const entry = cacheStore.get(key);
          if (!entry || Date.now() > entry.expiry) return undefined;
          return entry.value as T;
        },
        set: (key: string, value: unknown, ttlMs?: number) => {
          cacheStore.set(key, { value, expiry: Date.now() + (ttlMs ?? 30 * 60 * 1000) });
        },
        invalidatePrefix: () => {},
      }),
    } as unknown as GitHubClient;

    return { client, query, projectQuery: client.projectQuery as ReturnType<typeof vi.fn> };
  }

  function makeDetailFieldCache(): FieldOptionCache {
    const cache = new FieldOptionCache();
    cache.populate(1, "proj-1", []);
    return cache;
  }

  it("parses name, updatedAt, and creator from the field value", async () => {
    const { client } = makeDetailMockClient({
      fieldValueNode: {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        name: "In Progress",
        updatedAt: "2026-07-26T10:00:00Z",
        creator: { login: "cdubiel08" },
        field: { name: "Workflow State" },
      },
    });
    const detail = await getFieldValueDetail(client, makeDetailFieldCache(), "o", "r", 42, "Workflow State", 1);
    expect(detail).toEqual({ name: "In Progress", updatedAt: "2026-07-26T10:00:00Z", creator: "cdubiel08" });
  });

  // Split-token setups (RALPH_GH_PROJECT_TOKEN) route project reads to a
  // different credential than repo reads. A ProjectV2Item field-value read
  // issued on the repo endpoint fails there, taking the lock guard and the
  // stale-lock clock down with it.
  it("issues the ProjectV2Item field-value read on the PROJECT endpoint", async () => {
    const { client, projectQuery } = makeDetailMockClient({
      fieldValueNode: {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        name: "In Progress",
        updatedAt: "2026-07-26T10:00:00Z",
        field: { name: "Workflow State" },
      },
    });
    await getFieldValueDetail(client, makeDetailFieldCache(), "o", "r", 42, "Workflow State", 1);
    const projectCalls = projectQuery.mock.calls.filter(([q]: [string]) =>
      q.includes("... on ProjectV2Item {") && q.includes("fieldValues(first: 20)"),
    );
    expect(projectCalls.length).toBeGreaterThan(0);
  });

  it("returns an empty detail when the field genuinely has no value (not a fetch failure)", async () => {
    const { client } = makeDetailMockClient({ fieldValueNode: null });
    const detail = await getFieldValueDetail(client, makeDetailFieldCache(), "o", "r", 42, "Workflow State", 1);
    expect(detail.name).toBeUndefined();
    expect(detail.updatedAt).toBeUndefined();
    expect(detail.creator).toBeUndefined();
  });

  it("tolerates a token that cannot read `creator`: degrades to name+updatedAt", async () => {
    const { client, query } = makeDetailMockClient({
      failOnCreatorField: true,
      fieldValueNode: {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        name: "In Progress",
        updatedAt: "2026-07-26T10:00:00Z",
        field: { name: "Workflow State" },
      },
    });
    const detail = await getFieldValueDetail(client, makeDetailFieldCache(), "o", "r", 42, "Workflow State", 1);
    expect(detail.name).toBe("In Progress");
    expect(detail.updatedAt).toBe("2026-07-26T10:00:00Z");
    expect(detail.creator).toBeUndefined();
    // Two field-value attempts: with creator (fails), then without (succeeds).
    const fieldValueCalls = query.mock.calls.filter(
      ([q]: unknown[]) => typeof q === "string" && q.includes("fieldValues(first: 20)"),
    );
    expect(fieldValueCalls).toHaveLength(2);
  });

  it("propagates a real fetch failure (fetchFailed, not genuinely-unset) rather than degrading forever", async () => {
    const { client } = makeDetailMockClient({ failFieldValueQueryAlways: true });
    await expect(
      getFieldValueDetail(client, makeDetailFieldCache(), "o", "r", 42, "Workflow State", 1),
    ).rejects.toThrow(/transient API error/);
  });

  it("getCurrentFieldValue delegates to getFieldValueDetail and returns just the name", async () => {
    const { client } = makeDetailMockClient({
      fieldValueNode: {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        name: "Ready for Plan",
        field: { name: "Workflow State" },
      },
    });
    const value = await getCurrentFieldValue(client, makeDetailFieldCache(), "o", "r", 42, "Workflow State", 1);
    expect(value).toBe("Ready for Plan");
  });
});
