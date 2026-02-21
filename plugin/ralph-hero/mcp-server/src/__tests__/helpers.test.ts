import { describe, it, expect } from "vitest";
import { resolveFullConfig } from "../lib/helpers.js";
import type { GitHubClient } from "../github-client.js";
import type { GitHubClientConfig } from "../types.js";

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
