---
date: 2026-05-17
status: exploratory
type: plan
do_not_automate: true
tags: [exploration, claude-api, anthropic-sdk, managed-agents, deployment, ralph-hero, cost-modeling]
# Intentionally NO github_issue / github_issues / github_urls / primary_issue / parent_plan fields.
# This document exists for the author's understanding only and must not be picked up by
# ralph-hero workflow automation (which keys off github_issue references in frontmatter).
---

# Exploratory plan: deploy director → team → operator on the Claude API

> **Status: exploratory, not for automation.** This is a thinking-out-loud plan. It deliberately has no GitHub issue link, no `depends_on::` edges, and no phase-issue mapping. Do not feed it to `ralph-plan`, `ralph-impl`, or any orchestrator. When ready to commit, distill into a `/ralph-hero:form` ticket and create an actual plan.

## Prior Work

- builds_on:: [[2026-05-17-director-team-operator-on-claude-api]] (research — full topology mapping and the depth-1 multiagent constraint)

## Why this plan exists

The research doc (above) sketched a hybrid architecture: director on bare API, operators as Managed Agents, hero as a coordinator-with-roster. That's a reasonable end-state — but it is **not where to start**. This plan reframes the rollout around Anthropic's own guidance, picks the smallest first step that produces an end-to-end signal, and only adopts each new piece of cloud infrastructure when there is a concrete reason it's needed.

## Anthropic's guidance, distilled

From `shared/agent-design.md` and `https://platform.claude.com/docs/en/managed-agents/overview` (fetched 2026-05-17):

1. **"Start simple. Default to the simplest tier that meets your needs. Single API calls and workflows handle most use cases — only reach for agents when the task genuinely requires open-ended, model-driven exploration."** (`SKILL.md` of the `claude-api` skill, *Which Surface Should I Use?* section.)
2. **The two surfaces have crisp positioning** (Managed Agents overview page):
   - **Messages API** — "Custom agent loops and fine-grained control"
   - **Managed Agents** — "Long-running tasks and asynchronous work"
3. **"Start with bash for breadth. Promote to dedicated tools when you need to gate, render, audit, or parallelize."** (`agent-design.md` §Designing Your Tool Surface)
4. **"Should I build an agent?"** four-test heuristic: complexity, value, viability, cost-of-error. If "no" on any → stay at simpler tier (single call or workflow).
5. **Multiagent (coordinator-with-roster) and Outcomes are research preview**, gated behind an access request form. They are **not GA** as of the doc snapshot, which means the coordinator pattern from the research doc is not freely available today.

The honest read: today's ralph-hero is a **workflow** (multi-step, code-orchestrated, with bounded operators), not an open-ended agent. Anthropic's guidance steers a workflow toward **Messages API + tool use**, not Managed Agents. Managed Agents pays for itself when you specifically want Anthropic to host the container and run the loop — primarily for impl-agent's worktree isolation. Everywhere else, the Messages API is simpler and cheaper.

## Shared Constraints (for the eventual port)

These apply across all phases below. They are constraints on the *target architecture*, not on Phase 1.

1. **State plane is unchanged.** GitHub Projects V2 via `ralph-hero-mcp-server` remains the workflow state machine. Ralph-knowledge remains the long-term memory. Worktrees remain the isolation primitive for impl on the host.
2. **The current ralph-hero plugin keeps running.** This is an *additional* surface — Claude Code keeps doing what it does. No flag day.
3. **One operator at a time.** No "port everything in one weekend." Each operator port is its own commit, its own validation pass against a known issue, its own go/no-go.
4. **Models stay on the existing tier policy.** Sonnet for research/impl/triage/val, Opus 4.7 for plan/review, Haiku for pr/merge. See `plugin/ralph-hero/docs/model-tier-policy.md`.
5. **Costs are tracked from day 1.** Each operator port writes its token spend to a local JSONL log so we can compare to today's `delegation_stats` and to the eventual Managed Agents bill.
6. **No automation hooks** between this plan and ralph-hero's pipeline until the user explicitly decides to wire one up. The phases below are dispatchable by hand only.

## Cost model

### Token pricing (live, fetched 2026-05-17 from `platform.claude.com/docs/en/about-claude/models/overview`)

| Model | $/MTok input | $/MTok output | Cached input (75% off) |
|---|---|---|---|
| Claude Opus 4.7 | $5 | $25 | ~$1.25 |
| Claude Sonnet 4.6 | $3 | $15 | ~$0.75 |
| Claude Haiku 4.5 | $1 | $5 | ~$0.25 |

> Note: the cached pricing table in the `claude-api` skill is stale and shows $15/$75 for Opus 4.7. The numbers above are from the live docs page and supersede the cache.

### Per-operator cost estimate (one issue, no cache)

These are rough — derived from observed Claude Code run shapes, not measured on the API path. Treat as "order of magnitude" until you run actual numbers from `delegation_stats`.

| Operator | Model | ~Input tokens | ~Output tokens | $/run |
|---|---|---|---|---|
| research | Sonnet | 20K | 5K | ~$0.14 |
| plan | Opus 4.7 | 30K | 8K | ~$0.35 |
| review | Opus 4.7 | 20K | 3K | ~$0.18 |
| impl | Sonnet | 50K | 15K | ~$0.38 |
| impl (Opus retry on BLOCKED) | Opus 4.7 | 50K | 15K | ~$0.63 |
| val | Sonnet | 25K | 4K | ~$0.14 |
| pr | Haiku | 10K | 2K | ~$0.02 |
| merge | Haiku | 8K | 1K | ~$0.01 |
| triage | Sonnet | 12K | 2K | ~$0.07 |
| director (per event) | Opus 4.7, cached | 5K (cached) | 500 | ~$0.02 |

**End-to-end one issue (research → plan → impl → pr → merge):** ~$0.90, assuming no Opus impl retry and no review iterations.

**Director routing cost at 100 events/day:** $0.02 × 100 = $2/day = ~$60/month.

**Caretake heartbeat (hygiene hourly + report daily + trends weekly):** ~$0.20/day = ~$6/month.

**Order-of-magnitude monthly forecast for a steady-state 30-issue/month workflow:**
- Operator runs: 30 × $0.90 = $27
- Director routing: $60
- Caretake heartbeats: $6
- Slack: ~$15 (Opus impl retries, review re-iterations, miscellany)
- **~$110/month** baseline.

This is genuinely cheap compared to a Claude Code Pro ($20/mo) or Max ($200/mo) seat, especially if it replaces all *agent* work and you only use Claude Code for interactive sessions. Get real numbers before believing this; the figures above can easily be 2-3× off in either direction.

### Managed Agents container cost — **unknown**

The live Managed Agents overview page (`/docs/en/managed-agents/overview`) does not publish per-session container pricing, and `/docs/en/pricing` returned a 404 at fetch time. Rate-limits docs are public (300 creates/min, 600 reads/min per org) but pricing is not.

**Action**: Before adopting Managed Agents in any phase, get a written number from Anthropic — either through the request-access form (`https://claude.com/form/claude-managed-agents`) or via sales. Until then, treat container cost as a project risk, not a known quantity.

### Where caching helps most

- **Director**: same `event-classes.md` table in `system` on every poll → put `cache_control: {type: "ephemeral"}` after it. Expect >90% cache hit rate. Director cost drops to ~$0.005/event with caching.
- **Per-operator system prompt**: the skill SKILL.md content is identical across runs of the same operator → cache it. Saves ~75% of input tokens on every operator call after the first.
- **Per-issue context (research findings, plan doc)**: same content read by impl + val + review → if you can keep them in the same context window across phases, cache the shared prefix. Coordinator pattern (Phase 4) is where this pays off most.

## Current State Analysis

What we already have that this plan reuses:

- `plugin/ralph-hero/mcp-server/` — stdio MCP server with 39 GitHub Projects V2 tools, runnable via `npx ralph-hero-mcp-server`.
- `plugin/ralph-hero/skills/ralph-*/SKILL.md` — fully written autonomous skills for each operator phase, suitable for use as `system` content directly.
- `plugin/ralph-hero/agents/*.md` — per-phase agent definitions with `tools:` allowlists, `model:` tiers, and `skills:` preloads. The frontmatter contracts are exactly what we'll bake into Phase 1 scripts.
- `plugin/ralph-knowledge/` — Hono HTTP MCP server already, SQLite-backed. No porting needed.
- `worktrees/GH-NNN/` filesystem isolation — works as-is for Phases 1-3.
- `~/.ralph-hero/activity/*.jsonl` activity log + `recent_activity` MCP — keep for now; eventually replace with session-event stream.

What we **don't** need:
- A new MCP server
- A new state store
- A new thoughts/ corpus location
- Container infrastructure (until Phase 4 at earliest)

## Phase 1: One operator, hand-run

**Goal**: prove the end-to-end shape with the smallest possible thing. Run the existing `triage-agent` operator against a single Backlog issue via the Messages API.

Why triage first: no worktree, no MCP writes beyond labels/comments, well-bounded output (route/close/split decision). Lowest blast radius for "did the port produce the same answer as Claude Code?"

### Mechanics

A single Python script: `scripts/api-port/triage.py <issue-number>`. Roughly 100-200 LOC.

What it does:
1. Reads `plugin/ralph-hero/skills/ralph-triage/SKILL.md` from disk as the `system` prompt (with `cache_control: {type: "ephemeral"}` at the end).
2. Spawns `npx ralph-hero-mcp-server` as a subprocess and bridges its stdio MCP tools into the Messages API as user-defined tools. The simplest possible bridge: a function per tool that JSON-encodes a tool-call request to the MCP subprocess and parses the response. Roughly one helper for `tools/call` and a manifest derived from `tools/list`.
3. Adds a `bash` tool (reference implementation from `shared/tool-use-concepts.md`) — confined to read-only operations for triage. Same `Bash` allowlist as `agents/triage-agent.md`.
4. Runs a manual tool-use loop: `client.messages.create()` → check `stop_reason` → execute tool calls → append results → repeat until `stop_reason == "end_turn"`.
5. Writes the final assistant message + a JSONL token-spend record to `scripts/api-port/runs/<timestamp>-triage-<issue>.json`.

### What this deliberately *doesn't* do

- No Managed Agents.
- No multi-issue dispatch.
- No event polling.
- No caching beyond the single system-prompt breakpoint.
- No skill-content templating (env vars in the SKILL.md are left as-is; if they bite, fix that locally).
- No container — runs on the user's laptop.

### Acceptance signal

Run the script against three known-triaged issues from the past week. For each, eyeball the verdict against what Claude Code's `triage-agent` produced. They don't have to match exactly — they have to be in the same ballpark (same route decision, same close/split call). If they diverge significantly, debug before moving on.

### Cost ceiling

≤$0.30 to validate (~3 runs × ~$0.07/run, with cushion). If actual is >$0.50, something is wrong (probably the SKILL.md is dragging more context than expected — measure and trim).

### Verification

```bash
uv run scripts/api-port/triage.py 1234
# Inspect the final message; compare to the Claude Code triage on the same issue
cat scripts/api-port/runs/*.json | jq '.usage'  # sanity-check token spend
```

## Phase 2: Two more operators, manual chaining

**Goal**: confirm the pattern extends. Port `research-agent` and `plan-agent`. User runs them by hand in sequence on the same issue.

Why these two next: research exercises the ralph-knowledge HTTP MCP (different transport than ralph-hero stdio); plan exercises Opus 4.7 with adaptive thinking + `effort: "xhigh"`. Together they de-risk the two model tiers we haven't touched yet.

### Mechanics

- `scripts/api-port/research.py <issue-number>` — same shape as triage but Sonnet, larger output, writes findings to `thoughts/shared/research/`.
- `scripts/api-port/plan.py <issue-number> <research-doc-path>` — Opus 4.7 with `output_config: {effort: "xhigh"}` and adaptive thinking. Reads the research doc, writes a plan to `thoughts/shared/plans/`.
- Both scripts share the MCP bridge from Phase 1. Refactor it into `scripts/api-port/_mcp_bridge.py` after the second copy.

### What this deliberately *doesn't* do

- No automatic chaining. User runs research, eyeballs the output, runs plan, eyeballs the output. This is the point.
- No PR creation. No state-machine advancement.
- No subagent / multiagent. If plan-agent wants to spawn helpers (like the current `Agent()` calls to `codebase-locator`), defer those — let plan run flat and see if quality is acceptable.

### Acceptance signal

For two known issues with completed Claude Code research + plan docs:
1. Run the API research script. Compare findings doc to the Claude Code version (diff with `diff -u` and read).
2. Run the API plan script against the API research output. Compare plan to the Claude Code version.

Quality bar: API output is *usable*. It does not have to be identical. If it's clearly worse on both issues, debug effort/thinking parameters before adding more operators.

### Cost ceiling

≤$2 to validate (~2 issues × ~$0.50/issue, with cushion).

## Phase 3: Director loop, host-side

**Goal**: replace Claude Code's `autopilot` for read-only / non-impl operations. Still no Managed Agents.

This is where Anthropic's "workflow" frame really pays off. The director is just a Python event loop. It reads from ralph-github, picks the next event, dispatches the right operator script, logs the result.

### Mechanics

- `scripts/api-port/director.py` — long-running process (run in tmux, or via launchd).
- Tool surface for the director (Messages API, Opus 4.7 with `effort: "low"`):
  - `next_actions()` — wrapped MCP call
  - `get_issue(number)` — wrapped MCP call
  - `dispatch(operator: str, issue_number: int)` — local function that shells out to `triage.py` / `research.py` / `plan.py` from Phases 1-2, captures stdout, surfaces verdict back as the tool result.
- The director's `system` prompt is the existing `skills/director/SKILL.md` body + the `event-classes.md` table, with `cache_control: {type: "ephemeral"}` after both.

### What this deliberately *doesn't* do

- No impl/pr/merge dispatch yet. Those stay on Claude Code.
- No `Skill()`-style inline dispatch for hero. The director is allowed to invoke `triage` / `research` / `plan` operators only.
- No webhooks. Polling on a 60-second tick is fine.
- No Managed Agents.

### Acceptance signal

Run director.py side-by-side with Claude Code's autopilot for a week, on the same project board, and compare what each picked up. The director should not miss high-priority events or pick wrong operators. If the routing logic deviates from `event-classes.md`, fix the system prompt first; only change the table if you have a real reason.

### Cost ceiling

≤$80 for a one-week validation run. (~$60 expected for director + ~$15 for triggered operators + cushion.) If actual is higher, find out why before scaling cadence.

## Phase 4: Adopt Managed Agents — only for impl

**Goal**: introduce the first piece of cloud infrastructure, scoped narrowly to the one operator that genuinely benefits from it: `impl-agent`. Per-session containers replace `worktrees/GH-NNN/` and the `impl-worktree-gate.sh` hook.

Trigger criteria for entering this phase (don't enter early):
1. Phases 1-3 have run for ≥2 weeks without major surprises.
2. You have a confirmed price point from Anthropic for Managed Agents container/session cost.
3. There is a specific reason container isolation matters (e.g., wanting to run multiple impls in parallel on the same host without worktree contention, or wanting agents to run without a laptop being on).

### Mechanics

- `client.beta.agents.create()` — one persisted `Agent` config for `impl-agent`. Model: Sonnet 4.6. `tools` includes the bash, edit, glob, grep, and MCP server references. `skills` includes the `ralph-impl` SKILL.md.
- Vault for the GitHub PAT: `client.beta.vaults.credentials.create()`.
- Environment: cloud container with Node 20 + npm (for `npx ralph-hero-mcp-server`).
- The director's `dispatch("impl", N)` tool changes from a subprocess call to `client.beta.sessions.create()` + event-stream consumer.
- Read the `IMPL BLOCKED` verdict from the final session event; on BLOCKED, re-create the session pinned to an opus-versioned `impl-agent-opus` agent.

### Hooks to drop

When impl moves to Managed Agents, these existing hook scripts become redundant or impossible to replicate:
- `impl-worktree-gate.sh` — container isolation replaces it.
- Any `RALPH_WORKTREE_PATHS` multi-repo logic — handled by attaching multiple `github_repository` session resources.
- Activity-log writer for impl tool calls — consume session events instead.

### What this deliberately *doesn't* do

- No multiagent coordinator (that's Phase 5).
- No port of pr/merge/val to Managed Agents — those stay on bare API. (They don't need containers.)
- No port of research/plan/triage. Same reason.

### Acceptance signal

Run 5 known atomic issues end-to-end via director → Managed Agents impl → director → bare-API pr → Claude Code merge. All 5 should produce correct PRs. If the per-session container makes git/npm setup awkward, fix the environment config; don't downgrade to a bare-API impl.

### Cost ceiling

≤$30 for the 5-issue validation. Container cost is the unknown — set a hard daily cap via Anthropic's spend limits before running.

## Phase 5 (deferred): coordinator pattern for hero

**Only if** you outgrow the Phase 4 setup and need true intra-issue shared state (e.g., research findings reused by plan and review within one session, not via thoughts/).

Requires:
- Anthropic Managed Agents multiagent research-preview access (`https://claude.com/form/claude-managed-agents`).
- A clear answer to "what does the coordinator need that the director-as-Python-loop doesn't already give us?" If you can't answer that, don't enter this phase.

The coordinator-with-roster pattern is the right tool for cross-phase context sharing within one container's filesystem. But every problem it solves can also be solved by writing intermediate state to thoughts/ and re-reading it — which is what hero already does today. So unless cache amortization across phases turns out to be cost-load-bearing, this phase may never need to happen.

## Simplifications applied (vs the research doc's hybrid architecture)

| Research doc said | This plan says | Why |
|---|---|---|
| Managed Agents for all operators, persisted Agent configs per role | Bare Messages API for all operators in Phases 1-3 | Anthropic guidance: workflow → Messages API. Containers aren't free; only impl genuinely needs one. |
| Vaults for GitHub credentials from day 1 | Plain env var in Phase 1; vault when Managed Agents enters in Phase 4 | Vaults are an MCP-credential primitive. Local Python doesn't need them. |
| Coordinator-with-roster for hero | Deferred indefinitely to Phase 5 | Multiagent is research preview, not GA. The Phase 3 director loop covers 80% of what a coordinator would do, in pure Python. |
| Per-session container as worktree replacement | Use existing worktrees for Phases 1-3; container only for impl in Phase 4 | Don't break what works. |
| Bake skill content into agent versions at `agents.create()` time | Read SKILL.md from disk on every script invocation in Phases 1-3 | The agents.create() bake-in only matters once you're using Managed Agents (Phase 4+). |
| HTTP-wrap the stdio MCP server upfront | Stdio subprocess bridge in Phases 1-3; HTTP wrap only when Managed Agents needs it (Phase 4) | The stdio MCP is the existing artifact. Don't refactor it until forced. |
| ~50 hook scripts to audit | Audit only the impl-specific hooks in Phase 4 | Most hooks are inside Claude Code's hook system, which is irrelevant to the bare-API path. |
| OTel bridge for Langfuse from day 1 | Plain JSONL log in Phases 1-3; OTel only if/when needed | Premature observability. Local JSONL is fine for hand-run validation. |

Net effect: Phase 1 is **one Python file, maybe 200 LOC, no cloud infrastructure**. The research doc described an end-state that's worth ~3 months of work. Phase 1 should fit in a weekend.

## Open questions to resolve before any phase

- **What is the Managed Agents container cost per session?** (Affects Phase 4 viability.) Source: Anthropic sales / request-access form.
- **What is the actual token spend per operator today?** Run `delegation_stats` against a recent week and compare against the estimates in this doc. Affects all phases.
- **Does Claude Opus 4.7's `effort: "xhigh"` setting produce plan quality comparable to today's Opus 4.7 in Claude Code?** Decide in Phase 2.
- **Where does `thoughts/` live in Phase 4?** If impl runs in a container, does the container have access to thoughts/? Options: (a) clone thoughts/ into each session, (b) read-only file mount, (c) pass relevant excerpts in the prompt. Defer until Phase 4 actually starts.
- **Webhook receiver in Phase 3?** Polling on a 60s tick is fine for validation but wastes ~1500 director calls/day. Decide after one week of Phase 3 whether to add a webhook endpoint or accept the polling cost.

## What to do next

The smallest useful next step is **Phase 1: write `triage.py`** and run it once against a known issue. That single artifact will answer most of the questions about the bare-API path: does the MCP subprocess bridge work, does the SKILL.md system-prompt pattern work, does the cost estimate hold up. Everything in this plan downstream of Phase 1 is contingent on what that one script teaches us.

Do *not* start Phase 1 just because this plan exists. Read it, sleep on it, talk it through, then decide whether to write the script. The whole point of the "exploratory" framing is that this doc is allowed to sit untouched while the idea matures.
