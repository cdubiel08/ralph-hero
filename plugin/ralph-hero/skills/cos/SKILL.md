---
description: Chief-of-staff skill — surface project status, WIP, and priorities on
  demand. Use for "cos", "chief of staff", "morning brief", "status update from phone",
  or any request for a quick situation report from a low-power device. Dispatches
  three operating modes: desk (interactive dashboard), remote (phone-friendly 2-3
  sentence summary via local LLM, cached 30 min), unattended (scheduled morning brief).
argument-hint: "<mode> [args...]"
context: inline
allowed-tools:
  - Read
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
---

## Configuration

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

## System Prompt

!cat ${CLAUDE_PLUGIN_ROOT}/skills/cos/system-prompt.md

---

# Ralph COS — Chief of Staff

The COS skill surfaces project status, WIP, and priorities. It dispatches to one of three operating modes based on the first argument.

## Modes

| Mode | Description | Status |
|------|-------------|--------|
| `remote` | Phone-friendly 2-3 sentence summary via local LLM. 30-min cache at `~/.ralph-hero/cos/cache/remote-status.json`. Zero Claude Code — routes through `cos.sh` → mlx-openai-server. | Active (Phase 2) |
| `desk` | Interactive Streamlit dashboard at `localhost:8502` — six read-only panels (Today's Brief, Pipeline State, KG Growth, Recent Activity, WIP, KG Search) plus a chat panel that shells out to `cos.sh` (zero Claude Code). | Active (Phase 5) |
| `unattended` | Scheduled morning brief with ntfy push notification. | Phase 3 (GH-1255) |

## Dispatcher

Based on the `<mode>` argument, route to the handler script relative to the plugin root:

- `desk` → `scripts/cos/cos-desk.sh [args...]`
- `remote` → `scripts/cos/cos-remote.sh [args...]`
- `unattended` → `scripts/cos/cos-unattended.sh [args...]`

If no mode is provided or mode is `--help` / `-h`, print the mode table above and exit.

## Zero Claude Code on `remote`

The `remote` mode MUST NOT route through `cli-dispatch.sh` or spawn any `claude` process. It is a direct shell-out to `cos-remote.sh`, which calls `cos.sh` (Phase 1 wrapper) → `pi` → local mlx-openai-server. This constraint is enforced by the handler script and verified by `grep -rE '(^|\s)claude(\s|$)' scripts/cos/cos-remote.sh`.

## Cache

The `remote` mode uses a single-slot JSON cache at `~/.ralph-hero/cos/cache/remote-status.json` with a 30-minute TTL. Known limitation: if you run cos against multiple projects from the same machine, the cache will contain whichever project ran last. Multi-project cache keys are out of scope until Phase 4.
