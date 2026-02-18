---
date: 2026-02-15
status: draft
linear_ticket: null
linear_url: null
---

# `handoff_ticket` MCP Tool - Protocol-Level State Machine Enforcement

## Overview

Replace the raw `ralph_hero__update_workflow_state` tool with `ralph_hero__handoff_ticket` - a validated, intent-aware state transition tool that enforces the Ralph workflow state machine at the MCP protocol layer. Every state change goes through this tool, which validates transitions, resolves semantic intents, requires audit comments, and returns structured guidance. No agent can bypass the state machine because the raw tool no longer exists.

## Current State Analysis

### Problem

Agents can set arbitrary workflow states via `ralph_hero__update_workflow_state` (issue-tools.ts:998-1035). This tool accepts any string and passes it to GitHub with zero validation. The local workflow relies on shell hook scripts attached to skill frontmatter to catch invalid transitions, but:

1. Hooks only fire when skills are invoked via `Skill()` - forking contexts to get hooks adds token overhead
2. Hooks are scattered across 8+ shell scripts with duplicated validation logic
3. An agent spawned via `Task()` without `Skill()` has no hooks and can corrupt state
4. Observed failure: after a phase ran, an agent tried to manually set a state that doesn't exist in the taxonomy

### What Exists

- **State machine definition**: `landcrawler-ai/.claude/hooks/ralph-state-machine.json` - 11 states, transition graph, semantic intents, command mappings
- **Semantic intent system**: `__LOCK__`, `__COMPLETE__`, `__ESCALATE__`, `__CLOSE__`, `__CANCEL__` with per-command resolution
- **MCP server**: TypeScript, `@modelcontextprotocol/sdk`, published to npm as `ralph-hero-mcp-server`
- **Existing tool**: `ralph_hero__update_workflow_state` at `mcp-server/src/tools/issue-tools.ts:998-1035`

### Key Discoveries

- `ralph-state-machine.json:264-297`: Semantic intent mappings already define the handoff vocabulary
- `ralph-auto-state.sh:45-135`: Hook-based semantic resolution proves the pattern works
- `issue-tools.ts:1014-1017`: `getCurrentFieldValue()` already fetches current state - reusable for validation
- `issue-tools.ts:1020`: `resolveProjectItemId()` already resolves issue numbers to project item IDs
- `issue-tools.ts:1023`: `updateProjectItemField()` already updates GitHub Projects fields

## Desired End State

1. `ralph_hero__update_workflow_state` no longer exists
2. `ralph_hero__handoff_ticket` is the only way to change workflow state
3. State machine is enforced in TypeScript types (compile-time) and loaded from JSON config (runtime)
4. Every transition produces a GitHub issue comment (audit trail)
5. Semantic intents (`complete`, `lock`, `escalate`, `reject`, `close`, `cancel`) resolve per-command
6. Invalid transitions return a structured error with valid options
7. Skills and agents reference `handoff_ticket` instead of `update_workflow_state`

### Verification

- `npm test` passes with new tool tests
- `npm run build` compiles with no type errors
- Calling `handoff_ticket` with invalid transition returns error with valid transitions listed
- Calling `handoff_ticket` with valid transition succeeds and posts comment
- Calling `handoff_ticket` with semantic intent resolves correctly per command
- `update_workflow_state` tool no longer appears in MCP tool list
- Skills reference `handoff_ticket` in their instructions

## What We're NOT Doing

- Not changing the state machine itself (same 11 states, same transitions)
- Not modifying the local hook scripts (they continue to work for the local workflow)
- Not adding new states or transition rules
- Not changing how other issue tools work (create, update, estimate, priority, comment)
- Not implementing precondition checking beyond state transitions (e.g., "does research doc exist?") - that's a future enhancement
- Not removing the Linear-based local workflow - both systems coexist

## Implementation Approach

Embed the state machine in the MCP server as TypeScript types for compile-time safety, with runtime JSON config loading for overrides. Replace `update_workflow_state` with `handoff_ticket`. Update skill markdown files to reference the new tool.

## Phase 1: State Machine Types and Config Loading

### Overview

Create TypeScript type definitions for the state machine and a config loader that reads the JSON definition at server startup. This gives compile-time safety for the state graph while allowing runtime config updates without republishing.

### Changes Required

#### 1. State Machine Types

**File**: `mcp-server/src/lib/state-machine.ts` (NEW)

```typescript
// --- Type Definitions ---

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

export type RalphCommand =
  | "triage"
  | "split"
  | "research"
  | "plan"
  | "review"
  | "impl"
  | "hero";

export type SemanticIntent =
  | "lock"
  | "complete"
  | "escalate"
  | "reject"
  | "close"
  | "cancel";

export interface StateDefinition {
  description: string;
  allowed_transitions: WorkflowState[];
  is_lock_state?: boolean;
  is_terminal?: boolean;
  requires_human_action?: boolean;
}

export interface CommandDefinition {
  valid_input_states: WorkflowState[];
  valid_output_states: WorkflowState[];
  lock_state?: WorkflowState;
}

export interface StateMachineConfig {
  states: Record<WorkflowState, StateDefinition>;
  semantic_states: Record<string, Record<string, WorkflowState | null>>;
  commands: Record<string, CommandDefinition>;
}

// --- Validation Functions ---

export class StateMachine {
  constructor(private config: StateMachineConfig) {}

  /** Check if a transition from currentState to targetState is valid */
  isValidTransition(currentState: WorkflowState, targetState: WorkflowState): boolean {
    const stateConfig = this.config.states[currentState];
    if (!stateConfig) return false;
    return stateConfig.allowed_transitions.includes(targetState);
  }

  /** Get all valid transitions from a given state */
  getAllowedTransitions(fromState: WorkflowState): WorkflowState[] {
    return this.config.states[fromState]?.allowed_transitions ?? [];
  }

  /** Resolve a semantic intent to a concrete state for a given command */
  resolveIntent(intent: SemanticIntent, command: RalphCommand): WorkflowState | null {
    const intentKey = `__${intent.toUpperCase()}__`;
    const mapping = this.config.semantic_states[intentKey];
    if (!mapping) return null;

    // Try command-specific mapping first, fall back to wildcard
    const commandKey = `ralph_${command}`;
    if (commandKey in mapping) return mapping[commandKey] as WorkflowState | null;
    if ("*" in mapping) return mapping["*"] as WorkflowState | null;
    return null;
  }

  /** Check if a state is a lock state */
  isLockState(state: WorkflowState): boolean {
    return this.config.states[state]?.is_lock_state === true;
  }

  /** Check if a state is terminal */
  isTerminal(state: WorkflowState): boolean {
    return this.config.states[state]?.is_terminal === true;
  }

  /** Check if a state requires human action */
  requiresHumanAction(state: WorkflowState): boolean {
    return this.config.states[state]?.requires_human_action === true;
  }

  /** Check if a state is a valid workflow state */
  isValidState(state: string): state is WorkflowState {
    return state in this.config.states;
  }

  /** Get which commands expect a given state as input */
  getExpectedByCommands(state: WorkflowState): string[] {
    return Object.entries(this.config.commands)
      .filter(([, cmd]) => cmd.valid_input_states.includes(state))
      .map(([name]) => name);
  }

  /** Validate a command's output state */
  isValidOutputForCommand(command: RalphCommand, state: WorkflowState): boolean {
    const cmdKey = `ralph_${command}`;
    const cmdConfig = this.config.commands[cmdKey];
    if (!cmdConfig) return true; // Unknown commands are not validated
    return cmdConfig.valid_output_states.includes(state);
  }
}

// --- Config Loading ---

/** Default state machine (embedded for reliability) */
const DEFAULT_CONFIG: StateMachineConfig = {
  states: {
    "Backlog": {
      description: "Ticket awaiting triage",
      allowed_transitions: ["Research Needed", "Ready for Plan", "Done", "Canceled"],
    },
    "Research Needed": {
      description: "Ticket needs investigation before planning",
      allowed_transitions: ["Research in Progress", "Ready for Plan", "Human Needed"],
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
      allowed_transitions: ["Backlog", "Research Needed", "Ready for Plan", "In Progress"],
      requires_human_action: true,
    },
    "Done": {
      description: "Ticket completed",
      allowed_transitions: [],
      is_terminal: true,
    },
    "Canceled": {
      description: "Ticket canceled/superseded",
      allowed_transitions: [],
      is_terminal: true,
    },
  },
  semantic_states: {
    "__LOCK__": {
      "ralph_research": "Research in Progress",
      "ralph_plan": "Plan in Progress",
      "ralph_impl": "In Progress",
    },
    "__COMPLETE__": {
      "ralph_triage": null as unknown as WorkflowState,
      "ralph_research": "Ready for Plan",
      "ralph_plan": "Plan in Review",
      "ralph_impl": "In Review",
      "ralph_review": "In Progress",
      "ralph_split": "Backlog",
    },
    "__ESCALATE__": { "*": "Human Needed" },
    "__CLOSE__": { "*": "Done" },
    "__CANCEL__": { "*": "Canceled" },
    "__REJECT__": {
      "ralph_review": "Ready for Plan",
      "ralph_impl": "In Progress",
      "*": "Human Needed",
    },
  },
  commands: {
    "ralph_triage": {
      valid_input_states: ["Backlog"],
      valid_output_states: ["Research Needed", "Ready for Plan", "Done", "Canceled", "Human Needed"],
    },
    "ralph_split": {
      valid_input_states: ["Backlog", "Research Needed"],
      valid_output_states: ["Backlog"],
    },
    "ralph_research": {
      valid_input_states: ["Research Needed"],
      valid_output_states: ["Ready for Plan", "Human Needed"],
      lock_state: "Research in Progress",
    },
    "ralph_plan": {
      valid_input_states: ["Ready for Plan"],
      valid_output_states: ["Plan in Review", "Human Needed"],
      lock_state: "Plan in Progress",
    },
    "ralph_review": {
      valid_input_states: ["Plan in Review"],
      valid_output_states: ["In Progress", "Ready for Plan", "Human Needed"],
    },
    "ralph_impl": {
      valid_input_states: ["Plan in Review", "In Progress"],
      valid_output_states: ["In Progress", "In Review", "Human Needed"],
    },
    "ralph_hero": {
      valid_input_states: ["Backlog", "Research Needed", "Ready for Plan", "Plan in Review", "In Progress"],
      valid_output_states: ["In Review", "Human Needed"],
    },
  },
};

/** Load state machine config, with optional JSON file override */
export function loadStateMachine(configPath?: string): StateMachine {
  if (configPath) {
    try {
      const fs = require("fs");
      const raw = fs.readFileSync(configPath, "utf-8");
      const override = JSON.parse(raw) as StateMachineConfig;
      return new StateMachine(override);
    } catch {
      // Fall back to default if config file not found or invalid
      console.error(`Failed to load state machine config from ${configPath}, using defaults`);
    }
  }
  return new StateMachine(DEFAULT_CONFIG);
}
```

#### 2. Server Init - Load Config

**File**: `mcp-server/src/index.ts`
**Changes**: Load state machine at startup, pass to tool registration

After line ~229 (`const fieldCache = new FieldOptionCache();`), add:

```typescript
import { loadStateMachine } from "./lib/state-machine.js";

// Load state machine config (env var for override path)
const stateMachineConfigPath = resolveEnv("RALPH_STATE_MACHINE_CONFIG");
const stateMachine = loadStateMachine(stateMachineConfigPath);
```

Update `registerIssueTools` call to pass `stateMachine`:

```typescript
registerIssueTools(server, client, fieldCache, stateMachine);
```

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes (existing tests unaffected)
- [ ] State machine types enforce valid state names at compile time

#### Manual Verification:
- [ ] StateMachine class correctly validates transitions from the graph
- [ ] Semantic intent resolution returns correct states per command

---

## Phase 2: Implement `handoff_ticket` Tool

### Overview

Create the `ralph_hero__handoff_ticket` tool that replaces `update_workflow_state`. Accepts either semantic intents or explicit state names. Validates transitions, posts audit comments, returns structured guidance.

### Changes Required

#### 1. handoff_ticket Tool Registration

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Replace `ralph_hero__update_workflow_state` (lines 995-1035) with `ralph_hero__handoff_ticket`

```typescript
// -------------------------------------------------------------------------
// ralph_hero__handoff_ticket
// -------------------------------------------------------------------------
server.tool(
  "ralph_hero__handoff_ticket",
  `Transition an issue's workflow state with validation and audit trail.

Accepts EITHER:
- intent: Semantic intent (lock, complete, escalate, reject, close, cancel) resolved per-command
- to_state: Explicit target state name

The command parameter identifies which Ralph phase is requesting the transition,
enabling intent resolution and command-specific output state validation.

Always requires a reason, which is posted as a GitHub issue comment for audit trail.

Returns: previous state, new state, allowed next transitions, expected commands.
Rejects invalid transitions with the list of valid target states.`,
  {
    owner: z.string().optional().describe("GitHub owner. Defaults to GITHUB_OWNER env var"),
    repo: z.string().optional().describe("Repository name. Defaults to GITHUB_REPO env var"),
    number: z.number().describe("Issue number"),
    command: z.enum(["triage", "split", "research", "plan", "review", "impl", "hero"])
      .describe("Which Ralph command is requesting this transition"),
    intent: z.enum(["lock", "complete", "escalate", "reject", "close", "cancel"])
      .optional()
      .describe("Semantic intent - resolved to concrete state per command. Mutually exclusive with to_state."),
    to_state: z.string()
      .optional()
      .describe("Explicit target state name. Mutually exclusive with intent."),
    reason: z.string()
      .describe("Why this transition is happening. Posted as GitHub issue comment for audit trail."),
  },
  async (args) => {
    try {
      // --- Input validation ---
      if (args.intent && args.to_state) {
        return toolError(
          "Provide either 'intent' or 'to_state', not both. " +
          "Use intent for semantic transitions (e.g., 'complete'), " +
          "use to_state for explicit state names (e.g., 'Ready for Plan')."
        );
      }
      if (!args.intent && !args.to_state) {
        return toolError(
          "Must provide either 'intent' or 'to_state'. " +
          "Available intents: lock, complete, escalate, reject, close, cancel."
        );
      }

      const { owner, repo, projectNumber, projectOwner } = resolveFullConfig(client, args);

      // --- Resolve target state ---
      let targetState: string;
      if (args.intent) {
        const resolved = stateMachine.resolveIntent(args.intent, args.command);
        if (resolved === null) {
          return toolError(
            `Intent '${args.intent}' has no mapping for command '${args.command}'. ` +
            `This intent may not be applicable to this phase of the workflow.`
          );
        }
        targetState = resolved;
      } else {
        targetState = args.to_state!;
      }

      // --- Validate target state exists ---
      if (!stateMachine.isValidState(targetState)) {
        return toolError(
          `'${targetState}' is not a valid workflow state. ` +
          `Valid states: ${Object.keys(stateMachine['config'].states).join(", ")}`
        );
      }

      // --- Fetch current state ---
      await ensureFieldCache(client, fieldCache, projectOwner, projectNumber);
      const currentState = await getCurrentFieldValue(
        client, fieldCache, owner, repo, args.number, "Workflow State",
      );

      if (!currentState) {
        return toolError(
          `Could not determine current workflow state for issue #${args.number}. ` +
          `The issue may not be in the project.`
        );
      }

      // --- Validate transition ---
      if (!stateMachine.isValidState(currentState)) {
        // Current state not in our state machine - allow transition but warn
        // This handles edge cases like manually-set states
      } else if (!stateMachine.isValidTransition(currentState as WorkflowState, targetState as WorkflowState)) {
        const allowed = stateMachine.getAllowedTransitions(currentState as WorkflowState);
        return toolError(
          `Invalid transition: '${currentState}' → '${targetState}'. ` +
          `Allowed transitions from '${currentState}': ${allowed.length > 0 ? allowed.join(", ") : "(terminal state - no transitions allowed)"}. ` +
          `If this ticket needs to go backward, use intent='reject' or intent='escalate'.`
        );
      }

      // --- Validate command output state ---
      if (!stateMachine.isValidOutputForCommand(args.command, targetState as WorkflowState)) {
        const cmdConfig = stateMachine['config'].commands[`ralph_${args.command}`];
        return toolError(
          `Command '${args.command}' is not allowed to transition to '${targetState}'. ` +
          `Valid output states for ${args.command}: ${cmdConfig?.valid_output_states.join(", ") ?? "unknown"}.`
        );
      }

      // --- Execute transition ---
      const projectItemId = await resolveProjectItemId(client, fieldCache, owner, repo, args.number);
      await updateProjectItemField(client, fieldCache, projectItemId, "Workflow State", targetState);

      // --- Post audit comment ---
      const intentLabel = args.intent ? ` (intent: ${args.intent})` : "";
      const commentBody = [
        `**State transition**: ${currentState} → ${targetState}${intentLabel}`,
        `**Command**: ralph_${args.command}`,
        `**Reason**: ${args.reason}`,
      ].join("\n");

      await client.mutate(
        `mutation($issueId: ID!, $body: String!) {
          addComment(input: { subjectId: $issueId, body: $body }) {
            commentEdge { node { id } }
          }
        }`,
        {
          issueId: await resolveIssueNodeId(client, owner, repo, args.number),
          body: commentBody,
        },
      );

      // --- Build response with guidance ---
      const newAllowed = stateMachine.getAllowedTransitions(targetState as WorkflowState);
      const expectedBy = stateMachine.getExpectedByCommands(targetState as WorkflowState);
      const isLock = stateMachine.isLockState(targetState as WorkflowState);
      const isTerminal = stateMachine.isTerminal(targetState as WorkflowState);
      const needsHuman = stateMachine.requiresHumanAction(targetState as WorkflowState);

      return toolSuccess({
        number: args.number,
        previousState: currentState,
        newState: targetState,
        intent: args.intent ?? null,
        command: args.command,
        reason: args.reason,
        guidance: {
          isLockState: isLock,
          isTerminal,
          requiresHumanAction: needsHuman,
          allowedNextTransitions: newAllowed,
          expectedByCommands: expectedBy,
          ...(isLock && { note: "Lock acquired. This issue is now exclusively claimed." }),
          ...(isTerminal && { note: "Terminal state. No further transitions possible." }),
          ...(needsHuman && { note: "Human action required before next transition." }),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to handoff ticket: ${message}`);
    }
  },
);
```

#### 2. Wire resolveIssueNodeId into issue-tools scope

The `resolveIssueNodeId` helper currently exists in `relationship-tools.ts`. We need it available in `issue-tools.ts` for posting comments. Either:
- Move to a shared utility (e.g., `lib/resolve.ts`)
- Or duplicate the GraphQL query inline

Recommend extracting to `lib/resolve.ts` to avoid duplication.

**File**: `mcp-server/src/lib/resolve.ts` (NEW)

```typescript
import type { GitHubClient } from "../github-client.js";

export async function resolveIssueNodeId(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<string> {
  const cacheKey = `issue-node-id:${owner}/${repo}#${number}`;
  const cached = client.getCache().get<string>(cacheKey);
  if (cached) return cached;

  const result = await client.query<{
    repository: { issue: { id: string } | null } | null;
  }>(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) { id }
      }
    }`,
    { owner, repo, number },
  );

  const nodeId = result.repository?.issue?.id;
  if (!nodeId) throw new Error(`Issue #${number} not found in ${owner}/${repo}`);

  client.getCache().set(cacheKey, nodeId, 30 * 60 * 1000);
  return nodeId;
}
```

Update `relationship-tools.ts` to import from `lib/resolve.ts` instead of defining locally.

#### 3. Update registerIssueTools signature

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Add `stateMachine` parameter and import types

```typescript
import { StateMachine, type WorkflowState } from "../lib/state-machine.js";
import { resolveIssueNodeId } from "../lib/resolve.js";

export function registerIssueTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
  stateMachine: StateMachine,  // NEW
): void {
  // ... existing tools ...
}
```

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes including new handoff_ticket tests
- [ ] Calling `handoff_ticket` with `intent: "complete", command: "research"` returns `newState: "Ready for Plan"`
- [ ] Calling `handoff_ticket` with invalid transition returns error with allowed transitions
- [ ] Calling `handoff_ticket` with both `intent` and `to_state` returns error
- [ ] Calling `handoff_ticket` with neither `intent` nor `to_state` returns error

#### Manual Verification:
- [ ] GitHub issue comment is created on successful transition
- [ ] Comment includes previous state, new state, command, and reason

---

## Phase 3: Remove `update_workflow_state` and Update References

### Overview

Delete the old tool and update all skill/agent markdown files that reference workflow state updates to use `handoff_ticket` instead.

### Changes Required

#### 1. Remove update_workflow_state

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: Delete lines 995-1035 (the `ralph_hero__update_workflow_state` tool registration)

#### 2. Update Skill Definitions

Search all skill files in `ralph-hero/plugin/ralph-hero/skills/` for references to `update_workflow_state` and replace with `handoff_ticket` usage patterns.

For each skill that transitions state, update the instructions to use:

```
ralph_hero__handoff_ticket(
  number: <issue-number>,
  command: "<current-command>",
  intent: "complete",
  reason: "<what was accomplished>"
)
```

Instead of:

```
ralph_hero__update_workflow_state(
  number: <issue-number>,
  state: "Ready for Plan"
)
```

#### 3. Update Agent Definitions

Search agents in `ralph-hero/plugin/ralph-hero/agents/` for state transition references and update tool names.

#### 4. Update Tool Lists

Any agent or skill that lists `ralph_hero__update_workflow_state` in its `tools:` frontmatter needs updating to `ralph_hero__handoff_ticket`.

### Success Criteria

#### Automated Verification:
- [ ] `npm run build` compiles (no references to deleted tool)
- [ ] `npm test` passes
- [ ] `grep -r "update_workflow_state" ralph-hero/plugin/ralph-hero/` returns no matches
- [ ] No skill or agent markdown references the old tool name

#### Manual Verification:
- [ ] Full ralph-hero workflow completes using only `handoff_ticket` for state transitions

---

## Phase 4: Tests

### Overview

Add unit tests for the StateMachine class and integration-style tests for the handoff_ticket tool.

### Changes Required

#### 1. State Machine Unit Tests

**File**: `mcp-server/src/__tests__/state-machine.test.ts` (NEW)

Tests:
- Valid transitions accepted
- Invalid transitions rejected
- Terminal states have no transitions
- Lock states correctly identified
- Semantic intent resolution per command
- Wildcard intent fallback
- Unknown command intent returns null
- `isValidState` rejects unknown strings
- `getExpectedByCommands` returns correct command list
- `isValidOutputForCommand` enforces per-command output states
- Config loading falls back to defaults on missing file

#### 2. Handoff Ticket Tool Tests

**File**: `mcp-server/src/__tests__/handoff-ticket.test.ts` (NEW)

Tests (mocked GitHub client):
- Happy path: semantic intent resolves and transitions
- Happy path: explicit `to_state` transitions
- Rejects when both `intent` and `to_state` provided
- Rejects when neither `intent` nor `to_state` provided
- Rejects invalid transition (not in allowed_transitions)
- Rejects invalid output state for command
- Rejects unresolvable semantic intent
- Rejects unknown state name
- Posts comment on successful transition
- Returns structured guidance (lock, terminal, human needed)
- Handles missing project item gracefully

### Success Criteria

#### Automated Verification:
- [ ] `npm test` passes all new tests
- [ ] Coverage includes all StateMachine methods
- [ ] Coverage includes all handoff_ticket error paths

#### Manual Verification:
- [ ] Test output is clean with descriptive test names

---

## Testing Strategy

### Unit Tests
- StateMachine class: transition validation, intent resolution, state queries
- handoff_ticket tool: input validation, error paths, response structure

### Integration Tests
- Mock GitHub GraphQL client to verify:
  - `updateProjectItemField` called with correct args
  - `addComment` mutation called with audit trail
  - Cache interactions (field cache population, node ID resolution)

### Manual Testing Steps
1. Build and publish: `cd mcp-server && npm run build`
2. Start Claude Code with plugin: `claude --plugin-dir ./ralph-hero`
3. Call `handoff_ticket` with valid intent → verify state change + comment on GitHub
4. Call `handoff_ticket` with invalid transition → verify rejection message
5. Run `/ralph-research` on a test issue → verify it uses `handoff_ticket` for lock + complete
6. Verify `update_workflow_state` no longer appears in tool list

## Performance Considerations

- State machine config is loaded once at startup, held in memory (negligible)
- Each `handoff_ticket` call adds one extra API call vs the old tool: the `addComment` mutation for audit trail
- `getCurrentFieldValue` is already called by the old tool so no additional cost there
- The `resolveIssueNodeId` call for comments uses the existing cache (30-min TTL)

## Migration Notes

- Old `update_workflow_state` calls in skill markdown become `handoff_ticket` calls
- Skills must now specify `command` parameter (identifies which phase)
- Skills must now provide `reason` parameter (audit trail)
- Semantic intents (`complete`, `lock`, etc.) are preferred over explicit state names for portability

## References

- State machine definition: `landcrawler-ai/.claude/hooks/ralph-state-machine.json`
- Existing MCP server: `ralph-hero/plugin/ralph-hero/mcp-server/src/`
- Semantic intent hook (inspiration): `landcrawler-ai/.claude/hooks/ralph-auto-state.sh`
- Discussion: Session conversation about hook enforcement vs protocol-level enforcement
