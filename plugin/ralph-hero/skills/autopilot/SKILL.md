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

Use these resolved values when constructing GitHub URLs or referencing the repository. The audit log path is informational in this phase — the file itself is created in a later phase.

# Ralph Autopilot — Backlog Clearer

You are the autopilot orchestrator. One invocation = one tick. Each tick: decode-state -> pick -> check-worktrees -> dispatch -> diff -> record -> schedule-or-stop.

This phase implements the full per-tick flow through Step 10. Subsequent phases (#1140, #1141) add the audit-log JSONL writes + `PreToolUse` hook gate, and the docs + eval scenarios respectively.

## Step 0: Safety check

If `RALPH_AUTOPILOT_ENABLE` is not exactly the string `"true"`, STOP immediately with this message and do NOT proceed to Step 1:

> Autopilot is opt-in. To enable: `export RALPH_AUTOPILOT_ENABLE=true`

(Hard opt-in for unattended automation. Refuse cleanly so the user can re-invoke with the env var set. No fallthrough — terminate the skill body here.)

## Step 1: Argument parsing + state decode

Parse the following flags from `$ARGUMENTS`:

- `--max-iterations N` — default `${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`
- `--auto-merge` — default false (passes `--review-mode auto` to hero in later phases)
- `--dry-run` — default false (skip dispatch in later phases; report intent only)
- `--state=BASE64` — cross-tick state, absent on first tick. **Equals-form** is required to handle base64 padding (`=` chars).

**Equals-form parsing rule**: split each arg on the **first** `=` only. Everything after that first `=` is the value, including any additional `=` characters introduced by base64 padding. Do NOT split on every `=`.

Example: `--state=eyJpdGVyYXRpb24iOjF9==` parses as flag `--state` with value `eyJpdGVyYXRpb24iOjF9==` (two trailing `=` preserved).

If `--state` is **present**: base64-decode the value, then JSON-parse. Expected shape:

```json
{
  "iteration": 3,
  "no_progress_streak": 0,
  "started_at": "2026-05-07T03:00:00Z",
  "history": [{"issue": 1234, "outcome": "pr_landed"}]
}
```

If `--state` is **absent** (first tick): initialize state to:

```json
{
  "iteration": 1,
  "no_progress_streak": 0,
  "started_at": "<current ISO-8601 UTC timestamp>",
  "history": []
}
```

The `state` object is referenced in Step 2.5 (history filter) and will be re-encoded into the next tick's `--state` argument by Phase 3's loop machinery (not in this phase).

## Step 2: Pick the next actionable issue

Call `next_actions(audience="agent", limit=10)`. The limit is raised from the default 5 to give Step 2.5's filter enough headroom to skip past human-gated candidates without exhausting the list.

Inspect the result:

- If `items` is empty -> backlog clear -> STOP. Report "Backlog empty" with a brief final summary. Do NOT call `ScheduleWakeup` (loop scheduling is added in Phase 3, but even there the empty-backlog branch terminates cleanly without rescheduling).
- Filter to `kind == "issue"` only. Skip PR-kind, lock-stale, and tree-continue directions — those are handled by other skills, not autopilot's per-issue dispatch.
- If no `kind == "issue"` candidate remains after the filter -> STOP, same as empty backlog.
- Otherwise: the top issue-kind direction is the candidate `<picked>`. Pass it to Step 2.5.

## Step 2.5: Skip "human-gated" candidates (In-Review filter)

This filter prevents a false-positive escalation loop. **Background**: in `RALPH_REVIEW_MODE=interactive` (the default), hero lands a PR and stops; the issue's workflow state becomes `"In Review"`. But `"In Review"` is in `ACTIONABLE_PHASES` (verified at `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185`), so `next_actions` will keep returning the just-PR'd issue. Without this filter, autopilot would re-pick the same issue, hero would detect "phase=INTEGRATE, interactive mode, stop", outcome would be `no_progress`, and after 3 ticks autopilot would *escalate a perfectly healthy in-review PR to Human Needed*.

Apply both filter rules to the candidate list returned by Step 2:

1. **Exclude `In Review` outright** — these are human-gated by design in interactive mode. Skip without dispatching:

   ```
   candidates = candidates.filter(c => c.workflowState !== "In Review")
   ```

2. **Exclude issues already PR'd this loop** — even if their state somehow regressed, don't re-pick what we already shipped this run:

   ```
   candidates = candidates.filter(c => !state.history.some(h => h.issue === c.issue && h.outcome === "pr_landed"))
   ```

**`--auto-merge` carve-out**: For MVP, the In-Review filter remains **ON regardless** of `--auto-merge`. Users who want autopilot to push past code review can re-invoke after merge. Auto-merge In-Review handling (running code-review + merge against in-review PRs without re-escalation) is tracked as follow-up work.

After filtering:

- If no candidates remain -> STOP with `outcome=backlog_empty`. The human-gated PRs and shipped issues count as "done from autopilot's perspective". The final report should mention any in-review PRs awaiting human merge so the user knows what's still queued for them.
- Otherwise: the top remaining candidate is the picked issue `<picked>`. Subsequent steps (worktree liveness check, pre-state capture, hero dispatch, post-state diff, audit log, loop scheduling) are added in later phases — the skill body ends here for Phase 1.

For Phase 1 only: report the picked issue (number, title, workflow state) and STOP. Do not dispatch hero, do not call `ScheduleWakeup`, do not write to the audit log — those are Phase 2/3/4 work.

## Step 3: Worktree liveness check

Before dispatching hero, scan for a stale worktree at the canonical path for `<picked>`. A pre-existing worktree at `worktrees/GH-<picked>/` means a prior tick was interrupted mid-implement on this issue and there may be uncommitted in-progress work on disk that autopilot must not clobber.

Run via Bash:

```bash
git worktree list
```

Inspect the output for any line whose path matches `worktrees/GH-<picked-number>/` (a substring match on the worktree path is sufficient — both the bare `worktrees/GH-N` form and the absolute-path form `<repo>/worktrees/GH-N` are valid hits).

**On collision (a matching worktree exists)**:

1. ESCALATE the picked issue: call `save_issue(number=<picked>, workflowState="__ESCALATE__", command="ralph_impl")` to transition it to `Human Needed`.
2. Post a comment on the issue via `create_comment` with body:

   > Autopilot detected a stale worktree at `<path>` from a prior tick. Autopilot will not auto-clean worktrees because doing so risks destroying in-progress work. Please review `<path>`, commit or discard any pending changes, run `./scripts/remove-worktree.sh GH-<picked>`, then re-enable autopilot.

3. Stop the loop: this tick is terminal. Do NOT proceed to Step 4. Do NOT call `ScheduleWakeup` (loop scheduling is Phase 3, but even there the worktree-collision branch must terminate — record this as `outcome=escalated` for any audit-log purposes added in Phase 4).

This is the safe default — auto-cleanup risks destroying in-progress work. Autopilot never deletes worktrees, never deletes files under `worktrees/`, and never force-resets a branch. Recovery requires a human to inspect and clean up. (Automatic cleanup is tracked as follow-up work in the parent plan §Follow-up Work; it is an explicit non-goal of Phase 2.)

**On no collision**: proceed to Step 4.

## Step 4: Capture pre-state

Call `get_issue(number=<picked>, includePipeline=true)` once and capture four fields into a local `pre` object for use in Step 6's diff:

- `pre.workflowState` — top-level `workflowState` field on the response (e.g., `"Backlog"`, `"In Progress"`, `"In Review"`).
- `pre.phase` — pipeline phase name from the `pipeline` payload that `includePipeline=true` adds to the response (the high-level phase the orchestrator's pipeline detection assigned; used to spot phase advances that don't change `workflowState`).
- `pre.subIssueCount` — read from `subIssuesSummary.total` on the `get_issue` response. The response payload already carries this, so no separate `list_sub_issues` call is needed in MVP — keep the tick lean. (If a future schema change drops `subIssuesSummary`, fall back to `list_sub_issues(number=<picked>)` and use its returned count; document the source in the audit-log entry once Phase 4 lands.)
- `pre.linkedPRs` — collect any PR references already on the issue. Source: the `get_issue` response payload's existing PR-linkage fields (the same fields the regular `get_issue` view surfaces). No extra GitHub API calls.

`pre` lives only in the current tick's local scope — it is consumed by Step 6 and discarded. State persisted across ticks (the `state` object) is unaffected by Step 4.

## Step 5: Dispatch hero

**Dry-run branch** (`--dry-run` flag is set):

- Skip dispatch entirely. Do NOT call `Skill("ralph-hero:hero", ...)`.
- Mark this tick's outcome as `outcome=dry_run`.
- Emit a report to the user: `"Would dispatch hero for #<picked> (<title>) — skipped due to --dry-run"`.
- Do NOT proceed to Step 6's pre/post diff (treat dry-run as terminal for outcome derivation — there is no post-state to compare because no work happened).

**Real dispatch branch** (no `--dry-run`):

Hero's review mode is controlled via the `RALPH_REVIEW_MODE` environment variable, **not** a CLI flag. Hero's `argument-hint` (see `plugin/ralph-hero/skills/hero/SKILL.md:3`) is just `<issue-number>` — there is no `--review-mode` flag. Hero reads `${RALPH_REVIEW_MODE:-interactive}` at load time (`hero/SKILL.md:50`); accepted values are `interactive` (stop at PR, default) or `auto` (auto-run code review and merge) per `hero/SKILL.md:517`.

Set the env var for the dispatch shell context based on the parsed flags from Step 1:

- If `--auto-merge` is set: ensure `RALPH_REVIEW_MODE=auto` is exported in the shell environment hero will inherit. In practice, run `export RALPH_REVIEW_MODE=auto` via Bash before the `Skill()` call (or use a single Bash invocation that sets the env var inline before invoking the skill, whichever the surrounding skill body convention prefers).
- Otherwise (default): ensure `RALPH_REVIEW_MODE=interactive` is set (or simply leave the env var untouched and rely on the `:-interactive` default in hero — but explicitly setting it is safer and self-documenting).

Then dispatch hero with the picked issue as a single positional argument:

```
Skill("ralph-hero:hero", args="<picked>")
```

Hero will run its full per-issue flow (research → plan → split → impl → pr → merge as appropriate) and return text output describing what happened. Capture hero's text output to a local variable `hero_output` for inclusion in the Phase 4 audit-log entry.

**Critical anti-pattern** (cited from parent plan-of-plans, R1 review): do **NOT** parse `hero_output` for outcome derivation. Text-grepping hero's free-text reports (the approach used in `plugin/ralph-hero/scripts/ralph-loop.sh`'s `grep -qiE "Queue empty|Triage complete"`) is fragile and was explicitly rejected by review. Outcome derivation is the job of Step 6's structured `get_issue` diff. `hero_output` is preserved only for the audit log (forensic context for humans), never for control flow.

After hero returns, proceed to Step 6.

## Step 6: Capture post-state and derive outcome

If `--dry-run` short-circuited Step 5, outcome is already `dry_run`; skip this step entirely.

Otherwise, call `get_issue(number=<picked>, includePipeline=true)` again to capture post-state. Build a `post` object with the same four fields as `pre`: `post.workflowState`, `post.phase`, `post.subIssueCount`, `post.linkedPRs`.

Compare `pre` to `post` row-by-row using the canonical 8-row diff table below. **Rows are evaluated top-to-bottom; the first matching row wins** — row order encodes precedence. No fragile string matching on hero's text output; outcome derivation is purely from `get_issue` field comparisons.

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

The catch-all `other_change` row (added in R3) prevents silent loss of unexpected state transitions — anything that changes the workflow state but doesn't match a documented forward path (for example, a backward transition, a regression, or any other unanticipated mutation) is recorded with `outcome=other_change` in the audit log for forensic review and treated as progress for streak-reset purposes. Without this row, an unexpected post-state would silently fall through and be misclassified as `no_progress`.

When `outcome=escalated` (row 2 matches): also capture the most recent comment text on the issue into a local variable `escalation_reason` for inclusion in the Phase 4 audit-log entry. The simplest source is the last entry of the `comments` array on the post-state `get_issue` response payload (no extra API call). Hero's escalation flow posts a Human Needed comment as part of the transition, so the last comment is the escalation reason.

This step replaces R1's text-grep approach with structured pre/post diffing: outcome derivation reads only typed fields from MCP responses, never strings from hero's free-form output.

## Step 7: Update tick counters

After Step 6 derives `<outcome>` from the pre/post diff (or from the dry-run short-circuit), update the cross-tick state object before Step 8 evaluates termination conditions.

1. **Increment iteration**: `state.iteration += 1`. The `state` object was decoded (or initialized) in Step 1; `state.iteration` is the live counter that Step 8 row 4 (max-iterations cap) reads.

2. **Apply the canonical outcome → streak mapping** (one branch per outcome — exhaustive):

   - `outcome` is `completed`, `pr_landed`, `advanced`, or `other_change` -> `state.no_progress_streak = 0` (reset — work happened, even the catch-all `other_change` row counts as progress for streak-reset purposes per Step 6's table)
   - `outcome` is `no_progress` -> `state.no_progress_streak += 1` (increment — nothing changed this tick)
   - `outcome` is `escalated` -> irrelevant — the loop will STOP in Step 8 regardless, so the streak update has no observable effect
   - `outcome` is `dry_run` -> do NOT increment streak (one-shot test mode; dry-run also STOPs in Step 8 row 2 so the value is moot)

3. **Append to history**: push `{issue: <picked>, outcome: <derived>}` onto `state.history`. The history array is the source-of-truth read by Step 2.5's "exclude issues already PR'd this loop" filter on the next tick (cross-reference Phase 1 Step 2.5).

4. **No audit-log write here** — that is Phase 4 (#1140). Phase 3 keeps `state` and `<outcome>` as in-process variables only; the JSONL append at `~/.ralph-hero/autopilot.jsonl` is added in the next phase between Step 7 and Step 8.

## Step 8: Termination conditions (any one stops the loop)

Check each row in priority order — earlier rows short-circuit later ones. Exactly one branch fires per tick.

| # | Condition | Stop? | Reason |
|---|---|---|---|
| 1 | `outcome == "escalated"` | YES | escalation already moved issue to Human Needed; loop done |
| 2 | `outcome == "dry_run"` | YES | one-shot test mode |
| 3 | `state.no_progress_streak >= 3` | YES + escalate picked issue | "autopilot detected no-progress streak of 3" |
| 4 | `state.iteration > MAX_ITERATIONS` | YES | hard ceiling |
| 5 | `next_actions` (re-checked, with Step 2/2.5 filters reapplied) returns 0 issue-kind candidates | YES | backlog cleared |
| 6 | (else) | NO | continue to Step 9 |

`MAX_ITERATIONS` is the value parsed from `--max-iterations N` in Step 1 (default `${RALPH_AUTOPILOT_MAX_ITERATIONS:-20}`).

**Invariant table — exactly one branch per code path:**

| Step 8 evaluation | Step 9 action |
|---|---|
| any STOP condition matches (rows 1-5) | call `Step 10: Final report`, return; do NOT call `ScheduleWakeup` |
| no STOP condition matches (row 6) | call `ScheduleWakeup(...)` exactly once via Step 9, then return |

**Invariant**: exactly one branch per code path — there is no third option. Either Step 8 STOPs and Step 10 fires (no `ScheduleWakeup` call), OR Step 8 does not STOP and Step 9 fires (one `ScheduleWakeup` call, no Step 10). Two ScheduleWakeup calls in one tick is a bug. Zero ScheduleWakeup calls AND zero final reports is a bug.

**Streak-escalation side effect (row 3)**: when `state.no_progress_streak >= 3` matches, before stopping the loop, perform two side-effects against the picked issue:

1. Call `save_issue(number=<picked>, workflowState="__ESCALATE__", command="ralph_plan")` to transition `<picked>` to `Human Needed`.
2. Post a `create_comment` on the issue with body:

   > Autopilot detected a no-progress streak of 3 ticks against this issue. Escalating to Human Needed for review. Audit log: `~/.ralph-hero/autopilot.jsonl`

Then proceed to Step 10 (final report) — the streak-escalation count is surfaced in Step 10's escalation totals.

**Backlog re-check rule (row 5)**: this row calls `next_actions(audience="agent", limit=10)` again and re-applies Step 2/2.5 filters (kind=="issue", exclude In Review, exclude already-pr_landed in `state.history`). This catches the case where the picked issue was the last actionable item and post-tick the queue is now empty — re-checking inside Step 8 (rather than relying on the next tick to discover the empty backlog) avoids one wasted `ScheduleWakeup` round-trip and gives the user a tight terminal report.

**Cross-references**: STOP -> Step 10 (final report). CONTINUE -> Step 9 (ScheduleWakeup).

## Step 9: Schedule next tick

This step runs only when Step 8 evaluated to CONTINUE (row 6 — no STOP condition matched). For STOP outcomes, Step 10 fires instead and `ScheduleWakeup` is not called.

1. **Build the next-tick state**: construct

   ```json
   {
     "iteration": <state.iteration>,
     "no_progress_streak": <state.no_progress_streak>,
     "started_at": "<state.started_at>",
     "history": <state.history>
   }
   ```

   then JSON-serialize and base64-encode to produce `<BASE64>`.

2. **Choose `delaySeconds`** — the live set is exactly `{60, 1200}`. No other value is ever passed to `ScheduleWakeup`:

   - `outcome` is `pr_landed`, `advanced`, `completed`, or `other_change` -> `delaySeconds = 60` (stay in cache; immediately pick the next issue)
   - `outcome` is `no_progress` (with streak 1 or 2 — streak 3 was short-circuited to STOP in Step 8 row 3) -> `delaySeconds = 1200` (cache miss; longer cooldown — give the system time)
   - All other outcomes (`escalated`, `dry_run`) already short-circuited to STOP in Step 8 — Step 9 is unreachable for them

   **Forbidden values**:
   - The value `300` for `delaySeconds` is **forbidden** — cache-window anti-pattern. Phase 4's `PreToolUse` hook gate (in #1140) will enforce this, but Phase 3 must already comply by construction. There is no code path in Step 9 that produces that value.
   - The value `1800` for `delaySeconds` is **forbidden in branch logic**. The Configuration block at the top of this file mentions `1800` as a documentation default for genuinely idle ticks (per the parent plan's Key Discoveries), but Step 9's branch logic must NEVER select it. The live set of values that ever flow into a `ScheduleWakeup` call is exactly `{60, 1200}`.

3. **`--state=BASE64` equals-form** (R3): use the equals-form (e.g., `--state=eyJpdGVy...==`), not space-separated. Base64 padding (`=` chars) and URL-safe alternates can confuse a positional parser; the equals-form makes the boundary unambiguous. The argument-parser in Step 1 already accepts `--state=...` (everything after the first `=` is the value, including any additional `=` characters from base64 padding) — Step 9's emitted prompt must be wire-compatible with that parser.

4. **Build the prompt**: re-invoke `/ralph-hero:autopilot` and carry forward all original flags from Step 1 (`--max-iterations N`, `--auto-merge` if originally set, `--dry-run` if originally set — though `--dry-run` will have STOPped in Step 8 row 2 and never reaches Step 9 in practice) PLUS the new `--state=<BASE64>` argument.

5. **Call `ScheduleWakeup` exactly once**:

   ```
   ScheduleWakeup(
     delaySeconds = <chosen>,
     reason = "autopilot tick <iteration+1>: continuing after <picked> <outcome>",
     prompt = "/ralph-hero:autopilot --max-iterations <N> [--auto-merge] --state=<BASE64>"
   )
   ```

   The `prompt` field is the cross-tick state channel (per the parent plan's Tick Isolation table). The audit log (Phase 4) will record `next_delay_seconds` and `next_action`, but Phase 3 only persists state via this prompt.

6. **Emit a brief tick summary** to text output AFTER the `ScheduleWakeup` call: `"Tick N complete: dispatched #X, outcome=Y, next tick in Zs"` (filling in `state.iteration`, `<picked>`, `<outcome>`, and `<chosen>`). Then STOP this turn — the next invocation of the skill will be triggered by `ScheduleWakeup`'s wakeup callback.

7. **Step 10 is NOT called when Step 9 fires** — the final report is reserved for terminal turns (Step 8 STOPped). Step 9's brief tick summary is the only user-visible output for non-terminal ticks.

## Step 10: Final report (terminal turn only)

This step runs only when Step 8 STOPped (any STOP condition matched — rows 1-5). When Step 9 schedules the next tick, Step 10 is skipped and the current turn ends after Step 9's brief tick summary. There is no overlap.

Emit a markdown summary to user-visible output (not stderr) so the terminal turn surfaces the run cleanly:

- **Total ticks run**: from `state.iteration`.
- **Wall-clock elapsed time**: `now - state.started_at` (formatted as a human-readable duration).
- **Issues processed**: from `state.history`, with each issue's outcome (e.g., `#1234 -> pr_landed`, `#1235 -> advanced`, `#1236 -> escalated`).
- **PRs created**: count of entries in `state.history` where `outcome == "pr_landed"`.
- **Escalations**: count + reasons. This includes both the original `outcome=escalated` ticks (hero detected an ambiguity and escalated mid-flight) AND the streak-escalation from Step 8 row 3 (autopilot detected a no-progress streak of 3 and escalated the picked issue itself).
- **In-review PRs awaiting human merge**: any issues filtered out by Step 2.5 during the loop should be called out here — phrasing like "N issues are awaiting human merge in `In Review` — they were filtered out of autopilot picks; merge them manually or re-run with `--auto-merge`" so the user knows what's still queued for them.
- **Audit log path**: `~/.ralph-hero/autopilot.jsonl` (informational; the file itself is created and appended in Phase 4 — Phase 3 only references the path).

The report ends the autopilot run for this invocation. The user can re-run `/ralph-hero:autopilot` to start a fresh loop (which will initialize a new `state` object in Step 1).

<!-- Audit log writes (between Step 7 and Step 8) and PreToolUse hook gate added in Phase 4 (GH-1140); README/CLAUDE.md/eval-scenarios in Phase 5 (GH-1141) -->
