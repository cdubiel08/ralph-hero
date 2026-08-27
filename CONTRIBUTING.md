# Contributing to ralph-hero

Thanks for contributing. This repo holds the **`ralph`** Claude Code plugin (v2: two skills + the `ralph/scripts/board` CLI, no MCP server) and a few sibling sub-plugins. This guide is the contributor entry point; deeper architecture lives in [`CLAUDE.md`](https://github.com/cdubiel08/ralph-hero/blob/main/CLAUDE.md).

## Project layout

```
ralph/               # The plugin: skills, agent, hooks, board CLI, loop scripts
ralph/               # The Claude Code plugin (9 verb skills, agents, hooks)
plugin/
├── ralph-knowledge/ # Semantic search over thoughts/ (MCP server)
├── ralph-playwright/# UI-testing skills
└── ralph-demo/      # Sprint-demo video generation (Remotion)
```

See the [README](https://github.com/cdubiel08/ralph-hero/blob/main/README.md) for the plugin's user-facing surface and [`CLAUDE.md`](https://github.com/cdubiel08/ralph-hero/blob/main/CLAUDE.md) for internals.

## Dev setup

The board CLI is the main build target. From the repo root:

```bash
npm install
npx vitest run ralph/scripts/board.test.ts   # the board CLI contract suite
npx tsc --noEmit                             # typecheck
```

The **ralph-knowledge** plugin builds from `plugin/ralph-knowledge/` (`npm install && npm run build && npm test`).

No linter is configured — TypeScript strict mode is the primary code-quality gate. The slim plugin's hook tests live in `ralph/hooks/scripts/__tests__/` (bash).

## Branch & commit conventions

- Branch per issue: `feature/GH-NNN`.
- Conventional-commit style headings (`docs(...)`, `fix(...)`, `feat(...)`).
- Open a PR against `main`; CI (`ci.yml`) runs build + test (Node 20/22), hook tests, ShellCheck, and workflow lint.

## Releases (automated — do not publish manually)

Releases are **fully automated** on merge to `main`; two artifacts version independently:

- **`ralph` plugin:** `release-ralph.yml` fires when a merge touches `ralph/**`. It bumps `ralph/.claude-plugin/plugin.json` and tags `ralph-vX.Y.Z`.

Include `#minor` or `#major` for a larger-than-patch bump. It counts in the PR
title (which becomes the merge commit body) **or** at the end of a commit
*subject* line on the branch — `release-ralph.yml` reads both surfaces, so
wherever you naturally write it is the right place. `#major` outranks `#minor`.
Commit *bodies* are deliberately not scanned: prose about this rule contains
the tokens it describes.

**Do NOT** run `npm publish` or push `v*` tags manually — the release workflows own both.

## Changelog

Releases are tag-driven and automated, so the changelog is **not** auto-generated. Add a bullet under the `## [Unreleased]` section of [`CHANGELOG.md`](https://github.com/cdubiel08/ralph-hero/blob/main/CHANGELOG.md) as you land user-visible changes; entries are reconciled to a version when that artifact releases.
