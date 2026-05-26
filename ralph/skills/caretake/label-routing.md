# Label routing for `/ralph:caretake`

The default-mode dispatcher reads this table when invoked as `/ralph:caretake --issue NNN`. After fetching the issue and inspecting its labels, it picks the **first matching row in declaration order** and invokes the listed `Skill()`. After the dispatch returns, the dispatcher consumes the `trigger:caretake` label (when present) and posts a `## Caretaker Action` comment summarizing what ran.

## Routing table

The dispatcher walks this table top-to-bottom and stops at the first matching label. Labels are checked in priority order — `trigger:caretake` always wins because it represents an explicit operator intent ("run the full fan-out on this issue").

| Label present | Dispatch | Notes |
|---|---|---|
| `trigger:caretake` | Full fan-out (all 8 modes serially) | Operator override; consume after dispatch |
| `stale` | `Skill("ralph:caretake", args="--mode hygiene")` | Hygiene mode finds stale items by definition |
| `status-update-needed` | `Skill("ralph:catch-up", args="--mode report")` | Report lives in catch-up (Plan 1), not caretake |
| `trends-check` | `Skill("ralph:caretake", args="--mode trends")` | Read-only — markdown to stdout |
| `needs-triage` | `Skill("ralph:caretake", args="--mode triage #NNN")` | Pass through the issue number |
| `human-needed` | `Skill("ralph:caretake", args="--mode unblock --question #NNN")` | Autonomous request — posts `## Unblock Request` |
| `process-improvement` | `Skill("ralph:caretake", args="--mode retro")` | Manual retro flow scoped to the issue |
| `debug-auto` | `Skill("ralph:caretake", args="--mode debug")` | Triggered by recurring-failure clustering |
| `needs-split` | `Skill("ralph:caretake", args="--mode split #NNN")` | M/L/XL parent ready for decomposition |
| (none / default) | `Skill("ralph:caretake", args="--mode triage #NNN")` | Untriaged issue with no explicit label hint |

## Full fan-out (`trigger:caretake`)

When `trigger:caretake` is present, the dispatcher invokes **all eight modes serially** so the operator gets a complete board sweep from one command. Order matters — modes that mutate state run before modes that read state:

1. `Skill("ralph:caretake", args="--mode hygiene")` — archive candidates, WIP violations, field gaps
2. `Skill("ralph:caretake", args="--mode triage #NNN")` — assess the issue that carries the trigger label
3. `Skill("ralph:caretake", args="--mode split #NNN")` — only if the triage outcome was `TRIAGED needs-split`
4. `Skill("ralph:caretake", args="--mode unblock --question")` — pick the oldest Human Needed and post a fresh `## Unblock Request` (autonomous path)
5. `Skill("ralph:caretake", args="--mode debug")` — collate Langfuse errors (if `RALPH_DEBUG=true`)
6. `Skill("ralph:caretake", args="--mode postmortem")` — only if a team session just finished (`TaskList` non-empty)
7. `Skill("ralph:caretake", args="--mode retro")` — only if inline conversation context is available
8. `Skill("ralph:catch-up", args="--mode report")` — final status update so the operator sees the consolidated outcome

Skip modes that no-op cleanly (e.g., `postmortem` with no `TaskList` data); always run hygiene + triage + report.

## Label consumption

After dispatch (single-label or full fan-out), the dispatcher MUST remove the routing label so the issue is not re-picked on the next caretaker sweep. Use `save_issue` with the remaining label set:

```
save_issue(
  number: NNN,
  labels: [...remaining-labels-without-trigger:caretake]
)
```

Idempotency rule: only `trigger:caretake` is consumed unconditionally. Other labels (`stale`, `debug-auto`, `process-improvement`, `needs-split`) describe issue **state** and are owned by other systems (hygiene scans, dream-reflect clustering, triage). The caretaker does not consume those — it acts on them and lets the owner system re-apply or clear them.

## `## Caretaker Action` comment shape

After dispatch (success or failure), post one comment on the issue:

```
## Caretaker Action

Mode: <mode-or-fanout>
Trigger: <label-name or "default">
Dispatched: <comma-separated skill names>
Outcome: <one-line summary pulled from the terminal token of the last skill>
```

Pull the outcome line from the dispatched skill's terminal token (see [outcome-tokens.md](outcome-tokens.md)) — do not paraphrase. For full fan-out, list one outcome line per child skill.

## Adding a new label route

The taxonomy is intentionally one-row-per-label so future automation can extend it without touching SKILL.md. To add a label:

1. Append a new row to the routing table above (in priority order — earlier rows win).
2. If the dispatch is a new mode body, scaffold the mode under `modes/<name>.md` and add a row to the mode-dispatch table in SKILL.md.
3. If the label is operator-driven (e.g., a future `trigger:<team>`), make sure it gets consumed in the "Label consumption" rule.

No code change required for routing additions — the dispatcher reads this table as prose and the SKILL.md frontmatter only declares the union of hook scopes.

## Cross-references

- [SKILL.md](SKILL.md) — top-level dispatch, arg parsing, heartbeat fan-out.
- [outcome-tokens.md](outcome-tokens.md) — terminal-verdict strings each mode emits.
- Event-class taxonomy at [`ralph/skills/hero/event-classes.md`](../hero/event-classes.md) — same trigger-label conventions; keep both in sync.
