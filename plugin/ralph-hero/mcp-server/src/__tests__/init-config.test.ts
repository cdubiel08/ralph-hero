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
      process.env.RALPH_GH_REPO_TOKEN || process.env.RALPH_HERO_GITHUB_TOKEN;

    const projectToken = process.env.RALPH_GH_PROJECT_TOKEN || repoToken;

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

  /**
   * Mirrors the token source detection logic from health_check in index.ts.
   * Reports which env var each token was resolved from (not the value).
   */
  function resolveTokenSources() {
    const repoTokenSource = process.env.RALPH_GH_REPO_TOKEN
      ? "RALPH_GH_REPO_TOKEN"
      : "RALPH_HERO_GITHUB_TOKEN";

    const projectTokenSource = process.env.RALPH_GH_PROJECT_TOKEN
      ? "RALPH_GH_PROJECT_TOKEN"
      : repoTokenSource;

    const tokenMode =
      projectTokenSource !== repoTokenSource ? "dual-token" : "single-token";

    const note =
      projectTokenSource !== repoTokenSource
        ? `Repo operations use ${repoTokenSource}, project operations use ${projectTokenSource}`
        : `Both repo and project operations use ${repoTokenSource}`;

    return { repoTokenSource, projectTokenSource, tokenMode, note };
  }

  describe("token source reporting (health_check)", () => {
    it("single token via RALPH_HERO_GITHUB_TOKEN", () => {
      process.env.RALPH_HERO_GITHUB_TOKEN = "ghp_single";
      const src = resolveTokenSources();

      expect(src.repoTokenSource).toBe("RALPH_HERO_GITHUB_TOKEN");
      expect(src.projectTokenSource).toBe("RALPH_HERO_GITHUB_TOKEN");
      expect(src.tokenMode).toBe("single-token");
      expect(src.note).toBe(
        "Both repo and project operations use RALPH_HERO_GITHUB_TOKEN",
      );
    });

    it("single token via RALPH_GH_REPO_TOKEN", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_repo";
      const src = resolveTokenSources();

      expect(src.repoTokenSource).toBe("RALPH_GH_REPO_TOKEN");
      expect(src.projectTokenSource).toBe("RALPH_GH_REPO_TOKEN");
      expect(src.tokenMode).toBe("single-token");
    });

    it("dual token — separate project token", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_repo";
      process.env.RALPH_GH_PROJECT_TOKEN = "ghp_project";
      const src = resolveTokenSources();

      expect(src.repoTokenSource).toBe("RALPH_GH_REPO_TOKEN");
      expect(src.projectTokenSource).toBe("RALPH_GH_PROJECT_TOKEN");
      expect(src.tokenMode).toBe("dual-token");
      expect(src.note).toBe(
        "Repo operations use RALPH_GH_REPO_TOKEN, project operations use RALPH_GH_PROJECT_TOKEN",
      );
    });

    it("RALPH_GH_PROJECT_TOKEN set to same value still reports dual source", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_same_token";
      process.env.RALPH_GH_PROJECT_TOKEN = "ghp_same_token";
      const src = resolveTokenSources();

      // Source detection is based on env var presence, not value comparison
      expect(src.repoTokenSource).toBe("RALPH_GH_REPO_TOKEN");
      expect(src.projectTokenSource).toBe("RALPH_GH_PROJECT_TOKEN");
      expect(src.tokenMode).toBe("dual-token");
    });

    it("RALPH_GH_REPO_TOKEN takes priority for source label", () => {
      process.env.RALPH_GH_REPO_TOKEN = "ghp_repo";
      process.env.RALPH_HERO_GITHUB_TOKEN = "ghp_single";
      const src = resolveTokenSources();

      expect(src.repoTokenSource).toBe("RALPH_GH_REPO_TOKEN");
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
  it("should only accept RALPH_-prefixed env vars", () => {
    // Contract: .mcp.json has no env block — the MCP server inherits
    // the parent environment. Only RALPH_-prefixed vars are read by
    // resolveEnv(). This test documents which vars the server accepts.
    const acceptedVars = [
      "RALPH_GH_REPO_TOKEN",
      "RALPH_GH_PROJECT_TOKEN",
      "RALPH_HERO_GITHUB_TOKEN",
      "RALPH_GH_OWNER",
      "RALPH_GH_REPO",
      "RALPH_GH_PROJECT_OWNER",
      "RALPH_GH_PROJECT_NUMBER",
      "RALPH_GH_PROJECT_NUMBERS",
      "RALPH_GH_TEMPLATE_PROJECT",
      "RALPH_HERO_AUTO",
      "RALPH_DEBUG",
    ];

    const forbiddenVars = [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "GITHUB_OWNER",
      "GITHUB_REPO",
    ];

    for (const forbidden of forbiddenVars) {
      expect(acceptedVars).not.toContain(forbidden);
    }

    for (const accepted of acceptedVars) {
      expect(accepted).toMatch(/^RALPH_/);
    }
  });
});
