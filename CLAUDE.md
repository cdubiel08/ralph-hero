# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`ralph` v2 (GH-1662) — a Claude Code plugin for board-driven autonomous development over a GitHub Projects V2 board. Two skills, one read-only agent, one typed board CLI, three hooks (two courtesy funnels + one PostToolUse observation), and a scheduler-owned loop. The driving model sequences its own research/plan/build/verify; enforcement is code, not prose. Design record (normative): `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`.

The repo also ships two independent plugins: `plugin/ralph-knowledge/` (semantic search over thoughts/, own MCP server + npm release) and `plugin/ralph-playwright/` (UI-testing skills), plus `plugin/ralph-demo/` (Remotion demo videos).

## Build & Test

From the repo root:

```bash
npm install                                    # workspace dev deps (tsx, vitest)
npx vitest run ralph/scripts/                  # board contract suite + metrics registry
npx tsc --noEmit                               # typecheck
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

ralph-knowledge builds/tests from `plugin/ralph-knowledge/` (`npm ci && npm run build && npm test`).

## The Board (source of truth)

Six states, one machine, three write lanes — all in `ralph/scripts/board.ts` (~1,100 ln + ~700 test ln; run via `ralph/scripts/board`, a bun→tsx shim):

```text
Backlog → In Progress → In Review → Done
              ↕︎              ↓
         Human Needed ←──────┘        Canceled (explicit cancel; reopen = only exit from terminal)
```

- **transition** — agent intent, guarded by the MACHINE table. `Backlog → Done` is legal (GH-1777) so already-delivered work closes through the *gated* lane rather than detouring via `reconcile`, which writes the state field unchecked; the Done evidence gates key on the destination, so nothing is weakened. `Backlog → Human Needed` stays illegal — Human Needed is a pause on in-flight work that `answer` resumes, so a tend closure proposal files as a `<!-- ralph-tend:v1 proposed -->` marker comment (a `proposed` tend-queue category, plus a doctor `i` line when unanswered) instead. A proposal is **pending until answered**, and every disposition is observable: a `<!-- ralph-tend:v1 resolved -->` marker (written by `board resolve NNN --accept|--reject`, and by `reopen` itself — reopening *is* accepting `reopen-as-unevidenced`), or, on a closed item, the close itself for any proposal filed before it. Rejection has no other form: "leave it in Backlog" changes nothing observable, so the lane would re-surface it forever and never reach its clean sweep. Claim = `{holder}|{iso8601}` in the Claim text field, TTL 120 min (`RALPH_LOCK_TTL_MIN`); `--steal` posts an eviction comment; **no `--force` exists anywhere** — stale TTL is the only side door. Read-back verifies the claim won (GitHub has no CAS; the loser backs off).
- **reconcile** — GitHub reality wins: closed→Done/Canceled, reopened→Backlog, off-board→adopt. Every correction posts a comment.
- **parent-check** — rollup: all children closed → parent to In Review (deliberately multi-hop; fails closed on truncated child lists).

Guards by construction: scope gate (origin remote must match configured host/owner/repo before any mutation, incl. `doctor --fix`); cross-repo board items are partitioned by `ownRepo()` and never touched (bare-number resolution would hit the wrong repo's issue); archived items skipped everywhere; blocker-list truncation counts as blocked.

### Apply units — merge ≠ done (GH-1692)

Opt-in, via an `apply` block in `.github/ralph-merge-policy.json` (`enabled`, `label`, `infraPaths`) — the same file the merge gate reads, so a repo opts in once and `board.ts` + `merge-pr.sh` cannot drift. **ralph-hero has not armed it yet** (that's #1696); every gate below is inert without it, and inert again on a board with no apply issues.

An issue carrying the configured apply label (`apply.label`, default `ralph:apply`) is work whose completion is a *deploy*, not a merge — terraform, secrets, rulesets, a scheduled job's next fire. Four enforcement points:

| | |
|---|---|
| **Decomposition** | infra-touching units split into a ship issue + one or more apply units (`board create --apply`, which resolves the configured `apply.label` rather than a literal); settings-only changes get *only* an apply unit |
| **Merge gate 6** | `scripts/apply-keywords.sh` — no closing keyword may bind an apply unit, and an infra-touching PR may not close a ship issue with no apply twin. Re-published server-side as the `ralph-apply-keywords` status (recomputed on `edited`, since that's how a closing keyword arrives after CI went green) |
| **Close gate** | `transition()` refuses Done without a shape-valid `ralph-apply-evidence:v1` comment (`scripts/apply-evidence.sh` posts one). No `--why` escape, no merged-PR escape. `kind=run` evidence must bind `run.head_sha == merge_sha` |
| **Surfacing** | doctor's `merged-unapplied`, `apply-verify-elapsed` (honours `<!-- ralph-verify-after: ISO -->` in the body), `apply-closed-unevidenced` (strict-fail; `--fix` reopens to Human Needed) |

Honestly labelled limits: GitHub has no pre-close hook, so a UI close is *corrected within one reconcile pass*, not prevented; a label added after a PR's status was computed doesn't recompute it (merge time is the backstop); and non-run evidence proves a command exited 0, not that the operator's claim is true. Plan: `thoughts/shared/plans/2026-08-01-infra-apply-isolation.md`.

**Lane selectors** (GH-1712): `board deliver-queue` (quiescent In Review items with actionable PR signal — marker-gated per PR, gate truth from `merge-pr.sh --dry-run`, bounded verdict-agnostic retry) and `board tend-queue` (stale bodies, cleared/truncated deps, unformed intake, unaudited closes). Both are `next`-class typed read-only queries; empty `next` means spawn nothing. A lane = typed selector + judgment skill + goal; the four-dimension lane test gating new lane proposals is stated once in `ralph/CLAUDE.md`. Transport recipes (attended `/loop`, unattended routines/scheduler with the two-key fail-closed opt-in): `ralph/examples/README.md`.

`board doctor [--fix] [--strict]` is the invariant sweep — plus four `i`-level **state smells** (GH-1715: `repeated-claim-expiry`, `escalation-ping-pong`, `review-stalled`; GH-1777: `tend-proposal-stale`) read from the comment trail the machine already wrote. Info lines are advisory by construction: `--strict` never escalates them, `--fix` never acts on them, and a history read that throws degrades to `not evaluated` rather than touching the exit code. `board-volume` (GH-1788) is a fifth `i` line under the same rules — scanned nodes and pages vs `RALPH_VOLUME_MAX_ITEMS` (800), with `board prune` as the named remedy: a **dry run unless `--apply`** that removes long-closed terminal issues *from the project only*. The GitHub issue is left completely intact — title, body, comments, labels, closed state. What is lost is the **board item**: its Workflow State and Claim field values are deleted with it, and re-adding the issue to the project later does not bring them back. That is the one-way half, and the reason prune is offered rather than swept. One sweep removes at most `--limit` items (200) and aborts after 5 consecutive mutation failures, so a rate limit or a revoked scope cannot burn the budget this line of work exists to protect. `--json` reports the run it actually performed — under `--apply` it applies, and never silently reports a dry run. Its predicate fails closed on everything another reader still needs — non-terminal closes (doctor's drift sweep), recent closes (tend's Done audit), apply units, and any closed node an open item's tree walks through. `board readiness` is the advisory agent-readiness report (3 levels: interactive / unattended / autonomous loop — recommendations, never gates); `board help` lists everything.

### Enforcement layers (honestly labeled)

1. `board.ts` — typed gates at the path all sanctioned traffic uses.
2. `.github/workflows/state-guard.yml` — the corrective wall: issue-event lane (adopt/reconcile/parent gate) + 15-min reconciler cron (`doctor --fix`). Needs the `ROUTING_PAT` secret (GITHUB_TOKEN can't write a personal-account Projects V2 board). Every correction is a visible comment.
3. `ralph/hooks/funnel-{board,merge}.sh` — ~35-line courtesy redirects to the CLI / merge gate, registered once in `ralph/hooks/hooks.json`. **Never counted as enforcement.**
   - `ralph/hooks/hint-pr-linkage.sh` (GH-1717) is the *non-redirect* sibling: a PostToolUse observation that notes an unlinked `gh pr create` and never exits 2, because `gh pr create` has no sanctioned alternative to redirect to (the funnel-merge test, #1713). It stays silent on apply units — gate 6 forbids the very keyword a naive hint would ask for.
4. `.github/workflows/doctor.yml` — weekly `doctor --strict` from CI: the watcher-of-the-watcher (this repo has observed silent Actions non-fire and an expired PAT).

## Skills, Agent, Workflows

| Surface | Purpose |
|---|---|
| `/ralph:work` | The execution verb: claim → work at driver-judged depth (no prescribed phases) → PR → gates → close-out, under the 8-rule contract in its SKILL.md |
| `/ralph:deliver` | Follow-through lane (GH-1712): one pass over `board deliver-queue` — shepherd In Review PRs through the gate (token-mapped outcomes), close out merged-but-open items, demote semantic rework via the legal two-hop. Never `--force`; re-attests only via `attest-pr.sh --run --carry-review`; post-merge Done writes yield to reconcile |
| `/ralph:tend` | Hygiene lane (GH-1712): one bounded pass over `board tend-queue` — Backlog shape + Done audit, metadata-only, closures only ever PROPOSED via a `ralph-tend:v1 proposed` marker comment (surfaced back by the selector while pending; the human answers with `board resolve`). Grep the live tree before trusting a body |
| `/ralph:board` | Human surface: orientation, intake, answering Human Needed, doctor, readiness |
| `/ralph:help` | Topic-routed setup help (GH-1759): `herdr` checks/wires the herdr cockpit via `ralph/scripts/herdr-setup.sh` (check + permission-gated fix); `board doctor` relays the same script's verdict as the advisory `herdr-cockpit` info line |
| `ralph/agents/investigator.md` | Read-only fan-out worker — Read/Grep/Glob only (hard allowlist, no Bash) |
| `.claude/workflows/{research-panel,plan-critique,tree-impl,adversarial-review}.md` | Optional ultracode fan-out equipment — granted, never prescribed |

Model tiers (stated once in work/SKILL.md): sonnet default, haiku for mechanical fan-out, frontier (`fable`→`opus`) only as in-session bookends on feature/epic units; XS/S singles never touch frontier; escalate-never-preempt. `CLAUDE_CODE_SUBAGENT_MODEL=opus` is the harness escape hatch (flattens every tier).

## The Loop

`ralph/scripts/tick.sh` runs ONE iteration: lock (flock when present, else atomic noclobber pidfile) → heartbeat → `board next` (empty = exit before spawning) → worktree-per-job → `$RALPH_TICK_RUNNER "/ralph:work NNN"` with hard timeout → per-issue log; timeout releases the claim. The scheduler (launchd/cron via `install-loop.sh --enable`) owns cadence — no sentinels, no in-session wakeups; success is judged by board state, not exit codes (a no-op runner logs loudly).

- **Autopilot opt-in is typed and fail-closed**: `autopilot=true` in `~/.ralph/config`.
- **Billing guard**: tick refuses to spawn when `ANTHROPIC_API_KEY` is set (would bill API credits, not the subscription) unless `RALPH_ALLOW_API_BILLING=true`. `RALPH_TICK_RUNNER` makes the transport pluggable — interactive `/ralph:work` and bridge-routine drives are equally valid.

## Merge Gate (GH-1589; gate 6 added in GH-1694)

`main` is ruleset-protected — all changes land via PR; merge through `bash scripts/merge-pr.sh PR` (never bare `gh pr merge`; the funnel hook redirects — only in repos that ship the gate; host repos without `scripts/merge-pr.sh` keep their own merge flow). The script enforces: no `CHANGES_REQUESTED`, CI green, a head_sha-bound attestation (`scripts/attest-pr.sh` with real exit codes), an external review per `.github/ralph-merge-policy.json`, and apply-keyword hygiene (gate 6, see above — inert until the repo opts in). `validate-attestation.yml` republishes the verdict as the required `ralph-attestation` status. Gates are RUN, not predicted.

## CI/CD

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | push/PR | board-tests (vitest+tsc), knowledge, demo, hook/merge-gate script tests, shellcheck, actionlint+zizmor, mcp-pin check (knowledge) |
| `state-guard.yml` | issue events + 15-min cron | The corrective wall (see above) |
| `doctor.yml` | weekly + dispatch | Watchdog sweep |
| `validate-attestation.yml` | PR + attestation comments | Republishes the merge-gate verdict, plus the `ralph-apply-keywords` verdict (apply-kind hygiene) |
| `release-ralph.yml` | `ralph/**` on main | Plugin version bump + tag (no npm — the repo copy is the version) |
| `release-knowledge.yml` | `plugin/ralph-knowledge/**` on main | Knowledge npm release + pin |

**Verify release fired after merging `ralph/**`** — push-event workflows have silently not fired here before: `gh run list --commit <merge-sha>`; `workflow_dispatch` is the manual backup.

## Configuration

Scope vars live in the tracked `.claude/settings.json` `env` block: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` (+ optional `RALPH_GH_HOST` for GHE). A repo-root `.ralph.json` (`{owner, repo, projectNumber, host?}`) takes precedence when present. Auth is gh-keychain (`gh auth login -s repo,project`). Machine-local: `RALPH_LOCK_TTL_MIN`, `RALPH_CLAIM_HOLDER`, `RALPH_TICK_RUNNER`, `RALPH_TICK_TIMEOUT_MIN`, `RALPH_ALLOW_API_BILLING`, `RALPH_SMELL_CLAIM_EXPIRIES` / `RALPH_SMELL_ESCALATIONS` / `RALPH_SMELL_REVIEW_DAYS` / `RALPH_SMELL_PROPOSAL_DAYS` (doctor's state-smell thresholds, 2/3/7/7), `RALPH_GQL_COST=1` (log GitHub's own `rateLimit{cost}` per query to stderr — measurement mode, cost-neutral; observed table: `thoughts/shared/research/2026-08-11-graphql-cost-measurement.md`), `RALPH_VOLUME_MAX_ITEMS` / `RALPH_PRUNE_AFTER_DAYS` (board-volume advisory + prune age window, 800/180), `RALPH_ITEM_CACHE_TTL_SEC` (item-cache Δ, default 90, 0 disables, max 600 — see below), `~/.ralph/config` (`autopilot=true`).

### Item cache — reads may be stale, writes see truth (GH-1806)

The item walk is memoized to `~/.ralph/cache/items-{kind}-{select}-*` for 90 s, so a chain of board reads pays for one walk instead of one each. `--fresh` forces a walk for one command; a cached answer always says so, including on an empty queue.

This is **client-side bounded staleness, not a lease** — GitHub offers no server participation. Three rules carry the whole safety argument, all enforced in code:

1. **The cache never drives a write-guard evaluation.** Every MUTATING command, `doctor --fix`, and `prune --apply` run with the TTL zeroed (in `doctor()` itself, not only at the CLI dispatch), and every write path already re-reads the single item fresh at the guard. A stale entry can cost one wasted claim attempt — never a wrong transition — because the claim protocol is read-back verification, not read freshness.
2. **Read-your-writes + monotonic reads.** Every mutation bumps an `epoch` mark (hooked in `ghGraphQL`, the one path all writes take) and unlinks every selection variant; `servedAt` is a high-water mark. `fetchedAt` is stamped at the *start* of the walk, so a ~22 s walk that began before a write cannot end-stamp its way past the epoch check.
3. **An entry serves only a request its selection COVERS** (`selectCovers`). Since GH-1803 the walk's shape varies per caller, and an unselected group is *absent* from the item rather than empty — so serving a labels-less entry to a caller that reads labels would not lose data, it would fabricate "GitHub said there are none", and `next` would rank an item as unblocked whose dependencies were never fetched. `tsc` cannot catch this across a JSON file, so the check is at runtime and the cast on serve is honest only because it ran. The converse is free: a *wider* entry serves narrower requests, so a `list` or `doctor` walk pays for the `next`/`deliver-queue` reads after it. Entries are keyed by selection, so a lean walk cannot evict a fat one.

The cached walk also carries `scan` (GH-1788's meter), so `board-volume` and `prune`'s dry run report the board they were actually computed from rather than a zeroed counter.

## Gotchas

- **Projects V2 has no compare-and-swap.** The claim protocol makes races visible and refused (read-back + doctor), not impossible. One flock-serialized scheduler per machine keeps real concurrency rare.
- **The board can hold items from other repos.** board.ts resolves bare numbers within the configured repo only; foreign items are doctor-surfaced (`foreign-items`) and never written.
- **Archived items** are returned by the items API but reject writes — filtered everywhere. Corollary (GH-1788): **archiving buys no scan relief.** It hides an item from the board's views while every full scan still pages through it. Only removing the item from the project (`board prune`) shrinks a scan.
- **A full scan pays for more than issues.** ~47% of this board's paged nodes are pull requests and drafts: the `... on Issue` fragment never matches them, so they are invisible to `board.ts` and unprunable by it, yet cost a slot on every page. Volume is therefore *measured by the walk*, never inferred from survivors.
- **Legacy field options** (the 5 v1 states) can only be deleted from the Workflow State field in the board UI — the API cannot edit an existing field's option set.
- **Editing an existing field's options / creating fields**: `board setup` is idempotent and prints exactly which steps are manual.
- **GraphQL cost is per nested CONNECTION in the document** (not per field, not per node): each one over a 100-item page is +1 pt/page, so the item walk carries a `QueueSelect` and each caller asks only for what it reads (GH-1803 — `next`/`frontier`/`tend-queue` skip `labels`, `deliver-queue` skips both and runs at the 1-pt floor; `doctor` and `list` need both). An unselected group is **absent** from the item, never `[]` with `truncated: false` — the lean item types make `tsc` refuse the unguarded read, because a fail-closed flag is GitHub's assertion and a read that never asked may not make it. Trimming a nested `first:` is worth exactly zero (measured, twice).

## History

v1 (9 verb skills, 16 agents, 40 hooks, 20.7k-line MCP server, 11-state machine) was replaced in GH-1662 (PRs #1664/#1665/#1666+). Rationale and evidence: the design record + `thoughts/shared/plans/2026-07-31-GH-1662-ralph-v2-minimal-harness.md`. The npm package `ralph-hero-mcp-server` is deprecated. Historical references under `thoughts/` are point-in-time records, deliberately intact.
