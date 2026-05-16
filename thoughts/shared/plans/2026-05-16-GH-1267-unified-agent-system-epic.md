---
date: 2026-05-16
status: complete
type: plan-of-plans
tags: [director, agent-teams, watchers, soul, ios-remote, self-healing, dream-loop]
github_issue: 1267
github_issues: [1267]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1267
primary_issue: 1267
child_plans:
  - thoughts/shared/plans/2026-05-16-GH-1268-soul-framework-sessionstart-hook.md
  - thoughts/shared/plans/2026-05-16-GH-1269-director-skill.md
  - thoughts/shared/plans/2026-05-16-GH-1270-watcher-team-entrypoint.md
  - thoughts/shared/plans/2026-05-16-GH-1271-event-shims.md
  - thoughts/shared/plans/2026-05-16-GH-1272-self-healing-closure.md
  - thoughts/shared/plans/2026-05-16-GH-1273-scout-scheduling.md
  - thoughts/shared/plans/2026-05-16-GH-1274-caretaker-team-entrypoint.md
  - thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md
---

# Unified Agent System (Director → Teams → Operators + iOS Remote Control) — Plan of Plans

## Prior Work

- builds_on:: [[2026-05-16-unified-agent-system-architecture]]
- builds_on:: [[2026-04-16-GH-0761-dream-loop]]
- builds_on:: [[2026-05-15-cos-phase3-morning-brief-ntfy]]

## Strategic Context

**Problem space.** Approximately 95% of a Director → Teams → Operators agent system already exists in this workspace: ralph-hero (builders), ralph-knowledge (memory), ralph-playwright (scouts), dream-loop (memorykeepers), gcp-telemetry + ralph-debug-collate (proto-watchers), and ralph-hero's hygiene/triage/postmortem/report/trends (proto-caretakers). The pieces are not wired into a single event-driven loop, do not have durable per-team personality, and cannot be driven end-to-end from the Claude iOS app on the user's phone while the work executes on the Mac.

**Why this exists.** The user wants to *live in the iOS app* and supervise an autonomous agent organization from their phone: review a postmortem on the train, approve a plan from a coffee shop, trigger a Watcher sweep by adding a label, receive ntfy push when the Scout team finds an a11y violation. The Mac is the substrate; iOS is the cockpit. Today, every non-builder event class (alerts, traces, dream-loop reflections, scout findings) requires a human to hand-translate into a GitHub issue before the system can act. The Director, the Watcher entrypoint, the SOUL files, and the iOS remote-control plumbing are the missing seams.

**What success looks like.** When this epic completes:

- A single **Director** skill — invoked by `/schedule` cron from iOS or by webhook — reads `next_actions`, classifies the next event, and dispatches the correct team (Builders / Watchers / Scouts / Memorykeepers / Caretakers). Autopilot becomes a special case of Director.
- Five teams each have a single entrypoint orchestrator and a **`SOUL.md`** that gives them durable voice (paranoid Watchers, mischievous Scouts, librarian Memorykeepers, quiet Caretakers, thorough Builders). A SessionStart hook loads the SOUL into the orchestrator's context.
- Non-issue events (Cloud Monitoring alerts, Langfuse error spikes, dream-loop "recurring failure" clusters) **auto-land on the Projects V2 board** as labeled draft issues. No human in the loop for the ingestion side.
- The Mac-side feedback loop closes: merge → postmortem → `knowledge_record_outcome` → next dream-loop ingests it → reflect.py clusters it → if recurring, Director files a `process-improvement` issue → curate weekly promotes the clean reflection to the wiki tier → next session's SessionStart loads it via `knowledge_recall`. Two small new components only (`outcome-recorder` ~30 LOC, cluster-classifier in `reflect.py` ~50 LOC).
- **iOS remote control is first-class.** Every team entrypoint is invokable by editing an issue body/label/comment from the iOS app (e.g., adding `trigger:watch` causes the Director's next tick to dispatch Watchers). The Director skill accepts `RemoteTrigger` tool inputs. Each team's heartbeat is a `/schedule`-managed routine so iOS can list/edit/disable them. `cos` (the phone-friendly status skill) summarizes all five teams' state. PRs, postmortems, and scout reports are pushed to Google Drive via `gdrive-push` so iOS can open them without VPN. Background sessions emit `result:` / `needs input:` markers so iOS sees state at a glance. ntfy push notifications fire on completion of long-running team sessions.

**Non-goals:** No new runtime (no OpenClaw gateway, no message broker, no separate web UI). The GitHub Projects V2 bus stays the single source of truth. gemma-lab stays the local model. No new cloud LLM dependencies beyond what already exists (Vertex via Langfuse harness; Anthropic via the `claude-api` skill).

## Shared Constraints

The following constraints apply verbatim to every feature plan derived from this epic. Each feature plan inherits this section.

1. **No new runtime layers.** GitHub Projects V2 (via the `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` MCP tools) is the only event bus. ralph-knowledge SQLite is the only durable memory store. Do not introduce a message broker, a separate orchestration daemon, or an additional database. Webhook → issue bridges are allowed if and only if they terminate in a `create_issue` call on the existing board.

2. **Skill / agent surface conventions.** New orchestrator skills live under `plugin/ralph-hero/skills/<skill-name>/SKILL.md`. New subagents live under `plugin/ralph-hero/agents/<agent-name>.md`. Follow the existing frontmatter shape (`description`, `argument-hint`, `context: inline`, `hooks`, `allowed-tools`). Mirror the patterns in `hero/SKILL.md`, `autopilot/SKILL.md`, `ralph-debug-collate/SKILL.md`.

3. **SOUL files use a fixed schema.** Each team's SOUL lives at `plugin/ralph-hero/skills/<team-entrypoint>/SOUL.md` with frontmatter `team:`, `voice:`, `refuses: [list]` and a markdown body covering "How you talk" + at least one **Bad / Good** example exchange. Length target: ~150-250 words of body prose. Loaded into the orchestrator's system prompt by a SessionStart hook (single shared hook script, not five copies).

4. **Style inheritance.** All teams inherit `plugin/ralph-hero/skills/STYLE.md` (the global tone rules) and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (how to post artifact links to issues). SOUL adds personality; it never overrides STYLE. When the two conflict, STYLE wins for mechanics (file paths, link format, comment headers); SOUL wins for voice and refusals.

5. **iOS-friendly artifacts.** Every long-running team session must emit `result:` and `needs input:` markers so the harness's background-session extractor surfaces state to iOS. Any artifact larger than one screen (PRs, postmortems, scout reports, plan-of-plans) must be pushable to Google Drive via the existing `gdrive-push` skill — features that produce such artifacts must call it (or accept a `--push-drive` flag) so iOS users can open links without VPN. ntfy push notifications are the canonical "session done" channel.

6. **Remote-trigger contract.** Director (and any team entrypoint that wants to be iOS-invokable) accepts events from three sources, in this priority order: (a) `RemoteTrigger` tool inputs if the harness surfaces them; (b) GitHub issue labels matching `trigger:<team>` (e.g., `trigger:watch`, `trigger:scout`, `trigger:caretake`) — adding the label is the remote-trigger gesture, the Director's tick consumes it and removes the label after dispatch; (c) `/schedule` cron ticks for heartbeats. Direct CLI invocation remains available but is not the remote path.

7. **Outcome recording is automatic.** Every team's terminal state (merge, postmortem-filed, alert-triaged, scout-report-posted, curate-promotion) writes a `knowledge_record_outcome` entry via the ralph-knowledge MCP. The outcome captures decision, result, and a trace ID or commit SHA. This is non-optional — terminal handlers that don't record outcomes will fail review.

8. **Verification tooling per feature.** Each child feature plan must enumerate concrete verification commands in its phase success criteria. Discovered tooling for this repo:
   - **Lint / format**: `npm run lint` (TypeScript) and `npm run format`; Python is uv-managed (`cd scripts/dream && uv run ruff check .`).
   - **Type-check**: `npm run typecheck` (the ralph-knowledge MCP plugin lives at `plugin/ralph-knowledge` and has its own `tsconfig.json`).
   - **Tests**: `npm test` for plugin code; `cd scripts/dream && uv run pytest` for dream-loop scripts.
   - **Skill smoke tests**: `plugin/ralph-hero/scripts/cos/smoke.sh` and `self-improve-smoke.sh` patterns — copy this shape for new orchestrator skills.
   - **Dream-loop verification**: the commands in `~/projects/CLAUDE.md` ("Verification commands" block).

9. **Atomicity for child plans.** Features produced from this plan-of-plans must decompose into atomics of size XS or S only. Anything that emerges as M during planning is a sign the feature itself should be re-split. The whole point of this epic is wiring, not new platform.

10. **No OpenClaw runtime.** Borrow conventions (SOUL.md, event-class taxonomy) only. Do not install an OpenClaw gateway, do not adopt the 53 built-in skills, do not stand up a local message bus. This is repeated here because it is the single most likely scope-creep failure mode.

## Feature Decomposition

> **Tip on heading conventions.** When `ralph-split` (Step 6 below) creates child issues, this plan-of-plans will be edited in Step 8 to back-fill each feature heading with `### Feature X: <name> (GH-NNNN)`. The `GH-NNNN` token is load-bearing — `ralph-plan` Step 3.5 uses it to detect parent-plan reuse via mapping rule 1.2 and skip child plan generation when the parent phase already has File ownership + Automated Verification entries. Until those child numbers are assigned, each feature is named only.

### Feature A: SOUL framework + SessionStart hook (GH-1268)
- **depends_on**: null
- **produces**:
  - `plugin/ralph-hero/skills/shared/soul-schema.md` — the canonical SOUL.md frontmatter + body conventions, referenced by every team feature
  - `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` — a single SessionStart hook script that reads `$RALPH_COMMAND`, locates the matching `SOUL.md` under `plugin/ralph-hero/skills/<command>/SOUL.md`, and injects it into the orchestrator's system prompt
  - SOUL files for all five teams: `builders/SOUL.md` (next to `hero/SKILL.md`), `watch/SOUL.md` (Feature C target dir, stub here), `scouts/SOUL.md`, `memorykeepers/SOUL.md`, `caretakers/SOUL.md`. Stubs are fine when the team entrypoint doesn't yet exist — Feature C and Feature G fill in the bodies.
  - One smoke test that asserts the hook script loads a SOUL when `$RALPH_COMMAND` is set and is a no-op otherwise.
- **Estimated atomics**: 4 — (1) schema doc; (2) hook script; (3) five SOUL.md files; (4) hook smoke test

### Feature B: Director skill (GH-1269)
- **depends_on**: null
- **produces**:
  - `plugin/ralph-hero/skills/director/SKILL.md` — new orchestrator that reads `next_actions`, classifies the top event into one of {builders, watchers, scouts, memorykeepers, caretakers}, dispatches via `Skill()`, then returns. Replaces the hard-coded `hero` dispatch in `autopilot`.
  - `plugin/ralph-hero/skills/director/SOUL.md` — Director's own SOUL (terse, decisive, "I do not implement, I dispatch")
  - Event-class taxonomy doc at `plugin/ralph-hero/skills/director/event-classes.md` — the table mapping issue labels / workflow states / `trigger:*` labels to teams
  - Remote-trigger handler: accepts `RemoteTrigger` tool inputs and `trigger:<team>` labels (consumes the label after dispatch)
  - `autopilot/SKILL.md` updated to delegate to Director instead of directly to `hero`
- **consumes**: SOUL framework (Feature A)
- **Estimated atomics**: 5 — (1) Director SKILL.md skeleton; (2) event-class taxonomy; (3) classifier logic; (4) `trigger:*` label handler; (5) autopilot rewrite to delegate

### Feature C: Watcher team entrypoint (GH-1270)
- **depends_on**: [GH-1268]
- **produces**:
  - `plugin/ralph-hero/skills/watch/SKILL.md` — single orchestrator that wraps `gcp-incident-triage`, `ralph-debug-collate`, and a new `log-reader` subagent (LQL queries via gcp-telemetry conventions)
  - `plugin/ralph-hero/skills/watch/SOUL.md` — paranoid-but-disciplined voice, refuses claims without trace IDs / LQL queries
  - `plugin/ralph-hero/agents/log-reader.md` — subagent that wraps gcp-telemetry log queries (read-only, no auto-remediation)
  - `plugin/ralph-hero/agents/sre-fixit.md` — strictly allowlisted autoremediation subagent (replica bumps, node drains, pod restarts only)
  - `/schedule`-installable heartbeat: every 15 min by default, configurable
- **consumes**: SOUL framework + schema from Feature A
- **Estimated atomics**: 5 — (1) watch SKILL.md skeleton; (2) watch SOUL.md; (3) log-reader agent; (4) sre-fixit agent with allowlist; (5) heartbeat schedule registration

### Feature D: Event shims (alerts / langfuse / dream-loop → board) (GH-1271)
- **depends_on**: [GH-1270, GH-1269]
- **produces**:
  - Cloud Monitoring → issue bridge: a small Pub/Sub subscriber (Cloud Run job or launchd-scheduled pull) that normalizes monitoring alerts into `create_issue` calls with label `watcher-auto`
  - Langfuse → issue bridge: promote `ralph-debug-collate` from on-demand to a scheduled run inside the Watcher heartbeat (live behind the watch entrypoint, not standalone)
  - Dream-loop → issue bridge: add a cluster-classifier step to `scripts/dream/reflect.py` that, when a cluster size exceeds threshold AND raw memories share `tool_use_error` or `verdict: BLOCKED` signals, emits a `process-improvement` draft issue tagged for the responsible team
  - Director event-class taxonomy updated (Feature B) to recognize `watcher-auto` and `process-improvement` labels
- **consumes**: Watcher entrypoint (Feature C) for runtime context; Director taxonomy (Feature B) for routing labels
- **Estimated atomics**: 4 — (1) Cloud Monitoring Pub/Sub subscriber; (2) Langfuse scheduled-run wiring; (3) reflect.py cluster classifier; (4) Director taxonomy patch for new labels

### Feature E: Self-healing closure (outcome-recorder + reflection → improvement issue) (GH-1272)
- **depends_on**: [GH-1269]
- **produces**:
  - `outcome-recorder` — a ~30 LOC wrapper invoked by `ralph-postmortem`, `ralph-merge`, and any other terminal handler. Maps the handler's output (decision, result, trace_id or commit SHA) to a `knowledge_record_outcome` MCP call.
  - Updates to `ralph-postmortem`, `ralph-merge`, `ralph-pr`, and `ralph-val` exit points to call `outcome-recorder`
  - Cluster-classifier integration with Director: when `reflect.py` (Feature D) emits a `process-improvement` issue, the Director's next tick recognizes it via the taxonomy and dispatches the right team
- **consumes**: Director taxonomy (Feature B). Note: Feature D adds the reflect.py cluster classifier itself; Feature E wires its output through Director and adds the outcome-recorder on the upstream side.
- **Estimated atomics**: 3 — (1) outcome-recorder wrapper; (2) terminal-handler patches (one per skill); (3) integration test asserting merge → outcome row → next-night dream-loop ingestion

### Feature F: Scout scheduling (on-PR + nightly) (GH-1273)
- **depends_on**: [GH-1268]
- **produces**:
  - `plugin/ralph-hero/skills/scouts/SOUL.md` — curious-mischievous voice
  - `/scout-on-pr` hook: `pr-agent` posts a comment with a `/scout` trigger when the PR touches a UI directory (heuristic: changed files match `**/*.tsx`, `**/*.svelte`, `**/components/**`, etc.); `merge-agent` waits for green Scout report before merging UI-touching PRs
  - Nightly Scout sweep registered as a `/schedule` routine — runs `/test-e2e` against the latest deployed build, posts findings as `scout-auto`-labeled issues
  - Director taxonomy update (Feature B) to recognize `scout-auto` label
- **consumes**: SOUL framework (Feature A); minor coordination with Director taxonomy (Feature B) — taxonomy edit is small enough to ship in Feature F itself rather than block on B's plan
- **Estimated atomics**: 4 — (1) scouts SOUL.md; (2) /scout-on-pr trigger comment from pr-agent; (3) merge-agent gate; (4) nightly schedule registration

### Feature G: Caretaker team entrypoint (GH-1274)
- **depends_on**: [GH-1268]
- **produces**:
  - `plugin/ralph-hero/skills/caretake/SKILL.md` — single orchestrator that bundles existing `ralph-triage`, `ralph-hygiene`, `ralph-unblock`, `ralph-postmortem`, `report`, and `trends` skills behind one entrypoint
  - `plugin/ralph-hero/skills/caretake/SOUL.md` — quiet-steward voice
  - Heartbeat schedule: hourly hygiene, daily report, weekly trends
- **consumes**: SOUL framework (Feature A)
- **Estimated atomics**: 3 — (1) caretake SKILL.md wrapper; (2) caretake SOUL.md; (3) heartbeat schedule registration

### Feature H: iOS remote-control integration (GH-1275)
- **depends_on**: [GH-1269, GH-1270, GH-1273, GH-1274]
- **produces**:
  - `cos` skill extended to summarize all five teams' state, not just builders (current cos covers builders only — extend the section list + add per-team status rollups)
  - ntfy push notification hooks on team-session completion (extends the existing pattern from `2026-05-15-cos-phase3-morning-brief-ntfy.md`)
  - `gdrive-push` integration for PRs, postmortems, and scout reports — each producing handler accepts a `--push-drive` flag (default on for iOS-mode invocations)
  - Documentation page `plugin/ralph-hero/skills/director/IOS-REMOTE.md` describing the full iOS workflow: how to trigger from labels, how to read `cos` summaries, how to receive ntfy pushes, how to open Drive artifacts. This doc is the user-facing "how do I drive this from my phone" reference.
- **consumes**: Director (Feature B) for remote-trigger dispatch; Watch (Feature C), Scouts (Feature F), Caretake (Feature G) entrypoints so cos can summarize them
- **Estimated atomics**: 4 — (1) cos five-team rollup; (2) ntfy completion hooks; (3) gdrive-push wiring on artifact producers; (4) IOS-REMOTE.md user doc

## Integration Strategy

**How features compose.**

1. **SOUL framework (Feature A) is the ground floor.** Every team feature (C, F, G) and Director (B) consumes the schema + SessionStart hook from A. A is intentionally tiny and zero-dependency so it unblocks the most parallel work.

2. **Director (Feature B) and Watcher entrypoint (Feature C) are the two structural beams.** B classifies events and routes to teams; C is the first new team and validates the dispatch contract. Once both exist, every other team feature (F, G) is a copy of the C pattern with a different SOUL and a different orchestrator body.

3. **Event shims (Feature D) and the self-healing closure (Feature E) ride on top of B+C.** D plugs non-issue events into the board so Director picks them up. E plugs terminal-handler outputs into ralph-knowledge so next-night dream-loop can learn from them. Together they close the cycle described in the research doc (merge → postmortem → outcome → dream → reflect → process-improvement issue → next tick).

4. **Scouts (F) and Caretakers (G) are sibling team wirings.** They depend only on A. Sequenced after B mostly so that the Director taxonomy patches they need (recognizing `scout-auto` and existing Caretake labels) can land in one direction. The taxonomy edits themselves are small enough that F and G ship them inline rather than gating on B.

5. **iOS remote-control (Feature H) is the integration finale.** It depends on B, C, F, and G existing so that `cos` has all five team states to summarize and so that ntfy + gdrive wiring has every producer to hook. H is intentionally the last wave — the work is all "polish the seams for the phone user" and benefits from every prior feature being landable on its own.

**Shared interfaces.** The two contracts that cross feature boundaries:

- **Team-orchestrator contract.** Each team entrypoint (`hero` for builders, `watch` for watchers, `scouts` for scouts, `caretake` for caretakers, plus dream-loop for memorykeepers) accepts a `--issue NNN` argument (or no argument for heartbeat mode), reads its SOUL via the SessionStart hook, runs its mission, emits `result:` / `needs input:` markers, calls `outcome-recorder` on terminal states, and returns. Director only ever invokes team orchestrators through this contract.
- **Director event-class table.** Lives at `plugin/ralph-hero/skills/director/event-classes.md`. Maps `(workflow_state, labels)` tuples to team names. Features D and F edit it to add their new labels (`watcher-auto`, `scout-auto`, `process-improvement`). Treat the table as the canonical schema — when a feature wants Director to recognize a new event class, it edits this file.

**Integration tests.** After Feature H lands, the end-to-end smoke is:

1. Add label `trigger:watch` to an arbitrary issue from iOS (via the GitHub mobile app or `gh issue edit` over SSH).
2. Director's next `/schedule` tick consumes the label, removes it, dispatches Watch.
3. Watch runs its mission, emits a `result:` line, calls `outcome-recorder`, and pushes its report to Drive.
4. ntfy fires a push notification to the iOS device.
5. iOS opens the Drive link, sees the report.

This smoke covers Features B + C + E + H simultaneously and is the recommended acceptance test for the epic.

**Deployment order.** Land features in the wave order below. After each wave, run the dream-loop manually (`dream-now`) so the next wave's planners can see learnings from the prior wave land in ralph-knowledge.

## Feature Sequencing

Feature execution order is derived from the `depends_on` graph in the Feature Decomposition above. Features with `depends_on: null` can be planned in parallel; features with explicit `depends_on` wait until the referenced feature's plan is complete before planning begins.

Implied waves (for human reading; the planner uses the graph, not the wave numbers):

- **Wave 1** (parallel — no deps): GH-1268 (Feature A: SOUL framework), GH-1269 (Feature B: Director skill)
- **Wave 2** (depends on Wave 1): GH-1270 (Feature C: Watcher — needs 1268), GH-1273 (Feature F: Scouts — needs 1268), GH-1274 (Feature G: Caretakers — needs 1268)
- **Wave 3** (depends on Wave 2): GH-1271 (Feature D: Event shims — needs 1270, 1269), GH-1272 (Feature E: Self-healing — needs 1269)
- **Wave 4** (depends on Waves 1-3): GH-1275 (Feature H: iOS remote control — needs 1269, 1270, 1273, 1274)

After committing the plan-of-plans document, sync feature-level `depends_on` edges to GitHub `blockedBy` relationships using the sync plan graph tool. After Step 6 (ralph-split creates feature children), this section is edited in Step 8 to back-fill GH issue numbers next to each feature name.

## What We're NOT Doing

- Installing OpenClaw as a runtime (borrow SOUL convention only — repeated for emphasis).
- Replacing the GitHub Projects V2 bus with a message broker, web UI, or separate orchestration daemon.
- Migrating to a cloud LLM as the primary model. gemma-lab on `:8000` stays the local default; Vertex (via Langfuse harness) and Anthropic (via `claude-api` skill) stay opt-in.
- Building a separate iOS app. The Claude iOS app + Obsidian on `thoughts/` are enough; the work is making the existing iOS Claude app's view of the system rich enough.
- Replacing or rewriting any existing operator skill. Every change is wiring (orchestrator skills, hooks, schedule registrations, small bridge scripts). The only genuinely new code is `outcome-recorder` (~30 LOC) and the cluster-classifier in `reflect.py` (~50 LOC).
- Adding cross-team RPC. Teams communicate only through the board — they post issues, comments, and labels; the Director routes the next event from the board. No direct team-to-team calls.
- Auto-remediation outside the `sre-fixit` allowlist (replica bumps, node drains, pod restarts). Anything beyond that allowlist routes to Human Needed.
- Per-machine state outside `~/.ralph-hero/` and `~/projects/thoughts/`. No new runtime state directories, no new daemons writing to `/var`.
