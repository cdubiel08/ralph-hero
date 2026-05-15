---
date: 2026-05-15
status: draft
type: plan
github_issue: 1253
github_issues: [1253]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1253
primary_issue: 1253
parent_plan: thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md
tags: [cos-mode, pi-coding-agent, mlx, mcp, chief-of-staff, wrapper-scripts]
---

# cos mode Phase 1 — pi foundation + cos.sh wrapper

## Prior Work

- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]] (parent plan-of-plans covering all 6 cos-mode phases)
- builds_on:: [[2026-05-14-pi-coding-harness-as-chief-of-staff]] (primary research — pi headless usage, extensions, launchd patterns, gotchas)
- builds_on:: [[2026-05-14-pi-gemma-4-claude-code-setups]] (research — Gemma 4 MLX tool-call breakage; route to Qwen 3.5 27B instead)

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1253 | cos mode Phase 1 — pi foundation + cos.sh wrapper | S |

Single-issue plan (one phase, one PR). Phase 1 lays the foundation for the entire `cos` (chief-of-staff) skill stack: install the three required pi extensions, mount `ralph-knowledge` + `ralph-github` MCP servers into pi's MCP config (read-only by default, write gated by an env flag), and ship the `cos.sh` wrapper that resolves model roles and writes JSONL run logs. The wrapper's CLI surface (positional prompt + `--role` flag + env-var-based model resolution) becomes the stable contract every downstream phase depends on.

## Shared Constraints

These constraints are inherited verbatim from the parent plan ([[2026-05-14-GH-1252-ralph-hero-cos-mode]]) and apply to all cos-mode phases including this one:

- **No fork of pi.** Use vanilla `@earendil-works/pi-coding-agent`. Borrow conventions via wrapper scripts and small pi extensions, not by switching CLIs.
- **No replacement for `ralph-knowledge`.** No new memory tier; `cos_retain` is a thin wrapper around existing MCP tools (out of scope for Phase 1).
- **No TTSR (Time Traveling Streamed Rules) in v1.** Pattern-triggered rule injection is interesting but failure modes are better addressed by `--tools` allowlists + launchd `TimeOut`.
- **No Raspberry Pi hardware.** Remote routes go through M5 Pro + Tailscale + ntfy → phone.
- **All COS state lives under `~/.ralph-hero/cos/`** (`cursors/`, `logs/`, `runs/`, `prompts/`, `cache/`) — same root convention as `catch-up`, `delegate`, `activity`. No new top-level dir.
- **Model is Qwen 3.5 27B** (`qwen3.5-27b`), not Gemma 4. Gemma 4's MLX tool-call parser is still broken upstream. `~/.pi/agent/settings.json` is already pinned to this — do not change.
- **MCP write tools are off by default.** Unattended jobs must not mutate the project board without explicit opt-in via `RALPH_COS_ALLOW_WRITES=1`.

Phase-1-specific constraints:

- **`cos.sh` CLI surface is a stable contract once this phase merges.** Phases 2–6 will depend on the positional prompt + `--role` flag + JSONL log shape. Treat any change to this surface as a breaking change requiring downstream updates.
- **`model-roles.sh` must be sourced, not exec'd.** It exports `COS_MODEL` (and related vars) into the caller's env. Downstream scripts (Phase 4's `cos-loop.sh`, Phase 3's `cos-unattended.sh`) will source this helper too.
- **`~/.config/mcp/mcp.json` is global, not project-local.** All `cos` invocations see the same MCP servers regardless of `cwd`. If the file already exists (from other pi work), the install step must detect and merge rather than overwrite.

## Current State Analysis

The `ralph-hero` plugin (v2.5.151) has the right shape but no cos-flavored scripts. Existing infrastructure that Phase 1 builds on:

- **CLI entry point**: `plugin/ralph-hero/scripts/ralph-cli.sh` installed to `$HOME/.local/bin/ralph` by the `setup-cli` skill. Dispatches to recipes in a `justfile`. New `cos` commands surface in Phase 2 — Phase 1 ships scripts only.
- **Scripts directory layout**: `plugin/ralph-hero/scripts/` contains `activity/`, `delegate/`, `lib/`, `snapshot/`, `unblock/` — each a self-contained skill-support subtree. Phase 1 adds `cos/`.
- **State convention**: `~/.ralph-hero/` is the established root (used by `activity/`, `cursors/`, `delegate.log`). Phase 1 adds `~/.ralph-hero/cos/` with `runs/` (JSONL logs) and `logs/` (stdout/stderr tee).
- **pi 0.74.0 already installed** at `/Users/dubiel/.local/share/mise/installs/node/22.22.1/bin/pi`. `~/.pi/agent/settings.json` pinned to `qwen3.5-27b`. `~/.pi/agent/extensions/mlx-local.ts` auto-spawns the MLX server on `:8000` (no changes needed).
- **No pi extensions installed yet** beyond `mlx-local.ts`. Phase 1 installs three: `pi-mcp-adapter`, `@walterra/pi-charts`, `pi-web-access`. (Charts + web-access aren't directly used by `cos.sh` but the parent plan installs them upfront so Phases 2–6 don't each need their own setup step.)
- **No `~/.config/mcp/mcp.json` yet** — Phase 1 creates it.
- **MCP server build is `npm run build`** in `plugin/ralph-hero/mcp-server/` producing `dist/index.js`. The `mcp.json` config references this absolute path. The MCP server reads `RALPH_GH_OWNER` and `RALPH_GH_PROJECT_NUMBER` from env (set in the `mcp.json` config block).

## Desired End State

After this phase merges:

1. `pi list` shows `pi-mcp-adapter`, `@walterra/pi-charts`, `pi-web-access` installed.
2. `~/.config/mcp/mcp.json` exists and mounts `ralph-knowledge` + `ralph-github`, both with read-only tool allowlists.
3. `plugin/ralph-hero/scripts/cos/cos.sh "<prompt>"` shells out to `pi -p` via the local MLX server, using the resolved model for the `default` role.
4. `plugin/ralph-hero/scripts/cos/cos.sh --role plan "<prompt>"` switches to the `plan` role's model.
5. Every invocation appends exactly one JSONL row to `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` with fields: `ts`, `role`, `prompt-hash` (sha256 of prompt), `model`, `exit-code`, `duration-ms`.
6. `plugin/ralph-hero/scripts/cos/model-roles.sh` is source-able (not exec'd) by downstream scripts.
7. Smoke test: a one-shot prompt to write a markdown file under `thoughts/shared/research/_cos-smoke/` succeeds within 30s on Qwen 3.5 27B and the JSONL log row records the run.

### Verification
- [ ] `pi list` includes all three required extensions
- [ ] `jq '.mcpServers | keys' ~/.config/mcp/mcp.json` returns `["ralph-github", "ralph-knowledge"]`
- [ ] `bash plugin/ralph-hero/scripts/cos/cos.sh --help` exits 0 with usage
- [ ] `bash plugin/ralph-hero/scripts/cos/cos.sh "Write 'cos online' to /tmp/cos-smoke.txt"` creates the file and appends one JSONL row to today's run log
- [ ] `bash plugin/ralph-hero/scripts/cos/cos.sh --role plan "..."` resolves to the `plan` role's model (visible in the JSONL `model` field)
- [ ] Sourcing `model-roles.sh` from a separate shell exports `COS_MODEL` correctly for each role
- [ ] Write tools are blocked by the MCP allowlist unless `RALPH_COS_ALLOW_WRITES=1` is set

## What We're NOT Doing

- **No COS skill itself** — `plugin/ralph-hero/skills/cos/SKILL.md` and `agents/cos-agent.md` are Phase 2's work
- **No `ralph cos {desk,remote,unattended}` CLI wiring** — Phase 2 adds the `just` recipes / dispatch
- **No `cos-loop.sh` or `gh-vfs.ts` extension** — Phase 4
- **No launchd plists or scheduled jobs** — Phase 3 (morning brief) / Phase 6 (self-improve)
- **No Streamlit dashboard** — Phase 5
- **No ntfy.sh setup** — Phase 3
- **No system prompt for the cos agent** — Phase 2 creates `prompts/system.md`. Phase 1's `cos.sh` does NOT pass `--append-system-prompt`. (Phase 2 will add a flag or wrapper that does.)
- **No bats unit tests for `cos.sh`** — Phase 4 introduces the test scaffolding alongside `cos-loop.sh`. Phase 1 ships with manual + smoke verification only.

## Implementation Approach

Phase 1 has four task groups, mostly independent and dispatchable in parallel:

1. **Install pi extensions** (one-time imperative; document in README so it's reproducible)
2. **Create `model-roles.sh`** (sourced helper — pure shell, no external deps)
3. **Create `cos.sh`** (depends on `model-roles.sh` for role resolution)
4. **Create `~/.config/mcp/mcp.json`** (depends on the MCP server being buildable but not on `cos.sh`)

Tasks 2 and 4 can run in parallel. Task 3 depends on Task 2. Task 1 is documentation-only (no code) but listed first because verification requires the extensions to be installed.

The wrapper writes a JSONL row using a small helper inlined in `cos.sh` (no external `jq` dep — use printf-formatted JSON since the field set is fixed). Duration is measured with `EPOCHREALTIME` (bash 5+) or `date +%s%N` as fallback. Prompt-hash uses `shasum -a 256` (BSD/macOS-compatible).

---

## Phase 1: pi foundation + cos.sh wrapper
- **depends_on**: null

### Overview
Install pi extensions, mount MCP servers into pi's global config, ship the `cos.sh` wrapper with model-role resolution and JSONL run logs. End state: one-shot smoke test produces a markdown file and a structured log row.

### Tasks

#### Task 1.1: Author `model-roles.sh` sourced helper
- **files**: `plugin/ralph-hero/scripts/cos/model-roles.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/cos/model-roles.sh`
  - [ ] File is NOT marked executable (sourced helpers do not need +x and the convention is to mark only entrypoints executable)
  - [ ] Defines a function `cos_resolve_model()` that reads `RALPH_COS_ROLE` (default `default`) and sets/exports `COS_MODEL`
  - [ ] Resolves four roles to env-overridable defaults:
    - `default` → `${RALPH_COS_MODEL_DEFAULT:-qwen3.5-27b}`
    - `smol` → `${RALPH_COS_MODEL_SMOL:-qwen3.5-7b}`
    - `slow` → `${RALPH_COS_MODEL_SLOW:-qwen3.5-27b}`
    - `plan` → `${RALPH_COS_MODEL_PLAN:-qwen3.5-27b}`
  - [ ] Unknown role values fall back to `default` (with a stderr warning so misconfig is visible)
  - [ ] File has a leading `# shellcheck disable=SC2034` annotation for `COS_MODEL` (consumed by sourcing scripts)
  - [ ] Sourcing the file with `RALPH_COS_ROLE=smol` and calling `cos_resolve_model` results in `COS_MODEL=qwen3.5-7b`
  - [ ] Sourcing the file with `RALPH_COS_MODEL_DEFAULT=foo` results in `COS_MODEL=foo` when role is `default`

#### Task 1.2: Author `cos.sh` wrapper
- **files**: `plugin/ralph-hero/scripts/cos/cos.sh` (create), `plugin/ralph-hero/scripts/cos/model-roles.sh` (read/source)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File exists, marked executable (`chmod +x`)
  - [ ] Has a `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Supports `--help` / `-h`: exits 0 with usage text including the four model roles and the `--role` flag
  - [ ] Supports `--role <name>`: sets `RALPH_COS_ROLE=<name>` before sourcing `model-roles.sh`
  - [ ] Sources `model-roles.sh` from the same directory (resolved via `${BASH_SOURCE[0]}`, not `$0`, so it works when symlinked)
  - [ ] Reads the prompt as the first positional argument (after flags); if empty, prints usage to stderr and exits 2
  - [ ] Computes `RUN_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)` and `PROMPT_HASH=$(printf '%s' "$PROMPT" | shasum -a 256 | cut -d' ' -f1)`
  - [ ] Creates `~/.ralph-hero/cos/runs/` and `~/.ralph-hero/cos/logs/` if missing (`mkdir -p`)
  - [ ] Run-log path is `~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl` (one file per day, append mode)
  - [ ] Invokes pi with: `--no-session --no-context-files --provider mlx-local --model "$COS_MODEL" --tools "${RALPH_COS_TOOLS:-read,write,grep,find}" -p "$PROMPT"`
  - [ ] Captures pi's exit code and duration in ms (use `EPOCHREALTIME` if available; fall back to `date +%s` with second-precision warning)
  - [ ] Appends one JSONL row to the day's run log with shape:
    ```json
    {"ts":"2026-05-15T12:34:56Z","role":"default","prompt_hash":"abc123…","model":"qwen3.5-27b","exit_code":0,"duration_ms":12345}
    ```
  - [ ] Streams pi's stdout to the caller's stdout unmodified (no `tee` rewriting structure); stderr passes through
  - [ ] Exits with pi's exit code
  - [ ] When `RALPH_COS_DEBUG=1`, prints the resolved model + tool list to stderr before invoking pi
  - [ ] When pi is not on `PATH`, prints a clear "pi not found — install @earendil-works/pi-coding-agent" message and exits 127

#### Task 1.3: Author `~/.config/mcp/mcp.json`
- **files**: `plugin/ralph-hero/scripts/cos/mcp.json.example` (create), `plugin/ralph-hero/scripts/cos/install-mcp-config.sh` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `mcp.json.example` is a complete, valid JSON config (verified by `jq . mcp.json.example`)
  - [ ] Mounts two servers under `mcpServers`:
    - `ralph-knowledge`: `command: "npx"`, `args: ["-y", "ralph-hero-knowledge-index@latest"]`, with `directToolAllowlist` set to read tools only: `knowledge_search`, `knowledge_recall`, `knowledge_communities`, `knowledge_central`, `knowledge_memory_stats`
    - `ralph-github`: `command: "node"`, `args: ["<absolute-path>/plugin/ralph-hero/mcp-server/dist/index.js"]`, with `directToolAllowlist` set to read tools only: `pipeline_dashboard`, `next_actions`, `project_hygiene`, `metrics_trends`, `recent_activity`, `list_issues`, `get_issue`, `list_sub_issues`, `list_dependencies`
    - `ralph-github` `env` block sets `RALPH_GH_OWNER` and `RALPH_GH_PROJECT_NUMBER`
  - [ ] Both servers use `"lifecycle": "lazy"` and `"directTools": true`
  - [ ] `install-mcp-config.sh` is a Bash script that:
    - Reads `mcp.json.example`
    - Substitutes `__PLUGIN_ROOT__` placeholder with the resolved absolute path to `plugin/ralph-hero` (via `realpath` or `cd … && pwd -P`)
    - Substitutes `__GH_OWNER__` with `${RALPH_GH_OWNER:-cdubiel08}` and `__GH_PROJECT_NUMBER__` with `${RALPH_GH_PROJECT_NUMBER:-3}`
    - Writes to `~/.config/mcp/mcp.json` after detecting and merging with any existing file (via `jq` if available; falls back to "file exists, refusing to overwrite — see manual merge instructions" if `jq` is missing)
    - Creates `~/.config/mcp/` if missing
    - Is idempotent: running twice does not duplicate `mcpServers` entries
    - Prints the resolved path and which servers were added/skipped
  - [ ] Write-gate documentation: header comment in `mcp.json.example` explains that write tools (`save_issue`, `create_issue`, etc.) are deliberately omitted from the allowlist; to enable, the operator must edit `mcp.json` manually AND set `RALPH_COS_ALLOW_WRITES=1` in the environment that invokes `cos.sh`

#### Task 1.4: Install pi extensions (documented, not automated)
- **files**: `plugin/ralph-hero/scripts/cos/README.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] `README.md` documents the three required pi extensions: `pi-mcp-adapter`, `@walterra/pi-charts`, `pi-web-access`
  - [ ] Documents the one-time install commands:
    ```bash
    pi install pi-mcp-adapter
    pi install @walterra/pi-charts
    pi install pi-web-access
    ```
  - [ ] Documents the MCP config install: `bash plugin/ralph-hero/scripts/cos/install-mcp-config.sh`
  - [ ] Documents the smoke test:
    ```bash
    plugin/ralph-hero/scripts/cos/cos.sh "Write 'cos online' to /tmp/cos-smoke.txt"
    cat /tmp/cos-smoke.txt   # → cos online
    cat ~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl   # → one JSONL row
    ```
  - [ ] Documents the four model roles and the corresponding env vars
  - [ ] Documents the write-gate: `RALPH_COS_ALLOW_WRITES=1` and the manual `mcp.json` allowlist edit required to enable write tools
  - [ ] Links back to the parent plan and Phase 2+ for context
  - [ ] No actual install is performed in code — this is operator setup

#### Task 1.5: Smoke-test fixture
- **files**: `plugin/ralph-hero/scripts/cos/smoke.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Executable bash script that runs the smoke flow end-to-end:
    1. Asserts `pi` is on `PATH` (else exits 127 with "pi not installed")
    2. Asserts the MLX server is reachable: `curl -fsS http://localhost:8000/v1/models >/dev/null` (else exits 1 with "MLX server not running — run `gemma-up`")
    3. Invokes `cos.sh "Write the literal string 'cos online' to /tmp/cos-smoke.txt and nothing else."`
    4. Asserts `/tmp/cos-smoke.txt` contains `cos online`
    5. Asserts today's run log exists and has at least one JSONL row with `"exit_code":0`
  - [ ] Cleans up `/tmp/cos-smoke.txt` on success
  - [ ] Exits 0 on full success, non-zero with a clear stderr message otherwise
  - [ ] Manual-only — does NOT run in CI (CI has no MLX server)

### Phase Success Criteria

#### Automated Verification:
- [ ] `jq . plugin/ralph-hero/scripts/cos/mcp.json.example` exits 0 (valid JSON)
- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos.sh` exits 0 (no syntax errors)
- [ ] `bash -n plugin/ralph-hero/scripts/cos/model-roles.sh` exits 0
- [ ] `bash -n plugin/ralph-hero/scripts/cos/install-mcp-config.sh` exits 0
- [ ] `bash -n plugin/ralph-hero/scripts/cos/smoke.sh` exits 0
- [ ] `bash plugin/ralph-hero/scripts/cos/cos.sh --help` exits 0 and prints usage including `--role`
- [ ] Sourcing test: `bash -c 'source plugin/ralph-hero/scripts/cos/model-roles.sh; RALPH_COS_ROLE=smol cos_resolve_model; echo "$COS_MODEL"'` prints `qwen3.5-7b`
- [ ] Unknown role test: `bash -c 'source plugin/ralph-hero/scripts/cos/model-roles.sh; RALPH_COS_ROLE=bogus cos_resolve_model 2>/dev/null; echo "$COS_MODEL"'` prints `qwen3.5-27b` (default fallback)

#### Manual Verification:
- [ ] On a machine with `pi` + `mlx-openai-server` running, `bash plugin/ralph-hero/scripts/cos/smoke.sh` exits 0 within 30s
- [ ] The day's run log under `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl` contains a JSONL row matching the schema in Task 1.2's acceptance criteria
- [ ] `cos.sh --role plan "..."` produces a JSONL row where `"role":"plan"` and `"model"` matches `RALPH_COS_MODEL_PLAN` (or default `qwen3.5-27b`)
- [ ] Running `install-mcp-config.sh` twice does not create duplicate `mcpServers` entries
- [ ] When `mcp.json` already exists with unrelated servers, the install script merges rather than overwriting (verified by inspecting the merged JSON)
- [ ] Write tools are not callable from `cos.sh` invocations — verify by prompting "Use ralph_hero__save_issue to add a label to issue 1253" and confirming the model reports the tool is unavailable

**Creates for next phase**: A stable `cos.sh` CLI surface that Phase 2's `cos-remote.sh` and the skill scaffold will invoke; a global `mcp.json` that Phase 2's MCP-tool-using prompts can rely on; a `model-roles.sh` helper that Phases 2–6 source for role resolution.

---

## Integration Testing
- [ ] After Phase 1 ships, manually run the smoke test once on the M5 Pro with `mlx-openai-server` live
- [ ] Inspect today's run log to confirm JSONL schema is parseable (`jq -c . ~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl | head -5`)
- [ ] Cross-check pi extension list: `pi list | grep -E '(pi-mcp-adapter|pi-charts|pi-web-access)'`
- [ ] Cross-check MCP allowlist enforcement by invoking a write tool (should fail) and a read tool (should succeed)

## References

- Parent plan: [thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md)
- Primary research: [thoughts/shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md)
- Issue: [GH-1253](https://github.com/cdubiel08/ralph-hero/issues/1253)
- Parent issue: [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252)
- Convention donor: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) (model-role helper)
- Local MLX server: `~/projects/gemma-lab/scripts/start-server.sh` (port 8000)
- ralph-knowledge MCP: `plugin/ralph-knowledge/`
- ralph-github MCP: `plugin/ralph-hero/mcp-server/`
- launchd template precedent: `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` (Phase 3+ will follow this pattern)
