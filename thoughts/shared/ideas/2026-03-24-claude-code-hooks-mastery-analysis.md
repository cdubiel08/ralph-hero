# Idea Hunt: Claude Code Hooks Patterns
Date: 2026-03-24
Source: https://github.com/disler/claude-code-hooks-mastery

## Executive Summary

This repo is the most complete working example of Claude Code hooks in the wild. It demonstrates all 13 hook lifecycle events, a clear UV single-file script packaging pattern, and crucially — it contains the `CLAUDE_ENV_FILE` persistence mechanism via a `persist_env_variable()` helper in `setup.py`. There is no `env:` field in agent or skill frontmatter anywhere; env is handled entirely at the hook and shell level.

## Top Finds

### 1. `CLAUDE_ENV_FILE` — The Setup Hook Writes Persistent Env Vars

**File**: `.claude/hooks/setup.py`

```python
def persist_env_variable(name, value):
    """Persist an environment variable via CLAUDE_ENV_FILE."""
    env_file = os.environ.get('CLAUDE_ENV_FILE')
    if env_file:
        with open(env_file, 'a') as f:
            f.write(f'export {name}="{value}"\n')
        return True
    return False
```

Called during `trigger == 'init'` with:
```python
persist_env_variable('PROJECT_ROOT', cwd)
```

This is the canonical pattern for a Setup hook setting environment state that survives into later hook and agent invocations. `CLAUDE_ENV_FILE` is an official Claude Code mechanism — the hook appends `export KEY="VALUE"` lines to whatever file Claude Code tells it to use.

**Why it matters**: This is exactly the mechanism we would use if we wanted a SessionStart or Setup hook to inject env vars (e.g. `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`) that downstream hooks and agents could read. No agent frontmatter field required — the OS environment is the channel.

**Could we use this?**: Yes. A `setup.py`-style hook for ralph-hero could detect missing required env vars and emit a clear error via `additionalContext`, or write computed derived vars (e.g. a resolved `RALPH_GH_REPO` from project metadata) into `CLAUDE_ENV_FILE`.

### 2. `hookSpecificOutput.additionalContext` — The SessionStart/Setup Return Contract

Both `session_start.py` and `setup.py` return structured JSON to Claude Code:

```python
output = {
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",  # or "Setup"
        "additionalContext": context      # string injected into system prompt
    }
}
print(json.dumps(output))
sys.exit(0)
```

The `additionalContext` value is a multi-line string that Claude Code injects as context. `session_start.py` loads `.claude/CONTEXT.md`, git branch, uncommitted changes count, and recent GitHub issues — all injected at session open without requiring any CLAUDE.md changes.

**Why it matters**: This is a clean way to provide dynamic runtime context (today's date, active sprint, token availability) without baking it into static files. Ralph-hero's SessionStart hook could inject the current project board state summary.

### 3. UV Single-File Script Architecture — The Distribution Pattern

Every hook uses the same shebang + inline dependencies pattern:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
# ]
# ///
```

This means zero installation step. Hooks are dropped into `.claude/hooks/` and `uv` resolves dependencies on first run, caching them. `settings.json` references hooks via `$CLAUDE_PROJECT_DIR`:

```json
"command": "uv run $CLAUDE_PROJECT_DIR/.claude/hooks/pre_tool_use.py"
```

**Why it matters**: This is the right model for hook distribution in a plugin. A ralph-hero plugin could ship hooks as UV scripts in `.claude/hooks/`, referenced from a settings snippet the user merges. No global install, no version conflicts, works offline after first cache.

### 4. `python-dotenv` Load in Every Hook — The Env Bootstrapping Pattern

Every hook that reads API keys starts with:

```python
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass
```

The `.env.sample` defines all needed keys:
```
ANTHROPIC_API_KEY=
ELEVENLABS_API_KEY=
OPENAI_API_KEY=
ENGINEER_NAME=Dan
```

Hooks read these via `os.getenv()` at runtime. TTS provider selection in `stop.py` and `subagent_start.py` implements graceful fallback:

```python
if os.getenv('ELEVENLABS_API_KEY'):     # try ElevenLabs
elif os.getenv('OPENAI_API_KEY'):       # try OpenAI
else:                                    # fall back to pyttsx3 (no key)
```

**Why it matters**: The dotenv pattern means hooks work identically whether invoked from Claude Code (which inherits `settings.local.json` env) or run directly from a shell (which loads `.env`). This dual-path compatibility is worth mimicking.

### 5. Agent Frontmatter Fields — The Actual Schema

Examining all agent files confirms the supported frontmatter fields. From `crypto-coin-analyzer-haiku.md`:

```yaml
---
name: crypto-coin-analyzer-haiku
description: Cryptocurrency analysis specialist...
tools: WebSearch, Bash, Write
model: haiku
color: green
---
```

From `hello-world-agent.md`:
```yaml
name: hello-world-agent
description: Simple greeting agent...
tools: WebSearch
color: green
```

From `team/builder.md` (reconstructed from fetch): `model: opus`, `color: cyan`.

**Critical finding: there is no `env:` field in any agent frontmatter in this repo.** The schema is: `name`, `description`, `tools`, `model` (optional), `color` (optional). Environment is not a frontmatter concern — it is a shell/hook concern. This aligns with how Claude Code actually works: agents inherit the parent process environment.

### 6. Sub-Agent Tracking Pattern — SubagentStart/SubagentStop Hooks

`subagent_start.py` reads `agent_id` and `agent_type` from the JSON payload piped to stdin, logs to `logs/subagent_start.json`, and optionally announces via TTS. The hook has no mechanism to inject env vars into the sub-agent — it is purely observational.

`settings.json` passes `--notify` to `subagent_stop.py` but nothing else. There is no hook-based mechanism here to pass custom env to spawned agents.

**The implication**: Sub-agents receive the same environment as the parent session, set at startup. If you want sub-agents to have specific vars, they must be in the parent's env before the session starts. The `CLAUDE_ENV_FILE` pattern from `setup.py` is the only hook-time mechanism to add to that env.

### 7. `pre_tool_use.py` Blocks `.env` File Access — A Security Pattern Worth Noting

```python
def is_env_file_access(tool_name, tool_input):
    if tool_name in ['Read', 'Edit', 'MultiEdit', 'Write', 'Bash']:
        if tool_name in ['Read', 'Edit', 'MultiEdit', 'Write']:
            file_path = tool_input.get('file_path', '')
            if '.env' in file_path and not file_path.endswith('.env.sample'):
                return True
```

Exits with code 2 (blocks the tool call) if any tool tries to read/write `.env`. This prevents an agent from accidentally leaking secrets.

**Could we use this?**: Ralph-hero could add a similar guard in a PreToolUse hook: block any Bash command that echoes `$RALPH_HERO_GITHUB_TOKEN` or reads `settings.local.json`.

## Emerging Patterns

- **Hook-as-sidecar**: Every lifecycle event gets its own dedicated Python file. No monolithic hook. One file = one responsibility. The 13-file layout maps 1:1 to Claude Code's 13 events.

- **`$CLAUDE_PROJECT_DIR` as the stable anchor**: All hook paths in `settings.json` use this env var rather than relative paths or hardcoded absolutes. This makes the hook config portable across machines.

- **Flags over config files**: Hooks take CLI flags (`--notify`, `--log-only`, `--store-last-prompt`, `--name-agent`, `--chat`) rather than reading a separate config file. The `settings.json` command string is the configuration: `uv run hook.py --flag-a --flag-b`.

- **Fail silent, never block**: Every hook wraps its entire body in `try/except Exception: sys.exit(0)`. The philosophy is that hooks must never break the main workflow — they are observational and additive.

- **`additionalContext` over stdout injection**: Hooks that want to inject text into Claude's system context return the JSON structure with `hookSpecificOutput.additionalContext`. They do not write to a file that CLAUDE.md then references.

- **Agent body delegates to a shared prompt file**: `crypto-coin-analyzer-haiku.md` body is just `Read and Execute: .claude/commands/agent_prompts/crypto_coin_analyzer_agent_prompt.md`. This means the prompt is shared across the haiku/sonnet/opus variants — only the frontmatter differs. Clean separation of model selection from prompt content.

## Ideas Worth Exploring

1. **Setup hook for ralph-hero environment validation** — a `setup.py`-style hook that checks for `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER` and returns a clear `additionalContext` error if any are missing, instead of letting the MCP server fail obscurely at first tool call.

2. **SessionStart hook that injects live project state** — use `hookSpecificOutput.additionalContext` to inject the current sprint's top-3 open issues at session start, eliminating the manual "prime" step. The hook can call the MCP server or hit GitHub directly.

3. **PreToolUse hook blocking `settings.local.json` access** — mirroring the `.env` guard from `pre_tool_use.py` to prevent accidental leakage of `RALPH_HERO_GITHUB_TOKEN` via Read or Bash cat.

4. **UV single-file scripts for ralph-hero hooks** — if we ever ship hook files as part of the plugin, the UV shebang pattern means users don't need to install anything beyond `uv`. Hooks become self-contained. Currently our hooks are shell scripts in `plugin/ralph-hero/hooks/` — migrating the complex ones to UV Python scripts would give us proper error handling and testability.

5. **`persist_env_variable` for computed config** — in a multi-repo setup, a Setup hook could call the GitHub API to resolve the project's linked repo name and write `RALPH_GH_REPO=<resolved>` to `CLAUDE_ENV_FILE`, making `RALPH_GH_REPO` optional for users who only have one linked repo.

6. **Agent prompt delegation pattern** — our agents currently embed full prompts inline. The `Read and Execute: path/to/prompt.md` pattern lets us share one prompt across multiple agent variants that differ only in `model:` or `tools:`. Worth adopting if we ship haiku/sonnet variants of the same agent.

## Wild Card

The `--name-agent` flag in `user_prompt_submit.py` calls a local Ollama instance (with fallback to Anthropic) to generate a one-word alphanumeric session name. This name is stored in `.claude/data/sessions/<session_id>.json` and presumably displayed in the status line. The status line (`status_line_v6.py`) presumably reads this file to show something like "Session: Phoenix" instead of a UUID. This is a clever UX trick — giving sessions memorable names makes log archaeology much easier. The Ollama-first approach means it works offline and at zero cost.

## Raw Sources

- [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) — complete 13-hook implementation with UV scripts
- [.claude/settings.json](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/settings.json) — hook registration, `$CLAUDE_PROJECT_DIR` pattern
- [.claude/hooks/setup.py](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/hooks/setup.py) — `persist_env_variable` / `CLAUDE_ENV_FILE` usage
- [.claude/hooks/session_start.py](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/hooks/session_start.py) — `additionalContext` return pattern
- [.claude/hooks/stop.py](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/hooks/stop.py) — TTS provider selection via `os.getenv()`, dotenv loading
- [.claude/hooks/pre_tool_use.py](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/hooks/pre_tool_use.py) — `.env` access blocking pattern
- [.claude/hooks/subagent_start.py](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/hooks/subagent_start.py) — sub-agent tracking, env var read for TTS selection
- [.claude/hooks/user_prompt_submit.py](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/hooks/user_prompt_submit.py) — session naming via Ollama/Anthropic fallback
- [.claude/agents/crypto/crypto-coin-analyzer-haiku.md](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.claude/agents/crypto/crypto-coin-analyzer-haiku.md) — agent frontmatter schema (no `env:` field), prompt delegation pattern
- [.env.sample](https://raw.githubusercontent.com/disler/claude-code-hooks-mastery/main/.env.sample) — canonical key list: `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `ENGINEER_NAME`
