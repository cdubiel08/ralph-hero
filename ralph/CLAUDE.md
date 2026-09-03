# Working in ralph/

## What this is

ralph v2 (GH-1662): ten skills, one agent, one board CLI, courtesy hooks, and lane selectors. Design record (normative): `../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`; lanes spec (GH-1712): `../thoughts/shared/specs/2026-08-07-loop-agent-lanes-spec.md`.

```text
ralph/
├── skills/work/        # the execution verb — outcome, boundaries, contract
├── skills/deliver/     # follow-through lane: In Review PRs → merged (GH-1712)
├── skills/tend/        # hygiene lane: Backlog shape + Done audit (GH-1712)
├── skills/dispatch/    # standing ops lane: authorities + reserved set (GH-2177)
├── skills/board/       # human surface — orientation, intake, answers, doctor
├── skills/hero/        # attended face of dispatch — standing sitting (GH-2182)
├── skills/help/        # topic-routed setup help (herdr cockpit wiring, GH-1759)
├── skills/w/           # whisper shortcut — one message via the GH-2216 wrappers (GH-2220)
├── skills/d/           # dispatch-up shortcut — stand up the dispatch seat (GH-2220)
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

A lane is a **typed selector + a judgment skill + a goal** — cadence is derived per pass from what the queue is blocked on, never configured. Four exist: **work** (`board next` → `/ralph:work`), **deliver** (`board deliver-queue` → `/ralph:deliver` — quiescent In Review items, marker-gated per PR, gate truth from `merge-pr.sh --dry-run`), **tend** (`board tend-queue` → `/ralph:tend` — Backlog hygiene + Done audit, metadata-only, closures only ever proposed via a marker comment the selector reads back), **dispatch** (`board brief` + fleet state → `/ralph:dispatch` — standing ops under written authority; the reserved set and standing authorities live in that skill's text, GH-2177). Skills are single-pass operators; pacing vocabulary lives only in `examples/README.md`.

### Work/deliver exclusion is typed at the branch write (GH-1917)

The lanes spec accepted this exclusion as **probabilistic** (residue §8.2):
quiescence and the pre-push re-check both evaluate the same remote-signal
predicate (`board.ts:3697-3713`), so a session editing files locally, with
no push and no board write, is invisible to both — two mitigations, one
blind spot. A message cannot be the atomic winner mutual exclusion needs
(GH-1890), and Projects V2 has no compare-and-swap, so the board claim
can't carry it either.

The contested resource is a **git branch**, and git ref updates are a real
server-side CAS: `scripts/deliver-push.sh` pushes with a
`--force-with-lease` pinned to the head deliver rebased from (never bare —
a bare lease compares against the remote-tracking ref, which any background
`git fetch` silently refreshes). A work session that pushed first wins;
deliver is refused (`DELIVER PUSH PENDING`, exit 75 — back off, not
escalate). This excludes at the **push instant**, and only against work
that was pushed — the load-bearing half, not the whole.

**The other half: deliver reads the lease it already had (GH-1929).** A
session holding *unpushed* local commits emits no remote signal at all, so
the push-instant lease can't see it either. `board claim` already publishes
a per-(worktree, unit) lock (`takeWorktreeLock`, GH-1956) at the
acquisition point contract rule 1 makes mandatory — no user script can
strip it. `classifyDeliver` refuses a held unit **entirely**, before any
PR-shaped reasoning, surfacing it as a `local-session-active` blocked row
(the GH-1977 precedent: a row that vanished would read like one that
merged). Same `RALPH_LOCK_TTL_MIN` clock as the board claim, so a dead
session blocks deliver for one TTL, not forever — **the lease deliberately
outlives the claim** (`transition()` clears the claim on In Progress → In
Review, but `deliver-queue` only reads In Review items, so a lease cleared
there would be dead code), which costs deliver's pickup latency up to
`RALPH_LOCK_TTL_MIN` after the driving session's last claim touch, not the
~5-min `RALPH_SETTLE_MIN` window. `--steal` is the immediate override; no
"I am finished" reclaim verb exists (that would be the opt-in convention
residue §8.3 warns against). **Two edges are the exception: In Progress →
Backlog clears the session's own lock (GH-2107), and so does every move
into Done or Canceled (GH-2367)** — a closed unit has no driver left to
read the lease, and a lock left behind by a self-close is a tombstone
`reap-leases` cannot see in the main checkout. Own lock only, best-effort
delete after the state write and claim-clear verify. An unreadable
sessions dir returns **null, never an empty probe**; this covers a
**same-machine** deliver only — unpushed commits are a machine-local fact,
so residue §8.2 correctly survives for a deliver loop on another host.

Full rationale (every rejected design, the latency-vs-safety tradeoff, the
GH-1956 lock's own O_EXCL mechanism):
`../thoughts/shared/research/2026-09-02-ralph-claude-md-lane-exclusion-history.md`.

**The four-dimension lane test** (gates every future lane proposal; stated once, here): a new lane is justified only when **signal source, write lane, pacing signal, and permission set all four differ simultaneously** from every existing lane. The pacing signal is the observable a lane derives its next wake from (work: queue depth; deliver: check conclusions, review deltas, retry/settle windows; tend: accumulation age; dispatch: capacity and fleet/lead state) — a proposal that differs only in derived cadence numbers fails the test.

## Conventions

- **Enforcement is code.** An invariant worth having goes in `board.ts` (with a test) or `state-guard.yml` — never in skill prose, never in a bash validator. Prose states intent once; if you're writing "make sure to X" in a SKILL.md, you're in the wrong file.
- **Three write lanes on the state field**, all in board.ts: `transition` (agent intent, MACHINE-guarded), `reconcile` (issue reality wins), `parent-check` (rollup). Nothing else writes it. There is no `--force`; a stale claim TTL is the only override path.
- **No prescribed phases.** The work skill grants judgment; research/plan depth is sized to the unit by the driver. Don't add per-phase skills, verdict-token vocabularies, or step recipes.
- **Every board.ts change ships with tests** (`npm run test:board` at repo root).
- **Lifecycle parity (GH-2129): a field the CLI reads or gates on must have a CLI write surface.** This used to be the prose convention right here, and it lost twice in one day — the approval edge gated on an Estimate only `create` could set (GH-2126), and every write failed closed on a state option only the UI could add (GH-2127) — because a read and its corrective verb are added by different units. It is now a test: `FIELD_PARITY` in board.ts answers for every `*_FIELD` constant, and `board.parity.test.ts` derives the enumeration from those constants (a new field opts in by existing), checks each named verb exists and addresses an *existing* issue (which is what `create` does not), and RUNS it against a fake board to prove it writes that field. An exemption is legal; its reason is the assertion. Adding a gate on a new field without a verb fails the suite by name.

## Verify locally what CI verifies (repo root)

```bash
npx vitest run ralph/scripts/ && npx tsc --noEmit
npm run lint
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

## Names are derived, once (GH-1807)

Branch `<kind>/NNN-<slug>`, agent `w NNN-<slug>` — the **same slug**, so the branch panel, `herdr agent list` and `.claude/worktrees/` read as one vocabulary. Declared in `contracts.ts` (`formatBranchName`/`parseBranchName` beside grammar B's `formatAgentName`/`parseAgentName`, sharing `slugify`/`truncateSlug`/`slugBudget`); read via **`board name NNN [--json]`**, which is what tick.sh and tick-herdr.sh call — a shell that rebuilt slugify would be a second grammar. Kind comes from labels (apply label wins, and fails closed to `apply` on a truncated label list) with `feat` as the stated default; the registry is closed, so `spike/1807-x` does not parse.

**The peer address is a third namespace, and it is harness-owned (GH-1918).** It is not the agent name — it is the *worktree leaf* plus a harness-assigned suffix, so it can be *recognised* via **`board peer NNN`** (enumerated live names → one address) but never *constructed*. The legacy `feature/GH-NNN` branch resolves everywhere for the deprecation window, and **resume beats re-cut**. Full rationale (the hyphen-collision safety argument, the retitle-drift limit, the substring-match query GH-1807 needed): `../thoughts/shared/research/2026-09-02-ralph-claude-md-naming-and-install-history.md`.

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

That consistency test alone does not catch a missed bump (GH-1976) — it compares the two stamps to *each other*, not to the code. `scripts/check-herdr-version-bump.sh` closes that from the other side, as a `pull_request`-only CI job: a diff touching the plugin's **behavior surface** (`scripts/**`, non-test `cockpit/**`, the manifest itself) must move the manifest version; docs and tests are excluded. An unresolvable base ref is exit 2, never a pass. Full rationale: `../thoughts/shared/research/2026-09-02-ralph-claude-md-naming-and-install-history.md`.
