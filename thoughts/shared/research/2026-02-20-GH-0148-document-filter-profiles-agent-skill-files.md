---
date: 2026-02-20
github_issue: 148
github_url: https://github.com/cdubiel08/ralph-hero/issues/148
status: complete
type: research
---

# GH-148: Document Filter Profiles in Agent Skill Files

## Problem Statement

Ralph agent skill files (SKILL.md) currently hard-code inline filter parameters when calling `list_issues`. Once sibling #147 defines a filter profile registry and #149 wires it into the list tools, agents should reference named profiles for cleaner, more maintainable calls. This issue updates the SKILL.md files to show the `profile` param alongside existing inline params.

## Current State Analysis

### Skill Files That Call `list_issues`

Analyzed all 11 skill files in `plugin/ralph-hero/skills/`. Six skills call `ralph_hero__list_issues` with inline filters:

| Skill File | Current Filter Usage | Matching Profile |
|------------|---------------------|-----------------|
| `ralph-triage/SKILL.md` | `workflowState: "Backlog"` (lines 67-71, 76-83, 255-257, 260-265) | `analyst-triage` |
| `ralph-research/SKILL.md` | `workflowState: "Research Needed"` (line 47) | `analyst-research` |
| `ralph-plan/SKILL.md` | `workflowState: "Ready for Plan"` (line 85) | `builder-planned` |
| `ralph-impl/SKILL.md` | `workflowState: "In Progress"` (lines 51-58) | `builder-active` |
| `ralph-review/SKILL.md` | `workflowState: "Plan in Review"` (lines 65-72) | `validator-review` |
| `ralph-split/SKILL.md` | `workflowState: "Backlog"`, `estimate: "M"` (lines 56-61, then L/XL) | No direct profile (multi-query pattern) |

Five skills do NOT call `list_issues`:
- `ralph-hero/SKILL.md` — orchestrator, delegates to other skills
- `ralph-team/SKILL.md` — team orchestrator, delegates to other skills
- `ralph-status/SKILL.md` — calls `pipeline_dashboard`, not `list_issues`
- `ralph-report/SKILL.md` — reporting skill
- `ralph-setup/SKILL.md` — project setup skill

### Filter Profile Definitions (from #147/#109)

Per the parent issue #109 and sibling #147 research, profiles map to:

| Profile | Filters | Used By |
|---------|---------|---------|
| `analyst-triage` | `workflowState: "Backlog"` | ralph-triage |
| `analyst-research` | `workflowState: "Research Needed"` | ralph-research |
| `builder-planned` | `workflowState: "Ready for Plan"` | ralph-plan |
| `builder-active` | `workflowState: "In Progress"` | ralph-impl |
| `validator-review` | `workflowState: "Plan in Review"` | ralph-review |
| `integrator-merge` | `workflowState: "In Review"` | (future integrator skill) |

### Important Constraint: Profiles Are Additive, Not Replacements

The `profile` param provides default filters that can be overridden by explicit args. Skill files should show BOTH the profile approach and the existing inline approach for clarity. This is because:

1. Some calls add additional filters on top (e.g., triage adds `label: "ralph-triage"`)
2. Split has a multi-estimate query pattern that doesn't map to a single profile
3. Agents need to understand what the profile expands to for debugging

## Implementation Plan

### Change Strategy

For each applicable skill file, add a "Filter Profiles" reference section and update primary `list_issues` examples to show the `profile` param. Keep existing inline params as comments for transparency.

### 1. `ralph-triage/SKILL.md`

**Primary query (Step 1, lines 67-71)** — triaged issues lookup:
```
ralph_hero__list_issues
- profile: "analyst-triage"
- label: "ralph-triage"
# Equivalent to: workflowState: "Backlog", label: "ralph-triage"
- limit: 250
```

**Secondary query (lines 76-83)** — all Backlog issues:
```
ralph_hero__list_issues
- profile: "analyst-triage"
# Equivalent to: workflowState: "Backlog"
- orderBy: "createdAt"
- limit: 250
```

Note: The label override on the first query demonstrates profile + explicit arg composition.

**Step 5 queries (lines 255-257, 260-265)** — related issue scanning:
These use `workflowState: "Backlog"` and `workflowState: "Research Needed"` separately. Add profile alternatives:
```
ralph_hero__list_issues
- profile: "analyst-triage"
# or equivalently: workflowState: "Backlog"
- limit: 50
```

### 2. `ralph-research/SKILL.md`

**Step 1 query (line 47)**:
```
ralph_hero__list_issues
- profile: "analyst-research"
# Equivalent to: workflowState: "Research Needed"
- limit: 50
```

### 3. `ralph-plan/SKILL.md`

**Step 1b query (line 85)**:
```
ralph_hero__list_issues
- profile: "builder-planned"
# Equivalent to: workflowState: "Ready for Plan"
- limit: 50
```

### 4. `ralph-impl/SKILL.md`

**Step 1 query (lines 51-58)**:
```
ralph_hero__list_issues
- profile: "builder-active"
# Equivalent to: workflowState: "In Progress"
- orderBy: "priority"
- limit: 1
```

Note: The `estimate: "XS,S"` in the current query is not a valid single-value filter (the tool takes a single string, not comma-separated). This is likely a documentation bug. The profile approach avoids this issue.

### 5. `ralph-review/SKILL.md`

**Step 1 query (lines 65-72)**:
```
ralph_hero__list_issues
- profile: "validator-review"
# Equivalent to: workflowState: "Plan in Review"
- orderBy: "priority"
- limit: 1
```

### 6. `ralph-split/SKILL.md`

**Step 1 queries (lines 56-73)** — multi-estimate pattern:
The split skill queries for M, L, and XL estimates across two workflow states. No single profile captures this pattern. Keep inline filters but add a note:

```
# Note: No filter profile for split candidate selection.
# Split uses multi-query pattern across estimates (M, L, XL) and states.
ralph_hero__list_issues
- workflowState: "Backlog"
- estimate: "M"
- limit: 50
```

### 7. Add Profile Reference Table

Add a consistent reference section to each updated skill file, just before the `## Constraints` section. Example for ralph-triage:

```markdown
## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-triage` | `workflowState: "Backlog"` | Find untriaged backlog items |
| `analyst-research` | `workflowState: "Research Needed"` | Find items needing research |

Profiles set default filters. Explicit params override profile defaults.
```

Each skill only lists profiles relevant to its role (not all profiles).

### Files Changed

| File | Changes | Lines Affected |
|------|---------|---------------|
| `skills/ralph-triage/SKILL.md` | Update 4 `list_issues` examples, add profile table | ~20 lines changed |
| `skills/ralph-research/SKILL.md` | Update 1 `list_issues` example, add profile table | ~10 lines changed |
| `skills/ralph-plan/SKILL.md` | Update 1 `list_issues` example, add profile table | ~10 lines changed |
| `skills/ralph-impl/SKILL.md` | Update 1 `list_issues` example, add profile table | ~10 lines changed |
| `skills/ralph-review/SKILL.md` | Update 1 `list_issues` example, add profile table | ~10 lines changed |
| `skills/ralph-split/SKILL.md` | Add note about no matching profile | ~5 lines changed |

## Edge Cases

1. **Profile not yet implemented**: If #147 and #149 are not merged when this documentation ships, agents will get "unknown profile" errors. Mitigation: keep inline params as comments so agents can fall back.
2. **Profile expansion changes**: If profile definitions change in #147, these docs become stale. Mitigation: the inline comment shows the expansion, making staleness visible.
3. **New profiles added later**: New profiles won't appear in skill docs automatically. This is acceptable -- skill docs are manually maintained.
4. **ralph-split multi-query pattern**: No profile covers this use case. The split skill is documented as using inline filters. A future `split-candidates` profile could be added but is out of scope.

## Dependencies

- **Depends on #147**: Profile names must be finalized before documenting them
- **Depends on #149**: The `profile` param must exist on `list_issues` before agents can use it
- **Independent of #141/#142**: Presence/negation filters are separate from profile documentation

Note: The documentation can be written before #147/#149 merge, but agents cannot use profiles until both are deployed. The inline comment fallback ensures backward compatibility.

## Risks

1. **Minimal risk**: Pure documentation change -- no code, no behavior changes
2. **Correctness**: Profile expansions must match #147 definitions exactly. Cross-reference during implementation.
3. **Adoption**: Agents may ignore profiles and continue using inline params. This is harmless -- profiles are a convenience, not a requirement.

## Recommended Approach

1. Wait for #147 profile definitions to be finalized
2. Update each SKILL.md in a single commit
3. For each skill: add profile param to primary `list_issues` call, keep inline params as comments, add role-specific profile table
4. Skip ralph-split (no matching profile) and non-list-issues skills

Estimated effort: ~15 minutes. Straightforward documentation updates across 6 files.
