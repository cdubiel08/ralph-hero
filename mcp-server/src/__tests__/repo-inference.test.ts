/**
 * Tests for resolveRepoFromProject() — repo inference from project-linked repositories.
 *
 * Uses a minimal mock GitHubClient to test all inference branches without API calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";

// We test via the source file structure (structural) since resolveRepoFromProject
// calls queryProjectRepositories which requires a real client. For unit testing
// the logic, we import directly and mock the dependency.

// Dynamic import to allow mocking
const helpersPath = "../lib/helpers.js";

describe("resolveRepoFromProject", () => {
  let mockClient: GitHubClient;
  let mockConfig: GitHubClientConfig;

  beforeEach(() => {
    mockConfig = {
      token: "tok",
      owner: "test-owner",
      projectNumber: 3,
      projectOwner: "test-owner",
    };

    mockClient = {
      config: mockConfig,
      query: vi.fn(),
      projectQuery: vi.fn(),
      projectMutate: vi.fn(),
      getCache: vi.fn(() => ({
        get: vi.fn(),
        set: vi.fn(),
        invalidateQueries: vi.fn(),
      })),
      getAuthenticatedUser: vi.fn(),
    } as unknown as GitHubClient;
  });

  it("returns immediately when client.config.repo is already set", async () => {
    mockConfig.repo = "existing-repo";

    const { resolveRepoFromProject } = await import(helpersPath);
    const result = await resolveRepoFromProject(mockClient);

    expect(result).toBe("existing-repo");
    // Should NOT have called projectQuery
    expect(mockClient.projectQuery).not.toHaveBeenCalled();
  });

  it("infers repo when exactly one repo is linked", async () => {
    // Mock projectQuery to return one repo
    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 1,
            nodes: [
              { owner: { login: "test-owner" }, name: "my-repo", nameWithOwner: "test-owner/my-repo" },
            ],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);
    const result = await resolveRepoFromProject(mockClient);

    expect(result).toBe("my-repo");
    expect(mockClient.config.repo).toBe("my-repo");
  });

  it("also sets owner when unset and one repo linked", async () => {
    mockConfig.owner = undefined;

    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 1,
            nodes: [
              { owner: { login: "inferred-owner" }, name: "my-repo", nameWithOwner: "inferred-owner/my-repo" },
            ],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);
    await resolveRepoFromProject(mockClient);

    expect(mockClient.config.owner).toBe("inferred-owner");
  });

  it("throws when zero repos are linked", async () => {
    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 0,
            nodes: [],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);

    await expect(resolveRepoFromProject(mockClient)).rejects.toThrow(
      "No repositories linked to project",
    );
  });

  it("warns and returns undefined when multiple repos are linked", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 2,
            nodes: [
              { owner: { login: "owner" }, name: "repo-a", nameWithOwner: "owner/repo-a" },
              { owner: { login: "owner" }, name: "repo-b", nameWithOwner: "owner/repo-b" },
            ],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);
    const result = await resolveRepoFromProject(mockClient);

    expect(result).toBeUndefined();
    expect(mockClient.config.repo).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Multiple repos linked to project: owner/repo-a, owner/repo-b"),
    );

    consoleSpy.mockRestore();
  });

  it("uses first registry repo as default when multiple repos linked and registry is set", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Attach a registry with two repos; first key is "repo-alpha"
    const { parseRepoRegistry } = await import("../lib/repo-registry.js");
    mockConfig.repoRegistry = parseRepoRegistry(`
version: 1
repos:
  repo-alpha:
    domain: platform
  repo-beta:
    domain: ui
`);

    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 2,
            nodes: [
              { owner: { login: "owner" }, name: "repo-alpha", nameWithOwner: "owner/repo-alpha" },
              { owner: { login: "owner" }, name: "repo-beta", nameWithOwner: "owner/repo-beta" },
            ],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);
    const result = await resolveRepoFromProject(mockClient);

    expect(result).toBe("repo-alpha");
    expect(mockClient.config.repo).toBe("repo-alpha");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Using "repo-alpha" as default (from .ralph-repos.yml)'),
    );

    consoleSpy.mockRestore();
  });

  it("sets owner from registry entry when owner unset and registry has owner", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { parseRepoRegistry } = await import("../lib/repo-registry.js");
    mockConfig.owner = undefined;
    mockConfig.projectOwner = "test-owner"; // needed for the query to proceed
    mockConfig.repoRegistry = parseRepoRegistry(`
version: 1
repos:
  my-repo:
    owner: registry-owner
    domain: platform
`);

    (mockClient.projectQuery as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: {
        projectV2: {
          id: "proj-id",
          repositories: {
            totalCount: 2,
            nodes: [
              { owner: { login: "registry-owner" }, name: "my-repo", nameWithOwner: "registry-owner/my-repo" },
              { owner: { login: "registry-owner" }, name: "other-repo", nameWithOwner: "registry-owner/other-repo" },
            ],
          },
        },
      },
    });

    const { resolveRepoFromProject } = await import(helpersPath);
    await resolveRepoFromProject(mockClient);

    expect(mockClient.config.repo).toBe("my-repo");
    expect(mockClient.config.owner).toBe("registry-owner");

    vi.restoreAllMocks();
  });

  it("throws when projectNumber is missing", async () => {
    mockConfig.projectNumber = undefined;

    const { resolveRepoFromProject } = await import(helpersPath);

    await expect(resolveRepoFromProject(mockClient)).rejects.toThrow(
      "Cannot infer repo",
    );
  });

  it("throws when projectOwner is missing", async () => {
    mockConfig.owner = undefined;
    mockConfig.projectOwner = undefined;

    const { resolveRepoFromProject } = await import(helpersPath);

    await expect(resolveRepoFromProject(mockClient)).rejects.toThrow(
      "Cannot infer repo",
    );
  });
});

describe("resolveRepoFromProject structural", () => {
  it("helpers.ts exports resolveRepoFromProject", async () => {
    const helpers = await import(helpersPath);
    expect(typeof helpers.resolveRepoFromProject).toBe("function");
  });

  it("index.ts imports resolveRepoFromProject", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, "../index.ts"),
      "utf-8",
    );
    expect(indexSrc).toContain('import { resolveRepoFromProject } from "./lib/helpers.js"');
  });

  it("index.ts calls resolveRepoFromProject during init", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, "../index.ts"),
      "utf-8",
    );
    expect(indexSrc).toContain("resolveRepoFromProject(client)");
  });

  it("resolveConfig error message mentions project linking", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const helpersSrc = fs.readFileSync(
      path.resolve(__dirname, "../lib/helpers.ts"),
      "utf-8",
    );
    expect(helpersSrc).toContain(
      "link exactly one repo to your project",
    );
  });
});

describe("resolveConfigOptionalRepo", () => {
  let mockClient: GitHubClient;
  let mockConfig: GitHubClientConfig;

  beforeEach(() => {
    mockConfig = {
      token: "tok",
      owner: "test-owner",
      projectNumber: 3,
      projectOwner: "test-owner",
    };

    mockClient = {
      config: mockConfig,
    } as unknown as GitHubClient;

    vi.resetModules();
  });

  it("returns owner and repo when both available", async () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = "test-repo";
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    const result = resolveConfigOptionalRepo(mockClient, {});
    expect(result).toEqual({ owner: "test-owner", repo: "test-repo" });
  });

  it("returns owner with undefined repo when repo not set", async () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = undefined;
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    const result = resolveConfigOptionalRepo(mockClient, {});
    expect(result).toEqual({ owner: "test-owner", repo: undefined });
  });

  it("prefers args over config", async () => {
    mockConfig.owner = "config-owner";
    mockConfig.repo = "config-repo";
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    const result = resolveConfigOptionalRepo(mockClient, { owner: "arg-owner", repo: "arg-repo" });
    expect(result).toEqual({ owner: "arg-owner", repo: "arg-repo" });
  });

  it("throws when owner is missing", async () => {
    mockConfig.owner = undefined;
    const { resolveConfigOptionalRepo } = await import(helpersPath);
    expect(() => resolveConfigOptionalRepo(mockClient, {})).toThrow("owner is required");
  });
});

describe("resolveFullConfigOptionalRepo", () => {
  let mockClient: GitHubClient;
  let mockConfig: GitHubClientConfig;

  beforeEach(() => {
    mockConfig = {
      token: "tok",
      owner: "test-owner",
      projectNumber: 3,
      projectOwner: "test-owner",
    };

    mockClient = {
      config: mockConfig,
    } as unknown as GitHubClient;

    vi.resetModules();
  });

  it("returns full config with optional repo undefined", async () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = undefined;
    mockConfig.projectNumber = 3;
    const { resolveFullConfigOptionalRepo } = await import(helpersPath);
    const result = resolveFullConfigOptionalRepo(mockClient, {});
    expect(result.owner).toBe("test-owner");
    expect(result.repo).toBeUndefined();
    expect(result.projectNumber).toBe(3);
    expect(result.projectOwner).toBeDefined();
  });

  it("returns full config with repo when available", async () => {
    mockConfig.owner = "test-owner";
    mockConfig.repo = "test-repo";
    mockConfig.projectNumber = 3;
    const { resolveFullConfigOptionalRepo } = await import(helpersPath);
    const result = resolveFullConfigOptionalRepo(mockClient, {});
    expect(result.owner).toBe("test-owner");
    expect(result.repo).toBe("test-repo");
    expect(result.projectNumber).toBe(3);
  });

  it("throws when projectNumber is missing", async () => {
    mockConfig.owner = "test-owner";
    mockConfig.projectNumber = undefined;
    const { resolveFullConfigOptionalRepo } = await import(helpersPath);
    expect(() => resolveFullConfigOptionalRepo(mockClient, {})).toThrow("projectNumber is required");
  });
});
