---
date: 2026-03-09
status: draft
type: plan
github_issue: 550
github_issues: [550, 551, 552, 553, 554, 555]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/550
  - https://github.com/cdubiel08/ralph-hero/issues/551
  - https://github.com/cdubiel08/ralph-hero/issues/552
  - https://github.com/cdubiel08/ralph-hero/issues/553
  - https://github.com/cdubiel08/ralph-hero/issues/554
  - https://github.com/cdubiel08/ralph-hero/issues/555
primary_issue: 550
epic_issue: 549
tags: [knowledge-graph, metadata, shared-fragments, skill-templates, frontmatter, hooks, indexer, backfill]
---

# Knowledge Metadata Alignment — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]
- builds_on:: [[2026-03-09-GH-0550-knowledge-metadata-fragment]]
- builds_on:: [[2026-03-09-GH-0551-autonomous-skills-knowledge-metadata]]
- builds_on:: [[2026-03-09-GH-0554-knowledge-indexer-parser-github-issues-fallback]]
- builds_on:: [[2026-03-09-GH-0555-backfill-type-metadata]]
- builds_on:: [[2026-03-08-knowledge-graph-design]]
- builds_on:: [[2026-03-08-knowledge-graph-impl]]

## Overview

6 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate | Stream |
|-------|-------|-------|----------|--------|
| 1 | GH-550 | Create shared knowledge-metadata fragment for skill templates | XS | A |
| 2 | GH-551 | Update autonomous skills (ralph-research, ralph-plan, ralph-review) with knowledge metadata | XS | A |
| 3 | GH-552 | Update interactive skills (research, plan, draft, form, iterate) with knowledge metadata | XS | A |
| 4 | GH-553 | Update review-verify-doc.sh hook and specs for type:review rename | XS | B |
| 5 | GH-554 | Update ralph-knowledge indexer parser to support github_issues array fallback | XS | B |
| 6 | GH-555 | Backfill existing documents with type metadata (critique->review, add type:plan, type:idea) | XS | B |

**Why grouped**: All 6 issues serve the same goal (making documents discoverable via `knowledge_search` and `knowledge_traverse`). They share cross-cutting dependencies: the `type: critique` -> `type: review` rename in Phases 2/4 must be atomic to avoid breaking the `review-verify-doc.sh` hook, and the backfill in Phase 6 depends on both the hook update (Phase 4) and the indexer update (Phase 5) to deliver full benefit after reindexing.

**Two independent streams**:
- **Stream A (skills)**: Phase 1 -> Phase 2 -> Phase 3. Creates the shared fragment, then updates autonomous skills (which use `!cat` injection), then interactive skills (which use inline guidance).
- **Stream B (hook/indexer/backfill)**: Phase 4 -> Phase 5 -> Phase 6. Updates enforcement/specs, then the indexer parser, then runs one-time backfill + reindex.

Stream A and Stream B are independent and can be implemented in parallel. The only cross-stream coordination is that the `type: critique` -> `type: review` rename in ralph-review (Phase 2, Stream A) must be deployed atomically with the hook update (Phase 4, Stream B) to avoid breaking AUTO mode reviews. In a single-PR implementation, this is naturally satisfied.

## Current State Analysis

The ralph-knowledge indexer reads `type`, `tags`, `github_issue` (singular integer), and `## Prior Work` wikilinks from document frontmatter/body. However, multiple skills produce documents with gaps:

| Gap | Impact |
|-----|--------|
| No shared fragment explaining metadata fields | Skills duplicate guidance or omit it entirely |
| `ralph-plan` missing `type: plan` and `github_issue:` (singular) | Plans invisible to `knowledge_search(type="plan")` and issue-based lookups |
| `ralph-review` uses `type: critique` instead of `type: review` | Type mismatch with the indexer's advertised vocabulary |
| Interactive `plan` missing `type:`, `tags:`, `github_issue:`, `## Prior Work` | Interactive plans completely absent from knowledge graph |
| `draft` missing `type: idea` | Ideas invisible to type-based filtering |
| `iterate` has no preservation guidance | Edits can silently erase metadata fields |
| `review-verify-doc.sh` enforces `type: critique` | Blocks any attempt to use `type: review` in skills |
| Parser reads only `github_issue` (singular) | ~104 plan docs with `github_issues` (array) are invisible to issue lookups |
| ~60 review docs have `type: critique` | Stale type value prevents `knowledge_search(type="review")` from finding them |
| ~162 plan docs lack `type:` field entirely | Plans invisible to type-based filtering |

## Desired End State

### Verification
- [ ] `knowledge_search(type="plan")` returns plan documents
- [ ] `knowledge_search(type="review")` returns review documents
- [ ] `knowledge_search(type="idea")` returns idea documents
- [ ] `knowledge_traverse(from="<doc-id>", type="builds_on")` follows edges for new documents with `## Prior Work`
- [ ] New documents produced by all 8 skills include correct `type:`, `tags:`, and `github_issue:` fields
- [ ] `review-verify-doc.sh` enforces `type: review` (not `type: critique`)
- [ ] No existing review documents still have `type: critique`
- [ ] All plan documents have a `type:` field

## What We're NOT Doing

- Backfilling `tags:` into existing documents (too subjective; let them accumulate naturally)
- Backfilling `## Prior Work` into existing documents (454 docs would require manual research)
- Backfilling `github_issue:` into existing plan documents (the indexer fallback from Phase 5 handles this)
- Adding `tags:` to the `report` skill (it does not write files)
- Making `tags:` or `## Prior Work` hook-enforced (guidance only, not gates)
- Touching report documents in the backfill (explicitly out of scope per GH-555)
- Fixing the ~2 edge-case documents without YAML frontmatter (1 plan, 1 idea — require manual attention)

## Implementation Approach

The plan uses a shared fragment (`knowledge-metadata.md`) as the single source of truth for metadata guidance. Autonomous skills (ralph-research, ralph-plan, ralph-review) include it via `!cat` injection. Interactive skills (research, plan, draft, form, iterate) get inline guidance additions because they do not use fragment injection.

Stream A builds the fragment first (Phase 1), then propagates it to autonomous skills (Phase 2) and interactive skills (Phase 3). Stream B is a separate chain: update the hook/specs (Phase 4), fix the indexer parser (Phase 5), and run the one-time backfill (Phase 6).

**Critical atomicity constraint**: The `type: critique` -> `type: review` rename touches Phase 2 (skill template), Phase 4 (hook + specs), and Phase 6 (backfill). In a single PR, all three changes land together, so there is no broken window where the skill emits `type: review` but the hook still demands `type: critique`.

---

## Phase 1: Create Shared Knowledge-Metadata Fragment [GH-550]
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/550 | **Research**: [GH-0550 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0550-knowledge-metadata-fragment.md)

### Changes Required

#### 1. Create new fragment file
**File**: `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md` (NEW)
**Changes**: Create the file following the established fragment pattern (h2 heading, no frontmatter, concise standalone prose). Target ~30-35 lines. Content must include:

1. **`## Knowledge Graph Metadata`** heading
2. A 1-2 sentence explanation of why these fields matter (discoverability via `knowledge_search` and `knowledge_traverse`)
3. **Required Frontmatter Fields** table:

| Field | Purpose | Example |
|-------|---------|---------|
| `type` | Enables filtering by document kind | `research`, `plan`, `review`, `idea` |
| `tags` | Enables topic-based search and filtering | `[mcp-server, caching, graphql]` |

4. A note that plan documents should also include `github_issue: NNN` (singular integer, same value as `primary_issue`) for indexer linking, with a YAML example:
```yaml
github_issue: 123        # singular — for the knowledge indexer
github_issues: [123, 124] # array — existing plan convention
```

5. **`## Prior Work` Section** guidance (research and plan documents only):
   - Must appear after the `# Title`, before the first content section
   - Uses exact syntax: `- builds_on:: [[filename-without-extension]]` and `- tensions:: [[filename-without-extension]]`
   - Populate from thoughts-locator results or `knowledge_search` during research
   - If no prior work exists, include the section with "None identified."

6. **Choosing Tags** guidance:
   - Pick 2-5 tags describing the document's subject matter
   - Use existing tags when possible
   - Prefer specific component names over generic terms
   - Include the primary technology or domain

### Success Criteria
- [x] Automated: `test -f plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md` exits 0
- [x] Manual: Fragment content is clear, explains the "why", provides copy-pasteable templates, and is ~30-35 lines

**Creates for Phase 2**: The `knowledge-metadata.md` fragment that autonomous skills will include via `!cat` injection.

---

## Phase 2: Update Autonomous Skills [GH-551]
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/551 | **Research**: [GH-0551 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0551-autonomous-skills-knowledge-metadata.md) | **Depends on**: Phase 1

### Changes Required

#### 1. ralph-research — Add fragment inclusion only
**File**: [plugin/ralph-hero/skills/ralph-research/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md)
**Changes**: This skill is already nearly compliant — it has `type: research`, `tags:`, `github_issue:`, and `## Prior Work` in its template. The only change:
- Add `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md` inclusion line near the top of the workflow section (after the existing fragment inclusions, before the document creation steps). This ensures the LLM has the metadata guidance loaded when writing frontmatter.

**No other changes** to ralph-research — `tags:`, `## Prior Work`, and `type: research` are already present.

#### 2. ralph-plan — Add `type: plan` and `github_issue:` to frontmatter template, add fragment inclusion
**File**: [plugin/ralph-hero/skills/ralph-plan/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-plan/SKILL.md)
**Changes**:
- **Frontmatter template** (Step 5 template, around lines 173-187): Add two new fields:
  - `type: plan` — insert after `status: draft`
  - `github_issue: 123` — insert before or after `github_issues: [123, 124, 125]`, with a comment explaining it is derived from `primary_issue` for the knowledge indexer
- **Fragment inclusion**: Add `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md` near the top of the workflow section (after the `!cat` for `error-handling.md`, before Step 1).

**No changes to `tags:` or `## Prior Work`** — both are already present in the template (tags at line 185, Prior Work at lines 191-204).

#### 3. ralph-review — Change `type: critique` to `type: review`, add `tags:`
**File**: [plugin/ralph-hero/skills/ralph-review/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-review/SKILL.md)
**Changes**:
- **Critique frontmatter template** (AUTO mode template, around lines 213-220): Change `type: critique` to `type: review`
- **Add `tags:` field** to the critique frontmatter template: `tags: [plan-review, relevant, component, tags]` (after the `type:` line)
- **Update any prose** that references "type: critique" within the SKILL.md to say "type: review"

**Note**: This change MUST be deployed atomically with Phase 4 (hook update) to avoid breaking AUTO mode reviews. In a single PR, this is naturally satisfied.

### Success Criteria
- [x] Automated: `grep -c 'tags:' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [x] Automated: `grep -c 'type: plan' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 1
- [x] Automated: `grep -c 'github_issue:' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 2
- [x] Automated: `grep -c 'type: review' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns >= 1
- [x] Automated: `grep -c 'Prior Work' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [x] Automated: `grep -c 'Prior Work' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns >= 1
- [x] Automated: `grep -c 'knowledge-metadata' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns 1
- [x] Automated: `grep -c 'knowledge-metadata' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns 1
- [x] Manual: Templates are clear and the new fields do not bloat the prompt excessively

**Creates for Phase 3**: Establishes the pattern that interactive skills will follow (same fields, but inline instead of via fragment).

---

## Phase 3: Update Interactive Skills [GH-552]
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/552 | **Research**: GH-552 research (see issue comments) | **Depends on**: Phase 1

### Changes Required

#### 1. research (interactive) — Add `## Prior Work` to document template
**File**: [plugin/ralph-hero/skills/research/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md)
**Changes**: This skill already has `type: research` and `tags:` in its frontmatter template. Only needs:
- Add `## Prior Work` section to the document body template, between the `# Title` and `## Research Question`:
```markdown
# Research: [Research Question/Topic]

## Prior Work

- builds_on:: [[related-research-doc-id]]

## Research Question
```
- Add a note in Step 4 (synthesis section) to populate `## Prior Work` from thoughts-locator findings during context gathering.

#### 2. plan (interactive) — Add `type: plan`, `tags:`, `github_issue:`, `## Prior Work`
**File**: [plugin/ralph-hero/skills/plan/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/plan/SKILL.md)
**Changes**: This is the most deficient interactive skill. Needs:
- **Frontmatter template** (Step 4 template, around lines 196-202): Add:
  - `type: plan` after `status: draft`
  - `tags: [relevant, component, tags]` with 2-5 tag guidance
  - `github_issue: NNN` derived from `primary_issue`, with comment explaining it is for the indexer
- **Document body template**: Add `## Prior Work` section after the `# Title`, before `## Overview`:
```markdown
# [Description] - Implementation Plan

## Prior Work

- builds_on:: [[research-doc-filename]]
```
- Add guidance in Step 6 (GitHub integration) to set `github_issue: NNN` to the value of `primary_issue`.

#### 3. draft — Add `type: idea`
**File**: [plugin/ralph-hero/skills/draft/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/draft/SKILL.md)
**Changes**:
- **Frontmatter template** (around lines 71-77): Add `type: idea` after `status: draft`:
```yaml
---
date: YYYY-MM-DD
status: draft
type: idea
author: user
tags: [relevant, tags]
github_issue: null
---
```

#### 4. form — Set `type: idea` during transitions
**File**: [plugin/ralph-hero/skills/form/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form/SKILL.md)
**Changes**: Add `type: idea` to the 3 frontmatter mutation sites where `form` updates frontmatter:
- **Step 5a** (around lines 174-178): When updating frontmatter after issue creation, add `type: idea` to the set of fields being written
- **Step 5b**: Same treatment if there is a separate frontmatter update path
- **Step 5d** (around line 272): When refining, ensure `type: idea` is set if missing

#### 5. iterate — Preserve knowledge fields
**File**: [plugin/ralph-hero/skills/iterate/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/iterate/SKILL.md)
**Changes**:
- **Step 4** (around lines 184-196, "Make focused, precise edits"): Add preservation guidance after the existing bullet about maintaining automated vs manual success criteria distinction:
```
- Preserve `tags:`, `type:`, and `## Prior Work` sections — do not remove or overwrite these during edits
- If adding significant new content, consider whether new `builds_on::` relationships should be added to `## Prior Work`
```

### Success Criteria
- [ ] Automated: `grep -c 'Prior Work' plugin/ralph-hero/skills/research/SKILL.md` returns >= 1
- [ ] Automated: `grep -c 'type: plan' plugin/ralph-hero/skills/plan/SKILL.md` returns >= 1
- [ ] Automated: `grep -c 'type: idea' plugin/ralph-hero/skills/draft/SKILL.md` returns >= 1
- [ ] Automated: `grep -c 'type: idea' plugin/ralph-hero/skills/form/SKILL.md` returns >= 1
- [ ] Automated: `grep -c 'Prior Work' plugin/ralph-hero/skills/iterate/SKILL.md` returns >= 1
- [ ] Manual: Interactive plan skill template includes all four new fields naturally
- [ ] Manual: Iterate skill guidance is clear about preservation without being heavy-handed

**Creates for Phase 6**: All new documents will have correct metadata going forward; the backfill addresses existing documents.

---

## Phase 4: Update Hook and Specs for type:review Rename [GH-553]
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/553 | **Research**: GH-553 research (see issue comments)

### Changes Required

#### 1. Update review-verify-doc.sh hook
**File**: [plugin/ralph-hero/hooks/scripts/review-verify-doc.sh:33-34](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/review-verify-doc.sh#L33-L34)
**Changes**: Change the enforcement check from `type: critique` to `type: review`:

Before:
```bash
if ! head -20 "$file_path" | grep -q "^type: critique"; then
  block "Critique missing 'type: critique' in frontmatter: $file_path"
fi
```

After:
```bash
if ! head -20 "$file_path" | grep -q "^type: review"; then
  block "Review document missing 'type: review' in frontmatter: $file_path"
fi
```

This is the sole enforcement point for the `type:` field on review documents. No other hook validates this field.

#### 2. Update artifact-metadata.md spec
**File**: [specs/artifact-metadata.md:74](https://github.com/cdubiel08/ralph-hero/blob/main/specs/artifact-metadata.md#L74)
**Changes**:
- **Line 74**: Change `Critique docs MUST include \`type: critique\` field` to `Critique docs MUST include \`type: review\` field`
- **Add 4 new SHOULD rows** after the Critique Documents section (or in the appropriate Plan Documents section):

```
| Research docs SHOULD include `tags` field (array of strings) | [ ] not enforced (skill-prompt guidance) |
| Plan docs SHOULD include `type: plan` field | [ ] not enforced (skill-prompt guidance) |
| Plan docs SHOULD include `tags` field (array of strings) | [ ] not enforced (skill-prompt guidance) |
| Plan docs SHOULD include `github_issue` field (integer, same as primary_issue) | [ ] not enforced |
```

#### 3. Update document-protocols.md spec
**File**: [specs/document-protocols.md](https://github.com/cdubiel08/ralph-hero/blob/main/specs/document-protocols.md)
**Changes**:
- **Line 95**: Change `type: critique` to `type: review` in the frontmatter schema reference
- **Line 107**: Change `type: critique` to `type: review` in the requirement row: `Critique frontmatter MUST include \`status\`, \`github_issue\`, and \`type: review\` fields`

### Success Criteria
- [x] Automated: `grep 'type: review' plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` matches
- [x] Automated: `grep -c 'type: critique' plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` returns 0
- [x] Automated: `grep 'type: review' specs/artifact-metadata.md` matches
- [x] Automated: `grep 'type: review' specs/document-protocols.md` matches
- [x] Automated: `grep -c 'SHOULD' specs/artifact-metadata.md` returns >= 4 (new SHOULD rows)
- [x] Manual: Specs are internally consistent and cross-references are correct

**Creates for Phase 6**: The hook now accepts `type: review`, enabling the backfill to rename `type: critique` -> `type: review` in existing review documents without breaking future AUTO mode reviews.

---

## Phase 5: Update Indexer Parser for github_issues Fallback [GH-554]
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/554 | **Research**: [GH-0554 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0554-knowledge-indexer-parser-github-issues-fallback.md)

### Changes Required

#### 1. Update parser.ts with fallback chain
**File**: [plugin/ralph-knowledge/src/parser.ts:60](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/parser.ts#L60)
**Changes**: Replace the single-line `githubIssue` extraction with a fallback chain:

Before:
```typescript
githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,
```

After:
```typescript
githubIssue: typeof frontmatter.github_issue === "number"
  ? frontmatter.github_issue
  : Array.isArray(frontmatter.github_issues) && typeof frontmatter.github_issues[0] === "number"
    ? frontmatter.github_issues[0]
    : typeof frontmatter.primary_issue === "number"
      ? frontmatter.primary_issue
      : null,
```

Fallback chain: `github_issue` -> `github_issues[0]` -> `primary_issue` -> `null`

No type, schema, or downstream changes needed. The `ParsedDocument` interface (`githubIssue: number | null`) and `DocumentRow` interface already accommodate this output.

#### 2. Add parser test cases
**File**: [plugin/ralph-knowledge/src/__tests__/parser.test.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/__tests__/parser.test.ts)
**Changes**: Add test cases for the three fallback scenarios:

1. **`github_issues` array fallback**: Document with only `github_issues: [42]` -> yields `githubIssue: 42`
2. **`primary_issue` fallback**: Document with only `primary_issue: 42` -> yields `githubIssue: 42`
3. **Regression guard**: Document with `github_issue: 42` -> yields `githubIssue: 42` (may already be covered but worth an explicit named test)
4. **Edge case — empty array**: Document with `github_issues: []` -> yields `githubIssue: null`
5. **Edge case — null primary_issue**: Document with `primary_issue: null` -> yields `githubIssue: null`

### Success Criteria
- [x] Automated: `cd plugin/ralph-knowledge && npm test` passes
- [x] Automated: Parser test for `github_issues: [42]` -> `githubIssue: 42`
- [x] Automated: Parser test for `primary_issue: 42` -> `githubIssue: 42`
- [x] Automated: Parser test for `github_issue: 42` -> `githubIssue: 42` (no regression)
- [ ] Manual: After reindex (Phase 6), `knowledge_search(type="plan")` returns plan documents linked to their issues

**Creates for Phase 6**: The indexer can now correctly link plan documents to issues via the `github_issues` array fallback, enabling full benefit from the reindex.

---

## Phase 6: Backfill Existing Documents [GH-555]
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/555 | **Research**: [GH-0555 research](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0555-backfill-type-metadata.md) | **Depends on**: Phase 4 (hook), Phase 5 (indexer)

### Changes Required

#### 1. Backfill review documents — `type: critique` -> `type: review`
**Target**: `thoughts/shared/reviews/*.md` (~60 files)
**Command**:
```bash
find thoughts/shared/reviews/ -name '*.md' -exec \
  sed -i 's/^type: critique$/type: review/' {} +
```
This is a clean `sed` with zero ambiguity — all 60 review docs have `type: critique` and none already use `type: review`.

#### 2. Backfill plan documents — insert `type: plan` where missing
**Target**: `thoughts/shared/plans/*.md` (~162 files missing `type:` out of 180 total)
**Command**:
```bash
for f in thoughts/shared/plans/*.md; do
  if head -20 "$f" | grep -q "^---" && ! head -20 "$f" | grep -q "^type:"; then
    sed -i '/^status:/a type: plan' "$f"
  fi
done
```
**Edge cases handled**:
- 18 plan docs that already have a `type:` field (5 with `type: plan`, 13 with other types) are correctly skipped by the `! grep -q "^type:"` guard
- 1 plan doc (`2026-02-20-ralph-team-worker-redesign.md`) lacks YAML frontmatter entirely and will be silently skipped (no `^---` match) — acceptable loss

#### 3. Backfill idea documents — insert `type: idea` where missing
**Target**: `thoughts/shared/ideas/*.md` (1 of 2 files will be modified)
**Command**:
```bash
for f in thoughts/shared/ideas/*.md; do
  if head -20 "$f" | grep -q "^---" && ! head -20 "$f" | grep -q "^type:"; then
    sed -i '/^status:/a type: idea' "$f"
  fi
done
```
**Edge cases**: 1 idea doc (`2026-02-25-idea-hunt-synthesis.md`) has no YAML frontmatter and will be silently skipped — acceptable loss.

#### 4. Reindex the knowledge database
**Command**:
```bash
cd plugin/ralph-knowledge && npm run build && node dist/reindex.js \
  ../../thoughts ../../knowledge.db
```
This must run AFTER Phase 5 (indexer update) to get the full benefit of the `github_issues` fallback for plan documents.

#### 5. Commit the backfill
```bash
git add thoughts/shared/reviews/ thoughts/shared/plans/ thoughts/shared/ideas/
git commit -m "chore: backfill type metadata for knowledge graph alignment

- type: critique -> type: review in ~60 review documents
- Add type: plan to ~162 plan documents missing it
- Add type: idea to idea documents missing it"
```

### Success Criteria
- [ ] Automated: `grep -rc "type: critique" thoughts/shared/reviews/` returns 0
- [ ] Automated: `grep -rc "type: review" thoughts/shared/reviews/` returns count > 0
- [ ] Automated: `grep -rL "^type:" thoughts/shared/plans/*.md | wc -l` returns 1 or 0 (the 1 edge case without YAML frontmatter)
- [ ] Automated: `grep -rL "^type:" thoughts/shared/ideas/*.md | wc -l` returns 1 or 0 (the 1 edge case without YAML frontmatter)
- [ ] Automated: Reindex completes without errors
- [ ] Manual: `knowledge_search(type="review")` returns review documents
- [ ] Manual: `knowledge_search(type="plan")` returns plan documents
- [ ] Manual: `knowledge_search(type="idea")` returns idea documents

---

## Integration Testing

After all 6 phases are complete:
- [ ] `cd plugin/ralph-knowledge && npm test` passes (Phase 5 parser tests)
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` succeeds (no MCP server changes, but sanity check)
- [ ] Create a test research document with all new fields -> verify `knowledge_search` finds it
- [ ] Create a test plan document with `type: plan`, `github_issue:`, `tags:` -> verify `knowledge_search(type="plan")` finds it
- [ ] Run `ralph_review` in AUTO mode -> verify the critique has `type: review` and is NOT blocked by `review-verify-doc.sh`
- [ ] `knowledge_traverse` follows `builds_on` edges from a newly created document with `## Prior Work`
- [ ] All `grep` acceptance criteria from each issue pass

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/549
- Parent plan: [2026-03-09-GH-0549-knowledge-metadata-alignment.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-03-09-GH-0549-knowledge-metadata-alignment.md)
- Research: [GH-0550](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0550-knowledge-metadata-fragment.md), [GH-0551](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0551-autonomous-skills-knowledge-metadata.md), [GH-0554](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0554-knowledge-indexer-parser-github-issues-fallback.md), [GH-0555](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-09-GH-0555-backfill-type-metadata.md)
- Knowledge graph design: [docs/plans/2026-03-08-knowledge-graph-design.md](https://github.com/cdubiel08/ralph-hero/blob/main/docs/plans/2026-03-08-knowledge-graph-design.md)
- Hook source: [review-verify-doc.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/review-verify-doc.sh)
- Indexer parser: [parser.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/parser.ts)
