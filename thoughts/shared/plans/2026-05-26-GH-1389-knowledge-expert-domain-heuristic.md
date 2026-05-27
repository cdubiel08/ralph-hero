---
date: 2026-05-26
status: ready
type: plan
tags: [ralph-slim, research, knowledge-expert, doc-consistency]
github_issue: 1389
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1389
primary_issue: 1389
estimate: XS
---

# GH-1389 — Document the knowledge_expert domain-extraction heuristic in research-shapes.md

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] — the slim restructure (Plan 3, `/ralph:research` fold) that moved the `knowledge_expert` call shape into `research-shapes.md` but dropped the domain-extraction heuristic prose.
- The old source (`plugin/ralph-hero/skills/ralph-research/SKILL.md:183-201`, Step 3d) carried the heuristic verbatim but was deleted in GH-1438 (epic #1430). The heuristic content survives in issue #1389's body.

## Overview

`ralph/skills/research/research-shapes.md` § Knowledge-graph dispatch shape shows the `knowledge_expert(domain="<domain>", ...)` call (line 36) with `<domain>` as a bare placeholder, and a "no domain extractable → skip silently" fallback in the Graceful degradation table (line 77) — but it never documents **how to derive** the `domain` string. A reader of the slim research verb + reference can't tell how to pick it. This plan adds a short "Picking the `domain` parameter" subsection with the three-priority heuristic. Pure reference-doc addition — no code, no behavior change (the tool already tolerates a loose/missing domain).

## Current State Analysis

- `ralph/skills/research/research-shapes.md:36` — `knowledge_expert(domain="<domain>", issue_number=<NNN>, ...)` shown with `<domain>` unspecified.
- `ralph/skills/research/research-shapes.md:77` (Graceful degradation table) — has only the terminal fallback row `knowledge_expert unavailable or no domain extractable → Skip silently`. No derivation rule.
- The `## Knowledge-graph dispatch shape` section spans lines 28-45 (code block + "Use results to:" bullets), ending before `## Cross-repo addendum` (line 47) — the natural home for the new subsection.

### Key Discoveries

- The three-priority heuristic (from #1389's body, quoting the deleted old SKILL.md): (1) issue **label** match, (2) **noun-phrase** extraction from the issue title, (3) **skip**. Priority 3 already aligns with the existing line-77 "skip silently" fallback.
- No code reads a "domain heuristic" — it's purely agent-facing prose guidance. So this is a documentation-only change with zero runtime impact.

## Desired End State

1. `ralph/skills/research/research-shapes.md` § Knowledge-graph dispatch shape contains a `### Picking the \`domain\` parameter` subsection documenting the three-priority heuristic (label → noun-phrase → skip).
2. The subsection cross-references the existing "skip silently" fallback so the two are consistent.
3. No other file changes; no behavior change.

### Verification

- Automated: `grep -nE 'Picking the .domain. parameter|label match|noun.?phrase' ralph/skills/research/research-shapes.md` shows the new subsection with all three priorities.
- Automated: `bash ralph/skills/shared/__tests__/*.test.sh` and `bash ralph/hooks/scripts/__tests__/*.test.sh` pass (no regressions; the suites don't assert on this file but confirm nothing breaks).
- Manual: read the new subsection in context and confirm it reads naturally between the call shape and the Cross-repo addendum.

## What We're NOT Doing

- NOT changing any code or the `knowledge_expert` MCP tool — the tool already tolerates a missing/loose `domain`.
- NOT adding domain-extraction logic to the research SKILL.md body (the slim convention keeps such prose in the reference file, not the skill body).
- NOT touching the research SKILL.md or other reference sections.

## Implementation Approach

A single trivial phase: insert one `### Picking the \`domain\` parameter` subsection into `research-shapes.md` within the existing `## Knowledge-graph dispatch shape` section (after the "Use results to:" bullets, before `## Cross-repo addendum`). ~10 lines of markdown.

## Phase 1: Add the domain-extraction heuristic subsection
depends_on: null

### Overview
Document the three-priority `domain` heuristic in `research-shapes.md` so the slim research verb is self-contained.

### Changes Required
#### 1. research-shapes.md subsection
**File**: `ralph/skills/research/research-shapes.md`
**Changes**: Within `## Knowledge-graph dispatch shape`, after the "Use results to:" bullet list and before `## Cross-repo addendum`, add a `### Picking the \`domain\` parameter` subsection with the three-priority heuristic, in order:
1. **Issue label match** — if the issue carries a label that maps to a known domain/component area, use it as the `domain`.
2. **Noun-phrase extraction** — else extract the dominant noun phrase from the issue title and use that.
3. **Skip** — if neither yields a usable domain, omit the `knowledge_expert` call (consistent with the existing "no domain extractable → skip silently" row in § Graceful degradation).

### Success Criteria
#### Automated Verification
- [x] `grep -cE 'Picking the .domain. parameter' ralph/skills/research/research-shapes.md` returns `1`.
- [x] `grep -cE 'Issue label match|Noun-phrase extraction' ralph/skills/research/research-shapes.md` returns `2` (falsifiable priority-presence check — replaces the original loose `|skip` count per plan-review GAP).
- [x] `bash ralph/hooks/scripts/__tests__/*.test.sh` all pass; `bash ralph/skills/shared/__tests__/*.test.sh` introduces no new failures (only the unchanged pre-existing out-of-scope `hero:auto` failure in `loop-continuation.test.sh`, which this change does not touch).

#### Manual Verification
- [ ] The subsection reads naturally in context and cross-references the § Graceful degradation skip fallback.

## Testing Strategy

### Unit Tests
None — markdown reference-doc addition.

### Integration Tests
Run the existing bash suites to confirm no regression: `bash ralph/skills/shared/__tests__/*.test.sh`, `bash ralph/hooks/scripts/__tests__/*.test.sh`.

### Manual Testing Steps
1. `grep` for the new subsection + the three priorities.
2. Read the section to confirm flow.

## Migration Notes

No data/config migration. No behavior change — `knowledge_expert` already tolerates a missing/loose `domain`; this only makes the derivation rule visible to the agent without consulting the deleted old plugin.

## References

- Issue #1389 (carries the heuristic content in its body)
- `ralph/skills/research/research-shapes.md` § Knowledge-graph dispatch shape + § Graceful degradation
