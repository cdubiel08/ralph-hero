# ralph-herdr: the one-writer invariant — design

**Date:** 2026-08-13
**Issues:** #1808 (spine), #1776 (reshaped), #1775 (demoted)
**Status:** design approved, pending implementation plan

## The invariant

> Only one worker may write into a worktree at a time, through a claim.
> Everything else is orchestration, relay, and messaging.

This is the single safety property of the ralph-herdr fleet. It is the test this
design applies to every proposed change: **does this protect the invariant, or is
it bookkeeping?** Bookkeeping may be wrong without producing an unsafe state — it
produces bad diagnostics.

## How the invariant is enforced today

It already holds, by construction, through three layers:

| Layer | Mechanism | Strength |
|---|---|---|
| Worktree topology | branch derives from the issue number (`feature/GH-1832`), so issue ↔ branch ↔ worktree is 1:1 | structural |
| Agent-name mutex | names are `w<N>-<slug>`; herdr refuses a duplicate name server-side | atomic — this is what wins the race |
| Board claim | taken inside `/ralph:work`, read-back verified | the real backstop |

The `w<N>-*` pre-check in `lib.sh` is advisory and fails open; it is not what
holds the line. The name collision at `agent start` is, and the code handles the
lost race with `rc=2` rather than improvising a `--N` sibling.

`lib.sh` states the rule directly:

> never improvise a `--N` sibling here — that would put TWO `/ralph:work`
> sessions on one issue, the very thing the pre-check (and the board's claim
> protocol) refuse — and since GH-1774 there is no shared-claim plane to defer
> to either: sibling fleets are gone.

And on the ledger, one line later:

> every failure here is a warning, never an abort: reconcile discovers an
> unledgered live agent, and **tokens are chrome**.

The ledger, agent refs, lineage records, and reconcile are **observability**.
If every one of them were wrong simultaneously, the result is an unreadable
diagnostic trail — never two writers in one tree.

## Sorting the two epics by the invariant

| | Protects the invariant | Bookkeeping |
|---|---|---|
| **#1776** | "concurrent spawns cannot produce two active workers" (already held — needs a *test*, not a mechanism); remove multi-holder claim creation | high-entropy ref, identity binding, env export, owner-token locking, atomic ledger replacement, fleet capacity |
| **#1775** | *(nothing)* | all seven bullets |

**#1775 protects nothing.** It is orchestration cost and contract hygiene. Real
work, but sized as an optimization and blocking nothing.

## #1808 — the spine

#1808's outcome ("one driver owns the tree, investigators are read-only") *is*
the invariant, generalized to the case where several agents share a checkout.
Today the invariant holds only because shared checkouts are banned outright.
#1808 keeps the invariant while lifting the ban.

Its issue body is already well-formed and its scope stands as written. Two points
the implementation must carry:

### It supersedes merged code that argues against it

`fleet.sh` carries GH-1774's hard refusal of `spawn_issue_fleet`, with reasoning:

> No amount of claim-holder bookkeeping makes concurrent writes to one checkout
> safe, because the claim is coordinating access to the ISSUE while the damage
> happens to the TREE.
>
> It is removed rather than fixed because there is nothing here to fix.

**This reasoning is correct and must be preserved.** #1808 does not refute it —
it sidesteps it. GH-1774 banned *K sibling writers* in one tree, which is
genuinely unfixable. #1808 proposes *one driver plus N read-only investigators*,
which is not concurrent writing at all.

The edit is therefore narrow: change the ban from "several agents in one tree" to
"several **writers** in one tree", and keep GH-1774's finding intact as the
stated reason why the writer count is capped at one.

### Read-only is enforced, not conventional

`ralph/agents/investigator.md` declares:

```yaml
tools:
  - Read
  - Grep
  - Glob
```

Agent `tools:` is hard runtime enforcement — a missing tool is blocked, not
prompted. (This is the opposite of skill `allowed-tools`, which only
pre-approves.) An investigator has no Bash, no Write, no Edit; it *cannot* write
the tree. This is why #1808 specifies "capability is an allowlist, not prose",
and it is what makes one-driver-plus-N-investigators safe where K-siblings was
not.

### Scope (from the issue, unchanged)

- Add `role` to the C8 token vocabulary: orchestrator, driver, investigator,
  tender, relay, watcher. Today `role` is only the lane letter (`role: $lane` in
  `lib.sh:289`).
- Reshape `spawn_issue_fleet` to one driver plus N investigators in the driver's
  worktree.
- Enforce 1 driver : 1 worktree **structurally** — a second driver is refused,
  naming the live driver, rather than arbitrated by a lock.
- Bind investigators to `ralph/agents/investigator.md`.
- Encode graph edge rules at spawn: human → orchestrator or driver; orchestrator
  → driver, investigator, or tender; driver → investigator only; investigators
  are leaves; relay and watcher take no children.
- Record `role` in the lineage record; depth cap stays at 3.
- Two drivers on one issue is a **decomposition signal** — split into sub-issues
  rather than sharing a branch, since git refuses one branch in two worktrees.
  This preserves GH-1774's replacement strategy verbatim.

### Acceptance

- A shared-issue fleet has exactly one writer; investigators cannot mutate the
  tree, enforced by allowlist rather than convention.
- A second driver in one worktree is refused with the live driver named.
- Spawn refuses any forbidden edge, including an investigator spawning anything
  and a driver spawning a driver.
- `role` is present on every spawned agent's tokens and in its lineage record.

## #1776 — reshaped

Shrinks from eight bullets to three, plus a rider.

1. **A deterministic race schedule proving one-writer-per-tree.** The mechanism
   already exists; what is missing is a test that pins it. This is the only part
   of #1776 that touches the invariant.
2. **Remove multi-holder claim creation.** Readers and doctor checks continue to
   *recognize* existing Claim v2 values in order to report and clean state
   already written — that is the standing policy in `fleet.sh` and does not
   change. Nothing creates them.
3. **Fix the two bare-name join sites.** `attend.sh:61` and `ledger.sh:328`
   match on `split("#")[0]`, deliberately discarding the epoch, so a stale
   generation matches a live one. This is the real "replace bare-name matching"
   defect and the ghost-worker path in #1776's acceptance criteria.

**Rider:** widen the agent-ref mint. `naming.sh:192` derives a 16-bit epoch from
`cksum(date +%s, $$)`, so N agents spawned in one second from one process get
identical epochs — observed today (`#12d9` × 4 in one fleet run). This does *not*
currently cause key collisions, because every join keys on the full
`name#epoch` and names differ across a fleet. The exposure is narrow: two
generations of the *same* name in the same second, or a birthday collision at 16
bits (~0.08% across 10 generations of one name). Latent, low-probability,
one-line fix — it rides along, it does not justify anything.

**Removed from scope** as bookkeeping: identity binding, env export of claim
holder, owner-token locking, atomic ledger replacement, lifecycle-aware fleet
capacity.

## #1775 — demoted

Pure optimization, no dependents, blocks nothing.

The measurable cost: `reconcile.sh` globs `ledger_root/*/*/ledger.jsonl` twice
(phases A and C) with nested per-ref loops, and re-probes `agent list` mid-pass.
Bounding this is worth doing on its own merits.

Its contract-hygiene half — generated schemas, structural lints, protocol-19
fixtures, call-count and timing tests — is separable from its cost half and may
be split again if it grows.

## Consequences

- **#1808 is unblocked from #1776 in spirit but not in fact.** #1808's body
  declares `Depends on #1776`. Under this reshaping, what #1808 actually needs
  from #1776 is item 2 (remove multi-holder claim creation), since #1808's own
  Notes reconcile with that line. The dependency should be re-scoped to that
  item, not the whole issue.
- **#1775 should be un-blocked from everything and re-prioritised** as an
  optimization.
- The invariant should be stated once, in `plugin/ralph-herdr/README.md` or
  `ralph/CLAUDE.md`, so future changes can be tested against it rather than
  re-deriving it from `fleet.sh` comments.

## Open questions

None blocking. One worth deciding during implementation: whether investigators
in the driver's worktree earn their keep over in-process `ralph:investigator`
agents dispatched via the Agent tool, which need no worktree at all. #1808's
value is the *structural refusal* of a second driver; the investigator-placement
half may be smaller than it looks.
