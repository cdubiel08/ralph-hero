---
description: Post-merge propagation for PRs merged outside ralph-merge (GitHub UI, gh pr merge, Dependabot, teammate). Resolves PR → issue, applies idempotency guard, fires PushNotification, and records a merge_completed outcome event. Invoked by the ralph-hero-pr-merged cloud Routine; also user-invocable locally.
argument-hint: "--pr <PR-NUMBER>"
user-invocable: true
model: haiku
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=pr-merged"
allowed-tools:
  - Read
  - Bash
  - PushNotification
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

# Ralph PR-Merged

Post-merge propagation for PRs merged outside `ralph-merge`. Fires `PushNotification` and records `merge_completed` for every merged PR so observability surfaces remain complete regardless of merge path.

## Step 1: Parse arguments and idempotency check

Parse `$ARGUMENTS` for `--pr <N>`. If `--pr` is missing or `<N>` is not a positive integer, emit:

```
needs input: --pr <PR-NUMBER> is required.
```

and STOP.

Check the idempotency label:

```bash
gh pr view <N> --json labels --jq '.labels[].name' | grep -q "^pr-merged-handled$" && echo "ALREADY_HANDLED"
```

If `ALREADY_HANDLED` is printed, emit:

```
result: PR #<N> already handled. Skipping.
```

and STOP.

## Step 2: Fetch the PR

```bash
gh pr view <N> --json number,url,title,headRefName,body,state,mergedAt,mergeCommit,closingIssuesReferences
```

If `gh pr view` exits non-zero (PR does not exist, repo access denied, etc.), emit:

```
result: PR #<N> not accessible. Skipping.
```

and STOP.

If `state != MERGED`, emit:

```
result: PR #<N> is not merged (state: <state>). Skipping.
```

and STOP.

Store the parsed JSON as `PR_JSON` for the remaining steps.

## Step 3: Resolve linked issue

Try the following in order. First match sets `ISSUE_NUMBER`. If nothing matches, set `ISSUE_NUMBER=0`.

1. `closingIssuesReferences[0].number` — GitHub's built-in closing-reference detection
2. Regex `feature/GH-(\d+)` against `headRefName`
3. Regex `(?:closes|fixes|resolves)\s+#(\d+)` (case-insensitive) against `body`

```bash
# Python 3 — portable macOS + Linux
ISSUE_NUMBER=$(python3 -c "
import json, re, sys
pr = json.load(sys.stdin)
refs = pr.get('closingIssuesReferences', [])
if refs:
    print(refs[0]['number']); sys.exit()
m = re.search(r'feature/GH-(\d+)', pr.get('headRefName', ''))
if m:
    print(m.group(1)); sys.exit()
m = re.search(r'(?:closes|fixes|resolves)\s+#(\d+)', pr.get('body', ''), re.I)
if m:
    print(m.group(1)); sys.exit()
print(0)
" <<< "$PR_JSON")
```

## Step 4: Idempotency guard (Done-within-60s window)

If `ISSUE_NUMBER > 0`, fetch the issue:

```
ralph_hero__get_issue(number=ISSUE_NUMBER)
```

If `workflowState == "Done"` AND `closedAt` is within the last 60 seconds (compare to current UTC time), set `SKIP_TRANSITION=true`. The 60-second window covers the case where `ralph-merge` already ran the Done-transition. Otherwise set `SKIP_TRANSITION=false`.

```bash
# Portable date comparison — macOS + Linux
SKIP_TRANSITION=$(python3 -c "
from datetime import datetime, timezone
import sys
closed_at = '$CLOSED_AT'
if not closed_at or closed_at == 'null':
    print('false'); sys.exit()
dt = datetime.fromisoformat(closed_at.replace('Z', '+00:00'))
delta = (datetime.now(timezone.utc) - dt).total_seconds()
print('true' if delta < 60 else 'false')
")
```

If `ISSUE_NUMBER == 0`, set `SKIP_TRANSITION=true` (no issue to transition).

## Step 5: Done transition (gated)

If `ISSUE_NUMBER > 0` AND `SKIP_TRANSITION=false`:

```
ralph_hero__save_issue(number=ISSUE_NUMBER, workflowState="__COMPLETE__", command="ralph_merge")
```

If `SKIP_TRANSITION=true` AND `ISSUE_NUMBER > 0`, emit to stderr:

```
Skip save_issue: ralph-merge already transitioned #<ISSUE_NUMBER> within 60s window
```

## Step 6: PushNotification (best-effort, unconditional)

Fire the native push notification regardless of `SKIP_TRANSITION` or `ISSUE_NUMBER`:

```
PushNotification(
  title="Merged #<ISSUE_NUMBER>",      # When ISSUE_NUMBER > 0
  body="<PR_JSON.title> (<PR_JSON.url>)"
)
```

When `ISSUE_NUMBER == 0`, use `Merged PR #<N>` as the title instead.

Failure does NOT fail the skill. The call is best-effort — `PushNotification` no-ops gracefully when Remote Control is unpaired or routed through Bedrock/Vertex.

## Step 7: Record outcome (unconditional)

```
mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome({
  event_type: "merge_completed",
  issue_number: ISSUE_NUMBER,
  verdict: "merged",
  payload: {
    pr_url: <PR_JSON.url>,
    commit_sha: <PR_JSON.mergeCommit.oid or null>,
    repo: <RALPH_GH_REPO>,
    skip_transition: SKIP_TRANSITION,
    source: "ralph-pr-merged"
  }
})
```

This step fires on every path including the idempotent-skip path. Double-writes on the `merge_completed` event type are correctness-safe (the table is append-only) and the dream-loop `reflect.py` uses them as signal, not unique-count. If the MCP call fails, log to stderr and continue.

## Step 8: Apply idempotency label (best-effort)

```bash
gh pr edit <N> --add-label pr-merged-handled || true
```

Failure does NOT fail the skill.

## Step 9: Emit result marker

```
result: Processed PR #<N> (issue: #<ISSUE_NUMBER>, skip_transition: <SKIP_TRANSITION>)
```

## Constraints

- **Idempotency contract**: The `pr-merged-handled` label (Step 1) is the primary guard — re-fires on the same PR exit immediately without side-effects. The 60s `closedAt` window (Step 4) guards the race between this Routine and `ralph-merge` running concurrently.
- **Unconditional outcome recording**: `knowledge_record_outcome` fires on every path, including the `SKIP_TRANSITION=true` path. The `source: "ralph-pr-merged"` payload field lets callers distinguish Routine-sourced events from `ralph-merge`-sourced events.
- **`issue_number=0` sentinel**: When a PR has no linked issue (Dependabot bumps, docs-only PRs, etc.), `ISSUE_NUMBER` is set to `0` and `save_issue` is skipped. The outcome event still records `issue_number=0`; the `outcome_events` schema accepts `INTEGER NOT NULL` and `0` is the canonical sentinel.
- **Best-effort surfaces**: `PushNotification` and the idempotency label are wrapped with `|| true` or equivalent so failures never block the skill.
- **No `outcome-collector.sh` hook**: This skill calls `knowledge_record_outcome` directly via MCP. The `outcome-collector.sh` hook fires only on `ralph_hero__save_issue` with specific command/workflowState pairs — no hook update required.

## See also

- Research: [`thoughts/shared/research/2026-05-22-GH-1301-pr-merged-routine-design.md`](../../../../thoughts/shared/research/2026-05-22-GH-1301-pr-merged-routine-design.md)
- `ralph-merge` Step 7.5 and Step 9c — the surfaces this skill mirrors for non-ralph-merge paths
- Cloud Routine configuration: `plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh`
- Routine catalog: `plugin/ralph-hero/docs/routines.md`
- Sibling pattern (live proof-of-concept): `plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md`
