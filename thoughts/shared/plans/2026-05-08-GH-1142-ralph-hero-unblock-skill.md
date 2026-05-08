---
date: 2026-05-08
status: draft
type: plan
tags: [skills, escalation, human-needed, unblock, async-loop]
github_issue: 1142
github_issues: [1142]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1142
primary_issue: 1142
---

# Ralph Unblock Skill — Implementation Plan

## Prior Work

- Related research: `thoughts/shared/research/2026-04-22-agent-bus-design.md` (escalation team architecture)
- Related research: `thoughts/shared/research/2026-04-05-hero-pipeline-handoff-ux-inventory.md` (closing UX gap, missing `STOP: [reason]` protocol)
- Reference plan (foundry blockers): `thoughts/shared/plans/2026-04-11-palantir-foundry-remaining-surfaces-wave-plan.md` (real-world human-in-the-loop blocker pattern)

## Overview

Add a paired skill that closes the loop on Human Needed issues. `ralph-hero:ralph-unblock` (autonomous) picks an escalated issue and posts pointed blocking questions as a `## Unblock Request` comment. `ralph-hero:unblock` (interactive) walks the human through those questions, posts a `## Unblock Resolution`, and routes the issue back into the pipeline. Hero closes its loop at Human Needed; the unblock skills run as a separate async loop triggered by schedule, external signal, or human attention.

## Current State Analysis

**Human Needed is currently a one-way valve.**

- `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:36-54` defines `COMMAND_ALLOWED_STATES` — no command currently lists Human Needed input states or routes back from it
- `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:29` defines `__ESCALATE__: { "*": "Human Needed" }` — the universal escalation intent
- `plugin/ralph-hero/hooks/scripts/human-needed-outbound-block.sh:38-55` blocks any skill from transitioning issues out of Human Needed (only humans calling `save_issue` directly are allowed)
- `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json:59-65` lists `Human Needed` with `required_by_commands: []` (no skill consumes the state) and `allowed_transitions: ["Backlog", "Research Needed", "Ready for Plan", "In Progress"]`
- `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md:21-34` documents the escalation protocol — every escalation must post a comment via `ralph_hero__create_comment` with `@$RALPH_GH_OWNER Escalation: [reason]`. Many skills already use `## Escalation` as the comment header.

**Skills that escalate today** (each becomes a potential return-state hint for unblock):
- `ralph_research` — escalation typically needs more research context → return state `Research Needed`
- `ralph_plan` / `ralph_plan_epic` — escalation typically needs scope or architectural input → return state `Ready for Plan`
- `ralph_review` — escalation typically needs human plan judgment → return state `Plan in Review` (only reachable via `Ready for Plan`)
- `ralph_impl` — escalation typically needs implementation guidance → return state `In Progress`
- `ralph_pr` / `ralph_merge` / `ralph_code_review` — escalation typically needs PR-level decision → return state `In Progress`
- `ralph_triage` — escalation typically needs scope clarification → return state `Backlog`

### Key Discoveries

- **Idempotency signal**: the `## Unblock Request` and `## Escalation` headers in issue comments are the natural dedup key — autonomous skill must skip if a fresh `## Unblock Request` already exists since the latest `## Escalation`.
- **Knowledge ledger pattern**: `ralph-research` (Step 8) and `ralph-postmortem` (Step 3.5) both call `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` with structured event payloads. New event types `unblock_requested` and `unblock_resolved` follow the same shape.
- **Hello surfacing**: `plugin/ralph-hero/skills/hello/SKILL.md:38-46` calls `ralph_hero__next_actions` and renders directions via `AskUserQuestion`. A new direction `kind: "human-needed-unblock"` slots into the existing dispatch table without restructuring.
- **Triage skill structure** (the closest existing template — `plugin/ralph-hero/skills/ralph-triage/SKILL.md`): `context: fork`, queue-pick by `analyst-triage` profile, branch-gate PreToolUse, state-gate PostToolUse, postcondition Stop hook. Uses the same shape we'll mirror for `ralph-unblock`.

## Desired End State

After this plan is complete, a Human Needed issue moves through the unblock loop like this:

1. Some skill (e.g. `ralph-impl`) hits ambiguity and calls `save_issue(workflowState="__ESCALATE__", command="ralph_impl")` + posts `## Escalation` comment with the question. Hero closes its loop.
2. A scheduled launchd job (or external trigger) fires `ralph-hero:ralph-unblock` (no args) → it queue-picks the oldest Human Needed issue without a fresh `## Unblock Request`, parses the `## Escalation` comment (LLM reasons fresh if absent), synthesizes 1–5 specific blocking questions, posts a `## Unblock Request` comment, records `unblock_requested` outcome event, exits. Issue stays in Human Needed.
3. The user sees the `## Unblock Request` count surfaced by `/ralph-hero:hello` and runs `/ralph-hero:unblock 42` (or `/ralph-hero:unblock` to pick one).
4. Interactive skill loads the issue, the `## Escalation`, and the `## Unblock Request`, walks the human through each question via `AskUserQuestion`, infers a return state from the originating command (with confirmation if ambiguous), posts a `## Unblock Resolution` comment, calls `save_issue(workflowState=<chosen>, command="ralph_unblock")`, records `unblock_resolved` outcome event.
5. The issue is now in (e.g.) `In Progress` — the next pipeline run picks it up and continues from where it stopped.

### Verification

- `sqlite3 ~/.ralph-hero/knowledge.db "SELECT event_type, COUNT(*) FROM outcome_events WHERE event_type LIKE 'unblock_%' GROUP BY event_type"` returns rows for both new event types after a full loop test
- `/ralph-hero:hello` lists "N issues with unblock requests" when count > 0
- A Human Needed issue with `## Escalation` posted, then `ralph-unblock` run, then `unblock` run, ends up in one of the 4 valid re-entry states with `## Unblock Request` and `## Unblock Resolution` comments both posted
- `human-needed-outbound-block.sh` still blocks transitions when `RALPH_COMMAND != "unblock"` (regression test)

## What We're NOT Doing

- **Environment-access channel** (Phase 2 work). v1 only handles human-knowledge gaps. The skill does NOT auto-fetch external APIs / credentials / network resources for sandboxed agents — that's a future enhancement.
- **Auto-firing from hero**. The autonomous skill is independent of hero. Hero ends its loop at Human Needed. We will NOT modify `plugin/ralph-hero/skills/hero/SKILL.md` to chain into unblock.
- **Modifying every escalating skill**. We do NOT change `ralph-research`, `ralph-plan`, `ralph-impl`, etc. The unblock skills consume what those skills already produce (`## Escalation` comments).
- **Question-mode for originator skills**. We will NOT add a "re-run originator in dry-run question-mode" branch. The unblock skill is an LLM reading existing context.
- **Slack / PagerDuty / external notification routing**. The agent-bus design contemplates this; out of scope for v1.
- **A new "Plan in Review" return path**. Human Needed's `allowed_transitions` excludes `Plan in Review` directly. Issues that need re-review must route through `Ready for Plan`. No state-machine change for this.

## Implementation Approach

Foundation-first: bring `ralph_unblock` into the state machine and protocol surface before either skill exists. Each skill is shipped independently and is verifiable on its own. Keep autonomous and interactive concerns split across two SKILL.md files for testability. Reuse existing skill templates (`ralph-triage` for autonomous shape; `hello` for interactive composition).

---

## Phase 1: Foundation — state graph + protocol headers

### Overview

Wire the `ralph_unblock` command into every place state validation happens, extend the outbound-block hook, add the new artifact comment headers, and declare the new outcome event types. None of this is user-visible yet, but each subsequent phase builds on it.

### Changes Required

#### 1. State-resolution allowlist
**File**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts`
**Changes**: Add `ralph_unblock` entry to `COMMAND_ALLOWED_STATES`. No changes to `SEMANTIC_INTENTS` — direct state names are sufficient (the interactive skill always knows its target).

```typescript
const COMMAND_ALLOWED_STATES: Record<string, string[]> = {
  // ... existing entries ...
  ralph_unblock: [
    "Backlog",
    "Research Needed",
    "Ready for Plan",
    "In Progress",
    "Human Needed",
  ],
};
```

The five-state list covers: the four legal Human Needed → re-entry transitions (per state-machine.json) plus `Human Needed` itself so the autonomous variant can call `save_issue` as a no-op (e.g. only label changes) without a state-resolution error.

#### 2. State machine JSON
**File**: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
**Changes**:
- In `states["Human Needed"]`: change `required_by_commands` from `[]` to `["ralph_unblock"]`
- In `states["Backlog"]`, `states["Research Needed"]`, `states["Ready for Plan"]`, `states["In Progress"]`: append `"ralph_unblock"` to `produces_for_commands`
- Add a new entry under `commands` for `ralph_unblock`:

```json
"ralph_unblock": {
  "description": "Bridge Human Needed issues back into the pipeline by capturing missing context",
  "valid_input_states": ["Human Needed"],
  "valid_output_states": ["Backlog", "Research Needed", "Ready for Plan", "In Progress", "Human Needed"],
  "modes": ["autonomous", "interactive"],
  "preconditions": [
    "Must be on main branch",
    "Ticket must be in Human Needed state"
  ],
  "postconditions": [
    "Autonomous mode: ## Unblock Request comment posted, ticket remains Human Needed",
    "Interactive mode: ## Unblock Resolution comment posted, ticket transitioned to one of the 4 valid re-entry states"
  ]
}
```

Note: there's a unit test (`state-resolution.test.ts`) that verifies the TS hardcoded values match this JSON — both must be updated together.

#### 3. Outbound-block hook extension
**File**: `plugin/ralph-hero/hooks/scripts/human-needed-outbound-block.sh`
**Changes**: Insert an early-allow for `RALPH_COMMAND=unblock` after the existing `command` empty-check and before the `current_state` check:

```bash
# Only block if we're in an automated skill context
command="${RALPH_COMMAND:-}"
if [[ -z "$command" ]]; then
  allow  # No skill active — could be a human calling save_issue directly
fi

# unblock is the explicit bridge skill out of Human Needed
if [[ "$command" == "unblock" ]]; then
  allow
fi

# Check current state (set by skill after fetching issue)
current_state="${RALPH_CURRENT_STATE:-}"
# ... rest unchanged
```

#### 4. Artifact comment protocol headers
**File**: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`
**Changes**: Add two rows to the headers table:

| Header | Posted on | Contains | Created by |
|--------|-----------|----------|------------|
| `## Unblock Request` | Issue (Human Needed) | 1–5 specific blocking questions extracted from `## Escalation` or LLM-reasoned | `ralph-unblock` |
| `## Unblock Resolution` | Issue (Human Needed) | Question/answer pairs + chosen return state | `unblock` |

**File**: `specs/artifact-metadata.md`
**Changes**: Mirror the same two rows in the protocol section. (The two files are kept in sync.)

#### 5. Knowledge ledger event types — no code change required

`event_type` in the ralph-knowledge `outcome_events` table is a free-form `TEXT NOT NULL` column (`plugin/ralph-knowledge/src/db.ts:130`) with no CHECK constraint or enum table. The Zod schema at `plugin/ralph-knowledge/src/index.ts:351` accepts any string. There is no allowlist to extend — the new event-type strings `unblock_requested` and `unblock_resolved` are usable today.

For each event we still pin a canonical payload shape in this plan so both skills emit identical JSON:

```typescript
// unblock_requested — emitted by the autonomous skill after posting ## Unblock Request
{
  event_type: "unblock_requested",
  issue_number: number,
  agent_type: "ralph_unblock",
  session_id: string,
  payload: {
    question_count: number,
    escalation_comment_present: boolean,
    originating_command: string | null,  // parsed from ## Escalation if available
  }
}

// unblock_resolved — emitted by the interactive skill after transitioning the issue
{
  event_type: "unblock_resolved",
  issue_number: number,
  agent_type: "ralph_unblock",
  session_id: string,
  payload: {
    question_count: number,
    return_state: string,
    originating_command: string | null,
  }
}
```

No source files in `plugin/ralph-knowledge/` are modified by this phase.

### Success Criteria

#### Automated Verification:
- [x] All tests pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [x] State-resolution JSON-vs-TS drift test passes (existing test): `npx vitest run src/__tests__/state-resolution.test.ts`
- [x] Type checking passes: `cd plugin/ralph-hero/mcp-server && npm run build`
- [x] New unit test passes: `resolveState("In Progress", "ralph_unblock")` returns `In Progress` without error
- [x] New unit test passes: `resolveState("Done", "ralph_unblock")` throws (Done not in allowed list)
- [x] New hook unit test (or shellcheck-passing manual test) passes: `RALPH_COMMAND=unblock RALPH_CURRENT_STATE='Human Needed'` allows save_issue; `RALPH_COMMAND=triage RALPH_CURRENT_STATE='Human Needed'` blocks it

#### Manual Verification:
- [ ] Inspecting `state-resolution.ts` and `ralph-state-machine.json` side by side, the new `ralph_unblock` entries match in input/output states

**Implementation Note**: After completing Phase 1 and all automated verification passes, pause here for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Autonomous skill — `ralph-hero:ralph-unblock`

### Overview

Picks an issue, parses its escalation context, generates pointed blocking questions, posts them as a `## Unblock Request` comment. Records an outcome event. Issue stays in Human Needed.

### Changes Required

#### 1. Skill definition
**File**: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md`
**Changes**: New file. Frontmatter mirrors `ralph-triage` (autonomous, fork context, sonnet model). Workflow has 7 steps.

```yaml
---
description: Autonomous async-loop unblock helper — picks oldest Human Needed issue, parses escalation context, posts specific blocking questions as ## Unblock Request comment. Does NOT transition state.
user-invocable: false
argument-hint: "[optional-issue-number]"
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=unblock RALPH_REQUIRED_BRANCH=main RALPH_VALID_OUTPUT_STATES='Human Needed'"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/unblock-request-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---
```

Note `RALPH_VALID_OUTPUT_STATES='Human Needed'` constrains this variant from accidentally transitioning the issue. `save_issue` is intentionally absent from `allowed-tools`.

Workflow body (abbreviated; full prose written in the file):

1. **Branch verification** — same pattern as `ralph-triage` Step 1
2. **Select issue** — if arg provided, fetch that issue (verify it's in Human Needed; abort otherwise). If no arg, list issues with `workflowState: "Human Needed"`, `orderBy: "CREATED_AT"` ascending, limit 50. For each, check existing comments — skip if a `## Unblock Request` already exists since the most recent `## Escalation` (idempotency). Pick the first remaining one. If none, output `Queue empty.` and STOP.
3. **Read context** — fetch full issue body, all comments, and any linked artifacts. Look for the most recent `## Escalation` comment as the primary signal; if absent, read linked research/plan docs (via `## Research Document` / `## Implementation Plan` headers in earlier comments).
4. **Synthesize questions** — generate 1–5 pointed questions the human must answer to unblock. Each question must be specific (not "what should we do?"). Include in the synthesis: the originating command (if extractable from `## Escalation`), the issue title, and key constraints found in the linked docs. Cap at 5 to avoid overwhelm.
5. **Post `## Unblock Request` comment**:
   ```markdown
   ## Unblock Request

   This issue is in Human Needed. To unblock, please answer the following:

   1. [Question 1 — concrete and answerable]
   2. [Question 2 ...]

   Originating skill: `ralph_impl` (parsed from ## Escalation)
   When ready, run `/ralph-hero:unblock [issue-number]` to provide answers and route the issue back into the pipeline.
   ```
6. **Record outcome event** — `knowledge_record_outcome` with `event_type: "unblock_requested"`, payload as defined in Phase 1.5.
7. **Report**:
   ```
   Unblock request posted for #NNN: [Title]
   Questions: [N]
   Escalation comment found: [yes/no]
   Originating skill: [ralph_impl or "(unknown)"]
   Issue remains in Human Needed. Run /ralph-hero:unblock #NNN to provide answers.
   ```

#### 2. Agent definition
**File**: `plugin/ralph-hero/agents/unblock-agent.md`
**Changes**: New file. Mirrors existing per-phase agents.

```yaml
---
name: unblock-agent
description: Picks oldest Human Needed issue and surfaces specific blocking questions as a ## Unblock Request comment. Does not transition state.
model: sonnet
tools:
  - Read
  - Glob
  - Grep
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
skills:
  - ralph-hero:ralph-unblock
---

You are the unblock-request agent. Follow the preloaded ralph-unblock skill instructions exactly. Pick an issue, post a `## Unblock Request` comment, exit.
```

#### 3. Postcondition hook
**File**: `plugin/ralph-hero/hooks/scripts/unblock-request-postcondition.sh`
**Changes**: New file. Verifies a `## Unblock Request` comment was posted in this session and the issue is still in Human Needed. Mirror the structure of `triage-postcondition.sh`.

```bash
#!/bin/bash
# unblock-request-postcondition.sh
# Stop hook: verify autonomous unblock posted a ## Unblock Request comment

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

# If RALPH_UNBLOCK_QUEUE_EMPTY=1 was set by the skill, allow exit (no work to do)
if [[ "${RALPH_UNBLOCK_QUEUE_EMPTY:-0}" == "1" ]]; then
  allow
fi

# If RALPH_UNBLOCK_REQUEST_POSTED=1 was set by the skill after posting comment, allow
if [[ "${RALPH_UNBLOCK_REQUEST_POSTED:-0}" == "1" ]]; then
  allow
fi

block "ralph-unblock did not post a ## Unblock Request comment and did not declare an empty queue. Set RALPH_UNBLOCK_QUEUE_EMPTY=1 (no issues to process) or RALPH_UNBLOCK_REQUEST_POSTED=1 (after posting comment) before exiting."
```

The skill body must `export RALPH_UNBLOCK_REQUEST_POSTED=1` after a successful `create_comment` call (or `RALPH_UNBLOCK_QUEUE_EMPTY=1` if no work).

#### 4. Eval scenarios
**File**: `plugin/ralph-hero/skills/ralph-unblock/eval-scenarios.md`
**Changes**: New file. Document scenarios:
- `escalation-comment-present` — issue has `## Escalation` from ralph_impl, autonomous skill should extract originating command and ground questions in the impl context
- `escalation-comment-absent` — issue is Human Needed but only has body text, autonomous skill should LLM-reason fresh from issue body + linked plan
- `queue-empty` — no Human Needed issues; skill exits cleanly with `Queue empty.`
- `idempotency` — issue already has `## Unblock Request` posted after the latest `## Escalation`; skill skips it and picks the next one
- `arg-provided` — skill called with `42`, issue 42 is in Human Needed, skill processes only that issue
- `arg-provided-wrong-state` — skill called with `42`, issue 42 is in `In Progress`, skill aborts with clear error

### Success Criteria

#### Automated Verification:
- [ ] Skill file is valid YAML+markdown: `find plugin/ralph-hero/skills/ralph-unblock -name '*.md' | xargs -I{} head -1 {}` shows expected frontmatter delimiter
- [ ] Hook script passes shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/unblock-request-postcondition.sh`
- [ ] Agent file frontmatter is valid (no syntax errors loading the plugin)

#### Manual Verification:
- [ ] Manually run the autonomous skill against a real Human Needed issue with a `## Escalation` comment — verify a sensible `## Unblock Request` is posted with 1–5 specific questions
- [ ] Run again immediately — verify idempotency (skips the same issue, picks the next or exits empty)
- [ ] Run against an arg-specified issue not in Human Needed — verify clean abort
- [ ] Inspect `~/.ralph-hero/knowledge.db` after a run — verify `unblock_requested` event recorded with correct payload

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Interactive skill — `ralph-hero:unblock`

### Overview

Walks the user through the questions posted by the autonomous variant, captures answers via `AskUserQuestion`, posts a `## Unblock Resolution` comment, and routes the issue back into the pipeline.

### Changes Required

#### 1. Skill definition
**File**: `plugin/ralph-hero/skills/unblock/SKILL.md`
**Changes**: New file. Frontmatter is interactive (`context: inline`, `user-invocable: true`, AskUserQuestion in tools).

```yaml
---
description: Interactive unblock — answers the questions posted by ralph-unblock on a Human Needed issue, captures answers, posts ## Unblock Resolution, routes the issue back into the pipeline. Use when you want to unblock a Human Needed issue.
user-invocable: true
argument-hint: "[optional-issue-number]"
context: inline
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=unblock RALPH_VALID_OUTPUT_STATES='Backlog,Research Needed,Ready for Plan,In Progress'"
  PostToolUse:
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/unblock-state-gate.sh"
allowed-tools:
  - Read
  - Bash
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---
```

Note: no Stop postcondition hook (interactive skills can be aborted by the user mid-flow). State-gate runs on save_issue to enforce the 4-state allowlist.

Workflow body:

1. **Select issue** — if arg provided, fetch issue. Else, list Human Needed issues that have a `## Unblock Request` comment, present via `AskUserQuestion` (issue number + title fragment). If user provides an issue not in Human Needed, abort with clear message.
2. **Load context** — read issue body, the most recent `## Escalation`, the most recent `## Unblock Request`. If `## Unblock Request` is absent, regenerate the questions inline (LLM reasons fresh from `## Escalation` + body). Surface to the user: "No `## Unblock Request` exists yet — I'll generate questions on the fly. To pre-generate, run `/ralph-hero:ralph-unblock` first."
3. **Walk through questions** — for each question:
   - If multiple-choice is appropriate (e.g. "which approach: A, B, or C?"), present `AskUserQuestion` with the options
   - If freeform answer is needed, prompt the user inline (regular text response)
   - Capture each answer
4. **Determine return state** — apply the heuristic:

   | Originating command (from `## Escalation`) | Default return state |
   |---|---|
   | `ralph_research` | `Research Needed` |
   | `ralph_plan` / `ralph_plan_epic` | `Ready for Plan` |
   | `ralph_review` | `Ready for Plan` (re-plan with new direction) |
   | `ralph_impl` / `ralph_pr` / `ralph_merge` / `ralph_code_review` | `In Progress` |
   | `ralph_triage` | `Backlog` |
   | None / unknown | `In Progress` (most common case; skill confirms) |

   Then confirm the inferred state via `AskUserQuestion` with the 4 options + the inferred default first:
   - `In Progress (recommended)` — resume implementation
   - `Ready for Plan` — re-plan with new direction
   - `Research Needed` — gather more information first
   - `Backlog` — defer / not actionable now

5. **Post `## Unblock Resolution` comment**:
   ```markdown
   ## Unblock Resolution

   ### Q&A
   1. **Q**: [Question 1]
      **A**: [Answer 1]
   2. **Q**: [Question 2]
      **A**: [Answer 2]

   Routing to: `[chosen state]`
   ```
6. **Transition state** — call `save_issue(workflowState=<chosen>, command="ralph_unblock")`. State-gate hook validates the target is one of the 4 allowed values.
7. **Record outcome event** — `knowledge_record_outcome` with `event_type: "unblock_resolved"`.
8. **Report**:
   ```
   Unblocked #NNN: [Title]
   Routed to: [chosen state]
   Questions answered: [N]
   ```

#### 2. State-gate hook
**File**: `plugin/ralph-hero/hooks/scripts/unblock-state-gate.sh`
**Changes**: New file. Validates that `save_issue` calls from this skill target one of the 4 valid re-entry states.

```bash
#!/bin/bash
# unblock-state-gate.sh
# PostToolUse (ralph_hero__save_issue): validate state transition target

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/hook-utils.sh"

read_input > /dev/null

tool_name=$(get_tool_name)
if [[ "$tool_name" != "ralph_hero__save_issue" ]]; then
  allow
fi

target_state=$(get_field '.tool_input.workflowState')

case "$target_state" in
  "Backlog"|"Research Needed"|"Ready for Plan"|"In Progress"|"Human Needed")
    allow
    ;;
  *)
    block "ralph-unblock attempted to transition issue to '$target_state', which is not a valid re-entry state from Human Needed. Allowed: Backlog, Research Needed, Ready for Plan, In Progress, Human Needed."
    ;;
esac
```

`Human Needed` is included to allow no-op saves (e.g. label updates without state change).

#### 3. Eval scenarios
**File**: `plugin/ralph-hero/skills/unblock/eval-scenarios.md`
**Changes**: New file. Document scenarios:
- `request-comment-present` — issue has both `## Escalation` and `## Unblock Request`; skill walks the existing questions
- `request-comment-absent` — issue has `## Escalation` only; skill regenerates questions inline and informs the user
- `originating-impl` — `## Escalation` says `command="ralph_impl"`; skill defaults return state to `In Progress` and asks for confirmation
- `originating-research` — defaults to `Research Needed`
- `user-overrides-state` — heuristic suggests `In Progress`, user picks `Backlog`; skill respects user choice
- `arg-omitted-multiple-candidates` — 3 issues are Human Needed with `## Unblock Request`; skill presents picker
- `arg-omitted-single-candidate` — 1 candidate; skill auto-selects and proceeds (no picker friction)
- `transition-blocked-by-gate` — buggy LLM tries to set state `Done`; state-gate blocks with clear message

### Success Criteria

#### Automated Verification:
- [ ] Skill file is valid YAML+markdown
- [ ] Hook script passes shellcheck: `shellcheck plugin/ralph-hero/hooks/scripts/unblock-state-gate.sh`
- [ ] Hook unit test (or manual): `target_state=Done` blocks with stderr; `target_state="In Progress"` allows
- [ ] Hook unit test: with `RALPH_COMMAND=unblock` set, `human-needed-outbound-block.sh` allows transition (regression test for Phase 1)

#### Manual Verification:
- [ ] End-to-end: escalate a real test issue via `ralph-impl`, run `/ralph-hero:ralph-unblock` to post questions, run `/ralph-hero:unblock 42` to walk through them, confirm the issue lands in `In Progress` and both `## Unblock Request` and `## Unblock Resolution` comments are present
- [ ] Same flow but pick `Backlog` at the routing prompt — verify the issue moves to Backlog
- [ ] Run `/ralph-hero:unblock` with no arg, multiple candidates exist — verify picker presents all of them
- [ ] Run `/ralph-hero:unblock` against an issue not in Human Needed — verify clean abort
- [ ] Inspect knowledge DB — verify `unblock_resolved` event recorded with the correct return state

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding to Phase 4.

---

## Phase 4: Surfacing + scheduling + documentation

### Overview

Make unblockable issues discoverable in `/ralph-hero:hello`, ship a launchd template for the autonomous skill, and update the docs that describe the workflow architecture.

### Changes Required

#### 1. Hello/next-actions surfacing
**File**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (registers `ralph_hero__next_actions` at line 280)
**Changes**: Add a new `direction.kind: "human-needed-unblock"` to the next_actions ranker. A direction of this kind fires when an issue is in Human Needed AND has a posted `## Unblock Request` comment newer than its most recent `## Escalation`. Score it high enough to outrank `lock-stale` (these issues are explicitly waiting for the human's attention).

Direction shape:
```typescript
{
  kind: "human-needed-unblock",
  issue: { number, title, workflowState: "Human Needed", ... },
  signals: {
    unblockRequestAgeDays: number,   // age of the most recent ## Unblock Request comment
    questionCount: number,           // count of numbered questions in that comment
  },
  recommended: boolean,
  reason: "@deprecated — see hello synthesis prose",
}
```

**New data dependency**: `unblockRequestAgeDays` and `questionCount` are derived from issue comments and are NOT currently computed by the existing direction kinds (`issue`, `pr`, `tree-continue`, `lock-stale`). Implementor adds a narrowly scoped fetch step that runs only for Human Needed candidates:

1. Inside the `next_actions` ranker, after the existing Human Needed candidate filter, for each candidate issue call `get_issue(number, includeGroup=false)` (the existing tool already returns `comments`). The candidate set is small in practice (typically 0–5 issues), so per-issue overhead is acceptable.
2. From the `comments` array, find the most recent comment whose body starts with `## Unblock Request`. If none, this issue does NOT produce a `human-needed-unblock` direction (it can still surface as a generic `issue` direction if applicable).
3. From that comment, derive:
   - `unblockRequestAgeDays`: `Date.now() - createdAt`, in days, rounded down.
   - `questionCount`: count of lines matching `^\d+\.\s` in the comment body.
4. Skip the direction if a `## Escalation` comment exists that is *newer* than the `## Unblock Request` (means the autonomous skill needs to re-run before the human is asked — this case is rare but valid).

Acceptance criterion: a unit test adds two fixture issues, one with a `## Unblock Request` comment and one without, and asserts that the ranker produces exactly one `human-needed-unblock` direction with the correct `questionCount`.

**File**: `plugin/ralph-hero/skills/hello/SKILL.md`
**Changes**:
- Step 4 picker dispatch table (line ~95): add row for `kind: "human-needed-unblock"` → label `"Unblock #NNN · <fragment>"`, agent dispatch `Skill("ralph-hero:unblock", args="<NNN>")`
- Step 5 dispatch table: same row
- Synthesis guidance table (line ~66): add row for `human-needed-unblock` with example "issue #42 has 3 unblock questions waiting since 2 days ago"

#### 2. Launchd template
**File**: `plugin/ralph-hero/scripts/unblock/launchd/com.ralph.unblock.plist.template`
**Changes**: New file. Mirrors `scripts/snapshot/launchd/com.ralph.snapshot.plist.template`. Runs daily at e.g. 9am.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ralph.unblock</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>9</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-lc</string>
        <string>cd /Users/CHANGEME/projects/ralph-hero/plugin/ralph-hero/scripts/unblock &amp;&amp; ./run.sh</string>
    </array>
    <key>StandardOutPath</key>
    <string>/Users/CHANGEME/Library/Logs/ralph-unblock.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/CHANGEME/Library/Logs/ralph-unblock.error.log</string>
</dict>
</plist>
```

**File**: `plugin/ralph-hero/scripts/unblock/run.sh`
**Changes**: New file. One-shot wrapper that invokes the autonomous skill via the agent dispatch (matching the snapshot script pattern).

```bash
#!/usr/bin/env bash
set -euo pipefail
# Run the autonomous unblock skill once. Picks oldest Human Needed issue
# without a fresh ## Unblock Request and posts blocking questions.

cd "$(dirname "$0")/../../../.."
exec claude -p "Run the ralph-hero:ralph-unblock skill once. Pick the oldest Human Needed issue without a fresh ## Unblock Request comment. Post the blocking questions and exit."
```

(The exact CLI invocation depends on how `claude -p` is shaped in this repo — match the pattern in `scripts/snapshot/run.sh`.)

#### 3. Documentation updates
**File**: `CLAUDE.md` (root-level)
**Changes**:
- "Per-Phase Agents" table (line ~91): add row for `unblock-agent` (model: sonnet, preloaded skill: ralph-unblock, tier: Async-loop)
- After the "Workflow State Machine" section (line ~135): add a paragraph explaining the async unblock loop:
  > **Async unblock loop**: Hero closes its loop at Human Needed. The `ralph-hero:ralph-unblock` skill runs as a separate async loop (scheduled via launchd, fired by external trigger, or driven by human attention) and posts `## Unblock Request` comments with specific blocking questions. The interactive `ralph-hero:unblock` skill is then invoked by the human to provide answers and route the issue back into the pipeline.

**File**: `specs/issue-lifecycle.md`
**Changes**: In the section documenting Human Needed (line ~32): add a paragraph:
> **Exit paths**: Human Needed allows transitions to Backlog, Research Needed, Ready for Plan, or In Progress. Two paths exist: (a) human directly transitions via the GitHub Projects board, or (b) the `ralph_unblock` command captures human input via the interactive `ralph-hero:unblock` skill and transitions on the human's behalf. Other automated commands remain blocked from transitioning out of Human Needed via `human-needed-outbound-block.sh`.

#### 4. Filter profile (optional but tidy)
**File**: `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts` (locate during implementation — the file may have a different name)
**Changes**: Add a new `analyst-unblock` profile that maps to `workflowState: "Human Needed"`. Used by both unblock skills for consistent queue-pick behavior.

```typescript
"analyst-unblock": {
  workflowState: "Human Needed",
  // ... any default ordering
},
```

### Success Criteria

#### Automated Verification:
- [ ] All tests still pass: `cd plugin/ralph-hero/mcp-server && npm test`
- [ ] Type check passes: `npm run build`
- [ ] `next_actions` test (new): a Human Needed issue with `## Unblock Request` produces a direction of `kind: "human-needed-unblock"`
- [ ] `next_actions` test (new): a Human Needed issue without `## Unblock Request` does NOT produce a direction of that kind (it should still surface separately, but not as an unblock invitation)
- [ ] Launchd plist parses: `plutil -lint plugin/ralph-hero/scripts/unblock/launchd/com.ralph.unblock.plist.template` returns OK
- [ ] `run.sh` is executable: `test -x plugin/ralph-hero/scripts/unblock/run.sh`

#### Manual Verification:
- [ ] After Phase 4 complete, run `/ralph-hero:hello` in a project with a Human Needed issue that has a `## Unblock Request` — verify the unblock direction appears in the picker
- [ ] Pick the unblock direction — verify it dispatches `/ralph-hero:unblock #NNN` correctly
- [ ] Read `CLAUDE.md` and `specs/issue-lifecycle.md` end-to-end — verify the new sections read as a coherent description of the async unblock loop
- [ ] Install the launchd template manually (with paths edited): `launchctl load ~/Library/LaunchAgents/com.ralph.unblock.plist` → verify it appears in `launchctl list`
- [ ] Trigger the launchd job manually: `launchctl start com.ralph.unblock` → verify a `## Unblock Request` comment is posted on the oldest Human Needed issue

**Implementation Note**: After Phase 4 is complete, the full async unblock loop is shippable end-to-end.

---

## Testing Strategy

### Unit Tests

**MCP server (`plugin/ralph-hero/mcp-server/src/__tests__/`):**
- `state-resolution.test.ts` (extend): `ralph_unblock` valid output states, invalid states throw with helpful Recovery message
- `state-machine-drift.test.ts` (existing test that compares JSON to TS — will catch any forgotten sync)
- `dashboard.test.ts` (extend): `next_actions` produces `human-needed-unblock` direction when expected; doesn't when not expected

**Hook scripts (`plugin/ralph-hero/hooks/__tests__/` if such a dir exists, else manual via shellcheck + bats):**
- `human-needed-outbound-block.sh`: `RALPH_COMMAND=unblock` allows; `RALPH_COMMAND=triage` still blocks
- `unblock-state-gate.sh`: each of the 4 valid states allows; Done/Canceled/Plan in Review block
- `unblock-request-postcondition.sh`: missing both env vars blocks; either set allows

**ralph-knowledge:**
- `outcome-events.test.ts` (extend): `unblock_requested` and `unblock_resolved` event types accepted with the documented payloads

### Integration Tests

**Eval scenarios** (manual run-through against a test repo):
- See per-phase eval-scenarios.md files
- Key end-to-end happy path: escalate → autonomous unblock posts questions → interactive unblock answers and routes → next pipeline run picks it up

### Manual Testing Steps

1. Create a test repo with the ralph-hero plugin installed
2. Create a Human Needed issue manually (or escalate via `ralph-impl` failure)
3. Post a `## Escalation` comment mimicking the standard format
4. Run `/ralph-hero:ralph-unblock` (no args) — confirm `## Unblock Request` is posted with sensible questions
5. Run `/ralph-hero:ralph-unblock` again — confirm idempotency (skips this issue, queue empty or moves to next)
6. Run `/ralph-hero:unblock 42` — confirm `AskUserQuestion` walks each question, post-resolution comment is posted, issue moves to chosen state
7. Run `/ralph-hero:hello` — confirm the unblockable issue surfaces (or doesn't, after it's been resolved)
8. Inspect the knowledge DB and verify `unblock_requested` + `unblock_resolved` events both recorded

## Performance Considerations

- The autonomous skill queries Human Needed issues with `limit: 50`. For projects with > 50 Human Needed issues, the queue picker may miss older issues — acceptable for v1. (If this becomes a problem, paginate.)
- Idempotency check (`## Unblock Request` exists since the most recent `## Escalation`) requires reading all issue comments. For issues with hundreds of comments, this could be slow — fine in practice, but worth noting.
- The launchd job runs once per day. No concurrent-run protection needed (each invocation picks the next available issue).

## Migration Notes

- No data migration required. Existing Human Needed issues will be picked up by the autonomous skill on its next run.
- Existing `## Escalation` comments are read-compatible (the autonomous skill is permissive about format — falls back to LLM reasoning if structured fields are absent).
- The new outcome event types are additive and need no schema migration: `event_type` in `outcome_events` is open-string in `plugin/ralph-knowledge/src/db.ts:130` and the Zod schema at `plugin/ralph-knowledge/src/index.ts:351` is `z.string()`, so the two new strings (`unblock_requested`, `unblock_resolved`) are accepted today without code changes.

## References

- Related research: `thoughts/shared/research/2026-04-22-agent-bus-design.md`
- Related research: `thoughts/shared/research/2026-04-05-hero-pipeline-handoff-ux-inventory.md`
- Existing escalation protocol: `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md`
- Existing artifact comment protocol: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` and `specs/artifact-metadata.md`
- Reference autonomous skill template: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
- Reference interactive skill template: `plugin/ralph-hero/skills/hello/SKILL.md`
- State machine source of truth: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json`
- Outbound block hook: `plugin/ralph-hero/hooks/scripts/human-needed-outbound-block.sh`
