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
├── mcp.json.example              # Template MCP config (placeholders substituted on install)
├── install-mcp-config.sh         # Idempotent installer for mcp.json.example
├── smoke.sh                      # End-to-end smoke test (manual; requires pi + MLX server)
├── extensions/                   # pi extensions — drop into ~/.pi/agent/extensions/ (Phase 4)
│   ├── README.md                 # Extension install guide and URL scheme reference
│   └── gh-vfs.ts                 # read_github_url tool: issue://, pr://, thoughts:// schemes
└── launchd/
    └── com.ralph.cos-morning-brief.plist.template   # launchd schedule template (Phase 3)
```

---

## Downstream phases

This foundation is consumed by:

| Phase | Issue | What it adds |
|-------|-------|-------------|
| 2 | [GH-1254](https://github.com/cdubiel08/ralph-hero/issues/1254) | COS skill scaffold + `ralph cos {desk,remote,unattended}` CLI wiring |
| 3 | [GH-1255](https://github.com/cdubiel08/ralph-hero/issues/1255) | Unattended morning brief + ntfy push |
| 4 | [GH-1256](https://github.com/cdubiel08/ralph-hero/issues/1256) | oh-my-pi conventions: `cos-loop.sh` (count/duration loop), `gh-vfs.ts` pi extension (`issue://`, `pr://`, `thoughts://`), `ralph cos role` debug subcommand |
| 5 | [GH-1257](https://github.com/cdubiel08/ralph-hero/issues/1257) | Streamlit desktop command surface at :8502 |
| 6 | [GH-1258](https://github.com/cdubiel08/ralph-hero/issues/1258) | Nightly self-improvement loop |

The `cos.sh` CLI surface (positional prompt + `--role` flag + JSONL log shape) and
`model-roles.sh` sourcing convention are **stable contracts**. Treat changes to these
as breaking changes requiring downstream updates.
