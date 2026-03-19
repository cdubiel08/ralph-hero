---
type: plan
date: 2026-02-27
status: draft
github_issues: [433]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/433
primary_issue: 433
---

# RALPH_HERO_AUTO: Auto-Mode Pipeline Detection

## Overview

Add a `RALPH_HERO_AUTO` environment variable that controls whether Ralph treats "In Review" as a terminal human gate or as an actionable `INTEGRATE` phase. When enabled, `detect_pipeline_position` returns `INTEGRATE` instead of `TERMINAL` for issues in "In Review", allowing the integrator worker to autonomously review and merge PRs.

## Current State Analysis

`detect_pipeline_position` in `pipeline-detection.ts:276-287` treats "In Review" the same as "Done" and "Canceled" — all three trigger `TERMINAL` phase with no remaining work. This blocks `ralph-team` from spawning an integrator.

There's also a contradiction: `computeSuggestedRoster` (line 372-396) still returns `{ builder: 1, integrator: 1 }` for TERMINAL phase, suggesting workers that will never be spawned.

### Key Discoveries:
- Step 9 logic at `pipeline-detection.ts:276-287` combines In Review + Done + Canceled into one terminal check
- `REMAINING_PHASES` at `pipeline-detection.ts:69-79` maps TERMINAL → `[]` (empty)
- `computeSuggestedRoster` at `pipeline-detection.ts:372-396` doesn't special-case TERMINAL — it always returns builder ≥ 1, integrator ≥ 1
- Env var pattern: all config flows through `index.ts:33-123` → `GitHubClientConfig` → `client.config`
- `detectPipelinePosition` is a pure function with positional params; the codebase uses trailing `options` objects for extensible config (see `paginateConnection`)
- `detectStreamPipelinePositions` at `pipeline-detection.ts:344-366` internally calls `detectPipelinePosition` — needs the options threaded through
- Tests at `pipeline-detection.test.ts:30-39` use `detectSingle`/`detectGroup` wrappers — easy to extend with options

## Desired End State

- `RALPH_HERO_AUTO=true` in env → `detect_pipeline_position` returns `phase: "INTEGRATE"` for issues in "In Review" (not TERMINAL)
- `RALPH_HERO_AUTO` unset or `false` → existing behavior preserved exactly
- `INTEGRATE` phase has `remainingPhases: ["integrate"]` and `suggestedRoster: { analyst: 0, builder: 0, integrator: 1 }`
- TERMINAL phase roster is fixed to `{ analyst: 0, builder: 0, integrator: 0 }` (consistency fix)
- `team-stop-gate.sh` respects `RALPH_HERO_AUTO` — includes "In Review" in processable states when enabled

### Verification:
- `npm test` passes with new INTEGRATE tests and updated TERMINAL tests
- `npm run build` compiles cleanly
- Existing tests pass unchanged (default `autoMode: false` preserves behavior)

## What We're NOT Doing

- Not adding per-call `autoMode` override on the MCP tool schema — this is a global env setting only
- Not changing `HUMAN_STATES` or `TERMINAL_STATES` constants in `workflow-states.ts` — those are semantic definitions, not detection logic
- Not implementing the actual integrate/merge behavior — that's the integrator skill's job
- Not addressing #432 (team-stop-gate missing "In Review") as a separate concern, though Phase 2 makes the stop gate auto-mode-aware

## Implementation Approach

Thread `autoMode` from env → config → tool handler → pure detection function via a trailing options object. Keep the detection function pure and testable.

## Phase 1: Core Detection Logic

### Overview
Add `INTEGRATE` phase type, thread `autoMode` option through detection, and fix roster consistency.

### Changes Required:

#### 1. Add INTEGRATE phase and options type
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: Add INTEGRATE to PipelinePhase union, add options interface, add REMAINING_PHASES entry

```typescript
// Line 16-25: Add INTEGRATE to union
export type PipelinePhase =
  | "SPLIT"
  | "TRIAGE"
  | "RESEARCH"
  | "PLAN"
  | "REVIEW"
  | "IMPLEMENT"
  | "INTEGRATE"   // NEW
  | "COMPLETE"
  | "HUMAN_GATE"
  | "TERMINAL";

// After line 57: Add options interface
export interface DetectionOptions {
  /** When true, "In Review" maps to INTEGRATE instead of TERMINAL */
  autoMode?: boolean;
}

// Line 69-79: Add INTEGRATE entry
const REMAINING_PHASES: Record<PipelinePhase, string[]> = {
  SPLIT: ["split", "triage", "research", "plan", "review", "implement", "pr"],
  TRIAGE: ["triage", "research", "plan", "review", "implement", "pr"],
  RESEARCH: ["research", "plan", "review", "implement", "pr"],
  PLAN: ["plan", "review", "implement", "pr"],
  REVIEW: ["review", "implement", "pr"],
  IMPLEMENT: ["implement", "pr"],
  INTEGRATE: ["integrate"],  // NEW
  COMPLETE: ["pr"],
  HUMAN_GATE: [],
  TERMINAL: [],
};
```

#### 2. Update detectPipelinePosition signature and Step 9
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: Add trailing options param, split Step 9 based on autoMode

```typescript
// Line 113-117: Add options parameter
export function detectPipelinePosition(
  issues: IssueState[],
  isGroup: boolean,
  groupPrimary: number | null,
  options: DetectionOptions = {},  // NEW — defaults to {} so all callers still work
): PipelinePosition {

// Line 276-287: Split Step 9
  // Step 9: All issues in review/done/canceled
  const terminalCount = inReview.length + done.length + canceled.length;
  if (terminalCount === issues.length) {
    // In auto mode, "In Review" issues are actionable (integrator can merge)
    if (options.autoMode && inReview.length > 0 && done.length + canceled.length < issues.length) {
      return buildResult(
        "INTEGRATE",
        `${inReview.length} issue(s) awaiting integration`,
        issues,
        isGroup,
        groupPrimary,
        { required: false, met: true, blocking: [] },
      );
    }
    return buildResult(
      "TERMINAL",
      "All issues in review or done",
      issues,
      isGroup,
      groupPrimary,
      { required: false, met: true, blocking: [] },
    );
  }
```

The condition `inReview.length > 0 && done.length + canceled.length < issues.length` ensures:
- At least one issue is "In Review" (not all Done/Canceled)
- If ALL issues are Done/Canceled (none In Review), it's truly TERMINAL even in auto mode

#### 3. Update detectStreamPipelinePositions to thread options
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: Add options param, pass through to detectPipelinePosition

```typescript
// Line 344-347: Add options parameter
export function detectStreamPipelinePositions(
  streams: WorkStream[],
  issueStates: IssueState[],
  options: DetectionOptions = {},  // NEW
): StreamPipelineResult[] {
  // ...
  return streams.map((stream) => {
    // ...
    return {
      streamId: stream.id,
      issues: filteredIssues,
      position: detectPipelinePosition(filteredIssues, isGroup, groupPrimary, options),  // Thread options
    };
  });
}
```

#### 4. Fix computeSuggestedRoster for TERMINAL and INTEGRATE
**File**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
**Changes**: Return empty roster for TERMINAL, integrator-only for INTEGRATE

```typescript
// Line 372-396: Add phase-specific overrides at top of function
function computeSuggestedRoster(
  phase: PipelinePhase,
  issues: IssueState[],
): SuggestedRoster {
  // TERMINAL: no workers needed
  if (phase === 'TERMINAL') {
    return { analyst: 0, builder: 0, integrator: 0 };
  }
  // INTEGRATE: only integrator needed
  if (phase === 'INTEGRATE') {
    return { analyst: 0, builder: 0, integrator: 1 };
  }

  // ... rest of existing logic unchanged ...
}
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` compiles with no errors
- [ ] `npm test` passes — all existing tests pass (default options = backward compatible)
- [ ] New tests pass for INTEGRATE phase (see Phase 2)

#### Manual Verification:
- [ ] `detect_pipeline_position` returns INTEGRATE for "In Review" issue when `RALPH_HERO_AUTO=true`
- [ ] `detect_pipeline_position` returns TERMINAL for "In Review" issue when `RALPH_HERO_AUTO` is unset

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Wiring, Tests, and Stop Gate

### Overview
Wire the env var through config and tool handler, add comprehensive tests, and update the stop gate hook.

### Changes Required:

#### 1. Add autoMode to GitHubClientConfig
**File**: `plugin/ralph-hero/mcp-server/src/types.ts`
**Changes**: Add optional boolean field

```typescript
// After line 273 (templateProjectNumber):
export interface GitHubClientConfig {
  token: string;
  projectToken?: string;
  owner?: string;
  repo?: string;
  projectNumber?: number;
  projectNumbers?: number[];
  projectOwner?: string;
  templateProjectNumber?: number;
  autoMode?: boolean;  // NEW — enables autonomous integration (RALPH_HERO_AUTO)
}
```

#### 2. Read RALPH_HERO_AUTO in index.ts
**File**: `plugin/ralph-hero/mcp-server/src/index.ts`
**Changes**: Add autoMode to client config initialization

```typescript
// After line 85 (templateProjectNumber):
  const autoMode = resolveEnv("RALPH_HERO_AUTO") === "true";

// In createGitHubClient call (~line 103), add:
  return createGitHubClient({
    token: repoToken,
    // ... existing fields ...
    templateProjectNumber,
    autoMode,  // NEW
  }, debugLogger);
```

#### 3. Pass autoMode from tool handler to detection function
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Pass `client.config.autoMode` to `detectPipelinePosition`

```typescript
// Line 1411-1416: Thread autoMode
        const position = detectPipelinePosition(
          issueStates,
          group.isGroup,
          group.groupPrimary.number,
          { autoMode: client.config.autoMode },  // NEW
        );
```

#### 4. Thread autoMode in dashboard tools (detectStreamPipelinePositions caller)
**File**: `plugin/ralph-hero/mcp-server/src/tools/dashboard-tools.ts`
**Changes**: Pass autoMode to `detectStreamPipelinePositions`

Find the call to `detectStreamPipelinePositions` and add options:

```typescript
        const positions = detectStreamPipelinePositions(
          streamResult.streams,
          states,
          { autoMode: client.config.autoMode },  // NEW
        );
```

#### 5. Add tests for INTEGRATE phase and autoMode
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts`
**Changes**: Add new describe block for auto mode, update wrappers

```typescript
// Update helpers to support options:
function detectSingle(
  issue: IssueState,
  options?: DetectionOptions,
): ReturnType<typeof detectPipelinePosition> {
  return detectPipelinePosition([issue], false, issue.number, options);
}

function detectGroup(
  issues: IssueState[],
  options?: DetectionOptions,
): ReturnType<typeof detectPipelinePosition> {
  return detectPipelinePosition(issues, true, issues[0]?.number ?? null, options);
}

// New describe block:
describe("detectPipelinePosition - auto mode (RALPH_HERO_AUTO)", () => {
  const auto = { autoMode: true };

  it("returns INTEGRATE for In Review (single issue)", () => {
    const result = detectSingle(makeIssue(1, "In Review"), auto);
    expect(result.phase).toBe("INTEGRATE");
    expect(result.remainingPhases).toEqual(["integrate"]);
  });

  it("returns INTEGRATE for group with all In Review", () => {
    const result = detectGroup([
      makeIssue(1, "In Review"),
      makeIssue(2, "In Review"),
    ], auto);
    expect(result.phase).toBe("INTEGRATE");
  });

  it("returns INTEGRATE for mixed In Review + Done (some still need integration)", () => {
    const result = detectGroup([
      makeIssue(1, "In Review"),
      makeIssue(2, "Done"),
    ], auto);
    expect(result.phase).toBe("INTEGRATE");
  });

  it("returns TERMINAL for all Done even in auto mode", () => {
    const result = detectGroup([
      makeIssue(1, "Done"),
      makeIssue(2, "Done"),
    ], auto);
    expect(result.phase).toBe("TERMINAL");
  });

  it("returns TERMINAL for all Canceled even in auto mode", () => {
    const result = detectSingle(makeIssue(1, "Canceled", "S", 0), auto);
    // Canceled goes through Human Needed check (step 10), not step 9
    // Actually: Canceled is in the terminal count. All Canceled = TERMINAL.
  });

  it("returns TERMINAL for Done + Canceled (no In Review) in auto mode", () => {
    const result = detectGroup([
      makeIssue(1, "Done"),
      makeIssue(2, "Canceled"),
    ], auto);
    expect(result.phase).toBe("TERMINAL");
  });

  it("without autoMode, In Review still returns TERMINAL (backward compat)", () => {
    const result = detectSingle(makeIssue(1, "In Review"));
    expect(result.phase).toBe("TERMINAL");
  });

  it("INTEGRATE roster is integrator-only", () => {
    const result = detectSingle(makeIssue(1, "In Review"), auto);
    expect(result.suggestedRoster).toEqual({ analyst: 0, builder: 0, integrator: 1 });
  });

  it("TERMINAL roster is empty", () => {
    const result = detectSingle(makeIssue(1, "Done"));
    expect(result.suggestedRoster).toEqual({ analyst: 0, builder: 0, integrator: 0 });
  });
});
```

#### 6. Update team-stop-gate.sh for auto mode
**File**: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh`
**Changes**: Include "In Review" when RALPH_HERO_AUTO is set

```bash
# Line 27: Make STATES array conditional on RALPH_HERO_AUTO
STATES=("Backlog" "Research Needed" "Ready for Plan" "Plan in Review" "In Progress")
if [[ "${RALPH_HERO_AUTO:-}" == "true" ]]; then
  STATES+=("In Review")
fi
```

#### 7. Update tool description
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
**Changes**: Mention INTEGRATE phase in tool description

Update the description string at line 1334 to include INTEGRATE:
```
"Determine which workflow phase to execute next for an issue or its group. Returns: phase (SPLIT/TRIAGE/RESEARCH/PLAN/REVIEW/IMPLEMENT/INTEGRATE/COMPLETE/HUMAN_GATE/TERMINAL), convergence status with recommendation (proceed/wait/escalate), all group member states, and remaining phases. INTEGRATE phase appears when RALPH_HERO_AUTO=true and issues are In Review. Call this INSTEAD of separate detect_group + check_convergence calls. Recovery: if issue not found, verify the issue number and that it has been added to the project."
```

### Success Criteria:

#### Automated Verification:
- [ ] `npm run build` compiles cleanly
- [ ] `npm test` passes — all tests including new auto mode tests
- [ ] Existing tests unchanged and passing (backward compatibility)

#### Manual Verification:
- [ ] With `RALPH_HERO_AUTO=true`, `detect_pipeline_position` on an "In Review" issue returns `{ phase: "INTEGRATE", remainingPhases: ["integrate"], suggestedRoster: { analyst: 0, builder: 0, integrator: 1 } }`
- [ ] Without `RALPH_HERO_AUTO`, same call returns `{ phase: "TERMINAL", remainingPhases: [], suggestedRoster: { analyst: 0, builder: 0, integrator: 0 } }`
- [ ] `ralph-team` on an "In Review" issue spawns an integrator when `RALPH_HERO_AUTO=true`

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Testing Strategy

### Unit Tests:
- All new tests in `pipeline-detection.test.ts` (pure function, no mocks needed)
- INTEGRATE phase: single issue, group, mixed In Review + Done, remaining phases, roster
- Backward compat: existing TERMINAL tests pass without options arg
- Roster fix: TERMINAL returns `{ 0, 0, 0 }`, INTEGRATE returns `{ 0, 0, 1 }`

### Integration Tests:
- Manual: invoke `detect_pipeline_position` MCP tool with `RALPH_HERO_AUTO=true` on an "In Review" issue
- Manual: run `ralph-team` on an "In Review" issue with auto mode enabled

## References

- Issue: #433
- Sister issue: #432 (team-stop-gate.sh missing "In Review")
- Pipeline detection: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts`
- Workflow states: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts`
- Tool handler: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:1329-1419`
- Config types: `plugin/ralph-hero/mcp-server/src/types.ts:264-273`
- Env var init: `plugin/ralph-hero/mcp-server/src/index.ts:33-123`
- Stop gate hook: `plugin/ralph-hero/hooks/scripts/team-stop-gate.sh`
- Tests: `plugin/ralph-hero/mcp-server/src/__tests__/pipeline-detection.test.ts`
