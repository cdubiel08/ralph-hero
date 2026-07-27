# `--mode watch --kind {pr,upstream,issue}`

Resolve items parked by the `WAIT-*` triage verdicts. One mode, three kinds:

- **`--kind pr`** — Backlog items carrying `blocked:pr-NNN`. Advance on PR merge; escalate on closed-unmerged.
- **`--kind upstream`** — Backlog items carrying `blocked:upstream`. Advance when the recorded external condition resolves; escalate on a dead/unparseable URL.
- **`--kind issue`** — Human Needed (+ Backlog sweep) items blocked by an OPEN issue (`blockedBy` edge or a `## Escalation` body naming a blocker). Advance when **all** blockers close; no escalation path — an open blocker just leaves the item parked.

Bare `--mode watch` (no `--kind`) runs all three kinds **serially in one invocation** — pr, then upstream, then issue. Autonomous — no human prompts. Emits one terminal token per kind processed (see [outcome-tokens.md](../outcome-tokens.md)).

```bash
export RALPH_SUBCOMMAND=watch
```

This is the downstream consumer that makes the `WAIT-pr` / `WAIT-upstream` / `WAIT-issue=NNN` verdicts non-dead-ending: an item waits on a *named, watched condition* and advances automatically when that condition resolves. Triage (#1404, #1472) produces the labels / dependency edge; this mode resolves them.

No `Stop` hook gates this mode (parity with `--mode hygiene`) — it mutates only the items it owns per kind. The terminal token(s) are emitted by convention, not hook-enforced.

## §Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP the entire invocation (no kind can safely mutate state from a feature branch) and emit, for each kind that would have run:

```text
WATCH-<KIND> SKIPPED — branch <name> is not main
```

One line when `--kind <x>` was given; three lines in `pr`/`upstream`/`issue` order for a bare invocation. (Distinct from `WATCH-<KIND> IDLE`, which means "ran cleanly, found nothing to do".)

## §Step 2: Determine kind(s) to run

Parse `--kind <pr|upstream|issue>` from `$ARGUMENTS`:

- `--kind pr` → run only the **pr** row of §Step 3-6 below.
- `--kind upstream` → run only the **upstream** row.
- `--kind issue` → run only the **issue** row.
- no `--kind` → run **pr**, then **upstream**, then **issue**, each a full independent §Step 3-6 pass; emit one terminal token per kind (§Step 6), plus one informational summary line.
- any other `--kind` value → STOP and emit `WATCH SKIPPED — unknown --kind <value>; expected pr|upstream|issue`.

## §Step 3: Find parked items

| Kind | Query | Predicate |
|---|---|---|
| **pr** | `list_issues(profile: "analyst-triage", workflowState: "Backlog", limit: 250)` | `list_issues` filters on a single exact `label`, but `blocked:pr-*` is a family — filter **client-side** for any label matching `^blocked:pr-([0-9]+)$`, capturing the PR number `NNN` from the suffix. |
| **upstream** | `list_issues(profile: "analyst-triage", workflowState: "Backlog", label: "blocked:upstream", limit: 250)` | `blocked:upstream` is a single fixed label, so the server-side `label:` filter returns exactly the parked set. |
| **issue** | Two complementary sweeps, union the results (dedup by issue number): (1) `list_issues(profile: "analyst-triage", workflowState: "Human Needed", limit: 250)` — the canonical `WAIT-issue=NNN` parking state; (2) `list_issues(profile: "analyst-triage", workflowState: "Backlog", limit: 250)` — forward-compat for the Gap-A relaxation (a future `WAIT-issue` may park Backlog+edge per triage.md Gap A cross-ref). | For each candidate, identify its blocker(s) from **either** signal (prefer the edge; fall back to the `## Escalation` text): **Edge** — `list_dependencies(number: NNN)` → inspect the `blockedBy` connection, each node carries `number` + `state`; **`## Escalation` body convention (#1472)** — parse the blocker number from `Blocked by #NNN` and the advance target from `Move to <state> once #NNN closes` (default `Ready for Plan` when no explicit target is named). If neither signal yields a blocker number, **skip** the item (not counted). |

If a kind's candidate set is empty, emit `WATCH-<KIND> IDLE` (§Step 6 token) and move to the next kind (bare mode) or STOP (single-kind mode).

## §Step 4: Check resolution condition

| Kind | Check | MET → advance | Not met → leave (uncounted unless noted) | Can't confirm → leave |
|---|---|---|---|---|
| **pr** | `gh pr view <NNN> --json state,mergedAt --jq '{state: .state, merged: (.mergedAt != null)}'` | `state=MERGED` | `state=OPEN` — still waiting, no mutation | `gh pr view` errors (not found/inaccessible) — leave untouched, note in summary, never guess |
| **upstream** | Read the issue's **`## Triage Decision`** comment (this is where #1404's `WAIT-upstream` records the URL + condition — NOT a `## Blocker` comment, which does not exist) for the upstream URL + condition. Only a **confident MET** advances; anything uncertain leaves parked (never false-advance): GitHub issue/PR URL → `gh issue view`/`gh pr view`, MET = `CLOSED`/`MERGED`; package-registry URL → fetch registry JSON, MET only if a version/tag field satisfies the named condition; plain HTTP resource → MET only if the condition names an explicit checkable signal and the fetch confirms it; anything else/ambiguous → still blocked | confidently met | live-but-unconfirmable / ambiguous — parks indefinitely (no age/sweep escalation this phase; a human or manual label removal is the escape) | **Dead URL — HTTP 404/410 only** → escalate branch (§Step 5). Any *other* fetch failure (5xx, timeout, DNS) is **transient** → still blocked, note in summary, retry next sweep. Never escalate on a one-off error. No URL/condition parseable at all → escalate branch. |
| **issue** | `get_issue(<blocker>)` for **every** blocker number found for the item | ALL blockers `state=CLOSED` (Done or Canceled) | ANY blocker `state=OPEN` — leave untouched, **counted in `<m>`** | Blocker number unresolvable (`get_issue` errors) — leave untouched, note in summary, never guess |

Conservative posture across upstream/issue: only a confident MET / all-CLOSED set advances; anything uncertain leaves the item parked.

## §Step 5: Act

### Advance

| Kind | Steps |
|---|---|
| **pr** | 1. Determine the deferred verdict: **default `PROMOTE-plan`** (Phase 1/#1404 writes `## Triage Decision`, not a machine-parseable `## Deferred Verdict` comment, so the default applies unless one exists). 2. Map the verdict to its target using the **full 4-verdict map**: `PROMOTE-plan`→`"Ready for Plan"`, `PROMOTE-research`→`"Research Needed"`, `CLOSE-done`→`"Done"`, `CLOSE-canceled`→`"Canceled"`. If an honored `## Deferred Verdict` is itself a `WAIT-*` verdict, leave the item parked and note it. 3. `save_issue(number: NNN, workflowState: <target>, command: "ralph_triage", labels: <current labels minus blocked:pr-NNN, also dropping ralph-triage>)`. 4. Post a `## Watch-PR Resolution` comment: PR #NNN merged → label stripped, verdict `<verdict>` applied. |
| **upstream** | 1. Determine the deferred verdict: **default `PROMOTE-plan`**. 2. Map the verdict — **only auto-applies the promote family**: `PROMOTE-plan`→`"Ready for Plan"`, `PROMOTE-research`→`"Research Needed"`. A `CLOSE-*` or `WAIT-*` deferred verdict is **NOT** auto-applied (this kind never closes issues, and shouldn't auto-close on a speculative comment) — route those via the **escalate** branch instead (post `## Escalation` noting the deferred verdict needs human confirmation). 3. `save_issue(number: NNN, workflowState: <target>, command: "ralph_triage", labels: <current labels minus blocked:upstream, also dropping ralph-triage>)`. 4. Post a `## Watch-Upstream Resolution` comment: condition `<condition>` met at `<url>` → label stripped, verdict `<verdict>` applied. |
| **issue** | For each all-CLOSED item: 1. **Determine the advance target**: read the embedded condition from the `## Escalation` line (`Move to <state> once #NNN closes`), or an explicit `advance:` hint if present, else **default `Ready for Plan`**. 2. **Remove the dependency edge**: for each `blockedBy` edge found in §Step 3, call `remove_dependency(blockedNumber: <parked-item-number>, blockingNumber: <blocker-number>)`. `blockedNumber` = the parked item; `blockingNumber` = the now-closed blocker. Do NOT use `blockedByNumber` — that param does not exist in the tool schema. 3. `save_issue(number: <parked-item-number>, workflowState: <advance-target>, command: "ralph_triage", labels: <current labels minus any blocked:* and ralph-triage>)`. 4. Post a `## Unblocked` comment: "Blocker(s) #NNN closed → dependency edge removed, advanced to `<target>`." (name every blocker number that closed). |

Every `save_issue` call above passes an **explicit `labels` array** — `save_issue` replaces the full label set; omitting it leaves the stale `blocked:*` label attached and the next sweep re-finds and re-escalates/re-advances the same item (inflating the `ADVANCED <N>` count every tick). `command: "ralph_triage"` is passed for semantic parity, but `state-gate.sh` does **not** gate this mode (it scopes to `RALPH_SUBCOMMAND=triage`; watch's is `watch`) — this mode's transitions are unguarded, so pass only valid target states.

### Leave (no mutation)

- **pr**: PR still open — item keeps `blocked:pr-NNN` + `ralph-triage`, waits for the next sweep.
- **upstream**: still blocked / can't confirm — item keeps `blocked:upstream` + `ralph-triage`, waits for the next sweep.
- **issue**: any blocker still OPEN — item keeps its state + dependency edge + labels, waits for the next sweep. Counted in `<m>`.

### Escalate

| Kind | Trigger | Action |
|---|---|---|
| **pr** | PR closed, not merged | Strip `blocked:pr-NNN` (keep `ralph-triage`); `save_issue(number: NNN, workflowState: "Human Needed", command: "ralph_triage", labels: <current minus blocked:pr-NNN>)`; post `## Escalation`: "Blocking PR #NNN was closed without merging. The deferred `<verdict>` can no longer auto-apply — needs a human decision (re-route, re-block on a new PR, or close)." |
| **upstream** | Dead URL (404/410) or unparseable condition | Strip `blocked:upstream` (keep `ralph-triage`); `save_issue(number: NNN, workflowState: "Human Needed", command: "ralph_triage", labels: <current minus blocked:upstream>)`; post `## Escalation`: "Upstream blocker URL `<url>` is dead/unparseable; the deferred `<verdict>` can no longer auto-apply — needs a human decision (re-route, re-block on a new condition, or close)." |
| **issue** | *(none)* | An open blocker never escalates — it leaves the item parked and counts it in `<m>` (see Leave, above). |

## §Step 6: Emit terminal token(s)

For a **bare invocation**, print the optional cross-kind summary line FIRST (e.g. `WATCH summary: N advanced across pr/upstream/issue`) — it is informational, not a grepped token, and `outcome-tokens.md`'s invariant requires the token block to be the last thing emitted. Then emit exactly one token per kind processed (one line for `--kind <x>`; three lines in `pr`/`upstream`/`issue` order for a bare invocation — see [outcome-tokens.md](../outcome-tokens.md)):

- `WATCH-PR ADVANCED <N>` — `<N>` items **resolved this sweep**: merged→promoted PLUS closed-unmerged→escalated. Open/still-waiting items are NOT counted. | `WATCH-PR IDLE` — no `blocked:pr-*` items found. | `WATCH-PR SKIPPED — branch <name> is not main`.
- `WATCH-UPSTREAM ADVANCED <N>` — `<N>` items **resolved this sweep**: condition-met→promoted PLUS dead/unparseable→escalated. Still-blocked/can't-confirm items are NOT counted. | `WATCH-UPSTREAM IDLE` — no `blocked:upstream` items found. | `WATCH-UPSTREAM SKIPPED — branch <name> is not main`.
- `WATCH-ISSUE ADVANCED <N>` — `<N>` items **resolved this sweep** (all blockers CLOSED → dependency edge removed + advanced). Append informational prose `, <m> still blocked` for the count of items left parked with ≥1 open blocker (not part of the grepped token). | `WATCH-ISSUE IDLE` — no dependency-parked items found. | `WATCH-ISSUE SKIPPED — branch <name> is not main`.

Nothing may follow the token block — no trailing summary, no closing prose.

## §Constraints

- One sweep per kind per invocation; process only the items found by that kind's initial query in §Step 3.
- Mutates only parked items it owns per kind — never creates or closes issues outside the documented advance/escalate transitions, never touches items lacking that kind's parking signal.
- **Conservative advance** for upstream and issue — never false-advance; anything uncertain leaves the item parked.
- No code changes.
- Rate-limit awareness (**issue** kind): one `list_dependencies` (or `get_issue`) per candidate across two `list_issues` queries (limit 250 each) — a meaningful number of API calls per heartbeat tick on a large board; the proactive rate-limiter in the MCP server warns at 100 remaining and blocks at 50.
- Heartbeat / `--loop` fan-out: `--mode all` and a looped bare `--mode watch` run this mode as a heartbeat child (no `Queue empty.` terminal). `--mode watch --kind <x>` also dispatches directly from hero's `blocked:*` event-tier routing (board-wide sweep, not scoped to a single issue) and from manual invocation.
