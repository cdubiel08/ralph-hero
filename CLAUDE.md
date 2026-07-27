# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`ralph` — a Claude Code plugin for autonomous GitHub Projects V2 workflow automation. 9 fat skills (catch-up, form, research, plan, impl, review, caretake, hero, setup) backed by the `ralph-hero-mcp-server` npm package. `plugin/ralph-hero/` was deleted in GH-1438 (epic #1430, Phase 8); `ralph/` is now the sole Claude-Code-facing plugin.

## Build & Test

All commands run from `mcp-server/`:

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

**PR checks** (`ci.yml`): Build + test for mcp-server (Node 20/22), ralph-demo, ralph-knowledge. Hook tests from `ralph/hooks/scripts/__tests__` + merge-gate script tests from `scripts/__tests__`. ShellCheck on `ralph/hooks` and `scripts/`. Workflow lint via actionlint + zizmor. MCP pin verification. Doc-roster consistency (`scripts/check-doc-rosters.sh`) — the agent/skill/tool rosters in this file are CI-checked against source, so update them in the same PR as roster changes.

**Merge gate (GH-1589)**: `main` is ruleset-protected — all changes land via PR; merge through `bash scripts/merge-pr.sh PR_NUMBER` (never bare `gh pr merge`). The script enforces: no `CHANGES_REQUESTED`, CI green, a valid head_sha-bound attestation comment (post via `scripts/attest-pr.sh`), and a CodeRabbit review (policy: `.github/ralph-merge-policy.json`; dependabot/github-actions exempt from evidence gates). `validate-attestation.yml` republishes the verdict as the required `ralph-attestation` commit status. Escape hatch: `--force "reason"` (posts a durable override comment). Release workflows bypass via the GitHub Actions app.

**Auto-release** (`release.yml`): Merges touching `mcp-server/src/**` auto-bump `mcp-server/package.json`, publish to npm (OIDC provenance), and pin `ralph/.mcp.json`. Include `#minor` or `#major` in a commit message for larger bumps.

**ralph plugin release** (`release-ralph.yml`): Merges touching `ralph/**` bump `ralph/.claude-plugin/plugin.json` + tag.

**Do NOT** run `npm publish` manually or push `v*` tags manually — the release workflow handles both.

**Verify release fired after merging `ralph/**` changes** — push-event workflows (CI, release-ralph) have silently not fired for some PR-merge commits (observed 2026-07-19). Check `gh run list --commit <merge-sha>`; if absent, `release-ralph.yml` has `workflow_dispatch` as the manual backup.

## Architecture

### Plugin System

```
mcp-server/              # TypeScript MCP server (published as ralph-hero-mcp-server)
ralph/                   # Main plugin — 9 fat skills, 15 agents, hooks
├── skills/              # 9 verb skills (catch-up, form, research, plan, impl, review, caretake, hero, setup)
│   └── shared/          # Shared references: loop-wrapper, auto-alias, mcp-prefix guard
├── agents/              # 15 agents (7 per-phase + 8 investigators)
├── hooks/               # Lifecycle enforcement hooks
├── .claude-plugin/      # Plugin manifest (plugin.json)
└── .mcp.json            # Pinned ralph-hero-mcp-server version (updated by release.yml)
plugin/
├── ralph-knowledge/     # Semantic search over thoughts/ documents
│   └── src/             # Hono MCP server, SQLite + sqlite-vec embeddings
├── ralph-playwright/    # Polymorphic UI testing skills (no MCP server)
│   ├── skills/          # UI testing skills (browser, a11y, storybook, visual-diff, ...)
│   └── agents/          # explorer + story-runner agents
└── ralph-demo/          # Sprint demo video generation (Remotion)
    └── remotion/        # React-based video compositing (pnpm)
```

### ralph Plugin — 9 Verbs

| Verb | Model tier | Purpose |
|------|-----------|---------|
| `/ralph:catch-up` | inherit (haiku narrative agent) | Orientation: narrative + picker, or status report/daily brief |
| `/ralph:form` | inherit | Issue intake: dedup, draft, tree |
| `/ralph:research` | sonnet (feature/epic units: fable fork) | Research: interactive or autonomous queue-drain |
| `/ralph:plan` | best (fable→opus); single XS/S auto-plans fork sonnet | Planning: interactive, auto, epic, iterate, review |
| `/ralph:impl` | sonnet session / complexity ladder (haiku-opus) + haiku test-runner | Implementation: auto, pr, address |
| `/ralph:review` | best (fable→opus); singles reviewed at opus, group val at fable | Review: val, code, merge, behavior verification |
| `/ralph:caretake` | sonnet | Caretaking: triage, hygiene, unblock, reflect, watch, enrich |
| `/ralph:hero` | sonnet | Orchestrator: auto (adaptive queue-drainer) + watch + pr-drain |
| `/ralph:setup` | haiku | Bootstrap: project setup, CLI install, repo-registry |

Plus one experimental surface outside the 9-verb set: `/ralph:hero-fable` (fable; opt-in, requires Fable access) — isolated rail-free path (no prescribed phases, no gate hooks; artifact contract instead). `/ralph:hero --model fable` forwards to it. Design record: `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md`.

The plan/review skill sessions pin `model: best` (Fable 5 where entitled, else latest Opus); `plan-agent`/`review-agent` pin `model: fable` — non-Fable accounts set `CLAUDE_CODE_SUBAGENT_MODEL=opus` as the escape hatch for the `Agent()`-fork path. Autonomous paths additionally route tiers by unit size — feature/epic cycles get fable bookends (research, plan, critique, plan-vs-delivery val); single XS/S issue-PR pairs skip fable entirely. Rationale + routing table: [`docs/model-tier-policy.md`](docs/model-tier-policy.md).

### ralph Plugin — 15 Agents

**7 per-phase agents** (in `ralph/agents/`): `catch-up-agent`, `impl-agent`, `merge-agent`, `plan-agent`, `research-agent`, `review-agent`, `val-agent`

**8 investigators** (in `ralph/agents/`): `codebase-analyzer`, `codebase-locator`, `codebase-pattern-finder`, `log-reader`, `sre-fixit`, `thoughts-analyzer`, `thoughts-locator`, `web-search-researcher`

On `IMPL BLOCKED needs=opus` verdict, the hero re-dispatches `impl-agent` once at `model="opus"`. Override the default impl tier via `RALPH_IMPL_MODEL`. Model-tier rationale: [`docs/model-tier-policy.md`](docs/model-tier-policy.md).

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
| `tree-tools.ts` | create_sub_issues |
| `trends-tools.ts` | capture_snapshot, metrics_trends |
| `directions-tools.ts` | next_actions |
| `plan-graph-tools.ts` | sync_plan_graph |
| `sre-tools.ts` | sre__scale, sre__rollout_restart, sre__delete_pod, sre__drain |
| `activity-tools.ts` | recent_activity |
| `debug-tools.ts` | collate_debug (only registered when RALPH_DEBUG=true) |

**GitHub client** (`github-client.ts`): Wraps `@octokit/graphql` with dual endpoints — `query()`/`mutate()` for repo operations, `projectQuery()`/`projectMutate()` for project operations (may use a separate token). Auto-injects `rateLimit` fragments into non-mutation queries.

**Lib modules** (in `src/lib/` — curated subset; see the directory for the full set):

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
| `routing-types.ts` / `routing-config.ts` / `routing-engine.ts` | Issue routing subsystem |
| `lock-guard.ts` | Pure lock-conflict check for `save_issue` |
| `activity.ts` | Activity log reader (pure filesystem) |
| `directions.ts` | Pure ranker behind `next_actions` (session-briefing directions) |
| `plan-graph.ts` | Plan markdown → issue dependency-edge parser (pure) |
| `snapshots.ts` / `trends.ts` | Snapshot persistence + trend computation |
| `telemetry.ts` / `debug-logger.ts` | OTel export + JSONL debug logging (both gated by `RALPH_DEBUG=true`) |

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

**Async unblock loop**: Hero closes its loop at Human Needed. `/ralph:caretake --mode unblock` posts `## Unblock Request` comments; the human answers via `/ralph:caretake --mode unblock --question`. Sibling loop for held plans (GH-1544): plan review posts `## Decision Request` on Plan in Review issues with open `#### Decision:` blocks; the human replies on the issue (or runs `/ralph:plan --mode review NNN` interactively) and the next review dispatch folds the answers.

### Performance tracking over time

- **Capture**: `ralph_hero__capture_snapshot` appends to `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`.
- **Trends**: `ralph_hero__metrics_trends` returns 1d/7d/30d deltas via `src/lib/trends.ts`.
- **Fixture**: `src/__tests__/fixtures/snapshots.fixture.jsonl` holds 30 synthetic schema-valid rows.

### Activity log

The log lives at `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (path overridable via `RALPH_ACTIVITY_DIR`), one JSON event per line, append-only.

- **Reader**: `mcp-server/src/lib/activity.ts` + `tools/activity-tools.ts` (`recent_activity`). Pure functions — read-only.
- **Writer**: the only in-repo writer is `ralph/hooks/scripts/hero-dispatch-log.sh`, which appends one event per `/ralph:hero` → child-verb Skill dispatch. The general per-session writer (`record-activity.sh`) and the retention script were deleted with `plugin/ralph-hero/` (GH-1438).
- **Cursor advance**: `ralph/hooks/scripts/cursor-advance-catch-up.sh` (PostToolUse on `recent_activity`) persists `~/.ralph-hero/cursors/catch-up.json`.

### Caching Strategy

Two separate caches serve different purposes:
- **`SessionCache`**: API response cache keyed with `query:` prefix + stable node ID lookups (`issue-node-id:*`, `project-item-id:*`). Mutations invalidate `query:` entries only.
- **`FieldOptionCache`**: In-memory project field option IDs, populated by `fetchProjectForCache()`. Multi-project aware (keyed by project number).

### Hook Patterns

Hook scripts in `ralph/hooks/scripts/` are bash gates registered in skill frontmatter under `PreToolUse`, `PostToolUse`, or `Stop`.

**When to use PostToolUse for response inspection:**

Pick PostToolUse over PreToolUse when the data the gate needs to evaluate lives in the **tool response**, not the tool args.

**Mechanics:**

1. Register both `PreToolUse` and `PostToolUse` matchers in the skill's frontmatter, pointing at the same script.
2. Discriminate inside the script via `.hook_event_name`.
3. **Exit codes**: `exit 0` allows the agent to continue; `exit 2` blocks the next step.

**Picking PreToolUse vs PostToolUse:**

| Gate purpose | Event |
|--------------|-------|
| Inject context / remind the agent of constraints | PreToolUse |
| Validate `tool_input` (args correctness) | PreToolUse |
| Validate `tool_response` shape or content | PostToolUse |
| Verify a side-effect succeeded with the expected payload | PostToolUse |

## Key Implementation Gotchas

- **`@octokit/graphql` v9 reserves `query`, `method`, and `url`** as option keys. Never use these as GraphQL variable names.
- **ESM module system**: All internal imports require `.js` extensions (e.g., `import { foo } from "./bar.js"`). The project uses `"type": "module"` with `"module": "NodeNext"`.
- **`resolveEnv()` pattern**: The MCP server inherits env vars from Claude Code's process. `resolveEnv()` in `index.ts` filters out unexpanded `${VAR}` literals that may appear when vars are unset.
- **Split-owner support**: Repo and project can have different owners. `resolveProjectOwner()` handles this.
- **Aliased GraphQL mutations**: Bulk operations (like `batch_update`) use GraphQL aliases (`m0:`, `m1:`, ...) to batch multiple mutations in a single request.
- **mcptools args normalization**: `index.ts` patches `validateToolInput` to normalize `undefined` args to `{}` because mcptools 0.7.1 strips empty `{}` params.

## Environment Variables

The config file location depends on plugin install scope (detected from `~/.claude/plugins/installed_plugins.json`):

- **Project-scoped install**: non-secret scope vars (`RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`, `RALPH_GH_PROJECT_OWNER`) go in the **tracked** `<project>/.claude/settings.json` so worktree/bridge sessions and fresh clones inherit them; tokens and machine-local toggles go in the **gitignored** `<project>/.claude/settings.local.json` (local wins on conflict). Scope vars living only in the gitignored file leave every worktree session board-blind (`owner is required`) — see `ralph/skills/setup/scope-detection.md` § Worktrees and bridge sessions.
- **Creating impl worktrees from a bridge/worktree session**: `EnterWorktree({name})` refuses when the session is already in a worktree. Create manually — `git worktree add -b feature/GH-NNN .claude/worktrees/GH-NNN origin/main` — then `EnterWorktree({path: ...})` to switch in.
- **User-scoped install**: Set all env vars in `~/.claude/settings.json` — this makes the CLI work from any directory

When no `RALPH_*_TOKEN` env var is set, the MCP server falls back to `gh auth token` from the gh CLI keychain (just run `gh auth login -s repo,project,read:org`).

| Variable | Required | Description |
|----------|----------|-------------|
| `RALPH_HERO_GITHUB_TOKEN` | No (defaults to `gh auth token`) | GitHub PAT with `repo` + `project` scopes. |
| `RALPH_GH_OWNER` | Yes | GitHub owner (user or org) |
| `RALPH_GH_PROJECT_NUMBER` | Yes | GitHub Projects V2 number |
| `RALPH_GH_REPO` | No | Repository name (inferred from project if omitted) |
| `RALPH_GH_PROJECT_NUMBERS` | No | Comma-separated project numbers for cross-project dashboard |
| `RALPH_GH_REPO_TOKEN` | No | Separate repo token (falls back to main token, then to `gh auth token`) |
| `RALPH_GH_PROJECT_TOKEN` | No | Separate project token (falls back to repo token) |
| `RALPH_GH_PROJECT_OWNER` | No | Project owner if different from repo owner |
| `RALPH_GH_TEMPLATE_PROJECT` | No | Template project number for `setup_project` to copy fields/views from |
| `RALPH_AUTOPILOT_ENABLE` | No | Must be `"true"` for `hero --mode auto`; enforced by `autopilot-enable-gate.sh` |
| `RALPH_REVIEW_PLAN` | No | Plan-review gate mode. Default `auto` with decision-driven semantics: APPROVED plans with open `#### Decision:` blocks hold in Plan in Review with a `## Decision Request` comment; decision-free plans auto-advance. `interactive` opts into the whole-plan picker flow. |
| `RALPH_REVIEW_MODE` | No | Merge-gate mode. Default `auto`: hero runs val → code-review → merge → CI watch unattended (`CHANGES_REQUESTED` on a PR still unconditionally blocks). `interactive` opts into the old report-PR-URLs-and-STOP behavior. |
| `RALPH_IMPL_MODEL` | No | Override model for `impl-agent` (e.g. `sonnet`, `opus`, or `fable` if your plan includes it). Defaults to `sonnet`; BLOCKED escalation re-dispatches once at `opus`. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | No (harness-native, not ralph plumbing) | Escape hatch for the `model: fable` pins on `plan-agent`/`review-agent`: set to `opus` on accounts without Fable. Top precedence in Claude Code's subagent model resolution — it overrides frontmatter AND per-invocation `model` params, so it flattens EVERY subagent tier (locators, impl ladder, BLOCKED re-dispatch). Leave unset if your account has Fable. |
| `RALPH_DEBUG` | No | Set to `"true"` to enable JSONL debug logging and OpenTelemetry export. |
| `RALPH_USE_WORKFLOWS` | No | Research-preview prototype flag (GH-1474). Set to `"true"` to route `research` Step 3's investigator fan-out through the saved `research-investigators` Dynamic Workflow (`.claude/workflows/`) instead of inline `Agent()` dispatch. Default off — inline path unchanged. |

**Do NOT put tokens in `.mcp.json`** — the `.mcp.json` has no `env` block; the MCP server inherits the parent environment.

### OpenTelemetry export (`RALPH_DEBUG=true`)

`mcp-server/src/lib/telemetry.ts` lazily initializes the OTel NodeSDK only when `RALPH_DEBUG=true` (zero overhead otherwise). It exports `ralph_hero.graphql` spans (emitted in `github-client.ts`) over OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` — e.g. the local Langfuse harness at `~/projects/langfuse/`. Auto-instrumentation is off; a custom SpanProcessor redacts token-shaped attribute values (`gh[ps]_*` values, `*_TOKEN`/`authorization` keys) before export. The same env var gates JSONL debug logging (`debug-logger.ts`) and the debug tools.

## GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | push/PR to main | Build, test, lint |
| `release.yml` | mcp-server/ changes on main | Bump version, npm publish, pin ralph/.mcp.json |
| `release-ralph.yml` | ralph/ changes on main | Bump ralph plugin version + tag |
| `release-knowledge.yml` | plugin/ralph-knowledge/ changes on main | Publish-first knowledge release: npm publish → verify on registry → pin .mcp.json → tag |
| `route-issues.yml` | Issue opened | Route new issues to project board |
| `sync-issue-state.yml` | Issue state change | Sync GitHub issue state with project workflow |
| `sync-pr-merge.yml` | PR merged | Move linked issues to Done |
| `sync-project-state.yml` | Project field change | Sync project state back to issues |
| `advance-parent.yml` | Sub-issue state change | Auto-advance parent when children reach gate states |
