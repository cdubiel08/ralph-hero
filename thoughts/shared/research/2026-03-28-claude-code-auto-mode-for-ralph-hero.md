---
title: Claude Code Auto Mode — Replacing --dangerously-skip-permissions in Ralph-Hero
type: research
status: complete
date: 2026-03-28
tags: [permissions, auto-mode, safety, cli, migration]
---

# Claude Code Auto Mode for Ralph-Hero

## Context

Anthropic released [auto mode](https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode) as a research preview (March 2026). It provides a safer alternative to `--dangerously-skip-permissions` by running a classifier model (Sonnet 4.6) that reviews each action before execution. Ralph-hero currently assumes `--dangerously-skip-permissions` is enabled for all autonomous execution.

## How Auto Mode Works

- A **separate classifier model** (always Sonnet 4.6) reviews each tool call before execution
- The classifier sees user messages, tool calls, and CLAUDE.md — but **not tool results** (prompt injection resistant)
- Read-only actions and file edits in the working directory are auto-approved without calling the classifier
- First matching rule wins: explicit allow/deny rules → built-in auto-approvals → classifier → block with reason

### Default Blocks

- `curl | bash` and scripts from cloned repos
- Sending sensitive data to external endpoints
- Production deploys and migrations
- Mass deletion on cloud storage
- Granting IAM or repo permissions
- Force push or pushing directly to `main`
- Irreversibly destroying pre-session files

### Default Allows

- Local file operations in working directory
- Installing deps declared in lock files/manifests
- Reading `.env` and sending credentials to the matching API
- Read-only HTTP requests
- Pushing to the current branch or one Claude created

### Fallback Thresholds

- 3 consecutive blocks → session pauses (interactive) or **aborts** (`-p` mode)
- 20 total blocks in a session → same behavior
- Thresholds are **not configurable**

## Current Ralph-Hero Permission Usage

### Scripts using `--dangerously-skip-permissions`

| File | Line | Context |
|------|------|---------|
| `scripts/cli-dispatch.sh` | 49 | `run_headless()` — all headless skill dispatch |
| `scripts/ralph-loop.sh` | 79 | Autonomous workflow loop |
| `scripts/ralph-team-loop.sh` | 54 | Multi-agent team orchestrator |

### Two-level permission system

1. **CLI level**: `--dangerously-skip-permissions` → can Claude execute tools at all?
2. **Workflow level**: `RALPH_AUTO_APPROVE` env var → should ralph-hero stop for human plan approval?

Auto mode replaces only the first. `RALPH_AUTO_APPROVE` is unaffected.

### Subagent behavior

Ralph-hero subagents declare `permissionMode: bypassPermissions` in frontmatter. In auto mode, **this is ignored** — the classifier evaluates the delegated task before the subagent starts and reviews its action history afterward.

## Auto Mode vs Bypass Permissions

| Aspect | Auto mode | `--dangerously-skip-permissions` |
|--------|-----------|----------------------------------|
| Permission prompts | None (unless fallback triggers) | None, ever |
| Safety checks | Classifier reviews each action | No checks |
| Token usage | Higher (classifier calls) | Standard |
| Prompt injection protection | Yes | None |
| Recommended environment | Any | Isolated containers/VMs only |
| Plan availability | Team/Enterprise only | All plans |

## Availability (as of 2026-03-28)

| Plan | Auto Mode |
|------|-----------|
| Team | Yes (research preview, admin must enable) |
| Enterprise | Rolling out |
| API | Rolling out |
| Max (individual) | Not yet — no timeline |
| Pro (individual) | Not yet — no timeline |

Requirements: Sonnet 4.6 or Opus 4.6 only. Not available on Haiku, claude-3, or third-party providers (Bedrock, Vertex, Foundry).

## Migration Plan

### 1. Configure `autoMode` environment

In `~/.claude/settings.json` or `.claude/settings.local.json`:

```json
{
  "autoMode": {
    "environment": [
      "Organization: personal development. Primary use: autonomous GitHub project management",
      "Source control: github.com and all repos under the configured RALPH_GH_OWNER",
      "Ralph-hero is an autonomous workflow orchestrator that manages GitHub issues through a pipeline: Backlog -> Research -> Plan -> Implementation -> Review -> Done",
      "Git worktrees are used for isolated implementation — branches are created, pushed, and PRs opened as part of normal operation",
      "The MCP server ralph-hero-mcp-server manages GitHub Projects V2 via GraphQL"
    ],
    "allow": [
      "Creating and pushing git branches is allowed: ralph-hero uses worktrees for isolated implementation",
      "Creating pull requests via gh CLI is allowed: normal end-of-implementation workflow",
      "Running npm test, npm run build, and npm install is allowed: standard build/test operations",
      "Writing to thoughts/shared/ directory is allowed: research and plan artifacts are stored here"
    ]
  }
}
```

### 2. Add narrow permission allow rules

```json
{
  "permissions": {
    "allow": [
      "Bash(git checkout *)",
      "Bash(git branch *)",
      "Bash(git push *)",
      "Bash(git worktree *)",
      "Bash(gh pr create *)",
      "Bash(gh pr merge *)",
      "Bash(npm test *)",
      "Bash(npm run build *)",
      "Bash(npx vitest *)",
      "mcp__ralph-hero-mcp-server",
      "mcp__ralph-knowledge"
    ]
  }
}
```

### 3. Update scripts

Replace `--dangerously-skip-permissions` with `--permission-mode auto` in all three scripts. For `-p` mode, `--permission-mode auto` directly activates it (no `--enable-auto-mode` needed).

Add fallback for plans without auto mode support:

```bash
PERMISSION_FLAG="${RALPH_PERMISSION_MODE:---permission-mode auto}"
# Override: RALPH_PERMISSION_MODE="--dangerously-skip-permissions"
```

### 4. Validate with built-in tools

```bash
claude auto-mode defaults   # view built-in classifier rules
claude auto-mode config     # view effective config (settings + defaults)
claude auto-mode critique   # AI feedback on custom rules
```

## Risks

1. **3-block abort in `-p` mode**: If the classifier misunderstands a legitimate ralph-hero action during autonomous runs, 3 consecutive blocks kills the session. Mitigation: thorough `autoMode.allow` rules.
2. **Broad allow rules get dropped**: Auto mode strips `Bash(*)`, `Bash(python*)`, `Bash(node*)`, and `Agent` allow rules. Narrow rules survive. Ralph-hero's `allowed-tools` in skill frontmatter may need adjustment.
3. **Token cost**: Every non-trivial action goes through classifier, increasing cost for long autonomous runs.
4. **Plan availability**: Currently Team/Enterprise only. Individual Max/Pro has no timeline.

## Recommendation

Auto mode is a good fit for ralph-hero because:
- Ralph-hero's core operations (git branches, PRs, file writes, MCP calls) align with what the classifier auto-allows
- It adds prompt injection protection — valuable since ralph-hero reads untrusted content from GitHub issues
- The `autoMode.environment` config can teach the classifier about ralph-hero's legitimate workflow

**Blocker**: Not available on individual Max plan yet. Keep `--dangerously-skip-permissions` as default with auto mode as opt-in via `RALPH_PERMISSION_MODE` env var until availability expands.
