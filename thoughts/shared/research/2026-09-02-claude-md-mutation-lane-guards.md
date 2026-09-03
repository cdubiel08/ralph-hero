---
date: 2026-09-02
issue: GH-1777, GH-2198, GH-1732, GH-1996, GH-1948, GH-1956, GH-1973
topic: Full rationale behind the write lanes' guards — Done evidence, claim/session binding, the worktree lock, create's dedupe
status: shipped
---

# Write lanes — full rationale

`CLAUDE.md` states the rules; this is the reasoning and the incident record
behind them.

## Done evidence (transition)

`Backlog → Done` is legal (GH-1777) so already-delivered work closes through
the *gated* lane rather than detouring via `reconcile`, which writes the
state field unchecked; the Done evidence gates key on the destination, so
nothing is weakened.

**Done evidence is either linkage deliver already uses (GH-1732)**: a merged
closing-reference PR, or a merged PR on a branch that *parses* as this
issue's (`board name NNN`'s grammar, legacy included) — **plus one derived
form (GH-2198): an epic root every one of whose children is closed.** The
fact is the one `parent-check` already computed to advance the root to In
Review, so demanding `--why` there made the escape hatch the routine path
for every completed epic; it costs zero extra reads (the child list rides
the issue fetch), a childless issue keeps the linkage gates, a truncated
child list counts as not-all-closed, a Canceled child counts (CLOSED on
GitHub — `parent-check`'s own key), and the refusal on a non-qualifying root
names the children still open. The guard and the close-out lane may not
disagree about what "linked" means, or `--why` becomes the routine path for
the no-closing-keyword population the lane exists for and stops meaning
anything.

The branch read runs only when the closing-reference half came up empty, and
every unreadable path returns no evidence: a rate limit may not manufacture a
close.

**The branch read is a merged-PR search, not a live-ref read (GH-1996)** —
because the first version's stated premise was false. `merge-pr.sh` deletes
the head ref right after merging (GH-1873 is about the *local* delete),
observed on #1995 — GH-1732's own PR — so by the time any close-out asked,
the ref was already gone and the new evidence path found nothing for the
entire population it was built to serve. It failed closed, so no wrong close
ever happened; it simply did not work. Search's `head:` qualifier survives
the deletion (verified against #1995 after its branch was deleted, 1 pt, the
same slot the refs read occupied). `head:` is a **prefix** match and needs
the kind — `head:1732` matches nothing — so one qualifier per grammar is
OR'd into a single query, which the closed `BRANCH_KINDS` set plus the
legacy `feature/GH-N` makes a bounded six. Being a prefix match it also
returns `feat/17320-…`, which `parseBranchName` rejects client-side — the
same re-validation the substring ref read needed, for the same reason.
Honest limit: search is eventually consistent, so a just-merged PR may not
be indexed yet, which reads as no evidence — the fail-closed direction.
`deliver-queue`'s own ref read is untouched: it runs against OPEN PRs, whose
branches still exist.

`Backlog → Human Needed` stays illegal — Human Needed is a pause on
in-flight work that `answer` resumes, so a tend closure proposal files as a
`<!-- ralph-tend:v1 proposed -->` marker comment (a `proposed` tend-queue
category, plus a doctor `i` line when unanswered) instead. A proposal is
**pending until answered**, and every disposition is observable: a
`<!-- ralph-tend:v1 resolved -->` marker (written by `board resolve NNN
--accept|--reject`, and by `reopen` itself — reopening *is* accepting
`reopen-as-unevidenced`), or, on a closed item, the close itself for any
proposal filed before it. Rejection has no other form: "leave it in Backlog"
changes nothing observable, so the lane would re-surface it forever and
never reach its clean sweep.

## Claim protocol

Claim = `{holder}|{iso8601}` in the Claim text field, TTL 120 min
(`RALPH_LOCK_TTL_MIN`); `--steal` posts an eviction comment; **no `--force`
exists anywhere** — stale TTL is the only side door. Read-back verifies the
claim won (GitHub has no CAS; the loser backs off).

### Session binding (GH-1948)

A verified claim also **binds the session to the unit**: contract rule 9
("one unit per session") stops being prose, and a second *distinct* claim
from one session is refused. The binding is local
(`~/.ralph/sessions/<session-id>.json`, keyed on `CLAUDE_CODE_SESSION_ID`)
because the board holder is `user@host`, shared by every session on the
machine, so a rule keyed on *it* would refuse the legitimate concurrent
panes rule 9 exists to permit.

Enforced at claim rather than at the spawn path, since a self-dispatch is
precisely the session that never passed the spawner. Check runs before any
mutation; the binding is written after the read-back verify, so a session
that loses a claim race stays unbound and can take the other work it was
just told to pick. No session id → *not evaluated*, never refused.

The bind is an **O_EXCL create**, which is the compare-and-swap the guard's
read cannot be: two overlapping claims from one session both read an absent
binding and both pass the guard, and without it the last write would
silently pick which unit the session "has" while both issues stayed claimed
by it.

Unlike the board claim — where Projects V2 has no CAS, so races are made
visible rather than impossible — a local file can actually win this one, and
the loser is refused by name — after **unwinding the claim it just took**,
since leaving an issue In Progress under a claim nobody drives would cost
the queue a full TTL. The unwind re-reads first and restores only what is
still recognisably its own — an unconditional rollback would clear a newer
claim and regress work the session cannot see.

### The worktree lock (GH-1956)

A second guard beside the session binding is keyed on the worktree, because
the session key alone is blind to the case that motivated it: a herdr fork
pane (`claude --resume <id> --fork-session`) is a *new* session id in the
*source's* worktree, so the binding reads unbound and the `user@host` holder
reads as the same holder — two harnesses about to race on one index, one
branch, one set of uncommitted files.

Keyed on the worktree rather than on fork-ness deliberately: a fork is the
cheapest way to reach that state, not the only one, and an env marker set by
`fork.sh` would miss a hand-started second `claude` and would not survive a
`/clear`.

The mechanism is a **lock, not a ranking**: one file whose name is derived
from (worktree, unit), published write-then-`link(2)` — atomic *and*
`EEXIST`-failing, so exactly one creator wins and a peer can never read a
half-written record and score it as "no owner". Comparing peer records
instead is not a CAS at all: two sessions can each publish after the other
has scanned, and both then read a directory that justifies their own
success. Every path ends in a **read-back** whose session id must be ours,
which is what settles even two concurrent `--steal`s — both may unlink and
both may create, but the surviving file names one owner and everyone else
refuses.

Displacement — the only path that does not reduce to one exclusive create —
is **serialized by a second, short-lived mutex**, because validate-then-
replace is two steps POSIX cannot fuse (there is no conditional unlink): two
sessions validating the same incumbent could otherwise each unlink the
other's replacement after it landed, and both pass their own read-back.
Anyone who cannot enter refuses rather than proceeding on a validation that
may already be stale, and the incumbent is re-read *inside* the section,
since whatever was seen before entering may have been replaced by the
displacer that just left.

The mutex deliberately has **no expiry**: an expiring lock needs fencing to
be safe, and recovering one by unlinking the path lets two recoverers each
delete the other's fresh mutex and both enter — the race the mutex exists to
remove, reintroduced by its own escape hatch. The bounded price is stated
rather than escaped: a displacer killed mid-section blocks further
*displacement* of that one lock — never a first claim, never another unit,
never another worktree — and the refusal names the file to delete.

Same check-early/act-late shape as the session binding: the pre-check only
reads, so the common refusal costs nothing and leaves the board untouched,
and the lock is taken only once the claim is verifiably ours — acting
earlier would let a steal that then *loses* the race erase the incumbent's
lock on its way out and disarm the guard while the incumbent is still
driving. A loser never unwinds the board claim: the winner holds the same
unit under the same holder and the same claim field, so the board is
already correct and a "restore" would strip the winner's claim rather than
its own.

Staleness is the **same clock the board claim uses**
(`RALPH_LOCK_TTL_MIN`) — "the source is gone and this fork is its
continuation" already has exactly one definition here, and a longer local
clock would let a fork steal on the board and still be refused locally;
`--steal` is the explicit form of that assertion and displaces the lock
immediately, which is what a crashed session resumed in its own worktree
uses — but it displaces **only the lock the pre-check actually saw**,
matched on owner and `since`. A different lock present by then belongs to a
*concurrent* stealer, a session the operator never spoke to because it did
not exist when the assertion was made; without that identity check two
concurrent stealers each unlink the other's lock after the other's
read-back has already returned, and both succeed.

Only the *same* unit is guarded — a second session claiming a *different*
unit from one checkout is also wrong, but it has a legitimate reading (a
worktree reused after its first unit shipped) and refusing it would cost
false refusals to catch a case nobody has hit. No session id or no repo root
→ *not evaluated*, never guessed at.

## `create` retry-safety (GH-1973)

A lost response and a failed write are indistinguishable to a caller, and
the safe-looking answer — retry — is the one that files a duplicate (three
confirmed pairs, 62–122 s apart, during a network flap). `create` owns the
hazard rather than exporting it: a **pre-mutation twin search**
(byte-identical title, OPEN, authored by the viewer, inside
`RALPH_CREATE_DEDUPE_SEC`/300) adopts an already-filed issue instead of
duplicating it, and a **read-back on mutation failure** resolves the
lost-response case in-invocation so no retry is needed for it.

All three conjuncts carry weight: title alone collides with legitimately-
repeated intake, a foreign author's issue is never ours to adopt, and an
unbounded window would be a title lock. A failed guard **warns and files** —
the outage that loses a response is the one that breaks this read, and
refusing would make `create` unusable exactly when it is needed; the
read-back is the backstop. When the read-back itself cannot be read, the
error says the write **may** have landed and names the search to run, rather
than inviting the blind retry. `--allow-duplicate` is the explicit assertion
that a second issue is meant.
