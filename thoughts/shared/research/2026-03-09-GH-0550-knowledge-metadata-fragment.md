---
date: 2026-03-09
github_issue: 550
github_url: https://github.com/cdubiel08/ralph-hero/issues/550
status: complete
type: research
tags: [knowledge-graph, metadata, shared-fragments, skill-templates, frontmatter]
---

# GH-550: Create Shared Knowledge-Metadata Fragment for Skill Templates

## Prior Work

- builds_on:: [[2026-03-08-knowledge-graph-design]]
- builds_on:: [[2026-03-08-knowledge-graph-impl]]
- builds_on:: [[2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor]]
- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]

## Problem Statement

The ralph-knowledge indexer expects specific frontmatter fields (`type`, `tags`, `github_issue`) and body sections (`## Prior Work` with `builds_on::` / `tensions::` wikilinks) to make documents discoverable via `knowledge_search` and `knowledge_traverse`. Multiple skills produce documents but lack guidance on these fields. A shared fragment would centralize this guidance, following the existing fragment pattern (`error-handling.md`, `escalation-steps.md`, etc.), so all document-producing skills can include it via `!cat` injection.

## Current State Analysis

### Existing Fragment Pattern

Four shared fragments exist at `plugin/ralph-hero/skills/shared/fragments/`:

| Fragment | Lines | Purpose |
|----------|-------|---------|
| `error-handling.md` | 6 | Tool call failure recovery |
| `escalation-steps.md` | 27 | Escalation protocol via GitHub comments |
| `artifact-discovery.md` | 48 | Artifact comment protocol and discovery |
| `team-reporting.md` | 24 | TaskUpdate-based result reporting |

**Common characteristics:**
- Start with an `##` heading (h2)
- No YAML frontmatter
- Concise, standalone prose (6-48 lines)
- Use tables, bullet lists, and code blocks
- Direct imperative tone
- Each covers a single cross-cutting concern
- Included via `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/<name>.md`

**Inclusion pattern in skills** (8 existing usages across 7 skills):
```
!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md
!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/error-handling.md
```

### Knowledge Indexer Expectations

The parser at `plugin/ralph-knowledge/src/parser.ts` reads:

| Field | Source | Type | Required by Indexer |
|-------|--------|------|-------------------|
| `date` | Frontmatter | string | Yes |
| `type` | Frontmatter | string | Yes (for `knowledge_search(type=...)` filtering) |
| `status` | Frontmatter | string | Yes |
| `github_issue` | Frontmatter | number (singular) | Yes (for issue linking) |
| `tags` | Frontmatter | string[] | Yes (for tag filtering) |
| `superseded_by` | Frontmatter | string (wikilink) | Optional (human-set) |
| `builds_on` | Body `## Prior Work` | wikilink | Optional (relationship edges) |
| `tensions` | Body `## Prior Work` | wikilink | Optional (relationship edges) |

**Key parser detail** (`parser.ts:60`): `github_issue` reads only from `frontmatter.github_issue` as a number. It does NOT fall back to `github_issues[0]` or `primary_issue`. Plan documents use `github_issues` (array) and `primary_issue`, so they are currently invisible to issue-based lookups in the knowledge index.

**Valid type values** per the `knowledge_search` tool description: `research`, `plan`, `review`, `idea`, `report`.

### Current Skill Metadata Coverage

| Skill | Produces | Has `type:` | Has `tags:` | Has `github_issue:` | Has `## Prior Work` |
|-------|----------|-------------|-------------|---------------------|-------------------|
| `ralph-research` | Research docs | `research` | Yes | Yes | Yes |
| `ralph-plan` | Plan docs | Missing | Yes | Missing (has `github_issues` array) | Yes |
| `ralph-review` | Critique docs | `critique` (wrong) | Missing | Yes | N/A |
| `research` (interactive) | Research docs | `research` | Yes | Yes | Missing |
| `plan` (interactive) | Plan docs | Missing | Missing | Missing | Missing |
| `draft` | Idea docs | Missing | Yes | `null` | N/A |
| `form` | Updates ideas | Missing (doesn't set) | Existing | Existing | N/A |
| `iterate` | Modifies docs | N/A (edits) | N/A | N/A | No preservation guidance |

**Observations:**
1. `ralph-research` is the most complete, already having all four knowledge fields after the knowledge-graph-impl work
2. `ralph-plan` is close but missing `type: plan` and the singular `github_issue:` field
3. `ralph-review` uses `type: critique` but the indexer advertises `type: review`
4. The interactive `plan` skill is the most deficient — missing all knowledge fields
5. `draft` is close but needs explicit `type: idea`
6. `iterate` has no guidance about preserving knowledge metadata during edits

### Existing Type Values in Wild

A scan of existing documents reveals non-standard `type` values in older documents:

| Value | Count (approx) | Standard? |
|-------|----------------|-----------|
| `research` | Many | Yes |
| `critique` | 50+ | No (should be `review`) |
| `plan` | ~10 | Yes |
| `feature` | ~5 | No |
| `epic` | ~2 | No |
| `spec` | ~2 | No |
| `design` | ~1 | No |
| `architecture-spec` | ~1 | No |
| `parent-plan` | ~1 | No |

The backfill in Phase 6 of the parent plan addresses `critique` -> `review` and adds missing `type:` to plans and ideas. The non-standard values (`feature`, `epic`, `spec`, etc.) are from early documents before the type vocabulary was standardized; they are not harmful (the indexer stores them as-is) but won't match the documented filter values.

## Key Discoveries

1. **Fragment size target**: Existing fragments range from 6-48 lines. The knowledge-metadata fragment should aim for the middle of this range (~25-35 lines) to provide adequate guidance without bloating skill prompts.

2. **Fragment structure convention**: All fragments start with `## Heading`, use tables for reference data, code blocks for templates, and bullet lists for instructions. No frontmatter.

3. **Parser regex for Prior Work** (`parser.ts:24`): `^- (builds_on|tensions):: \[\[(.+?)\]\]` — this requires exact format: leading `- `, property name, `:: `, and `[[wikilink]]`. The fragment must document this exact syntax.

4. **`github_issue` vs `github_issues` gap**: The parser reads only `github_issue` (singular integer). Plan documents use `github_issues` (array) and `primary_issue`. The fragment should instruct plan authors to include `github_issue:` derived from `primary_issue`.

5. **The `!cat` injection point matters**: Fragment inclusion should be near the top of the workflow section (before document creation steps) so the LLM has the guidance loaded when it writes frontmatter.

6. **Review hook enforces `type: critique`** (`review-verify-doc.sh:33`): The PostToolUse hook currently blocks if the critique doesn't have `type: critique`. This must be updated to `type: review` in Phase 4 (GH-553) BEFORE the skill template change in Phase 2, or new reviews will be blocked.

## Potential Approaches

### Approach A: Single Comprehensive Fragment (Recommended)

Create one `knowledge-metadata.md` fragment that covers all fields: `type`, `tags`, `github_issue`, and `## Prior Work`. Each skill includes it via `!cat`. The fragment provides:
- A short "why" section explaining discoverability
- A reference table of fields
- Copy-pasteable YAML templates per document kind
- The `## Prior Work` syntax with examples

**Pros:**
- Single source of truth for all knowledge metadata guidance
- Consistent with existing fragment pattern (one file per concern)
- Easy to update when indexer expectations change
- Skills only need to add one `!cat` line

**Cons:**
- Fragment may be ~30-40 lines, slightly larger than most existing fragments
- Some skills don't produce `## Prior Work` sections (draft, form) — fragment content is partially irrelevant to them

### Approach B: Two Fragments (Frontmatter + Prior Work)

Split into `knowledge-frontmatter.md` (type, tags, github_issue) and `knowledge-prior-work.md` (## Prior Work section). Skills include one or both based on their document type.

**Pros:**
- More granular — skills that don't need Prior Work skip that fragment
- Each fragment stays very short

**Cons:**
- Doubles the `!cat` lines needed in most skills
- More files to maintain
- Fragments are so small they'd be ~10 lines each — barely worth the indirection

### Recommendation

**Approach A** is preferred. The slight irrelevance of `## Prior Work` guidance for idea/form skills is a minor cost compared to the complexity of managing two fragments. The fragment can note which sections apply to which document types.

## Risks

1. **Hook ordering dependency**: Phase 4 (update `review-verify-doc.sh` from `type: critique` to `type: review`) must be coordinated with Phase 2 (update `ralph-review` template). If the template changes first, new reviews will fail the hook. **Mitigation**: The parent plan already sequences Phase 4 after Phase 2 in a separate issue (GH-553), and the hook change itself is in GH-553's scope.

2. **Fragment prompt budget**: Adding ~30 lines to every document-producing skill increases context consumption. With 8 affected skills, this is ~240 additional tokens total across all skills. **Mitigation**: This is negligible relative to typical SKILL.md sizes (150-400 lines each).

3. **Non-standard type values in older documents**: Existing documents have types like `feature`, `epic`, `spec` that won't match `knowledge_search(type="plan")`. **Mitigation**: The Phase 6 backfill addresses this. The fragment should document only the canonical 5 types.

## Recommended Next Steps

1. Create the fragment at `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md` following the structure outlined in the parent plan's Phase 1
2. The fragment should be ~30-35 lines, starting with `## Knowledge Graph Metadata`
3. Include: field reference table, YAML templates per document kind, Prior Work syntax, tag guidance
4. This is a pure file creation — no existing files are modified in this issue
5. Subsequent issues (GH-551 through GH-555) handle skill template updates, hook changes, indexer updates, and backfill

## Files Affected

### Will Modify
- None (this issue creates a new file only)

### Will Create
- `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md` - New shared fragment with knowledge graph metadata guidance

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/fragments/error-handling.md` - Reference for fragment structure/conventions
- `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md` - Reference for fragment structure/conventions
- `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md` - Reference for fragment structure/conventions
- `plugin/ralph-hero/skills/shared/fragments/team-reporting.md` - Reference for fragment structure/conventions
- `plugin/ralph-knowledge/src/parser.ts` - Source of truth for indexer field expectations
- `plugin/ralph-knowledge/src/index.ts` - Tool descriptions with valid type values
- `docs/plans/2026-03-08-knowledge-graph-design.md` - Architecture and relationship type definitions
