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

`ralph` is the sole Claude-Code-facing plugin in this repo; `plugin/ralph-hero/` was deleted in GH-1438 (see root CLAUDE.md). All 9 verbs, 15 agents, and the MCP server (top-level `mcp-server/`) are self-contained here. An untracked `plugin/ralph-hero/` dir may linger on disk locally — it is gone from git; ignore it.

## Loop suitability

*(Renamed from "Loop and --auto suitability matrix", GH-1607 — the matrix below is now single-sourced in the two shared files rather than duplicated here.)*

Sources of truth — the ONLY copies:
- [`ralph/skills/shared/loop-wrapper.md`](skills/shared/loop-wrapper.md) § Continuation-rules manifest (loop-suitable `skill:mode` rows: sentinels, delay buckets, notes) and § Unsuitable surfaces (interactive/single-shot surfaces that refuse `--loop`, with the one-line reason each).
- [`ralph/skills/shared/auto-alias.md`](skills/shared/auto-alias.md) § Alias table (per-verb `--auto` rewrite target) and § Refusal targets (verbs that refuse `--auto` entirely).

`hero-fable` is outside the 9-verb set (experimental rail-free surface; one issue/outcome per invocation; `/ralph:hero --model fable` forwards here) and is not tracked in either manifest.

**Refusal message for unsuitable modes** — see `loop-wrapper.md` § Refusal message: `--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability.`

**`--auto` refusal for unsuitable verbs** (`form`, `catch-up`, `setup`) — see `auto-alias.md` § Refusal targets: `--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop suitability for the canonical detail.`

## ScheduleWakeup rules for --loop-wrapped skills

Skills wrapped via `--loop` must not call `ScheduleWakeup` themselves; `/loop` owns wakeup management. The one exception is `hero --mode auto`, which is a **never-terminating adaptive watcher** rather than a drain: it re-fires every tick (tight 60-270s during bursts, 3600s flat when the queue is idle) and only stops when the user cancels via `/tasks`. Four `autopilot-*` hooks enforce this contract deterministically and are keyed to `RALPH_COMMAND=hero` (the slim path) — `autopilot-enable-gate.sh` refuses to dispatch the inner `/loop` unless `RALPH_AUTOPILOT_ENABLE=true`, `autopilot-director-postcheck.sh` arms the loop when it sees `Skill("loop", …/ralph:hero --tick…)` and marks each tick as needing a wakeup, `autopilot-wakeup-clear.sh` clears that mark when `ScheduleWakeup` fires (and rejects the 300s cache-window anti-pattern), and `autopilot-stop-gate.sh` blocks session exit if a tick returns without a wakeup. (The legacy `ralph-hero` plugin / Director-dispatch path these hooks were originally written for is deprecated.) Adding a new direct `ScheduleWakeup` call from inside any other loop-suitable skill body is a bug — if you need to influence the wakeup cadence, do it via the continuation prompt in `loop-wrapper.md` instead.
