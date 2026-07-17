# Token setup

> Consulted by `/ralph:setup` default mode for auth flow and rotation guidance.

## Three auth modes

### 1. `gh auth` keychain (default, recommended)

```bash
gh auth login -s repo,project,read:org
```

Stores a token in the system keychain. The MCP server reads it via `gh auth token` at startup. **No settings file entry needed for the token.**

To rotate: `gh auth refresh -s repo,project,read:org`.
To check: `gh auth status` (or `just doctor` if the CLI is installed).

### 2. Single PAT in settings

For systems where `gh` is unavailable or undesired:

```json
{
  "env": {
    "RALPH_HERO_GITHUB_TOKEN": "ghp_your_token_here"
  }
}
```

Resolution chain (highest wins): `RALPH_GH_REPO_TOKEN` → `RALPH_HERO_GITHUB_TOKEN` → `gh auth token`.

### 3. Dual-token split-owner

Required when the repo is under an org but the project is under your personal account (or vice versa). Two PATs:

- **Repo token** — scopes: `repo`, `read:org`
- **Project token** — scopes: `project`

Settings file (paths depend on install scope — see [scope-detection.md](scope-detection.md)):

```json
{
  "env": {
    "RALPH_GH_REPO_TOKEN": "ghp_repo_only",
    "RALPH_GH_PROJECT_TOKEN": "ghp_project_only",
    "RALPH_GH_OWNER": "your-org",
    "RALPH_GH_REPO": "your-repo",
    "RALPH_GH_PROJECT_OWNER": "your-personal-username",
    "RALPH_GH_PROJECT_NUMBER": "1"
  }
}
```

Explicit env vars **always take precedence over `gh auth`.** To rotate, regenerate the PAT at <https://github.com/settings/tokens> and update the settings file. `gh auth` does not manage these.

## Required scopes

- `repo` — read/write issues, PRs, comments
- `project` — read/write Project V2 fields and items
- `read:org` — list org repos linked to a project (skipped if working only with personal repos)

## Where NOT to put tokens

- **Not in `.mcp.json`** — that file has no `env` block; the MCP server inherits from Claude Code's process.
- **Not in `~/.bashrc`/`.zshrc` below the interactive guard** — non-interactive Claude Code MCP child processes won't see them.
- **Not in git** — tokens live only in the keychain or the gitignored `settings.local.json`; never check a token in. (The non-secret scope vars `RALPH_GH_OWNER`/`RALPH_GH_REPO`/`RALPH_GH_PROJECT_NUMBER` are the opposite — they *belong* in the tracked `.claude/settings.json` so worktrees inherit them; see [scope-detection.md](scope-detection.md) § Project scope.)
- **Not in `RALPH_HERO_GITHUB_TOKEN` for split-owner setups** — that single token will only have access to one side. Use the dual-token variables instead.

## Recovery from a bad rotation

If the new token doesn't work and the old one was invalidated, the MCP server logs `auth failed` at startup. Re-run `gh auth login -s repo,project,read:org` (mode 1) or update the settings file (modes 2/3), then **restart Claude Code** — the MCP server reads env at startup only.
