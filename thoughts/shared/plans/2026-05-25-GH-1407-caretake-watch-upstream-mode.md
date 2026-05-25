---
date: 2026-05-25
status: draft
type: plan
tags: [caretake, watch-upstream, watcher, deferred-verdict]
github_issue: 1407
github_issues: [1407]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1407
primary_issue: 1407
estimate: S
---

# GH-1407: Add `/ralph:caretake --mode watch-upstream` for `blocked:upstream` items

## Prior Work

- builds_on:: [[GH-1404]] (Phase 1, merged) — established the `WAIT-upstream` verdict that parks a Backlog item with a `blocked:upstream` label + records the upstream URL in a `## Triage Decision` comment.
- builds_on:: [[GH-1406]] (Phase 3a, merged) — the sibling `watch-pr` mode. This phase mirrors its structure (scan → check-condition → act), adapted for an external URL instead of a PR. Folds in the #1406 code-review lessons up front (dedicated SKIPPED token, explicit `labels=` strip, `ADVANCED <N>` count semantics, verdict→state mapping, ungated-transition note).
- builds_on:: parent epic [[GH-1417]] — Phase 3b of 6. Phase 4 (#1408) wires both watchers into the heartbeat fan-out.
- tensions:: the issue body references reading **two** comments that Phase 1 never writes — a `## Deferred Verdict` comment and a `## Blocker` comment. Reality (verified on main, `triage.md` §Step 5 `WAIT-upstream` body): #1404 writes the URL into the **`## Triage Decision`** comment and applies `blocked:upstream` + `ralph-triage`; no `## Deferred Verdict` and no `## Blocker` comment exist. This plan reads the URL from `## Triage Decision` and defaults the post-resolve verdict to `PROMOTE-plan` (honoring an explicit `## Deferred Verdict` only if a future phase adds one).

## Overview

Add a new caretake mode, `watch-upstream`, that resolves Backlog items parked by the `WAIT-upstream` triage verdict. It scans `blocked:upstream`-labelled items, reads the upstream URL + condition from each item's `## Triage Decision` comment, checks whether the condition is met, and acts: **resolved** → strip `blocked:upstream` + apply the deferred verdict (default `PROMOTE-plan` → Ready for Plan); **still blocked** → leave untouched; **URL dead / condition unparseable** → escalate (`WAIT-decision` → Human Needed).

Upstream conditions are fuzzier than a PR merge: a GitHub issue/PR URL has a clean `gh`-checkable closed/merged state, but package-release or plain-HTTP conditions are best-effort. The mode is **conservative** — it only advances when it can *confidently* confirm the condition is met; ambiguous results leave the item parked (never a false advance), and only a dead/unparseable URL escalates.

## Current State Analysis

`watch-pr` (`ralph/skills/caretake/modes/watch-pr.md`, merged in #1406) is the direct template: a scan-and-act caretake mode, sets `RALPH_SUBCOMMAND=watch-upstream`, no Stop hook, tokens emitted by convention. The only structural differences are the label (`blocked:upstream`, a single exact label — so `list_issues` can filter by `label: "blocked:upstream"` directly, no client-side prefix match) and the condition check (fetch a URL vs `gh pr view`).

### Key Discoveries

- **URL source is `## Triage Decision`, not `## Blocker`** (verified: `triage.md` §Step 5 `WAIT-upstream` body — "Record the URL in the `## Triage Decision` comment"). The issue's `## Blocker` reference is stale; read `## Triage Decision`.
- **`## Deferred Verdict` does not exist** (same gap as #1406). Default `PROMOTE-plan`; honor an explicit `## Deferred Verdict: <verdict>` comment if present.
- **`blocked:upstream` is a single exact label** — `list_issues(label: "blocked:upstream")` works directly (unlike watch-pr's `blocked:pr-*` family which needed client-side filtering).
- **Condition checking is best-effort and must be conservative.** GitHub URLs (`github.com/.../issues/N` or `/pull/N`) → `gh issue view` / `gh pr view` for `state`. Other URLs (package registries, plain HTTP) → fetch best-effort; if the condition can't be *confidently* confirmed met, leave parked (do NOT false-advance). Escalate only on a dead URL (404/persistent error) or an unparseable condition.
- **#1406 review lessons folded in up front**: dedicated `WATCH-UPSTREAM SKIPPED — branch …` token (don't overload IDLE); `ADVANCED <N>` counts items resolved this sweep (advanced + escalated, not still-parked); every `save_issue` that strips a label passes an explicit `labels=` array (save_issue replaces the set; omitting it leaves the stale label → re-escalation loop); `command:"ralph_triage"` is semantic parity only (triage-state-gate doesn't gate this subcommand).

## Desired End State

1. `ralph/skills/caretake/modes/watch-upstream.md` exists, documenting scan → read-`## Triage Decision`-URL → check-condition → act, with the 3 outcome branches (resolved / still-blocked / dead-or-unparseable).
2. `Skill("ralph:caretake", args="--mode watch-upstream")` runs end-to-end and emits a terminal token.
3. SKILL.md `## Modes` table + mode-bodies + argument-hint + `description:` frontmatter + per-mode token quick-ref reference the new mode (bump `Nine`→`Ten`); `outcome-tokens.md` documents the three `WATCH-UPSTREAM` tokens.
4. No existing mode/hook regresses.

### Verification

- `test -f ralph/skills/caretake/modes/watch-upstream.md` and it documents the 3 branches.
- `grep -q "watch-upstream" ralph/skills/caretake/SKILL.md` (all five surfaces).
- `grep -qE "WATCH-UPSTREAM (ADVANCED|IDLE|SKIPPED)" ralph/skills/caretake/outcome-tokens.md`.
- The mode body references only tools in caretake's existing `allowed-tools`.
- Manual: read-through confirms the `## Triage Decision` URL source + conservative-advance posture.

## What We're NOT Doing

- **No heartbeat/`--loop` wiring** — Phase 4 (#1408).
- **No director routing** of `blocked:*` — Phase 5 (#1409).
- **No `watch-pr` changes** — shipped in #1406.
- **No new Stop hook** — parity with watch-pr/hygiene; token by convention.
- **No `## Blocker` or `## Deferred Verdict` comment authored** — read `## Triage Decision`; default `PROMOTE-plan`.
- **No aggressive condition inference** — when unsure whether an upstream condition is met, leave parked. Never false-advance.
- **No age/sweep-count escalation for stuck items** (acknowledged scoping choice). The conservative posture has a cost: an item whose URL parses fine but whose condition the mode *cannot confidently confirm* (the fuzzy non-GitHub / plain-HTTP case) lands in the "leave parked" branch **indefinitely** — there is no age-based or sweep-count escape, so it relies on a human (or manual `ralph-triage`/`blocked:upstream` label removal) to escape. This is worse than watch-pr, where an open PR is an unambiguous machine state that *will* eventually flip. Accepted for this phase to guarantee "never false-advance"; a future phase could add a sweep-count escalation to `WAIT-decision`.

## Implementation Approach

Two phases by file ownership, mirroring #1406. Phase 1 writes the mode body; Phase 2 wires SKILL.md + outcome-tokens.md. Phase 2 depends on Phase 1.

Outcome-branch contract:

| Condition result | Action | Token contribution |
|---|---|---|
| Confidently MET (e.g. GitHub URL closed/merged) | strip `blocked:upstream` (explicit `labels=`); apply deferred verdict (default `PROMOTE-plan` → Ready for Plan; drop `ralph-triage`); post `## Watch-Upstream Resolution` | `ADVANCED <N>` |
| Still blocked / can't confirm met | leave untouched (no mutation) | no-op |
| URL dead (404/persistent error) or condition unparseable | `WAIT-decision` → Human Needed; strip `blocked:upstream`, keep `ralph-triage`; post `## Escalation` | `ADVANCED <N>` |

Zero `blocked:upstream` items → `WATCH-UPSTREAM IDLE`. Not on main → `WATCH-UPSTREAM SKIPPED — branch <name> is not main`.

## Phase 1: Write the `watch-upstream` mode body

depends_on: null

### Overview

Create `ralph/skills/caretake/modes/watch-upstream.md`, mirroring `modes/watch-pr.md` adapted for an external URL read from `## Triage Decision`.

### Changes Required

#### 1. New mode body
**File**: `ralph/skills/caretake/modes/watch-upstream.md` (create)
**Changes**: Numbered steps:
- `export RALPH_SUBCOMMAND=watch-upstream`.
- §Step 1 — branch check; not on `main` → emit `WATCH-UPSTREAM SKIPPED — branch <name> is not main` + skip (dedicated token, not IDLE).
- §Step 2 — `list_issues(profile: "analyst-triage", workflowState: "Backlog", label: "blocked:upstream", limit: 250)`. None → `WATCH-UPSTREAM IDLE` + STOP.
- §Step 3 — for each, read the `## Triage Decision` comment to extract the upstream URL + condition. If no URL is parseable → escalate branch.
- §Step 4 — check the condition: GitHub issue/PR URL → `gh issue view`/`gh pr view --json state` (met = closed/merged); other URL → best-effort fetch with a **concrete confirm heuristic** so "best-effort" doesn't silently widen scope: a package-registry JSON whose `version`/`tag` field matches the named release condition → MET; an HTTP resource whose presence/status the condition names explicitly (e.g. "200 OK at <url>") → MET; **anything else → treat as still-blocked** (leave parked). Only "MET" on confident confirmation.
- §Step 5 — act per the outcome-branch table. The advance + escalate `save_issue` calls BOTH pass an explicit `labels=` array (strip `blocked:upstream`; advance drops `ralph-triage`, escalate keeps it). Include the verdict→state mapping (`PROMOTE-plan`→Ready for Plan, `PROMOTE-research`→Research Needed, `CLOSE-*`→Done/Canceled) + the `command:"ralph_triage"` ungated note.
- §Step 6 — emit `WATCH-UPSTREAM ADVANCED <N>` (resolved this sweep: advanced + escalated; still-parked excluded) / `IDLE` / `SKIPPED`.
- §Constraints — one sweep; only mutates `blocked:upstream` items; conservative advance.

### Success Criteria

#### Automated Verification
- [ ] `test -f ralph/skills/caretake/modes/watch-upstream.md` exits 0.
- [ ] `grep -qE "RALPH_SUBCOMMAND=watch-upstream" ralph/skills/caretake/modes/watch-upstream.md`.
- [ ] `grep -qE "## Triage Decision" ralph/skills/caretake/modes/watch-upstream.md` (reads the right comment, not `## Blocker`).
- [ ] `grep -qE "WATCH-UPSTREAM (ADVANCED|IDLE|SKIPPED)" ralph/skills/caretake/modes/watch-upstream.md` (all 3 tokens).
- [ ] Body documents all 3 outcome branches; both label-stripping `save_issue` calls show an explicit `labels=` arg.
- [ ] Every tool the body instructs is in caretake's `allowed-tools` (gh via Bash, list_issues, save_issue, create_comment).

#### Manual Verification
- [ ] URL source is `## Triage Decision` (verify against `triage.md` §Step 5 `WAIT-upstream` body), and the conservative-advance posture (no false advance on ambiguous conditions) reads clearly.

## Phase 2: Wire mode into SKILL.md + outcome-tokens.md

depends_on: [phase-1]

### Overview

Register the mode in SKILL.md (all five surfaces) + document its tokens.

### Changes Required

#### 1. SKILL.md
**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: Add a `**watch-upstream**` row to the `## Modes` table (after `watch-pr`); add to the `## Mode bodies` list, the `argument-hint` mode list, the `description:` frontmatter mode list, and the per-mode terminal-token quick-ref. Bump `Nine named modes` → `Ten named modes`. Do NOT add `--loop`/heartbeat wiring (Phase 4).

#### 2. Terminal tokens
**File**: `ralph/skills/caretake/outcome-tokens.md`
**Changes**: Add a `## Watch-Upstream terminal tokens` section: `WATCH-UPSTREAM ADVANCED <N>` (resolved = advanced + escalated; still-parked excluded), `WATCH-UPSTREAM IDLE` (no `blocked:upstream` items), `WATCH-UPSTREAM SKIPPED — branch <name> is not main`. Note no Stop hook gates this mode.

### Success Criteria

#### Automated Verification
- [ ] `grep -c "watch-upstream" ralph/skills/caretake/SKILL.md` ≥ 5 (table, bodies, arg-hint, description, token quick-ref).
- [ ] `grep -q "Ten named modes" ralph/skills/caretake/SKILL.md`.
- [ ] `grep -qE "WATCH-UPSTREAM ADVANCED <N>" ralph/skills/caretake/outcome-tokens.md`.
- [ ] `grep -qE "WATCH-UPSTREAM IDLE" ralph/skills/caretake/outcome-tokens.md`.
- [ ] `grep -qE "WATCH-UPSTREAM SKIPPED" ralph/skills/caretake/outcome-tokens.md`.

#### Manual Verification
- [ ] Mode name `watch-upstream` and the three token strings are byte-identical across watch-upstream.md, SKILL.md, and outcome-tokens.md (no drift).

## Testing Strategy

### Unit Tests
- None (markdown-only). The verification greps are the automated gate.

### Integration Tests
- N/A — no TS touched; CI build/test suites unaffected (regression guard only).

### Manual Testing Steps
1. Create a Backlog issue with `blocked:upstream` + a `## Triage Decision` comment naming a GitHub URL that is now closed.
2. `Skill("ralph:caretake", args="--mode watch-upstream")` → label stripped, advanced to Ready for Plan, `## Watch-Upstream Resolution` posted, `WATCH-UPSTREAM ADVANCED 1`.
3. Re-run with no `blocked:upstream` items → `WATCH-UPSTREAM IDLE`.
4. Item whose URL is still open → left parked (no mutation, not counted).

## Migration Notes

- Additive — no existing mode/hook/token changes.
- Reads the URL from `## Triage Decision` (what #1404 actually writes); defaults the verdict to `PROMOTE-plan`. The `## Deferred Verdict` / `## Blocker` comments referenced by the issue body do not exist and are not required.
- Heartbeat/`--loop` integration deferred to Phase 4 (#1408).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1407
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1417
- Sibling (merged): `ralph/skills/caretake/modes/watch-pr.md` (#1406), PR #1421
- URL source: `ralph/skills/caretake/modes/triage.md` §Step 5 `WAIT-upstream` body
- Wiring: `ralph/skills/caretake/SKILL.md`, `ralph/skills/caretake/outcome-tokens.md`
