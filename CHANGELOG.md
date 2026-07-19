# Changelog

All notable changes to this repo are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This repo ships **two independently-versioned artifacts**, each released
automatically on merge to `main` (see [CONTRIBUTING.md](https://github.com/cdubiel08/ralph-hero/blob/main/CONTRIBUTING.md) § Releases):

- **`ralph`** — the Claude Code plugin. Tags: `ralph-vX.Y.Z` (via `release-ralph.yml`).
- **`ralph-hero-mcp-server`** — the npm package. Tags: `vX.Y.Z` (via `release.yml`).

Because releases are tag-driven and automated, this changelog is **human-maintained**:
add entries under `## [Unreleased]` as you land user-visible changes; reconcile them
to a version heading when that artifact next releases. Full tag history:
<https://github.com/cdubiel08/ralph-hero/tags>.

## [Unreleased]

### Added

- `create_sub_issues` — batch tree-creation MCP tool; one call creates a
  parent's children, links each as a sub-issue, and wires dependency edges
  between them (GH-1565).

### Changed

- `batch_update` is now wired into `/ralph:caretake --mode split` Step 10,
  replacing per-child workflow-state updates with grouped batch calls
  (GH-1565).
- Tree-creation call sites (`caretake --mode split` §Step 6) now use
  `create_sub_issues` instead of per-child creation + `add_sub_issue` +
  `add_dependency` sequences.

### Removed

- Zero-reference MCP tools: `create_draft_issue`, `update_draft_issue`,
  `convert_draft_issue`, `get_draft_issue`, `list_groups`, `create_views`,
  and the `RALPH_DEBUG`-gated `debug_stats`. The `debug_stats` removal
  reverses its earlier "preserved for backward compat" note (GH-1566).

Note: net MCP tool surface is now 38 → 32 (31 always-on + `collate_debug`
under `RALPH_DEBUG`). GH-1552 may add one more tool later, which would
adjust this count again.

### Fixed

## Released

### ralph plugin — [ralph-v0.1.32](https://github.com/cdubiel08/ralph-hero/releases/tag/ralph-v0.1.32)

Latest released version of the `ralph` Claude Code plugin (9 verb skills:
catch-up, form, research, plan, impl, review, caretake, hero, setup). This
changelog was seeded at this version; earlier history is in the
[git tags](https://github.com/cdubiel08/ralph-hero/tags) and release notes.

### ralph-hero-mcp-server — [v2.5.191](https://github.com/cdubiel08/ralph-hero/releases/tag/v2.5.191)

Latest published version of the `ralph-hero-mcp-server` npm package (GitHub
Projects V2 workflow tools). Seeded at this version; earlier history is in the
[git tags](https://github.com/cdubiel08/ralph-hero/tags).
