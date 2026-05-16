---
description: Watcher team orchestrator. Dispatches gcp-incident-triage, ralph-debug-collate, log-reader, and sre-fixit based on issue markers. Accepts --issue NNN (direct) or no arg (heartbeat every RALPH_WATCH_HEARTBEAT_MIN minutes). Reads team SOUL via SessionStart hook.
argument-hint: "[--issue NNN]"
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=watch RALPH_REQUIRED_BRANCH=main"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh"
allowed-tools:
  - Skill
  - Agent
  - Bash
  - Read
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Heartbeat cadence (minutes): !`echo ${RALPH_WATCH_HEARTBEAT_MIN:-15}`

# Ralph Watch — Watcher Team Orchestrator

Single entrypoint for the Watcher team. Wraps `gcp-incident-triage`, `ralph-debug-collate`, `log-reader`, and `sre-fixit` behind one skill. Director (Feature B, GH-1269) dispatches this skill via `Skill("ralph-hero:watch", args="<issue-number>")` using a bare issue number. The canonical invocation form from Director is a bare number (e.g. `"42"`); `--issue NNN` is also accepted for direct human use. Both forms are equivalent.

<!-- internal: Shared Constraint 6 — Director, not Watch, consumes `trigger:watch` labels and decides when to dispatch. Watch only accepts --issue NNN (direct) or no arg (heartbeat). Watch never reads trigger: labels itself. -->

<!-- internal: Shared Constraint 7 — On every terminal state, Watch must call outcome-recorder. Feature E (GH-1272) builds the actual wrapper. Until then, every terminal handler contains a TODO(GH-1272) stub that Feature E follows when wiring. The stub comment is non-optional. -->

## Argument parsing

Parse `$ARGUMENTS` on entry:

```
if [[ "$ARGUMENTS" =~ ^--issue[[:space:]]+([0-9]+)$ ]]; then
  WATCH_ISSUE_NUMBER="${BASH_REMATCH[1]}"
  WATCH_MODE=direct
elif [[ "$ARGUMENTS" =~ ^([0-9]+)$ ]]; then
  # Bare number — canonical Director dispatch form
  WATCH_ISSUE_NUMBER="${BASH_REMATCH[1]}"
  WATCH_MODE=direct
elif [[ -z "$ARGUMENTS" ]]; then
  WATCH_MODE=heartbeat
else
  echo "needs input: unrecognised argument '${ARGUMENTS}'. Expected --issue NNN, a bare issue number, or no argument for heartbeat mode."
  exit 1
fi
```

**Direct mode** (`--issue NNN` or bare number): fetch the single issue and dispatch per the table below.

**Heartbeat mode** (no arg): query the board for all open `watcher-auto`, `watcher-investigate`, and `watcher-remediate` labelled issues in Backlog, then dispatch per the table for each. Stop when the queue is empty.

## SOUL refusal enforcement

The SOUL (loaded via `load-team-soul.sh`) refuses claims without a trace ID and claims without a literal LQL/log-query snippet. Enforce this at the orchestrator level too: before dispatching any sub-skill or subagent, verify the issue body contains at least one of:
- A trace ID matching `projects/[^/]+/traces/[a-f0-9]+`
- A literal `gcloud logging read ...` snippet

If neither is present AND the issue does not carry a `<!-- gcp-policy: ... -->` marker (which implies an upstream alert source that gcp-incident-triage will query), post a `needs input:` comment and escalate to Human Needed:

```
needs input: issue #NNN has no trace ID and no LQL snippet. Provide a trace ID (projects/<proj>/traces/<id>) or a gcloud logging read query before Watch can proceed.
```

## Dispatch table

Inspect the fetched issue and route to the first matching row:

| Condition | Action |
|-----------|--------|
| Issue body contains `<!-- gcp-policy: ... -->` marker | `Skill("gcp-incident-triage", "--issue NNN")` |
| Issue body contains a `langfuse-trace:` URL | `Skill("ralph-hero:ralph-debug-collate", "--issue NNN")` |
| Issue has label `watcher-investigate` | `Agent(subagent_type="ralph-hero:log-reader", prompt="Investigate issue #NNN: <issue title>. <issue body>")` |
| Issue has label `watcher-remediate` AND proposed action matches the sre-fixit allowlist | `Agent(subagent_type="ralph-hero:sre-fixit", prompt="Remediate issue #NNN: <issue title>. <issue body>")` |
| No row matches | Escalate to `Human Needed` with a `needs input:` comment explaining which marker or label is missing |

<!-- internal: Dispatch rows must not overlap. A single issue should match at most one row. Priority is top-to-bottom: gcp-policy wins over langfuse-trace wins over labels. If an issue has both a gcp-policy marker and a watcher-investigate label, gcp-incident-triage is dispatched (first match wins). -->

### sre-fixit pre-check

Before dispatching `sre-fixit`, confirm the requested kubectl action from the issue body matches one of the four allowlisted shapes:
- `kubectl scale deployment <name> --replicas=<N>`
- `kubectl drain node <name>`
- `kubectl rollout restart deployment/<name>`
- `kubectl delete pod <name>`

If the requested action is not in the list, do NOT dispatch sre-fixit. Escalate directly to Human Needed.

## Heartbeat mode

When invoked with no argument:

1. Call `list_issues({labels: ["watcher-auto", "watcher-investigate", "watcher-remediate"], workflowState: "Backlog"})`.
2. If the result is empty, emit `result: queue empty` and stop.
3. For each issue in the result, dispatch per the dispatch table above (sequential — one issue at a time to avoid race conditions on shared board state).
4. After all issues are processed, emit `result: heartbeat complete — N issues dispatched`.

The heartbeat loop is bounded: it processes only the issues returned by the initial `list_issues` call. It does not re-query mid-loop. New issues that arrive during the run are picked up on the next heartbeat invocation.

## Terminal handlers

After each sub-skill or subagent dispatch completes, emit a terminal result line and stub the outcome-recorder call:

**On success (sub-skill/agent returned a result):**
```
result: #NNN dispatched to <sub-skill> — outcome: <outcome-summary>
# TODO(GH-1272): wire outcome-recorder(decision=watch-dispatched, result=<outcome>, trace_id=<trace-id-if-known>)
```

**On escalation (no dispatch row matched or sre-fixit pre-check failed):**
```
result: #NNN escalated to Human Needed — no matching dispatch condition
# TODO(GH-1272): wire outcome-recorder(decision=watch-escalated, result=human-needed, trace_id=<trace-id-if-known>)
```

**On SOUL refusal (no trace ID or LQL snippet):**
```
result: #NNN blocked — SOUL refusal: no trace ID or LQL snippet present
# TODO(GH-1272): wire outcome-recorder(decision=watch-refused, result=missing-evidence, trace_id=none)
```

## Shared constraints (referenced)

- **Constraint 6**: Director consumes `trigger:watch` labels and dispatches Watch. Watch never reads `trigger:` labels directly.
- **Constraint 7** (GH-1272): All terminal handlers stub `outcome-recorder` with a `# TODO(GH-1272)` comment. Feature E wires the actual call.
