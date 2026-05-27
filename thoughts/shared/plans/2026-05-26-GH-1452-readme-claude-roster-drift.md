---
date: 2026-05-26
status: ready
type: plan
tags: [docs, claude-md, readme, agent-roster, doc-consistency]
github_issue: 1452
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1452
primary_issue: 1452
estimate: S
---

# GH-1452 — Fix agent-roster drift + factual errors in README.md and CLAUDE.md

## Prior Work

- Part of epic #1459 (Documentation hardening); sibling #1458 (CI doc-consistency check) is the recurrence guard. The epic has no plan-of-plans — children are independent.
- The wrong roster was introduced by the GH-1438 rewrite (epic #1430, Phase 8) that deleted `plugin/ralph-hero/` and rewrote both CLAUDE.md files.

## Overview

`CLAUDE.md` and `README.md` document an agent roster that does not match `ralph/agents/`. Both name 9 agents that don't exist and omit 8 that do — actively misleading every human reader and every Claude session that loads these canonical files (verified: this exact wrong roster misled the autopilot that triaged this issue). A few smaller factual drifts (README Node version, caretake-modes row, MCP-tool table) live in the same files. This plan corrects all of them to match reality. Doc-only — no code, no behavior change.

## Current State Analysis

Verified on `main` (2026-05-26):

- **Actual `ralph/agents/` (16 files):** `catch-up-agent, codebase-analyzer, codebase-locator, codebase-pattern-finder, impl-agent, log-reader, merge-agent, plan-agent, research-agent, review-agent, sre-fixit, thoughts-analyzer, thoughts-locator, triage-agent, val-agent, web-search-researcher`.
- **`CLAUDE.md:76-78`** claims per-phase `impl/plan/research/review/merge/catch-up/caretake-agent/form-agent` + investigators `codebase-locator/plan-investigator/research-investigator/impl-investigator/review-investigator/caretake-investigator/hero-investigator/scout-agent`. **9 of these don't exist** (`caretake-agent, form-agent, plan-investigator, research-investigator, impl-investigator, review-investigator, caretake-investigator, hero-investigator, scout-agent`); only `codebase-locator` overlaps.
- **`CLAUDE.md:47`** tree-comment: `# 16 agents (8 thin per-phase + 8 fat investigators)` — count is right, the per-phase/investigator split + names are not (the real split is 8 per-phase + 8 investigators but with different names).
- **`README.md:118`**: `# 16 agents (8 per-phase + 8 investigators)` — same wrong framing.
- **`README.md:27`**: "Node.js 18+" while CI tests Node 20/22.

### Key Discoveries

- The correct categorization (8 + 8): **per-phase** = catch-up, impl, merge, plan, research, review, triage, val; **investigators** = codebase-analyzer, codebase-locator, codebase-pattern-finder, log-reader, sre-fixit, thoughts-analyzer, thoughts-locator, web-search-researcher.
- The README MCP-tool table must be verified against the actual `ralph_hero__*` tools registered in `mcp-server/src/tools/` — note explicitly if the table is an intentional curated subset rather than exhaustive.
- Doc-only change: no code paths, no tests assert on this prose. CI (`ci.yml`) does not test README/CLAUDE.md content.

## Desired End State

1. `CLAUDE.md` § "ralph Plugin — 16 Agents" lists the real roster (8 per-phase + 8 investigators, correct names) and `CLAUDE.md:47` tree-comment matches.
2. All 9 non-existent agent references removed from both files.
3. `README.md` architecture agents block matches the corrected roster; Node version reconciled to CI (20/22); caretake skill-modes row matches CLAUDE.md (triage/hygiene/unblock/trends/split/debug/report).
4. README MCP-tool table verified against `mcp-server/src/tools/`; if curated, labelled as such.
5. No code change; no behavior change.

### Verification

- Automated: `for a in $(ls ralph/agents/ | sed 's/\.md$//'); do grep -q "$a" CLAUDE.md README.md || echo "MISSING: $a"; done` prints nothing (every real agent named). `grep -nE 'caretake-agent|form-agent|plan-investigator|research-investigator|impl-investigator|review-investigator|caretake-investigator|hero-investigator|scout-agent' CLAUDE.md README.md` returns no hits (all phantoms gone). `grep -n 'Node.js 18' README.md` returns no hits.
- Manual: read both roster sections + the README caretake row + MCP-tool table and confirm they match reality.

## What We're NOT Doing

- NOT changing any code, agent files, or skill files — docs only.
- NOT adding the CI doc-consistency check (that is sibling #1458).
- NOT touching the other epic-#1459 doc tasks (#1453-#1457).
- NOT addressing the `impl/SKILL.md:194 → §Delegated Summary` dangling reference (flagged separately on #1383; out of scope here).

## Implementation Approach

Two phases by file, each independently verifiable. Phase 1 fixes `CLAUDE.md` (roster section + tree-comment). Phase 2 fixes `README.md` (agents block + Node version + caretake-modes row + MCP-tool-table verification). Independent files → both `depends_on: null` (parallel-safe), though a single implementer will do them sequentially.

## Phase 1: Correct CLAUDE.md agent roster
depends_on: null

### Overview
Rewrite `CLAUDE.md` § "ralph Plugin — 16 Agents" + the `agents/` tree-comment to the real roster.

### Changes Required
#### 1. CLAUDE.md roster section + tree comment
**File**: `CLAUDE.md`
**Changes**: At `CLAUDE.md:76-78`, replace the per-phase + investigator lists with the real roster — per-phase (8): `catch-up-agent, impl-agent, merge-agent, plan-agent, research-agent, review-agent, triage-agent, val-agent`; investigators (8): `codebase-analyzer, codebase-locator, codebase-pattern-finder, log-reader, sre-fixit, thoughts-analyzer, thoughts-locator, web-search-researcher`. Remove all 9 phantom names. Keep `CLAUDE.md:47` tree-comment count (16) but reconcile the split label with the corrected names.

### Success Criteria
#### Automated Verification
- [ ] `grep -nE 'caretake-agent|form-agent|plan-investigator|research-investigator|impl-investigator|review-investigator|caretake-investigator|hero-investigator|scout-agent' CLAUDE.md` returns no hits.
- [ ] `for a in triage-agent val-agent codebase-analyzer codebase-pattern-finder log-reader sre-fixit thoughts-analyzer thoughts-locator web-search-researcher; do grep -q "$a" CLAUDE.md || echo "MISSING $a"; done` prints nothing.
- [ ] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass (no regression).

#### Manual Verification
- [ ] The roster section reads correctly and the 8/8 split matches `ls ralph/agents/`.

## Phase 2: Correct README.md roster, Node version, caretake row, MCP table
depends_on: null

### Overview
Align `README.md` with reality: agents block, Node version, caretake skill-modes row, and MCP-tool-table verification.

### Changes Required
#### 1. README.md fixes
**File**: `README.md`
**Changes**:
- Agents block (`README.md:118` area): correct the roster framing/names to match the CLAUDE.md fix.
- `README.md:27`: change "Node.js 18+" → "Node.js 20+" (CI tests 20/22).
- Caretake skill row: list the same modes as CLAUDE.md (triage, hygiene, unblock, trends, split, debug, report).
- MCP-tool table: verify each row against `mcp-server/src/tools/` registered `ralph_hero__*` tools; correct mismatches, and add a one-line note if it's an intentional curated subset.

### Success Criteria
#### Automated Verification
- [ ] `grep -n 'Node.js 18' README.md` returns no hits.
- [ ] `grep -nE 'plan-investigator|hero-investigator|scout-agent|caretake-agent|form-agent' README.md` returns no hits.
- [ ] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass.

#### Manual Verification
- [ ] README agents block, caretake-modes row, and MCP-tool table match reality (cross-checked against `ls ralph/agents/`, CLAUDE.md, and `mcp-server/src/tools/`).

## Testing Strategy

### Unit Tests
None — markdown doc edits.

### Integration Tests
`bash ralph/hooks/scripts/__tests__/*.test.sh` (no regression; these don't assert on README/CLAUDE.md but confirm nothing breaks).

### Manual Testing Steps
1. Run the roster grep assertions above.
2. Diff the corrected roster against `ls ralph/agents/`.
3. Spot-check the README MCP-tool table against `mcp-server/src/tools/`.

## Migration Notes

No data/config migration. Doc-only. Note: editing `CLAUDE.md`/`README.md` changes files the running Claude session reads, but implementation happens in an isolated worktree off `main`; the corrected roster lands on `main` at merge.

## References

- Issue #1452 (parent epic #1459)
- `ralph/agents/` (the 16 real agent files — source of truth)
- `mcp-server/src/tools/` (MCP-tool table source of truth)
