/**
 * Tests for registry-loader and the repoRegistry field on GitHubClientConfig.
 *
 * The actual GitHub API fetch is integration-only; these tests focus on:
 * - GitHubClientConfig accepts repoRegistry (type-level + structural)
 * - repoRegistry is optional (undefined is valid)
 * - parseRepoRegistry + registry structure works for a known-valid config
 */

import { describe, it, expect } from "vitest";
import type { GitHubClientConfig } from "../types.js";
import { parseRepoRegistry } from "../lib/repo-registry.js";

describe("GitHubClientConfig.repoRegistry", () => {
  it("accepts a config without repoRegistry (field is optional)", () => {
    const config: GitHubClientConfig = {
      token: "tok",
      owner: "test-owner",
      projectNumber: 3,
    };
    // repoRegistry is optional — should not require it
    expect(config.repoRegistry).toBeUndefined();
  });

  it("accepts a config with repoRegistry set to a parsed registry", () => {
    const yaml = `
version: 1
repos:
  mcp-server:
    domain: platform
    tech: [typescript]
  frontend:
    domain: ui
    tech: [react]
`;
    const registry = parseRepoRegistry(yaml);

    const config: GitHubClientConfig = {
      token: "tok",
      owner: "test-owner",
      projectNumber: 3,
      repoRegistry: registry,
    };

    expect(config.repoRegistry).toBeDefined();
    expect(config.repoRegistry?.repos).toHaveProperty("mcp-server");
    expect(config.repoRegistry?.repos).toHaveProperty("frontend");
  });

  it("repoRegistry can be set and cleared on a mutable config object", () => {
    const config: GitHubClientConfig = {
      token: "tok",
    };

    expect(config.repoRegistry).toBeUndefined();

    const yaml = `
version: 1
repos:
  api:
    domain: backend
`;
    config.repoRegistry = parseRepoRegistry(yaml);
    expect(config.repoRegistry).toBeDefined();
    expect(Object.keys(config.repoRegistry!.repos)).toContain("api");

    config.repoRegistry = undefined;
    expect(config.repoRegistry).toBeUndefined();
  });
});

describe("parseRepoRegistry integration with registry-loader", () => {
  it("parses a full valid registry config with repos and patterns", () => {
    const yaml = `
version: 1
repos:
  mcp-server:
    owner: cdubiel08
    domain: platform
    tech: [typescript, node]
    defaults:
      labels: [backend]
      estimate: S
    paths: [plugin/ralph-hero/mcp-server]
  frontend:
    domain: ui
    tech: [react]
patterns:
  full-stack-feature:
    description: "Frontend + backend change"
    decomposition:
      - repo: mcp-server
        role: Add API endpoint
      - repo: frontend
        role: Build UI
    dependency-flow:
      - mcp-server -> frontend
`;
    const registry = parseRepoRegistry(yaml);

    expect(registry.version).toBe(1);
    expect(Object.keys(registry.repos)).toHaveLength(2);

    const mcpEntry = registry.repos["mcp-server"];
    expect(mcpEntry.owner).toBe("cdubiel08");
    expect(mcpEntry.domain).toBe("platform");
    expect(mcpEntry.tech).toEqual(["typescript", "node"]);
    expect(mcpEntry.defaults?.labels).toEqual(["backend"]);
    expect(mcpEntry.defaults?.estimate).toBe("S");
    expect(mcpEntry.paths).toEqual(["plugin/ralph-hero/mcp-server"]);

    expect(registry.patterns).toBeDefined();
    const pattern = registry.patterns!["full-stack-feature"];
    expect(pattern.description).toBe("Frontend + backend change");
    expect(pattern.decomposition).toHaveLength(2);
    expect(pattern.decomposition[0]).toEqual({
      repo: "mcp-server",
      role: "Add API endpoint",
    });
    expect(pattern["dependency-flow"]).toEqual(["mcp-server -> frontend"]);
  });

  it("parses a minimal registry with only one repo and no patterns", () => {
    const yaml = `
version: 1
repos:
  core:
    domain: infra
`;
    const registry = parseRepoRegistry(yaml);
    expect(registry.version).toBe(1);
    expect(Object.keys(registry.repos)).toHaveLength(1);
    expect(registry.repos["core"].domain).toBe("infra");
    expect(registry.patterns).toBeUndefined();
  });
});

describe("registry-loader module structure", () => {
  it("exports loadRepoRegistry function", async () => {
    const { loadRepoRegistry } = await import("../lib/registry-loader.js");
    expect(typeof loadRepoRegistry).toBe("function");
  });

  it("index.ts imports loadRepoRegistry during startup", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, "../index.ts"),
      "utf-8",
    );
    expect(indexSrc).toContain("loadRepoRegistry");
    expect(indexSrc).toContain("registry-loader.js");
  });

  it("index.ts stores registry on client.config.repoRegistry", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, "../index.ts"),
      "utf-8",
    );
    expect(indexSrc).toContain("client.config.repoRegistry = registry");
  });
});
