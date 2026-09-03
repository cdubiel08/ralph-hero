---
date: 2026-09-02
issue: GH-1692, GH-1961, GH-2261, GH-1841, GH-2052
topic: Apply units (merge ≠ done) — full rationale behind the close-gate ancestry check
status: shipped
---

# Apply units — full rationale

`CLAUDE.md` states the rules (decomposition, merge gate 6, close gate,
surfacing); this file carries the ancestry-check history.

## Why a run must descend from the fix merge (GH-1961)

`apply-evidence.sh`'s `kind=run` evidence must bind `run.head_sha ==
merge_sha` — and, since that proves which tree the run checked out but not
that the operator named the right tree, the script also refuses a run that
does not descend from the fix merge. A run triggered before the fix landed
is recent, green, and produces a healthy artifact while having executed the
*old* workflow file, because `actions/checkout` pins to the run's own event
SHA; recency and a green conclusion are not ancestry.

The fix merge is **derived, never typed** — the apply unit's `blockedBy`
twin is the ship issue and its merged closing PR carries the commit — so the
rule needs no prose to find its subject. A candidate counts as a required
ancestor only if it is **reachable from the default branch** — tested, not
read off the PR's recorded base name, which is a proxy that a branch rename
silently invalidates while history survives it; a merge into a stacked base
that never landed is still excluded, which is what the proxy was there for.

`--fix-merge <sha>` **adds** to the derived set and can never suppress it: an
override that replaced derivation would let an operator name a weak
ancestor and skip the real fix, which is this issue's own defect handed a
flag.

The two failure modes are deliberately not alike: a question with **no
subject** (no twin, no closing PR merged to the default branch) records
`ancestry: not_evaluated` *with a reason* and proceeds, since a
settings-only unit legitimately has no ship twin; a question **with** a
subject that the compare API leaves unanswered **refuses and posts
nothing**, because a failed read rendering as a pass is the very defect the
check removes, and evidence is the one artifact no later reader re-opens.
`--fix-merge <sha>` gives the no-subject case a subject.

## The reason is typed, and the gate reads it (GH-2261)

That two-failure-mode rule was applied to the compare API and missed by the
reads that go *looking* for the subject: an unreadable `blockedBy` twin, an
unreadable default branch, and an unresolvable repo all landed in the
no-subject bucket, warned, and posted at exit 0 — and `board.ts` never read
`ancestry` at all, so the whole protection lived in one script's refusal
path with a hole in it (#2161 closed through it; safe only because a human
re-derived the ancestry by hand).

`ancestry.reason_code` is now an enum — `no_subject` vs `read_failed` (with
`failed_read` naming which read, `repo_resolution` never borrowing the
API-read string for something that never reached the API) — the script
refuses every `read_failed` before composing anything, and
`validateApplyEvidence` accepts `descends` and `not_evaluated: no_subject`
while refusing `read_failed`. So the settings-only population passes **by
construction**, needing no operator assertion: an escape hatch the
legitimate majority must use every time stops being read and becomes the
path, which is the `--why` failure GH-2198 fixed.

`--fix-merge` does not rescue a failed read either — it adds to the derived
set and can never replace it, so proceeding on an operator sha while the
derivation is unknown is the same weak-ancestor substitution the flag is
barred from making.

## Absence vs. failure (GH-1841's precedent)

An **absent** `ancestry` refuses rather than passing (GH-1841's missing-
`base_ref` call): it predates the binding so it cannot answer the question,
and a validator accepting absence would pass every pre-existing test and
inherit the entire hole — but the refusal binds **forward only**, on the
payload's own `applied_at` against one dated constant.

GH-1841 could treat absence as a one-time re-attest because attestations are
in flight; apply evidence is swept by `apply-closed-unevidenced` over every
closed apply unit forever and its `--fix` REOPENS them, so an unbounded
refusal would have had a 15-minute cron resurrect five finished pre-field
closes (#1697, #1728, #1739, #1771, #1953) whose ancestry nobody can now
re-derive — GH-2052's unsatisfiable remedy. The bound is on the payload, not
on a sweep or a caller, so there is still one predicate and no second
reader; it is self-closing, since every payload the script can produce
carries ancestry; and it grandfathers ABSENCE only — a pre-epoch payload
carrying `read_failed` is still refused.

GH-1961 now has two enforcement points; neither is load-bearing alone.
