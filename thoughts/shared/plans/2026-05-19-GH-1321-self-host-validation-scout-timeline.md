---
date: 2026-05-19
status: draft
type: plan
github_issue: 1321
github_issues: [1321]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1321
primary_issue: 1321
tags: [scouts, validation, fixture-pr, playwright-auto, ralph-merge, manual-test]
---

# Self-Host Validation: Open Fixture PR, Observe Scout Timeline, Record Evidence — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-19-GH-1317-extract-shared-ui-heuristic]]
- builds_on:: [[2026-05-19-GH-1318-scouts-team-skill]]
- builds_on:: [[2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow]]
- builds_on:: [[2026-05-19-GH-1320-mark-scouts-live-docs]]

(Note: the parent plan-of-plans `2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` referenced in the GH-1314 issue body was not present on disk at planning time; this plan reconstructs scope from the epic issue body, all four sibling Phase 1–4 plans, and the live consumer-gate logic in `ralph-merge/SKILL.md`. No `--parent-plan` flag was passed.)

## Overview

Single-issue atomic plan to manually self-host-validate the end-to-end closed loop assembled by sibling Phases 1–4. The execution path is: a fixture PR touches a UI-matching file → `.github/workflows/playwright-auto.yml` fires (Phase 3 producer) → a `scout-auto` labeled issue is created with `<!-- scout-pr: NNN -->` idempotency marker → Director classifies via the `scout-auto` automation-label row (Phase 4 taxonomy flip) → `/ralph-hero:scouts` dispatches `scouts-agent` (Phase 2 team-skill) → `## Scout Report` with `Verdict: GREEN|YELLOW|RED` is posted on the PR → `ralph-merge` Step 4b (Scout Report Gate, `ralph-merge/SKILL.md:213-276`) correctly consumes the verdict.

The output of this phase is NOT code — it is a `## Validation Evidence` section appended to the parent epic's plan document with concrete run IDs, issue numbers, and verdict snapshots, plus the fixture PR closed (not merged) and cleaned up.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1321 | Self-host validation — open fixture PR, observe full scout timeline, record evidence | XS |

## Shared Constraints

These constraints are inherited from the GH-1314 epic (reconstructed from the epic issue body and Phase 1–4 sibling plans, since the on-disk plan-of-plans file is missing) and extended with feature-specific constraints from this issue's Research Notes:

1. **Validation is intentionally manual.** Per the issue's Research Notes, this phase MUST NOT be gated on a CI assertion. The point is to observe the producer→Director→scouts→merge chain with a human in the loop. Impl-agent runs the steps and records artifacts; no automation is added to the repo.
2. **Fixture PR is small, reversible, and non-merging.** Touch exactly one low-risk file that the shared UI heuristic (`plugin/ralph-hero/scripts/shared/ui-heuristic.sh`) matches. Per the issue Scope: do not ship a change — close the PR without merging when validation is complete. Acceptable fixture files: a one-line comment edit to any `*.tsx`, `*.svelte`, `*.vue`, `*.css`, or `*.scss` file under the repo (none exist in this repo today — see Implementation Approach for the workaround using a path-matched file).
3. **Dependency-blocked on Phases 1–4 merged to `main`.** This phase MUST NOT run until GH-1317, GH-1318, GH-1319, and GH-1320 are all `Done`. Impl-agent verifies via `git log --oneline main -- .github/workflows/playwright-auto.yml plugin/ralph-hero/skills/scouts/SKILL.md plugin/ralph-hero/agents/scouts-agent.md plugin/ralph-hero/scripts/shared/ui-heuristic.sh` that all four source files exist on `main`. If any is missing, emit `IMPL BLOCKED needs=phase-1-2-3-or-4-not-yet-merged` and stop.
4. **Idempotency MUST be empirically proven, not theorized.** Per the issue Acceptance Criteria: push a follow-up commit on the same fixture PR (triggering `synchronize`) and verify that NO second `scout-auto` issue is created. The Phase 3 plan (GH-1319) embeds the search-then-create logic; this phase verifies it works against the real GitHub API.
5. **Verdict consumption is the load-bearing assertion.** The closed loop is "proven" only when `ralph-merge` Step 4b correctly consumes a real `## Scout Report` comment. Per `ralph-merge/SKILL.md:248-258`, the gate greps for the literal string `## Scout Report` AND `Verdict: GREEN` (case-insensitive on `GREEN`). The validation MUST exercise this gate against the scouts-produced comment (NOT a hand-pasted comment).
6. **GREEN-allows is the required positive case. RED-blocks is optional.** Per the issue Acceptance Criteria explicitly: "one positive case: GREEN allows; document but do not necessarily test a RED-blocks case if it requires real failures." Do not synthesize a fake RED to prove the block branch; document the gate logic from `ralph-merge/SKILL.md:259-267` instead.
7. **Evidence destination is the parent epic plan, not this plan.** Per the issue Scope: append a `## Validation Evidence` section to `thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md`. If that file does not exist on disk at run time, impl-agent MUST create a minimal stub plan at that path containing only the title, a Prior Work pointer to this child plan, and the `## Validation Evidence` section — preserving the originally-intended evidence destination. Do NOT append the evidence to THIS plan file.
8. **Cleanup is part of acceptance.** The fixture PR MUST be closed without merge. The `scout-auto` issue created by the workflow MUST be closed (with a comment linking to the recorded evidence). The fixture branch MAY be deleted after closure (optional — `gh pr close` does not auto-delete).
9. **No source-file changes beyond evidence document.** This phase is pure observation + documentation. The only files that change on disk are (a) the evidence document at the parent plan path and (b) the fixture-branch file (committed only to the throwaway branch, never to `main`).

## Current State Analysis

### What exists today (verified at planning time)

- **Phase 1 — shared UI heuristic** (`plugin/ralph-hero/scripts/shared/ui-heuristic.sh`): Will exist post-merge of GH-1317. Sourceable bash helper exposing `is_ui_touching`. Regex matches `\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/`.
- **Phase 2 — scouts team-skill** (`plugin/ralph-hero/skills/scouts/SKILL.md`, `plugin/ralph-hero/agents/scouts-agent.md`): Will exist post-merge of GH-1318. Skill dispatches `/ralph-playwright:a11y-scan` always, plus conditional `test-e2e`/`storybook-test`/`visual-diff`. Writes `## Scout Report` PR comment with `Verdict: GREEN|YELLOW|RED`.
- **Phase 3 — per-PR producer** (`.github/workflows/playwright-auto.yml`): Will exist post-merge of GH-1319. Fires on `pull_request.opened|synchronize|reopened`, sources the shared heuristic, files a `scout-auto` labeled issue with dual idempotency markers (`<!-- scout-pr: NNN -->` HTML + `scout-pr/NNN` plain-text).
- **Phase 4 — taxonomy flip** (`plugin/ralph-hero/skills/director/event-classes.md`, `CLAUDE.md`, `plugin/ralph-hero/docs/model-tier-policy.md`): Will exist post-merge of GH-1320. Director's `scout-auto` row routes to `ralph-hero:scouts` skill with status `live`. CLAUDE.md Per-Phase Agents table includes `scouts-agent` row.
- **ralph-merge consumer gate** (`plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276`): Step 4b "Scout Report Gate" already exists. Greps PR comments for `## Scout Trigger` (presence check from ralph-pr) then for `## Scout Report` + `Verdict: GREEN|RED`. Currently no-op'd in practice because no producer writes the report. This validation exercises that gate against a real scouts-produced report.
- **ralph-pr Scout Trigger producer** (`plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417`): Already exists. Posts the `## Scout Trigger` PR comment that ralph-merge's gate checks for presence. Note: this is a separate channel from `playwright-auto.yml`'s `scout-auto` issue producer; both run on UI-touching PRs.
- **Director skill** (`plugin/ralph-hero/skills/director/SKILL.md`): Already exists. Handles classification via `event-classes.md` taxonomy. Invoked via `/ralph-hero:director --issue NNN` or by trigger labels.
- **Repo composition**: This repo (`ralph-hero`) currently contains zero `*.tsx`, `*.svelte`, `*.vue`, `*.css`, or `*.scss` files. The heuristic ALSO matches paths containing `/components/` or `/storybook/` segments. The fixture can be a no-op markdown comment edit to a file path that contains `/components/` OR a new throwaway file under `plugin/ralph-hero/components/fixture-scout-validation.md` (path-segment match, low risk). See Implementation Approach for the chosen approach.

### Pattern source files (read, not modified)

- `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` — confirms which fixture paths will be matched (read by Task 1.1 to choose the fixture file).
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276` — Step 4b gate logic; Task 1.6 invokes ralph-merge to exercise this.
- `plugin/ralph-hero/skills/director/event-classes.md` — Director classification taxonomy; Task 1.4 watches Director consume the `scout-auto` row.
- `plugin/ralph-hero/skills/scouts/SKILL.md` — scouts orchestration logic; Task 1.5 watches the dispatch table fire.
- `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:206-246` — original search-then-create idempotency pattern; Task 1.3 verifies the ported logic in `playwright-auto.yml` behaves identically against the live API.

## Desired End State

### Verification

- [ ] All four Phase 1–4 source files exist on `main` (Phases 1–4 are merged): `plugin/ralph-hero/scripts/shared/ui-heuristic.sh`, `plugin/ralph-hero/skills/scouts/SKILL.md`, `plugin/ralph-hero/agents/scouts-agent.md`, `.github/workflows/playwright-auto.yml`. Verified by `git log main -- <path>` returning at least one commit per file.
- [ ] Fixture PR opened against `main` (head = throwaway branch, base = `main`); PR URL recorded in the evidence section.
- [ ] `playwright-auto.yml` workflow ran for the fixture PR (workflow run URL/ID recorded). Run logs show the heuristic returned `is_ui=true` and the idempotency search returned zero existing issues, then `gh issue create` succeeded.
- [ ] Exactly one `scout-auto` labeled issue was created. Issue body contains `<!-- scout-pr: NNN -->` on its own line AND `scout-pr/NNN` plain-text marker. Issue URL recorded.
- [ ] Idempotency proven empirically: a follow-up commit pushed to the same fixture PR triggers a second `synchronize` workflow run, which logs `skipping: open scout-auto issue exists for PR <N>` and does NOT create a second `scout-auto` issue. Both workflow run URLs recorded.
- [ ] Director classified the `scout-auto` issue (either via natural tick of an active Director instance OR via manual `/ralph-hero:director --issue NNN`). Director's dispatch log/output names the scouts team via the `event-classes.md:29` automation-label row.
- [ ] scouts-agent ran (skill invocation recorded; either via Director dispatch OR manual `/ralph-hero:scouts --issue NNN`). The scouts skill dispatched at least `/ralph-playwright:a11y-scan` (always-fire path). Run completed and posted a `## Scout Report` comment on the fixture PR.
- [ ] `## Scout Report` PR comment exists on the fixture PR. The comment body contains a parseable `Verdict:` line with a value of `GREEN`, `YELLOW`, or `RED`. The comment URL is recorded.
- [ ] `ralph-merge` Step 4b consumed the verdict correctly: with `Verdict: GREEN`, the gate passed (Step 4b.3 first or second bullet). The ralph-merge invocation log is recorded. The RED-blocks branch is documented from `ralph-merge/SKILL.md:259-267` but NOT exercised (per Constraint 6).
- [ ] `## Validation Evidence` section appended to `thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` (creating the file as a stub if it does not exist — see Constraint 7) with: PR URL, both workflow run URLs, `scout-auto` issue URL, Scout Report comment URL, ralph-merge gate output, and a 1–2 sentence summary of any deviation from expected behavior.
- [ ] Cleanup complete: fixture PR is `CLOSED` (state, NOT merged); `scout-auto` issue is `CLOSED` with a comment linking to the evidence section. Fixture branch deletion is optional.
- [ ] No new files committed to `main` outside `thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` (the evidence destination). `git log --since=<plan-start> main -- plugin/ .github/ CLAUDE.md` shows zero new commits.

## What We're NOT Doing

- Not modifying the producer workflow, the scouts skill, the heuristic, or the Director taxonomy (Phases 1–4 — blocker prerequisites).
- Not authoring a separate validation harness — this validation is intentionally manual per the issue Research Notes.
- Not exercising a RED-blocks case unless real failures occur naturally (per Constraint 6 / issue Acceptance Criteria explicit note).
- Not backfilling closed PRs — out of scope per the epic body.
- Not building a preview-deployment pipeline — out of scope per the epic body.
- Not migrating the closed loop into a CI assertion that runs on every PR — this is a one-shot validation; if regressions are observed later, file a separate issue for automation.
- Not merging the fixture PR. Closing without merge is part of acceptance.
- Not editing this child plan after writing it — observations append to the parent epic plan (`2026-05-18-GH-1314-...`), not this file.
- Not creating any persistent `*.tsx`/`*.svelte`/etc. files in the repo — the fixture file lives only on the throwaway branch.

## Implementation Approach

Single phase. Manual observation pipeline with 8 sequential tasks. Each task is a small, mechanically-verifiable step that the impl-agent (or a human running this plan) can execute and record artifacts for.

Fixture file choice: the repo contains no `*.tsx`/`*.svelte`/`*.vue`/`*.css`/`*.scss` files (`find . -type f \( -name '*.tsx' -o -name '*.svelte' -o -name '*.vue' -o -name '*.css' -o -name '*.scss' \) | head -1` returns empty at planning time). The heuristic also matches paths under `/components/` or `/storybook/`. The chosen fixture is a new file at `plugin/ralph-hero/components/fixture-scout-validation.md` — the `/components/` path segment guarantees the heuristic returns 0 (match), the `.md` extension keeps it a docs file with zero behavior impact, and the path under `plugin/ralph-hero/` keeps it scoped to a place reviewers will recognize as throwaway. Alternative: a `*.css` file containing a single CSS comment — pick whichever the impl-agent prefers; the acceptance criteria only require that the heuristic matches.

Task order (1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8). Each task waits for the prior task's artifact to exist before proceeding.

---

## Phase 1: Self-host validation — open fixture PR, observe full scout timeline, record evidence

- **depends_on**: [GH-1317, GH-1318, GH-1319, GH-1320]

### Overview

Run the end-to-end closed loop manually: create a fixture PR with a UI-matching file, watch the producer fire, watch Director classify, watch scouts run, watch ralph-merge gate consume the verdict. Record everything in a `## Validation Evidence` section appended to the parent epic plan. Close the fixture PR and clean up.

### Tasks

#### Task 1.1: Verify Phase 1–4 are merged to `main`

- **files**: `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` (read), `plugin/ralph-hero/skills/scouts/SKILL.md` (read), `plugin/ralph-hero/agents/scouts-agent.md` (read), `.github/workflows/playwright-auto.yml` (read), `plugin/ralph-hero/skills/director/event-classes.md` (read), `CLAUDE.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `test -f plugin/ralph-hero/scripts/shared/ui-heuristic.sh` exits 0.
  - [ ] `test -f plugin/ralph-hero/skills/scouts/SKILL.md` exits 0.
  - [ ] `test -f plugin/ralph-hero/agents/scouts-agent.md` exits 0.
  - [ ] `test -f .github/workflows/playwright-auto.yml` exits 0.
  - [ ] `grep -F 'ralph-hero:scouts | live' plugin/ralph-hero/skills/director/event-classes.md` returns at least 1 match (Phase 4 taxonomy flip applied).
  - [ ] `grep -c 'scouts-agent' CLAUDE.md` returns ≥ 1 (Phase 4 docs flip applied).
  - [ ] If any of the above fail, impl-agent emits `IMPL BLOCKED needs=phase-1-2-3-or-4-not-yet-merged-to-main` and stops. Do NOT proceed to fixture PR creation — validating against an incomplete chain would produce useless evidence.

#### Task 1.2: Create fixture branch and PR

- **files**: `plugin/ralph-hero/components/fixture-scout-validation.md` (create on throwaway branch only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new branch is created from `main` named `fixture/gh-1321-scout-validation-YYYYMMDD` (replace `YYYYMMDD` with today's date for traceability).
  - [ ] A new file is committed on the branch at `plugin/ralph-hero/components/fixture-scout-validation.md` containing a single-line markdown body (e.g., `Fixture file for GH-1321 self-host validation. Safe to delete.`). The `/components/` path segment is what triggers the UI heuristic.
  - [ ] The branch is pushed: `git push -u origin fixture/gh-1321-scout-validation-YYYYMMDD`.
  - [ ] A PR is opened against `main` via `gh pr create --base main --head fixture/gh-1321-scout-validation-YYYYMMDD --title "[FIXTURE] GH-1321 scout self-host validation" --body "<body referencing this plan; explicitly marks PR as non-merging>"`.
  - [ ] PR is opened as a non-draft (the producer workflow's `if: github.event.pull_request.draft == false` requires non-draft per Phase 3 plan task 1.1).
  - [ ] The PR URL and number are recorded for use by subsequent tasks (e.g., write to a scratch file at `/tmp/gh-1321-evidence.env`).

#### Task 1.3: Observe playwright-auto.yml workflow run #1 + scout-auto issue creation

- **files**: (no file edits; observes GitHub API)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Within 5 minutes of PR creation, a workflow run for `playwright-auto.yml` appears in `gh run list --workflow=playwright-auto.yml --branch=fixture/gh-1321-scout-validation-YYYYMMDD`. Run URL/ID recorded.
  - [ ] The workflow run completes successfully (`conclusion = success`).
  - [ ] Run logs show: heuristic returned UI-touching (`is_ui=true` step output), idempotency search returned zero existing issues (`skip=false` step output), `gh issue create` succeeded with a `[playwright-auto] created scout-auto issue #<N> for PR <P>` log line.
  - [ ] Exactly ONE new issue exists with the `scout-auto` label that links to this fixture PR. Found via: `gh issue list --label scout-auto --search "scout-pr/<PR_NUMBER>" --state open --json number,title,url`. Issue number recorded.
  - [ ] The issue body contains the HTML-comment marker `<!-- scout-pr: <PR_NUMBER> -->` on its own line. Verified by `gh issue view <ISSUE_NUMBER> --json body --jq '.body' | head -n 1` returning the literal marker.
  - [ ] The issue body contains the plain-text marker `scout-pr/<PR_NUMBER>` on its own line. Verified by `gh issue view <ISSUE_NUMBER> --json body --jq '.body' | grep -c '^scout-pr/'` returning ≥ 1.

#### Task 1.4: Prove idempotency — push follow-up commit, verify no second issue

- **files**: `plugin/ralph-hero/components/fixture-scout-validation.md` (modify on throwaway branch only)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] On the same fixture branch, the fixture markdown file is modified (e.g., add a second line `Idempotency-test commit.`) and pushed: `git commit -am 'fixture: idempotency-test commit' && git push`.
  - [ ] Within 5 minutes, a second workflow run for `playwright-auto.yml` appears (triggered by `synchronize`). Run URL/ID recorded.
  - [ ] The second run completes successfully (`conclusion = success`).
  - [ ] Second-run logs contain the literal line `[playwright-auto] skipping: open scout-auto issue exists for PR <N> (#<existing>)` (per `2026-05-19-GH-1319-...md` Task 1.1 acceptance criteria).
  - [ ] The count of open `scout-auto` issues matching `scout-pr/<PR_NUMBER>` remains exactly 1. Verified by `gh issue list --label scout-auto --search "scout-pr/<PR_NUMBER>" --state open --json number --jq 'length'` returning `1`.
  - [ ] No new issue was created between Task 1.3 and Task 1.4. The issue number from Task 1.3 matches the only matching issue post-Task-1.4.

#### Task 1.5: Observe Director classification and scouts-agent dispatch

- **files**: (no file edits; observes Skill invocations and PR comments)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Either a passive observation OR an explicit dispatch is performed:
    - **Passive path**: If a Director instance is already running (`/ralph-hero:director` in a loop or autopilot), wait up to 15 minutes and observe its `next_actions` query pick up the new `scout-auto` issue.
    - **Active path**: Invoke `/ralph-hero:director --issue <ISSUE_NUMBER>` (where `<ISSUE_NUMBER>` is the scout-auto issue from Task 1.3). The Director output MUST show classification via the `scout-auto` automation-label row (matches `event-classes.md:29`, mapping to `ralph-hero:scouts`).
  - [ ] Director's dispatch log/output contains a `Skill("ralph-hero:scouts", "<ISSUE_NUMBER>")` invocation (or the underlying scouts-agent dispatch). Recorded for evidence.
  - [ ] scouts-agent (or `/ralph-hero:scouts`) runs and produces output. The skill dispatches at least `/ralph-playwright:a11y-scan` (per Phase 2 plan Task 1.1 acceptance: a11y-scan is always-fire). If conditional skills fire (`test-e2e`/`storybook-test`/`visual-diff` based on detected artifacts), record which ones and why.
  - [ ] When scouts completes, a new comment exists on the fixture PR (NOT the `scout-auto` issue) whose body starts with `## Scout Report` and contains a `Verdict:` line with value `GREEN`, `YELLOW`, or `RED`. Comment URL recorded.
  - [ ] Verified by `gh pr view <PR_NUMBER> --json comments --jq '.comments[] | select(.body | startswith("## Scout Report")) | .url'` returning at least one URL.
  - [ ] Verified by `gh pr view <PR_NUMBER> --json comments --jq '.comments[] | select(.body | startswith("## Scout Report")) | .body' | grep -iE 'Verdict: (GREEN|YELLOW|RED)'` returning at least one match.

#### Task 1.6: Exercise ralph-merge Step 4b Scout Report Gate

- **files**: (no file edits; runs ralph-merge against fixture PR)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.5]
- **acceptance**:
  - [ ] Invoke `/ralph-hero:ralph-merge` (or `just merge <PR_NUMBER>` / `gh pr view` based ralph-merge dispatch) against the fixture PR. Since the PR will NOT actually merge (it is a fixture), the goal is to observe Step 4b output ONLY, then stop the merge before Step 5.
  - [ ] ralph-merge Step 4b.1 detects the `## Scout Trigger` comment (posted by ralph-pr's existing producer at `ralph-pr/SKILL.md:367-417`) — confirmed by Step 4b output mentioning `HAS_TRIGGER >= 1`.
  - [ ] ralph-merge Step 4b.2 detects the `## Scout Report` comment from Task 1.5 — confirmed by Step 4b output computing `HAS_GREEN_VERDICT >= 1` if the verdict was GREEN.
  - [ ] **GREEN positive case (REQUIRED):** If Task 1.5's verdict was GREEN, Step 4b.3 evaluates to PASS (per `ralph-merge/SKILL.md:258`: "If any comment contains `## Scout Report` AND `Verdict: GREEN` (case-insensitive on `GREEN`): PASS — Scout approved. Proceed to Step 5."). Step 4b.3 output recorded.
  - [ ] **YELLOW/RED case (OBSERVE-ONLY):** If Task 1.5's verdict was YELLOW or RED, document the gate output as observed (RED triggers a `MERGE BLOCKED — Scout review required` per `ralph-merge/SKILL.md:259-267`). Do not retry or attempt to flip the verdict (per Constraint 6).
  - [ ] **Stop before Step 5.** ralph-merge MUST NOT attempt to actually merge the fixture PR. Either Ctrl-C / cancel ralph-merge after Step 4b output is observed, OR run ralph-merge in a mode that stops after gate evaluation. If ralph-merge has no such mode, the cleanest path is: skip the actual `gh pr merge` invocation by running only Step 4b's bash logic (`PR_COMMENTS=$(gh pr view <PR> --json comments --jq '.comments[].body')` + the grep checks from `ralph-merge/SKILL.md:230,248-252`) — this exercises the exact gate logic without invoking the full skill.
  - [ ] The gate output (PASS/BLOCK decision + the four grep counters from Step 4b.2: `HAS_GREEN`, `HAS_GREEN_VERDICT`, `HAS_OVERRIDE`, `HAS_RED`) is recorded for evidence.

#### Task 1.7: Append `## Validation Evidence` to parent epic plan

- **files**: `thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` (modify if exists; create stub if missing — per Constraint 7)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4, 1.6]
- **acceptance**:
  - [ ] If `thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` does NOT exist, create it as a minimal stub with: frontmatter (`date: 2026-05-18`, `status: validated`, `type: plan`, `github_issue: 1314`, `primary_issue: 1314`, `tags: [scouts, playwright, director, epic]`), a title `# Wire ralph-playwright into Director→Teams — Epic Plan-of-Plans (Reconstructed Stub)`, a 1–2 sentence note that the original plan-of-plans was missing on disk and this stub was created post-hoc to host validation evidence, and pointers to all five child plans (GH-1317, GH-1318, GH-1319, GH-1320, this plan).
  - [ ] Append a `## Validation Evidence` section to the parent plan containing AT MINIMUM these fields (each on its own line or in a definition list):
    - **Validated by**: `GH-1321` (link to this plan)
    - **Validation date**: `YYYY-MM-DD` (run date)
    - **Fixture PR**: URL and number from Task 1.2
    - **Fixture branch**: branch name (e.g., `fixture/gh-1321-scout-validation-YYYYMMDD`)
    - **Workflow run #1 (opened)**: URL/ID from Task 1.3
    - **Workflow run #2 (synchronize, idempotency-test)**: URL/ID from Task 1.4
    - **scout-auto issue**: URL and number from Task 1.3
    - **Scout Report comment**: URL from Task 1.5
    - **Verdict observed**: `GREEN | YELLOW | RED`
    - **Conditional skills fired**: list from Task 1.5 (e.g., `a11y-scan only` or `a11y-scan + test-e2e`)
    - **Director dispatch path**: `passive (autopilot)` or `active (manual /director --issue NNN)`
    - **Step 4b gate output**: literal output from Task 1.6 (PASS/BLOCK decision + counter values)
    - **Deviations observed**: 1–3 sentences describing anything that did not match expected behavior (or `None.` if all clean)
    - **RED-blocks branch**: explicitly note "Not exercised; documented from `ralph-merge/SKILL.md:259-267` per issue Acceptance Criteria"
  - [ ] The section is the LAST top-level section of the parent plan document (appended, not interleaved).
  - [ ] The section is committed to `main` (`git add` the parent plan, `git commit -m "docs(plan): GH-1321 validation evidence for GH-1314 epic" && git push origin main`).

#### Task 1.8: Cleanup — close fixture PR and scout-auto issue

- **files**: (no file edits; runs `gh` commands)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.7]
- **acceptance**:
  - [ ] The fixture PR is closed without merging: `gh pr close <PR_NUMBER> --comment "Fixture PR for GH-1321 self-host validation. Evidence recorded in thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md ## Validation Evidence. Closing without merge."`.
  - [ ] Verified by `gh pr view <PR_NUMBER> --json state,merged --jq '.state'` returning `CLOSED` and `.merged` returning `false`.
  - [ ] The `scout-auto` issue from Task 1.3 is closed with a comment linking to the evidence: `gh issue close <ISSUE_NUMBER> --comment "Closed after self-host validation. Evidence: <permalink to ## Validation Evidence section>."`.
  - [ ] Verified by `gh issue view <ISSUE_NUMBER> --json state --jq '.state'` returning `CLOSED`.
  - [ ] Optional: delete the fixture branch (`git push origin --delete fixture/gh-1321-scout-validation-YYYYMMDD` and `git branch -D fixture/gh-1321-scout-validation-YYYYMMDD`). If left undeleted, that is acceptable — it's a throwaway branch and does not affect `main`.

### Phase Success Criteria

#### Automated Verification:

- [ ] `test -f .github/workflows/playwright-auto.yml && test -f plugin/ralph-hero/skills/scouts/SKILL.md && test -f plugin/ralph-hero/agents/scouts-agent.md && test -f plugin/ralph-hero/scripts/shared/ui-heuristic.sh` exits 0 (all four Phase 1–4 source files exist).
- [ ] `grep -c '## Validation Evidence' thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` returns ≥ 1 (evidence section appended).
- [ ] `grep -cE 'Verdict: (GREEN|YELLOW|RED)' thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` returns ≥ 1 (verdict recorded).
- [ ] `grep -cE 'Workflow run #(1|2)' thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` returns ≥ 2 (both run URLs recorded).
- [ ] `grep -c 'scout-auto issue' thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` returns ≥ 1 (issue URL recorded).
- [ ] `git diff --stat main HEAD` shows only the parent epic plan changed during this phase's commit (no `plugin/`, `.github/`, or `CLAUDE.md` changes from this phase).
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` continues to pass (regression: no MCP changes here, but worth running as a sanity check).

#### Manual Verification:

- [ ] A human reviewer reads the `## Validation Evidence` section and can follow each linked artifact (PR, workflow runs, scout-auto issue, Scout Report comment) to its source on GitHub. All links resolve.
- [ ] The fixture PR is closed (not merged) and its branch is either deleted or visibly marked throwaway by name.
- [ ] The scout-auto issue created during validation is closed with a clear back-pointer to the evidence section.
- [ ] No accidental commits to `main` outside the parent epic plan. `git log --oneline --since=<plan-start>` shows only the evidence commit from Task 1.7.
- [ ] Reading `ralph-merge/SKILL.md:248-258` side-by-side with the recorded Step 4b output, a reviewer can confirm the literal grep counters match the verdict observed (e.g., GREEN observed → `HAS_GREEN_VERDICT >= 1` recorded).

**Creates for next phase**: A validated closed-loop. The parent epic (GH-1314) can move to `Done` with evidence; the producer→Director→scouts→merge chain is proven to work end-to-end with real GitHub events.

---

## Integration Testing

This phase IS the integration test — the entire phase is one long-form integration scenario against live GitHub infrastructure. There is no separate integration test step. Bounded sanity checks:

- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (regression — no MCP changes in this phase).
- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` passes (regression — heuristic unchanged).
- [ ] `bash plugin/ralph-hero/scripts/playwright-auto-smoke.sh` passes (regression — workflow producer unchanged; smoke covers the bash logic in isolation).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1321
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1314
- Sibling Phase 1 (heuristic): #1317 — `thoughts/shared/plans/2026-05-19-GH-1317-extract-shared-ui-heuristic.md`
- Sibling Phase 2 (scouts skill): #1318 — `thoughts/shared/plans/2026-05-19-GH-1318-scouts-team-skill.md`
- Sibling Phase 3 (per-PR producer): #1319 — `thoughts/shared/plans/2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow.md`
- Sibling Phase 4 (taxonomy + docs flip): #1320 — `thoughts/shared/plans/2026-05-19-GH-1320-mark-scouts-live-docs.md`
- Evidence destination (parent epic plan, may need stub creation): `thoughts/shared/plans/2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md`
- ralph-merge Step 4b Scout Report Gate (the load-bearing consumer): `plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276`
- ralph-pr Scout Trigger producer (existing parallel channel): `plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417`
- Director taxonomy (consumes `scout-auto` label): `plugin/ralph-hero/skills/director/event-classes.md:29`
- Idempotency pattern source (search-then-create): `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:206-246`
- Phase 3 plan idempotency-log line (Task 1.4 acceptance source): `thoughts/shared/plans/2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow.md` Task 1.1
