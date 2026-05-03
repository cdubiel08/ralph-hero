---
date: 2026-05-02
status: draft
type: spec
topic: hello-skill-composable-rewrite
---

# Hello Skill — Composable Rewrite

## TL;DR

Rebuild `/hello` as a thin wrapper that composes single-purpose primitives:

- A new local activity log (harness-driven, not LLM-callable) records what ralph-hero does
- Two MCP tools — `next_actions` (refactored from `hello_directions`) and `recent_activity` (new) — expose that data
- A new `catch-up` skill synthesizes a "what changed since last time" narrative
- `hello` becomes a wrapper: catch-up → next_actions → picker → Agent dispatch
- Headless orchestrators call the same tools directly, follow `recommended: true`, skip the picker

The redesign honors a guiding principle: **use code where determinism is achievable; reserve LLM generation for genuine synthesis.** Today's hello inverts this — its ranker is deterministic but emits templated reasons that collapse signal, while its narrative step has nothing meaningful to synthesize.

## Design Philosophy

> Use generation when the stochastic nature really helps; use determinism where possible with code (don't do with an LLM what you should do with code).

Concretely for this work:

| Concern | Layer | Why |
|---|---|---|
| Ranking work items | Code (deterministic) | Same inputs → same picks, no surprises in headless mode |
| Recording what happened | Code (harness hooks) | LLM cannot be trusted to faithfully log its own actions |
| Picking which action to take | Code (recommended flag) | Selection is a 1-of-N choice; rank-1 captures the signal |
| Synthesizing a narrative recap | LLM | Joining heterogeneous signals (events + memory) into prose is genuinely stochastic work |
| Composing the user-facing flow | Skill (LLM orchestrates) | Wrapping primitives, picking what to render, handling errors |

## Goals

1. **Catch-up is the primary value** of `/hello` — narrating what's changed since the user last looked
2. **Single-purpose primitives** that compose: each tool/skill does one thing well
3. **Headless mode is a first-class citizen** — autonomous orchestrators use the same primitives the interactive skill does
4. **Differentiated reasons** in directions output — readers can tell *why* the recommended action is recommended, not just that it is
5. **Visibility into autonomous activity** — when ralph runs headlessly, the next interactive `/hello` reveals what happened

## Non-Goals

1. Memory-aware ranker boost in v1 — memory mentions could influence direction scoring but the activity log is the bigger unlock; defer
2. Backfill from git or GitHub events — the log starts empty; first session has nothing to recap, second session onward has material
3. Cross-machine sync of activity log — each machine maintains its own log under `~/.ralph-hero/`; multi-machine sync is a future concern
4. Replacing `pipeline_dashboard` or other read-only tools — those keep their existing roles; we add new tools rather than reshape existing ones
5. Real-time streaming of activity events — daily JSONL files are good enough for catch-up's read pattern

## Current State (Prior Work)

The existing `/hello` skill was rebuilt under GH-918 (parent plan) and GH-921/922/924 (atomic group, shipped 2026-04-30). That revamp:

- Moved ranking from LLM prose synthesis into a pure deterministic library (`plugin/ralph-hero/mcp-server/src/lib/directions.ts`)
- Added the `ralph_hero__hello_directions` MCP tool exposing the ranker
- Refactored the skill to call the tool and render top-3 directions

The revamp solved the "Dashboard too large" / output-budget problem and introduced determinism. What it did not solve:

- **Reason templates collapse signal**: when multiple top picks share the same template (e.g., all stale Ready-for-Plan), readers can't tell why one outranks another from the prose
- **Memory and git activity are not inputs** to either ranking or synthesis — the briefing reads as anonymous board recap regardless of what the user was just doing
- **PR surfacing has a 24h blind spot** — newly-opened PRs don't show until they're stale
- **No record of headless ralph activity** — when autonomous mode runs overnight, the next interactive session has no narrative of what happened

This spec addresses these gaps without disturbing what GH-918 got right (the deterministic ranker pattern is preserved and extended).

## Architecture

Four layers with strict directionality (lower layers don't know about upper):

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4 — Wrappers (orchestration)                             │
│  • /hello (interactive)         • Hero/team orchestrator        │
│    catch-up → next_actions →      next_actions(audience=agent)  │
│    picker → Agent dispatch        → Agent dispatch on recommended│
└────────────────────┬────────────────────────────────────────────┘
                     │ compose
┌────────────────────┴────────────────────────────────────────────┐
│  Layer 3 — Skills (LLM synthesis)                               │
│  • catch-up — narrative from recent_activity + memory           │
└────────────────────┬────────────────────────────────────────────┘
                     │ call
┌────────────────────┴────────────────────────────────────────────┐
│  Layer 2 — MCP tools (deterministic compute, LLM-callable)      │
│  • next_actions       — ranks work, marks one recommended       │
│  • recent_activity    — reads activity log since cursor         │
└────────────────────┬────────────────────────────────────────────┘
                     │ read
┌────────────────────┴────────────────────────────────────────────┐
│  Layer 1 — Activity log (harness-driven, append-only)           │
│  • hooks.json fires on lifecycle events                         │
│  • record-activity.sh appends one JSONL event                   │
│  • ~/.ralph-hero/activity/YYYY/MM/DD.jsonl                      │
└─────────────────────────────────────────────────────────────────┘
```

### Invariants

- **The activity log is never written by an LLM.** Only by hooks. Reads are LLM-callable.
- **Both modes use the same compute.** Interactive and headless call the same Layer 2 tools. The only difference is Layer 4: interactive adds a picker; headless follows `recommended: true` directly.
- **Layer independence.** A skill or tool can be removed/replaced without changing layers below it. The log doesn't care if catch-up exists.

## Components

### Layer 1 — Activity Log

#### `plugin/ralph-hero/hooks.json` (changed)

Five new hook entries, each single-purpose:

| Hook entry | Trigger | Action |
|---|---|---|
| `activity-log-tools` | `PostToolUse` | `record-activity.sh tool_called` |
| `activity-log-skills` | `PostSkillInvoke` | `record-activity.sh skill_invoked` |
| `activity-log-agents` | agent-spawn | `record-activity.sh agent_spawned` |
| `activity-log-agents-done` | agent-complete | `record-activity.sh agent_completed` |
| `activity-log-session` | `SessionStart` / `SessionStop` | `record-activity.sh session_*` |

Exact Claude Code hook event names (`PostToolUse`, `PostSkillInvoke`, agent-spawn/complete equivalents) to be verified against the harness's hook API during implementation; if a desired event has no hook, that subset of activity is unrecorded in v1 (gracefully — consumers see fewer events, not errors).

#### `plugin/ralph-hero/scripts/record-activity.sh` (new)

Single-purpose shell script. Does exactly:

1. Read event metadata from env vars (`CLAUDE_HOOK_EVENT`, `CLAUDE_TOOL_NAME`, `CLAUDE_SKILL_NAME`, `CLAUDE_PROJECT`, etc.)
2. Categorize event (`work` vs `meta`) per a lookup table
3. Format JSON object
4. Append to `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` (creating directory if needed)
5. Exit 0 unconditionally

Does NOT: enforce policy, validate other things, send notifications, update cursors, trigger downstream actions, mutate state outside the log file, read the log back to make decisions.

≤ 30 lines. No dependencies beyond `date` and `mkdir`. `jq` used opportunistically for JSON construction; falls back to manual string concat if absent.

#### Activity log file format

`~/.ralph-hero/activity/YYYY/MM/DD.jsonl` — one JSON object per line, append-only, never edited.

Event schema:

```json
{
  "ts": "2026-05-02T20:01:53.287Z",
  "kind": "tool_called",
  "category": "meta",
  "actor": "ralph-hero:hello",
  "target": {"tool": "ralph_hero__recent_activity"},
  "project": "ralph-hero",
  "session_id": "abc123"
}
```

Categorization rules:

| Tool kind | Category | Examples |
|---|---|---|
| State-mutating | `work` | `save_issue`, `create_issue`, `add_dependency`, `advance_issue`, `archive_items` |
| Read-only board queries | `meta` | `get_issue`, `list_issues`, `pipeline_dashboard`, `next_actions`, `recent_activity`, `pick_actionable_issue` |
| Lifecycle (high-level intent) | `work` | `skill_invoked` (e.g., `ralph-hero:hello`), `agent_spawned`, `agent_completed` |
| External observed events | `work` | `pr_opened`, `pr_merged`, `issue_advanced` (when from external sources, future) |
| Harness boundary | `meta` | `session_start`, `session_stop` |

Tools not in the table default to `meta` (safer — won't pollute work events with unknown calls).

### Layer 2 — MCP Tools

#### `ralph_hero__next_actions` (replaces `hello_directions`)

Location: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (existing, refactored)

Inputs:
- `limit: number` (default 3)
- `audience: "human" | "agent"` (default `"human"`)
- `openPRs: OpenPR[]` (existing)
- All existing pass-through params (`owner`, `projectNumbers`, `lockStaleHours`, `prStaleHours`, `stuckThresholdHours`, `treeRecentDoneDays`)

Output: `directions[]` where exactly one entry has `recommended: true` (rank-1 by default; future scoring adjustments can override).

```typescript
interface Direction {
  rank: number;
  recommended: boolean;        // NEW — exactly one entry has true
  kind: "issue" | "pr" | "tree-continue" | "lock-stale";
  issue: { number, title, workflowState, priority, estimate } | null;
  pr: { number, title, url, ageHours, reviewDecision } | null;
  reason: string;
  tags: string[];
  score: number;
}
```

Internal changes to `lib/directions.ts`:
- Add `recommended: boolean` field to `Direction` type
- After `merged.slice(0, limit)`, mark the top entry `recommended: true`
- Add `audience` weighting in `scoreIssue`:
  - `"human"`: existing scoring, no change
  - `"agent"`: penalize non-XS/S items (e.g., +20 to score for each size beyond Small) so autonomous-loop constraints are honored
- Reason templates differentiated further: when stale tag fires, also branch on priority so a stale P1 produces a different sentence than a stale P2 (fixes the templated-reason collapse observed today)

Backwards compat: `ralph_hero__hello_directions` registered as a thin alias that calls `next_actions(audience="human", ...)`. Marked `@deprecated`. Removed in 2.7.0.

#### `ralph_hero__recent_activity` (new)

Location: `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` (new)
Library: `plugin/ralph-hero/mcp-server/src/lib/activity.ts` (new)

Inputs:
- `since: string | null` — ISO8601 timestamp; null means "all of today"
- `until: string | null` — optional upper bound
- `kinds: string[] | null` — optional filter (e.g., `["pr_opened", "issue_advanced"]`)
- `category: "work" | "meta" | "all" | null` — default `"work"`
- `project: string | null` — optional filter
- `limit: number` (default 100)

Output:

```typescript
interface RecentActivityResult {
  events: ActivityEvent[];          // chronological order, oldest first
  cursor_advanced_to: string | null; // newest event ts seen, for caller to persist
  skipped_lines: number;             // corrupt JSONL lines that were skipped
}
```

Internals:
- Walk `~/.ralph-hero/activity/YYYY/MM/DD.jsonl` files newest-to-oldest until `since` cursor passed
- Tolerate missing daily files (sparse logs), corrupt lines (skip + count)
- Return parsed events in oldest-first chronological order
- Default category filter is `"work"` so consumers don't have to explicitly exclude meta noise

### Layer 3 — `catch-up` Skill

Location: `plugin/ralph-hero/skills/catch-up/SKILL.md` (new)

Responsibilities:
- Read `MEMORY.md` (same pattern as today's hello)
- Determine cursor — read from `~/.ralph-hero/cursors/catch-up.json` or default to "24h ago"
- Call `recent_activity(since=cursor, category="work")`
- Synthesize narrative: 2-4 sentences describing what happened since last time, framed naturally
- Update cursor file to `cursor_advanced_to` from tool response
- Output: narrative text only — no severity tags, no dashboard formatting, no JSON

Cursor file: `~/.ralph-hero/cursors/catch-up.json` → `{"last_event_ts": "2026-05-02T18:00:00Z"}`

Per-consumer cursors: each consumer (catch-up, future postmortem, future status report) maintains its own cursor file. No coordination required.

### Layer 4 — Wrappers

#### `/hello` skill (rewritten)

Location: `plugin/ralph-hero/skills/hello/SKILL.md` (existing, rewritten)

New flow:

1. Parallel:
   - Invoke `Skill("ralph-hero:catch-up")` → narrative text
   - `Bash("gh pr list ...")` → open PRs
2. `next_actions(limit=3, audience="human", openPRs=...)` → directions
3. Render briefing:
   - Catch-up narrative (one paragraph)
   - Brief mention of recommended action
   - ≤ 40 lines total (existing budget rule preserved)
4. `AskUserQuestion` with options 1:1 from `directions[]`, default selection = the entry where `recommended === true`
5. `Agent()` dispatch via existing kind/state → agent table

The picker + dispatch table stays inside hello's SKILL.md as glue (per design discussion: extracting it to its own skill produces an anemic wrapper with no reuse).

#### Headless orchestrator integration

Location: `plugin/ralph-hero/skills/hero/SKILL.md` and team mode

Changes:
- Replace `pick_actionable_issue` calls with `next_actions(limit=1, audience="agent")`
- Use the `recommended` direction directly — no LLM "which one" reasoning, no picker
- Optionally invoke `Skill("ralph-hero:catch-up")` before/after work cycles to write narrative output to issue comments or memory

## Data Flow

### Trace A: Interactive `/hello` invocation

```
USER: /hello

[Layer 4: hello wrapper]
   │
   ├─ parallel:
   │     ├─ Skill("ralph-hero:catch-up") ──────────┐
   │     └─ Bash("gh pr list --json ...")          │
   │                                                │
   │  [Layer 3: catch-up skill]                    │
   │     │                                          │
   │     ├─ Read MEMORY.md                          │
   │     ├─ Read ~/.ralph-hero/cursors/catch-up.json
   │     │     → {"last_event_ts": "2026-05-01T18:00:00Z"}
   │     ├─ recent_activity(since="2026-05-01T18:00:00Z", category="work")
   │     │                                          │
   │     │  [Layer 2: recent_activity tool]        │
   │     │     │                                    │
   │     │     ├─ Walk ~/.ralph-hero/activity/2026/05/{01,02}.jsonl
   │     │     ├─ Filter category="work"            │
   │     │     ├─ Parse, return chronological events
   │     │     │                                    │
   │     │     └─ events: [                         │
   │     │          {ts, kind:"pr_opened", pr:933}, │
   │     │          {ts, kind:"issue_advanced", issue:921, from, to},
   │     │          ...                             │
   │     │        ]                                 │
   │     │                                          │
   │     ├─ LLM synthesizes narrative from events + memory
   │     ├─ Write back updated cursor               │
   │     └─ Return narrative text ─────────────────┘
   │
   ├─ next_actions(limit=3, audience="human", openPRs=[...])
   │
   │  [Layer 2: next_actions tool]
   │     │
   │     ├─ Fetch dashboard items via existing GraphQL pipeline
   │     ├─ rankDirections(items, openPRs, config)
   │     ├─ Mark directions[0].recommended = true
   │     │
   │     └─ {directions: [{rank:1, recommended:true, ...}, ...],
   │         totalCandidates, fetchedAt}
   │
   ├─ Render briefing (≤40 lines):
   │     "[catch-up narrative paragraph]
   │      Right now there's [recommended action]"
   │
   ├─ AskUserQuestion(options=[
   │     // pre-selected: the one with recommended:true
   │     {label: "Plan #731", description: <reason>},
   │     {label: "Plan #566", description: <reason>},
   │     ...,
   │     {label: "Work through these in order"}
   │   ])
   │
   └─ Agent(subagent_type=<from dispatch table>, prompt=...)
        │
        └─ [agent runs in isolated context, returns]

[Hooks fire throughout — record-activity.sh appends events]
```

### Trace B: Headless orchestrator picking next work

```
[Layer 4: hero orchestrator running headless]
   │
   ├─ next_actions(limit=1, audience="agent")
   │     │
   │     └─ {directions: [{rank:1, recommended:true, kind, issue:{number:921}}], ...}
   │
   ├─ direction = response.directions.find(d => d.recommended)
   │   // no LLM reasoning, no picker, no AskUserQuestion
   │
   ├─ Agent(subagent_type=<from dispatch table>, prompt=...)
   │
   ├─ (optional) Skill("ralph-hero:catch-up")
   │   → narrative written to issue comment or memory
   │
   └─ loop or exit
```

### Key shape notes

- **`recommended` is the only API contract for selection.** Both modes look for it and act.
- **Catch-up output is text, not structured.** Returns synthesized prose. Interactive renders it; headless can pipe it into a comment, memory write, or status update.
- **Cursors are per-consumer, not global.** Future skills (postmortem, status report) get their own cursor files.
- **Hooks observe; they don't drive.** Removing the hooks doesn't break the data flow — the log just stops growing.

### Subtlety: hook → log → tool round-trip race

When a hook fires, the file write is async-ish (the hook script has to run). If `recent_activity` is called immediately after a tool fires, the corresponding event might not be on disk yet. This is fine for catch-up's normal usage (it reads "what happened earlier") but worth noting if any consumer ever calls `recent_activity` expecting to see *just-fired* events. None of the v1 consumers do.

## Error Handling

Cross-cutting principle: **telemetry must never break user-facing work.** Failures in the log layer are silent. Failures in higher layers degrade gracefully, never propagate.

### Layer 1 — Activity log (writes)

| Failure | Response |
|---|---|
| `record-activity.sh` not executable / missing | Hook does nothing visible; tool call completes normally (`\|\| true` in hook config) |
| Disk full / permissions denied | Script exits silently, tool call completes |
| Concurrent writes from parallel hooks | Append mode (`>>`) is atomic for writes ≤ PIPE_BUF (4KB); events well under that |
| Activity directory missing | Script does `mkdir -p` before write |
| `jq` not installed | Manual JSON construction in shell as fallback |

### Layer 2 — MCP tools (reads)

**`recent_activity`:**

| Failure | Response |
|---|---|
| Activity directory doesn't exist | Return `{events: [], cursor_advanced_to: null}` |
| Some daily files missing in range | Skip silently, continue |
| Corrupt JSONL line | Skip the line, increment `skipped_lines` |
| Cursor format invalid | Return MCP error (programming error, not data error) |
| Permission denied | Return MCP error with clear message |

**`next_actions`:**

| Failure | Response |
|---|---|
| GraphQL fetch fails | Return MCP error (existing behavior) |
| No candidates pass filters | Return `{directions: [], totalCandidates: 0}` |
| `openPRs` malformed | Schema validation rejects at MCP boundary |

### Layer 3 — `catch-up` skill

| Failure | Response |
|---|---|
| Cursor file missing or corrupt | Default to "24h ago", log warning, write fresh cursor |
| `recent_activity` returns empty | Output: "Nothing's changed since last time you checked." Skip synthesis. |
| `recent_activity` returns 1000+ events | Cap at most-recent-N (e.g., 200) for synthesis. Note in output: "A lot has happened since last week — here are the highlights." |
| `recent_activity` MCP error | Output: "Couldn't read activity log." Don't advance cursor. |
| MEMORY.md missing | Synthesize from events alone |
| LLM synthesis hits output budget | Hard constraint in skill prompt (existing pattern) |

### Layer 4 — `hello` wrapper

| Failure | Response |
|---|---|
| `catch-up` skill errors | Skip narrative section; brief mention "(catch-up unavailable)"; proceed |
| `next_actions` errors | Surface error, stop (no directions = no picker) |
| `next_actions` returns empty | "Things look calm — nothing stuck, nothing on fire." Skip picker. |
| User picks "Other" | "Got it — holler if you need anything." Stop. |
| Agent dispatch fails | Surface error; don't crash hello |
| Non-interactive mode (`claude -p`) | Detect via env; skip picker; print briefing only |

### Cross-cutting

**Cursor advancement on read failures.** Catch-up only advances its cursor on *successful* synthesis. Transient failures don't lose history.

## Hook Discipline (Design Constraint)

**Principle**: A hook configuration is a (trigger, action) pair. The action does exactly one thing. If two unrelated jobs both want to listen to a trigger, they get two separate hook entries — never one script that branches.

### Applied to activity-log hooks

Activity-log hooks share one job: record an activity event. They each fire `record-activity.sh` and do nothing else.

`record-activity.sh` does NOT:
- Enforce policy (e.g., "block this tool call if X")
- Validate other things (frontmatter, branch state, file paths)
- Send notifications (Slack, push, etc.)
- Update cursors (consumers manage their own)
- Trigger downstream actions (no chaining; if something needs to react to an event, it reads the log)
- Mutate state outside the log file
- Read the log back to make decisions

If any of those become needed later, they get their own hook listening to the same trigger.

### Future hygiene note

The existing 50+ ralph-hero hooks should be audited for any that conflate concerns. Out of scope for this work; flag as a separate cleanup ticket if found.

## Testing Strategy

Tests organized by layer, mirroring dependency direction.

### Layer 1 — Activity log

`plugin/ralph-hero/scripts/__tests__/record-activity.test.sh` (or `.bats`):
- Categorization: every kind in lookup table maps correctly
- JSON output is valid (`jq -e .`)
- Append-only behavior (writing twice → two lines)
- Auto-creates directory tree
- Silent failure on bad disk paths (exit 0, no stderr noise)
- Concurrent writes (50 parallel) produce 50 well-formed lines

### Layer 2 — MCP tools (vitest)

`directions.test.ts` (extends existing):
- `recommended: true` set on rank-1 entry, only one entry has it
- `audience: "agent"` down-weights non-XS/S items as expected
- `audience: "human"` produces same output as today (regression check)
- Determinism contract preserved

`directions-tools.test.ts` (extends existing):
- Renamed tool registered correctly
- Backwards-compat alias for `hello_directions` works during deprecation window
- New `audience` param accepted

`activity.test.ts` (new):
- Read empty log → `{events: [], skipped_lines: 0}`
- Read populated log → events in chronological order
- Skip corrupt JSONL line, increment counter
- Walk multiple daily files
- Filter by `kinds`, `category`, `since`, `until`, `project`
- Handle missing daily files mid-range
- Handle missing root directory

`activity-tools.test.ts` (new):
- Tool registration
- Param validation (zod schemas)
- Cursor format validation
- Permission-denied error surfaces correctly

### Layer 3 — `catch-up` skill

Behavioral fixtures (integration via `claude -p` against controlled log):
- Cursor lifecycle: write fixture → invoke catch-up → cursor moves forward → invoke again → no new events seen
- Empty log: invoke with empty log → "nothing to recap" → cursor unchanged
- Long absence: log with 500 events → expect capped synthesis → cursor advances to newest

### Layer 4 — `hello` wrapper

- Recommended flag honored: with fixture where rank-1 has `recommended: true`, picker pre-selects right option
- Empty directions: hello outputs "things look calm" and skips picker
- Catch-up failure isolated: stub catch-up to error → hello continues
- Non-interactive mode: invoke via `claude -p "/hello"` → briefing printed, no picker

### End-to-end smoke

```
1. Seed ~/.ralph-hero/activity/.../test.jsonl with N known events
2. Invoke /hello in test mode (env var → fixture log)
3. Assert: catch-up runs, narrative produced
4. Assert: next_actions called, directions returned
5. Assert: picker default = recommended
6. Verify: hooks fired during this run added new events
```

### Coverage targets

- Pure libraries (`directions.ts`, `activity.ts`): ~95% line coverage
- MCP tool wrappers: registration + validation + happy-path + key error paths (≥80%)
- Shell script: smoke + categorization + failure modes
- Skills: behavioral fixtures, not coverage metrics

### Explicitly NOT tested

- Exact LLM narrative text (stochastic by design — test inputs and that synthesis happened)
- Byte-identical hello briefing (presentation varies; determinism enforced at Layer 2)
- Hooks firing in real Claude Code session under unit tests (covered by manual smoke + E2E)

## Rollout & Migration

Six shippable units (Approach A — bottom-up by dependency).

### Step 1: Activity log foundation

- New hook entries in `hooks.json`
- New `record-activity.sh`
- No MCP server version bump (hooks live in plugin, not mcp-server)
- **Risk**: hooks fire on every tool/skill use. Bug = silent slowdown.
- **Mitigation**: script ≤ 30 lines, no external deps, exits 0 unconditionally; tests verify silent failure
- **Rollback**: revert hooks.json
- **User-visible**: minor release note: "Activity log added at `~/.ralph-hero/activity/`. Local-only."

### Step 2: `next_actions` tool

- Refactor `lib/directions.ts`: add `recommended` field + `audience` weighting + differentiated reason templates
- Register `ralph_hero__next_actions`; keep `ralph_hero__hello_directions` as `@deprecated` alias
- Auto-publishes new MCP server version
- **Risk**: ranker behavior change. **Mitigation**: existing `hello_directions` path stays byte-identical (same audience defaults, additive fields)
- **Rollback**: revert
- **Deprecation**: alias removed in 2.7.0

### Step 3: `recent_activity` MCP read tool

- New tool, new lib
- No behavioral change for existing consumers (pure addition)
- Auto-publishes new MCP server version

### Step 4: `catch-up` skill

- New skill at `skills/catch-up/SKILL.md`
- Cursor file path documented
- **First-run UX**: machines that installed step 1 a day ago have 24h of activity. Machines installing today get "nothing yet — I'll have more next time."

### Step 5: `hello` rewrite

- Existing `skills/hello/SKILL.md` rewritten as wrapper composing catch-up + next_actions + picker + dispatch
- **Risk**: highest in chain (user-visible flagship). **Mitigation**: prior steps validated; rewrite is mechanical composition.
- **Communication**: minor release note: "/hello now leads with what changed since you last looked. Picker default = recommended action."

### Step 6: Deprecate `pick_actionable_issue`

- Update `skills/hero/SKILL.md` (and team mode) to call `next_actions(limit=1, audience="agent")`
- Mark `pick_actionable_issue` `@deprecated`, route internally
- Remove deprecated tool one minor version later

### Backwards compatibility contract

| Surface | Compat window | Removal version |
|---|---|---|
| `ralph_hero__hello_directions` MCP tool | One minor cycle | 2.7.0 |
| `ralph_hero__pick_actionable_issue` MCP tool | One minor cycle | 2.7.0 |
| Existing `hello` skill behavior | Through step 4 | Replaced in step 5 |
| Hooks.json schema | Always backwards-compat | N/A (additive only) |

### Migration concerns / non-issues

- **Activity log starts empty.** First session has nothing to recap; second session onward is productive. No backfill in v1.
- **Cursor files don't exist yet.** Catch-up creates them on first run.
- **Multi-machine users.** Each machine has its own log; cross-machine sync is future concern.
- **Existing GitHub events not in log.** Catch-up is forward-looking, not historical reconstruction.

### Success criteria (one week after step 5 ships)

On a daily-driver machine:
- `/hello` opens with "since last time you ran this, X happened"
- Picker pre-selects the recommended direction
- Headless ralph still picks the right next work via `next_actions`
- Activity log file > 1MB (proof events are landing)
- Zero user-reported errors traced to telemetry

## Open Questions / Deferred

- **Memory-aware ranking** — boosting candidates mentioned in `MEMORY.md`. Defer to a follow-on; activity log is the bigger unlock.
- **External-event ingestion** — capturing PR merges and issue advances that happen outside Claude Code (e.g., from `gh` CLI, GitHub Actions, teammate pushes). Three options when we get to it: (1) accept gap, (2) periodic GitHub events sync, (3) read-time augmentation. Lean (1) for v1, (2 or 3) as follow-on.
- **Multi-machine sync** — how does catch-up handle a user with personal + work machines? Future concern; document as known limitation in v1.
- **Activity log retention** — daily files indefinitely is fine short-term. Add monthly tarball + 90-day retention as a logrotate follow-on.
- **Categorization registry maintenance** — when new MCP tools are added, contributors need to update the lookup table in `record-activity.sh`. Worth adding a CI check that flags unregistered tools.
- **Non-interactive mode detection** — exact env var or detection mechanism for `claude -p` vs interactive. Pin in implementation plan.
- **Existing 50+ hook audit** — confirm none currently conflate concerns; if found, separate cleanup ticket.

## References

- Prior work: `thoughts/shared/plans/2026-04-30-group-GH-0921-hello-directions-implementation.md` (GH-918 group, shipped 2026-04-30)
- Existing ranker library: `plugin/ralph-hero/mcp-server/src/lib/directions.ts`
- Existing `hello_directions` tool: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts`
- Existing `/hello` skill: `plugin/ralph-hero/skills/hello/SKILL.md`
- Existing `pick_actionable_issue`: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`
- Plugin architecture: `plugin/ralph-hero/CLAUDE.md`
- Dream-loop precedent (raw events → reflections): `~/projects/CLAUDE.md` and `plugin/ralph-knowledge`
