# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Claude Code plugin providing autonomous GitHub Projects V2 workflow automation. The MCP server is published to npm as `ralph-hero-mcp-server` and consumed via `npx` in `.mcp.json`. The `dist/` directory is not committed to git.

## Build & Test

All commands run from `plugin/ralph-hero/mcp-server/`:

```bash
npm install          # Install dependencies
npm run build        # TypeScript -> dist/ (tsc)
npm test             # Run full test suite (vitest)
npx vitest run src/__tests__/cache.test.ts           # Run a single test file
npx vitest run -t "should invalidate"                # Run tests matching a name pattern
```

**ralph-knowledge plugin** (from `plugin/ralph-knowledge/`):
```bash
npm install && npm run build && npm test
```

No linter is configured. TypeScript strict mode is the primary code quality gate.

## CI/CD

**PR checks** (`ci.yml`): Build + test across Node 18, 20, 22 for plugins with source (hero, knowledge, demo). ralph-playwright is skills/agents-only — no build step.

**Auto-release** (`release.yml`): Merges to `main` that touch MCP server source auto-bump version in both `mcp-server/package.json` and `.claude-plugin/plugin.json`, tag, and publish to npm with provenance. Include `#minor` or `#major` in a commit message for larger bumps.

**Do NOT** run `npm publish` manually or push `v*` tags manually — the release workflow handles both.

## Architecture

### Plugin System

```
plugin/
├── ralph-hero/              # Main plugin — MCP server, skills, agents, hooks
│   ├── mcp-server/          # TypeScript MCP server (published as ralph-hero-mcp-server)
│   ├── skills/              # 30+ skill definitions (YAML frontmatter + markdown)
│   ├── agents/              # 10 per-phase agent definitions
│   ├── hooks/               # 50+ lifecycle enforcement hooks
│   └── scripts/             # CLI and automation scripts
├── ralph-knowledge/         # Semantic search over thoughts/ documents
│   └── src/                 # Hono MCP server, SQLite + sqlite-vec embeddings
├── ralph-playwright/        # Polymorphic UI testing skills (no MCP server)
│   ├── skills/              # 7 skills (setup, story-gen, explore, test-e2e, a11y-scan, storybook-test, visual-diff)
│   ├── agents/              # 2 agents (explorer-agent, story-runner-agent)
│   └── schemas/             # User story YAML schema + examples
└── ralph-demo/              # Sprint demo video generation (Remotion)
    └── remotion/            # React-based video compositing (pnpm)
```

### Per-Phase Agents

Each autonomous skill has a dedicated agent in `plugin/ralph-hero/agents/` that preloads the skill via the `skills:` field. The hero orchestrator dispatches these agents via `Agent()` calls with natural language prompts.

| Agent | Model | Preloaded Skill | Tier |
|-------|-------|-----------------|------|
| `research-agent` | sonnet | ralph-research | Analyst |
| `plan-agent` | opus | ralph-plan | Analyst |
| `plan-epic-agent` | opus | ralph-plan-epic | Analyst |
| `split-agent` | opus | ralph-split | Analyst |
| `triage-agent` | sonnet | ralph-triage | Analyst |
| `review-agent` | opus | ralph-review | Builder |
| `impl-agent` | opus | ralph-impl | Builder |
| `pr-agent` | haiku | ralph-pr | Integrator |
| `merge-agent` | haiku | ralph-merge | Integrator |
| `val-agent` | haiku | ralph-val | Integrator |
| `unblock-agent` | sonnet | ralph-unblock | Async-loop |

> **Model tier policy**: see `plugin/ralph-hero/docs/model-tier-policy.md` for
> the complexity-driven tier rules and `RALPH_<AGENT>_MODEL` override pattern.

Key properties:
- Skill content is injected into agent context with backtick preprocessing (env vars resolved at load time)
- The agent's `tools:` field is a hard allowlist -- the runtime enforcement boundary
- Plugin-level hooks in `hooks.json` discriminate by `agent_type` (e.g., `impl-agent` triggers worktree gates)
- Plugin agents cannot declare `hooks`, `mcpServers`, or `permissionMode` in frontmatter -- only `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `effort`, `maxTurns`

### MCP Server Internals

**Entry point**: `src/index.ts` — resolves environment, creates `GitHubClient`, registers all tool modules, connects stdio transport.

**Tool registration pattern** — each module exports a `registerXyzTools()` function:
```typescript
export function registerIssueTools(
  server: McpServer,
  client: GitHubClient,
  fieldCache: FieldOptionCache,
): void {
  server.tool("ralph_hero__tool_name", "description", {
    param: z.string().describe("..."),
  }, async (params) => {
    return toolSuccess(result); // or toolError(message)
  });
}
```

All tool names use the `ralph_hero__` prefix. Use `toolSuccess()` and `toolError()` from `types.ts` for responses.

**Tool modules** (in `src/tools/`):

| Module | Key tools |
|--------|-----------|
| `issue-tools.ts` | list_issues, get_issue, create_issue, save_issue |
| `project-tools.ts` | setup_project, get_project |
| `relationship-tools.ts` | add_sub_issue, add_dependency, advance_issue |
| `batch-tools.ts` | batch_update |
| `dashboard-tools.ts` | pipeline_dashboard, detect_stream_positions |
| `project-management-tools.ts` | archive_items, create_status_update |
| `hygiene-tools.ts` | project_hygiene |
| `decompose-tools.ts` | decompose_feature |
| `debug-tools.ts` | debug tools (only registered when RALPH_DEBUG=true) |

**GitHub client** (`github-client.ts`): Wraps `@octokit/graphql` with dual endpoints — `query()`/`mutate()` for repo operations, `projectQuery()`/`projectMutate()` for project operations (may use a separate token). Auto-injects `rateLimit` fragments into non-mutation queries.

**Lib modules** (in `src/lib/`):

| Module | Purpose |
|--------|---------|
| `workflow-states.ts` | State machine definitions, ordering, validation |
| `cache.ts` | SessionCache (API responses) + FieldOptionCache (field metadata) |
| `helpers.ts` | Config resolution, field cache ensure, node ID lookup, status sync, parent auto-advance |
| `rate-limiter.ts` | Proactive rate limit tracking (warn at 100, block at 50 remaining) |
| `pipeline-detection.ts` | Phase detection for orchestrators |
| `group-detection.ts` | Parent-child group analysis |
| `dashboard.ts` | Pipeline aggregation, health scoring |
| `repo-registry.ts` | Multi-repo YAML registry types |

### Workflow State Machine

```
Backlog → Research Needed → Research in Progress → Ready for Plan
       → Plan in Progress → Plan in Review → In Progress → In Review → Done
```

Key state categories defined in `workflow-states.ts`:
- **Terminal**: Done, Canceled
- **Lock states**: Research in Progress, Plan in Progress, In Progress (exclusive claim)
- **Parent gate states**: Ready for Plan, Plan in Review, In Review, Done (trigger parent advancement)

`save_issue` automatically syncs the Status field (Todo/In Progress/Done) based on `WORKFLOW_STATE_TO_STATUS` mapping when setting `workflowState`. The sync is best-effort and one-way.

**Async unblock loop**: Hero closes its loop at Human Needed. The `ralph-hero:ralph-unblock` skill runs as a separate async loop (scheduled via launchd, fired by external trigger, or driven by human attention) and posts `## Unblock Request` comments with specific blocking questions. The interactive `ralph-hero:unblock` skill is then invoked by the human to provide answers and route the issue back into the pipeline.

### Performance tracking over time

Ralph captures point-in-time project snapshots so velocity, risk, WIP, and lead time can be trended without re-querying GitHub history.

- **Capture**: `ralph_hero__capture_snapshot` (registered by `trends-tools.ts`) appends one row to `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`. Pure helpers live in `src/lib/snapshots.ts` (`appendSnapshot`, `readSnapshots`, `toSnapshot`).
- **Schema**: `Snapshot` is schema-versioned (`SNAPSHOT_SCHEMA_VERSION`). Rows whose version does not match the current value are skipped on read with a `console.warn` so a single bad append cannot poison a file.
- **Cycle time**: `src/lib/cycle-times.ts` rolls per-issue `TransitionRecord[]` into p50/p90 lead-time + per-phase dwell. The optional `Snapshot.cycleTime` field carries this rollup forward into trends.
- **Trends**: `src/lib/trends.ts` exposes `computeTrends()` (1d/7d/30d deltas across `velocity`, `riskScore`, `wipTotal`, `leadTimeP50Hours`) and `renderSparkline()` (8-bucket Unicode block render). `ralph_hero__metrics_trends` returns markdown or JSON.
- **Skill**: `/trends` (`plugin/ralph-hero/skills/trends/SKILL.md`) captures a fresh snapshot, then prints the markdown trend report. Read-only — nothing is posted to GitHub.
- **Fixture**: `src/__tests__/fixtures/snapshots.fixture.jsonl` holds 30 synthetic schema-valid rows used by `trends.test.ts` and as a documentation example of the on-disk format.
- **Schedule**: optional launchd template at `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` — captures one snapshot per day so the JSONL accumulates a daily history without manual intervention.

### Autopilot

`/ralph-hero:autopilot` is a thin wrapper around `/loop /ralph-hero:hero`. The skill body delegates to the built-in `/loop` skill in dynamic mode (model self-paces wakeup cadence via `ScheduleWakeup`) and trusts hero for every per-issue decision including escalation. Opt-in via `RALPH_AUTOPILOT_ENABLE=true`, enforced deterministically by `hooks/scripts/autopilot-enable-gate.sh` (PreToolUse:Skill matcher) — the gate exits 2 with a fixed message if the env var is missing. No state machine, no audit log, no hardcoded delays in autopilot itself; `/loop` and hero own that machinery. Coexists with the out-of-process `scripts/ralph-loop.sh` for headless `claude -p` use.

### Activity log + retention

Hooks write per-session activity into `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (path overridable via `RALPH_ACTIVITY_DIR`). One JSON object per line. Events are categorized as `work` (state-mutating tool calls, agent dispatches, skill invocations) or `meta` (read-only tool calls — Bash, Read, Edit, etc.) by `record-activity.sh`. The `recent_activity` MCP tool reads this log; /hello's catch-up agent filters by `category: "work"` for narrative synthesis.

- **Writer**: `plugin/ralph-hero/hooks/scripts/record-activity.sh` (PostToolUse, matcher-less; also wired to SessionStart).
- **Reader**: `plugin/ralph-hero/mcp-server/src/lib/activity.ts` + `tools/activity-tools.ts`. Pure functions; no cursor state inside the server.
- **Cursor advance**: `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` (PostToolUse(`ralph_hero__recent_activity`)) writes `~/.ralph-hero/cursors/catch-up.json` from `tool_response.cursor_advanced_to`.
- **Retention**: `plugin/ralph-hero/scripts/activity/logrotate.sh` prunes day files older than `RALPH_ACTIVITY_RETENTION_DAYS` (default 14). Optional launchd template at `scripts/activity/launchd/com.ralph.activity-rotate.plist.template`.
- **Compact mode**: `recent_activity({ compact: true, limit: 50 })` projects events to `{ts, kind, tool, project}` for narrative consumers; ~50% byte reduction vs the full shape.

### Caching Strategy

Two separate caches serve different purposes:
- **`SessionCache`**: API response cache keyed with `query:` prefix + stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). Mutations invalidate `query:` entries only — node ID lookups are stable.
- **`FieldOptionCache`**: In-memory project field option IDs, populated by `fetchProjectForCache()`. Multi-project aware (keyed by project number).

### Delegation

Optional, off-by-default LLM delegation wrapper at `plugin/ralph-hero/scripts/ralph-delegate.sh`. Skills with narrow text-in/text-out sub-tasks (summarize, classify, rerank) can offload work to a local Gemma server or cheaper OpenRouter model via the `Bash` tool.

Master toggle is `RALPH_DELEGATE_ENABLED` — unset (the default) means exit 126 immediately and bit-identical no-op behavior. The wrapper never throws on disabled state; callers gate on `$?` and fall back natively.

Currently wired: `codebase-locator` (F4a), `pr-agent` (F4b), `val-agent` (F4c), and the reference skill `delegate-test` (F3).

Telemetry: `ralph_hero__delegation_stats` MCP tool + `ralph status --delegation` CLI read the JSONL audit log at `~/.ralph-hero/delegate.log`. See `plugin/ralph-hero/README.md` § Delegation (optional).

When to add delegation to a new skill: read `plugin/ralph-hero/docs/delegation-authoring.md` and check the eligible/ineligible matrix in `plugin/ralph-hero/skills/shared/delegation-conventions.md` first.

### Hook Patterns

Hook scripts in `plugin/ralph-hero/hooks/scripts/` are bash gates registered in skill frontmatter under `PreToolUse`, `PostToolUse`, or `Stop`. The default pattern is a single-event gate; this section documents the less-obvious **PostToolUse-for-response-inspection** pattern.

**When to use PostToolUse for response inspection:**

Pick PostToolUse over PreToolUse when the data the gate needs to evaluate lives in the **tool response**, not the tool args. Typical cases:

- The gate needs to inspect a fetched issue's estimate, status, or relationships before allowing the next step
- The gate needs to verify a side-effect actually produced the expected shape (e.g., `add_sub_issue` returned a real linkage)

PreToolUse only sees `tool_input` — it cannot see what the tool returned. If the constraint is "block if the response shape is X," PreToolUse alone cannot enforce it.

**Mechanics:**

1. Register both `PreToolUse` and `PostToolUse` matchers in the skill's frontmatter, pointing at the same script:
   ```yaml
   PreToolUse:
     - matcher: "ralph_hero__get_issue"
       hooks:
         - { type: command, command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh" }
   PostToolUse:
     - matcher: "ralph_hero__get_issue"
       hooks:
         - { type: command, command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh" }
   ```

2. Discriminate inside the script via `.hook_event_name`:
   ```bash
   event_name=$(get_field '.hook_event_name')
   if [[ "$event_name" == "PreToolUse" ]]; then
     # Surface a context reminder via stderr; exit 0 to allow the call
   else
     # PostToolUse: parse tool_response.content[0].text, exit 2 to block
   fi
   ```

3. **Exit codes**: `exit 0` allows the agent to continue; `exit 2` (with a clear stderr message) blocks the next step. PostToolUse cannot mutate the response — it can only allow or block subsequent skill steps.

**Reference implementation:** `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` + `plugin/ralph-hero/skills/ralph-split/SKILL.md` frontmatter. The gate surfaces an M/L/XL reminder on PreToolUse, then on PostToolUse parses `tool_response.content[0].text`, extracts the issue's estimate, and blocks with exit 2 if the estimate is XS or S — preventing the agent from proceeding to splitting an already-atomic issue.

**Picking PreToolUse vs PostToolUse:**

| Gate purpose | Event |
|--------------|-------|
| Inject context / remind the agent of constraints | PreToolUse |
| Validate `tool_input` (args correctness) | PreToolUse |
| Validate `tool_response` shape or content | PostToolUse |
| Verify a side-effect succeeded with the expected payload | PostToolUse |

Combine both when the gate needs both behaviors (context reminder + response inspection), as `split-estimate-gate.sh` does.

## Key Implementation Gotchas

- **`@octokit/graphql` v9 reserves `query`, `method`, and `url`** as option keys. Never use these as GraphQL variable names.
- **ESM module system**: All internal imports require `.js` extensions (e.g., `import { foo } from "./bar.js"`). The project uses `"type": "module"` with `"module": "NodeNext"`.
- **`resolveEnv()` pattern**: The MCP server inherits env vars from Claude Code's process. `resolveEnv()` in `index.ts` filters out unexpanded `${VAR}` literals that may appear when vars are unset. The `.mcp.json` has no `env` block — configuration flows through Claude Code's settings files (see Environment Variables below).
- **Split-owner support**: Repo and project can have different owners. `resolveProjectOwner()` handles this. `fetchProjectForCache()` tries both `user` and `organization` GraphQL types.
- **Aliased GraphQL mutations**: Bulk operations (like `batch_update`) use GraphQL aliases (`m0:`, `m1:`, ...) to batch multiple mutations in a single request.
- **mcptools args normalization**: `index.ts` patches `validateToolInput` to normalize `undefined` args to `{}` because mcptools 0.7.1 strips empty `{}` params.

## Environment Variables

The config file location depends on plugin install scope (detected from `~/.claude/plugins/installed_plugins.json`):

- **Project-scoped install**: Set all env vars in `<project>/.claude/settings.local.json` (gitignored)
- **User-scoped install**: Set all env vars in `~/.claude/settings.json` — this makes the CLI work from any directory

The CLI's `resolve-env.sh` searches in order: shell env → repo `settings.local.json` → repo `settings.json` → `~/.claude/settings.json`. When no `RALPH_*_TOKEN` env var is set, the MCP server falls back to `gh auth token` from the gh CLI keychain — so most users don't need to put a token in any settings file at all (just run `gh auth login -s repo,project,read:org`).

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | No (defaults to `gh auth token`) | GitHub PAT with `repo` + `project` scopes. Optional override — if unset, the MCP server falls back to the `gh` CLI keychain. |
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number |
| `RALPH_GH_REPO` | No | Repository name (inferred from project if omitted) |
| `RALPH_GH_PROJECT_NUMBERS` | No | Comma-separated project numbers for cross-project dashboard |
| `RALPH_GH_REPO_TOKEN` | No | Separate repo token (falls back to main token, then to `gh auth token`) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate project token (falls back to repo token) |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_DEBUG` | No | Set to `"true"` to enable JSONL debug logging, register debug tools, and activate OpenTelemetry export (when `OTEL_*` vars are also set). Acts as the master switch for all debug surfaces. |

**Do NOT put tokens in `.mcp.json`** — the `.mcp.json` has no `env` block; the MCP server inherits the parent environment.

### OpenTelemetry export to local Langfuse

When `RALPH_DEBUG=true` is set alongside the `OTEL_*` env vars below, Claude Code exports `mcp.tool.*` spans, hook events, and session lifecycle traces over OTLP/HTTP. The MCP server (Phase 2+) attaches `ralph_hero.graphql` child spans inside the same trace context. The local Langfuse harness at `~/projects/langfuse/` (documented in `~/projects/CLAUDE.md` under "Local ADK + Langfuse testing harness") is the default ingestion target.

**`RALPH_DEBUG` is the activation switch.** All four `OTEL_*` vars are no-ops when `RALPH_DEBUG` is unset — the MCP server skips OTel SDK initialization entirely and emits zero outbound traffic to `:3100`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | No | unset | Set to `"1"` to enable Claude Code's native OpenTelemetry export. Required for Claude Code to emit `mcp.tool.*` and hook spans. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | unset | OTLP/HTTP receiver URL. For the local Langfuse harness, use `http://localhost:3100/api/public/otel/v1/traces`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | No | unset | Comma-separated header list passed on every OTLP export. Use this to inject the Langfuse basic-auth header (see below). |
| `OTEL_SERVICE_NAME` | No | unset | Logical service name attached as a resource attribute on every span. Recommended: `claude-code` for the host process, `ralph-hero` for MCP server child spans. |

**Basic-auth header construction.** Langfuse's public OTLP endpoint requires basic auth with the project's public key as username and secret key as password. The default local-dev credentials are `pk-lf-local-dev:sk-lf-local-dev`. Construct the header value once:

```bash
printf '%s' "pk-lf-local-dev:sk-lf-local-dev" | base64
# -> cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==
```

Then set `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==`. The literal header value (key + `=` + base64) is what OTel SDKs expect; do not wrap the value in quotes inside the env var.

**Sample `.claude/settings.local.json` snippet.** Copy-paste the `env` block into `~/.claude/settings.json` (user-scoped) or `<project>/.claude/settings.local.json` (project-scoped, gitignored). The endpoint assumes the local Langfuse harness is running on port 3100 (see `~/projects/CLAUDE.md` for stack bring-up: `cd ~/projects/langfuse && ./scripts/up.sh`).

```json
{
  "env": {
    "RALPH_DEBUG": "true",
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:3100/api/public/otel/v1/traces",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Basic cGstbGYtbG9jYWwtZGV2OnNrLWxmLWxvY2FsLWRldg==",
    "OTEL_SERVICE_NAME": "claude-code"
  }
}
```

After editing the settings file, restart Claude Code so the MCP server inherits the new env. With `RALPH_DEBUG` unset (or absent from the `env` block), the MCP server bypasses OTel init regardless of the `OTEL_*` values.

## GitHub Actions Workflows

Beyond CI/CD, several workflows automate project board management:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `route-issues.yml` | Issue opened | Route new issues to project board |
| `sync-issue-state.yml` | Issue state change | Sync GitHub issue state with project workflow |
| `sync-pr-merge.yml` | PR merged | Move linked issues to Done |
| `sync-project-state.yml` | Project field change | Sync project state back to issues |
| `advance-parent.yml` | Sub-issue state change | Auto-advance parent when children reach gate states |
