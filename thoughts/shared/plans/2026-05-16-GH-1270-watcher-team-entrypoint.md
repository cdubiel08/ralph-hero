---
date: 2026-05-16
status: draft
type: plan
github_issue: 1270
github_issues: [1270]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1270
primary_issue: 1270
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [watchers, soul, gcp-incident-triage, debug-collate, heartbeat, sre-fixit]
---

# Watcher Team Entrypoint (GH-1270) — Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-16-unified-agent-system-architecture]]
- builds_on:: [[2026-05-15-cos-phase3-morning-brief-ntfy]]

## Overview

Feature C of the Unified Agent System epic. Wires the existing `gcp-incident-triage` skill, the existing `ralph-debug-collate` skill, and two new subagents (`log-reader`, `sre-fixit`) behind a single Watcher team entrypoint that obeys the team-orchestrator contract defined by the parent plan-of-plans.

| Phase | Description | Files (new) | Estimate |
|-------|-------------|-------------|----------|
| 1 | `watch/SOUL.md` — replace Feature A stub with full body | `plugin/ralph-hero/skills/watch/SOUL.md` | XS |
| 2 | `log-reader` subagent (read-only LQL/log-query wrapper) | `plugin/ralph-hero/agents/log-reader.md` | XS |
| 3 | `sre-fixit` subagent (allowlisted autoremediation) | `plugin/ralph-hero/agents/sre-fixit.md` | XS |
| 4 | `watch/SKILL.md` — orchestrator wiring all of the above | `plugin/ralph-hero/skills/watch/SKILL.md` | S |
| 5 | Heartbeat registration doc + smoke test | `plugin/ralph-hero/scripts/watch/smoke.sh`, `plugin/ralph-hero/skills/watch/HEARTBEAT.md` | XS |

**Why grouped**: All five phases co-produce one cohesive Watcher entrypoint. Phases 1–3 are independent and produce artifacts that Phase 4 imports; Phase 5 closes the loop with the heartbeat registration command and smoke test. Splitting further would fragment the SessionStart-hook → SOUL → orchestrator → subagent chain across multiple PRs without testable intermediate states.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`2026-05-16-GH-1267-unified-agent-system-epic.md` § Shared Constraints):

1. **No new runtime layers.** GitHub Projects V2 is the only event bus; ralph-knowledge SQLite is the only durable memory store. Watcher must dispatch through `Skill()` calls + MCP tools — no new daemon, broker, or DB.
2. **Skill / agent surface conventions.** `plugin/ralph-hero/skills/watch/SKILL.md` follows the autopilot/hero frontmatter shape (`description`, `argument-hint`, `context`, `hooks`, `allowed-tools`). Subagents go under `plugin/ralph-hero/agents/<name>.md` with the standard `name`, `description`, `model`, `tools`, `skills` shape — never `hooks`, `mcpServers`, or `permissionMode`.
3. **SOUL files use a fixed schema** (defined by Feature A in `plugin/ralph-hero/skills/shared/soul-schema.md`): frontmatter `team:`, `voice:`, `refuses: [list]`; body covers "How you talk" + at least one Bad/Good exchange; target length 150–250 words of body prose.
4. **Style inheritance.** Watcher inherits `plugin/ralph-hero/skills/STYLE.md` (mechanics) and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (comment headers). SOUL adds personality only.
5. **iOS-friendly artifacts.** Watch sessions emit `result:` and `needs input:` markers. Watcher reports are pushable via `gdrive-push` when invoked with `--push-drive`.
6. **Remote-trigger contract.** Director (Feature B) receives `trigger:watch` labels and dispatches Watch. Watch itself accepts `--issue NNN` (direct) or no arg (heartbeat). The label-consumption logic lives in Director, not here.
7. **Outcome recording is automatic.** On terminal states (alert triaged, debug-collate filed, sre-fixit applied), Watch calls `outcome-recorder`. **Feature E (GH-1272) builds the actual `outcome-recorder` wrapper** — when this feature ships before E, every terminal handler must include a `# TODO(GH-1272): wire outcome-recorder` stub adjacent to the terminal log line. The TODO comment is non-optional: it is the trail Feature E follows when wiring.
8. **Verification tooling per feature.** For this skill (markdown + bash + agent files, no TS/JS source changes), the relevant checks are:
   - `bash -n plugin/ralph-hero/scripts/watch/smoke.sh` — syntax check
   - `plugin/ralph-hero/scripts/watch/smoke.sh` — run the smoke
   - Frontmatter YAML validity for each new `*.md` (`python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]).read().split("---")[1])'`)
   - Plugin-wide: `cd plugin/ralph-hero/mcp-server && npm run build` (no source changed — should remain green)
9. **Atomicity for child plans.** Every phase below is XS or S. Phase 4 (`watch/SKILL.md`) is the only S; everything else is XS.
10. **No OpenClaw runtime.** SOUL convention is borrowed; nothing is installed. Subagents are pure agent `.md` files invoked via `Agent()`, not a separate process.

### Feature-specific constraints

11. **Dependency on Feature A is hard.** This feature consumes `plugin/ralph-hero/skills/shared/soul-schema.md` and `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` (both produced by GH-1268). If Feature A has NOT landed when this implements, **stop and escalate** — do not write a placeholder schema or hook script; the schema is authoritative and must originate from A.
12. **Wrap, never duplicate.** `gcp-incident-triage` and `ralph-debug-collate` are existing skills. The Watcher orchestrator invokes them via `Skill()`; it does not copy their bodies or re-implement their logic. If a behavior change is needed in either, file a separate issue against that skill, do not edit it from this feature.
13. **sre-fixit allowlist is the security boundary.** The allowlist must be enforced in TWO places: (a) the agent's `tools:` field (hard runtime gate), and (b) the agent's prompt body (instruction-level reminder). The hardcoded allow set is: `kubectl scale deployment * --replicas=*`, `kubectl drain node*`, `kubectl rollout restart *`, `kubectl delete pod *`. Anything else routes to Human Needed via the standard escalation flow. No `--force`, no `--cascade=foreground`, no node-pool ops.
14. **log-reader is read-only.** Its `tools:` field excludes `Edit`, `Write`, and all `mcp__plugin_ralph-hero_*` mutation tools. It may call `Bash` only with `gcloud logging read`, `gcloud monitoring metrics list`, and the `gcp-telemetry` skill's documented LQL query commands.

## Current State Analysis

**Existing skills wrapped by this feature** (do not modify):

- `~/.claude/skills/gcp-incident-triage/SKILL.md` — operates the delta between Cloud Monitoring policies and GitHub issues; deterministic-marker classification (NEW/TRACKED-FRESH/TRACKED-STALE/FLAPPING/RESOLVED-OPEN/DUPLICATE). Already supports loop mode (`/loop 30m /gcp-incident-triage`).
- `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` — dry-run → confirm → file `debug-auto` issues from Langfuse error groupings. Currently human-confirmed; Feature D will promote it to a scheduled run inside the Watcher heartbeat (out-of-scope here — this feature just wires the invocation point).

**Existing patterns to mirror**:

- Autopilot frontmatter shape (`plugin/ralph-hero/skills/autopilot/SKILL.md` lines 1–19): `argument-hint: ""`, `context: inline`, single `SessionStart` hook setting `RALPH_COMMAND`, narrow `allowed-tools` list.
- `set-skill-env.sh` (`plugin/ralph-hero/hooks/scripts/set-skill-env.sh`): writes `export KEY=VALUE` lines to `$CLAUDE_ENV_FILE`. Watcher's SessionStart hook chains this with Feature A's `load-team-soul.sh`.
- Agent frontmatter shape (`plugin/ralph-hero/agents/triage-agent.md`, `codebase-locator.md`): `name`, `description`, `model`, `tools` (comma-separated list, hard allowlist), optional `skills` for preloading.

**What does not yet exist** (Feature A precondition):

- `plugin/ralph-hero/skills/shared/soul-schema.md` — canonical SOUL frontmatter doc
- `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` — SessionStart hook that reads `$RALPH_COMMAND`, locates `plugin/ralph-hero/skills/$RALPH_COMMAND/SOUL.md`, and injects it into the orchestrator's system prompt
- `plugin/ralph-hero/skills/watch/SOUL.md` (stub) — Feature A drops a paranoid-but-disciplined stub; this feature replaces it with the full body.

## Desired End State

After this plan lands:

- A user (or Director) invokes `Skill("ralph-hero:watch", "--issue 1234")` and the Watcher orchestrator: (a) loads its SOUL via Feature A's hook; (b) inspects the issue; (c) dispatches `gcp-incident-triage` if the issue carries an alert marker, `ralph-debug-collate` if it carries a Langfuse trace marker, or the `log-reader` agent for freeform log investigation; (d) emits a `result:` line on completion; (e) calls (or stubs a TODO for) `outcome-recorder`.
- The same skill invoked with no argument runs a heartbeat: lists open `watcher-*` labeled issues, triages any new alerts, files comments on stale ones. This is the path `/schedule` calls every 15 min.
- The `sre-fixit` agent is callable from the Watcher orchestrator for the four allowlisted kubectl actions only. The allowlist is enforced at the `tools:` level so a model-side prompt-injection cannot widen it.
- The `log-reader` agent is callable from the Watcher orchestrator and from `gcp-incident-triage` itself for read-only log/trace queries.
- A smoke test (`plugin/ralph-hero/scripts/watch/smoke.sh`) asserts: (i) the watch SKILL.md frontmatter parses; (ii) the SOUL.md frontmatter parses and contains the required fields; (iii) the heartbeat path returns successfully when given an empty board; (iv) the sre-fixit agent's tools allowlist contains only the four kubectl entries.
- `HEARTBEAT.md` documents the exact `/schedule` command to register the 15-min routine and the env var (`RALPH_WATCH_HEARTBEAT_MIN`) for overriding the cadence.

### Verification

- [ ] `Skill("ralph-hero:watch", "--issue NNN")` dispatches the correct sub-skill based on issue markers
- [ ] Heartbeat-mode (no arg) drains the `watcher-*` queue and stops cleanly when empty
- [ ] `log-reader` agent has no write/mutation tools in its `tools:` field
- [ ] `sre-fixit` agent's `tools:` field lists exactly four `Bash` invocation patterns, all kubectl
- [ ] Watch SOUL has 150–250 words of body prose, exactly one Bad/Good exchange, and refuses-list mentions trace IDs / LQL queries
- [ ] `plugin/ralph-hero/scripts/watch/smoke.sh` exits 0
- [ ] `HEARTBEAT.md` shows the `/schedule` registration command and the cadence env var

## What We're NOT Doing

- **Building `outcome-recorder` itself.** That is Feature E (GH-1272). This feature stubs the call site with a TODO.
- **Cloud Monitoring → issue bridge.** Feature D (GH-1271) builds the Pub/Sub subscriber. This feature just makes the receiving skill exist.
- **Director event-class taxonomy edits.** `trigger:watch` label handling lives in Feature B (GH-1269). This feature accepts a direct `--issue NNN` invocation; Director's label-consume logic is out of scope.
- **Promoting `ralph-debug-collate` to non-interactive scheduled mode.** Feature D does that. This feature only wires the existing interactive form.
- **Editing `gcp-incident-triage` or `ralph-debug-collate`.** Constraint 12 forbids it.
- **Implementing Feature A's SOUL schema or load-team-soul.sh.** Those are dependencies, not deliverables.
- **iOS-specific polish** (cos rollup, ntfy hooks, gdrive-push wiring). Feature H (GH-1275).

## Implementation Approach

Phases 1–3 are independent and could be parallelized by an orchestrator (no `depends_on` between them). Phase 4 depends on all three because the orchestrator imports the SOUL, the log-reader, and the sre-fixit names. Phase 5 (smoke test + heartbeat doc) depends on Phase 4.

Each phase below contains explicit `depends_on` annotations consumed by hero/team orchestrators for parallel-vs-sequential scheduling.

---

## Phase 1: Watch SOUL.md — replace Feature A stub with full body
- **depends_on**: null

### Overview

Replace the paranoid-but-disciplined SOUL stub that Feature A drops at `plugin/ralph-hero/skills/watch/SOUL.md` with the full body. Voice: paranoid-but-disciplined ("show me the trace ID"). Refusals: claims without trace IDs, claims without LQL queries, claims based on log timestamps from the wrong timezone.

### Tasks

#### Task 1.1: Author watch/SOUL.md body
- **files**: `plugin/ralph-hero/skills/watch/SOUL.md` (modify — replace stub)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter contains `team: watchers`, `voice: paranoid-but-disciplined`, `refuses: [<list>]` matching Feature A's `soul-schema.md` shape (plural form per `soul-schema.md`; matches Feature A's existing stub at `plugin/ralph-hero/skills/watch/SOUL.md`)
  - [ ] Refuses list contains exactly these items (verbatim text): `"claims without a trace ID"`, `"claims without a literal LQL/log-query snippet"`, `"comparing timestamps across timezones without explicit TZ conversion"`, `"any remediation outside the sre-fixit allowlist"`
  - [ ] Body has a `## How you talk` section (~80–120 words)
  - [ ] Body has exactly one `## Example exchange` section with `### Bad` and `### Good` subsections; Good explicitly cites a trace ID or `gcloud logging read` snippet
  - [ ] Total body prose 150–250 words (count excludes frontmatter and headings)
  - [ ] Inherits — does not contradict — `plugin/ralph-hero/skills/STYLE.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] Frontmatter YAML valid: `python3 -c 'import yaml; yaml.safe_load(open("plugin/ralph-hero/skills/watch/SOUL.md").read().split("---")[1])'`
- [ ] Required frontmatter keys present: `grep -E '^(team|voice|refuses):' plugin/ralph-hero/skills/watch/SOUL.md | wc -l` returns `3`
- [ ] Body word count 150–250: `awk '/^---$/{n++; next} n==2' plugin/ralph-hero/skills/watch/SOUL.md | wc -w` returns a number in `[150, 250]`

#### Manual Verification:
- [ ] Voice reads as paranoid-but-disciplined, not paranoid-and-panicked
- [ ] Bad/Good exchange is concrete (uses a real-looking trace ID + gcloud snippet)

**Creates for next phase**: nothing direct — Phase 4 imports the SOUL by filename only.

---

## Phase 2: log-reader subagent (read-only)
- **depends_on**: null

### Overview

A subagent the Watcher orchestrator dispatches for "read these logs / run this LQL query / fetch this trace" tasks. Read-only by `tools:` allowlist. Wraps the documented `gcp-telemetry` query commands.

### Tasks

#### Task 2.1: Author log-reader.md
- **files**: `plugin/ralph-hero/agents/log-reader.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter: `name: log-reader`, `description:` (one-line), `model: haiku`, `tools:` lists ONLY: `Read`, `Grep`, `Glob`, `Bash`, `WebFetch`
  - [ ] Frontmatter explicitly EXCLUDES: `Edit`, `Write`, `Task`, `Agent`, and every `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*` mutation tool
  - [ ] Body documents the three permitted bash command shapes: `gcloud logging read ...`, `gcloud monitoring metrics list ...`, and the LQL playbook from `gcp-telemetry`
  - [ ] Body includes a "Read-only contract" paragraph stating the agent must refuse any task that asks it to write, modify, or remediate
  - [ ] Output-format section requires the agent to return `## Findings` with trace IDs / log-snippet quotes — never paraphrase

### Phase Success Criteria

#### Automated Verification:
- [ ] Frontmatter YAML valid (same yaml check shape as Phase 1)
- [ ] `tools:` field contains no write tools: `grep -E '^tools:' plugin/ralph-hero/agents/log-reader.md | grep -Eqv '(Edit|Write|save_issue|create_|advance_|add_|remove_|batch_update)'`
- [ ] Model is haiku: `grep -E '^model: haiku$' plugin/ralph-hero/agents/log-reader.md` returns 1 match

#### Manual Verification:
- [ ] Output-format section gives one concrete `## Findings` example with a real-shaped trace ID

**Creates for next phase**: log-reader is callable via `Agent(subagent_type="ralph-hero:log-reader", ...)`. Phase 4 imports this name.

---

## Phase 3: sre-fixit subagent (allowlisted autoremediation)
- **depends_on**: null

### Overview

A subagent the Watcher orchestrator dispatches for the four allowlisted kubectl autoremediation actions. The allowlist is enforced both at the `tools:` field (runtime hard gate) and in the prompt body (instruction-level reminder).

### Tasks

#### Task 3.1: Author sre-fixit.md
- **files**: `plugin/ralph-hero/agents/sre-fixit.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter: `name: sre-fixit`, `description:` (one-line, mentions "allowlisted autoremediation only"), `model: sonnet`, `tools:` lists ONLY: `Bash`, `Read`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`
  - [ ] Body opens with a `## Allowlisted actions` table listing exactly four kubectl invocation shapes (`kubectl scale deployment <name> --replicas=<N>`, `kubectl drain node <name>`, `kubectl rollout restart deployment/<name>`, `kubectl delete pod <name>`) with no `--force`, no `--cascade=foreground`, no node-pool / no node-deletion entries
  - [ ] Body's `## Refusal protocol` section states: any non-allowlisted action causes the agent to (a) post a `## Escalation` comment on the originating issue, (b) move the issue to `Human Needed`, (c) return without taking the action
  - [ ] Body documents the standard sre-fixit workflow: confirm-symptom → check-allowlist → dry-run-print → execute → record-outcome (`# TODO(GH-1272): wire outcome-recorder`)
  - [ ] Body cites the parent plan's Shared Constraint 13 verbatim as the authority for the allowlist
  - [ ] Output-format section requires the agent to return `## Remediation Applied` (success) or `## Escalation` (refusal), never both

### Phase Success Criteria

#### Automated Verification:
- [ ] Frontmatter YAML valid
- [ ] `tools:` field is exactly three entries: `Bash`, `Read`, the create_comment MCP tool
- [ ] Body contains exactly four kubectl command shapes in the allowlist table: `grep -cE 'kubectl (scale|drain|rollout|delete pod)' plugin/ralph-hero/agents/sre-fixit.md` returns `4` (allowing for one occurrence per command)
- [ ] No `--force` or `--cascade=foreground` strings present: `! grep -E '(--force|--cascade=foreground)' plugin/ralph-hero/agents/sre-fixit.md`

#### Manual Verification:
- [ ] Refusal protocol reads as ironclad — model cannot reasonably argue itself out of escalating

**Creates for next phase**: sre-fixit is callable via `Agent(subagent_type="ralph-hero:sre-fixit", ...)`. Phase 4 imports this name.

---

## Phase 4: watch/SKILL.md — orchestrator wiring
- **depends_on**: [phase-1, phase-2, phase-3]

### Overview

The Watcher orchestrator skill. Single entrypoint. Accepts `--issue NNN` (direct) or no arg (heartbeat). Reads SOUL via Feature A's `load-team-soul.sh` SessionStart hook. Dispatches `gcp-incident-triage`, `ralph-debug-collate`, `log-reader`, or `sre-fixit` based on issue markers / state. Emits `result:` / `needs input:` markers. Stubs `outcome-recorder` calls with `# TODO(GH-1272)`.

### Tasks

#### Task 4.1: Author watch/SKILL.md frontmatter and orchestrator body
- **files**: `plugin/ralph-hero/skills/watch/SKILL.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter mirrors autopilot's shape: `description:`, `argument-hint: "[--issue NNN]"`, `context: inline`, `hooks:` block, `allowed-tools:` block
  - [ ] SessionStart hook chains TWO commands (in order): `set-skill-env.sh RALPH_COMMAND=watch RALPH_REQUIRED_BRANCH=main` then `load-team-soul.sh` (Feature A's hook)
  - [ ] `allowed-tools:` enumerates exactly: `Skill`, `Agent`, `Bash`, `Read`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`
  - [ ] Body has a `## Argument parsing` section that distinguishes `--issue NNN` mode from heartbeat mode (no arg)
  - [ ] Body has a `## Dispatch table` section that maps `(issue marker / label)` → sub-skill or subagent:
    - `<!-- gcp-policy: ... -->` marker present → `Skill("gcp-incident-triage", "--issue NNN")`
    - `langfuse-trace:` URL in body → `Skill("ralph-hero:ralph-debug-collate", ...)`
    - `watcher-investigate` label → `Agent(subagent_type="ralph-hero:log-reader", ...)`
    - `watcher-remediate` label AND action is allowlisted → `Agent(subagent_type="ralph-hero:sre-fixit", ...)`
    - Otherwise → escalate to `Human Needed`
  - [ ] Body has a `## Heartbeat mode` section: when no `--issue` arg, calls `list_issues({labels: ["watcher-auto", "watcher-investigate", "watcher-remediate"], workflowState: "Backlog"})` and dispatches per the table for each result
  - [ ] Body has a `## Terminal handlers` section that, for every dispatch outcome, prints (a) a `result:` marker line, (b) an inline `# TODO(GH-1272): wire outcome-recorder(decision=<X>, result=<Y>, trace_id=<Z>)` comment
  - [ ] Body opens with a `## Configuration (resolved at load time)` section mirroring autopilot lines 21–26 — surfaces `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`, and `RALPH_WATCH_HEARTBEAT_MIN`
  - [ ] Body cites Shared Constraints 6 (remote-trigger contract — clarifying that Director, not Watch, consumes `trigger:watch` labels) and 7 (outcome recording is automatic — pointing to GH-1272 stubs)
  - [ ] Body refuses to act on any issue lacking BOTH a trace ID AND an LQL/log-query snippet — SOUL refusal enforced at the orchestrator level too

### Phase Success Criteria

#### Automated Verification:
- [ ] Frontmatter YAML valid
- [ ] `argument-hint` is exactly `"[--issue NNN]"`: `grep -E '^argument-hint: "\[--issue NNN\]"$' plugin/ralph-hero/skills/watch/SKILL.md`
- [ ] SessionStart hook chains the two scripts: `grep -c 'set-skill-env.sh\|load-team-soul.sh' plugin/ralph-hero/skills/watch/SKILL.md` returns at least `2`
- [ ] Dispatch table covers all five entries: `grep -cE '(gcp-policy|langfuse-trace|watcher-investigate|watcher-remediate|Human Needed)' plugin/ralph-hero/skills/watch/SKILL.md` returns at least `5`
- [ ] Three `# TODO(GH-1272)` markers present (one per terminal-handler branch): `grep -c 'TODO(GH-1272)' plugin/ralph-hero/skills/watch/SKILL.md` returns at least `3`
- [ ] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (sanity: no source changed)

#### Manual Verification:
- [ ] Dispatch table table reads unambiguously — no overlap that would let two rows match the same issue
- [ ] Heartbeat-mode loop bounds itself (does not recurse indefinitely on a non-empty queue)
- [ ] The `result:` marker format matches the iOS background-session extractor's expected shape

**Creates for next phase**: a fully-formed orchestrator file that Phase 5's smoke test exercises.

---

## Phase 5: Heartbeat doc + smoke test
- **depends_on**: [phase-4]

### Overview

User-facing documentation for registering the Watcher heartbeat as a `/schedule` routine, plus a smoke script that asserts the four artifacts (SOUL, log-reader, sre-fixit, SKILL) parse and obey their stated invariants.

### Tasks

#### Task 5.1: Author HEARTBEAT.md
- **files**: `plugin/ralph-hero/skills/watch/HEARTBEAT.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Documents the exact `/schedule` registration command shape (e.g., `Skill("schedule", "every 15m /ralph-hero:watch")`) with both interactive and cron syntaxes
  - [ ] Documents `RALPH_WATCH_HEARTBEAT_MIN` env var (default `15`, accepts integer minutes)
  - [ ] Documents how to verify the routine landed: `Skill("schedule", "list")` and the expected entry shape
  - [ ] Documents how to pause / disable: `Skill("schedule", "delete <id>")`
  - [ ] Has a `## Troubleshooting` section covering the two common failure modes: (a) Feature A hook not installed (SOUL not loaded), (b) `gcp-incident-triage` skill not present at `~/.claude/skills/gcp-incident-triage/`
  - [ ] Inherits the STYLE.md result-not-rationale tone

#### Task 5.2: Author smoke.sh
- **files**: `plugin/ralph-hero/scripts/watch/smoke.sh` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [5.1]
- **acceptance**:
  - [ ] Starts with `#!/usr/bin/env bash` and `set -euo pipefail`
  - [ ] Mirrors the smoke shape of `plugin/ralph-hero/scripts/cos/smoke.sh` (referenced by parent plan Shared Constraint 8)
  - [ ] Asserts SOUL frontmatter has `team`, `voice`, `refuses` keys (using the same yaml parse as Phase 1's automated verification)
  - [ ] Asserts SOUL body word count is in `[150, 250]`
  - [ ] Asserts `log-reader.md` `tools:` field does NOT contain `Edit`, `Write`, `save_issue`, `create_issue`, `add_dependency`, `add_sub_issue`, `batch_update`, `advance_issue`, `archive_items`
  - [ ] Asserts `sre-fixit.md` body contains the four kubectl shapes AND does not contain `--force` or `--cascade=foreground`
  - [ ] Asserts `watch/SKILL.md` SessionStart hook references both `set-skill-env.sh` and `load-team-soul.sh`
  - [ ] Asserts `watch/SKILL.md` contains at least three `TODO(GH-1272)` markers
  - [ ] Exits 0 on all-pass, exits 1 with a clear stderr line on first failure
  - [ ] File is `chmod +x`

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/scripts/watch/smoke.sh` — syntax check
- [ ] `plugin/ralph-hero/scripts/watch/smoke.sh` exits 0 (full smoke pass)
- [ ] `HEARTBEAT.md` exists and is non-empty

#### Manual Verification:
- [ ] HEARTBEAT.md reads well to a user setting up Watcher for the first time
- [ ] Smoke output is signal-only — no noise from passing assertions, errors are loud and specific

**Creates for next phase**: nothing — this is the terminal phase.

---

## Integration Testing

After all five phases land, the end-to-end check is:

- [ ] `plugin/ralph-hero/scripts/watch/smoke.sh` exits 0
- [ ] `Skill("ralph-hero:watch", "")` from a clean session loads SOUL, runs heartbeat against an empty board, and exits cleanly with a `result: queue empty` line
- [ ] `Skill("ralph-hero:watch", "--issue <a-gcp-policy-marker-issue>")` dispatches `gcp-incident-triage` and surfaces its triage table
- [ ] `Agent(subagent_type="ralph-hero:log-reader", prompt="<read-only query>")` succeeds; the same agent invoked with a write-style prompt refuses
- [ ] `Agent(subagent_type="ralph-hero:sre-fixit", prompt="kubectl delete deployment foo")` (non-allowlisted) refuses, posts a `## Escalation` comment, moves issue to `Human Needed`
- [ ] No `npm run build` regression in `plugin/ralph-hero/mcp-server/`

This integration smoke is the recommended acceptance bar before moving GH-1270 to `In Review`.

## References

- Parent plan-of-plans: [thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md)
- Sibling Feature A (SOUL framework): [GH-1268](https://github.com/cdubiel08/ralph-hero/issues/1268) — hard dependency
- This issue: [GH-1270](https://github.com/cdubiel08/ralph-hero/issues/1270)
- Wrapped skill: `~/.claude/skills/gcp-incident-triage/SKILL.md` (operator local, not under repo control)
- Wrapped skill: `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md`
- Mirror pattern: `plugin/ralph-hero/skills/autopilot/SKILL.md`
- Mirror pattern: `plugin/ralph-hero/agents/triage-agent.md`, `codebase-locator.md`
- Style: `plugin/ralph-hero/skills/STYLE.md`
- Comment headers: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`
