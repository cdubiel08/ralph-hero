---
date: 2026-05-06
status: draft
type: plan
github_issue: 1015
github_issues: [1015, 1016, 1017, 1018]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1015
  - https://github.com/cdubiel08/ralph-hero/issues/1016
  - https://github.com/cdubiel08/ralph-hero/issues/1017
  - https://github.com/cdubiel08/ralph-hero/issues/1018
primary_issue: 1015
parent_plan: thoughts/shared/plans/2026-04-03-GH-0731-complete-autonomous-loop.md
tags: [ralph-hero, autonomous-loop, integrator, code-review, queue-picking, state-machine]
---

# Complete Autonomous Loop — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-03-GH-0731-complete-autonomous-loop]]
- builds_on:: [[2026-01-19-naive-hero-autonomous-loop]]
- builds_on:: [[2026-02-18-GH-0069-move-pr-creation-to-integrator]]
- builds_on:: [[2026-02-19-GH-0116-integrate-hygiene-check-ralph-loop]]
- builds_on:: [[2026-02-21-GH-0294-early-exit-empty-work-ralph-loop]]

## Overview

Four related issues that together complete the autonomous loop pipeline: queue-empty fundamentals, queue-picking on integrator skills, a new `ralph-code-review` skill, and the loop wiring + autonomous merge gate. All four are children of #731 (already split via `/ralph-split`); this plan is the per-child implementation plan that subsumes the parent plan-of-plans into atomic, dispatchable tasks.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1015 | Fix loop fundamentals — queue-empty text, review default, justfile/budget sync | S |
| 2 | GH-1016 | Add queue-picking to ralph-val, ralph-pr, ralph-merge (skills + agents) | S |
| 3 | GH-1017 | New ralph-code-review skill + agent + state machine + command contracts | S |
| 4 | GH-1018 | Phases 4+5: Wire integrator phases into loop + autonomous merge gate | S |

**Why grouped**: All four phases descend from the same parent plan (`#731`) and form the single-PR-coherent set of changes that turn the loop into a fully autonomous pipeline. Each phase depends on the previous phase's output reaching `main` (the queue-empty grep widening in Phase 1 is required for Phases 2–4's "Queue empty" outputs to short-circuit the loop; Phase 4 wires Phase 2 + Phase 3 skills into the loop). The phases are sequential, not parallelizable.

## Shared Constraints

These constraints apply to all four phases (inherited from parent plan and codebase conventions):

1. **Queue-empty pattern**: All skills that pick from a queue must output the literal string `"Queue empty"` when no work is available, then STOP. The loop's `run_claude` greps for this case-insensitively (`grep -qiE "Queue empty|Triage complete"` after Phase 1).

2. **Do NOT use a generic queue-empty pattern**: Patterns like `"No .* issues"` will false-positive on `val` output (`"No substantive issues found"` from a clean validation run) and silently halt the loop. Stick to the explicit `Queue empty|Triage complete` alternation.

3. **Hygiene exemption**: `ralph-hygiene` is a board-scanning skill — it always produces a report and has no concept of "no work". The loop already handles it as `work_done=true` unconditionally at `ralph-loop.sh:149`. Do NOT add queue-empty output to hygiene.

4. **Allowed-tools and agent tools both need updating**: Loop dispatches via `claude -p "/ralph-hero:<skill>"` (reads skill `allowed-tools`); `hero` and `finish` dispatch via `Agent()` (reads agent `tools:`). Adding a new tool requires updating BOTH places for full coverage.

5. **State-machine consistency**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` and `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` are kept in sync by `state-resolution.test.ts` lines 347–380. Any new `COMMAND_ALLOWED_STATES` entry must have a matching `commands.<name>` block in the JSON with `valid_output_states` covering the same set. The test will fail otherwise.

6. **Command contracts are enforced**: `plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json` contains entries for `ralph_impl`, `ralph_merge`, `ralph_pr`, etc. (verified via `grep "ralph_" ralph-command-contracts.json`). Any new ralph_* command must have an entry there too.

7. **PR review state contract for code-review**:
   - `gh pr list --head feature/GH-NNN --json number --jq length` returns the literal string `0` when empty — compare as a string OR use `--jq '.[0]'` and check for null.
   - `gh pr view PR_NUMBER --json reviewDecision` returns `"APPROVED"`, `"CHANGES_REQUESTED"`, `"REVIEW_REQUIRED"`, or `null`.
   - `Skill("code-review:code-review", "PR_NUMBER")` is the canonical positional invocation pattern — see `ralph-merge/SKILL.md:123` for reference.

8. **Pre-existing val-postcondition Stop hook** (`hooks/scripts/val-postcondition.sh`): refuses Stop unless output contains `"VALIDATION PASS"` or `"VALIDATION FAIL"`. The new "Queue empty" branch in ralph-val will be blocked. Resolution: emit a synthetic `VALIDATION PASS — no work` verdict alongside the `Queue empty` line so the hook lets the skill terminate.

9. **No new MCP server tools**: All needed tools already exist (`list_issues`, `save_issue`, `get_issue`, `create_comment`).

10. **Backwards compatibility**: `just merge NNN` (standalone, no auto-merge env) must continue to present the interactive `AskUserQuestion` review gate. The autonomous merge gate is opt-in via `RALPH_AUTO_MERGE=true`.

## Current State Analysis

**What works** (from parent plan + codebase scan):
- `scripts/ralph-loop.sh` runs hygiene → triage → split → research → plan → review → impl in sequence with timeout/budget
- `cli-dispatch.sh` provides `run_headless()` with output filtering
- `justfile` exposes `loop`, `hero`, `team`, plus per-skill recipes (`triage`, `research`, `plan`, etc.)
- `code-review:code-review` plugin runs headlessly, posts PR comments, uses 5 parallel Sonnet reviewers
- `ralph-merge` Step 4 already handles `RALPH_REVIEW_MODE=auto` (PR #757) and outputs `CODE_REVIEW_FEEDBACK` status when changes requested
- `ralph-impl` Step 2 detects "In Review" + PR comments → enters Address Mode automatically (`ralph-impl/SKILL.md:88-95`)

**What's broken/missing** (verified against current source):
1. `ralph-triage/SKILL.md:91` outputs `"Triage complete"`; `ralph-loop.sh:128` greps for `"Queue empty"` → no match → loop never registers triage queue as empty
2. `ralph-loop.sh:54` defaults `RALPH_REVIEW_MODE` to `interactive`; `justfile:205` defaults `loop`'s `review` to `"skip"` — unattended runs require explicit override
3. `ralph-loop.sh:219-223` is a stub — no integrator phases at all
4. `ralph-val`, `ralph-pr`, `ralph-merge` lack `list_issues` in `allowed-tools` (verified via inspection); no "If no issue number" branch — loop cannot invoke them argument-less
5. No `ralph-code-review` skill exists (verified: `ls plugin/ralph-hero/skills/ralph-code-review` returns nothing)
6. `ralph-merge` has no `RALPH_AUTO_MERGE` gate

## Desired End State

The loop runs fully autonomously with this phase sequence (default behavior of `just loop`):

```
hygiene → triage → split → research → plan → review → impl → val → pr → code-review → [merge]
         ╰─── analyst ───╯  ╰── builder ──╯  ╰─────── integrator ────────╯
```

Default: issues end at "In Review" with a code-reviewed PR. `just loop auto-merge=true` additionally merges approved PRs with passing CI.

### Verification

- [x] Phase 1: `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-triage/SKILL.md` ≥ 1
- [x] Phase 1: `grep 'REVIEW_MODE.*:-' plugin/ralph-hero/scripts/ralph-loop.sh` shows `auto`
- [x] Phase 1: `just triage` on empty backlog outputs `"Queue empty"`
- [x] Phase 1: `just loop --triage-only` on empty backlog exits after 1 iteration
- [x] Phase 2: `just val`/`pr`/`merge` (no args) on empty queues each output `"Queue empty"`
- [x] Phase 3: `test -f plugin/ralph-hero/skills/ralph-code-review/SKILL.md`
- [x] Phase 3: `npx vitest run src/__tests__/state-resolution.test.ts` passes (consistency test)
- [ ] Phase 3: `just code-review NNN` on a PR with comments runs review and reports
- [ ] Phase 4: `just loop --integrator-only` on an "In Progress" issue runs val → pr → code-review
- [ ] Phase 4: `RALPH_AUTO_MERGE=true just merge NNN` with passing CI + approved review merges; with failing CI prints `"AUTO-MERGE BLOCKED"`
- [ ] End-to-end: `just loop` (no args) runs full pipeline through code review with default `review=auto`

## What We're NOT Doing

- No budget aggregation across the loop (per-task budget remains)
- No postmortem generation at loop completion (exists as a skill, wire later)
- No parallel ticket processing within a single phase
- No GitHub Actions changes (relies on existing CI via `gh pr checks`)
- No changes to the `hero` orchestrator or `finish` skill — this plan targets `ralph-loop.sh` and integrator skills only
- No new MCP server tools
- No changes to the `ralph-hygiene` queue-empty contract (intentionally exempt)

## Implementation Approach

Each phase ships as one atomic commit set on `main` and unblocks the next:

- **Phase 1** (`#1015`): One-line edits across 4 files — pure text/config change. No new logic, no new files.
- **Phase 2** (`#1016`): Add `list_issues` tool + a "If no issue number" branch to 3 existing skills, mirroring `ralph-impl` Step 1's structure. Update 3 corresponding agent files.
- **Phase 3** (`#1017`): Net new skill + agent + JSON state-machine entry + TS state-resolution entry + command-contracts entry + justfile recipe.
- **Phase 4** (`#1018`): Loop script extension (flag parsing, banner, integrator block) + 3 new justfile recipes + autonomous merge gate insert in `ralph-merge`.

**Phase dependency annotations** — These are sequential by hard contract: each phase's automated verification depends on the previous phase's changes being on `main`. The loop's queue-empty grep must be widened (Phase 1) before the new "Queue empty" outputs in Phases 2–4 are reliably detected. Phase 4 wires the skills/agents created in Phases 2 and 3 into the loop.

---

## Phase 1: Fix Loop Fundamentals (GH-1015)

- **depends_on**: null

### Overview
Standardize queue-empty output, change review/budget defaults, and broaden the loop's queue-empty grep to be a safety net for legacy text. Pure text/config edits — no logic changes.

### Tasks

#### Task 1.1: Standardize ralph-triage queue-empty output
- **files**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Line ~91 changed from `No untriaged issues in Backlog. Triage complete.` to `No untriaged issues in Backlog. Queue empty.`
  - [x] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-triage/SKILL.md` returns ≥ 1
  - [x] No other occurrences of `"Triage complete"` left in the skill body (legacy phrasing fully replaced)

#### Task 1.2: Switch ralph-loop.sh review default and update usage banner
- **files**: `plugin/ralph-hero/scripts/ralph-loop.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Line 54 changed: `REVIEW_MODE="${RALPH_REVIEW_MODE:-auto}"` (was `interactive`)
  - [x] Usage comment at line 13 reflects new default: `"--review=auto        Opus critiques plan automatically (default)"`
  - [x] `grep 'REVIEW_MODE.*:-' plugin/ralph-hero/scripts/ralph-loop.sh` shows `auto`, not `interactive`
  - [x] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` (syntax check) passes

#### Task 1.3: Broaden run_claude queue-empty grep to safety-net pattern
- **files**: `plugin/ralph-hero/scripts/ralph-loop.sh` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] Line 128 changed from `grep -qi "Queue empty"` to `grep -qiE "Queue empty|Triage complete"`
  - [x] `grep -E 'Queue empty\|Triage complete' plugin/ralph-hero/scripts/ralph-loop.sh` matches the safety-net pattern
  - [x] Smoke test: `echo "No untriaged issues in Backlog. Queue empty." | grep -qiE "Queue empty|Triage complete"` exits 0
  - [x] Smoke test: `echo "No substantive issues found" | grep -qiE "Queue empty|Triage complete"` exits non-zero (no false positive on val output)

#### Task 1.4: Sync justfile loop recipe defaults
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Line 205 changed from `loop mode="all" review="skip" split="auto" hygiene="auto" budget="5.00" timeout="60m":` to `loop mode="all" review="auto" split="auto" hygiene="auto" budget="8.00" timeout="60m":`
  - [x] `grep 'review="auto"' plugin/ralph-hero/justfile` confirms the change
  - [x] `grep 'budget="8.00"' plugin/ralph-hero/justfile` confirms the budget bump
  - [x] `just --list 2>&1 | grep -q "loop"` exits 0 (justfile still parses)

#### Task 1.5: Update docs/cli.md with loop recipe + review defaults
- **files**: `docs/cli.md` (modify or append)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] cli.md contains a section documenting `just loop` with the parameters: `mode`, `review` (default `auto`), `split` (default `auto`), `hygiene` (default `auto`), `budget` (default `"8.00"`), `timeout` (default `"60m"`), and the new `auto-merge` parameter (note its default is `"false"`, expecting Phase 4 to land later)
  - [x] Review-mode defaults section explicitly states: `auto` (default), `interactive`, `skip`
  - [x] `grep -i "review.*auto" docs/cli.md` returns ≥ 1
  - [x] No references to `review="skip"` as default remain in cli.md

### Phase 1 Success Criteria

#### Automated Verification:
- [x] `npm run build --prefix plugin/ralph-hero/mcp-server` — no errors (sanity that no TS broke)
- [x] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` — passes
- [x] All five Task acceptance grep checks pass

#### Manual Verification:
- [x] `just triage` on an empty backlog outputs the literal `"Queue empty"`
- [x] `just loop --triage-only` on an empty backlog exits after 1 iteration (banner shows `Iteration 1 of 10`, then `>>> No work found in any queue. Stopping.`)

**Creates for next phase**: A reliable queue-empty signal for the loop runner. Phases 2–4 will emit `"Queue empty"` from their integrator skills and depend on this grep pattern matching.

---

## Phase 2: Add Queue-Picking to Integrator Skills (GH-1016)

- **depends_on**: [phase-1]

### Overview
Add `list_issues` to the allowed-tools and an "If no issue number" branch to `ralph-val`, `ralph-pr`, and `ralph-merge`. Mirror `ralph-impl` Step 1's queue-picking structure. Patch `val-postcondition.sh` to accept the synthetic verdict so the new queue-empty branch can stop cleanly.

### Tasks

#### Task 2.1: Patch val-postcondition.sh to accept queue-empty verdict
- **files**: `plugin/ralph-hero/hooks/scripts/val-postcondition.sh` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] The hook accepts as terminal: `VALIDATION PASS`, `VALIDATION FAIL`, OR `Queue empty` (any one of the three present in the transcript)
  - [x] If none of the three are present, hook still exits 2 with the existing message
  - [x] Test (smoke): `echo '{"transcript_path":"/dev/null","stop_hook_active":false}' | bash plugin/ralph-hero/hooks/scripts/val-postcondition.sh` exits 2 (no verdict in input)
  - [x] No removal of the existing `STOP_HOOK_ACTIVE` early-return branch

#### Task 2.2: Add queue-picking to ralph-val
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [x] `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues` added to `allowed-tools` frontmatter
  - [x] Step 1 has a new "**If no issue number**" subsection that: queries `list_issues(workflowState: "In Progress", limit: 10)`, iterates candidates, checks `worktrees/GH-NNN` directory exists (relative to git root), picks the first match
  - [x] If no eligible issues, the skill outputs both: `VALIDATION PASS — no work` AND `Queue empty.` then STOPs (so val-postcondition is satisfied AND the loop's grep matches)
  - [x] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥ 1
  - [x] `grep -c "If no issue number" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥ 1
  - [x] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥ 1

#### Task 2.3: Add queue-picking to ralph-pr
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues` added to `allowed-tools` frontmatter
  - [x] Step 1 has a new "**If no issue number**" subsection that: queries `list_issues(workflowState: "In Progress", limit: 10)`, iterates candidates, checks worktree exists AND `gh pr list --head feature/GH-NNN --json number --jq '.[0]'` is null, picks the first match
  - [x] If no eligible issues, outputs `Queue empty.` then STOPs
  - [x] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥ 1
  - [x] `grep -c "If no issue number" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥ 1
  - [x] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥ 1

#### Task 2.4: Add queue-picking to ralph-merge
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues` added to `allowed-tools` frontmatter
  - [x] Step 1 has a new "**If no issue number**" subsection that: queries `list_issues(workflowState: "In Review", limit: 10)`, iterates candidates, finds an open PR via `gh pr list --head feature/GH-NNN --json number,state --jq '.[0]'`, picks the first match
  - [x] If no eligible issues, outputs `Queue empty.` then STOPs
  - [x] `grep -c "Queue empty" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥ 1
  - [x] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥ 1

#### Task 2.5: Add list_issues to integrator agents
- **files**: `plugin/ralph-hero/agents/val-agent.md` (modify), `plugin/ralph-hero/agents/pr-agent.md` (modify), `plugin/ralph-hero/agents/merge-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues` appears in the `tools:` field of each of the three agent files
  - [x] `grep -c "list_issues" plugin/ralph-hero/agents/val-agent.md` returns ≥ 1
  - [x] `grep -c "list_issues" plugin/ralph-hero/agents/pr-agent.md` returns ≥ 1
  - [x] `grep -c "list_issues" plugin/ralph-hero/agents/merge-agent.md` returns ≥ 1
  - [x] No accidental tool-list reordering or removal — the only diff per file is adding the new tool

### Phase 2 Success Criteria

#### Automated Verification:
- [x] All five Task acceptance grep checks pass
- [x] `npm run build --prefix plugin/ralph-hero/mcp-server` — no errors
- [x] `npm test --prefix plugin/ralph-hero/mcp-server` — passes (no regressions)

#### Manual Verification:
- [ ] `just val` (no args) with no "In Progress" issues → outputs both `VALIDATION PASS — no work` AND `Queue empty`
- [ ] `just pr` (no args) with no eligible issues → outputs `Queue empty`
- [ ] `just merge` (no args) with no "In Review" issues → outputs `Queue empty`

**Creates for next phase**: Self-selecting integrator skills the loop can invoke without arguments. Phase 3 will replicate this pattern in the new `ralph-code-review` skill. Phase 4 will wire all of them into the loop.

---

## Phase 3: New ralph-code-review Skill + Agent + State Machine (GH-1017)

- **depends_on**: [phase-2]

### Overview
Create a standalone `ralph-code-review` skill that picks an "In Review" issue with an open PR, runs `code-review:code-review`, addresses feedback via `ralph-impl` address mode, and loops up to 3 rounds before escalating to "Human Needed". Includes the matching agent definition, state-machine + state-resolution + command-contracts registration, and a justfile recipe.

### Tasks

#### Task 3.1: Register ralph_code_review in state-resolution.ts
- **files**: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Add `ralph_code_review: ["In Review", "Human Needed"]` to `COMMAND_ALLOWED_STATES` (after `ralph_merge` entry)
  - [x] No changes to `SEMANTIC_INTENTS` (the `__ESCALATE__` wildcard `"*": "Human Needed"` already covers escalation)
  - [x] `grep -c "ralph_code_review" plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` returns ≥ 1
  - [x] `npm run build --prefix plugin/ralph-hero/mcp-server` — no TypeScript errors

#### Task 3.2: Register ralph_code_review in state-machine JSON
- **files**: `plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [x] Add a `commands.ralph_code_review` block with: `description`, `valid_input_states: ["In Review"]`, `valid_output_states: ["In Review", "Human Needed"]`, plus `preconditions`/`postconditions` arrays following the structure of the `ralph_merge` block
  - [x] `grep -c "ralph_code_review" plugin/ralph-hero/hooks/scripts/ralph-state-machine.json` returns ≥ 1
  - [x] JSON validates: `node -e "JSON.parse(require('fs').readFileSync('plugin/ralph-hero/hooks/scripts/ralph-state-machine.json','utf8'))"` exits 0
  - [x] `npx vitest run plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` — both consistency tests at 317 and 347 pass (TS hardcoded entry matches JSON)

#### Task 3.3: Register ralph_code_review in command contracts
- **files**: `plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [x] Add a `ralph_code_review` entry following the structure of the `ralph_merge` and `ralph_impl` entries already present
  - [x] Entry includes: `description`, `valid_input_states`, `valid_output_states`, `preconditions`, `postconditions`
  - [x] `grep -c "ralph_code_review" plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json` returns ≥ 1
  - [x] JSON validates: `node -e "JSON.parse(require('fs').readFileSync('plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json','utf8'))"` exits 0

#### Task 3.4: Create ralph-code-review skill file
- **files**: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` (create)
- **tdd**: false
- **complexity**: high
- **depends_on**: [3.3]
- **acceptance**:
  - [x] File created at the path
  - [x] Frontmatter includes: `description`, `user-invocable: false`, `argument-hint: [optional-issue-number]`, `context: fork`, `model: sonnet`
  - [x] Frontmatter `hooks.SessionStart` runs `set-skill-env.sh RALPH_COMMAND=code-review`
  - [x] `allowed-tools` includes: `Read, Glob, Grep, Bash, Agent, Skill, get_issue, list_issues, save_issue, create_comment` (full MCP tool names)
  - [x] Body has 7 numbered Steps: Select Issue, Find PR, Check Existing Review State, Run Code Review, Address Feedback (Fix Loop), Re-Review (Loop), Report Result
  - [x] Step 1 implements queue-picking pattern: if no issue number, list "In Review" issues, output `"Queue empty."` and STOP if none
  - [x] Step 4 invokes `Skill("code-review:code-review", "PR_NUMBER")` (positional, matches `ralph-merge:123`)
  - [x] Step 4 records `BEFORE_COUNT = gh pr view ... --json comments --jq '.comments | length'` and re-checks `AFTER_COUNT` after the review; outputs `"Code review clean — no issues found"` and STOPs if equal
  - [x] Step 5 dispatches `Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for issue #NNN...")`
  - [x] Step 6 enforces `MAX_ROUNDS = 3`; on exhaustion, calls `save_issue(workflowState="Human Needed", command="ralph_code_review")` and posts a `## Code Review` comment, then STOPs
  - [x] Skill body documents the budget-vs-rounds reconciliation: explicit cap at 3 rounds with `DEFAULT_BUDGET=8.00` (matches recipe). Note that 3 rounds may exhaust the budget; on budget exhaustion the skill exits cleanly. The 3-round cap is enforced at the loop level in the skill (counter + max), not at the budget level.
  - [x] Skill body documents: `code-review-agent` does NOT need Write/Edit (delegates writes to nested `impl-agent`)
  - [x] `grep -c "list_issues" plugin/ralph-hero/skills/ralph-code-review/SKILL.md` returns ≥ 1
  - [x] Frontmatter contains `context: fork` and `user-invocable: false` (verified: `grep -c "context: fork" SKILL.md` ≥ 1 and `grep -c "user-invocable: false" SKILL.md` ≥ 1)

#### Task 3.5: Create code-review-agent file
- **files**: `plugin/ralph-hero/agents/code-review-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.4]
- **acceptance**:
  - [x] File created at the path
  - [x] Frontmatter: `name: code-review-agent`, `description: ...`, `model: sonnet`
  - [x] `tools:` field is comma-separated: `Read, Glob, Grep, Bash, Agent, Skill, mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues, mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue, mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`
  - [x] `skills:` field includes `- ralph-hero:ralph-code-review`
  - [x] Body is one short paragraph instructing the agent to follow the preloaded skill (matches pattern of `val-agent.md`, `pr-agent.md`)
  - [x] `grep -c "list_issues" plugin/ralph-hero/agents/code-review-agent.md` returns ≥ 1
  - [x] No Write/Edit in `tools:` (intentional — nested impl-agent does writes)

#### Task 3.6: Add code-review recipe to justfile
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.5]
- **acceptance**:
  - [x] New recipe added after the `review` recipe (around line 138)
  - [x] Recipe uses `[group('workflow')]`, `dispatch "ralph-code-review" "$@"`, `DEFAULT_BUDGET=8.00 DEFAULT_TIMEOUT=30m`
  - [x] Recipe shape matches `review` recipe (sources `cli-dispatch.sh`, parses args, calls `dispatch`)
  - [x] `grep -c "code-review" plugin/ralph-hero/justfile` returns ≥ 1
  - [x] `just --list 2>&1 | grep -q "code-review"` exits 0

### Phase 3 Success Criteria

#### Automated Verification:
- [x] `test -f plugin/ralph-hero/skills/ralph-code-review/SKILL.md` exits 0
- [x] `test -f plugin/ralph-hero/agents/code-review-agent.md` exits 0
- [x] `npm run build --prefix plugin/ralph-hero/mcp-server` — no errors
- [x] `npx vitest run plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` — passes (consistency test at line 347)
- [x] `npm test --prefix plugin/ralph-hero/mcp-server` — full suite passes
- [x] All Task acceptance grep checks pass
- [x] Both JSON files validate (state-machine + command-contracts)

#### Manual Verification:
- [ ] `just code-review NNN` on an issue with an open PR runs review and reports
- [ ] If review finds issues, `impl-agent` enters address mode and pushes fixes
- [ ] If review is clean, skill reports `"Code review clean"` and stops
- [ ] After 3 failed rounds, the issue moves to `"Human Needed"` and a `## Code Review` comment is posted

**Creates for next phase**: A standalone `ralph-code-review` skill, agent, and justfile recipe ready for the loop to invoke. Phase 4 will add the loop's code-review phase block.

---

## Phase 4: Wire Integrator Phases Into Loop + Autonomous Merge Gate (GH-1018)

- **depends_on**: [phase-3]

### Overview
Extend `ralph-loop.sh` with the four integrator phases (val → pr → code-review → merge), add the `--auto-merge` flag, register the new `--*-only` modes, add corresponding justfile recipes (`val`, `pr`, `merge`), and insert a new Step 4a in `ralph-merge` for the autonomous merge gate.

### Tasks

#### Task 4.1: Add auto-merge flag and banner to ralph-loop.sh
- **files**: `plugin/ralph-hero/scripts/ralph-loop.sh` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] After line 56 (init block), add `AUTO_MERGE="${RALPH_AUTO_MERGE:-false}"`
  - [ ] In the for-arg loop (around line 76), add a `--auto-merge)` case that sets `AUTO_MERGE="true"`
  - [ ] After the loop, add `export RALPH_AUTO_MERGE="$AUTO_MERGE"`
  - [ ] In the banner (around line 95), add `echo "Auto-merge: $AUTO_MERGE"`
  - [ ] `grep -c "auto-merge\|AUTO_MERGE" plugin/ralph-hero/scripts/ralph-loop.sh` returns ≥ 4 (init + flag parse + export + banner)
  - [ ] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` passes

#### Task 4.2: Add new --*-only modes to ralph-loop.sh case
- **files**: `plugin/ralph-hero/scripts/ralph-loop.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] The mode case statement (around line 71) extended to include: `--val-only|--pr-only|--code-review-only|--merge-only`
  - [ ] `grep -E "val-only.*pr-only.*code-review-only.*merge-only" plugin/ralph-hero/scripts/ralph-loop.sh` matches (all four on one alternation line)
  - [ ] Existing `--analyst-only|--builder-only|--integrator-only` still in the case
  - [ ] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` passes

#### Task 4.3: Replace integrator stub with four phase blocks
- **files**: `plugin/ralph-hero/scripts/ralph-loop.sh` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [4.2]
- **acceptance**:
  - [ ] Lines 219-223 (current stub `# Future: run_claude...`) replaced with four `if [ "$MODE" = ... ]` blocks: val, pr, code-review, merge
  - [ ] Each non-merge block guarded by: `[ "$MODE" = "all" ] || [ "$MODE" = "--<phase>-only" ] || [ "$MODE" = "--integrator-only" ]`
  - [ ] Merge block additionally guarded by `[ "$AUTO_MERGE" = "true" ]` so `just loop --merge-only` without auto-merge is a no-op
  - [ ] When `MODE=--merge-only` and `AUTO_MERGE=false`, an explicit warning is echoed (e.g., `"--merge-only requires --auto-merge or auto-merge=true; skipping merge phase"`) — not silent
  - [ ] Each phase calls `run_claude "/ralph-hero:ralph-<phase>" "<phase-name>"` and sets `work_done=true` on success
  - [ ] `grep -c "ralph-val\|ralph-pr\|ralph-code-review\|ralph-merge" plugin/ralph-hero/scripts/ralph-loop.sh` returns ≥ 4
  - [ ] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` passes

#### Task 4.4: Update justfile loop recipe with auto-merge parameter
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] `loop` recipe signature gains an `auto-merge="false"` parameter (last position)
  - [ ] Recipe body conditionally appends `--auto-merge` to args when `{{auto-merge}}` is `"true"`
  - [ ] `grep -c "auto-merge" plugin/ralph-hero/justfile` returns ≥ 2 (parameter + conditional)
  - [ ] `just --list 2>&1 | grep -q "loop"` exits 0
  - [ ] Backwards compat: invoking `just loop` (no args) still works (auto-merge defaults to `"false"`)

#### Task 4.5: Add val, pr, merge justfile recipes
- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Three new recipes added after the `impl` recipe (around line 150): `val`, `pr`, `merge`
  - [ ] Each follows the `dispatch "ralph-<name>"` shape used by other workflow recipes
  - [ ] Each uses `DEFAULT_BUDGET=1.00 DEFAULT_TIMEOUT=10m`
  - [ ] `[group('workflow')]` annotation on each
  - [ ] `just --list 2>&1 | grep -cE "val|pr|merge|code-review"` returns ≥ 4 (val + pr + merge + code-review from Phase 3)
  - [ ] `just --list 2>&1 | grep -q "val "` exits 0 (recipe parses)

#### Task 4.6: Insert Step 4a Autonomous Merge Gate in ralph-merge
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New Step 4a section inserted between existing Step 4 (Code Review Gate, line ~190) and Step 5 (Check PR Readiness)
  - [ ] Section header: `## Step 4a: Autonomous Merge Gate`
  - [ ] Body documents: only runs when `RALPH_AUTO_MERGE=true`; otherwise skipped entirely
  - [ ] Documents commands: `gh pr view PR_NUMBER --json reviewDecision --jq '.reviewDecision'` and `gh pr checks PR_NUMBER --json name,state,conclusion`
  - [ ] Documents merge criteria (ALL must be true): reviewDecision is APPROVED OR no review comments on XS issue; all CI `state: completed` AND `conclusion: success`; PR `OPEN` and `mergeable: MERGEABLE`
  - [ ] On miss, outputs `AUTO-MERGE BLOCKED` block with `Issue:`, `PR:`, `Review:`, `CI:`, `Reason:` fields, then STOPs
  - [ ] On pass, proceeds to Step 5 (existing flow)
  - [ ] `grep -c "RALPH_AUTO_MERGE" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥ 2
  - [ ] `grep -c "AUTO-MERGE BLOCKED" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥ 1
  - [ ] `grep -c "gh pr checks" plugin/ralph-hero/skills/ralph-merge/SKILL.md` returns ≥ 1
  - [ ] No frontmatter changes (RALPH_AUTO_MERGE is read from env at runtime)

### Phase 4 Success Criteria

#### Automated Verification:
- [ ] All six Task acceptance grep checks pass
- [ ] `bash -n plugin/ralph-hero/scripts/ralph-loop.sh` passes
- [ ] `just --list 2>&1 | grep -cE "val|pr|merge|code-review"` returns ≥ 4
- [ ] `npm run build --prefix plugin/ralph-hero/mcp-server` — no errors
- [ ] `npm test --prefix plugin/ralph-hero/mcp-server` — passes (no regressions)

#### Manual Verification:
- [ ] `just loop --integrator-only` on an "In Progress" issue with completed impl runs val → pr → code-review (no merge without auto-merge)
- [ ] `just loop --merge-only` (no auto-merge) prints the explicit warning then exits cleanly (not silent)
- [ ] `RALPH_AUTO_MERGE=true just merge NNN` on a PR with passing CI + approved review merges and moves issue to Done
- [ ] `RALPH_AUTO_MERGE=true just merge NNN` on a PR with failing CI prints `AUTO-MERGE BLOCKED` and stops
- [ ] `just merge NNN` (no auto-merge) presents AskUserQuestion (backwards compatible)
- [ ] `just loop` (no args) runs full pipeline through code review with default `review=auto`
- [ ] `just loop auto-merge=true` additionally merges approved PRs with passing CI
- [ ] `just loop --review=skip` still works (backwards compatible)

**Creates for next phase**: End-to-end autonomous loop. No further phases — this is the terminal phase.

---

## Integration Testing

- [ ] Run end-to-end on a fresh test issue (Backlog → ... → Done) per the Testing Strategy in the parent plan
- [ ] Verify all `just loop --<phase>-only` modes work standalone
- [ ] Regression: `just loop --review=interactive` and `just loop --review=skip` still work
- [ ] Regression: `just merge NNN` standalone (no auto-merge env) presents AskUserQuestion
- [ ] Regression: `just loop --triage-only` on empty backlog exits after 1 iteration

## References

- Parent plan: [thoughts/shared/plans/2026-04-03-GH-0731-complete-autonomous-loop.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-03-GH-0731-complete-autonomous-loop.md)
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/731
- Children:
  - https://github.com/cdubiel08/ralph-hero/issues/1015 (Phase 1)
  - https://github.com/cdubiel08/ralph-hero/issues/1016 (Phase 2)
  - https://github.com/cdubiel08/ralph-hero/issues/1017 (Phase 3)
  - https://github.com/cdubiel08/ralph-hero/issues/1018 (Phase 4)
- Related research:
  - thoughts/shared/research/2026-02-18-GH-0069-move-pr-creation-to-integrator.md
  - thoughts/shared/research/2026-02-19-GH-0116-integrate-hygiene-check-ralph-loop.md
  - thoughts/shared/research/2026-02-21-GH-0294-early-exit-empty-work-ralph-loop.md
- Pattern reference for queue-picking: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` Step 1
- State-machine consistency test: `plugin/ralph-hero/mcp-server/src/__tests__/state-resolution.test.ts` lines 316-381
- Existing autonomous review path (preserved): `plugin/ralph-hero/skills/ralph-merge/SKILL.md` Step 4 (PR #757)
- Code review plugin: `~/.claude/plugins/cache/claude-plugins-official/code-review/unknown/commands/code-review.md`
