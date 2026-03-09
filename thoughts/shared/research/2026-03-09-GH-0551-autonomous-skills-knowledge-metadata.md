---
date: 2026-03-09
github_issue: 551
github_url: https://github.com/cdubiel08/ralph-hero/issues/551
status: complete
type: research
tags: [knowledge-graph, skill-templates, metadata, autonomous-skills]
---

# GH-551: Update Autonomous Skills with Knowledge Metadata

## Prior Work

- builds_on:: [[2026-03-08-knowledge-graph-design]]
- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]

## Problem Statement

The ralph-knowledge indexer (`plugin/ralph-knowledge/src/parser.ts`) reads `type`, `tags`, `github_issue`, and `## Prior Work` sections from documents to build a searchable knowledge graph. However, the three autonomous skills that produce documents have metadata gaps:

1. **ralph-research**: Already has `type: research` and `tags:` in its frontmatter template (lines 116-124) and a `## Prior Work` section (lines 129-142). **This skill is already compliant with the knowledge metadata schema.**
2. **ralph-plan**: Missing `type: plan`, `github_issue:` (singular integer), and `tags:` from its frontmatter template. Has `## Prior Work` section (lines 191-204) and `tags:` (line 185). **Needs `type: plan` and `github_issue:` added.**
3. **ralph-review**: Uses `type: critique` (line 222 in the AUTO mode critique template) instead of `type: review`. Missing `tags:` from the critique frontmatter template. **Needs type rename and tags addition.**

Additionally, the parent plan (GH-549) calls for including the `knowledge-metadata.md` shared fragment in ralph-research and ralph-plan, but that fragment does not yet exist (Phase 1 / GH-550 not yet implemented).

## Current State Analysis

### ralph-research SKILL.md (264 lines)

The research skill template is **already largely aligned** with knowledge metadata requirements:

- **Frontmatter** (lines 116-124): Contains `date`, `github_issue`, `github_url`, `status`, `type: research`, `tags: [topic1, topic2]`
- **Prior Work section** (lines 129-142): Fully specified with `builds_on::` and `tensions::` syntax
- **Tags guidance** (lines 127): Instructs 2-5 tags with lowercase hyphenated terms
- **Fragment inclusion**: Currently includes `escalation-steps.md` (line 247) via `!cat` injection. No knowledge-metadata fragment inclusion yet.

Gaps:
- Missing `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md` inclusion (dependent on GH-550)
- No other metadata gaps

### ralph-plan SKILL.md (357 lines)

The plan skill template has partial coverage:

- **Frontmatter** (lines 173-187): Contains `date`, `status`, `github_issues` (array), `github_urls`, `primary_issue`, `stream_id`, `stream_issues`, `epic_issue`, `tags: [topic1, topic2]`
- **Missing from frontmatter**: `type: plan` and `github_issue: NNN` (singular integer for the indexer)
- **Prior Work section** (lines 191-204): Fully specified with `builds_on::` and `tensions::` syntax
- **Tags guidance** (line 189): Present, instructs 2-5 tags
- **Fragment inclusions**: Currently includes `error-handling.md` (line 165) and `escalation-steps.md` (line 309). No knowledge-metadata fragment.

Gaps:
- `type: plan` missing from frontmatter template
- `github_issue: NNN` (singular integer, same value as `primary_issue`) missing from frontmatter template
- Missing `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md` inclusion (dependent on GH-550)

### ralph-review SKILL.md (413 lines)

The review skill's AUTO mode critique template (embedded in the Task prompt, lines 199-237):

- **Frontmatter** (lines 213-220): Contains `date`, `github_issue`, `github_url`, `plan_document`, `status`, `type: critique`
- **Missing**: `tags:` field, `type` should be `review` not `critique`
- **No Prior Work section**: Review/critique documents are not specified to need `## Prior Work` per the parent plan
- **No fragment inclusion needed**: The plan does not call for knowledge-metadata fragment in ralph-review

Gaps:
- `type: critique` needs to change to `type: review`
- `tags:` field needs to be added to the frontmatter template

### Hook Enforcement: review-verify-doc.sh

The PostToolUse hook at `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` (line 33) enforces:
```bash
if ! head -20 "$file_path" | grep -q "^type: critique"; then
  block "Critique missing 'type: critique' in frontmatter: $file_path"
fi
```

This hook **will block** if we change the skill template to emit `type: review` without also updating the hook. However, **updating the hook is GH-553 (Phase 4), not GH-551 (Phase 2)**. This creates a dependency concern: if GH-551 is implemented before GH-553, the AUTO mode review skill will produce `type: review` documents that fail the hook validation.

### Spec References

Two spec files reference `type: critique`:
- `specs/artifact-metadata.md` line 74: "Critique docs MUST include `type: critique` field"
- `specs/document-protocols.md` line 95 and 107: "`type: critique`" in schema/requirements

These are also Phase 4 (GH-553) scope.

### Knowledge Indexer (parser.ts)

The indexer at `plugin/ralph-knowledge/src/parser.ts` line 60 reads:
```typescript
githubIssue: typeof frontmatter.github_issue === "number" ? frontmatter.github_issue : null,
```

It only reads `github_issue` (singular). Plan documents currently have `github_issues` (plural array) and `primary_issue`, but not `github_issue`. Adding `github_issue: NNN` (same as `primary_issue`) to the plan template solves this without any indexer changes. The indexer fallback chain (GH-554 / Phase 5) would provide a backup for existing documents, but new plans would be covered immediately.

### Fragment Inclusion Pattern

Existing fragments use `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/<name>.md` syntax. There are 4 existing fragments:
- `escalation-steps.md` - included by 7 skills
- `error-handling.md` - included by ralph-plan
- `team-reporting.md` - team coordination guidance
- `artifact-discovery.md` - artifact location protocol

The `knowledge-metadata.md` fragment does not yet exist (GH-550 scope). Including it in skills before it exists would cause a `!cat` injection error when the skill is loaded.

## Key Discoveries

1. **ralph-research is already nearly compliant** — it has `tags:`, `type: research`, and `## Prior Work`. The only change needed is adding the knowledge-metadata fragment inclusion line (which depends on GH-550).

2. **ralph-plan needs two frontmatter additions** — `type: plan` and `github_issue: NNN`. The `tags:` and `## Prior Work` are already present.

3. **ralph-review type rename has a hook dependency** — Changing `type: critique` to `type: review` in the skill template without simultaneously updating `review-verify-doc.sh` will cause AUTO mode reviews to fail. Implementation must either:
   - (a) Update the hook at the same time (pulling GH-553 Phase 4 work into GH-551), or
   - (b) Implement GH-553 before or atomically with the ralph-review change in GH-551, or
   - (c) Accept that AUTO mode reviews will be broken between GH-551 and GH-553 deployment

4. **Fragment inclusion depends on GH-550** — The `knowledge-metadata.md` fragment must exist before skills can include it. The parent plan orders this as Phase 1 -> Phase 2, so this is expected.

5. **The plan frontmatter template already has `tags:`** at line 185, so the parent plan's statement that `tags:` is "missing" from ralph-plan is incorrect — it was likely added after the plan was written.

6. **The research skill template already has `tags:` and `## Prior Work`** — the parent plan's Phase 2 section may be partially outdated. The acceptance criteria in the issue body still hold (`grep -c 'tags:' ... returns >= 1`) because they test for presence, not addition.

## Potential Approaches

### Approach A: Strict Phase Ordering (Recommended)

Implement GH-551 changes exactly as specified, **after** GH-550 (fragment creation):

1. ralph-research: Add `!cat` fragment inclusion line only (everything else already present)
2. ralph-plan: Add `type: plan` and `github_issue: NNN` to frontmatter template, add `!cat` fragment inclusion
3. ralph-review: Change `type: critique` -> `type: review`, add `tags:` to critique frontmatter template

**Risk**: The `type: review` change will break AUTO mode reviews until GH-553 updates the hook. Mitigation: implement GH-553 immediately after or atomically with GH-551.

**Pros**: Follows the parent plan's phase ordering, keeps PRs focused
**Cons**: Creates a broken window between GH-551 and GH-553 for the review hook

### Approach B: Bundle Hook Update with Type Rename

Include the `review-verify-doc.sh` hook change (line 33: `type: critique` -> `type: review`) as part of GH-551, even though it's nominally GH-553 scope.

**Pros**: No broken window, atomic change
**Cons**: Scope creep from Phase 4 into Phase 2, spec files (`artifact-metadata.md`, `document-protocols.md`) would still reference `type: critique` until GH-553

### Approach C: Defer Type Rename

Keep `type: critique` in ralph-review for now. Only add `tags:` in GH-551. Let the full type rename happen in GH-553 alongside the hook and spec updates.

**Pros**: No dependency issues, clean separation
**Cons**: Doesn't satisfy GH-551 acceptance criterion: `grep -c 'type: review' plugin/ralph-hero/skills/ralph-review/SKILL.md` returns >= 1

## Risks

1. **Hook breakage**: Changing `type: critique` to `type: review` in the skill without updating the hook will cause ALL AUTO mode reviews to fail with "Critique missing 'type: critique' in frontmatter" until GH-553 is deployed.

2. **Fragment dependency**: Adding `!cat` lines for `knowledge-metadata.md` before GH-550 creates the fragment will cause skill loading failures (file not found).

3. **Acceptance criteria already met**: Some acceptance criteria (`grep -c 'tags:'` on ralph-research) are already passing. The implementation must be careful not to duplicate existing content.

## Recommended Next Steps

1. **Implement GH-550 first** (create the knowledge-metadata fragment)
2. **Implement GH-551 with Approach A** (strict phase ordering), bundling the hook fix from GH-553 for the `type: review` rename specifically (just the one-line hook change) to avoid a broken window. Alternatively, implement GH-553 atomically.
3. **Verify acceptance criteria** with the exact `grep` commands listed in the issue body
4. **Run `npm test`** in the MCP server to ensure no regressions

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` - Add knowledge-metadata fragment inclusion line
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Add `type: plan` and `github_issue:` to frontmatter template, add fragment inclusion
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` - Change `type: critique` to `type: review`, add `tags:` to critique frontmatter

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md` - Must exist before fragment inclusion lines are added (GH-550)
- `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` - Enforces `type: critique`; must be updated (GH-553) before or with the type rename
- `plugin/ralph-knowledge/src/parser.ts` - Indexer that reads the metadata fields; confirms `github_issue` field name
- `specs/artifact-metadata.md` - Documents current `type: critique` requirement (GH-553 scope)
- `specs/document-protocols.md` - Documents current `type: critique` requirement (GH-553 scope)
