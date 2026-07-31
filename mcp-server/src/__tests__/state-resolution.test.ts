import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  resolveState,
  SEMANTIC_INTENTS,
  COMMAND_ALLOWED_STATES,
  normalizeCommand,
} from "../lib/state-resolution.js";
import { ALLOWED_TRANSITIONS } from "../lib/workflow-states.js";

// The state machine JSON lives at `ralph/hooks/scripts/`, not repo-root
// `hooks/scripts/` (GH-1615: the previous path resolved to a nonexistent
// location and the `existsSync` guard made every parity test below pass
// vacuously — this is how the COMMAND_ALLOWED_STATES drift survived).

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

  it("resolves __LOCK__ for ralph_plan_epic", () => {
    expect(resolveState("__LOCK__", "ralph_plan_epic").resolvedState).toBe(
      "Plan in Progress",
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
    expect(() => resolveState("__LOCK__", "ralph_merge")).toThrow(
      /not valid for ralph_merge/i,
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
    expect(resolveState("__COMPLETE__", "ralph_merge").resolvedState).toBe(
      "Done",
    );
    expect(resolveState("__COMPLETE__", "ralph_plan_epic").resolvedState).toBe(
      "In Progress",
    );
  });

  it("resolves __COMPLETE__ for ralph_split to Backlog (backward compat default)", () => {
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
    expect(resolveState("Done", "ralph_merge").resolvedState).toBe("Done");
    expect(
      resolveState("Human Needed", "ralph_merge").resolvedState,
    ).toBe("Human Needed");
  });

  it("accepts valid output states for ralph_plan_epic", () => {
    expect(resolveState("Plan in Progress", "ralph_plan_epic").resolvedState).toBe(
      "Plan in Progress",
    );
    expect(resolveState("In Progress", "ralph_plan_epic").resolvedState).toBe(
      "In Progress",
    );
    expect(resolveState("Human Needed", "ralph_plan_epic").resolvedState).toBe(
      "Human Needed",
    );
  });

  it("rejects invalid output states for ralph_plan_epic", () => {
    expect(() => resolveState("Plan in Review", "ralph_plan_epic")).toThrow(
      /not a valid output for ralph_plan_epic/i,
    );
    expect(() => resolveState("Done", "ralph_plan_epic")).toThrow(
      /not a valid output for ralph_plan_epic/i,
    );
  });

  it("accepts In Progress and Ready for Plan as direct states for ralph_split", () => {
    expect(resolveState("In Progress", "ralph_split").resolvedState).toBe(
      "In Progress",
    );
    expect(resolveState("Ready for Plan", "ralph_split").resolvedState).toBe(
      "Ready for Plan",
    );
  });

  it("accepts In Progress as direct state for ralph_plan (split-after-plan)", () => {
    expect(resolveState("In Progress", "ralph_plan").resolvedState).toBe(
      "In Progress",
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
    expect(() => resolveState("In Progress", "ralph_merge")).toThrow(
      /not a valid output for ralph_merge/i,
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

describe("resolveState - ralph_pr command", () => {
  it("accepts In Review as direct state", () => {
    const result = resolveState("In Review", "ralph_pr");
    expect(result.resolvedState).toBe("In Review");
    expect(result.wasIntent).toBe(false);
  });

  it("accepts Human Needed as direct state", () => {
    const result = resolveState("Human Needed", "ralph_pr");
    expect(result.resolvedState).toBe("Human Needed");
    expect(result.wasIntent).toBe(false);
  });

  it("rejects states not in ralph_pr allowed outputs", () => {
    expect(() => resolveState("In Progress", "ralph_pr")).toThrow(
      /not a valid output for ralph_pr/i,
    );
    expect(() => resolveState("In Progress", "ralph_pr")).toThrow(/recovery/i);
  });

  it("resolves __ESCALATE__ for ralph_pr", () => {
    expect(resolveState("__ESCALATE__", "ralph_pr").resolvedState).toBe(
      "Human Needed",
    );
  });

  it("resolves __CLOSE__ for ralph_pr", () => {
    expect(resolveState("__CLOSE__", "ralph_pr").resolvedState).toBe("Done");
  });

  it("resolves __CANCEL__ for ralph_pr", () => {
    expect(resolveState("__CANCEL__", "ralph_pr").resolvedState).toBe(
      "Canceled",
    );
  });

  it("rejects __LOCK__ for ralph_pr (no lock state)", () => {
    expect(() => resolveState("__LOCK__", "ralph_pr")).toThrow(
      /not valid for ralph_pr/i,
    );
  });

  it("rejects __COMPLETE__ for ralph_pr (not mapped)", () => {
    expect(() => resolveState("__COMPLETE__", "ralph_pr")).toThrow(
      /not valid for ralph_pr/i,
    );
  });

  it("normalizeCommand('pr') returns 'ralph_pr'", () => {
    expect(normalizeCommand("pr")).toBe("ralph_pr");
  });

  it("accepts bare 'pr' command name via normalization", () => {
    const result = resolveState("In Review", "pr");
    expect(result.resolvedState).toBe("In Review");
  });
});

describe("resolveState - ralph_unblock command", () => {
  it("accepts In Progress as direct state", () => {
    const result = resolveState("In Progress", "ralph_unblock");
    expect(result.resolvedState).toBe("In Progress");
    expect(result.wasIntent).toBe(false);
  });

  it("accepts Backlog as direct state", () => {
    expect(resolveState("Backlog", "ralph_unblock").resolvedState).toBe(
      "Backlog",
    );
  });

  it("accepts Research Needed as direct state", () => {
    expect(resolveState("Research Needed", "ralph_unblock").resolvedState).toBe(
      "Research Needed",
    );
  });

  it("accepts Ready for Plan as direct state", () => {
    expect(resolveState("Ready for Plan", "ralph_unblock").resolvedState).toBe(
      "Ready for Plan",
    );
  });

  it("accepts Human Needed as direct state (no-op for autonomous variant)", () => {
    expect(resolveState("Human Needed", "ralph_unblock").resolvedState).toBe(
      "Human Needed",
    );
  });

  it("rejects Done (not in allowed list)", () => {
    expect(() => resolveState("Done", "ralph_unblock")).toThrow(
      /not a valid output for ralph_unblock/i,
    );
    expect(() => resolveState("Done", "ralph_unblock")).toThrow(/recovery/i);
  });

  it("rejects In Review (not in allowed list)", () => {
    expect(() => resolveState("In Review", "ralph_unblock")).toThrow(
      /not a valid output for ralph_unblock/i,
    );
  });

  it("resolves __ESCALATE__ for ralph_unblock", () => {
    expect(resolveState("__ESCALATE__", "ralph_unblock").resolvedState).toBe(
      "Human Needed",
    );
  });

  it("rejects __LOCK__ for ralph_unblock (no lock state)", () => {
    expect(() => resolveState("__LOCK__", "ralph_unblock")).toThrow(
      /not valid for ralph_unblock/i,
    );
  });

  it("rejects __COMPLETE__ for ralph_unblock (not mapped)", () => {
    expect(() => resolveState("__COMPLETE__", "ralph_unblock")).toThrow(
      /not valid for ralph_unblock/i,
    );
  });

  it("normalizeCommand('unblock') returns 'ralph_unblock'", () => {
    expect(normalizeCommand("unblock")).toBe("ralph_unblock");
  });

  it("accepts bare 'unblock' command name via normalization", () => {
    const result = resolveState("In Progress", "unblock");
    expect(result.resolvedState).toBe("In Progress");
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
    expect(resolveState("__COMPLETE__", "merge").resolvedState).toBe("Done");
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

// (The "data consistency with state machine JSON" parity block was removed in
// the v2 cutover, GH-1662: ralph/hooks/scripts/ralph-state-machine.json was
// deleted with the v1 hook surface. The machine now lives only in this
// server's tables — and, for v2, in ralph/scripts/board.ts — so there is no
// second copy left to drift against. This server is deleted in Phase 4.)
