---
date: 2026-05-17
topic: "Deploying the ralph-hero director → team → operator topology on the Claude API (Anthropic SDK / Managed Agents), as an alternative to running inside Claude Code"
tags: [research, claude-api, managed-agents, anthropic-sdk, architecture, multi-agent, deployment, mcp, ralph-hero]
status: complete
type: research
git_commit: TBD
git_branch: main
related_issues: []
---

# Research: deploying director → team → operator on the Claude API

## TL;DR

The cleanest fit is a **hybrid** of two Claude API surfaces, not a single one:

1. **Director** runs as a long-lived **client process** using the bare Claude API (`POST /v1/messages` with tool use). It does not need a container — its job is event classification (`next_actions`, label/state lookups, dispatch decisions), which is cheap, cache-friendly, and benefits from holding the GitHub state surface as its own MCP tools.
2. **Operators** (impl, plan, research, val, pr, merge, review, finish) run as **Managed Agents** — one persisted `Agent` config per operator. Each operator session gets a fresh per-session container, which is a native replacement for the worktree primitive that `impl-worktree-gate.sh` exists to enforce.
3. **Teams** collapse from "intermediate orchestrator" to **routing logic inside the director process** plus, where useful, **Managed Agents coordinators with subagent rosters**. The current implementation already has teams calling operators via inline `Skill()` and direct `Agent()` — there is no team-as-isolated-process to preserve. The team SOUL becomes the coordinator's `system` prompt.

The hard constraint that drives this shape is in `shared/managed-agents-multiagent.md`: **a Managed Agents coordinator may delegate to subagents one level only — depth > 1 is ignored**. You cannot model director → team → operator as a single 3-level multiagent session. You can model it as either (a) two sessions (director session orchestrates team sessions over HTTP) or (b) a flattened director-as-coordinator with operators in its roster, which matches today's actual call graph.

## How today's topology maps to API surfaces

### Layer 1 — Director (`skills/director/SKILL.md`)

| Today | API equivalent |
|---|---|
| Inline skill in Claude Code, runs in user's context | Headless Python/TS process (`anthropic.Anthropic().messages.create`) |
| Tools: `Skill`, `Read`, `Bash`, `ScheduleWakeup`, 4 ralph-github MCP tools | Custom tools (user-defined) wrapping `next_actions`, `get_issue`, `save_issue`, `list_issues` — call the same MCP server over its stdio/HTTP interface |
| `RemoteTrigger` inputs / `trigger:*` labels / workflow state | Inbound events: webhook receiver in the same process, or polling `next_actions` on a cron |
| `Skill("ralph-hero:<team>", args="NNN")` dispatch | A `dispatch(team, issue_number)` custom tool that calls `client.beta.sessions.create()` against the appropriate operator/coordinator Agent |
| `ScheduleWakeup` / `autopilot` `/loop` | Replaced by the event loop in the client process (or an external scheduler like cron / launchd / k8s CronJob) |

**Model**: Opus 4.7 with `output_config: {effort: "low"}` — director is short-context, routing-only; `low` effort matches the deterministic table lookup in `event-classes.md`. Adaptive thinking off by default; let the table speak.

**Prompt caching**: Director sees the same `event-classes.md` table on every iteration. Put it in `system` with `cache_control: {type: "ephemeral"}` — that single breakpoint will give >90% cache hit rate across the polling loop.

### Layer 2 — Teams (`hero`, `caretake`, `watch`, `memorykeepers`, `scouts`)

Teams today are **inline orchestrator skills**, not isolated processes. Hero literally runs `Skill()` for analyst phases (research/plan/review/split/triage — context-sharing is the *point*) and `Agent()` for builder/integrator phases (impl/pr/val/merge — isolation is the point).

Two viable ports, depending on team:

- **Caretake / Watch** — these mostly heartbeat-dispatch to single operators (`ralph-triage`, `ralph-hygiene`, `gcp-incident-triage`, etc.) and don't share much intra-team state. Easiest: **fold the team into the director's routing**. Director picks an event, picks the operator directly, creates a session, done. The team SOUL becomes part of the operator's `system` prompt for that operator config.
- **Hero (builders)** — this team really *is* an orchestrator: it runs SPLIT → RESEARCH → PLAN → REVIEW → IMPL → PR → FINISH with a `TaskList` + `blockedBy` graph and reuses state across phases. Best fit: a **Managed Agents coordinator agent** (`multiagent: {type: "coordinator", agents: [research_agent_id, plan_agent_id, ...]}`). The coordinator runs in a session; each phase becomes a subagent **thread** in the same session, with shared filesystem (the per-session container = the worktree). The 1-level delegation cap is fine here because the operators are leaves — they don't sub-delegate.

For watchers' kubectl `sre-fixit` operator: model it as a Managed Agent with the `mcp__plugin_ralph-hero_ralph-github__ralph_hero__sre__*` MCP tools mounted, OR keep the kubectl path client-side and surface it as a custom tool gated by `always_ask`.

### Layer 3 — Operators (the per-phase agents in `plugin/ralph-hero/agents/`)

This is where Managed Agents earns its keep. One `Agent` config per operator, persisted, versioned, reused across runs. Key mapping:

| Operator concern today | Managed Agents primitive |
|---|---|
| `model:` frontmatter (sonnet/opus/haiku per agent) | `agent.model` |
| `tools:` allowlist | `agent.tools` — restricted set + the MCP server tools |
| `skills:` preloaded skill | `agent.skills` — same Skill content, uploaded via Skills API once per version |
| Backtick env-var substitution at skill load | Replace with templated `system`/`skills` content at `agents.create()` / `agents.update()` time. No runtime substitution — bake at agent-version creation. |
| `RALPH_IMPL_MODEL` override | `client.beta.agents.update(impl_agent_id, model="opus")` bumps a version; pin sessions to specific versions for reproducibility |
| Mandatory worktree at `worktrees/GH-NNN/` (enforced by `impl-worktree-gate.sh` PreToolUse) | **Per-session container** is the native replacement. Each impl session = one container = one fresh git checkout. The gate goes away. |
| Hero parses `IMPL BLOCKED ...` verdict from final agent output | Read `session.events.list()` for the terminal message; same parsing logic, just over events instead of stdout |
| Code-review-agent dispatches impl-agent in "Address Mode" (depth-2 `Agent()`) | This is the case that bumps into the 1-level delegation cap. **Resolution**: don't make code-review a subagent — keep it as a sibling operator dispatched by the *client process* in a loop. The director (or a per-issue session manager) sees `review_needed` → starts code-review session → on `NEEDS_FIX` outcome, starts impl session in Address Mode → loops. |

### Shared state plane

All four state surfaces survive intact, but two of them need a deployment change:

| Surface | Today | API deployment |
|---|---|---|
| **GitHub Projects V2** via `ralph-github` MCP (stdio, npm) | Spawned by Claude Code per session | Run as a **long-lived HTTP MCP server** (the SDK wraps stdio MCP into HTTP, or stand up a small adapter). Reference from agent configs as `mcp_servers: [{type, name: "ralph-github", url: "https://..."}]`. Credentials (`RALPH_HERO_GITHUB_TOKEN`) go in a **Vault**, attached to sessions via `vault_ids`. |
| **Knowledge graph** via `ralph-knowledge` MCP (Hono HTTP) | Local Hono server | Already HTTP — just publish it on a reachable URL. Same vault pattern for any tokens. |
| **Worktrees** under `worktrees/GH-NNN/` | Filesystem on host, gated by hook | **Per-session container** — eliminates the hook, isolates by construction. Attach the repo as a **session resource** (Files API or git clone in a bootstrap tool) so each impl session starts from a clean checkout of `main`. |
| **thoughts/ corpus** | Filesystem at `~/projects/thoughts/` | Treat as a separate git repo or volume. Two options: (a) clone it into each session container that needs it (research/plan); (b) attach as a read-only file mount via session resources. Writes go through commits, indexed nightly by the dream loop (which stays host-side). |
| **TaskList** (in-Claude-Code) | `TaskCreate`/`TaskGet`/`TaskUpdate` | Disappears. The director's event loop *is* the task list. Persist intermediate hero state to GitHub Projects (already done for status; extend a custom field for `currentPhase` if needed) so re-entry after crash is deterministic. |
| **Activity log** (`~/.ralph-hero/activity/*.jsonl`) + cursor | Hooks write per tool call | Managed Agents' **session events** stream replaces this directly. Tail `client.beta.sessions.events.stream()` into the same JSONL format if you want to keep `recent_activity` MCP working. `catch-up` cursor logic ports unchanged. |
| **Snapshots** / `trends` | Daily launchd-triggered `capture_snapshot` | Stays as a host-side cron — it queries GitHub Projects, not Claude. |

### Hooks (the spicy part)

The plugin has ~50 hook scripts (`hooks/scripts/*.sh`) enforcing things like worktree confinement, autopilot opt-in gating, split-estimate gating, activity logging. They run as PreToolUse / PostToolUse / SessionStart / Stop in Claude Code. Managed Agents has no equivalent.

Recommended port strategy:

| Hook category | Port path |
|---|---|
| **Isolation gates** (worktree, autopilot-enable) | **Drop**. Container isolation + agent allowlists replace them. |
| **Context injection** (`load-team-soul.sh`, `inject-skill-context.sh`) | **Bake into agent config** at `agents.create()` time via `system` and `skills` fields. |
| **Side-effect verification** (`split-estimate-gate.sh` PostToolUse pattern) | Move into the **client process** by inspecting `agent.tool_use` events on the session stream and replying with a `user.tool_confirmation` or a tool result that signals refusal. Or implement as a server-side custom tool that wraps the underlying MCP call and self-validates. |
| **Activity recording** (`record-activity.sh` PostToolUse) | Consume `session.events.stream()` in the director process; write the same JSONL. |
| **Cursor advance** (`cursor-advance-catch-up.sh`) | Same — consume events. |

This is the largest porting cost and the most likely place to discover gaps. Plan to audit each hook against the new architecture before flipping over.

### MCP credentials

GitHub PAT today lives in `~/.claude/settings.json` env or is read from `gh auth token`. On Managed Agents:

```python
gh_credential = client.beta.vaults.credentials.create(
    vault_id=vault.id,
    name="ralph-github-token",
    type="bearer",
    value=os.environ["RALPH_HERO_GITHUB_TOKEN"],
)
# Then:
session = client.beta.sessions.create(
    agent=impl_agent_id,
    environment_id=env.id,
    vault_ids=[vault.id],
)
```

No env vars in containers (`shared/managed-agents-overview.md` Pitfalls + `client-patterns.md` Pattern 9). Anything that's not an MCP auth secret (e.g., a Slack webhook URL the agent shouldn't see) stays host-side and gets surfaced as a custom tool result from the director.

## Model + effort matrix (preserved from current policy)

| Operator | Today | API |
|---|---|---|
| research | sonnet | `claude-sonnet-4-6`, `effort: "high"`, adaptive thinking |
| plan / plan-epic | opus | `claude-opus-4-7`, `effort: "xhigh"`, adaptive thinking (the 4.7 sweet spot for agentic work) |
| review | opus | `claude-opus-4-7`, `effort: "high"`, adaptive thinking |
| impl | sonnet (opus on BLOCKED) | `claude-sonnet-4-6`, `effort: "high"`. On `IMPL BLOCKED` verdict, director re-creates a session pinned to an opus-tier `impl-agent-opus` version (or `agents.update()` and pin). |
| split / triage | sonnet | `claude-sonnet-4-6`, `effort: "medium"` |
| val | sonnet | `claude-sonnet-4-6`, `effort: "high"` — judgment-heavy |
| pr / merge | haiku | `claude-haiku-4-5`, `effort: "low"` |
| director | n/a (host) | `claude-opus-4-7`, `effort: "low"` — table lookup |

Use **Task Budgets** (`output_config: {task_budget: {type: "tokens", total: N}}`, beta header `task-budgets-2026-03-13`) on impl sessions — currently the hero blocks at a 15-minute wall time, which is a proxy for "this is taking too long." A token budget is a better signal and is self-moderating.

## Suggested migration sequence

1. **Stand up an HTTP wrapper for ralph-github MCP** and a Vault with the GitHub PAT. Validate by calling `next_actions` and `get_issue` from a one-off `messages.create` with `mcp_servers` populated. This is the foundational dependency and isolates risk.
2. **Port one read-only operator first**: `triage-agent` is ideal — no worktree, no MCP writes beyond labels, well-bounded. Create the `Agent` config, run it against a synthetic issue, compare verdict to the Claude Code run.
3. **Port `research-agent`** next — exercises ralph-knowledge MCP and thoughts/ writes. Settles the "where does thoughts/ live" question.
4. **Port `impl-agent`** — exercises per-session container as worktree replacement. This is the largest single port; expect to learn that several worktree hooks need to be reimplemented as custom tools or dropped entirely.
5. **Build the director loop** — at this point you have enough operators on the API to write a thin Python event loop that picks an issue and routes it. Run it side-by-side with Claude Code's `autopilot` for a few days.
6. **Port `hero` coordinator** — last, because it's the most complex and benefits from all the above being battle-tested. Implement as a Managed Agents coordinator with operators in its roster, leaving caretake/watch flat.

## Open questions and known gaps

- **Stdio MCP → HTTP MCP** wrapping: `ralph-hero-mcp-server` is published for stdio (`npx`). Need to decide between (a) running it behind a small HTTP shim, (b) refactoring the server to natively support HTTP transport, or (c) using a community stdio-to-HTTP bridge. Option (b) is cleanest long-term but most work.
- **TaskList → persistence**: hero's `TaskCreate` + `blockedBy` upfront task graph has no direct API equivalent. Either persist phase state to GitHub Projects (custom field), or run hero's task graph in-memory in the coordinator's container and accept that a crash mid-loop loses scheduling state (the operators themselves are idempotent so this may be acceptable).
- **`AskUserQuestion` ↔ `always_ask`**: review-agent and merge-agent both use `AskUserQuestion`. Managed Agents has `always_ask` confirmations cross-posted to the primary thread (`shared/managed-agents-multiagent.md`). One-to-one port, but you need to design the UI that consumes these (Slack? web app? `gh` CLI prompts?).
- **`SendMessage` between long-running peer agents** (deprecated `team.md` skill, but the pattern recurs in code-review's address-mode loop): handled by the client process holding multiple sessions; not a direct API primitive.
- **iOS sentinel** (`/tmp/ralph-ios-mode`): becomes a request-property on the director's inbound webhook payload.
- **Hooks audit**: ~50 scripts to triage. Not all need ports; many become unnecessary under container isolation. Worth a dedicated follow-on research doc.
- **OTel export to Langfuse**: already wired in Claude Code via `OTEL_*` env vars. Managed Agents sessions emit events but not OTel-shaped traces; if the local Langfuse harness is important, write a small bridge in the director process that translates session events to OTLP/HTTP spans (the dimensions you care about — `mcp.tool.*`, agent dispatches — are all in the event stream).

## Cost shape

Director: cheap (Opus 4.7 low-effort, heavy cache hit rate, only on event). Watchers: cheap. Builders sessions: the bulk of spend. The session-container surcharge for Managed Agents is the main delta vs running today; offset by removing the user's Claude Code subscription as the orchestration layer. For a sanity number, multiply current hero invocations per day by per-operator avg token spend (visible in `delegation_stats` if telemetry is on) and compare against Managed Agents per-session pricing in `shared/live-sources.md`. Until you do that exercise, treat cost as the largest unknown.

## Bottom line

You don't need a 3-level multiagent topology to deploy this. The current Claude Code implementation already flattens "team" into inline dispatch; the API deployment continues that flattening. **Director (bare API, host process) → Operators (Managed Agents, one per per-phase role) — with Hero as a coordinator-with-roster for the one team that genuinely orchestrates state across phases.** The big design wins are: per-session containers replace the worktree gate entirely; vaults replace settings.local.json; session events replace the activity log; persisted/versioned Agent configs make the model-tier override pattern (`RALPH_IMPL_MODEL=opus`) cleaner. The big risks are: stdio MCP → HTTP wrapping, the ~50-hook audit, and the cost of running everything outside a Claude Code Pro subscription.
