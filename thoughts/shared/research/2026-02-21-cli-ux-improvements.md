---
date: 2026-02-21
status: complete
type: research
---

# CLI UX Improvements Research

## Problem Statement

The ralph CLI (justfile + wrapper) works but has rough edges: flat `just --list` with no grouping, raw JSON output from `quick-*` commands, no success confirmation from LLM recipes, inconsistent feedback across layers, and several portability issues.

## Current Architecture

```
ralph (wrapper) -> just --justfile -> _run_skill (claude -p) or _mcp_call (mcp call)
                                   -> ralph-loop.sh (multi-phase)
                                   -> ralph-team-loop.sh (single-shot)
```

## Findings

### 1. Discoverability: `just --list` is a flat wall of text

`just --list` shows 20+ recipes in declaration order with no visual grouping. The justfile has section comments (`# --- Individual Phase Recipes ---`) but these don't appear in the output. Users can't distinguish phases from orchestrators from utilities from quick actions.

**Fix**: Use `[group()]` attributes (just v1.27+). Proposed taxonomy:

| Group | Recipes |
|-------|---------|
| `workflow` | triage, split, research, plan, review, impl |
| `orchestrate` | hero, team, loop |
| `board` | status, hygiene, report |
| `quick` | quick-status, quick-move, quick-pick, quick-assign, quick-issue, quick-info, quick-comment |
| `setup` | setup, doctor, install-cli, uninstall-cli, install-completions, completions |

This transforms `just --list` from 25 flat lines into grouped sections. Also add `[private]` to `_run_skill` and `_mcp_call` (the `_` prefix already hides them, but explicit is better).

### 2. Feedback: No success confirmation from `_run_skill`

`_run_skill` prints a start banner (`>>> Running: ...`) but no completion banner on success. Compare to `ralph-loop.sh`'s `run_claude` which prints `>>> Completed: $command`. Users don't know when a recipe finished vs when the terminal just stopped outputting.

**Fix**: Add a success line after the `claude` call:

```bash
echo ">>> Completed: $cmd"
```

### 3. Output: `quick-*` recipes dump raw MCP JSON

`_mcp_call` passes MCP tool responses directly to stdout — unformatted JSON blobs. For `quick-status` (pipeline dashboard) this is especially bad since the tool returns a structured markdown report buried in JSON.

**Fix options** (ranked by effort):
1. **Pipe through `jq`** to extract the content field: `mcp call ... | jq -r '.content[0].text // .'` — requires jq dependency
2. **Add a `--format` param** to quick recipes: `json` (default, raw) or `text` (extracted)
3. **Use `node -e`** inline to extract — already a dependency, no new install

Recommended: Option 1 (jq) with a fallback to raw output. `jq` is nearly universal and already expected by developers who use CLI tools.

### 4. Error messages: Inconsistent and sometimes unhelpful

| Layer | Error Quality |
|-------|--------------|
| `ralph-cli.sh` (justfile not found) | OK — gives install command, but doesn't say *why* not found |
| `_mcp_call` (mcptools missing) | Good — two install options |
| `_run_skill` (timeout) | Minimal — `>>> Timed out after 15m` with no suggestion |
| `_run_skill` (other failure) | Bad — `>>> Exited with code 1` with no context |
| `doctor` (API health check) | Bad — raw MCP output inline with `FAIL:` text |

**Fix**: Every error should follow the pattern: **what failed** + **why** + **what to do next**. Example for timeout:

```
>>> Timed out after 15m
    The skill did not complete within the budget.
    Try: ralph research 42 timeout=30m
```

### 5. Portability: `ls -v` doesn't work on macOS

`ralph-cli.sh` line 11 uses `ls -v` (GNU version sort). On macOS, `ls -v` means "force non-printable characters to display" — completely different behavior. The version resolution breaks silently, picking an arbitrary directory.

**Fix**: Replace with `sort -V`:
```bash
LATEST=$(ls "$CACHE_DIR" | sort -V | tail -1)
```
`sort -V` is available on both GNU coreutils and macOS (since Monterey). Or use a pure-bash semver comparison.

### 6. Budget: Loop scripts don't enforce per-phase budgets

`ralph-loop.sh` calls `claude -p` without `--max-budget-usd`. A single phase can consume unlimited API cost. `ralph-team-loop.sh` has the same issue.

**Fix**: Thread the budget through, or add a `BUDGET` env var with sensible defaults per phase.

### 7. Loop: `work_done` flag is set but never read

In `ralph-loop.sh`, `work_done` is set to `true` whenever a phase runs but no logic checks it. The loop always runs `MAX_ITERATIONS` regardless of whether any work was done. This means it spins for 10 iterations even when the board is empty.

**Fix**: Break the loop when `work_done` remains `false` after a full cycle:
```bash
if [ "$work_done" = "false" ]; then
    echo ">>> No work found. Stopping."
    break
fi
```

### 8. npx cold start on every `quick-*` call

Each `_mcp_call` runs `npx -y ralph-hero-mcp-server@latest`, starting a fresh Node process. For rapid-fire usage (`quick-info 42`, `quick-move 42 "In Progress"`, `quick-comment 42 "done"`), this adds 2-3s startup overhead per call.

**Fix options**:
1. **Use a persistent MCP server** via `mcp` stdio mode with a long-lived process
2. **Cache the npx download** — already happens after first call, but `@latest` forces a freshness check each time. Pin to a version or use `@^2` for cached resolution
3. **Accept the latency** — these are still sub-5s and "instant" compared to LLM calls

Recommended: Change `@latest` to the current version (e.g., `@2.4.50`) so npx uses its cache. The release workflow can auto-update this.

### 9. Advanced just features to adopt

| Feature | Benefit | Minimum just version |
|---------|---------|---------------------|
| `[group('name')]` | Grouped `--list` output | v1.27 |
| `[confirm('msg')]` | Guard destructive recipes (e.g., `uninstall-cli`) | v1.29 |
| `[doc('text')]` | Machine-queryable docs via `--dump --dump-format json` | v1.30 |
| `alias t := triage` | Short aliases for common recipes | v0.3 (old) |
| `[default]` with `--choose` | fzf-based interactive chooser | v1.9 |

### 10. Completions: Legacy path reference

`ralph-completions.bash` line 6 falls back to `$HOME/.config/ralph-hero/justfile` — the legacy symlink path. Should reference the cache path or use the same resolution logic as `ralph-cli.sh`.

## Prioritized Recommendations

### Quick wins (XS each)
1. Add `[group()]` attributes to all recipes — transforms discoverability
2. Add success banner to `_run_skill`
3. Fix `ls -v` portability in `ralph-cli.sh`
4. Add early-exit for empty work in `ralph-loop.sh`

### Small improvements (S each)
5. Format `quick-*` output with `jq` extraction
6. Improve error messages with "what to do next" suggestions
7. Add common aliases (`t` for triage, `r` for research, `i` for impl, `s` for status)
8. Pin npx version in `_mcp_call` instead of `@latest`

### Medium improvements (M)
9. Thread budget through loop scripts
10. Fix completions to use cache-based path resolution
11. Add `[confirm]` guards to destructive recipes
12. Add `--choose` default recipe for interactive fzf selection
