---
date: 2026-03-19
status: draft
type: plan
github_issue: 631
tags: [cli, justfile, shell-quoting, bash, xs]
---

# GH-631 Implementation Plan: Fix unquoted `{{args}}` in justfile recipes

## Prior Work

- Research: `thoughts/shared/research/2026-03-19-GH-0631-justfile-args-quoting.md`
- GH-0251: introduced the shebang-recipe pattern with `*args` and `dispatch`
- GH-0546: documents the cli-dispatch.sh architecture
- GH-0410: prior justfile shebang investigation

## Overview

11 workflow recipes in `plugin/ralph-hero/justfile` pass `{{args}}` directly into a shebang bash script body. When arguments contain shell metacharacters (e.g., single quotes), just writes the raw string into the temp script file before bash parses it, producing a syntax error.

The fix is a two-line preamble using just's `quote()` function (available since 1.37, confirmed present in 1.47.1):

```bash
_args={{quote(args)}}
set -- $_args
dispatch "ralph-X" "$@"
```

This preserves correct multi-arg splitting (flags like `--budget=`, `-i`) while making the expansion safe for all shell metacharacters.

## Current State

Every affected recipe ends with:
```bash
dispatch "ralph-X" {{args}}
```

This raw interpolation breaks on any argument containing `'`, `"`, `\`, `$`, backticks, or other shell metacharacters.

## Desired End State

Every affected recipe ends with:
```bash
_args={{quote(args)}}
set -- $_args
dispatch "ralph-X" "$@"
```

All 11 recipes fixed. The `just --dry-run` output for any recipe shows proper POSIX quoting. `parse_mode` in `cli-dispatch.sh` continues to work correctly because `"$@"` expands each argument as a separate word.

---

## Phase 1: Fix all 11 affected recipes

**Estimate**: XS (< 30 min). Mechanical line-by-line substitution in one file.

### Task 1.1 — Fix all 11 dispatch calls in the justfile

**Files**: `plugin/ralph-hero/justfile`

**TDD**: No test harness for justfile recipes. Verification is done manually via `just --dry-run`.

**Complexity**: XS

**Depends on**: nothing

**Changes** — replace the single `dispatch` line in each recipe with the three-line pattern. Affected recipes and their current dispatch lines:

| Recipe | Line | Current | Skill arg |
|--------|------|---------|-----------|
| `triage` | 35 | `dispatch "ralph-triage" {{args}}` | `ralph-triage` |
| `split` | 44 | `dispatch "ralph-split" {{args}}` | `ralph-split` |
| `research` | 54 | `dispatch "ralph-research" {{args}}` | `ralph-research` |
| `plan` | 64 | `dispatch "ralph-plan" {{args}}` | `ralph-plan` |
| `review` | 73 | `dispatch "ralph-review" {{args}}` | `ralph-review` |
| `impl` | 83 | `dispatch "ralph-impl" {{args}}` | `ralph-impl` |
| `hygiene` | 93 | `dispatch "ralph-hygiene" {{args}}` | `ralph-hygiene` |
| `status` | 103 | `dispatch "status" {{args}}` | `status` |
| `report` | 112 | `dispatch "report" {{args}}` | `report` |
| `hero` | 126 | `dispatch "hero" {{args}}` | `hero` |
| `setup` | 145 | `dispatch "setup" {{args}}` | `setup` |

**Acceptance criteria**:
- `just --dry-run research "shouldn't"` shows `'shouldn'\''t'` in the `_args=` line (no raw single quote)
- `just --dry-run research 631 --budget=5.00` shows `_args='631' '--budget=5.00'` (two separate tokens)
- `just --dry-run research` (empty) shows `_args=` with an empty value
- `just --dry-run research 631 -i` shows `_args='631' '-i'`
- All 11 recipe `--dry-run` outputs show the new three-line pattern

### Task 1.2 — Verify the fix is complete

**Files**: none (read-only verification)

**TDD**: run `just --dry-run` for each recipe with at least one metacharacter argument

**Complexity**: XS

**Depends on**: Task 1.1

**Steps**:
```bash
cd plugin/ralph-hero
just --dry-run research "shouldn't"
just --dry-run research 631 --budget=5.00
just --dry-run plan 631 -i
just --dry-run impl 631 --timeout=30m
just --dry-run triage "test with 'quotes'"
# Spot-check remaining: split, review, hygiene, status, report, hero, setup
```

**Acceptance criteria**:
- No `--dry-run` output contains an unescaped single quote in the `dispatch` call
- All `_args=` assignments are syntactically valid shell

---

## Phase Success Criteria

### Automated

There is no CI test for justfile recipes. The TypeScript test suite (`npm test` in `plugin/ralph-hero/mcp-server/`) is unaffected — this change does not touch any TypeScript source.

### Manual Verification

1. `just --dry-run research "shouldn't"` exits 0 and shows `_args='shouldn'\''t'`
2. `just --dry-run research 631 --budget=5.00` exits 0 and shows two distinct quoted tokens
3. `just --dry-run setup` (no args) exits 0 and shows `_args=`
4. `just research 631` (live run) works as before — issue number is passed through correctly

---

## Dispatchability Self-Check

- **Single file, single change type**: yes — only `plugin/ralph-hero/justfile` changes
- **No new dependencies**: `quote()` is already available in just >= 1.37; the justfile already requires >= 1.37 (comment on line 4)
- **No API or schema changes**: no
- **No migration needed**: no
- **Reversible**: yes — revert is a one-line-per-recipe rollback
- **Blocking other work**: no — standalone XS fix
- **Can be dispatched to `ralph-impl`**: yes — the change is purely mechanical with precise acceptance criteria per recipe
