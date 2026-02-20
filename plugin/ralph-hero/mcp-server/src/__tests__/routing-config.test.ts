import { describe, it, expect } from "vitest";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  loadRoutingConfig,
  validateRulesLive,
} from "../lib/routing-config.js";
import { FieldOptionCache } from "../lib/cache.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const fixtures = join(__dirname, "fixtures");

// ---------------------------------------------------------------------------
// loadRoutingConfig
// ---------------------------------------------------------------------------

describe("loadRoutingConfig", () => {
  it("returns loaded status for valid config", async () => {
    const result = await loadRoutingConfig(join(fixtures, "valid-config.yml"));
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error("expected loaded");
    expect(result.config.version).toBe(1);
    expect(result.config.stopOnFirstMatch).toBe(true);
    expect(result.config.rules).toHaveLength(2);
    expect(result.config.rules[0].action.workflowState).toBe("Backlog");
    expect(result.filePath).toContain("valid-config.yml");
  });

  it("returns loaded status for empty rules", async () => {
    const result = await loadRoutingConfig(join(fixtures, "empty-rules.yml"));
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") throw new Error("expected loaded");
    expect(result.config.rules).toHaveLength(0);
  });

  it("returns missing status for non-existent file", async () => {
    const result = await loadRoutingConfig(
      join(fixtures, "nonexistent.yml"),
    );
    expect(result.status).toBe("missing");
    if (result.status !== "missing") throw new Error("expected missing");
    expect(result.config.version).toBe(1);
    expect(result.config.rules).toHaveLength(0);
    expect(result.config.stopOnFirstMatch).toBe(true);
  });

  it("returns error for invalid YAML", async () => {
    const result = await loadRoutingConfig(
      join(fixtures, "invalid-yaml.yml"),
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].phase).toBe("yaml_parse");
  });

  it("returns error for invalid schema (wrong version)", async () => {
    const result = await loadRoutingConfig(
      join(fixtures, "invalid-schema.yml"),
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(
      result.errors.some((e) => e.phase === "schema_validation"),
    ).toBe(true);
  });

  it("returns error for missing version", async () => {
    const result = await loadRoutingConfig(
      join(fixtures, "no-version.yml"),
    );
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected error");
    expect(
      result.errors.some((e) => e.phase === "schema_validation"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateRulesLive
// ---------------------------------------------------------------------------

describe("validateRulesLive", () => {
  function createFieldCache(
    workflowStates: string[],
  ): FieldOptionCache {
    const cache = new FieldOptionCache();
    cache.populate("project-1", [
      {
        id: "field-1",
        name: "Workflow State",
        options: workflowStates.map((name, i) => ({
          id: `opt-${i}`,
          name,
        })),
      },
    ]);
    return cache;
  }

  it("returns no errors when all workflow states exist", () => {
    const cache = createFieldCache(["Backlog", "Todo", "In Progress", "Done"]);
    const errors = validateRulesLive(
      {
        version: 1,
        stopOnFirstMatch: true,
        rules: [
          {
            match: { labels: { any: ["bug"] }, negate: false },
            action: { projectNumber: 3, workflowState: "Backlog" },
            enabled: true,
          },
        ],
      },
      cache,
    );
    expect(errors).toHaveLength(0);
  });

  it("returns errors for non-existent workflow state", () => {
    const cache = createFieldCache(["Backlog", "Todo"]);
    const errors = validateRulesLive(
      {
        version: 1,
        stopOnFirstMatch: true,
        rules: [
          {
            match: { labels: { any: ["bug"] }, negate: false },
            action: { projectNumber: 3, workflowState: "NonexistentState" },
            enabled: true,
          },
        ],
      },
      cache,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].phase).toBe("live_validation");
    expect(errors[0].path).toContain("workflowState");
    expect(errors[0].message).toContain("NonexistentState");
    expect(errors[0].message).toContain("Backlog");
  });

  it("returns no errors for rules without workflowState", () => {
    const cache = createFieldCache(["Backlog"]);
    const errors = validateRulesLive(
      {
        version: 1,
        stopOnFirstMatch: true,
        rules: [
          {
            match: { labels: { any: ["bug"] }, negate: false },
            action: { projectNumber: 3 },
            enabled: true,
          },
        ],
      },
      cache,
    );
    expect(errors).toHaveLength(0);
  });

  it("skips disabled rules", () => {
    const cache = createFieldCache(["Backlog"]);
    const errors = validateRulesLive(
      {
        version: 1,
        stopOnFirstMatch: true,
        rules: [
          {
            match: { labels: { any: ["bug"] }, negate: false },
            action: { projectNumber: 3, workflowState: "InvalidState" },
            enabled: false,
          },
        ],
      },
      cache,
    );
    expect(errors).toHaveLength(0);
  });
});
