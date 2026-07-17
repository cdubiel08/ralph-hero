# Install scope detection

> Consulted by `/ralph:setup` default mode Step 1. Decides which settings file to write env vars to.

## Detect

Read `~/.claude/plugins/installed_plugins.json`. Find the most recent entry for the ralph family — try both new and legacy names:

- New (slim): `"ralph@ralph"`
- Legacy: `"ralph-hero@ralph-hero"`

Use the latest entry's `"scope"` field.

## Decide target path

| Scope | Settings file | Reason |
|---|---|---|
| `"user"` | `~/.claude/settings.json` | CLI works from any directory; one set of env vars covers all projects |
| `"project"` | scope vars → `<project>/.claude/settings.json` (tracked); tokens + machine-local toggles → `<project>/.claude/settings.local.json` (gitignored) | Two-layer split below — tracked file makes worktrees and fresh clones work |
| undetermined / not found | `<project>/.claude/settings.local.json` | Conservative fallback — local-scoped is reversible without touching user settings |

## Project scope: the two-layer split

For project-scoped installs the env vars split by sensitivity:

| Layer | File | Goes in git? | What belongs here |
|---|---|---|---|
| Shared project settings | `.claude/settings.json` | Yes (tracked) | Non-secret scope vars: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`, `RALPH_GH_PROJECT_OWNER` |
| Local project settings | `.claude/settings.local.json` | No (gitignored) | Tokens (`RALPH_*_TOKEN` — only when not using `gh auth`), machine-local toggles (`RALPH_AUTOPILOT_ENABLE`, `RALPH_REVIEW_*`, `RALPH_DEBUG`) |

Claude Code merges both into the MCP server's environment; `settings.local.json` wins on conflict, so a local override still beats the tracked default.

Offer this split via `AskUserQuestion` before writing: **tracked `settings.json` (recommended)** / **gitignored `settings.local.json` only** (for users who don't want board coordinates in the repo). If the user picks local-only, mention the worktree caveat below.

## Worktrees and bridge sessions

`settings.local.json` is gitignored, so a fresh worktree checkout **never contains it**. A session launched with a worktree as its project directory (background jobs, bridge sessions, `git worktree add` by hand) starts the MCP server with no `RALPH_GH_*` at all — every board tool then fails with `owner is required (set RALPH_GH_OWNER env var or pass explicitly)` while plain `gh` commands still work. The server cannot autodetect the project from cwd (its own cwd is the plugin root); the settings-merge is the only channel.

Two remedies, in preference order:

1. **Track the scope vars** in `.claude/settings.json` (the two-layer split above). Every worktree and clone inherits them automatically — nothing to hydrate.
2. **Hydrate the worktree**: copy `.claude/settings.local.json` from the main checkout into the worktree's `.claude/` at creation time. Required when the user declined tracking; must be repeated per worktree.

Do NOT suggest exporting `RALPH_GH_OWNER`/`RALPH_GH_REPO`/`RALPH_GH_PROJECT_NUMBER` from shell profiles as a worktree fix — a global export overrides per-project settings resolution and silently retargets writes when the user works in a different project's checkout.

## User-facing message

After detection, tell the user:

- User-scoped: "Ralph is installed at user scope — config will be written to `~/.claude/settings.json` so the CLI works from any directory."
- Project-scoped: "Ralph is installed at project scope — scope vars go to the tracked `.claude/settings.json` (so worktrees and fresh clones inherit them); tokens and machine-local toggles go to the gitignored `.claude/settings.local.json`."
- Undetermined: "Could not detect install scope. Writing to `.claude/settings.local.json` (project-scoped) — you can rerun with the user-scope install if you want global access."

## Why this matters

`gh auth` tokens live in the system keychain and don't need a settings entry. Non-token env vars (`RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`, optional split-owner overrides) MUST live in a settings file the MCP server reads at startup.

If the user is on a user-scoped install but the setup writes to `settings.local.json`, the CLI will silently behave differently inside vs. outside the project root — a common source of "ralph doctor works here but not there" reports. The project-scoped analog is the worktree gap above: scope vars living only in the gitignored local file make every worktree session board-blind.
