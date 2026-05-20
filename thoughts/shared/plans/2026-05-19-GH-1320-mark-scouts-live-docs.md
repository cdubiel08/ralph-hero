---
date: 2026-05-19
status: draft
type: plan
github_issue: 1320
github_issues: [1320]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1320
primary_issue: 1320
tags: [scouts, director, taxonomy, documentation, model-tier-policy, claude-md]
---

# Mark Scouts Live in event-classes.md, CLAUDE.md, and model-tier-policy.md — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-19-GH-1317-extract-shared-ui-heuristic]]
- builds_on:: [[2026-05-19-GH-1318-scouts-team-skill]]
- builds_on:: [[2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow]]

(Note: the parent plan-of-plans `2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` referenced in the GH-1314 issue body was not present on disk at planning time; this plan reconstructs scope from the issue body, the three sibling Phase 1–3 plans, and the live state of the three files this phase mutates. No `--parent-plan` flag was passed.)

## Overview

Single-issue atomic plan to flip the taxonomy and docs surfaces so that `scouts` is documented as a **live** team rather than a placeholder. Touches exactly three files (`event-classes.md`, `CLAUDE.md`, `docs/model-tier-policy.md`) plus a regression check. No code or skill behavior changes — Phase 2 (GH-1318) ships the actual `ralph-hero:scouts` skill and `scouts-agent.md` files this phase documents.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1320 | Mark scouts live in event-classes.md, CLAUDE.md, and model-tier-policy.md | XS |

## Shared Constraints

These constraints are inherited from the GH-1314 epic (reconstructed from the epic issue body and sibling plans, since the on-disk plan-of-plans file is missing) and extended with feature-specific constraints from this issue's research.

1. **Docs must reflect reality, not aspiration.** Do not mark scouts as `live` until Phase 2 (GH-1318) and Phase 3 (GH-1319) ship the actual `SKILL.md`, `scouts-agent.md`, and `.github/workflows/playwright-auto.yml`. This phase is dependency-blocked by both GH-1318 and GH-1319 via the `blockedBy` graph maintained by GitHub. Impl-agent must verify those files exist on `main` before editing the docs.
2. **No skill or agent behavior changes.** This phase is documentation-only. No edits to `skills/scouts/`, `agents/scouts-agent.md`, `.github/workflows/playwright-auto.yml`, or any other source file outside the three target docs.
3. **Single source of truth per concept.** The tier rationale lives in `docs/model-tier-policy.md`; `CLAUDE.md` only references it. Do not duplicate the rationale into `CLAUDE.md`. (Issue Research Notes explicitly flag this.)
4. **Preserve the cron note.** Per the issue scope, the User-facing surface row swap in `CLAUDE.md` must preserve the existing `scout-nightly.sh` cron context — the new entrypoint is additive, not a replacement. The nightly batch path continues to operate independently per the GH-1314 epic body ("Not migrating scout-nightly").
5. **Match existing table conventions.** Each table edit must use the exact column shape and formatting present today. No reordering of columns, no Markdown table re-flow beyond the one-row swap/add. Diff must be minimal and reviewable as a docs-only change.
6. **Model-tier policy override pattern.** The new `scouts-agent` row in `CLAUDE.md` and the policy doc must follow the existing `RALPH_<AGENT>_MODEL` env var pattern. The override env var is `RALPH_SCOUTS_MODEL`, consistent with `RALPH_IMPL_MODEL`, `RALPH_SPLIT_MODEL`, `RALPH_PLAN_MODEL` already documented at `docs/model-tier-policy.md:23-33`.
7. **Tier choice must match Phase 2.** The Phase 2 plan (GH-1318) declared `scouts-agent` as `model: sonnet` (orchestration role with multi-skill coordination — matches log-reader/research-agent/impl-agent/val-agent tier). This phase MUST document the same tier and use a matching one-line tier rationale. Do not invent a different tier.

## Current State Analysis

### What exists today (verified at planning time)

- **`event-classes.md`**: Three scout-related rows already exist:
  - `trigger:scouts` row at line 17 with note `"Manual override: force scout dispatch. Feature F ships ralph-hero:scouts."`
  - `scout-auto` automation-label row at line 29 with note `"Label written by Scout scheduling hook (on-PR + nightly). Producer ships in Feature F (GH-1273). Feature F also ships ralph-hero:scouts."`
  - Team→entrypoint mapping row at line 58: `| scouts | ralph-hero:scouts | pending Feature F (GH-1273) |`
- **`CLAUDE.md`** has TWO tables that mention teams (per issue Research Notes — easy to miss the second one):
  - **Per-Phase Agents table** (lines 62-74): 11 rows for existing agents. No `scouts-agent` row.
  - **User-facing surface table** (lines 85-97): row at line 92 reads `| Scouts team | no skill — scout-nightly.sh cron + on-PR comment trigger |`.
- **`docs/model-tier-policy.md`**: Currently shows examples for `RALPH_IMPL_MODEL`, `RALPH_PLAN_MODEL`, `RALPH_SPLIT_MODEL` at lines 29-33. No `RALPH_SCOUTS_MODEL` example. No scouts-agent tier rationale.
- **Phase 2 plan output** (GH-1318): Authors `plugin/ralph-hero/skills/scouts/SKILL.md` and `plugin/ralph-hero/agents/scouts-agent.md` (model: sonnet).
- **Phase 3 plan output** (GH-1319): Authors `.github/workflows/playwright-auto.yml` per-PR producer.
- **`scout-nightly.sh`** continues as-is at `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` per the epic body.

### What's missing (this phase delivers)

- `event-classes.md`: status column on the scouts row in the team→entrypoint table flips from `pending Feature F (GH-1273)` to `live`. The `trigger:scouts` and `scout-auto` row notes are updated to remove "Feature F ships..." aspiration.
- `CLAUDE.md` Per-Phase Agents table: new `scouts-agent` row inserted following the existing column shape.
- `CLAUDE.md` User-facing surface table: Scouts team row swaps to the new `/ralph-hero:scouts` entrypoint while preserving the cron note as additive context.
- `docs/model-tier-policy.md`: new line in the Examples block for `RALPH_SCOUTS_MODEL`, plus a one-line addition to the tier rationale section explaining why scouts-agent is sonnet.

### Pattern source files (read, not modified)

- `plugin/ralph-hero/skills/director/event-classes.md` — taxonomy schema to mutate (lines 17, 29, 58).
- `CLAUDE.md` — both tables to mutate (lines 62-74 and 85-97).
- `plugin/ralph-hero/docs/model-tier-policy.md` — examples block to extend (lines 23-33).
- `plugin/ralph-hero/agents/impl-agent.md` — model-tier rationale pattern (impl-agent default sonnet, override via env var).
- `thoughts/shared/plans/2026-05-19-GH-1318-scouts-team-skill.md` — confirms tier choice (sonnet) and override env var name (`RALPH_SCOUTS_MODEL`) used by this phase.

## Desired End State

### Verification

- [ ] `event-classes.md` Team→entrypoint mapping row for `scouts` shows status `live` (no `pending Feature F` caveat).
- [ ] `event-classes.md` `trigger:scouts` row note no longer references "Feature F ships" — instead documents the live entrypoint `/ralph-hero:scouts --issue NNN`.
- [ ] `event-classes.md` `scout-auto` row note documents that the producer is `playwright-auto.yml` (Phase 3) and that dispatch routes to the live `ralph-hero:scouts` skill.
- [ ] `CLAUDE.md` Per-Phase Agents table contains a `scouts-agent` row with: model `sonnet`, preloaded skill `ralph-hero:scouts`, tier `Scout`, and a note documenting the `RALPH_SCOUTS_MODEL` override.
- [ ] `CLAUDE.md` User-facing surface table row for "Scouts team" reads `/ralph-hero:scouts [--issue NNN]` while preserving the cron note (e.g., "Scouts team | `/ralph-hero:scouts [--issue NNN]` (per-PR via `playwright-auto.yml`; nightly batch via `scout-nightly.sh` cron)").
- [ ] `docs/model-tier-policy.md` includes `RALPH_SCOUTS_MODEL` in the examples block at lines 29-33.
- [ ] `docs/model-tier-policy.md` includes a one-line entry documenting scouts-agent's default tier (sonnet) and rationale (multi-skill orchestration role).
- [ ] No edits outside the three target files. `git diff --stat` shows exactly 3 changed files.
- [ ] All sibling plan files referenced in `## Prior Work` exist on disk (sanity check — confirms the dependency chain was actually planned).

## What We're NOT Doing

- Not editing `plugin/ralph-hero/skills/scouts/` (Phase 2 — sibling).
- Not editing `plugin/ralph-hero/agents/scouts-agent.md` (Phase 2 — sibling).
- Not editing `.github/workflows/playwright-auto.yml` (Phase 3 — sibling).
- Not running self-host validation against a fixture PR (Phase 5 — sibling).
- Not modifying `ralph-pr`, `ralph-merge`, or any other skill body.
- Not adding the `scouts-agent` row to any third docs surface (e.g., `unified-agent-system.md`) — issue scope is exactly three files. If `unified-agent-system.md` is found to be stale post-merge, file a follow-up issue.
- Not changing the `RALPH_SCOUTS_MODEL` override mechanism — only documenting it. Phase 2 implements the env-var read in `scouts-agent.md` body.
- Not migrating `scout-nightly.sh` to use the new skill (epic-level out-of-scope per GH-1314 body).
- Not flipping the `memorykeepers` entry (still pending; out of scope).
- Not running the MCP server build/test suite — this is docs-only and the MCP server is not touched.

## Implementation Approach

Single phase, four tasks — three file edits in dependency order (no cross-file ordering required; each edit is independent), plus one verification task.

1. **Task 1.1 — Edit `event-classes.md`** to flip the three scout-related rows from "pending Feature F" to "live", with notes pointing to the live entrypoint and the Phase 3 producer.
2. **Task 1.2 — Edit `CLAUDE.md`** to add a `scouts-agent` row to the Per-Phase Agents table and swap the User-facing surface row to the new entrypoint with the cron note preserved.
3. **Task 1.3 — Edit `docs/model-tier-policy.md`** to add `RALPH_SCOUTS_MODEL` to the examples block and a one-line tier rationale entry.
4. **Task 1.4 — Verification**: grep checks against all three files, plus a `git diff --stat` assertion that exactly three files changed, plus a sanity check that the files documented as "live" actually exist (Phase 2 + 3 outputs).

---

## Phase 1: Mark scouts live across three docs files
- **depends_on**: [GH-1318, GH-1319]

### Overview

Flip the three docs surfaces (`event-classes.md`, `CLAUDE.md`, `docs/model-tier-policy.md`) so that scouts is documented as a live team. Pure docs change — no source files touched. Dependency-blocked by Phase 2 (the skill/agent that "live" refers to) and Phase 3 (the producer that creates `scout-auto` issues). Impl-agent verifies those upstream files exist on `main` before editing.

### Tasks

#### Task 1.1: Edit `plugin/ralph-hero/skills/director/event-classes.md`

- **files**: `plugin/ralph-hero/skills/director/event-classes.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 17 `trigger:scouts` row note is updated. Old text: `"Manual override: force scout dispatch. Feature F ships ralph-hero:scouts."` New text: `"Manual override: force scout dispatch. Routes to /ralph-hero:scouts --issue NNN."`
  - [ ] Line 29 `scout-auto` row note is updated. Old text: `"Label written by Scout scheduling hook (on-PR + nightly). Producer ships in Feature F (GH-1273). Feature F also ships ralph-hero:scouts."` New text: `"Label written by .github/workflows/playwright-auto.yml (per-PR) and plugin/ralph-hero/scripts/schedule/scout-nightly.sh (nightly batch). Routes to /ralph-hero:scouts."`
  - [ ] Line 58 Team→entrypoint mapping row is updated. Old text: `| scouts | ralph-hero:scouts | pending Feature F (GH-1273) |` New text: `| scouts | ralph-hero:scouts | live |`
  - [ ] No other lines in `event-classes.md` change. `git diff plugin/ralph-hero/skills/director/event-classes.md` shows exactly three changed lines.
  - [ ] `grep -c 'pending Feature F' plugin/ralph-hero/skills/director/event-classes.md` returns `0` (no remaining "pending" caveat on scouts).
  - [ ] `grep -F 'ralph-hero:scouts | live' plugin/ralph-hero/skills/director/event-classes.md` returns at least one match.

#### Task 1.2: Edit `CLAUDE.md`

- **files**: `CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A new row is inserted in the Per-Phase Agents table (between lines 62-74) for `scouts-agent`. The row format matches the existing column shape: `| scouts-agent | sonnet | ralph-hero:scouts | Scout | Multi-skill orchestration (a11y-scan + conditional test-e2e/storybook-test/visual-diff). Override with RALPH_SCOUTS_MODEL=opus. |`
  - [ ] The row is inserted in alphabetical or logical order. Recommended position: after `unblock-agent` (last in the existing table) or grouped near other dispatcher-style agents. Pick one and stick to it; impl-agent's judgment is acceptable.
  - [ ] The User-facing surface table row for Scouts (currently line 92: `| Scouts team | no skill — scout-nightly.sh cron + on-PR comment trigger |`) is replaced with: `| Scouts team | /ralph-hero:scouts [--issue NNN] (per-PR via playwright-auto.yml; nightly batch via scout-nightly.sh cron) |`. Backticks must be preserved around `/ralph-hero:scouts`, `playwright-auto.yml`, and `scout-nightly.sh` to match the existing Markdown code-formatting convention used elsewhere in the table.
  - [ ] No other lines in `CLAUDE.md` change. `git diff CLAUDE.md` shows exactly two changed regions (one row addition in the agents table, one row replacement in the user-facing surface table).
  - [ ] `grep -c 'scouts-agent' CLAUDE.md` returns ≥ 1 (the new agents-table row).
  - [ ] `grep -F '/ralph-hero:scouts' CLAUDE.md` returns ≥ 1 (the user-facing surface entrypoint).
  - [ ] `grep -c 'no skill — .scout-nightly.sh.' CLAUDE.md` returns 0 (the placeholder note is gone).
  - [ ] `grep -F 'RALPH_SCOUTS_MODEL' CLAUDE.md` returns ≥ 1 (override env var documented in the agents-table note).

#### Task 1.3: Edit `plugin/ralph-hero/docs/model-tier-policy.md`

- **files**: `plugin/ralph-hero/docs/model-tier-policy.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] A new line is added to the Examples block (currently lines 29-33) matching the existing pattern. Insert immediately after the `RALPH_SPLIT_MODEL=opus` line: `RALPH_SCOUTS_MODEL=opus           # rare: scouts orchestrator on complex multi-PR fan-out`
  - [ ] A new entry is added documenting scouts-agent's default tier. Recommended location: end of the "Default tier by agent" section (which currently only contains a pointer to `CLAUDE.md`). The entry MAY be a one-line tier rationale (e.g., `scouts-agent: sonnet — multi-skill orchestration role; same tier as impl-agent / val-agent / log-reader.`) added immediately below line 19. Impl-agent's judgment on exact placement is acceptable as long as the rationale is in the policy doc, not in CLAUDE.md (Constraint 3).
  - [ ] `grep -c 'RALPH_SCOUTS_MODEL' plugin/ralph-hero/docs/model-tier-policy.md` returns ≥ 1.
  - [ ] `grep -c 'scouts-agent' plugin/ralph-hero/docs/model-tier-policy.md` returns ≥ 1.
  - [ ] No other lines in `model-tier-policy.md` change beyond the two additions. `git diff plugin/ralph-hero/docs/model-tier-policy.md` shows additions only (no deletions or reorderings).

#### Task 1.4: Verification — grep + diff-stat + sibling-existence check

- **files**: (no file edits; runs commands)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] `git diff --stat main` (or `git diff --stat HEAD~1` if the previous three tasks are already committed) shows exactly three changed files: `CLAUDE.md`, `plugin/ralph-hero/skills/director/event-classes.md`, `plugin/ralph-hero/docs/model-tier-policy.md`.
  - [ ] `test -f plugin/ralph-hero/skills/scouts/SKILL.md` exits 0 (Phase 2 deliverable exists — sanity check that "live" claim is grounded).
  - [ ] `test -f plugin/ralph-hero/agents/scouts-agent.md` exits 0 (Phase 2 deliverable exists).
  - [ ] `test -f .github/workflows/playwright-auto.yml` exits 0 (Phase 3 deliverable exists).
  - [ ] If any of the three `test -f` checks fail, impl-agent emits `IMPL BLOCKED needs=phase-2-or-3-not-yet-merged` and stops. Do NOT mark scouts live in docs if the upstream files do not exist on `main` — that would create stale-aspirational docs (violates Constraint 1).
  - [ ] `grep -c 'scouts-agent' CLAUDE.md plugin/ralph-hero/docs/model-tier-policy.md` returns ≥ 2 (one match in each file).
  - [ ] `grep -F 'pending Feature F' plugin/ralph-hero/skills/director/event-classes.md` returns 0.
  - [ ] All sibling plan files referenced in `## Prior Work` exist on disk: `test -f thoughts/shared/plans/2026-05-19-GH-1317-extract-shared-ui-heuristic.md && test -f thoughts/shared/plans/2026-05-19-GH-1318-scouts-team-skill.md && test -f thoughts/shared/plans/2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow.md` exits 0.

### Phase Success Criteria

#### Automated Verification:

- [ ] `git diff --stat` shows exactly three changed files (`CLAUDE.md`, `event-classes.md`, `model-tier-policy.md`).
- [ ] `grep -c 'pending Feature F' plugin/ralph-hero/skills/director/event-classes.md` returns 0.
- [ ] `grep -F 'ralph-hero:scouts | live' plugin/ralph-hero/skills/director/event-classes.md` returns ≥ 1.
- [ ] `grep -c 'scouts-agent' CLAUDE.md` returns ≥ 1.
- [ ] `grep -F '/ralph-hero:scouts' CLAUDE.md` returns ≥ 1.
- [ ] `grep -F 'RALPH_SCOUTS_MODEL' CLAUDE.md` returns ≥ 1.
- [ ] `grep -F 'RALPH_SCOUTS_MODEL' plugin/ralph-hero/docs/model-tier-policy.md` returns ≥ 1.
- [ ] `grep -c 'scouts-agent' plugin/ralph-hero/docs/model-tier-policy.md` returns ≥ 1.
- [ ] `test -f plugin/ralph-hero/skills/scouts/SKILL.md && test -f plugin/ralph-hero/agents/scouts-agent.md && test -f .github/workflows/playwright-auto.yml` exits 0 (upstream Phase 2 + 3 sanity check).

#### Manual Verification:

- [ ] Read the three diffs side-by-side: row shapes match existing conventions, no Markdown table reflow, no stray whitespace changes.
- [ ] Read the new `scouts-agent` row in `CLAUDE.md` and confirm the tier rationale matches what `docs/model-tier-policy.md` says (single source of truth — Constraint 3).
- [ ] Read the User-facing surface row swap in `CLAUDE.md` and confirm the cron note is preserved as additive context (Constraint 4).
- [ ] Confirm visual cleanliness: no orphan placeholders, no broken Markdown tables.

**Creates for next phase**: A fully-documented live scouts team. Phase 5 (GH-1321, self-host validation) consumes this by opening a fixture PR and observing the timeline; without this phase's docs being correct, the Phase 5 validation would observe a producer→Director→scouts chain that doesn't match what the docs say.

---

## Integration Testing

This phase is docs-only — there is no runtime integration to test. Bounded integration checks:

- [ ] `git diff --stat` confirms exactly three changed files.
- [ ] The upstream files documented as "live" actually exist on disk (Phase 2 + 3 outputs — see Task 1.4 sanity check).
- [ ] No CI or test impact expected; the MCP server, hooks, and skill bodies are not touched.

The end-to-end producer→Director→scouts→report→merge-gate timeline is owned by Phase 5 (GH-1321, self-host validation).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1320
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1314
- Sibling phases: #1317 (heuristic — already planned), #1318 (skill/agent — blocker), #1319 (per-PR producer — blocker), #1321 (self-host validation — sibling)
- Director taxonomy (file under edit): `plugin/ralph-hero/skills/director/event-classes.md`
- Project root docs (file under edit): `CLAUDE.md`
- Model tier policy (file under edit): `plugin/ralph-hero/docs/model-tier-policy.md`
- Phase 2 plan (declares `scouts-agent` model tier): `thoughts/shared/plans/2026-05-19-GH-1318-scouts-team-skill.md`
- Phase 3 plan (per-PR producer this phase documents as the `scout-auto` producer): `thoughts/shared/plans/2026-05-19-GH-1319-per-pr-producer-playwright-auto-workflow.md`
- Phase 1 plan (heuristic library — context only): `thoughts/shared/plans/2026-05-19-GH-1317-extract-shared-ui-heuristic.md`
- Existing override env var pattern: `plugin/ralph-hero/docs/model-tier-policy.md:23-33`
- Existing agents table conventions: `CLAUDE.md:62-74`
- Existing User-facing surface table: `CLAUDE.md:85-97`
- scout-nightly batch path (preserved as-is): `plugin/ralph-hero/scripts/schedule/scout-nightly.sh`
