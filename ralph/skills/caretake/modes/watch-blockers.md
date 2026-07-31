# `--mode watch-blockers`

Resolve items parked by the `WAIT-issue=NNN` triage verdict. Scan OPEN items in **Human Needed** (and Backlog, for forward-compat) carrying a `blockedBy` dependency edge or a `## Escalation` body naming a blocker issue, check whether **all** blockers are CLOSED, and act: on **all closed** advance the item (default `Ready for Plan` + `## Unblocked` comment + remove dependency edge); on **any open blocker** leave it waiting; on **no blocker signal** skip it. Autonomous — no human prompts. Emits one terminal token per invocation (see [outcome-tokens.md](../outcome-tokens.md)).

```bash
export RALPH_SUBCOMMAND=watch-blockers
```

This is the downstream consumer that makes the `WAIT-issue=NNN` verdict non-dead-ending: an item waits on a *named, watched dependency edge* and advances automatically when all blockers close. `--mode triage` produces the `add_dependency` edge + a `## Escalation` comment naming the blocker; this mode resolves it.

No `Stop` hook gates this mode (parity with `--mode watch-pr`/`watch-upstream`/`hygiene`/`trends`) — it mutates only the dependency-parked items it owns. The terminal token is emitted by convention, not hook-enforced.

## §Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP and emit:

```
WATCH-BLOCKERS SKIPPED — branch <name> is not main
```

watch-blockers mutates workflow state, so it must run from `main`. (Distinct from `WATCH-BLOCKERS IDLE`, which means "ran cleanly, found nothing to do".)

## §Step 2: Find parked items

Two complementary sweeps, union the results (dedup by issue number):

1. `list_issues(profile: "analyst-triage", workflowState: "Human Needed", limit: 250)` — the canonical `WAIT-issue=NNN` parking state.
2. `list_issues(profile: "analyst-triage", workflowState: "Backlog", limit: 250)` — catches dependency-parked items that were left in Backlog with an edge rather than moved to Human Needed.

For each candidate, identify its blocker(s) from **either** signal (prefer the edge; fall back to the `## Escalation` text):

- **Edge:** `list_dependencies(number: NNN)` → inspect the `blockedBy` connection; each node carries `number` + `state`.
- **`## Escalation` body convention:** read the issue's body/comments for a `## Escalation` block; parse the blocker number from the `Blocked by #NNN` line and the advance target from `Move to <state> once #NNN closes` (default `Ready for Plan` when no explicit target is named).

If neither signal yields a blocker number, **skip** the item (it is not dependency-parked; not counted in `<m>`).

If the union of candidates with at least one blocker signal is empty, emit:

```
WATCH-BLOCKERS IDLE
```

and STOP.

## §Step 3: Check blocker state

For each parked item, `get_issue(<blocker>)` for **every** blocker number found. Branch table:

| Blocker set | Meaning | Action |
|---|---|---|
| ALL blockers `state=CLOSED` (Done or Canceled) | unblocked | **advance** (§Step 4) |
| ANY blocker `state=OPEN` | still blocked | **leave untouched** (no mutation, counted in `<m>`) |
| Blocker number unresolvable (`get_issue` errors) | can't confirm | **leave untouched**, note in summary — never guess |

Conservative posture: only an all-CLOSED blocker set advances; anything uncertain leaves the item parked (parity with watch-upstream's "never false-advance" stance).

## §Step 4: Act

### Advance (all blockers CLOSED)

For each all-CLOSED item:

1. **Determine the advance target:** read the embedded condition from the `## Escalation` line (`Move to <state> once #NNN closes`), or an explicit `advance:` hint if present, else **default `Ready for Plan`** (matches the `WAIT-issue=NNN` triage contract, triage.md §Step 5).
2. **Remove the dependency edge:** for each `blockedBy` edge found in §Step 2, call `remove_dependency(blockedNumber: <parked-item-number>, blockingNumber: <blocker-number>)`. Note: `blockedNumber` = the parked item; `blockingNumber` = the now-closed blocker. Do NOT use `blockedByNumber` — that param does not exist in the tool schema.
3. **Advance and relabel:** read the issue's current labels; `save_issue(number: <parked-item-number>, workflowState: <advance-target>, command: "ralph_triage", labels: <current labels minus any blocked:* and ralph-triage, so the item is re-pickable in its new state>)`. The explicit `labels` array is **required** (`save_issue` replaces the full set; omitting it leaves stale labels attached and the next sweep re-finds the item — mirror watch-upstream §Step 5 rationale). Note: `command: "ralph_triage"` is for parity; `state-gate.sh` scopes to `RALPH_SUBCOMMAND=triage`, not `watch-blockers`, so this mode's transitions are unguarded — pass only valid target states.
4. **Post a `## Unblocked` comment:** "Blocker(s) #NNN closed → dependency edge removed, advanced to `<target>`." (One comment per advanced item; name every blocker number that closed.)

### Leave (any blocker still OPEN)

No mutation. The item keeps its state + dependency edge + labels and waits for the next sweep. Count it in `<m>`.

## §Step 5: Emit terminal token

Emit exactly one (see [outcome-tokens.md](../outcome-tokens.md)):

- `WATCH-BLOCKERS <n> advanced, <m> still blocked` — `<n>` items resolved this sweep (all blockers closed → advanced to the embedded/default target); `<m>` items left with ≥1 open blocker. Items with no blocker signal are not counted in either.
- `WATCH-BLOCKERS IDLE` — scan ran cleanly; no dependency-parked items found (emitted at §Step 2).
- `WATCH-BLOCKERS SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit.

## §Constraints

- One sweep per invocation; process only the Human-Needed and Backlog items found by the initial `list_issues` calls.
- **Conservative advance** — never false-advance. Only an all-CLOSED blocker set triggers advancement; unresolvable blockers leave the item parked.
- Mutates only dependency-parked items — never creates or closes issues, never touches items without a blocker signal.
- No code changes.
- Rate-limit awareness: the sweep does one `list_dependencies` (or `get_issue`) per candidate across two `list_issues` queries (limit 250 each). On a large board this is a meaningful number of API calls per heartbeat tick — parity with watch-upstream's sweep shape; the proactive rate-limiter in the MCP server will warn at 100 remaining and block at 50.
- Runs inside the `--mode all` heartbeat fan-out, or via explicit `--mode watch-blockers` dispatch.
