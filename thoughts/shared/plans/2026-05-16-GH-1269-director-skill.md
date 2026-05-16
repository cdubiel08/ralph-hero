---
date: 2026-05-16
status: draft
type: plan
github_issue: 1269
github_issues: [1269]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1269
primary_issue: 1269
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [director, agent-teams, orchestrator, event-classification, remote-trigger]
---

# Director Skill + Event Classifier — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-16-unified-agent-system-architecture]]

## Overview

Single-issue plan for GH-1269 (Feature B of the Unified Agent System epic). Builds the Director orchestrator skill that reads `next_actions`, classifies the top event, and dispatches the correct team. Replaces autopilot's hard-coded `hero` dispatch with team-aware routing. Adds an iOS-friendly remote-trigger handler that consumes `trigger:<team>` issue labels.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1269 | Feature B: Director skill + event classifier | S |

## Shared Constraints

Inherited verbatim from parent plan-of-plans (`2026-05-16-GH-1267-unified-agent-system-epic.md`):

1. **No new runtime layers.** GitHub Projects V2 (via `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` MCP tools) is the only event bus. ralph-knowledge SQLite is the only durable memory store. No new daemons, brokers, or databases. Webhook → issue bridges are allowed if they terminate in `create_issue`.

2. **Skill / agent surface conventions.** New orchestrator skills live under `plugin/ralph-hero/skills/<skill-name>/SKILL.md`. Follow frontmatter shape: `description`, `argument-hint`, `context: inline`, `hooks`, `allowed-tools`. Mirror `hero/SKILL.md`, `autopilot/SKILL.md`, `ralph-debug-collate/SKILL.md`.

3. **SOUL files use a fixed schema.** Director's SOUL lives at `plugin/ralph-hero/skills/director/SOUL.md` with frontmatter `team:`, `voice:`, `refuses: [list]` and a markdown body (~150-250 words) covering "How you talk" + a Bad/Good example exchange. Loaded into the orchestrator's system prompt via the shared SessionStart hook from Feature A (GH-1268).

4. **Style inheritance.** Director inherits `plugin/ralph-hero/skills/STYLE.md` and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`. SOUL adds personality; STYLE wins for mechanics, SOUL wins for voice/refusals.

5. **iOS-friendly artifacts.** Director sessions emit `result:` and `needs input:` markers. Director itself produces no artifacts larger than one screen, so `gdrive-push` is not required here.

6. **Remote-trigger contract.** Director accepts events from three sources in priority order: (a) `RemoteTrigger` tool inputs if surfaced by the harness; (b) GitHub issue labels matching `trigger:<team>` (consumed/removed after dispatch); (c) `/schedule` cron ticks for heartbeats. Direct CLI invocation remains available.

7. **Outcome recording is automatic.** Director itself is a dispatcher and does not reach a terminal state per event — outcome recording is the responsibility of each dispatched team. Director records its own meta-outcomes (e.g., "dispatched watch for issue 4242") only when invoked via `/schedule` heartbeat (Feature E owns the wrapper).

8. **Verification tooling.** Lint: `npm run lint`. Type-check: `npm run typecheck`. Tests: `npm test` (for plugin code). Skill smoke tests follow `plugin/ralph-hero/scripts/cos/smoke.sh` pattern.

9. **Atomicity.** This is an S issue; phase decomposition is for the planner's clarity. No child issue creation needed.

10. **No OpenClaw runtime.** Borrow event-class taxonomy convention only. No gateway, no message bus, no new daemons.

**Feature-specific constraints (B-only):**

- Director MUST NOT hard-code team dispatch. The event-class taxonomy is the single source of truth; Director's classifier logic is a lookup against that table.
- Director MUST reuse `ralph_hero__next_actions` rather than re-implementing ranking.
- `event-classes.md` MUST be designed extension-friendly: Features D and F will edit it later to add `watcher-auto`, `scout-auto`, `process-improvement` rows.
- Director SKILL.md MUST declare `Skill` in `allowed-tools` (it dispatches via `Skill()`) and `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue` (to consume `trigger:<team>` labels after dispatch).

## Current State Analysis

**Existing orchestration.** `plugin/ralph-hero/skills/autopilot/SKILL.md` is a 65-line wrapper around `/loop /ralph-hero:hero`. It hard-codes hero dispatch — every non-terminal issue gets routed to the builder team. There is no concept of multiple teams or event classes; the queue is treated as homogeneous.

**Existing ranking.** `ralph_hero__next_actions` (MCP tool registered in `mcp-server/src/tools/`) ranks work and marks one entry `recommended: true`. Already used by `/hello` for narrative orientation. Returns issue metadata including `workflowState`, `labels`, `priority`, `estimate`.

**Existing label conventions.** The issue body for GH-1269 enumerates three label families that will exist post-epic: `trigger:<team>` (remote-trigger), `watcher-auto` (Cloud Monitoring → board), `scout-auto` (Scout findings), `process-improvement` (dream-loop cluster classifier output). Only `trigger:<team>` is in scope for this feature; the others get table entries but no live producers until Features D and F.

**Existing skill patterns.** Mirror `autopilot/SKILL.md` for: SessionStart hook setting `RALPH_COMMAND=director`, `context: inline`, terse skill body, `Skill` in allowed-tools. Mirror `hero/SKILL.md` for: rich allowed-tools list including MCP tools. Mirror `ralph-debug-collate/SKILL.md` for: preflight → action → summarize workflow shape.

**Existing SessionStart pattern for SOUL.** Feature A (GH-1268) ships `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` which reads `$RALPH_COMMAND` and injects the matching `<command>/SOUL.md` into the system prompt. Director's SOUL is loaded automatically once `RALPH_COMMAND=director` is set.

## Desired End State

After this plan executes:

- `/ralph-hero:director` is invokable directly (e.g., `Skill("ralph-hero:director", args="")` or `Skill("ralph-hero:director", args="--issue 4242")`).
- `/ralph-hero:autopilot` delegates to Director, not hero — Director picks the team per event.
- Adding label `trigger:watch` to any issue causes Director's next tick to dispatch the Watch team for that issue and remove the label.
- `event-classes.md` is the canonical mapping; Features D and F can extend it with one-row PR edits.
- Director's SOUL is loaded via the shared SessionStart hook from Feature A.

### Verification

- [ ] `Skill("ralph-hero:director", args="")` runs end-to-end against a populated board and dispatches the correct team for the top-ranked event
- [ ] Adding label `trigger:scouts` to an issue causes the next director tick to dispatch scouts and remove the label
- [ ] `Skill("ralph-hero:autopilot", args="")` no longer references hero directly; the `Skill("loop", ...)` body invokes Director
- [ ] All Director allowed-tools are present in frontmatter and exercised by the skill body
- [ ] `event-classes.md` enumerates all current event classes with no `TODO` rows

## What We're NOT Doing

- Implementing the Watch / Scouts / Caretake team entrypoints themselves (Features C, F, G).
- Adding `watcher-auto` or `scout-auto` rows that point to **live producers** — the table includes the rows pointing to teams, but the producers ship in Features D and F.
- iOS-specific UI work, `cos` extensions, ntfy hooks, or `gdrive-push` integration (Feature H).
- Outcome recording wiring (Feature E owns `outcome-recorder`).
- Replacing `next_actions` ranking — Director consumes it as a black box.
- Building a fallback when `RemoteTrigger` is absent — the shared constraint already defines a label-based fallback; Director implements the label path as primary and the `RemoteTrigger` path opportunistically.

## Implementation Approach

Single phase, five tasks. Order: (1) write `event-classes.md` first since it's the schema other tasks reference; (2) write Director's `SKILL.md` skeleton wiring the SessionStart hook + allowed-tools; (3) add classifier logic that reads `next_actions` + the taxonomy; (4) add `trigger:<team>` label handler with consumption via `save_issue`; (5) rewrite `autopilot/SKILL.md` to delegate to Director. Task 1.6 adds Director's SOUL.md (parallel with tasks 1.2–1.5 once the schema from Feature A lands).

The phase intentionally avoids depending on Feature A's SOUL framework landing before this plan starts. Director can ship its own SOUL.md as a stub initially; once Feature A's `load-team-soul.sh` hook lands, Director's SOUL loads automatically with no further edits.

**Phase dependency annotations:** Phase 1 has `depends_on: null` at the plan level. Within the phase, tasks have inter-task `depends_on` annotations.

---

## Phase 1: Director skill + event classifier (GH-1269)

- **depends_on**: null

### Overview

Build the Director orchestrator: a single skill at `plugin/ralph-hero/skills/director/` containing `SKILL.md`, `SOUL.md`, and `event-classes.md`. Update `autopilot/SKILL.md` to delegate. The skill reads `next_actions`, classifies the top event via the taxonomy table, dispatches via `Skill()`, and consumes `trigger:<team>` labels.

### Tasks

#### Task 1.1: Write event-classes.md taxonomy table
- **files**: `plugin/ralph-hero/skills/director/event-classes.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/director/event-classes.md`
  - [ ] Contains a markdown table with columns: `workflow_state`, `labels`, `team`, `notes`
  - [ ] Includes rows for: `Backlog` → triage (caretakers), `Research Needed`/`Research in Progress`/`Ready for Plan`/`Plan in Progress`/`Plan in Review`/`In Progress`/`In Review` → builders, `Human Needed` → unblock (caretakers), any state + `trigger:watch` → watchers, any state + `trigger:scouts` → scouts, any state + `trigger:caretake` → caretakers, any state + `trigger:memorykeepers` → memorykeepers, any state + `watcher-auto` → watchers (placeholder, producer ships in Feature D), any state + `scout-auto` → scouts (placeholder, producer ships in Feature F), any state + `process-improvement` → caretakers (placeholder, producer ships in Feature D)
  - [ ] Document includes a one-paragraph header explaining that this file is the canonical schema and that Features D/F edit it via PR to add new event classes
  - [ ] No `TODO` rows — placeholders are explicitly marked as "label exists, producer pending"

#### Task 1.2: Write Director SKILL.md skeleton
- **files**: `plugin/ralph-hero/skills/director/SKILL.md` (create), `plugin/ralph-hero/skills/autopilot/SKILL.md` (read), `plugin/ralph-hero/skills/hero/SKILL.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter includes: `description` (one sentence about classifying + dispatching events), `argument-hint: "[optional: --issue NNN]"`, `context: inline`, SessionStart hook running `set-skill-env.sh RALPH_COMMAND=director`
  - [ ] `allowed-tools` includes at minimum: `Skill`, `Read`, `Bash`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues`, `ScheduleWakeup`
  - [ ] Configuration block at top resolves `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` via backtick directives, mirroring autopilot/hero
  - [ ] Skill body includes numbered Workflow section with at least: Step 1 (parse args + check for `--issue` override), Step 2 (read `next_actions` or fetch specific issue), Step 3 (classify via taxonomy), Step 4 (dispatch via `Skill()`), Step 5 (consume `trigger:<team>` label if present), Step 6 (emit `result:` marker)
  - [ ] Body explicitly references `event-classes.md` as the lookup source

#### Task 1.3: Classifier logic + dispatch
- **files**: `plugin/ralph-hero/skills/director/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Skill body Step 3 documents the classification algorithm: load `event-classes.md`, for the candidate issue evaluate `trigger:*` labels first (highest priority), then automation labels (`*-auto`, `process-improvement`), then `workflow_state`; first match wins
  - [ ] Skill body Step 4 documents dispatch via `Skill("<plugin>:<team-entrypoint>", args="--issue NNN")` with the team-entrypoint mapping: builders → `ralph-hero:hero`, watchers → `ralph-hero:watch` (note: ships in Feature C), scouts → `ralph-hero:scouts` (Feature F), memorykeepers → manual `dream-now` (no skill yet; Director emits `needs input:` marker), caretakers → `ralph-hero:caretake` (Feature G)
  - [ ] When the target team entrypoint does not yet exist (watchers/scouts/caretakers pre-Feature-C/F/G), Director emits `needs input: team <name> not yet implemented (Feature <X>); skipping dispatch` and continues
  - [ ] Skill body explicitly documents that Director does NOT implement work itself — it only classifies and dispatches; this matches the Director SOUL refusals

#### Task 1.4: trigger:<team> label handler
- **files**: `plugin/ralph-hero/skills/director/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Skill body Step 5 documents the label-consumption flow: after a successful dispatch driven by a `trigger:<team>` label, call `save_issue` with `labels: [<existing labels minus trigger:*>]` to remove the trigger label
  - [ ] Body explicitly handles the priority order from Shared Constraint #6: `RemoteTrigger` inputs > `trigger:<team>` label > `/schedule` heartbeat. Body documents how Director detects each source (RemoteTrigger via tool input shape; label via `get_issue` labels array; heartbeat via no explicit input)
  - [ ] Body documents that the label is removed **after** successful dispatch initiation, not after team completion (teams may run long; consumption is dispatch-edge-triggered)

#### Task 1.5: Director SOUL.md
- **files**: `plugin/ralph-hero/skills/director/SOUL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists with frontmatter `team: director`, `voice: terse-decisive`, `refuses: ["implementing work", "modifying files outside director/", "running team operators directly"]`
  - [ ] Body length 150-250 words covering "How you talk" (terse, declarative, dispatches don't editorialize) + one Bad/Good example exchange demonstrating: bad = Director starts implementing or explaining a team's job; good = Director classifies, dispatches, returns
  - [ ] Body includes the line: "I do not implement. I dispatch."
  - [ ] Loadable by Feature A's `load-team-soul.sh` hook when `$RALPH_COMMAND=director`

#### Task 1.6: Rewrite autopilot to delegate to Director
- **files**: `plugin/ralph-hero/skills/autopilot/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] The `Skill("loop", args="...")` body inside autopilot no longer says `Run /ralph-hero:hero on the next-most-important issue`
  - [ ] Replaced with: `Run /ralph-hero:director on the next-most-important event on the project queue. Director classifies the event and dispatches the correct team (builders / watchers / scouts / memorykeepers / caretakers).`
  - [ ] Continuation rule preserved verbatim (re-check queue, `ScheduleWakeup` cadence, queue-empty termination)
  - [ ] Trust language updated: "Trust Director's classification and team dispatch decisions" replaces "Trust hero's escalation decisions" — but the underlying contract (escalation surfaces via `Human Needed`, autopilot does no bookkeeping) is unchanged
  - [ ] No new env vars introduced; no new opt-in gates added — `RALPH_AUTOPILOT_ENABLE` remains the single switch
  - [ ] Configuration block at top still shows "Review mode (inherited by hero)" but adds a parallel line for Director: `Director skill: /ralph-hero:director` (no env var needed since Director itself is unconditional)

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run lint` — no new errors (Director files are markdown; lint runs against any TypeScript touched, which should be none)
- [ ] `npm run typecheck` — passes (no TypeScript modified; included as a guard that nothing accidentally broke)
- [ ] `Skill("ralph-hero:director", args="")` invokable in a fresh Claude Code session with no parse errors in the frontmatter
- [ ] Markdown frontmatter on all three new files (`SKILL.md`, `SOUL.md`, `event-classes.md`) parses as valid YAML (check via `head -20 <file>` for visual inspection, or any markdown frontmatter validator)
- [ ] Grep check: `grep -l "Run /ralph-hero:hero on the next" plugin/ralph-hero/skills/autopilot/SKILL.md` returns nothing (the old hero-direct invocation is gone)
- [ ] Grep check: `grep -l "/ralph-hero:director" plugin/ralph-hero/skills/autopilot/SKILL.md` returns the file (the new Director invocation is present)

#### Manual Verification:
- [ ] Add label `trigger:caretake` to a real "Backlog" issue in the project. Run `Skill("ralph-hero:director", args="")`. Confirm Director's output: (a) identifies the label, (b) maps it to `caretakers` team via taxonomy, (c) attempts dispatch (or emits `needs input: team caretake not yet implemented` since Feature G hasn't shipped), (d) removes the label via `save_issue`.
- [ ] Read Director's SOUL.md aloud — confirm the voice feels terse-decisive and the refusals list is enforceable.
- [ ] Read `event-classes.md` — confirm a non-author can predict which team will run for any (workflow_state, labels) tuple.
- [ ] Read updated `autopilot/SKILL.md` — confirm the delegation handoff is clear and the opt-in gate semantics are preserved.

**Creates for next phase**: N/A — this is a single-phase plan. Downstream features that consume Director's output:
- Feature C (Watch, GH-1270): Director dispatches `Skill("ralph-hero:watch", ...)`; Feature C ships that entrypoint
- Feature F (Scouts, GH-1273): Director dispatches `Skill("ralph-hero:scouts", ...)`; Feature F ships that entrypoint + adds `scout-auto` taxonomy row
- Feature G (Caretake, GH-1274): Director dispatches `Skill("ralph-hero:caretake", ...)`; Feature G ships that entrypoint
- Feature D (Event shims, GH-1271): adds `watcher-auto` and `process-improvement` taxonomy rows
- Feature H (iOS remote, GH-1275): documents the `trigger:<team>` workflow in `IOS-REMOTE.md`

---

## Integration Testing

End-to-end smoke (manual, runnable after Feature C ships):

- [ ] Add `trigger:watch` label to a sample issue
- [ ] Run `Skill("ralph-hero:autopilot", args="")` with `RALPH_AUTOPILOT_ENABLE=true`
- [ ] Confirm autopilot's first `/loop` tick invokes Director, Director identifies the labeled issue from `next_actions`, classifies as watchers, dispatches via `Skill("ralph-hero:watch", ...)`, and removes the label
- [ ] Confirm Watch team's output appears in the conversation
- [ ] Confirm the label is gone from the issue after the dispatch edge

Pre-Feature-C smoke (runnable today):

- [ ] Add `trigger:builders` label to a sample issue
- [ ] Run `Skill("ralph-hero:director", args="")`
- [ ] Confirm Director dispatches `Skill("ralph-hero:hero", args="--issue NNN")` and removes the label

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1267
- This issue: https://github.com/cdubiel08/ralph-hero/issues/1269
- Plan of plans: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
- Sibling feature (Feature A): https://github.com/cdubiel08/ralph-hero/issues/1268
- Existing patterns:
  - `plugin/ralph-hero/skills/autopilot/SKILL.md`
  - `plugin/ralph-hero/skills/hero/SKILL.md`
  - `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md`
- MCP tool reference: `ralph_hero__next_actions` (registered in `mcp-server/src/tools/`)
- SessionStart hook reference (ships in Feature A): `plugin/ralph-hero/hooks/scripts/load-team-soul.sh`
