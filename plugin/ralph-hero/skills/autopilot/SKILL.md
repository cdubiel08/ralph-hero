---
description: Autonomous backlog clearer. Runs /hero in a self-paced loop via ScheduleWakeup, picking the next-most-important XS/S issue per tick, escalating to Human Needed when stuck, stopping cleanly when the queue is empty. Single-command shorthand for "go clear the backlog while I'm away."
argument-hint: "[--max-iterations N] [--auto-merge] [--dry-run] [--state=BASE64]"
context: inline
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

<!-- internal: this phase implements the full per-tick flow through Step 10. Subsequent phases
(#1140, #1141) add the audit-log JSONL writes + `PreToolUse` hook gate, and the docs + eval scenarios
respectively. -->

## Step 0: Safety check

If `RALPH_AUTOPILOT_ENABLE` is not exactly the string `"true"`, STOP immediately with this message and do NOT proceed to Step 1:

> Autopilot is opt-in. To enable: `export RALPH_AUTOPILOT_ENABLE=true`

<!-- internal: hard opt-in for unattended automation. Refuse cleanly so the user can re-invoke
with the env var set. No fallthrough — terminate the skill body here. -->

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

<!-- internal: the `state` object is referenced in Step 2.5 (history filter) and will be re-encoded into the next tick's `--state` argument by Phase 3's loop machinery. -->

## Step 2: Pick the next actionable issue

Call `next_actions(audience="agent", limit=10)`. <!-- internal: the limit is raised from the default 5 to give Step 2.5's filter enough headroom to skip past human-gated candidates without exhausting the list. -->

Inspect the result:

- If `items` is empty -> backlog clear -> STOP. Report "Backlog empty" with a brief final summary. Do NOT call `ScheduleWakeup`.
- Filter to `kind == "issue"` only. Skip PR-kind, lock-stale, and tree-continue directions. <!-- internal: those are handled by other skills, not autopilot's per-issue dispatch. -->
- If no `kind == "issue"` candidate remains after the filter -> STOP, same as empty backlog.
- Otherwise: the top issue-kind direction is the candidate `<picked>`. Pass it to Step 2.5.

## Step 2.5: Skip "human-gated" candidates (In-Review filter)

<!-- internal: rationale (do not surface to user)
This filter prevents a false-positive escalation loop. In `RALPH_REVIEW_MODE=interactive` (the default),
hero lands a PR and stops; the issue's workflow state becomes `"In Review"`. But `"In Review"` is in
`ACTIONABLE_PHASES` (verified at `plugin/ralph-hero/mcp-server/src/lib/directions.ts:180-185`), so
`next_actions` will keep returning the just-PR'd issue. Without this filter, autopilot would re-pick
the same issue, hero would detect "phase=INTEGRATE, interactive mode, stop", outcome would be
`no_progress`, and after 3 ticks autopilot would escalate a perfectly healthy in-review PR to Human Needed.
-->

Apply both filter rules to the candidate list returned by Step 2:

1. Drop `In Review` candidates:

   ```
   candidates = candidates.filter(c => c.workflowState !== "In Review")
   ```

2. Drop issues already PR'd this loop:

   ```
   candidates = candidates.filter(c => !state.history.some(h => h.issue === c.issue && h.outcome === "pr_landed"))
   ```

<!-- internal: `--auto-merge` carve-out
For MVP, the In-Review filter remains ON regardless of `--auto-merge`. Users who want autopilot
to push past code review can re-invoke after merge. Auto-merge In-Review handling
(running code-review + merge against in-review PRs without re-escalation) is tracked as follow-up work.
-->

After filtering:

- If no candidates remain -> STOP with `outcome=backlog_empty`. Surface any in-review PRs in the final report so the user knows what is queued for them.
- Otherwise: the top remaining candidate is the picked issue `<picked>`. Continue to Step 3.

<!-- internal: Phase 1 contract (kept here for the LLM, not user output)
For Phase 1 only: report the picked issue (number, title, workflow state) and STOP.
Do not dispatch hero, do not call `ScheduleWakeup`, do not write to the audit log —
those are Phase 2/3/4 work.
-->

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

3. Stop the loop: this tick is terminal. Do NOT proceed to Step 4. Do NOT call `ScheduleWakeup`. Record this as `outcome=escalated` in the audit log.

<!-- internal: auto-cleanup risks destroying in-progress work. Autopilot never deletes worktrees,
never deletes files under `worktrees/`, and never force-resets a branch. Recovery requires a human
to inspect and clean up. Automatic cleanup is tracked as follow-up work in the parent plan §Follow-up Work;
it is an explicit non-goal of Phase 2. -->

**On no collision**: proceed to Step 4.

## Step 4: Capture pre-state

Call `get_issue(number=<picked>, includePipeline=true)` once and capture four fields into a local `pre` object for use in Step 6's diff:

- `pre.workflowState` — top-level `workflowState` field on the response (e.g., `"Backlog"`, `"In Progress"`, `"In Review"`).
- `pre.phase` — pipeline phase name from the `pipeline` payload that `includePipeline=true` adds to the response (the high-level phase the orchestrator's pipeline detection assigned; used to spot phase advances that don't change `workflowState`).
- `pre.subIssueCount` — read from `subIssuesSummary.total` on the `get_issue` response. <!-- internal: the response payload already carries this, so no separate `list_sub_issues` call is needed. If a future schema change drops `subIssuesSummary`, fall back to `list_sub_issues(number=<picked>)` and use its returned count. -->
- `pre.linkedPRs` — collect any PR references already on the issue. Source: PR-linkage fields on the `get_issue` response payload. No extra GitHub API calls.

<!-- internal: `pre` lives only in the current tick's local scope — it is consumed by Step 6 and discarded.
State persisted across ticks (the `state` object) is unaffected by Step 4. -->

## Step 5: Dispatch hero

**Dry-run branch** (`--dry-run` flag is set):

- Skip dispatch entirely. Do NOT call `Skill("ralph-hero:hero", ...)`.
- Mark this tick's outcome as `outcome=dry_run`.
- Emit to user: `"Would dispatch hero for #<picked> (<title>) — skipped due to --dry-run"`.
- Do NOT proceed to Step 6's pre/post diff. <!-- internal: dry-run is terminal for outcome derivation; no post-state exists. -->

**Real dispatch branch** (no `--dry-run`):

<!-- internal: hero's review mode is controlled via `RALPH_REVIEW_MODE`, not a CLI flag.
Hero's `argument-hint` (see `plugin/ralph-hero/skills/hero/SKILL.md:3`) is just `<issue-number>`.
Hero reads `${RALPH_REVIEW_MODE:-interactive}` at load time (`hero/SKILL.md:50`); accepted values
are `interactive` (stop at PR, default) or `auto` (auto-run code review and merge) per `hero/SKILL.md:517`. -->

Set the env var for the dispatch shell context based on the parsed flags from Step 1:

- If `--auto-merge` is set: `export RALPH_REVIEW_MODE=auto` via Bash before the `Skill()` call.
- Otherwise: `export RALPH_REVIEW_MODE=interactive` (explicit beats relying on the `:-interactive` default).

Then dispatch hero with the picked issue as a single positional argument:

```
Skill("ralph-hero:hero", args="<picked>")
```

Capture hero's text output to a local variable `hero_output` for inclusion in the Phase 4 audit-log entry.

<!-- internal: do NOT parse `hero_output` for outcome derivation. Text-grepping hero's
free-text reports (the approach used in `plugin/ralph-hero/scripts/ralph-loop.sh`'s
`grep -qiE "Queue empty|Triage complete"`) is fragile and was explicitly rejected by review.
Outcome derivation is the job of Step 6's structured `get_issue` diff.
`hero_output` is preserved only for the audit log (forensic context for humans), never for control flow. -->

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

<!-- internal: the catch-all `other_change` row prevents silent loss of unexpected state transitions —
anything that changes the workflow state but doesn't match a documented forward path
(backward transition, regression, or any unanticipated mutation) is recorded with
`outcome=other_change` and treated as progress for streak-reset. Without this row,
an unexpected post-state would silently fall through and be misclassified as `no_progress`. -->

When `outcome=escalated` (row 2 matches): capture the most recent comment text on the issue into a local variable `escalation_reason` for inclusion in the Phase 4 audit-log entry. Source: the last entry of the `comments` array on the post-state `get_issue` response payload (no extra API call).

<!-- internal: this step replaces the earlier text-grep approach with structured pre/post diffing.
Outcome derivation reads only typed fields from MCP responses, never strings from hero's free-form output. -->

## Step 7: Update tick counters

After Step 6 derives `<outcome>` from the pre/post diff (or from the dry-run short-circuit), update the cross-tick state object before Step 8 evaluates termination conditions.

1. **Increment iteration**: `state.iteration += 1`. The `state` object was decoded (or initialized) in Step 1; `state.iteration` is the live counter that Step 8 row 4 (max-iterations cap) reads.

2. **Apply the canonical outcome → streak mapping** (one branch per outcome — exhaustive):

   - `outcome` is `completed`, `pr_landed`, `advanced`, or `other_change` -> `state.no_progress_streak = 0`
   - `outcome` is `no_progress` -> `state.no_progress_streak += 1`
   - `outcome` is `escalated` -> no-op <!-- internal: loop STOPs in Step 8 regardless -->
   - `outcome` is `dry_run` -> no-op <!-- internal: dry-run STOPs in Step 8 row 2 -->

3. **Append to history**: push `{issue: <picked>, outcome: <derived>}` onto `state.history`. <!-- internal: history is the source-of-truth for Step 2.5's "exclude issues already PR'd this loop" filter on the next tick. -->

4. **Audit-log write deferred to Step 8.5** — see `## Audit log entry shape` below.

<!-- internal: the JSONL append happens AFTER Step 8 has resolved STOP-or-CONTINUE
(so `next_action` and `next_delay_seconds` are known), but BEFORE Step 9 calls `ScheduleWakeup`
or Step 10 emits the final report. This ensures the audit row is forensically captured
even if the wakeup or final-report fails.
Cross-reference: parent plan `2026-05-07-GH-1136-autopilot-skill.md` §Phase 4 lines 401-426. -->

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

<!-- internal invariant: exactly one branch per code path. Either Step 8 STOPs and Step 10 fires
(no `ScheduleWakeup` call), OR Step 8 does not STOP and Step 9 fires (one `ScheduleWakeup` call,
no Step 10). Two ScheduleWakeup calls in one tick is a bug. Zero ScheduleWakeup calls AND zero
final reports is a bug. -->

**Streak-escalation side effect (row 3)**: when `state.no_progress_streak >= 3` matches, perform two side-effects against the picked issue before stopping:

1. Call `save_issue(number=<picked>, workflowState="__ESCALATE__", command="ralph_plan")` to transition `<picked>` to `Human Needed`.
2. Post a `create_comment` on the issue with body:

   > Autopilot detected a no-progress streak of 3 ticks against this issue. Escalating to Human Needed for review. Audit log: `~/.ralph-hero/autopilot.jsonl`

Then proceed to Step 10 — the streak-escalation count is surfaced in the final report's escalation totals.

**Backlog re-check rule (row 5)**: call `next_actions(audience="agent", limit=10)` again and re-apply Step 2/2.5 filters (kind=="issue", exclude In Review, exclude already-pr_landed in `state.history`).

<!-- internal: re-checking inside Step 8 (rather than relying on the next tick to discover
the empty backlog) avoids one wasted `ScheduleWakeup` round-trip and gives the user a tight terminal report. -->

**Cross-references**: STOP -> Step 10 (final report). CONTINUE -> Step 9 (ScheduleWakeup).

## Audit log entry shape

After Step 8's branch decision is made, but before Step 9's `ScheduleWakeup` call (or Step 10's final report), append a single JSON line to `~/.ralph-hero/autopilot.jsonl`.

<!-- internal: this sub-step (Step 8.5) is the forensic capture point. The row is written
BEFORE the side-effecting `ScheduleWakeup` or Step 10 emission so the audit trail records the tick
even if the wakeup or final-report subsequently fails.

Placement is dictated by data-readiness: by Step 7 we know `iteration`, `state.no_progress_streak`,
and `outcome`; the `next_action` and `next_delay_seconds` fields require the Step 8 branch to have resolved first.
Hence the write executes here — once Step 8 has decided STOP-or-CONTINUE — and immediately precedes Step 9 / Step 10. -->

The canonical 13-field entry shape (from parent plan-of-plans `2026-05-07-GH-1136-autopilot-skill.md` §Phase 4 lines 405-419):

```json
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
```

**Per-outcome variations** (parent plan lines 421-424):

- escalations: `outcome="escalated"`, `escalation_reason="<from last comment>"`, `next_action="stop"`, `next_delay_seconds=null`
- dry-run: `outcome="dry_run"`, `next_action="stop"`, `next_delay_seconds=null`
- backlog-empty: `outcome="backlog_empty"`, `next_action="stop"`, `next_delay_seconds=null`, `issue_number=null`
- no-progress-streak escalation, max-iterations stop, etc.: `next_action="stop"`, `next_delay_seconds=null`

**STOP / null rule (canonical)**: whenever `next_action == "stop"`, `next_delay_seconds` MUST be the JSON literal `null` (not `0`, not absent, not the string `"null"`). This rule applies to every STOP cause uniformly. Downstream JSONL parsers (e.g., `jq -r '.next_delay_seconds' ~/.ralph-hero/autopilot.jsonl | sort -u`) will then yield a clean set: `{60, 1200, null}` — no other values.

For continuing ticks (`next_action == "schedule"`), `next_delay_seconds` is the value Step 9 selected — exactly one of `{60, 1200}` per the live-set constraint. Cross-reference Step 9 for how that value is computed.

**Append pattern** (canonical, parent plan lines 428-435): use `mkdir -p ~/.ralph-hero` to idempotently create the parent directory (no-op on subsequent ticks), then construct the JSON via `jq -nc` with `--arg` / `--argjson` flags so all field values flow through safe parameter interpolation rather than manual shell quoting. The `-n` flag means "null input" (start from nothing), `-c` means "compact output" (single-line, JSONL-shaped):

```bash
mkdir -p ~/.ralph-hero
jq -nc \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson iteration "$ITER" \
  --argjson issue_number "$ISSUE_NUMBER" \
  --arg issue_url "$ISSUE_URL" \
  --arg pre_state "$PRE_STATE" \
  --arg post_state "$POST_STATE" \
  --arg outcome "$OUTCOME" \
  --arg pr_url "$PR_URL" \
  --argjson duration_ms "$DURATION_MS" \
  --argjson no_progress_streak "$STREAK" \
  --argjson next_delay_seconds "$NEXT_DELAY" \
  --arg next_action "$NEXT_ACTION" \
  --argjson args "$ARGS_JSON" \
  '{ts:$ts, iteration:$iteration, issue_number:$issue_number, issue_url:$issue_url, pre_state:$pre_state, post_state:$post_state, outcome:$outcome, pr_url:$pr_url, duration_ms:$duration_ms, no_progress_streak:$no_progress_streak, next_delay_seconds:$next_delay_seconds, next_action:$next_action, args:$args}' \
  >> ~/.ralph-hero/autopilot.jsonl
```

For STOP rows, pass `--argjson next_delay_seconds null` to materialize the JSON literal `null` correctly (note: `null` here is unquoted; passing `"null"` as a string would be wrong). For CONTINUE rows, pass `--argjson next_delay_seconds 60` or `--argjson next_delay_seconds 1200` per Step 9's selection.

The `args` object captures the parsed Step 1 flags (`max_iterations`, `auto_merge`, `dry_run`) so a forensic reader can reconstruct the run's invocation parameters from any single tick row.

**Forensic-capture invariant**: the JSONL append happens BEFORE the side-effecting `ScheduleWakeup` call (Step 9) or final-report emission (Step 10). If the wakeup or final-report subsequently fails, the audit row is still on disk. Cross-reference Step 9 (where `next_delay_seconds` is computed) and Step 10 (where `next_action="stop"` rows feed the final report's escalation totals and run summary).

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

   - `outcome` is `pr_landed`, `advanced`, `completed`, or `other_change` -> `delaySeconds = 60`
   - `outcome` is `no_progress` (streak 1 or 2; streak 3 STOPped in Step 8 row 3) -> `delaySeconds = 1200`
   - `escalated` and `dry_run` already STOPped in Step 8 — Step 9 is unreachable for them

   <!-- internal rationale:
   60s = stay inside Claude Code's prompt cache window for fast continuation.
   1200s = cache-miss cooldown that gives the system time when nothing changed. -->

   **Forbidden values**:
   - `300` is forbidden (cache-window anti-pattern). Phase 4's `PreToolUse` hook gate (in #1140) enforces this; Phase 3 already complies by construction.
   - `1800` is forbidden in branch logic. <!-- internal: the Configuration block mentions 1800 as a documentation default for idle ticks, but Step 9's branch logic must NEVER select it. -->

3. **`--state=BASE64` equals-form**: use the equals-form (e.g., `--state=eyJpdGVy...==`), not space-separated. The argument-parser in Step 1 accepts `--state=...` (everything after the first `=` is the value, including any base64 padding `=` chars).

<!-- internal: base64 padding (`=` chars) and URL-safe alternates can confuse a positional parser;
the equals-form makes the boundary unambiguous. Step 9's emitted prompt must be wire-compatible with Step 1's parser. -->

4. **Build the prompt**: re-invoke `/ralph-hero:autopilot` and carry forward all original flags from Step 1 (`--max-iterations N`, `--auto-merge` if originally set, `--dry-run` if originally set) PLUS the new `--state=<BASE64>` argument. <!-- internal: `--dry-run` STOPs in Step 8 row 2 and never reaches Step 9 in practice; carrying it forward is defensive. -->

5. **Call `ScheduleWakeup` exactly once**:

   ```
   ScheduleWakeup(
     delaySeconds = <chosen>,
     reason = "autopilot tick <iteration+1>: continuing after <picked> <outcome>",
     prompt = "/ralph-hero:autopilot --max-iterations <N> [--auto-merge] --state=<BASE64>"
   )
   ```

   <!-- internal: the `prompt` field is the cross-tick state channel (per the parent plan's Tick Isolation table).
   The audit log (Phase 4) records `next_delay_seconds` and `next_action`; Phase 3 persists state only via this prompt. -->

6. **Emit a brief tick summary** AFTER the `ScheduleWakeup` call: `"Tick N complete: dispatched #X, outcome=Y, next tick in Zs"` (filling in `state.iteration`, `<picked>`, `<outcome>`, and `<chosen>`). Then STOP this turn.

<!-- internal: Step 10 is NOT called when Step 9 fires. The final report is reserved for terminal turns
(Step 8 STOPped). Step 9's brief tick summary is the only user-visible output for non-terminal ticks. -->

## Step 10: Final report (terminal turn only)

This step runs only when Step 8 STOPped (rows 1-5). When Step 9 schedules the next tick, Step 10 is skipped.

Emit a markdown summary with these sections:

- **Total ticks run**: from `state.iteration`.
- **Wall-clock elapsed time**: `now - state.started_at` (human-readable duration).
- **Issues processed**: from `state.history`, with each issue's outcome (e.g., `#1234 -> pr_landed`, `#1235 -> advanced`, `#1236 -> escalated`).
- **PRs created**: count of entries in `state.history` where `outcome == "pr_landed"`.
- **Escalations**: count + reasons. <!-- internal: includes both the original `outcome=escalated` ticks (hero detected ambiguity mid-flight) AND the streak-escalation from Step 8 row 3 (autopilot detected a no-progress streak of 3). -->
- **In-review PRs awaiting human merge**: any issues filtered out by Step 2.5. Phrasing: "N issues are awaiting human merge in `In Review` — re-run with `--auto-merge` to merge automatically."
- **Audit log path**: `~/.ralph-hero/autopilot.jsonl`. <!-- internal: file is created and appended in Phase 4; Phase 3 only references the path. -->

The report ends the autopilot run for this invocation.

<!-- README/CLAUDE.md/eval-scenarios in Phase 5 (GH-1141) -->
