---
date: 2026-07-22
status: draft
type: plan
tags: [catch-up, brief, human-queue, decisions, unblock, ways-of-working]
github_issue: 1557
github_issues: [1557, 1558]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1557
  - https://github.com/cdubiel08/ralph-hero/issues/1558
primary_issue: 1557
estimate: S
---

# catch-up --mode brief — the daily sitting that empties the human queue (group: GH-1557 + GH-1558)

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — J3 research: every decision signal is scanned comprehensively but only ranked-top-N surfaced; no surface chains the answer flows into one sitting.
- builds_on:: [[2026-07-19-GH-1550-epic-ways-of-working-surfaces]] — epic Feature C: A→C is load-bearing (the brief renders exactly what enumeration returns — no second scan, no skill-side re-ranking); B→C is soft (summary degrades gracefully); answer machinery consumed by reference, never reimplemented; one new reference sibling only.
- builds_on:: [[2026-07-19-GH-1553-plan-of-plans]] — split record: #1557 (interactive) first, #1558 (`--prepare`) reuses its enumeration path; one group plan, one PR.
- builds_on:: [[2026-07-22-GH-1551-next-actions-human-queue-enumeration]] — Feature A SHIPPED (PR #1580): `next_actions` accepts `enumerate: "human-queue"` (full ranked list, `limit` ignored, human audience forced, `signals.sourceCommentUrl` on `plan-decision`/`human-needed-unblock`). The brief is its documented canonical caller.
- builds_on:: [[2026-07-22-GH-1559-group-capture-custody-chain]] — Feature D SHIPPED (PR #1582): idea-file lifecycle contract (`status: draft|forming`, `captured`, `enriched`, `## Enrichment`) in `ralph/skills/form/intake-shapes.md` § Idea-file lifecycle contract — the brief is the contract's named downstream reader.

## Overview

New `--mode brief` on `/ralph:catch-up` — one interactive sitting that walks and resolves everything waiting on a human: Decision Requests (GH-1544 holds), Unblock Requests, incubating thoughts (Feature D contract), then a read-only flagged tail. Plus a headless `--prepare` flag (Phase 2): same enumeration, zero prompts, zero mutations, at most one `PushNotification` per day with counts.

The load-bearing design stance: **the brief enumerates and dispatches; it never re-implements an answer flow.** Board-queue items route to their owning verbs inline via `Skill()` (decisions → `/ralph:plan --mode review NNN`; unblocks → `/ralph:caretake --mode unblock` for that issue) so the GH-1544 picker/fold-in and unblock Q&A contracts execute in their home skills with their own hooks. Incubating thoughts come from the local idea-file glob (not the board — capture never touches board state, so enumeration cannot see them).

## Current State Analysis

- `ralph/skills/catch-up/SKILL.md`: modes default / narrative / dashboard / report; frontmatter `allowed-tools` includes `next_actions`, `pipeline_dashboard`, `recent_activity`, `create_status_update`, `metrics_trends`, `Read`, `Skill`, `Agent`, `AskUserQuestion` — NO `PushNotification`, `Glob`, `Grep`, `Bash`, or `Edit`. The `--loop` gate allows `--mode report` only; all other modes refuse. Four reference siblings (narrative-synthesis, next-action-ranking, dashboard-render, report-composition) — the epic pre-authorized a fifth (`brief-composition.md`).
- `ralph_hero__next_actions` (shipped Feature A): `enumerate: "human-queue"` returns every direction, rank 1..N, `signals.sourceCommentUrl` on the two comment-anchored kinds; tool description names `catch-up --mode brief` as the ONE canonical caller.
- `ralph_hero__pipeline_status_summary` (shipped Feature B): compact `{health, riskScore, velocity, totalIssues, phaseCounts, stuckIssues, wipViolations, blockedDeps}` — the brief's status header input, soft dependency.
- Idea-file contract (shipped Feature D): `thoughts/shared/ideas/*.md` with `status: draft` (captured, unenriched) or `status: forming` — where `enriched` frontmatter / `## Enrichment` distinguishes "enrichment ran" from form's hand-off path. `captured` orders thoughts by age.
- Answer contracts consumed by reference: `ralph/skills/plan/plan-review.md` § Interactive vs auto (decisions-first pickers + fold-in, `Decision:`-prefixed headers); `ralph/skills/caretake/modes/unblock.md` (interactive answer flow + state-return confirmation).
- Hardened render rules: `dashboard-render.md` never-editorialize list; `next-action-ranking.md` forbids quoting `direction.reason` verbatim; estimate honesty.

### Key Discoveries

- Dispatching `Skill("ralph:plan", args="--mode review NNN")` per decision item executes the ENTIRE GH-1544 contract (pickers, fold-in, sentinel restore, In Progress advance) inside the skill that owns it — hooks included. The brief needs no mutation tools for decisions/unblocks at all; `Skill` is already allowed.
- Incubating thoughts are invisible to `next_actions` by design (capture never mutates board state) — the brief composes TWO sources: the enumeration (board queue) and the idea-file glob (thought queue). This must be stated explicitly in `brief-composition.md` or a future refactor will "simplify" one away.
- `--prepare` needs `PushNotification` + a filesystem idempotency marker; both require frontmatter `allowed-tools` additions (`PushNotification`, `Glob`, `Grep`, `Bash`).

## Desired End State

1. `/ralph:catch-up --mode brief` runs one sitting: status header → decision walk → unblock walk → incubating-thought walk → read-only flagged tail → one-line closing summary ("queue emptied" or "N deferred").
2. Every board-queue item is sourced from ONE `next_actions` call with `enumerate: "human-queue"`; the brief never re-ranks, re-filters, or re-scans (A→C contract).
3. Decisions and unblocks resolve through their owning verbs (`Skill` dispatch); the brief posts no issue comments and calls no mutating MCP tools itself.
4. Incubating thoughts (glob `thoughts/shared/ideas/`, `status: draft|forming`, oldest-`captured` first) present flesh-out / promote-via-form / keep / drop options; enriched files show their `## Enrichment` context.
5. `--prepare` (Phase 2): zero prompts, zero mutations, one `PushNotification` per day ("Daily brief ready: N decisions, M unblocks, K thoughts"), idempotent via a last-prepared-date marker; second same-day run is a silent no-op.
6. The mode is registered across the SKILL.md sync surface: mode table, argument-hint, description, `--loop` gate (brief stays refused — #1555's scheduled task, not `/loop`, owns cadence), and the References list names `brief-composition.md`.

### Verification

- Grep-based structure checks per phase (mode table row, section presence, allowed-tools additions, composition sections).
- `bash scripts/check-doc-rosters.sh` passes.
- Manual: one interactive brief against the live board; one `--prepare` run + same-day re-run proving idempotency.

## What We're NOT Doing

- No new verb; no second enumeration path; no skill-side re-ranking of enumeration output.
- No reimplementation of decision pickers, fold-in, or unblock Q&A — `Skill` dispatch to the owning verbs only.
- No issue comments, board mutations, or `save_issue` calls from the brief itself (the dispatched verbs own their mutations).
- No scheduling/cron wiring (#1555, Feature E) — but `--prepare` is built to be invoked by it.
- No mobile/ntfy delivery; `PushNotification` only (data-plane axiom: counts, nothing the board already shows).
- No `--loop` support for brief (interactive sitting; `--prepare` cadence belongs to the #1555 scheduled task).

## Design Decisions & Open Ambiguities

- **How the brief resolves items** — options: inline pickers + fold-in logic duplicated into the brief; `Skill()` dispatch to the owning verb per item. **Decided: `Skill()` dispatch.** The epic mandates "reuse the answer contracts as-is"; dispatching `/ralph:plan --mode review NNN` and `/ralph:caretake --mode unblock` executes those contracts with their own hooks and keeps catch-up mutation-free. Cost: per-item skill-context switches — acceptable for a deliberate daily sitting.
- **Incubating-thought source** — options: extend enumeration to include idea files; local glob in the brief. **Decided: local glob.** Idea files are filesystem artifacts invisible to the board by design (capture never starts work); pushing them into `next_actions` would couple the MCP server to a thoughts-directory layout it otherwise never reads. The two-source composition is documented explicitly.
- **Idempotency marker location** — options: `~/.ralph-hero/brief/last-prepared`; a frontmatter stamp somewhere in thoughts/. **Decided: `~/.ralph-hero/brief/last-prepared`** (single line, `YYYY-MM-DD`). Machine-local state belongs under `~/.ralph-hero/` with the cursors/snapshots precedent; a repo file would sync a per-machine concern across machines.
- **Flagged-tail scope** — options: render every enumeration kind not walked; only `pr` + `lock-stale`. **Decided: every remaining kind** (pr, lock-stale, tree-continue, stale/plain issue, triage aggregate) — the epic's brief scope is "the full human queue"; the tail is read-only so breadth costs nothing but lines. Render honors the never-editorialize rules.
- **`--prepare` thought-counting** — options: count `draft` only; count `draft` + `forming`. **Decided: `draft` + `forming`** — both are incubating (not yet promoted/refined); the push counts what the sitting will walk.

None — no open design decisions.

## Implementation Approach

Two phases, one worktree (`GH-1557`), one PR closing both members. **Shared file ownership**: both phases touch `ralph/skills/catch-up/SKILL.md` and `ralph/skills/catch-up/brief-composition.md` — Phase 1 creates the mode + composition doc; Phase 2 extends both with the `--prepare` branch. Phase 2 depends on Phase 1.

## Phase 1: GH-1557 — interactive brief

depends_on: null

### Overview

Register `--mode brief` on catch-up and author `brief-composition.md` — the walk order, two-source composition, dispatch table, and render rules.

### Changes Required

#### 1. Mode registration + body
**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: (a) Mode table row: `--mode brief` — "Daily sitting: status header + human-queue walk (decisions → unblocks → thoughts) + read-only flagged tail"; (b) argument-hint: add `brief` to the mode enum and `[--prepare]`; (c) description: add the brief trigger phrases ("daily brief", "walk the queue", "empty the human queue"); (d) `--loop` gate: brief stays in the refusal set, with a one-line note that `--prepare` cadence is owned by the #1555 scheduled task; (e) new `## --mode brief` section: parse `--prepare` (Phase 2 wires its behavior; Phase 1 notes the flag and defers), then follow `brief-composition.md` for the full walk; (f) allowed-tools: add `PushNotification`, `Glob`, `Grep`, `Bash`, and `mcp__plugin_ralph_ralph-github__ralph_hero__pipeline_status_summary`; (g) References list: add `brief-composition.md`.

#### 2. Composition reference
**File**: `ralph/skills/catch-up/brief-composition.md` (new)
**Changes**: The mode's full procedure:
- **§ Two sources**: board queue = ONE `next_actions` call with `enumerate: "human-queue"` (never re-rank/re-filter — A→C contract, canonical-caller note); thought queue = glob `thoughts/shared/ideas/*.md` with `status: draft|forming`, oldest-`captured` first (D contract pointer to `intake-shapes.md` § Idea-file lifecycle contract). State explicitly why thoughts cannot come from the board.
- **§ Status header**: `pipeline_status_summary` one-liner (health, velocity, totals) when the tool responds; degrade silently to the narrative-only header when unavailable (B is soft).
- **§ Walk order + dispatch table**: (1) `plan-decision` items → `Skill("ralph:plan", args="--mode review NNN")` per item (the GH-1544 pickers + fold-in run in their home skill); (2) `human-needed-unblock` items → `Skill("ralph:caretake", args="--mode unblock")` scoped to the issue per unblock.md's interactive answer flow; (3) incubating thoughts → per-thought `AskUserQuestion` (flesh out now / promote via `Skill("ralph:form", args="<path>")` / keep incubating / drop — drop deletes the file after an explicit confirm), showing `## Enrichment` context when present; (4) flagged tail: every remaining enumeration kind rendered read-only (kind, ref, age signals, `sourceCommentUrl` links) — no actions offered.
- **§ Render rules**: inherit the never-editorialize list and reason-synthesis rules by reference (`dashboard-render.md`, `next-action-ranking.md`); estimate honesty; one line per tail item.
- **§ Closing summary**: exactly one line — "Queue emptied." or "N deferred (…kinds…)" counting items skipped or left unresolved.

### Success Criteria

#### Automated Verification
- [ ] `grep -n "mode brief" ralph/skills/catch-up/SKILL.md` shows the mode-table row and section heading
- [ ] `grep -n "brief-composition" ralph/skills/catch-up/SKILL.md` shows the References entry
- [ ] `grep -n "PushNotification\|pipeline_status_summary" ralph/skills/catch-up/SKILL.md` shows both allowed-tools additions
- [ ] `grep -n "enumerate" ralph/skills/catch-up/brief-composition.md` shows the human-queue enumeration call
- [ ] `grep -n "Idea-file lifecycle contract" ralph/skills/catch-up/brief-composition.md` shows the D-contract pointer
- [ ] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] Run `/ralph:catch-up --mode brief` against the live board: header renders, decision/unblock items dispatch to their verbs, thoughts present the four options, tail is read-only, closing line appears

## Phase 2: GH-1558 — headless --prepare

depends_on: [phase-1]

### Overview

Wire the `--prepare` branch: enumeration + thought count, one push per day, idempotency marker, zero prompts.

### Changes Required

#### 1. Prepare branch
**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: In the `## --mode brief` section, replace the Phase 1 deferral note with the `--prepare` branch: read `~/.ralph-hero/brief/last-prepared`; if it equals today (local date), emit `Brief already prepared today.` and STOP (no push, no prompts). Otherwise follow `brief-composition.md` § Prepare.

#### 2. Prepare procedure
**File**: `ralph/skills/catch-up/brief-composition.md`
**Changes**: New **§ Prepare (headless)**: run the SAME two-source read (one enumeration call, one idea glob) with ZERO prompts and ZERO mutations — no `Skill` dispatches, no `AskUserQuestion`, no issue comments (auto-mode-is-end-to-end axiom); compute `N` = plan-decision count, `M` = human-needed-unblock count, `K` = incubating-thought count (`draft` + `forming`); fire exactly ONE `PushNotification(title="Daily brief ready", body="N decisions, M unblocks, K thoughts — sit /ralph:catch-up --mode brief")` (data-plane axiom: counts only); write today's date to `~/.ralph-hero/brief/last-prepared` (mkdir -p the parent); emit the terminal line `Brief prepared: N decisions, M unblocks, K thoughts.` Notification failure does not fail the mode (marker still written; the counts line is the durable record).

### Success Criteria

#### Automated Verification
- [ ] `grep -n "last-prepared" ralph/skills/catch-up/SKILL.md ralph/skills/catch-up/brief-composition.md` shows the marker in both files
- [ ] `grep -n "Prepare (headless)" ralph/skills/catch-up/brief-composition.md` shows the section
- [ ] `grep -c "PushNotification" ralph/skills/catch-up/brief-composition.md` ≥ 1
- [ ] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] Run `--mode brief --prepare`: one push fires, marker written, terminal counts line emitted, no prompts
- [ ] Re-run same day: `Brief already prepared today.` and no second push

## Testing Strategy

### Unit Tests
None — markdown-surface change.

### Integration Tests
CI doc-roster consistency; the caretake fan-out is untouched (no hook-test count assertions apply — verified by the GH-1559 cycle's lesson: grep the `__tests__` directory for any literal-count assertions against catch-up's SKILL.md before merging: `grep -rn "catch-up" ralph/hooks/scripts/__tests__/ | grep -i "total\|count"` should return nothing).

### Manual Testing Steps
1. Interactive sitting against the live board (Phase 1 manual check).
2. `--prepare` + same-day re-run (Phase 2 manual checks).

## Migration Notes

Purely additive mode; one PR closes #1557 + #1558 (parent #1553 advances server-side; #1553's board unblock follows from #1551/#1554 being Done). `release-ralph.yml` bumps the plugin on merge. Rollback = revert the PR; the idempotency marker file is harmless orphan state. Feature E (#1555) consumes `--prepare` as-is — no schedule-only code path exists.

## References

- Issues: https://github.com/cdubiel08/ralph-hero/issues/1557, https://github.com/cdubiel08/ralph-hero/issues/1558 (parent #1553, epic #1550)
- Split record: `thoughts/shared/plans/2026-07-19-GH-1553-plan-of-plans.md`
- Epic: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md` (Feature C)
- Shipped contracts consumed: `enumerate: "human-queue"` (#1551, PR #1580); `pipeline_status_summary` (#1552, PR #1581); idea-file lifecycle contract (#1559/#1560, PR #1582)
- Answer contracts by reference: `ralph/skills/plan/plan-review.md` § Interactive vs auto; `ralph/skills/caretake/modes/unblock.md`
- Render rules: `ralph/skills/catch-up/dashboard-render.md`, `ralph/skills/catch-up/next-action-ranking.md`
