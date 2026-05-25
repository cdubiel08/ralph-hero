import { describe, it, expect } from "vitest";
import { resolveProjectOwner, type GitHubClientConfig } from "../types.js";

describe("resolveProjectOwner", () => {
  it("returns projectOwner when set", () => {
    const config: GitHubClientConfig = {
      token: "tok",
      owner: "org-owner",
      projectOwner: "personal-owner",
    };
    expect(resolveProjectOwner(config)).toBe("personal-owner");
  });

  it("falls back to owner when projectOwner is not set", () => {
    const config: GitHubClientConfig = {
      token: "tok",
      owner: "org-owner",
    };
    expect(resolveProjectOwner(config)).toBe("org-owner");
  });

  it("returns undefined when neither is set", () => {
    const config: GitHubClientConfig = {
      token: "tok",
    };
    expect(resolveProjectOwner(config)).toBeUndefined();
  });

  it("prefers projectOwner over owner", () => {
    const config: GitHubClientConfig = {
      token: "tok",
      owner: "centerpoint-energy",
      projectOwner: "chad-a-dubiel_cpe",
    };
    expect(resolveProjectOwner(config)).toBe("chad-a-dubiel_cpe");
  });
});
