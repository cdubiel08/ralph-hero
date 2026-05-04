---
date: 2026-05-03
status: draft
type: plan
github_issue: 985
github_issues: [985]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/985
primary_issue: 985
tags: [hooks, catch-up, cursor, activity-log, refactor]
---

# Replace catch-up LLM Write with PostToolUse hook - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-03-GH-0985-catch-up-cursor-llm-write]]
- builds_on:: [[2026-05-02-hello-composable-rewrite]]
- builds_on:: [[2026-05-03-GH-0967-record-activity-stdin-json]]

## Overview

One issue, one PR, three logical layers (hook script + registration + skill cleanup):

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-985 | refactor(catch-up): replace LLM-driven cursor Write with PostToolUse hook on recent_activity | XS |

**Why grouped**: Single XS issue; phases here are intra-issue logical steps (script + tests, hook registration, skill cleanup) rather than separate tickets.

## Shared Constraints

- All bash hook scripts live under `plugin/ralph-hero/hooks/scripts/`, are `set -euo pipefail` at top, exit 0 unconditionally (best-effort), and source `hook-utils.sh` only when they need its helpers (the `outcome-collector.sh` precedent of *not* sourcing it is also acceptable when the script reads stdin directly).
- Tests live under `plugin/ralph-hero/hooks/scripts/__tests__/` as `*.test.sh`, follow the bash test harness used by `record-activity.test.sh` (`assert_eq`, `assert_file_exists`, PASS/FAIL counters, exit `$FAIL == 0`), and isolate filesystem state under `mktemp -d` with a trap cleanup.
- Cursor file path is `~/.ralph-hero/cursors/catch-up.json` (literal). Tests must NOT write to the real `~/.ralph-hero` — the new script must honor an env var override (e.g., `RALPH_CURSOR_DIR`) so tests can redirect to `$TEST_DIR`.
- `tool_response.cursor_advanced_to` is the ONLY field consumed; null/missing means skip the write entirely (matches `cursor_advanced_to: null` semantics from `mcp-server/src/lib/activity.ts:98-100`).
- The hook is best-effort: malformed stdin, jq failures, mkdir failures, and write failures must all exit 0 without surfacing errors to the user. Pattern reference: `outcome-collector.sh:88` (`|| { echo "WARNING: ..." >&2; return 0; }`).
- Hook tool-name matcher uses the bare server-side name (`ralph_hero__recent_activity`), matching the existing `ralph_hero__save_issue` matchers in `hooks.json:37,109` — NOT the `mcp__plugin_...` prefix used in skill `allowed-tools`.
- The skill change must remove `Write` from `allowed-tools` AND drop Step 5; Step 4's "Do not advance the cursor" wording on the empty case is no longer skill-side load-bearing (the hook will see `cursor_advanced_to: null` and skip), but the prose direction to the LLM about what to output is still relevant and stays.

## Current State Analysis

The catch-up subsystem today is split unevenly between hooks and the LLM:

- **Hook-driven write (activity log)**: `record-activity.sh` is wired in `hooks.json:30` (SessionStart) and `hooks.json:165` (matcher-less PostToolUse). Each tool call appends one JSON line to `~/.ralph-hero/activity/YYYY/MM/DD.jsonl`.
- **Stateless MCP read**: [`mcp-server/src/lib/activity.ts:98-100`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/activity.ts#L98-L100) computes `cursor_advanced_to` as the verbatim `ts` of the last event in the windowed result, or `null` for empty results. The MCP server holds zero cursor state.
- **LLM-driven cursor write (the problem)**: [`plugin/ralph-hero/skills/catch-up/SKILL.md:59-67`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/catch-up/SKILL.md#L59-L67) instructs the LLM to call `Write(~/.ralph-hero/cursors/catch-up.json, {"last_event_ts": "<value>"})`. This produces a visible Write call in the user's transcript on every /hello, burns tokens, and is asymmetric with the rest of the activity-log subsystem.

The ["successful synthesis" gate](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/catch-up/SKILL.md#L73-L78) is not load-bearing: `cursor_advanced_to: null` already encodes the empty case, and a tool-error path means PostToolUse never fires. See research doc's "The 'successful synthesis' gate is not load-bearing" section for the full argument.

The reference patterns are concrete:
- [`outcome-collector.sh:88-99`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh#L88-L99) — read stdin JSON, extract a value from `tool_response`, persist it, swallow errors.
- [`superpowers-bridge.sh:72-85`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh#L72-L85) — `jq -n --arg` JSON construction from `tool_response`.
- [`hook-utils.sh:11-22`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh#L11-L22) — `read_input` and `get_field` helpers for stdin extraction.

## Desired End State

### Verification

- [ ] `cursor-advance-catch-up.sh` exists and is executable, reads stdin JSON, writes `~/.ralph-hero/cursors/catch-up.json` only when `tool_response.cursor_advanced_to` is non-null
- [ ] `hooks.json` has a new `PostToolUse` entry with matcher `ralph_hero__recent_activity` calling the new script
- [ ] `skills/catch-up/SKILL.md` no longer contains Step 5; `allowed-tools` lists only `Read` and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity`
- [ ] New test file `cursor-advance-catch-up.test.sh` covers all four cases from AC: non-null cursor written, null cursor skipped, missing parent dir auto-created, malformed stdin doesn't crash
- [ ] Manual verification: `/ralph-hero:catch-up` no longer emits a visible `Write(catch-up.json)` tool call, but `~/.ralph-hero/cursors/catch-up.json` still advances between invocations
- [ ] All existing tests in `plugin/ralph-hero/mcp-server/` and `plugin/ralph-hero/hooks/scripts/__tests__/` still pass

## What We're NOT Doing

- Not changing the cursor file path or shape (`~/.ralph-hero/cursors/catch-up.json`, `{"last_event_ts": "..."}`)
- Not changing the MCP `recent_activity` tool's response shape
- Not changing the activity log writer (`record-activity.sh`) or its hook wiring
- Not refactoring the skill's Step 1 (Read cursor) — the LLM still needs to read the cursor for the `since` parameter
- Not adding a `PostSkillInvoke` mechanism (the harness doesn't surface it; see `hooks.json:6` note)
- Not introducing a new abstraction for cursor management beyond a single bash script
- Not migrating other skills' state files (out of scope; no other skills currently write JSON state files via the LLM)

## Implementation Approach

The work is a strict "do the thing the research doc concluded": write one bash script following the `outcome-collector.sh` pattern, register one PostToolUse entry in `hooks.json`, edit the catch-up SKILL.md to drop Step 5 and remove `Write` from `allowed-tools`. Tests are the only non-mechanical part — they need to cover the four enumerated cases plus exercise the env-var override that lets the test redirect the cursor write away from the real `~/.ralph-hero`.

Build the script first with its tests (Phase 1), then wire it into `hooks.json` and the skill (Phase 2). Phase 2 has no automated test of its own — it's a config + prose change that's verified by reading the diff and by manual /hello invocation.

---

## Phase 1: Cursor-advance hook script + tests

- **depends_on**: null

### Overview

Create the new `cursor-advance-catch-up.sh` script following the `outcome-collector.sh:88-99` pattern, plus a parallel test file covering the four AC test cases. The script must support a `RALPH_CURSOR_DIR` env-var override so tests can redirect the write target.

### Tasks

#### Task 1.1: Create cursor-advance-catch-up.sh

- **files**: [`plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh) (create)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] First line is `#!/bin/bash`; second line is a header comment explaining purpose and the matched event (`PostToolUse(ralph_hero__recent_activity)`)
  - [x] `set -euo pipefail` at top
  - [x] Reads full stdin into a variable using `INPUT=$(cat)` (matches `outcome-collector.sh:26` pattern). Does NOT need to source `hook-utils.sh` — direct `jq` on `$INPUT` is fine, mirroring `outcome-collector.sh`.
  - [x] Resolves cursor dir as `${RALPH_CURSOR_DIR:-${HOME}/.ralph-hero/cursors}` and cursor file as `$CURSOR_DIR/catch-up.json`
  - [x] Extracts `tool_response.cursor_advanced_to` via `jq -r '.tool_response.cursor_advanced_to // empty'` (the `// empty` idiom emits empty-string for null/missing — same pattern as `outcome-collector.sh:108-110`)
  - [x] If extracted value is empty (null cursor case), exits 0 without writing
  - [x] If extracted value is non-empty, runs `mkdir -p "$CURSOR_DIR"` (suppressing error to `2>/dev/null || true` per `outcome-collector.sh:23` pattern) then writes `{"last_event_ts":"<value>"}` via `jq -n --arg ts "$cursor" '{last_event_ts: $ts}' > "$CURSOR_FILE"`
  - [x] Final line is `exit 0` so script always succeeds (best-effort)
  - [x] Wraps the write in `|| { echo "WARNING: cursor-advance-catch-up failed to write cursor" >&2; exit 0; }` matching `outcome-collector.sh:88` defensive style
  - [x] File is `chmod +x` (verify with `stat -f %p` on macOS or via `git ls-files --stage` showing `100755`)
  - [x] Total script length under 50 lines (sanity check on simplicity)

#### Task 1.2: Create test file with four required cases

- **files**: [`plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh) (create), [`plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh) (read for harness pattern)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Shebang `#!/usr/bin/env bash`; `set -uo pipefail` (matching `record-activity.test.sh:5`); resolves `SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/cursor-advance-catch-up.sh"`
  - [x] Uses `TEST_DIR="$(mktemp -d)"` with `trap "rm -rf $TEST_DIR" EXIT` (matching `record-activity.test.sh:8-9`)
  - [x] Defines `assert_eq` and `assert_file_exists` helpers identical in shape to `record-activity.test.sh:14-39`; tracks `PASS` and `FAIL` counters; final line `[ "$FAIL" -eq 0 ]`
  - [x] Sets `export RALPH_CURSOR_DIR="$TEST_DIR/cursors"` before each test block (or per-block reset via `rm -rf "$TEST_DIR/cursors"`)
  - [x] **Test case 1 (non-null cursor written)**: Pipe `'{"tool_name":"ralph_hero__recent_activity","tool_response":{"cursor_advanced_to":"2026-05-03T10:00:00.000Z","events":[],"skipped_lines":0}}'` to script. Assert cursor file exists at `$TEST_DIR/cursors/catch-up.json`. Assert `jq -r .last_event_ts < $CURSOR_FILE` equals `"2026-05-03T10:00:00.000Z"`. Assert script exit 0.
  - [x] **Test case 2 (null cursor skipped)**: Pipe `'{"tool_name":"ralph_hero__recent_activity","tool_response":{"cursor_advanced_to":null,"events":[],"skipped_lines":0}}'` to script. Assert cursor file does NOT exist. Assert script exit 0.
  - [x] **Test case 3 (missing parent dir auto-created)**: Set `RALPH_CURSOR_DIR="$TEST_DIR/deeply/nested/cursors"` (parent does not pre-exist). Pipe a non-null cursor payload. Assert the directory was created and the file exists.
  - [x] **Test case 4 (malformed stdin doesn't crash)**: Pipe literal `not json at all` to script. Assert exit 0. Pipe empty string to script. Assert exit 0. Pipe `'{}'` (valid JSON, no fields). Assert exit 0 and no cursor file written.
  - [x] **Bonus: `cursor_advanced_to` field missing entirely**: Pipe `'{"tool_name":"ralph_hero__recent_activity","tool_response":{"events":[]}}'` (no cursor_advanced_to key). Assert exit 0, no cursor written.
  - [x] Test file ends with `echo "Results: $PASS passed, $FAIL failed"` line then `[ "$FAIL" -eq 0 ]` (matches `record-activity.test.sh:210-211`)
  - [x] File is `chmod +x` so it can be invoked directly

### Phase Success Criteria

#### Automated Verification:

- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh` — exits 0 with all assertions passing
- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh` — still passes (no regression in adjacent test file)
- [x] `shellcheck plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` — no errors (if shellcheck available; non-blocking if not installed)

#### Manual Verification:

- [x] Read the script source — confirm it follows the `outcome-collector.sh` style (set -euo pipefail, INPUT=$(cat), jq extraction, defensive mkdir, exit 0)
- [x] Verify the script handles `RALPH_CURSOR_DIR` override correctly by running it manually with the env var set

**Creates for next phase**: A working, tested hook script ready to be wired into `hooks.json`.

---

## Phase 2: Wire hook + remove LLM Write from skill

- **depends_on**: [phase-1]

### Overview

Register the new script in `hooks.json` under `PostToolUse` matched on `ralph_hero__recent_activity`, and edit the catch-up SKILL.md to drop Step 5 and remove `Write` from `allowed-tools`. Both edits are mechanical; the test for this phase is reading the diff and a manual /hello invocation.

### Tasks

#### Task 2.1: Add PostToolUse entry to hooks.json

- **files**: [`plugin/ralph-hero/hooks/hooks.json`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] New entry inserted in the `"PostToolUse"` array (alongside the existing `ralph_hero__save_issue`, `ralph_hero__create_comment`, `ralph_hero__get_issue`, `Write`, `Bash` entries — see [`hooks.json:107-168`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/hooks.json#L107-L168))
  - [x] Entry shape matches existing matchers exactly:
    ```json
    {
      "matcher": "ralph_hero__recent_activity",
      "hooks": [
        {
          "type": "command",
          "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/cursor-advance-catch-up.sh"
        }
      ]
    }
    ```
  - [x] Inserted before the matcher-less `record-activity.sh tool_called` entry at the end of `PostToolUse` (so the cursor advance fires before the activity log records the tool call — order is best-effort but conceptually the cursor advance is more specific)
  - [x] `jq . plugin/ralph-hero/hooks/hooks.json` parses cleanly (validates JSON syntax)
  - [x] No other entries removed or reordered

#### Task 2.2: Edit catch-up SKILL.md

- **files**: [`plugin/ralph-hero/skills/catch-up/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/catch-up/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `allowed-tools` list (currently lines 10-13) reduced to two entries: `Read` and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity`. Entry `Write` removed.
  - [x] Step 5 section (lines 59-67, "## Step 5: Advance cursor" through the closing `Use the Write tool...` paragraph) removed entirely
  - [x] Old "## Step 6: Output" section renamed to "## Step 5: Output" so step numbering remains contiguous (1-2-3-4-5)
  - [x] Constraints section (currently lines 73-78): "Cursor only advances on successful synthesis" bullet REMOVED (cursor advance is no longer a skill responsibility); "Never advance cursor when `recent_activity` errors" bullet REMOVED for the same reason. Other bullets (single output, sentence cap) retained.
  - [x] A new comment line added near the top of the skill body (after the `# Catch-up` heading or in a brief note section) explaining: cursor advancement is now automatic via the `cursor-advance-catch-up.sh` PostToolUse hook; the skill no longer manages the cursor file directly. One sentence, no extra ceremony.
  - [x] Step 1 (Read cursor) is UNCHANGED — the LLM still needs to read the cursor to compute the `since` parameter for `recent_activity`
  - [x] Step 4 empty-case wording ("Do not advance the cursor. Stop here.") is updated to drop the "Do not advance the cursor" phrase since that's now automatic; "Stop here." or equivalent terminator retained
  - [x] File still parses as a valid skill (frontmatter intact, code blocks balanced)

### Phase Success Criteria

#### Automated Verification:

- [x] `jq . plugin/ralph-hero/hooks/hooks.json > /dev/null` — JSON valid
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — TypeScript build still passes (no source changed but sanity check the workspace is healthy)
- [x] `cd plugin/ralph-hero/mcp-server && npm test` — full vitest suite passes (no source changed; this catches accidental cross-module breakage)
- [x] `bash plugin/ralph-hero/hooks/scripts/__tests__/cursor-advance-catch-up.test.sh` — still passes
- [x] `grep -c "^## Step " plugin/ralph-hero/skills/catch-up/SKILL.md` — returns `5` (Steps 1-5, with old Step 6 renumbered)
- [x] `grep "^  - Write$" plugin/ralph-hero/skills/catch-up/SKILL.md` — returns nothing (Write removed from allowed-tools)

#### Manual Verification:

- [ ] Run `/ralph-hero:catch-up` manually in a fresh session; observe the transcript shows no `Write(catch-up.json)` tool call but `~/.ralph-hero/cursors/catch-up.json` mtime advances
- [ ] Run `/ralph-hero:catch-up` a second time; observe the "nothing's changed" path (or new narrative) and the cursor advancing again on a non-empty result
- [ ] Run `/hello` (which dispatches catch-up via `Skill()`); confirm the hello output is unchanged from a user perspective (the Write call disappearing should be the only diff)
- [ ] Inspect cursor file contents after a /hello: `cat ~/.ralph-hero/cursors/catch-up.json` — confirm it still has the `{"last_event_ts": "..."}` shape

**Creates for next phase**: N/A (final phase).

---

## Integration Testing

- [ ] Smoke test the round-trip end-to-end: in a fresh session, delete `~/.ralph-hero/cursors/catch-up.json`, then run `/hello`. Confirm the cursor file is recreated with a valid `last_event_ts` and no `Write(catch-up.json)` appears in the transcript.
- [ ] Run with empty activity (e.g., temporarily set `RALPH_ACTIVITY_DIR` to a fresh empty dir) — confirm `cursor_advanced_to: null` flows through and the cursor file is NOT updated, matching the previous "do not advance the cursor" semantics.
- [ ] Stress: invoke `ralph_hero__recent_activity` directly via the MCP tool (outside the catch-up skill context) — confirm the hook fires and updates the cursor regardless of caller (this is a behavior expansion compared to the LLM-gated design, and is acceptable per the research doc's "successful synthesis gate is not load-bearing" finding).

## References

- Research: [thoughts/shared/research/2026-05-03-GH-0985-catch-up-cursor-llm-write.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-03-GH-0985-catch-up-cursor-llm-write.md)
- Issue: [GH-985](https://github.com/cdubiel08/ralph-hero/issues/985)
- Pattern reference: [`outcome-collector.sh:88-99`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/outcome-collector.sh#L88-L99)
- Pattern reference: [`superpowers-bridge.sh:72-85`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/superpowers-bridge.sh#L72-L85)
- Pattern reference: [`hook-utils.sh:11-22`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/hook-utils.sh#L11-L22)
- Test harness reference: [`record-activity.test.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/__tests__/record-activity.test.sh)
- Cursor compute reference: [`mcp-server/src/lib/activity.ts:98-100`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/activity.ts#L98-L100)
- Related closed: [GH-940](https://github.com/cdubiel08/ralph-hero/issues/940) (created the LLM-Write design being replaced), [GH-967](https://github.com/cdubiel08/ralph-hero/issues/967) (adjacent activity-log hook fix)
