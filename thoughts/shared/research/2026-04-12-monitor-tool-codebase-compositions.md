---
date: 2026-04-12
github_issue: 760
github_url: https://github.com/cdubiel08/ralph-hero/issues/760
topic: "Monitor Tool: What It Is and Where It Would Be Useful in the Codebase"
tags: [research, codebase, monitor-tool, polling, sleep, background-processes, ci-watch, dev-server]
status: complete
type: research
git_commit: ebfeccf721a3ce4f8628c4e683af753c59e806de
---

# Research: Monitor Tool & Codebase Compositions

## Prior Work

- builds_on:: [[2026-03-01-GH-0466-idle-notification-spam]]
- builds_on:: [[2026-03-20-GH-0116-ci-feedback-bounded-retry]]
- builds_on:: [[2026-03-25-GH-0224-ci-feedback-loop-post-push]]
- builds_on:: [[2026-03-21-GH-0166-cli-realtime-phase-progress]]
- builds_on:: [[2026-03-30-GH-0276-live-refresh-indicators]]

## Research Question

What is the Monitor tool, how does it work, and where across all compositions in this codebase would it be useful? Focus on API polling, sleeps (which should no longer be used), and log tailing.

## Summary

The **Monitor** tool is a Claude Code tool that starts a background process whose every stdout line becomes a notification in the conversation. It is designed for the **streaming** case — "tell me every time X happens" — as opposed to `Bash(run_in_background=true)` which is for the one-shot "wait until done" case. The codebase contains **three true polling loops** (CI watch, two dev server readiness checks), **one fixed-interval sleep** (ralph-loop.sh inter-iteration gap), **one streaming output filter** (cli-dispatch.sh awk pipeline), and **several single-shot API reads** that are not polling but sometimes described as "re-checks." The MCP server contains two legitimate TypeScript sleep patterns (rate limiter, retry-after) that operate at the wrong abstraction layer for Monitor.

## Detailed Findings

### The Monitor Tool

The Monitor tool has four parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `command` | string (required) | Shell command or script. Each stdout line is an event; exit ends the watch. |
| `description` | string (required) | Short description shown in every notification |
| `persistent` | boolean (default false) | Run for session lifetime (no timeout). Stop with TaskStop. |
| `timeout_ms` | number (default 300000) | Kill after deadline. Max 3600000 (1hr). Ignored when persistent. |

**Key design properties:**
- Each stdout line becomes a notification in the conversation
- Lines within 200ms are batched into a single notification
- Only stdout is the event stream; stderr goes to the output file (readable via Read) but does not trigger notifications
- Auto-killed if producing too many events (restart with tighter filter)
- Use `grep --line-buffered` in pipes to avoid buffering delays
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks
- Handle transient failures (`curl ... || true`) in poll loops

**Distinction from `Bash(run_in_background=true)`:** Monitor is for streaming — continuous events over time. `run_in_background` is for one-shot — start a process, get notified when it exits.

**Example use cases from the tool documentation:**
- `tail -f /var/log/app.log | grep --line-buffered "ERROR"` — log tailing
- `inotifywait -m --format '%e %f' /watched/dir` — file watching
- GitHub API poll loop that emits one line per new PR comment
- Node.js WebSocket listener script

---

### Composition 1: CI Watch Loop (finish skill) — STRONGEST CANDIDATE

**Location:** [`plugin/ralph-hero/skills/finish/SKILL.md:142-162`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/finish/SKILL.md#L142-L162)

**Current pattern:** After a PR merge, polls `gh run list --commit "$MERGE_SHA" --json status,conclusion,name,url --limit 10` every 30 seconds for up to 10 minutes using repeated Bash calls. Exit conditions: all runs succeed, any run fails, or 10-minute timeout.

**How it works today:** The finish skill (also preloaded into `finish-agent` via `agents/finish-agent.md:7`) instructs the agent to execute the `gh run list` command repeatedly, sleeping 30 seconds between invocations, checking JSON fields for terminal conclusions. Each poll cycle consumes a full Bash tool call turn.

**Monitor fit:** This is the textbook Monitor use case — a poll loop that emits events on state change. A Monitor script could:
```bash
last_status=""
while true; do
  current=$(gh run list --commit "$MERGE_SHA" --json status,conclusion,name --limit 10 2>/dev/null || echo "[]")
  summary=$(echo "$current" | jq -r '[.[] | "\(.name): \(.status)/\(.conclusion)"] | join(", ")')
  if [ "$summary" != "$last_status" ]; then
    echo "$summary"
    last_status="$summary"
  fi
  # Check for terminal state
  if echo "$current" | jq -e 'length > 0 and all(.conclusion != null)' >/dev/null 2>&1; then
    if echo "$current" | jq -e 'all(.conclusion == "success")' >/dev/null 2>&1; then
      echo "CI PASSED: all runs succeeded"
    else
      echo "CI FAILED: $(echo "$current" | jq -r '[.[] | select(.conclusion != "success") | "\(.name): \(.conclusion)"] | join(", ")')"
    fi
    exit 0
  fi
  sleep 30
done
```
This would free the agent to continue working while CI runs, receiving notifications only on state transitions rather than burning a tool call every 30 seconds.

---

### Composition 2: Dev Server Readiness Polling (research skills)

**Locations:**
- [`plugin/ralph-hero/skills/ralph-research/SKILL.md:282-285`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/ralph-research/SKILL.md#L282-L285) (autonomous)
- [`plugin/ralph-hero/skills/research/SKILL.md:236`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/research/SKILL.md#L236) (interactive)

**Current pattern:** After `Bash(command, run_in_background=true)` starts a dev server, polls `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>` every 2 seconds with a 30-second timeout. If the server doesn't respond in time, logs a warning and skips the Playwright baseline capture.

**Teardown:** Uses `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set, otherwise kills the background process PID ([`ralph-research/SKILL.md:285,334`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/ralph-research/SKILL.md#L285), [`research/SKILL.md:272`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/research/SKILL.md#L272)).

**Monitor fit:** Moderate. The dev server could be started directly in a Monitor, with the script emitting a "READY" line when curl gets a 200, then exiting. However, this is a short-lived wait (30s max) and the agent needs to block until ready before dispatching the explorer-agent, so the benefit over the current curl-poll approach is marginal. The current `run_in_background` + poll pattern is adequate for this use case.

**Also referenced in plan generation skills:**
- [`plugin/ralph-hero/skills/plan/SKILL.md:199,369`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/plan/SKILL.md#L199) — generates plan tasks for "start dev server" and "tear down dev server"
- [`plugin/ralph-hero/skills/ralph-plan/SKILL.md:386,432`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/ralph-plan/SKILL.md#L386) — same pattern in autonomous plan skill

---

### Composition 3: Streaming Output Filter (cli-dispatch.sh)

**Location:** [`plugin/ralph-hero/scripts/cli-dispatch.sh:117-183`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/scripts/cli-dispatch.sh#L117-L183)

**Current pattern:** The `_output_filter()` awk function in `run_headless()` pipes `claude -p` output through a real-time filter:
- Line 130: `print` passes every line through immediately
- Line 131: `fflush()` prevents pipe buffering (the only `fflush` in the codebase)
- Simultaneously scans for GitHub URLs, file paths matching `thoughts/shared/**`, and state transition arrows
- Accumulates extracted data into a temp file for a post-run summary footer
- Exit code captured via `${PIPESTATUS[0]}` at line 95

**Monitor fit:** Not directly applicable — this is a shell script, not a Claude Code skill, so the Monitor tool can't be used here. However, the pattern is architecturally identical to what Monitor does: streaming stdout with real-time filtering and side-collection. If this headless dispatch ever moves into a skill context, Monitor would be the right primitive.

---

### Composition 4: Outer Orchestration Loop (ralph-loop.sh)

**Location:** [`plugin/ralph-hero/scripts/ralph-loop.sh:108-232`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/scripts/ralph-loop.sh#L108-L232)

**Current pattern:**
- `run_claude()` at line 98 captures full buffered output: `output=$(portable_timeout "$TIMEOUT" claude -p "$command" ... 2>&1)`
- Line 128 checks for early exit: `if echo "$output" | grep -qi "Queue empty"`
- `while [ $iteration -lt $MAX_ITERATIONS ]` loop at line 135, default 10 iterations
- `sleep 5` at line 232 between iterations

**Monitor fit:** Not directly applicable — this is a standalone bash script, not a Claude Code tool context. The `sleep 5` is a fixed inter-iteration gap (not polling), and output is necessarily buffered because the script needs to grep the full output for "Queue empty" as a control flow decision.

---

### Composition 5: PR Review Re-check (ralph-merge skill)

**Location:** [`plugin/ralph-hero/skills/ralph-merge/SKILL.md:87,115,149`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/skills/ralph-merge/SKILL.md#L87)

**Current pattern:** Single-shot reads of `gh pr view NNN --json reviewDecision` — once before dispatching code review, once after it completes. At line 182, a single `gh pr view NNN --json mergeable,reviewDecision,state` gates the merge decision. If not ready, outputs `MERGE NOT READY` and exits — "The integrator will retry when ready" (line 201).

**Monitor fit:** Currently not a polling loop, but if the review dispatch becomes async (e.g., dispatched as a background agent), a Monitor watching for review decision changes on the PR would be useful. Today, the code review skill runs synchronously so the single-shot re-read is sufficient.

---

### Patterns That Are NOT Monitor Candidates

#### Rate Limiter Sleep — `mcp-server/src/lib/rate-limiter.ts:58,86-88`

[`rate-limiter.ts:58`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts#L58): When remaining GitHub API points drop to <= 50, `checkBeforeRequest()` sleeps up to 60 seconds until the hourly rate limit window resets. The private `sleep()` method at line 86 wraps `setTimeout`. This is server-side TypeScript that operates below the Claude Code tool layer — Monitor cannot replace it.

#### Retry-After Sleep — `mcp-server/src/github-client.ts:191`

[`github-client.ts:191`](https://github.com/cdubiel08/ralph-hero/blob/ebfeccf721a3ce4f8628c4e683af753c59e806de/plugin/ralph-hero/mcp-server/src/github-client.ts#L191): Inside `executeGraphQL()`, HTTP 403 responses with a `Retry-After` header trigger a server-directed wait followed by recursive retry. Same as rate limiter — server-side TypeScript, not observable from the skill layer.

#### Debug Logger Test Sleeps — `mcp-server/src/__tests__/debug-logger.test.ts:102,124,170,194,216,252`

Six `setTimeout(r, 100/200)` calls giving fire-and-forget async file writes time to flush before assertions. Test infrastructure — Monitor is not relevant.

#### portable_timeout Fork/Kill — `scripts/cli-dispatch.sh:34-48`, `ralph-loop.sh:36-50`, `ralph-team-loop.sh:29-43`, `justfile:553-565`

Inline Perl one-liner that forks a child, sets `SIGALRM`, and kills on timeout. Process lifetime enforcement, not monitoring.

#### GitHub Actions Workflows — `.github/workflows/*.yml`

`sync-pr-merge.yml`, `advance-parent.yml`, `sync-issue-state.yml`, `sync-project-state.yml`, `ci.yml` — all event-driven (webhook-triggered). They do not poll — they ARE the events. Sequential `gh api graphql` call chains within a single workflow run resolve project item IDs, check convergence, and mutate state, but none loop or sleep.

#### CLI Test Fixture — `scripts/__tests__/cli-dispatch.bats:213`

`sleep 10` as target process for `portable_timeout 1 sleep 10` — verifies the timeout mechanism kills the child. Not an actual wait.

---

## Code References

### Polling loops (Monitor candidates)
- `plugin/ralph-hero/skills/finish/SKILL.md:142-162` — CI watch: `gh run list` every 30s, 10 min max
- `plugin/ralph-hero/skills/ralph-research/SKILL.md:282-285` — Dev server readiness: curl every 2s, 30s max
- `plugin/ralph-hero/skills/research/SKILL.md:236` — Dev server readiness (interactive variant)

### Fixed sleeps
- `plugin/ralph-hero/scripts/ralph-loop.sh:232` — `sleep 5` between orchestration iterations
- `plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts:58,86-88` — `setTimeout` for rate limit reset (server-side)
- `plugin/ralph-hero/mcp-server/src/github-client.ts:191` — `setTimeout` for Retry-After (server-side)
- `plugin/ralph-hero/mcp-server/src/__tests__/debug-logger.test.ts:102,124,170,194,216,252` — test flush waits

### Streaming output
- `plugin/ralph-hero/scripts/cli-dispatch.sh:117-183` — awk `fflush()` real-time filter

### Single-shot API reads (not polling)
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:87,115,149,182` — PR review/merge readiness
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md:93,414` — PR state and review comments

### Background process management
- `plugin/ralph-hero/skills/ralph-research/SKILL.md:282,285,334` — Dev server start/teardown
- `plugin/ralph-hero/skills/research/SKILL.md:236,272` — Dev server start/teardown (interactive)
- `plugin/ralph-hero/scripts/cli-dispatch.sh:34-48` — portable_timeout fork/kill
- `plugin/ralph-hero/scripts/ralph-loop.sh:36-50` — portable_timeout fork/kill

## Architecture Documentation

### Categorization of All Sleep/Poll/Watch Patterns

| Category | Pattern | Location Type | Monitor Candidate? |
|----------|---------|---------------|-------------------|
| **Timed polling loop** | CI run status every 30s | Skill (finish) | **Yes — strongest** |
| **Timed polling loop** | Dev server curl every 2s | Skill (research x2) | Moderate — short-lived |
| **Fixed inter-iteration gap** | `sleep 5` between loop passes | Script (ralph-loop.sh) | No — bash script, not skill |
| **Server-side rate limit** | `setTimeout` up to 60s | MCP server (rate-limiter.ts) | No — wrong abstraction layer |
| **Server-side retry** | `setTimeout` per Retry-After | MCP server (github-client.ts) | No — wrong abstraction layer |
| **Test flush delay** | `setTimeout` 100-200ms | Test (debug-logger.test.ts) | No — test infrastructure |
| **Streaming filter** | awk + fflush() passthrough | Script (cli-dispatch.sh) | No — bash script, but architecturally similar |
| **Single-shot reads** | `gh pr view` before/after | Skill (ralph-merge, ralph-impl) | No — not polling |
| **Event-driven workflows** | Webhook-triggered GQL chains | GitHub Actions | No — already event-driven |

### Key Observation: Agent Context vs Script Context

The Monitor tool is only usable within Claude Code conversations (skills and agents), not in standalone bash scripts. This means:
- **`finish/SKILL.md` CI watch** — directly replaceable with Monitor
- **`research/SKILL.md` dev server poll** — replaceable with Monitor but marginal benefit
- **`cli-dispatch.sh` streaming** — architecturally similar but operates outside Claude Code
- **`ralph-loop.sh` sleep** — outside Claude Code, cannot use Monitor

## Historical Context (from thoughts/)

33+ documents in `thoughts/` touch on related patterns:

**CI feedback and polling:**
- `2026-03-20-GH-0116-ci-feedback-bounded-retry.md` — CI feedback with bounded retry polling patterns
- `2026-03-25-GH-0224-ci-feedback-loop-post-push.md` — CI feedback loop post-push with polling mechanisms

**Real-time streaming architecture:**
- `2026-03-24-GH-0202-cli-stream-to-output-formatter.md` — Wiring stream chunks to OutputFormatter
- `2026-03-21-GH-0166-cli-realtime-phase-progress.md` — Real-time progress output during phase execution
- `2026-03-23-engine-observability-gap.md` — Connecting governance events to real-time output

**Idle notification management (directly relevant to Monitor's auto-kill):**
- `2026-03-01-GH-0466-idle-notification-spam.md` — Central concern about background task polling causing excessive notifications. Monitor's auto-kill on excessive events and stdout-only event stream (stderr to file) provide built-in guardrails.

**Live refresh and indicators:**
- `2026-03-30-GH-0276-live-refresh-indicators.md` — Per-second elapsed ticking and polling hooks

**Background worker coordination:**
- `2026-02-17-GH-0052-taskupdate-self-notification.md` — TaskUpdate self-notification in background agents
- `2026-02-20-GH-0200-task-self-assignment-race-condition.md` — Task assignment race conditions

## Related Research

- [[2026-03-01-GH-0466-idle-notification-spam]] — Idle notification spam in team sessions
- [[2026-03-20-GH-0116-ci-feedback-bounded-retry]] — CI feedback bounded retry patterns
- [[2026-03-25-GH-0224-ci-feedback-loop-post-push]] — CI feedback loop post-push
- [[2026-03-21-GH-0166-cli-realtime-phase-progress]] — Real-time phase progress output
- [[2026-03-30-GH-0276-live-refresh-indicators]] — Live refresh indicators

## Open Questions

1. **ScheduleWakeup interaction**: The `ScheduleWakeup` tool (for `/loop` dynamic pacing) has a 5-minute prompt cache TTL consideration. How does Monitor interact with the prompt cache? Does a Monitor notification count as activity that keeps the cache warm?
2. **Monitor + Agent isolation**: Can a sub-agent (e.g., `finish-agent`) start a Monitor that sends notifications to the parent orchestrator? Or is Monitor scoped to the conversation that created it?
3. **Event volume tuning for CI watch**: The CI watch emits at most 20 events (10 min / 30s), well within Monitor's tolerance. But if multiple CI workflows trigger simultaneously (e.g., matrix builds), the per-transition output could spike.
4. **Dev server + Monitor teardown**: If a Monitor is used for dev server readiness, the dev server process would need to be started separately (Monitor runs its own command). The teardown pattern would need adjustment since Monitor manages its own process lifecycle.
