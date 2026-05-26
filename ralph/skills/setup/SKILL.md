---
description: |
  One-time setup for Ralph in this repo and on this machine. Three modes — default / `--mode project` (GitHub Project V2 bootstrap; custom fields, env vars, install-scope settings), `--mode cli` (install global `ralph` command + shell completions), `--mode repos` (bootstrap .ralph-repos.yml multi-repo registry). Triggers on "set up ralph", "configure ralph", "install ralph CLI", "create the project board", "bootstrap repos.yml", "fix missing workflow states".
argument-hint: "[<project-number> | --mode <project|cli|repos>] [path]"
context: inline
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=setup"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - AskUserQuestion
  - mcp__plugin_ralph_ralph-github__ralph_hero__health_check
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_project
  - mcp__plugin_ralph_ralph-github__ralph_hero__setup_project
  - mcp__plugin_ralph_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
---

# /ralph:setup — One-time setup in one verb

Interactive bootstrap. Three modes; pick by need:

| Mode | Trigger | Role |
|---|---|---|
| **default** / `--mode project` | `/ralph:setup [project-number]` | GitHub Project V2 bootstrap: custom fields, env vars, install-scope settings |
| **`--mode cli`** | `/ralph:setup --mode cli` | Install global `ralph` command + shell completions |
| **`--mode repos`** | `/ralph:setup --mode repos [path]` | Bootstrap `.ralph-repos.yml` for multi-repo portfolio |

References: [scope-detection.md](scope-detection.md), [project-fields.md](project-fields.md), [token-setup.md](token-setup.md), [cli-install.md](cli-install.md), [repos-registry.md](repos-registry.md).

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Shell: !`basename "${SHELL:-/bin/bash}"`

## Step 0: Parse arguments + set subcommand scope

**`--auto` refusal** — if `--auto` appears in `$ARGUMENTS`, emit the following and STOP (see `ralph/skills/shared/auto-alias.md` § Refusal targets):

```
--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop and --auto suitability matrix for the canonical table.
```

```bash
case "$ARGUMENTS" in
  --mode\ project*)  export RALPH_SUBCOMMAND=project ;;
  --mode\ cli*)      export RALPH_SUBCOMMAND=cli ;;
  --mode\ repos*)    export RALPH_SUBCOMMAND=repos ;;
  *)                 export RALPH_SUBCOMMAND=project ;;
esac
```

## Step 1: Dispatch by `RALPH_SUBCOMMAND`

Route to the matching mode section below. Each mode ends by emitting a `result:` line the harness extractor reads directly.

## Default mode (--mode project)

Interactive GitHub Project V2 bootstrap. Re-run with a project number to resume from an existing project (e.g., after an interrupted run).

1. **Detect install scope** — read `~/.claude/plugins/installed_plugins.json`, find the `ralph` entry, check `scope`. Sets target settings file path per [scope-detection.md](scope-detection.md).
2. **Health check** — `health_check` MCP tool. Display auth / repo access / project access / required fields status. On auth failure, STOP with rotation guidance from [token-setup.md](token-setup.md).
3. **Determine project owner** — if `projectAccess` failed/skipped, ask via `AskUserQuestion` ("under org" vs "under personal account"). If owners differ, enter split-owner mode — see [token-setup.md](token-setup.md) §dual-token.
4. **Create-or-verify project** — if arg passed: treat as resume number; `get_project` to verify; `setup_project` in extend mode to add any missing custom fields. If no arg + no `RALPH_GH_PROJECT_NUMBER`: `setup_project` to create. Field schema in [project-fields.md](project-fields.md).
5. **Create default views (manual)** — GitHub's GraphQL API does not support view creation. Print step-by-step instructions for Ralph Table + Ralph Kanban from [project-fields.md](project-fields.md).
6. **Write env vars** — to the target settings file from Step 1. Required: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`. Split-owner adds `RALPH_GH_PROJECT_OWNER`. Token via `gh auth` (no settings entry unless dual-PAT — see [token-setup.md](token-setup.md)).
7. **Print restart instructions** — MCP server reads env at startup. Restart Claude Code, then re-run `/ralph:setup` to verify.

```
result: Setup complete — project #NNN created/verified, env written to <path>. Restart Claude Code.
```

Or on STOP:

```
result: Setup paused at <step> — <reason>. Resume: /ralph:setup [NNN]
```

## --mode cli

Install the global `ralph` command and shell completions. Detailed steps in [cli-install.md](cli-install.md).

1. **Locate plugin** — cache at `~/.claude/plugins/cache/ralph/ralph/<version>/`. Latest version (`sort -V | tail -1`) wins.
2. **Install binary** — copy `scripts/ralph-cli.sh` → `~/.local/bin/ralph`, `mkdir -p` + `chmod +x`.
3. **Detect shell + install completions** — `basename "$SHELL"`. zsh → `ralph-completions.zsh`; bash → `ralph-completions.bash`; other shells skip.
4. **Check environment** — record `PATH_OK` (is `~/.local/bin` in `$PATH`?), `COMPINIT_OK` (zsh only — `compinit` in `~/.zshrc`?), `JUST_OK` (`command -v just`).
5. **Print per-shell summary** — conditional on the flags. End with `ralph doctor` + `/ralph:setup` as next steps.

```
result: CLI installed — ~/.local/bin/ralph. Restart shell or `source ~/.zshrc`.
```

## --mode repos

Bootstrap `.ralph-repos.yml` from real project data. Detailed flow + YAML schema + pattern detection in [repos-registry.md](repos-registry.md).

1. **Confirm target path** — default `.ralph-repos.yml`; accept custom via arg or `AskUserQuestion`. If file exists: ask overwrite / merge / cancel.
2. **Discover repos** — `health_check` then `pipeline_dashboard` (or `list_issues` fallback). Also try `gh api graphql ... projectV2.repositories` (user query → organization fallback).
3. **Per-repo Q&A** — domain (frontend/backend/data/infra/docs/other), tech stack, default labels, default assignees, default estimate. `AskUserQuestion` per repo.
4. **Detect patterns** — same-domain pairs → optionally create `cross-repo-feature` decomposition patterns with `dependency-flow` edges.
5. **Write file** — YAML output to target path. Merge mode preserves existing repos + appends new ones.

```
result: Registry written — <path>. <N> repos, <M> patterns.
```

## Notes

`RALPH_SUBCOMMAND` is set once at Step 0. SessionStart only sets `RALPH_COMMAND=setup`. No state-gate hooks — setup is not in the workflow pipeline. `ralph` is the sole plugin; `plugin/ralph-hero/` was deleted in GH-1438.
