## Outcome Recorder

After every terminal-state transition, call `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome`
to persist the outcome event to the ralph-knowledge ledger. This is **best-effort** — failure must NOT block the
surrounding state transition.

### Canonical call shape

```
mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome(
  event_type   = <see table below>,
  issue_number = <GitHub issue number>,
  verdict      = <outcome token — see table below>,
  payload      = <see table below>,
  session_id?  = <team/hero session identifier if available>,
)
```

### Event vocabulary and payload schema

| Event type            | Emitted by       | Verdict token                              | Required payload fields                                        |
|-----------------------|------------------|--------------------------------------------|----------------------------------------------------------------|
| `merge_completed`     | ralph-merge      | `"merged"`                                 | `{ pr_url, commit_sha, repo }`                                 |
| `pr_created`          | ralph-pr         | `"created"`                                | `{ pr_url, branch, repo }`                                     |
| `validation_passed`   | ralph-val        | `"VALIDATION PASS"`                        | `{ total_checks, failed_checks, substantive_failures }`        |
| `validation_failed`   | ralph-val        | `"VALIDATION FIX"` or `"VALIDATION FAIL"` | `{ total_checks, failed_checks, substantive_failures }`        |
| `postmortem_completed`| ralph-postmortem | `"filed"`                                  | `{ postmortem_path, blocker_count, impediment_count }`         |
| `blocker_recorded`    | ralph-postmortem | `"blocker"`                                | `{ blocker_type, description, created_issue_number }`          |
| `impediment_recorded` | ralph-postmortem | `"impediment"`                             | `{ impediment_type, description, self_resolved, workaround }`  |
| `session_completed`   | ralph-postmortem | `"completed"`                              | `{ issues_processed, issues_completed, workers, total_tokens }`|

### Best-effort error handling

If the MCP call fails (tool unavailable, DB unreachable, schema error), log to stderr and continue:

```
echo "outcome-record failed: <error message>" >&2
```

Do NOT block the surrounding state transition. The Done / In Review / Plan-Done /
VALIDATION-PASS transitions must succeed even when the outcome DB is unreachable.
