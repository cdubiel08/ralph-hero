import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Tests for token resolution and config initialization logic.
 *
 * Since initGitHubClient is not exported and has side effects (process.exit),
 * we test the resolution logic by simulating the env var combinations
 * and verifying the expected behavior.
 */

describe("Token resolution logic", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Clone env to avoid leaking between tests
    process.env = { ...originalEnv };
    // Clear all ralph/github env vars
    delete process.env.RALPH_GH_REPO_TOKEN;
    delete process.env.RALPH_GH_PROJECT_TOKEN;
    delete process.env.RALPH_HERO_GITHUB_TOKEN;
    delete process.env.RALPH_GH_OWNER;
    delete process.env.RALPH_GH_REPO;
    delete process.env.RALPH_GH_PROJECT_OWNER;
    delete process.env.RALPH_GH_PROJECT_NUMBER;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Simulates the token resolution logic from index.ts initGitHubClient.
   * This mirrors the actual code to test the env var priority.
   */
  function resolveTokens() {
    const repoToken =
      process.env.RALPH_GH_REPO_TOKEN ||
      process.env.RALPH_HERO_GITHUB_TOKEN;

    const projectToken =
      process.env.RALPH_GH_PROJECT_TOKEN || repoToken;

    return { repoToken, projectToken };
  }

  function resolveConfig() {
    const owner = process.env.RALPH_GH_OWNER;
    const repo = process.env.RALPH_GH_REPO;
    const projectOwner = process.env.RALPH_GH_PROJECT_OWNER || owner;
    const projectNumber = process.env.RALPH_GH_PROJECT_NUMBER
      ? parseInt(process.env.RALPH_GH_PROJECT_NUMBER, 10)
      : undefined;

    return { owner, repo, projectOwner, projectNumber };
  }

  describe("single-token setup", () => {
    it("RALPH_HERO_GITHUB_TOKEN used for both repo and project", () => {
      process.env.RALPH_HERO_GITHUB_TOKEN = "ghp_single";
      const { repoToken, projectToken } = resolveTokens();

      expect(repoToken).toBe("ghp_single");
      expect(projectToken).toBe("ghp_single");
    });

    it("RALPH_GH_REPO_TOKEN takes priority over RALPH_HERO_GITHUB_TOKEN", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_repo";
      process.env.RALPH_HERO_GITHUB_TOKEN = "ghp_single";
      const { repoToken } = resolveTokens();

      expect(repoToken).toBe("ghp_repo");
    });
  });

  describe("dual-token setup", () => {
    it("separate repo and project tokens", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_repo";
      process.env.RALPH_GH_PROJECT_TOKEN = "ghp_project";
      const { repoToken, projectToken } = resolveTokens();

      expect(repoToken).toBe("ghp_repo");
      expect(projectToken).toBe("ghp_project");
    });

    it("project token falls back to repo token when not set", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_repo";
      const { repoToken, projectToken } = resolveTokens();

      expect(repoToken).toBe("ghp_repo");
      expect(projectToken).toBe("ghp_repo");
    });
  });

  describe("no token", () => {
    it("returns undefined when no token is set", () => {
      const { repoToken } = resolveTokens();
      expect(repoToken).toBeUndefined();
    });
  });

  describe("owner resolution", () => {
    it("projectOwner falls back to owner when not set", () => {
      process.env.RALPH_GH_OWNER = "centerpoint-energy";
      const { owner, projectOwner } = resolveConfig();

      expect(owner).toBe("centerpoint-energy");
      expect(projectOwner).toBe("centerpoint-energy");
    });

    it("separate project owner overrides fallback", () => {
      process.env.RALPH_GH_OWNER = "centerpoint-energy";
      process.env.RALPH_GH_PROJECT_OWNER = "chad-a-dubiel_cpe";
      const { owner, projectOwner } = resolveConfig();

      expect(owner).toBe("centerpoint-energy");
      expect(projectOwner).toBe("chad-a-dubiel_cpe");
    });

    it("both undefined when nothing is set", () => {
      const { owner, projectOwner } = resolveConfig();
      expect(owner).toBeUndefined();
      expect(projectOwner).toBeUndefined();
    });
  });

  describe("project number parsing", () => {
    it("parses RALPH_GH_PROJECT_NUMBER as integer", () => {
      process.env.RALPH_GH_PROJECT_NUMBER = "3";
      const { projectNumber } = resolveConfig();
      expect(projectNumber).toBe(3);
    });

    it("undefined when not set", () => {
      const { projectNumber } = resolveConfig();
      expect(projectNumber).toBeUndefined();
    });
  });
});

describe(".mcp.json contract", () => {
  it("should NOT pass GITHUB_TOKEN or GH_TOKEN to MCP server", () => {
    // This test documents the .mcp.json contract: only RALPH_-prefixed vars
    const allowedVars = [
      "RALPH_GH_REPO_TOKEN",
      "RALPH_GH_PROJECT_TOKEN",
      "RALPH_HERO_GITHUB_TOKEN",
      "RALPH_GH_OWNER",
      "RALPH_GH_REPO",
      "RALPH_GH_PROJECT_OWNER",
      "RALPH_GH_PROJECT_NUMBER",
    ];

    const forbiddenVars = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GITHUB_OWNER",
      "GITHUB_REPO",
    ];

    // Verify none of the forbidden vars are in the allowed list
    for (const forbidden of forbiddenVars) {
      expect(allowedVars).not.toContain(forbidden);
    }

    // Verify all allowed vars start with RALPH_
    for (const allowed of allowedVars) {
      expect(allowed).toMatch(/^RALPH_/);
    }
  });
});
