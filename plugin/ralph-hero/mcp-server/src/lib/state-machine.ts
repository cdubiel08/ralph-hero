/**
 * State machine for Ralph workflow transitions.
 *
 * Embeds the full transition graph from ralph-state-machine.json as TypeScript
 * defaults. Provides transition validation, semantic intent resolution, and
 * state metadata queries. A unit test verifies these defaults match the JSON.
 *
 * This class is a pure data structure + validators: no I/O, no side effects.
 */

import * as fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All valid workflow states in the Ralph pipeline. */
export type WorkflowState =
  | "Backlog"
  | "Research Needed"
  | "Research in Progress"
  | "Ready for Plan"
  | "Plan in Progress"
  | "Plan in Review"
  | "In Progress"
  | "In Review"
  | "Human Needed"
  | "Done"
  | "Canceled";

/** Ralph commands that can trigger state transitions. */
export type RalphCommand =
  | "ralph_triage"
  | "ralph_split"
  | "ralph_research"
  | "ralph_plan"
  | "ralph_impl"
  | "ralph_review"
  | "ralph_hero";

/** Semantic intents for state transitions. */
export type SemanticIntent =
  | "lock"
  | "complete"
  | "escalate"
  | "close"
  | "cancel";

/** Definition of a single workflow state. */
export interface StateDefinition {
  description: string;
  allowed_transitions: string[];
  is_lock_state?: boolean;
  is_terminal?: boolean;
  requires_human_action?: boolean;
}

/** Definition of a command's valid states. */
export interface CommandDefinition {
  valid_input_states: string[];
  valid_output_states: string[];
  lock_state?: string;
}

/** Full state machine configuration. */
export interface StateMachineConfig {
  states: Record<string, StateDefinition>;
  semantic_intents: Record<string, Record<string, string | null>>;
  commands: Record<string, CommandDefinition>;
}

// ---------------------------------------------------------------------------
// Default configuration (embedded from ralph-state-machine.json)
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: StateMachineConfig = {
  states: {
    Backlog: {
      description: "Ticket awaiting triage",
      allowed_transitions: [
        "Research Needed",
        "Ready for Plan",
        "Done",
        "Canceled",
      ],
    },
    "Research Needed": {
      description: "Ticket needs investigation before planning",
      allowed_transitions: [
        "Research in Progress",
        "Ready for Plan",
        "Human Needed",
      ],
    },
    "Research in Progress": {
      description: "Research actively being conducted (LOCKED)",
      allowed_transitions: ["Ready for Plan", "Human Needed"],
      is_lock_state: true,
    },
    "Ready for Plan": {
      description: "Research complete, ready for implementation planning",
      allowed_transitions: ["Plan in Progress", "Human Needed"],
    },
    "Plan in Progress": {
      description: "Plan actively being created (LOCKED)",
      allowed_transitions: ["Plan in Review", "Human Needed"],
      is_lock_state: true,
    },
    "Plan in Review": {
      description: "Plan awaiting human approval",
      allowed_transitions: ["In Progress", "Ready for Plan", "Human Needed"],
      requires_human_action: true,
    },
    "In Progress": {
      description: "Implementation actively underway",
      allowed_transitions: ["In Review", "Human Needed"],
    },
    "In Review": {
      description: "PR created, awaiting code review",
      allowed_transitions: ["Done", "In Progress", "Human Needed"],
      requires_human_action: true,
    },
    "Human Needed": {
      description: "Escalated - requires human intervention",
      allowed_transitions: [
        "Backlog",
        "Research Needed",
        "Ready for Plan",
        "In Progress",
      ],
      requires_human_action: true,
    },
    Done: {
      description: "Ticket completed",
      allowed_transitions: [],
      is_terminal: true,
    },
    Canceled: {
      description: "Ticket canceled/superseded",
      allowed_transitions: [],
      is_terminal: true,
    },
  },

  semantic_intents: {
    lock: {
      ralph_research: "Research in Progress",
      ralph_plan: "Plan in Progress",
      ralph_impl: "In Progress",
    },
    complete: {
      ralph_triage: null, // multi-path: caller must use direct state
      ralph_split: "Backlog",
      ralph_research: "Ready for Plan",
      ralph_plan: "Plan in Review",
      ralph_impl: "In Review",
      ralph_review: "In Progress",
    },
    escalate: { "*": "Human Needed" },
    close: { "*": "Done" },
    cancel: { "*": "Canceled" },
  },

  commands: {
    ralph_triage: {
      valid_input_states: ["Backlog"],
      valid_output_states: [
        "Research Needed",
        "Ready for Plan",
        "Done",
        "Canceled",
        "Human Needed",
      ],
    },
    ralph_split: {
      valid_input_states: ["Backlog", "Research Needed"],
      valid_output_states: ["Backlog"],
    },
    ralph_research: {
      valid_input_states: ["Research Needed"],
      valid_output_states: ["Ready for Plan", "Human Needed"],
      lock_state: "Research in Progress",
    },
    ralph_plan: {
      valid_input_states: ["Ready for Plan"],
      valid_output_states: ["Plan in Review", "Human Needed"],
      lock_state: "Plan in Progress",
    },
    ralph_impl: {
      valid_input_states: ["Plan in Review", "In Progress"],
      valid_output_states: ["In Progress", "In Review", "Human Needed"],
    },
    ralph_review: {
      valid_input_states: ["Plan in Review"],
      valid_output_states: ["In Progress", "Ready for Plan", "Human Needed"],
    },
    ralph_hero: {
      valid_input_states: [
        "Backlog",
        "Research Needed",
        "Ready for Plan",
        "Plan in Review",
        "In Progress",
      ],
      valid_output_states: ["In Review", "Human Needed"],
    },
  },
};

// ---------------------------------------------------------------------------
// StateMachine class
// ---------------------------------------------------------------------------

export class StateMachine {
  private readonly config: StateMachineConfig;

  constructor(config: StateMachineConfig = DEFAULT_CONFIG) {
    this.config = config;
  }

  /** Check if a transition from one state to another is valid. */
  isValidTransition(from: string, to: string): boolean {
    const state = this.config.states[from];
    if (!state) return false;
    return state.allowed_transitions.includes(to);
  }

  /** Get all valid target states from a given state. */
  getAllowedTransitions(from: string): string[] {
    const state = this.config.states[from];
    if (!state) return [];
    return [...state.allowed_transitions];
  }

  /**
   * Resolve a semantic intent + command to a target state.
   *
   * Returns the resolved state string, or null if:
   * - The intent is ambiguous for the command (e.g., complete + triage)
   * - The command is not mapped for this intent
   * - The intent is unknown
   */
  resolveIntent(intent: string, command: string): string | null {
    const normalizedCommand = this.normalizeCommand(command);
    const mapping = this.config.semantic_intents[intent];
    if (!mapping) return null;

    // Check wildcard first
    const wildcardResult = mapping["*"];
    if (wildcardResult !== undefined) {
      return wildcardResult;
    }

    // Check command-specific
    const commandResult = mapping[normalizedCommand];
    if (commandResult === undefined) return null;
    return commandResult; // May be null (ambiguous)
  }

  /** Check if a state is a lock state (exclusive ownership). */
  isLockState(state: string): boolean {
    return this.config.states[state]?.is_lock_state === true;
  }

  /** Check if a state is terminal (no further transitions). */
  isTerminal(state: string): boolean {
    return this.config.states[state]?.is_terminal === true;
  }

  /** Check if a state requires human action. */
  requiresHumanAction(state: string): boolean {
    return this.config.states[state]?.requires_human_action === true;
  }

  /** Type guard: check if a string is a valid workflow state. */
  isValidState(state: string): state is WorkflowState {
    return state in this.config.states;
  }

  /** Get commands that expect this state as an input. */
  getExpectedByCommands(state: string): string[] {
    return Object.entries(this.config.commands)
      .filter(([, def]) => def.valid_input_states.includes(state))
      .map(([cmd]) => cmd);
  }

  /**
   * Validate that a state is a valid output for a command.
   * Returns true for unknown commands (pass-through).
   */
  isValidOutputForCommand(command: string, state: string): boolean {
    const normalizedCommand = this.normalizeCommand(command);
    const cmdDef = this.config.commands[normalizedCommand];
    if (!cmdDef) return true; // Unknown command: pass through

    // Build allowed set: valid_output_states + lock_state
    const allowed = new Set(cmdDef.valid_output_states);
    if (cmdDef.lock_state) {
      allowed.add(cmdDef.lock_state);
    }
    return allowed.has(state);
  }

  /** Get the underlying configuration for tests/introspection. */
  getConfig(): StateMachineConfig {
    return this.config;
  }

  /** Normalize a command name: accept both "research" and "ralph_research". */
  private normalizeCommand(raw: string): string {
    if (raw.startsWith("ralph_")) return raw;
    return `ralph_${raw}`;
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Load a StateMachine from an optional JSON config path.
 * Falls back to DEFAULT_CONFIG if path is not provided or file doesn't exist.
 */
export function loadStateMachine(configPath?: string): StateMachine {
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const json = JSON.parse(raw);

      // Transform JSON format to StateMachineConfig
      const config: StateMachineConfig = {
        states: {},
        semantic_intents: {},
        commands: {},
      };

      // Map states
      if (json.states) {
        for (const [name, def] of Object.entries(json.states)) {
          const stateDef = def as Record<string, unknown>;
          config.states[name] = {
            description: (stateDef.description as string) || "",
            allowed_transitions:
              (stateDef.allowed_transitions as string[]) || [],
            is_lock_state: (stateDef.is_lock_state as boolean) || undefined,
            is_terminal: (stateDef.is_terminal as boolean) || undefined,
            requires_human_action:
              (stateDef.requires_human_action as boolean) || undefined,
          };
        }
      }

      // Map semantic intents (transform from __LOCK__ to lock format)
      if (json.semantic_states) {
        for (const [intent, mapping] of Object.entries(json.semantic_states)) {
          if (intent === "description") continue;
          // Strip __ prefix/suffix and lowercase
          const normalizedIntent = intent
            .replace(/^__/, "")
            .replace(/__$/, "")
            .toLowerCase();
          config.semantic_intents[normalizedIntent] = mapping as Record<
            string,
            string | null
          >;
        }
      }

      // Map commands
      if (json.commands) {
        for (const [name, def] of Object.entries(json.commands)) {
          const cmdDef = def as Record<string, unknown>;
          config.commands[name] = {
            valid_input_states:
              (cmdDef.valid_input_states as string[]) || [],
            valid_output_states:
              (cmdDef.valid_output_states as string[]) || [],
            lock_state: (cmdDef.lock_state as string) || undefined,
          };
        }
      }

      return new StateMachine(config);
    } catch {
      // Fall back to defaults
      return new StateMachine();
    }
  }

  return new StateMachine();
}
