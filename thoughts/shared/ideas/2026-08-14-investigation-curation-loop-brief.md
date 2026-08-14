# Design brief: the investigation-and-curation loop as a ralph surface

**Status:** input to a design session, not a proposal. Written 2026-08-14 by the
session that produced the observations, so the examples are first-hand rather
than reconstructed.

## Why this exists

Over one working session (board #3, ralph-hero) a repeatable loop kept appearing
that no current ralph skill names. `/ralph:work` executes a unit. `/ralph:deliver`
shepherds PRs. `/ralph:tend` grooms the backlog. None of them covers what actually
happened between those verbs, which was roughly:

> observe something odd -> investigate it far enough to be sure -> decide whether it
> is a ticket, a correction to an existing ticket, or nothing -> write it down with
> its evidence and its uncertainty -> decide what gets worked next, and by how many
> agents in parallel

That loop produced, in one session: 2 new issues (#1888, #1891), a measured
correction posted to an epic (#1800), 2 issues resolved as stale/subsumed (#1813,
#1821) with residuals filed (#1883), a defect found in a watcher (#1878), and a
30-hour invisible orphan process killed. None of it was "work a ticket."

The design question: **is this a skill, a lane, a mode of `/ralph:board`, or just
a thing a good operator does?** It is genuinely not obvious, and the four-dimension
lane test in `ralph/CLAUDE.md` is the right gate to run it through.

## Observed patterns (evidence, not principles yet)

**1. Predict, then measure, and record the measurement even when it confirms.**
The GraphQL connection model has now mispredicted three times on this board
(GH-1803; two zero-value nested-`first:` trims; #1814 projected 15-18x and
delivered 3.2x). Direction reliable, magnitude unreliable. The correction posted
to #1800 exists only because someone measured after merging instead of trusting
the issue body.

**2. Measurement method is part of the finding.** Before/after `gh api rate_limit`
deltas were *inconsistent* because a cockpit and four agents spent budget between
the two reads. Per-query `RALPH_GQL_COST=1` attribution was immune. A number
without its method is not reusable, and on a live board the naive method is wrong.

**3. Grep the live tree before trusting an issue body.** #1813 asserted a feature
did not exist; it had shipped. #1821 described a problem a sibling had already
structurally deleted. Both were written by competent people and both were false by
the time they were read. Issue bodies decay; code does not.

**4. Proposals can be contingent.** #1821's disposition depended on #1814 merging,
which was in flight. "Propose, contingent on X, and say so" was more honest than
either closing it or leaving it silent.

**5. Record what you did NOT measure.** #1891 states plainly that 15 of its 22
queries are unattributed and says not to design against the guess. An issue that
hides its uncertainty gets implemented against a fiction.

**6. Check whether the thing is already built before filing the fix.** #1891 was
nearly filed as an N+1; `fetchHistories` already batches 20/round-trip with a
comment explaining why. The issue now says so explicitly, to stop the next reader
rediscovering it.

**7. Fleet composition is file-surface analysis, not ranking.** Parallelizing
#1814 with #1821 would have been a guaranteed conflict in one function, and
duplicated work besides. Ranking says what is most valuable; only the diff surface
says what can run concurrently. This is the least automated part of the loop and
maybe the most valuable.

**8. Detection and containment want opposite defaults.** `scope.sh` fails closed
because it decides *may I write here*. Orphan detection writes nothing, so
fail-closed provenance would only reproduce the blind spot it exists to close
(#1888). Worth generalizing: a check that only reports should not inherit the
caution of a check that acts.

**9. Recover in place; respawn discards.** Two sleep-killed sessions held
uncommitted work in live TUIs. Resuming beat respawning. The generalizable bit:
before replacing a stalled worker, look at what it is holding.

**10. Things that outlive their container go invisible.** Zombie panes (deleted
worktree), then a 30-hour orphaned cockpit polling into a dead PTY. Both invisible
to every existing check, both found by hand. Same shape, twice, in one session.

## The questions for the session

1. **Is it one surface or several?** Investigation, curation (issue hygiene as an
   output), and dispatch (fleet composition) may be three things sharing a session,
   not one skill.
2. **What is the typed selector?** Every ralph lane is *typed selector + judgment
   skill + goal*. `/ralph:tend` has `board tend-queue`. What does this one select
   over? Possibly nothing on the board at all — its inputs are measurements, live
   code, and running processes. If it has no selector, the lane test says it is not
   a lane.
3. **Where does the evidence live?** Findings here landed as issue bodies, an epic
   comment, and this file. Ad hoc. Is there a durable home?
4. **What must stay human?** Filing and correcting seem safely delegable. Fleet
   composition and accepting a closure proposal did not.
5. **Does it generalize past this board,** or is it an artifact of one repo whose
   product *is* the board tooling? (Real risk of building a skill that only works
   where the operator already knows the codebase cold.)
6. **Product mapping** (the operator's own parenthetical): does this belong in the
   shipped ralph plugin, or is it operator practice that should stay documentation?

## Constraints to respect

- Metadata-only lanes never execute closures — proposals with markers, human answers
  (`board resolve`). Anything designed here inherits that.
- Hooks are courtesy funnels, never enforcement. A "warning" surface is an advisory
  doctor `i` line: `--strict` never escalates, `--fix` never acts.
- ralph adapts to host repos; conventions are recommendations, never requirements.
- The four-dimension lane test in `ralph/CLAUDE.md` gates new lane proposals. Run it.

## Reading

- `ralph/CLAUDE.md` — lane test, enforcement layers, honest-limits style
- `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md` — design record
- `thoughts/shared/research/2026-08-11-graphql-cost-measurement.md` — the cost table
- Issues #1888, #1891, #1878; the #1800 correction comment
