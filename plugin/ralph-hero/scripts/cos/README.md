# cos — chief-of-staff wrapper for pi

Phase 1 of the cos-mode stack ([GH-1253](https://github.com/cdubiel08/ralph-hero/issues/1253),
parent: [GH-1252](https://github.com/cdubiel08/ralph-hero/issues/1252)).

This directory ships the foundation that every downstream cos-mode phase depends on:
`model-roles.sh` (sourced helper), `cos.sh` (wrapper), `mcp.json.example` (MCP server config),
and `install-mcp-config.sh` (idempotent installer).

---

## One-time setup

### 1. Install pi extensions

```bash
pi install npm:pi-mcp-adapter
pi install npm:@walterra/pi-charts
pi install npm:pi-web-access
```

After install, restart pi and verify:

```bash
pi list
# Expected output includes:
#   npm:pi-mcp-adapter
#   npm:@walterra/pi-charts
#   npm:pi-web-access
```

> **Note**: The install prefix is `npm:` (e.g., `npm:pi-mcp-adapter`), not bare package names.
> See `pi install --help` for the full source syntax.

### 2. Install the MCP config

```bash
bash plugin/ralph-hero/scripts/cos/install-mcp-config.sh
```

This reads `mcp.json.example`, substitutes `__PLUGIN_ROOT__`, `__GH_OWNER__`, and
`__GH_PROJECT_NUMBER__` with resolved values, and merges into `~/.config/mcp/mcp.json`.

Environment variables used during install (optional — values default to the project defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_GH_OWNER` | `cdubiel08` | GitHub owner |
| `RALPH_GH_PROJECT_NUMBER` | `3` | GitHub Projects V2 number |

The installer is **idempotent**: running it twice does not duplicate `mcpServers` entries.
If `~/.config/mcp/mcp.json` already exists with unrelated servers, the installer merges
the cos servers in without overwriting them.

Requires: `jq`. Install with `brew install jq` (macOS) or `apt-get install jq`.

### 3. Build the ralph-hero MCP server

The MCP config references `plugin/ralph-hero/mcp-server/dist/index.js`. Build it once:

```bash
cd plugin/ralph-hero/mcp-server && npm install && npm run build
```

---

## Usage

```bash
# Default role (qwen3.5-27b)
plugin/ralph-hero/scripts/cos/cos.sh "Summarise today's open issues"

# Specify a role
plugin/ralph-hero/scripts/cos/cos.sh --role plan "Draft a sprint goal for next week"

# Debug mode (prints resolved model + tools to stderr)
RALPH_COS_DEBUG=1 plugin/ralph-hero/scripts/cos/cos.sh "What files changed today?"

# Help
plugin/ralph-hero/scripts/cos/cos.sh --help
```

---

## Model roles

Each role maps to an env-overridable model. Override by setting the corresponding env var.

| Role | Default model | Override env var |
|------|---------------|-----------------|
| `default` | `qwen3.5-27b` | `RALPH_COS_MODEL_DEFAULT` |
| `smol` | `qwen3.5-7b` | `RALPH_COS_MODEL_SMOL` |
| `slow` | `qwen3.5-27b` | `RALPH_COS_MODEL_SLOW` |
| `plan` | `qwen3.5-27b` | `RALPH_COS_MODEL_PLAN` |

```bash
# Example: override the default model
RALPH_COS_MODEL_DEFAULT=qwen3.5-7b cos.sh "Quick task"

# Example: use the smol role
cos.sh --role smol "Short summarize task"
```

The role-resolution logic lives in `model-roles.sh`. It is designed to be **sourced** (not exec'd)
by downstream scripts (`cos-loop.sh` in Phase 4, `cos-unattended.sh` in Phase 3).

---

## Smoke test

```bash
plugin/ralph-hero/scripts/cos/smoke.sh
```

This requires `pi` on `PATH` and `mlx-openai-server` running on `:8000`.
Start the MLX server with `gemma-up` (or `cd ~/projects/gemma-lab && ./scripts/start-server.sh`).

Manual equivalent:

```bash
# Run a one-shot prompt
plugin/ralph-hero/scripts/cos/cos.sh "Write 'cos online' to /tmp/cos-smoke.txt"

# Verify the file was created
cat /tmp/cos-smoke.txt   # → cos online

# Verify the JSONL run log
cat ~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl
# → {"ts":"...","role":"default","prompt_hash":"...","model":"qwen3.5-27b","exit_code":0,"duration_ms":...}
```

---

## Five-team rollup

Since Feature H (GH-1275), `cos` output covers all five teams in the unified agent organization: **Builders**, **Watchers**, **Scouts**, **Memorykeepers**, and **Caretakers**.

Team attribution uses the Director event-classes taxonomy (see `plugin/ralph-hero/skills/director/event-classes.md` as the canonical source):

| Team | Attribution method | Label / filter |
|------|--------------------|----------------|
| Builders | workflow state | `In Progress`, `In Review` (no automation label for builders) |
| Watchers | label | `watcher-auto` (Priority 2, written by monitoring bridge) |
| Scouts | label | `scout-auto` (Priority 2, written by scout scheduling hook) |
| Memorykeepers | placeholder | no producer yet; reserved in event-classes.md |
| Caretakers | label | `process-improvement` (Priority 2, written by dream-loop classifier) |

Each section in the cos output shows: open issue count, titles of top 3 by priority, and a one-line WIP sentence.

For the iOS workflow (trigger teams from your phone, receive ntfy pushes, open Drive artifacts), see [`../skills/director/IOS-REMOTE.md`](../skills/director/IOS-REMOTE.md).

---

## Write gate

Write tools (`save_issue`, `create_issue`, `batch_update`, etc.) are **deliberately omitted**
from the MCP tool allowlists in `mcp.json.example`. Unattended COS jobs can read the project
board without risking accidental mutations.

To enable write tools for a session:
1. Add the desired write tools to the `directTools` array for `ralph-github` in `~/.config/mcp/mcp.json`.
2. Set `RALPH_COS_ALLOW_WRITES=1` in the environment that invokes `cos.sh`.

Both gates must be in place. The env var alone is not sufficient — the MCP tool allowlist
is the primary enforcement boundary.

---

## Run log

Every `cos.sh` invocation appends one JSONL row to `~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`.

Row schema:

```json
{
  "ts": "2026-05-15T12:34:56Z",
  "role": "default",
  "prompt_hash": "abc123...",
  "model": "qwen3.5-27b",
  "exit_code": 0,
  "duration_ms": 12345
}
```

| Field | Description |
|-------|-------------|
| `ts` | UTC ISO 8601 timestamp of invocation start |
| `role` | Resolved role name |
| `prompt_hash` | SHA-256 of the prompt string (first 64 hex chars from `shasum -a 256`) |
| `model` | Resolved model name (after env-var override) |
| `exit_code` | Exit code from `pi` |
| `duration_ms` | Wall-clock duration in milliseconds |

Inspect today's log:

```bash
cat ~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl
jq -c . ~/.ralph-hero/cos/runs/$(date +%Y-%m-%d).jsonl | head -5
```

---

## Loop mode (`cos-loop.sh`)

Mirror `/loop` semantics — run N iterations or a wall-clock duration of `cos.sh` invocations.

```bash
cos-loop.sh 10 "Summarise today's open issues"      # 10 iterations
cos-loop.sh 30s "Summarise today's open issues"     # 30 seconds wall-clock
cos-loop.sh --keep-going 5 "..."                    # don't abort on non-zero
cos-loop.sh --role plan 3 "Draft a sprint goal"     # passes --role through
```

Each iteration writes one row to the same JSONL log that `cos.sh` writes
(`~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`). `cos-loop.sh` itself does not
write rows — one `cos.sh` call per iteration produces one row.

---

## Role debugging (`ralph cos role`)

Print the resolved model for each role — useful for confirming env-var overrides
are taking effect.

```bash
ralph cos role            # prints all four roles + resolved models in a table
ralph cos role default    # prints just qwen3.5-27b
ralph cos role plan       # prints just qwen3.5-27b (or RALPH_COS_MODEL_PLAN)
```

`ralph cos role <unknown>` exits 2 with `unknown role: <unknown>` to stderr.
This is deliberately stricter than `cos.sh --role <unknown>`, which warns and falls
back to the default — the CLI failure makes misuse visible at invocation time.

---

## gh-vfs pi extension

A pi extension that registers a single `read_github_url` tool for accessing GitHub
resources and local thoughts/ files without leaving a pi session.

### Install

```bash
cp plugin/ralph-hero/scripts/cos/extensions/gh-vfs.ts ~/.pi/agent/extensions/
```

Restart pi after install. Verify by running:

```bash
pi -p "what tools are available?"
# Output should include: read_github_url
```

### URL schemes

```
read_github_url('issue://1252')
read_github_url('pr://1259/diff/3')
read_github_url('thoughts://shared/research/2026-05-14-pi-coding-harness-as-chief-of-staff.md')
```

| Scheme | What it fetches | Dependency |
|--------|----------------|-----------|
| `issue://N` | GitHub issue body via `ralph_hero__get_issue` MCP tool | `ralph_hero__get_issue` in `mcp.json` `directTools` (Phase 1 configures this) |
| `pr://N/diff/<ctx>` | Unified diff for PR #N with `<ctx>` context lines | `gh` CLI authenticated (`gh auth status` must succeed) |
| `thoughts://<path>` | File from the `thoughts/` corpus relative to repo root | pi invoked from a ralph-hero repo root (the default with `cos.sh`) |

The extension does not register any write capabilities — there is no `write_github_url`.

---

## Desk mode (Streamlit dashboard)

Six-panel Streamlit dashboard at `localhost:8502` with a chat panel that shells out to `cos.sh` (zero Claude Code).

### One-time install

```bash
cd plugin/ralph-hero/scripts/cos/desk
uv sync
```

### Launch

```bash
ralph cos desk
# → http://localhost:8502
```

### Port choice

Port `8502` is used (not Streamlit's default `8501`) to avoid collision with other local Streamlit apps. Override with the `RALPH_COS_DESK_PORT` env var:

```bash
RALPH_COS_DESK_PORT=8503 ralph cos desk
```

### Tailscale publishing

```bash
tailscale serve --bg --https 443 http://localhost:8502
# → https://<machine>.<tailnet>.ts.net/
```

Full Tailscale docs: <https://tailscale.com/kb/1242/tailscale-serve>

### Security model

Tailnet-only, no Streamlit auth. The dashboard is read-only and the chat panel routes through `cos.sh` → local LLM. Do not publish `:8502` to the public internet.

### Panels

| Panel | Data source | Refresh | Dependencies |
|-------|-------------|---------|-------------|
| Today's Brief | `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md` | On load + file glob fallback | Phase 3 morning-brief.sh |
| Pipeline State | `ralph_hero__pipeline_dashboard` via MCP stdio | Explicit button | MCP server built (`npm run build`) |
| KG Growth | `~/.ralph-hero/knowledge.db` documents table, last 30 days | On load | ralph-knowledge running + dream-loop |
| Recent Activity | `ralph_hero__recent_activity` (compact, limit 20) via MCP stdio | On load | MCP server built |
| WIP | `ralph_hero__list_issues` (In Progress + In Review) via MCP stdio | On load | MCP server built |
| KG Search | `knowledge_search` via ralph-knowledge MCP stdio | Search button | ralph-knowledge built |

### Chat panel

Every chat message shells out to `cos.sh --role default` — this app never calls the Anthropic SDK, OpenAI SDK, `claude` CLI, or any remote LLM (zero Claude Code). Conversation history lives in `st.session_state.messages` and is lost on tab refresh (not persisted to disk in Phase 5).

---

## Unattended morning brief (Phase 3)

Phase 3 ([GH-1255](https://github.com/cdubiel08/ralph-hero/issues/1255)) ships the first scheduled
unattended cos job: a weekday 06:30 morning brief that synthesizes the project board and local knowledge
corpus into `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md`, then pushes a one-line summary
via ntfy.

### One-time setup: install ntfy

```bash
brew install ntfy
```

Configure a private topic in `~/.config/ntfy/client.yml` (create if it doesn't exist):

```yaml
default-host: https://ntfy.sh
```

Then subscribe to your private topic on your phone via the ntfy app. Pick a topic name that is
hard to guess (treat it like a private channel):

```
cos-briefs-<user>-<random16hex>
```

Example: `cos-briefs-cdubiel08-a3f8c2d1e5b7`

Protect the config file:

```bash
chmod 600 ~/.config/ntfy/client.yml
```

### Set the ntfy topic env var

The script reads `RALPH_COS_NTFY_TOPIC` at runtime. If unset, the brief is still written to disk
but the push is skipped (script exits 0 with a warning).

```bash
export RALPH_COS_NTFY_TOPIC=cos-briefs-cdubiel08-a3f8c2d1e5b7
```

Add this to your `~/.zshrc` (or equivalent) to make it permanent.

### Manual trigger

```bash
ralph cos unattended --morning-brief
```

This calls `morning-brief.sh` synchronously and exits with its exit code. Use this to test without
waiting for the 06:30 launchd fire.

### Brief output path

Every run writes to:

```
thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md
```

The file is auto-classified as `type: research` by ralph-knowledge's path-based detector
(`/research/` segment in the path). No registry update needed — the next reindex pass ingests it.

### Install the launchd plist (optional — fires at 06:30 Mon–Fri)

```bash
cp plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template \
   ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist

# Hand-edit the plist if your checkout lives at a different path:
# nano ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
# Replace /Users/dubiel/... with your actual path.

# Set your ntfy topic in the plist's EnvironmentVariables block:
# <key>RALPH_COS_NTFY_TOPIC</key>
# <string>cos-briefs-<user>-<random16hex></string>

launchctl load ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
launchctl list | grep cos-morning-brief
# PID column shows "-" when idle; exit code "0" after a successful run.
```

To unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.ralph.cos-morning-brief.plist
```

Logs:
- stdout: `/tmp/ralph-cos-morning-brief.out`
- stderr: `/tmp/ralph-cos-morning-brief.err`

### Environment variables (Phase 3 additions)

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_COS_NTFY_TOPIC` | (unset) | ntfy topic name. Unset = push skipped, script exits 0. |
| `RALPH_COS_THOUGHTS_DIR` | `~/projects/thoughts` | Override for the thoughts/ corpus root directory. |

These are additive — the Phase 1 variables (`RALPH_COS_ROLE`, `RALPH_COS_MODEL_*`, `RALPH_COS_DEBUG`, etc.)
remain unchanged.

---

## Self-improvement loop (Phase 6)

Phase 6 ([GH-1258](https://github.com/cdubiel08/ralph-hero/issues/1258)) ships a nightly launchd job that grades the last 7 morning briefs against a 5-dimension rubric (specificity, actionability, signal-vs-noise, novelty, brevity — each scored 1–5) and, when the mean score falls below 3.5, drafts a revised `system-prompt.md` via `cos.sh --role slow` and opens a GitHub PR labeled `cos-self-improvement` for human review. The script **never auto-merges** — the human is the gate, always.

### Environment flags

| Variable | Default | Description |
|----------|---------|-------------|
| `RALPH_COS_SELF_IMPROVE` | (unset) | **Safety gate.** Must be exactly `"1"` to enable. Unset or any other value → exits 0 immediately with a "quarantined" log line. |
| `RALPH_COS_SELF_IMPROVE_DRY_RUN` | (unset) | Set to `"1"` to run the full grading + draft pipeline but skip `git push` and `gh pr create`. The branch and commit are created locally for inspection. Used by the smoke test and for first-time manual verification. |

### Two-manual-verification policy

**Do NOT set `RALPH_COS_SELF_IMPROVE=1` in the plist's EnvironmentVariables until you have manually invoked `self-improve.sh` twice with the env var set in your shell and confirmed both PRs are sensible.**

Manual verification workflow:

```bash
# First manual run (dry-run — no push, no PR)
RALPH_COS_SELF_IMPROVE=1 RALPH_COS_SELF_IMPROVE_DRY_RUN=1 \
    plugin/ralph-hero/scripts/cos/self-improve.sh

# Inspect the score table (stdout) and mean line (stderr)
# If mean < 3.5: inspect the locally-created branch's system-prompt.md diff
# git diff main plugin/ralph-hero/skills/cos/system-prompt.md

# If the draft looks sensible, run without dry-run for real verification run #1:
RALPH_COS_SELF_IMPROVE=1 plugin/ralph-hero/scripts/cos/self-improve.sh
# → Opens a real PR. Review it on GitHub. If it looks good, close (do not merge yet).

# Repeat for verification run #2. After two sensible PRs, set RALPH_COS_SELF_IMPROVE=1
# in the launchd plist's EnvironmentVariables and reload:
launchctl unload ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist
launchctl load   ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist
```

The `cos-self-improvement` GitHub label is created idempotently by the script on first run. A future auto-merge integration (if ever introduced) would key off this label — but v1 intentionally has no such automation.

### Smoke test

```bash
plugin/ralph-hero/scripts/cos/self-improve-smoke.sh
```

Creates a tmpdir with 7 synthetic low-quality briefs, runs `self-improve.sh` in dry-run mode, and asserts the expected score table and mean log line. Requires `pi` on PATH and `mlx-openai-server` running on `:8000`.

### Install the launchd plist (optional — fires at 02:30 daily)

```bash
cp plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template \
   ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist

# Hand-edit the plist if your checkout lives at a different path:
# nano ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist
# Replace /Users/dubiel/... with your actual path.

# Do NOT set RALPH_COS_SELF_IMPROVE=1 yet — see two-manual-verification policy above.

launchctl load ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist
launchctl list | grep cos-self-improve
# PID column shows "-" when idle; exit code "0" after a run (even when quarantined).
```

To unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist
```

Logs:
- stdout: `/tmp/ralph-cos-self-improve.out`
- stderr: `/tmp/ralph-cos-self-improve.err`

### State directory

Phase 6 writes transient grading artifacts (per-brief score files, draft system prompts) to:

```
~/.ralph-hero/cos/self-improve/run-YYYY-MM-DD/
```

Created automatically via `mkdir -p` on first run. The directory is safe to delete between runs — it is used only for intermediate files during a single grading session.

---

## Directory layout

```
plugin/ralph-hero/scripts/cos/
├── README.md                     # This file — operator setup guide
├── PREFLIGHT.md                  # Pre-flight install verification outputs (Task 1.0)
├── model-roles.sh                # Sourced helper — resolves RALPH_COS_ROLE → COS_MODEL
├── cos.sh                        # Entrypoint — invoke pi with model-role + JSONL logging
├── cos-loop.sh                   # Loop wrapper — count or duration mode (Phase 4)
├── cos-loop-smoke.sh             # End-to-end smoke for cos-loop.sh (manual; Phase 4)
├── cos-unattended.sh             # Dispatcher for scheduled unattended jobs (Phase 3)
├── morning-brief.sh              # Weekday 06:30 morning brief + ntfy push (Phase 3)
├── self-improve.sh               # Nightly self-improvement loop (Phase 6)
├── self-improve-smoke.sh         # Smoke test for self-improve.sh (manual; Phase 6)
├── mcp.json.example              # Template MCP config (placeholders substituted on install)
├── install-mcp-config.sh         # Idempotent installer for mcp.json.example
├── smoke.sh                      # End-to-end smoke test (manual; requires pi + MLX server)
├── extensions/                   # pi extensions — drop into ~/.pi/agent/extensions/ (Phase 4)
│   ├── README.md                 # Extension install guide and URL scheme reference
│   └── gh-vfs.ts                 # read_github_url tool: issue://, pr://, thoughts:// schemes
├── desk/                         # Streamlit desktop dashboard (Phase 5)
│   ├── app.py                    # Streamlit application (six panels + chat)
│   ├── launch.sh                 # uv run streamlit run app.py ...
│   └── pyproject.toml            # uv-managed deps (streamlit, pandas)
└── launchd/
    ├── com.ralph.cos-morning-brief.plist.template   # launchd schedule template (Phase 3)
    └── com.ralph.cos-self-improve.plist.template    # launchd schedule template (Phase 6)
```

---

## Downstream phases

This foundation is consumed by:

| Phase | Issue | What it adds |
|-------|-------|-------------|
| 2 | [GH-1254](https://github.com/cdubiel08/ralph-hero/issues/1254) | COS skill scaffold + `ralph cos {desk,remote,unattended}` CLI wiring |
| 3 | [GH-1255](https://github.com/cdubiel08/ralph-hero/issues/1255) | Unattended morning brief + ntfy push |
| 4 | [GH-1256](https://github.com/cdubiel08/ralph-hero/issues/1256) | oh-my-pi conventions: `cos-loop.sh` (count/duration loop), `gh-vfs.ts` pi extension (`issue://`, `pr://`, `thoughts://`), `ralph cos role` debug subcommand |
| 5 | [GH-1257](https://github.com/cdubiel08/ralph-hero/issues/1257) | Streamlit desktop command surface at :8502 (six panels + chat) |
| 6 | [GH-1258](https://github.com/cdubiel08/ralph-hero/issues/1258) | Nightly self-improvement loop — shipped in this phase |

The `cos.sh` CLI surface (positional prompt + `--role` flag + JSONL log shape) and
`model-roles.sh` sourcing convention are **stable contracts**. Treat changes to these
as breaking changes requiring downstream updates.
