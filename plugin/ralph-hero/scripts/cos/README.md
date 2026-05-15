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

## Directory layout

```
plugin/ralph-hero/scripts/cos/
├── README.md              # This file — operator setup guide
├── PREFLIGHT.md           # Pre-flight install verification outputs (Task 1.0)
├── model-roles.sh         # Sourced helper — resolves RALPH_COS_ROLE → COS_MODEL
├── cos.sh                 # Entrypoint — invoke pi with model-role + JSONL logging
├── mcp.json.example       # Template MCP config (placeholders substituted on install)
├── install-mcp-config.sh  # Idempotent installer for mcp.json.example
└── smoke.sh               # End-to-end smoke test (manual; requires pi + MLX server)
```

---

## Downstream phases

This foundation is consumed by:

| Phase | Issue | What it adds |
|-------|-------|-------------|
| 2 | [GH-1254](https://github.com/cdubiel08/ralph-hero/issues/1254) | COS skill scaffold + `ralph cos {desk,remote,unattended}` CLI wiring |
| 3 | [GH-1255](https://github.com/cdubiel08/ralph-hero/issues/1255) | Unattended morning brief + ntfy push |
| 4 | [GH-1256](https://github.com/cdubiel08/ralph-hero/issues/1256) | oh-my-pi conventions (`cos-loop.sh`, `gh-vfs.ts`, model-roles polish) |
| 5 | [GH-1257](https://github.com/cdubiel08/ralph-hero/issues/1257) | Streamlit desktop command surface at :8502 |
| 6 | [GH-1258](https://github.com/cdubiel08/ralph-hero/issues/1258) | Nightly self-improvement loop |

The `cos.sh` CLI surface (positional prompt + `--role` flag + JSONL log shape) and
`model-roles.sh` sourcing convention are **stable contracts**. Treat changes to these
as breaking changes requiring downstream updates.
