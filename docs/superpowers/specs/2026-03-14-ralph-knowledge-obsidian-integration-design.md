# Ralph-Knowledge Obsidian Integration

**Date:** 2026-03-14
**Status:** Draft
**Issue:** TBD

## Problem

Ralph-hero produces a growing body of knowledge documents (research, plans, ideas, reviews) in `thoughts/`. These are browsable in VS Code or GitHub, but both present a flat, unstructured experience — a jumble of files with no navigational aids. Obsidian is a natural fit for browsing this content since ralph-knowledge already uses Obsidian-compatible wikilinks, but there's no formal integration guiding users toward it or making the experience feel intentional.

## Goals

1. Make Obsidian the recommended primary UI for browsing ralph-knowledge documents
2. Have ralph-knowledge generate navigational content that works natively in Obsidian (index notes, issue hubs, query references)
3. Build for personal use first, then make it repeatable for other ralph-hero adopters

## Non-Goals

- Obsidian as a document authoring tool (skills handle creation)
- Custom Obsidian plugin development
- Two-way sync between Obsidian edits and ralph-knowledge index
- Obsidian templates for new documents (skills already handle frontmatter)

## User Priorities (ranked)

1. Quick navigation — clicking wikilinks to jump between related docs
2. Tags/filtering — browsing by type, status, issue number
3. Dataview queries — tables and cross-cutting views
4. Backlinks panel — "what documents reference this one?"
5. Graph view — visual network of relationships
6. Templates — not important (skills handle this)

## Design

### 1. Generated Index Notes

The `reindex` script gains a generation phase. After populating SQLite, it writes markdown index files into `thoughts/`.

**Generated files:**

| File | Purpose |
|------|---------|
| `_index.md` | Master MOC linking to type indexes and recent docs |
| `_research.md` | All research docs, sorted by date, with status and issue links |
| `_plans.md` | All plans with approval status |
| `_ideas.md` | All ideas with formation status |
| `_reviews.md` | All review documents |
| `_reports.md` | All report documents |
| `_issues/GH-NNNN.md` | Per-issue hub aggregating all related docs |
| `_queries.md` | Pre-built Dataview query snippets |

**Conventions:**
- All generated files start with `_` to distinguish from authored content
- The `_issues/` directory is entirely generated
- All generated files include `generated: true` in YAML frontmatter
- Generated files are `.gitignore`'d (derived artifacts, regenerated on each reindex)
- The reindexer skips files and directories starting with `_` to prevent indexing generated content (feedback loop prevention)

**Example: `_research.md`**

```markdown
---
generated: true
updated: 2026-03-14
---
# Research Documents

## Active
- [[2026-03-14-GH-0564-research-to-issue-workflow-gap]] — #564 · research-to-issue workflow gap
- [[2026-03-08-GH-0560-cache-ttl]] — #560 · cache TTL investigation

## Superseded
- ~~[[2026-02-25-GH-0390-aggressive-caching-plan]]~~ → [[2026-03-08-GH-0560-cache-ttl]]
```

**Example: `_issues/GH-0564.md`**

```markdown
---
generated: true
github_issue: 564
updated: 2026-03-14
---
# GH-564: Add research-to-issue workflow

## Research
- [[2026-03-14-GH-0564-research-to-issue-workflow-gap]]

## Plans
- [[2026-03-14-GH-0564-research-to-issue-workflow]]

## Relationships
- builds_on:: [[2026-02-28-GH-0460-form-skill-reference]]
```

### 2. Standardized Frontmatter Contract

All authored documents in `thoughts/` use consistent frontmatter for Dataview compatibility.

**Required fields:**

```yaml
---
date: 2026-03-14          # creation date
type: research             # research | plan | idea | review | report
status: draft              # draft | approved | superseded | archived
---
```

**Optional fields:**

```yaml
tags: [caching, mcp-server]  # forward-looking; only ~6% of existing docs have tags
github_issue: 564             # linked issue number (also accepts github_issues, primary_issue)
superseded_by: "[[doc-id]]"
```

**Changes:**
- `reindex` validates frontmatter and logs warnings on missing `date`, `type`, or `status` fields (not hard errors)
- `tags` is optional — tag-based queries will grow in usefulness as new documents are created with tags by skills. No backfill migration needed.
- The parser accepts `github_issue`, `github_issues` (plural), and `primary_issue` fields for issue number extraction (existing parser behavior)
- Skills that create documents already emit correct frontmatter

### 3. Dataview Queries & Obsidian Config

**Pre-built queries (`_queries.md`):**

Ships with 5-8 Dataview snippets covering:
- All research by date
- Open issues with research but no plan
- Documents by tag
- Recently modified documents
- Documents by status (draft, approved, superseded)
- Cross-cutting: issue → all related docs

**Obsidian config fragment (`.obsidian/`):**

Minimal config for a good out-of-box experience:
- `app.json` — wikilink style set to shortest path (so `[[doc-id]]` resolves without full paths). Date-prefixed filenames make collisions extremely unlikely.
- `graph.json` — group coloring by doc type: research=blue, plans=green, ideas=yellow, generated=gray

**Dataview plugin:** The config fragment does NOT install Dataview — Obsidian community plugins must be installed manually from the Community Plugin browser. The setup skill prints explicit instructions: "Open Settings > Community Plugins > Browse > search 'Dataview' > Install > Enable." The `_queries.md` file works without Dataview (it's just markdown with code blocks), but the queries won't execute until Dataview is installed.

### 4. Reindex Integration

**Extended flow:**

```
scan thoughts/ → parse docs → insert SQLite → build FTS5 → generate embeddings → generate index notes
```

**New module: `generate-indexes.ts`**
- Takes parsed document list (already in memory from indexing)
- Groups by type, status, issue number
- Writes all generated files
- Fully idempotent — overwrites generated files each run

**CLI flag:** `--no-generate` to skip index note generation (for users who only want the SQLite index). Default is generate.

**Reindexer change:** `findMarkdownFiles()` in `reindex.ts` must skip files and directories starting with `_`. This prevents the reindexer from indexing its own generated output on subsequent runs.

**Issue hub filenames:** Zero-padded to 4 digits (`GH-0042.md`, `GH-0564.md`). For issue numbers with 5+ digits, use the full number (`GH-12345.md`).

**Gitignore additions (`thoughts/.gitignore`):**

```
_*.md
_issues/
```

### 5. Setup Skill & Onboarding

**New skill: `/ralph-knowledge:setup-obsidian`**

Separate from existing `/ralph-knowledge:setup` (SQLite indexing):

1. Locate `thoughts/` directory
2. Check for existing `.obsidian/` directory
   - **If absent**: create `.obsidian/` with full config fragment
   - **If present**: patch `app.json` keys only if they don't already exist (preserve user customizations). Append to `graph.json` groups only if no existing groups conflict. Never overwrite existing config values.
3. Add generated files to `thoughts/.gitignore` (append if `.gitignore` exists, create if not)
4. Run `reindex` (now includes index note generation)
5. Print setup instructions:
   - "Open `thoughts/` as a vault in Obsidian"
   - "Install Dataview: Settings > Community Plugins > Browse > search 'Dataview' > Install > Enable"
   - "Start with `_index.md` for navigation"

**Existing `/ralph-knowledge:setup` updated:**
- After successful index, suggest: "Want to browse this in Obsidian? Run `/ralph-knowledge:setup-obsidian`"

## Architecture

```
reindex.ts
  ├── scan & parse (existing)
  ├── SQLite + FTS5 + embeddings (existing)
  └── generate-indexes.ts (NEW)
       ├── writeTypeIndexes(_research.md, _plans.md, _ideas.md, _reviews.md, _reports.md)
       ├── writeMasterIndex(_index.md)
       ├── writeIssueHubs(_issues/GH-NNNN.md)
       └── writeQueryReference(_queries.md)

setup-obsidian skill (NEW)
  ├── locate thoughts/
  ├── install .obsidian/ config
  ├── update .gitignore
  └── run reindex

setup skill (MODIFIED)
  └── suggest setup-obsidian after success
```

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Generated files prefixed with `_` | Clear visual/programmatic distinction from authored content |
| Generated files gitignored | Derived artifacts — regenerated from source docs on each reindex |
| Dataview as only required plugin | Widely adopted, covers filtering/querying needs without custom plugins |
| Separate setup-obsidian skill | Keeps Obsidian optional — SQLite index works without it |
| No custom Obsidian plugin | Reduces maintenance burden; Dataview + config is sufficient |
| `--no-generate` flag | Escape hatch for users who only want the indexing backend |
| Reindexer skips `_`-prefixed files | Prevents feedback loop where generated content gets indexed |
| `tags` is optional | Only ~6% of existing docs have tags; tag queries grow useful over time |
| Multi-directory indexing deferred | Current design assumes single `thoughts/` directory; multi-dir support (see `thoughts/shared/plans/2026-03-10-multi-dir-knowledge-index.md`) would need a location strategy for generated files |

## Testing

- Unit tests for `generate-indexes.ts`:
  - Given 3 research docs and 1 plan for issue 560, `_issues/GH-0560.md` contains exactly 3 research wikilinks and 1 plan wikilink under correct headings
  - Given 0 documents, generates empty index files with headers but no entries
  - Given docs with missing frontmatter fields, generates indexes using available data (no crashes)
  - Superseded docs appear in the "Superseded" section with strikethrough and arrow to replacement
- Integration test: reindex a test `thoughts/` directory, verify generated files exist with correct content and `_`-prefixed files are not in the SQLite index
- Verify wikilinks resolve correctly (shortest-path format matches Obsidian's default; date-prefixed filenames prevent collisions)
- Verify Dataview queries parse and return expected results (manual verification in Obsidian)
