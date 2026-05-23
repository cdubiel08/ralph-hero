---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, review, val, code-review, merge, finish, migration, plan-of-plans]
github_issue: 1368
github_issues: [1368]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1368
primary_issue: 1368
---

# Plan 6: `/ralph:review` — Review Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: [[2026-05-23-GH-1357-ralph-plan-1-catch-up]] — scaffold + flat-sibling pattern
- builds_on:: [[2026-05-23-GH-1359-ralph-plan-2-form]] — multi-surface fold heuristics
- builds_on:: [[2026-05-23-GH-1362-ralph-plan-3-research]] — SKILL.md frontmatter `hooks:` pattern + slim-plugin hook scope fixes
- builds_on:: [[2026-05-23-GH-1364-ralph-plan-4-plan]] — multi-mode fold (5 modes, 6 references) + path-discrimination hook pattern + multi-RALPH_COMMAND lesson
- builds_on:: [[2026-05-23-GH-1366-ralph-plan-5-impl]] — 9-hook ceiling + mode-driven-from-tool-input pattern + `## Scout Trigger` advisory contract

## Overview

The closing gate. Four `ralph-hero` skills (`ralph-val`, `ralph-code-review`, `ralph-merge`, `finish`) collapse into one `/ralph:review` verb with four modes:

| Mode | Source | Role |
|---|---|---|
| (default) | `finish` | Full close-out: val → code-review → merge → CI watch. Owns the depth-0 fan-out for the `code-review:code-review` parallel-reviewer pattern. |
| `--mode val [#NNN]` | `ralph-val` | Validate impl against plan — citation gate, drift log, cross-phase integration. Pre-PR or pre-merge gate. |
| `--mode code [#NNN]` | `ralph-code-review` | Run code-review skill, address feedback, loop up to 3 rounds, escalate to Human Needed. |
| `--mode merge [#NNN]` | `ralph-merge` | Merge-only mechanics: PR readiness check, merge, worktree cleanup, Done transition, parent advancement, cross-repo unblock. Refuses unreviewed PRs. |

Distinct from Plan 4's `--mode review` which is **plan-doc review** (critique a plan before impl). Plan 6's `/ralph:review` is **code-and-merge review** — the after-impl close-the-loop verb.

Plan 5's friction-log noted two follow-ups that land here:

1. **Plan 5's default-mode Step 6 picker dispatches `Skill("ralph-hero:finish", args="NNN")`** until Plan 6 ships. One-line edit in `ralph/skills/impl/SKILL.md` to retarget `Skill("ralph:review", args="NNN")`.
2. **The `## Scout Report` verdict contract** — Plan 5 wired the `## Scout Trigger` advisory in pr-mode; Plan 6's merge-gate must observe `## Scout Report` verdicts as a pre-merge condition.

Plan 5 established the "≤9 hooks" ceiling and the "mode-discriminated-by-tool-input" pattern. Plan 6 inherits both: the four modes share substrate (PR readiness, state transitions, terminal verdicts) but have distinct workflow bodies. The hook surface stays narrow at **3 mode-shared hooks + 2 reuses** because most gate logic is already enforced upstream (impl-state-gate covers the In Progress side; pr-state-gate covers the transition to In Review).

## Current State Analysis

Four source skills total **1,585 lines** of SKILL.md prose:

| Source | Lines | Shape |
|---|---|---|
| `plugin/ralph-hero/skills/ralph-val/SKILL.md` | 527 | Fetch issue → find plan + worktree → extract Automated Verification criteria → run checks (with Citation Gate) → drift-log verification → cross-phase integration → optional delegated classification → emit `VALIDATION PASS / VALIDATION FIX / VALIDATION FAIL` |
| `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` | 286 | Select issue → find open PR → check existing review decision → `Skill("code-review:code-review", PR#)` with before/after comment count → if new comments: dispatch impl-agent Address Mode → loop up to 3 rounds → escalate via `__ESCALATE__` → "Human Needed" |
| `plugin/ralph-hero/skills/ralph-merge/SKILL.md` | 431 | PR readiness check (review decision required) → merge via `scripts/merge-pr.sh` → worktree cleanup → `__DONE__` transition → parent auto-advance → cross-repo unblock → post `## Merged` comment + `knowledge_record_outcome` |
| `plugin/ralph-hero/skills/finish/SKILL.md` | 341 | Orchestrator: parse args → fetch issue + find PR → dispatch `val-agent` → Code Review Gate (`finish-review-verdict.sh` → `APPROVED` / `NEEDS_FIX` / `BLOCKED`) → fix cycle (1 max) → dispatch `merge-agent` → `Monitor` CI watch → final `FINISHED` report |

Hooks to consider porting (under `plugin/ralph-hero/hooks/scripts/`):

| Hook | Trigger | Job | Port |
|---|---|---|---|
| `merge-state-gate.sh` | PreToolUse on `save_issue`/`advance_issue` | Validate merge-mode transitions (only Done / Human Needed allowed; refuses In Progress / In Review backwards) | yes |
| `val-postcondition.sh` | Stop | Verify terminal verdict emitted (`VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL`, `Queue empty.`) | yes |
| `finish-review-verdict.sh` | (helper, not a hook) | Returns `APPROVED` / `NEEDS_FIX` / `BLOCKED` / `ERROR:` from `gh pr view --json reviewDecision,reviews` | yes (copy to `ralph/hooks/scripts/`) |
| `lock-release-on-failure.sh` | Stop | Release workflow lock on failure | already ported in Plan 3 |
| `doc-structure-validator.sh` | Stop | Validate doc sections per command type | already ported in Plan 3; review mode no-ops (no artifact dir for review) |

New hooks Plan 6 needs:

| Hook | Trigger | Job |
|---|---|---|
| `closeout-postcondition.sh` | Stop | Mode-discriminated terminal-verdict gate. Verifies one of: `VALIDATION PASS\|FIX\|FAIL` (val-mode), `CODE REVIEW PASSED\|ESCALATED\|BLOCKED` (code-mode), `MERGED\|MERGE BLOCKED\|MERGE NOT READY` (merge-mode), or `FINISHED\|FINISH BLOCKED` (default mode). Named `closeout-` to avoid collision with Plan 4's `review-postcondition.sh` (plan-doc review). |
| `closeout-scout-gate.sh` | PreToolUse on Bash matching `merge-pr.sh` / `gh pr merge` | When the PR has a `## Scout Trigger` comment posted (issued by `/ralph:impl --mode pr`), verify a `## Scout Report` reply exists with verdict `PASS` or `WARN`. Block merge with exit 2 if `FAIL`. Advisory-by-design: missing report passes (matches the existing scout-trigger contract). |

Three hook ports + two reuses + one helper-script port + one new hook = **5 hooks under the ≤9 ceiling** (`merge-state-gate.sh`, `val-postcondition.sh`, `closeout-postcondition.sh`, `closeout-scout-gate.sh`, plus the already-ported `lock-release-on-failure.sh` and `doc-structure-validator.sh` reuses).

### Key Discoveries

- **Four modes, two execution shapes.** `--mode val` and `--mode code` are *inspect-and-judge* — they read PR/worktree state and emit a verdict. `--mode merge` is *act-and-confirm* — it mutates GitHub state (merge PR, transition issue, advance parent). `default` is *orchestrate* — it dispatches the other three via `Skill()` / `Agent()` and threads verdicts through. The reference split tracks this: `plan-vs-impl-rubric.md` and `code-review-prompt.md` own inspect-and-judge opinion; `merge-gate.md` owns act-and-confirm; `auto-vs-interactive.md` owns orchestration.
- **Default-mode preserves the depth-0 fan-out for `code-review:code-review`.** The `code-review:code-review` plugin spawns 5 parallel Sonnet reviewers + N parallel Haiku scorers via the `Agent` tool. Those parallel agents land at depth 1 only when the wrapping skill runs at depth 0 — so `code-review:code-review` MUST be invoked inline (via `Skill()`) from `/ralph:review`'s default mode, not via a sub-agent dispatch. The runtime's no-depth-2-Agent rule would silently break parallel reviewers if violated. SKILL.md body comment + `auto-vs-interactive.md` §Depth-0 fan-out section preserves the contract.
- **`RALPH_REVIEW_MODE=auto|interactive` is the orchestration switch, not a verb mode.** It governs whether default-mode prompts via `AskUserQuestion` when the code-review gate returns `BLOCKED` (multi-author PR with no formal review and no self-authored fallback). Preserved verbatim in `auto-vs-interactive.md`. Distinct from `--mode val|code|merge` which selects a leaf verb.
- **Citation Gate (val-mode) is load-bearing.** Per `ralph-val/SKILL.md:163-201`, the val-mode body MUST quote the offending file lines before claiming a file-content failure. Inferring failures from plan text alone is forbidden. Preserve verbatim in `plan-vs-impl-rubric.md` §Citation Gate. The hook can't enforce this (it's per-check reasoning) so the prose carries the constraint.
- **`val-postcondition.sh` accepts three terminal tokens**: `VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL`. Plus `Queue empty.` for the no-work path. The val-mode body MUST emit one of these as the FIRST line of the verdict block. `closeout-postcondition.sh` extends the contract to cover code-mode and merge-mode terminals.
- **Code-review escalation posts TWO comments**: a `## Code Review` round-by-round summary AND a canonical `## Escalation` comment (which `ralph-unblock` / `/ralph-hero:unblock` discovers by header prefix and parses `Originating command:`). Both comments are load-bearing for the unblock chain. Preserve verbatim in `code-review-prompt.md` §Escalation Protocol.
- **Merge-mode refuses unreviewed PRs.** `ralph-merge/SKILL.md:40` — "Standalone callers that invoke this skill on an unreviewed PR will be rejected with `MERGE BLOCKED — review required`". The check uses `gh pr view PR_NUMBER --json reviewDecision` and rejects when `null` / `REVIEW_REQUIRED`. Preserve verbatim in `merge-gate.md` §Pre-merge gates. This is the safety net when default-mode is skipped — the gate ALWAYS runs, regardless of orchestrator.
- **`finish` Step 6 CI watch uses `Monitor`, not a polling loop.** Per `finish/SKILL.md:252-316`, the script signature is load-bearing: stdout one-line summary per state transition, terminal verdict line `CI PASSED:` / `CI FAILED:` / `CI SKIPPED:` immediately before exit, 10-min `timeout_ms` for `CI PENDING`. **CRITICAL**: the merge SHA must be substituted into the `command` string literally — Monitor runs in its own subshell and does not inherit `$MERGE_SHA` from prior Bash calls. Preserve in `merge-gate.md` §CI Watch with the substitution warning.
- **Code review fix cycle in default mode is `max 1`.** Per `finish/SKILL.md:201-233`, if `NEEDS_FIX` returns again after one impl-agent fix cycle, emit `FINISH BLOCKED — Code review feedback unresolved after 1 fix cycle` and stop. Distinct from `--mode code` which loops up to 3 rounds before escalating. Preserve both contracts: 1 cycle in default mode (orchestrator does not loop the leaf); 3 rounds in `--mode code` (the leaf owns its own loop).
- **`ralph-merge` queue-pick (no args) skips PRs without a review decision.** Step 1 picks the first "In Review" candidate whose PR is OPEN; downstream Step N's pre-merge gate filters unreviewed. Preserve in `merge-gate.md` §Queue-pick.
- **Parent auto-advance is handled server-side** by the `advance-parent.yml` GitHub Action. `ralph-merge` does NOT advance the parent — it transitions the child to Done and the Action moves the parent when all children are Done. Preserve verbatim in `merge-gate.md` §Parent advancement (one paragraph noting this is GH Actions territory, not skill territory).
- **Cross-repo merge** in `ralph-merge` reads `.ralph-repos.yml` to identify sibling repos that need state advancement on merge of the primary PR. Preserve in `merge-gate.md` §Cross-repo.
- **`knowledge_record_outcome` fires on `merged` and `pr_review_decision`.** ralph-merge records `event_type="pr_merged"` after merge; ralph-code-review records `event_type="pr_review_decision"` after each round. Preserve both calls (already in `allowed-tools` for each leaf).
- **Default-mode Step 6 picker edit owed by Plan 6.** `ralph/skills/impl/SKILL.md` Step 6 currently dispatches `Skill("ralph-hero:finish", args="NNN")`. Update to `Skill("ralph:review", args="NNN")`. One-line edit, Phase 6 of this plan.
- **`## Scout Report` pre-merge gate is new.** Per Plan 5's friction-log: "Plan 6 (`/ralph:review`) merge-gate should observe `## Scout Report` verdicts as a pre-merge condition." Implementation: `closeout-scout-gate.sh` PreToolUse on `Bash` matching the merge command — if `## Scout Trigger` comment exists on the PR, require a `## Scout Report` reply with `PASS` or `WARN`. Block on `FAIL`. Missing report passes (advisory-by-design, matches the scout-trigger contract). Spec the contract in `merge-gate.md` §Scout Report gate.

## Desired End State

After Plan 6 merges:

1. `/ralph:review` is discoverable. With no args → prompts for issue number.
2. `/ralph:review #NNN` → default full close-out (val → code-review → merge → CI watch).
3. `/ralph:review --mode val [#NNN]` → validation only, emits `VALIDATION PASS|FIX|FAIL`.
4. `/ralph:review --mode code [#NNN]` → code-review-and-fix loop (up to 3 rounds).
5. `/ralph:review --mode merge [#NNN]` → merge-only mechanics. Refuses unreviewed PRs.
6. Plan 5's `/ralph:impl` Step 6 picker dispatches `Skill("ralph:review", args="NNN")` (was `Skill("ralph-hero:finish", args="NNN")`).
7. Old `/ralph-hero:finish`, `/ralph-hero:ralph-val`, `/ralph-hero:ralph-code-review`, `/ralph-hero:ralph-merge` remain functional. Sunset is Plan 10.
8. `ralph/skills/review/SKILL.md` ≤ 200 lines (target ~190).
9. Four flat-sibling references: `plan-vs-impl-rubric.md`, `code-review-prompt.md`, `merge-gate.md`, `auto-vs-interactive.md`.
10. SKILL.md frontmatter `hooks:` block declares 3 new hooks (`closeout-postcondition.sh`, `closeout-scout-gate.sh`, plus reused `merge-state-gate.sh`) scoped via `RALPH_COMMAND=review`.
11. `ralph/README.md` migration table → Plan 6 shipped.
12. Friction-log entry appended to spec.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:review`.
- Four real invocations: default close-out, `--mode val`, `--mode code`, `--mode merge`.
- `wc -l ralph/skills/review/SKILL.md` ≤ 200.
- Four reference siblings present, each non-stub.
- Plan 5's `/ralph:impl` next-step picker correctly dispatches `Skill("ralph:review", ...)`.
- Old `/ralph-hero:*` close-out family skills still work.

## What We're NOT Doing

- **Not** absorbing `ralph-review` (the plan-doc critique skill). That was folded into `/ralph:plan --mode review` in Plan 4.
- **Not** changing the `code-review:code-review` plugin or its parallel-agent fan-out. Default-mode preserves the depth-0 invocation contract verbatim.
- **Not** changing the `## Code Review` / `## Escalation` / `## Merged` comment shapes. Keeps the unblock chain and outcome recorder working unchanged.
- **Not** changing the `finish-review-verdict.sh` helper script's stdout contract (`APPROVED|NEEDS_FIX|BLOCKED|ERROR: <msg>`). Hook-greppable.
- **Not** changing the `Monitor` CI-watch script signature in `merge-gate.md`. The terminal-line prefixes (`CI PASSED:` / `CI FAILED:` / `CI SKIPPED:`) are load-bearing.
- **Not** changing the `__ESCALATE__` / `__DONE__` / `__LOCK__` semantic-intent tokens. `state-resolution.ts` mapping is stable.
- **Not** changing the parent auto-advance contract (server-side GH Action; skills do NOT touch the parent).
- **Not** changing the `.ralph-repos.yml` cross-repo registry shape.
- **Not** wiring `/ralph:review` → next action (the user picks; default mode terminates with the `FINISHED` report and stops).
- **Not** sunsetting source skills. Plan 10 batches sunsets.

## Implementation Approach

Six XS-sized phases, mirroring Plan 5's phase density but compressed (Plan 5 had 7 because of the auto-mode-worktree split; Plan 6's leaves all share substrate so worktree concerns stay in `merge-gate.md`):

1. **Scaffold + hook ports** owns: `ralph/skills/review/SKILL.md` stub (frontmatter + mode-dispatch table + Step 0 arg parse), four empty reference stubs, hook ports under `ralph/hooks/scripts/`.
2. **`--mode val` body + plan-vs-impl-rubric.md** owns: SKILL.md val-mode body, `plan-vs-impl-rubric.md` (full).
3. **`--mode code` body + code-review-prompt.md** owns: SKILL.md code-mode body, `code-review-prompt.md` (full).
4. **`--mode merge` body + merge-gate.md** owns: SKILL.md merge-mode body, `merge-gate.md` (full — pre-merge gates, CI watch, parent advancement, cross-repo, Scout Report gate).
5. **Default mode + auto-vs-interactive.md** owns: SKILL.md default-mode body (val → code → merge → CI watch orchestration), `auto-vs-interactive.md` (full — depth-0 fan-out, `RALPH_REVIEW_MODE` handling, fix-cycle bound).
6. **Picker wiring + parity validation + dogfooding** owns: Plan 5 `/ralph:impl` Step 6 picker edit, `ralph/README.md` update, friction-log spec entry, 4-session parity validation.

Only `ralph/skills/review/SKILL.md` is touched in multiple phases — each appends a section. The reference files are single-owner. Plan 5's `/ralph:impl` SKILL.md edit is a single-file change in Phase 6.

## Phase 1: Scaffold + hook ports

### Overview

Stand up directory + frontmatter + reference stubs + three new hook ports (one helper-script port + one new gate + reuse merge-state-gate.sh).

### Changes Required

#### 1. Skill scaffold

`ralph/skills/review/SKILL.md`:

- Description (covers all 4 modes + natural-language trigger phrases — review, validate, code-review, merge, ship, close, finish).
- `argument-hint: "[--mode val|code|merge] [<issue-number>] [--pr-url <url>] [--plan-doc <path>]"`
- `context: inline`, `model: opus` (default mode owns depth-0 fan-out — depth-0 leaf must be top-tier).
- `allowed-tools` union covering all four modes (Read, Glob, Grep, Bash, Skill, Agent, Monitor, AskUserQuestion, PushNotification, plus the MCP tools used in any mode — `get_issue`, `list_issues`, `list_sub_issues`, `list_dependencies`, `save_issue`, `advance_issue`, `create_comment`, `knowledge_record_outcome`).
- `hooks:` block:
  - SessionStart → `set-skill-env.sh RALPH_COMMAND=review RALPH_VALID_OUTPUT_STATES='In Review,Done,Human Needed'` (union of leaf-mode states; per-mode tightening happens inside `closeout-postcondition.sh`).
  - PreToolUse on `save_issue|advance_issue` → `merge-state-gate.sh` (self-gates on tool-input target state — only fires when transitioning to Done).
  - PreToolUse on `Bash` matching `merge-pr.sh|gh pr merge` → `closeout-scout-gate.sh`.
  - Stop → `closeout-postcondition.sh`, `val-postcondition.sh` (val-mode subset), `lock-release-on-failure.sh`, `doc-structure-validator.sh` (no-ops for review-command no-artifact-dir case).
- Body: mode-dispatch table + Step 0 (arg parse).

#### 2. Reference stubs

- `plan-vs-impl-rubric.md`, `code-review-prompt.md`, `merge-gate.md`, `auto-vs-interactive.md` — `_Filled by Phase N._`

#### 3. Hook ports

Copy from `plugin/ralph-hero/hooks/scripts/`:
- `merge-state-gate.sh` (reuse — port verbatim, adapt only the `RALPH_COMMAND` guard to accept `review`).
- `val-postcondition.sh` (reuse — port verbatim, adapt the `RALPH_COMMAND` guard to accept `review` AND mode-discriminate on `RALPH_MODE=val` via tool-input shape; see Plan 4's lesson on no-env-flipping).
- `finish-review-verdict.sh` (helper script, not a hook — port verbatim to `ralph/hooks/scripts/finish-review-verdict.sh`; called by default-mode body).

Create new:
- `closeout-postcondition.sh` (~80 lines). Discriminates on `RALPH_MODE` (set per-mode at the SKILL.md body's mode-dispatch entry) — but per Plan 4's lesson, prefer tool-input-shape discrimination: parse the last 200 lines of the transcript for `VALIDATION (PASS|FIX|FAIL)|CODE REVIEW (PASSED|ESCALATED|BLOCKED)|MERGED|MERGE (BLOCKED|NOT READY)|FINISHED|FINISH BLOCKED` and exit 0 if any match. Exit 2 with a clear stderr message otherwise.
- `closeout-scout-gate.sh` (~40 lines). PreToolUse on `Bash`. Parse `tool_input.command` for `merge-pr.sh` or `gh pr merge`. If no match → exit 0 (not a merge command). Otherwise, fetch the PR's comments (via `gh pr view --json comments`) and check for `## Scout Trigger`. If absent → exit 0 (advisory not requested). If present → search for a `## Scout Report` reply with verdict. `PASS` or `WARN` → exit 0. `FAIL` → exit 2. Missing report → exit 0 (advisory-by-design; matches Scout Trigger contract).

Apply Plan 3's scope-fix pattern: each script gates on `RALPH_COMMAND` / `RALPH_TICKET_ID` env vars and no-ops when they're unset.

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/review/SKILL.md`
- [ ] `[ "$(wc -l < ralph/skills/review/SKILL.md)" -le 200 ]`
- [ ] All four references present.
- [ ] All three new/ported hooks present + executable.
- [ ] `finish-review-verdict.sh` ported and executable.

#### Manual Verification

- [ ] `/reload-plugins` discovers `/ralph:review`.

---

## Phase 2: `--mode val` body + plan-vs-impl-rubric.md

### Overview

The validation leaf. Folds `ralph-val/SKILL.md` (527 lines) into ~50 lines of SKILL.md body + ~150 lines of opinion in the reference.

### Changes Required

#### 1. SKILL.md val-mode body

Compact list — Plan 3-style:

1. **Parse args** — `--mode val [#NNN] [--plan-doc <path>]`. Queue-pick when no `#NNN` (`list_issues(workflowState: "In Progress", limit: 10)`, first candidate with `worktrees/GH-NNN`). STOP with literal `VALIDATION PASS — no work\nQueue empty.` if none match (BOTH lines required for the postcondition hook + loop runner).
2. **Fetch issue + find plan + find worktree** — Artifact Comment Protocol per `plan-vs-impl-rubric.md` §Plan discovery. STOP with `VALIDATION FAIL` if no plan; STOP with `VALIDATION FAIL` if no worktree (NEVER fall back to main — see anti-pattern callout).
3. **Worktree freshness check** — `git fetch origin main && git rev-list --count HEAD..origin/main`; record staleness as substantive failure note (do not auto-rebase).
4. **Extract verification criteria** — parse plan for `## Desired End State` + per-phase `### Success Criteria > #### Automated Verification` checkboxes.
5. **Run checks** — from worktree, per check: file existence / command execution / content check. Apply Citation Gate per `plan-vs-impl-rubric.md` §Citation Gate.
6. **Drift log + cross-phase integration** — per `plan-vs-impl-rubric.md` §Drift Analysis and §Cross-Phase Integration.
7. **Classify verdict** — optional delegation per `plan-vs-impl-rubric.md` §Delegation. Threshold gate (`>=2 checks AND >=1 failure`). Cross-check delegate enum against automated results.
8. **Emit verdict** — `VALIDATION PASS` (all green) / `VALIDATION FIX` (mechanical only — formatting, lint) / `VALIDATION FAIL` (substantive). Post per-phase results as a `## Validation Report` comment via `create_comment`. Record outcome via `knowledge_record_outcome(event_type="validation", verdict, ...)`.

#### 2. `plan-vs-impl-rubric.md`

- §Plan discovery: Artifact Comment Protocol (search comments for `## Implementation Plan` / `## Plan Reference`; fall back to `thoughts/shared/plans/*NNN*`).
- §Worktree-or-fail: hard stop on missing worktree; forbidden anti-pattern callout (verbatim from `ralph-val/SKILL.md:96-115`).
- §Citation Gate: MUST quote offending file lines before claiming content failure. Example correct citation + example anti-pattern (verbatim from `ralph-val/SKILL.md:163-201`).
- §Drift Analysis: parse `## Drift Log — Phase N` comments; verify `DRIFT:` commit messages exist; flag undocumented changes; emit drift summary block.
- §Cross-Phase Integration: per-phase "Creates for next phase" verification; import-path resolution between phase outputs; run plan's `## Integration Testing` section if present. Single-phase plans → skipped.
- §Delegation: opt-in via `RALPH_DELEGATE_ENABLED`. Threshold gate (`>=2 total AND >=1 failed`). 8KB prompt cap with per-check-summary truncation fallback. Strict 3-value enum (`pass|fail|needs-review`) cross-checked against automated results. Wrapper exit codes → native fallback. (Reference `skills/shared/delegation-conventions.md` for the no-mutation rule.)
- §Verdict tokens (strict): `VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL` — these are the only acceptable prefix tokens; `val-postcondition.sh` (the val branch of `closeout-postcondition.sh`) accepts no substitutes.

### Success Criteria

#### Automated Verification

- [ ] `[ "$(wc -l < ralph/skills/review/SKILL.md)" -le 200 ]`
- [ ] `plan-vs-impl-rubric.md` ≥ 100 lines.
- [ ] SKILL.md val-mode body references `VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL`, `Citation Gate`, `Queue empty.`.

#### Manual Verification

- [ ] `/ralph:review --mode val #NNN` against a real "In Progress" issue with a worktree: runs checks, emits verdict, posts report comment.
- [ ] Queue-pick path emits `Queue empty.` when no eligible candidate.

---

## Phase 3: `--mode code` body + code-review-prompt.md

### Overview

The code-review-and-fix loop leaf. Folds `ralph-code-review/SKILL.md` (286 lines) into ~40 lines of SKILL.md body + ~120 lines of opinion in the reference.

### Changes Required

#### 1. SKILL.md code-mode body

Compact list:

1. **Select issue** — arg or queue-pick (`list_issues(workflowState: "In Review", limit: 10)`, first candidate with open PR). STOP with literal `Queue empty.` if none.
2. **Find PR** — `gh pr list --head feature/GH-NNN`. STOP with `CODE REVIEW BLOCKED` if none.
3. **Check existing review state** — per `code-review-prompt.md` §Pre-loop short-circuits: `APPROVED` → STOP clean; human `CHANGES_REQUESTED` → STOP blocked (human owns the resolution).
4. **Run code review (round N of 3)** — per `code-review-prompt.md` §Loop invariants: snapshot `BEFORE_COUNT`, invoke `Skill("code-review:code-review", PR_NUMBER)`, re-query `AFTER_COUNT`. If equal → clean; else proceed to address.
5. **Address feedback** — dispatch `Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for #NNN — Address Mode")`. Wait for return.
6. **Re-review loop** — increment round counter. If `<= MAX_ROUNDS` (3) → return to Step 4. Else escalate per `code-review-prompt.md` §Escalation Protocol (TWO comments: `## Code Review` summary + canonical `## Escalation`; `save_issue(workflowState="__ESCALATE__", command="ralph_code_review")`).
7. **Report** — `CODE REVIEW PASSED` (clean round) / `CODE REVIEW ESCALATED` (3 rounds exhausted). Record outcome via `knowledge_record_outcome(event_type="pr_review_decision", verdict, ...)`.

#### 2. `code-review-prompt.md`

- §Pre-loop short-circuits: `APPROVED` → clean. Human `CHANGES_REQUESTED` → hard block (distinct from skill-driven feedback). `null` / `REVIEW_REQUIRED` → proceed to loop.
- §Loop invariants: `BEFORE_COUNT` / `AFTER_COUNT` via identical `gh pr view --json comments --jq '.comments | length'` command (idempotent before/after pair). Loop counter at `MAX_ROUNDS=3` enforced at the skill (not budget) level.
- §Address Mode dispatch: `Agent(subagent_type="ralph-hero:impl-agent", ...)`. The impl-agent auto-detects Address Mode from `workflowState == "In Review"` AND open PR with comments. Issue stays in "In Review" after fixes (no state mutation by code-mode itself).
- §Escalation Protocol: TWO comments required — `## Code Review` round-by-round summary AND canonical `## Escalation` (the unblock chain discovers by header prefix + parses `Originating command: ralph_code_review`). `save_issue(workflowState="__ESCALATE__", command="ralph_code_review")`.
- §Budget exhaustion behavior: if the wrapper kills the process before 3 rounds complete, the issue stays in "In Review"; the next invocation re-picks from Round 1 (rounds NOT persisted across invocations).
- §Verdict tokens (strict): `CODE REVIEW PASSED`, `CODE REVIEW ESCALATED`, `CODE REVIEW BLOCKED`.

### Success Criteria

#### Automated Verification

- [ ] `code-review-prompt.md` ≥ 80 lines.
- [ ] SKILL.md code-mode body references `MAX_ROUNDS=3`, `__ESCALATE__`, `Originating command: ralph_code_review`.

#### Manual Verification

- [ ] `/ralph:review --mode code #NNN` against a real "In Review" PR with comments: runs review, dispatches address mode, re-runs review, reports clean or escalates after 3 rounds.

---

## Phase 4: `--mode merge` body + merge-gate.md

### Overview

The merge-mechanics leaf. Folds `ralph-merge/SKILL.md` (431 lines) into ~50 lines of SKILL.md body + ~160 lines of opinion in the reference (largest reference — owns pre-merge gates, CI watch, cross-repo, Scout Report gate, parent advancement note).

### Changes Required

#### 1. SKILL.md merge-mode body

Compact list:

1. **Parse args** — `--mode merge [#NNN] [--pr-url <url>]`. Queue-pick when no `#NNN` (`list_issues(workflowState: "In Review", limit: 10)`, first candidate with open PR). STOP with `Queue empty.` if none.
2. **Fetch issue + find PR** — `gh pr list --head feature/GH-NNN` or use `--pr-url`. STOP with `MERGE NOT READY` if not found.
3. **Pre-merge gates** — per `merge-gate.md` §Pre-merge gates:
   - PR review decision required: `gh pr view --json reviewDecision` MUST be `APPROVED`. `null` / `REVIEW_REQUIRED` → `MERGE BLOCKED — review required`. (Refuses unreviewed PRs even when caller skipped default-mode.)
   - PR mergeable: `gh pr view --json mergeable` MUST be `MERGEABLE`. `CONFLICTING` → `MERGE BLOCKED — conflicts`.
   - Scout Report gate: enforced by `closeout-scout-gate.sh` PreToolUse on the merge Bash command (see `merge-gate.md` §Scout Report gate). Body need not duplicate the check.
4. **Merge** — invoke `scripts/merge-pr.sh PR_NUMBER` (verbatim from `ralph-merge`). Capture merge SHA.
5. **Worktree cleanup** — `git worktree remove worktrees/GH-NNN --force` after merge. Cross-repo: remove sibling worktrees per `.ralph-repos.yml`.
6. **Transition issue to Done** — `save_issue(workflowState="__DONE__", command="ralph_merge")`. Group merges: per-child transition.
7. **Cross-repo unblock** — per `merge-gate.md` §Cross-repo: identify sibling repos awaiting this merge; comment / advance per registry `dependency-flow`.
8. **Post artifact comment** — `## Merged` + merge URL + SHA. Record outcome via `knowledge_record_outcome(event_type="pr_merged", ...)`. PushNotification on `RALPH_COS_NTFY_TOPIC` (preserve `ralph-merge` Step 9c verbatim).
9. **Report** — `MERGED / Issue: #NNN / PR: <url> / SHA: <sha>`. Default mode continues to CI watch; merge-mode terminates here.

#### 2. `merge-gate.md`

- §Pre-merge gates: review decision (APPROVED required); mergeable status; Scout Report gate (advisory-by-design — block on FAIL, pass on missing report or PASS/WARN). Each gate has a verdict-token shape: `MERGE BLOCKED — <reason>` for hard stops.
- §Queue-pick: `list_issues(workflowState: "In Review", limit: 10)` + open-PR filter. Skips unreviewed (downstream pre-merge gate catches).
- §Merge mechanics: `scripts/merge-pr.sh` invocation (the script lives at repo root, reused as-is by old + new plugins). Capture merge SHA for CI watch.
- §Worktree cleanup: `git worktree remove ... --force` post-merge. Cross-repo: per-repo worktree removal.
- §Cross-repo: read `.ralph-repos.yml`; for each sibling repo with `awaits` dependency on this issue, advance / comment per `dependency-flow`. Tilde-expanded `localDir` always resolved to absolute path before `cd`.
- §Parent advancement: handled SERVER-SIDE by `advance-parent.yml` GitHub Action when all children reach Done. Skills MUST NOT advance parent — call out the boundary.
- §CI Watch: `Monitor` tool with stdin-line-as-notification semantics. Script signature: one-line summary per state transition, terminal verdict line (`CI PASSED:` / `CI FAILED:` / `CI SKIPPED:`) immediately before `exit 0`, `timeout_ms=600000` (10 min) for `CI PENDING`. **CRITICAL**: substitute merge SHA into the `command` string literally — Monitor runs in its own subshell, does NOT inherit `$MERGE_SHA` from prior Bash calls. Empty array → `CI SKIPPED:` immediate exit (no infinite loop when CI is unconfigured). Use `printf '%s\n'` not `echo`. Guard every `gh`/`jq` invocation with `2>/dev/null || ...`.
- §Scout Report gate: enforced by `closeout-scout-gate.sh` (Phase 1). When the PR has a `## Scout Trigger` comment (issued by `/ralph:impl --mode pr` per Plan 5), require a `## Scout Report` reply with verdict `PASS` or `WARN`. Block on `FAIL`. Missing report → exit 0 (advisory-by-design; matches scout-trigger contract). Plan 5 docs the producer side; this section docs the consumer side.
- §Verdict tokens (strict): `MERGED`, `MERGE BLOCKED — <reason>`, `MERGE NOT READY`.

### Success Criteria

#### Automated Verification

- [ ] `merge-gate.md` ≥ 120 lines.
- [ ] SKILL.md merge-mode body references `__DONE__`, `MERGE BLOCKED`, `MERGED`.
- [ ] `merge-gate.md` documents the Scout Report gate.

#### Manual Verification

- [ ] `/ralph:review --mode merge #NNN` against a real APPROVED PR: merges, cleans up worktree, posts `## Merged`, transitions to Done.
- [ ] Same against an unreviewed PR: emits `MERGE BLOCKED — review required` and stops without merging.
- [ ] Scout-Trigger PR with FAIL report: `closeout-scout-gate.sh` blocks the merge command.

---

## Phase 5: Default mode + auto-vs-interactive.md

### Overview

The orchestrator. Folds `finish/SKILL.md` (341 lines) into ~50 lines of SKILL.md body + ~100 lines of opinion in the reference. Owns depth-0 fan-out for `code-review:code-review`.

### Changes Required

#### 1. SKILL.md default-mode body

Compact list:

1. **Parse args + fetch issue + find PR** — same shape as merge-mode Steps 1-2. STOP `FINISH BLOCKED — wrong state` if not "In Review"; STOP `FINISH BLOCKED — no PR` if PR not found.
2. **Validate** — `Agent(subagent_type="ralph-hero:val-agent", prompt="Validate GH-NNN. Plan doc: ...")`. Parse verdict: `VALIDATION PASS` → continue. `VALIDATION FIX` → dispatch impl-agent for mechanical fixes (1 cycle max), re-run val. `VALIDATION FAIL` → STOP with `FINISH BLOCKED`.
3. **Code Review Gate** — read deterministic verdict via the helper: `verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)`. Branch on verdict per `auto-vs-interactive.md` §Code Review Gate:
   - `APPROVED` → continue to merge.
   - `NEEDS_FIX` → Code Review Fix Cycle (Step 3a).
   - `BLOCKED` → branch on `RALPH_REVIEW_MODE`: `auto` → invoke `Skill("code-review:code-review", PR_NUMBER)` inline (preserves depth-0 fan-out); `interactive` (default) → `AskUserQuestion` choice. Re-read verdict after.
   - `ERROR: *` → retry once, then `FINISH BLOCKED`.
4. **Code Review Fix Cycle (Step 3a)** — dispatch `Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback...")`. Re-invoke `Skill("code-review:code-review", PR_NUMBER)` once. Re-read verdict. If still `NEEDS_FIX` → `FINISH BLOCKED — review unresolved after 1 fix cycle`. Max 1 cycle (distinct from `--mode code`'s 3 rounds — orchestrator does NOT loop the leaf).
5. **Merge** — `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR for GH-NNN. PR URL: <url>")`. Parse output: `MERGED` → continue; `MERGE BLOCKED|NOT READY` → STOP and report.
6. **CI Watch** — `Monitor` per `merge-gate.md` §CI Watch (consumed in default mode too). Substitute merge SHA literally. Parse last notification: `CI PASSED:` / `CI FAILED:` / `CI SKIPPED:` / no-terminal-line → `CI PENDING`.
7. **Report** — `FINISHED / Issue: #NNN / PR: <url> / Validation: PASS / Merge: Done / CI: <verdict>`.

#### 2. `auto-vs-interactive.md`

- §Depth-0 fan-out: why `code-review:code-review` MUST be invoked inline via `Skill()` from depth-0 default-mode (the parallel reviewer agents land at depth 1; depth-2 Agent dispatch is forbidden by the runtime; nesting `code-review` inside an Agent context silently breaks the fan-out).
- §Code Review Gate: the `finish-review-verdict.sh` helper script's stdout contract (`APPROVED|NEEDS_FIX|BLOCKED|ERROR: <msg>`). Each branch's action (continue, fix cycle, prompt or auto, retry). Use a `case` statement, never if/elif chains (the helper's tokens are deterministic).
- §`RALPH_REVIEW_MODE` switch: `auto` invokes code review inline; `interactive` (default) prompts the user. NOT a verb mode — orchestration knob.
- §Code Review Fix Cycle: max 1 cycle in default-mode. Three rounds is the leaf's prerogative (`--mode code`); the orchestrator does ONE fix cycle then escalates. Preserves the boundary: orchestrator does not own the multi-round loop.
- §`code-review:code-review` not installed: prompt to install or `Merge without review` / `Stop`. Verbatim from `finish/SKILL.md:169-193`.
- §Verdict tokens (strict): `FINISHED`, `FINISH BLOCKED — <reason>`. Plus inherited tokens from the leaves (`VALIDATION PASS|FAIL`, `CODE REVIEW PASSED|ESCALATED`, `MERGED`, `MERGE BLOCKED|NOT READY`).

### Success Criteria

#### Automated Verification

- [ ] `auto-vs-interactive.md` ≥ 80 lines.
- [ ] `auto-vs-interactive.md` documents the depth-0 fan-out invariant.
- [ ] SKILL.md default-mode body references `finish-review-verdict.sh`, `RALPH_REVIEW_MODE`, `FINISHED`, `FINISH BLOCKED`.
- [ ] SKILL.md default-mode body invokes `code-review:code-review` via `Skill()` (not `Agent()`).

#### Manual Verification

- [ ] `/ralph:review #NNN` against a real APPROVED PR: validates → code-review clean → merges → watches CI → reports `FINISHED CI: PASS`.
- [ ] Same against a `BLOCKED` review state in interactive mode: prompts user with `AskUserQuestion`; user-selected "Run code review" → inline `Skill()` invocation → re-reads verdict.

---

## Phase 6: Picker wiring + parity validation + dogfooding

### Overview

Plan 5's owed edits + README + friction-log + 4-session parity validation.

### Changes Required

#### 1. Plan 5's `/ralph:impl` Step 6 picker edit

`ralph/skills/impl/SKILL.md` — locate the next-step picker (one of four options: Run finish / Create PR only / Iterate on plan / Done for now). Update the "Run finish" branch:

- Before: `Skill("ralph-hero:finish", args="NNN")`
- After: `Skill("ralph:review", args="NNN")`

Also update the option label if it reads "Run finish" → "Run review (close-out)".

This is a one-line edit (plus optionally a label update). Plan 5 noted it as a Phase 7 follow-up; Plan 6 lands it.

#### 2. README

`ralph/README.md`:
- `| 6 | \`/ralph:review\` | shipped |`
- `## Status` paragraph updated: "Plan 6 of 11 (review shipped). This plugin currently exposes six user-facing skills…"

#### 3. Friction-log on the spec

Append `### Plan 6: /ralph:review (shipped YYYY-MM-DD)` subsection. Capture:
- Stats: 4 sources (1,585 lines) → 1 SKILL.md (~190 lines) + 4 references (~460 lines) = ~650 lines total; ~59% reduction.
- 5 hooks (under the 9 ceiling): `merge-state-gate.sh` (reuse), `val-postcondition.sh` (reuse), `closeout-postcondition.sh` (new), `closeout-scout-gate.sh` (new), plus shared `lock-release-on-failure.sh` and `doc-structure-validator.sh`.
- Design call: default-mode preserves depth-0 fan-out by invoking `code-review:code-review` via `Skill()` directly, NOT via `Agent()`. Verified by 4-session parity (Phase 6 below) with parallel-reviewer fan-out visible in the run.
- Design call: code-review fix cycle bound differs by mode — 1 cycle in default-mode (orchestrator), 3 rounds in `--mode code` (leaf). Boundary preserved.
- Scout Report consumer: `closeout-scout-gate.sh` is the first hook to consume the `## Scout Report` artifact contract produced by `/ralph:impl --mode pr` per Plan 5. Closes the producer-consumer loop.
- Active-use checkboxes (4 dogfood sessions per Plan 5 pattern).

#### 4. Parity validation runs

1. `/ralph:review #NNN` → default close-out against a real "In Review" + APPROVED PR. Verify val → code-review clean → merge → CI watch → `FINISHED`.
2. `/ralph:review --mode val #NNN` → validation only against a real "In Progress" issue with a worktree.
3. `/ralph:review --mode code #NNN` → code-review-and-fix loop against a PR with non-trivial comments.
4. `/ralph:review --mode merge #NNN` → merge mechanics against a real APPROVED PR.
5. Cross-check: `/ralph:impl` next-step picker → "Run review" dispatches `Skill("ralph:review", ...)` correctly.

### Success Criteria

#### Automated Verification

- [ ] README shows Plan 6 shipped.
- [ ] Friction-log section exists.
- [ ] `grep -n "ralph:review" ralph/skills/impl/SKILL.md` matches (picker updated).
- [ ] `grep -n "ralph-hero:finish" ralph/skills/impl/SKILL.md` returns no match (old picker removed).

#### Manual Verification

- [ ] Five sessions completed successfully.
- [ ] No regressions in any `ralph-hero:*` close-out family skill.

---

## Testing Strategy

### Unit Tests

None — markdown workflow. MCP tools covered by ralph-hero MCP server's existing tests. Hooks are bash scripts; coverage continues via the existing hook-gate snapshot tests (Plan 3 pattern). New hook (`closeout-postcondition.sh`, `closeout-scout-gate.sh`) should get snapshot tests under `plugin/ralph-hero/mcp-server/src/__tests__/snapshots/` if the existing test runner picks them up via `ralph/hooks/scripts/` — confirm Phase 1 coverage scope.

### Integration Tests

The 4-mode parity sessions in Phase 6 are the integration test. Default-mode session exercises the orchestration path including depth-0 fan-out. Code-mode session exercises the 3-round loop. Merge-mode session exercises the Scout Report gate (verify both the FAIL block path and the missing-report pass path).

### Manual Testing Steps

Per Phase 6's list, plus:

1. Verify depth-0 fan-out: invoke `/ralph:review #NNN` against a PR with `BLOCKED` review state in `RALPH_REVIEW_MODE=auto`; confirm `code-review:code-review` runs inline at depth 0 and its parallel reviewers land at depth 1 (visible in transcript).
2. Verify code-review fix-cycle bound: simulate a `NEEDS_FIX` verdict in default-mode; confirm exactly 1 fix cycle runs before `FINISH BLOCKED`. Same simulation in `--mode code`; confirm up to 3 rounds run before escalation.
3. Verify val-mode citation gate: write a phase with a file-content automated check; run `--mode val` against a deliberately-failing implementation; confirm the verdict comment quotes the actual file content (not inferred text).
4. Verify Scout Report gate: PR with `## Scout Trigger` + `## Scout Report` (verdict FAIL); attempt `--mode merge`; confirm `closeout-scout-gate.sh` blocks with exit 2. Same PR with verdict PASS; confirm merge proceeds.
5. Verify merge-state-gate: attempt `save_issue` to transition merge-mode back to "In Progress"; confirm gate blocks.
6. Verify closeout-postcondition: terminate `--mode val` without emitting any verdict token; confirm Stop hook fires with exit 2.

## Performance Considerations

- Default flow: 1 issue fetch + 1 PR fetch + 1 val-agent dispatch + 1 code-review-verdict read + (optional) 1 inline code-review + 1 merge-agent dispatch + 1 Monitor CI watch (up to 10 min). Mirrors source `finish`. Per-step latency dominated by `code-review:code-review` (5 parallel reviewers + N parallel scorers) when invoked.
- Val flow: 1 issue fetch + 1 plan read + 1 worktree freshness check + N automated checks + 1 drift log parse + (optional) 1 delegated classification + 1 comment post. Fast path.
- Code flow: 1 issue fetch + 1 PR fetch + N×(1 code-review + 1 impl-agent fix) up to N=3. Latency dominated by code-review-skill fan-out per round.
- Merge flow: 1 PR fetch + 1 pre-merge-gates pass + 1 merge + 1 worktree-remove + 1 issue transition + (optional) cross-repo loop + 1 outcome record + 1 comment post + 1 PushNotification. Fast path.

## Post-implementation Code Review Findings

PR #1369's code review (commit `87f7312a..fa87cad9`) surfaced three merge-related bugs in the as-shipped Phase 1-6 work. All three are fixed inside this PR before merge; documented here so future Phase-1-style scaffold work avoids the same traps.

### Finding 1: `__DONE__` is not a valid semantic intent

**Symptom:** `ralph/skills/review/SKILL.md` merge-mode Step 6 and `merge-gate.md` §Parent advancement instructed `save_issue(workflowState="__DONE__", command="ralph_merge")`. `__DONE__` is **not** registered in `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts` — the registered intents are `__LOCK__`, `__COMPLETE__`, `__ESCALATE__`, `__CLOSE__`, `__CANCEL__`. Every merge-mode call would have errored at the MCP server with "Unknown semantic intent".

**Fix:** Replace `__DONE__` with `__CLOSE__` (maps `"*": "Done"`). SKILL.md line 120 + merge-gate.md §Parent advancement updated to use `__CLOSE__` and to call out the registered-intent set so future authors don't re-invent the token.

**Root cause:** the source `ralph-merge/SKILL.md` uses `__DONE__` in its prose for *some* call sites but the MCP server's resolution layer was renamed to `__CLOSE__` in a prior plan without back-porting the source skill's prose. Plan 6's fold lifted the source prose verbatim and inherited the rot.

### Finding 2: `merge-state-gate.sh` blocks semantic-intent transitions

**Symptom:** `merge-state-gate.sh` (registered PreToolUse on `save_issue|advance_issue` for /ralph:review) called `validate_state()` which does pure string comparison against `RALPH_VALID_OUTPUT_STATES`. `__ESCALATE__` / `__CLOSE__` / `__LOCK__` don't match any concrete state, so the gate would `block` with exit 2 — preventing the code-mode escalation (SKILL.md line 107) and the merge-mode completion (SKILL.md line 120) from ever reaching the MCP server. The source `ralph-merge` SKILL.md didn't hit this because the source plugin's old `merge-state-gate.sh` had no `is_semantic_intent` passthrough either, but `finish` always dispatched merge via `merge-agent` (a separate Agent context), which put the `save_issue` call outside `merge-state-gate.sh`'s hook scope. Plan 6 makes the call directly from the skill body, exposing the latent gap.

**Fix:** `ralph/hooks/scripts/merge-state-gate.sh` now mirrors `impl-state-gate.sh`'s shape — (a) RALPH_COMMAND scope guard so it only fires for `/ralph:review`, (b) `is_semantic_intent()` passthrough that allows the MCP server to resolve `__*__` tokens server-side, (c) concrete-state validation falls through for non-intent transitions. Smoke-tested with `__ESCALATE__`, `__CLOSE__`, concrete `Done`, invalid `Backlog`, and out-of-scope `RALPH_COMMAND=plan`.

**Root cause:** Plan 5 established the "mode-discriminated by tool-input shape" pattern but didn't articulate the semantic-intent passthrough as a separate substrate. The reuse-as-is port of `merge-state-gate.sh` skipped both substrates — the RALPH_COMMAND guard *and* the intent passthrough — because the source plugin's version was a 20-line gate that pre-dated both.

### Finding 3: `closeout-scout-gate.sh` dies under `set -euo pipefail`

**Symptom:** The verdict-extraction pipeline (`grep -iE 'verdict:' | head -1 | sed ... | tr ... | awk '{print $1}'`) was missing `|| true`. When a `## Scout Report` exists but has no `verdict:` line (malformed report), `grep` exits 1, `pipefail` propagates, `set -e` kills the script with exit 1 — never reaching the conservative `*) exit 0` arm. A malformed report would *block* the merge instead of allow it, contradicting the documented advisory-by-design contract.

**Fix:** Append `|| true` to the verdict-extraction pipeline. Now `VERDICT=""` on no-match, the `case` falls through to `*) exit 0`, advisory-by-design contract honored.

**Root cause:** `set -euo pipefail` + multi-stage pipeline + intermediate `grep` with potentially-empty match. Common bash trap. Plan 6's authoring-time smoke test only exercised the no-op paths (script not invoked, no scout trigger comment) — the malformed-report path was never exercised in the smoke test until code review caught it.

### Lessons for future fold plans

- **Verify semantic-intent tokens against `state-resolution.ts` before adopting prose from source skills.** Source-skill prose may have rot from a prior rename.
- **Audit hook reuse-as-is for the same substrate gaps the new hooks address.** If new hooks add a RALPH_COMMAND guard and a semantic-intent passthrough, ported hooks should too.
- **Smoke-test pipeline-heavy hooks under `set -euo pipefail` with the malformed/no-match path**, not just the happy path. Add the malformed-report test case to manual verification for `--mode merge`.

## Migration Notes

- Source skills remain functional alongside the new verb until Plan 10 batches sunsets.
- Plan 5's `/ralph:impl` Step 6 picker is updated as part of Phase 6 (this plan). The next-step picker now dispatches `Skill("ralph:review", args="NNN")`; the old `Skill("ralph-hero:finish", ...)` is removed.
- Plan 7 (`/ralph:caretake`) and Plan 8 (`/ralph:hero`) may depend on `/ralph:review` for their own orchestration. Hero orchestrator pattern: hero dispatches `/ralph:impl --mode auto`, then `/ralph:review` (default), then `/ralph:hero` resumes the next issue.
- `merge-pr.sh` lives at the repo root and is reused as-is by both old and new plugins.
- `finish-review-verdict.sh` is ported (helper script, called by default-mode body). Its stdout contract is preserved — old plugin's `finish` continues to call the source copy at `plugin/ralph-hero/hooks/scripts/finish-review-verdict.sh`; new plugin calls its copy at `ralph/hooks/scripts/finish-review-verdict.sh`. Identical contract; safe parallel operation.
- The `## Scout Trigger` (producer, Plan 5) + `## Scout Report` (consumer, Plan 6) loop is now closed. Future scout-related plans can extend the verdict vocabulary without touching the producer-consumer wiring.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 6 at line ~338; references layout at line ~185-187; Plan 5's hand-off notes at lines ~551-556).
- Plan 5: `thoughts/shared/plans/2026-05-23-GH-1366-ralph-plan-5-impl.md` (≤9 hook ceiling, mode-discriminated-by-tool-input pattern, `## Scout Trigger` producer contract).
- Plan 4: `thoughts/shared/plans/2026-05-23-GH-1364-ralph-plan-4-plan.md` (path-discrimination hook pattern + no-env-flipping lesson; review-mode hooks dropped from frontmatter via union-broadened state gate).
- Plan 3: `thoughts/shared/plans/2026-05-23-GH-1362-ralph-plan-3-research.md` (SKILL.md `hooks:` pattern + slim-plugin hook scope fixes).
- Source skills:
  - `plugin/ralph-hero/skills/ralph-val/SKILL.md` (527)
  - `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` (286)
  - `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (431)
  - `plugin/ralph-hero/skills/finish/SKILL.md` (341)
- Source hooks under `plugin/ralph-hero/hooks/scripts/`: `merge-state-gate.sh`, `val-postcondition.sh`, `finish-review-verdict.sh` (helper).
- ralph plugin state at Plan 6 start: `ralph/skills/{catch-up,form,research,plan,impl}/` (Plan 5 hooks declared in SKILL.md frontmatter; same pattern reused here).
