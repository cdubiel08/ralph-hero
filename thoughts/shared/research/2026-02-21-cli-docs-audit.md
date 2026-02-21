---
date: 2026-02-21
status: complete
type: research
---

# CLI Documentation Audit: docs/cli.md vs Justfile

## Problem Statement

Audit the CLI documentation against the actual justfile implementation to identify gaps — features documented but not implemented, and features implemented but not documented.

## Findings

### Documented and Working (No Issues)

All phase recipes, orchestrators, utility recipes (`setup`, `report`, `completions`), tab completion instructions, and the alias-based global access pattern are accurately documented and work as expected.

### Implemented but NOT Documented

These recipes exist in the justfile but are missing from `docs/cli.md`:

1. **`doctor`** — Diagnoses setup issues: checks env vars, dependencies, plugin manifest validity, and API connectivity via mcptools. Already in justfile lines 78-159.

2. **`quick-status`** — Instant pipeline dashboard (no LLM, requires mcptools)
3. **`quick-move`** — Move issue to workflow state
4. **`quick-pick`** — Find next actionable issue by state
5. **`quick-assign`** — Assign issue to GitHub user
6. **`quick-issue`** — Create issue with project fields
7. **`quick-info`** — Get full issue details
8. **`quick-comment`** — Add comment to issue

All `quick-*` recipes use mcptools (`mcp call`) to invoke MCP server tools directly — zero LLM cost, instant results.

### Documented but NOT Implemented (Phantom Features)

None found. The current docs are conservative and accurate for what they cover.

### Previously Planned but Never Merged

Research docs and commit history reference these features that were planned but never landed:

- `install-cli` / `uninstall-cli` recipes — global `ralph` command via symlink
- `ralph-cli.sh` wrapper script
- `ralph-completions.bash` / `ralph-completions.zsh` — custom completion scripts
- `install-completions` recipe

These exist only in planning documents, not in the codebase.

## Recommended Actions

1. **Add `doctor` section** to `docs/cli.md` under Utility Recipes
2. **Add Quick Actions section** to `docs/cli.md` documenting all `quick-*` recipes with mcptools prerequisite
3. **Create issue** for the planned-but-unimplemented global CLI access features (`install-cli`, wrapper script, custom completions)
