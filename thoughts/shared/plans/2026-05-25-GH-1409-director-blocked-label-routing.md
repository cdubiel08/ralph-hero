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

> **Iteration 1** (after critique `2026-05-25-GH-1409-critique.md`): the watcher modes are **board-wide sweeps that ignore `--issue NNN`** → dispatch drops the issue arg and is reframed as an event-driven sweep; the two `event-classes.md` copies are **not** identical (slim `ralph:` vs legacy `ralph-hero:` prefixes); the legacy `director/SKILL.md` inlines its own Priority headers + sentinel note that also need renumbering; the bare-`NNN` dispatch convention is explicitly reconciled.

## Prior Work

- builds_on:: [[GH-1406]] (watch-pr) + [[GH-1407]] (watch-upstream) + [[GH-1408]] (heartbeat fan-out) — all merged. The watcher modes + heartbeat exist; this phase adds **event-driven** dispatch so a `blocked:*` item routes to its watcher immediately (e.g. on a PR-merge webhook) instead of waiting for the ~1h heartbeat.
- builds_on:: parent epic [[GH-1417]] — Phase 5 of 6. Phase 6 (#1410) removes legacy `KEEP` and closes the epic.
- tensions:: the issue body passes `--issue NNN` to the watcher dispatch, but `watch-pr.md`/`watch-upstream.md` are **board-wide sweeps** (`list_issues(... limit:250)` over the whole parked set) that read no `TARGET_ISSUE` — so this plan drops `--issue NNN` and treats the dispatch as "fire the sweep now." Also the slim and legacy `event-classes.md` copies are **not** byte-identical: they diverge on the entrypoint prefix (`ralph:` vs `ralph-hero:`), so each file's new rows follow its own convention.

## Overview

Teach the event classifier (slim `/ralph:hero --mode classify` and legacy `ralph-hero:director`) to fire the matching caretake watcher **sweep** when it classifies a `blocked:*`-labelled item: `blocked:pr-*` → `caretake --mode watch-pr`, `blocked:upstream` → `caretake --mode watch-upstream`. Insert a new priority tier **between** explicit `trigger:*` labels and automation labels, so a watched-blocker item is handed to its watcher rather than falling through to the `workflow_state` path (which would send a Backlog item to triage).

**Event-driven, not single-item.** The watcher modes sweep the whole parked set; dispatching one on a `blocked:*` event means "run the sweep now (resolving every parked item whose condition is met, including the trigger) instead of waiting for the heartbeat." The dispatch carries no issue scoping.

## Current State Analysis

`event-classes.md` (the classifier schema, mirrored in slim `ralph/skills/hero/` and legacy `plugin/ralph-hero/skills/director/`) defines three priority tiers: **P1 trigger:\*** → **P2 automation labels** → **P3 workflow_state**. The classify body (`SKILL.md --mode classify`) applies this order and dispatches via `Skill(ENTRYPOINT, args="NNN")` — a **bare issue number**.

### Key Discoveries

- **The watcher modes ignore `--issue NNN`.** `watch-pr.md` §Step 2 = `list_issues(profile:"analyst-triage", workflowState:"Backlog", limit:250)` + client-side `blocked:pr-*` filter; `watch-upstream.md` = `list_issues(... label:"blocked:upstream", limit:250)`. Neither reads a target issue. So the dispatch is `--mode watch-pr` / `--mode watch-upstream` with **no** `--issue NNN` (the arg would be dead and misleading).
- **The two `event-classes.md` copies pre-diverge** on entrypoint prefix: slim rows use `ralph:hero`/`ralph:caretake`; legacy rows use `ralph-hero:hero`/`ralph-hero:caretake`. The new `blocked:*` rows follow each file's local convention — NOT byte-identical.
- **Priority numbers are referenced in-file in several spots** that must be renumbered consistently:
  - **slim** `event-classes.md`: section headers (`## Priority 1/2/3`), intro prose, `## Classification algorithm` steps, `## iOS-mode sentinel` note ("Priority 3 (workflow_state-driven)"). The slim `hero/SKILL.md --mode classify` body names the order in *prose* (no numbered headers).
  - **legacy** `director/event-classes.md`: same. **Additionally** the legacy `director/SKILL.md` **inlines** its own `**Priority 1 …**` / `**Priority 2 — Automation labels**` / `**Priority 3 — Workflow state**` headers + a sentinel note ("Priority 3 … do NOT write the sentinel") — all need insert+renumber.
- **`blocked:*` labels must NOT be consumed** on dispatch — unlike `trigger:*` (which classify removes), the label persists until the watcher resolves the condition. New tier sets `CONSUMED_LABEL=none`.
- **Dispatch-arg convention break (deliberate):** existing dispatch is `Skill(ENTRYPOINT, args="NNN")` (bare number); the legacy body explicitly notes "bare number `NNN` (not `--issue NNN`)". The `blocked:*` branch is the exception — it dispatches `Skill("<prefix>:caretake", args="--mode watch-pr")` (a mode arg, no issue number). Both classify bodies special-case this branch; the legacy "bare NNN" note gets a carve-out.
- **AC3 is satisfied by the ordering** — the new tier precedes workflow_state, so a `blocked:*` Backlog item routes to its watcher, never to Backlog→triage.
- `blocked:pr-*` is prefix-matched (per-PR family); `blocked:upstream` is exact-matched.

## Desired End State

1. Both `event-classes.md` copies define a new tier (before automation) with two rows — `blocked:pr-*` → caretakers/`<prefix>:caretake --mode watch-pr`, `blocked:upstream` → caretakers/`--mode watch-upstream` — each using its file's entrypoint prefix. Automation → P3, workflow_state → P4; intro prose + algorithm + iOS-sentinel renumbered.
2. Both classify bodies fire the watcher sweep for `blocked:*` (dispatch `--mode watch-<x>`, NO `--issue`, label NOT consumed). The legacy `director/SKILL.md` inline Priority headers + sentinel note are renumbered too.
3. No regression to trigger / automation / workflow_state routing.

### Verification

- Both `event-classes.md` contain `blocked:pr-*` + `blocked:upstream` rows in a tier ordered before automation.
- No stale `Priority 3 (workflow_state` / `Priority 3 — Workflow` reference remains in either `event-classes.md` OR the legacy `director/SKILL.md`.
- Both classify bodies dispatch `--mode watch-pr` / `--mode watch-upstream` (no `--issue NNN`); the dispatch is documented as a board-wide sweep.

## What We're NOT Doing

- **No `--issue NNN` scoping** of the watcher dispatch — the modes are board-wide sweeps; the dispatch fires the whole sweep (descoped from the issue body's literal arg).
- **No watcher mode implementation** (#1406/#1407) — including no new `--issue` scoping inside the modes (that would be a mode change, out of scope).
- **No label consumption** for `blocked:*` — the watcher owns the label lifecycle; classify must not strip it.
- **No `label-routing.md` change** — that file is caretake's *own* default-event dispatch table (for `/ralph:caretake --issue NNN`), a different surface from the classifier. #1409's ACs name `event-classes.md` + the classify bodies only. Adding `blocked:*` rows there would help caretake's event-driven path too, but is a reasonable **follow-up**, not this phase (noted so the omission is deliberate).
- **No webhook plumbing** — relies on existing GH Actions routing.
- **No change to the running autopilot loop** — it classifies from the versioned `0.1.15` cache, not this source; edits take effect on the next plugin publish.

## Implementation Approach

Two phases by surface. Phase 1 = slim active path (`ralph/skills/hero/event-classes.md` + `SKILL.md`). Phase 2 = legacy parallel surface (`plugin/ralph-hero/skills/director/event-classes.md` + `SKILL.md`), copying the same tier/rows/algorithm so the two stay in sync. Phase 2 depends on Phase 1 so the tier wording is fixed once.

New tier (per-file prefix — `ralph:` slim / `ralph-hero:` legacy):

```
## Priority 2 — Blocked-condition labels (watcher routing)
| workflow_state | labels | team | entrypoint (not consumed) |
| any | blocked:pr-*     | caretakers | <prefix>:caretake --mode watch-pr |
| any | blocked:upstream | caretakers | <prefix>:caretake --mode watch-upstream |
```
(automation labels → Priority 3; workflow_state → Priority 4). Dispatch fires a board-wide sweep (no `--issue`); label persists.

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
**Changes**: In the `--mode classify` body's classify step, after the `trigger:*` check and before automation: if a `blocked:pr-*` label is present → `TEAM=caretakers`, `ENTRYPOINT=ralph:caretake`, dispatch arg `--mode watch-pr` (NO `--issue NNN` — the watcher is a board-wide sweep), `DISPATCH_REASON=blocked:pr`, `CONSUMED_LABEL=none`; `blocked:upstream` → `--mode watch-upstream`. Special-case the dispatch step so the `blocked:*` branch emits `Skill("ralph:caretake", args="--mode watch-pr")` (a mode arg, NOT a bare `NNN`); all other branches keep `args="NNN"`. The consume step skips `blocked:*`.

### Success Criteria

#### Automated Verification
- [ ] `grep -qE 'blocked:pr-\*' ralph/skills/hero/event-classes.md` and `grep -qE 'blocked:upstream' ralph/skills/hero/event-classes.md`.
- [ ] `grep -qE 'Priority 4' ralph/skills/hero/event-classes.md` (workflow_state renumbered) and no remaining "Priority 3 (workflow_state" reference: `! grep -q 'Priority 3 (workflow_state' ralph/skills/hero/event-classes.md`.
- [ ] `grep -qE 'watch-pr|watch-upstream' ralph/skills/hero/SKILL.md` in the classify body, with `--mode` (not `--issue`).
- [ ] `! grep -qE 'watch-pr --issue|watch-upstream --issue' ralph/skills/hero/SKILL.md` (no dead `--issue` arg).
- [ ] The classification algorithm lists a `blocked:*` check between trigger and automation.

#### Manual Verification
- [ ] The new tier documents NOT-consumed + board-wide-sweep semantics; the ordering guarantees a `blocked:*` Backlog item routes to its watcher (not Backlog→triage).

## Phase 2: Legacy director surface (parity)

depends_on: [phase-1]

### Overview

Mirror the Phase 1 taxonomy + classify changes into the legacy `plugin/ralph-hero/skills/director/` copies so the two surfaces stay in sync.

### Changes Required

#### 1. Legacy taxonomy
**File**: `plugin/ralph-hero/skills/director/event-classes.md`
**Changes**: Apply the same tier insertion + renumbering + intro/algorithm/iOS-sentinel updates as Phase 1 change #1, but the new rows use the **`ralph-hero:caretake`** entrypoint (matching this file's existing `ralph-hero:` prefix convention — NOT identical to the slim copy).

#### 2. Legacy director body
**File**: `plugin/ralph-hero/skills/director/SKILL.md`
**Changes**: (a) Insert a `**Priority 2 — Blocked-condition labels**` block after the existing `**Priority 1 …**`; renumber the inline `**Priority 2 — Automation labels**` → Priority 3 and `**Priority 3 — Workflow state**` → Priority 4; fix the sentinel note ("Priority 3 … do NOT write the sentinel" → "Priority 4"). (b) Add the `blocked:*` → `Skill("ralph-hero:caretake", args="--mode watch-pr|--mode watch-upstream")` dispatch (no `--issue`, no consume), and add a carve-out to the body's "bare number `NNN` (not `--issue NNN`)" note exempting the `blocked:*` branch (which passes a `--mode` arg).

### Success Criteria

#### Automated Verification
- [ ] `grep -qE 'blocked:pr-\*' plugin/ralph-hero/skills/director/event-classes.md` and `grep -qE 'blocked:upstream' …`.
- [ ] `grep -qE 'watch-pr|watch-upstream' plugin/ralph-hero/skills/director/SKILL.md` (with `--mode`).
- [ ] `! grep -qE 'Priority 3 .*([Ww]orkflow)' plugin/ralph-hero/skills/director/event-classes.md` AND `! grep -qE 'Priority 3 .*([Ww]orkflow)' plugin/ralph-hero/skills/director/SKILL.md` (no stale tier number in EITHER legacy file).

#### Manual Verification
- [ ] The legacy taxonomy tier matches the slim one EXCEPT the entrypoint prefix (`ralph-hero:` vs `ralph:`) — the same divergence the other rows already have. The legacy `SKILL.md` inline Priority headers are all renumbered.

## Testing Strategy

### Unit Tests
- None (skill-markdown only). Verification greps are the gate.

### Integration Tests
- N/A — no TS/scripts touched; CI build/test suites unaffected.

### Manual Testing Steps
1. Read both `event-classes.md` — confirm the 4-tier order (trigger → blocked:* → automation → workflow_state) and consistent algorithm numbering.
2. Trace a `blocked:pr-1338` Backlog item through the classify body → confirms it dispatches `caretake --mode watch-pr` (board-wide sweep, NO `--issue`), does NOT consume the label, and does NOT fall to the Backlog→triage path.
3. Confirm no stale "Priority 3 (workflow_state)" sentinel text remains in either surface (incl. legacy `SKILL.md`).

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
