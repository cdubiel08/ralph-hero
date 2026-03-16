---
date: 2026-03-09
status: approved
github_issues: [549]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/549
primary_issue: 549
---

# Knowledge Metadata Alignment — Implementation Plan

## Overview

Align the document metadata produced by all ralph-hero skills with what the ralph-knowledge indexer expects, so that every document in `thoughts/` is fully discoverable via `knowledge_search` and `knowledge_traverse`.

| Phase | Scope | Description |
|-------|-------|-------------|
| 1 | Shared fragment | Create `knowledge-metadata.md` fragment with canonical frontmatter and `## Prior Work` guidance |
| 2 | Autonomous skills | Update `ralph-research`, `ralph-plan`, `ralph-review` templates |
| 3 | Interactive skills | Update `research`, `plan`, `draft`, `form`, `iterate` templates |
| 4 | Hooks & specs | Update `review-verify-doc.sh`, `artifact-metadata.md`, `document-protocols.md` |
| 5 | Indexer | Update parser to read `github_issues` array fallback; update tool description |
| 6 | Backfill | Script to add missing `type:` and fix `type: critique` → `type: review` in existing docs |

## Current State Analysis

The ralph-knowledge indexer (`parser.js`) reads these fields from frontmatter:
- `date` (string)
- `type` (string) — used for `knowledge_search(type=...)` filtering
- `status` (string)
- `github_issue` (integer, singular)
- `tags` (array of strings)
- `superseded_by` (string with wikilink)

It also parses `## Prior Work` body sections for `builds_on::` and `tensions::` wikilinks.

### Key Gaps

| Gap | Affected Skills | Impact |
|-----|----------------|--------|
| `tags:` missing | `ralph-research`, `ralph-plan`, `ralph-review`, `plan` (interactive) | Documents not filterable by tag |
| `type:` missing | `ralph-plan`, `plan`, `draft` | Plans invisible to `knowledge_search(type="plan")`, ideas invisible to `type="idea"` |
| `type: critique` instead of `type: review` | `ralph-review` + 50+ existing docs | Type filter mismatch with directory/skill naming |
| `github_issue:` missing from plans | `ralph-plan`, `plan` | Plans use `github_issues` (array); indexer reads only `github_issue` (singular) |
| `## Prior Work` missing | `ralph-research`, `ralph-plan`, `research`, `plan` | No relationship edges in knowledge graph |
| `form` doesn't add `type:` | `form` | Formed ideas stay typeless |
| `iterate` doesn't preserve new fields | `iterate` | Edits could drop `tags`, `type`, `## Prior Work` |

## Desired End State

Every document produced by ralph-hero skills includes:
1. A `type:` field matching its canonical type (`research`, `plan`, `review`, `idea`, `report`)
2. A `tags:` field with relevant topic tags
3. A `github_issue:` field (singular integer) when linked to an issue — plan documents derive this from `primary_issue`
4. A `## Prior Work` section (research and plan documents only) with typed wikilinks

The knowledge-index tool description matches the actual type vocabulary, and the indexer handles the `github_issues` array as a fallback.

### Verification

After implementation:
```bash
# Reindex
cd /tmp && node node_modules/ralph-hero-knowledge-index/dist/reindex.js \
  ~/projects/ralph-hero/thoughts ~/.ralph-hero/knowledge.db

# All plans findable by type
knowledge_search(query="implementation", type="plan", limit=3)

# All reviews findable by type
knowledge_search(query="critique approved", type="review", limit=3)

# All ideas findable by type
knowledge_search(query="idea", type="idea", limit=3)

# Tags work
knowledge_search(query="caching", tags=["mcp-server"], limit=3)

# Relationship traversal works for new documents
knowledge_traverse(from="<new-research-doc-id>", type="builds_on")
```

## What We're NOT Doing

- Backfilling `tags:` into existing documents (too subjective; let them accumulate naturally)
- Backfilling `## Prior Work` into existing documents (would require researching 454 docs)
- Backfilling `github_issue:` into existing plan documents (indexer fallback handles this)
- Adding `tags:` to the `report` skill (it doesn't write files)
- Making `tags:` or `## Prior Work` hook-enforced (guidance only, not gates)

## Implementation Approach

Use a shared fragment (`knowledge-metadata.md`) to explain *why* these fields matter and provide the canonical patterns. Skills include it via backtick injection. This follows the existing fragment pattern (error-handling, escalation-steps) and avoids duplicating guidance across 8+ skills.

---

## Phase 1: Create Shared Fragment

### Overview
Create a new shared fragment that explains the knowledge graph fields and provides templates.

### Changes Required

#### 1. New fragment file
**File**: `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md`
**Changes**: Create new file with the following content:

```markdown
## Knowledge Graph Metadata

Documents in `thoughts/` are indexed by the ralph-knowledge plugin for search and relationship traversal. These frontmatter fields and document sections make your output discoverable.

### Required Frontmatter Fields

Every document you write to `thoughts/` should include:

| Field | Purpose | Example |
|-------|---------|---------|
| `type` | Enables filtering by document kind | `research`, `plan`, `review`, `idea` |
| `tags` | Enables topic-based search and filtering | `[mcp-server, caching, graphql]` |

Plan documents should also include `github_issue` (singular integer) derived from `primary_issue`, so the indexer can link the plan to its issue:

```yaml
github_issue: 123        # derived from primary_issue for indexer
github_issues: [123, 124] # existing field for multi-issue plans
```

### `## Prior Work` Section (Research & Plan Documents Only)

After the title (`# ...`), include a `## Prior Work` section listing documents that informed this one. Use Obsidian Dataview inline field syntax with wikilinks:

```markdown
## Prior Work

- builds_on:: [[2026-02-28-GH-0460-cache-invalidation-research]]
- tensions:: [[2026-02-25-GH-0390-aggressive-caching-plan]]
```

- `builds_on` = "This document was informed by that one"
- `tensions` = "This document conflicts with or pulls against that one"
- Use filenames without `.md` extension inside `[[...]]`
- If no prior work exists, include the section with "None identified."
- Populate from thoughts-locator results or `knowledge_search` during research

### Choosing Tags

Pick 3-5 tags that describe the document's subject matter:
- Use existing tags when possible (check `knowledge_search` results for common tags)
- Prefer specific component names over generic terms (`mcp-server` over `server`)
- Include the primary technology or domain (`graphql`, `github-projects`, `cli`)
```

### Success Criteria

#### Automated Verification:
- [ ] File exists: `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md`

#### Manual Verification:
- [ ] Fragment content is clear, explains the "why", and provides copy-pasteable templates

---

## Phase 2: Update Autonomous Skills

### Overview
Add knowledge metadata to the three autonomous skills that produce documents.

### Changes Required

#### 1. ralph-research — Add `tags:` and `## Prior Work`
**File**: `plugin/ralph-hero/skills/ralph-research/SKILL.md`

**Frontmatter template** (lines 116-124): Add `tags:` field:
```yaml
---
date: YYYY-MM-DD
github_issue: NNN
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
status: complete
type: research
tags: [relevant, component, tags]
---
```

**After the document template section** (after line 148, before Step 7): Add fragment inclusion and `## Prior Work` guidance:
```
The document should include a `## Prior Work` section after the title, before the problem statement. Populate it from thoughts-locator findings during Step 4.
```

Add fragment inclusion near the top of the workflow section (after line 43):
```
!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md
```

#### 2. ralph-plan — Add `tags:`, `type: plan`, `github_issue:`, `## Prior Work`
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`

**Frontmatter template** (lines 168-179): Add `type:`, `tags:`, and `github_issue:`:
```yaml
---
date: YYYY-MM-DD
status: draft
type: plan
tags: [relevant, component, tags]
github_issue: 123
github_issues: [123, 124, 125]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/123
primary_issue: 123
stream_id: "stream-123-125"
stream_issues: [123, 125]
epic_issue: 40
---
```

Note: `github_issue` is always set to the same value as `primary_issue`. This is for the knowledge indexer which reads only the singular field.

**Document body template** (after line 181): Add `## Prior Work` section between the title and `## Overview`:
```markdown
# [Description] - Atomic Implementation Plan

## Prior Work

- builds_on:: [[YYYY-MM-DD-GH-NNNN-research-doc]]
```

Add fragment inclusion near the top of the workflow (after line 45):
```
!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md
```

#### 3. ralph-review — Change `type: critique` to `type: review`, add `tags:`
**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`

**Critique frontmatter template** (lines 209-216): Change type and add tags:
```yaml
---
date: YYYY-MM-DD
github_issue: NNN
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
plan_document: [plan path]
status: approved OR needs-iteration
type: review
tags: [plan-review, relevant, component, tags]
---
```

### Success Criteria

#### Automated Verification:
- [ ] `grep -c 'tags:' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns at least 1
- [ ] `grep -c 'type: plan' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns at least 1
- [ ] `grep -c 'github_issue:' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns at least 2 (template + comment about it)
- [ ] `grep -c 'type: review' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns at least 1
- [ ] `grep -c 'Prior Work' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns at least 1
- [ ] `grep -c 'Prior Work' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns at least 1
- [ ] `grep -c 'knowledge-metadata' plugin/ralph-hero/skills/ralph-research/SKILL.md` returns 1
- [ ] `grep -c 'knowledge-metadata' plugin/ralph-hero/skills/ralph-plan/SKILL.md` returns 1

#### Manual Verification:
- [ ] Templates are clear and the new fields don't bloat the prompt excessively

---

## Phase 3: Update Interactive Skills

### Overview
Update the 5 interactive skills that produce or modify documents.

### Changes Required

#### 1. research (interactive) — Add `## Prior Work`
**File**: `plugin/ralph-hero/skills/research/SKILL.md`

This skill already has `tags:` and `type: research` (lines 125-133). Only needs `## Prior Work` section added to the document template (after line 135, between the title and `## Research Question`):

```markdown
# Research: [Research Question/Topic]

## Prior Work

- builds_on:: [[related-research-doc-id]]

## Research Question
```

Add a note in Step 4 (synthesis, around line 96-104) to populate `## Prior Work` from thoughts-locator findings.

#### 2. plan (interactive) — Add `tags:`, `type: plan`, `github_issue:`, `## Prior Work`
**File**: `plugin/ralph-hero/skills/plan/SKILL.md` (this is the skill you're reading right now)

**Frontmatter template** (lines 196-202): Add `type:`, `tags:`, `github_issue:`:
```yaml
---
date: YYYY-MM-DD
status: draft
type: plan
tags: [relevant, component, tags]
github_issue: NNN
github_issues: [NNN]
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN
---
```

**Document body template** (Step 4 template, around line 204): Add `## Prior Work` after the title.

#### 3. draft — Add `type: idea`
**File**: `plugin/ralph-hero/skills/draft/SKILL.md`

**Frontmatter template** (lines 71-77): Add `type: idea`:
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

#### 4. form — Set `type:` during transitions
**File**: `plugin/ralph-hero/skills/form/SKILL.md`

**Step 5a** (lines 174-178): When updating frontmatter after issue creation, preserve/add `type`:
```yaml
github_issue: NNN
status: formed
type: idea
```

**Step 5d** (line 272): When refining, ensure `type: idea` is set if missing.

#### 5. iterate — Preserve knowledge fields
**File**: `plugin/ralph-hero/skills/iterate/SKILL.md`

**Step 4** (line 184-196, "Make focused, precise edits"): Add guidance to preserve knowledge metadata:

Add after line 196 ("Maintain the distinction between automated vs manual success criteria"):
```
   - Preserve `tags:`, `type:`, and `## Prior Work` sections — do not remove or overwrite these during edits
   - If adding significant new content, consider whether new `builds_on::` relationships should be added to `## Prior Work`
```

### Success Criteria

#### Automated Verification:
- [ ] `grep -c 'Prior Work' plugin/ralph-hero/skills/research/SKILL.md` returns at least 1
- [ ] `grep -c 'type: plan' plugin/ralph-hero/skills/plan/SKILL.md` returns at least 1
- [ ] `grep -c 'type: idea' plugin/ralph-hero/skills/draft/SKILL.md` returns at least 1
- [ ] `grep -c 'type: idea' plugin/ralph-hero/skills/form/SKILL.md` returns at least 1
- [ ] `grep -c 'Prior Work' plugin/ralph-hero/skills/iterate/SKILL.md` returns at least 1

#### Manual Verification:
- [ ] Interactive plan skill template includes all four new fields naturally
- [ ] Iterate skill guidance is clear about preservation without being heavy-handed

---

## Phase 4: Update Hooks & Specs

### Overview
Update the enforcement hook and specification documents to reflect the `type: review` change and new required fields.

### Changes Required

#### 1. Update review-verify-doc.sh
**File**: `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh`

**Line 33**: Change from `type: critique` to `type: review`:
```bash
# Before:
if ! head -20 "$file_path" | grep -q "^type: critique"; then
  block "Critique missing 'type: critique' in frontmatter: $file_path"

# After:
if ! head -20 "$file_path" | grep -q "^type: review"; then
  block "Review document missing 'type: review' in frontmatter: $file_path"
```

#### 2. Update artifact-metadata.md spec
**File**: `specs/artifact-metadata.md`

**Line 74**: Change requirement text:
```
| Critique docs MUST include `type: review` field | [x] `review-verify-doc.sh` |
```

**Add to Research and Plan frontmatter sections**: New rows for `tags:` (recommended, not enforced):
```
| Research docs SHOULD include `tags` field (array of strings) | [ ] not enforced (skill-prompt guidance) |
| Plan docs SHOULD include `type: plan` field | [ ] not enforced (skill-prompt guidance) |
| Plan docs SHOULD include `tags` field (array of strings) | [ ] not enforced (skill-prompt guidance) |
| Plan docs SHOULD include `github_issue` field (integer, same as primary_issue) | [ ] not enforced |
```

#### 3. Update document-protocols.md spec
**File**: `specs/document-protocols.md`

**Line 95**: Change `type: critique` to `type: review`
**Line 107**: Change requirement text to match

### Success Criteria

#### Automated Verification:
- [ ] `grep 'type: review' plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` matches
- [ ] `grep -c 'type: critique' plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` returns 0
- [ ] `grep 'type: review' specs/artifact-metadata.md` matches
- [ ] `grep 'type: review' specs/document-protocols.md` matches

#### Manual Verification:
- [ ] Specs are internally consistent and cross-references are correct

---

## Phase 5: Update Indexer

### Overview
Update the ralph-knowledge MCP server to handle plan documents' `github_issues` array and fix the type vocabulary in the tool description.

### Changes Required

The indexer source lives in the `ralph-hero-knowledge-index` npm package. Changes are to the package source (not in this repo).

#### 1. Update parser to read `github_issues` array as fallback
**File**: `parser.ts` (in ralph-hero-knowledge-index package)

After the `github_issue` extraction (line 35 of compiled `parser.js`):
```typescript
// Current:
githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,

// Updated:
githubIssue: typeof frontmatter.github_issue === "number"
  ? frontmatter.github_issue
  : Array.isArray(frontmatter.github_issues) && typeof frontmatter.github_issues[0] === "number"
    ? frontmatter.github_issues[0]
    : typeof frontmatter.primary_issue === "number"
      ? frontmatter.primary_issue
      : null,
```

Fallback chain: `github_issue` → `github_issues[0]` → `primary_issue` → `null`

#### 2. Update tool description type vocabulary
**File**: `index.ts` (in ralph-hero-knowledge-index package)

Change the `type` parameter description:
```typescript
// Current:
type: z.string().optional().describe("Filter by document type (research, plan, review, idea, report)"),

// Updated:
type: z.string().optional().describe("Filter by document type (research, plan, review, idea, report)"),
```

No change needed — `review` is already the advertised value, and after the backfill in Phase 6, all documents will use `type: review`.

### Success Criteria

#### Automated Verification:
- [ ] `npm test` passes in ralph-hero-knowledge-index
- [ ] Parser test: document with only `github_issues: [42]` yields `githubIssue: 42`
- [ ] Parser test: document with only `primary_issue: 42` yields `githubIssue: 42`
- [ ] Parser test: document with `github_issue: 42` still yields `githubIssue: 42` (no regression)

#### Manual Verification:
- [ ] After publishing and reindexing, `knowledge_search(type="plan")` returns plan documents
- [ ] After reindexing, `knowledge_search(type="review")` returns review/critique documents

---

## Phase 6: Backfill Existing Documents

### Overview
Fix `type: critique` → `type: review` in all existing review documents, and add `type:` to documents that lack it (inferred from directory).

### Changes Required

#### 1. Backfill script
**File**: Run as one-time bash commands (not a permanent script)

**Step A — Fix critique → review** in all existing review documents:
```bash
# Preview what will change
grep -rl "^type: critique" thoughts/shared/reviews/ | wc -l

# Apply change
find thoughts/shared/reviews/ -name '*.md' -exec \
  sed -i 's/^type: critique$/type: review/' {} +
```

**Step B — Add `type: plan` to plan documents missing it**:
```bash
# Find plans without type: field in frontmatter
for f in thoughts/shared/plans/*.md; do
  if head -20 "$f" | grep -q "^---" && ! head -20 "$f" | grep -q "^type:"; then
    # Insert 'type: plan' after 'status:' line
    sed -i '/^status:/a type: plan' "$f"
  fi
done
```

**Step C — Add `type: idea` to idea documents missing it**:
```bash
for f in thoughts/shared/ideas/*.md; do
  if head -20 "$f" | grep -q "^---" && ! head -20 "$f" | grep -q "^type:"; then
    sed -i '/^status:/a type: idea' "$f"
  fi
done
```

**Step D — Reindex**:
```bash
cd /tmp && node node_modules/ralph-hero-knowledge-index/dist/reindex.js \
  ~/projects/ralph-hero/thoughts ~/.ralph-hero/knowledge.db
```

#### 2. Commit the backfill
```bash
git add thoughts/shared/reviews/ thoughts/shared/plans/ thoughts/shared/ideas/
git commit -m "chore: backfill type metadata for knowledge graph alignment

- type: critique → type: review in 50+ review documents
- Add type: plan to plan documents missing it
- Add type: idea to idea documents missing it"
```

### Success Criteria

#### Automated Verification:
- [ ] `grep -rc "type: critique" thoughts/shared/reviews/` returns 0
- [ ] `grep -rc "type: review" thoughts/shared/reviews/` returns count > 0
- [ ] `grep -rL "^type:" thoughts/shared/plans/*.md` returns no results (all plans have type)
- [ ] `grep -rL "^type:" thoughts/shared/ideas/*.md` returns no results (all ideas have type)
- [ ] Reindex completes without errors

#### Manual Verification:
- [ ] `knowledge_search(type="review")` returns review documents
- [ ] `knowledge_search(type="plan")` returns plan documents
- [ ] `knowledge_search(type="idea")` returns idea documents

---

## Testing Strategy

### After Each Phase
Run the indexer and verify affected document types are searchable:
```bash
cd /tmp && node node_modules/ralph-hero-knowledge-index/dist/reindex.js \
  ~/projects/ralph-hero/thoughts ~/.ralph-hero/knowledge.db
```

### End-to-End Verification
After all phases:
1. Create a test research document with all new fields → verify it appears in `knowledge_search`
2. Create a test plan document with all new fields → verify `knowledge_search(type="plan")` finds it
3. Add `builds_on::` wikilink → verify `knowledge_traverse` follows the edge
4. Run `ralph-review` in AUTO mode → verify the critique has `type: review`

## References

- Knowledge graph design: `docs/plans/2026-03-08-knowledge-graph-design.md`
- Knowledge graph implementation: `docs/plans/2026-03-08-knowledge-graph-impl.md`
- Artifact metadata spec: `specs/artifact-metadata.md`
- Document protocols spec: `specs/document-protocols.md`
- Indexer source (npm): `ralph-hero-knowledge-index` package, `parser.ts`
- Review verify hook: `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh`
