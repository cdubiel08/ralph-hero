# CLI Reference

Ralph Hero provides justfile recipes for workflow automation. Run recipes from the `plugin/ralph-hero/` directory (or anywhere via the global `ralph` command if installed).

## Utility Recipes

### `doctor`

Diagnoses setup issues by checking environment variables, dependencies, plugin manifest validity, and API connectivity.

```bash
just doctor
```

**Checks performed:**

| Category | What it checks |
|----------|---------------|
| Environment Variables | `RALPH_HERO_GITHUB_TOKEN`, `RALPH_GH_OWNER`, `RALPH_GH_PROJECT_NUMBER` are set |
| Dependencies | `just`, `npx`, `node` are installed |
| Optional Dependencies | `mcp` (mcptools) for quick-* recipes, `claude` CLI for LLM-powered recipes |
| Plugin Files | `.claude-plugin/plugin.json` and `.mcp.json` exist and are valid JSON |
| API Health | Calls `ralph_hero__health_check` via mcptools (skipped if mcptools or token unavailable) |

Exits with code 1 if any errors are found. Warnings (missing optional dependencies) do not cause a non-zero exit.

## Quick Actions

Quick actions invoke MCP server tools directly via [mcptools](https://github.com/f/mcptools) — no LLM involved, instant results, zero API cost.

### Prerequisite

Install mcptools before using any `quick-*` recipe:

```bash
brew tap f/mcptools && brew install mcp
```

Or via Go:

```bash
go install github.com/f/mcptools/cmd/mcptools@latest
```

Run `just doctor` to verify mcptools is available.

---

### `quick-status`

Display the pipeline status dashboard.

```bash
just quick-status                # Markdown format (default)
just quick-status format="json"  # JSON format
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `format` | `"markdown"` | Output format: `"markdown"` or `"json"` |

### `quick-move`

Move an issue to a workflow state.

```bash
just quick-move 42 "In Progress"
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `issue` | Yes | Issue number |
| `state` | Yes | Target workflow state (e.g., `"Backlog"`, `"In Progress"`, `"Done"`) |

### `quick-pick`

Find the next actionable issue by workflow state and estimate size.

```bash
just quick-pick                                  # Default: Research Needed, max S
just quick-pick state="Ready for Plan"
just quick-pick state="Backlog" max-estimate="M"
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `state` | `"Research Needed"` | Workflow state to search |
| `max-estimate` | `"S"` | Maximum estimate size to include |

### `quick-assign`

Assign an issue to a GitHub user.

```bash
just quick-assign 42 cdubiel08
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `issue` | Yes | Issue number |
| `user` | Yes | GitHub username |

### `quick-issue`

Create a new issue with project fields set automatically.

```bash
just quick-issue "Fix login bug"
just quick-issue "Add dark mode" label="enhancement" priority="P2" estimate="S"
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `title` | (required) | Issue title |
| `label` | `""` | Label to apply |
| `priority` | `""` | Priority level (e.g., `"P1"`, `"P2"`) |
| `estimate` | `""` | Size estimate (e.g., `"XS"`, `"S"`, `"M"`) |
| `state` | `"Backlog"` | Initial workflow state |

### `quick-info`

Get full issue details including project fields.

```bash
just quick-info 42
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `issue` | Yes | Issue number |

### `quick-comment`

Add a comment to an issue.

```bash
just quick-comment 42 "Looks good, merging now"
```

| Parameter | Required | Description |
|-----------|----------|-------------|
| `issue` | Yes | Issue number |
| `body` | Yes | Comment text |

### `quick-draft`

Create a draft issue on the project board. Draft issues are project cards without a backing GitHub issue — useful for quick capture.

```bash
just quick-draft "Investigate auth latency"
just quick-draft "Refactor cache layer" priority="P2" estimate="M" state="Backlog"
```

| Parameter | Default | Description |
|-----------|---------|-------------|
| `title` | (required) | Draft issue title |
| `priority` | `""` | Priority level |
| `estimate` | `""` | Size estimate |
| `state` | `"Backlog"` | Initial workflow state |
