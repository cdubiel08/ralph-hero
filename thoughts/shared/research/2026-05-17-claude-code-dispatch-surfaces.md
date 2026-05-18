---
date: 2026-05-17
topic: "How dispatch, loops, and triggers work in Claude Code, and how ralph-hero uses them today"
tags: [research, dispatch, loops, triggers, schedule, cron, hooks, autopilot, director, background-agents, ralph-hero]
status: complete
type: research
git_commit: 7931b4689d4e9454e4bcb877d6a0f2715579aa9d
git_branch: main
---

# Research: How dispatch, loops, and triggers work in Claude Code (and what ralph-hero uses today)

## Prior Work

- builds_on:: [[2026-05-07-GH-1136-autopilot-skill]] (plan — autopilot wraps `/loop` dynamic + Director per-iteration)
- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]] (plan — Director + 5 teams + iOS triggers, status: complete)
- builds_on:: [[2026-05-17-GH-1267-unified-agent-system-usage-guide]] (research — user-facing guide for the unified agent system)
- builds_on:: [[2026-03-20-skill-dispatch-inventory]] (research — primary evidence on Skill() vs Agent() dispatch across ralph-hero skills)
- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]] (research — Hero's Skill() vs Agent() dispatch model)
- builds_on:: [[2026-04-12-monitor-tool-codebase-compositions]] (research — Monitor + ScheduleWakeup interaction, cache TTL)
- builds_on:: [[2026-05-05-GH-0760-monitor-tool-ci-watch]] (plan — Monitor adoption for CI watch)
- builds_on:: [[2026-04-03-GH-0731-complete-autonomous-loop]] (plan — early complete autonomous loop through PR + code review)
- builds_on:: [[2026-02-21-GH-0294-early-exit-empty-work-ralph-loop]] (research — early-exit semantics for empty-queue loops)
- builds_on:: [[2026-03-24-GH-0674-agent-per-phase-architecture]] (plan — agent-per-phase wiring that Director now dispatches)
- builds_on:: [[2026-05-08-GH-1142-ralph-hero-unblock-skill]] (plan — async unblock loop, separate from autopilot)
- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]] (plan — chief-of-staff unattended loop foundation)
- builds_on:: [[2026-05-03-GH-0967-record-activity-stdin-json]] (plan — activity log via PostToolUse hook)
- builds_on:: [[2026-05-03-GH-0985-catch-up-cursor-hook]] (plan — PostToolUse cursor advancement)
- builds_on:: [[2026-05-05-GH-1022-snapshot-capture-jsonl]] (plan — snapshot JSONL + launchd template)
- builds_on:: [[2026-04-22-agent-bus-design]] (research — cross-repo agent bus patterns)

## Research Question

How does "dispatch" work on Claude Code (CLI and desktop) — Agent dispatch, background sessions, /loop, /schedule, ScheduleWakeup, CronCreate, hooks, RemoteTrigger, PushNotification, Monitor, MCP-driven triggers — and how is ralph-hero already using each surface today? The goal is to document the surface area so a follow-up plan can identify which loop/trigger primitives are not yet exploited and propose incremental adoption to automate more work.

## Summary

Claude Code exposes **eleven distinct dispatch and trigger surfaces**, each with its own scope, durability, and isolation model:

| # | Surface | Scope | Durable | Trigger by |
|---|---------|-------|---------|-----------|
| 1 | `Agent` tool (subagents) | Within session | No | Inline call from a skill |
| 2 | Background sessions (`/bg`, `claude --bg`, agent view) | Supervisor-managed | Yes (`~/.claude/jobs/<id>/`) | Manual or `--bg` flag |
| 3 | `/loop` (fixed interval) | Session | 7 days, restored on `--resume` | `CronCreate` under the hood |
| 4 | `/loop` (dynamic mode) | Session | 7 days | `ScheduleWakeup` per iteration |
| 5 | `/schedule` / `CronCreate` | Session | 7 days | Cron expression |
| 6 | `ScheduleWakeup` | Dynamic `/loop` only | 7 days | Self-paced (Claude chooses delay) |
| 7 | Hooks (Session, Tool, Stop) | Global or session | Rules, not state | Lifecycle events |
| 8 | `RemoteTrigger` / Routines | Cloud account | Persistent | Schedule, API, GitHub webhook |
| 9 | `PushNotification` | Global | N/A | Inline call |
| 10 | `Monitor` tool | Session | N/A | Streaming background process |
| 11 | MCP tool responses | Session | Depends on server | Tool call returning structured data |

ralph-hero is **already a heavy consumer** of surfaces 1, 2, 3, 4, 5, 6, 7, 10, 11 plus an out-of-band integration via `launchd` and `ntfy`. The surfaces that are **referenced in code but not fully exercised** are: native `RemoteTrigger` (Director has a contract for it but no harness wiring), native `PushNotification` (ntfy is used as a workaround), cloud Routines (everything durable is `launchd`-based), and the `Monitor` tool for CI watch (planned in [[2026-05-05-GH-0760-monitor-tool-ci-watch]] but not landed in autopilot's terminal path). Agent teams + `SendMessage` are experimental and not in active use.

The dispatch hierarchy in ralph-hero today flows: **launchd / heartbeat → `/ralph-hero:autopilot` → `/loop` (dynamic) → `/ralph-hero:director` → team `Skill()` → per-phase `Agent()` → MCP `save_issue` → hook chain (record-activity, outcome-collector, cursor-advance) → ntfy push**. Each layer has a clean handoff, enforced by deterministic hook gates (e.g., `autopilot-enable-gate.sh`, `impl-worktree-gate.sh`, `split-estimate-gate.sh`).

## Detailed Findings

### 1. `Agent` tool — subagent dispatch

**What it is.** Inline tool call that spawns an isolated worker with its own context window, tool allowlist, and (optionally) git worktree. Returns a single text result to the parent.

**Mechanism.**
- Subagents defined in `.claude/agents/<name>.md` or plugin `agents/` directory; preloaded skills via `skills:` frontmatter field.
- Each subagent runs in a fresh context (no parent conversation inheritance), with the `tools:` field acting as a hard allowlist.
- Foreground vs background controlled by `run_in_background: true` — background agents auto-deny tools that would otherwise prompt.
- Worktree isolation via `isolation: "worktree"` — agent operates on an isolated copy under `.claude/worktrees/`.
- `SendMessage(to: <agent_id>, message: ...)` resumes a previously stopped subagent (used by the harness for continuation; mostly experimental for inter-teammate comms).

**Ralph-hero usage.**
- **Per-phase agents** at `plugin/ralph-hero/agents/` — `research-agent`, `plan-agent`, `plan-epic-agent`, `split-agent`, `triage-agent`, `review-agent`, `impl-agent`, `pr-agent`, `merge-agent`, `val-agent`, `unblock-agent`. Each preloads its companion `ralph-*` skill via `skills:` frontmatter (see `plugin/ralph-hero/agents/impl-agent.md`).
- **Tier-based model selection** in `plugin/ralph-hero/docs/model-tier-policy.md`. Override via `RALPH_<AGENT>_MODEL` env vars.
- **Hero orchestrator** at `plugin/ralph-hero/skills/hero/SKILL.md` dispatches each phase via `Agent(subagent_type=…)` with explicit model override and natural-language prompts.
- **Research skill** at `plugin/ralph-hero/skills/research/SKILL.md` (and ralph-research) parallels three locator + analyzer agents for codebase scanning.
- **Sub-agent team isolation rule**: internal `Agent()` calls do NOT pass `team_name` (per `plugin/ralph-hero/skills/STYLE.md`).

### 2. Background sessions

**What it is.** A full Claude Code session running independently of any attached terminal, hosted by a per-user supervisor daemon (`~/.claude/daemon/`). State lives at `~/.claude/jobs/<session-id>/`.

**Mechanism.**
- Spawned via `claude --bg "task"`, `/bg` from inside a running session, or `claude agents` TUI.
- Per-session worktree under `.claude/worktrees/` for write isolation.
- Persistent across terminal close, supervisor restart, and laptop sleep/wakeup (active work pauses on sleep).
- Supervisor stops idle sessions ~1 hour after unattachment; reattaching restarts from saved state.
- Each session emits `result:` / `needs input:` / `failed:` markers on its last text line; a classifier extracts these for the job-list display.
- Background sessions inherit hooks from `~/.claude/settings.json` and the project, exactly like foreground sessions.

**Ralph-hero usage.**
- The current background job (this very session) writes scratch files to `$CLAUDE_JOB_DIR` (`/Users/dubiel/.claude/jobs/<id>`).
- `result:` / `needs input:` / `failed:` markers are used by every team orchestrator skill to signal terminal states to the background harness.
- `plugin/ralph-hero/scripts/cli-dispatch.sh` and `plugin/ralph-hero/scripts/ralph-cli.sh` provide entrypoints suitable for headless `claude -p` invocations.
- `plugin/ralph-hero/scripts/ralph-loop.sh` and `ralph-team-loop.sh` run as out-of-process loops alongside the in-session `/loop` skill, so users can pick "headless" or "in-session" depending on context.

### 3 & 4. `/loop` skill — fixed and dynamic modes

**What it is.** A bundled skill (`Skill("loop", ...)`) that runs a prompt repeatedly while the session stays open.

**Mechanism — fixed interval.**
- `/loop 5m <prompt>` converts the interval to a 5-field cron expression (`*/5 * * * *`), creates a `CronCreate` task, and the harness polls on schedule.
- Tasks live in `~/.claude/jobs/<session-id>/` and auto-expire 7 days after creation.

**Mechanism — dynamic mode.**
- `/loop <prompt>` with no interval triggers dynamic mode. After each iteration Claude calls `ScheduleWakeup(prompt, delaySeconds)` with a self-chosen delay.
- Harness sleeps locally, then re-invokes Claude with the same prompt + any deltas in conversation context.
- Sentinel `<<autonomous-loop-dynamic>>` is used by the harness to carry the loop's pacing state across firings (not user-visible).
- Bare `/loop` with no prompt runs a built-in maintenance prompt; `.claude/loop.md` overrides the default.

**Quirks.**
- 7-day session expiry; resumed via `claude --resume <id>` if unexpired.
- Max 50 scheduled tasks per session.
- Recurring jitter: up to 30 minutes (or half the interval) to avoid thundering herd.
- Esc clears the next pending wakeup for `/loop`.
- Disabled in non-prompt form on Bedrock/Vertex.

**Ralph-hero usage.**
- **Autopilot** at `plugin/ralph-hero/skills/autopilot/SKILL.md` is a thin wrapper that calls `Skill("loop", args="Run /ralph-hero:director on the next-most-important event…")` in dynamic mode. Autopilot does NOT call `ScheduleWakeup` directly — `/loop` owns that.
- The autopilot prompt instructs the model to pick a delay matching the prior outcome: short (60-270s, in-cache) when forward progress was made; long (1200-1800s) when only stuck/in-review items remain; never 300s (cache-window anti-pattern). The cache-TTL guidance comes verbatim from `ScheduleWakeup`'s tool description.
- The **`ralph-loop.sh`** script (`plugin/ralph-hero/scripts/ralph-loop.sh`) is an out-of-process equivalent for headless `claude -p` invocations, supporting `--triage-only`, `--split-only`, `--analyst-only` flags.

### 5. `/schedule` and `CronCreate`

**What it is.** A user-facing skill plus a tool that schedule one-time or recurring prompts inside the current session.

**Mechanism.**
- Standard 5-field cron in local timezone: `minute hour day-of-month month day-of-week`.
- `recurring: false` for one-shot reminders (auto-delete after firing).
- `recurring: true` for recurring (default; auto-delete after 7 days).
- `durable: true` writes to `.claude/scheduled_tasks.json` to survive restarts; `false` (default) is in-memory only.
- Jitter: ±30 min for recurring (max 15 min capped); ±90 sec early for one-shot at `:00` or `:30`.
- 7-day auto-expiry on recurring tasks.

**Ralph-hero usage.**
- Watcher heartbeat: `Skill("schedule", "every 15m /ralph-hero:watch")` documented in `plugin/ralph-hero/skills/watch/HEARTBEAT.md`. Override interval via `RALPH_WATCH_HEARTBEAT_MIN`.
- Caretaker heartbeats (×3) installed via `plugin/ralph-hero/scripts/caretake/install-schedules.sh` — uses `/schedule create` with explicit cron.
- Scout nightly: `/schedule create scout-nightly --cron "0 3 * * *" --script plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (per `CLAUDE.md`).
- `/schedule create` for ad-hoc reminders is implicit in user workflow; not codified anywhere.
- ralph-hero does NOT use `durable: true` — durable scheduling is delegated to `launchd` (see surface #11).

### 6. `ScheduleWakeup`

**What it is.** A tool callable only inside dynamic `/loop` mode that requests the harness sleep and re-invoke at a future time.

**Mechanism.**
- Parameters: `prompt` (must be the same prompt as the current `/loop` so the next firing re-enters the skill), `delaySeconds` (clamped to [60, 3600]), `reason` (telemetry string shown to user).
- Cache-aware sleep windows: <270s stays warm; 300s is worst-case (pays cache miss without amortizing); 1200s+ is the right range when amortizing a cache miss.
- For autonomous /loop runs, pass the literal sentinel `<<autonomous-loop-dynamic>>` as the prompt.
- A separate sentinel `<<autonomous-loop>>` exists for `CronCreate`-based autonomous loops (different harness mode); do not confuse.

**Ralph-hero usage.**
- Allowlisted in autopilot's `allowed-tools` (along with `Skill`), but autopilot doesn't call it directly — `/loop` calls it on autopilot's behalf.
- Allowlisted in `director/SKILL.md` so Director could pace its own re-firing, though current Director ends after a single dispatch and lets `/loop` handle re-entry.
- Hero, watch, caretake, and per-phase agents do NOT have `ScheduleWakeup` in their allowlists — they're single-shot operators that return control to the caller (`/loop` if invoked from autopilot, or the user if invoked directly).

### 7. Hooks — Session, Tool, Stop lifecycle

**What it is.** Shell commands, HTTP endpoints, or MCP-tool calls registered in `hooks.json` or skill/agent frontmatter that fire automatically at lifecycle points.

**Mechanism.**
- Event types: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `StopFailure`, `FileChanged` (advanced), plus team-level `TeammateIdle`, `TaskCreated`, `TaskCompleted` for experimental agent teams.
- Handler types: `command` (shell + JSON on stdin), `http` (POST), `mcp_tool`, `prompt` (single-turn model), `agent` (full subagent).
- Exit-code contract: `0` allow, `2` block with stderr message, anything else is non-blocking error (logged but doesn't stop work).
- Matcher patterns filter tool name (`"Bash"`, `"Bash|Edit"`, `"^Notebook"`, `"mcp__memory__.*"`).
- **PostToolUse-for-response-inspection**: when a gate needs to evaluate `tool_response` content (not just `tool_input`), register both `PreToolUse` and `PostToolUse` for the same matcher and discriminate inside the script via `.hook_event_name`. PostToolUse can only allow or block subsequent steps; it cannot mutate the response.
- Skills can only declare `PreToolUse`, `PostToolUse`, `Stop` hooks in frontmatter. Plugin agents cannot declare hooks at all (the plugin-level `hooks.json` discriminates by `agent_type`).

**Ralph-hero usage.** This is one of the most heavily exploited surfaces. `plugin/ralph-hero/hooks/scripts/` contains 50+ scripts. Categories:
- **SessionStart**: `load-team-soul.sh` injects the team's voice file (`SOUL.md`) into the orchestrator's system prompt; `record-activity.sh` initializes the activity log.
- **PreToolUse gates** (15+): `autopilot-enable-gate.sh` (blocks `Skill` if `RALPH_AUTOPILOT_ENABLE` unset), `agent-phase-gate.sh`, `split-estimate-gate.sh` (M/L/XL reminder; later blocks on PostToolUse if estimate is XS), `impl-plan-required.sh`, `impl-state-gate.sh`, `impl-worktree-gate.sh`, `lock-claim-validator.sh`.
- **PostToolUse mirrors** (10+): `outcome-collector.sh` mirrors state transitions to `~/.ralph-hero/outcomes/`; `cursor-advance-catch-up.sh` advances the catch-up cursor from `tool_response.cursor_advanced_to`; `record-activity.sh` logs every tool call categorized as `work` or `meta`; `*-postcondition.sh` validates phase completion.
- **Stop gates**: `team-stop-gate.sh`, `team-shutdown-validator.sh`.
- **Pattern reference**: `split-estimate-gate.sh` + `ralph-split/SKILL.md` documents the canonical PostToolUse-response-inspection pattern (see `CLAUDE.md` for full description).

### 8. `RemoteTrigger` and Routines

**What it is.** A tool (`RemoteTrigger`) that creates a cloud-hosted Routine on claude.ai, which then runs as a full autonomous Claude Code session triggered by schedule, API call, or GitHub webhook.

**Mechanism.**
- Each Routine has a triggering policy: scheduled (cron, 1-hour minimum), API (POST to `/v1/claude_code/routines/<id>/fire` with bearer token), or GitHub (webhook on PR/release with filter rules).
- Runs in Anthropic's cloud — no local session required. Has its own model, environment, MCP connectors.
- Persistent until manually deleted (unlike `/loop` which expires at 7 days).
- Routines can use MCP connectors without per-use approval.
- API trigger body may include a `text` field for context (e.g., alert body).

**Ralph-hero usage.**
- **Director has a contract for it** (see `plugin/ralph-hero/skills/director/SKILL.md` Step 1): if a `RemoteTrigger` tool input is present in session context, Director extracts `issue_number` + `team` from the tool payload, treats it as priority 1, and skips taxonomy classification.
- **The contract is not exercised end-to-end yet** — no producer in the repo actually creates a Routine that fires `RemoteTrigger` against Director. The integration point exists but no wire is connected.
- All "remote" triggers today are implemented via the iOS sentinel: a label `trigger:<team>` added from the GitHub mobile app, picked up by Director on its next tick. See `plugin/ralph-hero/skills/director/IOS-REMOTE.md`.

### 9. `PushNotification`

**What it is.** A tool that delivers a notification to desktop and (if Remote Control mobile app is paired) phone.

**Mechanism.**
- Parameters: `title`, `body`. Immediate delivery.
- Routed via Anthropic infrastructure — unavailable on Bedrock/Vertex/Foundry.

**Ralph-hero usage.**
- **Not used directly.** ralph-hero uses an out-of-band ntfy bridge instead: `plugin/ralph-hero/scripts/lib/push-on-completion.sh` posts to a topic named by `RALPH_COS_NTFY_TOPIC`. Fires from `ralph-merge` Step 9c and the COS morning-brief.
- `push-artifact.sh` and `push-on-completion.sh` are bash scripts called from skill bodies; they shell out to `curl` against the ntfy server.

### 10. `Monitor` tool

**What it is.** A tool that runs a background command and streams each stdout line back as a separate model turn.

**Mechanism.**
- `Monitor(command: "tail -f log.txt", ...)`. Each line becomes a notification that wakes Claude.
- For one-shot "wait until done" Bash with `run_in_background: true` is the more idiomatic fit; Monitor is for streaming until-loops.
- Long leading `sleep` commands are blocked; use Monitor with an until-loop (e.g., `until <check>; do sleep 2; done`).

**Ralph-hero usage.**
- **Planned but not landed in autopilot's terminal path** — see [[2026-05-05-GH-0760-monitor-tool-ci-watch]] for the adoption plan (watch CI from finish-agent instead of polling). Status of that plan is "approved, not yet implemented" based on the prior-art search.
- `plugin/ralph-hero/agents/finish-agent` allowlist includes `Monitor` (per `plugin/ralph-hero/agents/finish-agent.md`), so the wiring is present — only the skill body change is missing.

### 11. MCP-driven triggers + launchd

**What it is.** Two related mechanisms: (a) MCP tools whose responses include structured event data the harness can consume, and (b) external job runners (launchd on macOS) that invoke `claude -p` or call MCP tools directly.

**Mechanism (a) — MCP tool responses.**
- Tools return `content` blocks with metadata; hooks can inspect (PostToolUse pattern) and act.
- Stateless from the MCP server's perspective; state lives in the client (hooks, cursors).

**Mechanism (b) — launchd templates.**
- Located under `plugin/ralph-hero/scripts/*/launchd/com.ralph.*.plist.template`.
- User copies template to `~/Library/LaunchAgents/`, edits paths, loads via `launchctl load`.
- Survives machine reboot; durable across sessions; not session-scoped.

**Ralph-hero usage.**
- **MCP**: `ralph_hero__recent_activity` returns activity events + a `cursor_advanced_to` field that `cursor-advance-catch-up.sh` (PostToolUse) writes to `~/.ralph-hero/cursors/catch-up.json`. The catch-up cursor is the synchronization primitive for `/hello`'s "what changed since last time" narrative.
- **MCP**: `ralph_hero__save_issue` triggers `outcome-collector.sh` (PostToolUse) which mirrors the state transition to `~/.ralph-hero/outcomes/YYYY/MM/DD.jsonl`. Later, `reflect.py` clusters these outcomes into `process-improvement` issues when failure signals exceed `RALPH_DREAM_PROCESS_IMPROVEMENT_MIN_CLUSTER`.
- **launchd templates** present:
  - `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` — nightly memory consolidation (ingest + reflect + logrotate).
  - `scripts/snapshot/launchd/com.ralph.snapshot.plist.template` — daily snapshot capture for trends.
  - `scripts/activity/launchd/com.ralph.activity-rotate.plist.template` — activity log retention (`RALPH_ACTIVITY_RETENTION_DAYS`).
  - `scripts/delegate/launchd/com.ralph.delegate-rotate.plist.template` — delegation audit log rotation.
  - `scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` — morning-brief generator.
  - `scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` — self-improvement analyzer.
  - `scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template` — GCP Cloud Monitoring → GitHub issue relay (creates issues from alerts; Director then picks them up).
  - `scripts/unblock/launchd/com.ralph.unblock.plist.template` — async unblock request processor.

### Cross-surface composition in ralph-hero today

The dispatch graph for an end-to-end autonomous backlog run:

```
launchd com.ralph.cos-morning-brief
   v (cron tick)
cos.sh / cos-loop.sh
   v (renders status, posts to ntfy via push-on-completion.sh)
user types /ralph-hero:autopilot (or schedule fires it)
   v (autopilot-enable-gate.sh PreToolUse blocks if RALPH_AUTOPILOT_ENABLE unset)
Skill("loop", args="Run /ralph-hero:director...")
   v (dynamic mode; /loop owns the wakeup cadence)
/ralph-hero:director (allowlisted Skill, Read, Bash, next_actions, get_issue, save_issue, list_issues, ScheduleWakeup)
   v (SessionStart: load-team-soul.sh injects team voice)
   v (classifies via event-classes.md: trigger:<team> > automation label > workflow_state)
Skill("ralph-hero:hero", args="NNN")  [or watch / caretake / scouts]
   v (per-phase agent dispatched via Agent())
Agent(subagent_type="impl-agent", model="sonnet" | "opus")
   v (impl-plan-required.sh, impl-state-gate.sh, impl-worktree-gate.sh PreToolUse gates)
   v (work happens inside .claude/worktrees/<feature>/)
   v (impl-postcondition.sh PostToolUse validates completion)
ralph_hero__save_issue  -> workflow state transition
   v (outcome-collector.sh PostToolUse mirrors to ~/.ralph-hero/outcomes/)
   v (record-activity.sh PostToolUse logs to ~/.ralph-hero/activity/YYYY/MM/DD.jsonl)
Hero emits `result: ...` on stdout
/loop sees the result, calls ScheduleWakeup(delay=<self-chosen>)
   v (next iteration; Director picks the next-most-important event)
[loop continues until Director emits `result: Queue empty`]
ralph-merge Step 9c -> push-on-completion.sh -> ntfy push to phone
```

### Telemetry / observability

OpenTelemetry export is wired when `RALPH_DEBUG=true` plus `OTEL_*` env vars are set. Claude Code emits `mcp.tool.*` spans, hook events, and session lifecycle traces over OTLP/HTTP. The ralph-hero MCP server (Phase 2+) attaches `ralph_hero.graphql` child spans inside the same trace context. Default ingestion target is the local Langfuse harness at `~/projects/langfuse/` (see `~/projects/CLAUDE.md`).

This means every dispatch above has trace evidence, queryable in Langfuse, when telemetry is enabled.

## Code References

**Skill definitions and orchestrators:**
- `plugin/ralph-hero/skills/autopilot/SKILL.md:39-49` — autopilot's full body (one `Skill("loop", …)` call)
- `plugin/ralph-hero/skills/director/SKILL.md:36-42` — remote-trigger contract (three priority sources)
- `plugin/ralph-hero/skills/director/SKILL.md:69-96` — classification algorithm
- `plugin/ralph-hero/skills/director/SKILL.md:114-121` — team→entrypoint mapping
- `plugin/ralph-hero/skills/hero/SKILL.md` — builders team orchestrator
- `plugin/ralph-hero/skills/watch/SKILL.md` — watchers team orchestrator
- `plugin/ralph-hero/skills/caretake/SKILL.md` — caretakers team orchestrator
- `plugin/ralph-hero/skills/watch/HEARTBEAT.md` — `Skill("schedule", "every 15m /ralph-hero:watch")` pattern
- `plugin/ralph-hero/skills/cos/SKILL.md` — chief-of-staff orchestrator

**Per-phase agents (preloaded skills):**
- `plugin/ralph-hero/agents/impl-agent.md` — `skills: ralph-impl`, `model: sonnet`, `tools:` allowlist
- `plugin/ralph-hero/agents/research-agent.md`, `plan-agent.md`, etc.

**Hook scripts (lifecycle automation):**
- `plugin/ralph-hero/hooks/hooks.json` — central registration
- `plugin/ralph-hero/hooks/scripts/autopilot-enable-gate.sh` — PreToolUse(Skill) opt-in gate
- `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` — Pre+PostToolUse response-inspection pattern
- `plugin/ralph-hero/hooks/scripts/record-activity.sh` — SessionStart + PostToolUse activity log writer
- `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` — PostToolUse cursor advancer
- `plugin/ralph-hero/hooks/scripts/outcome-collector.sh` — PostToolUse state-transition mirror
- `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` — SessionStart voice injection
- `plugin/ralph-hero/hooks/scripts/impl-{plan-required,state-gate,worktree-gate,postcondition}.sh` — phase gates

**launchd / external schedule infrastructure:**
- `plugin/ralph-hero/scripts/caretake/install-schedules.sh` — three caretaker `/schedule create` invocations
- `scripts/dream/launchd/com.dubiel.dream-loop.plist.template` — nightly dream-loop
- `plugin/ralph-hero/scripts/snapshot/launchd/com.ralph.snapshot.plist.template` — daily snapshot
- `plugin/ralph-hero/scripts/monitoring-bridge/README.md` — GCP alert → GitHub issue relay
- `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` — morning brief
- `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` — self-improvement loop
- `plugin/ralph-hero/scripts/lib/push-on-completion.sh` — ntfy push integration

**Loop runners (out-of-process):**
- `plugin/ralph-hero/scripts/ralph-loop.sh` — headless `claude -p` loop with `--triage-only`/`--split-only`/`--analyst-only` flags
- `plugin/ralph-hero/scripts/ralph-team-loop.sh` — team-mode equivalent
- `plugin/ralph-hero/scripts/cos/cos-loop.sh`, `cos-unattended.sh` — COS attended / unattended variants

**MCP tools used in dispatch flows:**
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` — `next_actions` (Director's ranking input)
- `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` — `recent_activity` (catch-up + observability)
- `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts` — `save_issue`, `get_issue` (state transitions hit hooks)
- `plugin/ralph-hero/mcp-server/src/tools/trends-tools.ts` — `capture_snapshot` (called from launchd)

## Architecture Documentation

### Dispatch decision matrix (when ralph-hero picks each surface)

| Trigger source | Mechanism | Used for |
|---|---|---|
| Human types `/ralph-hero:autopilot` | `Skill("loop", …)` dynamic mode | Backlog drainage |
| Human types `/ralph-hero:director` | Direct `Skill()` invocation | One-event dispatch |
| Human types `/ralph-hero:hero NNN` | Direct `Skill()` invocation | Process one issue end-to-end |
| iOS app adds `trigger:<team>` label | Director picks up on next `/loop` tick or `/schedule` heartbeat | Remote control from phone |
| `/schedule` heartbeat fires `/ralph-hero:watch` | `CronCreate` (session-scoped) | Watcher monitoring |
| `launchd` fires `dream-now` | External cron | Nightly memory consolidation |
| `launchd` fires `cos-morning-brief` | External cron | Daily status push |
| `launchd` fires `monitoring-bridge` | External script POST to GitHub Issues API | Cloud alert → backlog ingestion |
| GitHub PR merged on `main` | `release.yml` GitHub Actions workflow | npm publish |
| GitHub Issue state change | `sync-issue-state.yml` GitHub Actions workflow | Sync to Projects V2 |

### Two distinct dispatch hierarchies

ralph-hero runs **two parallel dispatch hierarchies** that share the same MCP server backend:

1. **In-session hierarchy** (foreground or background): `autopilot → /loop → director → team skill → per-phase agent`. State transitions hit hooks, hooks write to log files, log files inform `recent_activity` MCP tool.

2. **External hierarchy** (no Claude Code involvement): `launchd → bash script → curl/gh → GitHub Issues → backlog`. The dream-loop, monitoring-bridge, and snapshot capture all run this way. The work surfaces as new issues that the in-session hierarchy will then pick up on its next tick.

The handoff between the two is the GitHub Projects V2 board — every external producer writes issues, every in-session consumer reads issues. No shared memory, no shared file locks, no race conditions.

### What Director does NOT do (deliberate non-features)

- Director does NOT implement work — only classifies and dispatches.
- Director does NOT route by instinct — classification is always a lookup against `event-classes.md`.
- Director does NOT call `ScheduleWakeup` even though it's in the allowlist — when invoked inside `/loop`, `/loop` owns wakeup cadence.
- Director does NOT consume automation labels (`watcher-auto`, `scout-auto`, `process-improvement`) — their producers manage their own lifecycle.

This is the source of Director's robustness: it's a thin, table-driven dispatcher with no state of its own.

### Hook gate placement convention

ralph-hero uses three distinct gate placements:

| Gate purpose | Placement | Example |
|---|---|---|
| Inject context / remind agent of constraints | PreToolUse, exit 0 | `split-estimate-gate.sh` Pre-half |
| Validate `tool_input` (args) before run | PreToolUse, exit 2 if bad | `autopilot-enable-gate.sh` |
| Validate `tool_response` content after run | PostToolUse, exit 2 if bad | `split-estimate-gate.sh` Post-half |
| Mirror successful side-effects | PostToolUse, always exit 0 | `outcome-collector.sh`, `record-activity.sh`, `cursor-advance-catch-up.sh` |
| Release lock if work failed | PostToolUse on failure | `lock-release-on-failure.sh` |
| Enforce clean shutdown | Stop | `team-stop-gate.sh` |

## Historical Context (from thoughts/)

- **GH-1136 autopilot epic** ([[2026-05-07-GH-1136-autopilot-skill]]): five-phase plan to build autopilot on top of `/loop` + `ScheduleWakeup`. Phase 4 specifies the deterministic hook gate. Critique iterations R1, R2, R3 progressively removed in-skill complexity (iteration counters, cooldown tables, audit logs) and moved them to `/loop`'s ownership.
- **GH-1267 unified-agent-system epic** ([[2026-05-16-GH-1267-unified-agent-system-epic]], status: complete): plan-of-plans that wired Director + five teams + iOS remote control. The eight sub-epics (GH-1268 through GH-1275) cover SOUL framework, Director skill, watcher team, event shims, self-healing closure, scout scheduling, caretaker team, and iOS integration.
- **GH-0731 complete autonomous loop** ([[2026-04-03-GH-0731-complete-autonomous-loop]]): early plan to drive the full lifecycle (research → plan → impl → PR → code review → merge) autonomously. Predates Director; the work was later refactored under the unified-agent system.
- **GH-0294 early-exit semantics** ([[2026-02-21-GH-0294-early-exit-empty-work-ralph-loop]]): documented why `/loop` must terminate gracefully when the queue is empty rather than running forever. This convention is preserved in autopilot via Director's `result: Queue empty` marker.
- **GH-0760 Monitor tool for CI watch** ([[2026-05-05-GH-0760-monitor-tool-ci-watch]]): approved plan to replace the polling pattern in `finish-agent` with `Monitor` for CI watching. The agent allowlist already includes `Monitor`; skill-body update is pending.
- **GH-0637 Hero dispatch model** ([[2026-03-19-GH-0637-hero-dispatch-model]]): foundational research that established the Skill()-for-orchestration / Agent()-for-execution convention. Pre-Director, hero dispatched per-phase agents directly; post-Director, hero is still the builders entrypoint but it's invoked by Director.

## Related Research

- [[2026-03-20-skill-dispatch-inventory]] — 40-skill inventory of `Skill()` vs `Agent()` patterns
- [[2026-04-22-claude-code-agentic-metrics]] — Instrumentation for Claude Code agentic workflows (OTel hookup)
- [[2026-04-22-agent-bus-design]] — Cross-repo agent bus patterns
- [[2026-05-02-langsmith-parity-shared-agent-platform]] — Langsmith parity considerations
- [[2026-03-31-claude-sdk-alignment-effort-summary]] — Claude Agent SDK best-practices alignment

## Open Questions

These are observations from the inventory, not recommendations — they're flagged so the follow-up plan can decide whether to act on them.

1. **`RemoteTrigger` contract is half-wired.** Director's Step 1 documents the priority-1 path, but no producer in the repo creates a Routine that exercises it. Closing this gap would let external systems (CI, alerting, Slack) fire Director directly without going through GitHub Issues.
2. **`PushNotification` is bypassed.** The ntfy bridge does the work, but Claude Code's native `PushNotification` tool would integrate with the Remote Control mobile app and not require a self-hosted ntfy server.
3. **Cloud Routines vs `launchd`.** All durable schedules in ralph-hero use `launchd` (macOS-specific, host-pinned). Routines (cloud) would be cross-platform, survive host downtime, and integrate with GitHub webhooks natively. Trade-off: cloud Routines consume subscription usage and require a claude.ai account.
4. **`Monitor` tool is allowlisted but not invoked.** `finish-agent` has `Monitor` in its allowlist (per GH-0760 plan) but the skill body still polls. The wire is hot, the switch isn't flipped.
5. **GitHub webhook → trigger label flow is missing.** A PR opened by a non-bot user could automatically get a `trigger:builders` label posted by a Routine, putting it on Director's queue without manual action.
6. **`TaskCreate` / `TaskList` usage is sparse.** Per-phase agents track their work in markdown plan files rather than the harness's TaskList. This is intentional for plan auditability but limits cross-session work tracking. Agent teams (experimental) would unlock `SendMessage` for inter-agent coordination.
7. **`/schedule durable: true` is unused.** Watcher and caretaker heartbeats survive only the current session. If the user kills the session, the heartbeat stops until they restart. `launchd` is the workaround, but it diverges from Claude Code's native scheduling.
8. **No alert-driven autopilot trigger.** GCP Cloud Monitoring alerts arrive via `monitoring-bridge` and create GitHub Issues. But autopilot only runs when invoked. A high-severity alert should ideally fire autopilot directly, not just add an issue and wait.
