# Ralph Hero — Weekly Ship Report

**Period**: Feb 14–21, 2026
**Releases**: v2.4.5 → v2.4.47 (42 releases)
**Commits**: 387 to main
**PRs Merged**: 30+

---

## Highlights

This was a transformative week. Ralph Hero went from a single-project plugin with basic issue management to a full multi-project orchestration platform with deterministic routing, cross-project sync, intelligent filtering, CLI tooling, and a production-grade team worker architecture.

---

## 1. Worker Architecture Overhaul

Replaced ad-hoc agent spawning with a formal 4-worker team model.

- **4 specialized workers**: Analyst, Builder, Validator, Integrator — each with defined scope boundaries and state ownership
- **Bough model**: Current-phase-only task creation prevents over-planning; tasks emerge as phases converge
- **Typed agents**: Workers spawned as `ralph-analyst`, `ralph-builder`, `ralph-validator`, `ralph-integrator` with role-specific tool surfaces
- **Single worker template**: Consolidated 7 spawn templates into one `worker.md` with placeholder substitution
- **Hybrid task ownership**: Push-based pre-assignment at spawn + pull-based self-claim eliminates first-turn race conditions
- **Worker Stop hook**: Prevents premature shutdown while GitHub has processable issues
- **Context isolation**: `context:fork` on all 6 worker skills prevents cross-invocation pollution
- **Template integrity enforcement**: Line-count guardrail (10-line max) prevents orchestrators from front-loading context
- **Sub-agent team isolation**: Internal `Task()` calls no longer inherit team context, eliminating phantom teammate floods

**Issues**: #40, #44, #45–51, #52, #53, #88, #89, #92, #132, #134–137, #200, #209, #218, #231, #252, #256, #257, #258, #264, #268, #269

## 2. Deterministic Issue Routing

A complete rules engine for automatically routing GitHub issues to the right project board with the right field values.

- **Config schema**: YAML-based routing rules with label/title/body matchers and field-setting actions
- **Matching engine**: Supports `contains`, `matches` (regex), `equals`, `startsWith` operators with first-match-wins semantics
- **GitHub Actions workflow**: Triggers on issue open/transfer/label events, evaluates rules, routes to projects
- **Reusable workflow**: Cross-repo installation via `workflow_call` — any repo can adopt routing with a thin caller workflow
- **Config loader + live validation**: `configure_routing` MCP tool with CRUD operations, `validate_rules` checks against live project data
- **Dry-run mode**: Test routing rules against issues without making changes
- **Audit trail**: Every routing action logs a comment with rule match details
- **Error handling**: Retry logic with idempotency guards

**Issues**: #99, #125, #126, #166–173, #175–180, #197

## 3. Cross-Project Sync & Multi-Project Support

First-class support for managing multiple GitHub Projects V2 boards from a single Ralph instance.

- **`RALPH_GH_PROJECT_NUMBERS` env var**: Comma-separated list enables cross-project awareness
- **`projectNumber` override**: All project-aware tools accept per-call project targeting
- **Cross-project dashboard**: `pipeline_dashboard` auto-aggregates across all configured projects with health indicators
- **`sync_across_projects` MCP tool**: Propagate state changes from one project to others
- **GitHub Actions sync workflow**: Event-driven cross-project state sync on issue close/reopen
- **Parent auto-advance**: When all children reach a gate state, parent issues advance automatically via `advance_parent`
- **`list_project_repos` tool**: Query which repositories are linked to a project
- **Repo inference**: Automatically infer `RALPH_GH_REPO` from project-linked repositories instead of env var
- **`link_repository` / `link_team`**: Associate repos and teams with projects programmatically
- **Multi-project cache**: Session cache scoped per project number

**Issues**: #93, #144, #145, #146, #150, #151, #152, #180, #181, #197, #199, #223–225

## 4. Intelligent Agent Filtering

Advanced query capabilities so agents can precisely target the issues they need.

- **`has`/`no` presence filters**: Filter by field presence (e.g., "issues with no estimate")
- **`exclude*` negation filters**: Exclude specific workflow states, estimates, priorities
- **Date-math filters**: `updatedSince`/`updatedBefore` with relative date support ("24h", "7d")
- **Close reason filter**: Distinguish `completed` from `not_planned` closures
- **Draft issue filtering**: `is:draft` / `-is:draft` support via `itemType` filter
- **Filter profiles**: Named presets per agent role (analyst, builder, validator, integrator) — `profile` param on list tools
- **Port to `list_project_items`**: All filters available on both `list_issues` and `list_project_items`

**Issues**: #94, #105–109, #141–143, #147–149

## 5. Expanded MCP Tool Surface

16 new MCP tools added to the server this week.

| Tool | Category | Description |
|------|----------|-------------|
| `advance_parent` | Relationships | Upward epic state propagation |
| `batch_update` | Bulk ops | Update multiple fields across issues |
| `bulk_archive` | Project mgmt | Batch archival with filtering |
| `copy_project` | Project mgmt | Duplicate project from template |
| `list_projects` | Project mgmt | List all projects for an owner |
| `list_project_repos` | Project mgmt | Query linked repositories |
| `link_team` | Project mgmt | Associate GitHub team with project |
| `create_draft_issue` | Issues | Create draft items on project boards |
| `update_draft_issue` | Issues | Modify draft item fields |
| `create_status_update` | Reporting | Post project status updates |
| `update_status_update` | Reporting | Edit existing status updates |
| `delete_status_update` | Reporting | Remove status updates |
| `reorder_item` | Project mgmt | Change item position in views |
| `update_project` | Project mgmt | Modify project settings |
| `delete_field` | Project mgmt | Remove custom fields (with safety guardrails) |
| `update_collaborators` | Project mgmt | Manage project collaborators |

Additional enhancements to existing tools:
- `setup_project` now supports `copyProjectV2` template mode
- `pipeline_dashboard` now aggregates across multiple projects
- `project_hygiene` reporting with archive eligibility stats
- `configure_routing` with CRUD, validation, and dry-run
- `sync_across_projects` for cross-project state propagation

## 6. View Template Recipes & Golden Project

Turnkey project setup with pre-configured views.

- **Golden project template**: Project #4 with 7 pre-configured views (Workflow Board, Sprint Board, Priority Table, Triage Queue, Blocked Items, Done Archive, Roadmap)
- **`setup_project` copy-from-template**: One command to clone the golden project for new repos
- **View recipe documentation**: Step-by-step configuration guides for each view type with purpose, config steps, and usage guidance

**Issues**: #95, #110, #111, #112, #160, #161, #270–273

## 7. CLI & Developer Experience

New `justfile`-based CLI for quick Ralph operations without entering a Claude session.

- **`just ralph-*` recipes**: LLM-powered commands via `mcptools` for issue creation, status checks, comments
- **`just doctor`**: Setup diagnostics — validates env vars, MCP server connectivity, project access
- **Shell tab completion**: Bash/Zsh completions for all `just` recipes
- **Quick actions**: `quick-issue`, `quick-info`, `quick-comment` for rapid issue management
- **`ralph-setup` breadcrumbs**: Integrated routing and sync setup steps into the setup wizard

**Issues**: #67, #72, #73, #251, #255, #259, #260, #262, #266, #267

## 8. Pipeline & Reporting

Visibility into pipeline health and velocity.

- **Pipeline dashboard**: Real-time status across all workflow phases with stuck issue detection, WIP violations, and lock collision alerts
- **Health indicators**: Critical/warning/info severity levels for pipeline anomalies
- **`ralph-status` skill**: Read-only dashboard display
- **`ralph-hygiene` skill**: Archive candidates, stale items, board health assessment
- **`ralph-report` skill**: Auto-generated status reports with velocity metrics and ON_TRACK/AT_RISK/OFF_TRACK health determination
- **Velocity metrics**: Throughput tracking and auto-status determination
- **Transition comments**: Structured format spec with builders and parsers for machine-readable state change records

**Issues**: #115, #116, #119, #140, #158, #237, #238, #246, #247, #248

## 9. Bug Fixes & Reliability

- **Tree-aware SPLIT assessment**: Skip SPLIT phase for issues that already have sub-issues (#246, #248)
- **Recursive sub-issue depth**: `list_sub_issues` supports tree traversal (#247)
- **FieldOptionCache preservation**: Cache survives `setup_project` calls (#242)
- **Numeric param coercion**: `z.coerce.number()` on all tool params (#229)
- **Specific file staging**: `ralph-impl` uses named files instead of `git add -A` (#236)
- **Release race condition**: Prevent concurrent merge conflicts in CI (#131)
- **SDK self-notification fix**: Agents no longer waste turns on their own idle notifications (#52)
- **Branch isolation**: Enforce correct branch for impl workflows (#39)

## 10. CI/CD & Infrastructure

- **Unified release automation**: Single workflow handles version bump, tag, npm publish, GitHub Release for all plugin content changes
- **Multi-node CI**: Build + test across Node 18, 20, 22
- **Auto-release on merge**: No manual `npm publish` or tag pushing needed
- **`allowed_tools` frontmatter**: Skills declare their tool surface for enforcement

---

## By the Numbers

| Metric | Value |
|--------|-------|
| Releases shipped | 42 (v2.4.5 → v2.4.47) |
| Commits to main | 387 |
| PRs merged | 30+ |
| New MCP tools | 16 |
| Epics completed | 7 (#40, #58, #93, #94, #95, #96, #99) |
| Issues closed | 129 (Done) |
| Issues canceled | 13 |
| Peak daily commits | 107 (Feb 20) |

---

*Generated 2026-02-21 by Ralph Hero pipeline dashboard + git log analysis.*
