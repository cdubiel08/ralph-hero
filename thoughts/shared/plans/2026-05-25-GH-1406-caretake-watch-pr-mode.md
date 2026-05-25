---
date: 2026-05-25
status: draft
type: plan
tags: [caretake, watch-pr, watcher, deferred-verdict]
github_issue: 1406
github_issues: [1406]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1406
primary_issue: 1406
estimate: S
---

# GH-1406: Add `/ralph:caretake --mode watch-pr` for `blocked:pr-*` items

## Prior Work

- builds_on:: [[GH-1404]] (Phase 1, **merged** via PR #1420) — established the `WAIT-pr=NNN` verdict that parks a Backlog item with a `blocked:pr-NNN` label + a `## Triage Decision` comment. This phase ships the watcher that resolves those parked items.
- builds_on:: parent epic [[GH-1417]] — Phase 3a of 6. Phase 3b (#1407, `watch-upstream`) is the sibling; Phase 4 (#1408) wires both into the heartbeat fan-out; Phase 5 (#1409) adds director routing.
- tensions:: the issue body says watch-pr should "read the deferred verdict from a `## Deferred Verdict` comment", but Phase 1 (#1404, merged) writes a `## Triage Decision` comment + `blocked:pr-NNN` label — **no `## Deferred Verdict` comment exists**. This plan resolves the gap by defaulting the post-merge verdict to `PROMOTE-plan` (the issue's "typically `PROMOTE-plan`"), optionally honoring an explicit `## Deferred Verdict` comment if a future phase adds one (forward-compatible, no hard dependency).

## Overview

Add a new caretake mode, `watch-pr`, that resolves Backlog items parked by the `WAIT-pr` triage verdict. It scans `blocked:pr-NNN`-labelled items, checks each referenced PR's merge state via `gh`, and acts: on **merged** → strip the label + apply the deferred verdict (default `PROMOTE-plan` → Ready for Plan); on **open** → leave untouched; on **closed-not-merged** → escalate (`WAIT-decision` → Human Needed) so a human re-decides. The mode emits a `WATCH-PR ADVANCED <N>` / `WATCH-PR IDLE` terminal token.

This is the consumer that makes the `WAIT-pr` verdict non-dead-ending: an item waits on a *named, watched condition* (the PR) and advances automatically when that condition resolves — the core fix the epic exists to deliver.

## Current State Analysis

The caretake skill (`ralph/skills/caretake/SKILL.md`) is a one-verb board steward with 8 named modes, each a body under `ralph/skills/caretake/modes/`. Mode bodies set their own `RALPH_SUBCOMMAND` and emit a terminal token from `ralph/skills/caretake/outcome-tokens.md`. The closest structural analog is `modes/hygiene.md` — a scan-and-act mode with no Stop postcondition hook (it mutates only bookkeeping, not gated semantic state).

### Key Discoveries

- **Mode wiring is three touch-points**: (1) a `modes/<name>.md` body, (2) a row in the SKILL.md `## Modes` table + a `## Mode bodies` dispatch note, (3) terminal tokens in `outcome-tokens.md`. (`ralph/skills/caretake/SKILL.md:91-102, 139-151`.)
- **No new tools needed**: caretake's `allowed-tools` already includes `Bash` (for `gh pr view`), `list_issues`, `save_issue` (label + workflowState mutation), and `create_comment` (`SKILL.md:55-84`). No frontmatter change required.
- **No new hook required**: per `modes/hygiene.md:131`, scan-act modes that don't need a postcondition gate simply don't register one. The Stop chain's existing hooks are each scoped to their own `RALPH_SUBCOMMAND` and pass through for `watch-pr`. Token emission is by convention (like hygiene/trends).
- **Label query is client-side filtered**: `list_issues` takes a single exact `label` param (`triage.md:31`), but `blocked:pr-*` is a family. The mode lists Backlog issues and filters client-side for any label matching the `blocked:pr-` prefix, extracting `NNN` from the label suffix.
- **`## Deferred Verdict` does not exist** (see Prior Work tensions). Default to `PROMOTE-plan`; honor an explicit `## Deferred Verdict: <verdict>` comment only if present.

## Desired End State

1. `ralph/skills/caretake/modes/watch-pr.md` exists and documents the scan → check-merge-state → act loop with the 3 outcome branches (merged / open / closed-unmerged).
2. `Skill("ralph:caretake", args="--mode watch-pr")` runs end-to-end: lists `blocked:pr-*` items, checks each PR, acts, emits a terminal token.
3. SKILL.md `## Modes` table + `## Mode bodies` reference the new mode; `outcome-tokens.md` documents `WATCH-PR ADVANCED <N>` and `WATCH-PR IDLE`.
4. No existing mode or hook regresses.

### Verification

- `test -f ralph/skills/caretake/modes/watch-pr.md` and it contains the 3 outcome branches.
- `grep -q "watch-pr" ralph/skills/caretake/SKILL.md` (mode table + dispatch).
- `grep -q "WATCH-PR ADVANCED" ralph/skills/caretake/outcome-tokens.md`.
- The mode body references only tools in caretake's existing `allowed-tools` (no undeclared tool).
- A dry read-through confirms the `blocked:pr-NNN` → PR-number extraction and the default-`PROMOTE-plan` reconciliation are documented.

## What We're NOT Doing

- **No `watch-upstream` mode** — Phase 3b (#1407).
- **No heartbeat fan-out / `--loop` manifest wiring** — Phase 4 (#1408). This phase adds the mode + manual dispatch only; it does NOT add a `caretake:watch-pr` row to `loop-wrapper.md` or wire `--mode all`.
- **No director event-driven routing** of `blocked:*` labels — Phase 5 (#1409).
- **No new Stop postcondition hook** — consistent with hygiene; token emission is by convention. (A `watch-pr-state-gate` could be a later hardening, out of scope here.)
- **No amendment to Phase 1 (#1404, merged)** to add a `## Deferred Verdict` comment — we default to `PROMOTE-plan` instead.
- **No automated test of live `gh pr` calls** — the AC calls for a manual test against a known-merged PR-blocked issue.

## Implementation Approach

Two phases by file ownership. Phase 1 writes the mode body (the substance). Phase 2 wires it into the SKILL.md mode table + dispatch note and adds the terminal tokens. Phase 2 depends on Phase 1 so the mode name/token strings are fixed once.

Outcome-branch contract:

| PR state | Action | Token contribution |
|---|---|---|
| MERGED | strip `blocked:pr-NNN`; apply deferred verdict (default `PROMOTE-plan` → Ready for Plan; `save_issue(command:"ralph_triage")`); post `## Watch-PR Resolution` comment | counts toward `ADVANCED <N>` |
| OPEN | leave untouched (still waiting) | no-op |
| CLOSED (not merged) | post comment; apply `WAIT-decision` → Human Needed + `## Escalation` comment; keep `ralph-triage` | counts toward `ADVANCED <N>` (resolved by escalation) |

If zero `blocked:pr-*` items exist, emit `WATCH-PR IDLE`.

## Phase 1: Write the `watch-pr` mode body

depends_on: null

### Overview

Create `ralph/skills/caretake/modes/watch-pr.md` documenting the scan-check-act loop, mirroring the structure/voice of `modes/hygiene.md`.

### Changes Required

#### 1. New mode body
**File**: `ralph/skills/caretake/modes/watch-pr.md` (create)
**Changes**: Document, in numbered steps:
- `export RALPH_SUBCOMMAND=watch-pr`.
- §Step 1 — branch check (`git branch --show-current` must be `main`; else emit the dedicated `WATCH-PR SKIPPED — branch <name> is not main` token + skip, matching the house style of triage's `TRIAGED skipped — branch …` and unblock's `UNBLOCK REQUEST SKIPPED — branch …`. Do NOT reuse `WATCH-PR IDLE` for the branch-skip — IDLE means "no parked items found", a distinct outcome).
- §Step 2 — list Backlog issues (`list_issues`), filter client-side for labels matching `^blocked:pr-([0-9]+)$`, extract the PR number.
- §Step 3 — for each, `gh pr view <NNN> --json state,mergedAt` and branch per the outcome-branch table (merged / open / closed-not-merged).
- §Step 4 — deferred-verdict resolution: default `PROMOTE-plan`; if a `## Deferred Verdict: <verdict>` comment exists, honor it. Document the reconciliation note (Phase 1 writes `## Triage Decision`, not `## Deferred Verdict`).
- §Step 5 — emit `WATCH-PR ADVANCED <N>` where `<N>` counts items **resolved this sweep** (merged→promoted PLUS closed-unmerged→escalated), or `WATCH-PR IDLE` (zero `blocked:pr-*` items found). Open/still-waiting items do NOT count toward `<N>`.
- §Constraints — one sweep per invocation; only mutates `blocked:pr-*`-labelled Backlog items; no issue creation.

### Success Criteria

#### Automated Verification
- [ ] `test -f ralph/skills/caretake/modes/watch-pr.md` exits 0.
- [ ] `grep -qE "RALPH_SUBCOMMAND=watch-pr" ralph/skills/caretake/modes/watch-pr.md`.
- [ ] `grep -qE "blocked:pr-" ralph/skills/caretake/modes/watch-pr.md` and the body documents all 3 PR-state branches (merged/open/closed).
- [ ] `grep -qE "WATCH-PR (ADVANCED|IDLE|SKIPPED)" ralph/skills/caretake/modes/watch-pr.md` (all three tokens documented, including the branch-skip).
- [ ] Every tool the body instructs is present in `ralph/skills/caretake/SKILL.md` `allowed-tools` (manual cross-check: `gh` via Bash, `list_issues`, `save_issue`, `create_comment`).

#### Manual Verification
- [ ] The deferred-verdict reconciliation (default `PROMOTE-plan`; no dependency on a `## Deferred Verdict` comment) reads clearly and matches what Phase 1 (#1404) actually writes — verify against `ralph/skills/caretake/modes/triage.md` §Step 5 `WAIT-pr` action body (writes a `## Triage Decision` comment + `blocked:pr-NNN` label; `grep -rn "Deferred Verdict" ralph/` returns zero hits).

## Phase 2: Wire mode into SKILL.md + outcome-tokens.md

depends_on: [phase-1]

### Overview

Register the new mode in the caretake SKILL.md mode table + dispatch note, and document its terminal tokens.

### Changes Required

#### 1. SKILL.md mode table + dispatch
**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: Add a `**watch-pr**` row to the `## Modes` table (after `split`). Add a one-line entry under `## Mode bodies` / dispatch noting `--mode watch-pr` reads `modes/watch-pr.md`. Update the `argument-hint` mode list to include `watch-pr`. Do NOT add `--loop`/heartbeat wiring (Phase 4).

#### 2. Terminal tokens
**File**: `ralph/skills/caretake/outcome-tokens.md`
**Changes**: Add a `## Watch-PR terminal tokens` section documenting:
- `WATCH-PR ADVANCED <N>` — `<N>` = items **resolved this sweep** (merged→promoted + closed-unmerged→escalated); open items excluded.
- `WATCH-PR IDLE` — zero `blocked:pr-*` items found.
- `WATCH-PR SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit (parity with triage/unblock skip tokens).

Note no Stop postcondition gates this mode (parity with hygiene/trends).

### Success Criteria

#### Automated Verification
- [ ] `grep -q "watch-pr" ralph/skills/caretake/SKILL.md` (mode table + dispatch + argument-hint).
- [ ] `grep -qE "WATCH-PR ADVANCED <N>" ralph/skills/caretake/outcome-tokens.md`.
- [ ] `grep -qE "WATCH-PR IDLE" ralph/skills/caretake/outcome-tokens.md`.
- [ ] `grep -qE "WATCH-PR SKIPPED" ralph/skills/caretake/outcome-tokens.md`.
- [ ] No shell/markdown lint regressions: `bash -n` is N/A (no scripts changed); markdown only.

#### Manual Verification
- [ ] The SKILL.md mode table row and `outcome-tokens.md` section use the exact mode name (`watch-pr`) and token strings from Phase 1 (no drift).

## Testing Strategy

### Unit Tests
- No automated unit tests (markdown-only change). The verification greps above are the automated gate.

### Integration Tests
- N/A — no TS source touched; CI build/test suites are unaffected (run as a regression guard only).

### Manual Testing Steps
1. Create (or identify) a Backlog issue with a `blocked:pr-NNN` label where PR #NNN is merged.
2. Run `Skill("ralph:caretake", args="--mode watch-pr")`.
3. Confirm: the `blocked:pr-NNN` label is stripped, the issue advances to Ready for Plan (default `PROMOTE-plan`), a `## Watch-PR Resolution` comment is posted, and `WATCH-PR ADVANCED 1` is emitted.
4. Re-run with no `blocked:pr-*` items → `WATCH-PR IDLE`.

## Migration Notes

- watch-pr is **additive** — no existing mode, hook, or token changes. Existing `blocked:pr-*` items (none expected yet, since Phase 1 just shipped) are picked up on first run.
- The `## Deferred Verdict` comment is **not** required; default `PROMOTE-plan` applies. If a later phase teaches triage to write `## Deferred Verdict`, watch-pr already honors it (forward-compatible) with no change here.
- Heartbeat/`--loop` integration is deferred to Phase 4 (#1408); until then watch-pr runs only via explicit `--mode watch-pr` dispatch.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1406
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1417
- Phase 1 (merged): https://github.com/cdubiel08/ralph-hero/pull/1420
- Pattern: `ralph/skills/caretake/modes/hygiene.md` (scan-and-act, no Stop hook)
- Wiring: `ralph/skills/caretake/SKILL.md` `## Modes` table + `## Mode bodies`; `ralph/skills/caretake/outcome-tokens.md`
