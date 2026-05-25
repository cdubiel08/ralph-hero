---
date: 2026-05-25
status: draft
type: plan
tags: [caretake, heartbeat, watch-pr, watch-upstream, fan-out]
github_issue: 1408
github_issues: [1408]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1408
primary_issue: 1408
estimate: XS
---

# GH-1408: Add watch-pr + watch-upstream to `/ralph:caretake` heartbeat fan-out

## Prior Work

- builds_on:: [[GH-1406]] (watch-pr, merged) + [[GH-1407]] (watch-upstream, merged) — both watcher modes now exist; this phase wires them into the no-args heartbeat so they actually run on the periodic loop.
- builds_on:: parent epic [[GH-1417]] — Phase 4 of 6. Phase 5 (#1409) adds director event routing; Phase 6 (#1410) removes legacy `KEEP`.

## Overview

The `/ralph:caretake` no-args (and `--mode all`) heartbeat currently fans out to `hygiene → report → trends` — all read-mostly (dashboards). Add the two merged watcher modes (`watch-pr`, `watch-upstream`) to the serial fan-out so each heartbeat tick also *drives forward progress* (resolving PR/upstream-blocked items) instead of only printing status. Single-file documentation change to the SKILL.md Step 1 "No args" dispatch list.

## Current State Analysis

`ralph/skills/caretake/SKILL.md` Step 1 "No args" path (lines ~143-147) lists three serial `Skill()` invocations: hygiene, catch-up report, trends, then "Report consolidated outcome (one line per child)." The two watcher modes (`watch-pr`, `watch-upstream`) are fully implemented and registered (#1406/#1407) but are NOT in this fan-out, so they only run via explicit `--mode` dispatch.

### Key Discoveries

- The fan-out is a plain serial list in the SKILL.md body — adding two rows is the entire change (the issue body specifies the exact 5-mode order: hygiene → watch-pr → watch-upstream → report → trends).
- `--mode all` shares this path (Step 1 "No args **or** `--mode all`"), so both entrypoints pick up the new modes automatically.
- The consolidated-outcome line says "one line per child" — it's count-agnostic, so it already accommodates 5 children, but the plan calls out the expectation explicitly per the AC.
- The watcher modes emit `WATCH-PR/UPSTREAM IDLE` when there's nothing to do — a clean no-op on an empty board, so adding them to the heartbeat carries no regression risk for the existing hygiene/report/trends behavior.

## Desired End State

1. The SKILL.md Step 1 "No args" fan-out invokes all 5 modes in the documented order: hygiene → watch-pr → watch-upstream → report → trends.
2. The consolidated-outcome instruction reflects 5 children.
3. No regression to the existing 3-mode behavior; watch modes reporting `IDLE` are benign.

### Verification

- The fan-out list in `SKILL.md` Step 1 contains 5 numbered `Skill()` invocations in the documented order.
- `grep` confirms `--mode watch-pr` and `--mode watch-upstream` appear in the no-args fan-out block.

## What We're NOT Doing

- **No watcher mode implementation** — done in #1406/#1407.
- **No `--loop` manifest rows** for the individual watch modes — the heartbeat (`--mode all`, 1h) already carries them via fan-out; per-mode loop drains are a separate concern not requested here.
- **No director routing** of `blocked:*` labels — Phase 5 (#1409).
- **No change to the heartbeat interval** (stays 1h / `--mode all` default).

## Implementation Approach

One phase, one file. Edit the SKILL.md Step 1 "No args" serial list to insert `watch-pr` and `watch-upstream` between `hygiene` and `report`, matching the issue body's exact ordering, and update the consolidated-outcome note to "one line per child (5 total)".

## Phase 1: Extend the heartbeat fan-out list

depends_on: null

### Overview

Insert the two watcher invocations into the SKILL.md Step 1 "No args" fan-out and update the outcome note.

### Changes Required

#### 1. Heartbeat fan-out list
**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: In the Step 1 "No args" path, change the 3-item serial list to the 5-item order: (1) `--mode hygiene`, (2) `--mode watch-pr`, (3) `--mode watch-upstream`, (4) catch-up `--mode report`, (5) `--mode trends`. Update the trailing note to "Report consolidated outcome (one line per child — 5 total)."

### Success Criteria

#### Automated Verification
- [ ] `grep -A8 'No args.*--mode all.*heartbeat fan-out' ralph/skills/caretake/SKILL.md` shows 5 numbered invocations including `--mode watch-pr` and `--mode watch-upstream`.
- [ ] `grep -c 'mode watch-pr\|mode watch-upstream' ralph/skills/caretake/SKILL.md` increased (the fan-out now references both, in addition to their mode-table/bodies rows).
- [ ] The order in the list is hygiene → watch-pr → watch-upstream → report → trends (manual eyeball of the numbered list).

#### Manual Verification
- [ ] Reading Step 1, a no-args `/ralph:caretake` clearly drives all 5 modes; the consolidated-outcome note says 5 children.

## Testing Strategy

### Unit Tests
- None (markdown-only).

### Integration Tests
- N/A — no TS/scripts touched; CI suites unaffected.

### Manual Testing Steps
1. Read SKILL.md Step 1 "No args" — confirm the 5-mode order.
2. (Optional, post-merge) Run `/ralph:caretake` no-args and confirm 5 child outcome lines, with `WATCH-PR IDLE` / `WATCH-UPSTREAM IDLE` on an empty board (no regression).

## Migration Notes

- Purely additive to the fan-out; existing hygiene/report/trends behavior is unchanged. The watcher modes are no-ops (`IDLE`) when no `blocked:*` items exist.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1408
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1417
- Fan-out location: `ralph/skills/caretake/SKILL.md` Step 1 "No args" path
- Watcher modes (merged): `ralph/skills/caretake/modes/watch-pr.md` (#1406), `ralph/skills/caretake/modes/watch-upstream.md` (#1407)
