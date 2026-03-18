# Artifact Comment Protocol

Standard comment headers used to link documents to GitHub issues. All document-producing and document-consuming skills use these headers for discovery.

## Comment Headers

### Existing Headers

| Header | Posted on | Contains | Created by |
|--------|-----------|----------|------------|
| `## Research Document` | Issue | URL to research doc + key findings summary | `ralph-research` |
| `## Implementation Plan` | Issue | URL to plan doc + phase position summary | `ralph-plan` |
| `## Group Implementation Plan` | Group issues | URL to group plan doc | `ralph-plan` |
| `## Validation` | Issue | Validation results (PASS/FAIL per check) | `ralph-val` |
| `## Plan Review` | Issue | VERDICT: APPROVED/NEEDS_ITERATION + critique URL | `ralph-review` |
| `## Implementation Complete` | Issue | PR URL + implementation summary | `ralph-impl` |

### New Headers (Tiered Planning)

| Header | Posted on | Contains | Created by |
|--------|-----------|----------|------------|
| `## Plan of Plans` | Epic issue | URL to plan-of-plans doc, feature list with issue numbers | `ralph-plan-epic` |
| `## Plan Reference` | Atomic issue (parent-planned) | URL to parent plan + `#phase-N` anchor, inherited constraints summary | `ralph-split` (when splitting from a plan) |
| `## Phase N Review` | Issue | Phase code quality review result (APPROVED/NEEDS_FIXES) | `ralph-impl` |
| `## Drift Log — Phase N` | Issue (if drift occurred) | List of adaptations with minor/major severity | `ralph-impl` |
| `## Plan Revision Request` | Sibling or parent issue | What's needed, why current plan doesn't provide it | `ralph-impl` or `ralph-plan-feature` |

## Comment Format Examples

### `## Plan Reference` (posted on atomic children)

```
## Plan Reference

https://github.com/OWNER/REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-feature.md#phase-1

Parent: #NNN (feature issue)
Phase: 1 of 3
Shared constraints inherited from parent plan.
```

### `## Plan of Plans` (posted on feature children)

```
## Plan of Plans

https://github.com/OWNER/REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-epic.md

Parent: #NNN (epic issue)
Feature scope defined in parent plan-of-plans.
```

### `## Phase N Review` (posted after phase code quality review)

```
## Phase 2 Review

Assessment: APPROVED
Strengths: Clean file boundaries, consistent naming
Issues fixed: 1 Important (extracted shared constant)
Minor notes: Consider extracting parser helper in future phase
```

### `## Drift Log — Phase N` (posted if drift occurred during phase)

```
## Drift Log — Phase 1

- `src/types.ts`: Added `timeout` field not in original plan (minor — needed by parser)
- `src/config.ts`: Import path changed from `./util` to `./utils` (minor — file was renamed)

No major drift. All adaptations documented in commit messages with DRIFT: prefix.
```

## Plan Discovery Chain

Skills that consume plan documents use this fallback chain:

1. `knowledge_search(query="implementation plan GH-NNN", type="plan", limit=3)`
2. `--plan-doc` flag (if provided)
3. Artifact Comment Protocol — search issue comments for headers in order:
   a. `## Implementation Plan` (direct plan ownership)
   b. `## Plan Reference` (backreference — follow URL to parent plan, extract phase section + `## Shared Constraints`)
   c. `## Plan of Plans` (for feature-level context only)
4. Glob fallback: `thoughts/shared/plans/*GH-NNN*`
5. Group fallback: `thoughts/shared/plans/*group*GH-NNN*`
6. Stream fallback: `thoughts/shared/plans/*stream*GH-NNN*`
7. Self-heal: if glob found a file, post comment to link it
8. Hard stop: no plan found

When resolving via `## Plan Reference`:
- Extract the URL and phase anchor from the comment
- Read the parent plan document
- Extract the specific phase section matching the anchor
- Also extract `## Shared Constraints` from the plan header
- Optionally: extract `## Integration Strategy` from plan-of-plans if cross-feature work
