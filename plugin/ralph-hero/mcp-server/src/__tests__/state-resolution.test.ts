import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  resolveState,
  SEMANTIC_INTENTS,
  COMMAND_ALLOWED_STATES,
  normalizeCommand,
} from "../lib/state-resolution.js";

describe("normalizeCommand", () => {
  it("passes through ralph_ prefixed commands", () => {
    expect(normalizeCommand("ralph_research")).toBe("ralph_research");
  });
  it("adds ralph_ prefix to bare command names", () => {
    expect(normalizeCommand("research")).toBe("ralph_research");
    expect(normalizeCommand("plan")).toBe("ralph_plan");
  });
});

describe("resolveState - semantic intents", () => {
  it("resolves __LOCK__ for commands with lock states", () => {
    expect(resolveState("__LOCK__", "ralph_research").resolvedState).toBe(
      "Research in Progress",
    );
    expect(resolveState("__LOCK__", "ralph_plan").resolvedState).toBe(
      "Plan in Progress",
    );
    expect(resolveState("__LOCK__", "ralph_impl").resolvedState).toBe(
      "In Progress",
    );
  });

  it("rejects __LOCK__ for commands without lock states with recovery guidance", () => {
    expect(() => resolveState("__LOCK__", "ralph_triage")).toThrow(
      /not valid for ralph_triage/i,
    );
    expect(() => resolveState("__LOCK__", "ralph_triage")).toThrow(/recovery/i);
    expect(() => resolveState("__LOCK__", "ralph_review")).toThrow(
      /not valid for ralph_review/i,
    );
    expect(() => resolveState("__LOCK__", "ralph_hero")).toThrow(
      /not valid for ralph_hero/i,
    );
  });

  it("resolves __COMPLETE__ for commands with single completion target", () => {
    expect(resolveState("__COMPLETE__", "ralph_research").resolvedState).toBe(
      "Ready for Plan",
    );
    expect(resolveState("__COMPLETE__", "ralph_plan").resolvedState).toBe(
      "Plan in Review",
    );
    expect(resolveState("__COMPLETE__", "ralph_impl").resolvedState).toBe(
      "In Review",
    );
    expect(resolveState("__COMPLETE__", "ralph_review").resolvedState).toBe(
      "In Progress",
    );
    expect(resolveState("__COMPLETE__", "ralph_split").resolvedState).toBe(
      "Backlog",
    );
  });

  it("rejects __COMPLETE__ for ralph_triage (null / multi-path) with recovery", () => {
    expect(() => resolveState("__COMPLETE__", "ralph_triage")).toThrow(
      /ambiguous.*multiple output paths/i,
    );
    expect(() => resolveState("__COMPLETE__", "ralph_triage")).toThrow(
      /recovery.*direct state name/i,
    );
  });

  it("rejects __COMPLETE__ for ralph_hero (not mapped) with recovery", () => {
    expect(() => resolveState("__COMPLETE__", "ralph_hero")).toThrow(
      /not valid for ralph_hero/i,
    );
    expect(() => resolveState("__COMPLETE__", "ralph_hero")).toThrow(
      /recovery/i,
    );
  });

  it("resolves wildcard intents for all commands", () => {
    for (const cmd of Object.keys(COMMAND_ALLOWED_STATES)) {
      expect(resolveState("__ESCALATE__", cmd).resolvedState).toBe(
        "Human Needed",
      );
      expect(resolveState("__CLOSE__", cmd).resolvedState).toBe("Done");
      expect(resolveState("__CANCEL__", cmd).resolvedState).toBe("Canceled");
    }
  });

  it("resolves ralph_pr intents correctly", () => {
    expect(resolveState("__CLOSE__", "ralph_pr").resolvedState).toBe("Done");
    expect(resolveState("__COMPLETE__", "ralph_pr").resolvedState).toBe("Done");
    expect(resolveState("__ESCALATE__", "ralph_pr").resolvedState).toBe(
      "Human Needed",
    );
    expect(resolveState("__CANCEL__", "ralph_pr").resolvedState).toBe(
      "Canceled",
    );
  });

  it("rejects __LOCK__ for ralph_pr (no lock state for PR ops)", () => {
    expect(() => resolveState("__LOCK__", "ralph_pr")).toThrow(
      /not valid for ralph_pr/i,
    );
  });

  it("rejects unknown semantic intents with valid intent list", () => {
    expect(() => resolveState("__FOOBAR__", "ralph_research")).toThrow(
      /unknown semantic intent/i,
    );
    expect(() => resolveState("__FOOBAR__", "ralph_research")).toThrow(
      /recovery.*retry/i,
    );
  });

  it("marks resolved intents with wasIntent=true", () => {
    const result = resolveState("__LOCK__", "ralph_research");
    expect(result.wasIntent).toBe(true);
    expect(result.originalState).toBe("__LOCK__");
  });
});

describe("resolveState - direct state names", () => {
  it("accepts valid output states for each command", () => {
    expect(resolveState("Research Needed", "ralph_triage").resolvedState).toBe(
      "Research Needed",
    );
    expect(resolveState("Ready for Plan", "ralph_triage").resolvedState).toBe(
      "Ready for Plan",
    );
    expect(
      resolveState("Research in Progress", "ralph_research").resolvedState,
    ).toBe("Research in Progress");
    expect(resolveState("In Review", "ralph_impl").resolvedState).toBe(
      "In Review",
    );
  });

  it("accepts valid direct states for ralph_pr", () => {
    expect(resolveState("Done", "ralph_pr").resolvedState).toBe("Done");
    expect(resolveState("In Review", "ralph_pr").resolvedState).toBe(
      "In Review",
    );
    expect(resolveState("Human Needed", "ralph_pr").resolvedState).toBe(
      "Human Needed",
    );
  });

  it("rejects invalid direct states for ralph_pr", () => {
    expect(() => resolveState("In Progress", "ralph_pr")).toThrow(
      /not a valid output for ralph_pr/i,
    );
    expect(() => resolveState("Backlog", "ralph_pr")).toThrow(
      /not a valid output for ralph_pr/i,
    );
  });

  it("rejects states not in command's allowed outputs with recovery", () => {
    expect(() => resolveState("Ready for Plan", "ralph_impl")).toThrow(
      /not a valid output for ralph_impl/i,
    );
    expect(() => resolveState("Ready for Plan", "ralph_impl")).toThrow(
      /recovery.*retry/i,
    );
    expect(() => resolveState("Done", "ralph_research")).toThrow(
      /not a valid output for ralph_research/i,
    );
    expect(() => resolveState("In Progress", "ralph_triage")).toThrow(
      /not a valid output for ralph_triage/i,
    );
  });

  it("includes semantic intent suggestions in recovery guidance", () => {
    // ralph_research can use __COMPLETE__ → "Ready for Plan", so recovery should list it
    expect(() => resolveState("Done", "ralph_research")).toThrow(
      /available semantic intents/i,
    );
    expect(() => resolveState("Done", "ralph_research")).toThrow(
      /__COMPLETE__/,
    );
  });

  it("marks direct states with wasIntent=false", () => {
    const result = resolveState("Research Needed", "ralph_triage");
    expect(result.wasIntent).toBe(false);
  });
});

describe("resolveState - command validation", () => {
  it("rejects unknown commands with recovery guidance", () => {
    expect(() => resolveState("__LOCK__", "foo")).toThrow(/unknown command/i);
    expect(() => resolveState("__LOCK__", "foo")).toThrow(/recovery.*retry/i);
  });

  it("accepts bare command names via normalization", () => {
    expect(resolveState("__LOCK__", "research").resolvedState).toBe(
      "Research in Progress",
    );
    expect(resolveState("__LOCK__", "plan").resolvedState).toBe(
      "Plan in Progress",
    );
  });

  it("accepts bare 'pr' name via normalization", () => {
    expect(resolveState("__CLOSE__", "pr").resolvedState).toBe("Done");
  });
});

describe("error messages contain Recovery: section", () => {
  const errorScenarios = [
    { state: "__LOCK__", command: "ralph_triage", desc: "invalid lock" },
    {
      state: "__COMPLETE__",
      command: "ralph_triage",
      desc: "ambiguous complete",
    },
    { state: "__COMPLETE__", command: "ralph_hero", desc: "unmapped complete" },
    { state: "__FOOBAR__", command: "ralph_research", desc: "unknown intent" },
    { state: "Done", command: "ralph_research", desc: "invalid direct state" },
    { state: "__LOCK__", command: "foo", desc: "unknown command" },
  ];

  for (const { state, command, desc } of errorScenarios) {
    it(`includes Recovery guidance for: ${desc}`, () => {
      expect(() => resolveState(state, command)).toThrow(/recovery/i);
    });
  }
});

describe("data consistency with state machine JSON", () => {
  it("verify SEMANTIC_INTENTS matches ralph-state-machine.json semantic_states", () => {
    const jsonPath = path.resolve(
      __dirname,
      "../../../hooks/scripts/ralph-state-machine.json",
    );
    // Only run if the JSON file exists (not in CI without full repo)
    if (!fs.existsSync(jsonPath)) return;

    const raw = fs.readFileSync(jsonPath, "utf-8");
    const stateMachine = JSON.parse(raw);
    const semanticStates = stateMachine.semantic_states;

    if (!semanticStates) return; // Section may not exist yet

    // Verify each semantic state in JSON has a matching entry in SEMANTIC_INTENTS
    for (const [intent, mapping] of Object.entries(semanticStates)) {
      if (intent === "description") continue; // Skip metadata key
      const hardcodedMapping = SEMANTIC_INTENTS[intent];
      expect(hardcodedMapping).toBeDefined();

      for (const [cmd, resolvedState] of Object.entries(
        mapping as Record<string, string | null>,
      )) {
        if (hardcodedMapping[cmd] !== undefined) {
          expect(hardcodedMapping[cmd]).toBe(resolvedState);
        }
      }
    }
  });

  it("verify COMMAND_ALLOWED_STATES matches ralph-state-machine.json commands", () => {
    const jsonPath = path.resolve(
      __dirname,
      "../../../hooks/scripts/ralph-state-machine.json",
    );
    if (!fs.existsSync(jsonPath)) return;

    const raw = fs.readFileSync(jsonPath, "utf-8");
    const stateMachine = JSON.parse(raw);
    const commands = stateMachine.commands;

    if (!commands) return;

    for (const [cmd, config] of Object.entries(commands)) {
      const hardcoded = COMMAND_ALLOWED_STATES[cmd];
      if (!hardcoded) continue; // Command may not be in our map

      const jsonConfig = config as {
        valid_output_states?: string[];
        lock_state?: string;
      };

      // Build expected set: valid_output_states ∪ {lock_state}
      const expected = new Set(jsonConfig.valid_output_states || []);
      if (jsonConfig.lock_state) {
        expected.add(jsonConfig.lock_state);
      }

      // Every state in hardcoded should be in expected
      for (const state of hardcoded) {
        expect(expected.has(state)).toBe(true);
      }
    }
  });
});
