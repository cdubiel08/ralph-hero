---
date: 2026-09-02
issue: GH-1918, GH-1976
topic: Peer-address resolution and the herdr-version-bump guard — full rationale behind ralph/CLAUDE.md's stated rules
status: shipped
---

# Peer addressing and install-consistency — full rationale

## The peer address is a third namespace, harness-owned (GH-1918)

A session's messaging address is not its agent name — it is the *worktree
leaf* plus a suffix the harness assigns at session start, so `w1918-slug`
does not resolve and never will. Ralph owns only the root: `peerPrefix()`
in `contracts.ts` (declared apart from `worktreeLeaf()` because it asserts
where the transport roots the address, not where the directory lives),
surfaced as `board name`'s `peerPrefix` and resolved by `board peer NNN`,
which takes the enumerated live names and returns the one address. The
address can therefore be *recognised* but never *constructed* —
enumeration stays mandatory.

The suffix pattern is hyphen-free by measurement, and that is the safety
argument: a bare `startsWith` would let `feat-1918-one`'s prefix address
`feat-1918-one-session-two`'s session. Both branch grammars are matched, so
a session that resumed a legacy `feature/GH-NNN` branch (leaf `GH-NNN`) is
not reported dead; repeats of one address dedupe to one session.

The residual limit is honest and unfixable by derivation: retitle a unit
after its session spawned and the slug drifts, so the live session stops
resolving until it is addressed by its listed name. Zero matches and two
matches are both refusals with exit 1 — one worktree can hold two
sessions, and the wrong session is worse than none.

The legacy `feature/GH-NNN` resolves everywhere for the deprecation window,
and resume beats re-cut — a unit that already has a legacy branch keeps it,
or its work splits across two heads. Both grammars are covered by ONE
query: `deliver-queue`'s PR linkage moved from exact
`pullRequests(headRefName:)` to `refs(refPrefix:"refs/heads/",
query:"<number>")`, because GitHub's ref filter is a **substring** match
(probed, not assumed). That also returns coincidences —
`feature/GH-18070`, `chore/1807-typo` — which `parseBranchName` rejects
client-side; the alternative (recomputing the exact branch) would have
needed the `labels` connection back in the item walk that GH-1803 just
removed. Measured: +1 pt per 10-item deliver chunk, item walk untouched.

## The version-bump guard that catches the guard that missed it (GH-1976)

`scripts/__tests__/herdr-setup.test.sh` compares the ralph-side stamp
against the herdr-side manifest to *each other*, which says nothing about
whether either tracks the actual code — GH-1808 shipped `roles.sh` and a
changed spawn path at 0.6.0 and both stayed green while installed cockpits
ran a copy without the script in it.

`scripts/check-herdr-version-bump.sh` closes that from the other side, as a
`pull_request`-only CI job: a diff touching the plugin's **behavior
surface** — `scripts/**`, non-test `cockpit/**`, the manifest itself — must
move the manifest version. README/CHEATSHEET, `tests/**` and `features/**`
are excluded because they never ship into an install, and a guard that
reddened on them would train people to bump for nothing, which is how a
signal stops meaning anything. An unresolvable base ref is exit 2, never a
pass: this guard exists because an absent signal read as "fine" once
already.
