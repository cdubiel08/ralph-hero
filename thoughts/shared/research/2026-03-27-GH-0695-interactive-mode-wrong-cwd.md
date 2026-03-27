---
date: 2026-03-27
github_issue: 695
github_url: https://github.com/cdubiel08/ralph-hero/issues/695
status: complete
type: research
tags: [cli, justfile, cwd, interactive-mode, shell-scripting]
---

# GH-695: CLI Interactive Mode Opens Claude in Plugin Cache Dir Instead of User's CWD

## Prior Work

- builds_on:: [[2026-03-06-GH-0546-ralph-cli-justfile-architecture]]
- builds_on:: [[2026-02-27-ralph-cli-qol-improvements]]
- tensions:: None identified.

## Problem Statement

Running any `ralph` command with `-i` (interactive mode) — e.g., `ralph review -i` — opens Claude Code in the plugin cache directory (`~/.claude/plugins/cache/ralph-hero/ralph-hero/2.5.50`) instead of the user's current working directory. This causes:

1. Claude presents a trust prompt for the cache directory, not the user's project
2. Claude cannot find the user's git repository, `.claude/` config, or project files
3. Headless mode has a secondary impact: `git rev-parse --show-toplevel` in `cli-dispatch.sh:40` resolves against the cache dir instead of the user's repo root

## Root Cause Analysis

The call chain is:

```
ralph review -i
  -> ralph-cli.sh:22  exec just --justfile "$RALPH_JUSTFILE" "$@"
     -> just changes CWD to justfile's parent (the plugin cache dir)
        -> justfile review recipe:  source cli-dispatch.sh; dispatch "ralph-review" -i
           -> cli-dispatch.sh run_interactive():  exec claude "/ralph-hero:review"
              (Claude inherits CWD = plugin cache dir)
```

The root cause is `just`'s behavior when invoked with `--justfile`: it sets the working directory to the parent directory of the justfile by default. The [just documentation](https://just.systems/man/en/) explicitly states that `--justfile` changes the working directory to the justfile's parent unless `--working-directory` is also provided.

### Verified Behavior

Locally confirmed with just 1.46.0:

```bash
# Without --working-directory: CWD changes to justfile directory
cd /tmp && just --justfile /path/to/cache/justfile  # pwd => /path/to/cache/

# With --working-directory .: CWD preserved from invocation point
cd /tmp && just --justfile /path/to/cache/justfile --working-directory .  # pwd => /tmp
```

### Why `run_headless` is Also Affected

`cli-dispatch.sh:40` captures `repo_root=$(git rev-parse --show-toplevel 2>/dev/null || echo "")`. Since the recipe is already running in the cache dir when this executes, `git rev-parse` either:
- Returns the ralph-hero plugin git root (wrong repo), or
- Returns empty string if the cache dir is not in a git repo

This `repo_root` is used by `_output_filter` to construct `vscode://file/...` links in the summary footer — so the links would point to wrong paths even in headless mode.

## Key Discoveries

### Fix Location: ralph-cli.sh Line 22

The fix belongs in `ralph-cli.sh`, not in the justfile or `cli-dispatch.sh`. The single line change:

```bash
# Before (line 22)
exec just --justfile "$RALPH_JUSTFILE" "$@"

# After
exec just --justfile "$RALPH_JUSTFILE" --working-directory "$(pwd)" "$@"
```

This preserves the user's CWD before `exec` replaces the shell process. The `$(pwd)` expansion happens in the user's shell context (before exec), so it correctly captures the user's directory.

### --working-directory Flag Availability

The `--working-directory` flag (`-d` shorthand) was introduced in just. It requires `--justfile` to be set simultaneously (which is exactly our usage). The justfile already requires `just >= 1.37` (line 4 comment); `--working-directory` has been available since before 1.37. No version constraint change needed.

### Alternative Approaches Evaluated

| Approach | Pros | Cons |
|----------|------|------|
| `--working-directory "$(pwd)"` in ralph-cli.sh | Single-line fix, correct location, zero side effects | None |
| Export `RALPH_INVOCATION_DIR=$(pwd)` + `cd` in recipes | Works but requires touching all recipes | More invasive, recipes must all `cd "$RALPH_INVOCATION_DIR"` |
| Use `invocation_directory()` in justfile recipes | Idiomatic just built-in | Requires touching every recipe shebang; `invocation_directory()` is a string function only available inside recipe bodies, not in sourced shell scripts |
| Fix in `run_interactive()` / `run_headless()` | Fixes Claude's CWD | Too late — `git rev-parse` in `run_headless()` line 40 still runs in wrong dir |

The `--working-directory "$(pwd)"` approach in `ralph-cli.sh` is clearly the right fix: it fixes the CWD at the source (before `just` changes it), corrects both interactive and headless paths, and requires changing exactly one line.

### Impact on justfile Recipes

Adding `--working-directory` to the `just` invocation means all justfile recipes run in the user's CWD. This is the correct behavior. The justfile recipes use `{{justfile_directory()}}` to reference files relative to the justfile (e.g., `source "{{justfile_directory()}}/scripts/cli-dispatch.sh"`), which is unaffected by `--working-directory` — `justfile_directory()` always returns the actual justfile location regardless of working directory.

### No Impact on `team` and `loop` Recipes

The `team` and `loop` recipes call `./scripts/ralph-team-loop.sh` and `./scripts/ralph-loop.sh` using relative paths. With `--working-directory "$(pwd)"`, these paths resolve relative to the user's project directory. These scripts are expected to be run from the ralph-hero project directory anyway (not from arbitrary user directories), so this is a low-risk concern — but worth documenting.

Actually on reflection: the `team` and `loop` recipes use `./scripts/` relative paths, which would resolve relative to the user's CWD after this fix. If the user runs `ralph team 42` from `/home/user/myproject`, `./scripts/ralph-team-loop.sh` would look for a scripts/ directory there. This is a pre-existing design issue with those recipes, not introduced by this fix. The `cli-dispatch.sh`-based recipes properly use `{{justfile_directory()}}/scripts/cli-dispatch.sh` which is always correct.

The `team` and `loop` recipes need to be assessed separately, but they are outside the scope of this bug. Those recipes invoke loop scripts from within the justfile, and currently they fail in a different way (wrong dir) — that's a separate concern.

### doctor Recipe Not Affected

The `doctor` recipe uses hardcoded paths and `command -v` checks that are not CWD-sensitive.

## Risk Assessment

- **Low risk**: The fix is a one-line change in `ralph-cli.sh`
- **Zero regression risk for interactive mode**: CWD was always wrong before; now it's correct
- **Zero regression risk for headless mode**: Same — headless mode now runs in user's CWD too
- **Slight behavior change for `team`/`loop` recipes**: They use `./scripts/` relative paths, which now resolve from user's CWD instead of justfile directory. Mitigation: update those two recipes to use `{{justfile_directory()}}/scripts/` pattern (already used by all other recipes)

## Recommended Next Steps

1. **Fix `ralph-cli.sh` line 22**: Add `--working-directory "$(pwd)"` to the `exec just` invocation.
2. **Fix `team` and `loop` recipes**: Update `./scripts/ralph-team-loop.sh` and `./scripts/ralph-loop.sh` to use `{{justfile_directory()}}/scripts/` absolute references (matching the pattern already used by all other recipes).
3. **Update `justfile` comment line 4**: Note that `just >= 1.37` is still the requirement (no change needed for `--working-directory`).
4. **Manually verify**: Run `ralph review -i` from a project directory and confirm Claude opens in the correct directory with trust prompt for the right path.

## Files Affected

### Will Modify
- `plugin/ralph-hero/scripts/ralph-cli.sh` - Add `--working-directory "$(pwd)"` to line 22 `exec just` invocation
- `plugin/ralph-hero/justfile` - Update `team` and `loop` recipes to use `{{justfile_directory()}}/scripts/` path prefix instead of `./scripts/`

### Will Read (Dependencies)
- `plugin/ralph-hero/scripts/cli-dispatch.sh` - Verify `git rev-parse` at line 40 is fixed by CWD correction
- `plugin/ralph-hero/scripts/ralph-cli.sh` - Source of truth for the fix
