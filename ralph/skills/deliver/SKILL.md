---
description: Shepherd In Review PRs from open to merged — one pass over the deliver queue. Reacts to concluded checks, review deltas, stale attestations, and merge-gate PENDING verdicts; maintains branch topology; escalates semantic rework to the lead; closes out items whose PRs already merged. Mechanical remediation only — never authors feature semantics, never demotes on its own judgment. Triggers on "deliver", "shepherd the review queue", "work the In Review items", "chase the open PRs".
argument-hint: "[<issue-number> | (empty = take the deliver queue's next)]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# /ralph:deliver — follow-through, not authorship

One pass over the deliver lane: the In Review items whose open PRs have an actionable signal. `/ralph:work` runs the gates once at PR-up (its rule 7); this lane owns everything rule 7 deliberately does not — the follow-through after that session exited (gates pending, a review that landed later, an attestation unbound by a later push, a merged PR whose issue never closed). You remediate mechanically and merge through the host repo's own gate; you never author feature semantics.

The board CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder resolves to wherever this plugin is installed; never substitute a repo-relative path. Below, `board` is shorthand for it.

## Judgment boundary (Sonnet-may / lead-decides, GH-2353)

Two classes of call, so a pass never blurs them. **Yours alone, no
escalation** — every mechanical remediation this file names: re-run flakes,
fix lint/format, `--run` re-attestation, reviewer nudges, evidence-only thread
replies, rebase/push through the lease, marker and log upkeep, and the
post-merge reconciliation that yields to `reconcile`. None of these change
what the PR *does* — they get an existing, gate-legible fact back in front of
the gate.

**The lead's call, escalated — never executed by this lane**
(`board move NNN human-needed --why "…"`, composed per
[../work/references/escalation.md](../work/references/escalation.md), which
addresses the lead by default when this session has one, GH-2179): whether a
genuinely failing test at unchanged semantics is real rework rather than a
flake that looked convincing, whether an advisory P1/P2 finding is serious
enough to hold the merge though the gate does not block on it, an unclassified
gate FAIL, and anything that would change the unit's scope. **Rework demotion
specifically is the lead's decision, not this lane's**: post the findings
comment (the evidence — which threads, which test, why it reads as rework and
not flake) and escalate with your read; never run the two-hop demotion
yourself. A confirming answer resumes the item to In Progress under the
answering session's own claim (GH-2204) — that session either drives the
rework directly or releases it to Backlog for the next `/ralph:work` pass to
pick up. Solo (no `$RALPH_HERDR_LEAD`), the same escalation lands on the human
exactly as it always has — nothing about the boundary changes without a lead
in the loop.

## One pass

`board deliver-queue --json` picks the work: take `next` (or the argument's issue if given — it must be in the queue). Empty `next` ⇒ nothing to do: write the exit report and stop. Handle ONE item per pass, end to end, then exit at a surfaced state. You are a single-pass operator: whatever invoked you decides whether and when another pass happens — never arrange one yourself, and never wait around for state to change.

Inherited from /ralph:work, verbatim: board truthful at all times; exit only at surfaced states; findings outlive the transcript; decisions journaled via `board comment`; gates are run, not predicted; scope is the selected item. So is the evidence discipline those rules assume — [../work/references/discipline.md](../work/references/discipline.md): empty output is never evidence, the watch is part of the push, async state needs settle time, threads outrank gates, verdicts are observed never typed.

## The gate decides — you react to its token

Merge exclusively through the host repo's own gate: `bash scripts/merge-pr.sh PR` where the repo ships it (**never `--force` — contract rule**: any situation that seems to need it is Human Needed with the gate output quoted). Map outcomes on the machine-parseable `MERGE GATE <verdict> — <gate>` token, never the bare exit code:

- **PENDING** (exit 75) — evidence not in yet. Leave In Review, journal, exit. Not a failure.
- **FAIL — state** — re-read reality: the PR is usually already merged (native auto-merge, or a prior run). Treat per the post-merge rule below; anything else → Human Needed.
- **FAIL — mergeable** — CONFLICTING → record `git rev-parse origin/<branch>` first, rebase onto main, resolve preserving both sides' stated intent, push **through the lease** (see the push rule below), exit at In Review (quiescence restarts the clock). UNKNOWN → wait, exit at In Review; never rebase or push on mere uncertainty.
- **FAIL — checks** — remediate mechanically: re-run flakes, fix lint/format. A genuinely failing test at unchanged semantics is a rework signal → escalate per the Judgment boundary above, never demote yourself.
- **FAIL — review** (CHANGES_REQUESTED) — **run `bash scripts/review-staleness.sh PR` before demoting (GH-1816).** `reviewDecision` carries no commit binding, so a CHANGES_REQUESTED keeps blocking after its findings were fixed and pushed, until the reviewer re-reviews — hours later when it is rate-limited, which is the normal shape of a round, not a race. Map its `verdict`: **`live`** (a blocking review bound to the current head) → escalate per the Judgment boundary above (post the findings comment, then hand the rework call to the lead), never demote yourself. **`stale`** (every blocking review predates the head) → **do not demote**: the item awaits evidence, not the author. Hold at In Review, post one comment naming the blocking review, its commit, and the current head, and — if no nudge has been posted at this head yet — post the reviewer nudge below; then exit. **Anything else** (`not-evaluated`, an absent script, unusable output) → escalate per the Judgment boundary above, exactly as the `live` case does: an unreadable answer never proves the verdict is stale, and this fix may not become under-demotion where it cannot see. Either way the merge still refuses; gate 1 is unchanged and unforceable.
- **FAIL — attestation** — re-run the attested commands at the current head via `scripts/attest-pr.sh PR --run "<cmd>" --carry-review` — **contract rules: re-attestation only ever through `--run` (observed exit codes, never caller-typed), and the review verdict only ever carried forward, never authored or retyped**. Commands fail → escalate per the Judgment boundary above. Refusals key on their tokens, never the shared exit code: `ATTESTATION REFUSED — head moved` is not a test failure (re-check quiescence, retry once, else exit at In Review); `ATTESTATION REFUSED — no prior review` → Human Needed, never a fresh self-approval.
- Any unclassified FAIL → Human Needed with the gate output quoted.

Reviewer nudges take the shape the merge policy declares. When
`external_review.head_marker` is absent, the reviewer files formal APPROVED
reviews and the nudge is just the policy's `external_review.trigger` — do not
invent a marker it never reads. When the policy declares `head_marker`
(findings mode, which is what this repo runs), the nudge is an exact two-line
comment: the trigger, then `<!-- <head_marker>: <full-head-sha> -->` using the
current 40-character head SHA. With the current policy, the body is:

```text
@codex review for P0 issues only
<!-- ralph-review-head: <full-head-sha> -->
```

Post that body **once per head SHA** — one review per head is the bound, not a
default. The gate then passes once the bot has answered at that head — a
findings review, or its comment naming the reviewed commit — with no P0 thread
unresolved; P1/P2 are advisory, adjudicated by you, and never block. Clearing a
P0 has two honest verbs: fix it (the thread goes outdated) or resolve the thread
once adjudicated. **Resolving fires no workflow event** GitHub will accept, so
the `ralph-attestation` status does not recompute on its own — post any PR
comment after resolving and it does. Never substitute another reviewer's trigger. Read
rate-limiting from the reviewer's check *description*, never its state. Thread
replies are evidence-only — commit link, line link, test output link; anything
argumentative is a rework signal, not a reply.

**Stop when the findings stop shrinking (GH-1849).** One review per head bounds
each round; nothing bounded the number of rounds, and PR #1764 ran 33 of them
(#1755 ran 17) with findings growing 5 → 19 → 22 as each fix pass widened the
blast radius. Before posting another nudge, run
`bash scripts/review-convergence.sh PR` — `pr-gate-watch.sh` already appends its
two stopping verdicts to `GATE-YOURS review`, so in the normal flow you will
have read it without asking:

- **`stalled`** — blocking findings did not strictly decrease across the last
  two completed passes.
- **`cap-reached`** — the round budget is spent (`--cap`, else
  `$RALPH_REVIEW_ROUND_CAP`, else 5; **set 2 in an unattended lane**, where the
  budget being burned is a session nobody is watching).

Either one means **stop iterating and escalate** — `board move NNN human-needed`
with the series quoted, composed per
[../work/references/escalation.md](../work/references/escalation.md) — rather
than requesting another review. Hitting the cap is an escalation, **not a
failure**: the work may be perfectly good, it is the loop that is out of budget,
and a human choosing to split the diff or accept the findings is the cheap move
the 33rd round is not. `converged` (no blocking findings at the latest pass) is
the terminal *success* and outranks the cap — a clean review is never blocked
for having been pushed often.

The rule still gates **nothing at the merge path**; what it now does gate is
which work the lane PICKS UP (GH-1977). `board deliver-queue` runs the same
script on the rows that reach the queue (budget `RALPH_DELIVER_CONVERGENCE_MAX`,
3) and holds a `stalled`/`cap-reached` PR out of `queue` as its own
**`convergence-stalled`** blocked row, carrying the verdict and detail. It is
surfaced rather than withheld — a stalled PR that simply vanished would read
exactly like one that merged — and the selector never escalates on its own: the
`board move NNN human-needed` is still yours. An unreadable verdict blocks
nothing. That check exists for the *unattended* lane, which is the population
the cap protects, since prose cannot stop a lane nobody is watching.

### A unit a live session is driving is not yours (GH-1929)

`deliver-push.sh` wins the branch at the **push instant** — but a work session
sitting on **unpushed local commits** emits no remote signal at all, so every
check above reads a quiet PR and the rebase lands anyway. That session's next
push then conflicts loudly: the "messy-but-recoverable" outcome the lanes spec
named as residue §8.2.

The lease that closes it already existed; nobody read it. `board claim` takes a
per-(worktree, unit) lock (GH-1956) at the one acquisition point contract rule 1
makes mandatory — so it is not a convention that can be stripped. `board
deliver-queue` now reads it, and a unit held by a *live foreign session on this
machine* is refused **entirely**, before any PR-shaped reasoning, as a
**`local-session-active`** blocked row naming the holder's worktree.

Two things follow. It is **self-clearing** — `windowExpiresAt` is the lock's own
`RALPH_LOCK_TTL_MIN` expiry, so a dead session costs one TTL and no human, and
`board claim NNN --steal` is the same explicit assertion the claim path already
documents. The lease deliberately outlives the board claim — releasing it on the move to In
Review would make it unobservable, since In Review is the only state this queue
reads — so a unit's pickup latency can be a full TTL rather than the ~5-min
settle window. That is the accepted price; no "I'm finished" verb reclaims it,
because a verb whose omission restores the hazard is residue §8.3 by
construction.

And it is **same-machine only**: a deliver loop on another host sees
no lock and residue §8.2 survives there — correctly, since unpushed commits are
themselves a machine-local fact that no remote reader could ever have observed.

## Close-out, demotion, safety rails

- **`no-open-pr` rows**: verify at least one linked PR actually MERGED, then `board move NNN done` (the Done-evidence guard accepts either linkage this lane uses — a closing-reference merged PR, or one merged on this issue's branch — so `--why` is for a completion with no merged PR at all, GH-1732). A linked PR closed *unmerged* → Human Needed with the finding, the escalation composed per [../work/references/escalation.md](../work/references/escalation.md). This lane is the only thing that un-strands these. **Apply units are different by design**: on an apply-labeled item the close gate refuses Done without `ralph-apply-evidence:v1` — that refusal means the deploy, not the merge, is the outcome; leave it open (or escalate), never route around the gate.
- **Post-merge state writes yield to reconcile — contract rule.** After a successful merge (or FAIL — state on an already-merged PR), re-read the issue: already Done/Canceled means the event lane won — journal and exit. Only `board move NNN done` when the issue did not auto-close, and treat a refusal (lost race) as success after re-read.
- **Rework escalation** (see Judgment boundary — never self-executed): post ONE findings comment enumerating every unresolved thread, then `board move NNN human-needed --why "<the findings, and why they read as rework rather than flake>"`. Whether this really is rework, and driving it, is the lead's or human's call, not this lane's: never run the two-hop demotion yourself, and never self-fix semantics — any change a reviewer would call a design decision belongs to a work session someone dispatches after confirming.
- **Stack safety**: before merging a PR that is the base of another open PR, retarget the dependent first — GitHub *closes*, not retargets, dependents on base-branch deletion.
- **Every push goes through the lease — contract rule.** Never `git push` a PR branch directly, and never `--force`. Record the remote head **before** rebasing (`git rev-parse origin/<branch>`), then push with `bash ${CLAUDE_PLUGIN_ROOT}/scripts/deliver-push.sh --branch <branch> --expect <that-sha>`. Map the `DELIVER PUSH <verdict>` token, never the bare exit code: **PENDING** (exit 75, lease refused — a peer moved the branch) → abandon the push, leave the branch alone, exit at In Review; **WARN — noop** → nothing was pushed and the lease was never evaluated, so do not report it as a successful push; **FAIL** → Human Needed with the output quoted. A refused lease is this gate working, not an error: never retry it with a wider hammer.
- **Pre-push quiescence re-check**: immediately before any push (rebase, conflict fix, format), re-check the item is still quiescent (`board deliver-queue --json` — the item must not read `settling`); fresh activity aborts the push, exit at In Review. **Know what this check cannot see** (GH-1917): quiescence is computed from *remote* signals only — state change, issue comment, open-PR activity (the deliver-queue quiescence guard in `board.ts`). A live interactive `/ralph:work` session editing files locally emits none of them, so for that hazard this re-check is not an independent second guard; it is the settle-window predicate sampled twice. The lease above is what actually excludes that session, because it is the only check with an atomic winner.
- Host repos without `scripts/merge-pr.sh`: use the repo's native merge flow and branch protection; never import ralph-hero's policy.

## Exit — every pass, even an empty one

1. Update the item's marker so the selector can gate re-selection: PATCH (or post) the issue's `<!-- ralph-deliver:v1 -->` comment with fenced JSON, one entry per PR you touched (`at` = now; `verdict`/`gate` = the last gate token you observed; unknown cursors are `null`). On a `FAIL — review` also record `"review_staleness"` — `live`, `stale`, or `not-evaluated` — so the trail shows which of the two judgements the pass made rather than leaving a held item and a demoted one identical (GH-1816); omit it on every other verdict. Only sessions write this marker; the selector reads it. Example:

   ```json
   {"prs": {"1730": {"head_sha": "f47fa9a8c0ffee00", "verdict": "PENDING", "gate": "external-review", "check_conclusions": "board-tests=success,test-hooks=success", "review_cursor": "2026-08-09T03:10:00Z", "thread_cursor": null, "at": "2026-08-09T03:12:00Z"}}}
   ```

2. `mkdir -p "$RALPH_HOME"` (default `~/.ralph`) first, then append `<iso8601> deliver GH-<n> rc=<code> checked=<N> acted=<M>` to `$RALPH_HOME/deliver.outcomes.log` and touch `$RALPH_HOME/deliver.heartbeat` — surface a write failure rather than swallowing it; a lane always logging `checked=0` must be visibly dead, never silently green. An empty pass (no item selected) writes `GH-none` in the subject slot; the line still lands.
3. Report, as your final output: `checked`/`acted` counts, the blocked-reason set from the queue read, and the earliest `windowExpiresAt` among time-bounded rows (`settling`, `retry-window`, `deferred`). The lane's goal state — for whatever invoked you — is: empty `next` AND no time-bounded blocked rows; rows only a human can clear (`no-pr`, `convergence-stalled`, Human Needed) don't count against it. `local-session-active` IS time-bounded — it clears itself on the lock's TTL — so it counts like the others.
