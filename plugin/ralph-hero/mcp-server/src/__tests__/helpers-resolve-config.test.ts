import { describe, it, expect } from "vitest";
import { resolveConfig, resolveConfigOptionalRepo } from "../lib/helpers.js";
import type { GitHubClient } from "../github-client.js";

function mockClient(overrides: Partial<GitHubClient["config"]> = {}): GitHubClient {
  return {
    config: {
      token: "fake",
      ...overrides,
    },
  } as unknown as GitHubClient;
}

describe("resolveConfig", () => {
  it("throws with scope-aware message when owner is missing", () => {
    const client = mockClient({ owner: undefined });
    expect(() => resolveConfig(client, {})).toThrow(
      "owner is required",
    );
    expect(() => resolveConfig(client, {})).toThrow(
      "~/.claude/settings.json",
    );
  });
});

describe("resolveConfigOptionalRepo", () => {
  it("throws with scope-aware message when owner is missing", () => {
    const client = mockClient({ owner: undefined });
    expect(() => resolveConfigOptionalRepo(client, {})).toThrow(
      "owner is required",
    );
    expect(() => resolveConfigOptionalRepo(client, {})).toThrow(
      "~/.claude/settings.json",
    );
  });
});
