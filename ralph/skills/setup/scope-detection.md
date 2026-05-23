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
| `"project"` | `<project>/.claude/settings.local.json` | CLI only works from this project; settings are gitignored |
| undetermined / not found | `<project>/.claude/settings.local.json` | Conservative fallback — local-scoped is reversible without touching user settings |

## User-facing message

After detection, tell the user:

- User-scoped: "Ralph is installed at user scope — config will be written to `~/.claude/settings.json` so the CLI works from any directory."
- Project-scoped: "Ralph is installed at project scope — config will be written to `.claude/settings.local.json`. The CLI will only work from this project directory."
- Undetermined: "Could not detect install scope. Writing to `.claude/settings.local.json` (project-scoped) — you can rerun with the user-scope install if you want global access."

## Why this matters

`gh auth` tokens live in the system keychain and don't need a settings entry. Non-token env vars (`RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`, optional split-owner overrides) MUST live in a settings file the MCP server reads at startup.

If the user is on a user-scoped install but the setup writes to `settings.local.json`, the CLI will silently behave differently inside vs. outside the project root — a common source of "ralph doctor works here but not there" reports.
