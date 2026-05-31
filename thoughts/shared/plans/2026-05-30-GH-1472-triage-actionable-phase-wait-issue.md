---
date: 2026-05-30
status: draft
type: plan
tags: [triage, caretake, picker, dependencies, wait-issue]
github_issue: 1472
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1472
primary_issue: 1472
estimate: S
---

# GH-1472 — triage.md authoritative actionable-phase rule + WAIT-issue=NNN verdict

## Prior Work

- builds_on:: [[thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md]] — Gap D (triage.md never documents the picker rule) is the direct driver; Gap A (picker fallback applies no dependency filtering) and Gap C (no watcher) are the named cross-references this plan forward-points to.
- builds_on:: existing `WAIT-pr` / `WAIT-upstream` / `WAIT-decision` verdicts in `ralph/skills/caretake/modes/triage.md` §Step 4–§Step 8 — the new `WAIT-issue=NNN` verdict slots into that family.
- tensions:: the issue body instructs editing a *legacy* `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` allowlist. That file does not exist on `main` (the legacy plugin was deleted in GH-1438 / epic #1430 Phase 8; the untracked `plugin/ralph-hero/` tree on disk holds only a stub `skills/research/` and is not git-tracked). This plan drops that stale step and edits only the slim hook.

## Overview

`ralph/skills/caretake/modes/triage.md` never states which workflow phases the `next_actions` / `directions` picker treats as actionable, never warns that a `blockedBy`-OPEN item left in Backlog gets re-surfaced by the picker's Backlog fallback, and has no verdict for "blocked on an OPEN sibling issue." The result was six caretaker passes churning on landcrawler-ai #512/#515, each re-deriving the actionable-phase rule from memory and getting it wrong ("siblings are In Progress so the fallback stays dormant" — false; In Progress is NOT actionable).

This plan makes the actionable-phase rule authoritative inside triage.md, adds a `WAIT-issue=NNN` verdict that escalates an OPEN-sibling-blocked item to Human Needed (instead of leaving it in Backlog where the picker re-surfaces it), and threads the new verdict through the decision table, the `RALPH_TRIAGE_ACTION` allowlist, the terminal-token list, `outcome-tokens.md`, and the slim `triage-postcondition.sh` Stop hook + its test. It is a pure doc + hook-regex edit; no mcp-server/ TypeScript changes.

## Current State Analysis

The triage mode doc is `ralph/skills/caretake/modes/triage.md` (234 lines). Relevant existing anchors verified against `main`:

- **§Step 4: Determine action** (lines 59–78) — the 8-verdict table (lines 63–73) maps each verdict to a workflow target + downstream consumer. `WAIT-pr=NNN`, `WAIT-upstream=URL`, `WAIT-decision` are rows 6–8.
- **§Step 5: Take action** (lines 80–129) — per-verdict action prose. The `WAIT-pr=NNN / WAIT-upstream=URL` branch is at lines 103–108; `WAIT-decision` at line 110. The `RALPH_TRIAGE_ACTION` export block + valid-values list is lines 112–129.
- **§Step 6: Mark issue as triaged** (lines 131–135) — the rationale paragraph (lines 133–135) distinguishes verdicts that leave the issue in Backlog (need `ralph-triage` label to suppress §Step 2 re-pick) from those that move it OUT of Backlog.
- **§Step 8: Emit terminal token** (lines 184–198) — the per-verdict `TRIAGED …` token bullet list (lines 188–196).

The terminal-token contract is mirrored in `ralph/skills/caretake/outcome-tokens.md` — the Triage tokens table is lines 9–19.

The Stop hook is `ralph/hooks/scripts/triage-postcondition.sh`; its `TRANSCRIPT_TOKENS_RE` alternation is line 11 (currently `…|WAIT-pr=[0-9]+|WAIT-upstream|WAIT-decision|…`). The hook test is `ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh`.

### Key Discoveries

- The actionable-phase list (Plan in Review, In Review, Ready for Plan, Research Needed) lives ONLY in the compiled MCP tool description at `mcp-server/src/tools/directions-tools.ts:483` ("no items are in actionable phases (Plan in Review, In Review, Ready for Plan, Research Needed)… falls back to Backlog and null-state items"). triage.md must cite it verbatim, not paraphrase. This is the root cause of Gap D.
- **No triage routing logic lives in mcp-server.** Grep for `triage` / `WAIT-` across `mcp-server/src` returns only the `analyst-triage` filter profile, `ralph_triage` state-resolution command, pipeline-detection `TRIAGE` phase, and the directions-tools fallback description — none implement verdict selection. Verdict routing is doc-driven. So this is doc-only except the one Stop-hook regex (the hook is bash, not mcp-server).
- **The legacy `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` does not exist on `main`.** `git ls-files plugin/ralph-hero` returns 0 tracked files. The issue body's step to amend its allowlist is stale and is dropped from this plan.
- The asymmetry is the crux: `WAIT-pr` / `WAIT-upstream` may stay in Backlog because a watcher (Phase 3, #1406/#1407) owns them; an OPEN-issue blocker has no watcher until Gap C (#1473) ships, so Backlog is unsafe and `WAIT-issue` must escalate to **Human Needed**.

## Desired End State

1. triage.md contains a new authoritative subsection (§Step 4a) stating the four actionable phases verbatim, that In Progress is NOT actionable, that the Backlog fallback applies NO dependency filtering, and an explicit refutation of the "In-Progress sibling keeps the fallback dormant" reasoning.
2. triage.md documents a `WAIT-issue=NNN` verdict with its three actions: (a) `get_issue` on the blocker to branch on state, (b) if OPEN → Human Needed + `## Escalation` comment naming #NNN + ensure the `add_dependency` blocked-by edge, (c) if CLOSED → advance (do not park).
3. The §Step 4 verdict table, §Step 5 action prose, §Step 6 rationale, §Step 8 token list, the `RALPH_TRIAGE_ACTION` allowlist, and `outcome-tokens.md` all carry `WAIT-issue`, and `WAIT-pr` / `WAIT-upstream` are cross-referenced so the three `WAIT-*` verdicts read as a coherent family (with the Backlog-vs-Human-Needed asymmetry stated).
4. A decision table keyed on blocker kind + state makes Backlog-vs-Human-Needed mechanical, with a forward cross-ref to Gap A (#1473 / picker fix) noting the rule relaxes once the picker honors edges.
5. `triage-postcondition.sh` accepts `TRIAGED WAIT-issue=NNN`; the palette test asserts it passes and a bare blocked-in-Backlog line still fails.

### Verification

- `grep -n "Step 4a" ralph/skills/caretake/modes/triage.md` returns the new subsection.
- `grep -n "WAIT-issue" ralph/skills/caretake/modes/triage.md` returns ≥5 hits (table, decision table, §Step 5 branch, allowlist, §Step 8 token).
- `grep -n "WAIT-issue" ralph/skills/caretake/outcome-tokens.md` returns the new token row.
- `grep -n "WAIT-issue" ralph/hooks/scripts/triage-postcondition.sh` returns the regex addition.
- `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` exits 0.
- The `docs-consistency.yml` CI roster check passes (no roster drift introduced).

## What We're NOT Doing

- NOT editing any `mcp-server/` TypeScript. The Gap A picker fix (teaching the directions fallback to skip blockedBy-OPEN items) is a separate issue and explicitly out of scope.
- NOT building the watch-blockers mode (#1473, Gap C) — only forward-referencing it.
- NOT editing the legacy `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` — it does not exist on `main`.
- NOT renumbering existing §Steps. The new actionable-phase content is added as §Step 4a so §Step 5–§Step 8 anchors are preserved.

## Implementation Approach

Single concern (triage verdict palette + picker-rule documentation), one tightly-scoped doc plus one hook + its test. Estimate S → two phases: Phase 1 owns the triage.md + outcome-tokens.md prose; Phase 2 owns the hook regex + test. Phase 2 depends on Phase 1 only for token-string consistency (`WAIT-issue=NNN`). File ownership is disjoint — no file is touched in both phases.

## Phase 1: triage.md actionable-phase rule + WAIT-issue verdict + outcome-tokens

depends_on: null

### Overview

Add the authoritative actionable-phase subsection, the `WAIT-issue=NNN` verdict, the decision table, and thread the verdict through every list in triage.md; mirror the new token in outcome-tokens.md.

### Changes Required

#### 1. New §Step 4a — Picker actionable phases (authoritative)

**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: Insert a new `## §Step 4a: Picker actionable phases (authoritative)` subsection immediately after §Step 4 (after current line 78, before §Step 5 at line 80). Content:
- The four actionable phases verbatim: **Plan in Review, In Review, Ready for Plan, Research Needed** (cite `mcp-server/src/tools/directions-tools.ts` as the contract source).
- **In Progress is NOT actionable.**
- The picker's Backlog/null-state fallback applies **NO dependency filtering** — a `blockedBy`-OPEN item left in Backlog is re-surfaced every pass.
- Therefore **a blockedBy-OPEN item MUST NOT stay in Backlog**; the canonical park is **Human Needed** via `WAIT-issue=NNN` (or `WAIT-decision`).
- Explicit refutation: "An In-Progress sibling does NOT keep the fallback dormant — In Progress is not actionable, so the picker falls back to Backlog and re-surfaces the blocked item."
- **Decision table** keyed on blocker kind + state:

  | Blocker | Blocker state | Verdict | Resting state |
  |---|---|---|---|
  | OPEN sibling issue | OPEN | `WAIT-issue=NNN` | Human Needed (no watcher yet) |
  | OPEN sibling issue | CLOSED | advance (PROMOTE-* / normal) | out of Backlog |
  | PR | open | `WAIT-pr=NNN` | Backlog + `blocked:pr-NNN` (watcher owns it) |
  | external URL | unresolved | `WAIT-upstream=URL` | Backlog + `blocked:upstream` (watcher owns it) |
  | none | — | normal verdict | per verdict |

- Forward cross-ref to Gap A (#1473 / picker fix): once the picker fallback honors `blockedBy` edges, the Backlog-unsafe rule relaxes and the `WAIT-issue` target can move Human Needed → Backlog + edge (a one-line edit later).

#### 2. §Step 4 verdict table — add WAIT-issue row

**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: Add a `WAIT-issue=NNN` row to the verdict table (current lines 63–73), e.g. `| WAIT-issue=NNN | Human Needed + ## Escalation naming #NNN + blocked-by edge | watch-blockers (#1473) |`. Update the surrounding "8 structured verdicts" count language to "9 structured verdicts" wherever it appears (line 60 and line 128).

#### 3. §Step 5 — WAIT-issue action branch + WAIT-* cross-reference

**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: After the `WAIT-decision` branch (current line 110), add a `**WAIT-issue=NNN.**` branch with the three actions: (a) `get_issue({number: NNN})` to read blocker state FIRST; (b) if CLOSED → do not park, advance per the underlying verdict and emit that verdict's token; (c) if OPEN → `save_issue(workflowState: "Human Needed", command: "ralph_triage")`, post a `## Escalation` comment naming #NNN with a machine-readable advance condition, and `add_dependency` to ensure the blocked-by-NNN edge exists. Add one sentence cross-referencing `WAIT-pr` / `WAIT-upstream`: those may rest in Backlog because a watcher owns them; `WAIT-issue` has no watcher until #1473, so it parks in Human Needed. Add `export RALPH_TRIAGE_ACTION=WAIT-issue` to the export block (lines 112–127) and add `WAIT-issue` to the valid-values lists (lines 124 and 128).

#### 4. §Step 6 rationale amend

**File**: `ralph/skills/caretake/modes/triage.md`
**Changes**: In the §Step 6 rationale (lines 133–135), note that `WAIT-issue` (like `WAIT-decision`) moves the issue OUT of Backlog to Human Needed, so it does NOT need the `ralph-triage` re-pick-suppression label — distinguishing the two re-pick mechanisms (the §Step 2 triage-mode query vs. the picker Backlog fallback).

#### 5. §Step 8 terminal token + outcome-tokens.md

**File**: `ralph/skills/caretake/modes/triage.md`, `ralph/skills/caretake/outcome-tokens.md`
**Changes**: Add `TRIAGED WAIT-issue=NNN` to the §Step 8 token bullet list (after line 195) and to the Triage tokens table in `outcome-tokens.md` (lines 9–19), with meaning "Escalated to Human Needed; blocked on OPEN issue #NNN (the `=NNN` is part of the token)".

### Success Criteria

#### Automated Verification
- [ ] `grep -n "Step 4a" ralph/skills/caretake/modes/triage.md` returns the new subsection
- [ ] `grep -c "WAIT-issue" ralph/skills/caretake/modes/triage.md` returns ≥5
- [ ] `grep -n "WAIT-issue" ralph/skills/caretake/outcome-tokens.md` returns the new row
- [ ] `grep -n "In Progress is NOT actionable" ralph/skills/caretake/modes/triage.md` returns a hit
- [ ] No §Step heading numbers 5–8 changed (`grep -n "## §Step" ralph/skills/caretake/modes/triage.md` still shows Step 5–8 at their headings)

#### Manual Verification
- [ ] The four actionable phases appear verbatim and match `directions-tools.ts:483`
- [ ] The decision table makes Backlog-vs-Human-Needed mechanical for a reader
- [ ] The three `WAIT-*` verdicts read as a coherent family with the asymmetry stated
- [ ] Gap A (#1473) forward cross-reference present

## Phase 2: triage-postcondition hook + palette test

depends_on: [phase-1]

### Overview

Teach the slim Stop hook to accept the `TRIAGED WAIT-issue=NNN` token and extend the palette test.

### Changes Required

#### 1. Hook regex

**File**: `ralph/hooks/scripts/triage-postcondition.sh`
**Changes**: Add `WAIT-issue=[0-9]+` to the `TRANSCRIPT_TOKENS_RE` alternation (line 11), mirroring the existing `WAIT-pr=[0-9]+` form.

#### 2. Palette test

**File**: `ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh`
**Changes**: Add a case asserting a transcript line `TRIAGED WAIT-issue=512` exits 0, and confirm a bare blocked-in-Backlog line (no `TRIAGED …` token) still exits 2.

### Success Criteria

#### Automated Verification
- [ ] `grep -n "WAIT-issue" ralph/hooks/scripts/triage-postcondition.sh` returns the regex addition
- [ ] `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` exits 0
- [ ] `shellcheck ralph/hooks/scripts/triage-postcondition.sh` passes (CI runs ShellCheck on `ralph/hooks`)

#### Manual Verification
- [ ] The new test case fails before the regex edit and passes after (confirms the assertion is load-bearing)

## Testing Strategy

Doc + hook change. Verification is: grep triage.md for the new §Step 4a precondition + `WAIT-issue` verdict and grep outcome-tokens.md for the new token; run the palette test (`bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh`); confirm ShellCheck and the `docs-consistency.yml` doc-roster CI check pass. No mcp-server tests are affected (no TypeScript touched).

### Unit Tests
The hook palette test is the only automated test; it asserts `TRIAGED WAIT-issue=512` passes and bare blocked-in-Backlog fails.

### Integration Tests
None — no runtime code path changes.

### Manual Testing Steps
Read triage.md §Step 4a + the decision table and confirm a reader can mechanically pick Backlog vs Human Needed for each blocker kind/state.

## Migration Notes

No data or state migration. Existing triage runs that emitted the prior token palette remain valid (the hook only adds an alternative). The `WAIT-issue` target (Human Needed) is intentionally stricter than `WAIT-pr` / `WAIT-upstream` (Backlog) until the Gap A picker fix and #1473 watcher ship; at that point a one-line edit relaxes `WAIT-issue` to Backlog + edge.

## References

- Research: `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md` (Gap D, with Gap A/B/C cross-refs)
- Target doc: `ralph/skills/caretake/modes/triage.md`
- Token contract: `ralph/skills/caretake/outcome-tokens.md`
- Stop hook: `ralph/hooks/scripts/triage-postcondition.sh` + `__tests__/triage-postcondition-palette.test.sh`
- Picker contract (read-only reference): `mcp-server/src/tools/directions-tools.ts:483`
- Follow-up: #1473 (caretake watch-blockers mode, Gap C); Gap A picker fallback fix (separate issue)
