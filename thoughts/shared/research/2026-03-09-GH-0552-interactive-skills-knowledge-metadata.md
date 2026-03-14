---
date: 2026-03-09
github_issue: 552
github_url: https://github.com/cdubiel08/ralph-hero/issues/552
status: complete
type: research
tags: [interactive-skills, knowledge-graph, metadata, frontmatter, skill-templates]
---

# Research: Update Interactive Skills with Knowledge Metadata (GH-552)

## Prior Work

- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]
- builds_on:: [[2026-03-01-GH-0471-shared-fragments-and-skill-prompt-refactor]]
- builds_on:: [[2026-02-22-GH-0345-research-codebase-interactive-skill]]
- builds_on:: [[2026-02-22-GH-0346-create-plan-interactive-skill]]
- builds_on:: [[2026-02-22-GH-0343-draft-idea-interactive-skill]]
- builds_on:: [[2026-02-22-GH-0344-form-idea-interactive-skill]]
- builds_on:: [[2026-02-22-GH-0347-iterate-plan-interactive-skill]]

## Problem Statement

The five interactive skills (`research`, `plan`, `draft`, `form`, `iterate`) produce documents in `thoughts/` that are indexed by the ralph-knowledge plugin for search and traversal. Currently these skills produce documents with incomplete or missing metadata fields, making documents unfindable or untraversable via `knowledge_search` and `knowledge_traverse`.

Specific gaps:
- `plan` skill produces documents with no `type:`, no `tags:`, no `github_issue:` (singular), and no `## Prior Work` section
- `draft` skill produces documents with no `type: idea` field
- `form` skill does not inject `type: idea` when updating idea document frontmatter after issue creation
- `iterate` skill has no guidance to preserve `tags:`, `type:`, and `## Prior Work` sections during edits
- `research` skill already has `type: research` and `tags:` but is missing `## Prior Work` section in the document template and lacks explicit guidance to populate it from thoughts-locator findings

## Current State Analysis

### 1. `research` interactive skill — `plugin/ralph-hero/skills/research/SKILL.md`

**What it has**: The frontmatter template at lines 124-133 already includes:
```yaml
tags: [research, codebase, relevant-component-names]
status: complete
type: research
```

**What it is missing**:
- No `## Prior Work` section in the document template (line 135 jumps directly from the title to `## Research Question`)
- Step 4 synthesis guidance (lines 96-104) mentions thoughts-locator findings but says nothing about populating a `## Prior Work` section with `builds_on::` / `tensions::` wikilinks
- The thoughts-locator sub-agent is spawned (line 73) but its output flows to `## Historical Context (from thoughts/)` section, not to a structured `## Prior Work` section with wikilinks

**Document template gap** (lines 134-168): Document structure goes:
```
# Research: [Topic]
## Research Question
## Summary
## Detailed Findings
...
```
Missing: `## Prior Work` block immediately after the title.

### 2. `plan` interactive skill — `plugin/ralph-hero/skills/plan/SKILL.md`

**What it has**: Frontmatter template at lines 195-202:
```yaml
---
date: YYYY-MM-DD
status: draft
github_issues: [NNN]
github_urls:
  - https://github.com/.../issues/NNN
primary_issue: NNN
---
```

**What it is missing**:
- No `type: plan` field — plan documents are invisible to `knowledge_search(type="plan")`
- No `tags:` field — plans are unfilterable by topic tag
- No `github_issue:` (singular integer) — the knowledge indexer reads only `github_issue`, not `github_issues` (array); the indexer fallback in GH-554 will add array support but the singular field is cleaner for new documents
- No `## Prior Work` section in the document body template (lines 203-293); the template jumps from `# [Feature/Task Name] Implementation Plan` directly to `## Overview`

**Form/iterate interaction**: The plan skill's GitHub integration step (Step 6, lines 318-370) updates frontmatter with `github_issues`, `github_urls`, and `primary_issue` but never adds `github_issue:` (singular) or `type: plan`.

### 3. `draft` interactive skill — `plugin/ralph-hero/skills/draft/SKILL.md`

**What it has**: Frontmatter template at lines 71-77:
```yaml
---
date: YYYY-MM-DD
status: draft
author: user
tags: [relevant, tags]
github_issue: null
---
```

**What it is missing**:
- No `type: idea` field — drafted ideas are invisible to `knowledge_search(type="idea")`

This is a minimal change: a single line `type: idea` must be added to the template. The `draft` skill is intentionally lightweight (speed over polish), so no `## Prior Work` section is needed here; ideas are pre-research documents.

### 4. `form` interactive skill — `plugin/ralph-hero/skills/form/SKILL.md`

**What it has**: Step 5a (lines 173-178) updates the idea file frontmatter after issue creation:
```yaml
github_issue: NNN
status: formed
```

Step 5b (lines 232-234) also updates frontmatter:
```yaml
github_issue: NNN
status: formed
```

Step 5d (lines 264-281) refines the draft without setting `type:`.

**What it is missing**:
- Neither Step 5a, 5b, nor 5d ensures `type: idea` is set when updating frontmatter. An idea file created by the `draft` skill will have `type: idea` after GH-552 lands, but ideas created before the fix (or inline ideas without a file) will remain typeless. The `form` skill must set or preserve `type: idea` during all frontmatter mutations.
- No mention anywhere of `type:` in the skill — not in templates, not in guidance

### 5. `iterate` interactive skill — `plugin/ralph-hero/skills/iterate/SKILL.md`

**What it has**: Step 4 "Make focused, precise edits" (lines 184-196) has four consistency bullets:
- `If adding a new phase, ensure it follows the existing pattern`
- `If modifying scope, update "What We're NOT Doing" section`
- `If changing approach, update "Implementation Approach" section`
- `Maintain the distinction between automated vs manual success criteria`

**What it is missing**:
- No guidance to preserve `tags:`, `type:`, and `## Prior Work` sections during edits
- An LLM following these instructions could drop frontmatter fields or overwrite the `## Prior Work` section when rewriting a phase, because there is no explicit preservation constraint
- No mention of whether adding significant new content should trigger new `builds_on::` relationships

## Key Discoveries

### Discovery 1: Fragment dependency (Phase 1 must precede Phase 3 logically, not technically)

The plan document (Phase 3 section) says "Add fragment inclusion" (`!cat` of `knowledge-metadata.md`) to the `research` and `plan` interactive skills. However, reading the current interactive skills reveals they do NOT use fragment injection at all — unlike the autonomous skills. The interactive `research/SKILL.md` and `plan/SKILL.md` are self-contained and do not `!cat` any fragments.

This means GH-552 can be implemented **without waiting for GH-550** (the fragment creation issue), by adding the guidance inline rather than via fragment injection. The fragment is useful for skill authors and future skills; the interactive skills can contain the guidance directly.

The parent plan's Phase 3 spec does NOT require fragment injection in the interactive skills (unlike Phase 2 which adds `!cat` lines to autonomous skills). Only the acceptance criteria matter: `grep` checks for specific strings in each SKILL.md file.

### Discovery 2: `research` interactive skill already has `type:` and `tags:` — smallest delta

The `research/SKILL.md` is the closest to complete. The only required change is adding `## Prior Work` to the document template body and adding a sentence to Step 4 to populate it from thoughts-locator results. This is a 3-5 line change.

### Discovery 3: `plan` skill has the largest delta — 4 new fields

The interactive `plan/SKILL.md` needs four additions to its frontmatter template: `type: plan`, `tags:`, `github_issue:`, and a `## Prior Work` section in the document body. It also needs the GitHub integration step (Step 6) updated to inject `github_issue: NNN` when linking to an issue, since `primary_issue` is set there but `github_issue` (singular) is not.

### Discovery 4: `form` skill touches 3 frontmatter mutation sites

The `form` skill has three places that mutate idea file frontmatter: Step 5a (GitHub issue creation), Step 5b (ticket tree creation), and Step 5d (refine draft). All three must be updated to set `type: idea` when the field is missing or to preserve it when present. Step 5a and 5b are the most critical because they mark `status: formed` — a formed idea should always have `type: idea`.

### Discovery 5: `iterate` risk is silent data loss

The `iterate` skill's risk is subtle: it does not actively delete metadata but an LLM rewriting a section using Edit tools could inadvertently overwrite the frontmatter or the `## Prior Work` section if it replaces a large block of text. Explicit preservation guidance eliminates the risk without changing the skill's behavior for normal edits.

### Discovery 6: `draft` is the simplest fix — one line

Adding `type: idea` to the `draft` template is a one-line change. No `## Prior Work`, no `tags:` change (already present), no GitHub integration change needed.

## Potential Approaches

### Option A: Inline guidance (no fragment dependency)

Add the metadata guidance directly into each skill's template/guidance sections. Does not depend on GH-550 (Phase 1 fragment) completing first.

**Pros**:
- GH-552 can ship independently
- No fragmentation of reading context for the interactive skills (they are already self-contained)
- Simpler implementation — each skill's template is fully visible in its SKILL.md

**Cons**:
- Slight duplication of the "why" explanation across skills (but only a sentence or two per skill, not the full fragment content)
- Harder to update the guidance in one place later (but the fragment injection mechanism is still available if needed)

### Option B: Fragment injection + inline template (as described in parent plan for autonomous skills)

Add `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md` near the top of each interactive skill and reference it from templates.

**Pros**:
- Single source of truth for the "why" explanation
- Consistent with autonomous skills after Phase 2 lands

**Cons**:
- Hard blocks on GH-550 (Phase 1)
- Interactive skills currently have no `!cat` injections; adding them changes the skill's context budget
- The acceptance criteria (grep checks) do not require `knowledge-metadata.md` to be referenced in interactive skills — only in autonomous skills

**Recommendation**: Option A for the template changes (required by acceptance criteria). Fragment injection is optional and should only be added if Phase 1 is complete; the implementation plan makes this conditional.

## Risks

1. **Over-specification of `## Prior Work` in interactive skills**: The `research` interactive skill is user-facing and exploratory. If the `## Prior Work` guidance is too prescriptive, it could slow down the skill by requiring thoughts-locator searches even for quick research sessions. The guidance should be additive ("if you find relevant prior work, add it here") not mandatory.

2. **`form` skill frontmatter collision**: If an idea file was created without `type: idea` (pre-fix), and the `form` skill adds `type: idea` to the frontmatter update block, it must use an "add if missing" pattern rather than overwriting. The Edit tool is surgical and safe here, but the skill instructions need to be explicit.

3. **`iterate` skill edge case — plans without `## Prior Work`**: Many existing plan documents do not have a `## Prior Work` section. The iterate skill's preservation guidance should not require adding the section — only preserving it if present.

4. **Phase ordering in the group**: GH-552 is order 3 in the group. GH-550 (fragment creation) and GH-551 (autonomous skills) are orders 1 and 2. The implementation of GH-552 can proceed independently (Option A above), but the PR should document that fragment injection is deferred pending GH-550.

## Recommended Next Steps

1. **Implement GH-552** per the parent plan's Phase 3 spec using Option A (inline guidance, no fragment injection):
   - `research/SKILL.md`: Add `## Prior Work` block after title in template; add 1-sentence guidance in Step 4 synthesis section
   - `plan/SKILL.md`: Add `type: plan`, `tags:`, `github_issue:` to frontmatter template; add `## Prior Work` after title in document body template; update Step 6 GitHub integration to set `github_issue: NNN`
   - `draft/SKILL.md`: Add `type: idea` to frontmatter template (one line)
   - `form/SKILL.md`: Add `type: idea` to Step 5a, 5b, and 5d frontmatter update blocks
   - `iterate/SKILL.md`: Add preservation bullet to Step 4 consistency guidance

2. **Verify acceptance criteria** with the grep commands in the issue body before marking complete

3. **No blocking dependency on GH-550**: The fragment can be added later as an enhancement; the critical metadata alignment for interactive skills does not require it

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/research/SKILL.md` — Add `## Prior Work` to document template; add guidance in Step 4 to populate from thoughts-locator findings
- `plugin/ralph-hero/skills/plan/SKILL.md` — Add `type: plan`, `tags:`, `github_issue:` to frontmatter template; add `## Prior Work` to document body template; update Step 6 GitHub integration to set `github_issue: NNN`
- `plugin/ralph-hero/skills/draft/SKILL.md` — Add `type: idea` to frontmatter template
- `plugin/ralph-hero/skills/form/SKILL.md` — Add `type: idea` to Steps 5a, 5b, and 5d frontmatter mutation blocks
- `plugin/ralph-hero/skills/iterate/SKILL.md` — Add preservation guidance for `tags:`, `type:`, `## Prior Work` in Step 4

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md` — Fragment from GH-550 (Phase 1); read only if adding optional fragment injection
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — Reference pattern for `## Prior Work` guidance in autonomous skills (Phase 2)
- `thoughts/shared/plans/2026-03-09-GH-0549-knowledge-metadata-alignment.md` — Parent plan with exact line-level specs for all changes
