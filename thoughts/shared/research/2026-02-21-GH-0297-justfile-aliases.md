---
date: 2026-02-21
github_issue: 297
github_url: https://github.com/cdubiel08/ralph-hero/issues/297
status: complete
type: research
---

# GH-297: Add common aliases for justfile recipes

## Problem Statement

Frequently-used recipes require typing full names (`triage`, `research`, `impl`, `status`). Users who run the CLI interactively would benefit from short single-letter aliases.

## Current State Analysis

### File

**[plugin/ralph-hero/justfile](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile)** -- No `alias` directives currently exist.

### Version Compatibility

- **Installed `just` version**: 1.21.0
- **`alias` feature**: Available since early `just` versions, well before v1.21.0
- **No version constraint change needed**: Unlike `[group()]` (requires v1.27+), aliases work on v1.21.0 without any `set min-version` change

### Just Alias Behavior

From just documentation and changelog (v1.17.0 clarification):
- Aliases **can only be used on the command line** -- `just t` works, but `just _run_skill "t"` does not resolve the alias
- Aliases appear in `just --list` output alongside the original recipe
- Aliases cannot have their own parameters -- they forward all args to the target recipe
- Aliases do not affect how recipes call each other internally

## Proposed Aliases

Based on the issue body and usage patterns:

| Alias | Target | Rationale |
|-------|--------|-----------|
| `t` | `triage` | Most common workflow entry point |
| `r` | `research` | Frequently run manually |
| `i` | `impl` | Used during implementation phase |
| `s` | `status` | Dashboard shortcut |
| `sp` | `split` | Complement to triage |
| `h` | `hygiene` | Board maintenance shortcut |

Additional candidates (lower priority):
| Alias | Target | Rationale |
|-------|--------|-----------|
| `p` | `plan` | Planning phase |
| `rv` | `review` | Avoid conflict with potential `r` for `report` |
| `qs` | `quick-status` | Quick dashboard |

### Conflict Check

No conflicts among proposed aliases -- all are unique. `s` for `status` is unambiguous since `setup` and `split` both have longer names (`sp`, `se`).

## Implementation

Add alias declarations near the top of the justfile (after `set` directives, before recipes). just convention is to place aliases adjacent to or grouped together at top:

```just
# Aliases
alias t  := triage
alias r  := research
alias i  := impl
alias s  := status
alias sp := split
alias h  := hygiene
alias p  := plan
```

**File**: [plugin/ralph-hero/justfile](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile)
**Location**: After line 8 (`set dotenv-load`), before the `default` recipe (line 11)

## Dependency Note

This issue is blocked by #291 (Add `[group()]` attributes). The `[group()]` change should be applied first so that aliases appear in the correct group section in `just --list` output. However, since aliases themselves don't have group attributes, this ordering is a "nice to have" -- aliases work correctly without groups in place.

## Estimate Validation

XS is correct (re-estimated from S during triage). This is 6-8 lines of `alias x := y` declarations with no logic changes.

## Risks

- **`alias` visibility**: Aliases appear in `just --list` alongside originals, which may increase list noise. Minimal concern -- aliases are clearly labeled in output.
- **Blocked by #291**: If groups are added first, `just --list` will display aliases in a clean grouped view. If aliases are added first, they appear ungrouped. Either order is functionally correct.
