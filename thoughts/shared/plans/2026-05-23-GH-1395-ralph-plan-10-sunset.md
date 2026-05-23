---
date: 2026-05-23
github_issue: 1395
github_issues: [1395, 1372, 1373, 1374, 1375, 1377, 1378]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1395
primary_issue: 1395
status: ready
type: plan
tags: [ralph, plugin-restructure, plan-10, sunset, parity, audit]
spec_reference: thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md
---

# Plan 10: Sunset `plugin/ralph-hero/` (Wave 1 — P0/P1 parity fixes)

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] — parent spec, §Migration Plan row 10
- builds_on:: Plans 1–9 (shipped) — every slim verb the audit issues reference
- builds_on:: 2026-05-23 slim-plugin completeness audit — created issues #1372–#1389

## Overview

Plan 10 is the final plan in the migration. It splits across three waves because the spec calls for a ~1-week dogfooding gap between parity-fix completion and sunset, and because a single monolithic PR would bundle 18 unrelated fixes plus the deletion. This plan doc covers **Wave 1 only** — the six P0/P1 audit issues that block sunset. Waves 2 and 3 are scoped here but shipped via their own PRs.

| Wave | Scope | Ships when |
|---|---|---|
| 1 (this PR) | P0 + 5 P1 parity fixes (#1372, #1373, #1374, #1375, #1377, #1378) | Now |
| 2 | 12 P2/P3 parity fixes (#1376, #1379–#1389) | Each as a self-contained PR or small batch over the dogfooding window |
| 3 | Delete `plugin/ralph-hero/skills/` in alphabetical batches, retarget README + CLAUDE.md, decide MCP relocation | After ≥1 real-session pass through every active `/ralph:*` mode post-Wave-2 |

The six Wave-1 issues all stem from the slim plugin silently dropping enforcement or capabilities that the source plugin carried. None are bugs in the new architecture; they're missed ports. Each fix is a small, surgical edit (or new hook) scoped to its own commit so a single regression is revertable without rolling back the whole PR.

## Current State Analysis

The six P0/P1 issues split into three thematic clusters:

### Cluster A — `/ralph:impl` runtime breakage (1 issue)

- **#1372 (P0)**: `ralph/skills/impl/phase-execution.md` references three sub-agent prompt files (`implementer-prompt.md`, `task-reviewer-prompt.md`, `phase-reviewer-prompt.md`) that exist in `plugin/ralph-hero/skills/ralph-impl/` but were never copied into `ralph/skills/impl/`. First invocation of `/ralph:impl --mode auto` cannot construct sub-agent context packets and fails.

### Cluster B — `/ralph:review --mode merge` enforcement + capability gaps (3 issues)

- **#1373 (P1)**: Merge-gate enforcement is prose-only — no hook reads `gh pr view --json reviewDecision` and exits 2 on `null`/`REVIEW_REQUIRED`. Spec principle P6 ("Hooks own enforcement") violated.
- **#1374 (P1)**: `RALPH_AUTO_MERGE=true` autonomous gate + `AUTO-MERGE BLOCKED` terminal token are completely missing from the slim verb. Any orchestrator passing the env var silently bypasses the gate.
- **#1375 (P1)**: New `merge-gate.md` accepts only `APPROVED`; the source plugin's XS-no-review and self-authorship carve-outs (single-developer repos, fast-track ladder) were dropped. Single-contributor repos are now hard-blocked on every merge.

These three share a single file (`ralph/skills/review/merge-gate.md`) and one new hook surface — they batch naturally.

### Cluster C — `/ralph:plan` enforcement + schema gaps (2 issues)

- **#1377 (P1)**: `ralph/skills/plan/plan-shapes.md` omits the per-task YAML fields (`depends_on`, `tdd`, `complexity`, `acceptance`) and the per-phase `depends_on:` annotation that `ralph/hooks/scripts/plan-postcondition.sh:74-84` consumes for `sync_plan_graph`. Plans authored via `/ralph:plan` produce incomplete graphs silently.
- **#1378 (P1)**: `ralph/hooks/scripts/review-postcondition.sh` was ported but not registered in the `Stop:` block of `ralph/skills/plan/SKILL.md` (registration conflict with `--mode auto`). `--mode review` Stop enforcement is weaker than the source skill.

### Key Discoveries

- **All six fixes touch existing files only.** No new scaffolding, no new mode bodies, no new modes-subfolder content. The largest single edit is the merge-gate.md cluster which gains roughly 60–100 lines of restored opinion content.
- **Two fixes ship hooks** (#1373 needs a new `merge-review-decision-gate.sh`; #1378 needs `review-postcondition.sh` self-gating + re-registration). Both follow the established `RALPH_COMMAND` scope guard + `|| true` under pipefail pattern from Plan 6's friction log.
- **No source-plugin file deletion in this wave.** Per the wave layout, `plugin/ralph-hero/skills/` stays intact until Wave 3.

### Out of scope for Wave 1

- The 12 P2/P3 parity issues (#1376, #1379–#1389). Each is independently mergeable post-Wave-1; the plan doc tracks them but does not implement.
- Sunset itself (Wave 3) — no `git rm plugin/ralph-hero/skills/*` in this PR.
- MCP server relocation decision (Wave 3).
- New slim-plugin scaffolding (every fix edits an existing file).
- Plan 8 / Plan 9 retroactive audit. Both shipped today and their own audit issues — if any — will be filed via the same completeness-audit mechanism; not in this wave.

## Desired End State

After this PR merges:

1. All six P0/P1 audit issues (#1372, #1373, #1374, #1375, #1377, #1378) are closed via this PR's commits, each with a comment linking back to the closing commit.
2. `/ralph:impl --mode auto` constructs sub-agent context packets without "file not found" failures.
3. `/ralph:review --mode merge` refuses to merge a PR without `APPROVED` (or matched carve-out) via a deterministic hook, not prose.
4. `/ralph:review --mode merge` honors `RALPH_AUTO_MERGE=true` and emits `AUTO-MERGE BLOCKED` when blocked.
5. `/ralph:review --mode merge` permits XS-no-review and self-authorship merges per the source plugin's carve-outs.
6. `/ralph:plan` produces plan docs with per-phase `depends_on:` annotations and per-task `depends_on`/`tdd`/`complexity`/`acceptance` YAML fields that `plan-postcondition.sh` consumes.
7. `/ralph:plan --mode review` Stop enforcement verifies a critique doc was created in `thoughts/shared/reviews/`.
8. Spec friction-log gains a "Plan 10 Wave 1" entry referencing each closed issue.
9. README's migration table row for Plan 10 → "Wave 1 shipped 2026-05-23".

### Verification

- `wc -l ralph/skills/impl/{implementer,task-reviewer,phase-reviewer}-prompt.md` — all three files present and non-empty.
- `grep -r "RALPH_AUTO_MERGE" ralph/skills/review/` — at least one match (gate + token).
- `grep -r "XS.*carve-out\|self-authorship" ralph/skills/review/merge-gate.md` — both carve-outs documented.
- `grep -r "depends_on\|complexity:\|tdd:" ralph/skills/plan/plan-shapes.md` — per-task YAML present.
- `grep "review-postcondition.sh" ralph/skills/plan/SKILL.md` — hook registered in Stop chain.
- `test -x ralph/hooks/scripts/merge-review-decision-gate.sh` — new hook present + executable.
- `gh issue list --state closed --search "1372 1373 1374 1375 1377 1378 in:title" --json number,closedAt` — all six closed by this PR's merge commit.

## What We're NOT Doing

- **Not** deleting any file in `plugin/ralph-hero/`.
- **Not** changing the MCP server.
- **Not** modifying `ralph/.claude-plugin/plugin.json` or releasing a new ralph version (no functional change to the slim verbs warrants a bump beyond the auto-release workflow if it triggers).
- **Not** touching the 12 P2/P3 parity issues. Each gets its own PR in Wave 2.
- **Not** writing new tests for the existing slim verbs — only adding smoke checks for the new hook (#1373) and the re-registered hook (#1378).
- **Not** changing the SOUL-removal decision from Plan 6 (no SOUL files reintroduced).

## Implementation Approach

Six XS/S-sized phases, one per issue, in priority order. Each phase is its own commit so a single regression is revertable. Phase 7 wraps up README + friction-log.

| Phase | Owns | Closes |
|---|---|---|
| 1 | Copy 3 sub-agent prompt files into `ralph/skills/impl/` | #1372 |
| 2 | New `merge-review-decision-gate.sh` hook + register in `ralph/skills/review/SKILL.md` | #1373 |
| 3 | Port `RALPH_AUTO_MERGE` + `AUTO-MERGE BLOCKED` into `merge-gate.md` | #1374 |
| 4 | Port XS-no-review + self-authorship carve-outs into `merge-gate.md` + cross-reference from the new hook | #1375, refines #1373 |
| 5 | Add per-phase `depends_on:` + per-task YAML schema to `plan-shapes.md` | #1377 |
| 6 | Self-gate `review-postcondition.sh` on `RALPH_SUBCOMMAND=review` + re-register in `ralph/skills/plan/SKILL.md` Stop chain | #1378 |
| 7 | Spec friction-log entry + README Plan 10 row + cross-reference to Wave 2/3 backlog | — |

Each phase commits independently. Phases 3 and 4 both touch `merge-gate.md` and run sequentially. Phase 2 must land before Phase 4's cross-reference (Phase 4 cites the hook by name).

---

## Phase 1: Copy sub-agent prompt files (#1372)

### Overview

Copy the three sub-agent prompt files referenced by `phase-execution.md` from `plugin/ralph-hero/skills/ralph-impl/` into `ralph/skills/impl/`. No content changes — verbatim port.

### Changes Required

#### 1. File copies

```bash
cp plugin/ralph-hero/skills/ralph-impl/implementer-prompt.md ralph/skills/impl/implementer-prompt.md
cp plugin/ralph-hero/skills/ralph-impl/task-reviewer-prompt.md ralph/skills/impl/task-reviewer-prompt.md
cp plugin/ralph-hero/skills/ralph-impl/phase-reviewer-prompt.md ralph/skills/impl/phase-reviewer-prompt.md
```

#### 2. Update `ralph/skills/impl/phase-execution.md` to cite paths

The current reference is "re-used as-is from source plugin" with no path. Update both call sites (`:25` and `:55`) to read `implementer-prompt.md` (and the other two) from the same directory — relative to the SKILL bundle. The verb is loaded from `ralph/skills/impl/`, so a bare filename resolves correctly.

If the existing prose says "re-used as-is from source plugin", change to:

> Build context packet from `implementer-prompt.md` (sibling file in this skill bundle).

Same surgical edit for the other two references.

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/impl/implementer-prompt.md && test -s ralph/skills/impl/implementer-prompt.md`
- [ ] `test -f ralph/skills/impl/task-reviewer-prompt.md && test -s ralph/skills/impl/task-reviewer-prompt.md`
- [ ] `test -f ralph/skills/impl/phase-reviewer-prompt.md && test -s ralph/skills/impl/phase-reviewer-prompt.md`
- [ ] `grep -c "source plugin" ralph/skills/impl/phase-execution.md` — zero (the misleading phrase is gone).

#### Manual Verification

- [ ] Skip — the gap is corrected by file presence. Manual `/ralph:impl --mode auto` run is deferred to natural dogfooding.

---

## Phase 2: `merge-review-decision-gate.sh` hook (#1373)

### Overview

Add a `PreToolUse:Bash` hook scoped to `RALPH_COMMAND=review` + `RALPH_SUBCOMMAND=merge` that detects `gh pr merge` invocations, runs `gh pr view <num> --json reviewDecision,statusCheckRollup`, and exits 2 if `reviewDecision != "APPROVED"`.

The hook is intentionally minimal in Wave 1 — it gates strictly on `APPROVED`. Phase 4 then extends it to honor the XS-no-review + self-authorship carve-outs from #1375.

### Changes Required

#### 1. New hook: `ralph/hooks/scripts/merge-review-decision-gate.sh`

Mirror `ralph/hooks/scripts/impl-state-gate.sh` shape:

- `set -euo pipefail`
- Source `hook-utils.sh`.
- Scope guard: no-op when `RALPH_COMMAND != "review"` OR `RALPH_SUBCOMMAND != "merge"`.
- Read `tool_input.command` from stdin via the existing `get_field` helper.
- Match `gh pr merge` (allow `--squash`, `--rebase`, `--merge`, `--auto` etc.). Extract the PR number using a regex.
- If no PR number captured, exit 0 (let the call through — not our case).
- Call `gh pr view <PR_NUM> --json reviewDecision 2>/dev/null` and parse with `jq -r '.reviewDecision // "null"'`. Append `|| true` to the pipeline per the Plan 6 friction-log lesson.
- If `reviewDecision == "APPROVED"`, exit 0.
- Otherwise exit 2 with a stderr message naming the PR number and the actual `reviewDecision`.

#### 2. Register in `ralph/skills/review/SKILL.md` frontmatter

Add to the `PreToolUse:` block:

```yaml
PreToolUse:
  - matcher: "Bash"
    hooks:
      - type: command
        command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-review-decision-gate.sh"
```

### Success Criteria

#### Automated Verification

- [ ] `test -x ralph/hooks/scripts/merge-review-decision-gate.sh`
- [ ] `grep -q "RALPH_COMMAND" ralph/hooks/scripts/merge-review-decision-gate.sh` — scope guard present.
- [ ] `grep -q "merge-review-decision-gate.sh" ralph/skills/review/SKILL.md` — hook registered.
- [ ] Bash smoke test (run inline from the impl):
  ```bash
  RALPH_COMMAND=review RALPH_SUBCOMMAND=merge \
    bash ralph/hooks/scripts/merge-review-decision-gate.sh \
    <<< '{"hook_event_name":"PreToolUse","tool_input":{"command":"echo hi"}}'
  ```
  Expected: exit 0 (non-merge Bash command, hook no-ops).

#### Manual Verification

- [ ] Skip — gate behavior is verified by smoke test. Real-merge verification deferred to dogfooding.

---

## Phase 3: `RALPH_AUTO_MERGE` autonomous gate (#1374)

### Overview

Port the Step 4a autonomous merge gate from `plugin/ralph-hero/skills/ralph-merge/SKILL.md:159-205` into `ralph/skills/review/merge-gate.md` as a discriminated section. Three-criterion check (review decision + CI green + PR open & mergeable). Emit `AUTO-MERGE BLOCKED` terminal token on failure.

### Changes Required

#### 1. Append to `ralph/skills/review/merge-gate.md`

New section `## Autonomous mode (RALPH_AUTO_MERGE=true)` after the existing "Pre-merge checks" prose. Body covers:

- Trigger: `RALPH_AUTO_MERGE=true` env var (typically set by an orchestrator before invoking `/ralph:review --mode merge`).
- Three criteria, all must pass:
  1. `gh pr view <PR> --json reviewDecision --jq .reviewDecision` returns `APPROVED` (or matched carve-out from Phase 4).
  2. `gh pr view <PR> --json statusCheckRollup --jq '.statusCheckRollup[].conclusion'` returns no `FAILURE`/`ERROR`/`CANCELLED` (PENDING/IN_PROGRESS treated as "wait", emit `AUTO-MERGE BLOCKED ci-pending` and STOP without merging).
  3. `gh pr view <PR> --json state,mergeable --jq '{state, mergeable}'` returns `state=OPEN` + `mergeable=MERGEABLE`.
- Token contract: emit `AUTO-MERGE BLOCKED <reason>` on any blocker; emit `MERGED <PR>` on success. These are recognized by upstream orchestrators (autopilot, hero).

#### 2. Cross-reference from `ralph/skills/review/SKILL.md` `--mode merge` body

Single line: "When `RALPH_AUTO_MERGE=true`, consult `merge-gate.md` § Autonomous mode for the three-criterion gate and the `AUTO-MERGE BLOCKED` token contract."

### Success Criteria

#### Automated Verification

- [ ] `grep -q "RALPH_AUTO_MERGE" ralph/skills/review/merge-gate.md`
- [ ] `grep -q "AUTO-MERGE BLOCKED" ralph/skills/review/merge-gate.md`
- [ ] `grep -q "Autonomous mode" ralph/skills/review/merge-gate.md`
- [ ] `grep -q "RALPH_AUTO_MERGE\|Autonomous mode" ralph/skills/review/SKILL.md` — cross-reference present.

#### Manual Verification

- [ ] Skip — deferred to dogfooding.

---

## Phase 4: XS-no-review + self-authorship carve-outs (#1375)

### Overview

Port the two intentional carve-outs from `plugin/ralph-hero/skills/ralph-merge/SKILL.md:133-149`:

1. **XS exception** — issues with estimate `XS` and zero PR comments may merge without a formal `APPROVED` decision (typo fixes, one-line tweaks).
2. **Self-authorship pass-through** — self-authored PRs are treated as APPROVED-equivalent on single-contributor repos, because GitHub blocks self-approval.

Both carve-outs land in `merge-gate.md` AND the new `merge-review-decision-gate.sh` from Phase 2 (so the hook enforces the same shape the prose advertises).

### Changes Required

#### 1. Append to `ralph/skills/review/merge-gate.md`

Add a `## Carve-outs from the APPROVED requirement` section after the Pre-merge checks. Body covers both rules with the source-skill's exact thresholds:

- **XS exception:** `gh issue view <ISSUE> --json projectItems --jq '.projectItems[].fieldValues' | jq -r '.[] | select(.field.name=="Estimate") | .name'` returns `XS` AND `gh pr view <PR> --json comments --jq '.comments | length'` returns `0`. When both true, accept merge.
- **Self-authorship:** `gh pr view <PR> --json author,headRepositoryOwner --jq '{author: .author.login, owner: .headRepositoryOwner.login}'` returns matching `author == owner`. When true AND the repo has only one human contributor (heuristic: `gh api repos/{owner}/{repo}/contributors --jq 'length'` returns 1), accept merge.

#### 2. Update `ralph/hooks/scripts/merge-review-decision-gate.sh` (from Phase 2)

After the `reviewDecision == "APPROVED"` happy-path exit, add two fallback checks:

```bash
# Carve-out 1: XS estimate + zero comments
if is_xs_no_comments_pr "$PR_NUM"; then
  exit 0
fi

# Carve-out 2: self-authored on single-contributor repo
if is_self_authored_solo_repo "$PR_NUM"; then
  exit 0
fi

# Otherwise, block.
echo "merge-review-decision-gate: PR #$PR_NUM has reviewDecision='$REVIEW_DECISION' (need APPROVED, or XS-no-comments, or self-authored-solo-repo)." >&2
exit 2
```

Both helpers (`is_xs_no_comments_pr`, `is_self_authored_solo_repo`) live inline in the script — no separate file.

### Success Criteria

#### Automated Verification

- [ ] `grep -q "XS exception\|XS-no-comments" ralph/skills/review/merge-gate.md`
- [ ] `grep -q "Self-authorship\|self-authored" ralph/skills/review/merge-gate.md`
- [ ] `grep -q "is_xs_no_comments_pr\|XS.*comments" ralph/hooks/scripts/merge-review-decision-gate.sh`
- [ ] `grep -q "is_self_authored\|self-author" ralph/hooks/scripts/merge-review-decision-gate.sh`
- [ ] Bash dry-run: feed a fake `tool_input.command="gh pr merge 1 --squash"` JSON with `RALPH_COMMAND=review RALPH_SUBCOMMAND=merge`; script should call `gh pr view` (will fail in CI because the test PR doesn't exist) — that's expected. Hook script structure validated by manual review.

#### Manual Verification

- [ ] Skip — dogfooding catches real-merge edge cases.

---

## Phase 5: per-phase `depends_on:` + per-task YAML schema (#1377)

### Overview

Restore the per-phase `depends_on:` annotation and the per-task YAML fields (`depends_on`, `tdd`, `complexity`, `acceptance`) into `ralph/skills/plan/plan-shapes.md`. The `plan-postcondition.sh` hook (lines 74-84) already checks for these fields — Wave 1 closes the documentation gap so authored plans carry them.

### Changes Required

#### 1. Add `## Task anatomy` section to `ralph/skills/plan/plan-shapes.md`

Insert after the existing "Phase anatomy" section. Body covers:

- The four YAML fields a task should carry:
  - `depends_on:` — `null` or `[phase-N]` or `[GH-NNN]` (other issues in the group).
  - `tdd:` — `true` or `false`. Default `false`; `true` means write the failing test first.
  - `complexity:` — `low` / `medium` / `high`. Used by orchestrators for parallel-dispatch decisions.
  - `acceptance:` — markdown checkbox list, one per success criterion.
- A worked example showing one task in full YAML+markdown form.

#### 2. Update the Phase template

Add a `- **depends_on**: ...` row to the Phase header anatomy already documented in `plan-shapes.md`. Value mirrors the per-task `depends_on:` shape: `null` or `[phase-N]`.

#### 3. Optional: tighten `plan-postcondition.sh`

NOT in scope for Wave 1 — the hook currently warns when these fields are missing. Elevating to a block is a behavior change that risks failing plans authored before this PR. Wave 2 may revisit.

### Success Criteria

#### Automated Verification

- [ ] `grep -c "depends_on:" ralph/skills/plan/plan-shapes.md` — at least 2 (per-phase + per-task).
- [ ] `grep -q "^\(\| \)*tdd:" ralph/skills/plan/plan-shapes.md` — `tdd:` field documented.
- [ ] `grep -q "^\(\| \)*complexity:" ralph/skills/plan/plan-shapes.md` — `complexity:` field documented.
- [ ] `grep -q "## Task anatomy\|Task anatomy" ralph/skills/plan/plan-shapes.md` — new section header present.

#### Manual Verification

- [ ] Skip — re-read the diff to confirm prose flow.

---

## Phase 6: re-register `review-postcondition.sh` (#1378)

### Overview

Make `ralph/hooks/scripts/review-postcondition.sh` self-gate on `RALPH_SUBCOMMAND=review` (no-op otherwise), then re-register it in the `Stop:` chain of `ralph/skills/plan/SKILL.md`. The hook can then enforce critique-doc existence in `thoughts/shared/reviews/` without false-firing in `--mode auto`.

### Changes Required

#### 1. Self-gate `ralph/hooks/scripts/review-postcondition.sh`

Add at the top of the script body (after `set -euo pipefail` and `source hook-utils.sh`):

```bash
# Scope guard: only fire in --mode review of /ralph:plan.
if [[ "${RALPH_COMMAND:-}" != "plan" ]] || [[ "${RALPH_SUBCOMMAND:-}" != "review" ]]; then
  exit 0
fi
```

This mirrors the `RALPH_COMMAND` + `RALPH_SUBCOMMAND` pattern used by `triage-state-gate.sh` and the other multi-mode hooks.

#### 2. Register in `ralph/skills/plan/SKILL.md` `Stop:` block

Append a hook entry to the existing `Stop:` block (after `plan-postcondition.sh` and `lock-release-on-failure.sh`):

```yaml
Stop:
  - hooks:
      - ...existing hooks...
      - type: command
        command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/review-postcondition.sh"
```

### Success Criteria

#### Automated Verification

- [ ] `grep -q "RALPH_SUBCOMMAND.*review\|RALPH_SUBCOMMAND..= .review" ralph/hooks/scripts/review-postcondition.sh` — scope guard present.
- [ ] `grep -q "review-postcondition.sh" ralph/skills/plan/SKILL.md` — registered in Stop chain.
- [ ] Smoke test: invoke the hook with `RALPH_COMMAND=plan RALPH_SUBCOMMAND=auto` set (wrong mode) — must exit 0 immediately.
  ```bash
  RALPH_COMMAND=plan RALPH_SUBCOMMAND=auto \
    bash ralph/hooks/scripts/review-postcondition.sh \
    <<< '{"hook_event_name":"Stop"}'
  ```
  Expected: exit 0 (scope guard no-op).

#### Manual Verification

- [ ] Skip — verified by smoke test.

---

## Phase 7: friction-log + README update

### Overview

Append a Wave 1 friction-log entry to the spec and update the migration table row for Plan 10.

### Changes Required

#### 1. Append to `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`

New section after the Plan 7 entry (preserve the existing Plan 7 prose):

```markdown
### Plan 10 Wave 1: P0/P1 parity fixes (shipped 2026-05-23, branch `feature/ralph-plan-10-sunset-wave1`)

Six audit issues closed in a single PR:
- #1372 (P0): copied 3 sub-agent prompt files into `ralph/skills/impl/`.
- #1373 (P1): added `merge-review-decision-gate.sh` PreToolUse:Bash hook.
- #1374 (P1): ported `RALPH_AUTO_MERGE` + `AUTO-MERGE BLOCKED` token into `merge-gate.md`.
- #1375 (P1): restored XS-no-comments + self-authorship carve-outs in `merge-gate.md` AND the new hook.
- #1377 (P1): added per-phase `depends_on:` + per-task YAML schema (`depends_on`, `tdd`, `complexity`, `acceptance`) to `plan-shapes.md`.
- #1378 (P1): self-gated `review-postcondition.sh` on `RALPH_SUBCOMMAND=review`, re-registered in `/ralph:plan` Stop chain.

Wave 2 (12 P2/P3 issues: #1376, #1379–#1389) ships as individual PRs over the dogfooding window. Wave 3 (sunset of `plugin/ralph-hero/skills/`) blocked on Wave 2 closure + one real-session pass per active mode.

Patterns to encode in future plans:
- **Audit-then-fix is its own plan shape.** Plans 1–9 were folds. Plan 10 Wave 1 is a directed-fix wave with no new structure — each phase is a single commit, scope tight to the one audit issue it closes. Useful pattern for the inevitable Wave 2 + Plans 11+.
- **Carve-outs belong in the hook AND the doc.** Phase 4 deliberately duplicates the XS-no-comments + self-authorship logic across `merge-gate.md` (prose) and `merge-review-decision-gate.sh` (enforcement). Spec P6 ("Hooks own enforcement") doesn't mean prose is silent — the prose tells the user what the hook does. Drift catches will surface as future audit issues.
```

#### 2. Update `ralph/README.md` migration table

Find the migration-table row for Plan 10 and replace its status cell with: `Wave 1 shipped 2026-05-23 (P0/P1 fixes). Wave 2+3 in progress.`

### Success Criteria

#### Automated Verification

- [ ] `grep -q "Plan 10 Wave 1" thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`
- [ ] `grep -q "Wave 1 shipped" ralph/README.md`

#### Manual Verification

- [ ] Re-read the friction-log entry — sounds like a teammate-readable summary.

---

## Open follow-ups (separate plans / PRs)

- **Wave 2** (each its own PR or small batch):
  - #1376 — iOS-mode push implementation in merge-gate.md
  - #1379 — `--mode review` picker (restore multi-select + Open in editor)
  - #1381 — port `remember-turn.sh` Stop hook into slim plugin (dream-loop memory write)
  - #1384 — port `install-schedules.sh` heartbeat bootstrap (or document the loss + alternative)
  - #1385 — restore `result:`/`needs input:` markers in caretake (iOS-harness extraction)
  - #1386 — restore triage Step 7 "Find and Link Related Issues"
  - #1387 — document the form `thoughts-analyzer` addition
  - #1380 — `RALPH_PLAN_TYPE` propagation for `--mode epic`
  - #1382 — document `RALPH_IMPL_MODEL` in slim verb
  - #1383 — port 8 KB prompt-size-cap truncation in `--mode pr`
  - #1388 — restore form no-args help block
  - #1389 — document the knowledge_expert 3-priority rule in `--mode auto`
- **Wave 3** (after Wave 2 + dogfood-window):
  - Delete `plugin/ralph-hero/skills/` in alphabetical batches.
  - Update `ralph-hero/CLAUDE.md` to point at `ralph/` as the canonical plugin.
  - Update `ralph-hero/README.md` migration table → "shipped".
  - Decide whether to relocate `plugin/ralph-hero/mcp-server/` into `ralph/mcp/` or leave in place.
  - Spec friction-log: final "migration complete" entry.
- **Beyond Plan 10:**
  - Audit Plan 8 (hero) and Plan 9 (setup) for parity gaps using the same completeness-audit mechanism; issues filed will land in a Plan 11 if any surface.
