---
date: 2026-05-25
status: draft
type: plan
tags: [caretake, triage, postcondition, keep-deprecation]
github_issue: 1410
github_issues: [1410]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1410
primary_issue: 1410
estimate: XS
---

# GH-1410: triage-postcondition rejects `RALPH_TRIAGE_ACTION=KEEP` outright

## Prior Work

- builds_on:: [[GH-1404]] (Phase 1, merged) — added the 8 structured verdicts and **retained** legacy `KEEP` in the plugin `triage-postcondition.sh` allowlist explicitly "until Phase 6 (#1410)". This phase removes that retention.
- builds_on:: parent epic [[GH-1417]] — Phase 6 of 6. **Merging this closes the epic** (all six children Done).
- tensions:: the issue's *behavior* line says "Post-tightening: **only the 8 new values accepted**", but the *title* and all three ACs target **`KEEP` only** (reject KEEP; 8 new values still pass; purge KEEP doc refs). The other legacy values (`RESEARCH`/`CLOSE`/`HUMAN`/`CANCEL`/`RE-ESTIMATE`) have 1:1 successors in the 8-verdict scheme and `RE-ESTIMATE` is orthogonal-and-still-useful; none was a dead-end (KEEP was the dead-end the epic exists to kill). This plan scopes to **KEEP-rejection** (AC-driven, lowest-risk) and flags the broader-removal option for the reviewer — see Key Discoveries.

## Overview

Make the legacy plugin `triage-postcondition.sh` **reject** `RALPH_TRIAGE_ACTION=KEEP` with a non-zero exit + a deprecation message pointing at the 8 structured verdicts, and purge the now-stale "KEEP retained until Phase 6" references from the triage docs. The 8 structured verdicts continue to pass; the other legacy values are left untouched (scoped per the ACs).

## Current State Analysis

The plugin `triage-postcondition.sh` (`plugin/ralph-hero/hooks/scripts/triage-postcondition.sh`) `case "$triage_action"` has three arms (post-#1404): a **structured** arm (`CLOSE-done|…|WAIT-decision`) → `allow`; a **legacy** arm (`RESEARCH|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE`) → `allow`; and a `*)` catch-all → `warn` (which **exits 0** — allow-with-warning). The slim `ralph/hooks/scripts/triage-postcondition.sh` is terminal-token-based and never matched `KEEP` (the palette test already asserts `KEEP` does NOT match), so it needs no change.

### Key Discoveries

- **Removing `KEEP` from the allowlist is NOT enough to reject it.** The `*)` catch-all calls `warn` → `exit 0` (allow-with-warning). So a bare removal would make `KEEP` *allowed with a warning*, not rejected. To **exit 2**, the fix must add an **explicit `KEEP)` branch that calls `block`** (exit 2) with the deprecation message, placed before `*)`. (`triage-postcondition.sh` `warn()` = `exit 0`; `block()` = exit 2 — verified in `hook-utils.sh`.)
- **Scope = KEEP only** (see Prior Work tensions). Keep the other legacy values (`RESEARCH|CLOSE|HUMAN|CANCEL|RE-ESTIMATE`) in the allow arm — the ACs don't require removing them, they have successors but weren't dead-ends, and the legacy plugin surface is superseded anyway. **Reviewer decision point:** if "only the 8" is truly wanted, the other legacy values would also move to reject — flagged, not done.
- **Slim hook unchanged.** `KEEP` was never a slim terminal token; `triage-postcondition-palette.test.sh` already asserts `KEEP` does not match. No slim-side enforcement change needed.
- **Stale KEEP doc refs to purge** (4 files): three added/retained in #1404 — `ralph/skills/caretake/modes/triage.md` (RALPH_TRIAGE_ACTION export block + valid-values line mention "KEEP … retained until Phase 6"), `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (valid-values + "retired"/legacy mentions), `ralph/skills/caretake/outcome-tokens.md` (the `RALPH_TRIAGE_ACTION` allowlist line lists legacy `KEEP`) — PLUS a fourth, pre-existing one surfaced by review: **`specs/issue-lifecycle.md:137`** has a `| KEEP | *(no state change)* |` row in a normative "Triage-specific actions" table, presenting KEEP as a usable triage action with the exact dead-end (`no state change`) the epic kills. The plan's Desired End State ("no doc tells an author KEEP is usable") makes it in-scope; it is added to the Phase 2 purge.

## Desired End State

1. `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` rejects `RALPH_TRIAGE_ACTION=KEEP` with exit 2 + the deprecation message; the 8 structured verdicts still pass; the remaining legacy values still pass.
2. The three triage docs no longer present `KEEP` as an accepted/retained value (the "until Phase 6" hedge is gone; KEEP is documented as removed/rejected).
3. No regression: the slim hook + palette test are unchanged and still green.
4. Merging closes epic #1417.

### Verification

- `RALPH_TICKET_ID=t RALPH_TRIAGE_ACTION=KEEP bash plugin/ralph-hero/hooks/scripts/triage-postcondition.sh <<<'{}'` exits **2** (was 0).
- `RALPH_TRIAGE_ACTION=PROMOTE-plan` (and the other 7) still exit 0.
- `grep -rn 'KEEP' ralph/skills/caretake/modes/triage.md plugin/ralph-hero/skills/ralph-triage/SKILL.md ralph/skills/caretake/outcome-tokens.md` shows no "accepted/retained" framing (only, at most, a "removed/deprecated" mention).
- Slim palette test still passes unchanged.

## What We're NOT Doing

- **No rejection of the other legacy values** (`RESEARCH`/`CLOSE`/`HUMAN`/`CANCEL`/`RE-ESTIMATE`) — scoped per the ACs; flagged for reviewer if broader removal is desired.
- **No migration of existing KEEP-labeled issues** — per-project, out of scope (and the issue notes it should land before enforcement).
- **No slim-hook change** — `KEEP` was never a slim terminal token.
- **No change to the running autopilot loop** (versioned-cache classify; unaffected).

## Implementation Approach

Two phases. Phase 1 = the enforcement (plugin hook). Phase 2 = doc purge across the three files. Phase 2 depends on Phase 1 so the deprecation message wording is fixed once and echoed in the docs.

## Phase 1: Reject KEEP in the plugin postcondition

depends_on: null

### Overview

Add an explicit `KEEP)` → `block` branch (exit 2) and drop `KEEP` from the legacy allow arm + the block-message legacy list.

### Changes Required

#### 1. Plugin postcondition hook
**File**: `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh`
**Changes**:
- In the `case "$triage_action"`, remove `KEEP` from the legacy allow arm (`RESEARCH|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE` → `RESEARCH|CLOSE|HUMAN|CANCEL|RE-ESTIMATE`).
- Add a new explicit branch **before** `*)`:
  ```bash
  KEEP)
    block "Bare KEEP is deprecated. Pick a structured verdict — CLOSE-done, CLOSE-canceled, SPLIT, PROMOTE-research, PROMOTE-plan, WAIT-pr=NNN, WAIT-upstream=URL, or WAIT-decision."
    ;;
  ```
- Update the top-of-file `RALPH_TRIAGE_ACTION` comment + the `block` "Expected" message to drop `KEEP` from the legacy list and note it is now rejected.

### Success Criteria

#### Automated Verification
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` exits 0.
- [ ] **Run from repo root:** `RALPH_TICKET_ID=t RALPH_TRIAGE_ACTION=KEEP bash plugin/ralph-hero/hooks/scripts/triage-postcondition.sh <<<'{}'` exits **2**.
- [ ] `RALPH_TICKET_ID=t RALPH_TRIAGE_ACTION=PROMOTE-plan bash plugin/ralph-hero/hooks/scripts/triage-postcondition.sh <<<'{}'` exits 0; same for `WAIT-pr=1338` and a remaining legacy value (`RESEARCH`).
- [ ] KEEP is not in any `allow`-reaching case arm: extract the two allow-arm pattern lines (the structured arm + the legacy `RESEARCH|CLOSE|…` arm) and confirm neither contains `KEEP` — e.g. `grep -nE '^\s+(CLOSE-done\||RESEARCH\|)' plugin/ralph-hero/hooks/scripts/triage-postcondition.sh | grep -qv 'KEEP'` for the legacy line. (The exit-2 behavioral test above is the real guard; KEEP should appear only in the new `KEEP)` reject branch + the messages.)

#### Manual Verification
- [ ] The deprecation message lists all 8 structured verdicts and is emitted on exit 2.

## Phase 2: Purge stale KEEP doc references

depends_on: [phase-1]

### Overview

Remove the "KEEP retained until Phase 6 / legacy-accepted" framing from the three triage docs; where KEEP is mentioned, frame it as removed/deprecated.

### Changes Required

#### 1. Slim triage body
**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: In the §Step 5 `RALPH_TRIAGE_ACTION` export block + valid-values line, drop `KEEP` from the legacy-accepted list (and remove the "removed in Phase 6 (#1410)" hedge — it's now done). Keep the remaining legacy values as-is.

#### 2. Legacy triage skill
**File**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
**Changes**: Remove `KEEP` from the valid-values line + the export examples; if a "legacy `KEEP` retired" note exists, update it to state KEEP is now **rejected** by the postcondition (not merely retired-but-accepted).

#### 3. Token contract
**File**: `ralph/skills/caretake/outcome-tokens.md`
**Changes**: In the `RALPH_TRIAGE_ACTION` allowlist line, drop `KEEP` from the legacy set.

#### 4. Issue-lifecycle spec (surfaced by review)
**File**: `specs/issue-lifecycle.md`
**Changes**: In the "Triage-specific actions" table (line ~137), the `| KEEP | *(no state change)* |` row presents KEEP as a usable action with the dead-end behavior the epic removes. Either delete the KEEP row or annotate it as deprecated/removed (e.g. replace with the structured successors or strike it). This keeps the normative spec consistent with the enforced postcondition.

### Success Criteria

#### Automated Verification
- [ ] `! grep -nE 'KEEP' ralph/skills/caretake/modes/triage.md` returns nothing framed as accepted/retained (a "KEEP removed/rejected" mention is acceptable; an "accepted"/"retained" one is not — manual eyeball of any remaining hit).
- [ ] `! grep -qE 'KEEP\b' plugin/ralph-hero/skills/ralph-triage/SKILL.md` in the valid-values/export context.
- [ ] `! grep -qE 'KEEP' ralph/skills/caretake/outcome-tokens.md` in the `RALPH_TRIAGE_ACTION` allowlist line.
- [ ] `specs/issue-lifecycle.md` no longer has a `| KEEP | *(no state change)* |` row presenting KEEP as a usable action (`! grep -qE '\| KEEP \|' specs/issue-lifecycle.md`, or any remaining KEEP mention is framed as deprecated/removed).

#### Manual Verification
- [ ] No doc still tells an author `KEEP` is a usable value; the only KEEP mentions (if any) say it's deprecated/rejected.

## Testing Strategy

### Unit Tests
- The slim palette test (`triage-postcondition-palette.test.sh`) is unchanged and must still pass (regression guard — it already asserts KEEP is not a slim token).

### Integration Tests
- N/A — bash + markdown only; no TS. CI suites unaffected (regression guard).

### Manual Testing Steps
1. `RALPH_TICKET_ID=t RALPH_TRIAGE_ACTION=KEEP bash plugin/ralph-hero/hooks/scripts/triage-postcondition.sh <<<'{}'; echo $?` → 2 + deprecation message.
2. Repeat with `PROMOTE-plan` / `WAIT-pr=1338` / `RESEARCH` → 0.
3. `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` → still 0 failures.

## Migration Notes

- Per the issue's own note + epic, **existing KEEP-labeled issues must be re-mapped (Phase 2 of the epic, per consuming project) before this enforcement bites in their pipelines.** This change only affects *new* triage runs that try to emit `KEEP`.
- The other legacy values remain accepted (scoped to KEEP); a follow-up could retire them if "only the 8" is confirmed desired.
- Merging closes epic #1417 (final child).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1410
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1417
- Hook: `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` (+ `hook-utils.sh` `warn`=exit0 / `block`=exit2)
- Docs: `ralph/skills/caretake/modes/triage.md`, `plugin/ralph-hero/skills/ralph-triage/SKILL.md`, `ralph/skills/caretake/outcome-tokens.md`
- Slim hook (unchanged): `ralph/hooks/scripts/triage-postcondition.sh` + its palette test
