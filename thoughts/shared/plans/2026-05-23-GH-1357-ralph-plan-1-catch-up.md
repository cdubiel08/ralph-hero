---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, catch-up, migration, plan-of-plans]
github_issue: 1357
github_issues: [1357]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1357
primary_issue: 1357
---

# Plan 1: `/ralph:catch-up` — Orientation Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: Plan 0 scaffold merged as `986b165e` + cleanup `c714aa50` (PR #1356); cross-plugin MCP from `ralph` → `plugin_ralph-hero_ralph-github` verified.

## Overview

Fold five existing `ralph-hero` skills (`hello`, `catch-up`, `status`, `report`, `cos`) into one user-facing slash command `/ralph:catch-up` in the new `ralph/` plugin. The skill body is a thin mode dispatcher; opinion content lives in four flat-sibling reference files. Default surface is narrative + picker (today's `/hello` flow). `cos`'s `desk` / `remote` / `unattended` CLI subcommands stay in `plugin/ralph-hero/scripts/cos/` — they are deliberately not absorbed into the slash-command skill because their purpose is zero-Claude-Code-on-the-call-chain (phone, scheduled, offline).

This plan validates the full ralph pattern end-to-end (P1-P10 from the spec) on a low-risk read-mostly verb before any lifecycle verb is touched. The closing acceptance gate is dogfooding rhythm: switch real workflows to `/ralph:catch-up` for two weeks before sunsetting any source skill (sunset is Plan 10, not Plan 1).

## Current State Analysis

Five source skills total **580 lines** of SKILL.md prose plus a 65-line `cos/system-prompt.md`:

| Source | Lines | Shape | Side effects |
|---|---|---|---|
| `plugin/ralph-hero/skills/hello/SKILL.md` | 139 | Interactive: narrative + AskUserQuestion picker + Agent dispatch | No writes (delegates) |
| `plugin/ralph-hero/skills/catch-up/SKILL.md` | 74 | Pure narrative synthesis, cursor-managed | Read-only |
| `plugin/ralph-hero/skills/status/SKILL.md` | 101 | Raw dashboard render, hard negative-constraint prose | Read-only |
| `plugin/ralph-hero/skills/report/SKILL.md` | 142 | Compose + post status update via `create_status_update` | **Writes** to project board |
| `plugin/ralph-hero/skills/cos/SKILL.md` (+ 65-line system-prompt) | 59 | Dispatcher → 3 sub-modes (`desk`/`remote`/`unattended`) | Mixed; see below |

`cos`'s body is a thin dispatcher to `plugin/ralph-hero/scripts/cos/cos-{desk,remote,unattended}.sh`. The substance is **9 shell scripts + a 570-line operator README + a Streamlit app + launchd plists**, all of which deliberately do not spawn `claude` (verified by `grep -rE '(^|\s)claude(\s|$)' scripts/cos/cos-remote.sh`).

Plan 0's `ralph/` scaffold currently contains:
- `ralph/.claude-plugin/plugin.json` (v0.1.0, marketplace-registered as of commit `dd4e948f`)
- `ralph/skills/` (empty after smoke cleanup)
- `ralph/hooks/hooks.json` (one SessionStart hook → `set-skill-env.sh`)
- `ralph/hooks/scripts/set-skill-env.sh` + `hook-utils.sh`
- `ralph/CLAUDE.md`, `ralph/README.md`
- Local-dev symlink at `~/.claude/plugins/cache/ralph/HEAD` → `/Users/dubiel/projects/ralph-hero/ralph` (working as verified by the smoke skill).

The source plugin's cursor management hook lives at `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh` and is wired in `plugin/ralph-hero/hooks.json` as `PostToolUse:mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity`. It writes `~/.ralph-hero/cursors/catch-up.json` from `tool_response.cursor_advanced_to`. This is the only hook Plan 1 must port; `record-activity.sh` (the matcher-less activity logger) stays owned by `plugin/ralph-hero/` during the migration window — that log is a substrate concern, not a verb concern, and it writes to a shared per-machine path under `~/.ralph-hero/activity/`.

### Key Discoveries

- `recent_activity` MCP tool already supports `compact: true, category: "work", limit: 50` (`plugin/ralph-hero/skills/catch-up/SKILL.md:34-41`). No MCP changes needed.
- `next_actions` already fetches open PRs internally and marks one direction `recommended: true` (`plugin/ralph-hero/skills/hello/SKILL.md:36-40`). The skill must NOT pass `openPRs`.
- `pipeline_dashboard` already supports `format: json|markdown|ascii` plus `includeHealth` and `includeMetrics` (`plugin/ralph-hero/skills/status/SKILL.md:37-40`, `plugin/ralph-hero/skills/report/SKILL.md:36-42`). No MCP changes.
- `create_status_update` is the write side of report and accepts `{status, body}` (`plugin/ralph-hero/skills/report/SKILL.md:132-138`).
- The hello skill's tiebreak transparency (`signals.tiedAtScore > 1`) and the M/L/XL estimate-weight rule ("never describe XL work as 'small'") are real lessons-learned from production iteration (`plugin/ralph-hero/skills/hello/SKILL.md:61-71`) — they must survive the move verbatim.
- Status's negative-constraint prose (`plugin/ralph-hero/skills/status/SKILL.md:55-101`) is a wall of "never editorialize / never prescribe / NEVER produce Key Findings" with a negative example. This survived production iteration on a model that *will* synthesize if you let it. It must move verbatim into `dashboard-render.md`.
- Hook port mechanics: the `cursor-advance-catch-up.sh` script reads `tool_response.cursor_advanced_to` and writes the cursor file. It is matcher-bound to the `recent_activity` MCP tool by name, which is identical across plugins (cross-plugin invocation uses the same tool name).

## Desired End State

After Plan 1 merges:

1. `/ralph:catch-up` is discoverable in any fresh Claude Code session (plugin installed via marketplace, skill listed under `ralph:catch-up`).
2. `/ralph:catch-up` with no args produces a briefing equivalent to today's `/hello` (catch-up narrative paragraph + AskUserQuestion picker over `next_actions` directions with one recommended default + Agent dispatch).
3. `/ralph:catch-up --mode narrative` produces equivalent output to today's `/catch-up` (2-4 sentence narrative, no picker).
4. `/ralph:catch-up --mode dashboard` produces equivalent output to today's `/status` (raw `pipeline_dashboard` render, no analyst commentary).
5. `/ralph:catch-up --mode report` composes and (when not `--dry-run`) posts a GitHub Projects V2 status update equivalent to today's `/report`.
6. `/ralph:catch-up --mode help` (and `--help` / `-h`) prints the mode table.
7. Old `ralph-hero:*` skills (`hello`, `catch-up`, `status`, `report`, `cos`) remain functional and untouched. Sunset is Plan 10's job.
8. `ralph/skills/catch-up/SKILL.md` is ≤ 200 lines (target ~150). Opinion content lives in four flat-sibling reference files.
9. `ralph/hooks/hooks.json` includes the `PostToolUse:ralph_hero__recent_activity` matcher → `cursor-advance-catch-up.sh`. Cursor file at `~/.ralph-hero/cursors/catch-up.json` advances correctly after each invocation that calls `recent_activity`.
10. `ralph/README.md` migration table shows Plan 1 as "shipped".
11. Friction-log entry appended to the spec doc at `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:catch-up` without errors.
- Invoking `/ralph:catch-up` three times against the real `cdubiel08/ralph-hero` project board, each time producing prose + a picker, with the recommended pick matching what `/hello` would have chosen.
- `wc -l ralph/skills/catch-up/SKILL.md` reports ≤ 200.
- `cat ~/.ralph-hero/cursors/catch-up.json` advances after each invocation that called `recent_activity`.
- Old `/ralph-hero:hello` still works (sanity check).

## What We're NOT Doing

- **Not** absorbing `cos`'s `desk` / `remote` / `unattended` modes into the slash-command skill. They stay as `ralph cos {desk,remote,unattended}` CLI subcommands. Their entire raison d'être is zero-Claude-Code-on-the-call-chain.
- **Not** moving `plugin/ralph-hero/scripts/cos/` to `ralph/scripts/cos/`. That's a Plan 10 cleanup decision.
- **Not** porting `record-activity.sh` (the matcher-less PostToolUse activity logger). It stays owned by `plugin/ralph-hero/` for the migration window; the activity log it writes is a per-machine substrate concern, not a verb concern.
- **Not** sunsetting the source skills. They remain functional for at least the 2-week dogfooding window (spec acceptance #5). Sunset is Plan 10.
- **Not** adding a `--mode {desk,remote,unattended}` shim that shells out to `cos.sh`. That would invert the zero-Claude-Code property by design.
- **Not** refactoring the MCP server. All MCP tools used by Plan 1 already exist (`recent_activity`, `next_actions`, `pipeline_dashboard`, `create_status_update`, `metrics_trends`, plus the Agent dispatch tools).
- **Not** introducing a `references/` subfolder. Spec P2 default is flat siblings.
- **Not** adding a PreToolUse gate on `create_status_update` to guard accidental posts. `--dry-run` is the safe-default approach (P9 — YAGNI). If accidental posts become a real failure mode, that hook is a separate one-line PR.

## Implementation Approach

Five XS-sized phases, each owning a tightly-scoped file set so phases are independently mergeable and resumable:

1. **Scaffold + hook port** owns: `ralph/skills/catch-up/SKILL.md` (stub), four empty reference siblings, `ralph/hooks/scripts/cursor-advance-catch-up.sh` (copy), `ralph/hooks/hooks.json` (one PostToolUse matcher added).
2. **Default surface** owns: `ralph/skills/catch-up/SKILL.md` (default flow body), `ralph/skills/catch-up/narrative-synthesis.md`, `ralph/skills/catch-up/next-action-ranking.md`.
3. **Read-only modes** owns: `ralph/skills/catch-up/SKILL.md` (two new mode branches), `ralph/skills/catch-up/dashboard-render.md`.
4. **Write mode** owns: `ralph/skills/catch-up/SKILL.md` (one new mode branch), `ralph/skills/catch-up/report-composition.md`.
5. **Parity validation + dogfooding** owns: `ralph/README.md`, `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (append-only friction-log entry).

Only `ralph/skills/catch-up/SKILL.md` is touched in multiple phases — and each phase appends a discrete section. The other files are single-owner.

## Phase 1: Scaffold + hook port

### Overview

Stand up the directory structure and wire the cursor hook so subsequent phases have a working SKILL.md to fill in. No user-visible behavior beyond `--help`.

### Changes Required

#### 1. Skill scaffold

**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: New file with frontmatter, mode dispatch skeleton, and `--help` body. ~50 lines for this phase; subsequent phases fill in mode branches.

```markdown
---
description: Orientation companion — catches you up on what changed since you last
  checked, then surfaces actionable directions with a recommended default. Folds the
  ralph-hero hello, catch-up, status, report, and cos verbs. Default flow is
  narrative + interactive picker; --mode flag selects narrative / dashboard /
  report sub-surfaces.
argument-hint: "[--mode {narrative,dashboard,report}] [--dry-run] [--window N] [--status ON_TRACK|AT_RISK|OFF_TRACK] [--with-trends]"
context: inline
allowed-tools:
  - Read
  - Skill
  - Agent
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_status_update
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__metrics_trends
---

# /ralph:catch-up — Orientation

The unified orientation verb. Default flow is narrative + picker (matches the old
`/ralph-hero:hello`). The `--mode` flag selects a single-surface alternative.

## Mode dispatch

| Mode | Behavior | Equivalent to |
|---|---|---|
| (default, no `--mode`) | Narrative paragraph + AskUserQuestion picker over `next_actions`, then Agent dispatch | `/ralph-hero:hello` |
| `--mode narrative` | 2-4 sentence narrative only, no picker, no dispatch | `/ralph-hero:catch-up` |
| `--mode dashboard` | Raw `pipeline_dashboard` render (markdown / ascii / json) | `/ralph-hero:status` |
| `--mode report` | Compose status update; post via `create_status_update` (default `--dry-run`) | `/ralph-hero:report` |
| `--help` / `-h` | Print this table and exit | — |

> The `cos` family (`desk`, `remote`, `unattended`) is deliberately CLI-only —
> see `ralph cos --help`. Those modes shell out to a local LLM specifically to
> avoid spawning Claude Code (phone-friendly, scheduled, offline).

## Default flow

_(Filled by Phase 2)_

## --mode narrative

_(Filled by Phase 3)_

## --mode dashboard

_(Filled by Phase 3)_

## --mode report

_(Filled by Phase 4)_

## References

- `narrative-synthesis.md` — catch-up narrative tone rules + cursor mechanics
- `next-action-ranking.md` — signal-cue table, picker label rules, dispatch table
- `dashboard-render.md` — pipeline render rules + negative-constraint prose
- `report-composition.md` — markdown template, status determination, --with-trends
```

#### 2. Reference siblings (empty stubs)

**File**: `ralph/skills/catch-up/narrative-synthesis.md`
**Changes**: New file. One-line stub: `# Narrative synthesis` + `_Filled by Phase 2_`.

**File**: `ralph/skills/catch-up/next-action-ranking.md`
**Changes**: New file. One-line stub: `# Next-action ranking` + `_Filled by Phase 2_`.

**File**: `ralph/skills/catch-up/dashboard-render.md`
**Changes**: New file. One-line stub: `# Dashboard render` + `_Filled by Phase 3_`.

**File**: `ralph/skills/catch-up/report-composition.md`
**Changes**: New file. One-line stub: `# Report composition` + `_Filled by Phase 4_`.

#### 3. Cursor hook port

**File**: `ralph/hooks/scripts/cursor-advance-catch-up.sh`
**Changes**: Copy verbatim from `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh`. No edits (the script reads `tool_response.cursor_advanced_to` and writes to `~/.ralph-hero/cursors/catch-up.json` — both are global per-machine paths, plugin-agnostic). Set executable bit.

Verification command:

```bash
diff plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh \
     ralph/hooks/scripts/cursor-advance-catch-up.sh
# Expected: empty diff
test -x ralph/hooks/scripts/cursor-advance-catch-up.sh && echo OK
```

#### 4. Hooks.json wiring

**File**: `ralph/hooks/hooks.json`
**Changes**: Add a `PostToolUse` matcher block alongside the existing `SessionStart` block.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/cursor-advance-catch-up.sh"
          }
        ]
      }
    ]
  }
}
```

### Success Criteria

#### Automated Verification

- [ ] File present: `test -f ralph/skills/catch-up/SKILL.md`
- [ ] File line count within budget: `[ "$(wc -l < ralph/skills/catch-up/SKILL.md)" -le 200 ]`
- [ ] All four references present: `for f in narrative-synthesis next-action-ranking dashboard-render report-composition; do test -f "ralph/skills/catch-up/$f.md" || exit 1; done`
- [ ] Hook script copied verbatim: `diff plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh ralph/hooks/scripts/cursor-advance-catch-up.sh`
- [ ] Hook script executable: `test -x ralph/hooks/scripts/cursor-advance-catch-up.sh`
- [ ] hooks.json valid JSON: `jq . ralph/hooks/hooks.json > /dev/null`
- [ ] hooks.json contains PostToolUse matcher: `jq -e '.hooks.PostToolUse[0].matcher == "mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity"' ralph/hooks/hooks.json`

#### Manual Verification

- [ ] After `/reload-plugins`, `/ralph:catch-up --help` returns the mode table.
- [ ] No SessionStart errors logged for `ralph` plugin.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: Default surface — narrative + picker

### Overview

Wire the no-args default flow (catch-up sub-agent → `next_actions` → AskUserQuestion → Agent dispatch). Move all opinion content into `narrative-synthesis.md` and `next-action-ranking.md`.

### Changes Required

#### 1. Default-flow body in SKILL.md

**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: Replace the `## Default flow` placeholder section with a ~50-line workflow. Mirror `plugin/ralph-hero/skills/hello/SKILL.md:26-131` but redirect opinion content to the references.

```markdown
## Default flow

You compose three primitives:

1. `narrative-synthesis.md` rules → `Agent(subagent_type="ralph-hero:catch-up-agent")` for the catch-up narrative.
2. `ralph_hero__next_actions` MCP tool → ranks work, marks one `recommended: true`. Do NOT pass `openPRs`.
3. `AskUserQuestion` picker over the ranked directions.

### Step 1: Catch-up narrative

Dispatch `Agent(subagent_type="ralph-hero:catch-up-agent", description="Catch-up narrative", prompt="Synthesize the catch-up narrative for this session.")`. Capture the returned text — it is the only output you need. The 200-event activity payload stays in the sub-agent's context, not yours.

If the sub-agent returns empty or errors, skip the narrative paragraph and proceed.

### Step 2: Compute directions

Call `ralph_hero__next_actions` with `limit=3, audience="human"`. Capture `directions[]`.

### Step 3: Render briefing

Output ≤ 40 lines total. Structure:

1. The catch-up narrative verbatim (one paragraph, 2-4 sentences). If empty, skip.
2. One synthesized sentence introducing the recommendations, naming the recommended pick. See `narrative-synthesis.md` and `next-action-ranking.md` for synthesis rules — **never quote `direction.reason` verbatim**.
3. The picker (Step 4).

For per-direction synthesis (the introductory sentence and each picker option's description), read `next-action-ranking.md` — it carries the signal-cue table, tiebreak transparency rules, and the M/L/XL estimate-weight rule.

**Empty directions case**: if `directions` is empty, output `Things look calm — nothing stuck, nothing on fire.` Skip the picker. Stop.

### Step 4: Picker

Present `AskUserQuestion` with options derived 1:1 from `directions[]`. The `recommended: true` option is FIRST (default). Per-option labels and the dispatch table both live in `next-action-ranking.md`. Add a final option: `{label: "Work through these in order", description: "Address each direction in order"}`.

If `CLAUDE_NONINTERACTIVE` is set or `AskUserQuestion` is unavailable, skip the picker and end with: *"Recommended: [recommended action] — invoke explicitly to proceed."*

### Step 5: Dispatch

Based on the pick, dispatch via `Agent()` or `Skill()` per the table in `next-action-ranking.md`. For "Work through these in order": dispatch sequentially in `directions[]` order, noting before each subsequent dispatch *"Earlier actions may have changed board state."*

After dispatch completes, output `Session complete.`
```

#### 2. `narrative-synthesis.md` — replace stub

**File**: `ralph/skills/catch-up/narrative-synthesis.md`
**Changes**: Replace stub with the full narrative-synthesis ruleset. Port `plugin/ralph-hero/skills/catch-up/SKILL.md:17-75` verbatim minus the `# Catch-up` header (now redundant), reframed as "consulted by the catch-up sub-agent". Sections:

- **Cursor mechanics**: read `~/.ralph-hero/cursors/catch-up.json`; if missing, default to 24h ago in ISO8601 UTC. Cursor write is handled automatically by the `cursor-advance-catch-up.sh` PostToolUse hook — this doc consumer must NOT write the cursor file directly.
- **Memory read (optional)**: `MEMORY.md` is supplementary context for the synthesis prompt; missing memory does not gate.
- **`recent_activity` call shape**: `since=cursor`, `category="work"`, `limit=50`, `compact=true`. Internal note: `compact=true` drops `actor`, `session_id`, `category`, wrapper `target` — narrative synthesis only needs `ts, kind, tool, project`.
- **Empty case**: output `Nothing's changed since last time you checked.` Stop.
- **Populated case**: 2-4 sentences describing what happened. Lean on event kinds + issue/PR numbers + patterns. No bullet lists; prose only. No severity tags, no dashboard formatting, no JSON.
- **Long-absence prefix**: if `events.length` was at the `limit` cap, prefix with `A lot has happened since last time — here are the highlights:`.

Target ~80 lines.

#### 3. `next-action-ranking.md` — replace stub

**File**: `ralph/skills/catch-up/next-action-ranking.md`
**Changes**: Replace stub with the full ranking ruleset. Port `plugin/ralph-hero/skills/hello/SKILL.md:32-124` (Steps 2-5 of the old skill) reframed as a reference. Sections:

- **`next_actions` call shape**: `limit=3, audience="human"`. Open PRs fetched internally; do not pass `openPRs`.
- **Per-direction synthesis** — the signal-cue table verbatim from `hello/SKILL.md:61-71` covering `issue (staleDays)`, `issue (estimateWeight set, M/L/XL)`, `issue (tiedAtScore > 1)`, `lock-stale`, `tree-continue`, `pr`, `human-needed-unblock`.
- **Synthesis rules**: compose from `signals + title + memory (catch-up output + MEMORY.md)`. Never quote `direction.reason` verbatim. Surface tiebreak transparency when `signals.tiedAtScore > 1`. Reflect estimate size honestly — never describe XL work as "small". Weave `signals.parentChainNote` into tree-continue prose rather than emitting "active tree".
- **Title fragment truncation rule** verbatim from `hello/SKILL.md:98-101`: ≤30 chars; cut at word boundary in last 5 chars when possible; append `…` only if truncation occurred.
- **Per-kind label rules** verbatim from `hello/SKILL.md:88-96`.
- **Dispatch table** verbatim from `hello/SKILL.md:113-122` (kind/workflowState → Agent subagent_type or Skill call).

Target ~120 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/catch-up/SKILL.md)" -le 200 ]`
- [ ] `narrative-synthesis.md` is non-stub: `[ "$(wc -l < ralph/skills/catch-up/narrative-synthesis.md)" -ge 40 ]`
- [ ] `next-action-ranking.md` is non-stub: `[ "$(wc -l < ralph/skills/catch-up/next-action-ranking.md)" -ge 80 ]`
- [ ] SKILL.md references both files by name: `grep -q 'narrative-synthesis.md' ralph/skills/catch-up/SKILL.md && grep -q 'next-action-ranking.md' ralph/skills/catch-up/SKILL.md`
- [ ] No `direction.reason` quoted-verbatim anti-pattern: `! grep -E 'direction\.reason' ralph/skills/catch-up/SKILL.md`

#### Manual Verification

- [ ] `/ralph:catch-up` (no args) produces a briefing equivalent to `/ralph-hero:hello`: narrative paragraph, then a picker with one recommended pick, then dispatches on selection.
- [ ] Picker labels match the per-kind rules (`Plan #NNN · …`, `Review plan #NNN · …`, etc.).
- [ ] After invocation, `~/.ralph-hero/cursors/catch-up.json` has advanced.
- [ ] Old `/ralph-hero:hello` still works unchanged.

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Read-only modes — `--mode narrative`, `--mode dashboard`

### Overview

Wire two single-surface read-only modes. Narrative is the no-picker variant (today's `/catch-up`). Dashboard is the raw-render variant (today's `/status`).

### Changes Required

#### 1. Two new mode branches in SKILL.md

**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: Fill the `## --mode narrative` and `## --mode dashboard` placeholder sections.

```markdown
## --mode narrative

Dispatch the same `Agent(subagent_type="ralph-hero:catch-up-agent")` as the default flow's Step 1. Return only the narrative text (or the empty-case sentence). No picker, no dispatch.

Consult `narrative-synthesis.md` for tone rules.

## --mode dashboard

Parse the trailing argument (after `--mode dashboard`) as the output format. Default to `markdown`. Valid formats: `markdown`, `ascii`, `json`.

Call `ralph_hero__pipeline_dashboard` with `format=<parsed>, includeHealth=true, issuesPerPhase=5`. Render per `dashboard-render.md`:

- If `format == "json"`: emit `JSON.stringify(dashboard, null, 2)` inside a fenced ```json``` block. No narration. No prose. Stop.
- If `format == "markdown" | "ascii"`: emit `dashboard.formatted` verbatim. If critical health warnings exist, surface them raw under a `### Critical Health Warnings (N)` heading. No analysis, no key findings, no recommendations.

The negative-constraint surface ("never prescribe, never editorialize") is load-bearing and lives in `dashboard-render.md`. Consult it before generating any output for this mode.
```

#### 2. `dashboard-render.md` — replace stub

**File**: `ralph/skills/catch-up/dashboard-render.md`
**Changes**: Replace stub with the full dashboard render ruleset. Port `plugin/ralph-hero/skills/status/SKILL.md:32-101` verbatim, reframed as a reference consulted by `--mode dashboard`. Sections:

- **`pipeline_dashboard` call shape**: `format`, `includeHealth=true`, `issuesPerPhase=5`.
- **Format routing**: JSON mode emits fenced literal, no narration; markdown/ascii mode emits `formatted` verbatim.
- **Critical health warnings**: in JSON mode they're already in the payload — do not re-surface. In markdown/ascii mode, surface raw under `### Critical Health Warnings (N)` after the formatted block.
- **Output scope** verbatim from `status/SKILL.md:54-67`: read-only passive render. NOT a triage tool, NOT an analyst, NOT a recommender.
- **NEVER list** verbatim from `status/SKILL.md:60-66`: prescribe actions, add diagnostic framing, synthesize key findings, group/rank/editorialize warnings, cross-reference issues.
- **Negative example** verbatim from `status/SKILL.md:69-87` (the "do NOT produce output like this" block).
- **Correct shape** verbatim from `status/SKILL.md:89-101`.

Target ~70 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/catch-up/SKILL.md)" -le 200 ]`
- [ ] `dashboard-render.md` is non-stub: `[ "$(wc -l < ralph/skills/catch-up/dashboard-render.md)" -ge 40 ]`
- [ ] `dashboard-render.md` carries the negative-example block (verbatim signature): `grep -q "Key Findings" ralph/skills/catch-up/dashboard-render.md`
- [ ] `dashboard-render.md` carries the NEVER list: `grep -q "NEVER" ralph/skills/catch-up/dashboard-render.md`
- [ ] SKILL.md `--mode dashboard` references the dashboard render doc: `grep -A 20 '## --mode dashboard' ralph/skills/catch-up/SKILL.md | grep -q 'dashboard-render.md'`

#### Manual Verification

- [ ] `/ralph:catch-up --mode narrative` produces a 2-4 sentence prose narrative; no picker; output text matches `/ralph-hero:catch-up` invocation.
- [ ] `/ralph:catch-up --mode dashboard` (default markdown) produces the same dashboard markdown as `/ralph-hero:status`. No "Key Findings" or "Recommendations" sections appear.
- [ ] `/ralph:catch-up --mode dashboard json` produces a fenced JSON block; no surrounding prose.
- [ ] If critical health warnings exist on the board, they surface as a raw list — no editorialization.

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 4.

---

## Phase 4: Write mode — `--mode report`

### Overview

Wire the write mode. Composes a markdown report and (when not `--dry-run`) posts via `create_status_update`. Default to `--dry-run` is **not** part of the spec for the equivalent `/ralph-hero:report` — but the parsed-arg fallthrough is `--dry-run` when no posting is intended. Plan 1 preserves the source behavior: `--dry-run` if passed; otherwise post.

### Changes Required

#### 1. `--mode report` branch in SKILL.md

**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: Fill the `## --mode report` placeholder section. ~25 lines.

```markdown
## --mode report

Parse arguments:
- `--dry-run`: compose but do not post
- `--window N`: override the time window in days (default 7)
- `--status ON_TRACK|AT_RISK|OFF_TRACK`: override auto-determined status
- `--with-trends`: append a Trends section (sparklines + 1d/7d/30d deltas)

Compose per `report-composition.md`:

1. Fetch `ralph_hero__pipeline_dashboard` with `format="json", includeHealth=true, includeMetrics=true, doneWindowDays=<window>, velocityWindowDays=<window>`.
2. Handle the metrics-absent fallback per `report-composition.md`.
3. Compose the markdown body using the template in `report-composition.md`.
4. If `--with-trends`, call `ralph_hero__metrics_trends` with `format="markdown"` and append under `## Trends` only when ≥2 snapshots exist.
5. Determine final status: `--status` override > `metrics.status` > fallback.

If `--dry-run`: display the composed body + determined status + `Dry run complete. No status update posted.`. Stop.

Otherwise: call `ralph_hero__create_status_update` with `{status, body}`. Display the response: status update ID + status + first 200 chars of body. Print `Status update posted successfully.`
```

#### 2. `report-composition.md` — replace stub

**File**: `ralph/skills/catch-up/report-composition.md`
**Changes**: Replace stub with the full report composition ruleset. Port `plugin/ralph-hero/skills/report/SKILL.md:23-142` verbatim, reframed as a reference. Sections:

- **Argument parsing** verbatim from `report/SKILL.md:23-33`.
- **`pipeline_dashboard` call shape** verbatim from `report/SKILL.md:34-42`.
- **Metrics fallback** verbatim from `report/SKILL.md:44-59`: `velocity = count of Done`; status from `health.ok` (`true → ON_TRACK`, critical → `OFF_TRACK`, else `AT_RISK`); empty highlights; note "(metrics unavailable — using dashboard fallback)".
- **Markdown template** verbatim from `report/SKILL.md:62-106` — Pipeline Summary table, Velocity, Health Indicators (grouped by severity), Highlights (Recently Completed + Newly Added), Status footer.
- **Trends append** verbatim from `report/SKILL.md:108-116`: skip silently when <2 snapshots; place after the `## Status:` block under a `## Trends` H2.
- **Final status determination** verbatim from `report/SKILL.md:118-123`.

Target ~110 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/catch-up/SKILL.md)" -le 200 ]`
- [ ] `report-composition.md` is non-stub: `[ "$(wc -l < ralph/skills/catch-up/report-composition.md)" -ge 70 ]`
- [ ] `report-composition.md` carries the markdown template: `grep -q '## Pipeline Summary' ralph/skills/catch-up/report-composition.md`
- [ ] `report-composition.md` covers the metrics fallback path: `grep -q 'metrics unavailable' ralph/skills/catch-up/report-composition.md`
- [ ] SKILL.md `--mode report` references the composition doc: `grep -A 20 '## --mode report' ralph/skills/catch-up/SKILL.md | grep -q 'report-composition.md'`

#### Manual Verification

- [ ] `/ralph:catch-up --mode report --dry-run` prints the composed markdown body + determined status + `Dry run complete.` line. No status update posted.
- [ ] `/ralph:catch-up --mode report` posts a real status update to the `cdubiel08/ralph-hero` project board. Status update ID returned; body visible in the project board's status updates section.
- [ ] `/ralph:catch-up --mode report --status OFF_TRACK --dry-run` honors the override and prints `OFF_TRACK` in the footer.
- [ ] `/ralph:catch-up --mode report --with-trends --dry-run` appends a `## Trends` section if ≥2 snapshots exist; silently skips otherwise.
- [ ] Composed markdown matches `/ralph-hero:report --dry-run` output for the same window.

**Implementation Note**: Pause for manual confirmation before proceeding to Phase 5. The `--mode report` (non-dry-run) verification will post a real status update to the project board — that's an acceptable side effect for parity validation.

---

## Phase 5: Parity validation + dogfooding setup

### Overview

Final parity validation across 3 real sessions, README update, friction-log entry. No source code changes after this phase.

### Changes Required

#### 1. README migration table

**File**: `ralph/README.md`
**Changes**: Update the migration table row for Plan 1.

```diff
-| 1 | `/ralph:catch-up` | pending |
+| 1 | `/ralph:catch-up` | shipped |
```

Also update the `## Status` paragraph to reflect that the plugin now exposes one user-facing skill.

```diff
-**Plan 0 of 11 (scaffold).** This plugin currently exposes zero user-facing skills. Verbs are migrated in one at a time per the plan-of-plans.
+**Plan 1 of 11 (catch-up shipped).** This plugin currently exposes one user-facing skill (`/ralph:catch-up`). Verbs are migrated in one at a time per the plan-of-plans.
```

#### 2. Friction-log entry on the spec

**File**: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`
**Changes**: Append a new `## Friction Log` section at the end of the document (after `## What "Done" Looks Like`). Add the first entry for Plan 1.

```markdown
## Friction Log

The dogfooding rhythm depends on capturing lessons-learned from each shipped verb to feed the next plan's design.

### Plan 1: `/ralph:catch-up` (shipped YYYY-MM-DD)

Real-session usage notes during the 2-week dogfooding window:

- [ ] Cross-plugin MCP invocation pattern works as expected; no friction.
- [ ] _(Add entries as you use it. Examples to watch for: edge cases in narrative synthesis, picker label truncation issues, dashboard JSON-mode quirks, report-mode posting permissions, cursor advance timing.)_

Inputs to feed into Plan 2 (`/ralph:form`):

- _(TBD after 2 weeks of usage.)_
```

#### 3. Parity validation runs

No file changes. Execute three real `/ralph:catch-up` invocations against the live `cdubiel08/ralph-hero` project board, exercising different code paths:

1. **Default flow + dispatch on a real pick** (e.g., recommended is a `Plan in Review` issue → review-agent dispatches).
2. **`--mode dashboard`** (markdown) and verify against a same-time `/ralph-hero:status` invocation.
3. **`--mode report --dry-run`** and verify against a same-time `/ralph-hero:report --dry-run` invocation.

Record observations in the friction-log entry created in change #2.

### Success Criteria

#### Automated Verification

- [ ] README migration table line updated: `grep -q '| 1 | \`/ralph:catch-up\` | shipped |' ralph/README.md`
- [ ] README status paragraph updated: `grep -q 'Plan 1 of 11' ralph/README.md`
- [ ] Friction-log section exists in the spec: `grep -q '## Friction Log' thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`
- [ ] Spec doc still ends cleanly (no truncation): `tail -1 thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md | wc -c | grep -qE '^\s*[1-9]'`

#### Manual Verification

- [ ] Three real `/ralph:catch-up` sessions completed and recorded in the friction log.
- [ ] Each session shows output equivalent (within tolerance — narrative wording will vary; structure must match) to the corresponding old skill.
- [ ] No regressions in `/ralph-hero:hello`, `/ralph-hero:catch-up`, `/ralph-hero:status`, `/ralph-hero:report`, or any `ralph cos *` CLI command.
- [ ] After two weeks of usage, friction-log inputs feed Plan 2 design (separate plan; not a Plan 1 deliverable).

**Implementation Note**: The 2-week dogfooding window starts when Plan 1 merges. Sunsetting any source skill is explicitly Plan 10's job — Plan 1 does not delete or alter `plugin/ralph-hero/skills/{hello,catch-up,status,report,cos}/`.

---

## Testing Strategy

### Unit Tests

None. The new skill is a markdown workflow; it has no compiled code. The MCP tools it consumes are already covered by the ralph-hero MCP server's existing test suite.

### Integration Tests

The "3 real sessions" parity check in Phase 5 is the integration test. There is no automated harness for skill execution against a live GitHub project.

### Manual Testing Steps

Per Phase 5's manual verification list:

1. `/plugin marketplace update ralph-hero && /reload-plugins` in a fresh Claude Code session.
2. `/ralph:catch-up --help` → mode table.
3. `/ralph:catch-up` → narrative + picker; pick the recommended option; observe Agent dispatch.
4. `/ralph:catch-up --mode narrative` → 2-4 sentence prose only.
5. `/ralph:catch-up --mode dashboard` → raw `pipeline_dashboard` markdown; no editorialization.
6. `/ralph:catch-up --mode dashboard json` → fenced JSON only.
7. `/ralph:catch-up --mode report --dry-run` → composed body + status footer + `Dry run complete.`
8. `/ralph:catch-up --mode report` → real status update posted; ID returned.
9. Verify cursor file at `~/.ralph-hero/cursors/catch-up.json` advances after invocations that call `recent_activity`.
10. Sanity-check `/ralph-hero:hello` still works unchanged.

## Performance Considerations

- The new skill's worst-case invocation is the default flow: 1 Agent dispatch (catch-up sub-agent) + 1 MCP call (`next_actions`) + 1 AskUserQuestion + 1 Agent dispatch (the picked direction). Same as today's `/ralph-hero:hello`. No new latency.
- `--mode narrative` saves the next_actions call and the picker → faster than the default.
- `--mode dashboard` is a single MCP call → fastest.
- `--mode report` is two MCP calls + an optional third (`metrics_trends`) → same as today's `/ralph-hero:report`.
- Cross-plugin MCP invocation has no measurable overhead beyond local MCP (the tool name resolution is constant-time).

## Migration Notes

- Old skills (`hello`, `catch-up`, `status`, `report`, `cos`) remain functional and unmodified for the 2-week dogfooding window. Plan 10 owns sunset.
- `cos` CLI subcommands (`ralph cos {desk,remote,unattended}`) continue to work via the existing `plugin/ralph-hero/scripts/cos/` scripts. They are not user-facing slash commands and stay outside the migration boundary for Plan 1.
- The `cursor-advance-catch-up.sh` hook is now wired in BOTH plugins during the migration window. Both invocations are idempotent (last write wins; the cursor file is overwritten, not appended to). Verified by inspection of the source script (`plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh`).
- `record-activity.sh` (the per-session activity logger) stays owned by `plugin/ralph-hero/` and is NOT ported in Plan 1. The activity log it writes is consumed by the new `/ralph:catch-up` via the cross-plugin `recent_activity` MCP tool.
- No backwards-compatibility shims are needed. The new skill is a parallel surface; the old skills are unchanged.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 1 at line 333).
- Plan 0 scaffold merge: commit `dd4e948f` (marketplace registration), `c714aa50` (smoke cleanup), `986b165e` (PR #1356 merge).
- Source skill bodies:
  - `plugin/ralph-hero/skills/hello/SKILL.md:26-131`
  - `plugin/ralph-hero/skills/catch-up/SKILL.md:17-75`
  - `plugin/ralph-hero/skills/status/SKILL.md:32-101`
  - `plugin/ralph-hero/skills/report/SKILL.md:23-142`
  - `plugin/ralph-hero/skills/cos/SKILL.md:31-60`
- Source hook: `plugin/ralph-hero/hooks/scripts/cursor-advance-catch-up.sh`.
- Source cos scripts (not migrated in Plan 1): `plugin/ralph-hero/scripts/cos/cos.sh`, `cos-desk.sh`, `cos-remote.sh`, `cos-unattended.sh`, `morning-brief.sh`.
- ralph plugin scaffold: `ralph/.claude-plugin/plugin.json`, `ralph/hooks/hooks.json`, `ralph/README.md`, `ralph/CLAUDE.md`.
