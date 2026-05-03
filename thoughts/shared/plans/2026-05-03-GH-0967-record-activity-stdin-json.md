---
date: 2026-05-03
status: draft
type: plan
github_issue: 967
github_issues: [967]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/967
primary_issue: 967
tags: [activity-log, hooks, bug-fix, stdin-json, hello-skill]
---

# fix(activity-log): record-activity.sh reads env vars instead of stdin JSON — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-02-hello-composable-rewrite]]
- builds_on:: GH-936 (Hello composable rewrite epic)
- builds_on:: GH-937 (Phase 1: activity log foundation, PR #959)
- tensions:: None identified.

## Overview

Single-issue, single-phase fix. The activity log hook script `record-activity.sh` (shipped in PR #959 / GH-937) reads tool/skill/agent/project metadata from environment variables (`CLAUDE_TOOL_NAME`, `CLAUDE_SKILL_NAME`, `CLAUDE_AGENT_NAME`, `CLAUDE_PROJECT`, `CLAUDE_SESSION_ID`) that the Claude Code hook system never sets. The Claude Code hook contract delivers tool data as **JSON over stdin**. Result: every event in `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` has `target.tool: "unknown"`, `actor: "claude"`, `project: "unknown"`, which silently breaks the catch-up skill (#940, Phase 4) — there is nothing meaningful to synthesize.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-967 | fix(activity-log): record-activity.sh reads env vars instead of stdin JSON | XS |

## Shared Constraints

- **Canonical stdin pattern**: Other ralph-hero hooks read JSON from stdin via `INPUT=$(cat)` then extract via `jq -r '.field // "default"'`. The reusable helpers live in [`plugin/ralph-hero/hooks/scripts/hook-utils.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh#L11-L22) (`read_input`, `get_field`). Reference implementations include [`post-github-validator.sh:12-14`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/post-github-validator.sh#L12-L14) and [`outcome-collector.sh:25-27`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh#L25-L27).
- **Non-blocking guarantee**: `record-activity.sh` MUST exit 0 unconditionally (no `set -e`). The whole point of activity logging is that it never breaks the harness. Even if `jq` is missing or stdin is empty, the script must still write a valid (possibly degraded) JSON line and return 0. Do not adopt `hook-utils.sh`'s `set -euo pipefail` blanket — its `block`/`warn` helpers exit 2 which would propagate failures up.
- **Stdin may be empty**: Some hook events (or testing scenarios) may invoke `record-activity.sh` without piping JSON. The script must handle empty stdin gracefully — fall back to "unknown"/"claude" defaults rather than producing malformed JSON. Use `cat` with a timeout-style guard or simply tolerate empty `$INPUT`.
- **`jq` is already a dependency**: All the other stdin-reading hooks shell out to `jq -r`. It's available in the runtime. No need to do shell-only JSON parsing.
- **Concurrent-write semantics preserved**: The current append (`echo "$EVENT" >> "$TODAY_FILE"`) survives 50 concurrent writes per the existing test. Do not alter the write strategy.
- **Backwards compatibility on env vars**: The existing test suite at [`__tests__/record-activity.test.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh) sets `CLAUDE_TOOL_NAME`, `CLAUDE_PROJECT`, etc. via env. Since the Claude Code harness does NOT set these in real life, we have a choice: (a) drop env var reads entirely and rewrite those tests to feed stdin JSON; (b) keep env vars as a fallback ladder behind stdin JSON. **Decision: (a) — drop env var reads**. The env vars are dead weight (never set in production); keeping them masks the bug and bloats the script. Rewrite all existing tests to use stdin JSON.

## Current State Analysis

### What `record-activity.sh` does today (lines referenced from `plugin/ralph-hero/hooks/scripts/record-activity.sh`)

1. Line 11: takes `KIND` as positional arg (e.g., `tool_called`, `session_start`).
2. Line 19: reads `ACTOR` from `$CLAUDE_SKILL_NAME`, falls back to `$CLAUDE_AGENT_NAME`, then `"claude"`. **None of these env vars exist** at hook fire time.
3. Line 20: reads `PROJECT` from `$CLAUDE_PROJECT` → always `"unknown"`.
4. Line 21: reads `SESSION_ID` from `$CLAUDE_SESSION_ID` → always empty.
5. Line 71: categorize subject is `$CLAUDE_TOOL_NAME` → always empty, so categorization always falls through to `meta`.
6. Lines 76, 79, 82: `TARGET` JSON is built from `$CLAUDE_TOOL_NAME` / `$CLAUDE_SKILL_NAME` / `$CLAUDE_AGENT_NAME` → all `"unknown"`.

### Hook wiring (from `plugin/ralph-hero/hooks/hooks.json`)

`record-activity.sh` fires on two events as of 2026-05:
- **`SessionStart`** ([line 30](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json#L30)) — invokes `record-activity.sh session_start`.
- **`PostToolUse`** ([line 165](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json#L165)), matcher-less (all tools) — invokes `record-activity.sh tool_called`.

The `_activity_log_note` in `hooks.json` documents that `SessionStop`, `PostSkillInvoke`, and agent-spawn/agent-complete event names "were probed and are not currently surfaced by the harness" — so the `skill_invoked`/`agent_spawned` code paths in `record-activity.sh` are dead code in production, but the test suite still exercises them. We should keep those code paths working when the script is invoked manually with stdin (the tests do this), but understand they have zero real-world traffic today.

### Claude Code stdin JSON contract

Per the existing reference implementations (`post-github-validator.sh`, `outcome-collector.sh`, `hook-utils.sh::get_agent_type`, `split-estimate-gate.sh`), the stdin payload includes:

| Field | Type | Source events | Usage in this fix |
|-------|------|---------------|-------------------|
| `tool_name` | string | PostToolUse, PreToolUse | populates `target.tool` for `kind=tool_called` |
| `tool_input` | object | PostToolUse, PreToolUse | not used by this script |
| `tool_response` | object | PostToolUse | not used by this script |
| `agent_type` | string | any (when in sub-agent) | populates `actor` (strip plugin prefix); replaces dead `CLAUDE_AGENT_NAME` |
| `hook_event_name` | string | all | optional sanity check |
| `session_id` | string | all | populates `session_id` |
| `cwd` | string | all | populates `project` (basename of cwd) |
| `transcript_path` | string | all | not used |

**No `skill_name` field exists in the stdin schema** as of 2026-05. The `_activity_log_note` confirms this. The `skill_invoked` event kind is dispatched by *positional arg*, not stdin extraction — so for that kind, we keep populating `target.skill` with whatever the test/caller pipes in (or fall back to "unknown"). The production flow never fires `skill_invoked` anyway.

### Live evidence (issue body)

38 events on 2026-05-03 13:00–13:30 UTC; 37/37 `tool_called` events have `target.tool: "unknown"`, 38/38 have `actor: "claude"` and `project: "unknown"`. Confirmed locally: `wc -l ~/.ralph-hero/activity/2026/05/03.jsonl` returns 133 lines (the issue captured the count at 13:30; we are now at ~14:00).

### Test gap

[`__tests__/record-activity.test.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh) verifies:
- JSON validity (line 57)
- `target.tool` matches `CLAUDE_TOOL_NAME` env var (line 72) — **but only because the test sets the env var; production never sets it**
- categorization rules (lines 76-103)
- silent failure on read-only path (line 106-112)
- concurrent writes don't corrupt (lines 121-140)

**Critical gap**: no test pipes a realistic Claude Code stdin JSON payload to the script. A test that does so — and asserts `target.tool` matches the input's `tool_name` field — would have caught this bug immediately.

## Desired End State

A `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` event after the fix should look like:

```json
{"ts":"2026-05-03T14:00:00.000Z","kind":"tool_called","category":"meta","actor":"claude","target":{"tool":"Read"},"project":"ralph-hero","session_id":"abc-123-def"}
```

…where `tool` came from stdin's `tool_name`, `project` from `basename` of stdin's `cwd`, and `session_id` from stdin's `session_id`. When the script is invoked from inside a sub-agent (e.g., `impl-agent` calling Read), `actor` should be `impl-agent` (stripped of plugin prefix) — replicating the `get_agent_type` behavior in `hook-utils.sh`.

### Verification

- [ ] `record-activity.sh` reads JSON from stdin (`INPUT=$(cat 2>/dev/null || echo "")` followed by `jq -r '.field // "default"'`)
- [ ] `target.tool` populated from stdin's `tool_name` for `kind=tool_called` events
- [ ] `actor` populated from stdin's `agent_type` (with plugin prefix stripped) for any kind, falling back to `"claude"` when absent
- [ ] `project` populated from `basename` of stdin's `cwd`, falling back to `"unknown"`
- [ ] `session_id` populated from stdin's `session_id` (when present and non-empty)
- [ ] All env-var reads removed: `CLAUDE_TOOL_NAME`, `CLAUDE_SKILL_NAME`, `CLAUDE_AGENT_NAME`, `CLAUDE_PROJECT`, `CLAUDE_SESSION_ID` are no longer referenced
- [ ] Categorization (`work` vs `meta`) still works via the same allow-list, now driven by stdin's `tool_name`
- [ ] Existing tests for "concurrent writes" and "silent failure on read-only path" still pass
- [ ] Existing tests are rewritten to feed stdin JSON instead of env vars (drop `CLAUDE_*` env exports)
- [ ] **New test (PostToolUse)**: pipe `{"tool_name":"ralph_hero__save_issue","cwd":"/Users/x/projects/ralph-hero","session_id":"S1"}` to `record-activity.sh tool_called`; assert resulting JSONL line has `target.tool == "ralph_hero__save_issue"`, `project == "ralph-hero"`, `session_id == "S1"`, `category == "work"`
- [ ] **New test (SessionStart)**: pipe `{"hook_event_name":"SessionStart","cwd":"/Users/x/projects/ralph-hero","session_id":"S2"}` to `record-activity.sh session_start`; assert `kind == "session_start"`, `project == "ralph-hero"`, `session_id == "S2"`
- [ ] **New test (sub-agent attribution)**: pipe `{"tool_name":"Write","agent_type":"ralph-hero:impl-agent","cwd":"/x"}` to `record-activity.sh tool_called`; assert `actor == "impl-agent"` (plugin prefix stripped)
- [ ] **New test (empty stdin)**: invoke `record-activity.sh tool_called` with `< /dev/null`; assert exit code 0 and resulting line has `target.tool == "unknown"` (graceful degradation)
- [ ] Live verification on next session: garbage events from today are tolerated (no migration); fresh events show real metadata
- [ ] Test suite passes: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` exits 0 with all tests green

## What We're NOT Doing

- **Not migrating the 38 garbage events from 2026-05-03.** The issue explicitly says this is fine. They will be filtered out by the catch-up skill's `since` cursor or simply overlooked by virtue of being old.
- **Not introducing new event kinds.** No `skill_invoked` plumbing — that path was dead in production before and remains dead.
- **Not modifying the activity log schema or the `activity.ts` reader.** The output JSONL fields (`ts`, `kind`, `category`, `actor`, `target`, `project`, `session_id`) stay identical. Only their values become correct.
- **Not refactoring `record-activity.sh` to source `hook-utils.sh`.** The `set -euo pipefail` discipline of `hook-utils.sh` would break the "exit 0 always" guarantee. We replicate the *pattern* (read stdin, extract via jq) without inheriting the strictness.
- **Not adding `hook_event_name` cross-checks.** The positional-arg `KIND` is the source of truth for the event type, matching the current contract in `hooks.json`.
- **Not touching the `RALPH_ACTIVITY_DIR` env var.** That one is a config knob set by the user, not a Claude Code-supplied field. It stays.

## Implementation Approach

Single phase, single file rewrite plus test additions. Order:

1. Modify `record-activity.sh`: replace env-var reads with stdin JSON parsing via `jq`. Preserve unconditional `exit 0`, the `categorize()` allow-list, the file-write strategy, and the date-based directory layout.
2. Rewrite the existing tests in `__tests__/record-activity.test.sh` to pipe stdin JSON instead of setting `CLAUDE_*` env vars.
3. Add four new tests covering the regressions identified in the issue's acceptance criteria (PostToolUse, SessionStart, sub-agent actor attribution, empty-stdin graceful fallback).
4. Run the test suite locally to confirm green. No build step needed (pure shell).

---

## Phase 1: GH-967 — record-activity.sh reads stdin JSON instead of env vars
- **depends_on**: null

### Overview

Rewrite `record-activity.sh` to read its tool/agent/project/session metadata from a stdin JSON payload (matching the Claude Code hook contract) instead of from never-set environment variables. Update and extend the bats test suite to feed realistic stdin payloads and assert that extracted fields land correctly in the output JSONL.

### Tasks

#### Task 1.1: Rewrite `record-activity.sh` to read stdin JSON
- **files**: [`plugin/ralph-hero/hooks/scripts/record-activity.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/record-activity.sh) (modify)
- **tdd**: false (test additions in Task 1.2 verify behavior; the script change itself is mechanical replacement of env-var reads with `jq` extracts)
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] After `KIND=...` line, capture stdin: `INPUT=$(cat 2>/dev/null || echo "")` — the `2>/dev/null || echo ""` ensures empty/missing stdin doesn't break the script
  - [ ] Add a helper to extract a field with a default: `extract() { echo "$INPUT" | jq -r "$1 // \"$2\"" 2>/dev/null || echo "$2"; }` — survives both empty `$INPUT` and absent `jq`
  - [ ] Replace `ACTOR="${CLAUDE_SKILL_NAME:-${CLAUDE_AGENT_NAME:-claude}}"` with: extract `agent_type` (default empty), strip everything before and including the last `:` (replicating `get_agent_type` from `hook-utils.sh`), set `ACTOR` to the result; if empty, set `ACTOR="claude"`
  - [ ] Replace `PROJECT="${CLAUDE_PROJECT:-unknown}"` with: extract `cwd` (default empty); if non-empty, set `PROJECT` to its basename via `basename "$cwd"`; else `PROJECT="unknown"`
  - [ ] Replace `SESSION_ID="${CLAUDE_SESSION_ID:-}"` with: extract `session_id` (default empty)
  - [ ] In the `categorize()` call site (currently line 71), replace `${CLAUDE_TOOL_NAME:-${CLAUDE_SKILL_NAME:-}}` with: for `KIND=tool_called` use the extracted `tool_name`; for `KIND=skill_invoked` use the extracted `skill_name` (default empty — this stays a no-op in production but keeps tests addressable)
  - [ ] In the per-kind `case` block (currently lines 74-90), replace `${CLAUDE_TOOL_NAME:-unknown}` with the extracted `tool_name` (default `"unknown"`); replace `${CLAUDE_SKILL_NAME:-unknown}` with extracted `skill_name`; replace `${CLAUDE_AGENT_NAME:-unknown}` with extracted `agent_name` — all default to `"unknown"` so the script stays robust to missing fields
  - [ ] Comment header (lines 2-7) updated: replace "Reads event metadata from env vars" with "Reads event metadata from stdin JSON (Claude Code hook contract)"; document the stdin field map (`tool_name`, `agent_type`, `cwd`, `session_id`)
  - [ ] No `set -e` is added; existing `set -u` is preserved; final `exit 0` is preserved
  - [ ] No reference to `CLAUDE_TOOL_NAME`, `CLAUDE_SKILL_NAME`, `CLAUDE_AGENT_NAME`, `CLAUDE_PROJECT`, or `CLAUDE_SESSION_ID` remains in the file (verify with `grep -n CLAUDE_ plugin/ralph-hero/hooks/scripts/record-activity.sh` — should match nothing)
  - [ ] Manual smoke test: `echo '{"tool_name":"Read","cwd":"/tmp","session_id":"S1"}' | RALPH_ACTIVITY_DIR=/tmp/test-activity bash plugin/ralph-hero/hooks/scripts/record-activity.sh tool_called` produces a valid JSONL line at `/tmp/test-activity/$(date -u +%Y/%m/%d).jsonl` with `target.tool == "Read"`, `project == "tmp"`, `session_id == "S1"`

#### Task 1.2: Rewrite existing tests to feed stdin JSON; add four new tests
- **files**: [`plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh) (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Existing test "writes one valid JSON line" (lines 47-57): replace the env-var invocation `CLAUDE_HOOK_EVENT="PostToolUse" CLAUDE_TOOL_NAME="..." "$SCRIPT" tool_called` with `echo '{"tool_name":"ralph_hero__get_issue","cwd":"/x","session_id":"S0"}' | "$SCRIPT" tool_called`; same assertions on file existence and JSON validity
  - [ ] Existing test "includes actor and target fields" (lines 60-73): pipe `{"tool_name":"ralph_hero__save_issue","cwd":"/Users/dubiel/projects/ralph-hero","session_id":"S1"}` to the script; assert `target.tool == "ralph_hero__save_issue"`; assert `project == "ralph-hero"` (basename of cwd, replacing the previous `CLAUDE_PROJECT="ralph-hero"` env-var-driven assertion); assert `session_id == "S1"`
  - [ ] Existing test "categorization rules" (lines 76-103): rewrite each invocation to pipe stdin JSON with `tool_name` set instead of `CLAUDE_TOOL_NAME`; for `skill_invoked` event, pipe `{"skill_name":"ralph-hero:hello"}` (the script extracts this from stdin even though production never fires this event); for `session_start`, pipe `{"hook_event_name":"SessionStart"}` or empty `{}`; same five assertions on `category` field
  - [ ] Existing test "silent failure on read-only path" (lines 106-112): no env vars to remove; just pipe an empty JSON `{}` via stdin; same assertion that exit code is 0
  - [ ] Existing test "missing kind argument" (lines 116-118): pipe empty stdin; same assertion that exit code is 0
  - [ ] Existing test "concurrent writes don't corrupt file" (lines 121-140): replace the loop's `CLAUDE_TOOL_NAME="ralph_hero__test_$i"` with `echo "{\"tool_name\":\"ralph_hero__test_$i\"}" | "$SCRIPT" tool_called &`; same 50-line and zero-corrupt assertions
  - [ ] **New test "PostToolUse: target.tool extracted from stdin tool_name"**: pipe `{"tool_name":"ralph_hero__save_issue","tool_input":{},"tool_response":{},"hook_event_name":"PostToolUse","cwd":"/tmp/proj","session_id":"sess-A"}` to the script with `tool_called`; assert `.target.tool == "ralph_hero__save_issue"`, `.project == "proj"`, `.session_id == "sess-A"`, `.category == "work"`
  - [ ] **New test "SessionStart: kind lands with stdin-derived metadata"**: pipe `{"hook_event_name":"SessionStart","cwd":"/Users/x/foo-repo","session_id":"sess-B"}` to the script with `session_start`; assert `.kind == "session_start"`, `.project == "foo-repo"`, `.session_id == "sess-B"`, `.actor == "claude"` (no `agent_type` in payload), `.category == "meta"`
  - [ ] **New test "sub-agent: actor strips plugin prefix from agent_type"**: pipe `{"tool_name":"Write","agent_type":"ralph-hero:impl-agent","cwd":"/x"}` to the script with `tool_called`; assert `.actor == "impl-agent"` (the `ralph-hero:` prefix is stripped, matching `get_agent_type` behavior); assert `.target.tool == "Write"`, `.category == "work"` (Write is in the work allow-list)
  - [ ] **New test "empty stdin: graceful fallback to defaults"**: invoke `"$SCRIPT" tool_called < /dev/null`; assert exit code 0; assert resulting line has `.target.tool == "unknown"`, `.actor == "claude"`, `.project == "unknown"`, no `.session_id` field (or empty string)
  - [ ] Test runs end-to-end: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` exits 0 with all tests green

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` — exits 0, all assertions pass
- [ ] `grep -n 'CLAUDE_TOOL_NAME\|CLAUDE_SKILL_NAME\|CLAUDE_AGENT_NAME\|CLAUDE_PROJECT\|CLAUDE_SESSION_ID' plugin/ralph-hero/hooks/scripts/record-activity.sh` — no matches (env-var reads fully removed)
- [ ] Bash syntax check: `bash -n plugin/ralph-hero/hooks/scripts/record-activity.sh && bash -n plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` — exits 0
- [ ] No build/typecheck commands needed — this is a shell-only change. The `mcp-server/` package is untouched.

#### Manual Verification:
- [ ] After merging and a fresh Claude Code session, watch `~/.ralph-hero/activity/$(date -u +%Y/%m/%d).jsonl` for 30 seconds. Confirm new events show `target.tool` matching real tool names (e.g., `Read`, `Bash`, `ralph_hero__list_issues`), `project` matching the cwd basename, and `session_id` populated. Confirm `actor` is `claude` for the orchestrator and a stripped agent name (e.g., `impl-agent`) when running inside a sub-agent.
- [ ] Confirm existing 38 garbage events from earlier today are NOT migrated (their `target.tool: "unknown"` entries persist on disk; no harm).
- [ ] Run the catch-up skill (`/ralph-hero:catch-up` or whichever surface exists in #940 once merged) and confirm it has meaningful content to summarize — at minimum, that it can list real tool names instead of "unknown".

**Creates for next phase**: N/A (single-phase plan).

---

## Integration Testing

- [ ] Bash test suite green locally: `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`
- [ ] CI on the PR runs the existing `ci.yml` matrix (Node 18/20/22 + tests) — note: this fix touches no TypeScript, so the npm `test` job will be a no-op for the new lines, but bash test execution is not currently in CI for this script. Document as a follow-up that adding `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` to CI would prevent regressions.
- [ ] Live smoke test: trigger a Claude Code session (`claude` CLI) with this fix in place; do five tool calls (Read, Write, Bash, Glob, Grep) and one MCP call; tail `~/.ralph-hero/activity/$(date -u +%Y/%m/%d).jsonl`; confirm 6 fresh events with correct `target.tool`, `actor`, and `project`.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/967
- Parent epic: GH-936 (Hello composable rewrite) — https://github.com/cdubiel08/ralph-hero/issues/936
- Phase 1 PR (introduced bug): #959 — https://github.com/cdubiel08/ralph-hero/pull/959
- Phase 1 plan: [`thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md) (sibling work, not a dependency)
- Hook contract reference: [`plugin/ralph-hero/hooks/scripts/hook-utils.sh:11-22`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh#L11-L22) (functions `read_input`, `get_field`)
- Reference stdin-reading hooks: [`post-github-validator.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/post-github-validator.sh), [`outcome-collector.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh), [`split-estimate-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh)
- Hook wiring: [`plugin/ralph-hero/hooks/hooks.json:30, :165`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json#L30-L165) (`SessionStart` and `PostToolUse` registrations)
- Reader library (unchanged): [`plugin/ralph-hero/mcp-server/src/lib/activity.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/activity.ts)
- Live evidence: `~/.ralph-hero/activity/2026/05/03.jsonl` (133 lines as of plan-write time, all with `target.tool: "unknown"`)
