# Watch Mode Dispatch

> Consulted by `/ralph:hero --mode watch`. Defines the dispatch table for routing watcher events to gcp-incident-triage / debug-collate / log-reader / sre-fixit, the evidence preconditions, and the heartbeat fan-out shape.

## Evidence preconditions

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
| Issue body contains a `langfuse-trace:` URL | `Agent(subagent_type="ralph:log-reader", prompt="Investigate the trace linked on issue #NNN: <title>. <body>")` |
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
4. Emit:
   ```
   result: heartbeat: N alerts dispatched
   ```

The heartbeat loop is bounded — it processes only the issues returned by the initial `list_issues` call. New issues that arrive during the run are picked up on the next heartbeat invocation.

## Terminal handlers

After each sub-skill or subagent dispatch completes, emit a terminal result line:

**On success (sub-skill/agent returned a result):**

```
result: #NNN dispatched to <sub-skill> — outcome: <summary>
```

**On escalation (no dispatch row matched or sre-fixit pre-check failed):**

```
result: #NNN escalated to Human Needed — no matching dispatch condition
```

**On refusal (no trace ID or LQL snippet):**

```
result: #NNN blocked — no trace ID or LQL snippet present
```
