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

This phase implements only the prefix of that flow: safety check, argument parsing + state decode, pick-next-actionable, and the In-Review filter. Subsequent phases (#1138, #1139, #1140) append the worktree check, hero dispatch, pre/post diff, loop scheduling, termination conditions, and audit log writes.

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

<!-- Steps 7+ added in subsequent phases (GH-1139, GH-1140, GH-1141) -->

