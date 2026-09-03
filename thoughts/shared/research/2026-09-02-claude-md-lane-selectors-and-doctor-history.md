---
date: 2026-09-02
issue: GH-2151, GH-2048, GH-1929, GH-1788, GH-2052, GH-1825, GH-2138, GH-2282
topic: Lane selectors and the doctor sweep — full rationale
status: shipped
---

# Lane selectors and the doctor sweep — full rationale

`CLAUDE.md` states what each selector and doctor check does; this file
carries why.

## The Done audit is O(exceptions), not O(closes) (GH-2151)

The audit demand permanently exceeded the lane's capacity (185 unaudited
closes at batch 5, ~13 closes/day) and a close aging past `RALPH_AUDIT_DAYS`
dropped out *unaudited and unrecorded* — "audited" and "aged out unaudited"
rendered alike, the GH-1971/GH-2048 collapse.

A close carrying the gated Done lane's own evidence — a merged closing PR in
GitHub's `closedByPullRequestsReferences`, or shape-valid
`ralph-decision-evidence:v1` / `ralph-apply-evidence:v1` evidence judged by
the gate's OWN validators (`decisionEvidence`, `validateApplyEvidence` —
marker presence alone is not evidence) — now self-audits at read time:
withheld from `done-audit` as a counted `evidenced` line (GH-1945: counted,
never silent), no marker written (GH-2179's no-tracking-state shape —
nothing to drift, and the backlog absorbs retroactively: measured 83/93
recent COMPLETED closes carry a merged closing PR).

NOT_PLANNED closes are excluded from the audit entirely — reconcile's own
rule, a cancellation claims nothing to verify — though a pending post-close
proposal on one still surfaces as `proposed`. What still surfaces is exactly
the no-closing-keyword population the audit exists for (epic-root rollup
closes, `--why` closes, GH-1996 branch-linkage-only closes — deliberately
not re-derived per close: that search costs a query each, and those closes
*deserve* the look).

The linkage read is opt-in per caller (GH-1803 shape): `tendQueue` and
doctor pay ~+10 pts/page on the bounded closed-window read; `recentDone`
never renders it and does not pay. Doctor's `done-audit-pending` `i` line
counts the current window's still-curable exceptions with time-to-expiry —
deliberately *not* the already-expired (no verb can audit an expired close,
so that line's remedy could never act and it would clear only by time
passing: the GH-2052 unsatisfiable-remedy trap wearing an info line).

## `board pr-orphans` is the one selector not keyed on the board (GH-2048)

Every other surface needs a board item to hang a row on — `next`/`frontier`
rank issues, `deliver-queue` selects In Review items, `doctor` sweeps board
invariants — so an open PR referencing no issue is not merely unranked, it
is *unseeable*, and an empty queue renders identically to one that is empty
because its work never reached the board. Three PRs sat that way for up to
23 days (#1779, #1587, plus 12 untriaged dependabot PRs), found only because
the board hit zero open work and someone audited PRs to explain the
emptiness.

The selector reads GitHub's own `closingIssuesReferences` — the field gate 6
reads — never the PR body, which is app-writable (GH-1940); doctor carries
the count as an advisory `i` line under `board-volume`'s rules (`--strict`
never escalates it, `--fix` never acts on it).

Deliberately a selector and not a gate: blocking `gh pr create` has no
sanctioned alternative to redirect to (GH-1717's unchanged reason for
observing rather than redirecting), and auto-filing an issue per orphan
would convert a human's exploratory branch into board work without their
say.

Bot authors are skipped by default, and the spelling is the trap the first
draft fell into: GraphQL returns `dependabot` while every doc and the web UI
say `dependabot[bot]`, so a suffixed list matched nothing and left all 12
rows standing — the "a dozen rows and nobody reads it" failure the check
exists to avoid. Honest limit: making orphans visible does not make anyone
look.

## `deliver-queue` refuses a unit a live local session is driving (GH-1929)

The other half of GH-1917's push-instant lease, for the unpushed-commits
case no remote signal can see. It reads the per-(worktree, unit) lock
`board claim` already publishes (GH-1956), which is why it is enforcement
and not convention: that acquisition is mandatory and unstrippable. Held
rows surface as `local-session-active` and are self-clearing on
`RALPH_LOCK_TTL_MIN`, so a dead session costs one TTL, not a human. An
unreadable sessions dir yields **null, never an empty probe** — "could not
read the lease" may not render as "no lease is held" — and the whole read is
machine-local by nature, so a deliver loop on another host keeps the
original exposure. Full history: `ralph/CLAUDE.md`'s Work/deliver exclusion
section.

## `board-volume` and `prune` (GH-1788, GH-2052)

One sweep removes at most `--limit` items (200) and aborts after 5
consecutive mutation failures, so a rate limit or a revoked scope cannot burn
the budget this line of work exists to protect. `--json` reports the run it
actually performed.

**The `i` marker is gated on the remedy existing, not on the threshold
(GH-2052).** Once GH-2050 swept the 763 PR/draft items out, the count became
honest and the line became *permanent*: 860 real issues, 0 prunable, the
text itself saying there was nothing to do. That is not a mis-calibrated
constant but an unsatisfiable one — `RALPH_PRUNE_AFTER_DAYS` (180) floors the
board at one retention window of closed work, ~840 items at this repo's
throughput, so no threshold under that floor is reachable by the remedy the
line names, and raising 800 would only move the same unsatisfiable line to a
bigger number.

Over-threshold **with** candidates stays `i` and names the prune;
over-threshold with **nothing** prunable reads `ok`, prints the identical
measurement (doctor renders every check, `ok` included) and says why there
is no action — the marker asking a reader to act is what is withheld, never
the number. 800 keeps a coherent meaning: the point at which pruning is
worth recommending as soon as anything becomes prunable. A read that throws
still degrades to `not evaluated` at `i`, since a failed measurement may not
read like a healthy one.

## `installed-plugin` (GH-1825)

The gates in `board.ts` ship as a versioned **install**, so merging one is
not the moment it becomes true — the line resolves the copy agents actually
call (`installPath` from `~/.claude/plugins/installed_plugins.json`,
`$CLAUDE_CONFIG_DIR` honoured; version read from that copy's own manifest,
the registry record only as a labelled fallback) and compares it against
`CAPABILITY_FLOORS`. A floor is **derived, never configured**: `since` is a
fact about ralph's release history (the apply close gate landed in 0.1.81)
and `reliedOn` is the opt-in the repo already declares once in the merge
policy — so a new gate adds one row beside itself, the version exists in no
second place, and a repo that enabled nothing hears nothing. Several
installed copies are judged by the lowest (any may be the one a session
resolved); an absent/unreadable registry or an unparseable version reads
`not evaluated`, which is why the weekly CI doctor — which has no plugin
install at all — stays green.

## `board readiness` — Level-3 `integration-policy` (GH-2138)

Measures collision surface, main velocity, median PR lifetime, and the
ruleset's strict/merge-queue bits, and emits a **recommended integration
policy, not a table** — a decision gets read, a table joins the unread
(GH-2048's limit); strict-without-queue and hot-collision both name the
merge queue by name (recommended, never implemented — a stated non-goal),
and every unreadable input degrades to `info`, never `miss`.

## The state-guard doctor line names the cause, not just the count (GH-2282)

It used to render a rate limit, a rotten PAT and a real bug as one string —
`N/5 recent runs not successful` — and this repo rotated a healthy PAT off
that reading twice (2026-06-05, 2026-08-08). The newest failure's own log is
now read (`gh run view --log-failed` — the ONE extra call, fired only when a
failure exists, so a green window costs exactly what it did) and classified
into three verdict *shapes*, not one verdict with a suffix:
`rate-limited, self-healed — no action` is an `i` line once green runs
follow (a fact about a past outage, not a present fault); `rate-limited —
wait, do not rotate the PAT` keeps the fail and names the reset (derived
from the failed run's timestamp plus the hourly window, never read from the
reader's own `rateLimit`, which is a different token in any host repo);
`auth — rotate ROUTING_PAT` leads with the credential and quotes its
evidence; `other — debug <run URL>` covers everything else, including an
unreadable log.

Rate-limit evidence is tested first and outranks auth evidence, because a
starved token also fails `gh auth status` with `The token in GH_TOKEN is
invalid` (run 33223698651 printed both) — an auth-first reading names the
PAT on exactly the log the check exists to read correctly. `project … not
found (checked user + organization)` counts as auth: that is what the
2026-08-08 expired-PAT incident actually logged. `event`/`databaseId`/`url`
ride the existing `gh run list`. GH-1722's warn-inside/fail-outside split is
untouched.
