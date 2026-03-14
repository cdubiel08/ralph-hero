---
date: 2026-03-09
github_issue: 553
github_url: https://github.com/cdubiel08/ralph-hero/issues/553
status: complete
type: research
tags: [hooks, specs, metadata, review, document-protocols]
---

# GH-553: Update review-verify-doc.sh hook and specs for type:review rename

## Prior Work

- builds_on:: [[2026-03-09-GH-0549-knowledge-metadata-alignment]]

## Problem Statement

The ralph-review skill generates critique documents with `type: critique` in frontmatter. The `review-verify-doc.sh` hook enforces this field at write-time. However, the canonical type vocabulary for the knowledge indexer (and the skill itself) is `type: review` — matching the directory name `thoughts/shared/reviews/`, the workflow state name "Plan in Review", and the command name `ralph_review`. This mismatch means existing review documents are invisible to `knowledge_search(type="review")`.

Phase 4 of the parent plan ([GH-549](https://github.com/cdubiel08/ralph-hero/issues/549)) requires updating the enforcement hook and two specification documents to change `type: critique` → `type: review`, and adding SHOULD rows for new recommended fields.

## Current State Analysis

### review-verify-doc.sh

[`plugin/ralph-hero/hooks/scripts/review-verify-doc.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/review-verify-doc.sh) is a `PostToolUse(Write)` hook that fires whenever a file is written to `thoughts/shared/reviews/`. It enforces three frontmatter fields: `status`, `github_issue`, and `type: critique`.

Current state at lines 33–35:
```bash
if ! head -20 "$file_path" | grep -q "^type: critique"; then
  block "Critique missing 'type: critique' in frontmatter: $file_path"
fi
```

The script header comment (line 3) also calls the artifact a "critique document". Both the grep pattern and the block message need updating. No other hook scripts reference `type: critique` — this is the sole enforcement point.

### artifact-metadata.md

[`specs/artifact-metadata.md`](https://github.com/cdubiel08/ralph-hero/blob/main/specs/artifact-metadata.md) contains the frontmatter schema table for Critique Documents (lines 67–75). The specific row at line 74 reads:

```
| Critique docs MUST include `type: critique` field | [x] `artifact-metadata-validator.sh` |
```

The `artifact-metadata-validator.sh` reference in the enablement column is informational — the actual runtime enforcement is in `review-verify-doc.sh`. Confirming: `artifact-comment-validator.sh` and `doc-structure-validator.sh` do **not** reference `type: critique`; they are type-agnostic.

The spec also lacks SHOULD rows for `tags:` (research/plan), `type: plan`, and `github_issue:` (plan) — these need to be added to the Research Documents (lines 40–46) and Plan Documents (lines 48–65) sections.

### document-protocols.md

[`specs/document-protocols.md`](https://github.com/cdubiel08/ralph-hero/blob/main/specs/document-protocols.md) has two `type: critique` references:
- **Line 95**: The frontmatter schema description: `...type: critique`.
- **Line 107**: The requirements table row: `| Critique frontmatter MUST include \`status\`, \`github_issue\`, and \`type: critique\` fields | \`[x]\` \`review-verify-doc.sh\`...`

Both need to change to `type: review`.

### Out-of-scope items confirmed

The following contain `critique` references but are **out of scope** for this issue:
- `plugin/ralph-hero/hooks/scripts/ralph-command-contracts.json` — uses `"critique"` as an artifact type key and in path patterns
- `plugin/ralph-hero/skills/ralph-review/SKILL.md` — template has `type: critique` (Phase 2 scope)
- `plugin/ralph-hero/skills/shared/fragments/artifact-discovery.md` — references `YYYY-MM-DD-GH-NNNN-critique.md` filename pattern

The issue explicitly states: skill template changes are Phases 2 and 3; backfilling existing documents is Phase 6.

## Key Discoveries

1. **Single hook, clean change**: The `type: critique` enforcement is isolated to exactly lines 33–34 of `review-verify-doc.sh`. No other scripts enforce this field value. The change is a safe 2-line edit.

2. **artifact-metadata-validator.sh is listed but not the enforcer**: The enablement column in `artifact-metadata.md` cites `artifact-metadata-validator.sh`, but that script does not currently check `type: critique`. The actual gate is `review-verify-doc.sh`. The spec column is aspirational/inaccurate, but since we're changing the requirement text, the enablement column should still point to `review-verify-doc.sh`.

3. **Block message needs updating too**: Line 34 says `"Critique missing 'type: critique'"` — after the change this should say `"Review document missing 'type: review'"` to match the parent plan guidance.

4. **SHOULD rows placement**: The four new SHOULD rows for `artifact-metadata.md` belong:
   - `tags:` for research → after line 46 (end of Research Documents table)
   - `type: plan` for plans → after line 56 (end of Plan Documents Single Issue table)
   - `tags:` for plans → same location
   - `github_issue:` for plans → same location

5. **document-protocols.md cross-references**: The section header (line 88) says "Review/Critique Documents" and line 11 defines "Critique Document". These are editorial/naming details — the issue only requires changing the two `type: critique` string occurrences.

## Potential Approaches

### Option A: Targeted string replacements (recommended)
Replace exactly the `type: critique` strings as specified in the parent plan. Touch only the lines identified. Add the four SHOULD rows to `artifact-metadata.md`.

**Pros**: Minimal diff, easy to review, exactly matches acceptance criteria
**Cons**: Leaves `artifact-metadata-validator.sh` citation in the enablement column (already inaccurate)

### Option B: Broader cleanup pass
Also fix the enablement column citation in `artifact-metadata.md` to `review-verify-doc.sh`, fix the section header "Review/Critique Documents" to just "Review Documents" in `document-protocols.md`.

**Pros**: More consistent naming throughout
**Cons**: Larger diff, higher risk of unexpected test/hook failures; scope exceeds what acceptance criteria require

**Recommendation**: Option A. The acceptance criteria are precise grep-based checks; Option B changes are editorial and belong in a separate cleanup issue.

## Risks

- **No runtime risk**: `review-verify-doc.sh` is a hook. After this change, any existing `type: critique` review docs written with the old hook would fail verification if re-written. But since existing docs are committed, they won't trigger re-verification. Phase 6 handles backfill.
- **Spec accuracy**: After the change, `artifact-metadata.md` line 74 will reference `review-verify-doc.sh` for the `type: review` enforcement — this is accurate.
- **Test gap**: No automated tests cover `review-verify-doc.sh` behavior. The change is simple enough that manual verification (running the grep acceptance criteria) is sufficient.

## Recommended Next Steps

1. In `review-verify-doc.sh`, update line 33 grep pattern and line 34 block message.
2. In `artifact-metadata.md`, update the `type: critique` row (line 74) and add 4 SHOULD rows.
3. In `document-protocols.md`, update lines 95 and 107.
4. Run the 4 grep-based acceptance criteria to confirm.
5. Commit and push.

No dependency ordering required — all three files can be edited in a single commit.

## Files Affected

### Will Modify
- `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` - Change `type: critique` to `type: review` (lines 33–34)
- `specs/artifact-metadata.md` - Update requirement row (line 74); add 4 SHOULD rows for tags/type/github_issue
- `specs/document-protocols.md` - Change `type: critique` to `type: review` (lines 95 and 107)

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` - Provides `block` function (already sourced; no changes needed)
- `thoughts/shared/plans/2026-03-09-GH-0549-knowledge-metadata-alignment.md` - Parent plan Phase 4 specification
