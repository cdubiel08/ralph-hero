---
date: 2026-05-08
status: draft
type: plan
github_issue: 1140
github_issues: [1140]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1140
primary_issue: 1140
parent_plan: thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md
tags: [skill, autopilot, audit-log, jsonl, hook-gate, schedulewakeup]
---

# Autopilot Phase 4 — Audit Log JSONL + ScheduleWakeup Hook Gate

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]]
- builds_on:: [[2026-05-08-GH-1137-autopilot-scaffold]]
- builds_on:: [[2026-05-08-GH-1138-autopilot-tick-body]]
- builds_on:: [[2026-05-08-GH-1139-autopilot-loop-termination]]

## Overview

Single-issue plan for GH-1140, Phase 4 of the parent plan-of-plans (`2026-05-07-GH-1136-autopilot-skill.md`). Two coupled additions to the autopilot skill that just landed Steps 0-10 in Phases 1-3:

1. **Audit-log writer** — a markdown section inserted between Step 7 (counter update) and Step 8 (termination) of `plugin/ralph-hero/skills/autopilot/SKILL.md` that appends one structured JSON line per tick to `~/.ralph-hero/autopilot.jsonl`. The schema captures pre/post workflow state, derived outcome, PR URL, duration, no-progress streak, and the next-action decision. The rule "when `next_action == \"stop\"`, `next_delay_seconds` MUST be `null`" yields a clean parser set `{60, 1200, null}` for downstream tooling (`jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u`).
2. **PreToolUse hook gate** — a new executable shell script `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` registered in the autopilot skill's frontmatter. Two checks: (a) `prompt =~ ^/ralph-hero:autopilot` (sufficient evidence the call is autopilot-driven; the only required check), (b) `delaySeconds != 300` (cache-window anti-pattern). The gate does NOT check `RALPH_COMMAND=autopilot` — that signal is unverified across `ScheduleWakeup` re-fires per the R2 critique, so the prompt regex is the load-bearing check.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1140 | Autopilot: audit log JSONL + ScheduleWakeup hook gate | XS |

## Shared Constraints

Inherited from parent plan-of-plans `2026-05-07-GH-1136-autopilot-skill.md`. Constraints that bind this phase:

1. **Pure markdown skill body + one shell hook script** — no TypeScript / MCP changes. `npm test` continues to pass without modification (`1184 passed | 2 skipped` baseline from Phase 1; expected ±0).
2. **No new dependencies** — `package.json` unchanged; `mcp-server/package.json` unchanged.
3. **`delaySeconds` invariant**: the skill body (already written in Phase 3) only branches into `{60, 1200}` for live `ScheduleWakeup` calls. Phase 4's hook gate adds a defensive runtime check rejecting `delaySeconds == 300`. The gate must NOT reject `60`, `1200`, or any other value outside the cache-window anti-pattern — it is a single-value blacklist, not an allowlist. Other values (e.g., `270`, `1800`) remain technically acceptable per the `ScheduleWakeup` tool's own [60, 3600] clamp; only `300` is the documented anti-pattern.
4. **Hook gate uses `prompt` regex exclusively, NOT `RALPH_COMMAND`**: per parent plan §Phase 4 R2 design choice, `set-skill-env.sh` writes `RALPH_COMMAND=autopilot` to `$CLAUDE_ENV_FILE` which is per-session and unverified across `ScheduleWakeup` re-fires. The implementer must NOT re-add an `RALPH_COMMAND=autopilot` env-var check to the hook script. The `prompt =~ ^/ralph-hero:autopilot` check is sufficient.
5. **Hook gate is `PreToolUse` only**, not `PostToolUse`. The validation targets `tool_input.delaySeconds` and `tool_input.prompt` which are both available pre-call. `ScheduleWakeup` does not return a response shape that requires inspection — there is no PostToolUse use-case here.
6. **Hook gate matcher is `ScheduleWakeup`** (the bare tool name, not a glob, not a prefix). `ScheduleWakeup` is a top-level tool, not an `mcp__*` tool, so the matcher is just the unqualified tool name — verified against existing patterns like `hero-dispatch-gate.sh` (matcher: `Skill`) and `branch-gate.sh` (matcher: `Bash`).
7. **No collision with existing `ScheduleWakeup` callers**: parent plan §Current State Analysis verified zero existing callers in `plugin/` (`grep -rn ScheduleWakeup plugin/` returns no results). The gate cannot break any current skill. Implementer should re-verify this fact by re-running the grep before merging — if any new caller has appeared since the parent plan was written, the gate's prompt regex must be widened or the gate must be made caller-aware.
8. **Audit-log entry schema (canonical, from parent plan §Phase 4 lines 401-426)**: `{ts, iteration, issue_number, issue_url, pre_state, post_state, outcome, pr_url, duration_ms, no_progress_streak, next_delay_seconds, next_action, args}`. Implementer must use this exact field set; downstream consumers (mentioned in parent plan §Follow-up Work as a future MCP tool) will rely on stable keys.
9. **STOP / null rule (canonical, from parent plan §Phase 4 lines 421-426)**: whenever `next_action == "stop"`, `next_delay_seconds` MUST be the JSON literal `null` (not `0`, not absent, not the string `"null"`). For `escalated`, `dry_run`, `backlog_empty`, no-progress-streak escalation, max-iterations stop, and any other STOP cause, `next_delay_seconds: null`. For continuing ticks, `next_delay_seconds` is the value Step 9 selected (`60` or `1200`). The downstream `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` must yield exactly `{60, 1200, null}` after a healthy multi-tick run — no other values.
10. **Audit-log entry timing**: the write happens between Step 7 (counter update) and Step 8 (termination check). Rationale: by Step 7 we know `iteration`, `state.no_progress_streak`, and `outcome`; by inserting before Step 8 we capture the row even when Step 8 STOPs (otherwise STOP rows would be lost). However, the `next_action` and `next_delay_seconds` fields require knowing Step 8/9's branch — so the write must capture the row in two passes OR (per parent plan's structural choice) the write happens AFTER Step 8 has resolved its decision but BEFORE Step 9 actually calls `ScheduleWakeup`. Implementer reading the parent plan's lines 401-403 verbatim ("after Step 7 (counter update) and before Step 8 (termination check)") must reconcile: the write executes once Step 8 has decided STOP-or-CONTINUE (so `next_action` is known) but BEFORE the `ScheduleWakeup` call lands (so the audit row precedes the side-effect, ensuring forensic capture even if the wakeup fails). Concretely: place the audit-log section as a sub-step immediately after Step 8's branch decision and before any `ScheduleWakeup` call or final-report emission. The parent plan's "between 7 and 8" phrasing is a *narrative ordering hint*, not a literal between-block placement; the implementer must place it where the data is ready.
11. **`mkdir -p ~/.ralph-hero` before append**: the skill body must idempotently create the parent directory before redirecting into the JSONL file. First-run case: no directory exists. Subsequent runs: `mkdir -p` is a no-op.
12. **Use `jq -nc` to construct the JSON**, not manual string concatenation. The `-n` flag means "null input" (start from nothing), `-c` means "compact output" (one line, no pretty-printing — required for JSONL). All field values must flow through `--arg` / `--argjson` parameters to avoid shell-quoting bugs.
13. **`shellcheck` MUST pass** on the new hook script. Use `set -euo pipefail` at the top, follow `split-estimate-gate.sh` structure as the reference style. The script should be idempotent and side-effect-free except for stderr writes and exit codes.
14. **Frontmatter `PreToolUse` block** appended to the existing `hooks:` section (which currently has only `SessionStart`). The new block must use `matcher: "ScheduleWakeup"` with the script reference `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-wakeup-gate.sh`.
15. **HTML-comment marker at end of `SKILL.md`**: Phase 3 left a comment pointing at Phases 4 and 5; Phase 4 must update it to reference Phase 5 only (the docs + eval scenarios in #1141). No dangling Phase-4-pointing comment after Phase 4 lands.
16. **Resolved configuration** for runtime lookups: Owner=cdubiel08, Repo=ralph-hero, Project=3.

## Current State Analysis

After Phases 1-3 land, `plugin/ralph-hero/skills/autopilot/SKILL.md` exists with frontmatter, Configuration block, Steps 0 through 10, and a closing HTML comment placeholder pointing at Phases 4 and 5 (`<!-- Audit log writes (between Step 7 and Step 8) and PreToolUse hook gate added in Phase 4 (GH-1140); README/CLAUDE.md/eval-scenarios in Phase 5 (GH-1141) -->`). The skill body's frontmatter has only the `SessionStart` hook from Phase 1; the `PreToolUse: ScheduleWakeup` matcher is the new addition Phase 4 brings.

**Note on merge order**: At plan-write time, #1137 is implemented (in `In Progress`, branch `feature/GH-1137`), #1138 is implemented (in `In Progress`), and #1139 is in planning (workflowState pending Phase 3 plan write). #1140 (this plan) is the fourth phase. The Phase 4 implementer will work from a fresh branch off main *after* Phases 1-3 land. If Phase 3 has not landed when Phase 4 starts, the implementer should rebase or wait — Phase 4's audit-log section depends on Step 7's counter update being on disk.

Reference points for Phase 4 work:

- Parent plan `2026-05-07-GH-1136-autopilot-skill.md` lines 387-503 — drop-in copy for the audit-log section, hook script content, and frontmatter additions.
- Parent plan lines 400-436 — canonical audit-log entry shape and the `mkdir -p ~/.ralph-hero` + `jq -nc` append pattern.
- Parent plan lines 442-472 — canonical hook script body (43 lines incl. blank lines and comments).
- Parent plan lines 478-489 — canonical frontmatter `hooks:` block addition.
- `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` — reference style for hook scripts: `#!/bin/bash`, `set -euo pipefail`, `source "$(dirname "$0")/hook-utils.sh"`, JSON parsing via `jq -r`, exit codes `0` (allow) / `2` (block) per CLAUDE.md §Hook Patterns.
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — shared utilities (`read_input`, `get_field`, `allow`, `block`, `warn`). Phase 4 hook script may use these or write inline `cat | jq` — parent plan's reference body uses inline `jq` without sourcing `hook-utils.sh`; either approach is acceptable, but consistency with `split-estimate-gate.sh` favors sourcing.
- `plugin/ralph-hero/skills/autopilot/SKILL.md` lines (post-Phase-3) — Step 7 ends right before the audit-log insertion point; Step 8 begins right after.
- ralph-hero CLAUDE.md §Hook Patterns — canonical decision matrix for PreToolUse vs PostToolUse. Phase 4 is PreToolUse-only because the validation targets `tool_input` fields, not `tool_response` shape.

## Desired End State

After this phase:

- `plugin/ralph-hero/skills/autopilot/SKILL.md` contains a new "Audit log entry shape" section between Step 7 and the dispatch into Step 8, documenting the JSON schema and the `mkdir -p` + `jq -nc` append pattern.
- `plugin/ralph-hero/skills/autopilot/SKILL.md`'s frontmatter `hooks:` block has a new `PreToolUse: ScheduleWakeup` matcher entry pointing at `autopilot-wakeup-gate.sh`.
- `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` exists, is executable, passes `shellcheck`, and implements the two-check gate (prompt regex, delay anti-pattern).
- `~/.ralph-hero/autopilot.jsonl` is created on the first tick that runs through the audit-log section, every line is valid JSON, and a multi-tick run accumulates one line per tick.
- The HTML-comment marker at the end of `SKILL.md` is updated to point only at Phase 5.
- `npm test` in `plugin/ralph-hero/mcp-server/` still passes (unchanged).
- No `package.json` change.

### Verification

- [ ] `test -f plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` exits 0
- [ ] `grep -q '## Audit log entry shape' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'matcher: "ScheduleWakeup"' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'autopilot-wakeup-gate.sh' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'mkdir -p ~/.ralph-hero' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'jq -nc' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -qE 'next_delay_seconds.*null' plugin/ralph-hero/skills/autopilot/SKILL.md` (STOP-row null rule documented)
- [ ] YAML frontmatter still parses: `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (unchanged baseline)
- [ ] `git diff plugin/ralph-hero/mcp-server/package.json` is empty (no dep changes)
- [ ] `git diff --stat` shows only `plugin/ralph-hero/skills/autopilot/SKILL.md` and the new `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` modified
- [ ] HTML comment at end of `SKILL.md` no longer references Phase 4 (only Phase 5)
- [ ] Manual: after one tick, `test -f ~/.ralph-hero/autopilot.jsonl` succeeds
- [ ] Manual: `jq -e . ~/.ralph-hero/autopilot.jsonl > /dev/null` exits 0 (every line valid JSON)
- [ ] Manual: after a 3-tick run, `wc -l ~/.ralph-hero/autopilot.jsonl` shows 3+ lines
- [ ] Manual: after a 3-tick run that ends in `backlog_empty`, `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` yields a subset of `{60, 1200, null}` (no `0`, no `300`, no other values)
- [ ] Manual: edit the skill body to set `delaySeconds=300` in a `ScheduleWakeup` call → run one tick → hook blocks with stderr message containing "cache-window"
- [ ] Manual: edit the skill body to set `prompt="/something-else"` in a `ScheduleWakeup` call → run one tick → hook blocks with stderr message containing "must re-invoke /ralph-hero:autopilot"
- [ ] Manual: without `RALPH_AUTOPILOT_ENABLE=true`, the skill body refuses with the safety-check message before ever reaching `ScheduleWakeup` (Step 0 from Phase 1)
- [ ] Manual: audit-log STOP rows have `next_delay_seconds: null` (verified via `jq -r 'select(.next_action == "stop") | .next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` yielding only `null`); running rows have `60` or `1200` (verified via `jq -r 'select(.next_action == "schedule") | .next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` yielding `{60, 1200}`)
- [ ] Manual: `grep -rn ScheduleWakeup plugin/` returns no results outside the autopilot skill itself (re-confirms zero pre-existing callers)

## What We're NOT Doing

- **No log rotation** — explicitly deferred per parent plan §Performance Considerations. JSONL grows ~500 bytes/tick → ~500 KB after 1000 ticks; no rotation is needed for the MVP. A future enhancement could add rotation triggered by file size or age.
- **No audit-log MCP tool** — parent plan §Follow-up Work mentions a future `/tasks`-style autopilot dashboard exposing the JSONL via an MCP tool. Out of scope for Phase 4.
- **No `RALPH_COMMAND=autopilot` env-var check** in the hook gate — explicitly forbidden by R2 critique design (parent plan §Key Discoveries). The prompt regex is sufficient and the env var is unverified across re-fires.
- **No `PostToolUse` matcher** — `ScheduleWakeup`'s response is not relevant to the gate's enforcement. PreToolUse-only.
- **No new MCP server code** — Phase 4 is shell + markdown.
- **No README / CLAUDE.md / eval-scenarios.md edits** — Phase 5 (#1141).
- **No retroactive replay** of past ticks into the audit log — the file starts empty and accumulates from Phase 4 forward. There is no concept of historical reconstruction.
- **No JSONL schema versioning** — a stable schema for v1 is sufficient; if the schema needs to evolve later, a `schema_version` field can be added at that time. Adding it now would be premature.
- **No collision with `RALPH_DEBUG` JSONL** — the MCP server's debug JSONL (mentioned in CLAUDE.md §Environment Variables: "Set to `true` to enable JSONL debug logging") is a different file in a different location. No conflict.

## Implementation Approach

A coordinated two-file change. The implementer creates the hook script first (so it can be referenced by the frontmatter), then adds the skill-body audit-log section, then adds the frontmatter matcher. Verification is mostly grep-and-shellcheck plus one manual end-to-end smoke test.

**Phase dependency annotations**

This is a single-phase plan; the lone phase has `depends_on: null` at the plan-level. The work itself depends on Phase 3 (#1139) merging to main first — that dependency is enforced via the GitHub `blockedBy` edge maintained on the issue (not via a `depends_on` line inside this plan).

---

## Phase 1: Audit Log + Hook Gate

- **depends_on**: null

### Overview

Three coordinated changes to land Phase 4: (1) create the hook script file with the two-check gate body, (2) append the audit-log entry-shape section to the skill body and update the trailing HTML comment, (3) add the `PreToolUse: ScheduleWakeup` matcher to frontmatter pointing at the new script. Each change is independently verifiable via grep / shellcheck / `npm test`.

### Tasks

#### Task 1.1: Create `autopilot-wakeup-gate.sh` hook script

- **files**: `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
  - [ ] File is executable: `test -x plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` (`chmod +x` applied)
  - [ ] First line is `#!/bin/bash` (or `#!/usr/bin/env bash` — either is acceptable; `split-estimate-gate.sh` uses `#!/bin/bash` for style consistency)
  - [ ] `set -euo pipefail` present near the top (errexit + nounset + pipefail)
  - [ ] Reads JSON input from stdin via `cat` or `read_input` (from `hook-utils.sh` — sourcing is encouraged for consistency with `split-estimate-gate.sh`)
  - [ ] Defines a `get_field` helper (or imports one from `hook-utils.sh`) that pipes stdin into `jq -r "$1"`
  - [ ] Reads `tool_name` and short-circuits with `exit 0` if it is not `ScheduleWakeup` (defensive — the matcher should already filter, but defense-in-depth)
  - [ ] Reads `tool_input.delaySeconds` (default `0` via `// 0`) and `tool_input.prompt` (default empty string via `// ""`)
  - [ ] Check 1 (prompt regex): if `prompt` does NOT match `^/ralph-hero:autopilot`, write a clear stderr message ("Autopilot ScheduleWakeup must re-invoke /ralph-hero:autopilot, got: $prompt") and `exit 2` (block)
  - [ ] Check 2 (cache-window anti-pattern): if `delaySeconds == 300`, write a clear stderr message ("delaySeconds=300 is the 5-min cache-window anti-pattern — pick <=270 or >=1200") and `exit 2` (block)
  - [ ] If both checks pass, `exit 0` (allow)
  - [ ] Does NOT check `RALPH_COMMAND` env var (R2 design choice; the prompt regex is the load-bearing check)
  - [ ] `shellcheck plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` exits 0 with no warnings
  - [ ] Manual smoke test 1 (block-on-bad-prompt): `echo '{"tool_name":"ScheduleWakeup","tool_input":{"delaySeconds":60,"prompt":"/something-else"}}' | ./autopilot-wakeup-gate.sh ; echo "exit=$?"` prints `exit=2` and a stderr line containing "must re-invoke"
  - [ ] Manual smoke test 2 (block-on-300): `echo '{"tool_name":"ScheduleWakeup","tool_input":{"delaySeconds":300,"prompt":"/ralph-hero:autopilot"}}' | ./autopilot-wakeup-gate.sh ; echo "exit=$?"` prints `exit=2` and a stderr line containing "cache-window"
  - [ ] Manual smoke test 3 (allow-good): `echo '{"tool_name":"ScheduleWakeup","tool_input":{"delaySeconds":60,"prompt":"/ralph-hero:autopilot --max-iterations 5"}}' | ./autopilot-wakeup-gate.sh ; echo "exit=$?"` prints `exit=0`
  - [ ] Manual smoke test 4 (passthrough on non-ScheduleWakeup): `echo '{"tool_name":"Bash","tool_input":{}}' | ./autopilot-wakeup-gate.sh ; echo "exit=$?"` prints `exit=0`
  - [ ] Manual smoke test 5 (allow 1200): `echo '{"tool_name":"ScheduleWakeup","tool_input":{"delaySeconds":1200,"prompt":"/ralph-hero:autopilot"}}' | ./autopilot-wakeup-gate.sh ; echo "exit=$?"` prints `exit=0`

#### Task 1.2: Append audit-log section to `SKILL.md`

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A new `## Audit log entry shape` heading is present in the skill body, located between the end of Step 7's body and the start of Step 8's heading (per parent plan §Phase 4 narrative ordering; the implementer reconciles the data-readiness ordering per Shared Constraint #10)
  - [ ] Body opens by stating "After Step 8's branch decision is made, but before Step 9's `ScheduleWakeup` call (or Step 10's final report), append a single JSON line to `~/.ralph-hero/autopilot.jsonl`"
  - [ ] Body documents the canonical entry-shape JSON verbatim (matching parent plan lines 405-419) with fields: `ts`, `iteration`, `issue_number`, `issue_url`, `pre_state`, `post_state`, `outcome`, `pr_url`, `duration_ms`, `no_progress_streak`, `next_delay_seconds`, `next_action`, `args`
  - [ ] Body documents per-outcome variations verbatim (matching parent plan lines 421-424):
    - escalations: `outcome="escalated"`, `escalation_reason="<from last comment>"`, `next_action="stop"`, `next_delay_seconds=null`
    - dry-run: `outcome="dry_run"`, `next_action="stop"`, `next_delay_seconds=null`
    - backlog-empty: `outcome="backlog_empty"`, `next_action="stop"`, `next_delay_seconds=null`, `issue_number=null`
    - no-progress-streak escalation, max-iterations stop, etc.: `next_action="stop"`, `next_delay_seconds=null`
  - [ ] Body explicitly states the STOP/null rule: "whenever `next_action == \"stop\"`, `next_delay_seconds` MUST be `null` (not 0, not absent). This makes downstream JSONL parsers (e.g., `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u`) yield a clean set: `{60, 1200, null}`"
  - [ ] Body documents the `mkdir -p ~/.ralph-hero` + `jq -nc` append pattern verbatim (matching parent plan lines 428-435), including the shell snippet showing `--arg`/`--argjson` flags for safe JSON construction
  - [ ] Body explicitly notes that the write happens BEFORE the side-effecting `ScheduleWakeup` or final-report emission, so the audit row is forensically captured even if the wakeup or final-report fails
  - [ ] Body cross-references Step 9 (where `next_delay_seconds` value is computed) and Step 10 (where `next_action="stop"` rows feed the final report)
  - [ ] No claim to log rotation (deferred per parent plan §Performance Considerations)
  - [ ] No claim to schema versioning (intentional — see What We're NOT Doing)

#### Task 1.3: Add `PreToolUse: ScheduleWakeup` matcher to frontmatter

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify — frontmatter only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2]
- **acceptance**:
  - [ ] Frontmatter `hooks:` block contains both the existing `SessionStart` entry (preserved unchanged) and a new `PreToolUse` entry
  - [ ] The new `PreToolUse` entry has exactly one matcher block with `matcher: "ScheduleWakeup"` (bare tool name, double-quoted)
  - [ ] The matcher block contains exactly one hooks entry: `type: command` with `command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-wakeup-gate.sh"`
  - [ ] The frontmatter still parses as valid YAML: `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
  - [ ] Indentation matches the existing `SessionStart` entry's style (2-space YAML)
  - [ ] `grep -A 6 'PreToolUse' plugin/ralph-hero/skills/autopilot/SKILL.md` shows the matcher and command lines in the expected order
  - [ ] No other frontmatter fields are mutated (no `allowed-tools` change, no `description` change, no `argument-hint` change)

#### Task 1.4: Update end-of-file HTML comment

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] HTML comment at end of file no longer references Phase 4 / GH-1140 (since Phase 4 is now landed in this commit)
  - [ ] HTML comment still references Phase 5 / GH-1141 (docs + eval scenarios) — e.g., `<!-- README/CLAUDE.md/eval-scenarios in Phase 5 (GH-1141) -->`
  - [ ] No dangling `## Step 11:` placeholder, no leftover Phase 4 marker text
  - [ ] Single trailing newline preserved

#### Task 1.5: Verify YAML, tests, shellcheck, and grep invariants

- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (read), `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` (read), `plugin/ralph-hero/mcp-server/package.json` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3, 1.4]
- **acceptance**:
  - [ ] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
  - [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (1184 passed | 2 skipped baseline from Phase 1, ±0 expected)
  - [ ] `shellcheck plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` exits 0 with no warnings
  - [ ] `git diff --stat` shows exactly two paths modified: `plugin/ralph-hero/skills/autopilot/SKILL.md` and `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
  - [ ] `git diff plugin/ralph-hero/mcp-server/package.json` is empty (no dep changes)
  - [ ] `grep -q '## Audit log entry shape' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q 'matcher: "ScheduleWakeup"' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q 'autopilot-wakeup-gate.sh' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q 'mkdir -p ~/.ralph-hero' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q 'jq -nc' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -qE 'next_delay_seconds.*null' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -q 'autopilot.jsonl' plugin/ralph-hero/skills/autopilot/SKILL.md`
  - [ ] `grep -rn ScheduleWakeup plugin/ | grep -v 'plugin/ralph-hero/skills/autopilot/' | grep -v 'plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh' | grep -v 'plugin/ralph-hero/agents/'` returns no results outside the autopilot skill itself (defensive re-check that no new `ScheduleWakeup` callers have appeared since the parent plan was written)

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
- [ ] `test -x plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` exits 0
- [ ] `grep -q '## Audit log entry shape' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'matcher: "ScheduleWakeup"' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'autopilot-wakeup-gate.sh' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'mkdir -p ~/.ralph-hero' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `grep -q 'jq -nc' plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] `python -c "import yaml; yaml.safe_load(open('plugin/ralph-hero/skills/autopilot/SKILL.md').read().split('---')[1])"` exits 0
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes
- [ ] `git diff plugin/ralph-hero/mcp-server/package.json` is empty
- [ ] `git diff --stat` shows exactly two paths modified

#### Manual Verification:
- [ ] After one tick, `test -f ~/.ralph-hero/autopilot.jsonl` succeeds
- [ ] `jq -e . ~/.ralph-hero/autopilot.jsonl > /dev/null` exits 0 (every line valid JSON)
- [ ] After a 3-tick run, `wc -l ~/.ralph-hero/autopilot.jsonl` shows 3+ lines
- [ ] After a 3-tick run that ends in `backlog_empty`, `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` yields a subset of `{60, 1200, null}` only
- [ ] `jq -r 'select(.next_action == "stop") | .next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` yields only `null`
- [ ] `jq -r 'select(.next_action == "schedule") | .next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u` yields a subset of `{60, 1200}`
- [ ] Edit the skill body to set `delaySeconds=300` in a `ScheduleWakeup` call → run one tick → hook blocks with stderr containing "cache-window"
- [ ] Edit the skill body to set `prompt="/something-else"` in a `ScheduleWakeup` call → run one tick → hook blocks with stderr containing "must re-invoke /ralph-hero:autopilot"
- [ ] Without `RALPH_AUTOPILOT_ENABLE=true`, the skill body refuses with the safety-check message before ever reaching `ScheduleWakeup`

**Creates for next phase**: A working autopilot skill body with audit logging and a defensive `ScheduleWakeup` gate. Phase 5 (#1141) adds the eval-scenarios document, the README section, and the CLAUDE.md edit — all consumer-facing docs that depend on the in-place skill behavior Phase 4 finalizes.

---

## Integration Testing

Phase-4-only — full integration (eval scenarios, multi-issue runs documented in `eval-scenarios.md`) is verified in Phase 5. For Phase 4, the manual verification list above is the integration test. Specifically:

- The audit-log file existence + JSONL validity + line count after a 3-tick run covers the happy path of the audit-log writer.
- The two manual block tests (delay=300, prompt=/something-else) cover both gate checks.
- The `next_delay_seconds` distribution check (`{60, 1200, null}` only) verifies the STOP/null rule end-to-end.
- The `grep -rn ScheduleWakeup plugin/` re-check confirms no new callers have appeared that would silently be blocked by the gate.

A useful manual smoke test before merging Phase 4: run `--max-iterations 2` against a 3-issue backlog with `RALPH_AUTOPILOT_ENABLE=true`. Expected: tick 1 + tick 2 each append one row with `next_action="schedule"`, `next_delay_seconds` one of `{60, 1200}`. Tick 3 stops in Step 8 with "max iterations hit", appends one row with `next_action="stop"`, `next_delay_seconds=null`. Total: 3 lines in `~/.ralph-hero/autopilot.jsonl`. `jq` validates each. The `grep` invariant (no new ScheduleWakeup callers) holds.

## Performance Considerations

- **Audit-log file size**: ~500 bytes/line × ~20 ticks per run = ~10 KB per overnight run. Across many runs, growth is bounded by user activity. No rotation needed for MVP.
- **Hook gate latency**: a single `jq -r` invocation + two `[[ ... ]]` checks. Sub-millisecond per `ScheduleWakeup` call. Negligible.
- **`mkdir -p ~/.ralph-hero` per tick**: idempotent and cached by the OS after first call. ~microsecond. Negligible.
- **`jq -nc` per tick**: a single-line JSON construction. Sub-millisecond. Negligible.

## Migration Notes

No migration. New file (the hook script) and additive edits to an existing skill body. No schema changes, no breaking changes. The audit-log file is created on first use; pre-existing autopilot.jsonl files (if any from manual testing) are appended to without modification.

## Follow-up Work (out of scope for this plan)

- **Log rotation** — when `~/.ralph-hero/autopilot.jsonl` grows past some threshold (e.g., 5 MB or 30 days of history), rotate to `autopilot.jsonl.YYYY-MM-DD` and start a fresh file. Not needed for MVP.
- **Audit-log MCP tool** — expose the JSONL via a new `ralph_hero__autopilot_history` MCP tool so other skills (e.g., `/hello`, `/status`) can surface autopilot run summaries. Tracked in parent plan §Follow-up Work as "/tasks-style autopilot dashboard".
- **Schema versioning** — if the audit-log schema evolves (new fields, removed fields, semantic changes), add a `schema_version: 1` field at that time. Not needed now.
- **Hook gate `ScheduleWakeup` allowlist** — currently the gate only allows prompts matching `^/ralph-hero:autopilot`. If other skills legitimately need to call `ScheduleWakeup` in the future, the gate must be made caller-aware (either via a per-skill prompt prefix allowlist or by moving the check into the autopilot skill body itself).

## References

- Parent plan-of-plans: [thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-07-GH-1136-autopilot-skill.md) (§Phase 4, lines 387-503)
- Phase 1 plan: [thoughts/shared/plans/2026-05-08-GH-1137-autopilot-scaffold.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-GH-1137-autopilot-scaffold.md)
- Phase 2 plan: [thoughts/shared/plans/2026-05-08-GH-1138-autopilot-tick-body.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-GH-1138-autopilot-tick-body.md)
- Phase 3 plan: [thoughts/shared/plans/2026-05-08-GH-1139-autopilot-loop-termination.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-08-GH-1139-autopilot-loop-termination.md)
- Issue: [GH-1140](https://github.com/cdubiel08/ralph-hero/issues/1140)
- Parent issue: [GH-1136](https://github.com/cdubiel08/ralph-hero/issues/1136)
- Reference hook script: `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` (style + structure reference for `set -euo pipefail`, `source hook-utils.sh`, `get_field`, exit-code conventions)
- Reference shared utilities: `plugin/ralph-hero/hooks/scripts/hook-utils.sh` (`read_input`, `get_field`, `allow`, `block`, `warn`)
- Hook patterns canonical doc: `/Users/dubiel/projects/ralph-hero/CLAUDE.md` §Hook Patterns (PreToolUse vs PostToolUse decision matrix)
- Audit-log entry-shape source: parent plan lines 401-426 (canonical 13-field schema + per-outcome variations + STOP/null rule)
- Hook script body source: parent plan lines 442-472 (canonical 30-line shell script body)
- Frontmatter `hooks:` block source: parent plan lines 478-489
- ScheduleWakeup tool description: cache-window guidance restating "never pick exactly 300s; prefer ≤270s (warm) or ≥1200s (committed)"
