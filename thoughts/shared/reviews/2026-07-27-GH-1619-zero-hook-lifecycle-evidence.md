---
date: 2026-07-27
re_verified: 2026-07-31
re_verified_head: d3204d1c
github_issue: 1619
github_url: https://github.com/cdubiel08/ralph-hero/issues/1619
type: review
status: complete
---

# Zero-hook lifecycle evidence — GH-1619

Concrete proof that the server-side invariants added across GH-1615/1616/1617/1618
hold with **zero Claude Code hooks anywhere in the call path** — not just the
per-skill hooks a `hero-fable` session skips, but Claude Code itself.

## Vehicle: direct MCP-server-level exercise (not a hero-fable session)

The plan's default vehicle was a `/ralph:hero-fable` session, because its
`SKILL.md` registers no per-skill hooks. This implementer does not have a
tool surface that can drive an interactive `hero-fable` session end-to-end
(the impl-agent role that produced this evidence is scoped to
`get_issue`/`list_issues`/`save_issue`/`create_comment`/`list_sub_issues` —
it cannot call `create_issue`, `create_sub_issues`, `advance_issue`, or
`next_actions` as Claude-Code tool invocations).

Instead this doc uses a **strictly stronger** proof: the compiled
`ralph-hero-mcp-server` (`mcp-server/dist/index.js`, built from this
worktree at the commit this evidence is attached to) was spawned as a plain
child process and driven over the MCP stdio protocol via the official
`@modelcontextprotocol/sdk` `Client`/`StdioClientTransport` classes, from a
throwaway Node script run via `Bash` — **outside Claude Code entirely**.
There is no Claude Code session anywhere in this call path, so there are
zero Claude Code hooks of any kind (not just zero skill-level hooks) — a
strictly stronger claim than "the skill registers no hooks," which is
exactly the nuance the plan's own round-2 critique flagged (`ralph/hooks/hooks.json`
still registers two plugin-level hooks, `set-skill-env.sh` on SessionStart
and `cursor-advance-catch-up.sh` on `PostToolUse: recent_activity`, that
load for every skill including `hero-fable`; neither is in this call path
at all here, so the question of whether they're inert doesn't even arise).

Every call below ran against the **live** `cdubiel08/ralph-hero` project
board (project 3) — not stubs. Two disposable sandbox issues were created
(`#1621`, `#1622`) plus one sandbox child (`#1623`), all labeled
`test:zero-hook`, and all three were canceled (`CLOSED_NOT_PLANNED`) at the
end of the run. Live links:

- https://github.com/cdubiel08/ralph-hero/issues/1621 (Canceled)
- https://github.com/cdubiel08/ralph-hero/issues/1622 (Canceled)
- https://github.com/cdubiel08/ralph-hero/issues/1623 (Canceled)

## 1. Transition refusal (server, both classes)

Sandbox issue A (`#1621`) created at `Research Needed`.

**1a. Command-class refusal** — `save_issue(number=1621, workflowState="Done", command="impl")`:

```json
{"error":"Failed to save issue: State \"Done\" is not a valid output for ralph_impl. Valid direct states for ralph_impl: In Progress, In Review, Human Needed. Recovery: retry with one of the valid states listed above. Available semantic intents for ralph_impl: __LOCK__ → In Progress, __COMPLETE__ → In Review, __ESCALATE__ → Human Needed."}
```

**1b. Transition-class refusal (command-less)** — `save_issue(number=1621, workflowState="In Review")`:

```json
{"error":"Illegal transition for #1621: \"Research Needed\" -> \"In Review\". Legal next states from \"Research Needed\": Research in Progress, Ready for Plan, Human Needed, Backlog, Done, Canceled. Recovery: move through the pipeline via one of the legal states, or — for human repair (e.g. reopening a closed issue) — retry with force=true; the override is recorded in the response."}
```

**1c. The legal transition succeeds** — `save_issue(number=1621, workflowState="Research in Progress")`:

```json
{"number": 1621, "url": "https://github.com/cdubiel08/ralph-hero/issues/1621", "changes": {"workflowState": "Research in Progress"}}
```

Proof criterion satisfied: both refusal texts are the server's own `toolError`
payload (command-level `COMMAND_ALLOWED_STATES` check, then transition-level
`isLegalTransition` check); there is no hook anywhere in this call path to
have produced either message.

## 2. Lock refusal + loud force

**Deviation from the plan's illustrative example, and why.** The plan's Phase 5
spec suggested driving issue A to `Research in Progress` and then attempting
`Plan in Progress` to show a lock refusal. That specific pair is actually
**doubly illegal** — `"Research in Progress" -> "Plan in Progress"` is not in
`ALLOWED_TRANSITIONS["Research in Progress"]` at all, and `save_issue`'s choke
points run the transition check (2b-i) strictly before the lock check
(2b-iii, `issue-tools.ts`) — so that call would return the **transition**
refusal, never reach the lock guard, and would not actually demonstrate lock
enforcement. To exercise a *genuine* lock conflict (transition-legal, but
blocked by an active claim) requires a target that is BOTH transition-legal
from the current lock state AND itself a lock state — the one edge in the
table that qualifies is `"Plan in Progress" -> "In Progress"` (the
plan-reuse short-circuit, inventory row 13). This is used below instead.

Issue A driven legally through: `Research in Progress -> Ready for Plan`
(completion edge, unconditional) -> `Ready for Plan -> Plan in Progress`
(claims the plan lock).

**2c. Lock conflict refusal** — `save_issue(number=1621, workflowState="In Progress")`
(transition-legal per the JSON's `Plan in Progress -> In Progress` edge, but
a live lock conflict — current and target are both lock states):

```json
{"error":"Issue #1621 is locked: \"Plan in Progress\" held by @cdubiel08 since 2026-07-27T05:37:59Z (1m ago). Another agent may be working on it. Recovery: wait for release; if the claim is stale (see next_actions lock-stale directions), release it via save_issue(workflowState: \"Ready for Plan\") — releasing requires the claim to be past the stale threshold or force=true; or override this claim directly with force=true (the override is recorded in the response)."}
```

Holder identity (`@cdubiel08`) and claim time (`2026-07-27T05:37:59Z`, `1m ago`)
both come from the project field value's `creator`/`updatedAt`
(`ProjectV2ItemFieldValueCommon`, GH-1616) — every local agent on this repo
shares one token login, so the holder name is not diagnostic on its own here,
but the claim-time/age IS the load-bearing signal, exactly as the plan's
Design Decisions record.

**2d. Loud force overrides it** — `save_issue(number=1621, workflowState="In Progress", force=true)`:

```json
{"number": 1621, "url": "https://github.com/cdubiel08/ralph-hero/issues/1621", "changes": {"forcedLockOverride": {"previousState": "Plan in Progress", "holder": "cdubiel08", "heldSince": "2026-07-27T05:37:59Z"}, "workflowState": "In Progress"}}
```

`forcedLockOverride` in the response is the durable, loud record the plan's
Design Decisions specify — no silent bypass.

## 3. Tree contract

Sandbox issue B (`#1622`) created at `Human Needed` (deliberately — this
doubles as the parent for §5). Baseline `get_issue(1622)`:
`subIssuesSummary.total: 0`.

`create_sub_issues(parentNumber=1622, maxChildEstimate="S", children=[{estimate:"XL"}, {estimate:"XS"}])`:

```json
{"error":"Child #0 (\"[test:zero-hook] child 1 (XL, over ceiling)\") has estimate XL, which exceeds maxChildEstimate=S. No issues were created. Split this child further, or raise/omit maxChildEstimate if this is an epic-level decomposition (feature children may legitimately be M)."}
```

Follow-up `get_issue(1622)` after the refused call: `subIssuesSummary.total: 0`,
`subIssues: []` — unchanged. Zero orphans; the refusal is up-front (before
any child is created), not partial.

## 4. Stale lock

Live demonstration (not just a linked CI run), using the per-call
`lockStaleHours` param exactly as the plan's Design Decisions anticipated.
After §2's force-claim, issue A sits at `In Progress` with a fresh claim
time. `next_actions(audience="agent", lockStaleHours=0.0001, limit=100)`
(a ~0.36-second threshold, guaranteed to read every open lock — including
issue A's just-made claim — as stale) returned issue A as direction rank 8:

```json
{
  "rank": 8,
  "kind": "lock-stale",
  "issue": {"number": 1621, "title": "[test:zero-hook] Transition + lock refusal sandbox A", "workflowState": "In Progress"},
  "signals": {
    "tags": ["stalled"],
    "heldSince": "2026-07-27T05:38:00Z",
    "reclaimInstruction": "No release edge exists for In Progress (preserves the no-rollback-on-impl-failure asymmetry) — checkpoint or inspect the worktree to confirm whether work is still live, or escalate to Human Needed if it has been abandoned."
  },
  "reason": "Stuck in In Progress for 1 day — may be blocked"
}
```

Note the `reclaimInstruction` correctly reflects that `In Progress` has no
backward release edge (the deliberate no-rollback asymmetry, Design
Decisions) — the instruction is "checkpoint/inspect or escalate," not
"release," which is the behaviorally-correct advice for this lock state.
Three other genuinely-old `In Progress` issues on the live board (#1609,
#1613, #1615) also surfaced under the same tiny threshold, confirming this
is the real ranking path, not a special case for the sandbox issue.

Companion CI evidence (the no-false-positive matrix at the real 24h
default): `mcp-server/src/__tests__/directions.test.ts` and
`dashboard-fetch.test.ts` (Phase 3, GH-1617) — see the `cd mcp-server && npm test`
run attached to this PR.

## 5. Parent-gate refusal (both writers)

Sandbox child (`#1623`) created under parent B (`#1622`, at `Human Needed`)
via `create_sub_issues(parentNumber=1622, maxChildEstimate="S", children=[{estimate:"S", workflowState:"Backlog"}])`.

**5b. Side-effect path** (`autoAdvanceParent`, fired from `save_issue`) —
`save_issue(number=1623, workflowState="Ready for Plan")` (a parent-gate
state) succeeds for the CHILD's own transition, and — run with
`RALPH_DEBUG=true` to observe the internal best-effort skip — emits:

```
[autoAdvanceParent] skipped advancing parent #1622 to "Ready for Plan": parent is escalated (current="Human Needed")
```

The `save_issue` response for the child carries no `changes.parentAdvanced`
key (that key is only set on a successful advance) — the skip is silent in
the primary response by design (best-effort, never fails the child's own
write) but observable via the debug log and via a follow-up `get_issue` on
the parent.

**5c. Explicit path** (`advance_issue direction="parent"`) —
`advance_issue(direction="parent", number=1623)`:

```json
{
  "advanced": false,
  "reason": "parent is escalated",
  "parent": {"number": 1622, "title": "[test:zero-hook] Tree-contract + parent-gate sandbox B", "currentState": "Human Needed"},
  "targetState": "Ready for Plan",
  "childStates": [{"number": 1623, "workflowState": "Ready for Plan"}]
}
```

**5d. Confirmation** — `get_issue(1622)` after both calls: `workflowState:
"Human Needed"` (unchanged), `subIssuesSummary.total: 1`. The escalation was
not silently overwritten by either writer — this is the invariant whose
absence made the plan's first draft "proves each invariant server-side"
claim overstated (round-1 critique Failure 2).

## 6. Scope statement

This proof covers **MCP-mediated mutations only**. The five GitHub Actions
workflows (`route-issues.yml`, `sync-issue-state.yml`, `sync-project-state.yml`,
`advance-parent.yml`, `sync-pr-merge.yml`) mutate Workflow State via raw
GraphQL with `ROUTING_PAT` and do not call the MCP server at all — they are
documented trusted writers, out of scope for this proof, per the epic's
structural limit (GH-1592 What We're NOT Doing).

The one MCP-mediated caller this feature does **not** prove legal is the
cross-repo `dependency-flow` sibling advancement
(`ralph/skills/review/merge-gate.md` §Cross-repo,
`ralph/skills/review/SKILL.md` Step 7): the target workflow state for the
sibling repo's issue is not enumerated anywhere in `.ralph-repos.yml`'s
schema or in the skill prose, so it cannot be checked against the transition
table. Phase 5 bounded this caller (require an explicit target state + a
`get_issue` read of the sibling before any write) rather than fabricating
proof of legality it cannot demonstrate — see `merge-gate.md` §Cross-repo.

## Cleanup

All three sandbox issues canceled via `save_issue(issueState:
"CLOSED_NOT_PLANNED")` (legal from any non-terminal state via the universal
terminal edges) — `#1621` (from `In Progress`), `#1622` (from `Human
Needed`), `#1623` (from `Ready for Plan`). All three now read `Canceled` /
`CLOSED` on the live board.

---

# Re-verification at the PR-B head (2026-07-31, `d3204d1c`)

The relanding pivot plan (§ Phase 2 §5) requires this evidence re-run at the
PR-B head. **This was not a formality: the server changed materially after the
original run.** The original drive executed against `feature/GH-1593`
(`18f53463`); PR-A's review then fixed four defects in exactly the modules this
doc exercises — `issue-tools.ts` (lock destruction on the claim-clock refresh),
`batch-tools.ts` (guard bypass on duplicate ops, destructive dry-run preview),
and `tree-tools.ts` (unbounded alias query) — plus `lock-guard.ts` and
`workflow-states.ts`. `git diff feature/GH-1593 HEAD -- mcp-server/src/` reports
25 files changed. Evidence captured before those fixes could not be assumed to
describe current behavior.

Same vehicle as the original: the compiled `mcp-server/dist/index.js` built from
this worktree, spawned as a plain child process and driven over MCP stdio via the
official SDK `Client`/`StdioClientTransport`, from a throwaway Node script — no
Claude Code session in the call path, therefore zero Claude Code hooks of any
kind. Live `cdubiel08/ralph-hero` project 3. Four disposable sandbox issues
(`#1641`, `#1642`, `#1643`, `#1644`) plus one sandbox child (`#1645`), all
labeled `test:zero-hook`, **all canceled (`CLOSED_NOT_PLANNED`) at the end of
the run** — verified in the transcript below.

## Result: every invariant still holds

| § | Invariant | Verdict at `d3204d1c` |
|---|---|---|
| 1a | Command-class refusal (`COMMAND_ALLOWED_STATES`) | Holds — byte-identical message |
| 1b | Transition-class refusal (`isLegalTransition`) | Holds — byte-identical message |
| 1c | Legal transition succeeds | Holds |
| 2c | Lock-conflict refusal with holder + claim age | Holds — **message improved**, see below |
| 2d | Loud `force` records `forcedLockOverride` | Holds |
| 3b | Tree ceiling refused up front | Holds — byte-identical message |
| 3c | Zero orphans after the refusal | Holds — `subIssuesSummary.total: 0` unchanged |
| 4a | Stale-lock direction surfaces at a low threshold | Holds |
| 4b | Same issue NOT surfaced at the 24h default | Holds |
| 4c | Release gate on a non-stale claim | Holds — **new coverage**, see below |
| 5b | Parent-gate refusal names the blocking children | Holds |
| 5c | Parent state unchanged after refusal | Holds |

### Two differences from the original run — both improvements, neither a regression

**§2c gained a clause.** The refusal now names the rejected target:

```
Issue #1641 is locked: "Plan in Progress" held by @cdubiel08 since 2026-07-31T00:17:29Z (1m ago). Refused move to "In Progress". Another agent may be working on it. Recovery: ...
```

`Refused move to "In Progress".` is new since the original transcript. It landed
with PR-A's lock work and makes the refusal self-describing.

**§4c is new coverage.** The original §4 demonstrated the stale-lock *clock*
(that a held claim surfaces as `lock-stale` past the threshold). It did not
exercise the *release gate*. Attempting to release a fresh claim now refuses:

```
Issue #1643 is locked: "Plan in Progress" held since 2026-07-31T00:17:35Z (1m ago) — not yet stale (threshold: 24h). Releasing it to "Ready for Plan" would let another agent claim it out from under the holder.
Recovery: wait for the holder to finish or escalate; if you ARE the holder releasing after a failure, retry with force=true (the release is recorded in the response).
```

This closes the loop the original §2c refusal only *described* ("releasing
requires the claim to be past the stale threshold or force=true") — that
sentence is now demonstrated, not merely asserted.

### §4a/§4b — the stale clock reads the field value, not the issue

At `lockStaleHours: 0.0001` the held claim surfaces:

```json
{"rank":7,"kind":"lock-stale","issue":{"number":1643,"workflowState":"Plan in Progress","estimate":"XS"},
 "signals":{"tags":["stalled"],"heldSince":"2026-07-31T00:17:35Z",
 "reclaimInstruction":"Stale claim — release it via save_issue(workflowState: \"Ready for Plan\") so another agent can pick it up ..."}}
```

At the 24h default the same issue is correctly absent. `heldSince` matches the
claim time from the project field value's `updatedAt` (GH-1617), not the issue's
`updatedAt` — the fix that made the clock trustworthy.

### §5 — parent gate

`advance_issue(child #1645, direction: "parent")` with the child at `Backlog`:

```json
{"advanced": false, "reason": "Not all children at a gate state", "minimumChildState": "Backlog",
 "gateStates": ["Ready for Plan","Plan in Review","In Review","Done"],
 "parent": {"number": 1644}, "childStates": [{"number": 1645, "workflowState": "Backlog"}]}
```

Parent re-read afterwards: still `"Human Needed"` — the refusal is not merely
reported, it is enforced.

> **Method note.** A first pass at this re-run had two script defects, both mine,
> both corrected before the transcript above was taken: `advance_issue` was
> called without its required `direction` argument (an input-validation error,
> not a server refusal — it proved nothing), and the §5 parent had been left
> childless by §3b's ceiling refusal, so "no parent/child pair" was being
> mistaken for a gate result. §5 was re-run against a purpose-built parent/child
> pair. Recording this because an evidence doc that quietly drops the two
> sections its script got wrong is worth less than one that says so.
