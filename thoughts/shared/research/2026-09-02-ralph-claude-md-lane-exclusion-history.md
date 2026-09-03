---
date: 2026-09-02
issue: GH-1917, GH-1890, GH-1929, GH-1956, GH-2107, GH-2367
topic: Work/deliver mutual exclusion — full rationale behind ralph/CLAUDE.md's stated rule
status: shipped
---

# Work/deliver exclusion — full rationale (GH-1917, GH-1929)

`ralph/CLAUDE.md` states the rule: deliver excludes a push-instant race via
a pinned `--force-with-lease`, and excludes a live local session via the
GH-1956 worktree lock. This file carries why, including the rejected
designs.

## The gap the lanes spec left open

The lanes spec accepted work/deliver exclusion as **probabilistic**: an
interactive `/ralph:work` session never holds `tick.pid`, so if it idles
past `RALPH_SETTLE_MIN` deliver can rebase and push a branch that live
session still owns. The two named mitigations do not cover it. Quiescence
and the pre-push re-check evaluate the *same* predicate — the newest of
state change, issue comment, and open-PR activity (`board.ts:3697-3713`),
all **remote** signals — and a session editing files locally emits none of
them. So the re-check is not an independent second guard for this hazard;
it is the settle window sampled twice. Two mitigations, one blind spot.

## Why a message cannot be the guard

Mutual exclusion needs an atomic winner, and **a message cannot be one**
(GH-1890's finding, and why no channel was built here). Projects V2 has no
compare-and-swap, so the board claim cannot carry it either — and the claim
is gone by then regardless: `transition()` clears it on In Progress → In
Review (`board.ts:2108-2136`) and read-back-throws if the clear did not
stick.

## The push-instant lease (GH-1917)

The contested resource is not a board item — it is a **git branch, and git
ref updates are a real server-side CAS**. That is the primitive
`scripts/deliver-push.sh` uses: a `--force-with-lease` pinned to the head
deliver rebased from, so a work session that pushed first wins and deliver
is refused (`DELIVER PUSH PENDING`, exit 75 — back off, not escalate).
Always pinned, never bare: a bare `--force-with-lease` compares against the
remote-tracking ref, which **any background `git fetch` silently
refreshes** — proved to clobber in `deliver-push.test.ts`, which also keeps
a control case showing a plain force push destroying the work commit
outright.

Honest bound: this excludes at the **push instant**, and only against work
that was *pushed*. This is the load-bearing half of the exclusion, not the
whole of it.

## The unpushed-commits half (GH-1929)

A session holding *unpushed* local commits emits no remote signal, so
quiescence, the pre-push re-check and the pinned lease all read a quiet
branch and deliver rebases anyway — lanes spec residue §8.2.

The fix is not a new lock. `board claim` already publishes a per-(worktree,
unit) record (`takeWorktreeLock`, GH-1956) at the acquisition point
contract rule 1 makes **mandatory**, which is precisely what a branch-level
lease could not have promised — GH-1929's own second design question, and
why this does not land as residue §8.3 ("conventions fail open by nature"):
no user script can strip a lock taken inside the CLI's claim path.

Two non-accidental properties make it readable from outside the owning
session — the sessions dir is machine-shared, and the issue number is in
the **filename** — so `localSessionLease()` names every live holder with
one `readdir` and zero API cost, which matters on a walk running at the
1-pt GraphQL floor. `classifyDeliver` refuses a held unit **entirely**,
before any PR-shaped reasoning (the hazard is invisible to every check that
follows, so no amount of looking at the PR can rule it out), and surfaces
it as a `local-session-active` blocked row — the GH-1977 precedent: a row
that merely vanished would read exactly like one that merged.

**Rejected**: a new `refs/ralph/lease/<branch>` ref (GH-1929's first
option) — a second lock needing its own expiry and heartbeat semantics, for
a hazard that never leaves the machine.

Reusing the record settles expiry by inheritance: the **same
`RALPH_LOCK_TTL_MIN` clock** as the board claim, so the row is
self-clearing (`windowExpiresAt` is the lock's expiry, unlike
`convergence-stalled`, which only a human clears) and a dead session blocks
deliver for one TTL, not forever.

**The lease deliberately outlives the claim, and that costs latency.**
Clearing the lock wherever `transition()` clears the claim would give the
two one coherent lifecycle — and would make this dead code, since
`deliver-queue` only ever considers *In Review* items, so a lease released
on entering In Review is one the probe can never observe. The lease must
outlive In Progress or it does nothing. The price is that deliver's pickup
latency for a unit becomes up to `RALPH_LOCK_TTL_MIN` (120 min) after the
driving session's last claim touch, rather than the ~5-min
`RALPH_SETTLE_MIN` window. No "I am finished" verb was added to reclaim it:
that would be precisely the opt-in convention residue §8.3 warns about,
whose *omission* — the default — silently restores the hazard. TTL-only
fails in the safe direction (it over-blocks deliver; it never loses a
commit), the operator has the knob, and `--steal` is the immediate
override.

**Two edges are the exception: In Progress → Backlog clears the session's
own lock (GH-2107), and so does every move into Done or Canceled
(GH-2367)** — a closed unit has no driver and no deliver pass left to read
the lease, and a lock left behind by a self-close is a tombstone
`reap-leases` cannot see when the checkout is the main repo (#2242 sat four
days). That edge — `board release` and the `move backlog --why` demotion —
returns the unit to the eligible pool, where the lock guards nothing
deliver reads (deliver-queue considers In Review only) and blocks exactly
the spawn the release exists to permit: measured as answer → release →
`work-fleet` SKIP for a full TTL.

Own lock only (a fresh lock naming another session is a live driver a
non-owning demoter may not disarm), deleted after the state write and
claim-clear verify, best-effort — a failed unlink restores the TTL status
quo, never blocks the release.

Three stated bounds: an unreadable sessions dir returns **null, never an
empty probe** — "we could not read the lease" must not render as "no lease
is held" — and this covers a **same-machine** deliver only. Residue §8.2
survives for a deliver loop on another host, correctly: unpushed commits
are a machine-local fact, so there was never anything for a remote reader
to see.
