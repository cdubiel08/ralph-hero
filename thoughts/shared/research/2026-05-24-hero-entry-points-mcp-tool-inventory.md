---
date: 2026-05-24
researcher: Chad Dubiel
git_commit: 3d7d8badce0e27bc84316c304bb4e35df9119506
branch: main
repository: ralph-hero
topic: "Inventory of MCP tools declared by every hero entry point"
tags: [research, mcp-tools, agents, orchestration, allowlist, gh-646]
status: complete
last_updated: 2026-05-24
last_updated_by: Chad Dubiel
type: research
---

# Hero Entry Point ↔ MCP Tool Inventory

## Research Question

For every "hero entry point" in `ralph-hero` (orchestrator skills, per-phase agents, and the slim `/ralph` plugin verbs), enumerate the MCP tools declared in frontmatter — so we can see at a glance which surface area each entry point is authorized to call.

## Summary

Three tiers of entry points span the system:

1. **Orchestrator skills** (`plugin/ralph-hero/skills/<name>/SKILL.md`) — 13 user-facing skills whose `allowed-tools:` field is **pre-approval** (tools run without prompts but unlisted tools still work — see [wiki/skill-allowed-tools-is-pre-approval](../../wiki/skill-allowed-tools-is-pre-approval.md)).
2. **Per-phase agents** (`plugin/ralph-hero/agents/<name>.md`) — 13 core operators + 4 orchestrator agents + 8 read-only support agents whose `tools:` field is **hard runtime enforcement** at the MCP layer (see [wiki/agent-tools-allowlist-is-runtime-enforced](../../wiki/agent-tools-allowlist-is-runtime-enforced.md)).
3. **Slim `/ralph` plugin verbs** (`ralph/skills/<name>/SKILL.md`) — 9 consolidated entry skills; each verb's `allowed-tools:` covers the superset of its `--mode` branches.

Each section below tabulates the MCP tools declared per entry point. Built-in tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `Agent`, `Skill`, `Task*`, `AskUserQuestion`, `WebSearch`, `WebFetch`, `Monitor`, `ScheduleWakeup`, `PushNotification`, `SendMessage`, `TeamCreate`/`TeamDelete`) are listed separately from MCP tools to keep the MCP columns scannable.

## Prior Work

- **[wiki/skill-allowed-tools-is-pre-approval](../../wiki/skill-allowed-tools-is-pre-approval.md)** — Establishes that skill `allowed-tools:` is pre-approval semantics (tools listed run without prompts; unlisted tools still execute but with prompts).
- **[wiki/agent-tools-allowlist-is-runtime-enforced](../../wiki/agent-tools-allowlist-is-runtime-enforced.md)** — Establishes that agent `tools:` is hard runtime enforcement (unlisted tools are blocked at MCP layer).
- **[2026-05-16-unified-agent-system-architecture.md](2026-05-16-unified-agent-system-architecture.md)** — Director → Teams → Operators architecture; lists tool surface per team archetype but not exhaustive per-entry-point.
- **[2026-03-20-skill-dispatch-inventory.md](2026-03-20-skill-dispatch-inventory.md)** — Companion inventory from [GH-646](https://github.com/cdubiel08/ralph-hero/issues/646) (closed 2026-03-21) that classifies skills by *dispatch mode* (interactive vs autonomous vs lightweight). This doc is the orthogonal axis: same entry points, classified by *MCP tool surface*.
- **[GH-1267 — Unified Agent System Epic](https://github.com/cdubiel08/ralph-hero/issues/1267)** — Wired per-phase agents into Director → Teams → Operators pipeline. Defines the agent surface this doc inventories.
- **[GH-1250 — Hero Workflow Model-Tier Optimization](https://github.com/cdubiel08/ralph-hero/issues/1250)** — Per-phase model tier policy that drives which agents get which complexity-appropriate tool surface.
- **[GH-1285 — Typed MCP kubectl tools for sre-fixit](https://github.com/cdubiel08/ralph-hero/issues/1285)** — Replaced Bash-allowlist gate with 4 typed MCP tools; reflected in `sre-fixit` having the narrowest surface.
- **[CLAUDE.md § Per-Phase Agents](../../../CLAUDE.md)** — Model tier table per agent with preloaded skill references.
- **[plugin/ralph-hero/docs/model-tier-policy.md](../../../plugin/ralph-hero/docs/model-tier-policy.md)** — Complexity-driven model tier rules + `RALPH_<AGENT>_MODEL` override pattern.

## Files Affected

Inventory only. No code changes required. Files read:

- `plugin/ralph-hero/agents/*.md` — 22 agent files (13 core operators + 4 orchestrator agents + 5 read-only support agents; excludes 3 `*-eval.md` stubs)
- `plugin/ralph-hero/skills/{hero,autopilot,director,team,watch,caretake,scouts,hello,catch-up,status,report,cos,finish}/SKILL.md` — 13 orchestrator skills
- `ralph/skills/{hero,research,plan,impl,review,caretake,catch-up,form,setup}/SKILL.md` — 9 slim plugin verbs

## Detailed Findings

### Tier 1 — Orchestrator Skills (`plugin/ralph-hero/skills/`)

`allowed-tools:` is **pre-approval** (unlisted tools work but trigger permission prompts).

| Skill | Built-ins | ralph-github MCP tools | ralph-knowledge MCP tools |
|---|---|---|---|
| `hero` | Read, Write, Edit, Glob, Grep, Bash, Agent, Skill, Task, AskUserQuestion, PushNotification | get_issue, list_issues, save_issue, create_issue, create_comment, add_sub_issue, list_sub_issues, add_dependency, remove_dependency, decompose_feature, detect_stream_positions, next_actions, pipeline_dashboard | knowledge_search, knowledge_traverse |
| `autopilot` | Skill, ScheduleWakeup | list_issues | — |
| `director` | Skill, Read, Bash, ScheduleWakeup | next_actions, get_issue, save_issue, list_issues | — |
| `team` *(deprecated)* | Read, Write, Glob, Bash, Task, Skill, TeamCreate, TeamDelete, TaskCreate, TaskList, TaskGet, TaskUpdate, SendMessage | get_issue, pipeline_dashboard, detect_stream_positions, next_actions, create_issue | — |
| `watch` | Skill, Agent, Bash, Read | get_issue, list_issues, save_issue, create_comment | — |
| `caretake` | Read, Bash, Skill, PushNotification | get_issue, save_issue, create_comment, list_issues, pipeline_dashboard | knowledge_record_outcome |
| `scouts` | Skill, Agent, Bash, Read, Glob | get_issue, list_issues, save_issue | — |
| `hello` | Read, Skill, Agent, AskUserQuestion | next_actions | — |
| `catch-up` | Read | recent_activity | — |
| `status` | — | pipeline_dashboard | — |
| `report` | — | pipeline_dashboard, create_status_update, metrics_trends | — |
| `cos` | Read, Bash | pipeline_dashboard, next_actions, recent_activity, list_issues, get_issue | — |
| `finish` | Read, Glob, Grep, Bash, Skill, Agent, Monitor, AskUserQuestion | get_issue, list_sub_issues, list_dependencies, advance_issue, save_issue, create_comment | — |

### Tier 2 — Per-Phase Agents (`plugin/ralph-hero/agents/`)

`tools:` is **hard runtime enforcement** — unlisted tools are blocked at the MCP layer.

#### Core operators

| Agent | Model | Built-ins | ralph-github MCP tools | ralph-knowledge MCP tools |
|---|---|---|---|---|
| `research-agent` | sonnet | Read, Write, Glob, Grep, Bash, Agent, WebSearch, WebFetch | get_issue, list_issues, save_issue, create_comment, add_dependency, remove_dependency | knowledge_search, knowledge_traverse, knowledge_query_outcomes, knowledge_record_outcome, knowledge_expert |
| `plan-agent` | opus | Read, Write, Glob, Grep, Bash, Agent | get_issue, list_issues, save_issue, create_comment | — |
| `plan-epic-agent` | opus | Read, Write, Glob, Grep, Bash, Agent | get_issue, list_issues, save_issue, create_issue, create_comment, add_sub_issue, add_dependency, remove_dependency, list_sub_issues, decompose_feature | — |
| `split-agent` | sonnet | Read, Glob, Grep, Bash, Agent | get_issue, list_issues, save_issue, create_issue, add_sub_issue, add_dependency, remove_dependency, list_sub_issues, create_comment | — |
| `triage-agent` | sonnet | Read, Glob, Grep, Bash, Task, Agent, WebSearch | get_issue, list_issues, save_issue, create_comment, create_issue, add_sub_issue, list_sub_issues, add_dependency | — |
| `review-agent` | opus | Read, Write, Glob, Grep, Bash, Agent, AskUserQuestion | get_issue, list_issues, save_issue, create_comment | — |
| `impl-agent` | sonnet *(opus on BLOCKED)* | Read, Write, Edit, Glob, Grep, Bash, Agent | get_issue, list_issues, save_issue, create_comment, list_sub_issues | — |
| `pr-agent` | haiku | Read, Glob, Grep, Bash | get_issue, list_issues, save_issue, create_comment, advance_issue | — |
| `merge-agent` | haiku | Read, Glob, Grep, Bash, AskUserQuestion | get_issue, list_issues, save_issue, create_comment, advance_issue, list_sub_issues, list_dependencies | — |
| `val-agent` | sonnet | Read, Glob, Grep, Bash | get_issue, list_issues, save_issue, create_comment, list_sub_issues | — |
| `unblock-agent` | sonnet | Read, Glob, Grep, Bash | get_issue, list_issues, create_comment | knowledge_record_outcome |
| `scouts-agent` | sonnet | Skill, Agent, Bash, Read, Glob | get_issue, list_issues, save_issue | — |
| `sre-fixit` | sonnet | *(none — no Bash by design)* | sre__scale, sre__rollout_restart, sre__delete_pod, sre__drain, get_issue, create_comment, save_issue | — |

#### Orchestrator-style agents

| Agent | Model | Built-ins | ralph-github MCP tools | ralph-knowledge MCP tools |
|---|---|---|---|---|
| `code-review-agent` | sonnet | Read, Glob, Grep, Bash, Agent, Skill | get_issue, list_issues, save_issue, create_comment | — |
| `finish-agent` | sonnet | Read, Glob, Grep, Bash, Skill, Monitor, AskUserQuestion | get_issue, list_sub_issues, list_dependencies, advance_issue, save_issue, create_comment | — |
| `catch-up-agent` | haiku | Read | recent_activity | — |
| `cos-agent` | sonnet | Read, Bash, WebFetch | pipeline_dashboard, next_actions, recent_activity, list_issues, get_issue | knowledge_recall, knowledge_search |

#### Read-only support agents (research sub-agents)

| Agent | Model | Built-ins | MCP tools |
|---|---|---|---|
| `codebase-locator` | haiku | Grep, Glob, Bash | — |
| `codebase-analyzer` | sonnet | Read, Grep, Glob, Bash | — |
| `codebase-pattern-finder` | haiku | Grep, Glob, Read, Bash | — |
| `thoughts-locator` | haiku | Grep, Glob, Bash | knowledge_search, knowledge_traverse, knowledge_communities, knowledge_central, knowledge_bridges |
| `thoughts-analyzer` | sonnet | Read, Grep, Glob, Bash | knowledge_search, knowledge_traverse, knowledge_paths, knowledge_common, knowledge_query_outcomes |
| `web-search-researcher` | sonnet | WebSearch, WebFetch, Read, Grep, Glob, Bash | — |
| `log-reader` | haiku | Read, Grep, Glob, Bash, WebFetch | — |
| `github-lister` | sonnet | Read, Glob, Grep, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, WebSearch, WebFetch | `mcp__github__*` and `mcp__plugin_github_github__*` search/list family (search_repositories, search_code, search_issues, search_users, list_issues, list_pull_requests, get_file_contents) |
| `github-analyzer` | sonnet | Read, Write, Glob, Grep, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, WebSearch, WebFetch | `mcp__github__*` get_file_contents, search_repositories, search_code; `mcp__plugin_github_github__*` get_file_contents, search_code |

Excluded: `pr-agent-eval.md`, `val-agent-eval.md`, `codebase-locator-eval.md` (empty frontmatter — eval scaffolds).

### Tier 3 — Slim `/ralph` Plugin (`ralph/skills/`)

Each verb consolidates multiple ralph-hero skills behind `--mode` branches, so allowlists are necessarily broader.

| Verb | Built-ins | ralph-github MCP tools | ralph-knowledge MCP tools |
|---|---|---|---|
| `hero` | Read, Write, Edit, Glob, Grep, Bash, Agent, Skill, Task, TaskCreate, TaskUpdate, TaskList, TaskGet, AskUserQuestion, PushNotification, ScheduleWakeup | get_issue, list_issues, save_issue, advance_issue, create_issue, create_comment, add_sub_issue, list_sub_issues, add_dependency, remove_dependency, decompose_feature, detect_stream_positions, next_actions, pipeline_dashboard | knowledge_search, knowledge_traverse, knowledge_record_outcome |
| `research` | Read, Write, Edit, Glob, Grep, Bash, Task, Agent, AskUserQuestion, WebSearch, WebFetch | get_issue, list_issues, save_issue, create_comment, add_dependency, remove_dependency | **all 9 knowledge tools** — search, recall, traverse, query_outcomes, record_outcome, expert, paths, common, communities, central, bridges |
| `plan` | Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion, WebSearch, WebFetch | get_issue, list_issues, save_issue, create_issue, create_comment, add_sub_issue, add_dependency, remove_dependency, list_dependencies, list_sub_issues, decompose_feature | knowledge_recall, knowledge_search, knowledge_record_outcome |
| `impl` | Read, Write, Edit, Glob, Grep, Bash, Agent, Task, WebSearch, WebFetch, AskUserQuestion | get_issue, list_issues, list_sub_issues, save_issue, create_comment | knowledge_recall, knowledge_search, knowledge_record_outcome |
| `review` | Read, Glob, Grep, Bash, Skill, Agent, Monitor, AskUserQuestion | get_issue, list_issues, list_sub_issues, list_dependencies, save_issue, advance_issue, create_comment | knowledge_record_outcome |
| `caretake` | Read, Write, Edit, Glob, Grep, Bash, Skill, Agent, Task, TaskList, TaskGet, AskUserQuestion, PushNotification | get_issue, list_issues, save_issue, create_issue, create_comment, add_sub_issue, add_dependency, list_sub_issues, pipeline_dashboard, project_hygiene, archive_items, capture_snapshot, metrics_trends | knowledge_record_outcome, knowledge_search, knowledge_recall |
| `catch-up` | Read, Skill, Agent, AskUserQuestion | recent_activity, next_actions, pipeline_dashboard, create_status_update, metrics_trends | — |
| `form` | Read, Write, Edit, Glob, Grep, Bash, Agent, AskUserQuestion, WebSearch, WebFetch | list_issues, get_issue, create_issue, save_issue, add_sub_issue, add_dependency, create_comment | — |
| `setup` | Read, Write, Edit, Bash, AskUserQuestion | health_check, get_project, setup_project, pipeline_dashboard, list_issues, decompose_feature, create_issue | — |

## Cross-Cutting Observations

### Narrowest vs. broadest surfaces

- **Narrowest agent:** `sre-fixit` — 4 typed kubectl MCP tools + 3 GitHub tools, **zero Bash**. Per [GH-1285](https://github.com/cdubiel08/ralph-hero/issues/1285), the typed-tool gate replaced a regex Bash allowlist with `execFile(shell: false)`.
- **Narrowest skill:** `status` — one MCP tool, no built-ins beyond the dashboard call.
- **Broadest skill:** slim `/ralph:research` — all 9 ralph-knowledge tools, the largest knowledge-graph footprint of any entry point.
- **Broadest agent:** `plan-epic-agent` — 10 ralph-github tools including `create_issue`, `add_sub_issue`, `decompose_feature` (multi-tier decomposition needs the lot).

### Tool-surface patterns

- **Knowledge-graph access is gated:** only `research-agent` and slim `/ralph:research` declare `knowledge_expert`. Only `research-agent`, `unblock-agent`, slim `/ralph:research`, `plan`, `impl`, `review`, and `caretake` skills declare `knowledge_record_outcome`. The Director → Teams pipeline records outcomes via the `outcome-collector.sh` PostToolUse hook for everything else (see CLAUDE.md § Self-healing closure).
- **`advance_issue` boundary:** only `pr-agent`, `merge-agent`, `finish-agent`, slim `/ralph:hero`, and slim `/ralph:review` can call it. State-machine pull is gated to integration-phase agents.
- **`list_dependencies` boundary:** only `merge-agent` and `finish-agent` (plus slim `/ralph:plan` and `/ralph:review`) — late-pipeline readiness checks.
- **Mutation-free read surfaces:** `status`, `report`, `cos-agent`, `catch-up-agent`, `catch-up` skill, slim `/ralph:catch-up` — no `save_issue` or `create_*`. These are observability/orientation tools.
- **`pr-agent` is unusually narrow for an integrator:** haiku model, no `Skill`/`Agent`, no Write/Edit, no knowledge tools. Single-purpose: push branch, create PR, advance state.

### Slim plugin vs. ralph-hero deltas

- Slim `/ralph:hero` adds `Task*`, `advance_issue`, and `knowledge_record_outcome` over `plugin/ralph-hero/skills/hero` — the slim verb absorbs the autopilot/classify/watch/pr-drain modes that were separate skills in ralph-hero.
- Slim `/ralph:caretake` exposes the full caretaker surface (`project_hygiene`, `archive_items`, `capture_snapshot`, `metrics_trends`) directly — the ralph-hero `caretake` orchestrator dispatches sub-skills that hold those tools individually.
- Slim `/ralph:research` is the only entry point exposing the **full knowledge-graph surface** (9 tools); even `research-agent` is narrower (5 knowledge tools).

### Authorization model recap

- Skills (`allowed-tools:`) — pre-approval. Tools listed run silently; unlisted tools work but prompt. Skills compose; the host inherits its caller's permissions.
- Agents (`tools:`) — hard runtime allowlist. Unlisted tools are **blocked**. Sub-agent invocation creates a fresh permission boundary; the parent agent's allowlist does not flow through.
- Hooks layered on top — per CLAUDE.md § Hook Patterns, e.g. `split-estimate-gate.sh` blocks `split-agent` if `get_issue` returns XS/S; `branch-gate.sh` restricts autonomous-mode agents to `main`. Frontmatter `tools:` is the floor; hooks are the additional ceiling.

## Open Questions / Follow-ups

- **Pairs with GH-646's dispatch inventory:** The 2026-03-20 dispatch inventory + this MCP-tool inventory together form the full 2D classification of every entry point (dispatch mode × tool surface). Worth linking from CLAUDE.md or the README so both axes are discoverable.
- **Ralph-playwright agents not inventoried here:** `explorer-agent` and `story-runner-agent` live in `plugin/ralph-playwright/agents/` and use Playwright CLI rather than ralph-github MCP. Out of scope for "hero entry points" but worth a sibling doc.
- **Periodic drift audit:** Frontmatter tool lists drift as we add MCP tools (snapshot, trends, sre__* family all landed post-GH-646). Worth a quarterly script that diffs declared tools vs. `ralph_hero__*` tool registrations in `mcp-server/src/tools/`.
