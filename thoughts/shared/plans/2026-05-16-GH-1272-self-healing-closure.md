---
date: 2026-05-16
status: draft
type: plan
github_issue: 1272
github_issues: [1272]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1272
primary_issue: 1272
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [self-healing, outcome-recorder, knowledge-record-outcome, terminal-handlers, dream-loop]
---

# Self-Healing Closure (Outcome-Recorder + Reflection Routing) — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-16-GH-1269-director-skill]]
- builds_on:: [[2026-04-16-GH-0761-dream-loop]]

## Overview

Single-issue plan for GH-1272 (Feature E of the Unified Agent System epic). Adds a thin `outcome-recorder` wrapper that standardizes terminal-handler → `knowledge_record_outcome` MCP calls, patches the four terminal handlers (`ralph-merge`, `ralph-pr`, `ralph-val`, `ralph-postmortem`) to invoke it on success paths, and adds an integration test asserting merge → outcome row → next-night dream-loop ingestion. Closes the merge → postmortem → ralph-knowledge → dream-loop → process-improvement cycle defined in the epic.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1272 | Feature E: Self-healing closure (outcome-recorder + reflection routing) | S |

## Shared Constraints

Inherited verbatim from parent plan-of-plans (`2026-05-16-GH-1267-unified-agent-system-epic.md`):

1. **No new runtime layers.** GitHub Projects V2 (via `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` MCP tools) is the only event bus. ralph-knowledge SQLite is the only durable memory store. No new daemons, brokers, or databases. Webhook → issue bridges are allowed only if they terminate in `create_issue`.

2. **Skill / agent surface conventions.** New shared fragments live under `plugin/ralph-hero/skills/shared/`. SKILL.md frontmatter shape (`description`, `argument-hint`, `context: inline`, `hooks`, `allowed-tools`). When patching existing skills, only add `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` to `allowed-tools` where it is not already present.

3. **SOUL files use a fixed schema.** Not applicable to this feature — Feature E ships no new team entrypoint and therefore no SOUL.md. Existing team SOULs are untouched.

4. **Style inheritance.** Patched skills continue to inherit `plugin/ralph-hero/skills/STYLE.md` and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`. The `outcome-recorder` fragment is mechanics-only and contains no voice or personality.

5. **iOS-friendly artifacts.** The outcome-recorder itself produces no user-facing artifact. Its only side effect is one row inserted into `~/.ralph-hero/knowledge.db`. No `gdrive-push` integration is required for this feature; the rows surface to iOS via `knowledge_query_outcomes` and the `outcomes_summary` field already attached to `knowledge_search` / `knowledge_recall` results.

6. **Remote-trigger contract.** Not applicable directly — Feature E does not introduce a new orchestrator. However, the `process-improvement` label class produced by `reflect.py` (Feature D, GH-1271) MUST be recognized by Director's event-classes taxonomy (Feature B, GH-1269) — this plan asserts that linkage in its integration test rather than re-editing the taxonomy itself.

7. **Outcome recording is automatic.** This is the constraint Feature E exists to implement. After this plan lands, the four terminal handlers (`ralph-postmortem`, `ralph-merge`, `ralph-pr`, `ralph-val`) MUST call the outcome-recorder on their success exit paths. Failure to record an outcome MUST be best-effort — log to stderr, do NOT block the terminal state transition. The Done / In Review / Plan-Done / VALIDATION-PASS transitions must succeed even when the outcome DB is unreachable.

8. **Verification tooling.** Lint: `npm run lint`. Type-check: `npm run typecheck`. Tests: `npm test` (for plugin code). Skill smoke tests follow `plugin/ralph-hero/scripts/cos/smoke.sh` pattern. Dream-loop verification per `~/projects/CLAUDE.md` "Verification commands" block: `sqlite3 ~/.ralph-hero/knowledge.db "SELECT memory_tier, COUNT(*) FROM documents GROUP BY memory_tier"`.

9. **Atomicity.** This is an S issue. Phase decomposition is for the planner's clarity. No child issue creation needed.

10. **No OpenClaw runtime.** Borrow no conventions from OpenClaw in this feature. The outcome-recorder is a 30 LOC fragment, not a daemon.

**Feature-specific constraints (E-only):**

- The `outcome-recorder` contract is a **fragment** (markdown procedure under `plugin/ralph-hero/skills/shared/fragments/`), NOT a new SKILL.md and NOT a standalone script. Terminal handlers `!cat` the fragment at the appropriate exit step, exactly as they currently `!cat` other shared fragments. This keeps the surface ≤ 30 LOC of imperative content and avoids creating a new skill that would need its own frontmatter, hooks, and dispatch.
- The fragment MUST be wrapped in a defensive `try`-equivalent: the MCP call is best-effort; failure logs to stderr and continues. A failed outcome row MUST NOT block the surrounding state transition.
- Event-type vocabulary is fixed by this plan to: `merge_completed`, `pr_created`, `validation_passed`, `validation_failed`, `postmortem_completed`. `ralph-postmortem` keeps its existing `blocker_recorded`, `impediment_recorded`, `session_completed` event types — Feature E adds, never removes.
- The integration test asserts the full loop ingestion side (merge → outcome row in DB → dream-loop ingest picks it up). It is allowed to use `RALPH_KNOWLEDGE_DB` env var redirection to a tempfile DB instead of mutating the real `~/.ralph-hero/knowledge.db`.

**Sibling context (Feature B / GH-1269 — PLANNED):**

- Director's event-classes taxonomy lives at `plugin/ralph-hero/skills/director/event-classes.md`. Director recognizes the `process-improvement` label and dispatches accordingly.
- Feature E's deliverable is the outcome-recorder fragment + terminal-handler patches + an integration test asserting merge → outcome row → next-night dream-loop ingestion. The `process-improvement` issues themselves are produced by Feature D's `reflect.py` cluster classifier (GH-1271); this plan's integration test asserts only the outcome-row ingestion side, not the cluster-classifier output (Feature D's responsibility).

## Current State Analysis

**Existing outcome-recording call sites.** `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` already (a) declares `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` in its `allowed-tools` and (b) describes inline outcome-recording in Step 3.5 for `blocker_recorded`, `impediment_recorded`, and `session_completed` event types. This is the de-facto reference pattern. The other three terminal handlers (`ralph-merge`, `ralph-pr`, `ralph-val`) do NOT currently call `knowledge_record_outcome` — confirmed by absence of the tool name in their `allowed-tools` and SKILL bodies.

**Existing MCP tool surface.** `knowledge_record_outcome` is implemented in `plugin/ralph-knowledge/src/index.ts:644-682` and accepts `{event_type, issue_number, session_id?, duration_ms?, verdict?, component_area?, estimate?, drift_count?, model?, agent_type?, iteration_count?, payload?}`. Storage goes through `db.insertOutcomeEvent()` (declared `OutcomeEventInput` in `plugin/ralph-knowledge/src/db.ts:26-39`). Query path is `knowledge_query_outcomes` (`src/index.ts:684`). The `outcomes_summary` field is already auto-attached to `knowledge_search` / `knowledge_recall` results that match a `githubIssue` (`src/index.ts:276, 418`).

**Existing terminal exit points.**

- `ralph-merge/SKILL.md` Step 7 "Move Issues to Done" → Step 9 "Post Completion Comment" → Step 10 "Report Result". The success path lands at Step 7 (state transition to Done). Step 10 emits `MERGED\nIssue: #NNN\nPR: ...\nState: Done`.
- `ralph-pr/SKILL.md` Step 6 "Move Issues to In Review" → Step 7 "Post Comment" → Step 8 "Report Result". Success path is Step 6 (state transition to In Review).
- `ralph-val/SKILL.md` Step 7.0 "Classify Verdict" → Step 7 "Verdict" → Step 8 "Post Comment". Verdict prefix is one of `VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL` (the literal tokens the `val-postcondition.sh` Stop hook accepts).
- `ralph-postmortem/SKILL.md` Step 3.5 already records outcomes inline; this plan refactors that to delegate to the fragment without changing the visible event types.

**Existing shared fragments.** `plugin/ralph-hero/skills/shared/fragments/` already houses `artifact-discovery.md`, `error-handling.md`, `escalation-steps.md`, `knowledge-metadata.md`, `link-formatting.md`, `skill-vs-agent-dispatch.md`, `stream-detection.md`, `task-template.md`, `team-reporting.md`. The pattern is `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/<name>.md` at the relevant SKILL.md step. This plan adds `outcome-recorder.md` to that directory.

**Existing dream-loop ingestion.** `scripts/dream/ingest.py` writes raw memories to `~/projects/thoughts/dream-memories/YYYY/MM/DD/`. It does NOT currently ingest from the outcome-events table; the connection between outcome rows and dream-loop happens via the issue-number join: the outcome row points at a GitHub issue, the dream-loop ingests the issue's session log + commits + research docs, and `knowledge_recall` surfaces the outcome alongside the document via `outcomes_summary`. This plan adds an integration test that asserts the outcome row is queryable post-ingestion via `knowledge_query_outcomes(issue_number=N)`.

## Desired End State

After this plan executes:

- A new shared fragment `plugin/ralph-hero/skills/shared/fragments/outcome-recorder.md` exists. It is ≤ 30 LOC of imperative content describing the canonical MCP call shape, the best-effort error handling, and the event-type vocabulary.
- `ralph-merge/SKILL.md` invokes the fragment immediately after Step 7 (Move Issues to Done) on the success path. Event type: `merge_completed`. Payload: `{pr_url, commit_sha, repo}`.
- `ralph-pr/SKILL.md` invokes the fragment immediately after Step 6 (Move Issues to In Review) on the success path. Event type: `pr_created`. Payload: `{pr_url, branch, repo}`.
- `ralph-val/SKILL.md` invokes the fragment immediately after Step 7 (Verdict) on every verdict path. Event types: `validation_passed` (when VERDICT_PREFIX = VALIDATION PASS), `validation_failed` (when VALIDATION FIX or VALIDATION FAIL). Verdict field is the literal prefix.
- `ralph-postmortem/SKILL.md` Step 3.5 is refactored to reference the fragment (the existing event types `blocker_recorded`, `impediment_recorded`, `session_completed` move into the fragment's "Postmortem-specific events" subsection). No behavior change visible from the outside.
- Each patched SKILL.md adds `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` to its `allowed-tools` list (already present in postmortem).
- An integration test at `plugin/ralph-knowledge/src/__tests__/outcome-merge-ingest.test.ts` asserts: insert outcome row → query it → assert the row is the expected shape.
- Director's event-classes taxonomy (Feature B, GH-1269) already routes `process-improvement` labels — this plan does NOT edit it. The integration test only asserts the outcome-row side of the loop; the cluster classifier producing `process-improvement` issues is Feature D's responsibility.

### Verification

- [ ] `grep -l "outcome-recorder" plugin/ralph-hero/skills/ralph-merge/SKILL.md plugin/ralph-hero/skills/ralph-pr/SKILL.md plugin/ralph-hero/skills/ralph-val/SKILL.md plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` returns all four files.
- [ ] `grep -l "knowledge_record_outcome" plugin/ralph-hero/skills/ralph-merge/SKILL.md plugin/ralph-hero/skills/ralph-pr/SKILL.md plugin/ralph-hero/skills/ralph-val/SKILL.md` returns all three (postmortem already had it).
- [ ] `cd plugin/ralph-knowledge && npm test` includes the new `outcome-merge-ingest.test.ts` and it passes.
- [ ] `cd plugin/ralph-knowledge && npm run typecheck` passes.
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds (sanity — no ralph-hero source touched, but ensures no accidental MCP tool name typos in SKILL.md break the hook validators).
- [ ] Manual: stub a merge by calling `knowledge_record_outcome(event_type="merge_completed", issue_number=9999, verdict="merged", payload={pr_url:"..."})` and confirm a row appears in `~/.ralph-hero/knowledge.db` outcome_events table.

## What We're NOT Doing

- Implementing the `reflect.py` cluster classifier — that is Feature D (GH-1271). This plan's integration test stops at the outcome-row level and does not assert that `reflect.py` emits `process-improvement` issues.
- Editing Director's event-classes taxonomy (`plugin/ralph-hero/skills/director/event-classes.md`) — Feature B already added `process-improvement` routing. This plan asserts the linkage via test, not by editing the taxonomy.
- Adding a new orchestrator skill, agent, or SOUL.md. The outcome-recorder is a fragment, not a skill.
- Building a CLI wrapper for the outcome-recorder. The MCP call is invoked directly from each SKILL.md step; no shell script is introduced.
- Migrating ralph-postmortem's existing inline outcome logic to a new file. The fragment becomes the canonical reference; postmortem's Step 3.5 prose is shortened to delegate to it.
- Auto-blocking terminal state transitions on outcome-record failures. The constraint is explicit: outcome-record failures are best-effort, logged, ignored.
- Editing dream-loop scripts (`scripts/dream/ingest.py`, `reflect.py`). The dream loop already ingests via document paths; the outcome rows are queryable independently via `knowledge_query_outcomes`. No script edits needed.
- Adding `outcomes_summary` to additional knowledge tools — it's already attached to `knowledge_search` and `knowledge_recall` for any matching `githubIssue`.
- Modifying the `knowledge_record_outcome` MCP tool signature or its db schema. The tool already accepts everything this plan needs.

## Implementation Approach

Five tasks in one phase, ordered by dependency. The fragment lands first (Task 1.1) so subsequent terminal-handler patches can reference it. The three new terminal-handler patches (1.2, 1.3, 1.4) are independent and operate on different SKILL.md files — they could in principle run in parallel, but a single planner-pass keeps the diff coherent. Postmortem refactor (1.5) is last because it touches the most prose. The integration test (1.6) lands after all patches so it can validate the full set.

---

## Phase 1: Outcome-recorder fragment + terminal-handler patches + integration test
- **depends_on**: null

### Overview

Add a shared `outcome-recorder` fragment, patch the four terminal handlers to invoke it on their success exits, and add one integration test asserting the merge → outcome-row path. Net new content: one fragment file (~30 LOC of markdown), four SKILL.md edits (≤ 10 lines added each), one test file (~80 LOC TypeScript).

### Tasks

#### Task 1.1: Author `outcome-recorder.md` shared fragment
- **files**: `plugin/ralph-hero/skills/shared/fragments/outcome-recorder.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/shared/fragments/outcome-recorder.md`
  - [ ] Body is ≤ 50 lines of markdown (target ~30 LOC of imperative content + headers)
  - [ ] Documents the canonical MCP call: `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome(event_type, issue_number, verdict, payload, session_id?)`
  - [ ] Enumerates the canonical event-type vocabulary for this feature: `merge_completed`, `pr_created`, `validation_passed`, `validation_failed`, `postmortem_completed`, plus the existing postmortem-specific types: `blocker_recorded`, `impediment_recorded`, `session_completed`
  - [ ] Includes an explicit "Best-effort" subsection: if the MCP call fails, log to stderr (`echo "outcome-record failed: ..." >&2`) and continue. Do NOT block the surrounding state transition.
  - [ ] Includes a per-handler payload schema table (one row per event type → required payload fields)

#### Task 1.2: Patch `ralph-merge` to invoke the fragment on success
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` is present in the SKILL's `allowed-tools` frontmatter list
  - [ ] A new step (numbered "Step 7.5: Record outcome event" or appended to Step 9) cats the fragment: `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/outcome-recorder.md`
  - [ ] The step body specifies `event_type="merge_completed"`, `verdict="merged"`, `payload={pr_url, commit_sha, repo}`
  - [ ] The step is placed AFTER Step 7 (Move Issues to Done) so the state transition lands first and outcome-record runs only on the success path
  - [ ] The rejection branch (Step 9b "Upstream PR Rejection") does NOT call the recorder — rejections are not terminal-success

#### Task 1.3: Patch `ralph-pr` to invoke the fragment on success
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` is present in the SKILL's `allowed-tools` frontmatter list
  - [ ] A new step (numbered "Step 6.5: Record outcome event" or appended to Step 7) cats the fragment: `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/outcome-recorder.md`
  - [ ] The step body specifies `event_type="pr_created"`, `verdict="created"`, `payload={pr_url, branch, repo}`
  - [ ] The step is placed AFTER Step 6 (Move Issues to In Review)

#### Task 1.4: Patch `ralph-val` to invoke the fragment on every verdict path
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` is present in the SKILL's `allowed-tools` frontmatter list
  - [ ] A new step (numbered "Step 7.5: Record outcome event") cats the fragment after Step 7 (Verdict) and BEFORE Step 8 (Post Comment) so the recorder fires on all three verdict paths
  - [ ] The step body branches on `VERDICT_PREFIX`: `VALIDATION PASS` → `event_type="validation_passed"`; `VALIDATION FIX` or `VALIDATION FAIL` → `event_type="validation_failed"`
  - [ ] The `verdict` field passed to `knowledge_record_outcome` is the literal `VERDICT_PREFIX` value (one of the three accepted tokens)
  - [ ] The payload includes `{total_checks, failed_checks, substantive_failures}` from Step 6 / Step 7.0 context variables
  - [ ] Best-effort error handling: a recorder failure does NOT prevent Step 8 (Post Comment) or the postcondition hook from succeeding

#### Task 1.5: Refactor `ralph-postmortem` Step 3.5 to delegate to the fragment
- **files**: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Step 3.5 prose is shortened: replace the inline per-event-type bullets with `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/outcome-recorder.md` plus a brief "Postmortem-specific events" subsection referencing the postmortem-only event types (`blocker_recorded`, `impediment_recorded`, `session_completed`)
  - [ ] No event-type rename: the three existing postmortem event types continue to be emitted with the same names and payload shapes
  - [ ] The `allowed-tools` entry for `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` is preserved (it was already there)
  - [ ] An additional step at the end of Step 4 (Write Post-Mortem) emits `event_type="postmortem_completed"` with `verdict="filed"` and `payload={postmortem_path, blocker_count, impediment_count}`

#### Task 1.6: Add `outcome-merge-ingest.test.ts` integration test
- **files**: `plugin/ralph-knowledge/src/__tests__/outcome-merge-ingest.test.ts` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Test file uses Vitest, mirroring the patterns in existing `plugin/ralph-knowledge/src/__tests__/graph-tools.test.ts` for setup (tempdir DB, `createServer()` import, cleanup)
  - [ ] Test 1: `record outcome → query outcome` — calls `knowledge_record_outcome` with `event_type="merge_completed", issue_number=9999, verdict="merged", payload={pr_url: "https://github.com/owner/repo/pull/1", commit_sha: "abc123", repo: "ralph-hero"}` and asserts that `knowledge_query_outcomes(issue_number=9999)` returns exactly one row with the same event_type and verdict
  - [ ] Test 2: `outcomes_summary attaches to documents` — inserts a stub document with `githubIssue=9999`, records the same outcome, then asserts that `knowledge_search` or a direct `db.getOutcomeSummary(9999)` call returns a non-null summary including the merge_completed row
  - [ ] Test 3: `idempotency on event_type` — recording the same outcome twice creates two rows (this asserts NO de-duplication; reflect.py is responsible for cluster-level de-duplication, not the recorder)
  - [ ] All tests pass under `npm test` from `plugin/ralph-knowledge/`
  - [ ] Test does NOT depend on `~/.ralph-hero/knowledge.db` — uses `RALPH_KNOWLEDGE_DB=<tempfile>` or equivalent test-fixture path

### Phase Success Criteria

#### Automated Verification:
- [ ] `cd plugin/ralph-knowledge && npm test` — all tests passing including the new `outcome-merge-ingest.test.ts`
- [ ] `cd plugin/ralph-knowledge && npm run typecheck` — no errors
- [ ] `cd plugin/ralph-knowledge && npm run build` — clean build
- [ ] `grep -c "outcome-recorder" plugin/ralph-hero/skills/ralph-merge/SKILL.md plugin/ralph-hero/skills/ralph-pr/SKILL.md plugin/ralph-hero/skills/ralph-val/SKILL.md plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` returns `≥ 1` for each of the four files
- [ ] `grep -c "knowledge_record_outcome" plugin/ralph-hero/skills/ralph-merge/SKILL.md plugin/ralph-hero/skills/ralph-pr/SKILL.md plugin/ralph-hero/skills/ralph-val/SKILL.md plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` returns `≥ 1` for each of the four files
- [ ] `wc -l plugin/ralph-hero/skills/shared/fragments/outcome-recorder.md` returns ≤ 50

#### Manual Verification:
- [ ] Trigger a real merge via `Skill("ralph-hero:ralph-merge", ...)` against a test issue; confirm a `merge_completed` row lands in `~/.ralph-hero/knowledge.db` via `sqlite3 ~/.ralph-hero/knowledge.db "SELECT * FROM outcome_events ORDER BY timestamp DESC LIMIT 1"`
- [ ] Trigger a real PR via `ralph-pr`; confirm a `pr_created` row appears with the expected payload
- [ ] Trigger a real `ralph-val` PASS verdict; confirm a `validation_passed` row appears
- [ ] Run `dream-now` and confirm the dream-loop completes without error and the next-day reflection cluster includes any document linked to the issue whose outcome was recorded (smoke check only — Feature D owns the cluster classifier behavior)

**Creates for next phase**: N/A — this is the only phase.

---

## Integration Testing

- [ ] End-to-end smoke: file a throwaway issue, run `ralph-impl` → `ralph-val` → `ralph-pr` → `ralph-merge` in sequence, then assert four outcome rows (`validation_passed`, `pr_created`, `merge_completed`, optionally `postmortem_completed` if `ralph-postmortem` runs) all appear in `outcome_events` with the same `issue_number`
- [ ] Negative test: temporarily set `RALPH_KNOWLEDGE_DB=/dev/null/bad` and confirm `ralph-merge` still completes its Step 7 (Move Issues to Done) and Step 10 (Report Result) — the outcome-record failure must be logged to stderr but NOT block the terminal transition

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1272
- Parent epic plan: `thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md`
- Sibling plan (Feature B / Director): `thoughts/shared/plans/2026-05-16-GH-1269-director-skill.md`
- MCP tool: `plugin/ralph-knowledge/src/index.ts:644-682` (`knowledge_record_outcome`)
- DB schema: `plugin/ralph-knowledge/src/db.ts:26-56` (`OutcomeEventInput`, `OutcomeEventRow`)
- Existing reference pattern: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` Step 3.5
- Shared fragments dir: `plugin/ralph-hero/skills/shared/fragments/`
- Dream-loop verification commands: `~/projects/CLAUDE.md` (root) — "Verification commands" block
