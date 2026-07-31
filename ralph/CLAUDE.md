# Working in ralph/

## What this is

The slim successor to `ralph-hero`. See `../thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` for the full design.

## Conventions

- **SKILL.md is dispatch + step skeleton only.** Opinion and reference content goes in flat sibling .md files, not the skill body. If a SKILL.md grows past ~200 lines, move prose to a sibling.
- **No `references/` subfolder by default.** Reference files are siblings of SKILL.md. Two named exceptions: `caretake/` uses a `modes/` subfolder, and the vendored `using-html/` utility skill keeps its upstream `references/` + `assets/` subfolders. `using-html/` is preserved byte-identical from its source so it tracks upstream cleanly — do not flatten it to match this convention.
- **No SOUL.md files.** Substrate is the product (principle P10).
- **Enforcement lives in hooks/, not skill prose.** If you find yourself writing "make sure to validate X" in a SKILL.md, that's a hook.
- **Artifact state lives in the MCP server.** Skills read/write via `mcp__plugin_ralph_ralph-github__*` tools (resolved via ralph's own `.mcp.json`; the package is still published as `ralph-hero-mcp-server` from top-level `mcp-server/`).
- **The decisions section is the plan's human-interface contract.** Every plan carries `## Design Decisions & Open Ambiguities` (`plan-shapes.md` § Design decisions anatomy, hook-enforced): open `#### Decision:` blocks are what the human reviews — plan review holds on them and auto-advances without them. Author judgment calls there, at the moment of uncertainty, not buried in phase prose.
- **Plan docs must keep ≥1 unchecked `- [ ]`.** `doc-structure-validator.sh` (Stop gate) requires it. Check off Automated Verification results only; Manual Verification boxes stay unchecked for human sign-off.
- **Hooks that look up artifacts keyed on `tool_input.file_path` root via `resolve_root_from_path "$file_path"`** (hook-utils.sh), not `get_project_root`. New hook tests copy `plan-research-required.test.sh`'s harness (SBX/REPO/NOGIT sandboxes + `run_case`). Gotchas: run cases from a CWD with no `GH-NNN` substring (worktree paths leak into ticket-ID fallbacks), and keep fixture filenames token-free when a case targets a later lookup branch — a `GH-NNN` in the filename satisfies the direct-artifact check first and masks it.

## Adding a new verb

Each verb gets its own plan in `../thoughts/shared/plans/`. Don't add verbs ad-hoc — follow the plan-of-plans.

## Install model & local dev

There is **no symlink and no live-edit path**. Claude Code installs `ralph` from the `ralph-hero` marketplace (a git clone at `~/.claude/plugins/marketplaces/ralph-hero`) as an **immutable versioned copy** at `~/.claude/plugins/cache/ralph-hero/ralph/<version>/` — that copy is what `${CLAUDE_PLUGIN_ROOT}` resolves to; `~/.claude/plugins/installed_plugins.json` records the active installPath/version/gitCommitSha. The MCP server ships separately: `ralph/.mcp.json` pins `ralph-hero-mcp-server@<version>`, resolved via npx.

Edits in this working tree reach a running Claude Code only after: merge to main → `release-ralph.yml` bumps `ralph/.claude-plugin/plugin.json` + tags → marketplace clone updates → plugin update installs the new version dir.

Pre-merge, verify locally what CI verifies (run from repo root):

```bash
# Hook tests (CI: test-hooks — globs *.test.sh and test-*.sh)
find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash

# ShellCheck (CI: shellcheck-hooks, severity=error)
shellcheck -S error ralph/hooks/scripts/*.sh

# Doc rosters — CLAUDE.md/README.md agent/skill/tool tables vs source (CI: check-doc-rosters)
bash scripts/check-doc-rosters.sh

# Skill frontmatter contract
cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts
```

## Standalone — `plugin/ralph-hero/` is gone

`ralph` is the sole Claude-Code-facing plugin in this repo; `plugin/ralph-hero/` was deleted in GH-1438 (see root CLAUDE.md). All 9 verbs, 16 agents, and the MCP server (top-level `mcp-server/`) are self-contained here. An untracked `plugin/ralph-hero/` dir may linger on disk locally — it is gone from git; ignore it.

## Loop and --auto suitability matrix

Sources of truth: [`ralph/skills/shared/loop-wrapper.md`](skills/shared/loop-wrapper.md) (continuation-rules manifest) and [`ralph/skills/shared/auto-alias.md`](skills/shared/auto-alias.md) (per-verb `--auto` alias table). The table below is a summary; when there is any conflict, the source files win.

| Skill / Mode | `--loop` Suitable? | `--auto` resolves to | Default interval | Terminal sentinels | Notes |
|---|---|---|---|---|---|
| `research --mode auto` | Yes | (this IS the auto mode) | dynamic | `Queue empty.` | drain Research Needed queue |
| `research --mode prove` | No | — | — | — | single-claim investigation; interactive |
| `research` default | No | `--mode auto` | — | — | interactive question intake |
| `plan --mode auto` | Yes | (this IS the auto mode) | dynamic | `Queue empty.` | drain Ready for Plan queue |
| `plan --mode review` | Yes | — | dynamic | `Queue empty.` | drain Plan in Review queue; `PLAN AWAITING DECISION` is a progress sentinel (held plan, re-fire), not terminal |
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
| `caretake --mode debug` | No | — | — | — | retired; emits `DEBUG RETIRED` and stops |
| `caretake --mode split` | Yes | — | dynamic | `Queue empty.` | drain M/L/XL queue |
| `caretake --mode watch-pr` | Yes | — | — | heartbeat (no `Queue empty.`) | sweep `blocked:pr-NNN` items; usually runs inside the `--mode all` fan-out |
| `caretake --mode watch-upstream` | Yes | — | — | heartbeat (no `Queue empty.`) | sweep `blocked:upstream` items; usually runs inside the `--mode all` fan-out |
| `caretake --mode watch-blockers` | Yes | — | — | heartbeat (no `Queue empty.`) | advance items whose `blockedBy` edges all closed; usually runs inside the `--mode all` fan-out |
| `caretake --mode all` | Yes | — | `1h` | heartbeat (no `Queue empty.`) | periodic fan-out: hygiene + watch-* + report + trends |
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
| `hero-fable` | No | — | — | — | experimental rail-free surface; one issue/outcome per invocation; `/ralph:hero --model fable` forwards here |
| `form` all modes | No | — | — | — | interactive picker |
| `setup` all modes | No | — | — | — | one-shot bootstrap |

**Refusal message for unsuitable modes**: `--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability.`

**`--auto` refusal for unsuitable verbs** (`form`, `catch-up`, `setup`): `--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop and --auto suitability matrix for the canonical table.`

## ScheduleWakeup rules for --loop-wrapped skills

Skills wrapped via `--loop` must not call `ScheduleWakeup` themselves; `/loop` owns wakeup management. The one exception is `hero --mode auto`, which is a **never-terminating adaptive watcher** rather than a drain: it re-fires every tick (tight 60-270s during bursts, 3600s flat when the queue is idle) and only stops when the user cancels via `/tasks`. Four `autopilot-*` hooks enforce this contract deterministically and are keyed to `RALPH_COMMAND=hero` (the slim path) — `autopilot-enable-gate.sh` refuses to dispatch the inner `/loop` unless `RALPH_AUTOPILOT_ENABLE=true`, `autopilot-director-postcheck.sh` arms the loop when it sees `Skill("loop", …--mode classify…)` and marks each tick as needing a wakeup, `autopilot-wakeup-clear.sh` clears that mark when `ScheduleWakeup` fires (and rejects the 300s cache-window anti-pattern), and `autopilot-stop-gate.sh` blocks session exit if a tick returns without a wakeup. (The legacy `ralph-hero` plugin / Director-dispatch path these hooks were originally written for is deprecated.) Adding a new direct `ScheduleWakeup` call from inside any other loop-suitable skill body is a bug — if you need to influence the wakeup cadence, do it via the continuation prompt in `loop-wrapper.md` instead.
