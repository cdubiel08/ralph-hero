---
date: 2026-05-22
topic: "PR-drain routine: handling unlinkable PRs without feeding them to Director"
tags: [design, spec, pr-drain, routine, director, next_actions, dependabot, observability]
status: complete
type: research
git_commit: fd0a38d820f9398df8030d1c3826a9cc7018d012
git_branch: main
---

# PR-drain routine: handling unlinkable PRs without feeding them to Director

## Prior Work

- builds_on:: [[2026-05-21-autopilot-loop-handoff]] (research — silent-drop bug; identifies the wasteful-skip director problem this spec fixes)
- builds_on:: [[2026-05-17-GH-1267-unified-agent-system-usage-guide]] (research — Director/teams/operators architecture this design extends)
- builds_on:: commit `57a735a2 fix(director): STOP on unlinked PR instead of iterating directions` (the change that surfaced the wasteful-skip behavior)
- contrasts_with:: GH-1346 (in-flight autopilot silent-drop stop-gate — orthogonal fix for a different failure mode)

## Problem

`next_actions` ranks open PRs alongside open issues. When a PR's head-ref does not match `feature/GH-NNNN` (typical for Dependabot bumps), Director's Step 2a emits `result: Top direction is PR #<N> with no linked issue. Skipping.` and STOPs (per commit `57a735a2`, which rejected the alternative "iterate within one invocation" because Director is documented as a pure single-event dispatcher).

`/loop` re-ticks back into the same top-of-queue entry, Director emits the same skip, the loop spins on the same wasteful no-op. Observed in a background session on 2026-05-21 where the top three queue entries were Dependabot bumps and Director skipped each one in sequence on every tick.

Two requirements that constrain the fix:

1. **Director must not see PRs it cannot dispatch** — filtering happens upstream.
2. **PRs still need to get handled.** Dependabot bumps accumulate; stale non-Dependabot PRs need pinging or closing. The handler must exist somewhere.

## Architectural constraints (from user)

- Per-PR, near-real-time. No 24h heartbeat latency.
- Aligned with the existing **message-based async-loop, shared-state-with-message-based-triggers** pattern (the same shape that powers caretake heartbeats, scout-nightly, Director's `RemoteTrigger` input, and the monitoring-bridge daemon).
- Integrated with the existing state machine and observability surfaces — no shadow channel where PR-handling work happens invisibly to the pipeline dashboard, snapshots, dream loop, or cos summaries.

## Summary

A new Claude Code **Routine** named `pr-drain`, hosted on Anthropic's cloud Claude Code infrastructure (Max plan, research-preview surface). Triggered by the **native GitHub trigger** in Routines (Claude GitHub App listens for `pull_request` events on `cdubiel08/ralph-hero`). The routine prompt is a one-liner that parses the PR number out of the text payload and invokes a new local skill `/ralph-hero:ralph-pr-drain --pr <N>`.

The skill is the operator: classify the PR, run `code-review:code-review` as the merge gate for auto-merge candidates, act (merge / comment / close), create a synthetic Ralph issue threaded through the project board for observability, and record the outcome.

Director never sees these PRs because `next_actions` filters out `kind: "pr" && linkedIssueNumber === null` rows at the source. The director STOP branch on unlinked PRs becomes dead code (kept for safety; deleted as cleanup).

## Architecture

```
PR opened / synchronized / ready_for_review
        │
        ▼
Claude GitHub App (native trigger registered in claude.ai/code UI)
        │
        ▼
Routine "pr-drain" wakes a cloud Claude Code session
  text payload: e.g. "PR 1316 opened in cdubiel08/ralph-hero"
        │
        ▼
/ralph-hero:ralph-pr-drain --pr 1316
        │
        ├─ Classify (Dependabot patch/minor/major, stale-close, stale-ping, needs-human)
        ├─ Create synthetic Ralph issue (state: Backlog → In Progress)
        ├─ For auto-merge candidates: Skill("code-review:code-review", "1316") as gate
        │     ├─ GREEN  → gh pr merge --squash --auto
        │     └─ MUST_FIX → comment + hold for human (new class: dependabot-review-flagged)
        ├─ Post audit comment on PR, add `pr-drained` label
        ├─ Advance synthetic issue to Done (or Human Needed for needs-human / merge-failed)
        └─ knowledge_record_outcome({ event: "pr_drain", outcome: CLASS, … })

In parallel:
next_actions (MCP, ranking surface): drops kind: "pr" rows with null linkedIssueNumber.
Director never sees them. Director's STOP-on-unlinked-PR branch becomes dead code.
```

**Architectural alignment with the async-loop / message-trigger model:**

| Element | Maps to |
|---|---|
| `pull_request` event | the message |
| Routine text payload | the message content |
| `pr-drained` label | shared state, queryable by all consumers |
| Synthetic issue + labels | shared state visible to dashboard, snapshots, cos |
| Cloud Routine session | the loop (one-shot, per-event) |
| `ralph-pr-drain` skill | the operator |
| `next_actions` filter | source-level gate so Director sees no PR work |

Director (issue dispatch) and the pr-drain routine (PR dispatch) are independent loops keyed on different input shapes. They share no orchestration state; they share GitHub state.

## Components

Four files change. One new skill is created.

### 1. `mcp-server/src/lib/directions.ts` (filter)

In the `merged.sort` build phase (currently lines ~895–913), after building `merged` and before computing `tiedCount`, filter out PR rows whose `linkedIssueNumber` is null:

```typescript
// Filter unlinkable PRs (no linked issue) so they don't appear in next_actions.
// These are handled by the pr-drain Routine (out of band of Director).
const drainable = merged.filter((entry) => {
  if (entry.kind !== "prRow") return true;
  return entry.payload.linkedIssueNumber !== null;
});
```

Use `drainable` everywhere `merged` was used downstream.

No new signal/field surfaces. No new top-level counter (deferred per user decision). The Director STOP branch in `director/SKILL.md` Step 2a becomes dead code; kept in place for safety, deleted as a follow-up cleanup commit.

### 2. `mcp-server/src/__tests__/directions-tools.test.ts` (test)

New test case: 3 candidate PRs in `openPRs` (2 with `feature/GH-NNNN` head-refs, 1 with `dependabot/...`). Assert the resulting `directions` array contains exactly 2 entries, both linked PRs.

### 3. `skills/ralph-pr-drain/SKILL.md` (new skill)

| Concern | Value |
|---|---|
| `description` | "Drain a pull request that Director cannot dispatch (typically Dependabot bumps or stale unlinked PRs). Classifies the PR, runs code-review as the merge gate for auto-merge candidates, acts, and threads a synthetic Ralph issue through the board for observability. Invoked by the pr-drain cloud Routine, also user-invocable locally." |
| `argument-hint` | `--pr <PR-NUMBER>` |
| `user-invocable` | `true` |
| `model` | `sonnet` (classification + review parsing benefits from Sonnet; Haiku would be marginal) |
| `allowed-tools` | `Read`, `Bash`, `Skill`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` |
| `hooks.SessionStart` | `set-skill-env.sh RALPH_COMMAND=pr-drain` |

**Skill body (8 steps, ~120 lines):**

1. **Parse `--pr <N>` arg; idempotency check.** `gh pr view <N> --json labels --jq '.labels[].name'`. If `pr-drained` is present → emit `result: PR #N already drained` and STOP.
2. **Fetch PR.** `gh pr view <N> --json number,url,title,author,statusCheckRollup,mergeable,headRefName,createdAt,updatedAt,body`.
3. **Classify** (priority order, first match wins):
   - `author.login == "app/dependabot"` AND title parses as patch/minor bump AND all checks green → `dependabot-auto-merge` candidate
   - `author.login == "app/dependabot"` AND title parses as major bump → `dependabot-needs-review`
   - `now - updatedAt > 30d` → `stale-close`
   - `now - updatedAt > 14d` → `stale-ping`
   - default → `needs-human`
4. **Synthetic issue (with reuse check).** First `list_issues({ labels: ["kind:pr-drain"], state: "OPEN" })` and search titles for `Drain: PR #<N>`. If found, reuse its number. Otherwise `create_issue({ title: "Drain: PR #<N> — <pr.title>", labels: ["pr-drain", "kind:pr-drain"], body: "Auto-created by ralph-pr-drain. Classification: <CLASS>. PR: <pr.url>" })`. Then `save_issue({ number: <synth>, workflowState: "In Progress" })`.
5. **Act per CLASS:**
   - `dependabot-auto-merge`: `Skill("code-review:code-review", "<N>")` → parse verdict
     - GREEN: `gh pr merge <N> --squash --auto`; final outcome = `dependabot-auto-merge`
     - MUST_FIX: post comment with review findings; final outcome = `dependabot-review-flagged`
   - `dependabot-needs-review`: `Skill("code-review:code-review", "<N>")`, post review as comment, no merge
   - `stale-close`: `gh pr close <N> --comment "Closing as stale (>30d since last activity). Reopen if still relevant."`
   - `stale-ping`: `gh pr comment <N> --body "This PR has been open >14d with no activity. @<author> — is this still active?"`
   - `needs-human`: emit `needs input: PR shape unrecognized; manual triage required.` STOP (do not advance synth to Done).
6. **Audit trail on PR.** `gh pr comment <N> --body "## PR Drain\n\nClassified as <CLASS>. Action: <action>. Synthetic issue: #<synth>. Review verdict: <verdict-or-n/a>."`. Then `gh pr edit <N> --add-label pr-drained`.
7. **Advance synth + record outcome.**
   - For non-`needs-human` classes: `save_issue({ number: <synth>, workflowState: "Done" })`.
   - For `needs-human` and the runtime `merge-failed` outcome from the Error Handling table: `save_issue({ number: <synth>, workflowState: "Human Needed" })`.
   - `knowledge_record_outcome({ event: "pr_drain", outcome: CLASS, pr: N, synth_issue: <synth>, review_verdict: GREEN | MUST_FIX | "n/a" })`.
8. **Emit result marker.** `result: Drained PR #<N> (class: <CLASS>, synthetic issue: #<synth>)`.

### 4. `skills/director/SKILL.md` (dead-code cleanup, optional)

Delete or comment out the `linkedIssueNumber` absent branch in Step 2a (currently lines ~59–61). Not required for correctness — the filter makes it unreachable — but worth removing to avoid future-reader confusion. Can be a separate commit.

### 5. The Routine (lives in claude.ai UI, not in this repo)

Created via `claude.ai/code/routines` → New Routine. Prompt body:

```
You receive a GitHub pull_request event as a text payload (e.g. "PR 1316 opened
in cdubiel08/ralph-hero"). Parse the PR number. Then invoke:

  /ralph-hero:ralph-pr-drain --pr <N>

The skill classifies the PR, runs code review for auto-merge candidates, acts
(merge / comment / close), creates a synthetic Ralph issue for board visibility,
and records the outcome. Emit the skill's `result:` line and exit.
```

Trigger: native GitHub → events `pull_request: opened, synchronize, ready_for_review` → repo `cdubiel08/ralph-hero`.

## Data flow

End-to-end happy path for a Dependabot patch bump (`#1316 idna 3.7→3.8`):

```
T+0s     Dependabot opens PR #1316
         ├─ headRefName = dependabot/pip/idna-3.8 (no feature/GH-NNNN match)
         └─ next_actions filter excludes it from Director queue

T+2s     Claude GitHub App fires pr-drain Routine
         └─ text: "PR 1316 opened in cdubiel08/ralph-hero"

T+5s     Cloud Claude session starts; invokes /ralph-hero:ralph-pr-drain --pr 1316

T+10s    Step 1: gh pr view 1316 → no pr-drained label
T+15s    Step 2: fetch PR; author = app/dependabot
T+20s    Step 3: classify → dependabot-auto-merge candidate

T+25s    Step 4: list_issues (no existing drain issue for #1316) →
         create_issue → #1347 (Backlog → In Progress)

T+30s    Step 5: Skill("code-review:code-review", "1316")
T+90s    Review verdict: GREEN
T+92s    gh pr merge 1316 --squash --auto

T+100s   Step 6: gh pr comment audit trail + gh pr edit --add-label pr-drained
T+102s   Step 7: save_issue #1347 → Done
T+103s   knowledge_record_outcome({ event: "pr_drain", outcome:
         "dependabot-auto-merge", pr: 1316, synth_issue: 1347,
         review_verdict: "GREEN" })

T+105s   result: Drained PR #1316 (class: dependabot-auto-merge,
         synthetic issue: #1347)
T+105s   Cloud session ends
```

**Synthetic issue state transitions** (one full lifecycle inside one skill invocation):
`Backlog (on create_issue) → In Progress (Step 4) → Done (Step 7)`.

For `needs-human` and `merge-failed`: terminal state is `Human Needed` instead of `Done`.

**Where existing observability picks it up:**

- `pipeline_dashboard`: counts the synthetic issue in its terminal-state bucket
- `capture_snapshot`: next daily snapshot rolls the synth issue into velocity + lead-time-p50 (lead time will be ~minutes, which is informative — distinguishes drain work from real work)
- `dream-loop / reflect.py`: clusters outcome events. If `dependabot-review-flagged` outcomes spike, files a process-improvement issue
- `cos remote`: synthetic issues are filterable via the `kind:pr-drain` label so the "real work" view stays clean

## Error handling

| Failure | Detection | Recovery |
|---|---|---|
| `gh pr view` fails (PR deleted / 404) | Non-zero exit | Emit `result: PR #N no longer accessible. Skipping.` No synth issue created. |
| `code-review:code-review` times out or errors | No verdict line | Treat as MUST_FIX (fail closed for auto-merge); post comment that review didn't complete; outcome `"review-error"`. |
| `gh pr merge` fails (merge conflict, CI red between view and merge) | Non-zero exit | Post comment with the error, advance synth to `Human Needed`, outcome `"merge-failed"`. |
| `create_issue` fails (rate limit, GitHub outage) | MCP error | Abort before any PR action. No `pr-drained` label written. Next routine fire retries the whole flow. |
| Cloud session times out mid-flow | Routine wrapper sees no `result:` line in output | PR has no `pr-drained` label → next event re-runs. Orphan synth issue in `In Progress` is caught by caretake's hygiene mode. |
| Two routine fires race | Both pass Step 1 check | The Step 4 reuse-by-title check collapses to one synth issue. `gh pr merge --auto` is naturally idempotent. Worst case: two audit comments on the PR (cosmetic). |

## Idempotency (defense in depth)

1. **Pre-flight label check (Step 1):** skill exits silently if PR already has `pr-drained`. Catches double-fire of the routine for the same `pull_request: opened` event.
2. **Synthetic-issue reuse-by-title (Step 4):** prevents duplicate synth issues if the label check is bypassed (e.g., manual invocation with the label not yet present).
3. **`gh pr merge --auto`:** idempotent by design — if already merged, exits 0 with a no-op message the skill treats as success.

## Testing strategy

| Layer | What | How |
|---|---|---|
| `directions.ts` filter | Unit test in `directions-tools.test.ts` | Fixture: 3 PRs (2 linked, 1 Dependabot). Assert merged list has 2. |
| Classification rules | Unit test (new `pr-drain.test.ts` or fixture under `mcp-server/src/__tests__/`) | Mock `gh pr view` outputs for each class. Assert correct CLASS string. |
| Synthetic-issue contract | Integration smoke | Manual: invoke skill against a sandbox PR; assert title format, labels, state machine path. |
| End-to-end | Manual: open a draft Dependabot-shaped PR | Verify routine fires, drain runs, synth lifecycle, audit comment, label, outcome event. |
| Idempotency | Manual: invoke skill twice on same PR | Second invocation emits "already drained" and exits. |

No new eval scenarios in `autopilot/eval-scenarios.md` — pr-drain is out-of-band of autopilot.

## What this does NOT do (scope boundaries)

- **Does not** add a `drainedPRs` counter to `pipeline_dashboard`. Drained synth issues fold into existing Done counts. Filterable by `kind:pr-drain` label if a consumer wants to break them out.
- **Does not** add a `record_activity_remote` MCP tool. The cloud→local activity-log gap stays open. Synthetic-issue + outcome-event traces cover the observability need for v1.
- **Does not** fix GH-1346 (autopilot silent-drop stop-gate). Orthogonal fix on its own branch.
- **Does not** change the `RemoteTrigger` tool description or the monitoring-bridge `subscribe.py` URL path. Those may use an older path (`/v1/code/triggers/...` vs official `/v1/claude_code/routines/...`); worth auditing in a follow-up but not blocking on this work.
- **Does not** introduce a heartbeat or cron sweep as a safety net. Per-event triggering only. If a fire is missed, the PR sits unhandled until the next `pull_request: synchronize` event or until a human notices.

## Setup steps (one-time, after the code merges)

1. Build + publish `ralph-hero-mcp-server` with the `directions.ts` filter (auto-release on merge to main).
2. Install ralph-hero plugin in the cloud routine session (via `claude.ai/code` UI when creating the routine — same plugin source as local).
3. `claude.ai/code/routines` → **New Routine** → paste the routine prompt above → trigger: GitHub → events: `pull_request: opened, synchronize, ready_for_review` → repo: `cdubiel08/ralph-hero` → **Create**.
4. Verify with a smoke PR (open a draft, watch the routine fire, inspect the synth issue + audit comment).

## Open questions

- The `RemoteTrigger` tool description in the local plugin cache says `/v1/code/triggers/...` but the official Anthropic docs say `/v1/claude_code/routines/...`. The monitoring-bridge `subscribe.py` may be hitting an undocumented or internal path. Worth a separate audit but doesn't block this spec because the native GitHub trigger does not use the `RemoteTrigger` tool.
- `code-review:code-review`'s verdict-parsing contract — does it always emit a parseable GREEN / MUST_FIX line, or does it sometimes emit only prose? Verify before relying on it as a gate. If unreliable, fall back to grep for `MUST_FIX` / `must fix` / `block` in the review output.
- Dependabot bump-classification heuristic (parsing the title for major vs minor vs patch). The PR title format is conventional but not guaranteed — Dependabot occasionally formats grouped updates differently. Spec assumes single-package bumps; grouped updates would need a follow-up.

## References

- Research: [[2026-05-21-autopilot-loop-handoff]] (silent-drop bug; identifies the wasteful-skip director problem)
- Director skill: `plugin/ralph-hero/skills/director/SKILL.md` (Step 2a STOP branch becomes dead code)
- next_actions ranking: `plugin/ralph-hero/mcp-server/src/lib/directions.ts:870–1000`
- `ralph-merge` (reference for merge mechanics, not directly reusable due to issue coupling): `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
- `finish` (reference for code-review-as-merge-gate pattern): `plugin/ralph-hero/skills/finish/SKILL.md`
- Monitoring bridge (in-repo RemoteTrigger producer, for the `URL-shape` audit follow-up): `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py:289-632`
- Official Routines docs: https://code.claude.com/docs/en/routines
- Official fire endpoint: https://platform.claude.com/docs/en/api/claude-code/routines-fire
