---
date: 2026-05-26
status: ready
type: plan
tags: [ralph-slim, loop, auto, doc-consistency, hooks]
github_issue: 1414
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1414
primary_issue: 1414
estimate: S
---

# GH-1414 — Fix 3 loop/--auto consistency gaps from GH-1402

## Prior Work

- builds_on:: [[2026-05-24-GH-1402-add-loop-flag-to-ralph-skills]] — the feature that wired `--loop` across the ralph slim skills; this plan repairs three consistency gaps a post-merge review found.
- builds_on:: [[2026-05-24-GH-1402-critique]] — the plan-review critique for #1402.
- Parent feature #1402 · PR #1411 · merge `7b32d52b`.

## Overview

An independent post-merge review of #1402 (PR #1411) found three doc↔impl consistency gaps that the bash test suites could not catch — the suites validate the manifest/snippets, not the actual `SKILL.md` command construction. All three are fix-forward polish, not regressions. This plan repairs each gap so the `--loop` suitability matrix (`ralph/CLAUDE.md`), the continuation manifest (`loop-wrapper.md`), and the skill bodies all agree.

The unifying decision for Gap 1: where docs claimed a capability that was **never wired**, we correct the docs to tell the truth and have the surface refuse the flag — rather than build a new, undogfooded autonomous looping surface. `hero --mode auto` already owns the autonomous drain loop.

## Current State Analysis

Three independent gaps, each in a different skill surface:

- **Gap 1 (med/high):** `ralph/CLAUDE.md` (suitability matrix) and `ralph/skills/shared/loop-wrapper.md` (the `hero:default` manifest row) both list `hero` default mode as `--loop`-suitable, but `ralph/skills/hero/SKILL.md` default mode has **no `--loop` Step-0 gate** (only `--mode auto` and `--mode watch` do). A bare `/ralph:hero --loop` therefore runs the normal one-shot flow with a stray `--loop` token rather than wrapping in `/loop` or refusing.
- **Gap 2 (high):** `ralph/skills/caretake/SKILL.md` Step 0 routes the no-arg `--loop` path to the `caretake:default-event` manifest row (a **drain** that terminates on `Queue empty.`), but the no-arg dispatch body actually runs the **heartbeat fan-out** (hygiene → watch-pr → watch-upstream → report → trends), which never emits `Queue empty.`. So bare `/ralph:caretake --loop` is handed drain continuation rules whose terminate condition can never fire.
- **Gap 3 (med):** `ralph/skills/form/SKILL.md` and `ralph/skills/setup/SKILL.md` each have an `--auto` refusal stanza in Step 0 but neither refuses `--loop`. The #1402 plan's Desired-End-State #4 requires unsuitable interactive/one-shot surfaces to refuse `--loop` with the one-line message.

### Key Discoveries

- `ralph/skills/hero/SKILL.md` — default mode Step 0 `case` only branches on `--mode auto|classify|watch|pr-drain`; no `--loop` detection. `--mode auto` and `--mode watch` each have their own `--loop` handling.
- `ralph/skills/caretake/SKILL.md` Step 0 — case statement maps bare no-arg (`""`) to `RALPH_SUBCOMMAND=all` (heartbeat fan-out), but the `--loop` gate prose maps "No args (no `--issue`)" to the `caretake:default-event` row (drain). The two disagree.
- `ralph/skills/shared/loop-wrapper.md` — manifest has both a `hero:default` row (drain top-ranked, terminal `result: Queue empty.`) and a `caretake:default-event` row (drain trigger:* labels, terminal `Queue empty.`) and a `caretake:all` row (heartbeat, no terminal).
- `ralph/skills/form/SKILL.md` Step 0 "Flag guard" and `ralph/skills/setup/SKILL.md` Step 0 — both contain the verbatim `--auto` refusal block; the `--loop` refusal message lives in `loop-wrapper.md` § Refusal message.
- The slim matrix already marks `hero --mode classify` as "No / redundant with --mode auto" — the same redundancy logic applies to a hero-default loop.

## Desired End State

1. `grep -n '\-\-loop' ralph/skills/hero/SKILL.md` shows the default mode either gates **or refuses** `--loop`, and `hero default` is no longer claimed as an independent `--loop`-suitable drain in `ralph/CLAUDE.md` + `loop-wrapper.md` (matrix, manifest, and body all agree).
2. Bare `/ralph:caretake --loop` and bare `/ralph:caretake` agree on continuation semantics — both heartbeat (clock re-fire, no `Queue empty.` terminator) — documented in the manifest row that Step 0 points at.
3. `/ralph:form --loop` and `/ralph:setup --loop` emit the one-line refusal from `loop-wrapper.md` § Refusal message and do not run their normal flow.
4. Existing bash suites still pass (`ralph/skills/shared/__tests__/*.test.sh`, `ralph/hooks/scripts/__tests__/*.test.sh`).

### Verification

- Automated: `grep -n '\-\-loop' ralph/skills/hero/SKILL.md ralph/skills/form/SKILL.md ralph/skills/setup/SKILL.md` shows the new gates/refusals; `grep -n 'hero default' ralph/CLAUDE.md` and `grep -n 'hero:default' ralph/skills/shared/loop-wrapper.md` reflect the corrected (non-suitable) claim.
- Automated: `bash ralph/skills/shared/__tests__/*.test.sh` and `bash ralph/hooks/scripts/__tests__/*.test.sh` all pass.
- Manual: read each Step 0 stanza and confirm the refusal text matches the canonical one-liner verbatim; confirm the caretake manifest row Step 0 points at is the heartbeat row.

## What We're NOT Doing

- NOT wiring a new `hero --mode default --loop` autonomous builder-drain surface (Gap 1 option a). That capability was never implemented; we are correcting docs + refusing, not building it.
- NOT touching the three optional lower-priority items the review flagged (the `--loop dynamic` token-strip behavior, the `triage-postcondition.sh` regex tightening, the `triage.md §Step 4` `HUMAN` palette entry). They are deferrable/splittable and explicitly out of scope here.
- NOT changing the `--mode auto`, `--mode watch`, or `--mode classify` loop behaviors — those are correctly wired.
- NOT changing MCP server code — this is skill-prose + doc consistency only.

## Implementation Approach

Three small phases, one per gap, each tightly scoped to its files. Phases 1 and 2 both touch `loop-wrapper.md`, so Phase 2 is sequenced after Phase 1 to avoid a write conflict. Phase 3 touches only `form`/`setup` and is independent. Every change is skill-prose/markdown — no code, no build step. Verification is `grep` assertions plus the existing bash suites.

## Phase 1: Gap 1 — correct the hero-default loop claim + refuse `--loop`
depends_on: null

### Overview
Make `hero` default mode refuse `--loop` (pointing users at `--auto` / `--mode auto`) and remove the inaccurate "loop-suitable" claim for `hero default` from the matrix and manifest, so docs match the actual (never-wired) behavior.

### Changes Required
#### 1. Hero default mode Step 0 refusal
**File**: `ralph/skills/hero/SKILL.md`
**Changes**: In Step 0 (before mode dispatch / in the default branch), add a `--loop` detection stanza: if `--loop` is present and the resolved mode is `default` (no `--auto`, which already rewrites to `--mode auto` before `--loop` detection), emit the canonical refusal from `loop-wrapper.md` § Refusal message and STOP. Point the operator at `/ralph:hero --auto` (the autonomous drain) in a one-line note. Mirror the existing `--auto`-alias placement so the `--auto --loop` → `--mode auto` path is unaffected.

#### 2. Suitability matrix
**File**: `ralph/CLAUDE.md`
**Changes**: In the "Loop and --auto suitability matrix", change the `hero default` row so it is NOT independently `--loop`-suitable (mark `--loop` Suitable? = No, with note "refuses; use `--auto` → `--mode auto` for the drain"). Keep the `--auto` resolves-to `--mode auto` cell intact.

#### 3. Continuation manifest
**File**: `ralph/skills/shared/loop-wrapper.md`
**Changes**: Remove the `hero:default` manifest row (or convert it to a note stating hero-default is not a loop target; `--mode auto` is the loop). Ensure no other row references `hero:default`.

### Success Criteria
#### Automated Verification
- [ ] `grep -n '\-\-loop' ralph/skills/hero/SKILL.md` shows a default-mode refusal stanza.
- [ ] `grep -n 'hero:default' ralph/skills/shared/loop-wrapper.md` returns no loop-suitable manifest row (or only a not-a-loop-target note).
- [ ] `grep -n 'hero default' ralph/CLAUDE.md` shows `--loop` = No.
- [ ] `bash ralph/skills/shared/__tests__/*.test.sh` passes.

#### Manual Verification
- [ ] The refusal text in `hero/SKILL.md` matches the canonical one-liner from `loop-wrapper.md` § Refusal message verbatim.
- [ ] The `--auto --loop` → `--mode auto` autopilot path still works (the refusal does not fire when `--auto` is present).

## Phase 2: Gap 2 — make bare `caretake --loop` heartbeat-consistent
depends_on: [phase-1]

### Overview
Resolve the contradiction so bare `/ralph:caretake --loop` uses heartbeat continuation (matching its no-arg fan-out body) instead of drain rules whose `Queue empty.` terminator never fires.

### Changes Required
#### 1. Caretake Step 0 no-arg loop routing
**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: In Step 0's `--loop` gate, change the "No args (no `--issue`) → `caretake:default-event` row" routing to the `caretake:all` heartbeat row (default interval `1h`, no `Queue empty.` terminal) — consistent with the no-arg `RALPH_SUBCOMMAND=all` fan-out body. Reserve the `caretake:default-event` row for the `--issue NNN` event-drain path only (or document that bare no-arg is heartbeat fan-out).

#### 2. Manifest note (if needed)
**File**: `ralph/skills/shared/loop-wrapper.md`
**Changes**: Ensure the `caretake:default-event` row's "notes" column clarifies it applies to `--issue`-scoped trigger draining, not the bare no-arg fan-out (which uses `caretake:all`). No row addition expected — `caretake:all` already exists.

### Success Criteria
#### Automated Verification
- [ ] `grep -n 'caretake:all\|caretake:default-event' ralph/skills/caretake/SKILL.md` shows the no-arg loop path pointing at `caretake:all`.
- [ ] `bash ralph/skills/shared/__tests__/*.test.sh` passes.

#### Manual Verification
- [ ] Bare `/ralph:caretake --loop` and bare `/ralph:caretake` both describe heartbeat semantics (clock re-fire, no terminal `Queue empty.`).

## Phase 3: Gap 3 — add `--loop` refusals to form + setup
depends_on: null

### Overview
Add a `--loop` refusal stanza to `form` and `setup` Step 0, mirroring their existing `--auto` refusals, so these interactive/one-shot surfaces refuse `--loop` with the canonical one-liner.

### Changes Required
#### 1. Form flag guard
**File**: `ralph/skills/form/SKILL.md`
**Changes**: In Step 0 "Flag guard", add a `--loop` refusal block beneath the `--auto` refusal: if `--loop` appears in `$ARGUMENTS`, emit the canonical refusal from `loop-wrapper.md` § Refusal message and STOP.

#### 2. Setup flag guard
**File**: `ralph/skills/setup/SKILL.md`
**Changes**: In Step 0, add the same `--loop` refusal block beneath the existing `--auto` refusal.

### Success Criteria
#### Automated Verification
- [ ] `grep -n '\-\-loop' ralph/skills/form/SKILL.md ralph/skills/setup/SKILL.md` shows a refusal stanza in each.
- [ ] `bash ralph/skills/shared/__tests__/*.test.sh` and `bash ralph/hooks/scripts/__tests__/*.test.sh` pass.

#### Manual Verification
- [ ] The refusal text matches the canonical one-liner verbatim in both files.

## Testing Strategy

### Unit Tests
No unit tests — these are skill-prose/markdown changes. The relevant guards are the existing bash suites.

### Integration Tests
Run the existing bash suites after each phase:
- `bash ralph/skills/shared/__tests__/*.test.sh`
- `bash ralph/hooks/scripts/__tests__/*.test.sh`

### Manual Testing Steps
1. `grep -n '\-\-loop'` across `hero/SKILL.md`, `form/SKILL.md`, `setup/SKILL.md` and confirm the gates/refusals are present and text-identical to the canonical one-liner.
2. Confirm `ralph/CLAUDE.md` matrix and `loop-wrapper.md` manifest no longer claim `hero default` is loop-suitable.
3. Confirm the caretake Step 0 no-arg loop path points at the `caretake:all` heartbeat row.

## Migration Notes

No data migration. No env-var changes. Existing `--mode auto` / `--mode watch` / `--mode classify` loop behaviors are untouched, so any running autopilot (`/ralph:hero --auto --loop`) is unaffected — it resolves `--auto` to `--mode auto` before `--loop` detection and never hits the new default-mode refusal. The only behavioral change is that previously-mis-parsed flags (`/ralph:hero --loop`, `/ralph:form --loop`, `/ralph:setup --loop`) now refuse cleanly instead of silently running their normal flow.

## References

- Issue #1414
- Parent #1402 · PR #1411 · merge `7b32d52b`
- `ralph/skills/shared/loop-wrapper.md` § Refusal message + continuation-rules manifest
- `ralph/CLAUDE.md` § Loop and --auto suitability matrix
