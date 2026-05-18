---
date: 2026-05-07
status: draft
type: plan
tags: [skill, autopilot, loop, hero, autonomous, scheduling]
github_issue: 1136
github_issues: [1136]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1136
primary_issue: 1136
revision: 3
---

# Autopilot Skill Implementation Plan

> **Revision 3** — addresses 5 findings from `thoughts/shared/reviews/2026-05-08-GH-1136-critique-r2.md`: (1) **CRITICAL** In-Review re-pick loop fix via new Step 2.5 filter, (2) reconcile delaySeconds bucket inconsistency between dispatchability table and body, (3) add catch-all row to outcome table, (4) specify `next_delay_seconds: null` for STOP outcomes, (5) `--state=BASE64` equals-syntax. R2 had closed 7 of 8 R1 findings cleanly but introduced one regression (false-positive escalation of just-PR'd issues after 3 60s ticks); R3 fixes that without re-introducing CI babysitting.

> **Revision 2** — addressed all 8 findings from `thoughts/shared/reviews/2026-05-07-GH-1136-critique.md`. Key changes from R1: tick-isolation section added; budget-cap termination deferred to follow-up; outcome detection switched from text-grep to pre/post `get_issue` diff; CI-awaiting cache bucket dropped (autopilot is a dispatcher, not a CI babysitter); cross-tick state moved from audit-log tail to `prompt` field; hook gate's `RALPH_COMMAND` check dropped (redundant with prompt regex); per-phase dispatchability table added; README + CLAUDE.md prose pre-drafted.

## Overview

Add `/ralph-hero:autopilot` — a single-command shorthand that enters Claude Code's `/loop`-style self-pacing mode and clears the backlog by repeatedly dispatching `/ralph-hero:hero` against the next-most-important actionable issue, escalating to "Human Needed" when stuck and stopping cleanly when the queue is empty. The skill replaces the manual mantra "`/loop please run in a loop until the backlog is cleared; you have license to go full auto…`" with a single invocation that bakes in opinionated termination, escalation, and audit rails. Budget-cap termination is deferred to a follow-up issue once hero surfaces structured token telemetry.

## Current State Analysis

Five pieces of relevant infrastructure already exist; the new skill composes them rather than reinventing them.

**1. Out-of-process loop runner** — `plugin/ralph-hero/scripts/ralph-loop.sh` already implements autonomous batch execution outside Claude Code, driving `claude -p` subprocesses through the per-phase skills. It detects queue-empty via `grep -qiE "Queue empty|Triage complete"` in skill output and caps at `MAX_ITERATIONS=10`. This is the reference for termination logic; the new skill is its in-process counterpart.

**2. Single-issue orchestrator** — `plugin/ralph-hero/skills/hero/SKILL.md:54-112` drives one root issue through SPLIT→RESEARCH→PLAN→REVIEW→IMPLEMENT→PR→FINISH. Resumability section at `hero/SKILL.md:491-499` uses `get_issue(includePipeline=true)` (server-side, persists across contexts) **and** `TaskList()` (per-session, does NOT persist). The TaskList behavior is critical for autopilot's tick-isolation reasoning (see §Tick Isolation below).

**3. Self-pacing primitive** — `ScheduleWakeup` is the dispatcher for `/loop`'s dynamic mode. Tool description (verbatim): *"Pass the same /loop prompt back via `prompt` each turn so the next firing repeats the task."* The `delaySeconds` field is clamped to [60, 3600] and the docs explicitly warn against picking 300s exactly. **Verified zero existing callers** in `plugin/` (`grep -rn ScheduleWakeup plugin/` returns no results) — the hook gate cannot break any current skill.

**4. Action ranking** — `mcp-server/src/lib/directions.ts:728` (`rankDirections`) scores by priority + phase + estimate. `audience: "agent"` penalty at `lib/directions.ts:270` plus `ESTIMATE_PENALTY` at `lib/directions.ts:211` tilts the agent toward XS/S work — autopilot inherits this for free.

**5. Escalation channel** — `workflow-states.ts:41-44` defines `"Human Needed"` as a non-pipeline terminal state. `__ESCALATE__` resolves universally via `state-resolution.ts:29`. Items in `"Human Needed"` are excluded from `ACTIONABLE_PHASES`, so once escalated they drop out of `next_actions` automatically.

**What's missing** — there is no in-Claude-Code autonomous backlog loop. The shell script requires the user to leave the Claude Code session and run a separate process.

## Desired End State

A user can type `/ralph-hero:autopilot` and walk away. The skill:

1. Picks the next-most-important actionable issue
2. Dispatches `/ralph-hero:hero N` for that issue (one tick = one issue end-to-end)
3. Records the tick outcome to a structured audit log on disk
4. Schedules the next tick via `ScheduleWakeup` if continuation criteria are met
5. Terminates cleanly on any of: empty backlog, escalation flagged this tick, three no-progress ticks in a row, or max-iterations hit
6. On termination: posts a final summary report to text output

**Verification** — invoking on a 3-issue XS backlog → 3 ticks, 3 PRs (or merges if `--auto-merge`), clean stop with "Backlog empty". Empty backlog → immediate stop with "No actionable work", no `ScheduleWakeup` call. Forced escalation → stops after first escalation, offending issue in "Human Needed", @owner mention posted.

### Tick Isolation (new in R2)

Each tick fires in a **fresh Claude Code context** (this is intrinsic to `ScheduleWakeup` semantics). Implications autopilot MUST handle:

| State category | Persists across ticks? | How autopilot handles it |
|---|---|---|
| GitHub project board state (workflow state, sub-issues, dependencies) | **Yes** (server-side) | Source of truth — `next_actions` and `get_issue(includePipeline=true)` re-derive everything from it each tick |
| `TaskList()` — hero's intra-session task graph | **No** (per-session) | Hero rebuilds its TaskList from `get_issue(includePipeline=true)` at the start of each dispatch (per `hero/SKILL.md:497-499` resumption logic). No autopilot action needed. |
| Worktrees (`worktrees/GH-NNN/`) from prior ticks' impl-agents | Filesystem persists, but the agent in the new tick has no memory | **Autopilot MUST run `git worktree list` at the start of each tick** and check whether the picked issue already has a worktree. If yes: this means a prior tick was interrupted mid-implement on this same issue. Autopilot escalates (do NOT re-dispatch hero, which would create a worktree collision) with reason "stale worktree from prior tick — needs human cleanup". |
| Iteration counter + no-progress streak | Encoded in `prompt` field of next `ScheduleWakeup` | Autopilot passes `--state base64(json)` in the next prompt; first tick initializes from defaults |
| Audit log | File at `~/.ralph-hero/autopilot.jsonl` | Append-only audit trail. NOT used as the recovery channel for runtime state. |

**Key design decision**: cross-tick state rides on the `prompt` field of `ScheduleWakeup`, not on the audit log. This is more robust against file race conditions, log rotation, and stale entries. The audit log remains a forensic artifact, not a state machine.

### Key Discoveries:

- `ScheduleWakeup` is callable from skills (verified by tool-description docs and zero-collision check in `plugin/`)
- `next_actions(audience="agent")` already biases toward XS/S via `ESTIMATE_PENALTY` in `lib/directions.ts:211`
- Hero is single-root-issue by design (`hero/SKILL.md:506`); autopilot calls hero once per tick
- `__ESCALATE__` resolves universally to `"Human Needed"` regardless of command (`state-resolution.ts:29`)
- Cache-window guidance: never pick exactly 300s; prefer ≤270s (warm) or ≥1200s (committed). Default idle delay 1800s
- Plugin agents already use a 3-attempt cap pattern (`code-review-agent` per `ralph-code-review/SKILL.md:174-218`); autopilot's no-progress streak mirrors it
- **`set-skill-env.sh` writes to `$CLAUDE_ENV_FILE` (per-session)** — using `RALPH_COMMAND=autopilot` as a hook-gate signal across `ScheduleWakeup` re-fires is unverified and possibly broken; the hook gate uses the `prompt` regex check exclusively (R2 design choice)

## What We're NOT Doing

- **NOT replacing `ralph-loop.sh`** — the shell script remains for `claude -p` headless use; both coexist.
- **NOT modifying `/hero` itself** — autopilot dispatches hero unchanged.
- **NOT shipping a `loop.md` template** — conflicts with users' existing loop.md files.
- **NOT adding new MCP tools** — pure composition over `next_actions`, `save_issue`, `create_comment`, `get_issue`, `ScheduleWakeup`, `Skill`, `Agent`.
- **NOT implementing parallel multi-issue dispatch** — one tick = one issue.
- **NOT implementing token/budget tracking** — deferred. Hero does not currently surface structured token tallies; building on guesses isn't worth the surface area. Track in a follow-up issue once hero exposes telemetry.
- **NOT babysitting CI** — when hero lands a PR awaiting CI, that's a "tick complete, move on" outcome. The `finish` skill already has a dedicated CI-watch loop (`finish/SKILL.md:142-162`) for human-initiated merges.
- **NOT replacing per-phase loop scripts** — `ralph-triage`, `ralph-research`, etc. remain queue-pickers in their own right.

## Implementation Approach

Five tightly-scoped phases. Each phase is independently dispatchable per the table below. Pure markdown plus one shell hook script — no MCP/TypeScript changes.

| Phase | files | tdd | complexity | depends_on | acceptance |
|---|---|---|---|---|---|
| 1 — Scaffold | `plugin/ralph-hero/skills/autopilot/SKILL.md` | N (markdown skill) | low | — | Skill loads; safety check refuses without env var; empty backlog → "Backlog empty"; one-issue dispatch works (no loop) |
| 2 — Tick body | `plugin/ralph-hero/skills/autopilot/SKILL.md` | N | low | phase-1 | Pre/post `get_issue` diff produces structured outcome; `--dry-run` does not call hero; escalation outcome detected |
| 3 — Loop + termination | `plugin/ralph-hero/skills/autopilot/SKILL.md` | N | medium | phase-2 | 3-issue backlog → 3 ticks → "Backlog empty"; `--max-iterations 1` stops after one tick; escalation stops loop; only delay buckets {60, 1200} ever used (1800 mentioned in Configuration as documentation default but never selected by Step 9 logic) |
| 4 — Audit log + hook gate | `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`, `plugin/ralph-hero/skills/autopilot/SKILL.md` (frontmatter add) | shellcheck | low | phase-3 | Each tick appends valid JSONL line; hook blocks 300s and non-autopilot prompts; passes shellcheck |
| 5 — Docs + evals | `plugin/ralph-hero/skills/autopilot/eval-scenarios.md`, `plugin/ralph-hero/README.md`, `/Users/dubiel/projects/ralph-hero/CLAUDE.md` | N | low | phase-4 | All 11 eval scenarios documented; README section pre-drafted (in this plan); CLAUDE.md edit pre-drafted |

The skill is purely markdown — no TypeScript MCP code. All composition happens inside the skill body via existing tools.

---

## Phase 1: Skill Scaffold

### Overview
Create the skill directory with frontmatter, configuration block, argument parsing, safety check, and a one-shot "tick" body that calls `next_actions` and picks the top actionable issue. No looping yet — this phase produces a working "do one issue and stop" skill.

### Changes Required:

#### 1. Skill file
**File**: `plugin/ralph-hero/skills/autopilot/SKILL.md`
**Changes**: New file. Frontmatter mirrors `hero` but adds `ScheduleWakeup` to `allowed-tools` and registers the autopilot wakeup gate (the gate file is created in Phase 4; the frontmatter reference can be added incrementally or in Phase 4).

```markdown
---
description: Autonomous backlog clearer. Runs /hero in a self-paced loop via ScheduleWakeup, picking the next-most-important XS/S issue per tick, escalating to Human Needed when stuck, stopping cleanly when the queue is empty. Single-command shorthand for "go clear the backlog while I'm away."
argument-hint: "[--max-iterations N] [--auto-merge] [--dry-run] [--state=BASE64]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=autopilot"
allowed-tools:
  - Read
  - Write
  - Bash
  - Skill
  - Agent
  - ScheduleWakeup
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__next_actions
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Autopilot enabled: !`echo ${RALPH_AUTOPILOT_ENABLE:-false}`
- Max iterations: !`echo ${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`
- Audit log: ~/.ralph-hero/autopilot.jsonl

# Ralph Autopilot — Backlog Clearer

You are the autopilot orchestrator. One invocation = one tick. Each tick: decode-state → pick → check-worktrees → dispatch → diff → record → schedule-or-stop.

## Step 0: Safety check

If `RALPH_AUTOPILOT_ENABLE` is not "true", STOP immediately with:
> Autopilot is opt-in. To enable: `export RALPH_AUTOPILOT_ENABLE=true`

(Hard opt-in for unattended automation.)

## Step 1: Argument parsing + state decode

Parse from args:
- `--max-iterations N` (default: `${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`)
- `--auto-merge` (default: false)
- `--dry-run` (default: false)
- `--state=BASE64` (cross-tick state; absent on first tick; equals-form to avoid base64 padding-char ambiguity)

If `--state` is present, base64-decode and parse the JSON. Expected shape:
{
  "iteration": 3,
  "no_progress_streak": 0,
  "started_at": "2026-05-07T03:00:00Z",
  "history": [{"issue": 1234, "outcome": "pr_landed"}]
}

If absent, initialize: `{iteration: 1, no_progress_streak: 0, started_at: <now>, history: []}`.

## Step 2: Pick the next actionable issue

Call `next_actions(audience="agent", limit=10)`. (Limit raised from 5 to give Step 2.5's filter enough headroom.) Inspect the result:
- If `items` is empty → backlog clear → STOP (do NOT call ScheduleWakeup). Report "Backlog empty" and final summary.
- Filter to `kind == "issue"` only (skip PR / lock-stale / tree-continue directions).
- If no issue-kind candidate found → STOP, same as empty.
- Otherwise: top issue-kind direction is the candidate; pass to Step 2.5.

## Step 2.5: Skip "human-gated" candidates (In-Review filter)

Critical filter to prevent a false-positive escalation loop. Background: in `RALPH_REVIEW_MODE=interactive` (the default), hero lands a PR and stops; the issue's workflow state becomes `"In Review"`. But `"In Review"` is in `ACTIONABLE_PHASES` (verified at `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185`), so `next_actions` will keep returning the just-PR'd issue. Without this filter, autopilot would re-pick the same issue, hero would detect "phase=INTEGRATE, interactive mode, stop", outcome would be `no_progress`, and after 3 ticks autopilot would *escalate a perfectly healthy in-review PR to Human Needed*.

Filter logic:

1. **Exclude `In Review` outright** — these are human-gated by design in interactive mode. Skip without dispatching:
   - `candidates = candidates.filter(c => c.workflowState !== "In Review")`
2. **Exclude issues already PR'd this loop** — even if their state somehow regressed, don't re-pick what we already shipped this run:
   - `candidates = candidates.filter(c => !state.history.some(h => h.issue === c.issue && h.outcome === "pr_landed"))`
3. **If `--auto-merge` is set**, the In-Review filter is conditionally relaxed: hero in auto-merge mode WILL act on `In Review` (running code-review + merge). In that case, skip the filter only when the picked issue has no open blocking review threads. (For MVP: keep the filter on regardless — `--auto-merge` users who want autopilot to push past code review can re-invoke after merge. Track auto-merge In-Review handling as follow-up work.)

After filtering:
- If no candidates remain → STOP with `outcome=backlog_empty` (the human-gated PRs and shipped issues count as "done from autopilot's perspective"). Final report mentions any in-review PRs awaiting human merge so the user knows what's still queued for them.
- Otherwise: top remaining candidate is the picked issue. Continue to Step 3.

```

### Success Criteria:

#### Automated Verification:
- [ ] Skill file exists at `plugin/ralph-hero/skills/autopilot/SKILL.md`
- [ ] YAML frontmatter parses (Claude Code's plugin loader will validate at load time; manual: `python -c "import yaml; yaml.safe_load(open('SKILL.md').read().split('---')[1])"`)
- [ ] No new TypeScript files added
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` still passes (unchanged)

#### Manual Verification:
- [ ] `/ralph-hero:autopilot` is listed by `/help` after plugin reload
- [ ] Invoking with `RALPH_AUTOPILOT_ENABLE` unset → safety-check refusal with copy-pasteable enable command
- [ ] With `RALPH_AUTOPILOT_ENABLE=true` and an empty backlog → stops with "Backlog empty"
- [ ] With one XS issue in `Ready for Plan` → reports the picked issue and stops (no dispatch yet — Phase 2)

**Implementation Note**: After completing this phase pause for confirmation that the skill is registered before adding tick body.

---

## Phase 2: Tick Body — Worktree Check, Hero Dispatch, Pre/Post Diff

### Overview
Wire up the actual work. Three things differ from R1: (1) check `git worktree list` before dispatching to detect stale worktrees from interrupted prior ticks; (2) capture pre-state via `get_issue(includePipeline=true)` before dispatch; (3) derive outcome from the post-state diff, not from string-grepping hero's text output.

### Changes Required:

#### 1. Tick dispatch body
**File**: `plugin/ralph-hero/skills/autopilot/SKILL.md`
**Changes**: Append the worktree-check, dispatch, and outcome-diff sections.

```markdown
## Step 3: Worktree liveness check

Run `git worktree list` via Bash. If a worktree path matches `worktrees/GH-<picked-number>/` exists:
- This means a prior tick was interrupted mid-implement on this issue.
- ESCALATE the issue with reason "stale worktree at `<path>` from prior tick — needs human cleanup before autopilot can re-dispatch".
- Stop the loop (do NOT schedule next).

This is the safe default. The alternative (auto-cleanup) risks destroying in-progress work.

## Step 4: Capture pre-state

Call `get_issue(number=<picked>, includePipeline=true)`. Save:
- `pre.workflowState`
- `pre.phase` (from pipeline)
- `pre.subIssueCount` (from `list_sub_issues` if needed; or count from the includePipeline payload if it carries this)
- `pre.linkedPRs` (from issue body / linked PRs)

## Step 5: Dispatch hero

If `--dry-run`: skip dispatch entirely; mark this tick as a no-op for outcome purposes (`outcome=dry_run`).

Otherwise call `Skill("ralph-hero:hero", args="<picked> --review-mode <interactive|auto>")` where `--review-mode` is determined by `--auto-merge`:
- `--auto-merge` flag → pass `--review-mode auto` to hero (RALPH_REVIEW_MODE=auto)
- default → pass `--review-mode interactive` (hero stops at PR; autopilot moves on next tick)

Hero will report back via text output. Capture hero's output for the audit log, but **do NOT parse it for outcome**. Outcome is derived in Step 6.

## Step 6: Capture post-state and derive outcome

Call `get_issue(number=<picked>, includePipeline=true)` again. Compare to `pre`:

| Pre-state | Post-state | Derived outcome | Made progress? |
|---|---|---|---|
| any | `Done` | `completed` | yes |
| any | `Human Needed` | `escalated` (capture last comment for `escalation_reason`) | no |
| `Backlog`/`Research Needed` | `Ready for Plan`/`Plan in Review`/`In Progress` | `advanced` | yes |
| `Ready for Plan`/`Plan in Review` | `In Progress`/`In Review` | `advanced` | yes |
| `In Progress` | `In Review` (PR linked) | `pr_landed` | yes |
| any | unchanged AND `pre.subIssueCount < post.subIssueCount` | `advanced` (split happened) | yes |
| any | unchanged | `no_progress` | no |
| any | different from pre, not matched by rows above (catch-all) | `other_change` | yes (treat as advanced for streak-reset) |

The catch-all row (added in R3) prevents silent loss of unexpected state transitions (e.g., backward transitions, regressions) — anything that changes the workflow state but doesn't match a documented forward path is treated as progress for streak purposes and recorded with `outcome=other_change` in the audit log for forensic review.

This replaces R1's text-grep approach with structured pre/post diffing — no fragile string matching.
```

### Success Criteria:

#### Automated Verification:
- [ ] No new dependencies added (`package.json` unchanged)
- [ ] Skill body still parses

#### Manual Verification:
- [ ] `--dry-run` against 1-issue backlog → reports "Would dispatch hero for #N", does not call hero, exits cleanly
- [ ] Default flags against 1 XS issue → hero runs, autopilot reports outcome derived from `get_issue` diff, exits without scheduling (loop is Phase 3)
- [ ] Pre-existing worktree at `worktrees/GH-N/` for the top picked issue → autopilot escalates without dispatching
- [ ] Manually-set-up ambiguous issue → hero escalates → autopilot's pre/post diff detects `Human Needed` post-state → outcome=`escalated`

---

## Phase 3: Loop Mechanism + Four Termination Conditions

### Overview
Add the `ScheduleWakeup` call that re-fires the skill, plus the four termination conditions (budget cap deferred per critique issue 6).

### Changes Required:

#### 1. Loop bootstrap + termination logic
**File**: `plugin/ralph-hero/skills/autopilot/SKILL.md`
**Changes**: Append loop scheduling and termination sections.

```markdown
## Step 7: Update tick counters

`iteration += 1`.

If outcome ∈ {`completed`, `pr_landed`, `advanced`, `other_change`}: `no_progress_streak = 0`.
If outcome == `no_progress`: `no_progress_streak += 1`.
If outcome == `escalated`: irrelevant (loop will stop).
If outcome == `dry_run`: don't increment streak.

Append `{issue: <picked>, outcome: <derived>}` to `state.history`.

## Step 8: Termination conditions (any one stops the loop)

Check in priority order. Outcome → action mapping:

| Condition | Stop? | Reason |
|---|---|---|
| outcome == `escalated` | YES | escalation already moved issue to Human Needed; loop done |
| outcome == `dry_run` | YES | one-shot test mode |
| `no_progress_streak >= 3` | YES + escalate picked issue | "autopilot detected no-progress streak of 3" |
| `iteration > MAX_ITERATIONS` | YES | hard ceiling |
| `next_actions` (re-checked) returns 0 issue-kind candidates | YES | backlog cleared |
| else | NO | continue loop |

**Invariant table — exactly one branch per code path:**

| Step 8 evaluation | Step 9 action |
|---|---|
| any STOP condition matches | call `Step 10: Final report`, return; do NOT call ScheduleWakeup |
| no STOP condition matches | call `ScheduleWakeup(...)` exactly once, then return |

## Step 9: Schedule next tick

Build `next_state = {iteration, no_progress_streak, started_at, history}` and base64-encode the JSON.

Choose `delaySeconds` based on outcome (only two buckets — never 300):
- `pr_landed`, `advanced`, `completed`, or `other_change`: 60s (stay in cache, immediately pick next)
- `no_progress` (streak 1 or 2): 1200s (cache miss, longer cooldown — give the system time)
- All other outcomes already short-circuited to STOP in Step 8

Call:
ScheduleWakeup(
  delaySeconds = <chosen>,
  reason = "autopilot tick <iteration+1>: continuing after <picked> <outcome>",
  prompt = "/ralph-hero:autopilot --max-iterations <N> [--auto-merge] --state=<BASE64>"
)

**`--state=BASE64` syntax (R3)**: use the equals-form, not space-separated. Base64 padding (`=` chars) and URL-safe alternates can confuse a positional parser; the equals-form makes the boundary unambiguous. Argument-parser must accept `--state=...` (everything after the first `=` is the value, even if it contains additional `=` from base64 padding).

The `prompt` field carries forward all original flags PLUS the encoded state. This is the cross-tick state channel (per Tick Isolation table).

After scheduling, output a brief tick summary to text and STOP this turn.

## Step 10: Final report (terminal turn only)

When any STOP condition fires, emit a markdown summary:
- Total ticks run
- Wall-clock elapsed time (`now - state.started_at`)
- Issues processed (with workflow-state outcome each, from `state.history`)
- PRs created (count from `state.history` outcomes)
- Escalations (count + reasons)
- Audit log path: `~/.ralph-hero/autopilot.jsonl`
```

### Success Criteria:

#### Automated Verification:
- [ ] Skill body parses
- [ ] Invariant table is present and exhaustive (exactly one branch per outcome)
- [ ] `delaySeconds` only ever takes values from {60, 1200} — verify by `grep -E "delaySeconds.*=" SKILL.md`

#### Manual Verification:
- [ ] 3-issue XS backlog → 3 ticks fire, "Backlog empty" stops cleanly
- [ ] `--max-iterations 1` → exactly one tick fires, second tick stops with "max iterations hit"
- [ ] Forced escalation → autopilot stops on first escalation
- [ ] No `ScheduleWakeup` call ever uses `delaySeconds=300` — confirmed by `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u`
- [ ] Cross-tick state survives — set `--max-iterations 5`, run 3 ticks, confirm `iteration` field grows correctly in audit log

---

## Phase 4: Audit Log + Hook Gate

### Overview
Persist every tick to `~/.ralph-hero/autopilot.jsonl` for forensic auditing. Add the hook gate that catches the 300s cache-window anti-pattern and rejects `ScheduleWakeup` calls whose prompt isn't an autopilot continuation.

Note: per critique issue 2, the gate does NOT check `RALPH_COMMAND=autopilot` — that check is unverified across `ScheduleWakeup` re-fires. The `prompt =~ ^/ralph-hero:autopilot` check is sufficient evidence the call is autopilot-driven.

### Changes Required:

#### 1. Audit log writer
**File**: `plugin/ralph-hero/skills/autopilot/SKILL.md`
**Changes**: Add an audit-log section that runs at the end of every tick (between Step 7 and Step 8).

```markdown
## Audit log entry shape

Append a single JSON line to `~/.ralph-hero/autopilot.jsonl` after Step 7 (counter update) and before Step 8 (termination check):

{
  "ts": "2026-05-07T03:14:15Z",
  "iteration": 3,
  "issue_number": 1234,
  "issue_url": "https://github.com/...",
  "pre_state": "Ready for Plan",
  "post_state": "In Review",
  "outcome": "pr_landed",
  "pr_url": "https://github.com/.../pull/5678",
  "duration_ms": 487211,
  "no_progress_streak": 0,
  "next_delay_seconds": 60,
  "next_action": "schedule",
  "args": {"max_iterations": 20, "auto_merge": false, "dry_run": false}
}

For escalations: `outcome="escalated"`, `escalation_reason="<from last comment>"`, `next_action="stop"`, `next_delay_seconds=null`.
For dry-run: `outcome="dry_run"`, `next_action="stop"`, `next_delay_seconds=null`.
For backlog-empty: `outcome="backlog_empty"`, `next_action="stop"`, `next_delay_seconds=null`, `issue_number=null`.
For no-progress-streak escalation, max-iterations, etc.: `next_action="stop"`, `next_delay_seconds=null`.

**Rule**: whenever `next_action == "stop"`, `next_delay_seconds` MUST be `null` (not 0, not absent). This makes downstream JSONL parsers (e.g., `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u`) yield a clean set: `{60, 1200, null}`.

Append via Bash using `jq -n` to construct the JSON safely without manual quote-escaping:

mkdir -p ~/.ralph-hero
jq -nc --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       --argjson iteration "$ITER" \
       --arg issue_url "$ISSUE_URL" \
       '{ts:$ts, iteration:$iteration, issue_url:$issue_url, ...}' \
  >> ~/.ralph-hero/autopilot.jsonl
```

#### 2. Hook gate
**File**: `plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
**Changes**: New file (executable). PreToolUse hook on `ScheduleWakeup`.

```bash
#!/usr/bin/env bash
# autopilot-wakeup-gate.sh
# Validates ScheduleWakeup calls match autopilot semantics.
# Note: relies on prompt regex (not RALPH_COMMAND env var, which is unverified
# across ScheduleWakeup re-fires per the R2 critique).
set -euo pipefail

input_json="$(cat)"
get_field() { jq -r "$1" <<<"$input_json"; }

tool=$(get_field '.tool_name // empty')
[[ "$tool" != "ScheduleWakeup" ]] && exit 0

delay=$(get_field '.tool_input.delaySeconds // 0')
prompt=$(get_field '.tool_input.prompt // ""')

# Only one check that's required: prompt must re-invoke autopilot
if [[ ! "$prompt" =~ ^/ralph-hero:autopilot ]]; then
  echo "Autopilot ScheduleWakeup must re-invoke /ralph-hero:autopilot, got: $prompt" >&2
  exit 2
fi

# Cache-window anti-pattern check
if [[ "$delay" == "300" ]]; then
  echo "delaySeconds=300 is the 5-min cache-window anti-pattern — pick <=270 or >=1200" >&2
  exit 2
fi

exit 0
```

#### 3. Register the hook in skill frontmatter
**File**: `plugin/ralph-hero/skills/autopilot/SKILL.md`
**Changes**: Add to the `hooks:` block:

```yaml
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=autopilot"
  PreToolUse:
    - matcher: "ScheduleWakeup"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/autopilot-wakeup-gate.sh"
```

### Success Criteria:

#### Automated Verification:
- [ ] `test -x plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh`
- [ ] `shellcheck plugin/ralph-hero/hooks/scripts/autopilot-wakeup-gate.sh` passes
- [ ] After one tick: `test -f ~/.ralph-hero/autopilot.jsonl`
- [ ] `jq -e . ~/.ralph-hero/autopilot.jsonl > /dev/null` (every line valid JSON)

#### Manual Verification:
- [ ] After a 3-tick run, `wc -l ~/.ralph-hero/autopilot.jsonl` shows 3+ lines
- [ ] Set `delaySeconds=300` in the skill body manually → hook blocks with cache-window message
- [ ] Set `prompt="/something-else"` in the skill body manually → hook blocks with prompt message
- [ ] Without `RALPH_AUTOPILOT_ENABLE=true`, the skill body refuses with the safety-check message before ever reaching ScheduleWakeup

---

## Phase 5: Documentation + Eval Scenarios

### Overview
Write the eval scenarios document, README section (pre-drafted below), and CLAUDE.md edit (pre-drafted below). Per critique issue 8, the implementer should not have to invent docs prose.

### Changes Required:

#### 1. Eval scenarios
**File**: `plugin/ralph-hero/skills/autopilot/eval-scenarios.md`
**Changes**: New file. Mirror format of `plugin/ralph-hero/skills/ralph-merge/eval-scenarios.md`.

Scenarios:
1. Empty backlog → stops immediately with "Backlog empty"
2. Single XS issue, default flags → 1 tick, 1 PR, stops with "Backlog empty"
3. Three XS issues → 3 ticks, 3 PRs, stops cleanly
4. Mid-loop escalation (ambiguous issue) → stops on first escalation, issue in Human Needed
5. `--max-iterations 2` against 5-issue backlog → exactly 2 ticks, stops with "max iterations"
6. Three consecutive ticks pick the same locked issue → no_progress_streak hits 3, escalates issue, stops
7. `RALPH_AUTOPILOT_ENABLE` unset → refuses
8. `--auto-merge` with passing CI → ticks merge PRs (not just land them)
9. `--dry-run` → ticks log "would-dispatch", do not call hero, do not schedule
10. Pre-existing worktree at `worktrees/GH-N/` for picked issue → autopilot escalates without dispatching (worktree-liveness gate)
11. Cross-tick state survives — verify `iteration` field grows monotonically in audit log
12. **In-Review filter (R3 critical fix)**: single XS issue, default flags (`RALPH_REVIEW_MODE=interactive`) → tick 1 lands PR (issue moves to `In Review`); tick 2 fires 60s later, picks the issue from `next_actions`, Step 2.5 filters it out (workflowState=`In Review`), no other candidates remain, autopilot exits with `outcome=backlog_empty` mentioning the in-review PR awaiting human merge. **Critically**: the issue does NOT get re-dispatched to hero, does NOT accumulate a no-progress streak, and does NOT get falsely escalated to Human Needed.
13. **In-Review filter — multi-issue mix**: 2 XS issues + 1 issue already in `In Review` from a prior session → autopilot only dispatches against the 2 XS issues; the prior in-review issue is skipped on every tick and never picked. Final report lists it as "awaiting human merge" not as "processed".

#### 2. README section (pre-drafted)
**File**: `plugin/ralph-hero/README.md`
**Changes**: Add this section under the existing skill catalog (insert near the `hero` skill entry):

```markdown
### `/ralph-hero:autopilot` — Backlog Clearer

Single-command shorthand for "clear the backlog while I'm away." Uses `ScheduleWakeup`-based self-pacing to dispatch `/ralph-hero:hero` against the next-most-important XS/S issue per tick, escalating to `Human Needed` when stuck and stopping cleanly when the queue is empty.

**Opt-in (required)**: `export RALPH_AUTOPILOT_ENABLE=true` — unattended automation is opt-in by design.

**Invocation**:
- `/ralph-hero:autopilot` — default: 20 iterations max, interactive merge
- `/ralph-hero:autopilot --max-iterations 5` — bound the loop tighter
- `/ralph-hero:autopilot --auto-merge` — auto-merge PRs that pass code review + CI
- `/ralph-hero:autopilot --dry-run` — one-shot dry run; no hero dispatch

**Termination conditions** (any one stops the loop):
- Backlog empty (no actionable XS/S issues remain)
- Escalation flagged on the current tick
- Three consecutive ticks produced no progress (issue gets escalated)
- Iteration cap reached

**Interactive-merge mode (default)**: When hero lands a PR, the issue moves to `In Review` awaiting human merge. Autopilot does NOT re-pick `In Review` issues — they're listed in the final summary as "awaiting human merge" so you know what's queued for you. Use `--auto-merge` to also drive code-review + merge through the loop.

**Audit trail**: every tick appends to `~/.ralph-hero/autopilot.jsonl`. Inspect with `jq . ~/.ralph-hero/autopilot.jsonl`.

**Cancel an in-flight loop**: use `/tasks` (Claude Code's scheduled-task list) to identify the autopilot wakeup and delete it via the cron tools.
```

#### 3. CLAUDE.md edit (pre-drafted)
**File**: `/Users/dubiel/projects/ralph-hero/CLAUDE.md`
**Changes**: Add to the existing skill list documentation (find the section that lists per-phase skills and append):

```markdown
### Autopilot

`/ralph-hero:autopilot` is a self-paced backlog clearer that wraps `/hero` in a `ScheduleWakeup`-based loop. Single-command shorthand for autonomous overnight runs. Opt-in via `RALPH_AUTOPILOT_ENABLE=true`. Audit log at `~/.ralph-hero/autopilot.jsonl`. See `skills/autopilot/SKILL.md` for the tick state machine and `hooks/scripts/autopilot-wakeup-gate.sh` for the cache-window/prompt-regex safety gate. Coexists with the out-of-process `scripts/ralph-loop.sh` for headless `claude -p` use.
```

#### 4. Plugin manifest
**File**: `plugin/ralph-hero/.claude-plugin/plugin.json`
**Changes**: None — discovery is file-based per the existing convention. Verified by codebase-locator findings (no skill registry in manifest).

### Success Criteria:

#### Automated Verification:
- [ ] `eval-scenarios.md` exists and parses as markdown
- [ ] README section renders cleanly
- [ ] CLAUDE.md edit applied
- [ ] CI (`npm test`) passes (unchanged)

#### Manual Verification:
- [ ] Walk through eval scenarios 1–5 + 10 (worktree gate) against a real test board
- [ ] A teammate can read the README section + CLAUDE.md and successfully invoke autopilot end-to-end
- [ ] Cancel-mid-loop instructions work: `/tasks` lists the wakeup, deletion cancels next tick

---

## Testing Strategy

### Unit Tests
None added — the skill is pure markdown. Hook script is shell, covered by `shellcheck` + manual scenario tests.

### Integration Tests
Manual via the eval scenarios document. Each scenario is a real run against a test project board.

### Manual Testing Steps
1. Set up a test project board with 3 known XS issues in `Ready for Plan`
2. `RALPH_AUTOPILOT_ENABLE=true /ralph-hero:autopilot --max-iterations 5`
3. Walk away ~15 min; verify 3 PRs landed, audit log shows 3 ticks, final report is clean
4. Re-run on empty backlog → "Backlog empty" immediately
5. Add an ambiguous issue, re-run → first tick escalates, loop stops
6. Inspect `~/.ralph-hero/autopilot.jsonl` — every tick auditable, every `next_delay_seconds` ∈ {60, 1200, null}

## Performance Considerations

- **Cache discipline**: `delaySeconds` ∈ {60, 1200} ∪ {null when stopping}. Never 300. Single biggest cost lever.
- **No persistent state in conversation context**: every tick reads from GitHub + `--state BASE64` in prompt. Context bloat bounded by one tick's work.
- **Audit log size**: JSONL grows ~500 bytes/tick. ~500 KB after 1000 ticks. Log rotation deferred until needed.
- **Per-tick cost**: not tracked in MVP (token telemetry deferred per critique issue 6). Empirical observation post-launch will inform a follow-up budget-cap issue.

## Migration Notes

No migration. New skill, no schema changes, no breaking changes. `ralph-loop.sh` unchanged.

## Follow-up Work (out of scope for this plan)

- **Token telemetry + budget cap**: requires hero to surface structured token tallies to its caller. Once that exists, add a 5th termination condition keyed off real cost. Tracked separately.
- **`/tasks`-style autopilot dashboard**: expose `~/.ralph-hero/autopilot.jsonl` via an MCP tool for in-session inspection.
- **Worktree auto-cleanup**: the safe MVP escalates on stale-worktree detection. A future enhancement could offer interactive cleanup or a `--clean-stale-worktrees` flag.
- **Auto-merge In-Review handling**: R3 keeps the In-Review filter on regardless of `--auto-merge`. A future enhancement: when `--auto-merge` is set AND the picked In-Review issue has no open blocking review threads, allow autopilot to drive code-review + merge for it. Requires a new structured signal from the issue (or `get_issue` extension) to detect "blocking review threads".
- **`next_actions(includeInReview=false)` flag**: principled alternative to autopilot's client-side In-Review filter. Adding the filter at the MCP tool layer would let other agent-audience consumers benefit. Would replace Step 2.5's first filter rule with a parameter to `next_actions`.

## References

- Existing single-issue orchestrator: `plugin/ralph-hero/skills/hero/SKILL.md` (resumability §491-499; constraints §504-510)
- Existing out-of-process loop: `plugin/ralph-hero/scripts/ralph-loop.sh`
- Action ranking: `plugin/ralph-hero/mcp-server/src/lib/directions.ts:728` (`rankDirections`)
- Action ranking penalty constants: `plugin/ralph-hero/mcp-server/src/lib/directions.ts:200-217`
- Escalation protocol: `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md`
- State resolution: `plugin/ralph-hero/mcp-server/src/lib/state-resolution.ts:29` (`__ESCALATE__` mapping)
- Workflow states: `plugin/ralph-hero/mcp-server/src/lib/workflow-states.ts:41-44` (HUMAN_STATES)
- ScheduleWakeup tool description: cache-window guidance and `<<autonomous-loop-dynamic>>` sentinel mechanics
- Claude Code scheduled tasks docs: https://code.claude.com/docs/en/scheduled-tasks.md
- R1 plan critique: `thoughts/shared/reviews/2026-05-07-GH-1136-critique.md`
