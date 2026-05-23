---
description: Event classifier and team dispatcher. Reads next_actions, classifies the top event via the taxonomy table in event-classes.md, and dispatches the correct team via Skill(). Accepts an optional --issue override or trigger:<team> label inputs. Consumes trigger:<team> labels after dispatch.
argument-hint: "[optional: --issue NNN]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=director"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh"
allowed-tools:
  - Skill
  - Read
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - ScheduleWakeup
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Director skill: /ralph-hero:director

# Ralph Director — Event Classifier and Team Dispatcher

Director is a pure dispatcher. It reads the project queue, classifies the top event, and dispatches the correct team. It does not implement work, does not modify files outside `director/`, and does not run team operators directly. Classification is always a lookup against `event-classes.md` — never by instinct.

## Remote-trigger contract

> **DEPRECATED — `RemoteTrigger` source (Priority 1) cannot be exercised end-to-end.** Cloud Routines (the only producer surface that fires `RemoteTrigger` tool inputs) do not currently install ralph-hero plugins at session start, so a Routine that POSTs to a `/fire` endpoint starts a cloud session where Director itself is "Unknown skill" and never runs. The wire is preserved here for the day Anthropic ships imperative cloud plugin install; until then, **do not build new producers against `RemoteTrigger`**. The shipped producer in `scripts/monitoring-bridge/subscribe.py` (GH-1300, PR #1310) is similarly inert. Verified empirically 2026-05-22; see PRs #1352/#1353 and the `cloud-routines-plugin-install-gap` memory.

Director accepts events from three sources in priority order:

1. **`RemoteTrigger` tool inputs** *(deprecated, see callout above)* — if surfaced by the harness, these arrive as structured tool arguments and take precedence over all other inputs.
2. **`trigger:<team>` issue labels** — checked via `get_issue` labels array after fetching the candidate issue. Consumed (removed) after dispatch.
3. **`/schedule` heartbeat or direct CLI invocation** — no explicit input; Director reads `next_actions` and picks the top-ranked event.

## Workflow

### Step 1: Parse arguments and detect input source

Parse `$ARGUMENTS` for an optional `--issue NNN` flag.

- If `--issue NNN` is present: set `TARGET_ISSUE=NNN`. Skip to Step 2b.
- If a `RemoteTrigger` tool input is present in the session context: extract `issue_number` and `team` from the tool payload. Set `TARGET_ISSUE`, `FORCED_TEAM`, and `DISPATCH_REASON=RemoteTrigger`. Skip to Step 4 (dispatch directly with `FORCED_TEAM`).
- Otherwise: proceed to Step 2a (read `next_actions`).

### Step 2a: Read next_actions (no issue override)

Call `next_actions({})` to get the ranked project queue. Do NOT recompute ranking — reuse the tool's output as-is.

- If the queue is empty or all issues are in terminal states (`Done`, `Canceled`): emit `result: Queue empty. No events to dispatch.` and STOP.
- Select the top-ranked direction (the entry marked `recommended: true`, or the first entry if none is marked). Resolve `TARGET_ISSUE` from the direction based on its `kind` — process only this one direction per invocation:
  - `kind: "issue" | "tree-continue" | "lock-stale" | "human-needed-unblock"` → `TARGET_ISSUE = direction.issue.number`. Proceed to Step 2b.
  - `kind: "pr"` → `direction.issue` is `null`. `direction.signals.linkedIssueNumber` is guaranteed to be set because `next_actions` filters out PRs with a null `linkedIssueNumber` at the source (see `mcp-server/src/lib/directions.ts`; unlinkable PRs are handled by the pr-drain Routine, not Director). Set `TARGET_ISSUE = direction.signals.linkedIssueNumber` and proceed to Step 2b; Step 3 classifies the linked issue's `workflowState` via the taxonomy.

### Step 2b: Fetch specific issue (--issue override or label trigger)

Call `get_issue({ number: TARGET_ISSUE })` to get full issue details including `workflowState`, `labels`, and current state.

Store: `ISSUE_WORKFLOW_STATE`, `ISSUE_LABELS[]`.

### Step 3: Classify via taxonomy

Read `event-classes.md` from the Director skill directory (`plugin/ralph-hero/skills/director/event-classes.md`). This file is the **single source of truth** for team routing. Director does not route by instinct.

Apply the classification algorithm in this exact priority order:

**Priority 1 — Explicit trigger labels (highest priority):**
Scan `ISSUE_LABELS[]` for any label matching `trigger:<team>`. First match wins.
- `trigger:builders` → team: `builders`, entrypoint: `ralph-hero:hero`
- `trigger:watch` → team: `watchers`, entrypoint: `ralph-hero:watch`
- `trigger:scouts` → team: `scouts`, entrypoint: `ralph-hero:scouts`
- `trigger:caretake` → team: `caretakers`, entrypoint: `ralph-hero:caretake`
- `trigger:memorykeepers` → team: `memorykeepers`, entrypoint: none (emit `needs input:` marker)

Set `DISPATCH_REASON=trigger:<label>` and `CONSUMED_LABEL=<matched label>`.

**Priority 2 — Automation labels:**
If no `trigger:*` label matched, scan `ISSUE_LABELS[]` for automation labels:
- `watcher-auto` → team: `watchers`, entrypoint: `ralph-hero:watch`
- `scout-auto` → team: `scouts`, entrypoint: `ralph-hero:scouts`
- `process-improvement` → team: `caretakers`, entrypoint: `ralph-hero:caretake`

Set `DISPATCH_REASON=label:<matched-label>`. No label consumption for automation labels (they are managed by their producers).

**Priority 3 — Workflow state (fallback):**
If no label matched, look up `ISSUE_WORKFLOW_STATE` in the taxonomy table:
- `Backlog` → team: `caretakers`, entrypoint: `ralph-hero:caretake`
- `Research Needed`, `Research in Progress`, `Ready for Plan`, `Plan in Progress`, `Plan in Review`, `In Progress`, `In Review` → team: `builders`, entrypoint: `ralph-hero:hero`
- `Human Needed` → team: `caretakers`, entrypoint: `ralph-hero:caretake`
- `Done`, `Canceled` → terminal, skip dispatch. Emit `result: #NNN is terminal (${ISSUE_WORKFLOW_STATE}). Skipping.` and STOP.

Set `DISPATCH_REASON=workflow_state:${ISSUE_WORKFLOW_STATE}`.

### Step 4: Dispatch via Skill()

Director dispatches using `Skill()`. It does NOT call `Agent()` — Director is an orchestrator, not a worker. Team entrypoints receive the issue number as a bare number `NNN` (not `--issue NNN`).

**iOS-mode sentinel write (Feature H contract):**

Before the `Skill()` call, if `DISPATCH_REASON` starts with `trigger:` OR equals `RemoteTrigger`, write the iOS-mode sentinel:

```bash
touch "${TMPDIR:-/tmp}/ralph-ios-mode"
```

This signals downstream producers (Feature H) that the current dispatch is iOS-initiated. Workflow_state-driven dispatches (Priority 3) do NOT write the sentinel — only Priority 1 (`trigger:*`) and `RemoteTrigger` paths do. The sentinel may persist until session end; that is intentional — producers running inside the dispatched session see it. No explicit cleanup is required.

**Team → entrypoint mapping:**

| team | entrypoint | status |
|------|-----------|--------|
| builders | `ralph-hero:hero` | live |
| watchers | `ralph-hero:watch` | pending Feature C (GH-1270) |
| scouts | `ralph-hero:scouts` | pending Feature F (GH-1273) |
| memorykeepers | manual `dream-now` | no skill; Director emits `needs input:` |
| caretakers | `ralph-hero:caretake` | live (Feature G, GH-1274) |

**If the target entrypoint exists (builders / live teams):**

```
Skill("<entrypoint>", args="NNN")
```

Emit before dispatch: `Classified #NNN as <team> (reason: <DISPATCH_REASON>). Dispatching <entrypoint>.`

**If the target entrypoint does not yet exist:**

Do NOT attempt to dispatch. Emit:

```
needs input: team <name> not yet implemented (Feature <X>); skipping dispatch.
```

Then proceed to Step 5 (label consumption) and Step 6 (result marker).

Director does NOT implement work itself. Director does NOT explain the team's job. Director classifies, dispatches, and stops.

### Step 5: Consume trigger:<team> label (if applicable)

This step runs only when dispatch was triggered by a `trigger:*` label (`CONSUMED_LABEL` is set).

After successful dispatch initiation (Skill() called or `needs input:` emitted for an unimplemented team), remove the trigger label via `save_issue`:

1. Fetch the current labels for `TARGET_ISSUE` (from the Step 2b response — do not re-fetch unless the fetch was stale).
2. Build `NEW_LABELS = ISSUE_LABELS[] minus CONSUMED_LABEL`.
3. Call `save_issue({ number: TARGET_ISSUE, labels: NEW_LABELS })`.

Label is removed **after** dispatch initiation, not after team completion. Teams may run long; consumption is dispatch-edge-triggered.

Automation labels (`watcher-auto`, `scout-auto`, `process-improvement`) are NOT consumed by Director — their producers manage their own lifecycle.

`RemoteTrigger`-sourced events: no label to consume (trigger arrived via tool input, not a GitHub label). Skip this step.

### Step 6: Emit result marker

Always emit a `result:` marker before returning so iOS and other harnesses can parse Director's output:

```
result: Dispatched #NNN to <team> via <entrypoint>. (reason: <DISPATCH_REASON>)
```

Or, if no dispatch was made (unimplemented team):

```
result: #NNN classified as <team> (reason: <DISPATCH_REASON>). No dispatch — team not yet implemented.
```

Or, if queue was empty:

```
result: Queue empty. No events to dispatch.
```

## Constraints

- Director MUST NOT implement work. It only classifies and dispatches.
- Classification MUST use the taxonomy in `event-classes.md` — never route by instinct.
- `trigger:*` labels MUST be consumed after dispatch initiation, not before and not after team completion.
- When a team entrypoint does not yet exist, emit `needs input:` and continue — do not error.
- Director does not maintain iteration counters, audit logs, or cooldown tables. Those belong to `/loop`.
- Director does not call `ScheduleWakeup` itself. When Director is invoked inside `/loop` (via autopilot), `/loop` owns the wakeup cadence.

## Why this design

- **Table-driven routing**: Adding a new event class requires only a one-row PR to `event-classes.md`. Director's classifier logic does not change.
- **Trigger-label priority**: `trigger:*` labels give humans and iOS shortcuts a direct, auditable override path without requiring a separate tool surface.
- **Consumption at dispatch edge**: Removing the label after dispatch (not after team completion) ensures the trigger is not re-processed on the next tick even if the team runs long or fails.
- **`needs input:` for unimplemented teams**: Director ships before Features C, F, and G. Emitting a marker instead of erroring keeps the system functional during the rollout window.

## See also

- [IOS-REMOTE.md](IOS-REMOTE.md) — user-facing guide: trigger teams from iOS, read `cos` summaries, receive ntfy completion pushes, open Drive artifacts
- [event-classes.md](event-classes.md) — canonical event taxonomy and iOS-mode sentinel contract
- [plugin/ralph-hero/skills/cos/SKILL.md](../cos/SKILL.md) — chief-of-staff five-team rollup
