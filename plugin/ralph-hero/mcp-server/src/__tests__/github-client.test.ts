import { describe, it, expect, vi } from "vitest";
import { createGitHubClient } from "../github-client.js";

// Mock @octokit/graphql to avoid real API calls
vi.mock("@octokit/graphql", () => {
  const mockGraphql = vi
    .fn()
    .mockResolvedValue({ viewer: { login: "test-user" } });
  mockGraphql.defaults = vi.fn().mockReturnValue(mockGraphql);
  return { graphql: mockGraphql };
});

describe("createGitHubClient", () => {
  describe("single-token mode", () => {
    it("creates client with query and projectQuery methods", () => {
      const client = createGitHubClient({
        token: "single-token",
        owner: "org",
        repo: "repo",
      });

      expect(client.query).toBeTypeOf("function");
      expect(client.projectQuery).toBeTypeOf("function");
      expect(client.mutate).toBeTypeOf("function");
      expect(client.projectMutate).toBeTypeOf("function");
    });

    it("stores config correctly", () => {
      const client = createGitHubClient({
        token: "tok",
        owner: "org",
        repo: "repo",
        projectNumber: 3,
        projectOwner: "personal",
      });

      expect(client.config.owner).toBe("org");
      expect(client.config.projectOwner).toBe("personal");
      expect(client.config.projectNumber).toBe(3);
    });
  });

  describe("dual-token mode", () => {
    it("creates client with separate project token in config", () => {
      const client = createGitHubClient({
        token: "repo-token",
        projectToken: "project-token",
        owner: "org",
        repo: "repo",
      });

      expect(client.config.token).toBe("repo-token");
      expect(client.config.projectToken).toBe("project-token");
    });

    it("treats same token as single-token mode", () => {
      const client = createGitHubClient({
        token: "same-token",
        projectToken: "same-token",
        owner: "org",
        repo: "repo",
      });

      // Both methods should exist regardless
      expect(client.query).toBeTypeOf("function");
      expect(client.projectQuery).toBeTypeOf("function");
    });
  });
});

describe("GitHubClient config shape", () => {
  it("supports all new config fields", () => {
    const client = createGitHubClient({
      token: "repo-token",
      projectToken: "project-token",
      owner: "centerpoint-energy",
      repo: "my-repo",
      projectNumber: 3,
      projectOwner: "chad-a-dubiel_cpe",
    });

    expect(client.config).toEqual({
      token: "repo-token",
      projectToken: "project-token",
      owner: "centerpoint-energy",
      repo: "my-repo",
      projectNumber: 3,
      projectOwner: "chad-a-dubiel_cpe",
    });
  });

  it("works with minimal config (backward compatible)", () => {
    const client = createGitHubClient({
      token: "single-token",
    });

    expect(client.config.token).toBe("single-token");
    expect(client.config.projectToken).toBeUndefined();
    expect(client.config.projectOwner).toBeUndefined();
  });
});
