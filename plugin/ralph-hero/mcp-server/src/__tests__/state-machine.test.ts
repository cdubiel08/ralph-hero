import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  StateMachine,
  DEFAULT_CONFIG,
  loadStateMachine,
  type WorkflowState,
} from "../lib/state-machine.js";

const sm = new StateMachine();

// All 11 workflow states
const ALL_STATES: WorkflowState[] = [
  "Backlog",
  "Research Needed",
  "Research in Progress",
  "Ready for Plan",
  "Plan in Progress",
  "Plan in Review",
  "In Progress",
  "In Review",
  "Human Needed",
  "Done",
  "Canceled",
];

// ---------------------------------------------------------------------------
// isValidTransition
// ---------------------------------------------------------------------------

describe("isValidTransition", () => {
  it("accepts valid forward transitions", () => {
    expect(sm.isValidTransition("Backlog", "Research Needed")).toBe(true);
    expect(sm.isValidTransition("Research Needed", "Research in Progress")).toBe(
      true,
    );
    expect(sm.isValidTransition("Research in Progress", "Ready for Plan")).toBe(
      true,
    );
    expect(sm.isValidTransition("Ready for Plan", "Plan in Progress")).toBe(
      true,
    );
    expect(sm.isValidTransition("Plan in Progress", "Plan in Review")).toBe(
      true,
    );
    expect(sm.isValidTransition("Plan in Review", "In Progress")).toBe(true);
    expect(sm.isValidTransition("In Progress", "In Review")).toBe(true);
    expect(sm.isValidTransition("In Review", "Done")).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(sm.isValidTransition("Backlog", "In Progress")).toBe(false);
    expect(sm.isValidTransition("Backlog", "In Review")).toBe(false);
    expect(sm.isValidTransition("Research Needed", "Done")).toBe(false);
    expect(sm.isValidTransition("In Progress", "Backlog")).toBe(false);
    expect(sm.isValidTransition("Ready for Plan", "In Review")).toBe(false);
  });

  it("terminal states have no outgoing transitions", () => {
    for (const state of ALL_STATES) {
      expect(sm.isValidTransition("Done", state)).toBe(false);
      expect(sm.isValidTransition("Canceled", state)).toBe(false);
    }
  });

  it("Human Needed transitions to allowed recovery states", () => {
    expect(sm.isValidTransition("Human Needed", "Backlog")).toBe(true);
    expect(sm.isValidTransition("Human Needed", "Research Needed")).toBe(true);
    expect(sm.isValidTransition("Human Needed", "Ready for Plan")).toBe(true);
    expect(sm.isValidTransition("Human Needed", "In Progress")).toBe(true);
    // Not allowed
    expect(sm.isValidTransition("Human Needed", "Done")).toBe(false);
    expect(sm.isValidTransition("Human Needed", "In Review")).toBe(false);
    expect(sm.isValidTransition("Human Needed", "Plan in Progress")).toBe(
      false,
    );
  });

  it("supports bidirectional Plan in Review <-> Ready for Plan", () => {
    expect(sm.isValidTransition("Plan in Review", "Ready for Plan")).toBe(true);
    // Ready for Plan -> Plan in Review goes via Plan in Progress
    expect(sm.isValidTransition("Ready for Plan", "Plan in Review")).toBe(
      false,
    );
  });

  it("supports In Review -> In Progress (rejection)", () => {
    expect(sm.isValidTransition("In Review", "In Progress")).toBe(true);
  });

  it("returns false for unknown states", () => {
    expect(sm.isValidTransition("NonExistent", "Backlog")).toBe(false);
    expect(sm.isValidTransition("Backlog", "NonExistent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAllowedTransitions
// ---------------------------------------------------------------------------

describe("getAllowedTransitions", () => {
  it("returns correct transitions for each state", () => {
    expect(sm.getAllowedTransitions("Backlog")).toEqual([
      "Research Needed",
      "Ready for Plan",
      "Done",
      "Canceled",
    ]);
    expect(sm.getAllowedTransitions("Research Needed")).toEqual([
      "Research in Progress",
      "Ready for Plan",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("Research in Progress")).toEqual([
      "Ready for Plan",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("Ready for Plan")).toEqual([
      "Plan in Progress",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("Plan in Progress")).toEqual([
      "Plan in Review",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("Plan in Review")).toEqual([
      "In Progress",
      "Ready for Plan",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("In Progress")).toEqual([
      "In Review",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("In Review")).toEqual([
      "Done",
      "In Progress",
      "Human Needed",
    ]);
    expect(sm.getAllowedTransitions("Human Needed")).toEqual([
      "Backlog",
      "Research Needed",
      "Ready for Plan",
      "In Progress",
    ]);
  });

  it("returns empty array for terminal states", () => {
    expect(sm.getAllowedTransitions("Done")).toEqual([]);
    expect(sm.getAllowedTransitions("Canceled")).toEqual([]);
  });

  it("returns empty array for unknown states", () => {
    expect(sm.getAllowedTransitions("NonExistent")).toEqual([]);
  });

  it("returns a copy (not a reference)", () => {
    const transitions = sm.getAllowedTransitions("Backlog");
    transitions.push("HACKED");
    expect(sm.getAllowedTransitions("Backlog")).not.toContain("HACKED");
  });
});

// ---------------------------------------------------------------------------
// resolveIntent
// ---------------------------------------------------------------------------

describe("resolveIntent", () => {
  describe("lock intent", () => {
    it("research -> Research in Progress", () => {
      expect(sm.resolveIntent("lock", "research")).toBe(
        "Research in Progress",
      );
    });

    it("plan -> Plan in Progress", () => {
      expect(sm.resolveIntent("lock", "plan")).toBe("Plan in Progress");
    });

    it("impl -> In Progress", () => {
      expect(sm.resolveIntent("lock", "impl")).toBe("In Progress");
    });

    it("unmapped command -> null", () => {
      expect(sm.resolveIntent("lock", "triage")).toBeNull();
      expect(sm.resolveIntent("lock", "review")).toBeNull();
    });
  });

  describe("complete intent", () => {
    it("research -> Ready for Plan", () => {
      expect(sm.resolveIntent("complete", "research")).toBe("Ready for Plan");
    });

    it("plan -> Plan in Review", () => {
      expect(sm.resolveIntent("complete", "plan")).toBe("Plan in Review");
    });

    it("impl -> In Review", () => {
      expect(sm.resolveIntent("complete", "impl")).toBe("In Review");
    });

    it("review -> In Progress", () => {
      expect(sm.resolveIntent("complete", "review")).toBe("In Progress");
    });

    it("split -> Backlog", () => {
      expect(sm.resolveIntent("complete", "split")).toBe("Backlog");
    });

    it("triage -> null (ambiguous, multi-path)", () => {
      expect(sm.resolveIntent("complete", "triage")).toBeNull();
    });
  });

  describe("wildcard intents", () => {
    it("escalate -> Human Needed for any command", () => {
      expect(sm.resolveIntent("escalate", "triage")).toBe("Human Needed");
      expect(sm.resolveIntent("escalate", "research")).toBe("Human Needed");
      expect(sm.resolveIntent("escalate", "plan")).toBe("Human Needed");
      expect(sm.resolveIntent("escalate", "impl")).toBe("Human Needed");
      expect(sm.resolveIntent("escalate", "review")).toBe("Human Needed");
      expect(sm.resolveIntent("escalate", "hero")).toBe("Human Needed");
      expect(sm.resolveIntent("escalate", "unknown_cmd")).toBe("Human Needed");
    });

    it("close -> Done for any command", () => {
      expect(sm.resolveIntent("close", "triage")).toBe("Done");
      expect(sm.resolveIntent("close", "impl")).toBe("Done");
    });

    it("cancel -> Canceled for any command", () => {
      expect(sm.resolveIntent("cancel", "research")).toBe("Canceled");
      expect(sm.resolveIntent("cancel", "plan")).toBe("Canceled");
    });
  });

  describe("command normalization", () => {
    it("accepts both 'research' and 'ralph_research'", () => {
      expect(sm.resolveIntent("lock", "research")).toBe(
        "Research in Progress",
      );
      expect(sm.resolveIntent("lock", "ralph_research")).toBe(
        "Research in Progress",
      );
    });

    it("accepts both 'plan' and 'ralph_plan'", () => {
      expect(sm.resolveIntent("complete", "plan")).toBe("Plan in Review");
      expect(sm.resolveIntent("complete", "ralph_plan")).toBe("Plan in Review");
    });
  });

  it("returns null for unknown intent", () => {
    expect(sm.resolveIntent("unknown_intent", "research")).toBeNull();
    expect(sm.resolveIntent("reject", "review")).toBeNull();
  });

  it("returns null for unknown command with non-wildcard intent", () => {
    expect(sm.resolveIntent("lock", "nonexistent")).toBeNull();
    expect(sm.resolveIntent("complete", "nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// State metadata queries
// ---------------------------------------------------------------------------

describe("isLockState", () => {
  it("identifies lock states", () => {
    expect(sm.isLockState("Research in Progress")).toBe(true);
    expect(sm.isLockState("Plan in Progress")).toBe(true);
  });

  it("rejects non-lock states", () => {
    expect(sm.isLockState("Backlog")).toBe(false);
    expect(sm.isLockState("In Progress")).toBe(false);
    expect(sm.isLockState("Done")).toBe(false);
    expect(sm.isLockState("Human Needed")).toBe(false);
  });

  it("returns false for unknown states", () => {
    expect(sm.isLockState("NonExistent")).toBe(false);
  });
});

describe("isTerminal", () => {
  it("identifies terminal states", () => {
    expect(sm.isTerminal("Done")).toBe(true);
    expect(sm.isTerminal("Canceled")).toBe(true);
  });

  it("rejects non-terminal states", () => {
    expect(sm.isTerminal("Backlog")).toBe(false);
    expect(sm.isTerminal("In Progress")).toBe(false);
    expect(sm.isTerminal("Human Needed")).toBe(false);
  });
});

describe("requiresHumanAction", () => {
  it("identifies human-action states", () => {
    expect(sm.requiresHumanAction("Human Needed")).toBe(true);
    expect(sm.requiresHumanAction("Plan in Review")).toBe(true);
    expect(sm.requiresHumanAction("In Review")).toBe(true);
  });

  it("rejects non-human-action states", () => {
    expect(sm.requiresHumanAction("Backlog")).toBe(false);
    expect(sm.requiresHumanAction("In Progress")).toBe(false);
    expect(sm.requiresHumanAction("Done")).toBe(false);
    expect(sm.requiresHumanAction("Research in Progress")).toBe(false);
  });
});

describe("isValidState", () => {
  it("accepts all 11 workflow states", () => {
    for (const state of ALL_STATES) {
      expect(sm.isValidState(state)).toBe(true);
    }
  });

  it("rejects arbitrary strings", () => {
    expect(sm.isValidState("Foo")).toBe(false);
    expect(sm.isValidState("")).toBe(false);
    expect(sm.isValidState("backlog")).toBe(false); // case-sensitive
    expect(sm.isValidState("in progress")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isValidOutputForCommand
// ---------------------------------------------------------------------------

describe("isValidOutputForCommand", () => {
  it("validates triage outputs", () => {
    expect(sm.isValidOutputForCommand("triage", "Research Needed")).toBe(true);
    expect(sm.isValidOutputForCommand("triage", "Ready for Plan")).toBe(true);
    expect(sm.isValidOutputForCommand("triage", "Done")).toBe(true);
    expect(sm.isValidOutputForCommand("triage", "Canceled")).toBe(true);
    expect(sm.isValidOutputForCommand("triage", "Human Needed")).toBe(true);
    // Invalid outputs
    expect(sm.isValidOutputForCommand("triage", "In Progress")).toBe(false);
    expect(sm.isValidOutputForCommand("triage", "In Review")).toBe(false);
  });

  it("validates research outputs (including lock_state)", () => {
    expect(sm.isValidOutputForCommand("research", "Ready for Plan")).toBe(true);
    expect(sm.isValidOutputForCommand("research", "Human Needed")).toBe(true);
    // lock_state included
    expect(
      sm.isValidOutputForCommand("research", "Research in Progress"),
    ).toBe(true);
    // Invalid
    expect(sm.isValidOutputForCommand("research", "Done")).toBe(false);
  });

  it("validates plan outputs (including lock_state)", () => {
    expect(sm.isValidOutputForCommand("plan", "Plan in Review")).toBe(true);
    expect(sm.isValidOutputForCommand("plan", "Human Needed")).toBe(true);
    expect(sm.isValidOutputForCommand("plan", "Plan in Progress")).toBe(true);
    expect(sm.isValidOutputForCommand("plan", "Done")).toBe(false);
  });

  it("validates impl outputs", () => {
    expect(sm.isValidOutputForCommand("impl", "In Progress")).toBe(true);
    expect(sm.isValidOutputForCommand("impl", "In Review")).toBe(true);
    expect(sm.isValidOutputForCommand("impl", "Human Needed")).toBe(true);
    expect(sm.isValidOutputForCommand("impl", "Done")).toBe(false);
  });

  it("validates review outputs", () => {
    expect(sm.isValidOutputForCommand("review", "In Progress")).toBe(true);
    expect(sm.isValidOutputForCommand("review", "Ready for Plan")).toBe(true);
    expect(sm.isValidOutputForCommand("review", "Human Needed")).toBe(true);
    expect(sm.isValidOutputForCommand("review", "Done")).toBe(false);
  });

  it("validates split outputs", () => {
    expect(sm.isValidOutputForCommand("split", "Backlog")).toBe(true);
    expect(sm.isValidOutputForCommand("split", "Done")).toBe(false);
  });

  it("passes through unknown commands", () => {
    expect(sm.isValidOutputForCommand("nonexistent", "Done")).toBe(true);
    expect(sm.isValidOutputForCommand("nonexistent", "Backlog")).toBe(true);
  });

  it("normalizes command names", () => {
    expect(sm.isValidOutputForCommand("ralph_triage", "Done")).toBe(true);
    expect(sm.isValidOutputForCommand("triage", "Done")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getExpectedByCommands
// ---------------------------------------------------------------------------

describe("getExpectedByCommands", () => {
  it("Research Needed -> ralph_research, ralph_split", () => {
    const cmds = sm.getExpectedByCommands("Research Needed");
    expect(cmds).toContain("ralph_research");
    expect(cmds).toContain("ralph_split");
    expect(cmds).not.toContain("ralph_triage");
  });

  it("Ready for Plan -> ralph_plan", () => {
    const cmds = sm.getExpectedByCommands("Ready for Plan");
    expect(cmds).toContain("ralph_plan");
  });

  it("Plan in Review -> ralph_review, ralph_impl", () => {
    const cmds = sm.getExpectedByCommands("Plan in Review");
    expect(cmds).toContain("ralph_review");
    expect(cmds).toContain("ralph_impl");
  });

  it("Backlog -> ralph_triage", () => {
    const cmds = sm.getExpectedByCommands("Backlog");
    expect(cmds).toContain("ralph_triage");
  });

  it("Done -> no commands (terminal)", () => {
    expect(sm.getExpectedByCommands("Done")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Data consistency with ralph-state-machine.json
// ---------------------------------------------------------------------------

describe("DEFAULT_CONFIG consistency with ralph-state-machine.json", () => {
  const jsonPath = path.resolve(
    __dirname,
    "../../../hooks/scripts/ralph-state-machine.json",
  );

  // Skip these tests if the JSON file doesn't exist (e.g., in CI without full repo)
  const jsonExists = fs.existsSync(jsonPath);
  const describeOrSkip = jsonExists ? describe : describe.skip;

  describeOrSkip("states", () => {
    const json = jsonExists
      ? JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
      : null;

    it("has the same state names", () => {
      const configStates = Object.keys(DEFAULT_CONFIG.states).sort();
      const jsonStates = Object.keys(json.states).sort();
      expect(configStates).toEqual(jsonStates);
    });

    it("has matching allowed_transitions for each state", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.states)) {
        const jsonDef = json.states[name];
        expect(def.allowed_transitions).toEqual(
          jsonDef.allowed_transitions,
        );
      }
    });

    it("has matching is_lock_state flags", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.states)) {
        const jsonDef = json.states[name];
        const expectedLock = jsonDef.is_lock_state === true;
        expect(def.is_lock_state === true).toBe(expectedLock);
      }
    });

    it("has matching is_terminal flags", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.states)) {
        const jsonDef = json.states[name];
        const expectedTerminal = jsonDef.is_terminal === true;
        expect(def.is_terminal === true).toBe(expectedTerminal);
      }
    });

    it("has matching requires_human_action flags", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.states)) {
        const jsonDef = json.states[name];
        const expectedHuman = jsonDef.requires_human_action === true;
        expect(def.requires_human_action === true).toBe(expectedHuman);
      }
    });
  });

  describeOrSkip("semantic_intents", () => {
    const json = jsonExists
      ? JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
      : null;

    it("lock matches __LOCK__", () => {
      expect(DEFAULT_CONFIG.semantic_intents.lock).toEqual(
        json.semantic_states.__LOCK__,
      );
    });

    it("complete matches __COMPLETE__", () => {
      expect(DEFAULT_CONFIG.semantic_intents.complete).toEqual(
        json.semantic_states.__COMPLETE__,
      );
    });

    it("escalate matches __ESCALATE__", () => {
      expect(DEFAULT_CONFIG.semantic_intents.escalate).toEqual(
        json.semantic_states.__ESCALATE__,
      );
    });

    it("close matches __CLOSE__", () => {
      expect(DEFAULT_CONFIG.semantic_intents.close).toEqual(
        json.semantic_states.__CLOSE__,
      );
    });

    it("cancel matches __CANCEL__", () => {
      expect(DEFAULT_CONFIG.semantic_intents.cancel).toEqual(
        json.semantic_states.__CANCEL__,
      );
    });
  });

  describeOrSkip("commands", () => {
    const json = jsonExists
      ? JSON.parse(fs.readFileSync(jsonPath, "utf-8"))
      : null;

    it("has the same command names", () => {
      const configCmds = Object.keys(DEFAULT_CONFIG.commands).sort();
      const jsonCmds = Object.keys(json.commands).sort();
      expect(configCmds).toEqual(jsonCmds);
    });

    it("has matching valid_input_states for each command", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.commands)) {
        const jsonDef = json.commands[name];
        expect(def.valid_input_states).toEqual(jsonDef.valid_input_states);
      }
    });

    it("has matching valid_output_states for each command", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.commands)) {
        const jsonDef = json.commands[name];
        expect(def.valid_output_states).toEqual(jsonDef.valid_output_states);
      }
    });

    it("has matching lock_state for commands with locks", () => {
      for (const [name, def] of Object.entries(DEFAULT_CONFIG.commands)) {
        const jsonDef = json.commands[name];
        if (jsonDef.lock_state) {
          expect(def.lock_state).toBe(jsonDef.lock_state);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// loadStateMachine
// ---------------------------------------------------------------------------

describe("loadStateMachine", () => {
  it("returns default config when no path provided", () => {
    const machine = loadStateMachine();
    expect(machine.isValidState("Backlog")).toBe(true);
    expect(machine.getAllowedTransitions("Backlog")).toEqual(
      DEFAULT_CONFIG.states.Backlog.allowed_transitions,
    );
  });

  it("returns default config when path is undefined", () => {
    const machine = loadStateMachine(undefined);
    expect(machine.isValidState("Done")).toBe(true);
  });

  it("falls back to defaults for nonexistent path", () => {
    const machine = loadStateMachine("/nonexistent/path/to/config.json");
    expect(machine.isValidState("Backlog")).toBe(true);
    expect(machine.resolveIntent("lock", "research")).toBe(
      "Research in Progress",
    );
  });

  it("loads from actual JSON file if available", () => {
    const jsonPath = path.resolve(
      __dirname,
      "../../../hooks/scripts/ralph-state-machine.json",
    );
    if (fs.existsSync(jsonPath)) {
      const machine = loadStateMachine(jsonPath);
      expect(machine.isValidState("Backlog")).toBe(true);
      expect(machine.isValidTransition("Backlog", "Research Needed")).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("every state can transition to at least one target or is terminal", () => {
    for (const state of ALL_STATES) {
      const transitions = sm.getAllowedTransitions(state);
      const isTerminal = sm.isTerminal(state);
      expect(transitions.length > 0 || isTerminal).toBe(true);
    }
  });

  it("no state transitions to itself", () => {
    for (const state of ALL_STATES) {
      expect(sm.isValidTransition(state, state)).toBe(false);
    }
  });

  it("all transition targets are valid states", () => {
    for (const state of ALL_STATES) {
      for (const target of sm.getAllowedTransitions(state)) {
        expect(sm.isValidState(target)).toBe(true);
      }
    }
  });

  it("all lock_state values in commands are valid states", () => {
    for (const def of Object.values(DEFAULT_CONFIG.commands)) {
      if (def.lock_state) {
        expect(sm.isValidState(def.lock_state)).toBe(true);
        expect(sm.isLockState(def.lock_state)).toBe(true);
      }
    }
  });
});
