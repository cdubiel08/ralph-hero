---
date: 2026-05-15
last_iterated: 2026-05-16
status: draft
type: plan
github_issue: 1257
github_issues: [1257]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1257
primary_issue: 1257
tags: [cos-mode, streamlit, pi-coding-agent, desk-mode, tailscale, dashboard]
---

# cos mode Phase 5 — Streamlit desktop command surface at :8502

## Iteration history

- **2026-05-16 (iteration 1)** — Addressed `thoughts/shared/reviews/2026-05-15-GH-1257-critique.md` (`NEEDS_ITERATION`). Changes:
  - Fixed Panel 3 (KG Growth) SQL: `created_at` → `date` (column verified against `plugin/ralph-knowledge/src/db.ts:104-113`). Updated Shared Constraints / Key Discoveries / Task 5.3 acceptance to match.
  - Clarified chat-panel streaming semantics in Task 5.3 — `cos.sh` is non-streaming, so `st.write_stream` renders line-buffered / one-shot. Wrapped in `st.spinner`. Token-by-token streaming is deferred to Phase 6+.
  - De-duplicated `st.set_page_config` wording — explicitly stated "exactly one call inside `main()`" with a note about `StreamlitAPIException`.
  - Added `Subagent context required` note to Task 5.3 listing the three plan sections the implementer must pre-read.
  - Added pre-flight finding that `ralph status --json` / `ralph activity --json` / `ralph list --json` do NOT exist today (verified by grep); promoted the MCP-stdio path from "fallback" to "primary path" for Panels 2/4/5. CLI `--json` flag work is out of scope.

## Prior Work

- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]] (Phase 1 — `cos.sh` CLI surface, `model-roles.sh` sourced helper, `mcp.json` read-only allowlist, JSONL run-log schema)
- builds_on:: [[2026-05-15-GH-1254-cos-phase2-skill-scaffold]] (Phase 2 — `plugin/ralph-hero/skills/cos/SKILL.md`, `cos-desk.sh` stub at `scripts/cos/cos-desk.sh`, `ralph cos desk` justfile dispatch)
- builds_on:: [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]] (Phase 3 — froze the brief filename convention `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md` that Panel 1 globs)
- builds_on:: [[2026-05-15-GH-1256-cos-phase4-oh-my-pi-conventions]] (Phase 4 — `cos-loop.sh` and `gh-vfs.ts` extension available to operators who use pi directly during a desk session)
- addresses:: [[2026-05-15-GH-1257-critique]] (auto-review critique — see Iteration history above)

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1257 | cos mode Phase 5 — Streamlit desktop command surface at :8502 | S |

Single-issue plan (one phase, one PR). Phase 5 replaces the `cos-desk.sh` stub from Phase 2 with a working Streamlit app at `localhost:8502` that renders six read-only panels plus a chat panel that shells out to `cos.sh`. Ships:

1. `plugin/ralph-hero/scripts/cos/desk/app.py` — a Streamlit application with six panels (Today's Brief, Pipeline State, KG Growth, Recent Activity, WIP, KG Search) and a chat panel.
2. `plugin/ralph-hero/scripts/cos/desk/launch.sh` — a thin shell wrapper that runs `streamlit run app.py --server.port 8502 --server.address 0.0.0.0`, with a Python dependency preflight.
3. `plugin/ralph-hero/scripts/cos/desk/pyproject.toml` — `uv`-managed Python deps (streamlit, vega-altair or plotly for sparklines, no extras the user does not already have via `~/projects/ralph-hero/scripts/dream/`).
4. A rewrite of `plugin/ralph-hero/scripts/cos/cos-desk.sh` — replaces the Phase 2 stub with an `exec` of `desk/launch.sh "$@"`.
5. A new `## Desk mode (Streamlit dashboard)` section in `plugin/ralph-hero/scripts/cos/README.md` documenting the port choice, Tailscale publishing, dependency install, and the zero-Claude-Code chat-panel constraint.

## Shared Constraints

Inherited from the parent plan-of-plans (`#1252` umbrella issue body — the parent plan-of-plans markdown file is not on disk; constraints are inlined here just as Phases 1–4 did):

- **No fork of pi.** All "agent" behavior in the chat panel must route through `cos.sh` → `pi` → local mlx-openai-server. The Streamlit process does NOT call the Anthropic SDK, the OpenAI SDK against any remote endpoint, or `claude` CLI.
- **No replacement for `ralph-knowledge`.** Panel 6 (KG Search) calls the existing `knowledge_search` MCP tool by shelling out to the ralph-knowledge MCP server stdio binary OR by reading the SQLite DB directly with read-only queries. It does NOT introduce a new embeddings pipeline.
- **No TTSR (Time Traveling Streamed Rules) in v1.**
- **No Raspberry Pi hardware.**
- **All COS state lives under `~/.ralph-hero/cos/`.** Phase 5 does NOT create new top-level dirs. Streamlit's session state is in-memory only (Phase 5 does not persist chat history to disk; that is a follow-up if requested).
- **Model is Qwen 3.5 27B** by default (per Phase 1's `model-roles.sh`). The chat panel uses `--role default`.
- **MCP write tools are off by default.** Phase 5 reads from the project board via `ralph_hero__pipeline_dashboard`, `ralph_hero__list_issues`, and `ralph_hero__recent_activity` — all in the existing read-only `mcp.json` allowlist. No write tools are added.

Phase 5-specific constraints:

- **Port 8502, NOT 8501.** Streamlit's default is 8501; the issue body and parent plan deliberately pick 8502 to avoid collision with other local Streamlit apps. The port is hardcoded in `launch.sh` (overridable via `RALPH_COS_DESK_PORT` env var for future flexibility, but the default is 8502 everywhere).
- **`--server.address 0.0.0.0`.** Required so Tailscale can publish the port to the Tailnet (`tailscale serve` proxies to localhost only when the listener is on all interfaces). The README documents that this is intentional and that the security model is "Tailnet-only" (no auth on the dashboard itself).
- **Chat panel is the second zero-Claude-Code path.** Every chat submission MUST shell out to `cos.sh --role default`. Phase 5 verifies this with a `grep -rE '(^|\s)(claude|anthropic|openai)(\s|$)' plugin/ralph-hero/scripts/cos/desk/app.py` returning empty (excluding pure-comment occurrences in the doc-string is fine — the regex is a smoke test, not a strict gate).
- **Brief glob is frozen by Phase 3.** Panel 1 reads `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md` (where YYYY-MM-DD is today's date), falling back to the most recent file matching `*-cos-morning-brief.md` if today's file does not exist. The glob points at the same path Phase 3's `morning-brief.sh` writes to.
- **Subprocess invocations are read-only.** Panels 2/4/5 invoke the ralph CLI via subprocess (`ralph status --json`, `ralph activity --json --limit=20 --compact`, etc.) — NOT direct MCP server calls (which would require setting up an MCP client inside Streamlit). When the CLI does not have a JSON flag for a given tool, the panel calls the MCP server via stdio using a one-shot Python helper that writes a minimal JSON-RPC request (acceptable fallback, but the CLI-first path is preferred).
- **KG DB access is read-only.** Panel 3 (KG Growth) and Panel 6 (KG Search) open `~/.ralph-hero/knowledge.db` with `sqlite3.connect("file:...?mode=ro", uri=True)`. No write paths anywhere.
- **No new MCP tool allowlist entries.** All tools used (`pipeline_dashboard`, `list_issues`, `recent_activity`, `get_issue`, `knowledge_search`) are already in the existing read-only allowlist.
- **No Streamlit auth.** Tailscale + Tailnet is the v1 security model. The README is explicit about this — do not add `streamlit-authenticator` or any login flow.
- **No mobile layout.** Streamlit's default responsive behavior is sufficient for v1. README documents that the UI is desktop-first.
- **Python deps managed by `uv`.** Follow the precedent set by `scripts/dream/pyproject.toml` — a sibling `scripts/cos/desk/pyproject.toml` lists Streamlit and its sparkline dep, and operators run `cd plugin/ralph-hero/scripts/cos/desk && uv sync` once before `ralph cos desk`. The launch script does a preflight check that `uv` is on `PATH` and that `.venv/` exists; if either is missing, it prints a clear install hint and exits non-zero.
- **Sparkline tool choice: vega-altair.** The issue body mentions `@walterra/pi-charts` (a JS pi extension installed in Phase 1) OR Streamlit-native. Streamlit ships with `st.line_chart` and `st.bar_chart` out of the box; for the 30-day KG-growth sparkline we use `st.line_chart` (no extra dep needed). For the pipeline-state horizontal bar chart we use `st.bar_chart` with a transposed dataframe. `@walterra/pi-charts` is NOT used inside Streamlit — it is a pi extension, not a Python library.

## Pre-flight verification (completed during planning)

- **`cos-desk.sh` stub confirmed.** `plugin/ralph-hero/scripts/cos/cos-desk.sh:1-30` is a 30-line stub that prints "cos desk is not yet implemented — see Phase 5" and exits 0. Phase 5 rewrites this file to `exec` the new `desk/launch.sh`.
- **`cos.sh` CLI contract confirmed.** `plugin/ralph-hero/scripts/cos/cos.sh:33-228` accepts `[--role <name>] [--append-system-prompt <file>] <prompt>` and writes one JSONL row per invocation. The chat panel invokes it via `subprocess.run(["bash", cos_sh_path, "--role", "default", prompt], capture_output=True, text=True)`.
- **MCP tool names confirmed.** `plugin/ralph-hero/mcp-server/src/index.ts:540` registers `ralph_hero__recent_activity`. `pipeline_dashboard` and `list_issues` are also registered (confirmed via `grep -rn "ralph_hero__pipeline_dashboard" plugin/ralph-hero/mcp-server/src/`). The Phase 1 `mcp.json` allowlist includes all three.
- **Brief filename confirmed.** `plugin/ralph-hero/scripts/cos/morning-brief.sh:115` writes to `${THOUGHTS_DIR}/shared/research/${DATE}-cos-morning-brief.md`. Panel 1 globs the same path.
- **KG DB path + schema confirmed.** `~/.ralph-hero/knowledge.db` per `~/projects/CLAUDE.md` and `~/.ralph/knowledge.config.json`. SQLite schema verified against `plugin/ralph-knowledge/src/db.ts:104-113` — the `documents` table has columns `id, path, title, date, type, status, github_issue, content, is_stub, memory_tier`. **There is no `created_at` column; the timestamp column is `date` (TEXT, ISO-8601).** Panel 3 queries `SELECT date(date) AS day, memory_tier, COUNT(*) FROM documents WHERE date >= date('now', '-30 day') GROUP BY 1, 2`. The outer `date()` is the SQLite function, the inner `date` is the column — awkward but valid.
- **ralph CLI `--json` flag — does NOT exist today.** Verified by `grep -rn -- "--json" plugin/ralph-hero/scripts/ralph*` returning empty. Panels 2/4/5 cannot use the `ralph status --json` / `ralph activity --json` / `ralph list --json` shape described in the issue body. **The CLI-first path is aspirational; the MCP-stdio path is the primary path Phase 5 must implement.** Panels 2/4/5 shell out to the built MCP server binary (`node plugin/ralph-hero/mcp-server/dist/index.js`) with a one-shot JSON-RPC `tools/call` request, parse the response, and render. If the MCP server is not built (`dist/index.js` missing), the panel renders an `st.warning` with a build hint. Adding `--json` flags to the ralph CLI is out of scope for this phase.
- **`knowledge_search` tool shape confirmed.** `plugin/ralph-knowledge/src/index.ts` registers `knowledge_search(query, limit, type, tags, ...)` returning an array of `{ id, title, type, date, tags, score }`. Panel 6 invokes the tool via stdio JSON-RPC against the ralph-knowledge MCP server binary or — simpler — runs `npx --yes @plugin/ralph-knowledge --query "..." --json` if such a CLI exists; if not, it shells out to a small Python helper that opens a stdio child process. The exact invocation is implementation detail; the panel must return the top 5 results with titles and snippets.
- **`uv` precedent confirmed.** `scripts/dream/pyproject.toml` uses `uv sync` + `uv run`. Phase 5 follows the same convention with a sibling `pyproject.toml` under `scripts/cos/desk/`.
- **Justfile dispatch unchanged.** `plugin/ralph-hero/justfile:319` already wires `ralph cos desk` to `exec "${PLUGIN_DIR}/scripts/cos/cos-desk.sh" "$@"`. Phase 5 only rewrites the body of `cos-desk.sh`; the justfile recipe stays as-is.
- **Tailscale `serve` pattern.** Documented by Tailscale: `tailscale serve --bg --https 443 http://localhost:8502` publishes the port at `https://<machine>.<tailnet>.ts.net/`. README links to the Tailscale docs and shows the exact command.
- **bash 3.2 compatibility on `launch.sh`.** macOS ships bash 3.2 by default. `launch.sh` avoids `EPOCHREALTIME` and bash-4+ associative arrays; it is a thin wrapper that runs `uv run streamlit run app.py ...`.

## Current State Analysis

After Phases 1–4 ship (all four CLOSED on GitHub), the foundation Phase 5 builds on:

- **`plugin/ralph-hero/scripts/cos/`** contains: `README.md`, `PREFLIGHT.md`, `model-roles.sh`, `cos.sh`, `cos-desk.sh` (stub), `cos-remote.sh`, `cos-unattended.sh`, `morning-brief.sh`, `mcp.json.example`, `install-mcp-config.sh`, `smoke.sh`, `launchd/`. Phase 5 ADDS the `desk/` subdirectory and REWRITES `cos-desk.sh`.
- **`plugin/ralph-hero/skills/cos/SKILL.md`** already documents `desk` mode as "Phase 5 (GH-1257)" in the mode table. Phase 5 updates the table row to mark `desk` Active.
- **`plugin/ralph-hero/justfile:287`** already dispatches `ralph cos desk` to `cos-desk.sh`. No justfile changes in Phase 5 (the dispatch already points at the right script; we only swap the script body).
- **`~/.config/mcp/mcp.json`** (created by Phase 1's installer) already lists `pipeline_dashboard`, `list_issues`, `recent_activity`, `get_issue`, `knowledge_search` in `directTools` allowlists. No new MCP allowlist entries needed.
- **`~/.ralph-hero/knowledge.db`** is owned by the dream-loop + ralph-knowledge MCP server. Phase 5 opens it read-only via `mode=ro` URI flag. The dream-loop's nightly reindex updates the file; Streamlit always reads the latest state on each page rerun.
- **`thoughts/shared/research/`** is where Phase 3's morning brief lands. Panel 1's glob is the consumer side of that producer contract.

### Key Discoveries

- The issue body describes six panels + a chat panel. The natural Streamlit layout is `st.columns(3)` for the top row (Today's Brief, Pipeline State, KG Growth), `st.columns(3)` for the second row (Recent Activity, WIP, KG Search), and then a full-width Chat panel at the bottom. This keeps the chat panel as the focal "do something" surface and the panels as a stable status header.
- The issue body's "Pipeline State panel reflects the live project board (verify by changing an issue's state and refreshing)" criterion is satisfied by either (a) Streamlit's `st.button("Refresh")` triggering a fresh subprocess call, or (b) `st.cache_data(ttl=30)` so the dashboard refreshes every 30 seconds automatically. We pick (a) — explicit refresh button — to keep the panel deterministic and avoid surprise MCP traffic. Auto-refresh can be added as a checkbox in v2.
- The issue body's "Chat panel: submitting a prompt invokes `cos.sh` and streams the response back into the UI" — Streamlit does not have native stdio-streaming widgets, but `st.chat_message` + `st.write_stream` together can render line-by-line output from a generator. The implementation wraps `subprocess.Popen` and yields stdout lines as they arrive.
- The issue body mentions `@walterra/pi-charts` as the visualization library. That library is a TypeScript pi extension installed in Phase 1's `pi install` step; it is NOT a Python library and is NOT importable from Streamlit. The plan substitutes Streamlit-native `st.line_chart` / `st.bar_chart` (no external Python deps) and notes the substitution in the README.
- KG-growth panel: the `documents` table in `~/.ralph-hero/knowledge.db` has a `date` column (TEXT, ISO-8601) — verified against `plugin/ralph-knowledge/src/db.ts:104-113`. **There is no `created_at` column** (corrected in iteration after critique). Querying `SELECT date(date) AS day, memory_tier, COUNT(*) AS count FROM documents WHERE date >= date('now', '-30 day') GROUP BY 1, 2 ORDER BY 1` returns a long-format dataframe that Streamlit can pivot to wide-format and pass to `st.line_chart` (one line per `memory_tier`). The outer `date()` is the SQLite function, the inner `date` is the column name.
- The KG-search panel calling `knowledge_search`: the simplest path is to import a small Python helper that opens a stdio child process running the ralph-knowledge MCP server binary, sends one JSON-RPC `tools/call` request for `knowledge_search`, reads the response, and closes the pipe. This pattern is well-trodden — `mcp` SDK has a Python client in beta, but for one-shot calls a hand-rolled JSON-RPC over stdio is ~30 lines and avoids a new dep.
  - Alternative: shell out to a Node-side one-shot script. The decision (stdio Python vs Node CLI) is implementation detail; the acceptance criterion is "returns top 5 results for a known-good query."
- Chat panel streaming: `subprocess.Popen([..., "--role", "default", prompt], stdout=PIPE, stderr=STDOUT, text=True, bufsize=1)` followed by iterating `proc.stdout` line-by-line yields each line as it arrives. Streamlit's `st.write_stream(generator)` consumes the generator and renders progressively. On `proc.wait()`, the exit code is checked; non-zero shows an error block.
- The Streamlit app's working directory matters for Panel 1 (reading thoughts/) and the chat panel (resolving the cos.sh path). The launch script sets `cd $(git rev-parse --show-toplevel)` before invoking Streamlit, so all relative paths resolve from the repo root. The app also stores the repo root in a module-level constant at startup using `subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()` for robustness.

## Desired End State

After this phase merges:

1. `plugin/ralph-hero/scripts/cos/desk/app.py` exists and is a syntactically valid Streamlit application.
2. `plugin/ralph-hero/scripts/cos/desk/launch.sh` exists, marked executable.
3. `plugin/ralph-hero/scripts/cos/desk/pyproject.toml` exists and lists Streamlit as a dep (plus any sparkline deps if Streamlit-native is insufficient).
4. `plugin/ralph-hero/scripts/cos/cos-desk.sh` no longer prints "not yet implemented" — it `exec`s `desk/launch.sh "$@"`.
5. Running `ralph cos desk` from any cwd within the repo:
   - Verifies `uv` is on `PATH` (else clear error)
   - Runs `cd plugin/ralph-hero/scripts/cos/desk && uv run streamlit run app.py --server.port 8502 --server.address 0.0.0.0`
   - The Streamlit page opens at `http://localhost:8502` and renders all six panels + chat without error
6. Each panel renders correctly on first paint:
   - Panel 1 (Today's Brief): shows today's brief markdown if present, falls back to the most-recent brief with a banner noting the date, or "No brief found" if zero briefs exist
   - Panel 2 (Pipeline State): horizontal bar chart of issue count by workflow state, with an explicit Refresh button
   - Panel 3 (KG Growth): line chart of document count per day per memory_tier, last 30 days
   - Panel 4 (Recent Activity): table of last 20 activity log entries (cols: ts, kind, tool, project) from `ralph_hero__recent_activity --compact --limit=20`
   - Panel 5 (WIP): table of issues in "In Progress" / "In Review" with assignee and age in days
   - Panel 6 (KG Search): text input + Search button; on submit, shows top 5 results with title, type, date, score
7. Chat panel: text input + submit. On submit, the prompt is passed to `cos.sh --role default` via `subprocess.Popen`, and stdout streams into a `st.chat_message("assistant")` block. Session state holds the conversation history client-side (Streamlit's `st.session_state.messages` list).
8. `:8502` is reachable from another device on the Tailnet when `tailscale serve --bg --https 443 http://localhost:8502` is active. (Verified manually; not in CI.)
9. `plugin/ralph-hero/scripts/cos/README.md` has a new `## Desk mode (Streamlit dashboard)` section documenting: install (`uv sync`), launch (`ralph cos desk`), port choice (8502, not 8501), Tailscale publishing command, zero-Claude-Code constraint, no-auth security model.
10. `plugin/ralph-hero/skills/cos/SKILL.md` mode table updates `desk`'s status from "Phase 5 (GH-1257)" to "Active (Phase 5)".

### Verification

- [ ] `bash -n plugin/ralph-hero/scripts/cos/cos-desk.sh` exits 0
- [ ] `bash -n plugin/ralph-hero/scripts/cos/desk/launch.sh` exits 0
- [ ] `python -c "import ast; ast.parse(open('plugin/ralph-hero/scripts/cos/desk/app.py').read())"` exits 0 (AST parse — no need for full streamlit import)
- [ ] `grep -E '(^|\s)(claude|anthropic\.|openai\.)(\s|$|\()' plugin/ralph-hero/scripts/cos/desk/app.py` returns empty (zero-Claude-Code check; excludes occurrences inside comments via separate manual review)
- [ ] `grep -c 'st.chat_message\|st.write_stream' plugin/ralph-hero/scripts/cos/desk/app.py` returns ≥ 1 (chat panel exists)
- [ ] `grep -c 'cos.sh' plugin/ralph-hero/scripts/cos/desk/app.py` returns ≥ 1 (chat panel routes through cos.sh)
- [ ] `grep -c 'mode=ro' plugin/ralph-hero/scripts/cos/desk/app.py` returns ≥ 1 (KG DB opened read-only)
- [ ] `grep -c '8502' plugin/ralph-hero/scripts/cos/desk/launch.sh` returns ≥ 1 (port is hardcoded as default)
- [ ] `cd plugin/ralph-hero/scripts/cos/desk && uv sync` exits 0
- [ ] After `uv sync`, `cd plugin/ralph-hero/scripts/cos/desk && uv run python -c "import streamlit; print(streamlit.__version__)"` prints a version
- [ ] `ralph cos desk` (manual run): page loads at `http://localhost:8502` and all six panels render without traceback. Chat panel submits a "say hello" prompt and gets a response from the local LLM.

## What We're NOT Doing

- **No Streamlit auth.** Tailscale-only is the v1 model. Adding `streamlit-authenticator` or a basic-auth proxy is out of scope.
- **No persistent chat history.** Conversation lives in `st.session_state` and is cleared on tab refresh. Persisting to disk (e.g., `~/.ralph-hero/cos/desk/chat-YYYY-MM-DD.jsonl`) is a follow-up if requested.
- **No multi-tab / multi-page Streamlit app.** Single `app.py` with all six panels + chat. Sidebar navigation can be added in v2 if the page grows.
- **No mobile-optimized layout.** Streamlit's default responsive CSS is sufficient for v1.
- **No live auto-refresh.** Each panel has an explicit Refresh button (or refreshes on every Streamlit script rerun, which Streamlit triggers on widget interaction). Auto-refresh-every-30s is deferred.
- **No alternative themes.** Streamlit's default theme. No `config.toml` theming.
- **No alternative ports beyond 8502.** Operators who need a different port can set `RALPH_COS_DESK_PORT=8503` (the launch script honors it), but 8502 is the documented default everywhere.
- **No Tailscale auto-publish.** The README documents the `tailscale serve` command but Phase 5 does NOT run it automatically — operators set up Tailscale themselves.
- **No additional MCP tools or write capabilities.** The dashboard is strictly read-only.
- **No tests beyond AST parse + bash -n.** Streamlit apps are notoriously hard to unit-test (they require a running server). Manual smoke verification is the gate.
- **No `streamlit_extras`, `streamlit-aggrid`, or fancy widget libraries.** Stock Streamlit only.
- **No CI test for the dashboard.** CI does not have an MLX server and cannot meaningfully test the chat panel. The dashboard is verified manually on the M5 Pro.
- **No `@walterra/pi-charts` integration.** That library is a pi extension (JS), not a Python library. Streamlit-native charts substitute.

## Implementation Approach

Phase 5 has five task groups. Tasks 5.1 (`pyproject.toml`), 5.2 (`launch.sh`), and 5.3 (`app.py`) can be drafted in parallel but final assembly depends on all three. Task 5.4 (rewrite `cos-desk.sh`) depends on 5.2. Task 5.5 (SKILL.md + README updates) depends on 5.1–5.4 to document what shipped.

`app.py` is structured as: imports → constants (port, paths) → repo-root resolution → MCP-stdio helper (`_call_mcp(tool_name, args)` — shared by Panels 2, 4, 5, 6) → six panel-rendering functions (`render_brief()`, `render_pipeline()`, `render_kg_growth()`, `render_recent_activity()`, `render_wip()`, `render_kg_search()`) → chat panel (`render_chat()`) → `main()` which lays out the page (`st.set_page_config`, title, two rows of three columns, then chat). Each panel function is self-contained and catches its own exceptions, rendering an `st.error` block on failure so one broken panel does not break the page.

The `_call_mcp` helper is the canonical bridge to the read-only MCP tools (`ralph_hero__pipeline_dashboard`, `ralph_hero__recent_activity`, `ralph_hero__list_issues`, ralph-knowledge `knowledge_search`). It spawns the built MCP server binary (`node plugin/ralph-hero/mcp-server/dist/index.js`), writes one JSON-RPC `tools/call` request to stdin, reads one line of JSON response from stdout, parses `result.content[0].text` as JSON, and returns the parsed object. If the binary does not exist, it raises a `RuntimeError` that each panel converts to an `st.warning` with the build-hint command. This is the primary path because the ralph CLI does not have `--json` flags (verified iteration 1).

`launch.sh` is a thin wrapper: cd into the desk dir, verify `uv` is on PATH, verify `.venv` exists (else suggest `uv sync`), then `exec uv run streamlit run app.py --server.port "${RALPH_COS_DESK_PORT:-8502}" --server.address 0.0.0.0`.

`cos-desk.sh` is a 10-line rewrite: parse `--help`, `exec` `desk/launch.sh "$@"`.

The README and SKILL.md updates are documentation polish: one new section in the README, one table-row update in SKILL.md.

---

## Phase 1: Streamlit desktop command surface — app, launcher, dependency manifest, dispatcher rewrite, docs

- **depends_on**: null

### Overview

Author the Streamlit app, its launcher, its `pyproject.toml`, rewrite the `cos-desk.sh` dispatcher, and document the new mode in the cos README and skill. End state: `ralph cos desk` opens a working dashboard at `:8502` with six panels + a zero-Claude-Code chat panel.

### Tasks

#### Task 5.1: Author `desk/pyproject.toml`

- **files**: `plugin/ralph-hero/scripts/cos/desk/pyproject.toml` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/cos/desk/pyproject.toml`
  - [ ] `[project]` table with `name = "ralph-cos-desk"`, `version = "0.1.0"`, `requires-python = ">=3.11"`
  - [ ] `dependencies` array includes at minimum: `streamlit>=1.32`, `pandas>=2.0` (for sparkline dataframes), `httpx>=0.27` (optional — only if MCP client uses async HTTP; otherwise omit)
  - [ ] `[build-system]` block matches `scripts/dream/pyproject.toml`'s pattern: `requires = ["hatchling"]`, `build-backend = "hatchling.build"`
  - [ ] `[tool.hatch.build.targets.wheel]` `only-include = ["app.py"]` (wheel build is not actually used in production — Streamlit runs from the source tree — but the table is included for consistency with `scripts/dream/`)
  - [ ] `cd plugin/ralph-hero/scripts/cos/desk && uv sync` exits 0 (manual verification on a machine with `uv` installed)
  - [ ] `cd plugin/ralph-hero/scripts/cos/desk && uv run python -c "import streamlit; print(streamlit.__version__)"` prints a version string ≥ 1.32

#### Task 5.2: Author `desk/launch.sh`

- **files**: `plugin/ralph-hero/scripts/cos/desk/launch.sh` (create), `plugin/ralph-hero/scripts/cos/desk/pyproject.toml` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/cos/desk/launch.sh`, marked executable (`chmod +x`)
  - [ ] `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Resolves `SCRIPT_DIR` via `${BASH_SOURCE[0]}` (so the script works when symlinked)
  - [ ] Supports `--help` / `-h`: exits 0 with usage text covering the port env var override
  - [ ] Verifies `uv` is on `PATH`; if not, prints `[cos-desk] ERROR: uv not found — install from https://docs.astral.sh/uv/` to stderr and exits 127
  - [ ] Verifies `${SCRIPT_DIR}/.venv` exists (created by `uv sync`); if not, prints `[cos-desk] ERROR: .venv not found — run 'cd plugin/ralph-hero/scripts/cos/desk && uv sync'` to stderr and exits 1
  - [ ] Reads `RALPH_COS_DESK_PORT` from env; defaults to `8502` if unset
  - [ ] Reads `RALPH_COS_DESK_ADDRESS` from env; defaults to `0.0.0.0` if unset (Tailscale requires all-interfaces)
  - [ ] Final exec: `exec uv run streamlit run "${SCRIPT_DIR}/app.py" --server.port "$PORT" --server.address "$ADDRESS" --server.headless true` (the `--server.headless true` flag suppresses Streamlit's auto-browser-open since the operator may be on a headless machine or accessing via Tailscale)
  - [ ] When `RALPH_COS_DEBUG=1`, prints to stderr before exec: `[cos-desk] launching streamlit on ${ADDRESS}:${PORT}`
  - [ ] `bash -n launch.sh` passes

#### Task 5.3: Author `desk/app.py` (Streamlit application)

- **files**: `plugin/ralph-hero/scripts/cos/desk/app.py` (create), `plugin/ralph-hero/scripts/cos/cos.sh` (read — referenced by chat panel), `plugin/ralph-hero/scripts/cos/morning-brief.sh` (read — for brief filename convention)
- **tdd**: false
- **complexity**: high
- **depends_on**: null
- **Subagent context required**: this task is `complexity: high` and the acceptance list spans six panel functions + chat + main. Before starting, a subagent dispatched to this task MUST read these sections of the plan in full: `## Shared Constraints` (port, address, zero-Claude-Code rule, read-only DB access, subprocess fallback rules), `## Current State Analysis` + `### Key Discoveries` (brief glob, chat-streaming semantics, KG DB column name, layout decisions), and `## Implementation Approach` (file structure: imports → constants → repo-root → six panel functions → chat → main). The task block alone is insufficient.
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/cos/desk/app.py`
  - [ ] First line is a doc comment block describing all six panels + chat, the port (8502), the zero-Claude-Code constraint, and a one-line "run with `ralph cos desk`"
  - [ ] Imports: `streamlit as st`, `pandas as pd`, `subprocess`, `sqlite3`, `pathlib.Path`, `datetime`, `os`, `json`, `glob`, `typing`
  - [ ] Module-level constants:
    - `PORT = int(os.environ.get("RALPH_COS_DESK_PORT", 8502))`
    - `REPO_ROOT = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=True).stdout.strip())`
    - `COS_SH = REPO_ROOT / "plugin" / "ralph-hero" / "scripts" / "cos" / "cos.sh"`
    - `THOUGHTS_DIR = Path(os.environ.get("RALPH_COS_THOUGHTS_DIR", REPO_ROOT / "thoughts"))`
    - `KG_DB = Path(os.path.expanduser("~/.ralph-hero/knowledge.db"))`
  - [ ] **Exactly one** `st.set_page_config(page_title="cos — desk", layout="wide", initial_sidebar_state="collapsed")` call, placed as the first statement inside `main()` (before `st.title(...)`). Streamlit throws `StreamlitAPIException: set_page_config can only be called once per app` if called twice — do not duplicate this in any panel function.
  - [ ] `def render_brief() -> None:` — Panel 1 (Today's Brief)
    - Resolves today's brief path: `THOUGHTS_DIR / "shared" / "research" / f"{datetime.date.today().isoformat()}-cos-morning-brief.md"`
    - If exists, reads and renders with `st.markdown(content)`
    - If not, globs `THOUGHTS_DIR / "shared" / "research" / "*-cos-morning-brief.md"`, takes the most recent by filename, renders with an `st.info(f"Showing brief from {date}")` banner
    - If zero matches, renders `st.info("No morning brief found. Run `ralph cos unattended --morning-brief` to generate one.")`
  - [ ] `def render_pipeline() -> None:` — Panel 2 (Pipeline State)
    - Uses `st.button("Refresh pipeline")` to trigger a fresh call
    - **Primary path (CLI `--json` does NOT exist — verified during iteration):** invokes the MCP server stdio binary directly with a one-shot JSON-RPC `tools/call` for `ralph_hero__pipeline_dashboard`. Spawns `node ${REPO_ROOT}/plugin/ralph-hero/mcp-server/dist/index.js`, writes a single JSON-RPC request to stdin, reads one response line from stdout, then closes the pipe. A small `_call_mcp(tool_name, args)` helper at the top of `app.py` encapsulates this for reuse by Panels 4 and 5.
    - If `mcp-server/dist/index.js` does not exist, renders `st.warning("Pipeline panel requires the MCP server to be built. Run 'cd plugin/ralph-hero/mcp-server && npm install && npm run build'.")`
    - Parses the JSON response, extracts workflow-state counts
    - Renders `st.bar_chart(df)` with workflow states on x-axis, counts on y-axis
    - On non-zero exit or parse error, renders `st.error(stderr)`
  - [ ] `def render_kg_growth() -> None:` — Panel 3 (KG Growth)
    - Opens `KG_DB` with `sqlite3.connect(f"file:{KG_DB}?mode=ro", uri=True)`
    - Queries (verified against `plugin/ralph-knowledge/src/db.ts:104-113` — column is `date`, NOT `created_at`):
      ```sql
      SELECT date(date) AS day, memory_tier, COUNT(*) AS count
      FROM documents
      WHERE date >= date('now', '-30 day')
      GROUP BY 1, 2
      ORDER BY 1
      ```
      Note: the outer `date(...)` is the SQLite function, the inner `date` is the column name — both are correct.
    - Loads into a pandas DataFrame, pivots wide so each `memory_tier` becomes a column
    - Renders `st.line_chart(df)`
    - On `OperationalError` (DB missing) or `ProgrammingError` (column missing — schema drift), renders `st.warning(f"KG DB not available: {err}")`
  - [ ] `def render_recent_activity() -> None:` — Panel 4 (Recent Activity)
    - **Primary path:** uses the same `_call_mcp` helper to invoke `ralph_hero__recent_activity` with `{ compact: true, limit: 20 }` (the CLI `--json` flag does NOT exist as of iteration 1).
    - Parses the JSON list, renders `st.dataframe(df)` with columns `ts`, `kind`, `tool`, `project`
    - On error, renders `st.error(...)`
  - [ ] `def render_wip() -> None:` — Panel 5 (WIP)
    - **Primary path:** uses the same `_call_mcp` helper to invoke `ralph_hero__list_issues` twice (once with `workflowState: "In Progress"`, once with `workflowState: "In Review"`) and concatenates the results. The CLI `--json` flag does NOT exist as of iteration 1.
    - Parses the JSON list, renders `st.dataframe(df)` with columns `number`, `title`, `workflowState`, `assignee`, `age_days`
    - Age computed from `updatedAt` field
    - On error, renders `st.error(...)`
  - [ ] `def render_kg_search() -> None:` — Panel 6 (KG Search)
    - `query = st.text_input("KG search query", placeholder="e.g., ralph-hero workflow states")`
    - `if st.button("Search"):` — invokes `knowledge_search` via the same MCP-stdio pattern. Note: `knowledge_search` is registered by the **ralph-knowledge** plugin server (`plugin/ralph-knowledge/dist/` after `npm run build` in that directory), NOT the ralph-hero MCP server. The `_call_mcp` helper must accept an optional `binary_path` argument so this panel can point at the ralph-knowledge binary. If the ralph-knowledge binary is not built, renders `st.warning("KG search requires the ralph-knowledge plugin to be built. Run 'cd plugin/ralph-knowledge && npm install && npm run build'.")`
    - Renders top 5 results as a table with columns `title`, `type`, `date`, `score`
    - On error, renders `st.error(...)`
  - [ ] `def render_chat() -> None:` — Chat panel
    - Initializes `st.session_state.messages` to `[]` if missing
    - Renders all prior messages: `for msg in st.session_state.messages: with st.chat_message(msg["role"]): st.markdown(msg["content"])`
    - `prompt = st.chat_input("Ask cos anything...")` (Streamlit's chat-style input)
    - If `prompt`: appends `{"role": "user", "content": prompt}` to session state; renders the user message; then spawns `subprocess.Popen([str(COS_SH), "--role", "default", prompt], stdout=PIPE, stderr=STDOUT, text=True, bufsize=1)` and streams stdout via `st.write_stream(line_generator)` inside a `with st.chat_message("assistant"):` block; on completion, appends `{"role": "assistant", "content": collected_text}` to session state
    - **Streaming semantics (clarified after critique).** `cos.sh` (`plugin/ralph-hero/scripts/cos/cos.sh:33-228`) is a single-prompt wrapper that invokes `pi` non-interactively and prints the accumulated response when `pi` finishes — it does NOT emit token-by-token output to stdout in real time. `st.write_stream` over `proc.stdout` therefore renders **line-buffered (likely one-shot)**, not token-by-token like ChatGPT. This is the expected, acceptable behavior for v1; do NOT attempt to add a `cos.sh --stream` flag or modify `cos.sh` to achieve token streaming (that would re-open the stable CLI contract). The user-facing latency is "wait for the spinner, then the full response appears" — a Streamlit `st.spinner("Asking cos...")` wrapper around the `Popen`/`write_stream` block conveys this. Token-by-token streaming is a Phase 6+ enhancement that requires plumbing changes in `cos.sh` and `pi`.
    - On `cos.sh` non-zero exit, renders `st.error(f"cos.sh exited {rc}")` and does NOT append the assistant message
  - [ ] `def main() -> None:` — entry point
    - First line of `main()` is the single `st.set_page_config(...)` call described above (this is the ONLY call to `set_page_config` in the entire file).
    - Then `st.title("cos — desk")`
    - Two rows of `st.columns(3)` for panels 1–6 (each panel function takes a column context manager)
    - Full-width `render_chat()` at the bottom
  - [ ] `if __name__ == "__main__": main()` (Streamlit runs this when launched via `streamlit run app.py`)
  - [ ] NO imports of `anthropic`, `openai`, `claude`, or any remote-LLM client. Verified by: `grep -E '^(from|import)\s+(anthropic|openai|claude|langchain|llama_index)' plugin/ralph-hero/scripts/cos/desk/app.py` returns empty
  - [ ] Every panel function wraps its body in `try/except Exception as e: st.error(f"{panel_name}: {e}")` so one broken panel does not break the page
  - [ ] `python -c "import ast; ast.parse(open('plugin/ralph-hero/scripts/cos/desk/app.py').read())"` exits 0
  - [ ] **MCP-stdio is the primary path for Panels 2, 4, 5.** The ralph CLI does NOT have `--json` flags (verified during iteration 1: `grep -rn -- "--json" plugin/ralph-hero/scripts/ralph*` returns empty). Implementation: a `_call_mcp(tool_name, args)` helper at the top of `app.py` spawns `node ${REPO_ROOT}/plugin/ralph-hero/mcp-server/dist/index.js`, writes a JSON-RPC `tools/call` request to stdin, reads one response line, and returns the parsed `result.content[0].text` (or raises on `result.isError`). If `dist/index.js` does not exist, every panel that uses `_call_mcp` renders `st.warning("MCP server not built — run 'cd plugin/ralph-hero/mcp-server && npm install && npm run build'.")` rather than crashing. Adding `--json` flags to the ralph CLI is OUT OF SCOPE for this phase.
  - [ ] File is ≤ 600 lines (target — small enough to read in one sitting; if growing larger, escalate per parent constraint)

#### Task 5.4: Rewrite `cos-desk.sh` to dispatch to `desk/launch.sh`

- **files**: `plugin/ralph-hero/scripts/cos/cos-desk.sh` (modify — replace stub), `plugin/ralph-hero/scripts/cos/desk/launch.sh` (read — target of exec)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.2]
- **acceptance**:
  - [ ] `cos-desk.sh` no longer prints "cos desk is not yet implemented" (the stub message is gone)
  - [ ] `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Resolves `SCRIPT_DIR` via `${BASH_SOURCE[0]}`
  - [ ] Supports `--help` / `-h`: exits 0 with usage text. The help text describes:
    - The default port (8502) and how to override (`RALPH_COS_DESK_PORT=8503 ralph cos desk`)
    - The Tailscale-publish command (one-liner reference, fuller docs in README)
    - One-time install hint: `cd plugin/ralph-hero/scripts/cos/desk && uv sync`
  - [ ] Final exec: `exec "${SCRIPT_DIR}/desk/launch.sh" "$@"`
  - [ ] If `desk/launch.sh` is not executable or missing, prints `[cos-desk] ERROR: desk/launch.sh not found at <path>` to stderr and exits 127
  - [ ] `bash -n cos-desk.sh` passes
  - [ ] `ralph cos desk --help` exits 0 and prints the new help text (manual verification — the dispatch in the justfile is unchanged)

#### Task 5.5: Document `desk` mode in cos README and SKILL.md

- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify), `plugin/ralph-hero/skills/cos/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [5.1, 5.2, 5.3, 5.4]
- **acceptance**:
  - [ ] In `plugin/ralph-hero/scripts/cos/README.md`: adds a new `## Desk mode (Streamlit dashboard)` section under (or near) the existing `## Unattended morning brief (Phase 3)` section. Section contents:
    - One-sentence summary: "Six-panel Streamlit dashboard at `localhost:8502` with a chat panel that shells out to `cos.sh` (zero Claude Code)."
    - `### One-time install` subsection:
      ```bash
      cd plugin/ralph-hero/scripts/cos/desk
      uv sync
      ```
    - `### Launch` subsection:
      ```bash
      ralph cos desk
      # → http://localhost:8502
      ```
    - `### Port choice` subsection: one paragraph explaining why 8502 (collision with default 8501 Streamlit apps), and the `RALPH_COS_DESK_PORT` override.
    - `### Tailscale publishing` subsection: the exact `tailscale serve --bg --https 443 http://localhost:8502` command, the resulting `https://<machine>.<tailnet>.ts.net/` URL pattern, and a link to <https://tailscale.com/kb/1242/tailscale-serve> for full Tailscale docs.
    - `### Security model` subsection: one paragraph stating "Tailnet-only, no Streamlit auth. The dashboard is read-only and the chat panel routes through `cos.sh` → local LLM. Do not publish `:8502` to the public internet."
    - `### Panels` subsection: a 6-row table listing each panel's name, data source, refresh model (button / auto), and any dependencies.
    - `### Chat panel` subsection: one paragraph reaffirming the zero-Claude-Code constraint ("every chat message shells out to `cos.sh --role default`"), one paragraph on session-state-only history (lost on tab refresh).
  - [ ] In `plugin/ralph-hero/scripts/cos/README.md`: the existing `## Downstream phases` table updates Phase 5's "What it adds" cell to `Streamlit desktop command surface at :8502 (six panels + chat)`.
  - [ ] In `plugin/ralph-hero/scripts/cos/README.md`: the existing `## Directory layout` block gets a new `desk/` entry:
    ```
    └── desk/
        ├── app.py          # Streamlit application (six panels + chat)
        ├── launch.sh       # uv run streamlit run app.py ...
        └── pyproject.toml  # uv-managed deps (streamlit, pandas)
    ```
  - [ ] In `plugin/ralph-hero/skills/cos/SKILL.md`: the mode table row for `desk` changes from `Phase 5 (GH-1257)` to `Active (Phase 5)`. Description updates to reflect what shipped (six panels + chat panel at :8502).
  - [ ] No broken markdown (manual readability check; all code blocks have language tags)
  - [ ] All new external links (Tailscale docs) are HTTPS

### Phase Success Criteria

#### Automated Verification

- [x] `bash -n plugin/ralph-hero/scripts/cos/cos-desk.sh` exits 0
- [x] `bash -n plugin/ralph-hero/scripts/cos/desk/launch.sh` exits 0
- [x] `python -c "import ast; ast.parse(open('plugin/ralph-hero/scripts/cos/desk/app.py').read())"` exits 0
- [x] `grep -E '^(from|import)\s+(anthropic|openai|claude|langchain|llama_index)' plugin/ralph-hero/scripts/cos/desk/app.py` returns empty
- [x] `grep -c 'cos.sh' plugin/ralph-hero/scripts/cos/desk/app.py` returns ≥ 1
- [x] `grep -c 'mode=ro' plugin/ralph-hero/scripts/cos/desk/app.py` returns ≥ 1
- [x] `grep -c '8502' plugin/ralph-hero/scripts/cos/desk/launch.sh` returns ≥ 1
- [x] `grep -c 'cos-desk' plugin/ralph-hero/scripts/cos/README.md` returns ≥ 1 (README documents desk mode)
- [x] `grep -c 'desk' plugin/ralph-hero/skills/cos/SKILL.md | grep -v 'Phase 5 (GH-1257)'` — SKILL.md no longer marks desk as Phase 5 placeholder (manual confirm: row says "Active")
- [x] `npm test` in `plugin/ralph-hero/mcp-server/` still passes — no MCP server source changes, but run as regression smoke
- [x] `npm run build` in `plugin/ralph-hero/mcp-server/` still passes — same regression smoke
- [x] Existing cos shell scripts still pass `bash -n`: `cos.sh`, `cos-remote.sh`, `cos-unattended.sh`, `model-roles.sh`, `install-mcp-config.sh`, `smoke.sh` (this phase does NOT modify them; the check verifies no accidental edits)
- [x] `wc -l plugin/ralph-hero/scripts/cos/desk/app.py` returns ≤ 600 (file stays small)
- [x] `wc -l plugin/ralph-hero/scripts/cos/cos-desk.sh` returns ≤ 50 (dispatcher stays thin)

#### Manual Verification

- [ ] On a machine with `uv` + `mlx-openai-server` running:
  - [ ] `cd plugin/ralph-hero/scripts/cos/desk && uv sync` exits 0
  - [ ] `ralph cos desk` opens `http://localhost:8502` in a browser (or the URL is reachable)
  - [ ] All six panels render on first paint without traceback in the Streamlit logs (some may show empty data if the source is empty — that is acceptable; the criterion is "no Python exception")
  - [ ] Panel 1 (Today's Brief): if today's brief exists, it renders as markdown; if not, the most-recent brief renders with a banner.
  - [ ] Panel 2 (Pipeline State): clicking Refresh re-runs the subprocess; changing an issue's workflow state on the project board and clicking Refresh shows the updated count.
  - [ ] Panel 3 (KG Growth): line chart renders with at least one line per `memory_tier` present in the DB.
  - [ ] Panel 4 (Recent Activity): table shows the last 20 activity events.
  - [ ] Panel 5 (WIP): table shows current In Progress / In Review issues.
  - [ ] Panel 6 (KG Search): typing "ralph-hero workflow states" and clicking Search returns at least 1 result.
  - [ ] Chat panel: typing "say hello in 5 words" and pressing Enter spawns `cos.sh`, streams the response into an assistant message bubble, and persists in `st.session_state.messages` for subsequent turns.
  - [ ] `ralph cos desk --help` prints the new help text and exits 0.
- [ ] On a second device on the same Tailnet, after `tailscale serve --bg --https 443 http://localhost:8502` runs on the M5 Pro: navigating to `https://<machine>.<tailnet>.ts.net/` renders the dashboard.

**Creates for next phase**:

- A working desk surface that Phase 6's self-improvement loop can use to display grading results once the loop ships (Phase 6 may add a seventh panel for "Brief grades over time" — Phase 5 leaves room for this by structuring panels as independent render functions).
- A `desk/` subdirectory pattern that future cos visualizations can follow (e.g., a separate `desk/grades.py` Streamlit page for Phase 6's rubric).
- Documentation conventions (Tailscale-only security model, port-collision rationale) that downstream visualization phases inherit.

---

## Integration Testing

- [ ] After Phase 5 ships, run the manual smoke on the M5 Pro with `mlx-openai-server` live: `ralph cos desk` from a clean shell.
- [ ] Verify all six panels paint without traceback. Capture a screenshot for the PR description.
- [ ] Verify the chat panel: submit "what files changed today?" and confirm the response references the JSONL run-log (proves cos.sh invoked pi, which invoked the local LLM).
- [ ] Verify Tailscale publishing: from a phone on the Tailnet, browse to `https://<machine>.<tailnet>.ts.net/` and confirm the dashboard renders.
- [ ] Cross-check that the existing `cos.sh`, `model-roles.sh`, `cos-remote.sh`, `cos-unattended.sh`, `morning-brief.sh` files have NOT been modified by this phase: `git diff --stat HEAD~1 HEAD plugin/ralph-hero/scripts/cos/cos.sh plugin/ralph-hero/scripts/cos/model-roles.sh plugin/ralph-hero/scripts/cos/cos-remote.sh plugin/ralph-hero/scripts/cos/cos-unattended.sh plugin/ralph-hero/scripts/cos/morning-brief.sh` shows no changes (only `cos-desk.sh` is intentionally modified).
- [ ] Cross-check that `ralph cos --help` still lists `desk` (no regression in the justfile dispatch).
- [ ] Manual verification: kill the Streamlit process (Ctrl-C in the launching terminal) and confirm port 8502 is freed (`lsof -iTCP:8502 -sTCP:LISTEN` returns empty).

## References

- Issue: [GH-1257](https://github.com/cdubiel08/ralph-hero/issues/1257)
- Parent issue: [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252)
- Phase 1 plan: `thoughts/shared/plans/2026-05-15-GH-1253-cos-phase1-pi-foundation.md`
- Phase 2 plan: `thoughts/shared/plans/2026-05-15-GH-1254-cos-phase2-skill-scaffold.md`
- Phase 3 plan: `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md`
- Phase 4 plan: `thoughts/shared/plans/2026-05-15-GH-1256-cos-phase4-oh-my-pi-conventions.md`
- Brief filename convention: `plugin/ralph-hero/scripts/cos/morning-brief.sh:115` (`${THOUGHTS_DIR}/shared/research/${DATE}-cos-morning-brief.md`)
- `cos.sh` CLI contract: `plugin/ralph-hero/scripts/cos/cos.sh:33-228`
- `cos-desk.sh` stub being replaced: `plugin/ralph-hero/scripts/cos/cos-desk.sh:1-30`
- Existing justfile dispatch: `plugin/ralph-hero/justfile:319` (unchanged in this phase)
- ralph-knowledge DB schema reference: `plugin/ralph-knowledge/src/db.ts`
- Python deps precedent: `scripts/dream/pyproject.toml` (uv-managed Python project)
- Streamlit docs: <https://docs.streamlit.io/library/api-reference>
- Streamlit chat elements: <https://docs.streamlit.io/library/api-reference/chat>
- Tailscale serve: <https://tailscale.com/kb/1242/tailscale-serve>
- Convention donor (parent plan): [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252) issue body
