---
date: 2026-02-26
github_issue: 410
github_url: https://github.com/cdubiel08/ralph-hero/issues/410
status: complete
type: research
---

# GH-410: Justfile Shebang Recipes Fail with Permission Denied on WSL2

## Problem Statement

Running `ralph` CLI commands via the justfile on WSL2 fails with:

```
error: Recipe `_run_skill` with shebang `#!/usr/bin/env bash` execution error: Permission denied (os error 13)
error: Recipe `hero` failed on line 81 with exit code 1
```

This affects all workflow recipes (`ralph hero`, `ralph triage`, `ralph research`, etc.) because they all delegate to the `_run_skill` private recipe, which uses a shebang. Additionally, the `ralph issue` command fails because no `issue` recipe exists.

## Root Cause

When `just` runs a shebang recipe (`#!/usr/bin/env bash`), it:
1. Writes the recipe body to a **temporary file**
2. Marks that file **executable** (`chmod +x`)
3. **Executes the file directly** — the OS resolves the shebang

The temp directory priority chain is: `JUST_TEMPDIR` env var > `set tempdir` directive > `XDG_RUNTIME_DIR` > `/tmp`.

**WSL2 2.5.7+ mounts `XDG_RUNTIME_DIR` (typically `/run/user/1000`) with the `noexec` flag** as a side effect of GUI application support. When `just` tries to execute a script from that directory, the kernel refuses with `EACCES` (Permission Denied, os error 13).

This is distinct from inline (non-shebang) recipes, which pass each line directly as `bash -c "..."` — no temp file is written, so the `noexec` mount does not apply.

**References**: casey/just issues [#2702](https://github.com/casey/just/issues/2702), [#2719](https://github.com/casey/just/issues/2719), [#2857](https://github.com/casey/just/issues/2857)

## Current State Analysis

### Justfile Location
`plugin/ralph-hero/justfile` (375 lines)

### Global Shell Directive
**`plugin/ralph-hero/justfile:7`**: `set shell := ["bash", "-euc"]`

This applies bash to all recipes that do NOT use a shebang. Recipes with explicit shebangs bypass this and use the temp-file-execute path instead.

### Shebang Recipes (Affected)

| Recipe | Line | Impact |
|--------|------|--------|
| `_run_skill` | 327 | **Critical** — called by all workflow recipes |
| `loop` | 85 | Orchestration loop |
| `doctor` | 100 | Environment diagnostic |
| `install-cli` | 185 | CLI installer |
| `uninstall-cli` | 212 | CLI uninstaller |
| `install-completions` | 236 | Shell completions installer |
| `quick-issue` | 292 | Create GitHub issue |
| `quick-draft` | 316 | Create draft issue |
| `_mcp_call` | 354 | MCP tool invocation |
| `default` | 20 | Interactive recipe picker |

### Non-Shebang Recipes (Unaffected)

**`plugin/ralph-hero/justfile:30-81`** — All primary workflow recipes use `@just _run_skill` delegation (single-line, no shebang):

```just
triage issue="" budget="1.00" timeout="15m":
    @just _run_skill "triage" "{{issue}}" "{{budget}}" "{{timeout}}"
```

These are not directly affected, but they call `_run_skill` which IS affected.

**`plugin/ralph-hero/justfile:268-312`** — `quick-status`, `quick-move`, `quick-pick`, `quick-assign`, `quick-info`, `quick-comment` all use `@just _mcp_call` delegation (single-line). They call `_mcp_call` which IS affected.

### Missing `issue` Recipe

There is no `issue` recipe. The closest equivalents are:
- `quick-info issue:` (line 304) — fetches issue details via `ralph_hero__get_issue`
- `quick-issue title ...:` (line 292) — creates a new issue via `ralph_hero__create_issue`

The user likely expected `ralph issue 410` to fetch issue details.

## Key Discoveries

### Discovery 1: `set tempdir` is the Minimal Fix

Adding `set tempdir := "/tmp"` to the top of the justfile redirects temp file creation to `/tmp`, which is always mounted executable on Linux (including WSL2). This is a one-line source-controlled fix that requires no user environment changes.

**`/tmp` on WSL2** is a Linux-native in-memory filesystem with exec permissions — confirmed safe by just maintainer.

### Discovery 2: `[script]` Attribute Eliminates the Problem Architecturally

`just` 1.33.0+ added a `[script]` attribute. Unlike shebang recipes, `[script]` recipes **pass the temp file as an argument to the interpreter** rather than executing it directly. Since the interpreter binary (`bash`) is the thing being executed — not the temp file — the `noexec` mount flag is irrelevant.

```just
set script-interpreter := ["bash", "-euo", "pipefail"]

[script]
_run_skill skill issue budget timeout:
    if [ -n "{{issue}}" ]; then ...
```

This is the architecturally clean solution but requires `just >= 1.33.0`. Prior research (`thoughts/shared/research/2026-02-21-GH-0291-justfile-group-attributes.md`) found the installed version was 1.21.0 — need to verify current version.

### Discovery 3: `JUST_TEMPDIR` Env Var as User-Space Workaround

Users can set `export JUST_TEMPDIR=/tmp` in their shell profile as an immediate workaround without any code change. This should be documented in `doctor` output and in README/docs.

### Discovery 4: `_mcp_call` Shebang Can Be Eliminated

`_mcp_call` uses a shebang recipe primarily for multi-line conditional logic. This could be converted to a non-shebang recipe by restructuring with `&&` chaining and `set shell` handling — but it's complex enough that `set tempdir` is the simpler fix.

### Discovery 5: No Prior WSL2 Research

The `thoughts/shared/research/` directory has no prior research on WSL2 shebang issues specifically. The closest relevant docs are `2026-02-21-GH-0279-global-cli-access-shell-shortcut.md` (notes "WSL works via the bash script") and `2026-02-21-GH-0291-justfile-group-attributes.md` (version compatibility concerns).

## Potential Approaches

### Approach A: Add `set tempdir := "/tmp"` (Recommended for Quick Fix)

**Change**: Add one line near the top of the justfile.

```just
set shell := ["bash", "-euc"]
set dotenv-load
set tempdir := "/tmp"          # ← add this
```

**Pros**:
- One-line change, minimal risk
- Immediately fixes all affected recipes
- Source-controlled — no user action required
- Works for current just version (1.21+)
- No behavioral changes to recipe logic

**Cons**:
- `/tmp` is not preserved across reboots (minor, temp files are ephemeral anyway)
- Does not address the underlying architecture (shebangs still used)

### Approach B: Convert `_run_skill` and `_mcp_call` to `[script]` Attribute

**Change**: Replace shebang with `[script]` attribute, set `set script-interpreter`.

**Pros**:
- Architecturally eliminates the problem permanently
- Uses modern just feature designed for this exact use case
- Works even if `/tmp` has issues

**Cons**:
- Requires `just >= 1.33.0` (current may be 1.21.0 — would need version bump)
- Requires changing ~10 recipes
- Risk of subtle behavioral differences

### Approach C: Document `JUST_TEMPDIR=/tmp` Workaround Only

**Change**: Add to `doctor` output and docs.

**Pros**:
- No code change to justfile

**Cons**:
- Requires user action on every machine
- Poor DX — issue should be fixed in the tool, not the user's shell

### Approach D: Convert Shebang Recipes to Non-Shebang (Inline)

**Change**: Rewrite each shebang recipe to use bash one-liners with `&&` chaining.

**Pros**:
- Eliminates shebangs entirely

**Cons**:
- Highly invasive — 10 recipes to rewrite
- `_run_skill` and `doctor` have complex conditional logic that's difficult to express inline
- Significantly increases risk of behavioral regressions
- Readability decreases

## Risks

1. **just version**: `set tempdir` was added in just 1.3.0 (very old). No risk there. `[script]` attribute requires 1.33.0.
2. **`/tmp` space**: Extremely unlikely to be an issue for small recipe scripts.
3. **Other `noexec` filesystems**: If someone has `/tmp` also mounted `noexec`, Approach A would still fail. Approach B (`[script]`) would not.
4. **Missing `issue` alias**: Adding a new recipe is zero-risk.

## Recommended Next Steps

1. **Primary fix**: Add `set tempdir := "/tmp"` to `plugin/ralph-hero/justfile` (line ~9, after existing `set` directives)
2. **Add `issue` alias**: Add `issue` as an alias for `quick-info` or add an `issue` recipe that accepts a number and fetches it
3. **Update `doctor`**: Add a WSL2 shebang diagnostic check — verify `just --show-dump-directory` output is on an exec-mounted filesystem, warn if not, and mention `JUST_TEMPDIR=/tmp` as a fallback
4. **Document in README**: Add a WSL2 troubleshooting note with the `JUST_TEMPDIR=/tmp` workaround for users on older just versions
5. **Future consideration**: Migrate to `[script]` attribute once just version requirement can be bumped to 1.33.0+

## Files Affected

### Will Modify
- `plugin/ralph-hero/justfile` - Add `set tempdir := "/tmp"` directive; add `issue` recipe alias

### Will Read (Dependencies)
- `plugin/ralph-hero/justfile` - Full recipe list and existing `set` directives (lines 1-15)
- `plugin/ralph-hero/scripts/ralph-cli.sh` - CLI wrapper script (ensure it doesn't override TMPDIR in a breaking way)
- `thoughts/shared/research/2026-02-21-GH-0291-justfile-group-attributes.md` - Prior justfile version research
- `thoughts/shared/research/2026-02-21-GH-0279-global-cli-access-shell-shortcut.md` - Prior CLI access research
