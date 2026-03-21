---
date: 2026-03-19
github_issue: 631
github_url: https://github.com/cdubiel08/ralph-hero/issues/631
status: complete
type: research
tags: [cli, justfile, shell-quoting, bash]
---

# GH-631: CLI unquoted `{{args}}` in justfile recipes breaks on shell metacharacters

## Prior Work

- GH-0251 (`2026-02-21-GH-0251-justfile-llm-powered-recipes.md`): introduced the shebang-recipe pattern with `*args` and `dispatch`.
- GH-0546 (`2026-03-06-GH-0546-ralph-cli-justfile-architecture.md`): documents the cli-dispatch.sh architecture.
- GH-0410 (`2026-02-26-GH-0410-justfile-shebang-wsl2-permission-denied.md`): prior justfile shebang investigation.

## Problem Statement

When users pass CLI arguments containing shell metacharacters (specifically single quotes), the just template expands `{{args}}` as a raw string into the generated bash script body. Since the expansion happens before bash parses the script, a single quote in an argument creates a syntax error.

Reported error:
```
/tmp/just-2ZR2ab/research: line 54: unexpected EOF while looking for matching '\''
```

Example trigger: `ralph research "fix shouldn't crash"` or `just research "shouldn't"`

## Current State

All 11 workflow recipes follow this pattern (`plugin/ralph-hero/justfile`):

```bash
research *args:
    #!/usr/bin/env bash
    set -eu
    source "{{justfile_directory()}}/scripts/cli-dispatch.sh"
    DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
    INTERACTIVE_SKILL="research"
    dispatch "ralph-research" {{args}}    # <-- BUG HERE
```

The 11 affected recipes (lines in justfile):
- `triage` (line 35)
- `split` (line 44)
- `research` (line 54)
- `plan` (line 64)
- `review` (line 73)
- `impl` (line 83)
- `hygiene` (line 93)
- `status` (line 103)
- `report` (line 112)
- `hero` (line 126)
- `setup` (line 145)

Recipes that do NOT use `*args`/`dispatch` and are not affected:
- `team` (line 116): uses named params `issue=""`, `budget`, `timeout` — always safe integers/strings
- `loop` (line 130): uses named params with controlled enum-like values
- `quick-*` recipes: use named params, not variadic
- `doctor`, `install-cli`, etc.: no user args passed to shell

## Key Discoveries

### How just interpolates `*args` in shebang recipes

File: `plugin/ralph-hero/justfile:7` — `set shell := ["bash", "-euc"]`
File: `plugin/ralph-hero/justfile:30-35` — example recipe

Just's `*args` variadic parameter collects all extra CLI arguments as a single space-joined string. When `{{args}}` appears in a shebang recipe (one starting with `#!/usr/bin/env bash`), just writes that string literal directly into the temp script file before bash ever sees it.

For `just research "shouldn't"`:
- just writes: `dispatch "ralph-research" shouldn't`
- bash fails to parse: `shouldn't` contains an unmatched single quote

Verified with `just --dry-run research "shouldn't":
```bash
#!/usr/bin/env bash
set -eu
source ".../cli-dispatch.sh"
DEFAULT_BUDGET=2.00 DEFAULT_TIMEOUT=15m
INTERACTIVE_SKILL="research"
dispatch "ralph-research" shouldn't   # <- unmatched quote, bash parse fails
```

### How `just quote()` works

`just` >= 1.37 provides a `quote()` function that shell-escapes a string using POSIX single-quote syntax. `{{quote(args)}}` transforms `shouldn't` into `'shouldn'\''t'` — a valid shell token sequence that bash CAN parse.

Verified: bash correctly handles `'shouldn'\''t'` as a literal assignment — this is standard POSIX quoting.

### The split-args problem with `"{{args}}"`

Wrapping in double quotes — `dispatch "ralph-research" "{{args}}"` — does NOT work for multi-argument invocations. For `just research 631 --budget=5.00`, bash receives:
```bash
dispatch "ralph-research" "631 --budget=5.00"   # ONE argument instead of TWO
```
`parse_mode` in `cli-dispatch.sh:13` iterates `"$@"`, so it would receive `"631 --budget=5.00"` as a single token and fail to detect `--budget=5.00` as a flag.

### The correct fix: `_args={{quote(args)}}` + `set -- $_args`

Tested pattern (confirmed working with just 1.47.1):

```bash
_args={{quote(args)}}
set -- $_args
dispatch "ralph-X" "$@"
```

This works because:
1. `{{quote(args)}}` produces a properly shell-escaped string, e.g. `'631' '--budget=5.00'` or `'shouldn'\''t'`
2. Just writes this as a safe literal into the temp file
3. bash parses it correctly as an assignment
4. `set -- $_args` re-establishes the positional parameters by word-splitting the already-quoted shell words
5. `"$@"` expands each arg as a separate word

Tested results (all pass):

| Input | `$#` | Args received by dispatch |
|-------|------|--------------------------|
| `research 631` | 1 | `[631]` |
| `research 631 --budget=5.00` | 2 | `[631]` `[--budget=5.00]` |
| `research 631 -i` | 2 | `[631]` `[-i]` |
| `research` (empty) | 0 | (none) |
| `research "shouldn't"` | 1 | `[shouldn't]` |

### How args flow through cli-dispatch.sh

File: `plugin/ralph-hero/scripts/cli-dispatch.sh`

```
dispatch(skill, ...args)         # line 146
  -> parse_mode(...args)         # line 148 — splits flags vs ARGS array
      -i/--interactive -> MODE=interactive
      -q/--quick       -> MODE=quick
      --budget=*       -> BUDGET=value
      --timeout=*      -> TIMEOUT=value
      *                -> ARGS+=("$arg")  # issue number or free-form text
  -> run_headless(skill, "${ARGS[@]}")   # line 151
       or run_interactive(...)           # line 152
```

In `run_headless` (line 34-72) and `run_interactive` (line 25-31), the remaining `ARGS` are appended to the claude command string:
```bash
cmd="/ralph-hero:${skill}"
if [ $# -gt 0 ] && [ -n "$1" ]; then cmd="$cmd $*"; fi
```

So the args ultimately become part of a prompt string passed to `claude -p "..."`. Single quotes in the issue number/description could also break this — but that is a separate issue (the claude invocation) and is not addressed here.

## Fix Analysis

### Recommended Fix

Replace every `dispatch "ralph-X" {{args}}` with the two-line preamble + quoted expansion:

```bash
_args={{quote(args)}}
set -- $_args
dispatch "ralph-X" "$@"
```

This is mechanical, applies identically to all 11 recipes, and has been verified to:
- Preserve flag parsing (`--budget=`, `--timeout=`, `-i`, `-q`)
- Handle empty args correctly (0 positional params)
- Handle single-arg issue numbers
- Handle args containing single quotes, double quotes, backslashes, and other shell metacharacters

### Rejected Alternatives

**Option A: `dispatch "ralph-research" "{{args}}"`**
Breaks multi-arg: `631 --budget=5.00` becomes one token. Flags stop working.

**Option B: `dispatch "ralph-research" {{quote(args)}}`**
`quote(args)` quotes ALL args as ONE string. Same breakage as Option A for multi-arg cases.

**Option C: `set -- {{quote(args)}}; dispatch ... "$@"`**
`set -- {{quote(args)}}` won't work because `{{quote(args)}}` produces a single quoted string — `set` would see it as one argument. The intermediate variable assignment is required.

**Option D: `eval "dispatch 'ralph-X' $_args"` after `_args={{quote(args)}}`**
Eval re-expands `$_args` after it has already been unquoted by the assignment. For `shouldn't`, `_args` contains the literal value `shouldn't`, and `eval "set -- $shouldn't"` fails. The `set --` approach avoids eval entirely.

## Files Affected

### Will Modify

- `plugin/ralph-hero/justfile` — 11 recipes, each changing one line (the `dispatch` call) and adding two lines above it

### Will Read (no changes)

- `plugin/ralph-hero/scripts/cli-dispatch.sh` — confirms `parse_mode` uses `"$@"` and array-safe expansion throughout
- `plugin/ralph-hero/scripts/ralph-cli.sh` — passes args through `exec just --justfile "$RALPH_JUSTFILE" "$@"` (safe, no changes needed)
