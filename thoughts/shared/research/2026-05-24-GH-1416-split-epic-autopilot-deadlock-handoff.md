---
date: 2026-05-24
github_issue: 1416
github_url: https://github.com/cdubiel08/ralph-hero/issues/1416
status: complete
type: research
tags: [handoff, autopilot, ralph-plan, split, deadlock]
related_issues: [1416, 1417, 1403, 1404, 1406, 1407, 1408, 1409, 1410]
last_updated: 2026-05-24
last_updated_note: "Follow-up research for the GH-1416 implementation: two-part fix + the doc-structure-validator.sh plan-of-plans gap"
---

# Handoff: `/ralph:hero --auto --loop` deadlocks on split-epic clusters (GH-1416)

## Research Question

Does the backlog already track the `/ralph:hero --auto` planning deadlock on freshly-split
epic clusters, and what is the state of the fix?

**Answer:** Yes — **#1416** tracks it with a full root-cause + proposed fix, but it is parked
in null workflow-status so the autonomous pipeline never works it.

## Summary

`/ralph:hero --auto --loop` cannot drain a freshly **split** epic. Its children land in
**Ready for Plan** with complete specs in their bodies, but the autonomous planner only
accepts a per-ticket research doc *or* a parent plan-of-plans phase — never the issue body.
So every child stalls and the documented behavior is to escalate it to **Human Needed**.

The fix is already filed as **#1416** (full root-cause + proposed solution), but it is
**parked in null workflow-status** on the board, so `next_actions`/autopilot never surfaces
it, and it is `M`-sized so the XS/S auto-planner would not pick it up either.

An autopilot run on 2026-05-24 re-derived this entire deadlock from scratch (loop → classify
→ hero → plan-auto + reading 6 reference files + multiple hooks) and was about to escalate
**#1404** to Human Needed for nothing. No GitHub state was mutated.

## What triggered this handoff

- Invocation: `/ralph:hero --auto --loop` (autopilot, dynamic `/loop` wrapping `--mode classify`).
- `next_actions(audience=agent)` top-3 were **all** from the deadlocked cluster: #1404, #1406, #1407.
- Classify routed #1404 (Ready for Plan, no trigger/automation labels) → builders → `ralph:hero` → default mode → phase `PLAN`.
- `/ralph:plan --auto 1404` reached its research check, found none, and the only documented
  outcome was **escalate to Human Needed**.

## The deadlocked cluster

- Epic **#1417** ("caretake: replace bare KEEP verdict with structured successor verdicts + watcher modes"), estimate **L**, Ready for Plan.
- Children (all Ready for Plan, all XS/S, full per-phase specs in bodies):
  - #1404 Phase 1 — 8-verdict triage schema + `RALPH_TRIAGE_ACTION` validation (XS)
  - #1406 Phase 3a — `--mode watch-pr` (S)
  - #1407 Phase 3b — `--mode watch-upstream` (S)
  - #1408 Phase 4 — heartbeat fan-out wires the watchers (XS)
  - #1409 Phase 5 — director routes `blocked:*` labels (S)
  - #1410 Phase 6 — postcondition rejects bare `KEEP` (XS)
- #1416's root-cause writeup references the original split as **#1403 → #1404–#1410**; the
  live parent is now **#1417**. Either way the shape is identical: a triage→SPLIT cluster with
  **zero research docs and zero plan docs** on disk.

## Root cause (confirmed live)

The autonomous planner accepts exactly two planning inputs:

1. a per-ticket research doc at `thoughts/shared/research/*GH-NNNN*.md`, or
2. a parent **plan-of-plans** phase via the *parent-plan reuse* short-circuit
   (`ralph/skills/plan/intake-routing.md:42-63`).

A richly-spec'd **issue body is neither**, and nothing in the planning path reads the body to
decide whether planning can proceed:

- `--mode auto` picker filters to "XS/S Ready-for-Plan + unblocked + **has-linked-research**"
  → research-less children are never selected.
- If forced on a specific child, plan-auto Step 3 finds no research → **escalate to Human Needed**.
- Deterministic backstop `ralph/hooks/scripts/plan-research-required.sh` blocks the plan-doc
  `Write`: it greps the **filename** for `GH-NNNN`, looks for a matching file in
  `thoughts/shared/research/`, finds none → `exit 2`. **It never opens the issue or the body.**
  Confirmed: the slim `ralph/skills/plan` SessionStart hook sets only `RALPH_COMMAND=plan`, so
  `RALPH_REQUIRES_RESEARCH` defaults to `true`.

### Why the "obvious" escape hatches don't work

- **`--mode epic` on #1417** — its research carve-out (`intake-routing.md:39`) is *prose-only and
  unenforced*; the hook is mode-blind and fires on the epic's plan-of-plans `Write` anyway
  (filename carries `GH-1417`, no research doc). Also, epic Step 4 *creates* children — they
  already exist, so it risks duplication (the Re-decomposition path mitigates but it's still gated).
- **Manually writing the plan-of-plans from the plan skill** — same filename gate (`GH-1417` →
  research required).
- **Generating research docs per child** — works today but duplicates the already-detailed
  bodies and keeps a human/loop tick in the path.

## The fix is already filed: #1416

**"split-on-epic should emit a parent plan-of-plans so split children are autonomously plannable."**

Proposed solution: have `/ralph:caretake --mode split` (epic path) write its output as a parent
plan-of-plans to `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-plan-of-plans.md`, one
`### Phase`/`### Feature` per child (matched by number/title). Then the existing parent-plan
reuse short-circuit fires for each child during `--mode auto`: posts `## Plan Reference`,
advances child **Ready for Plan → In Progress** (skipping Plan in Review), **no per-child
research required**. Closes the gap with no new gate logic.

Why this writes successfully where the plan skill can't: split is a **caretake** skill, so the
plan skill's `plan-research-required.sh` Write hook is **not armed** in that context.

**Status problem:** #1416 sits on the board ("Ralph Workflow") with an **empty status**
(`status.name == ""`). It must be given a real workflow state or it stays invisible to the
pipeline.

## Recommended next steps (decision pending)

1. **Unblock this cluster now (fastest real work).** Hand-write the parent plan-of-plans for
   **#1417** (the child bodies are spec-complete + a `## Issue Split` comment carries the
   dependency graph) → parent-plan reuse advances #1404–1410 to In Progress → autopilot can
   implement them. One-time; must be written from a context where `plan-research-required.sh`
   is not armed (e.g. a caretake/split context, or with the gate explicitly handled).
2. **Fix the root cause (#1416).** Give it a status, plan it, implement it. Permanent — future
   splits self-heal. This *already-split* cluster still needs its plan-of-plans generated once
   (re-run split's new path, or hand-write per step 1).
3. **Both** (recommended): step 1 to drain the work that's queued, step 2 so it never recurs.
4. **Stop** — set #1416's status so it's not lost, leave autopilot stopped, hand back.

> Until #1416 ships, **re-running `/ralph:hero --auto --loop` will keep deadlocking** on this
> cluster — it dominates the top of the Ready-for-Plan queue, so the loop churns it and
> escalates each child to Human Needed.

## State left behind

- **No GitHub mutations** this run — #1404 was never locked, never escalated.
- Local hero task list (Plan/Review/Impl/PR/Finish for #1404) was created then **deleted**.
- Autopilot loop **paused** (no `ScheduleWakeup` rescheduled into the same wall).

## Files Affected

The deadlock lives in the planning path; the #1416 fix touches the split path. Relevant files:

- `ralph/skills/plan/intake-routing.md` — parent-plan reuse short-circuit (lines 42-63) and the linked-research check.
- `ralph/hooks/scripts/plan-research-required.sh` — filename-based research gate (lines 34-43); blocks the plan-doc `Write`.
- `ralph/skills/plan/SKILL.md` — `--mode auto` picker filter + Step 3 escalation; `--mode epic` decomposition.
- `ralph/skills/plan/decomposition.md` — plan-of-plans shape the fix must emit.
- `ralph/skills/caretake/modes/split.md` (split-on-epic path) — **where #1416 adds the plan-of-plans write** (caretake context, so the plan Write hook is not armed).
- `thoughts/shared/plans/YYYY-MM-DD-GH-1417-plan-of-plans.md` — the artifact that, once written, unblocks #1404–1410 via parent-plan reuse (does not yet exist).

## Key references

- Tracking issue: `#1416` — https://github.com/cdubiel08/ralph-hero/issues/1416
- Deadlocked epic: `#1417`; children `#1404`, `#1406`, `#1407`, `#1408`, `#1409`, `#1410`
- Parent-plan reuse short-circuit: `ralph/skills/plan/intake-routing.md:42-63`
- Research gate hook: `ralph/hooks/scripts/plan-research-required.sh:34-43`
- Auto-mode picker + escalation: `ralph/skills/plan/SKILL.md` (`--mode auto` §Steps 2–3, escalation triggers)
- Plan-of-plans shape: `ralph/skills/plan/decomposition.md` § Plan-of-plans shape

---

## Follow-up Research [2026-05-24] — implementation surface for the GH-1416 fix

This section is the autonomous-research findings for *implementing* #1416 (the
hero pipeline run that re-estimated it M→S and routed it through research). It
adds one load-bearing finding the original handoff did not surface: the fix is
**two parts**, not one.

### Finding: the fix is two parts (writer + validator), not just the writer

**Part 1 — Writer (expected).** Add a step to `ralph/skills/caretake/modes/split.md`
(epic path) that, after children are created (§Step 7, numbers known), writes a
parent plan-of-plans to `thoughts/shared/plans/YYYY-MM-DD-GH-<parent>-plan-of-plans.md`
per `decomposition.md` § Plan-of-plans shape — one `### Feature` section per child,
each naming the child's **real GH number + title** (so parent-plan reuse matches "by
number or title"), with a `## Feature Sequencing` graph identical to the `## Issue
Split` comment's dependency chain (AC #5). Document it in `split-decomposition.md`.

**Part 2 — Validator gap (non-obvious, required by AC #2 AND the end-to-end AC #4).**
`ralph/hooks/scripts/doc-structure-validator.sh` is a **Stop hook on the plan skill**
that selects its validation branch **by file path, not by mode** (its header comment
says so explicitly). Any doc under `thoughts/shared/plans/` gets the `plan` branch:

```bash
plan)
  grep -qE "^## Phase [0-9]" "$doc" || errors+=("Missing: '## Phase N:' header ...")
  grep -qE "^#### (Automated|Manual) Verification" "$doc" || errors+=("Missing: ... Verification")
  grep -qE "^- \[ \]" "$doc" || errors+=("Missing: success-criteria checkboxes")
  ;;
```

A plan-of-plans (`## Feature Decomposition` / `### Feature` shape) has **none** of
these and fails all three checks. The hook scans for *any* `plans/` doc modified in
the last 15 min (freshest wins). Sequence of events in the autonomous pipeline:

1. split (caretake) writes the plan-of-plans — caretake's Stop set does **not**
   include `doc-structure-validator.sh` (verified in `ralph/skills/caretake/SKILL.md`
   frontmatter: `triage/unblock/split-postcondition`, `postmortem-completeness`,
   `lock-release-on-failure`), so the write succeeds.
2. `/ralph:plan --mode auto #<child>` runs next, takes the parent-plan-reuse
   short-circuit (writes no new doc), and **Stops** — firing the plan skill's
   `doc-structure-validator.sh`.
3. That hook finds the just-written plan-of-plans as the freshest `plans/` doc,
   applies the `plan` branch, and **blocks with exit 2** (no `## Phase N`).

So without the validator fix, AC #3/#4 (child advances to In Progress, cluster drains
end-to-end) break at the child's plan-auto Stop. The fix: teach the `plan` branch to
detect a plan-of-plans (frontmatter `type: plan-of-plans` and/or a `## Feature
Decomposition` section) and validate it against plan-of-plans sections instead.

**Precedent to copy:** `ralph/hooks/scripts/plan-tier-validator.sh` already
self-discriminates plan vs plan-of-plans by shape (`## Feature Decomposition` vs
`## Phase N`), stripping fenced code blocks first to avoid false positives on
documented examples. The validator fix should mirror that detection.

### Finding: the writer side is free because split runs under caretake

`ralph/hooks/scripts/plan-research-required.sh` (the filename-only research gate) is
registered **only in the plan skill's frontmatter**, not in caretake and not in the
plugin-global `hooks.json`. Hooks fire only for the active skill's registered set, so
the research gate is **not armed** when split writes under caretake. This is why the
fix belongs in split, not plan. (Out of scope to modify this hook — issue says so.)

### Refined Files Affected (supersedes the list above for the GH-1416 fix)

**Will Modify**
- `ralph/skills/caretake/modes/split.md` — add the plan-of-plans write step (epic path).
- `ralph/skills/caretake/split-decomposition.md` — document the emission behavior + shape/naming contract.
- `ralph/hooks/scripts/doc-structure-validator.sh` — add plan-of-plans detection to the `plan` branch.

**Will Read (Dependencies)**
- `ralph/skills/plan/intake-routing.md` (reuse contract), `ralph/skills/plan/decomposition.md` (shape), `ralph/skills/plan/plan-shapes.md` (shape diffs), `ralph/hooks/scripts/plan-tier-validator.sh` (discrimination precedent), `ralph/skills/plan/SKILL.md` (`--mode epic` Step 3 pattern), `ralph/skills/caretake/SKILL.md` (Stop-hook set).

### Open design decisions for planning
- AC #2 path: teach `doc-structure-validator.sh` the plan-of-plans shape (recommended;
  matches AC wording + `plan-tier-validator.sh` precedent) vs. emit a `## Phase N`-shaped
  doc (rejected — violates plan-of-plans intent and `plan-tier-validator.sh` mixed-shape guard).
- Filename suffix: `-epic-<name>.md` (decomposition.md convention) vs `-plan-of-plans.md`
  (issue wording). Both satisfy the `*GH-NNNN-*.md` reuse glob — pick one.
- Backfilling the already-split #1417 cluster (AC #4) is one-time verification, not
  separate implementation: re-run the new split path or hand-write the doc once.
