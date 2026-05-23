# Plan shapes

Plan-doc structure consumed by default, `--mode auto`, and `--mode epic` (with epic-specific variant). The `doc-structure-validator.sh` hook enforces a subset of these sections for plan-mode writes.

## Filename convention

`thoughts/shared/plans/YYYY-MM-DD-[GH-NNNN-]description.md` where:

- `YYYY-MM-DD` is today's date.
- `GH-NNNN` is the zero-padded primary issue number. Omit if no linked issue.
- `description` is brief kebab-case.

Examples:

- With issue: `2026-05-23-GH-1364-ralph-plan-4-plan.md`
- Without issue: `2026-05-23-multi-tenant-tokens.md`
- Plan-of-plans (epic): `2026-05-23-GH-1300-epic-mobile-app-decomposition.md`

## Frontmatter

```yaml
---
date: YYYY-MM-DD
status: draft                    # draft → ready → approved → in-progress → complete
type: plan                       # or "plan-of-plans" for epic mode
tags: [relevant, topic, tags]    # 2-5 lowercase-hyphenated
github_issue: NNN                # optional
github_issues: [NNN, NNN, ...]   # for multi-issue groups
github_urls:
  - https://github.com/OWNER/REPO/issues/NNN
primary_issue: NNN
---
```

## Section order (standard plan)

```markdown
# [Plan title — descriptive, references the work]

## Prior Work
[builds_on:: / tensions:: wikilinks with evidence weighting]

## Overview
[1-3 paragraphs: what + why]

## Current State Analysis
[What exists today, where the work lives, key constraints]

### Key Discoveries
[Bullet list of load-bearing facts the plan reacts to — file:line refs]

## Desired End State
[Numbered list of post-merge invariants]

### Verification
[Bullet list — automated and manual checks proving Desired End State]

## What We're NOT Doing
[Bullet list — scope boundaries]

## Implementation Approach
[1-2 paragraphs — high-level shape, phase count, file ownership intent]

## Phase 1: [Descriptive name]
### Overview
[1-2 sentences]

### Changes Required
#### 1. [Component / File group]
**File**: `relative/path.ts`
**Changes**: [What changes]

### Success Criteria
#### Automated Verification
- [ ] `command to run` returns expected result
- [ ] tests pass

#### Manual Verification
- [ ] User-visible behavior matches

## Phase 2: [...]
...

## Testing Strategy
### Unit Tests
### Integration Tests
### Manual Testing Steps

## Performance Considerations

## Migration Notes

## References
```

## Phase-section anatomy

Each `## Phase N:` section MUST include:

1. **Overview** — 1-2 sentences describing the phase's outcome.
2. **Changes Required** — concrete file paths + what changes. Backtick-wrap each path.
3. **Success Criteria** with TWO subsections:
   - **`#### Automated Verification`** — commands / tests that prove correctness without human eyes. The `doc-structure-validator.sh` hook checks for this header pattern.
   - **`#### Manual Verification`** — what the user must observe themselves (UI behavior, data integrity post-migration).

File ownership rule: each phase owns a tightly-scoped file set. Phases should not stomp on each other's files. Document file ownership explicitly when a file is touched in multiple phases.

## Plan-of-plans variant (epic mode)

Epic mode writes a different shape — see `decomposition.md` § Plan-of-plans shape. Key differences:

- No phases; instead `## Feature Decomposition` with `### Feature A`, `### Feature B`, etc.
- `## Strategic Context` replaces `## Current State Analysis`.
- `## Feature Sequencing` replaces phase ordering.
- `## Integration Strategy` describes how features compose.

## Estimate / complexity decision guide

| Estimate | Phase count | When |
|---|---|---|
| XS | 1 phase | Single concern, < 100 LOC, no schema changes |
| S | 2-3 phases | Single concern, < 500 LOC, optional schema |
| M | 5-7 phases | Multiple concerns; needs `--mode epic` if there are independent features |
| L | 7-10 phases | Multi-tier; `--mode epic` required |
| XL | Plan of plans | Always `--mode epic` |

Plan 4 `--mode auto` targets XS/S only (enforced by `plan-tier-validator.sh`). Default and iterate modes accept M too. L+ requires `--mode epic`.

## Per-mode required-sections matrix

| Section | default (interactive) | `--mode auto` | `--mode epic` |
|---|---|---|---|
| Frontmatter | required | required | required |
| Prior Work | required | required | required |
| Overview | required | required | required |
| Current State Analysis | required | required | replaced by Strategic Context |
| Desired End State | required | required | replaced by Integration Strategy |
| What We're NOT Doing | required | required | required |
| Implementation Approach | required | required | replaced by Feature Decomposition |
| Phase N sections | required | required | n/a (no phases) |
| Feature Decomposition | n/a | n/a | required |
| Feature Sequencing | n/a | n/a | required |
| Testing Strategy | recommended | required | optional |
| Performance Considerations | optional | optional | optional |
| Migration Notes | optional | required | required |
| UI Validation Phase | conditional | conditional | n/a |

`--mode iterate` consumes an existing plan and preserves its section shape — no new required sections.

`--mode review` writes a separate critique doc per `plan-review.md` § Critique-doc structure.
