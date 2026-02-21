---
date: 2026-02-21
status: draft
github_issues: [291, 292, 293, 294, 295, 296, 297, 298, 300, 302, 303, 304]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/291
  - https://github.com/cdubiel08/ralph-hero/issues/292
  - https://github.com/cdubiel08/ralph-hero/issues/293
  - https://github.com/cdubiel08/ralph-hero/issues/294
  - https://github.com/cdubiel08/ralph-hero/issues/295
  - https://github.com/cdubiel08/ralph-hero/issues/296
  - https://github.com/cdubiel08/ralph-hero/issues/297
  - https://github.com/cdubiel08/ralph-hero/issues/298
  - https://github.com/cdubiel08/ralph-hero/issues/300
  - https://github.com/cdubiel08/ralph-hero/issues/302
  - https://github.com/cdubiel08/ralph-hero/issues/303
  - https://github.com/cdubiel08/ralph-hero/issues/304
primary_issue: 291
---

# CLI UX Improvements - Atomic Implementation Plan

## Overview

12 related issues for atomic implementation in a single PR. All are children of #290 (CLI UX improvements) targeting the justfile, shell scripts, and CI/CD workflow.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-304 | _run_skill uses short skill names causing `claude -p` to hang | XS |
| 2 | GH-292 | Add success banner to _run_skill | XS |
| 3 | GH-296 | Improve error messages with "what to do next" suggestions | S |
| 4 | GH-291 | Add [group()] attributes to all justfile recipes | XS |
| 5 | GH-297 | Add common aliases for justfile recipes | XS |
| 6 | GH-295 | Format quick-* output with jq extraction | S |
| 7 | GH-298 | Pin npx version in _mcp_call instead of @latest | S |
| 8 | GH-302 | Add --choose default recipe for interactive fzf selection | XS |
| 9 | GH-303 | Add `quick-draft` CLI recipe for rapid idea capture | XS |
| 10 | GH-293 | Fix `ls -v` portability in ralph-cli.sh for macOS | XS |
| 11 | GH-300 | Fix completions to use cache-based path resolution | XS |
| 12 | GH-294 | Add early-exit for empty work in ralph-loop.sh | XS |

**Why grouped**: All 12 issues are children of #290 (CLI UX improvements), targeting 6 files in the CLI layer (justfile, ralph-cli.sh, ralph-loop.sh, ralph-team-loop.sh, ralph-completions.bash, ralph-completions.zsh) plus the release workflow. Several issues touch overlapping code (GH-304 and GH-292 both modify `_run_skill`; GH-295 and GH-298 both modify `_mcp_call`; GH-293 and GH-300 share the `sort -V` pattern). Implementing atomically avoids merge conflicts and ensures consistency.

## Current State Analysis

The Ralph CLI layer consists of:
- **`plugin/ralph-hero/justfile`** (316 lines): 22 public recipes + 2 private helpers, no grouping/alias/confirm attributes, raw MCP output, short skill names in `_run_skill`, `@latest` version tag in `_mcp_call`
- **`plugin/ralph-hero/scripts/ralph-loop.sh`** (178 lines): Sequential loop with 7 hardcoded short skill names, no early-exit logic, unconditional `work_done=true`
- **`plugin/ralph-hero/scripts/ralph-team-loop.sh`** (53 lines): Team orchestrator with 1 hardcoded short skill name
- **`plugin/ralph-hero/scripts/ralph-cli.sh`** (22 lines): Global CLI with `ls -v` portability bug
- **`plugin/ralph-hero/scripts/ralph-completions.bash`** (12 lines): Legacy hardcoded path
- **`plugin/ralph-hero/scripts/ralph-completions.zsh`** (14 lines): Legacy hardcoded path
- **`plugin/ralph-hero/.mcp.json`** (13 lines): `@latest` version tag
- **`.github/workflows/release.yml`** (147 lines): No version pinning for justfile/.mcp.json

## Desired End State

### Verification
- [ ] `just --list` shows recipes organized into 4 groups: workflow, orchestrate, setup, quick
- [ ] `just --list` shows aliases (t, r, i, s, sp, h, p)
- [ ] `_run_skill` uses fully-qualified `/ralph-hero:ralph-{skill}` names
- [ ] `_run_skill` prints `>>> Completed: $cmd` on success
- [ ] `_run_skill` error messages include "what to do next" suggestions
- [ ] `ralph-loop.sh` uses fully-qualified skill names
- [ ] `ralph-loop.sh` exits early when no work is found
- [ ] `ralph-loop.sh` error messages include recovery suggestions
- [ ] `ralph-team-loop.sh` uses fully-qualified skill name
- [ ] `_mcp_call` extracts inner JSON via `jq` with graceful fallback
- [ ] `_mcp_call` detects `isError` and exits non-zero
- [ ] `_mcp_call` uses pinned version (e.g., `@2.4.50`) instead of `@latest`
- [ ] `.mcp.json` uses pinned version instead of `@latest`
- [ ] `release.yml` auto-updates pinned version on release
- [ ] `default` recipe launches `just --choose` with fzf fallback
- [ ] `quick-draft` recipe creates draft issues via `create_draft_issue` MCP tool
- [ ] `ralph-cli.sh` uses `sort -V` instead of `ls -v`
- [ ] Both completion scripts use cache-based path resolution with `sort -V`
- [ ] All changes pass `just doctor` health check

## What We're NOT Doing
- Not adding `[confirm]` guards (covered by children #307, #308 of umbrella #301)
- Not threading budget through loop scripts (covered by children #305, #306 of umbrella #299)
- Not adding per-recipe `jq` filters for `quick-status` (scope creep -- base extraction is sufficient)
- Not adding `jq` to `doctor` dependency check (optional bonus, out of scope)
- Not upgrading `just` to v1.27+ (users must upgrade themselves; `set min-version` gives clear error)

## Implementation Approach

Phases are ordered to minimize conflicts and build on each other:
1. **P0 bug fix first** (GH-304): Fix the broken skill names that cause hangs -- highest priority, unblocks all LLM recipes
2. **`_run_skill` improvements** (GH-292, GH-296): Restructure the same function for success banner and error messages -- natural to combine since both touch the `timeout claude` block
3. **Justfile structure** (GH-291, GH-297): Add groups and aliases -- cosmetic, no logic changes
4. **`_mcp_call` improvements** (GH-295, GH-298): Format output and pin version -- both modify the same helper
5. **New recipes** (GH-302, GH-303): Add `default` fzf chooser and `quick-draft` -- pure additions
6. **Shell script fixes** (GH-293, GH-300, GH-294): Fix portability, completions, early-exit -- independent scripts

---

## Phase 1: GH-304 - Fix short skill names causing `claude -p` to hang
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/304 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0304-run-skill-short-name-hang.md | **Priority**: P0

### Changes Required

#### 1. Fix `_run_skill` in justfile
**File**: `plugin/ralph-hero/justfile:287-290`
**Changes**: Replace `/ralph-{{skill}}` with `/ralph-hero:ralph-{{skill}}` in both branches of the `if` statement.

Before:
```bash
if [ -n "{{issue}}" ]; then
    cmd="/ralph-{{skill}} {{issue}}"
else
    cmd="/ralph-{{skill}}"
fi
```

After:
```bash
if [ -n "{{issue}}" ]; then
    cmd="/ralph-hero:ralph-{{skill}} {{issue}}"
else
    cmd="/ralph-hero:ralph-{{skill}}"
fi
```

#### 2. Fix `ralph-loop.sh` skill names
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Replace all 7 short skill names with fully-qualified names:
- Line 101: `/ralph-hygiene` -> `/ralph-hero:ralph-hygiene`
- Line 111: `/ralph-triage` -> `/ralph-hero:ralph-triage`
- Line 119: `/ralph-split` -> `/ralph-hero:ralph-split`
- Line 129: `/ralph-research` -> `/ralph-hero:ralph-research`
- Line 138: `/ralph-plan` -> `/ralph-hero:ralph-plan`
- Line 151: `/ralph-review` -> `/ralph-hero:ralph-review`
- Line 161: `/ralph-impl` -> `/ralph-hero:ralph-impl`

#### 3. Fix `ralph-team-loop.sh` skill name
**File**: `plugin/ralph-hero/scripts/ralph-team-loop.sh:31-33`
**Changes**: Replace `/ralph-team` with `/ralph-hero:ralph-team` in both branches.

Before:
```bash
if [ -n "$ISSUE_NUMBER" ]; then
    COMMAND="/ralph-team $ISSUE_NUMBER"
else
    COMMAND="/ralph-team"
fi
```

After:
```bash
if [ -n "$ISSUE_NUMBER" ]; then
    COMMAND="/ralph-hero:ralph-team $ISSUE_NUMBER"
else
    COMMAND="/ralph-hero:ralph-team"
fi
```

### Success Criteria
- [ ] Automated: `grep -r '/ralph-[a-z]' plugin/ralph-hero/justfile plugin/ralph-hero/scripts/ | grep -v '/ralph-hero:' | grep -v '#'` returns empty (no short names remain)
- [ ] Manual: `just triage` no longer hangs (uses fully-qualified name)

**Creates for next phase**: Clean `_run_skill` function ready for success banner and error message improvements.

---

## Phase 2: GH-292 - Add success banner to `_run_skill`
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/292 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0292-success-banner-run-skill.md | **Depends on**: Phase 1 (GH-304)

### Changes Required

#### 1. Restructure `_run_skill` to `if/then/else`
**File**: `plugin/ralph-hero/justfile:292-303`
**Changes**: Replace the `|| { ... }` pattern with `if/then/else` so the success banner only prints on actual success.

After Phase 1 + this phase, `_run_skill` becomes:
```bash
_run_skill skill issue budget timeout:
    #!/usr/bin/env bash
    set -eu
    if [ -n "{{issue}}" ]; then
        cmd="/ralph-hero:ralph-{{skill}} {{issue}}"
    else
        cmd="/ralph-hero:ralph-{{skill}}"
    fi
    echo ">>> Running: $cmd (budget: \${{budget}}, timeout: {{timeout}})"
    if timeout "{{timeout}}" claude -p "$cmd" \
        --max-budget-usd "{{budget}}" \
        --dangerously-skip-permissions \
        2>&1; then
        echo ">>> Completed: $cmd"
    else
        exit_code=$?
        if [ $exit_code -eq 124 ]; then
            echo ">>> Timed out after {{timeout}}"
        else
            echo ">>> Exited with code $exit_code"
        fi
    fi
```

### Success Criteria
- [ ] Manual: Run `just status` -- see `>>> Completed: /ralph-hero:ralph-status` on success
- [ ] Manual: Verify timeout still shows `>>> Timed out after` message
- [ ] Manual: Verify non-zero exit still shows `>>> Exited with code` message

**Creates for next phase**: `if/then/else` structure ready for error message improvements.

---

## Phase 3: GH-296 - Improve error messages with "what to do next" suggestions
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/296 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0296-improve-error-messages-what-to-do-next.md | **Depends on**: Phase 2 (GH-292)

### Changes Required

#### 1. Improve `_run_skill` error messages
**File**: `plugin/ralph-hero/justfile` (within `_run_skill`)
**Changes**: Add indented suggestion lines after each error message, following the existing `doctor` two-line pattern.

Timeout error becomes:
```bash
echo ">>> Timed out after {{timeout}}"
echo "    The skill did not complete within the time limit."
echo "    Try: just {{skill}} timeout=30m   (increase timeout)"
```

Non-zero exit error becomes:
```bash
echo ">>> Exited with code $exit_code"
echo "    Check above for error details from the skill output."
echo "    Common causes: API token expired, budget exhausted, network error."
echo "    Run: just doctor   to diagnose environment issues."
```

#### 2. Improve `ralph-loop.sh` error messages
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh:74-78`
**Changes**: Add context about loop continuation and recovery suggestions.

Timeout becomes:
```bash
echo ">>> Task timed out after $TIMEOUT"
echo "    Continuing to next phase. To increase: TIMEOUT=30m just loop"
```

Non-zero exit becomes:
```bash
echo ">>> Task exited with code $exit_code"
echo "    Continuing to next phase. Check output above for details."
echo "    To diagnose: just doctor"
```

### Success Criteria
- [ ] Manual: Force a timeout with `just triage timeout=1s` -- verify suggestion appears
- [ ] Manual: Error messages follow "what failed + what to do next" pattern

**Creates for next phase**: Polished `_run_skill` function. Justfile structure ready for groups.

---

## Phase 4: GH-291 - Add [group()] attributes to all justfile recipes
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/291 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0291-justfile-group-attributes.md

### Changes Required

#### 1. Add version constraint
**File**: `plugin/ralph-hero/justfile` (line 7, after `set shell`)
**Changes**: Add `set min-version := "1.27.0"` to enforce the minimum `just` version.

#### 2. Add `[group()]` attributes to all 22 public recipes
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add `[group('name')]` attribute above each recipe declaration:

| Group | Recipes |
|-------|---------|
| `workflow` | triage, split, research, plan, review, impl, hygiene, status, report |
| `orchestrate` | team, hero, loop |
| `setup` | setup, doctor, install-cli, uninstall-cli, install-completions, completions |
| `quick` | quick-status, quick-move, quick-pick, quick-assign, quick-issue, quick-info, quick-comment |

The `default` recipe stays ungrouped (it's the entry point).

#### 3. Add `[private]` to helpers
**File**: `plugin/ralph-hero/justfile`
**Changes**: Add `[private]` above `_run_skill` and `_mcp_call` (belt-and-suspenders with `_` prefix).

#### 4. Remove section comment dividers
**File**: `plugin/ralph-hero/justfile`
**Changes**: Remove the `# --- Section Name ---` comment lines since groups replace them:
- Line 14: `# --- Individual Phase Recipes ---`
- Line 48: `# --- Orchestrator Recipes ---`
- Line 67: `# --- Utility Recipes ---`
- Line 233: `# --- Quick Actions (no LLM, requires mcptools) ---`
- Line 276: `# --- Completion & Documentation ---`
- Line 282: `# --- Internal Helpers ---`

### Success Criteria
- [ ] Automated: `just --list` shows recipes grouped under `workflow`, `orchestrate`, `setup`, `quick`
- [ ] Automated: `just --list` does NOT show `_run_skill` or `_mcp_call`
- [ ] Manual: Running on just < 1.27 gives clear version error

**Creates for next phase**: Grouped recipe structure ready for aliases.

---

## Phase 5: GH-297 - Add common aliases for justfile recipes
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/297 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0297-justfile-aliases.md | **Depends on**: Phase 4 (GH-291)

### Changes Required

#### 1. Add alias declarations
**File**: `plugin/ralph-hero/justfile` (after `set` directives, before `default` recipe)
**Changes**: Add 7 aliases for frequently-used recipes:

```just
alias t  := triage
alias r  := research
alias p  := plan
alias i  := impl
alias s  := status
alias sp := split
alias h  := hygiene
```

### Success Criteria
- [ ] Automated: `just t --dry-run 2>&1` succeeds (alias resolves)
- [ ] Automated: `just --list` shows aliases alongside originals
- [ ] Manual: `ralph s` invokes `status` recipe

**Creates for next phase**: Complete justfile structure (groups + aliases).

---

## Phase 6: GH-295 - Format quick-* output with jq extraction
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/295 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0295-format-quick-output-jq-extraction.md

### Changes Required

#### 1. Add jq post-processing to `_mcp_call`
**File**: `plugin/ralph-hero/justfile` (within `_mcp_call`)
**Changes**: Capture `mcp call` output, extract inner JSON via `jq`, detect errors via `isError`, graceful fallback when `jq` unavailable.

```bash
_mcp_call tool params:
    #!/usr/bin/env bash
    set -eu
    if ! command -v mcp &>/dev/null; then
        echo "Error: mcptools not installed."
        echo "Install: brew tap f/mcptools && brew install mcp"
        echo "   or: go install github.com/f/mcptools/cmd/mcptools@latest"
        exit 1
    fi
    raw=$(mcp call "{{tool}}" --params '{{params}}' \
        npx -y ralph-hero-mcp-server@latest)
    if command -v jq &>/dev/null; then
        if echo "$raw" | jq -e '.isError // false' > /dev/null 2>&1; then
            echo "$raw" | jq -r '.content[0].text' >&2
            exit 1
        fi
        echo "$raw" | jq -r '.content[0].text // .' | jq '.' 2>/dev/null \
            || echo "$raw" | jq -r '.content[0].text // .'
    else
        echo "$raw"
    fi
```

### Success Criteria
- [ ] Manual: `just quick-info 291` shows pretty-printed JSON (not wrapped in MCP envelope)
- [ ] Manual: With `jq` unavailable, output falls back to raw MCP JSON
- [ ] Manual: MCP error responses exit non-zero with error text on stderr

**Creates for next phase**: `_mcp_call` ready for version pinning.

---

## Phase 7: GH-298 - Pin npx version in `_mcp_call` instead of @latest
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/298 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0298-pin-npx-version.md | **Depends on**: Phase 6 (GH-295)

### Changes Required

#### 1. Pin version in `_mcp_call`
**File**: `plugin/ralph-hero/justfile` (within `_mcp_call`)
**Changes**: Replace `ralph-hero-mcp-server@latest` with `ralph-hero-mcp-server@2.4.50`.

#### 2. Pin version in `.mcp.json`
**File**: `plugin/ralph-hero/.mcp.json:5`
**Changes**: Replace `ralph-hero-mcp-server@latest` with `ralph-hero-mcp-server@2.4.50`.

#### 3. Extend release workflow to auto-update version
**File**: `.github/workflows/release.yml`
**Changes**: Add a step after "Bump version" (step `version`) to `sed`-replace the pinned version in both files, and add them to the git commit.

Add after the version bump step:
```yaml
- name: Pin version in justfile and .mcp.json
  working-directory: .
  env:
    NEW_VERSION: ${{ steps.version.outputs.new }}
  run: |
    sed -i "s/ralph-hero-mcp-server@[0-9][0-9.]*/ralph-hero-mcp-server@${NEW_VERSION}/g" \
      plugin/ralph-hero/justfile \
      plugin/ralph-hero/.mcp.json
```

Extend the git add in "Commit version bump and tag" step to include:
```yaml
git add plugin/ralph-hero/justfile
git add plugin/ralph-hero/.mcp.json
```

Also add `plugin/ralph-hero/justfile` and `plugin/ralph-hero/.mcp.json` to the `paths` trigger so version-pin changes are included in releases.

### Success Criteria
- [ ] Automated: `grep '@latest' plugin/ralph-hero/justfile plugin/ralph-hero/.mcp.json` returns empty
- [ ] Automated: `grep '@2.4.50' plugin/ralph-hero/justfile plugin/ralph-hero/.mcp.json` matches both files
- [ ] Manual: Verify release.yml sed pattern works: `echo 'ralph-hero-mcp-server@2.4.50' | sed 's/ralph-hero-mcp-server@[0-9][0-9.]*/ralph-hero-mcp-server@2.4.51/'`

**Creates for next phase**: Finalized `_mcp_call` helper.

---

## Phase 8: GH-302 - Add `--choose` default recipe for interactive fzf selection
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/302 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0302-choose-default-recipe-fzf.md

### Changes Required

#### 1. Replace `default` recipe with fzf chooser
**File**: `plugin/ralph-hero/justfile:10-12`
**Changes**: Replace the static `just --list` with an fzf-based chooser that falls back to `--list`.

Before:
```just
# Show available recipes
default:
    @just --list
```

After:
```just
# Browse and run a recipe interactively (falls back to --list without fzf)
default:
    #!/usr/bin/env bash
    if command -v fzf >/dev/null 2>&1; then
        just --choose
    else
        just --list
    fi
```

### Success Criteria
- [ ] Manual: `ralph` with fzf installed shows interactive chooser
- [ ] Manual: `ralph` without fzf shows recipe list (same as before)

---

## Phase 9: GH-303 - Add `quick-draft` CLI recipe for rapid idea capture
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/303 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-quick-draft-cli-command.md

### Changes Required

#### 1. Add `quick-draft` recipe
**File**: `plugin/ralph-hero/justfile` (after `quick-comment`, before completions section)
**Changes**: Add new recipe following the `quick-issue` pattern for optional field handling.

```just
[group('quick')]
# Create a draft issue on the project board (no GitHub issue, just a card)
quick-draft title priority="" estimate="" state="Backlog":
    #!/usr/bin/env bash
    set -eu
    params='{"title":"{{title}}"'
    if [ -n "{{priority}}" ]; then params="$params,\"priority\":\"{{priority}}\""; fi
    if [ -n "{{estimate}}" ]; then params="$params,\"estimate\":\"{{estimate}}\""; fi
    params="$params,\"workflowState\":\"{{state}}\"}"
    just _mcp_call "ralph_hero__create_draft_issue" "$params"
```

### Success Criteria
- [ ] Manual: `just quick-draft "Test idea"` creates a draft issue in Backlog
- [ ] Manual: `just quick-draft "P1 bug" priority=P1 estimate=XS` sets fields correctly
- [ ] Automated: `just --list` shows `quick-draft` in the `quick` group

---

## Phase 10: GH-293 - Fix `ls -v` portability in ralph-cli.sh for macOS
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/293 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0293-ls-v-portability-macos.md

### Changes Required

#### 1. Replace `ls -v` with `sort -V`
**File**: `plugin/ralph-hero/scripts/ralph-cli.sh:11`
**Changes**: Single-line change.

Before:
```bash
LATEST=$(ls -v "$CACHE_DIR" | tail -1)
```

After:
```bash
LATEST=$(ls "$CACHE_DIR" | sort -V | tail -1)
```

### Success Criteria
- [ ] Automated: `grep 'ls -v' plugin/ralph-hero/scripts/ralph-cli.sh` returns empty
- [ ] Automated: `grep 'sort -V' plugin/ralph-hero/scripts/ralph-cli.sh` matches
- [ ] Manual: `ralph --version` (or any command) resolves the correct latest version

**Creates for next phase**: Correct pattern for completions scripts to copy.

---

## Phase 11: GH-300 - Fix completions to use cache-based path resolution
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/300 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0300-completions-cache-path-resolution.md | **Depends on**: Phase 10 (GH-293)

### Changes Required

#### 1. Update bash completions
**File**: `plugin/ralph-hero/scripts/ralph-completions.bash:6`
**Changes**: Replace the single-line legacy path with the cache resolution block.

Before:
```bash
local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
```

After:
```bash
local justfile="${RALPH_JUSTFILE:-}"
if [ -z "$justfile" ]; then
    local cache_dir="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
    if [ -d "$cache_dir" ]; then
        local latest
        latest=$(ls "$cache_dir" | sort -V | tail -1)
        justfile="$cache_dir/$latest/justfile"
    fi
fi
```

#### 2. Update zsh completions
**File**: `plugin/ralph-hero/scripts/ralph-completions.zsh:6`
**Changes**: Same pattern as bash completions.

Before:
```bash
local justfile="${RALPH_JUSTFILE:-$HOME/.config/ralph-hero/justfile}"
```

After:
```bash
local justfile="${RALPH_JUSTFILE:-}"
if [ -z "$justfile" ]; then
    local cache_dir="$HOME/.claude/plugins/cache/ralph-hero/ralph-hero"
    if [ -d "$cache_dir" ]; then
        local latest
        latest=$(ls "$cache_dir" | sort -V | tail -1)
        justfile="$cache_dir/$latest/justfile"
    fi
fi
```

### Success Criteria
- [ ] Automated: `grep '.config/ralph-hero' plugin/ralph-hero/scripts/ralph-completions.*` returns empty
- [ ] Automated: `grep 'sort -V' plugin/ralph-hero/scripts/ralph-completions.bash` matches
- [ ] Manual: After `source ralph-completions.bash`, `ralph <TAB>` shows recipe names

---

## Phase 12: GH-294 - Add early-exit for empty work in ralph-loop.sh
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/294 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0294-early-exit-empty-work-ralph-loop.md

### Changes Required

#### 1. Modify `run_claude` to detect empty queues
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh:63-84`
**Changes**: Capture output, check for "Queue empty" signal, return 1 if no work found.

```bash
run_claude() {
    local command="$1"
    local title="$2"

    echo ">>> Running: $command"
    echo ">>> Timeout: $TIMEOUT"
    echo ""

    local output
    if output=$(timeout "$TIMEOUT" claude -p "$command" --dangerously-skip-permissions 2>&1); then
        echo "$output"
    else
        local exit_code=$?
        echo "$output"
        if [ $exit_code -eq 124 ]; then
            echo ">>> Task timed out after $TIMEOUT"
            echo "    Continuing to next phase. To increase: TIMEOUT=30m just loop"
        else
            echo ">>> Task exited with code $exit_code"
            echo "    Continuing to next phase. Check output above for details."
            echo "    To diagnose: just doctor"
        fi
    fi

    echo ""
    echo ">>> Completed: $command"
    echo ""

    # Return 1 if queue was empty (no work done)
    if echo "$output" | grep -qi "Queue empty"; then
        return 1
    fi
    return 0
}
```

#### 2. Update phase blocks to conditionally set `work_done`
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh`
**Changes**: Change each `run_claude` call to check return value before setting `work_done=true`. Example for triage:

Before:
```bash
run_claude "/ralph-hero:ralph-triage" "triage"
work_done=true
```

After:
```bash
if run_claude "/ralph-hero:ralph-triage" "triage"; then
    work_done=true
fi
```

Apply this pattern to all 7 phase blocks (hygiene, triage, split, research, plan, review, impl). Note: hygiene always reports findings, so it should always set `work_done=true` regardless.

#### 3. Add early-exit check after all phases
**File**: `plugin/ralph-hero/scripts/ralph-loop.sh` (before `sleep 5`)
**Changes**: Break loop when no work found.

```bash
if [ "$work_done" = "false" ]; then
    echo ">>> No work found in any queue. Stopping."
    break
fi

sleep 5
```

### Success Criteria
- [ ] Manual: Run `just loop` on an empty board -- loop exits after 1 iteration instead of 10
- [ ] Manual: Run `just loop` with work available -- loop processes work normally
- [ ] Manual: Error messages include recovery suggestions (from Phase 3)

---

## Integration Testing
- [ ] `just doctor` passes all checks
- [ ] `just --list` shows 4 groups with all recipes correctly organized
- [ ] `just t 42` resolves alias and runs triage (if `just` >= 1.27)
- [ ] `ralph quick-info 291` shows pretty JSON (not MCP envelope)
- [ ] `ralph quick-draft "test"` creates a draft issue
- [ ] `ralph` with no args shows fzf chooser (or list fallback)
- [ ] `ralph-loop.sh` exits early on empty board
- [ ] Tab completions work from cache-installed plugin
- [ ] All 3 script files use fully-qualified skill names

## References
- Research documents:
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0291-justfile-group-attributes.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0292-success-banner-run-skill.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0293-ls-v-portability-macos.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0294-early-exit-empty-work-ralph-loop.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0295-format-quick-output-jq-extraction.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0296-improve-error-messages-what-to-do-next.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0297-justfile-aliases.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0298-pin-npx-version.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0300-completions-cache-path-resolution.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0302-choose-default-recipe-fzf.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-quick-draft-cli-command.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-21-GH-0304-run-skill-short-name-hang.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/290
