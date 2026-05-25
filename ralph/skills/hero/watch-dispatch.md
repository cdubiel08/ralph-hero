# Watch Mode Dispatch

> Consulted by `/ralph:hero --mode watch`. Defines the dispatch table for routing watcher events to gcp-incident-triage / debug-collate / log-reader / sre-fixit, the SOUL refusal preconditions, and the heartbeat fan-out shape.

## SOUL refusal preconditions

Before dispatching any sub-skill or subagent, verify the issue body contains at least one of:

- A trace ID matching `projects/[^/]+/traces/[a-f0-9]+`
- A literal `gcloud logging read ...` snippet
- A `<!-- gcp-policy: ... -->` marker (which implies an upstream alert source that gcp-incident-triage will query)

If none present, post a `needs input:` comment and escalate to Human Needed:

```
needs input: issue #NNN has no trace ID and no LQL snippet. Provide a trace ID (projects/<proj>/traces/<id>) or a gcloud logging read query before /ralph:hero --mode watch can proceed.
```

## Dispatch table

Inspect the fetched issue and route to the first matching row:

| Condition | Action |
|-----------|--------|
| Issue body contains `<!-- gcp-policy: ... -->` marker | `Skill("gcp-incident-triage", "--issue NNN")` |
| Issue body contains a `langfuse-trace:` URL | `Skill("ralph:caretake", "--mode debug --issue NNN")` |
| Issue has label `watcher-investigate` | `Agent(subagent_type="ralph:log-reader", prompt="Investigate issue #NNN: <title>. <body>")` |
| Issue has label `watcher-remediate` AND proposed action matches the sre-fixit allowlist | `Agent(subagent_type="ralph:sre-fixit", prompt="Remediate issue #NNN: <title>. <body>")` |
| No row matches | Escalate to `Human Needed` with a `needs input:` comment explaining which marker or label is missing |

Dispatch rows must not overlap. A single issue should match at most one row. Priority is top-to-bottom: gcp-policy wins over langfuse-trace wins over labels.

## sre-fixit pre-check

Before dispatching `sre-fixit`, confirm the requested kubectl action from the issue body matches one of:

- `kubectl scale deployment <name> --replicas=<N>`
- `kubectl drain node <name>`
- `kubectl rollout restart deployment/<name>`
- `kubectl delete pod <name>`

If the requested action is not in the list, do NOT dispatch sre-fixit. Escalate directly to Human Needed.

## Heartbeat mode (no --issue arg)

1. Call `list_issues({ labels: ["watcher-auto", "watcher-investigate", "watcher-remediate"], workflowState: "Backlog" })`.
2. If empty, emit `result: heartbeat: 0 alerts dispatched` and stop.
3. For each issue, dispatch per the table above (sequential — avoids race conditions on shared board state).
4. **Langfuse error collation:**
   - Preflight: check `RALPH_DEBUG=true`. If unset, log `debug-collate skipped: RALPH_DEBUG unset` and continue to step 5 without failing the heartbeat.
   - If `RALPH_DEBUG=true`, invoke: `Skill("ralph:caretake", "--mode debug --auto-confirm --since 24h --min-occurrences 3")`. Capture the count of filed issues from the result line.
5. Emit:
   ```
   result: heartbeat: N alerts dispatched, M debug-collate issues filed
   ```

The heartbeat loop is bounded — it processes only the issues returned by the initial `list_issues` call. New issues that arrive during the run are picked up on the next heartbeat invocation.

## Terminal handlers

After each sub-skill or subagent dispatch completes, emit a terminal result line + outcome-recorder stub:

**On success (sub-skill/agent returned a result):**

```
result: #NNN dispatched to <sub-skill> — outcome: <summary>
# outcome-recorder(decision=watch-dispatched, result=<outcome>, trace_id=<id-if-known>)
```

**On escalation (no dispatch row matched or sre-fixit pre-check failed):**

```
result: #NNN escalated to Human Needed — no matching dispatch condition
# outcome-recorder(decision=watch-escalated, result=human-needed, trace_id=<id-if-known>)
```

**On SOUL refusal (no trace ID or LQL snippet):**

```
result: #NNN blocked — SOUL refusal: no trace ID or LQL snippet present
# outcome-recorder(decision=watch-refused, result=missing-evidence, trace_id=none)
```
