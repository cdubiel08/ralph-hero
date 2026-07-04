# `--mode watch-upstream`

Resolve Backlog items parked by the `WAIT-upstream` triage verdict. Scan issues carrying a `blocked:upstream` label, read the upstream URL + condition from the item's `## Triage Decision` comment, check whether the condition is met, and act: on **condition met** advance the item (default `PROMOTE-plan` → Ready for Plan); on **still blocked / can't confirm** leave it waiting; on **dead URL or unparseable condition** escalate (`WAIT-decision` → Human Needed). Autonomous — no human prompts. Emits one terminal token per invocation (see [outcome-tokens.md](../outcome-tokens.md)).

```bash
export RALPH_SUBCOMMAND=watch-upstream
```

This is the downstream consumer that makes the `WAIT-upstream` verdict non-dead-ending: an item waits on a *named, watched external condition* and advances when it resolves. Phase 1 (#1404) produces the `blocked:upstream` label + records the URL in a `## Triage Decision` comment; this mode resolves it.

No `Stop` hook gates this mode (parity with `--mode watch-pr`/`hygiene`/`trends`) — it mutates only the `blocked:upstream`-parked items it owns. The terminal token is emitted by convention, not hook-enforced.

## §Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP and emit:

```
WATCH-UPSTREAM SKIPPED — branch <name> is not main
```

watch-upstream mutates workflow state, so it must run from `main`. (Distinct from `WATCH-UPSTREAM IDLE`, which means "ran cleanly, found nothing to do".)

## §Step 2: Find parked items

`list_issues(profile: "analyst-triage", workflowState: "Backlog", label: "blocked:upstream", limit: 250)`. Unlike watch-pr's `blocked:pr-*` family, `blocked:upstream` is a single fixed label, so the server-side `label:` filter returns exactly the parked set.

If no Backlog issue carries `blocked:upstream`, emit:

```
WATCH-UPSTREAM IDLE
```

and STOP.

## §Step 3: Read the blocker condition

For each parked item, read its **`## Triage Decision`** comment (this is where #1404's `WAIT-upstream` records the URL + condition — NOT a `## Blocker` comment, which does not exist). Extract:

- the **upstream URL** (e.g. a GitHub issue/PR URL, a package-registry URL, or a plain HTTP resource), and
- the **condition** that resolves the block (e.g. "external issue closed", "package `foo` ≥ 2.0 released").

If no URL/condition is parseable from the comment, take the **escalate** branch (§Step 5) — the wait premise is unrecoverable.

## §Step 4: Check the condition (conservative)

Determine whether the condition is **confidently met**. Only a confident MET advances the item; anything uncertain leaves it parked (never false-advance):

- **GitHub issue/PR URL** (`github.com/<owner>/<repo>/issues/N` or `/pull/N`) → `gh issue view <url> --json state` / `gh pr view <url> --json state,mergedAt`. MET = issue `CLOSED` / PR `MERGED`.
- **Package-registry URL** → fetch the registry JSON (`curl -fsS`); MET only if a `version`/`tag` field satisfies the named release condition.
- **Plain HTTP resource** → MET only if the condition names an explicit, checkable signal (e.g. "200 OK at `<url>`") and the fetch confirms it.
- **Anything else / ambiguous** → treat as **still blocked** (leave parked).
- **Dead URL — HTTP 404/410 only** → **escalate** branch. Any *other* fetch failure (5xx, timeout, DNS) is **transient** → treat as **still blocked** (note it in the summary; retry next sweep). Never escalate on a one-off error — a flaky upstream must not prematurely push an item to Human Needed (matches watch-pr's "all fetch errors leave untouched" posture, but allows a definitive 404/410 to escalate).

## §Step 5: Act

**Advance (condition confidently met).** Strip the `blocked:upstream` label and apply the deferred verdict:

1. Determine the deferred verdict. **Default `PROMOTE-plan`** (the common case). If the issue carries an explicit `## Deferred Verdict: <verdict>` comment, honor it instead. (Phase 1 / #1404 writes a `## Triage Decision` comment, not a `## Deferred Verdict` comment, so the default applies unless a later phase adds the explicit comment.)
2. Map the verdict to its target. watch-upstream **only auto-applies the promote family**: `PROMOTE-plan`→`"Ready for Plan"`, `PROMOTE-research`→`"Research Needed"`. Default `PROMOTE-plan`→Ready for Plan. A `CLOSE-*` or `WAIT-*` deferred verdict is **NOT** auto-applied here — this watcher never closes issues (see §Constraints), and shouldn't auto-close on a speculative comment — so route those via the **escalate** branch instead (post a `## Escalation` noting the deferred verdict needs human confirmation before close/re-wait).
3. Read the issue's current labels; `save_issue(number: NNN, workflowState: <verdict target>, command: "ralph_triage", labels: <current labels minus blocked:upstream, also dropping ralph-triage so the item is re-pickable in its new state>)`. The explicit `labels` array is required (save_issue replaces the full set; omitting it leaves `blocked:upstream` attached). Note: `command: "ralph_triage"` is passed for semantic parity, but `state-gate.sh` does **not** gate this mode (it scopes to `RALPH_SUBCOMMAND=triage`; watch-upstream's is `watch-upstream`) — its transitions are unguarded, so pass only valid target states.
4. Post a `## Watch-Upstream Resolution` comment: condition `<condition>` met at `<url>` → label stripped, verdict `<verdict>` applied.

**Leave (still blocked / can't confirm).** No mutation. The item keeps its `blocked:upstream` + `ralph-triage` labels and waits for the next sweep. (Per the plan's scoping choice, an item whose condition is live-but-unconfirmable parks indefinitely — no age/sweep escalation in this phase; a human or manual label removal is the escape.)

**Escalate (dead URL or unparseable condition).** The watched condition can no longer be evaluated:

1. Read the issue's current labels, then `save_issue(number: NNN, workflowState: "Human Needed", command: "ralph_triage", labels: <current labels minus blocked:upstream, keeping ralph-triage>)`. The explicit `labels` array is **required** — `save_issue` only mutates labels when the arg is provided (replace-set semantics), so omitting it would leave the stale `blocked:upstream` label attached and the next sweep would re-find and re-escalate the same dead item (inflating `WATCH-UPSTREAM ADVANCED <N>` every tick).
2. Post a `## Escalation` comment: "Upstream blocker URL `<url>` is dead/unparseable; the deferred `<verdict>` can no longer auto-apply — needs a human decision (re-route, re-block on a new condition, or close)."

## §Step 6: Emit terminal token

Emit exactly one (see [outcome-tokens.md](../outcome-tokens.md)):

- `WATCH-UPSTREAM ADVANCED <N>` — `<N>` items **resolved this sweep**: condition-met→promoted PLUS dead/unparseable→escalated. Still-blocked / can't-confirm items are NOT counted.
- `WATCH-UPSTREAM IDLE` — no `blocked:upstream` items found (emitted at §Step 2).
- `WATCH-UPSTREAM SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit.

## §Constraints

- One sweep per invocation; process only the `blocked:upstream`-labelled Backlog items found by the initial `list_issues` call.
- **Conservative advance** — never false-advance. When the condition can't be confidently confirmed met, leave the item parked.
- Mutates only parked items — never creates or closes issues, never touches items without a `blocked:upstream` label.
- No code changes.
- Heartbeat / `--loop` fan-out is wired in Phase 4 (#1408); until then this mode runs only via explicit `--mode watch-upstream` dispatch.
