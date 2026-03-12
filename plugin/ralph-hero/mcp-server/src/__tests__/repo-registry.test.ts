import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  RepoRegistrySchema,
  parseRepoRegistry,
  lookupRepo,
  lookupPattern,
  mergeDefaults,
} from "../lib/repo-registry.js";

// ---------------------------------------------------------------------------
// Schema Validation
// ---------------------------------------------------------------------------

describe("RepoRegistrySchema", () => {
  it("accepts a minimal valid registry", () => {
    const data = {
      version: 1,
      repos: {
        "my-repo": { domain: "platform" },
      },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.version).toBe(1);
    expect(result.data.repos["my-repo"].domain).toBe("platform");
  });

  it("accepts a full registry with patterns", () => {
    const data = {
      version: 1,
      repos: {
        "mcp-server": {
          owner: "cdubiel08",
          domain: "platform",
          tech: ["typescript", "node"],
          defaults: {
            labels: ["backend"],
            assignees: ["cdubiel08"],
            estimate: "S",
          },
          paths: ["plugin/ralph-hero/mcp-server"],
        },
        frontend: {
          domain: "ui",
          tech: ["react"],
        },
      },
      patterns: {
        "full-stack-feature": {
          description: "Frontend + backend change",
          decomposition: [
            { repo: "mcp-server", role: "Add API endpoint" },
            { repo: "frontend", role: "Build UI" },
          ],
          "dependency-flow": ["mcp-server -> frontend"],
        },
      },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(Object.keys(result.data.repos)).toHaveLength(2);
    expect(result.data.patterns?.["full-stack-feature"].decomposition).toHaveLength(2);
    expect(result.data.patterns?.["full-stack-feature"]["dependency-flow"]).toEqual([
      "mcp-server -> frontend",
    ]);
  });

  it("accepts a registry with localDir on repo entries", () => {
    const data = {
      version: 1,
      repos: {
        "ralph-hero": {
          localDir: "~/projects/ralph-hero",
          domain: "platform",
          tech: ["typescript"],
          paths: ["plugin/ralph-hero/mcp-server"],
        },
        "landcrawler-ai": {
          localDir: "~/projects/landcrawler-ai",
          domain: "backend",
        },
      },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("expected success");
    expect(result.data.repos["ralph-hero"].localDir).toBe("~/projects/ralph-hero");
    expect(result.data.repos["landcrawler-ai"].localDir).toBe("~/projects/landcrawler-ai");
  });

  it("rejects a registry missing version", () => {
    const data = {
      repos: { "my-repo": { domain: "platform" } },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues.some((i) => i.path.includes("version"))).toBe(true);
  });

  it("rejects a registry with empty repos", () => {
    const data = {
      version: 1,
      repos: {},
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(result.error.issues.some((i) => i.path.includes("repos"))).toBe(true);
  });

  it("rejects a repo entry missing domain", () => {
    const data = {
      version: 1,
      repos: {
        "bad-repo": { tech: ["typescript"] },
      },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(
      result.error.issues.some((i) => i.path.join(".").includes("domain")),
    ).toBe(true);
  });

  it("rejects a pattern with an empty decomposition array", () => {
    const data = {
      version: 1,
      repos: { "my-repo": { domain: "platform" } },
      patterns: {
        "empty-pattern": {
          description: "A pattern with no steps",
          decomposition: [],
        },
      },
    };
    const result = RepoRegistrySchema.safeParse(data);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected failure");
    expect(
      result.error.issues.some((i) => i.path.join(".").includes("decomposition")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseRepoRegistry
// ---------------------------------------------------------------------------

describe("parseRepoRegistry", () => {
  it("parses a valid YAML string", () => {
    const yaml = `
version: 1
repos:
  mcp-server:
    domain: platform
    tech:
      - typescript
    defaults:
      labels:
        - backend
`;
    const registry = parseRepoRegistry(yaml);
    expect(registry.version).toBe(1);
    expect(registry.repos["mcp-server"].domain).toBe("platform");
    expect(registry.repos["mcp-server"].tech).toEqual(["typescript"]);
    expect(registry.repos["mcp-server"].defaults?.labels).toEqual(["backend"]);
  });

  it("throws on invalid YAML syntax", () => {
    const badYaml = `
version: 1
repos:
  bad: [unclosed bracket
`;
    expect(() => parseRepoRegistry(badYaml)).toThrow(
      /Repo registry YAML parse error/,
    );
  });

  it("throws on valid YAML that fails schema validation", () => {
    const yaml = `
repos:
  my-repo:
    domain: platform
`;
    // Missing version — schema validation should fail
    expect(() => parseRepoRegistry(yaml)).toThrow(
      /Repo registry schema validation failed/,
    );
  });

  it("parses patterns with dependency-flow", () => {
    const yaml = `
version: 1
repos:
  api:
    domain: backend
  web:
    domain: frontend
patterns:
  standard:
    description: "Standard full-stack pattern"
    decomposition:
      - repo: api
        role: REST endpoint
      - repo: web
        role: UI component
    dependency-flow:
      - "api -> web"
`;
    const registry = parseRepoRegistry(yaml);
    const pattern = registry.patterns?.["standard"];
    expect(pattern).toBeDefined();
    expect(pattern?.decomposition).toHaveLength(2);
    expect(pattern?.["dependency-flow"]).toEqual(["api -> web"]);
  });

  it("parses localDir from YAML", () => {
    const yaml = `
version: 1
repos:
  ralph-hero:
    localDir: ~/projects/ralph-hero
    domain: platform
  landcrawler-ai:
    localDir: ~/projects/landcrawler-ai
    domain: backend
`;
    const registry = parseRepoRegistry(yaml);
    expect(registry.repos["ralph-hero"].localDir).toBe("~/projects/ralph-hero");
    expect(registry.repos["landcrawler-ai"].localDir).toBe("~/projects/landcrawler-ai");
  });

  it("throws a descriptive error listing all schema issues", () => {
    const yaml = `
version: 2
repos: {}
`;
    let caught: Error | undefined;
    try {
      parseRepoRegistry(yaml);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    // Should mention both issues: wrong version and empty repos
    expect(caught?.message).toMatch(/schema validation failed/i);
    expect(caught?.message).toContain("version");
    expect(caught?.message).toContain("repos");
  });
});

// ---------------------------------------------------------------------------
// lookupRepo
// ---------------------------------------------------------------------------

describe("lookupRepo", () => {
  const registry = parseRepoRegistry(`
version: 1
repos:
  MCP-Server:
    domain: platform
  frontend:
    domain: ui
`);

  it("finds a repo by exact name", () => {
    const result = lookupRepo(registry, "MCP-Server");
    expect(result).toBeDefined();
    expect(result?.name).toBe("MCP-Server");
    expect(result?.entry.domain).toBe("platform");
  });

  it("finds a repo case-insensitively", () => {
    const result = lookupRepo(registry, "mcp-server");
    expect(result).toBeDefined();
    expect(result?.name).toBe("MCP-Server");
  });

  it("returns undefined for an unknown repo", () => {
    const result = lookupRepo(registry, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns localDir when present in registry entry", () => {
    const reg = parseRepoRegistry(`
version: 1
repos:
  ralph-hero:
    localDir: ~/projects/ralph-hero
    domain: platform
`);
    const result = lookupRepo(reg, "ralph-hero");
    expect(result).toBeDefined();
    expect(result?.entry.localDir).toBe("~/projects/ralph-hero");
  });
});

// ---------------------------------------------------------------------------
// lookupPattern
// ---------------------------------------------------------------------------

describe("lookupPattern", () => {
  const registryWithPatterns = parseRepoRegistry(`
version: 1
repos:
  api:
    domain: backend
patterns:
  Full-Stack:
    description: "Full stack feature"
    decomposition:
      - repo: api
        role: Backend
`);

  const registryNoPatterns = parseRepoRegistry(`
version: 1
repos:
  api:
    domain: backend
`);

  it("finds a pattern by exact name", () => {
    const result = lookupPattern(registryWithPatterns, "Full-Stack");
    expect(result).toBeDefined();
    expect(result?.name).toBe("Full-Stack");
    expect(result?.pattern.description).toBe("Full stack feature");
  });

  it("finds a pattern case-insensitively", () => {
    const result = lookupPattern(registryWithPatterns, "full-stack");
    expect(result).toBeDefined();
    expect(result?.name).toBe("Full-Stack");
  });

  it("returns undefined for an unknown pattern", () => {
    const result = lookupPattern(registryWithPatterns, "nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns undefined when registry has no patterns", () => {
    const result = lookupPattern(registryNoPatterns, "full-stack");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mergeDefaults
// ---------------------------------------------------------------------------

describe("mergeDefaults", () => {
  it("returns empty object when no defaults and no args", () => {
    const result = mergeDefaults(undefined, {});
    expect(result).toEqual({});
  });

  it("returns args as-is when no defaults", () => {
    const result = mergeDefaults(undefined, {
      labels: ["bug"],
      assignees: ["alice"],
      estimate: "S",
    });
    expect(result.labels).toEqual(["bug"]);
    expect(result.assignees).toEqual(["alice"]);
    expect(result.estimate).toBe("S");
  });

  it("returns defaults as-is when no args supplied", () => {
    const result = mergeDefaults(
      { labels: ["backend"], assignees: ["bob"], estimate: "M" },
      {},
    );
    expect(result.labels).toEqual(["backend"]);
    expect(result.assignees).toEqual(["bob"]);
    expect(result.estimate).toBe("M");
  });

  it("merges labels as additive union (args first, then defaults)", () => {
    const result = mergeDefaults(
      { labels: ["backend", "infra"] },
      { labels: ["bug", "backend"] },
    );
    // "backend" appears in both — should be deduplicated
    expect(result.labels).toBeDefined();
    expect(result.labels).toContain("bug");
    expect(result.labels).toContain("backend");
    expect(result.labels).toContain("infra");
    // Dedup: backend only appears once
    expect(result.labels?.filter((l) => l === "backend")).toHaveLength(1);
  });

  it("args assignees win over defaults", () => {
    const result = mergeDefaults(
      { assignees: ["default-user"] },
      { assignees: ["explicit-user"] },
    );
    expect(result.assignees).toEqual(["explicit-user"]);
  });

  it("falls back to defaults assignees when args omit them", () => {
    const result = mergeDefaults({ assignees: ["default-user"] }, {});
    expect(result.assignees).toEqual(["default-user"]);
  });

  it("args estimate wins over defaults", () => {
    const result = mergeDefaults(
      { estimate: "XL" },
      { estimate: "S" },
    );
    expect(result.estimate).toBe("S");
  });

  it("falls back to defaults estimate when args omit it", () => {
    const result = mergeDefaults({ estimate: "M" }, {});
    expect(result.estimate).toBe("M");
  });

  it("omits labels field entirely when both are empty/absent", () => {
    const result = mergeDefaults({ assignees: ["user"] }, { estimate: "S" });
    expect(result.labels).toBeUndefined();
    expect(result.assignees).toEqual(["user"]);
    expect(result.estimate).toBe("S");
  });

  it("deduplicates labels from args alone", () => {
    const result = mergeDefaults(undefined, { labels: ["bug", "bug", "enhancement"] });
    expect(result.labels?.filter((l) => l === "bug")).toHaveLength(1);
    expect(result.labels).toContain("enhancement");
  });
});

// ---------------------------------------------------------------------------
// create_issue registry integration (structural)
// ---------------------------------------------------------------------------

describe("create_issue registry integration", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../tools/issue-tools.ts"),
    "utf-8",
  );

  it("imports lookupRepo from repo-registry", () => {
    expect(src).toContain("lookupRepo");
  });

  it("imports mergeDefaults from repo-registry", () => {
    expect(src).toContain("mergeDefaults");
  });
});
