---
date: 2026-03-19
github_issue: 634
github_url: https://github.com/cdubiel08/ralph-hero/issues/634
status: complete
type: research
tags: [cli, doctor, env-vars, settings-local-json]
---

# GH-634: ralph doctor — resolve env vars from settings.local.json

## Prior Work

- builds_on:: [[2026-02-21-GH-0073-ralph-doctor-cli-command]]
- builds_on:: [[2026-03-18-justfile-cli-setup-fallbacks]]
- builds_on:: [[2026-03-17-GH-0588-remove-mcp-env-block]]

## Problem Statement

`ralph doctor` checks required env vars (`RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER`) via bash indirect expansion `${!var:-}`. These variables are configured in `.claude/settings.local.json` under the `"env"` key and injected into Claude Code's process at startup — they are never exported to the user's shell.

Running `ralph doctor` from the terminal always reports FAIL for all three vars, even when configuration is correct.

## Current State Analysis

### Doctor recipe ([justfile:149-167](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L149-L167))

```bash
for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER; do
    if [ -z "${!var:-}" ]; then
        echo "FAIL: $var is not set"
        errors=$((errors + 1))
    else
        # ...print OK
    fi
done
```

Only checks `process.env` — no fallback to config files.

### settings.local.json structure

Located at `$PROJECT_ROOT/.claude/settings.local.json` (gitignored). Format:

```json
{
  "permissions": { "allow": [...] },
  "env": {
    "RALPH_HERO_GITHUB_TOKEN": "ghp_...",
    "RALPH_GH_OWNER": "cdubiel08",
    "RALPH_GH_REPO": "ralph-hero",
    "RALPH_GH_PROJECT_NUMBER": "3"
  }
}
```

All values are strings. The `env` block is a flat key-value map.

### resolveEnv() pattern ([index.ts:31-36](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/index.ts#L31-L36))

```typescript
function resolveEnv(name: string): string | undefined {
  const val = process.env[name];
  if (!val || val.startsWith("${")) return undefined;
  return val;
}
```

Filters unexpanded `${VAR}` literals. The doctor fallback should replicate this filter.

### No existing programmatic readers

No code in the codebase currently opens or parses `settings.local.json` directly. All consumption happens via Claude Code's env injection.

## Key Discoveries

1. **`node` is already a required dependency** — checked by doctor at [justfile:170-171](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L170-L171). This means `node -e` is safe to use without an additional dependency check.

2. **`jq` is optional** — only a warning if missing ([justfile:178-184](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L178-L184)). Cannot rely on it.

3. **Settings file path is deterministic** — always `$GIT_ROOT/.claude/settings.local.json` relative to the project root. The justfile runs from `plugin/ralph-hero/`, but doctor checks `.claude-plugin/plugin.json` and `.mcp.json` relative to that dir already. Need to resolve up to git root or use `{{justfile_directory()}}` parent traversal.

4. **The justfile `set dotenv-load`** ([justfile:8](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L8)) sources `.env` but NOT `.claude/settings.local.json`.

5. **Existing `node -e` pattern in doctor** — already used for JSON validation at [justfile:194](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/justfile#L194): `node -e "JSON.parse(require('fs').readFileSync(...))"`.

## Approach

### Recommended: `node -e` with `resolveEnv`-equivalent filter

Add a helper function at the top of the doctor recipe that reads a var from `settings.local.json` as a fallback:

```bash
# Read env var from .claude/settings.local.json (fallback when not in shell env)
read_settings_env() {
    local var="$1"
    local settings_file
    settings_file="$(git rev-parse --show-toplevel 2>/dev/null)/.claude/settings.local.json"
    if [ ! -f "$settings_file" ]; then return 1; fi
    local val
    val=$(node -e "
        const s = JSON.parse(require('fs').readFileSync('$settings_file','utf8'));
        const v = (s.env || {})['$var'] || '';
        if (!v || v.startsWith('\${')) process.exit(1);
        process.stdout.write(v);
    " 2>/dev/null) || return 1
    echo "$val"
}
```

Then modify the env var loop to try shell env first, fall back to settings:

```bash
for var in RALPH_HERO_GITHUB_TOKEN RALPH_GH_OWNER RALPH_GH_PROJECT_NUMBER; do
    val="${!var:-}"
    source_label=""
    if [ -z "$val" ]; then
        val=$(read_settings_env "$var") && source_label=" (from settings.local.json)" || val=""
    fi
    if [ -z "$val" ]; then
        echo "FAIL: $var is not set"
        errors=$((errors + 1))
    else
        if [ "$var" = "RALPH_HERO_GITHUB_TOKEN" ]; then
            echo "  OK: $var (set, redacted)$source_label"
        else
            echo "  OK: $var = ${val}$source_label"
        fi
    fi
done
```

### Why not jq?

`jq` is optional and only a warning if missing. Using `node -e` keeps the required dependency set unchanged.

### Why `git rev-parse --show-toplevel`?

The justfile runs from `plugin/ralph-hero/` but `settings.local.json` lives at the project root. `git rev-parse --show-toplevel` reliably finds the root regardless of working directory.

## Risks

- **Low**: `node -e` adds ~50ms to doctor startup. Acceptable for a diagnostic command.
- **Low**: If `settings.local.json` has syntax errors, `JSON.parse` will throw and the fallback returns empty — same as "not set". Could add a warning.
- **None**: No security risk — the file is local and gitignored. Token values are already redacted in output.

## Files Affected

### Will Modify
- `plugin/ralph-hero/justfile` - Add `read_settings_env()` helper and modify env var check loop in doctor recipe

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/index.ts` - `resolveEnv()` pattern to replicate
