---
date: 2026-05-16
status: draft
type: plan
github_issue: 1273
github_issues: [1273]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1273
primary_issue: 1273
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [scouts, soul, pr-agent, merge-agent, scheduling, playwright, ui-validation]
---

# Feature F: Scout scheduling (on-PR + nightly) — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-16-unified-agent-system-architecture]]

## Overview

Single atomic feature (GH-1273) implemented as four sequential phases inside one PR. Moves the Scout team from manual-only (`/test-e2e`) invocation to automatic: PR-triggered scout reports on UI-touching changes, plus a nightly sweep against the latest deployed build. Also authors the Scout SOUL.md body that Feature A (GH-1268) left as a curious-mischievous stub.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1273 | Scouts SOUL.md authored body | XS |
| 2 | GH-1273 | pr-agent emits `/scout` trigger comment on UI-touching PRs | S |
| 3 | GH-1273 | merge-agent gates UI-touching PRs on green Scout report | S |
| 4 | GH-1273 | Nightly Scout sweep registered via `/schedule` + taxonomy patch | XS |

**Why grouped**: All four atomics share the Scouts team contract — the SOUL voice authored in Phase 1 is referenced by the trigger comment in Phase 2 (so the comment carries the team's voice), the merge gate in Phase 3 reads the Scout report posted in response to Phase 2's trigger, and the nightly schedule in Phase 4 invokes the same `/test-e2e` skill the on-PR path uses. Shipping them in a single PR keeps the Scouts contract (voice + heuristic + gate + cadence) atomic and reviewable as one unit. The taxonomy edit in Phase 4 is small enough that the plan-of-plans explicitly allows it to ship inline rather than blocking on Feature B.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`2026-05-16-GH-1267-unified-agent-system-epic.md` § Shared Constraints). The constraints most load-bearing for this feature:

1. **No new runtime layers.** GitHub Projects V2 is the only event bus. The nightly Scout sweep is a `/schedule` cron routine, NOT a new daemon. The `/scout-on-pr` trigger is a comment posted by `pr-agent`, NOT a webhook.
2. **Skill / agent surface conventions.** No new orchestrator skills land in this feature — the Scout team already exists under `plugin/ralph-playwright/skills/`. SOUL goes under `plugin/ralph-hero/skills/scouts/SOUL.md` (matching Feature A's stub location).
3. **SOUL files use the fixed schema from Feature A.** Frontmatter `team: scouts`, `voice: curious-mischievous`, `refuses: [list]`. Body covers "How you talk" + at least one Bad/Good exchange. Length target: ~150-250 words of body prose. The SessionStart hook (`load-team-soul.sh` from Feature A) loads it when `$RALPH_COMMAND` resolves to a scouts entrypoint.
4. **Style inheritance.** Scouts SOUL inherits `STYLE.md` mechanics (file paths, link format, comment headers); SOUL only governs voice and refusals.
5. **iOS-friendly artifacts.** Scout reports must be pushable to Drive (handled by ralph-playwright's existing post-execute step); on-PR trigger comments are short enough to read on iOS without Drive.
6. **Remote-trigger contract.** This feature does NOT add a new `trigger:scout` label — the on-PR path is automatic (pr-agent decides via the heuristic) and the nightly path is `/schedule`-driven. Manual `/test-e2e` invocation remains the human-initiated path.
7. **Outcome recording is automatic.** Scout report terminal handlers (in ralph-playwright) call `knowledge_record_outcome` via the outcome-recorder wrapper from Feature E (GH-1272). This feature does NOT add outcome recording — it relies on E to provide it. If E hasn't landed when F merges, the gap is acceptable (the report still gets posted; the outcome just doesn't get recorded).
8. **Verification tooling.** `npm test` from `plugin/ralph-hero/mcp-server/` for unit tests; `cd plugin/ralph-hero/mcp-server && npm run build` for typecheck of any TypeScript touched; shell smoke scripts under `plugin/ralph-hero/scripts/` for hook-shaped verification.
9. **Atomicity.** All four phases are XS or S — no phase grows into M during planning. The merge-agent gate (Phase 3) is the largest and is still S because it only adds one bash block to an existing decision tree.
10. **No OpenClaw runtime.** Borrow the SOUL convention for Scouts; do not adopt any OpenClaw skills or infrastructure.

Feature-specific constraints (not in parent plan):

11. **UI-touching heuristic must be conservative.** The pr-agent heuristic decides whether to post the `/scout` trigger comment. False negatives (UI PRs not flagged) are recoverable — humans can comment `/scout` manually. False positives (non-UI PRs flagged) waste Scout-team budget and slow merges. The heuristic globs MUST match `**/*.tsx`, `**/*.svelte`, `**/*.vue`, `**/components/**`, `**/*.css`, `**/*.scss`, and `**/storybook/**`. Backend-only PRs that touch none of these patterns MUST NOT be flagged.
12. **Merge gate exception for non-UI PRs.** The merge-agent gate (Phase 3) only blocks merges of PRs where the on-PR heuristic fired. Non-UI PRs (no `/scout` trigger was posted, therefore no Scout report is expected) pass through merge unchanged. This is the contract: if there's no `## Scout Report` comment AND no `/scout` trigger comment exists on the PR, the gate is a no-op.
13. **Scout report format is fixed.** Phase 3's gate reads `## Scout Report` comments on the PR. The verdict line is `Verdict: GREEN` or `Verdict: RED` or `Verdict: PENDING`. ralph-playwright's `test-e2e` skill must post comments matching this header — Phase 2 verifies the contract via smoke test.

## Current State Analysis

**Scout team exists.** `plugin/ralph-playwright/skills/` contains seven skills: `setup`, `story-gen`, `explore`, `test-e2e`, `a11y-scan`, `storybook-test`, `visual-diff`, `ux-audit`, `capture`, `reflect`, plus `browser`, `storybook-onboard`, and `storybook-review`. The `test-e2e` skill (`plugin/ralph-playwright/skills/test-e2e/SKILL.md`) is the canonical Scout entrypoint — it discovers `playwright-stories/**/*.yaml`, executes via `story-runner-agent`, aggregates a signal report, and creates GitHub issues for `critical`/`high` severity findings.

**Scouts SOUL.md does not exist on disk.** The parent plan's Feature A description lists `scouts/SOUL.md` as one of the five team SOUL files Feature A will create (as a stub for Wave 2 features to fill in). The sibling-context note confirms: "SOUL.md stub already exists at plugin/ralph-hero/skills/scouts/SOUL.md (curious-mischievous stub). … this feature replaces the scouts/SOUL.md stub with full body content." When Feature F implementation begins, the stub MUST exist (Feature A is a Wave-1 dependency); if it does not exist at impl time, Phase 1 creates the file from scratch using the Feature A schema (`plugin/ralph-hero/skills/shared/soul-schema.md`).

**pr-agent today is minimal.** `plugin/ralph-hero/agents/pr-agent.md` is a one-line skill delegation to `ralph-pr`. The pr-agent's behavior lives in `plugin/ralph-hero/skills/ralph-pr/SKILL.md`, which pushes the branch, creates the PR, moves the issue to "In Review", and posts a comment. The skill has 8 numbered steps; Phase 2 adds Step 7.5 (between "Move Issues to In Review" and "Post Comment") that evaluates the UI-touching heuristic and posts a `## Scout Trigger` comment.

**merge-agent has a review decision gate.** `plugin/ralph-hero/skills/ralph-merge/SKILL.md` Step 4 already has a review-decision guard (APPROVED / CHANGES_REQUESTED / null with XS exception). Phase 3 adds a sibling guard immediately before Step 5 that checks for a Scout Report when the on-PR heuristic fired.

**/schedule is a built-in skill, not a ralph-hero skill.** No `plugin/ralph-hero/skills/schedule/` directory exists. The system surfaces `/schedule` as part of the harness skill list. The nightly Scout sweep registration in Phase 4 invokes `/schedule create` via the harness, not via a ralph-hero MCP tool.

**Event-class taxonomy is created by Feature B (GH-1269).** The parent plan describes `event-classes.md` as a Feature B deliverable at `plugin/ralph-hero/skills/director/event-classes.md`. When Feature F (this plan) lands, Feature B may or may not have shipped. The plan-of-plans Integration Strategy paragraph 4 explicitly allows Feature F to ship the `scout-auto` taxonomy edit inline. Phase 4 handles both cases:
- If `event-classes.md` exists, append the `scout-auto` row.
- If it does not exist, create the file with a minimal one-row schema and leave a header comment that Feature B will extend it.

**Existing pr-agent and merge-agent tool allowlists.** `pr-agent.md` already has `create_comment` in its tools list. `merge-agent.md` does NOT need new tools — it only needs to read existing PR comments via `gh pr view --json comments`. No tool-allowlist changes required.

## Desired End State

### Verification

- [ ] `plugin/ralph-hero/skills/scouts/SOUL.md` exists with the Feature A schema (frontmatter + How-you-talk + Bad/Good example). Body length 150-250 words.
- [ ] `pr-agent` posts a `## Scout Trigger` comment with body `/scout` on PRs whose changed-files match the UI heuristic. Backend-only PRs receive no comment.
- [ ] `merge-agent` blocks merge with `MERGE BLOCKED — Scout review required` when a UI-touching PR has a `## Scout Trigger` comment but no `## Scout Report: Verdict: GREEN`. Non-UI PRs (no trigger comment) merge unchanged.
- [ ] `/schedule list` shows a `scout-nightly` routine. The routine runs `/ralph-playwright:test-e2e` against the latest deployed build URL. Scout findings get filed as GitHub issues with the `scout-auto` label (existing test-e2e behavior, augmented with the label).
- [ ] `plugin/ralph-hero/skills/director/event-classes.md` lists `scout-auto` in its label-to-team taxonomy (or the file is created with that one row if Feature B hasn't landed).
- [ ] Manual `/ralph-playwright:test-e2e` invocation works unchanged — no regression.

## What We're NOT Doing

- Authoring any new Scout skill (a11y-scan, story-runner-agent, etc. already exist).
- Building the Director skill (Feature B / GH-1269).
- Implementing the outcome-recorder wrapper (Feature E / GH-1272). Scout report terminal handlers will call it once E lands; until then they no-op.
- Adding a `trigger:scout` label (parent plan's remote-trigger contract — separate feature for label-driven dispatch via Director).
- Authoring SOUL files for other teams (watchers, builders, memorykeepers, caretakers) — those land via Feature A's stub creation, with bodies filled by their respective team features (C, G).
- Adding iOS-specific behavior (Feature H / GH-1275 owns ntfy + gdrive-push wiring for Scout reports).
- Auto-failing PRs on Scout RED. RED only blocks merge; humans can override by posting an explicit `## Scout Report: Verdict: GREEN (override)` comment. This is the existing pattern from the parent plan's manual-override clause.

## Implementation Approach

Phase 1 lands the SOUL body (text-only change, no agent code). Phase 2 adds the on-PR heuristic + trigger-comment posting in `ralph-pr/SKILL.md`. Phase 3 adds the merge-time check in `ralph-merge/SKILL.md` that reads PR comments. Phase 4 registers the nightly schedule and patches (or creates) the taxonomy file.

**Phase dependency annotations**: Phase 1 is independent (no dependencies on other phases in this plan, depends on Feature A's stub existing). Phases 2 and 3 are conceptually paired (the trigger and the gate) but can be implemented sequentially — Phase 3 depends on Phase 2 for the trigger-comment contract. Phase 4 depends on nothing in this plan and could run first; sequenced last because the taxonomy edit benefits from seeing the trigger-comment naming convention land first.

---

## Phase 1: Author Scouts SOUL.md body
- **depends_on**: null

### Overview

Replace the curious-mischievous stub at `plugin/ralph-hero/skills/scouts/SOUL.md` with a fully authored body (~150-250 words) covering How-you-talk + one Bad/Good exchange. Voice: curious, slightly mischievous, refuses to file flaky findings without evidence.

### Tasks

#### Task 1.1: Replace SOUL.md body with authored content
- **files**: `plugin/ralph-hero/skills/scouts/SOUL.md` (modify if stub exists; create if Feature A hasn't shipped)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/scouts/SOUL.md`
  - [ ] Frontmatter contains `team: scouts`, `voice: curious-mischievous`, `refuses: [...]` (refusal list non-empty; minimum: flaky tests without retries, claims without screenshots, mass-filing without dedup)
  - [ ] Body contains a `## How you talk` section (2-4 sentences describing tone)
  - [ ] Body contains at least one `## Example exchange` with a "Bad" and "Good" pair
  - [ ] Body word count between 150 and 250 words (rough — measured by `wc -w` on the body, excluding frontmatter)
  - [ ] If Feature A's `plugin/ralph-hero/skills/shared/soul-schema.md` exists, the frontmatter shape matches it; if not, follow the parent plan's documented schema (Constraint 3)

### Phase Success Criteria

#### Automated Verification:
- [x] `wc -w plugin/ralph-hero/skills/scouts/SOUL.md` — body section is in the 150-250 word range (excluding frontmatter)
- [x] `head -20 plugin/ralph-hero/skills/scouts/SOUL.md` shows valid YAML frontmatter that parses (no broken keys)

#### Manual Verification:
- [ ] Bad/Good example reads naturally and demonstrates the scouts voice
- [ ] Refusal list reads as enforceable (not "be careful", but "refuse if X")

**Creates for next phase**: A canonical Scout voice that Phase 2's trigger-comment can reference (the comment links to the SOUL file so reviewers see why the Scout team gets invoked).

---

## Phase 2: pr-agent posts `/scout` trigger on UI-touching PRs
- **depends_on**: [phase-1]

### Overview

Add a new step to `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (between current Step 6 "Move Issues to In Review" and Step 7 "Post Comment") that evaluates the UI-touching heuristic and posts a `## Scout Trigger` comment on the PR when the heuristic fires.

### Tasks

#### Task 2.1: Add UI-heuristic evaluation step to ralph-pr/SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New step "Step 6.5: Evaluate UI-Touching Heuristic" added between "Step 6: Move Issues to In Review" and "Step 7: Post Comment"
  - [ ] Step uses `gh pr diff PR_NUMBER --name-only` to get changed file paths
  - [ ] Heuristic returns true when ANY changed file matches one of: `**/*.tsx`, `**/*.svelte`, `**/*.vue`, `**/components/**`, `**/*.css`, `**/*.scss`, `**/storybook/**`
  - [ ] Step is documented as a no-op when zero matches (no comment posted, no error)
  - [ ] Step is documented with a `<!-- internal: ... -->` comment explaining why the heuristic is conservative (avoid blocking backend PRs)

#### Task 2.2: Post `## Scout Trigger` comment when heuristic fires
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify, same edit as 2.1)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] When heuristic fires, the step invokes `gh pr comment PR_NUMBER --body "..."` with a comment using header `## Scout Trigger`
  - [ ] Comment body contains the literal trigger phrase `/scout` on its own line so a future Director / Scout runner can match it
  - [ ] Comment body links to `plugin/ralph-hero/skills/scouts/SOUL.md` so reviewers see the team's voice
  - [ ] Comment body lists the matched file globs (so the user sees why their PR got flagged)
  - [ ] Failure of the `gh pr comment` call is logged but does NOT fail the PR creation flow (advisory, not blocking)

#### Task 2.3: Smoke test the heuristic
- **files**: `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Script accepts a space-separated list of file paths as stdin or argv and prints `MATCH` or `NO_MATCH`
  - [ ] Test cases assert: `src/components/Button.tsx` → MATCH; `src/pages/index.svelte` → MATCH; `src/styles/main.css` → MATCH; `mcp-server/src/tools/issue-tools.ts` → NO_MATCH; `README.md` → NO_MATCH; empty input → NO_MATCH
  - [ ] Script exits 0 on test pass, 1 on test fail
  - [ ] Script mirrors the shape of existing `plugin/ralph-hero/scripts/cos/smoke.sh` and `self-improve-smoke.sh`

### Phase Success Criteria

#### Automated Verification:
- [x] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` — passes all test cases, exits 0
- [x] `grep -n "Step 6.5" plugin/ralph-hero/skills/ralph-pr/SKILL.md` — confirms step header present
- [x] `grep -n "## Scout Trigger" plugin/ralph-hero/skills/ralph-pr/SKILL.md` — confirms comment header in heredoc

#### Manual Verification:
- [ ] Open a test PR touching `src/components/Foo.tsx`; verify `## Scout Trigger` comment appears
- [ ] Open a test PR touching only `mcp-server/src/tools/issue-tools.ts`; verify no comment appears
- [ ] PR creation itself is not blocked if the `gh pr comment` call fails (network test: revoke gh auth, retry, verify PR still gets created)

**Creates for next phase**: A `## Scout Trigger` comment header convention that Phase 3's merge gate reads to decide whether to look for a Scout Report.

---

## Phase 3: merge-agent gates UI-touching PRs on green Scout report
- **depends_on**: [phase-2]

### Overview

Add a new sub-step to `plugin/ralph-hero/skills/ralph-merge/SKILL.md` Step 4 (immediately after the existing review-decision guard) that, when a `## Scout Trigger` comment is present on the PR, requires a corresponding `## Scout Report: Verdict: GREEN` comment before allowing merge.

### Tasks

#### Task 3.1: Add Scout-report gate to ralph-merge/SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New sub-step "Step 4b: Scout Report Gate (UI-touching PRs only)" added immediately after the existing Step 4 review-decision guard
  - [ ] Step reads PR comments via `gh pr view PR_NUMBER --json comments --jq '.comments[].body'`
  - [ ] Step is a no-op if no comment body starts with `## Scout Trigger` (backend PR — pass through)
  - [ ] Step looks for any comment containing `## Scout Report` AND `Verdict: GREEN` (case-insensitive on the verdict word, exact-match on header) — pass if found
  - [ ] Step looks for any comment containing `Verdict: GREEN (override)` — pass (human override)
  - [ ] Step blocks (output `MERGE BLOCKED — Scout review required`, exit) if `## Scout Trigger` present but no GREEN verdict found
  - [ ] Step blocks if a `## Scout Report` exists with `Verdict: RED` and no override comment

#### Task 3.2: Document the Scout-report contract in ralph-merge/SKILL.md
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify, same edit as 3.1)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Sub-step header includes the output-contract table format used elsewhere in ralph-merge (status / meaning / caller action)
  - [ ] New status string `MERGE BLOCKED — Scout review required` documented in that table with caller action "Run `/ralph-playwright:test-e2e` against the PR's preview build, then post `## Scout Report: Verdict: GREEN`"

#### Task 3.3: Smoke test the gate
- **files**: `plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Script accepts a JSON array of comment bodies on stdin and prints `PASS`, `BLOCK_NO_REPORT`, or `BLOCK_RED`
  - [ ] Test cases: no comments → PASS (no trigger); `[{body: "## Scout Trigger\n/scout"}]` → BLOCK_NO_REPORT; trigger + GREEN report → PASS; trigger + RED report → BLOCK_RED; trigger + RED + GREEN(override) → PASS
  - [ ] Script exits 0 on test pass, 1 on test fail
  - [ ] Script mirrors the shape of `scout-heuristic-smoke.sh` from Phase 2

### Phase Success Criteria

#### Automated Verification:
- [x] `bash plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh` — passes all test cases, exits 0
- [x] `grep -n "Step 4b" plugin/ralph-hero/skills/ralph-merge/SKILL.md` — confirms sub-step header present
- [x] `grep -n "MERGE BLOCKED — Scout review required" plugin/ralph-hero/skills/ralph-merge/SKILL.md` — confirms new status string documented

#### Manual Verification:
- [ ] Open a UI-touching test PR; verify pr-agent posts `## Scout Trigger`; attempt merge without Scout Report; verify `MERGE BLOCKED — Scout review required`
- [ ] Post a `## Scout Report: Verdict: GREEN` comment manually; re-run merge-agent; verify merge proceeds
- [ ] Test override path: trigger + RED report, then add `Verdict: GREEN (override)` comment; verify merge proceeds

**Creates for next phase**: A working on-PR Scout gate. Phase 4's nightly schedule reuses the same `/scout` trigger phrase and the same `## Scout Report` format, so the report-handling contract is fully validated before Phase 4 lands.

---

## Phase 4: Nightly Scout schedule + Director taxonomy patch
- **depends_on**: [phase-3]

### Overview

Register a nightly `/schedule` routine that invokes `/ralph-playwright:test-e2e` against the latest deployed build URL. Findings get filed as GitHub issues with the `scout-auto` label (extending `test-e2e`'s existing issue-creation step). Patch (or create) `plugin/ralph-hero/skills/director/event-classes.md` to recognize `scout-auto`.

### Tasks

#### Task 4.1: Register `scout-nightly` schedule routine
- **files**: `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (create) and `plugin/ralph-hero/scripts/schedule/README.md` (create or modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `scout-nightly.sh` is the harness-executable script body the `/schedule` routine invokes
  - [ ] Script body: invokes `/ralph-playwright:test-e2e` with a `--label scout-auto` flag (Phase 4 also adds this flag to test-e2e — see Task 4.2)
  - [ ] Script reads the deployed-build URL from `RALPH_DEPLOYED_BUILD_URL` env var, with a default fallback to `http://localhost:3100` for local-only setups
  - [ ] README documents how a human installs the routine: `/schedule create scout-nightly --cron "0 3 * * *" --script plugin/ralph-hero/scripts/schedule/scout-nightly.sh`
  - [ ] README notes that `/schedule list` is how to confirm the routine is installed

#### Task 4.2: Add `--label` flag to test-e2e for auto-labeled issue creation
- **files**: `plugin/ralph-playwright/skills/test-e2e/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `test-e2e` Step 4 ("Act") documented to accept an optional `--label LABEL_NAME` flag
  - [ ] When `--label` is provided, `ralph_hero__create_issue` calls include the label in the `labels:` parameter
  - [ ] No behavior change when the flag is absent (existing manual invocations unaffected)

#### Task 4.3: Patch event-classes.md to recognize `scout-auto`
- **files**: `plugin/ralph-hero/skills/director/event-classes.md` (create if Feature B hasn't shipped, else modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/director/event-classes.md`
  - [ ] File contains a markdown table mapping `(label, workflow_state)` tuples to team names
  - [ ] Table contains a row for `scout-auto` → team `scouts`
  - [ ] If file was created by this task (Feature B hadn't shipped), header comment notes "Bootstrapped by Feature F (GH-1273); Feature B (GH-1269) will extend"
  - [ ] If file already existed, the `scout-auto` row is appended (no other rows modified)

### Phase Success Criteria

#### Automated Verification:
- [x] `test -x plugin/ralph-hero/scripts/schedule/scout-nightly.sh` — script exists and is executable
- [x] `grep -n "scout-auto" plugin/ralph-hero/skills/director/event-classes.md` — taxonomy row present
- [x] `grep -n "\\-\\-label" plugin/ralph-playwright/skills/test-e2e/SKILL.md` — flag documented

#### Manual Verification:
- [ ] Run `/schedule list` after installing the routine; verify `scout-nightly` appears with `0 3 * * *` cadence
- [ ] Run the script manually once with a known-good deployed URL; verify it invokes test-e2e and that any findings get the `scout-auto` label
- [ ] Visual review of `event-classes.md` — confirm table parses as markdown and the new row reads consistently with any pre-existing rows

**Creates for next phase**: N/A (final phase).

---

## Integration Testing

- [ ] End-to-end on-PR Scout flow: open a UI-touching PR → verify pr-agent posts `## Scout Trigger` → manually run `/ralph-playwright:test-e2e` against the PR's preview build → post `## Scout Report: Verdict: GREEN` → run merge-agent → verify merge proceeds
- [ ] End-to-end non-UI Scout flow: open a backend-only PR → verify no `## Scout Trigger` comment posted → run merge-agent → verify merge proceeds unchanged (existing flow not regressed)
- [ ] End-to-end nightly flow: install `/schedule` routine → trigger one execution manually → verify test-e2e ran against `$RALPH_DEPLOYED_BUILD_URL` → verify any findings filed with `scout-auto` label
- [ ] Override flow: open UI-touching PR → trigger fires → post `## Scout Report: Verdict: RED` → attempt merge → blocked → post `## Scout Report: Verdict: GREEN (override)` → merge proceeds
- [ ] SOUL load: invoke any Scouts-team skill (e.g., `/ralph-playwright:explore`) with `$RALPH_COMMAND=scouts` set → verify Feature A's `load-team-soul.sh` hook loads the SOUL body into the context (only verifiable once Feature A ships; smoke skipped otherwise)

## References

- Parent plan: [thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md)
- Issue: [GH-1273](https://github.com/cdubiel08/ralph-hero/issues/1273)
- Sibling Feature A (SOUL framework): [GH-1268](https://github.com/cdubiel08/ralph-hero/issues/1268)
- Existing skills modified:
  - [plugin/ralph-hero/skills/ralph-pr/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-pr/SKILL.md)
  - [plugin/ralph-hero/skills/ralph-merge/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-merge/SKILL.md)
  - [plugin/ralph-playwright/skills/test-e2e/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/test-e2e/SKILL.md)
- Existing patterns referenced:
  - `plugin/ralph-hero/skills/STYLE.md` (output style)
  - `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (comment header conventions)
  - `plugin/ralph-hero/scripts/cos/smoke.sh` (smoke-script shape)
