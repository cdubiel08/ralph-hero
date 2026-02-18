/**
 * Semantic state resolution and command-level validation.
 *
 * Hardcoded from ralph-state-machine.json. A unit test verifies these
 * match the JSON to prevent drift.
 */

// --- Semantic intent mappings ---
// null means the intent is recognized but ambiguous for that command (multi-path)
// undefined (missing key) means the intent isn't mapped for that command

const SEMANTIC_INTENTS: Record<string, Record<string, string | null>> = {
  __LOCK__: {
    ralph_research: "Research in Progress",
    ralph_plan: "Plan in Progress",
    ralph_impl: "In Progress",
  },
  __COMPLETE__: {
    ralph_triage: null, // multi-path: caller must use direct state
    ralph_split: "Backlog",
    ralph_research: "Ready for Plan",
    ralph_plan: "Plan in Review",
    ralph_impl: "In Review",
    ralph_review: "In Progress",
    ralph_merge: "Done",
  },
  __ESCALATE__: { "*": "Human Needed" },
  __CLOSE__: { "*": "Done" },
  __CANCEL__: { "*": "Canceled" },
};

// --- Per-command allowed output states (valid_output_states ∪ {lock_state}) ---

const COMMAND_ALLOWED_STATES: Record<string, string[]> = {
  ralph_triage: [
    "Research Needed",
    "Ready for Plan",
    "Done",
    "Canceled",
    "Human Needed",
  ],
  ralph_split: ["Backlog"],
  ralph_research: ["Research in Progress", "Ready for Plan", "Human Needed"],
  ralph_plan: ["Plan in Progress", "Plan in Review", "Human Needed"],
  ralph_impl: ["In Progress", "In Review", "Human Needed"],
  ralph_review: ["In Progress", "Ready for Plan", "Human Needed"],
  ralph_merge: ["Done", "Human Needed"],
  ralph_hero: ["In Review", "Human Needed"],
};

// --- Helpers ---

function isSemanticIntent(state: string): boolean {
  return state.startsWith("__") && state.endsWith("__");
}

function normalizeCommand(raw: string): string {
  // Accept both "research" and "ralph_research"
  if (raw.startsWith("ralph_")) return raw;
  return `ralph_${raw}`;
}

const VALID_COMMANDS = Object.keys(COMMAND_ALLOWED_STATES);
const VALID_INTENTS = Object.keys(SEMANTIC_INTENTS);

// --- Public API ---

interface ResolutionResult {
  resolvedState: string;
  wasIntent: boolean;
  originalState: string;
  command: string;
}

function resolveState(state: string, rawCommand: string): ResolutionResult {
  const command = normalizeCommand(rawCommand);

  // Validate command
  if (!COMMAND_ALLOWED_STATES[command]) {
    throw new Error(
      `Unknown command "${rawCommand}". Valid commands: ${VALID_COMMANDS.join(", ")}. ` +
        `Recovery: retry with the correct ralph_* command name. ` +
        `If you passed a bare name like "${rawCommand}", use "ralph_${rawCommand}".`,
    );
  }

  if (isSemanticIntent(state)) {
    return resolveSemanticIntent(state, command);
  } else {
    return validateDirectState(state, command);
  }
}

function resolveSemanticIntent(
  intent: string,
  command: string,
): ResolutionResult {
  const intentMapping = SEMANTIC_INTENTS[intent];

  // Unknown intent
  if (!intentMapping) {
    throw new Error(
      `Unknown semantic intent "${intent}". ` +
        `Valid intents: __LOCK__ (claim work), __COMPLETE__ (finish work), ` +
        `__ESCALATE__ (needs human), __CLOSE__ (mark done), __CANCEL__ (abandon). ` +
        `Recovery: retry with one of these intents, or use a direct state name.`,
    );
  }

  // Check wildcard first, then command-specific
  const wildcardResult = intentMapping["*"];
  const commandResult = intentMapping[command];

  // Wildcard match (e.g., __ESCALATE__, __CLOSE__, __CANCEL__)
  if (wildcardResult !== undefined) {
    return {
      resolvedState: wildcardResult as string,
      wasIntent: true,
      originalState: intent,
      command,
    };
  }

  // Command not in mapping at all
  if (commandResult === undefined) {
    const supported = Object.entries(intentMapping)
      .filter(([k, v]) => k !== "*" && v !== null)
      .map(([k, v]) => `${k} → ${v as string}`)
      .join(", ");
    const allowedStates = COMMAND_ALLOWED_STATES[command].join(", ");
    throw new Error(
      `Intent ${intent} is not valid for ${command}. ` +
        `Commands supporting ${intent}: ${supported || "none"}. ` +
        `Recovery: for ${command}, use a direct state name instead: ${allowedStates}. ` +
        `Or use __ESCALATE__ to escalate to human.`,
    );
  }

  // Mapping is null (e.g., ralph_triage + __COMPLETE__)
  if (commandResult === null) {
    const allowedStates = COMMAND_ALLOWED_STATES[command].join(", ");
    throw new Error(
      `Intent ${intent} is ambiguous for ${command} (multiple output paths). ` +
        `Recovery: use a direct state name instead: ${allowedStates}.`,
    );
  }

  return {
    resolvedState: commandResult,
    wasIntent: true,
    originalState: intent,
    command,
  };
}

function validateDirectState(state: string, command: string): ResolutionResult {
  const allowed = COMMAND_ALLOWED_STATES[command];

  if (!allowed.includes(state)) {
    // Build recovery suggestions using semantic intents available for this command
    const recoveryIntents: string[] = [];
    for (const [intent, mapping] of Object.entries(SEMANTIC_INTENTS)) {
      const resolved = mapping[command] || mapping["*"];
      if (resolved && allowed.includes(resolved)) {
        recoveryIntents.push(`${intent} → ${resolved}`);
      }
    }
    const recoveryStr =
      recoveryIntents.length > 0
        ? ` Available semantic intents for ${command}: ${recoveryIntents.join(", ")}.`
        : "";

    throw new Error(
      `State "${state}" is not a valid output for ${command}. ` +
        `Valid direct states for ${command}: ${allowed.join(", ")}. ` +
        `Recovery: retry with one of the valid states listed above.${recoveryStr}`,
    );
  }

  return {
    resolvedState: state,
    wasIntent: false,
    originalState: state,
    command,
  };
}

// Exported for unit tests
export {
  resolveState,
  SEMANTIC_INTENTS,
  COMMAND_ALLOWED_STATES,
  VALID_COMMANDS,
  VALID_INTENTS,
  normalizeCommand,
};
export type { ResolutionResult };
