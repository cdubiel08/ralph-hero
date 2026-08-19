# Operating discipline — reading evidence without fooling yourself

Contract rule 7 says gates are run, not predicted. These are the measured ways
sessions broke that rule **while believing they complied** — each one observed
on the reference board, dated, and paid for. They are not steps to follow; they
are how to read what the tools actually said. Where a rule has since grown a
code half (a hook, a counter, a status), the code is the guarantee and the rule
here is why it exists — a host repo without that code gets only the rule, which
is exactly when it matters.

## 1. Empty output is never evidence

A command that failed and a command that legitimately returned nothing print
**identically** — and a filter (`grep -v`, `--jq`) launders the failure into a
clean-looking result. Before reporting "no PR", "all green", "queue empty",
"nothing there": re-read capturing the success signal separately —

```sh
cmd > /tmp/out 2>/tmp/err; echo "exit=$? bytes=$(wc -c < /tmp/out)"
```

Never batch queries whose failures are silent — one labelled call per line, or
a failed read collapses onto the surviving value and two issues read as one.
"I could not read" is its own outcome, never folded into "no change" or "still
quiet". A flapping API is recovered after **two consecutive** successful
probes, not one. Measured hit rate during a 2026-08-14 network flap: roughly
one failed-silent read in three.

Corollary: a second source corroborates only if its coverage window includes
the event. Two sources agreeing while neither could have seen the failure is
*worse* than one source — it manufactures confidence. When timing matters,
start the instrument before triggering the event.

## 2. The watch is part of the push

In a repo wired for automatic review, every push to a PR branch draws a
reviewer pass on its own — nobody has to request one. So "pushed, stopping" is
never a finished state: CI failures and review findings sit undiscovered while
the human assumes someone is on it. After any push, in the same turn, watch the
gate to a **terminal verdict** — `bash scripts/pr-gate-watch.sh PR --watch`
where the repo ships it, the repo's own checks/review surfaces to a settled
conclusion otherwise — and act on a verdict that names you rather than
reporting the wait. This holds even when told not to *trigger* a review
(triggering and watching are different things) and even when you expect the
work to be clean.

Never substitute a `gh pr checks` poll loop: where a status is pending by
design until a later step (ralph's attestation is), the loop cannot terminate,
and its silence is indistinguishable from CI still running.

## 3. Async reviewer and CI state needs settle time

External reviewers and CI land 1–3+ minutes after their trigger. A read seconds
later is an intermediate state, not a verdict — declaring it "stuck" and firing
a corrective command races the first trigger and hands back a stale, wrong
picture (observed: an APPROVED landing 72 s after the trigger, 12 s after the
session had already escalated). Wait a realistic settle window (~2–3 min, or
watch the state) before concluding stuck; never issue a second corrective
command while the first is unconfirmed. A bot's disclaimer text is not evidence
the trigger failed.

## 4. Review threads are ground truth — a passing gate is not evidence of no findings

Merge gates typically block on a subset of findings (ralph's gate 5: P0 only),
and some reviewers' status checks are **completion-only** — `pass` regardless
of findings. So a green gate and all-green checks say nothing about what is
outstanding. The work list is the review threads themselves: `isResolved:
false`, queried after each push *and again immediately before merging*.
Adjudicated-and-rejected is fine — reply in-thread with the reasoning; unread
is not. Never dismiss a finding by timestamp: GitHub re-anchors
still-applicable comments to the new head, so an "old" comment can be live.

The failure mode is not forgetting this rule — it is the rule silently losing
its trigger. It was learned when the reviewer *blocked*, so a green PR implied
nothing outstanding; when the reviewer stopped blocking, four consecutive PRs
merged or near-merged over valid unresolved findings before anyone noticed.
Where the repo counts advisory findings into the gate-watch verdict (GH-1945),
the count is the reminder — but a count of zero is not a clean PR, and `NO
ADVISORY REVIEW AT THIS HEAD` is not zero (GH-1971).

## 5. Never type an unearned verdict

Every field in an attestation or evidence comment is a claim you personally
observed. Review verdicts come from `gh pr view --json reviews` and nowhere
else — a green reviewer **check** is not a review; it passes while rate-limited.
Test results come from observed exit codes (`attest-pr.sh --run`), never a
hand-typed code. A required field with no truth behind it yet means wait: a
PENDING gate is the honest state, not a failure. The one time this was
violated, the gate independently verified and refused — but the attestation
comment is the repo's evidence record, and a false claim in it is exactly the
failure the gate exists to catch. If you have already claimed something false,
post a visible correction.

## 6. A snapshot ages between read and act

Any value derived from shared state — a queue, a merge order, a peer's routing,
your own earlier read — can be false by the time you act on it, and the window
between reading and acting is exactly when the fleet moves. Re-read at the
moment of action. Treat any coordinator's or peer's routing as advisory, never
as a verdict you may rely on, and say so when you are the one routing. This is
rule 7's general form: the gate re-reads reality at the merge instant, and so
do you at yours — which is also why rules 1–5 all end in a fresh read rather
than a remembered one.
