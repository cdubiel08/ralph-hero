---
name: bridge-artifact
description: Use when migrating a superpowers artifact (spec or plan from docs/superpowers/) to ralph-hero format with frontmatter and optional GitHub issue linking
user-invocable: true
argument-hint: <path-to-superpowers-artifact> [#issue-number]
context: fork
model: sonnet
allowed-tools: [Read, Write, Glob, Grep, ralph_hero__get_issue, ralph_hero__create_comment]
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Bridge Superpowers Artifact to Ralph-Hero

Migrate a superpowers artifact to ralph-hero format with proper frontmatter, naming conventions, and optional GitHub issue linking.

## Usage

```
/ralph-hero:bridge-artifact docs/superpowers/plans/2026-03-12-feature.md
/ralph-hero:bridge-artifact docs/superpowers/specs/2026-03-11-design.md #42
```

## Process

### Step 1: Read the Source Artifact

Read the file specified in ARGUMENTS fully. Determine artifact type from path:
- `docs/superpowers/specs/*` → type: `research`, destination: `thoughts/shared/research/`
- `docs/superpowers/plans/*` → type: `plan`, destination: `thoughts/shared/plans/`

If the path doesn't match either pattern, inform the user and exit.

### Step 2: Extract Metadata

From the superpowers artifact:
1. **Date**: Extract from filename (`YYYY-MM-DD-` prefix) or use today's date
2. **Description**: Extract from filename (after date, before `-design.md` or `.md`)
3. **Title**: Extract from first `# ` heading in the document
4. **Tags**: Infer 2-5 tags from the content (lowercase, hyphenated)

If `#NNN` was provided in ARGUMENTS:
1. Fetch the issue: `ralph_hero__get_issue(number=NNN)`
2. Use issue context to refine tags

### Step 3: Build Ralph-Hero Artifact

Construct the new file with:

**Filename pattern:**
- With issue: `YYYY-MM-DD-GH-NNNN-description.md` (zero-padded to 4 digits)
- Without issue: `YYYY-MM-DD-description.md`

**Content:**
1. Add ralph-hero YAML frontmatter at the top
2. Keep the original superpowers content below the frontmatter
3. Add a `## Prior Work` section with a reference to the original superpowers artifact

For plans:
```yaml
---
date: YYYY-MM-DD
status: draft
type: plan
tags: [inferred, tags]
github_issue: NNN              # if issue provided
github_issues: [NNN]           # if issue provided
github_urls:
  - https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
primary_issue: NNN             # if issue provided
---
```

For research/specs:
```yaml
---
date: YYYY-MM-DD
status: complete
type: research
tags: [inferred, tags]
github_issue: NNN              # if issue provided
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
---
```

### Step 4: Write the File

Save to the appropriate `thoughts/shared/` subdirectory using the Write tool.

### Step 5: GitHub Integration (if issue provided)

If `#NNN` was provided:
1. Post artifact link comment via Artifact Comment Protocol:
   ```
   ralph_hero__create_comment(number=NNN, body="## Implementation Plan\n\nhttps://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md\n\nBridged from superpowers artifact: docs/superpowers/plans/original-filename.md")
   ```
   Use `## Research Document` header for specs/research type.

2. Offer to update issue workflow state if appropriate.

### Step 6: Report

```
Bridged superpowers artifact:
  Source: docs/superpowers/plans/2026-03-12-feature.md
  Target: thoughts/shared/plans/2026-03-12-GH-0042-feature.md
  Type: plan
  Issue: #42 (linked via Artifact Comment Protocol)

The original superpowers artifact has been preserved.
```
