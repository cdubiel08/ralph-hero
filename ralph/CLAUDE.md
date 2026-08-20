# Working in ralph/

## What this is

ralph v2 (GH-1662): five skills, one agent, one board CLI, courtesy hooks, and lane selectors. Design record (normative): `../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`; lanes spec (GH-1712): `../thoughts/shared/specs/2026-08-07-loop-agent-lanes-spec.md`.

```text
ralph/
├── skills/work/        # the execution verb — outcome, boundaries, contract
├── skills/deliver/     # follow-through lane: In Review PRs → merged (GH-1712)
├── skills/tend/        # hygiene lane: Backlog shape + Done audit (GH-1712)
├── skills/board/       # human surface — orientation, intake, answers, doctor
├── skills/help/        # topic-routed setup help (herdr cockpit wiring, GH-1759)
├── skills/using-html/  # vendored utility (byte-identical upstream; do not edit)
├── agents/investigator.md  # read-only fan-out worker (hard tools: allowlist) —
│                       #   also the herdr-plane investigator's binding: its
│                       #   `tools:` block IS the `claude --tools` allowlist a
│                       #   spawned investigator runs under (GH-1808)
├── scripts/board(.ts)  # THE board mutation path — typed 6-state machine,
│                       #   claims with TTL, scope gate, doctor, and the lane
│                       #   selectors (next / deliver-queue / tend-queue)
├── scripts/herdr-setup.sh  # herdr-cockpit wiring truth: /ralph:help herdr drives
│                       #   it; doctor relays its `check --oneline` verdict —
│                       #   one line, carrying each gap's DETAIL (versions +
│                       #   remedy), never just a count and a check name
├── scripts/tick.sh     # ONE scheduler-transport example of driving the work
│                       #   lane (+ install-loop.sh) — a recipe, not THE loop
├── scripts/install-gates.sh  # vendors kit/ into a host repo (GH-2083):
│                       #   idempotent, respects host-modified/deleted files,
│                       #   seeds a minimal merge policy, stamps
│                       #   .github/ralph-kit.json, PRINTS the manual steps
├── scripts/kit-sync.sh # the ONE writer of kit/ — regenerates it from the
│                       #   canonical repo-root scripts/; kit.test.ts asserts
│                       #   byte-identity in CI (the GH-2058 shape)
├── kit/                # the merge-gate family + the board workflows
│                       #   (state-guard/doctor, GH-2088), vendored so they
│                       #   ship in the plugin (the marketplace packages only
│                       #   ./ralph, and validate-attestation.yml runs these
│                       #   scripts in Actions where no plugin install exists —
│                       #   vendoring is forced, a shim was never an option)
├── examples/README.md  # transport recipes: /loop, routines, scheduler — copy and own
├── hooks/funnel-*.sh   # courtesy redirects to board.ts / merge-pr.sh /
│                       # deliver-push.sh / pr-gate-watch.sh (each
│                       #   only when the host repo ships the target) — NOT
│                       #   enforcement; board.ts + state-guard.yml are
│                       #   the guarantees
├── hooks/lib/cmdscan.sh    # the ONE reader of shell quoting (GH-2058): which
│                       #   bytes are being RUN, and where one command ends.
│                       #   Policy stays in each rail; only the walk is shared
└── .claude-plugin/     # manifest
```

## Lanes (GH-1712)

A lane is a **typed selector + a judgment skill + a goal** — cadence is derived per pass from what the queue is blocked on, never configured. Three exist: **work** (`board next` → `/ralph:work`), **deliver** (`board deliver-queue` → `/ralph:deliver` — quiescent In Review items, marker-gated per PR, gate truth from `merge-pr.sh --dry-run`), **tend** (`board tend-queue` → `/ralph:tend` — Backlog hygiene + Done audit, metadata-only, closures only ever proposed via a marker comment the selector reads back). Skills are single-pass operators; pacing vocabulary lives only in `examples/README.md`.

### Work/deliver exclusion is typed at the branch write (GH-1917)

The lanes spec accepted this exclusion as **probabilistic**: an interactive `/ralph:work` session never holds `tick.pid`, so if it idles past `RALPH_SETTLE_MIN` deliver can rebase and push a branch that live session still owns. The two named mitigations do not cover it. Quiescence and the pre-push re-check evaluate the *same* predicate — the newest of state change, issue comment, and open-PR activity (`board.ts:3697-3713`), all **remote** signals — and a session editing files locally emits none of them. So the re-check is not an independent second guard for this hazard; it is the settle window sampled twice. Two mitigations, one blind spot.

Mutual exclusion needs an atomic winner, and **a message cannot be one** (that is GH-1890's finding, and why no channel was built here). Projects V2 has no compare-and-swap, so the board claim cannot carry it either — and the claim is gone by then regardless: `transition()` clears it on In Progress → In Review (`board.ts:2108-2136`) and read-back-throws if the clear did not stick.

But the contested resource is not a board item — it is a **git branch, and git ref updates are a real server-side CAS**. That is the primitive `scripts/deliver-push.sh` uses: a `--force-with-lease` pinned to the head deliver rebased from, so a work session that pushed first wins and deliver is refused (`DELIVER PUSH PENDING`, exit 75 — back off, not escalate). Always pinned, never bare: a bare `--force-with-lease` compares against the remote-tracking ref, which **any background `git fetch` silently refreshes** — proved to clobber in `deliver-push.test.ts`, which also keeps a control case showing a plain force push destroying the work commit outright.

Honest bound: this excludes at the **push instant**, and only against work that was *pushed*. This is the load-bearing half of the exclusion, not the whole of it.

**The other half: deliver reads the lease it already had (GH-1929).** A session holding *unpushed* local commits emits no remote signal, so quiescence, the pre-push re-check and the pinned lease all read a quiet branch and deliver rebases anyway — lanes spec residue §8.2. The fix is not a new lock. `board claim` already publishes a per-(worktree, unit) record (`takeWorktreeLock`, GH-1956) at the acquisition point contract rule 1 makes **mandatory**, which is precisely what a branch-level lease could not have promised — GH-1929's own second design question, and why this does not land as residue §8.3 ("conventions fail open by nature"): no user script can strip a lock taken inside the CLI's claim path. Two non-accidental properties make it readable from outside the owning session — the sessions dir is machine-shared, and the issue number is in the **filename** — so `localSessionLease()` names every live holder with one `readdir` and zero API cost, which matters on a walk running at the 1-pt GraphQL floor. `classifyDeliver` refuses a held unit **entirely**, before any PR-shaped reasoning (the hazard is invisible to every check that follows, so no amount of looking at the PR can rule it out), and surfaces it as a `local-session-active` blocked row — the GH-1977 precedent: a row that merely vanished would read exactly like one that merged.

Rejected: a new `refs/ralph/lease/<branch>` ref (GH-1929's first option) — a second lock needing its own expiry and heartbeat semantics, for a hazard that never leaves the machine. Reusing the record settles expiry by inheritance: the **same `RALPH_LOCK_TTL_MIN` clock** as the board claim, so the row is self-clearing (`windowExpiresAt` is the lock's expiry, unlike `convergence-stalled`, which only a human clears) and a dead session blocks deliver for one TTL, not forever. **The lease deliberately outlives the claim, and that costs latency.** Clearing the lock wherever `transition()` clears the claim would give the two one coherent lifecycle — and would make this dead code, since `deliver-queue` only ever considers *In Review* items, so a lease released on entering In Review is one the probe can never observe. The lease must outlive In Progress or it does nothing. The price is that deliver's pickup latency for a unit becomes up to `RALPH_LOCK_TTL_MIN` (120 min) after the driving session's last claim touch, rather than the ~5-min `RALPH_SETTLE_MIN` window. No "I am finished" verb was added to reclaim it: that would be precisely the opt-in convention residue §8.3 warns about, whose *omission* — the default — silently restores the hazard. TTL-only fails in the safe direction (it over-blocks deliver; it never loses a commit), the operator has the knob, and `--steal` is the immediate override. Three stated bounds: an unreadable sessions dir returns **null, never an empty probe** — "we could not read the lease" must not render as "no lease is held" — and this covers a **same-machine** deliver only. Residue §8.2 survives for a deliver loop on another host, correctly: unpushed commits are a machine-local fact, so there was never anything for a remote reader to see.

**The four-dimension lane test** (gates every future lane proposal; stated once, here): a new lane is justified only when **signal source, write lane, pacing signal, and permission set all four differ simultaneously** from every existing lane. The pacing signal is the observable a lane derives its next wake from (work: queue depth; deliver: check conclusions, review deltas, retry/settle windows; tend: accumulation age) — a proposal that differs only in derived cadence numbers fails the test.

## Conventions

- **Enforcement is code.** An invariant worth having goes in `board.ts` (with a test) or `state-guard.yml` — never in skill prose, never in a bash validator. Prose states intent once; if you're writing "make sure to X" in a SKILL.md, you're in the wrong file.
- **Three write lanes on the state field**, all in board.ts: `transition` (agent intent, MACHINE-guarded), `reconcile` (issue reality wins), `parent-check` (rollup). Nothing else writes it. There is no `--force`; a stale claim TTL is the only override path.
- **No prescribed phases.** The work skill grants judgment; research/plan depth is sized to the unit by the driver. Don't add per-phase skills, verdict-token vocabularies, or step recipes.
- **Every board.ts change ships with tests** (`npm run test:board` at repo root) and must keep the parity invariant: `get` reads exactly the fields `move`/`claim` write.

## Verify locally what CI verifies (repo root)

```bash
npx vitest run ralph/scripts/ && npx tsc --noEmit
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

## Names are derived, once (GH-1807)

Branch `<kind>/NNN-<slug>`, agent `w NNN-<slug>` — the **same slug**, so the branch panel, `herdr agent list` and `.claude/worktrees/` read as one vocabulary. Declared in `contracts.ts` (`formatBranchName`/`parseBranchName` beside grammar B's `formatAgentName`/`parseAgentName`, sharing `slugify`/`truncateSlug`/`slugBudget`); read via **`board name NNN [--json]`**, which is what tick.sh and tick-herdr.sh call — a shell that rebuilt slugify would be a second grammar. Kind comes from labels (apply label wins, and fails closed to `apply` on a truncated label list) with `feat` as the stated default; the registry is closed, so `spike/1807-x` does not parse.

**The peer address is a third namespace, and it is harness-owned (GH-1918).** A session's messaging address is not its agent name — it is the *worktree leaf* plus a suffix the harness assigns at session start, so `w1918-slug` does not resolve and never will. Ralph owns only the root: `peerPrefix()` in `contracts.ts` (declared apart from `worktreeLeaf()` because it asserts where the transport roots the address, not where the directory lives), surfaced as `board name`'s `peerPrefix` and resolved by **`board peer NNN`**, which takes the enumerated live names and returns the one address. The address can therefore be *recognised* but never *constructed* — enumeration stays mandatory. The suffix pattern is hyphen-free by measurement, and that is the safety argument: a bare `startsWith` would let `feat-1918-one`'s prefix address `feat-1918-one-session-two`'s session. Both branch grammars are matched, so a session that resumed a legacy `feature/GH-NNN` branch (leaf `GH-NNN`) is not reported dead; repeats of one address dedupe to one session. The residual limit is honest and unfixable by derivation: **retitle a unit after its session spawned and the slug drifts**, so the live session stops resolving until it is addressed by its listed name. Zero matches and two matches are both **refusals with exit 1** — one worktree can hold two sessions, and the wrong session is worse than none.

The legacy `feature/GH-NNN` resolves everywhere for the deprecation window, and **resume beats re-cut** — a unit that already has a legacy branch keeps it, or its work splits across two heads. Both grammars are covered by ONE query: `deliver-queue`'s PR linkage moved from exact `pullRequests(headRefName:)` to `refs(refPrefix:"refs/heads/", query:"<number>")`, because GitHub's ref filter is a **substring** match (probed, not assumed). That also returns coincidences — `feature/GH-18070`, `chore/1807-typo` — which `parseBranchName` rejects client-side; the alternative (recomputing the exact branch) would have needed the `labels` connection back in the item walk that GH-1803 just removed. Measured: +1 pt per 10-item deliver chunk, item walk untouched.

## The Loop

`scripts/tick.sh` runs ONE iteration: lock (flock when present, else atomic noclobber pidfile) → heartbeat → `board next` (empty = exit before spawning) → worktree-per-job → `$RALPH_TICK_RUNNER "/ralph:work NNN"` with hard timeout → per-issue log; timeout releases the claim. The scheduler (launchd/cron via `install-loop.sh --enable`) owns cadence — no sentinels, no in-session wakeups; success is judged by board state, not exit codes (a no-op runner logs loudly).

- **Autopilot opt-in is typed and fail-closed**: `autopilot=true` in `~/.ralph/config`.
- **Billing guard**: tick refuses to spawn when `ANTHROPIC_API_KEY` is set (would bill API credits, not the subscription) unless `RALPH_ALLOW_API_BILLING=true`. `RALPH_TICK_RUNNER` makes the transport pluggable — interactive `/ralph:work` and bridge-routine drives are equally valid.

## Item cache — reads may be stale, writes see truth (GH-1806)

The item walk is memoized to `~/.ralph/cache/items-{kind}-{select}-*` for 90 s, so a chain of board reads pays for one walk instead of one each. `--fresh` forces a walk for one command; a cached answer always says so, including on an empty queue.

This is **client-side bounded staleness, not a lease** — GitHub offers no server participation. Three rules carry the whole safety argument, all enforced in code:

1. **The cache never drives a write-guard evaluation.** Every MUTATING command, `doctor --fix`, and `prune --apply` run with the TTL zeroed (in `doctor()` itself, not only at the CLI dispatch), and every write path already re-reads the single item fresh at the guard. A stale entry can cost one wasted claim attempt — never a wrong transition — because the claim protocol is read-back verification, not read freshness.
2. **Read-your-writes + monotonic reads.** Every mutation bumps an `epoch` mark (hooked in `ghGraphQL`, the one path all writes take) and unlinks every selection variant; `servedAt` is a high-water mark. `fetchedAt` is stamped at the *start* of the walk, so a ~22 s walk that began before a write cannot end-stamp its way past the epoch check.
3. **An entry serves only a request its selection COVERS** (`selectCovers`). Since GH-1803 the walk's shape varies per caller, and an unselected group is *absent* from the item rather than empty — so serving a labels-less entry to a caller that reads labels would not lose data, it would fabricate "GitHub said there are none", and `next` would rank an item as unblocked whose dependencies were never fetched. `tsc` cannot catch this across a JSON file, so the check is at runtime and the cast on serve is honest only because it ran. The converse is free: a *wider* entry serves narrower requests, so a `list` or `doctor` walk pays for the `next`/`deliver-queue` reads after it. Entries are keyed by selection, so a lean walk cannot evict a fat one.

### The walk past Δ is gated, not automatic (GH-1804)

Beyond Δ the entry is on probation rather than dead: a REST conditional request against the repo's issues list may extend it up to **T_max** (`RALPH_ITEM_ORACLE_MAX_SEC`, 600, 0 disables), and a 304 costs zero rate limit on a budget measured to be independent of the GraphQL one the walk spends.

The oracle sees comments, body edits, labels, open/close — and is **blind to Workflow State, Claim and dependency writes**, which is most of what this board does. So T_max, not the oracle, sets the refresh rate for an agent fleet, and it is a hard ceiling no certification overrides. Three rules keep every failure pointed at paying for the walk:

1. **The verdict is the HTTP status line, never the exit code.** `gh api` exits 1 on a 304 and 0 on a 200; reading exit-1 as "unchanged" would make every network failure, auth error and rate limit look like a quiet board, and the walk would never run again — silently and permanently. Anything that is not an unambiguous 304 answering a conditional request we actually sent is CHANGED.
2. **The etag's capture instant must precede the walk it certifies.** A 304 proves nothing changed *after* `since` and says nothing about the window before it, so an etag captured after a walk cannot vouch for that walk. The probe therefore runs on the way *into* a walk, not out of it.
3. **It only ever extends a serve the other guarantees already permit.** Selection coverage, read-your-writes and monotonic reads are checked on the same entry, unchanged. And `doctor` is opted out entirely — even report-only, since it reads the state and claim fields the oracle cannot see and `--strict` turns that read into an exit code.

The cached walk also carries `scan` (GH-1788's meter), so `board-volume` and `prune`'s dry run report the board they were actually computed from rather than a zeroed counter.

## Install model

Claude Code installs `ralph` from the marketplace clone as an immutable versioned copy; edits here reach a running session after merge → `release-ralph.yml` bumps + tags → plugin update. `board.ts` ships inside the plugin (no npm, no version pin — the repo copy is the version).

The herdr half of the cockpit does **not** auto-update (herdr has no `plugin update`), so `scripts/herdr-plugin-version` stamps the `ralph-herdr` version this ralph release expects; `herdr-setup.sh check` compares it against herdr's registered version and names the reinstall command on drift. Bump the stamp with `plugin/ralph-herdr/herdr-plugin.toml` — `scripts/__tests__/herdr-setup.test.sh` fails if they diverge.

That consistency test is not the one that catches a missed bump (GH-1976): it compares the two stamps to *each other*, which says nothing about whether either tracks the code — GH-1808 shipped `roles.sh` and a changed spawn path at 0.6.0 and both stayed green while installed cockpits ran a copy without the script in it. `scripts/check-herdr-version-bump.sh` closes that from the other side, as a `pull_request`-only CI job: a diff touching the plugin's **behavior surface** — `scripts/**`, non-test `cockpit/**`, the manifest itself — must move the manifest version. README/CHEATSHEET, `tests/**` and `features/**` are excluded because they never ship into an install, and a guard that reddened on them would train people to bump for nothing, which is how a signal stops meaning anything. An unresolvable base ref is exit 2, never a pass: this guard exists because an absent signal read as "fine" once already.
