---
date: 2026-09-02
issue: GH-1847, GH-2087, GH-1945, GH-1971, GH-1843, GH-1842, GH-1940, GH-1849, GH-1977, GH-2057, GH-2058, GH-1841, GH-1816
topic: Merge gate family — full rationale behind the rules CLAUDE.md states
status: shipped
---

# Merge gate family — full rationale

`CLAUDE.md`'s Merge Gate section states what each gate checks and what
`pr-gate-watch.sh` reports. This file carries the incidents and reasoning
behind each rule.

## Gate 5 — one scoped review per head (GH-1847), findings mode (GH-2087)

Two modes, derived from the policy: `review` (a formal APPROVED review at the
head — every reviewer that has that verb) and **findings**, opted into by
naming `head_marker`, for reviewers that do not.

**Findings mode carries two request protocols (GH-2087)**: the comment-marker
protocol (Codex), and `request_mode: "review-request"` for GitHub Copilot in
kit host repos — engaged via a review request (the requestable login is
`Copilot`; reviews are filed by `copilot-pull-request-reviewer[bot]`, the
default bot when the mode names none), predicate in
`scripts/copilot-review-evidence.sh`, dispatched by all three gate-5 readers.

Measured, not assumed (public corpus, n=31:
`thoughts/shared/research/2026-08-19-copilot-review-evidence-measurement.md`):
a clean diff still files a review ("generated no comments"), so the GH-1847
unsatisfiable-predicate trap does not apply — but a **quota-exhausted
Copilot files a real COMMENTED review at the head** saying it reviewed
nothing (9/31 sampled), so a bare review-object predicate is wrong and the
failure-body family is excluded; no severity markup exists, so **every**
unresolved non-outdated bot thread blocks (fix or resolve — no P0 scoping to
fall back on); an unrecognized `request_mode` fails closed like invalid
JSON, and a request on an unentitled repo is silently dropped (200, nothing
recorded) — read the request back.

This repo runs findings mode against Codex: request exactly ONE review per
head — `@codex review for P0 issues only` plus
`<!-- ralph-review-head: <full-sha> -->` — and the gate passes when the bot
has ANSWERED at that head with **zero unresolved P0 threads**. "Answered" is
a review object at the head *or* a bot comment naming the head commit —
with nothing to say Codex files no review at all (observed on #1853), so a
review-only predicate would be unsatisfiable on exactly the clean PRs it
must pass. The comment test binds on the SHA the reviewer reports, never on
its prose. P1/P2 are advisory: visible, adjudicated by the driver, never
blocking.

The predicate is one script, `scripts/codex-review-evidence.sh`, which
`merge-pr.sh`, `validate-attestation.sh` and `pr-gate-watch.sh` all RUN — the
previous three-copy mirror is what let a gate and its watcher disagree.

Why the inversion: Codex has no APPROVED verb (67 reviews on this repo, 0
clean), and a zero-findings predicate does not terminate on a large diff —
findings grew 5→19→22 across 33 rounds on #1764 — so it acted as an
unlegislated diff-size cap nobody voted for. An OUTDATED thread does not
block: Codex never resolves its own threads, so counting them would rebuild
that trap. Resolving a thread fires no workflow event GitHub accepts
(`pull_request_review_thread` is refused in an `on:` block — it invalidated
the whole file when tried), so after resolving a P0, post any PR comment to
make the required status recompute.

CodeRabbit is gone (GH-1847) — it was a second, redundant reviewer that
blocked through gate 1.

## Sub-P0 findings are counted, never gated (GH-1945)

P1/P2 — and every finding from a reviewer the policy does not gate on —
were advisory by design and *unread* in practice: three consecutive PRs
(#1939/#1941/#1942) merged over valid open findings, because a PR with five
open P1 threads and a PR with none rendered identically on every surface a
driver reads.

`scripts/advisory-findings.sh PR` counts unresolved, non-outdated badged
threads minus the ones gate 5 already blocks on (policy bot + P0), and
`pr-gate-watch.sh` appends the count to the two verdicts whose next move is
toward merge (`GATE-READY`, `GATE-YOURS attestation`). It changes no verdict
and blocks no merge — the judgment stays with the driver; only the
invisibility is fixed.

Reviewer-agnostic **by measurement**: Greptile renders severity as
`<img alt="P1">` and Codex as `![P1 Badge](…)`, so a parser written against
either alone misses the other's findings entirely — and Greptile's own
status check is completion-only (`pass` regardless), which is why its P0 is
counted here rather than left to a gate that does not exist. Zero is
printed (`no unresolved advisory findings`) rather than left as silence,
and an unreadable count says `NOT COUNTED` — "none" and "never ran" must
not read alike.

**A count of zero is not a clean PR (GH-1971).** The count answers what is
outstanding, never whether anyone looked, so a reviewer that is
rate-limited, quota-exhausted or uninstalled produced the words a
reviewed-and-clean PR produces — this line's own founding defect, one layer
in, and live during the capped Greptile trial. The script now reports
`reviewed` beside the count in three states, and an unreviewed head renders
as `NO ADVISORY REVIEW AT THIS HEAD` rather than borrowing clean's wording.
"Reviewed" is the shape gate 5 already uses — a non-dismissed review object
at the head, or a comment naming the head commit — reimplemented rather
than delegated because `codex-review-evidence.sh` binds to the one policy
bot and to a scoped request, while this line is reviewer-agnostic. Two
bounds carry it: the **PR author is excluded** (the driver's own
`ralph-review-head` request comment names the head, so counting it would
make every PR prove its own review — and when the author cannot be read,
comment evidence is skipped rather than trusted), and `reviewed` is **never
inferred from the findings**, since an unresolved thread can be inherited
from an older head. An unreadable history reads `unknown`, never `false`.
The honest limit: a reviewer with nothing to say may file nothing, so
`reviewed:false` diagnoses no cause — it only stops the silence reading as
clean.

## The rules the gates read live in one file (GH-1843)

Gate 5's *predicate* was shared in GH-1847, but everything around it was
not: five scripts — `merge-pr.sh`, `validate-attestation.sh`,
`pr-gate-watch.sh`, `codex-review-evidence.sh`, `advisory-findings.sh` — each
re-derived policy parsing, evidence-mode derivation, the `norm()` bot-login
rule, exempt-author waivers, and the attestation payload's extraction and
validation. Seven review rounds on #1764 produced 20+ findings that were, in
the large majority, one reader disagreeing with another about the same
bytes, in both directions: stricter than the gate is a watcher that never
terminates, looser is `GATE-READY` into a merge that immediately refuses.
Two of them were correct when written and stale when read, because #1839
changed gate 5 mid-review. Each fix was cheap; the class regenerates as long
as the rules live in five places, held together by comments saying "must
change with gate 5" — a convention, not a mechanism.

`scripts/lib/merge-evidence.sh` is now the one reader, published on **two
surfaces over one definition**: `ME_JQ_LIB` (jq source, prepended by
`pr-gate-watch.sh`, which does its work inside a single jq program) and
`me_*` bash wrappers running that same source, for the scripts that step
through gates line by line. A rewrite into either surface alone would have
left the other as the fifth copy.

Three things it fixed on contact: `head_marker` defaulted to `""` in three
readers and `"ralph-review-head"` in a fourth — the mirror bug one edit from
being live; attestation validity now returns a **reason code** rather than a
boolean, because `stale` (re-attest) and `rejected` (a verdict against
merging) have opposite correct responses and a caller that cannot tell them
apart either loops forever or merges over a REJECTED; and a malformed
policy reports a **distinct exit 2**, so every gate fails closed on it while
the two non-gating readers deliberately fall back to defaults. The library
never turns errexit on for a caller that did not have it — it saves and
restores, since a bare `set -e` in a sourced helper silently converts the
caller's next tolerated non-zero exit into an abort.

## The attestation is read from the paginated comment list (GH-1842)

All three readers located the `<!-- ralph-attestation:v1 -->` comment via
`gh pr view --json comments`, which returns a **bounded window** — so on a
PR long enough to matter (#1764: 40+ comments over seven review rounds) a
*valid* attestation falls outside it and reads as absent: the gate refuses a
merge, the validator publishes red, and the watcher demands an attestation
that already exists.

`me_attestation_comment` in `scripts/lib/merge-evidence.sh` is now the one
reader, `--paginate` like gate 5, and the marker has one definition instead
of three copies beside a comment asking them to stay in sync. **An
unreadable comment list is not an absent attestation** — it is a distinct
exit 3, mapped to `MERGE GATE PENDING`, `pending`, and `GATE-WAIT
attestation` respectively, because "retry the read" and "go run
attest-pr.sh" are opposite instructions and collapsing them is what sends a
driver to re-do finished work. Gate 4's evidence is tracked separately from
gate 5's in the watcher (`comments_ok`, not `fetch_ok`): one unreadable read
may not be reported under the other's name.

## A PR body is app-writable (GH-1940)

Greptile edits the pull-request *description* in place, writing its summary
between `<!-- greptile_comment -->` markers (observed on #1939) — any
installed review app with write scope can do the same. Gate 6 rightly does
not regex the body; it reads GitHub's own `closingIssuesReferences`, because
closing keywords are honoured in commit messages too. But that field is
**derived from** the body, so nothing in this repo may treat a PR body as
authored input. The property everything rests on — an app preserves the
author's `Closes #N` when it rewrites the body — is contracted nowhere and
silent if it ever changes: the gate would evaluate a PR that closes
nothing, pass it, and the merge would fold nothing back into the board.

`scripts/pr-linkage-drift.sh PR` asserts the invariant where it is cheap —
every closing keyword still visible in the body or the commits must appear
in the derived linkage — and `pr-gate-watch.sh` appends drift to the same
two merge-ward verdicts as the advisory count. **It gates nothing**, same
split as GH-1945. The load-bearing output is `where`, not the count: a
keyword the *commits* still carry while the *body* has lost it is the
signature of a rewrite.

Biased toward silence by construction — code stripped from the body AND the
commit messages (fenced blocks and inline spans; both halves were proved
necessary by this line's own PR, which tripped on its own body and then on
its own fix commit), own-repo references only (GitHub creates no cross-repo
closing linkage), and each candidate confirmed to be an issue rather than a
PR, since `#N` also spells a pull request and a PR number can never appear
in the linkage. Not evaluated prints `NOT CHECKED`, never intact.

## The review loop has a termination condition (GH-1849), and it gates queue pickup (GH-1977)

One review per head bounds each round; nothing bounded the *number* of
rounds, and #1764 ran 33 of them (#1755, 17) with findings growing
5 → 19 → 22 as each fix pass widened the blast radius — a full session
spent on an unlegislated budget.

`scripts/review-convergence.sh PR` answers one question: are blocking
findings still going down? `stalled` (no strict decrease across the last
two completed passes) and `cap-reached` (`--cap`, else
`RALPH_REVIEW_ROUND_CAP`, else 5; unattended lanes set 2) both mean stop
iterating and escalate to Human Needed rather than requesting another
review — hitting the cap is an escalation, not a failure. `pr-gate-watch.sh`
appends those two to `GATE-YOURS review` and nowhere else: that is the
verdict whose next move is "fix these and re-request", and a round count
beside a decision to merge is noise.

**Derived, never recorded** — a pass is the `ralph-review-head` request the
driver already posts (gate 5 *refuses* an unmarked request, so the trail is
reliable), and its findings are the policy bot's blocking threads filed
before the next one; there is no marker to write and nothing to keep in
sync. Unlike gate 5 it counts findings *filed* per pass, not outstanding
now: the subject is the reviewer's output per round, and filtering to what
survives would score a diligent driver's worst pass as its best.

**Zero is the floor, not a stall** — a strict-decrease test applied at zero
condemns every clean PR, which is exactly what the first draft did to
#1970/#1962/#1964/#1949 when it was run against them, so `converged` is
checked first and outranks the cap. The rule measures and gates nothing at
the merge path: there is no code path at "the driver decides to
re-request", so the judgment stays with the driver — the same split GH-1945
settled for advisory findings.

**What it does gate is which work an unattended lane picks up (GH-1977).**
`board deliver-queue` runs the same script on the rows that reach the queue
and holds `stalled`/`cap-reached` out of `queue` as a `convergence-stalled`
**blocked row** — surfaced, never silently withheld, because a stalled PR
that vanished from the queue would read identically to one that merged. It
is a selector, so it still does not escalate: the `board move NNN
human-needed` stays the driver's. Budgeted
(`RALPH_DELIVER_CONVERGENCE_MAX`, 3) and run *after* classification rather
than in the ranking walk — the check is 3 API reads and ~1.4 s per PR while
the walk runs at the 1-pt floor (GH-1803) — and rows past the budget keep
their classification, which is what an ungated rule means. Not-evaluated
never invents a block: an unreadable verdict, a crashed script, or a host
repo that ships no `scripts/review-convergence.sh` leaves the queue exactly
as it was.

## Every gate can pass a merge GitHub will refuse (GH-2057)

The ruleset enumerates its required status checks by **literal name**,
per-matrix entries included (`build-and-test-knowledge (20)`), so a diff
that drops a matrix leg stops producing a context the ruleset still
requires — required, never reported, unmergeable. Observed on #2055:
attestation green, Codex clean at head, apply-keywords PASS, every CI leg
green, `MERGE GATE PASS` printed, and then `the base branch policy prohibits
the merge`. Our gate ran and said yes because it does not read the
authority that decides.

`scripts/ruleset-contexts.sh PR` compares the base branch's effective rules
(`repos/{o}/{r}/rules/branches/{branch}` — the *effective* set, so GitHub's
own ruleset-matching is not re-derived here) against the contexts the head
actually produced, and names the difference. It **gates nothing** — the
refusal is GitHub's to make and all the driver is owed is the string
instead of the opaque one; same measure/decide split as GH-1945 and
GH-1849. `pr-gate-watch.sh` appends it to **`GATE-READY` alone**, unlike the
advisory count and linkage drift: that is the one verdict that says act now
and the only one whose recommended next action GitHub can refuse, and on
`GATE-YOURS attestation` the answer is noise by construction —
`ralph-attestation` is required and unproduced until `attest-pr.sh` runs,
which is what that verdict already says.

It **fails open**, which is load-bearing twice over: a host repo with no
ruleset is the common case and an unreadable one is a rate limit, not a
policy, so neither may darken a merge path — but they are different
answers, not one, and a ruleset read that requires nothing (`ok:true,
count:0`) never renders like a ruleset we could not read (`ok:false`).
Honest limit stated in the output rather than guessed at: a required
context absent because CI has not started is indistinguishable from one the
diff deleted without reading the workflow file and expanding its matrix, so
the wording is "required but not produced at this head" and the judgment
stays with the driver.

## Quoted-is-not-run was line-based (GH-2057 second finding, GH-2058)

`funnel-merge.sh` strips quoted spans before matching (GH-1930) using
`sed`, which reads a line at a time — so a `--body "…"` spanning newlines
had its opening and closing quotes on different lines, matched nothing,
survived stripping, and any `gh pr merge` inside it was refused as though it
were being run. The rail refused GH-2057's own filing. The stripper now
reads the whole command as one record. Backticks are deliberately **not**
stripped: outside quotes they are command substitution, which really does
run what is inside them, and stripping them would open the hole the rail
exists to close.

The three sibling funnels carried the same defect and were fixed together
in **GH-2058**, as one shared reader rather than three more edits:
`ralph/hooks/lib/cmdscan.sh` is now the only place any rail decides what
shell quoting means. That is the GH-1843 shape — a rule living in four
files held together by a comment asking the copies to stay in sync — and it
had already cost exactly one round: GH-2057 fixed one copy and the other
three kept the bug.

In the siblings the defect was one shape worse, because they also **split
the command into segments before stripping**, so a multi-line `--body` was
cut at every newline and at every `;`/`&`/`|` *inside* it and its bounding
quotes then landed in different segments, leaving each segment's `sed`
nothing to match. Reversing that — derive segments on **unquoted**
separators, strip afterwards — is what made both halves multi-line-native
at once.

Two rules survive the move unchanged, and one is new: backticks outside
quotes are still never stripped (command substitution really does run);
`funnel-board`'s `gh api` exception still matches its segment whole (the
GraphQL mutation lives *inside* the quotes) and `funnel-gate-watch` still
preserves a double-quoted span carrying `$(` or a backtick, since
`until [ -z "$(gh pr checks N)" ]` is the loop it exists for; and a `#`
comment now runs to end of **line** rather than truncating the whole command
at the first `#` anywhere, so a comment on line 1 no longer silences line 2.
The anti-drift check is a test, not a convention: `cmdscan.test.sh` asserts
every `funnel-*.sh` sources the shared reader and carries no private
quoted-span regex — matched on the regex rather than on `sed`, because
GH-2057's own fix was written in awk and a check spelling only the tool it
last saw would have missed it.

## The attestation is bound to the base, not only the head (GH-1841)

Every gate binds evidence to `head_sha` — and retargeting a PR changes what
it *merges* without moving the head. So a green `ralph-attestation` computed
against base A survived a retarget to base B, and gate 4 accepted evidence
for a diff that no longer existed. `attest-pr.sh` now records `base_ref`
beside `head_sha`, and the shared reader's `me_attestation_status` gained a
`base-changed` reason code that gate 4, `validate-attestation.sh` and
`pr-gate-watch.sh` all map to the same remedy — re-attest.

The identity is the base **ref name**, deliberately not the base SHA: a
base sha moves every time the target branch gains a commit, so binding to
it would invalidate every open attestation in the repo each time anything
merges — churn, not a gate — while a ref name changes on exactly the event
this catches and on no other. A payload with **no** `base_ref` lands on the
same code rather than passing: it predates the binding, so it cannot answer
the question, and the one-time cost is one re-attest per in-flight PR when
this reaches the default branch. An unreadable base is the other direction —
the caller passes `""` and the check is **skipped**, because a field we
could not read is not evidence that the PR was retargeted.

The workflow half matters as much as the predicate: a base retarget arrives
as `pull_request_target` action `edited`, which the attestation job skipped
wholesale on the correct reasoning that a *body* edit cannot change whether
the head is attested. It now takes `edited` when
`github.event.changes.base` is present and still ignores every other edit,
so the status recomputes to pending on the retarget instead of staying
green until the next push.

## A blocking review is not evidence the author has work to do (GH-1816)

Gate 1 blocks on `reviewDecision`, which is repo-level aggregate state
carrying **no commit binding** — so a `CHANGES_REQUESTED` keeps blocking
after its findings were fixed and pushed, until the reviewer re-reviews.
That is the *normal* shape of a review round, and hours wide when the
reviewer is rate-limited. The deliver lane read that token on 2026-08-12
and demoted GH-1774 In Review → Backlog as semantic rework, against a PR
(#1797) that was green and complete: the demotion drops the claim and makes
finished work read as unstarted.

`scripts/review-staleness.sh PR` answers the one question gate 1 cannot —
**whose turn is it** — by comparing each blocking review's `commit_id`
against `headRefOid`: `live` (a blocking review at the head — demote,
unchanged), `stale` (every blocking review predates it — hold at In Review
and nudge), `no-block`. `pr-gate-watch.sh` appends only `stale` and
not-evaluated to `GATE-FAIL review`; `live` is what that verdict already
means. **Gate 1 is untouched and still unforceable** — a stale verdict
still refuses the merge; the same measure/decide split as GH-1945 and
GH-1849.

Blocking is GitHub's own semantics reimplemented, never guessed: the script
runs only *inside* a `CHANGES_REQUESTED` reviewDecision, and within it
scores each reviewer's **newest non-dismissed** review, so a
`CHANGES_REQUESTED` the same reviewer later superseded is not counted as a
head-bound block. Every failed read — unreadable reviews, a missing head, a
blocking review with no `commit_id`, or a reviewDecision the review list
does not corroborate — is `not-evaluated`, and the caller then demotes
exactly as before: the bug being fixed is over-demotion, and the fix may
not become under-demotion where it cannot see. The judgement each pass made
is recorded in the `<!-- ralph-deliver:v1 -->` marker as `review_staleness`,
so a held item and a demoted one no longer read alike; the selector's
re-arm delta ignores that field, so recording it can neither hold nor
re-arm a row.
