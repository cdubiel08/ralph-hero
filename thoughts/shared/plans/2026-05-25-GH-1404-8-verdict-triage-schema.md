---
date: 2026-05-25
status: draft
type: plan
tags: [caretake, triage, verdict-schema, hooks]
github_issue: 1404
github_issues: [1404]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1404
primary_issue: 1404
estimate: XS
---

# GH-1404: Define the 8-verdict triage schema + update RALPH_TRIAGE_ACTION validation

## Prior Work

- builds_on:: parent epic [[GH-1417]] — "caretake: replace bare KEEP verdict with structured successor verdicts + watcher modes". This is Phase 1 of 6; it ships the schema only. Phases 3a/3b (#1406/#1407) build the `watch-pr`/`watch-upstream` consumers; Phase 6 (#1410) removes legacy `KEEP`.
- tensions:: the issue body's premise ("replace the **bare KEEP** verdict") reflects the **legacy** `plugin/ralph-hero/skills/ralph-triage/SKILL.md` palette (`CLOSE / SPLIT / RESEARCH / KEEP / HUMAN`). The **active** slim verb `/ralph:caretake --mode triage` already moved past `KEEP` to `CLOSE / SPLIT / RE-ESTIMATE / ROUTE-TO-*`. This plan reconciles both surfaces and is explicit where the issue body is stale (see Key Discoveries).

## Overview

Replace the ad-hoc triage verdict vocabulary with the 8 structured verdicts defined in epic #1417, each naming its downstream successor: `CLOSE-done`, `CLOSE-canceled`, `SPLIT`, `PROMOTE-research`, `PROMOTE-plan`, `WAIT-pr=NNN`, `WAIT-upstream=URL`, `WAIT-decision`. The genuinely-new capability is the **`WAIT-*` deferred family** — verdicts that park an item against a *named, watched condition* instead of dead-ending it in Backlog (the failure mode the epic exists to fix).

Phase 1 is schema + validation only: document the verdicts in the triage skill bodies, extend the terminal-token contract, and update the postcondition allowlists to accept the new values **plus legacy `KEEP`** (Phase 6 removes legacy). No `WAIT-*` consumer is wired here — an item parked with `WAIT-pr=NNN` simply carries a `blocked:pr-NNN` label until Phase 3 ships the watcher.

## Current State Analysis

There are **two parallel triage surfaces** during the slim-plugin migration (by design — `ralph/CLAUDE.md` § "What's still in plugin/ralph-hero/"), with **two different enforcement models**:

1. **Slim / active** — `/ralph:caretake --mode triage`:
   - `ralph/skills/caretake/modes/triage.md` §Step 4 verdict list, §Step 5 action table + `RALPH_TRIAGE_ACTION` export (self-discipline marker, **not** hook-read here).
   - `ralph/hooks/scripts/triage-postcondition.sh` — enforces via a **terminal-token regex** (line ~48) grepping the transcript for `TRIAGED <token>` / `Queue empty.`.
   - `ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` — asserts the regex against valid/invalid token samples.
   - `ralph/skills/caretake/outcome-tokens.md` — canonical token list.

2. **Legacy / parallel** — `/ralph-hero:ralph-triage`:
   - `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (326 lines) — uses `KEEP`/`RESEARCH` palette.
   - `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` — enforces via the **`RALPH_TRIAGE_ACTION` env var** (`case` allowlist: `RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE`).

### Key Discoveries

- The issue body omits **two active-path files** it must touch: `ralph/hooks/scripts/triage-postcondition.sh` and its test `triage-postcondition-palette.test.sh`. The slim hook is the live enforcement for `/ralph:caretake --mode triage`; updating only the plugin hook (as the AC literally reads) would leave the new tokens unenforced on the active path.
- The slim hook does **not** read `RALPH_TRIAGE_ACTION` — it greps terminal tokens (`ralph/hooks/scripts/triage-postcondition.sh:45-51`). The issue's "update `RALPH_TRIAGE_ACTION` valid-value list" AC applies literally only to the **legacy plugin** hook (`plugin/ralph-hero/hooks/scripts/triage-postcondition.sh:35-43`).
- The palette test (`triage-postcondition-palette.test.sh:64-65`) explicitly asserts `KEEP` and `TRIAGED valid` do **not** match — so the slim terminal-token contract already treats `KEEP` as a non-token. Legacy-`KEEP` retention applies only to the plugin hook's `RALPH_TRIAGE_ACTION` allowlist.
- **Verdict→token mapping is undefined.** Decision (this plan): introduce **8 verbatim `TRIAGED <verdict>` tokens** that match the verdict names 1:1, and **keep the existing token alternations** (`routed → …`, `duplicate`, `canceled`, `needs-split`, `escalated`, `re-estimated`, `skipped`) in the regex for no-regression. Alternative considered — reuse existing tokens for 6 verdicts + add 2 `wait-*` tokens — rejected because AC3 reads "lists all 8 `TRIAGED <verdict>` variants" (1:1 is the most literal reading) and 1:1 tokens make loop-continuation telemetry per-verdict legible. Flagged for the review gate.

## Desired End State

1. Both triage skill bodies (`triage.md` §Step 4/§Step 5 and `ralph-triage/SKILL.md`) document the 8-verdict schema table, each verdict mapped to its workflow target + terminal token.
2. `ralph/skills/caretake/outcome-tokens.md` lists all 8 `TRIAGED <verdict>` terminal tokens (the 8 verbatim tokens), with the legacy tokens retained as accepted-for-back-compat.
3. The slim postcondition regex (`ralph/hooks/scripts/triage-postcondition.sh`) matches all 8 new tokens **and** every previously-valid token; the palette test covers the 8 new tokens (match) and still asserts `KEEP` / bare `TRIAGED` do not match.
4. The legacy plugin postcondition (`plugin/ralph-hero/hooks/scripts/triage-postcondition.sh`) `RALPH_TRIAGE_ACTION` `case` allowlist accepts all 8 new verdict values **plus** legacy `KEEP`.
5. No `WAIT-*` consumer logic is added (out of scope — Phase 3+). No existing triage flow regresses.

### Verification

- `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` exits 0, with new assertions for the 8 verbatim tokens.
- `cd plugin/ralph-hero/mcp-server && npm test` and `cd plugin/ralph-knowledge && npm test` (if touched) stay green — no TS source changes expected, so these should be unaffected; run as a regression guard.
- `grep -c "TRIAGED" ralph/skills/caretake/outcome-tokens.md` shows the 8 new token lines present.
- Manual read: the §Step 4 schema table in both skill bodies matches the 8-verdict table in #1417 verbatim.

## What We're NOT Doing

- **No `WAIT-pr` / `WAIT-upstream` consumer** — that is Phase 3a/3b (#1406/#1407). Items parked with `WAIT-*` just carry a `blocked:*` label.
- **No removal of legacy `KEEP`** from the plugin allowlist — Phase 6 (#1410). We *add* the new values and *keep* `KEEP`.
- **No migration** of existing `ralph-triage`-labeled or KEEP'd Backlog items — Phase 2, owned per consuming project.
- **No new workflow states** — all 8 verdicts map to existing states (Backlog/Research Needed/Ready for Plan/Human Needed/Done/Canceled).
- **No `RALPH_TRIAGE_ACTION` enforcement added to the slim hook** — the slim path stays terminal-token-based; we do not port the env-var model.

## Implementation Approach

Two phases split by surface for clean file ownership. Phase 1 wires the **active slim path** end-to-end (skill body → token contract → hook regex → test). Phase 2 syncs the **legacy plugin path** so the two surfaces document the same vocabulary, and updates the plugin's env-var allowlist per the literal AC. Phase 2 depends on Phase 1 so the verdict/token names are fixed once and copied, not re-decided.

The verdict→token mapping used throughout:

| Verdict | Workflow target | Terminal token | Label/side-effect |
|---|---|---|---|
| `CLOSE-done` | Done | `TRIAGED CLOSE-done` | `issueState: CLOSED` |
| `CLOSE-canceled` | Canceled | `TRIAGED CLOSE-canceled` | `issueState: CLOSED_NOT_PLANNED` |
| `SPLIT` | Backlog (children created) | `TRIAGED SPLIT` | `needs-split` + `ralph-triage` labels |
| `PROMOTE-research` | Research Needed | `TRIAGED PROMOTE-research` | — |
| `PROMOTE-plan` | Ready for Plan | `TRIAGED PROMOTE-plan` | — |
| `WAIT-pr=NNN` | Backlog | `TRIAGED WAIT-pr=NNN` | `blocked:pr-NNN` + `ralph-triage` |
| `WAIT-upstream=URL` | Backlog | `TRIAGED WAIT-upstream` | `blocked:upstream` + `ralph-triage` |
| `WAIT-decision` | Human Needed | `TRIAGED WAIT-decision` | `## Escalation` comment + `ralph-triage` |

## Phase 1: Slim active path — schema, tokens, hook regex, test

depends_on: null

### Overview

Document the 8-verdict schema in the slim triage body, add the 8 verbatim terminal tokens to the token contract, extend the slim postcondition regex to match them (keeping all legacy alternations), and add palette-test coverage.

### Changes Required

#### 1. Slim triage skill body
**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: Replace the §Step 4 verdict list with the 8-verdict schema table (verdict → workflow target → downstream consumer → terminal token). Update §Step 5 action bodies so each verdict routes to the correct `save_issue` state + labels per the mapping table. Update the §Step 5 `RALPH_TRIAGE_ACTION` export examples + "Valid values" line to the 8 new values plus legacy `KEEP` (kept as self-discipline marker). Update §Step 8 terminal-token list to the 8 verbatim tokens (retain legacy tokens as accepted).

#### 2. Terminal-token contract
**File**: `ralph/skills/caretake/outcome-tokens.md`
**Changes**: Under "## Triage terminal tokens", add the 8 `TRIAGED <verdict>` token lines with one-line descriptions. Retain the existing token lines (mark as legacy-accepted for back-compat). Update the prose pointer to the regex so it matches the union.

#### 3. Slim postcondition regex
**File**: `ralph/hooks/scripts/triage-postcondition.sh`
**Changes**: Extend the line-~48 alternation so it matches the 8 verbatim tokens, e.g. add `CLOSE-done|CLOSE-canceled|SPLIT|PROMOTE-research|PROMOTE-plan|WAIT-pr=.+|WAIT-upstream|WAIT-decision` as an alternation branch while preserving the existing `routed (→ )?.+|duplicate|canceled|needs-split|escalated|re-estimated|skipped` branch and `^Queue empty\.`. Update the block-message "Expected one of" list.

#### 4. Palette test
**File**: `ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh`
**Changes**: Mirror the regex change into the test's `PATTERN` constant. Add `assert_matches` lines for all 8 new tokens (including a `WAIT-pr=1234` sample to exercise the `=NNN` suffix). Keep the existing `assert_no_match` lines for `KEEP`, `TRIAGED valid`, bare `TRIAGED`, lowercase `queue empty.`.

### Success Criteria

#### Automated Verification
- [ ] `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` exits 0 and reports the 8 new tokens passing.
- [ ] `bash -n ralph/hooks/scripts/triage-postcondition.sh` (syntax check) exits 0.
- [ ] `grep -E "CLOSE-done|PROMOTE-plan|WAIT-pr" ralph/skills/caretake/outcome-tokens.md` returns ≥3 hits.
- [ ] `grep -c "^- \`TRIAGED " ralph/skills/caretake/outcome-tokens.md` increased by 8.

#### Manual Verification
- [ ] §Step 4 schema table in `triage.md` matches the #1417 verdict table verbatim (verdict names, targets, consumers).
- [ ] The regex change preserves every previously-valid token (eyeball the alternation: old branches still present).

## Phase 2: Legacy plugin sync — SKILL.md + RALPH_TRIAGE_ACTION allowlist

depends_on: [phase-1]

### Overview

Sync the legacy plugin triage surface to the same 8-verdict vocabulary fixed in Phase 1, and update the plugin postcondition's `RALPH_TRIAGE_ACTION` `case` allowlist to accept the 8 new values plus legacy `KEEP` (per the issue's literal AC).

### Changes Required

#### 1. Legacy triage skill body
**File**: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`
**Changes**: Update the verdict/action documentation to present the same 8-verdict schema table as Phase 1 (kept-in-sync note already exists in the issue). Preserve the env-var (`RALPH_TRIAGE_ACTION`) model this surface uses — only the *vocabulary* changes, not the enforcement mechanism.

#### 2. Legacy plugin postcondition allowlist
**File**: `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh`
**Changes**: Extend the `case "$triage_action"` allowlist (line ~36) to accept the 8 new verdict values (`CLOSE-done|CLOSE-canceled|SPLIT|PROMOTE-research|PROMOTE-plan|WAIT-pr=*|WAIT-upstream=*|WAIT-decision`) **plus** the existing `RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE` (legacy `KEEP` retained — Phase 6 removes it). Update the top-of-file comment listing valid actions and the `block` message's "Expected" line.

### Success Criteria

#### Automated Verification
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` exits 0.
- [ ] `RALPH_TICKET_ID=test RALPH_TRIAGE_ACTION=PROMOTE-plan bash plugin/ralph-hero/hooks/scripts/triage-postcondition.sh <<<'{}'` exits 0 (new value accepted); same with `RALPH_TRIAGE_ACTION=KEEP` still exits 0 (legacy retained).
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` stays green (regression guard; no TS changes expected).

#### Manual Verification
- [ ] The 8-verdict table in `ralph-triage/SKILL.md` is identical to the one in `triage.md` (no drift between the two surfaces).

## Testing Strategy

### Unit Tests
- The palette test (`triage-postcondition-palette.test.sh`) is the primary unit-level guard for the slim regex. Extended in Phase 1.

### Integration Tests
- Sanity-run the MCP server test suite (`npm test` in `plugin/ralph-hero/mcp-server`) as a regression guard even though no TS source changes are planned.

### Manual Testing Steps
1. `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` → "N passed, 0 failed".
2. Exercise the legacy hook directly with a new value and with `KEEP` (commands in Phase 2 Automated Verification).
3. Diff the two §Step 4 schema tables to confirm zero drift.

## Migration Notes

- Legacy `KEEP` is **retained** in the plugin `RALPH_TRIAGE_ACTION` allowlist this phase; Phase 6 (#1410) removes it. Do not delete `KEEP` here.
- Existing `ralph-triage`-labeled Backlog items are unaffected — they remain excluded from re-pick by the §Step 2 query. No batch migration ships here (Phase 2 of the epic, per-project).
- The slim and legacy surfaces use different enforcement (terminal token vs. env var); this plan keeps both — it does not unify them. Unification, if ever, is post-migration cleanup outside this epic.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1404
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1417
- Slim triage body: `ralph/skills/caretake/modes/triage.md`
- Slim postcondition + test: `ralph/hooks/scripts/triage-postcondition.sh`, `ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh`
- Token contract: `ralph/skills/caretake/outcome-tokens.md`
- Legacy skill + hook: `plugin/ralph-hero/skills/ralph-triage/SKILL.md`, `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh`
