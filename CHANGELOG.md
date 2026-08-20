# Changelog

All notable changes to this repo are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

This repo ships **two independently-versioned artifacts**, each released
automatically on merge to `main` (see [CONTRIBUTING.md](https://github.com/cdubiel08/ralph-hero/blob/main/CONTRIBUTING.md) § Releases):

- **`ralph`** — the Claude Code plugin. Tags: `ralph-vX.Y.Z` (via `release-ralph.yml`).
- **`ralph-knowledge`** — npm package. Tags: `knowledge-vX.Y.Z` (via `release-knowledge.yml`).
  (The former `ralph-hero-mcp-server` npm artifact was retired in GH-1662 and is deprecated.)

Because releases are tag-driven and automated, this changelog is **human-maintained**:
add entries under `## [Unreleased]` as you land user-visible changes; reconcile them
to a version heading when that artifact next releases. Full tag history:
<https://github.com/cdubiel08/ralph-hero/tags>.

## [Unreleased]

### Changed — the v2 rewrite (GH-1662)

- **ralph is now v2**: two skills (`/ralph:work`, `/ralph:board`), one read-only
  investigator agent, the typed `ralph/scripts/board` CLI as the sole board
  mutation path (6-state machine, claims with TTL, scope gate, doctor), a
  server-side `state-guard.yml` corrective wall, and a scheduler-owned
  `tick.sh` loop. Enforcement is code, not prose.
- **Removed**: the 9-verb skill surface, 16 agents, 40 hook scripts, the
  sentinel/loop protocol, 5 board-sync workflows, and the entire
  `mcp-server/` (the `ralph-hero-mcp-server` npm package is deprecated).
- Design record: `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`.

### Added

- `create_sub_issues` — batch tree-creation MCP tool; one call creates a
  parent's children, links each as a sub-issue, and wires dependency edges
  between them (GH-1565).

### Changed

- `batch_update` is now wired into `/ralph:caretake --mode split` Step 10,
  replacing per-child workflow-state updates with grouped batch calls
  (GH-1565).
- Tree-creation call sites (`caretake --mode split` §Step 6) now use
  `create_sub_issues` instead of per-child creation + `add_sub_issue` +
  `add_dependency` sequences.
- `create_sub_issues` splits the old overloaded `dependsOn` into two per-child
  arrays: `dependsOn` (sibling indices only, validated in-range) and
  `dependsOnIssues` (existing GitHub issue numbers). Both capped at 50
  (GH-1565).
- The `ralph_split` per-command workflow-state allowlist is **not** enforced by
  `create_sub_issues` / `batch_update` — those tools pass estimate / priority /
  workflowState through unchanged. Policy gating lives in the caretake hooks
  (`split-size-gate.sh` et al.) by design (plan decision, GH-1565).
- `~/.ralph-hero/logs` JSONL debug logs no longer have an in-repo reader —
  `debug-logger.ts` still writes them under `RALPH_DEBUG=true`, but retention
  and rotation are now the operator's concern (GH-1565).

### Removed

- Zero-reference MCP tools: `create_draft_issue`, `update_draft_issue`,
  `convert_draft_issue`, `get_draft_issue`, `list_groups`, `create_views`,
  and the `RALPH_DEBUG`-gated `debug_stats`. The `debug_stats` removal
  reverses its earlier "preserved for backward compat" note (GH-1566).

Note: net MCP tool surface is now 38 → 32 (31 always-on + `collate_debug`
under `RALPH_DEBUG`). GH-1552 may add one more tool later, which would
adjust this count again.

### Fixed

## [0.2.0] — ralph plugin

Release theme: the 2026-08-19 ways-of-working audit
(`thoughts/shared/research/2026-08-19-ways-of-working-audit/`) — 10 days of
session transcripts and traces mined for friction, adversarially verified
against the live tree, and converted into typed verbs, exit codes, doctor
lines, hooks, and tests. Sections mirror the audit's A/B/C/D structure.

### A. Happy-path speedups

- **A1 — stable board resolver**: `ralph/scripts/resolve-board.sh` resolves the
  installed board CLI (registry `installPath`, `$CLAUDE_CONFIG_DIR` honoured,
  warned in-tree fallback — always one path, always exit 0); a SessionStart
  hook (`resolve-board-context.sh`, not HERDR-gated) emits `RALPH_BOARD=<path>`
  and regenerates the `~/.ralph/bin/board` shim, which re-resolves at CALL
  time so a mid-session release is picked up. Funnel refusals prefer
  `$RALPH_BOARD` over pinned versioned paths.
- **A2 — orientation verbs**: `board brief` (one read: next head, queue
  counts, deliver/tend counts, local leases, cache facts) and `board who`
  (the GH-1929/1956 per-(worktree, unit) leases, zero API; unreadable dir
  reads "not evaluated", never "nobody").
- **A4 — `scripts/review-threads.sh`**: paginated review-thread reader/writer
  (`--unresolved`, `--reply`, `--resolve` + the GH-1847 recompute nudge), dual
  badge parser (Codex + Greptile), rate-limited writes typed via gh-budget;
  unreadable list is a distinct exit, never "no threads". `GATE-YOURS review`
  now hands back this reader.
- **A5 — vocabulary**: `board dep --blocked-by` (alias for `--on`),
  `board help <verb>` per-verb usage with examples.
- **A6 — event-driven cockpit refresh**: board.ts's write marks
  (`~/.ralph/cache` epoch, GH-1806) are now watched by the cockpit per tick —
  a local write snaps polling to the floor and refetches immediately; the
  poll remains the reconciler for foreign edits.
- **A8 — policy-default attest runs**: a `verify` block in
  `.github/ralph-merge-policy.json` (`runs` + path-scoped `pathRuns`) is the
  default `--run` set when `attest-pr.sh` gets none; explicit flags always
  win; an absent block keeps the old refusal (now naming the block).

### B. Sad-path resiliency

- **B1 — idempotent terminal transitions**: same-state moves are retries, not
  violations — a pure noop when nothing is missing, and a half-applied
  terminal close (field written, close lost) is completed on the same
  evidence a fresh move demands. `doctor --fix` completes the close the board
  was ahead of instead of demoting finished work; no evidence still demotes.
- **B2 — typed transport + budget attribution**: `TransientError` → exit 75
  (EX_TEMPFAIL) for rate limits (with the reset instant) and retried-out
  transport failures; ghGraphQL retries transport-shaped failures for READS
  only (mutations keep GH-1973's read-back-over-replay); ranking/selector
  lanes pre-flight the free REST rate_limit read and defer under
  `RALPH_GH_BUDGET_FLOOR` before any read (fails open on an unreadable
  budget, GH-1817); cost instrumentation is on by default (`RALPH_GQL_COST=0`
  disables, `=1` narrates) and every invocation appends one attribution line
  to `~/.ralph/budget.jsonl`; doctor's `gql-spend` reports 24h top spenders.
- **B3 — attest-pr.sh refuses the unrunnable**: an all-failed run set whose
  failures match unrunnable shapes (`command not found`, missing modules, the
  tsc squatter, vitest config death) refuses with `NEXT: npm ci` instead of
  posting an attestation that asserts nothing; runs are cached per head_sha
  and `--resume` re-posts only at an unchanged head; every kit script gained
  a real `--help` and every refusal a runnable `NEXT:` line.
- **B4 — cmdscan command position**: GraphQL mutation names count only in
  segments whose command word is `gh`/`curl` — grep/sed/python argument text
  is data; the board-CLI self-allow covers `$RALPH_BOARD`, the shim, and bare
  `board`. Every observed false positive is pinned in `cmdscan.test.sh`.
- **B5 — triage visibility**: doctor's `untriaged-priority` counts
  null-priority Backlog items (invisible to ranking) and names
  `board priority`.
- **B6 — lock-aware stale-claim release**: `doctor --fix` consults the
  GH-1956 worktree lock before releasing a stale board claim (the
  network-flap divergence: local heartbeat landed, board write did not) —
  held rows read `claim-idle-but-driven`; a null probe keeps today's release.
  New `worktree-uncommitted` row surfaces dirty issue-branch worktrees with
  no live claim — the shape a TTL release leaves behind.
- **B7 — reviewer-rate-limited surfaced**: deliver-queue rows whose gate text
  says the reviewer is rate-limited become their own blocked row
  (self-clearing, never escalating); `pr-gate-watch --watch` annotates a
  review wait past `RALPH_REVIEW_ANSWER_MAX_MIN` (default 30) with the
  prefilled human-needed move — an annotation, never a new verdict.
- **B8 — typed closes for PR-less units**: `In Progress → Done` is legal (the
  GH-1777 destination-keyed-gates argument extended), apply units close on
  their evidence comment, and decision units close on a
  `ralph-decision-evidence:v1` marker (`board move NNN done --decision
  <artifact>`). `board defer NNN --until "<condition>" [--recheck ISO]` parks
  unready items out of ranking (a Defer text field riding the fieldValues
  page — zero extra GraphQL cost); claiming lifts it; doctor's
  `defer-elapsed` surfaces passed rechecks; the empty queue diagnosis gains
  `all-deferred`.
- **B9 — accepted proposals finish or say so**: `resolve --accept` prints the
  gated follow-up disposition; reopen resolutions stamp `actioned`;
  accepted-but-unmoved items join `tend-proposal-stale` immediately.
- **B10 — skill-path lint** (`ralph/scripts/skill-paths.test.ts`): every
  `bash`/`sh` invocation in skill docs must be `${CLAUDE_PLUGIN_ROOT}`-anchored,
  absolute, placeholder-anchored, or a `ralph/kit/` host-contract path; no
  `board.ts:<line>` citations. Pins the GH-2074 defect classes (PR #2090).

### C. Foreign-codebase readiness

- **C1 — readiness verifies its own alternatives**: the merge-gate rung is
  satisfied by required status checks under the effective branch rules — the
  alternative its miss text always named, now checked instead of recommended.
- **C2 — `board bootstrap`**: first-run bring-up (`--owner --repo --project
  [--host]`) writes `.ralph.json` (refuses overwrite — no --force exists
  anywhere), links the repo, runs setup, prints the env snippet and next
  steps. `board help` runs config-free; the missing-config error names
  bootstrap; doctor's scope line distinguishes not-a-repo from
  no-origin-remote.
- **C3 — host-repo orientation from the kit** (`install-gates.sh`):
  - advisory hooks vendored into host repos at `.claude/hooks/`:
    `ralph-kit-orient.sh` (SessionStart one-liner naming the gate family and
    the after-push command, or "board configured, gates not installed") and
    `funnel-gate-watch.sh` + `lib/cmdscan.sh` for plugin-less hosts.
    Registration is a printed manual step — the installer never edits host
    settings.
  - a managed CLAUDE.md operator-asks fragment between
    `<!-- BEGIN/END ralph-kit -->` markers: host content outside is never
    touched, edits inside are respected, a deleted block is a durable opt-out.
  - kit manifest schema grew `sources` and `fragments`; `kit-sync.sh` remains
    the one writer; `kit.test.ts` asserts byte-identity for all of it.
- **C4 — sanctioned cross-repo add**: `board add <issue-url>` — the
  non-own-repo add path the GH-1815 guard was built to gate, policy-checked
  before any read (`RALPH_ALLOW_FOREIGN_REPO_ITEMS` unset/false refuses with
  the reason).

### D. Herdr integration

- **D1 — worktree provisioning at spawn**: after `git worktree add`, the
  spawn path runs the host's `scripts/provision-worktree.sh` if executable,
  else a lockfile-matched install when `node_modules` is absent; the path
  taken is printed into the pane. Fail-open — the fail-closed half is B3's
  attest gate.
- **D2 — spawn verification + provisional ledger**: spawn confirms the turn
  actually started (chunked `agent wait` up to
  `RALPH_HERDR_SPAWN_CONFIRM_SEC`), prints `SPAWN-UNCONFIRMED <pane>` with
  the resubmit command, probes once for the known blocking modals
  (`pane-blocked-modal`); the spawn record is provisional at pane creation so
  a worker dead before claiming leaves a sweepable row.
- **D3 — lock-aware spawn pre-check**: `spawn_work_session` also skips units
  held by a fresh GH-1956 worktree lock (read-only — can only skip, never
  override; the claim-first spawner was rejected as conflicting with
  work-fleet's never-writes charter).
- **D4 — content-hash plugin freshness**: `herdr-setup.sh check` hashes the
  installed plugin tree against the repo's (version strings were measured
  equal while trees differed); `herdr-plugin-sync.sh` prints, reinstalls, and
  verifies by re-hashing. Stays an advisory `i` at doctor.
- **D5 — fleet surfaces**: `fleet-status.sh` (one-shot table/JSON with the
  dead-before-start discriminator derived from herdr's own agent_status —
  tokens stay decoration) and `fleet-send.sh` (typed message template;
  `--wait` stripped loudly for lead targets). Both in CHEATSHEET §7.
- **D6 — reap + cockpit supervision**: `herdr-setup.sh reap [--apply]
  [--limit N]` closes panes whose checkout is gone, kills processes rooted in
  deleted worktrees (#2159 shape), names stale unknown panes — dry-run
  default, every kill keyed on a local-filesystem fact, ownership-unclear is
  listed never acted on, board never written (claim release stays
  claim-recover.sh's pane-proved job). The cockpit now writes a heartbeat;
  `check` reports `cockpit-down`; CHEATSHEET documents launchd KeepAlive.

### Tooling / release

- ESLint flat config (typescript-eslint recommended, scoped to
  `ralph/scripts/`) + `npm run lint` / `npm run lint:sh`; the whole repo
  passes at error level.
- ralph-herdr plugin 0.8.2 → 0.9.0 (stamp pair in lockstep).
- Version: this release is stamped by the `#minor` merge annotation
  (0.1.x → 0.2.0 via `release-ralph.yml`).

## Released

### ralph plugin — [ralph-v0.1.32](https://github.com/cdubiel08/ralph-hero/releases/tag/ralph-v0.1.32)

Latest released version of the `ralph` Claude Code plugin (9 verb skills:
catch-up, form, research, plan, impl, review, caretake, hero, setup). This
changelog was seeded at this version; earlier history is in the
[git tags](https://github.com/cdubiel08/ralph-hero/tags) and release notes.

### ralph-hero-mcp-server — [v2.5.191](https://github.com/cdubiel08/ralph-hero/releases/tag/v2.5.191)

Latest published version of the `ralph-hero-mcp-server` npm package (GitHub
Projects V2 workflow tools). Seeded at this version; earlier history is in the
[git tags](https://github.com/cdubiel08/ralph-hero/tags).
