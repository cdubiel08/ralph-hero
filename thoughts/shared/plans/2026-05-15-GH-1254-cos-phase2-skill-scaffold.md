---
date: 2026-05-15
status: draft
type: plan
github_issue: 1254
github_issues: [1254]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1254
primary_issue: 1254
parent_plan: thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md
tags: [cos-mode, pi-coding-agent, chief-of-staff, skill-scaffold, ralph-cli, local-llm]
---

# cos mode Phase 2 — COS skill scaffold + `ralph cos {desk,remote,unattended}` CLI wiring

## Prior Work

- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]] (parent plan-of-plans — shared constraints, mode architecture, system-prompt voice)
- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]] (Phase 1 — `cos.sh` CLI surface, `model-roles.sh` sourced helper, `~/.config/mcp/mcp.json` allowlist, JSONL run-log schema)
- builds_on:: [[2026-05-14-pi-coding-harness-as-chief-of-staff]] (research — pi headless usage, three-mode rationale, no-Claude-Code-on-remote constraint)
- builds_on:: [[2026-02-27-ralph-cli-qol-improvements]] (prior plan — 3-mode dispatch pattern via just recipes + `cli-dispatch.sh`)

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1254 | cos mode Phase 2 — COS skill scaffold + `ralph cos {desk,remote,unattended}` CLI wiring | S |

Single-issue plan (one phase, one PR). Phase 2 scaffolds the `cos` skill — `SKILL.md`, dedicated `cos-agent.md`, static system prompt — and wires `ralph cos desk|remote|unattended` into the existing justfile-based CLI. Ships the **`remote` mode** as the first complete user-facing path: phone/tablet status pulls routed through the local LLM (Qwen 3.5 27B via Phase 1's `cos.sh`) with a 30-minute response cache. `desk` and `unattended` are stubs that print a "see Phase 5/3" message — not silent no-ops.

## Shared Constraints

Inherited from the parent plan-of-plans (`thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md`):

- **No fork of pi.** Vanilla `@earendil-works/pi-coding-agent` only; conventions added as wrapper scripts.
- **No replacement for `ralph-knowledge`.** No new memory tier in this phase.
- **No TTSR (Time Traveling Streamed Rules) in v1.** The cos system prompt is a static markdown file; no pattern-triggered rule injection. Revisit after Phase 6.
- **No Raspberry Pi hardware.** Remote routes go through M5 Pro + Tailscale + ntfy → phone.
- **All COS state lives under `~/.ralph-hero/cos/`** (`runs/`, `logs/`, `cache/`, `prompts/`). Phase 2 adds `cache/`.
- **Model is Qwen 3.5 27B** by default (per Phase 1's `model-roles.sh`). The `remote` mode uses the `smol` role (Qwen 3.5 7B) for the cache-miss synthesis call — speed matters more than depth on a phone-friendly summary.
- **MCP write tools are off by default.** Phase 1's `mcp.json` allowlists only read tools. Phase 2 does not change that.

Phase 2-specific constraints:

- **Zero Claude Code usage on the `remote` path.** `ralph cos remote` must NOT route through `cli-dispatch.sh`'s `claude -p` invocation. It is a direct shell-out to `cos-remote.sh` → `cos.sh` (Phase 1) → local mlx-openai-server. Verified by `ps aux | grep claude` returning no new processes during a remote-mode call.
- **`cos.sh` CLI surface is the stable contract** Phase 2 binds against. From Phase 1: positional prompt + `--role <name>` flag + JSONL row in `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`. Phase 2 does not modify `cos.sh`.
- **Skill discovery is filesystem-based.** Claude Code auto-discovers skills from `plugin/ralph-hero/skills/<name>/SKILL.md`. No registration step beyond writing the file.
- **The `desk` and `unattended` stubs must exit with a clear "not yet implemented" message and exit code 0** (not failure). Phase 3 wires `unattended`; Phase 5 wires `desk`. Failing the command would block users from running `ralph cos --help` cleanly.
- **System prompt is referenced from `SKILL.md` via `!cat` fragment include** (parent-plan-mandated pattern). The cos skill body sources `skills/cos/system-prompt.md` so the prompt is one file authored once and consumed by both the skill body and `cos.sh --append-system-prompt`.

## Pre-flight verification (completed during planning)

- **Phase 1 CLI surface confirmed in source.** Per `thoughts/shared/plans/2026-05-15-GH-1253-cos-phase1-pi-foundation.md` (Task 1.2): `cos.sh` accepts `[--role <name>] [--help] <prompt>`, sources `model-roles.sh` from `${BASH_SOURCE[0]}`'s directory, appends one JSONL row per run to `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` with fields `{ts, role, prompt_hash, model, exit_code, duration_ms}`, exits with pi's exit code, prints pi stdout unmodified.
- **Justfile dispatch pattern verified.** `plugin/ralph-hero/justfile` recipes invoke `scripts/cli-dispatch.sh` which calls `claude /ralph-hero:<skill>` for `claude`-routed recipes. The cos recipes deliberately bypass this — they call shell scripts directly (zero-Claude-Code-on-remote constraint). The justfile already has a precedent for direct shell-out: `pick`, `info`, `move`, `comment` recipes call `_mcp_call` directly without going through `claude`.
- **MCP read tools confirmed.** `ralph_hero__pipeline_dashboard` (`tools/dashboard-tools.ts:53`), `ralph_hero__recent_activity` (`tools/activity-tools.ts:15`), `ralph_hero__next_actions`, `ralph_hero__list_issues`, `ralph_hero__get_issue` all registered in the MCP server. The `mcp.json` allowlist created by Phase 1 includes all five.
- **Skill auto-discovery confirmed.** Existing skills (`autopilot`, `catch-up`, `hello`, etc.) live as `plugin/ralph-hero/skills/<name>/SKILL.md` with no separate manifest — discovery is filename-based.
- **Agent file naming convention.** Existing agents follow `plugin/ralph-hero/agents/<name>-agent.md` (e.g. `catch-up-agent.md`, `hello-agent.md`, `triage-agent.md`). Phase 2 follows the same pattern with `cos-agent.md`.
- **Cache directory convention.** Other ralph-hero state dirs live under `~/.ralph-hero/<area>/` (e.g. `activity/`, `cursors/`, `snapshots/`). `~/.ralph-hero/cos/cache/` extends Phase 1's `runs/` + `logs/`.

## Current State Analysis

After Phase 1 (#1253) ships, the cos foundation exists but is invisible to end users:

- **Wrapper script**: `plugin/ralph-hero/scripts/cos/cos.sh` — invokable directly, but no `ralph cos *` surface. Users discover it only by reading the plan.
- **MCP config**: `~/.config/mcp/mcp.json` — pi can call MCP tools but only when pi runs. No higher-level orchestration yet.
- **State dirs**: `~/.ralph-hero/cos/runs/` and `~/.ralph-hero/cos/logs/` are populated. `cache/` and `prompts/` are not yet created.
- **No skill**: `plugin/ralph-hero/skills/cos/` does not exist. Claude Code cannot dispatch `/ralph-hero:cos`.
- **No agent**: `plugin/ralph-hero/agents/cos-agent.md` does not exist. Skills that wanted to compose cos as a sub-agent could not.
- **No CLI surface**: `ralph cos` returns "Unknown command 'cos'" from `ralph-cli.sh`'s pre-flight check (`scripts/ralph-cli.sh:124-141`).
- **No system prompt**: `cos.sh` is invoked without `--append-system-prompt` (Phase 1 deferred prompt authoring to Phase 2).

### Key Discoveries

- The Phase 1 plan explicitly defers prompt authoring: *"No system prompt for the cos agent — Phase 2 creates `prompts/system.md`. Phase 1's `cos.sh` does NOT pass `--append-system-prompt`."* Phase 2 owns prompt authoring AND deciding how `cos.sh` consumes it. Simplest: `cos-remote.sh` and friends pass `--append-system-prompt "$PLUGIN_ROOT/skills/cos/system-prompt.md"` when invoking `cos.sh`. `cos.sh` itself stays prompt-agnostic.
- The parent plan placed the system prompt under `skills/cos/prompts/system.md`. Phase 1's deferral comment references `prompts/system.md`. The GH-1254 issue body places it at `skills/cos/system-prompt.md` (no subdirectory). **This plan uses `skills/cos/system-prompt.md`** (flat path per the issue body, which is the authoritative spec) and treats `prompts/` as reserved for Phase 3+ multi-prompt expansion.
- `ralph-cli.sh` pre-flight (line 124) checks the requested recipe against `just --summary`. Adding a `cos` recipe to the justfile is sufficient — no edits to `ralph-cli.sh`.
- `cli-dispatch.sh` has a `headless` path (`claude -p`) and an `interactive` path (`claude`). The cos recipes do not call `dispatch()` — they directly `exec` a script.
- The `remote` mode's cache file path needs to be a single fixed location (not date-stamped) because the freshness check is "younger than 30 min", not "today's file". The parent plan and issue body agree: `~/.ralph-hero/cos/cache/remote-status.json`. JSON (not markdown) is the right format because the cache stores `{timestamp, summary, model, prompt_hash}` for both replay and debuggability.
- The `desk` and `unattended` stubs are not just placeholders — they are part of the user-discoverable surface. `ralph cos --help` must list all three modes, and each must respond meaningfully. The stub exits 0 with a `# TODO(Phase 3|5): wire this`-style message so the user knows the mode is reserved, not broken.

## Desired End State

After this phase merges:

1. `plugin/ralph-hero/skills/cos/SKILL.md` exists with valid frontmatter. Claude Code auto-discovers `/ralph-hero:cos`. Frontmatter description triggers on "cos", "chief of staff", "morning brief", "status update from phone".
2. `plugin/ralph-hero/agents/cos-agent.md` exists with `skills: [cos]` preloaded and a tools allowlist scoped to read-only MCP tools + Bash + Read + WebFetch.
3. `plugin/ralph-hero/skills/cos/system-prompt.md` exists. The voice is "brief, factual, no narration of internal steps"; explicit non-actions documented (no write tools without `RALPH_COS_ALLOW_WRITES=1`).
4. `ralph cos --help` exits 0 and lists `desk`, `remote`, `unattended` with one-line descriptions.
5. `ralph cos remote` exits 0:
   - On a cache hit (cache file < 30 min old): returns the cached summary in < 5 s.
   - On a cache miss: shells out to `cos.sh --role smol` with a status-pull prompt, captures the response, writes `~/.ralph-hero/cos/cache/remote-status.json` (atomic write via tmp + mv), prints the summary, returns in < 30 s.
   - Zero `claude` or `claude-code` processes spawned (verified with `ps aux | grep claude` during the run).
6. `ralph cos desk` exits 0 with `cos desk is not yet implemented — see Phase 5 (GH-1257)`. Same for `ralph cos unattended` referencing GH-1255.
7. The justfile has three new recipes (`cos`, `cos-remote`, plus help dispatch) and the `cos` group is documented in `just --list`.
8. The skill discovery test passes: invoking `/ralph-hero:cos` in a Claude Code session loads `SKILL.md` and the system prompt without error.

### Verification

- [ ] `claude --plugin ralph-hero --list-skills | grep cos` shows the new skill
- [ ] `ralph cos --help` exits 0 with all three modes listed
- [ ] `ralph cos remote` exits 0 and prints a 2–3 sentence status summary in < 30 s (cache-miss) or < 5 s (cache-hit)
- [ ] `ls ~/.ralph-hero/cos/cache/remote-status.json` shows the cache file after one `cos remote` call
- [ ] `jq '.timestamp, .summary, .model, .prompt_hash' ~/.ralph-hero/cos/cache/remote-status.json` returns non-null values
- [ ] `ralph cos desk` and `ralph cos unattended` exit 0 with the documented "not yet implemented" message
- [ ] No `claude` or `claude-code` process spawned during `ralph cos remote` (verified by attaching `pgrep claude` before and after)
- [ ] `bash -n` exits 0 for `cos-remote.sh`, `cos-desk.sh`, `cos-unattended.sh`

## What We're NOT Doing

- **No `desk` mode implementation.** Phase 5 (#1257) ships the Streamlit dashboard. Phase 2 only ships the stub that prints a "see Phase 5" message.
- **No `unattended` mode implementation.** Phase 3 (#1255) ships the morning-brief launchd job. Phase 2 only ships the stub.
- **No `cos-loop.sh` or `gh-vfs.ts`.** Phase 4 (#1256) ships those.
- **No ntfy.sh integration.** Phase 3 owns ntfy. The `remote` mode in Phase 2 prints to stdout — phone delivery comes later via either `ntfy publish` (Phase 3) or `tailscale serve` (Phase 5).
- **No TTSR or dynamic rule injection.** The system prompt is a single static markdown file. Per parent plan, revisit after Phase 6.
- **No edits to `cos.sh`.** Phase 1's wrapper is treated as a stable contract. If a flag is needed (e.g., `--system-prompt`), `cos-remote.sh` passes through `pi` flags via env vars, not by mutating `cos.sh`.
- **No `bats` unit tests for the new shell scripts.** Phase 4 introduces the bats scaffold alongside `cos-loop.sh`. Phase 2 ships with `bash -n` lint + manual smoke verification + one acceptance script that exercises the cache-hit/miss paths.
- **No write-tool enablement.** `RALPH_COS_ALLOW_WRITES` stays off for `remote` mode. The system prompt explicitly forbids write tools.
- **No changes to `mcp.json`.** The Phase 1 allowlist is sufficient — `remote` mode reads pipeline state via `pipeline_dashboard`, `next_actions`, `recent_activity` (all already allowed).
- **No multi-project support in the cache.** The cache key is the empty string (one cache slot per machine). If the user runs cos against multiple projects, the cache will thrash. Multi-project caching is out of scope; document the constraint in `SKILL.md`.

## Implementation Approach

Phase 2 has six task groups. Tasks 2.1–2.3 (skill, agent, system prompt) can run in parallel — they are pure file creation with no inter-dependencies. Tasks 2.4 (`cos-remote.sh`) and 2.5 (`cos-desk.sh` + `cos-unattended.sh` stubs) depend on the system prompt path being settled. Task 2.6 (justfile wiring + `ralph-cli.sh` recipe registration) depends on all three handler scripts existing.

The skill body is intentionally thin — it lists the three modes, points at the system-prompt fragment via `!cat`, and otherwise defers to the underlying scripts. The cos skill is NOT a multi-step orchestrator like `hero` or `autopilot`; it is a mode-dispatcher that mostly exists for skill-discoverability and to host the static system prompt.

The agent file is even thinner — its only job is to preload the cos skill so it can be invoked as `Agent(subagent_type="ralph-hero:cos-agent", ...)` from future composing skills (e.g., Phase 3's morning brief). Phase 2 does not exercise this composition path; it ships the file so Phase 3 doesn't have to.

---

## Phase 1: COS skill scaffold + `ralph cos {desk,remote,unattended}` CLI wiring

- **depends_on**: null

### Overview

Author the skill, agent, and system prompt; ship `cos-remote.sh` as the first complete user-facing handler with a 30-min response cache; ship `cos-desk.sh` and `cos-unattended.sh` as exit-0 stubs that print phase-pointer messages; wire all three into the justfile so `ralph cos {desk,remote,unattended}` resolves through `ralph-cli.sh`'s pre-flight check.

### Tasks

#### Task 2.1: Author `SKILL.md`

- **files**: `plugin/ralph-hero/skills/cos/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/cos/SKILL.md`
  - [ ] Frontmatter has `description:` field whose body triggers on the literal strings `cos`, `chief of staff`, `morning brief`, `status update from phone`. Voice mirrors existing skills (one paragraph, action-oriented).
  - [ ] Frontmatter `argument-hint:` is `"<mode> [args...]"` where `<mode>` is one of `desk`, `remote`, `unattended`
  - [ ] Frontmatter `context:` is `inline` (matches `hello` and `catch-up`)
  - [ ] Frontmatter `allowed-tools:` lists at minimum: `Read`, `Bash`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity`. (These let a future composing agent inspect state without leaving the skill.)
  - [ ] Body contains a `## Modes` section enumerating the three modes with one-line descriptions
  - [ ] Body includes a `!cat ${CLAUDE_PLUGIN_ROOT}/skills/cos/system-prompt.md` fragment include to inject the static system prompt at skill-load time
  - [ ] Body documents the dispatcher: `desk` → `cos-desk.sh`, `remote` → `cos-remote.sh`, `unattended` → `cos-unattended.sh` (file paths relative to plugin root)
  - [ ] Body documents the `Zero Claude Code on remote` constraint with one sentence
  - [ ] Body documents the cache slot (`~/.ralph-hero/cos/cache/remote-status.json`, 30-min TTL, single-slot — known limitation)
  - [ ] File passes `head -1 SKILL.md | grep -q '^---$'` (valid YAML frontmatter open)

#### Task 2.2: Author `cos-agent.md`

- **files**: `plugin/ralph-hero/agents/cos-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/agents/cos-agent.md`
  - [ ] Frontmatter has `name: cos-agent`, `description: <one-liner>`, `model: sonnet` (matches the Async-loop tier in the model-tier policy — cos is dispatched by composing skills, not by hero/team)
  - [ ] Frontmatter `skills: [cos]` (preloads the SKILL.md content from Task 2.1)
  - [ ] Frontmatter `tools:` is a hard allowlist with: `Read`, `Bash`, `WebFetch`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_recall`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`
  - [ ] Frontmatter does NOT include any write-capable MCP tools (`save_issue`, `create_issue`, `create_comment`, etc.) — enforces the read-only constraint at the runtime boundary
  - [ ] Body is 5–15 lines explaining the agent's role (compose cos skill primitives, surface status, never mutate)
  - [ ] Body explicitly states: "This agent runs `cos-*.sh` scripts via Bash; it does not invoke `claude -p`."

#### Task 2.3: Author system prompt

- **files**: `plugin/ralph-hero/skills/cos/system-prompt.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/cos/system-prompt.md`
  - [ ] First line is `# Chief-of-Staff System Prompt` (heading lets `--append-system-prompt` include the file without context confusion)
  - [ ] Voice section: "brief, factual, no narration of internal steps. Output is read by the user on a phone — terseness is a virtue."
  - [ ] Tool preferences: prefer `ralph_hero__next_actions` over `list_issues` for ranking; prefer `knowledge_recall(role=researcher)` over `knowledge_search` for retrieval.
  - [ ] Output conventions: markdown (no plain text), absolute file paths, mermaid diagrams over prose when shape matters.
  - [ ] Explicit non-actions, one bullet each: never modify GitHub issues; never push branches; never call MCP write tools; never escalate to Claude Code; never spawn long-running processes; never fabricate issue numbers (cross-check against `next_actions`).
  - [ ] One example output block showing the target `remote` shape: a 2-3 sentence status summary with one issue reference (`#NNN`) and one date.
  - [ ] File length ≤ 80 lines (concise — the local LLM has 8K-context limits in practice with tool calls eating space).

#### Task 2.4: Author `cos-remote.sh`

- **files**: `plugin/ralph-hero/scripts/cos/cos-remote.sh` (create), `plugin/ralph-hero/scripts/cos/cos.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.3]
- **acceptance**:
  - [ ] File exists, marked executable (`chmod +x`)
  - [ ] `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Supports `--help` / `-h`: exits 0 with usage including the cache path and TTL
  - [ ] Supports `--no-cache`: forces a cache-miss path even if the file is fresh (for debugging)
  - [ ] Resolves `PLUGIN_ROOT` via `${BASH_SOURCE[0]}` (so the script works when symlinked from `~/.local/bin`)
  - [ ] Creates `~/.ralph-hero/cos/cache/` if missing (`mkdir -p`)
  - [ ] Cache file path: `$HOME/.ralph-hero/cos/cache/remote-status.json`
  - [ ] Cache freshness check: file exists AND `mtime` within 1800 s of `now` (uses `stat -f %m` on macOS / `stat -c %Y` on Linux — detect via `uname`)
  - [ ] On cache hit: reads `.summary` from the cache JSON via `jq -r .summary`, prints to stdout, exits 0
  - [ ] On cache hit: total elapsed time < 5 s (asserted via wall-clock in the smoke test)
  - [ ] On cache miss: invokes `cos.sh --role smol "<prompt>"` where the prompt instructs the model to call `pipeline_dashboard`, `next_actions`, `recent_activity` (read tools — already in `mcp.json` allowlist) and emit a 2–3 sentence summary. The exact prompt is inlined in the script (no separate prompts/ file in this phase — keeps the cache key simple).
  - [ ] On cache miss: passes `--append-system-prompt "$PLUGIN_ROOT/skills/cos/system-prompt.md"` to `cos.sh`. (Phase 1 deferred this — `cos-remote.sh` is the consumer that adds the flag at invocation time.)
  - [ ] Captures `cos.sh` stdout into a variable; writes a JSON object to a temp file then `mv -f` to the cache path (atomic update). JSON shape: `{"timestamp": "<ISO-8601 UTC>", "summary": "<captured stdout>", "model": "<COS_MODEL from cos.sh JSONL row>", "prompt_hash": "<sha256 of the inlined prompt>"}`
  - [ ] If `cos.sh` exits non-zero, propagates the exit code, does NOT update the cache, prints `cos-remote: upstream cos.sh failed (exit N) — cache not updated` to stderr
  - [ ] Prints the summary to stdout (cache-hit AND cache-miss paths) — caller does not need to re-read the cache
  - [ ] Adds no `claude` invocations anywhere in the script (verified by `grep -E '(^|\s)claude(\s|$)' cos-remote.sh` returning empty)
  - [ ] `bash -n cos-remote.sh` passes

#### Task 2.5: Author `cos-desk.sh` and `cos-unattended.sh` stubs

- **files**: `plugin/ralph-hero/scripts/cos/cos-desk.sh` (create), `plugin/ralph-hero/scripts/cos/cos-unattended.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Both files exist, marked executable
  - [ ] Both have `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] `cos-desk.sh` exits 0 with stdout: `cos desk is not yet implemented — see Phase 5 (https://github.com/cdubiel08/ralph-hero/issues/1257)`
  - [ ] `cos-unattended.sh` exits 0 with stdout: `cos unattended is not yet implemented — see Phase 3 (https://github.com/cdubiel08/ralph-hero/issues/1255)`
  - [ ] Neither script spawns `claude` (`grep claude` returns empty)
  - [ ] Both pass `bash -n` lint
  - [ ] Both support `--help` / `-h` and print a one-line "stub for Phase N — see GH-NNNN" message
  - [ ] Stub messages mention the corresponding GitHub issue URL so future spelunkers can find context fast

#### Task 2.6: Wire `cos` into the justfile

- **files**: `plugin/ralph-hero/justfile` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.4, 2.5]
- **acceptance**:
  - [ ] Adds a single new recipe `cos mode='--help' *args` with `[group('cos')]` annotation
  - [ ] Recipe body dispatches on `mode`:
    - `--help` / `-h` / empty → cat a help string listing the three modes and exit 0
    - `desk` → `exec` `plugin/ralph-hero/scripts/cos/cos-desk.sh "${@:2}"`
    - `remote` → `exec` `plugin/ralph-hero/scripts/cos/cos-remote.sh "${@:2}"`
    - `unattended` → `exec` `plugin/ralph-hero/scripts/cos/cos-unattended.sh "${@:2}"`
    - unknown → print `unknown cos mode: <mode>` to stderr, exit 2
  - [ ] Recipe uses `#!/usr/bin/env bash` script form (not single-line just), because just's positional-arg passing makes the dispatch awkward as a one-liner
  - [ ] Path resolution uses `{{justfile_directory()}}` so `ralph cos` works from any cwd
  - [ ] `ralph cos --help` exits 0 (verified by adding `cos` to the list of recipes in `just --summary`, which `ralph-cli.sh:124` checks against)
  - [ ] `ralph cos remote` exits 0 and the underlying `cos-remote.sh` is invoked (verified by checking `ps -p $! -o args=` during the call — args should reference the cos-remote.sh path, not `claude`)
  - [ ] Recipe does NOT route through `cli-dispatch.sh` (verified by `grep -A20 '^cos ' justfile | grep -v 'cli-dispatch.sh'` — should be no match)
  - [ ] `ralph cos --help` from outside the plugin directory (e.g. `cd /tmp && ralph cos --help`) still works

### Phase Success Criteria

#### Automated Verification

- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos-remote.sh` exits 0
- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos-desk.sh` exits 0
- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos-unattended.sh` exits 0
- [ ] `just --summary` includes `cos`
- [ ] `head -1 plugin/ralph-hero/skills/cos/SKILL.md` matches `^---$` (valid frontmatter)
- [ ] `head -1 plugin/ralph-hero/agents/cos-agent.md` matches `^---$` (valid frontmatter)
- [ ] `wc -l plugin/ralph-hero/skills/cos/system-prompt.md` returns ≤ 80
- [ ] `grep -rE '(^|\s)claude(\s|$)' plugin/ralph-hero/scripts/cos/cos-remote.sh` returns nothing (zero Claude Code on remote path)
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` still passes (no MCP-server changes in this phase, but the CI gate stays green)

#### Manual Verification

- [ ] On a machine with `pi` + `mlx-openai-server` running:
  - [ ] `ralph cos --help` exits 0 and prints the three modes with one-line descriptions
  - [ ] `ralph cos remote` (cache empty) returns a 2–3 sentence summary in < 30 s, creates `~/.ralph-hero/cos/cache/remote-status.json`
  - [ ] `ralph cos remote` (immediate re-run) returns the cached summary in < 5 s
  - [ ] `ralph cos remote --no-cache` forces a cache-miss path and updates the file
  - [ ] `ralph cos desk` and `ralph cos unattended` exit 0 with the stub messages
- [ ] `ps aux | grep -E '(claude|claude-code)' | grep -v grep` during a `ralph cos remote` call shows zero matches (other than the user's existing Claude Code session)
- [ ] The cache file's `summary` field is non-empty plain text (no surrounding JSON escapes leaking through)
- [ ] The cache file's `timestamp` field is a valid ISO-8601 UTC string parseable by `date -j -f '%Y-%m-%dT%H:%M:%SZ'`
- [ ] Opening a fresh Claude Code session in this repo and typing `/ralph-hero:cos` loads the skill content without "skill not found" errors
- [ ] Dispatching `Agent(subagent_type="ralph-hero:cos-agent", ...)` from a test prompt works (skill preloads, tools allowlist enforced)
- [ ] The cos system prompt is visibly in effect: `cos.sh --role smol "echo something"` (with no `--append-system-prompt`) and `cos-remote.sh` (with the system prompt) produce visibly different output styles — the latter is terser and follows the documented output conventions

**Creates for next phase**:

- A stable `cos-unattended.sh` entry point that Phase 3's morning-brief launchd job invokes (Phase 3 extends the stub into a real handler that reads `--job morning-brief` and runs the brief flow).
- A stable `cos-desk.sh` entry point that Phase 5's Streamlit launcher replaces (Phase 5 swaps the stub for a Streamlit app launcher).
- A `system-prompt.md` that Phase 3's brief prompt extends (Phase 3 will reuse the voice + non-actions section verbatim).
- A `cos-agent.md` that Phase 3's morning-brief composer can dispatch via `Agent(subagent_type="ralph-hero:cos-agent", ...)`.

---

## Integration Testing

- [ ] After Phase 2 ships, run `ralph cos remote` from the repo root and confirm a markdown-friendly summary appears
- [ ] Run `ralph cos remote` twice in a row; confirm the second run is sub-5-second (cache hit) by timing with `time`
- [ ] Inspect `~/.ralph-hero/cos/cache/remote-status.json` with `jq` and verify the four keys (`timestamp`, `summary`, `model`, `prompt_hash`)
- [ ] Inspect today's `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` (from Phase 1) and confirm one row was added per cache-miss `cos-remote.sh` call
- [ ] Cross-check that `ralph cos desk` and `ralph cos unattended` exit 0 with their pointer messages
- [ ] Cross-check the skill's discoverability: `claude /ralph-hero:cos` in an interactive session loads the SKILL body without errors

## References

- Issue: [GH-1254](https://github.com/cdubiel08/ralph-hero/issues/1254)
- Parent issue: [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252)
- Parent plan-of-plans: `thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md`
- Phase 1 plan: `thoughts/shared/plans/2026-05-15-GH-1253-cos-phase1-pi-foundation.md` (defines the `cos.sh` CLI contract Phase 2 binds against)
- Research: `thoughts/shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md`
- Existing skill precedent (mode-dispatcher pattern): `plugin/ralph-hero/skills/autopilot/SKILL.md`
- Existing skill precedent (thin wrapper with inline content): `plugin/ralph-hero/skills/hello/SKILL.md`
- Existing agent precedent (read-only tool allowlist): `plugin/ralph-hero/agents/catch-up-agent.md`
- CLI dispatch source: `plugin/ralph-hero/scripts/cli-dispatch.sh` (cos recipes deliberately bypass this — direct shell-out only)
- Model-tier policy (justifies `sonnet` for cos-agent): `plugin/ralph-hero/docs/model-tier-policy.md`
