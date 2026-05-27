# Working in ralph/

## What this is

The slim successor to `ralph-hero`. See `../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` for the full design.

## Conventions

- **SKILL.md ≤ ~150 lines.** Opinion content goes in flat sibling .md files, not the skill body.
- **No `references/` subfolder by default.** Reference files are siblings of SKILL.md. Two named exceptions: `caretake/` uses a `modes/` subfolder, and the vendored `using-html/` utility skill keeps its upstream `references/` + `assets/` subfolders. `using-html/` is preserved byte-identical from its source so it tracks upstream cleanly — do not flatten it to match this convention.
- **No SOUL.md files.** Substrate is the product (principle P10).
- **Enforcement lives in hooks/, not skill prose.** If you find yourself writing "make sure to validate X" in a SKILL.md, that's a hook.
- **Artifact state lives in the MCP server.** Skills read/write via `mcp__plugin_ralph_ralph-github__*` tools (resolved via ralph's own `.mcp.json`; the package is still published as `ralph-hero-mcp-server` from top-level `mcp-server/`).

## Adding a new verb

Each verb gets its own plan in `../thoughts/shared/plans/`. Don't add verbs ad-hoc — follow the plan-of-plans.

## Local dev

The symlink at `~/.claude/plugins/cache/ralph/HEAD` points here. Edits are picked up on next skill invocation. Hooks may need a Claude Code reload.

## Standalone — `plugin/ralph-hero/` is gone

`ralph` is now the sole Claude-Code-facing plugin in this repo. `plugin/ralph-hero/` was deleted in GH-1438 (epic #1430, Phase 8). All 9 verbs, 16 agents, and the MCP server (`ralph-hero-mcp-server` at top-level `mcp-server/`) are self-contained here.

## Loop and --auto suitability matrix

Sources of truth: [`ralph/skills/shared/loop-wrapper.md`](skills/shared/loop-wrapper.md) (continuation-rules manifest) and [`ralph/skills/shared/auto-alias.md`](skills/shared/auto-alias.md) (per-verb `--auto` alias table). The table below is a summary; when there is any conflict, the source files win.

| Skill / Mode | `--loop` Suitable? | `--auto` resolves to | Default interval | Terminal sentinels | Notes |
|---|---|---|---|---|---|
| `research --mode auto` | Yes | (this IS the auto mode) | dynamic | `Queue empty.` | drain Research Needed queue |
| `research --mode prove` | No | — | — | — | single-claim investigation; interactive |
| `research` default | No | `--mode auto` | — | — | interactive question intake |
| `plan --mode auto` | Yes | (this IS the auto mode) | dynamic | `Queue empty.` | drain Ready for Plan queue |
| `plan --mode review` | Yes | — | dynamic | `Queue empty.` | drain Plan in Review queue |
| `plan --mode iterate` | No | — | — | — | single-plan surgical edit; interactive |
| `plan --mode epic` | No | — | — | — | single-epic decomposition |
| `plan` default | No | `--mode auto` | — | — | interactive phased plan creation |
| `impl --mode auto` | Yes | (this IS the auto mode) | dynamic | `IMPL BLOCKED …` / `Queue empty.` | drain unlocked impl phases |
| `impl --mode pr` | Yes | — | dynamic | `Queue empty.` | drain ready-for-PR queue |
| `impl --mode address` | No | — | — | — | single PR feedback cycle |
| `impl` default | No | `--mode auto` | — | — | interactive; pauses between phases |
| `review` default | Yes | (no change; already autonomous) | dynamic | `Queue empty.` | drain In Review queue |
| `review --mode val` | Yes | — | dynamic | `Queue empty.` | drain validation queue |
| `review --mode code` | Yes | — | dynamic | `Queue empty.` | drain code-review queue |
| `review --mode merge` | Yes | — | dynamic | `Queue empty.` | drain mergeable queue |
| `caretake --mode triage` | Yes | (this IS the auto mode) | dynamic | `Queue empty.` | drain Backlog |
| `caretake --mode hygiene` | Yes | — | `1h` | heartbeat (no `Queue empty.`) | periodic scan |
| `caretake --mode unblock` | Yes | — | dynamic | `Queue empty.` | autonomous path only (no `--question`) |
| `caretake --mode trends` | Yes | — | `6h` | heartbeat (no `Queue empty.`) | periodic snapshot |
| `caretake --mode debug` | Yes | — | dynamic | `Queue empty.` | drain Langfuse errors |
| `caretake --mode split` | Yes | — | dynamic | `Queue empty.` | drain M/L/XL queue |
| `caretake --mode all` | Yes | — | `1h` | heartbeat (no `Queue empty.`) | periodic fan-out |
| `caretake` default (event) | Yes | `--mode triage` | dynamic | `Queue empty.` | drain `trigger:*` labels (`--issue NNN` / `--auto`→triage). Bare no-arg `--loop` → heartbeat fan-out (`caretake:all`), not this drain. |
| `caretake --mode postmortem` | No | — | — | — | single artifact per session |
| `caretake --mode retro` | No | — | — | — | single artifact per session |
| `caretake --mode unblock --question` | No | — | — | — | interactive answer collection |
| `catch-up --mode report` | Yes | — | `1d` | heartbeat (no `Queue empty.`) | periodic status post; `--dry-run` by default in loop |
| `catch-up` default | No | — | — | — | interactive orientation |
| `catch-up --mode narrative` | No | — | — | — | pure stdout; interactive |
| `catch-up --mode dashboard` | No | — | — | — | pure stdout; interactive |
| `hero` default | No | `--mode auto` | — | — | one-shot orchestrator; refuses `--loop`. Use `--auto` → `--mode auto` for the autonomous drain. |
| `hero --mode auto` | Already wrapped | (this IS the auto mode) | dynamic (adaptive) | never-terminate (no `Queue empty.` stop; `Queue empty` → 1h idle backoff) | uses `RALPH_AUTOPILOT_ENABLE=true` gate; runs until cancelled via `/tasks` |
| `hero --mode watch` | Yes | — | `15m` | heartbeat (no `Queue empty.`) | polling heartbeat |
| `hero --mode classify` | No | — | — | — | redundant with `hero --mode auto` |
| `hero --mode pr-drain` | No | — | — | — | single-PR action; loop would re-process same PR |
| `form` all modes | No | — | — | — | interactive picker |
| `setup` all modes | No | — | — | — | one-shot bootstrap |

**Refusal message for unsuitable modes**: `--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability.`

**`--auto` refusal for unsuitable verbs** (`form`, `catch-up`, `setup`): `--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop and --auto suitability matrix for the canonical table.`

## ScheduleWakeup rules for --loop-wrapped skills

Skills wrapped via `--loop` must not call `ScheduleWakeup` themselves; `/loop` owns wakeup management. The one exception is `hero --mode auto`, which is a **never-terminating adaptive watcher** rather than a drain: it re-fires every tick (tight 60-270s during bursts, 3600s flat when the queue is idle) and only stops when the user cancels via `/tasks`. The three `autopilot-*` hooks enforce this contract deterministically and are keyed to `RALPH_COMMAND=hero` (the slim path) — `autopilot-director-postcheck.sh` arms the loop when it sees `Skill("loop", …--mode classify…)` and marks each tick as needing a wakeup, `autopilot-wakeup-clear.sh` clears that mark when `ScheduleWakeup` fires (and rejects the 300s cache-window anti-pattern), and `autopilot-stop-gate.sh` blocks session exit if a tick returns without a wakeup. (The legacy `ralph-hero` plugin / Director-dispatch path these hooks were originally written for is deprecated.) Adding a new direct `ScheduleWakeup` call from inside any other loop-suitable skill body is a bug — if you need to influence the wakeup cadence, do it via the continuation prompt in `loop-wrapper.md` instead.
