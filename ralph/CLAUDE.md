# Working in ralph/

## What this is

The slim successor to `ralph-hero`. See `../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` for the full design.

## Conventions

- **SKILL.md ≤ ~150 lines.** Opinion content goes in flat sibling .md files, not the skill body.
- **No `references/` subfolder by default.** Reference files are siblings of SKILL.md. Only `caretake/` uses a `modes/` subfolder.
- **No SOUL.md files.** Substrate is the product (principle P10).
- **Enforcement lives in hooks/, not skill prose.** If you find yourself writing "make sure to validate X" in a SKILL.md, that's a hook.
- **Artifact state lives in the MCP server.** Skills read/write via `mcp__plugin_ralph-hero_ralph-github__*` tools (cross-plugin during migration).

## Adding a new verb

Each verb gets its own plan in `../thoughts/shared/plans/`. Don't add verbs ad-hoc — follow the plan-of-plans.

## Local dev

The symlink at `~/.claude/plugins/cache/ralph/HEAD` points here. Edits are picked up on next skill invocation. Hooks may need a Claude Code reload.

## What's still in `plugin/ralph-hero/`

Everything not yet migrated. The old plugin keeps working until each verb has a counterpart in `ralph` that's been dogfooded for two weeks.
