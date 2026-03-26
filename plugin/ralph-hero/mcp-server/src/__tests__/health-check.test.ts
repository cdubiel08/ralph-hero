import { describe, it, expect, vi } from "vitest";
import { runHealthCheck } from "../lib/health-check.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function mockClient(
  overrides: Partial<GitHubClientConfig> = {},
  methods: {
    getAuthenticatedUser?: () => Promise<string>;
    query?: (...args: unknown[]) => Promise<unknown>;
    projectQuery?: (...args: unknown[]) => Promise<unknown>;
  } = {},
): GitHubClient {
  const config: GitHubClientConfig = {
    token: "ghp_test_token",
    owner: "test-owner",
    repo: "test-repo",
    projectNumber: 3,
    projectOwner: "test-owner",
    ...overrides,
  };

  return {
    config,
    getAuthenticatedUser:
      methods.getAuthenticatedUser ??
      vi.fn().mockResolvedValue("test-user"),
    query:
      methods.query ??
      vi.fn().mockResolvedValue({
        repository: { nameWithOwner: "test-owner/test-repo" },
      }),
    projectQuery:
      methods.projectQuery ??
      vi.fn().mockResolvedValue({
        user: {
          projectV2: {
            title: "Test Project",
            fields: {
              nodes: [
                { name: "Workflow State" },
                { name: "Priority" },
                { name: "Estimate" },
              ],
            },
          },
        },
      }),
  } as unknown as GitHubClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runHealthCheck", () => {
  describe("happy path", () => {
    it("returns ok status with all checks green", async () => {
      const client = mockClient();
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.status).toBe("ok");
      expect(result.checks.auth.status).toBe("ok");
      expect(result.checks.repoAccess.status).toBe("ok");
      expect(result.checks.projectAccess.status).toBe("ok");
      expect(result.checks.requiredFields.status).toBe("ok");
    });

    it("includes tokenSource in config output", async () => {
      const client = mockClient();
      const result = await runHealthCheck(client, "RALPH_GH_REPO_TOKEN");

      expect(result.config.tokenSource).toBe("RALPH_GH_REPO_TOKEN");
    });

    it("reports dual-token mode when project token differs", async () => {
      const client = mockClient({ projectToken: "different-token" });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.config.tokenMode).toBe("dual-token");
    });
  });

  describe("auth failures", () => {
    it("auth failure returns fail with error message", async () => {
      const client = mockClient({}, {
        getAuthenticatedUser: vi.fn().mockRejectedValue(new Error("Bad credentials")),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.status).toBe("issues_found");
      expect(result.checks.auth.status).toBe("fail");
      expect(result.checks.auth.detail).toContain("Bad credentials");
    });
  });

  describe("scope-specific messages", () => {
    it("repo access failure with auth success gives scope-specific message", async () => {
      const client = mockClient({}, {
        query: vi.fn().mockRejectedValue(new Error("Not found")),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.repoAccess.status).toBe("fail");
      expect(result.checks.repoAccess.detail).toContain("Authenticated successfully");
      expect(result.checks.repoAccess.detail).toContain("'repo' scope");
    });

    it("project access failure with auth success gives scope-specific message", async () => {
      const client = mockClient({}, {
        projectQuery: vi.fn().mockRejectedValue(new Error("Forbidden")),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.projectAccess.status).toBe("fail");
      expect(result.checks.projectAccess.detail).toContain("Authenticated successfully");
      expect(result.checks.projectAccess.detail).toContain("'project' scope");
    });
  });

  describe("missing fields", () => {
    it("missing required fields reports which fields are missing", async () => {
      const client = mockClient({}, {
        projectQuery: vi.fn().mockResolvedValue({
          user: {
            projectV2: {
              title: "Partial Project",
              fields: {
                nodes: [{ name: "Workflow State" }],
              },
            },
          },
        }),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.requiredFields.status).toBe("fail");
      expect(result.checks.requiredFields.detail).toContain("Priority");
      expect(result.checks.requiredFields.detail).toContain("Estimate");
    });
  });

  describe("skip behavior", () => {
    it("skips repo access when owner/repo not set", async () => {
      const client = mockClient({ owner: undefined, repo: undefined });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.repoAccess.status).toBe("skip");
    });

    it("skips project access when project number not set", async () => {
      const client = mockClient({ projectNumber: undefined });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.projectAccess.status).toBe("skip");
    });

    it("skipped checks count as ok in summary", async () => {
      const client = mockClient({
        owner: undefined,
        repo: undefined,
        projectNumber: undefined,
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.status).toBe("ok");
    });
  });

  describe("project not found", () => {
    it("project not found after trying user and org", async () => {
      const client = mockClient({}, {
        projectQuery: vi.fn().mockResolvedValue({
          user: { projectV2: null },
        }),
      });
      const result = await runHealthCheck(client, "RALPH_HERO_GITHUB_TOKEN");

      expect(result.checks.projectAccess.status).toBe("fail");
      expect(result.checks.projectAccess.detail).toContain("not found");
      expect(result.checks.projectAccess.detail).toContain("RALPH_GH_PROJECT_OWNER");
    });
  });
});
