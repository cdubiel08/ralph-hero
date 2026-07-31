# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`ralph` v2 (GH-1662) — a Claude Code plugin for board-driven autonomous development over a GitHub Projects V2 board. Two skills, one read-only agent, one typed board CLI, two courtesy hooks, and a scheduler-owned loop. The driving model sequences its own research/plan/build/verify; enforcement is code, not prose. Design record (normative): `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`.

The repo also ships two independent plugins: `plugin/ralph-knowledge/` (semantic search over thoughts/, own MCP server + npm release) and `plugin/ralph-playwright/` (UI-testing skills), plus `plugin/ralph-demo/` (Remotion demo videos).

## Build & Test

From the repo root:

```bash
npm install                                    # workspace dev deps (tsx, vitest)
npx vitest run ralph/scripts/board.test.ts     # the board CLI's contract suite
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

- **transition** — agent intent, guarded by the MACHINE table. Claim = `{holder}|{iso8601}` in the Claim text field, TTL 120 min (`RALPH_LOCK_TTL_MIN`); `--steal` posts an eviction comment; **no `--force` exists anywhere** — stale TTL is the only side door. Read-back verifies the claim won (GitHub has no CAS; the loser backs off).
- **reconcile** — GitHub reality wins: closed→Done/Canceled, reopened→Backlog, off-board→adopt. Every correction posts a comment.
- **parent-check** — rollup: all children closed → parent to In Review (deliberately multi-hop; fails closed on truncated child lists).

Guards by construction: scope gate (origin remote must match configured host/owner/repo before any mutation, incl. `doctor --fix`); cross-repo board items are partitioned by `ownRepo()` and never touched (bare-number resolution would hit the wrong repo's issue); archived items skipped everywhere; blocker-list truncation counts as blocked.

`board doctor [--fix] [--strict]` is the invariant sweep; `board help` lists everything.

### Enforcement layers (honestly labeled)

1. `board.ts` — typed gates at the path all sanctioned traffic uses.
2. `.github/workflows/state-guard.yml` — the corrective wall: issue-event lane (adopt/reconcile/parent gate) + 15-min reconciler cron (`doctor --fix`). Needs the `ROUTING_PAT` secret (GITHUB_TOKEN can't write a personal-account Projects V2 board). Every correction is a visible comment.
3. `ralph/hooks/funnel-{board,merge}.sh` — ~35-line courtesy redirects to the CLI / merge gate, registered once in `ralph/hooks/hooks.json`. **Never counted as enforcement.**
4. `.github/workflows/doctor.yml` — weekly `doctor --strict` from CI: the watcher-of-the-watcher (this repo has observed silent Actions non-fire and an expired PAT).

## Skills, Agent, Workflows

| Surface | Purpose |
|---|---|
| `/ralph:work` | The execution verb: claim → work at driver-judged depth (no prescribed phases) → PR → gates → close-out, under the 8-rule contract in its SKILL.md |
| `/ralph:board` | Human surface: orientation, intake, answering Human Needed, doctor |
| `ralph/agents/investigator.md` | Read-only fan-out worker — Read/Grep/Glob only (hard allowlist, no Bash) |
| `.claude/workflows/{research-panel,plan-critique,tree-impl,adversarial-review}.md` | Optional ultracode fan-out equipment — granted, never prescribed |

Model tiers (stated once in work/SKILL.md): sonnet default, haiku for mechanical fan-out, frontier (`fable`→`opus`) only as in-session bookends on feature/epic units; XS/S singles never touch frontier; escalate-never-preempt. `CLAUDE_CODE_SUBAGENT_MODEL=opus` is the harness escape hatch (flattens every tier).

## The Loop

`ralph/scripts/tick.sh` runs ONE iteration: lock (flock when present, else atomic noclobber pidfile) → heartbeat → `board next` (empty = exit before spawning) → worktree-per-job → `$RALPH_TICK_RUNNER "/ralph:work NNN"` with hard timeout → per-issue log; timeout releases the claim. The scheduler (launchd/cron via `install-loop.sh --enable`) owns cadence — no sentinels, no in-session wakeups; success is judged by board state, not exit codes (a no-op runner logs loudly).

- **Autopilot opt-in is typed and fail-closed**: `autopilot=true` in `~/.ralph/config`.
- **Billing guard**: tick refuses to spawn when `ANTHROPIC_API_KEY` is set (would bill API credits, not the subscription) unless `RALPH_ALLOW_API_BILLING=true`. `RALPH_TICK_RUNNER` makes the transport pluggable — interactive `/ralph:work` and bridge-routine drives are equally valid.

## Merge Gate (unchanged from GH-1589)

`main` is ruleset-protected — all changes land via PR; merge through `bash scripts/merge-pr.sh PR` (never bare `gh pr merge`; the funnel hook redirects). The script enforces: no `CHANGES_REQUESTED`, CI green, a head_sha-bound attestation (`scripts/attest-pr.sh` with real exit codes), and an external review per `.github/ralph-merge-policy.json`. `validate-attestation.yml` republishes the verdict as the required `ralph-attestation` status. Gates are RUN, not predicted.

## CI/CD

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | push/PR | board-tests (vitest+tsc), knowledge, demo, hook/merge-gate script tests, shellcheck, actionlint+zizmor, mcp-pin check (knowledge) |
| `state-guard.yml` | issue events + 15-min cron | The corrective wall (see above) |
| `doctor.yml` | weekly + dispatch | Watchdog sweep |
| `validate-attestation.yml` | PR + attestation comments | Republishes the merge-gate verdict |
| `release-ralph.yml` | `ralph/**` on main | Plugin version bump + tag (no npm — the repo copy is the version) |
| `release-knowledge.yml` | `plugin/ralph-knowledge/**` on main | Knowledge npm release + pin |

**Verify release fired after merging `ralph/**`** — push-event workflows have silently not fired here before: `gh run list --commit <merge-sha>`; `workflow_dispatch` is the manual backup.

## Configuration

Scope vars live in the tracked `.claude/settings.json` `env` block: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` (+ optional `RALPH_GH_HOST` for GHE). A repo-root `.ralph.json` (`{owner, repo, projectNumber, host?}`) takes precedence when present. Auth is gh-keychain (`gh auth login -s repo,project`). Machine-local: `RALPH_LOCK_TTL_MIN`, `RALPH_CLAIM_HOLDER`, `RALPH_TICK_RUNNER`, `RALPH_TICK_TIMEOUT_MIN`, `RALPH_ALLOW_API_BILLING`, `~/.ralph/config` (`autopilot=true`).

## Gotchas

- **Projects V2 has no compare-and-swap.** The claim protocol makes races visible and refused (read-back + doctor), not impossible. One flock-serialized scheduler per machine keeps real concurrency rare.
- **The board can hold items from other repos.** board.ts resolves bare numbers within the configured repo only; foreign items are doctor-surfaced (`foreign-items`) and never written.
- **Archived items** are returned by the items API but reject writes — filtered everywhere.
- **Legacy field options** (the 5 v1 states) can only be deleted from the Workflow State field in the board UI — the API cannot edit an existing field's option set.
- **Editing an existing field's options / creating fields**: `board setup` is idempotent and prints exactly which steps are manual.

## History

v1 (9 verb skills, 16 agents, 40 hooks, 20.7k-line MCP server, 11-state machine) was replaced in GH-1662 (PRs #1664/#1665/#1666+). Rationale and evidence: the design record + `thoughts/shared/plans/2026-07-31-GH-1662-ralph-v2-minimal-harness.md`. The npm package `ralph-hero-mcp-server` is deprecated. Historical references under `thoughts/` are point-in-time records, deliberately intact.
