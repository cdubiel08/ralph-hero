---
date: 2026-05-25
status: draft
type: plan
tags: [director, classify, event-classes, blocked-labels, watcher-routing]
github_issue: 1409
github_issues: [1409]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1409
primary_issue: 1409
estimate: S
---

# GH-1409: Director routes `blocked:*` labels to matching watcher modes

## Prior Work

- builds_on:: [[GH-1406]] (watch-pr) + [[GH-1407]] (watch-upstream) + [[GH-1408]] (heartbeat fan-out) — all merged. The watcher modes + heartbeat exist; this phase adds **event-driven** dispatch so a `blocked:*` item routes to its watcher immediately (e.g. on a PR-merge webhook) instead of waiting for the ~1h heartbeat.
- builds_on:: parent epic [[GH-1417]] — Phase 5 of 6. Phase 6 (#1410) removes legacy `KEEP` and closes the epic.
- tensions:: none material — the issue's file list matches the repo (both `event-classes.md` copies + both classify bodies exist, verified on main).

## Overview

Teach the event classifier (slim `/ralph:hero --mode classify` and legacy `ralph-hero:director`) to dispatch `blocked:*`-labelled items to the matching caretake watcher mode: `blocked:pr-*` → `caretake --mode watch-pr`, `blocked:upstream` → `caretake --mode watch-upstream`. Insert a new priority tier **between** explicit `trigger:*` labels and automation labels, so a watched-blocker item is handled by its watcher rather than falling through to the `workflow_state` path (which would send a Backlog item to triage).

## Current State Analysis

`event-classes.md` (the canonical classifier schema, mirrored in slim `ralph/skills/hero/` and legacy `plugin/ralph-hero/skills/director/`) defines three priority tiers: **P1 trigger:\*** → **P2 automation labels** → **P3 workflow_state**. The classify body (`SKILL.md --mode classify` step 3) applies this order to set `TEAM`/`ENTRYPOINT`/`DISPATCH_REASON`/`CONSUMED_LABEL`.

### Key Discoveries

- The priority numbers are referenced in **three** places that must stay in sync: the section headers (`## Priority N`), the `## Classification algorithm` numbered steps, and the `## iOS-mode sentinel` note ("Priority 3 (workflow_state-driven)…"). Inserting a tier requires renumbering all three. (`ralph/skills/hero/event-classes.md:9,21,32,64-72,82`.)
- **`blocked:*` labels must NOT be consumed** on dispatch — unlike `trigger:*` (which classify removes after dispatch), the `blocked:pr-NNN`/`blocked:upstream` label persists until the watcher resolves the condition. So the new tier sets `CONSUMED_LABEL=none` (same as automation labels and workflow_state, which also don't consume).
- The dispatch target is **mode-specific within the caretakers team**: `Skill("ralph:caretake", args="--mode watch-pr --issue NNN")` / `--mode watch-upstream`. The taxonomy's `team` column is `caretakers`, but the entrypoint carries the specific `--mode`, so the classify body needs a `blocked:*` → mode mapping (not just team → entrypoint).
- **AC3 ("blocked:* does NOT advance via workflow_state while watcher is responsible") falls out of the priority ordering for free** — because the new tier is checked before workflow_state, a `blocked:*` Backlog item routes to the watcher, never to Backlog→caretakers-triage.
- `blocked:pr-*` is a family (per-PR suffix); `blocked:upstream` is a single fixed label — the classify match logic must prefix-match `blocked:pr-` and exact-match `blocked:upstream`.

## Desired End State

1. Both `event-classes.md` copies define a new priority tier (between trigger:* and automation) with two rows: `blocked:pr-*` → caretakers/`--mode watch-pr`, `blocked:upstream` → caretakers/`--mode watch-upstream`. Automation → P3, workflow_state → P4; algorithm + iOS-sentinel + intro prose renumbered consistently.
2. Both classify bodies (`ralph/skills/hero/SKILL.md`, `plugin/ralph-hero/skills/director/SKILL.md`) apply the new order and dispatch `blocked:pr-*`→watch-pr / `blocked:upstream`→watch-upstream, WITHOUT consuming the label.
3. No regression to existing trigger / automation / workflow_state routing.

### Verification

- Both `event-classes.md` contain a `blocked:pr-*` and a `blocked:upstream` row in a tier ordered before automation labels.
- The classification algorithm step list checks `blocked:*` between `trigger:*` and automation.
- No stale "Priority 3 (workflow_state…)" reference remains where workflow_state is now P4.
- `grep` confirms both classify bodies reference `--mode watch-pr` / `--mode watch-upstream` dispatch for `blocked:*`.

## What We're NOT Doing

- **No webhook plumbing** — relies on existing GH Actions routing (out of scope per issue).
- **No watcher mode implementation** — done in #1406/#1407.
- **No label consumption** for `blocked:*` — the watcher owns the label lifecycle; classify must not strip it.
- **No change to the running autopilot loop's behavior** — it loads classify from the versioned `0.1.15` cache, not this repo source; these edits take effect on the next plugin publish, not mid-session.

## Implementation Approach

Two phases by surface. Phase 1 = slim active path (`ralph/skills/hero/event-classes.md` + `SKILL.md`). Phase 2 = legacy parallel surface (`plugin/ralph-hero/skills/director/event-classes.md` + `SKILL.md`), copying the same tier/rows/algorithm so the two stay in sync. Phase 2 depends on Phase 1 so the tier wording is fixed once.

New tier (identical in both copies):

```
## Priority 2 — Blocked-condition labels (watcher routing)
| workflow_state | labels | team | entrypoint |
| any | blocked:pr-*    | caretakers | caretake --mode watch-pr --issue NNN |
| any | blocked:upstream | caretakers | caretake --mode watch-upstream --issue NNN |
```
(automation labels → Priority 3; workflow_state → Priority 4). Label NOT consumed.

## Phase 1: Slim active path (event-classes.md + classify body)

depends_on: null

### Overview

Add the `blocked:*` tier to the slim `event-classes.md` and teach the slim `--mode classify` body to route + not-consume.

### Changes Required

#### 1. Slim taxonomy
**File**: `ralph/skills/hero/event-classes.md`
**Changes**: Insert a new `## Priority 2 — Blocked-condition labels (watcher routing)` section (the two-row table above) between the current P1 (trigger) and P2 (automation). Renumber automation → `## Priority 3`, workflow_state → `## Priority 4`. Update: the intro prose (line ~3) to mention the blocked tier; the `## Classification algorithm` steps to insert a `blocked:*` check (prefix-match `blocked:pr-`, exact-match `blocked:upstream`) between the trigger check and the automation check, renumbering subsequent steps; the `## iOS-mode sentinel` note's "Priority 3 (workflow_state-driven)" → "Priority 4". Note in the new section that the label is NOT consumed (watcher owns its lifecycle).

#### 2. Slim classify body
**File**: `ralph/skills/hero/SKILL.md`
**Changes**: In the `--mode classify` body's classify step (the one applying "trigger:* → automation → workflow_state" priority order), insert the `blocked:*` tier: after the `trigger:*` check and before automation, if a `blocked:pr-*` label is present set `TEAM=caretakers`, `ENTRYPOINT=ralph:caretake`, the dispatch arg `--mode watch-pr --issue NNN`, `DISPATCH_REASON=blocked:pr`, `CONSUMED_LABEL=none`; `blocked:upstream` → `--mode watch-upstream`. Ensure the dispatch step passes the `--mode` arg, and the label-consume step skips `blocked:*` (no consumption).

### Success Criteria

#### Automated Verification
- [ ] `grep -qE 'blocked:pr-\*' ralph/skills/hero/event-classes.md` and `grep -qE 'blocked:upstream' ralph/skills/hero/event-classes.md`.
- [ ] `grep -qE 'Priority 4' ralph/skills/hero/event-classes.md` (workflow_state renumbered) and no remaining "Priority 3 (workflow_state" reference: `! grep -q 'Priority 3 (workflow_state' ralph/skills/hero/event-classes.md`.
- [ ] `grep -qE 'watch-pr|watch-upstream' ralph/skills/hero/SKILL.md` in the classify body.
- [ ] The classification algorithm lists a `blocked:*` check between trigger and automation (manual-confirmable via grep of the steps).

#### Manual Verification
- [ ] The new tier documents that `blocked:*` is NOT consumed, and the priority ordering guarantees a `blocked:*` Backlog item routes to its watcher (not Backlog→triage).

## Phase 2: Legacy director surface (parity)

depends_on: [phase-1]

### Overview

Mirror the Phase 1 taxonomy + classify changes into the legacy `plugin/ralph-hero/skills/director/` copies so the two surfaces stay in sync.

### Changes Required

#### 1. Legacy taxonomy
**File**: `plugin/ralph-hero/skills/director/event-classes.md`
**Changes**: Apply the identical tier insertion + renumbering + algorithm/iOS-sentinel/intro updates as Phase 1 change #1.

#### 2. Legacy director body
**File**: `plugin/ralph-hero/skills/director/SKILL.md`
**Changes**: Apply the identical `blocked:*` dispatch + no-consume logic as Phase 1 change #2 (adapt to the legacy body's existing classify-step wording).

### Success Criteria

#### Automated Verification
- [ ] `grep -qE 'blocked:pr-\*' plugin/ralph-hero/skills/director/event-classes.md` and `grep -qE 'blocked:upstream' …`.
- [ ] `grep -qE 'watch-pr|watch-upstream' plugin/ralph-hero/skills/director/SKILL.md`.
- [ ] No remaining stale "Priority 3 (workflow_state" reference in the legacy event-classes.md.

#### Manual Verification
- [ ] The legacy taxonomy tier + rows are identical to the slim copy (diff the two new sections — no drift).

## Testing Strategy

### Unit Tests
- None (skill-markdown only). Verification greps are the gate.

### Integration Tests
- N/A — no TS/scripts touched; CI build/test suites unaffected.

### Manual Testing Steps
1. Read both `event-classes.md` — confirm the 4-tier order (trigger → blocked:* → automation → workflow_state) and consistent algorithm numbering.
2. Trace a hypothetical `blocked:pr-1338` Backlog item through the classify body → confirms it dispatches `caretake --mode watch-pr --issue NNN` and does NOT consume the label or fall to the Backlog→triage path.

## Migration Notes

- Renumbering P2→P3 (automation) and P3→P4 (workflow_state) is internal to `event-classes.md`; no other file references these tier numbers by name (verified — only the in-file algorithm + iOS-sentinel note do).
- `blocked:*` labels are produced by triage's `WAIT-pr`/`WAIT-upstream` verdicts (#1404) and consumed by the watcher modes (#1406/#1407) — this phase only adds the event-driven *routing*, not the producers or consumers.
- The running autopilot loop is unaffected (loads classify from the versioned cache, not this source).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1409
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1417
- Taxonomy: `ralph/skills/hero/event-classes.md` + `plugin/ralph-hero/skills/director/event-classes.md`
- Classify bodies: `ralph/skills/hero/SKILL.md` (`--mode classify`) + `plugin/ralph-hero/skills/director/SKILL.md`
- Watcher modes (merged): `ralph/skills/caretake/modes/watch-pr.md` (#1406), `watch-upstream.md` (#1407)
