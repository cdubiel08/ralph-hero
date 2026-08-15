---
date: 2026-08-15
type: research
status: inputs-for-planning
scope: cdubiel08/ralph-hero board (project #3), 59 open issues
author: epic-planner session (read-only)
---

# Epic planning inputs: the conflated-signal class, and everything else open

**Deliverable choice.** A markdown file, not an issue comment. The report is 5 sections
across 59 issues with code evidence; an issue comment would bind it to one issue's thread
and make it unreadable on a phone, and there is no natural issue to hang it on (creating
one would be a board write, which this session is not permitted to make).

**Method and its limits.** Everything below was read from `origin/main` after a `git fetch`,
or from the live GitHub API, never from the working tree. Board reads were `--fresh`.
Where a claim rests on a measurement I ran, the number is given. Where I did not verify
something, it says **I could not determine**. Exit codes were captured separately from
output on every query, because an empty result and a failed query render identically —
which is, not coincidentally, the subject of this report.

One methodological note that changed a finding: `board list --state all` returns **zero
items and exit 0**. `all` is not a valid state, and the CLI filters to nothing rather than
refusing. This report's inventory comes from `board list --json --fresh` (59 items) cross-
checked against `gh issue list` (59). Anyone using `--state all` as a "give me everything"
idiom is reading an empty board as a calm one.

---

## 0. Board health at the time of reading

`board doctor` exits OK. No stale claims, no claim anomalies, no closed/terminal drift, no
claimless WIP, no foreign items, no pending tend proposals, no state smells. Two advisory
lines matter:

- `⚠ merged-unapplied: #1969 ← closed #1519` — the one open item doctor actively flags.
- `i board-volume: 1532 items = 16 pages per full scan (59 open, 766 closed, 707 non-issue)`
  — over the 800 threshold, but *no closed item is old enough to prune*. The growth is live
  work, not history. Prune buys nothing today.

`tend-queue`: 0 pending proposals, 9 `deps-cleared`, 70 `done-audit`. Nothing is stuck
waiting on a human answer through the board's own escalation lane.

---

## 1. Full inventory: 59 open issues in 8 themes

Every open issue appears exactly once. The one-line statement is what unites the theme, not
a summary of its members.

### A. Merge and review gate integrity — 17 items
*The gate is a chain of scripts that read GitHub about a PR; every member is a place where
what the chain read is not what was true.*

| # | Title (short) | Note |
|---|---|---|
| 1971 | advisory-findings reports clean when nobody reviewed | **In Review**, P1 — the only item not in Backlog |
| 1921 | gate 4 reports an unreachable API as 'no attestation comment' | **exact duplicate of 1922** |
| 1922 | gate 4 reports an unreachable API as 'no attestation comment' | **exact duplicate of 1921** |
| 1842 | Attestation read from an unpaginated comment window | 3 scripts affected |
| 1843 | Three scripts independently reimplement the merge-policy rules | structural prerequisite for 1921/1842/1836 |
| 1836 | validate-attestation checks out the DEFAULT branch on comment/review lanes | |
| 1841 | PR base retarget leaves a green attestation on a changed diff | |
| 1827 | apply-keywords job hides its own verdict (`bash -e` aborts pre-publish) | |
| 1940 | A PR body is app-writable once a review app is installed | Greptile writes the body |
| 1894 | Dead CodeRabbit rate-limit branch in pr-gate-watch.sh | verified still present, `pr-gate-watch.sh:262` |
| 1849 | Convergence stopping rule: escalate when findings stop decreasing | was blocked on the #1848 spike, which is now closed |
| 1845 | Courtesy rail: redirect `gh pr checks` poll loops | must be advise-only |
| 1824 | funnel-merge blocks any command whose TEXT mentions the merge verb | verified still present, `funnel-merge.sh:16` |
| 1742 | `attest --run` digests with ANSI escapes make the JSON unparseable | |
| 1816 | deliver: distinguish a stale CHANGES_REQUESTED from live rework | |
| 1732 | Done-evidence guard: accept branch-convention-linked merged PRs | premise live, **spec stale** — see §3 |
| 1837 | Configure Codex as the merge-gate reviewer | **recommend close** — see §3 |

### B. Board CLI cost and read correctness — 11 items
*The board's own reads: what they cost, and whether two of them agree.*

1784 (cockpit reads exhaust the budget · **recommend close**), 1800 (cut consumption to ≤1/5 ·
**recommend close**), 1804 (change oracle behind the walk), 1817 (starvation is a property of
the token, not the cockpit), 1883 (prune: sibling/`blocks` gating), 1885 (bound tend's Done
audit · **superseded**), 1889 (how are PRs getting on the board?), 1790 (frontier empty while
next has a candidate · **superseded**), 1791 (`get` and `tree` disagree about parentage),
1792 (nudge Priority on create), 1826 (tend markers match in prose; `--accept/--reject` swallow `-m`).

### C. herdr fleet and cockpit — 11 items
*Everything about running more than one agent at once, and knowing what they are doing.*

1808 (fleet role model: one driver, read-only investigators), 1865 (herdr-setup globs the
plugin cache instead of `installPath`), 1868 (two agent-prompt sites still parse outside the
adapter), 1880 (contract gaps: frontier typing, C8 at the push site), 1900 (live restart probe
for phase F), 1905 (phase F can refill into a foreign server), 1925 (spawn reported successful
· **duplicate of closed #1926**), 1929 (extend the lease to unpushed local work), 1930 (courtesy
funnel for force-pushes), 1943 (make the fleet bound enforceable · **largely superseded**),
1957 (a fork verb in the cockpit TUI).

### D. ralph-knowledge / MCP bootstrap — 4 items
*The vendored MCP server's launcher, and what it assumes about the machine it lands on.*

1844 (isolate bootstrap trees by Node runtime identity), 1846 (validate transitive/platform-
native payloads in the integrity check), 1850 (decouple the handshake from a cold bootstrap),
1851 (port the launcher to Node for full cross-platform support). All four are split-out
Codex findings from PR #1755 — an unusually clean provenance trail.

### E. Dream-loop and wiki curation — 2 items
*Candidate dedup for the weekly meta-reflection.*

1965 and 1967 — **near-duplicates**, see §3.

### F. ralph-demo v2 epic — 5 items
*The only pre-existing epic on the board, and the only theme with a real dependency chain.*

1748 (epic root) → 1749 (validate playwright-cli video capture) and 1750 (burn the framework,
extract the scaffold) → 1751 (the one judgment skill) → 1752 (dogfood: first real MP4).
Untouched since 2026-08-10. Nothing else on the board depends on it.

### G. Apply units — work that closes on a deploy, not a merge — 6 items

| # | What must become true | Status as of now |
|---|---|---|
| 1766 | next `ralph/**` release pushes with the pinned host key | **satisfied** — 3 green runs, tags v0.1.135/136/137 |
| 1828 | next knowledge release publishes with no `.mcp.json` pin rewrite | **satisfied** — run 31732136969 published 0.1.60; `.mcp.json` carries no pin |
| 1838 | Codex review enabled and verified in Codex Cloud | **satisfied** — codex reviews present on PR #1964 |
| 1915 | doctor's heartbeat rows on a machine with the loop registered | **duplicate of 1916** |
| 1916 | doctor's heartbeat rows on a machine with the loop registered | actionable now (0.1.137 installed) |
| 1969 | load `com.dubiel.dream-weekly` launchd job | doctor's one ⚠; one command on this Mac |

### H. Docs and repo hygiene — 3 items

1703 (state-guard cron is throttled to 30–80 min, documented as 15), 1810 (residual private
downstream-project names under `plugin/`), 1835 (`CLAUDE.md:42` says the apply block is not
armed — **verified still false**, the line is verbatim on `origin/main` while the policy has
`apply.enabled: true`).

---

## 2. The conflated-signal cluster, characterized from evidence

**It is three classes, not one.** The framing handed to me — *"a status signal that conflates
a benign and a dangerous outcome and defaults to the reading that raises no alarm"* — is
exactly right, and it describes about half of the 14 issues named. The other half are two
neighbouring failures that need different fixes and would be misrepresented by a shared
acceptance criterion.

The repo already made this distinction itself. **#1911's body draws the boundary explicitly**:

> Those three [1878/1907/1909] are **conflation**: a signal that cannot separate a benign
> outcome from a dangerous one, and defaults to the reading that raises no alarm. This one
> is the opposite failure. The finding is **correct, specific, and correctly attributed** —
> and delivered at a severity that guarantees no one acts on it. The information was not
> lost in the check. It was lost in the relay.

I am not improving on that. I am extending it.

### Class 1 — A/B collapse. One observable, two worlds, quiet reading wins.

The test: *does a single value occur under both a benign and a dangerous state, with the
benign one the default reading?* If yes, it is this class, and the fix always has the same
shape — **make "didn't run" and "ran and found nothing" different values**.

Confirmed members among the named:

| # | The collapsed pair | State |
|---|---|---|
| 1878 | `idle` = between turns \| never started | closed, PR #1908 |
| 1907 | `done` = finished \| killed mid-turn | closed, PR #1913 |
| 1909 | heartbeat absent = never installed \| scheduler dead | closed, PR #1914 |
| 1926 | spawn ok = prompt delivered \| delivered *and submitted* | closed, PR #1932 |
| 1933 | no live pane = foreign ledger \| quiesced own ledger | closed, PR #1941 |
| 1971 | `count: 0` = reviewed and clean \| nobody reviewed | **open, In Review** |

**1921/1922 are members with inverted polarity.** `2>/dev/null || echo ""` collapses
"API unreachable" into "no attestation" — but the merge blocks either way, so the
*dangerous* reading wins on safety. What is wrong is the **named remedy**: the operator
re-runs `attest-pr.sh`, re-posting a duplicate and re-running the suite for nothing. The
issue says this itself, and gate 5 already models the fix (`MERGE GATE PENDING … retry`).
Verified verbatim on `origin/main` at `scripts/merge-pr.sh:305-308`.

**The class is much larger than the 14 named.** These open issues are Class 1 by their own
text and were not on the list:

- **#1827** — *"A genuine gate-6 FAIL is indistinguishable from a broken runner"*, and
  publishes no status at all. The most textbook instance still open.
- **#1817 §2** — an exhausted GraphQL budget *fails silently* in background jobs.
- **#1784** — *"Columns render stale-but-plausible data, so the failure is easy to miss."*
- **#1842** — a valid attestation outside the comment window reads as **absent**.
- **#1865** — `herdr-setup.sh check` would `pass` a board-CLI path the cockpit does not run
  (verified: the glob is still at `herdr-setup.sh:208`). This is #1825's exact defect,
  unfixed one file over.
- **#1846** — the bootstrap marker is trusted while the platform-native payload is broken.
- **#1905** — on a foreign server *"the herd is empty, every seat looks free"*: absence read
  as capacity, and this one **starts processes and takes claims**. Verified still ungated:
  `reconcile.sh:827-830` loops `walk_ledgers` with no `record_is_ours` call, while phases A
  and D gate at `:532` and `:775`.
- **#1732** — a merged PR linked by branch convention reads as *no Done evidence*
  (`board.ts:2045` still tests only `closedByPullRequestsReferences`).
- **#1791** — `get` reports `parentNumber: null` where `tree` sees a child; the issue notes
  *"any future gate reading `get`'s parent would fail open."* A precursor, not yet a defect.
- **#1868** — the `2>&1` capture means a chatty-but-successful call can read as a failure.
  1921/1922's polarity: message-only, which is *why it survived review*.

### Class 2 — the finding survives, the reading does not.

The check is correct and the information reaches a surface. Nobody acts on it. The fix is
about **routing and severity**, not about adding a distinct value.

- **#1911** (closed, PR #1950) — a real deploy gap relayed as `i … 1 gap(s)`. Two sessions
  read it repeatedly and both classified it as cosmetic. It was the statement that the
  merged GH-1878 fix was not in the copy the cockpit executes — while the pre-fix watcher
  went on firing the exact false positive GH-1878 had just fixed, six minutes after merge.
- **#1849** (open) — 33 Codex rounds on PR #1764, findings 5 → 19 → 22, no termination
  condition. Same failure at a different timescale: the signal is present every round and
  no one is obliged to conclude anything from it.

**#1945 sits on the seam and belongs to both.** Its *symptom* is Class 1 — a PR with five
open P1 threads and a PR with none render identically. Its *cause* is Class 2 — advisory
findings have no consumer, by construction. It was correctly fixed as a Class 1 problem
(count the findings), and #1971 is the immediate proof that a Class 1 fix to a Class 2
problem inherits Class 1's failure mode: **the counter now collapses a third state,
"nobody looked," into the same reading.** That recursion is the single strongest argument
for a shared acceptance criterion rather than ten independent fixes.

### Class 3 — evidence that is shape-valid and answers the wrong question.

Nothing is conflated. Every signal is true. The signal simply does not bear on the claim
being made.

- **#1961** (closed, PR #1962) — *"recency and a green conclusion are not ancestry."* A green
  run, a reachable tag, an agreeing manifest — all three true, all three irrelevant, because
  the producing run checked out the **pre-fix** workflow. The gate was sound; the human step
  of *choosing which run to bind* was not.
- **#1841** (open) — a green `ralph-attestation` survives a **base retarget**, which changes
  what the PR merges without changing `head_sha`.
- **#1836** (open) — `validate-attestation` grades a PR against **main's** policy on the
  comment and review lanes, not the PR's.
- **#1940** (open) — `closingIssuesReferences` is derived by GitHub from a PR body that a
  third-party app can now rewrite. The gate's input moved out from under it.

### Named issues that only *look* like members

- **#1924** — self-dispatch. Not a signal defect at all: a containment defect (one unit per
  session). Its only kinship is that the failure is *silent by construction* because the
  session is outside the fleet's accounting. Fixing every conflated signal on the board
  would not have caught it.
- **#1944** — a **granularity** error: a sound predicate evaluated per-ledger and applied
  per-record. Its interest is elsewhere — it was a Greptile P1 **merged over unresolved**,
  which is what #1945 is about.
- **#1952 / #1954** — the root cause is a read-before-serialize race (`concurrency`
  serializes execution, not the read). Class 1 is only the **aggravator**: nothing between
  "merged" and "released" distinguishes released from unreleased, which is why it went
  unnoticed. Treating them as class members would put the fix in the wrong file. #1954 is
  additionally not an observation — it was filed by *inspection* of a sibling workflow,
  which is the honest and correct move and worth preserving as a pattern.

### Where the boundary actually falls

**Class 1 asks: can this value occur in two worlds?** Fix by adding a third value.
**Class 2 asks: did anyone have to act on this?** Fix by routing or by an obligation.
**Class 3 asks: does this evidence bear on the claim?** Fix by re-binding the evidence.

A single epic can hold Class 1 because one acceptance test covers all of it. It cannot hold
Class 2 or 3 without the acceptance test becoming "use good judgment."

---

## 3. Supersession and duplication

### Confirmed superseded — recommend close, with the commit

| Issue | Superseded by | Evidence |
|---|---|---|
| **#1885** Bound tend-queue's Done audit | GH-1891, PR #1897, `04619ebb5` | `tendQueue()` (`board.ts:4816`) no longer calls `listItemsFull`; the closed half comes from `issues(states: CLOSED …)` at `board.ts:3687`. The three surviving `listItemsFull` callers are doctor, `list --all-repos`, and prune. **Measured today: `tend-queue` = 17 pts / 6 queries**, exactly GH-1891's stated result. |
| **#1790** frontier empty while next returns a candidate | GH-1814, PR #1884, `9c44736e3` | `board.ts:7187` now reads *"EXACTLY next's inputs and ranking — frontier is a re-projection, down to the query selection"* and calls the same `rankNext`. **Measured live: frontier queue = 52, `frontier[0]` = #1969, `next` = #1969.** Symptom gone and the second computation is gone. |
| **#1925** spawn reported successful | duplicate of **#1926**, closed via PR #1932 `7edd3f68e` | Bodies **byte-identical** (`diff -q` clean). #1926 is CLOSED COMPLETED. #1925 is an orphan twin of already-shipped work. |
| **#1837** Configure Codex as the merge-gate reviewer | reality | `AGENTS.md` is on `origin/main`; `.github/ralph-merge-policy.json` names `chatgpt-codex-connector[bot]` with `head_marker`; codex reviews present on PR #1964. **One clause is not met and never will be** — "Preserve CodeRabbit installation as a supplemental reviewer" was deliberately reversed by GH-1847 / apply twin #1852. Close noting the reversal, do not silently drop it. |
| **#1838** Enable and verify Codex automatic review | reality | Same evidence. Its own success criterion — *"chatgpt-codex-connector posts a head-bound GitHub review recognized by the merge gate"* — is demonstrated on PR #1964. |
| **#1943** Make the fleet concurrency bound enforceable | GH-1948, PR #1949, `8de4b531f` (+ GH-1956, PR #1964) | #1943 asks for *"a refusal at the pane, so a self-dispatch is caught rather than conventionally avoided."* `board.ts:2440` says verbatim that the session→unit binding is *"strictly wider than a spawn-path counter: it also catches the session that reached a second unit without passing the spawner at all."* **Residual is real**: the binding caps units-*per-session*; fleet size *k* is still emergent. Recommend rewriting #1943 down to that residual rather than closing outright. |

### Recommend close as delivered — measured, not inferred

| Issue | Target | Measured today (`RALPH_GQL_COST=1`, `--fresh`) |
|---|---|---|
| **#1800** Cut board GraphQL consumption to ≤1/5 | ~126 pts per cockpit tick (3 walks × ~42) | `list` **13 pts / 1 query**, `next` 14/3, `frontier` 14/3, `deliver-queue` 13/3, `tend-queue` 17/6. One tick is now one shared walk (GH-1802) = **13 pts ≈ 10% of baseline.** Target exceeded ~2×. |
| **#1784** Cockpit reads exhaust the budget and time out | 21–23 s per column against a 25 s `boardTimeout` | 47 s → 5 s (GH-1814, PR #1884). All four children (#1785–#1788) closed. |

Children **#1804**, **#1883**, **#1889** survive on their own merits and should be re-rooted,
not closed with the parent. **#1817 explicitly does not follow #1784** — it says so in its
own body: starvation is a property of the token, and a review-polling loop with *no board
reads at all* drove the budget to 0/5000 during #1785's gate wait.

### Exact duplicates still open — 4 double-files, and the pattern is itself a finding

| Pair | Bodies | Filed apart | Recommendation |
|---|---|---|---|
| #1915 / #1916 | byte-identical | **62 s** | close #1915 — #1916 carries `ralph:apply` and parent #1909 |
| #1921 / #1922 | byte-identical | **75 s** | close either; neither is labeled |
| #1925 / #1926 | byte-identical | **122 s** | #1926 already closed; close #1925 |
| #1965 / #1967 | different text, same remedy | 33 min | see below |

Four double-files on 2026-08-14/15, three of them within two minutes, each pair with
identical bodies and consecutive-ish numbers. **This is very likely `board create` retried
after a lost response** — a create whose reply did not arrive reads as a failure. If so it
is another Class 1 instance, sitting at the intake path, and it has been quietly inflating
the board. **I could not determine the mechanism** — I did not read `createIssue`'s error
handling, and I have no log of the sessions that filed them. Recommend this be filed and
investigated on its own; it is the highest-leverage unfiled thing I found.

**#1965 / #1967** are not byte-identical but are one unit. Both say `meta_reflect`'s candidate
dedup is a lexical hash and the remedy is embedding similarity. #1965 (from #1518) says
*"not actionable yet, on purpose"* and names the trigger: *"curate sessions start seeing
re-proposed paraphrases."* #1967 reports **that trigger firing** — measured 2026-08-15, two
back-to-back runs over the same 44 reflections staged a restatement of an already-pending
candidate. So #1967 is #1965's activation condition, not a second problem. Merge #1967's
measurement into #1965 and close one.

### Verified NOT stale — premises re-checked against `origin/main`

Checked because a stale issue describing deleted architecture is common here. All still live:

- **#1835** — `CLAUDE.md:42` still reads *"ralph-hero has not armed it yet"* verbatim, while
  the policy has `apply.enabled: true`. The doc drift the issue reports is exactly as
  described, one day later.
- **#1894** — the hardcoded `test("coderabbit"; "i")` is still at `pr-gate-watch.sh:262`.
- **#1824** — `funnel-merge.sh:16` still matches `*"gh pr merge"*` on the whole command.
- **#1826** — `board.ts:4634` still uses `body.lastIndexOf(TEND_PROPOSAL_MARKER)`, unanchored.
- **#1971** — `scripts/advisory-findings.sh` contains **zero** occurrences of `reviews`,
  confirming it never asks whether a review happened.
- **#1732** — premise live (`board.ts:2045` tests only `closedByPullRequestsReferences`) but
  the **spec is stale**: the issue names `feature/GH-NNN` as *the* convention, and GH-1807
  replaced the grammar with `<kind>/NNN-slug` (`feature/GH-NNN` survives only as
  `legacyBranch`, `board.ts:7064`). Rewrite the acceptance to "the derived grammar per
  `board name NNN`, legacy included" before working it, or the fix will be built to a
  convention the repo has left behind.

### One near-miss worth recording

Tag `knowledge-v0.1.61` exists and `main`'s manifest reads 0.1.61, while npm's `latest` is
**0.1.60**. That looks exactly like the 2026-05-20 / 2026-08-09 stranded-release incidents.
**It is not a defect.** PR #1966 (GH-1518) touched `scripts/dream/*` and skills, not MCP
source, so `mcp_changed=false` and the `Publish to npm` step is skipped by design — the
workflow documents this explicitly (*"Skill-only changes still bump + commit + tag + push"*).
Confirmed by reading run 31898042243's step list: there is no publish step in it. Recorded
because the surface reads identically to a real stranding, which is — again — the subject
of this report.

---

## 4. Blocked items and their blockers

**Blocked on other in-repo work — 3 items, one chain, all in the demo epic:**

- #1751 ← #1750, #1749
- #1752 ← #1751
- #1837 ← #1838 — and this blocker is **phantom**: #1838's success condition is already
  demonstrated (§3). Closing #1838 unblocks #1837, which should also close.

That is the **entire** `openBlockers` graph. 56 of 59 open items have no blockers. There is
no dependency thicket here; whatever shape the user chooses, sequencing is not the constraint.

**Blocked on a human, not on work — 6 items.** None of these are in Human Needed (the board
has zero Human Needed items); they are blocked in the sense that no amount of agent time
moves them.

| # | What only a human can do | Ready? |
|---|---|---|
| 1969 | `launchctl load com.dubiel.dream-weekly.plist` on this Mac | **yes — one command, and it is doctor's only ⚠** |
| 1916 | register the loop, then read doctor's heartbeat rows | **yes** — 0.1.137 installed, GH-1909 shipped |
| 1766 | bind `kind=run` evidence and close | **yes** — 3 green release-ralph runs, tags v0.1.135/136/137 |
| 1828 | bind evidence and close | **yes** — run 31732136969 published 0.1.60; `.mcp.json` has no pin |
| 1838 | verify Codex in the Cloud console | **already true** — codex reviews on PR #1964 |
| 1900 | perform a real herdr restart with an armed fleet in flight | **no** — needs a deliberate live probe |
| 1749 | drive a real dev server through video capture | **no** — needs a running app |

**The honest reading: four of the six apply units are closeable today on evidence that
already exists.** They are not blocked; they are unharvested. That is worth more attention
than it is getting — an apply unit that sits open after its proof point has passed makes
`merged-unapplied` and `apply-verify-elapsed` noisier, which is a Class 2 failure waiting
to happen to the very lane built to prevent Class 1 ones.

---

## 5. A proposed epic to cut, not compose

### The shape I would offer

**Epic: "A signal must say what it does not know."**
*Every status read that agents and drivers act on distinguishes "did not run" from "ran and
found nothing."*

Class 1 only. Ten open children, all verified live against `origin/main`:

| # | The collapsed pair | Why it's in |
|---|---|---|
| **1971** | reviewed-clean \| nobody reviewed | already In Review; it is the class recursing into its own mitigation |
| **1827** | genuine gate-6 FAIL \| broken runner | publishes *no status at all* — the worst instance open |
| **1921** (close 1922) | no attestation \| unreachable API | gate 5 already models the fix; gate 4 should match |
| **1842** | absent attestation \| outside the comment window | affects all three readers |
| **1905** | free capacity \| foreign server's herd | the only member that **starts processes and takes claims** |
| **1865** | correct board CLI \| highest-versioned cache dir | GH-1825's own defect, one file over |
| **1817** | empty result \| exhausted budget, in background jobs | |
| **1846** | intact payload \| marker trusted over broken transitive deps | |
| **1732** | no Done evidence \| evidence the guard doesn't recognize | **rewrite the spec first** (§3) |
| **1791** | no parent \| parent the read path can't see | precursor; cheapest, and closes a fail-open path |

**The one thing that makes it an epic rather than ten tickets:** a shared acceptance
criterion. Something like — *no sanctioned read may map a failed query and an empty result
onto the same value; `advisory-findings.sh`'s `NOT COUNTED` and doctor's `not evaluated` are
the two existing idioms, and the epic's job is to make them the default rather than the
exception.* If the user does not want that criterion, the epic is overhead and §5's
alternative (d) is the better answer.

**Sequencing note, not a dependency:** #1843 (extract one shared merge-policy reader) is not
in the epic but sits underneath three of its children — 1921, 1842, and (via the same
scripts) 1836. Fixing those three independently writes the same fix three times into the
three scripts #1843 exists to unify, and #1843's own evidence is that seven review rounds on
PR #1764 produced 20+ findings *"the large majority [being] the classifier disagreeing with
gate 5 or gate 4 about the same evidence."* Worth deciding **before** the epic starts, not
during. I did not put it in the epic because it is a refactor with a different risk profile
and a different acceptance test, and folding it in would let the epic's completion hinge on
it.

### What should NOT go in

- **Class 2 (#1849, and #1911's lesson).** Only one open member. An epic of one is a ticket.
- **Class 3 (#1841, #1836, #1940).** A coherent three-item cluster — *"evidence bound to the
  wrong thing"* — and a legitimate **second, smaller epic** if the user wants one. It should
  not be merged into the first: its acceptance test is about what evidence *binds to*, which
  no Class 1 test can express.
- **#1944, #1924, #1952, #1954** — granularity, containment, and a race. Already closed, and
  including them would make the epic a retrospective.
- **#1868, #1824, #1930** — inverse polarity (false positives from over-broad matching).
  Same *feel*, opposite fix.
- **Themes B (cost), C (fleet), D (knowledge), E (dream), F (demo), H (docs)** — unrelated.
- **The four apply units that are closeable today** (§4). They are a 30-minute harvest, not
  epic material, and putting them in an epic would delay them.

### Shapes I rejected, and why

**(a) One epic over all 14 named issues.** Rejected: ten are already closed. An epic whose
children are mostly closed is a retrospective document, and it would have been better written
as one — it belongs in `thoughts/`, not on the board. Three of the fourteen are also not the
class (§2), so the epic would assert a false membership at its root.

**(b) One epic per surface — gate / board / herdr.** Rejected: it destroys the only property
that makes this worth an epic. The fix is *the same shape* on all three surfaces, and the
shared acceptance criterion is the deliverable. Split by surface and you get three epics that
each rediscover the same rule.

**(c) A broad "enforcement is code, not prose" epic** spanning conflation + enforcement
(#1943, #1929, #1930) + relay (#1849). Rejected: too large to finish, and the enforcement
items have a genuinely different acceptance bar (a refusal that fires) from the signal items
(a value that distinguishes). #1945's own evidence points at this doctrine, which makes the
framing tempting — and that is exactly why it would swallow half the board.

**(d) No epic. Prioritize the ten and work them.** **Genuinely viable, and the user should
weigh it.** The board already ranks; the ten are independent (56 of 59 open items have no
blockers at all); and an epic root that yields to its best open leaf adds ranking machinery
for coordination that does not exist here. The epic earns its place *only* if the user wants
the shared acceptance criterion — a lint, a test, or a doctor line that refuses a *new*
silent-absence read. Without that, ten well-prioritized tickets do the same work with less
board.

**My recommendation, offered as a cut and not a composition:** take (d) unless the shared
criterion is wanted, and if it is, take the epic above with #1843 decided first. The single
fact that argues hardest for the epic is that **#1971 is the class reappearing inside the fix
for #1945, one day later.** Ten independent fixes have no mechanism to prevent an eleventh.

---

## Appendix: what I did not verify

- **The double-file mechanism** (§3). The strongest unfiled finding, and the one I am least
  able to substantiate.
- **#1889** (how PRs and drafts reach the board). Doctor counts 707 non-issue items; I did
  not inspect the project's automation settings.
- **Greptile quota state.** I was told the trial quota is exhausted or near it and did not
  re-derive it. Consistent with what I saw — PRs #1966, #1968 and #1970 carry few or no
  reviews — but *I could not determine* whether that is quota exhaustion or the reviewer
  simply having nothing to say. **Which is #1971 exactly**, observed from the outside.
- **Whether #1790 and #1885 were ever re-tested by a human** after the commits that appear to
  fix them. I verified the code and measured the behaviour; I did not find a verification
  comment on either issue. Recommend they close through the tend lane's proposal path rather
  than directly.
