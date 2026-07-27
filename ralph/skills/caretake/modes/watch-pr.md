# `--mode watch-pr`

Resolve Backlog items parked by the `WAIT-pr` triage verdict. Scan issues carrying a `blocked:pr-NNN` label, check each referenced PR's merge state, and act: on **merged** advance the item (default `PROMOTE-plan` → Ready for Plan); on **open** leave it waiting; on **closed-not-merged** escalate (`WAIT-decision` → Human Needed) so a human re-decides. Autonomous — no human prompts. Emits one terminal token per invocation (see [outcome-tokens.md](../outcome-tokens.md)).

```bash
export RALPH_SUBCOMMAND=watch-pr
```

This is the downstream consumer that makes the `WAIT-pr` verdict non-dead-ending: an item waits on a *named, watched condition* (the PR) and advances automatically when that condition resolves. Phase 1 (#1404) produces the `blocked:pr-NNN` label + a `## Triage Decision` comment; this mode resolves it.

No `Stop` hook gates this mode (parity with `--mode hygiene`) — it mutates only the `blocked:pr-*`-parked items it owns. The terminal token is emitted by convention, not hook-enforced.

## §Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP and emit:

```
WATCH-PR SKIPPED — branch <name> is not main
```

watch-pr mutates workflow state, so it must run from `main` to avoid acting from a feature branch. (Distinct from `WATCH-PR IDLE`, which means "ran cleanly, found nothing to do".)

## §Step 2: Find parked items

`list_issues(profile: "analyst-triage", workflowState: "Backlog", limit: 250)`. `list_issues` filters on a single exact `label`, but `blocked:pr-*` is a family — so list Backlog issues and filter **client-side** for any label matching `^blocked:pr-([0-9]+)$`, capturing the PR number `NNN` from the suffix.

If no Backlog issue carries a `blocked:pr-NNN` label, emit:

```
WATCH-PR IDLE
```

and STOP.

## §Step 3: Check each PR's merge state

For each parked item, resolve its PR number from the label and check merge state:

```bash
gh pr view <NNN> --json state,mergedAt --jq '{state: .state, merged: (.mergedAt != null)}'
```

Branch by result:

| PR result | Meaning | Action (see §Step 4) |
|---|---|---|
| `state=MERGED` (`mergedAt` set) | condition resolved — work can proceed | **advance** |
| `state=OPEN` | still waiting | **leave untouched** (no mutation, does not count toward `<N>`) |
| `state=CLOSED` and not merged | PR abandoned — the wait premise is gone | **escalate** |

If `gh pr view` errors (PR not found / inaccessible), leave the item untouched and note it in the summary — do not guess.

## §Step 4: Act

**Advance (PR merged).** Strip the `blocked:pr-NNN` label and apply the deferred verdict:

1. Determine the deferred verdict. **Default `PROMOTE-plan`** (the common case — the item was waiting only on the PR). If the issue carries an explicit `## Deferred Verdict: <verdict>` comment, honor that verdict instead. (Phase 1 / #1404 does not write a `## Deferred Verdict` comment — it writes `## Triage Decision`, which names the *condition* but not a machine-parseable successor verdict — so the default applies unless a later phase adds the explicit comment.)
2. Map the verdict to its target workflow state (same mapping as triage's 8-verdict schema): `PROMOTE-plan`→`"Ready for Plan"`, `PROMOTE-research`→`"Research Needed"`, `CLOSE-done`→`"Done"`, `CLOSE-canceled`→`"Canceled"`. The default verdict is `PROMOTE-plan`→Ready for Plan. If an honored `## Deferred Verdict` is itself a `WAIT-*` verdict, leave the item parked and note it (a PR-blocked item shouldn't defer to another wait).
3. Read the issue's current labels; `save_issue(number: NNN, workflowState: <verdict target>, command: "ralph_triage", labels: <current labels minus blocked:pr-NNN, also dropping ralph-triage so the item is re-pickable in its new state>)`. The explicit `labels` array is required (save_issue replaces the full set; omitting it leaves `blocked:pr-NNN` attached). Note: `command: "ralph_triage"` is passed for semantic parity, but `state-gate.sh` does **not** gate this mode (it scopes to `RALPH_SUBCOMMAND=triage`; watch-pr's is `watch-pr`) — watch-pr's transitions are unguarded, so pass only valid target states.
4. Post a `## Watch-PR Resolution` comment: PR #NNN merged → label stripped, verdict `<verdict>` applied.

**Leave (PR open).** No mutation. The item keeps its `blocked:pr-NNN` + `ralph-triage` labels and waits for the next sweep.

**Escalate (PR closed, not merged).** The watched condition can no longer resolve:

1. Read the issue's current labels, then `save_issue(number: NNN, workflowState: "Human Needed", command: "ralph_triage", labels: <current labels minus blocked:pr-NNN, keeping ralph-triage>)`. The explicit `labels` array is **required** — `save_issue` only mutates labels when the arg is provided (it replaces the full set), so omitting it would leave the stale `blocked:pr-NNN` label attached and the next sweep would re-find and re-escalate the same dead PR (inflating `WATCH-PR ADVANCED <N>` every tick).
2. Post a `## Escalation` comment: "Blocking PR #NNN was closed without merging. The deferred `<verdict>` can no longer auto-apply — needs a human decision (re-route, re-block on a new PR, or close)."

## §Step 5: Emit terminal token

Emit exactly one (see [outcome-tokens.md](../outcome-tokens.md)):

- `WATCH-PR ADVANCED <N>` — `<N>` items **resolved this sweep**: merged→promoted PLUS closed-unmerged→escalated. Open/still-waiting items are NOT counted.
- `WATCH-PR IDLE` — no `blocked:pr-*` items found (emitted at §Step 2).
- `WATCH-PR SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit.

## §Constraints

- One sweep per invocation; process only the `blocked:pr-*`-labelled Backlog items found by the initial `list_issues` call.
- Mutates only parked items — never creates or closes issues, never touches items without a `blocked:pr-*` label.
- No code changes.
- Heartbeat / `--loop` fan-out is wired in Phase 4 (#1408); until then this mode runs only via explicit `--mode watch-pr` dispatch.
