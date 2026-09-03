# GH-2426: should `pollDue` gate on a known GraphQL rate-limit reset?

Decision record for `board move 2426 done --decision`. No code path changes
behavior; `plugin/ralph-herdr/cockpit/model.go`'s `pollDue` gained a doc-comment
pointer to this record so the question isn't re-litigated from scratch.

## Question

GH-2386 (PR #2423) built and then **backed out** a banner that named the
GitHub rate-limit reset instant as the cockpit's "next poll" time, because
`pollDue` doesn't actually wait for it — it only ever gates on
`lastPoll + pollEvery`, and a keypress or write-stamp can fetch immediately
regardless. The banner was rewritten to show the cadence `pollDue` truly
keeps (commit `0864629f`).

GH-2426 asks the question GH-2386 declined to answer at the time: should
`pollDue` be changed so that promise becomes true — i.e., should the
scheduler actually wait out a known rate-limit reset before issuing the next
board read?

## Answer: no

`pollDue` should keep gating on `lastPoll + pollEvery` alone. Do not fold a
rate-limit reset into the scheduling decision, now or with a better reset
source, unless the calculus below changes.

## Reasoning

**1. The only reset source in reach is proven unreliable.** The cockpit's
`rateProbe` (`fetch.go:987-1008`) reads `gh api rate_limit`'s REST `graphql`
sub-bucket. GH-2278 measured that sub-bucket mirroring `core` and reporting
5000 remaining while GraphQL itself read 0 — i.e., exactly backwards from
what a scheduling gate needs (a reset time that looks urgent when nothing is
actually wrong, or looks fine when the budget is actually exhausted). Gating
scheduling on this source could stall the cockpit's board column for up to
`RALPH_COCKPIT_INTERVAL_MAX` past a *wrong* reset — nothing in `pollDue`'s
current design bounds a stall caused by a bad input, because the whole point
of gating would be to skip polls the code currently insists on making.

**2. The authoritative source doesn't reach the cockpit today.** GraphQL's
own `rateLimit{resetAt}` is what board.ts prints in its exit-75
`RATE_LIMITED` stderr — a string the cockpit would have to parse out of a
subprocess failure, not a value it can query on demand without spending a
process round-trip itself. Moving the probe to `gh api graphql
'{rateLimit{remaining resetAt}}'` (the GH-2278 rule, already used by
`gh-budget.sh`'s `gb_snapshot graphql`) is possible, but it only fixes
concern 1 — it does not remove concern 3.

**3. The savings are small and already bounded; the failure mode is not.**
`backoff()` already caps `pollEvery` at `cfg.MaxInterval` (default 300s).
Over a worst-case 60-minute rate-limit window that's on the order of 10-12
wasted read attempts — each one a `gh` process spawn that fails fast on a
rejected request, not a real GraphQL point spend (a rejected call is billed
nothing). Trading that bounded, cheap waste for an unbounded-by-a-bad-signal
stall — on the one queue (the board column) the cockpit exists to keep
current — is a bad trade even with a trustworthy reset, because:

**4. Bypass semantics would have to be re-litigated for every existing snap
path.** `snapToFloor()` is called from a keypress, an answer/spawn write the
cockpit itself performs, and the write-stamp path (`update.go:117,158,265,
443,452,482,495,498-499`). A reset gate would need an explicit answer for
each of those — does a keypress override a known reset, or does the operator
sit looking at a frozen board because the code "knows" the request would
fail? Every "yes it bypasses" answer re-derives the situation `pollDue`
already handles today (poll now, let the read fail, show the honest error);
every "no it doesn't" answer makes the cockpit *less* responsive than the
status quo during exactly the window an operator is most likely to be
watching it for a state change.

## What would change this

If a future incident shows the *current* bounded waste is actually costly
(e.g., `RALPH_COCKPIT_INTERVAL_MAX` gets set low fleet-wide and rate-limit
windows recur often enough to matter), the fix is still not a scheduling
gate — it's probing `gh api graphql '{rateLimit{...}}'` once per read
failure (already close to what `rateProbe.get()` does) and improving the
*banner text* only, the way GH-2386 already chose. A gate remains the wrong
shape because of point 4 regardless of source reliability.

## Related

- GH-2386 / PR #2423 / commit `0864629f` — built and removed the resetAt
  banner plumbing this issue asks about extending into real scheduling.
- GH-2278 — established that GraphQL's own `rateLimit` field is the only
  trustworthy budget read; REST `rate_limit`'s `graphql` sub-bucket mirrors
  `core` and lies.
- GH-1805 — the adaptive cadence (`pollEvery`, `backoff`, `snapToFloor`,
  `blurToCeiling`) this decision leaves unchanged.
