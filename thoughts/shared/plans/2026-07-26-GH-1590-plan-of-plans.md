---
date: 2026-07-26
type: plan-of-plans
github_issue: 1590
parent_epic: 1588
status: draft
tags: [surface-reduction, skills, 4cs, decomposition]
---

# GH-1590 Plan of Plans — Skill surface reduction wave 2 (47 modes → ≤22)

## Strategic Context

Wave 1 (epic #1430) collapsed 52 skills into 9 verbs. Wave 2 attacks what
survived *inside* those verbs: the 2026-07-25 audit counted 10,053 lines
across 47 mode surfaces, of which only ~45% is genuine domain knowledge.
The ceremony now contradicts itself — two taxonomy files documented as
"keep both in sync" have already diverged, a mode exists specifically to
evade another skill's hook, an agent duplicates an inline mode and is never
dispatched, and a research mode is dispatched by nothing at all.

Feature 1 of epic #1588 (#1589, merged) moved enforcement into portable
layers — `scripts/merge-pr.sh`, attestation, a ruleset-protected `main`.
That ordering was deliberate: enforcement had to exist *before* the rails
come out, so this feature can delete prose gates without losing coverage.

## Shared Constraints

- **Rosters are CI-checked.** `scripts/check-doc-rosters.sh` validates the
  agent/skill/tool rosters in `CLAUDE.md` against source. Any mode or agent
  deletion updates the rosters in the same PR or CI fails.
- **Hook tests are the regression net.** `ralph/hooks/scripts/__tests__` +
  `scripts/__tests__` run in CI; ShellCheck covers `ralph/hooks` and
  `scripts/`.
- **No lost recurring workflow.** Every deletion must cite the audit
  evidence (dead tool, duplicated body, phantom dispatch) in the PR body.
- **Terminal tokens are load-bearing.** Hooks and the `/loop` continuation
  contract grep for exact result lines; a mode merge that changes a token
  must update every consumer in the same change.
- **Merge path.** `main` is ruleset-protected — land via PR through
  `scripts/attest-pr.sh` + `scripts/merge-pr.sh` (GH-1589).

## Feature Decomposition

### Feature 1 — #1603: Delete dead caretake + catch-up modes (debug, postmortem→reflect, trends, narrative, dashboard)

Removes the five audit-confirmed dead or duplicate surfaces and folds the
surviving reflection content of `postmortem` into `retro`, renamed
`reflect`. `debug` is dead three ways (unrostered tool, tool gated off by
default, hardcoded machine path); `postmortem` reads worker infra deleted
in GH-1438; `trends` is two MCP calls that belong on a schedule;
`narrative` duplicates catch-up default Step 1; `dashboard` is ~80%
suppress-the-model prose around `pipeline_dashboard.formatted`.

Acceptance: five surfaces gone, `reflect` is the single reflection mode, no
dangling `--mode` references, rosters and hook tests green.

### Feature 2 — #1604: Merge caretake watch-pr/watch-upstream/watch-blockers into one `--mode watch --kind {pr,upstream,issue}`

Three bodies of 86/88/91 lines differ only in label matched, resolution
predicate, and terminal token. They collapse into one parameterized mode
with a per-kind table. Cross-skill: dispatch call sites live in hero
(`--mode classify`, `event-classes.md`) as well as caretake's fan-out and
`label-routing.md`.

Acceptance: one `modes/watch.md`, every dispatch site updated, branch guard
and escalation paths preserved.

### Feature 3 — #1605: Consolidate decomposition into one surface (caretake split + plan --mode epic + form Step 6b) and fix the hook scoping that forced the fork

Three surfaces decompose work today. `split-decomposition.md` states
outright that split writes the plan-of-plans because it runs in caretake
context "where the plan skill's `plan-research-required.sh` Write gate is
not armed" — the fork exists to evade a hook. Fix the hook scoping so a
decomposition write passes on its own merit, then merge the three surfaces
into one, preserving the estimate gate (M/L/XL parent), the size gate
(XS/S children), and the ≥2-children postcondition.

Acceptance: one decomposition surface, no context-based escape hatch, hero
SPLIT-phase dispatch updated in `dispatch.md` / `state-machine.md` /
`task-graph.md`.

### Feature 4 — #1606: Remove `hero --mode classify` as a public mode; fold classification into `--mode auto`

`--mode auto` is a `/loop` wrapper around `--mode classify`; the repo's own
CLAUDE.md marks classify as redundant. Classification becomes an internal
step of auto. Two details are load-bearing and must survive: the queue read
uses `next_actions({audience:"agent"})` (XS/S penalty + Backlog fallback),
and the continuation contract keys on classify's exact result lines, with
`autopilot-stop-gate.sh` arming on the observed `Skill("loop", …)` string.

Acceptance: classify is not a public mode, autopilot cadence and stop-gate
arming preserved, classify-scoped hooks updated or removed.

### Feature 5 — #1607: Single-source the shared substrate: one taxonomy file, one loop/auto reference

`label-routing.md` and `event-classes.md` become one authoritative taxonomy
(reconciled, not concatenated — they have already drifted). The loop/auto
gate substrate collapses from three copies to `shared/loop-wrapper.md` +
`shared/auto-alias.md` referenced by every consumer, and the terminal-token
table gets exactly one home.

Acceptance: one copy each of taxonomy, loop/auto substrate, and token
table; no "keep in sync" instruction remains in `ralph/skills/**`.

### Feature 6 — #1608: Rehome `research --mode prove`, delete `triage-agent`, and verify the 47→≤22 mode count

Closes out the wave. `--mode prove` is an orphan — nothing dispatches it,
no board state produces it, and it inherits 5 Stop hooks it never triggers.
`triage-agent` duplicates the inline `caretake --mode triage` body and is
never dispatched (agent roster 16 → 15). This feature is also the
acceptance gate for #1590: it produces the before/after mode tally.

Acceptance: prove rehomed with only applicable hooks, `triage-agent`
deleted and de-rostered, documented tally showing ≤22 modes across ≤9
verbs, rosters + hook tests + ShellCheck green.

## Integration Strategy

All six children are content edits to `ralph/skills/**`, `ralph/agents/**`,
`ralph/hooks/**`, and the doc rosters — one shared surface with one revert
scope. Per GH-1538 they are batch-planned as ONE group plan and ship as ONE
PR whose body carries the per-deletion audit evidence; the child estimates
size *phases* of that plan, not separate PRs.

Verification is uniform per phase: `scripts/check-doc-rosters.sh`, the hook
test suites (`ralph/hooks/scripts/__tests__`, `scripts/__tests__`),
ShellCheck, and a repo-wide grep proving no dangling reference to any
deleted mode, agent, or fragment.

The mode-count tally in Feature 6 is the epic-facing evidence: it is what
`#1590`'s first acceptance criterion is measured against.

## Feature Sequencing

```
#1603 ──┬─> #1604 ──┬─> #1607 ──┬─> #1608
        ├─> #1606 ──┘           │
        └─> #1605 ──────────────┘
```

- #1603 first — the deletions shrink the surface the other children edit.
- #1604, #1605, #1606 are parallel-safe after #1603 (disjoint mode bodies).
- #1607 after #1604 and #1606 — both rewrite rows in the taxonomy files, so
  deduping earlier would mean rebasing the same tables twice.
- #1608 last — it depends on #1605 and #1607 and produces the final tally.

## What We're NOT Doing

- MCP tool surface reduction — that is #1591 (feature 3 of the epic).
- Server-side state-machine invariants — #1592.
- Capability-tier model config — #1593.
- Adding new modes or capabilities. This is subtractive work; any behavior
  a surviving mode gains is only what a merged sibling already had.
- Touching `hero-fable`, which is deliberately rail-free and outside the
  9-verb set.
