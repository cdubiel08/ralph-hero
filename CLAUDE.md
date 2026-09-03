# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`ralph` v2 (GH-1662) — a Claude Code plugin for board-driven autonomous development over a GitHub Projects V2 board. Two skills, one read-only agent, one typed board CLI, four hooks (three courtesy funnels + one PostToolUse observation), and a scheduler-owned loop. The driving model sequences its own research/plan/build/verify; enforcement is code, not prose. Design record (normative): `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`. The shape of the *work* the board carries — units, sizing, ordering, freshness — is `thoughts/shared/ideas/2026-08-23-board-work-shape-design.md` (normative), with its §2 vocabulary projected verbatim into the root `CONTEXT.md`.

**Operator asks — answer from `plugin/ralph-herdr/CHEATSHEET.md`, don't re-derive:** "launch a fleet" → `bash plugin/ralph-herdr/scripts/work-fleet.sh [NNN...]` (§6); "open the cockpit" → `herdr plugin action invoke cockpit --plugin ralph-herdr` (§3); "what's on the board / who's working" → `board list` / `board next` / `herdr agent list` (§7). Measured (GH-2074/GH-2075): without this pointer every session re-discovers these paths in 5–15 tool calls, and haiku lands on `tick.sh` instead of the fleet.

The repo also ships two independent plugins: `plugin/ralph-knowledge/` (semantic search over thoughts/, own MCP server + npm release) and `plugin/ralph-playwright/` (UI-testing skills), plus `plugin/ralph-demo/` (Remotion demo videos).

## Build & Test

From the repo root:

```bash
npm install                                    # workspace dev deps (tsx, vitest, eslint)
npx vitest run ralph/scripts/                  # board contract suite + metrics registry
npx tsc --noEmit                               # typecheck
npm run lint                                   # eslint (ralph/scripts, error level)
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

The cockpit is Go and CI gates it on **formatting** as well as tests, so a
green `go test` is not a green `test-hooks`: from `plugin/ralph-herdr/cockpit/`,
run `gofmt -l .` (must print nothing) before `go vet ./... && go test ./...`.

ralph-knowledge builds/tests from `plugin/ralph-knowledge/` (`npm ci && npm run build && npm test`).

`scripts/dream/` (Python, `uv run --locked --extra test pytest tests/`) is the
one Python surface in this repo where units are accepted under a
mutate-restore-confirm mutation-testing practice; that surface's `README.md`
documents a false-red trap in the restore step (a stale `__pycache__`) and its
one-line remedy — read it before mutation-testing a change there.

## The Board (source of truth)

Seven states, one machine, three write lanes — all in `ralph/scripts/board.ts` (run via `ralph/scripts/board`, a bun→tsx shim):

```text
Intake → Backlog → In Progress → In Review → Done
                        ↕︎    ↘︎         ↓
                   Human Needed ←──────┘   Canceled (explicit cancel; reopen = only exit from terminal)
```

**Intake (GH-2077) is the approval tier** — before it, filing an issue *was*
approving it for autonomous pickup, so every way to track unapproved work was
dishonest or invisible to `tend`/`doctor`. It is a seventh Workflow State
rather than a field or label, fail-closed by construction: every eligibility
read already filters `state === "Backlog"`, so an Intake item drops out of
`next`/`frontier` with zero predicate change. Design record (normative):
`thoughts/shared/ideas/2026-08-18-GH-2060-intake-tier-design.md`; full
implementation rationale (surfaces, `board setup`'s option-add mechanism, the
epic in-flight probe fix, what stayed deliberately unchanged):
`thoughts/shared/research/2026-09-02-claude-md-intake-tier-implementation.md`.

**Edges are strictly one-way**: `Intake → Backlog | Canceled`, nothing else —
no demotion edge back to Intake, and `Intake → In Progress` is absent, so
`board claim` on an unapproved item refuses via the MACHINE with no special
code. Approval (`Intake → Backlog`) refuses without a Priority **and** an
Estimate — Backlog means approved *and* rankable.

**`create` has no default landing state**: `--intake` (minimal detail,
Priority/Estimate optional) or `--backlog` (both REQUIRED, the refusal names
whichever is missing); neither flag → a refusal naming both lanes. The
readiness bar is one helper, `backlogReadinessGaps`, called by both the
approval edge and `create` — two spellings of "approved and rankable" held
apart by a comment is the GH-1843 drift shape.

**Surfaces**: `next`/`frontier` exclude Intake by construction (pinned by a
test, including the epic in-flight probe). `list` shows Intake by default.
`tend-queue`'s existing `unformed` category takes Intake items with their
age. `doctor` gains an advisory `intake-stale` line
(`RALPH_SMELL_INTAKE_DAYS`, 14), info-only — never strict-escalated, never
`--fix`ed, since the only remedies are a human's approval or rejection.
`deliver-queue`, `prune` and `board-volume` are untouched by construction.
**`board setup` adds the option itself (GH-2127)**: `updateProjectV2Field`
resubmits every existing option with its id and verifies the add by **id
survival**, never the ack; an unreadable current option set refuses the
mutation and prints the manual step. Until the option exists, every Intake
filing and move fails closed on the missing-option refusal. Deliberately
unchanged: state-guard adoption still lands Backlog (GH-1952 must reach a
driver unattended), and so does `reopen`.

**Backward edges are tightened (GH-2078, the second GH-2060 unit).**
`In Progress → Backlog` and `In Review → In Progress` refuse without a
`--why`, landed as a comment before the state write. `Human Needed →
Backlog` is REMOVED from the machine: an answered item resumes (`→ In
Progress`) or dies (`→ Canceled`) — no parking edge out of an escalation.
Deliberately untouched: doctor's stale-claim demotion and `reconcile`.

**The resume edge belongs to the RESUMING agent (GH-2204).** `board answer
NNN -m` is comment-only — the Answer comment lands and the item STAYS Human
Needed; the driving session takes `Human Needed → In Progress` itself via
`board claim NNN`, so the session→unit binding (GH-1948), the worktree lock
(GH-1956) and the size ceiling (GH-2134) all bind on the actual driver.
`--resume` keeps the one-invocation form for self-answer. `board
escalations` marks answered-but-unresumed rows `ANSWERED … resume pending`;
doctor's `answer-unresumed` `i` line ages them past `RALPH_SMELL_ANSWER_MIN`
(30 min).

**Escalations carry an audience (GH-2179, the GH-2176 arbitration unit).**
In a team, a worker's `move NNN human-needed --why` routes to the epic's
**lead** via a `ralph-escalation:v1` marker (no marker = human-addressed).
Default keys on `$RALPH_HERDR_LEAD`; `--to-human` forces the reserved-set
direction, `--to-lead <name>` is explicit. The lead dispositions via
`answer` or **`board promote NNN [-m]`** (durable marker, no state change).
**Promotion writes the inbox directly (GH-2218)**: `board inbox` Tier 1
withholds a lead-routed escalation still inside its window as a counted
`with leads` line — never dropped — and a promotion (the lead's or the TTL's)
is the admission. **The TTL bound is computed at read time** by `board
escalations` (`RALPH_LOCK_TTL_MIN`), never by a cron. `board contract
validate ralph.escalation` is the deliberate check.

Full rationale for this subsection:
`thoughts/shared/research/2026-09-02-claude-md-board-edges-and-escalation-history.md`.

v0.2.0 (the 2026-08-19 ways-of-working audit; full history in
CHANGELOG.md): **In Progress → Done is legal** (gates key on the
destination) — apply units close on their evidence comment, decision units
via `board move NNN done --decision <artifact>` binding a
`ralph-decision-evidence:v1` marker. **Same-state moves are retries, not
violations** — a pure noop, or a fresh move completing a half-applied
terminal close on the same evidence (`doctor --fix` does the same). **`board
defer NNN --until "<condition>" [--recheck ISO]`** parks unready Backlog
items out of ranking via a Defer field; claiming lifts it. **`board brief`**
(queues + leases) and **`board who`** (leases, zero API) are the orientation
reads. **A lease whose checkout was deleted is DEAD, not stale (GH-2108)** —
`who` is machine-wide and withholds nothing; `brief` is repo-scoped. `board
reap-leases [--apply]` reaps on the **missing checkout**, never age; **`--closed`
adds the second key (GH-2368)**: the unit is CLOSED on GitHub. **`board
bootstrap`** is the config-free first-run bring-up; **`board add <url>`** is
the sanctioned cross-repo add behind `RALPH_ALLOW_FOREIGN_REPO_ITEMS`.
Transport failures and rate limits are typed **exit 75** (EX_TEMPFAIL, reads
retried bounded, mutations never — GH-1973 stands); lanes pre-flight
GraphQL's own free `rateLimit` field and defer under `RALPH_GH_BUDGET_FLOOR`
(GH-2278); every invocation appends a spend line to `~/.ralph/budget.jsonl`
(doctor's `gql-spend`; `RALPH_GQL_COST=0` disables, `=1` narrates). Full
rationale:
`thoughts/shared/research/2026-09-02-claude-md-v0.2.0-ways-of-working-audit.md`.

- **transition** — agent intent, guarded by the MACHINE table. `Backlog →
  Done` is legal (GH-1777): already-delivered work closes through the gated
  lane rather than detouring via `reconcile`, which writes the state field
  unchecked. **Done evidence** is a merged closing-reference PR, a merged PR
  on a branch that *parses* as this issue's (`board name NNN`'s grammar,
  legacy included — GH-1732; the branch read is a merged-PR search via
  `head:` qualifiers, GH-1996, never a live-ref read, since `merge-pr.sh`
  deletes the head ref on merge), or **one derived form (GH-2198): an epic
  root every one of whose children is closed** (a Canceled child counts; a
  truncated child list counts as not-all-closed; the refusal on a
  non-qualifying root names the children still open). Every unreadable path
  returns no evidence. `Backlog → Human Needed` stays illegal — a tend
  closure proposal instead files a `<!-- ralph-tend:v1 proposed -->` marker
  comment, disposed via `board resolve NNN --accept|--reject` (or the close
  itself for a proposal filed before it). Claim = `{holder}|{iso8601}` in
  the Claim field, TTL 120 min (`RALPH_LOCK_TTL_MIN`); `--steal` posts an
  eviction comment; **no `--force` exists anywhere** — stale TTL is the only
  side door; read-back verifies the winner. **A verified claim also binds
  the session to the unit (GH-1948)**: contract rule 9 ("one unit per
  session") is enforced in code — a second *distinct* claim from one
  session is refused, tracked locally
  (`~/.ralph/sessions/<session-id>.json`, keyed on
  `CLAUDE_CODE_SESSION_ID`) because the board holder (`user@host`) is
  shared by every session on the machine. No session id → not evaluated.
  **A second guard is keyed on the worktree (GH-1956)** for the fork-pane
  case the session key is blind to: a per-(worktree, unit) lock file,
  `link(2)`-atomic and `EEXIST`-failing, read-back-verified, `--steal`
  displacement serialized by a short-lived, non-expiring mutex, staleness on
  the same `RALPH_LOCK_TTL_MIN` clock as the board claim. Full rationale
  (every rejected alternative, the O_EXCL argument, the displacement race):
  `thoughts/shared/research/2026-09-02-claude-md-mutation-lane-guards.md`.
- **create** — retry-safe (GH-1973): a pre-mutation twin search
  (byte-identical title, OPEN, viewer-authored, inside
  `RALPH_CREATE_DEDUPE_SEC`/300, 0 disables) adopts an already-filed issue
  instead of duplicating it, and a read-back on mutation failure resolves
  the lost-response case in-invocation. A failed guard **warns and files**
  rather than refusing. `--allow-duplicate` is the explicit assertion that a
  second issue is meant. Rationale:
  `thoughts/shared/research/2026-09-02-claude-md-mutation-lane-guards.md`.
- **reconcile** — GitHub reality wins: closed→Done/Canceled,
  reopened→Backlog, off-board→adopt. Every correction posts a comment.
- **parent-check** — rollup: all children closed → parent to In Review
  (deliberately multi-hop; fails closed on truncated child lists).

Guards by construction: scope gate (origin remote must match configured host/owner/repo before any mutation, incl. `doctor --fix`); cross-repo board items are partitioned by `ownRepo()` and never touched (bare-number resolution would hit the wrong repo's issue); archived items skipped everywhere; blocker-list truncation counts as blocked.

### Apply units — merge ≠ done (GH-1692)

Opt-in, via an `apply` block in `.github/ralph-merge-policy.json` (`enabled`,
`label`, `infraPaths`) — the same file the merge gate reads, so a repo opts
in once and `board.ts` + `merge-pr.sh` cannot drift. **ralph-hero armed it
on 2026-08-02 (#1696)**: `enabled: true`, label `ralph:apply`, `infraPaths`
`[".github/**", "ralph/scripts/install-loop.sh"]`.

An issue carrying the configured apply label (`apply.label`, default
`ralph:apply`) is work whose completion is a *deploy*, not a merge —
terraform, secrets, rulesets, a scheduled job's next fire. Four enforcement
points:

| | |
|---|---|
| **Decomposition** | infra-touching units split into a ship issue + one or more apply units (`board create --backlog --apply`, resolving the configured label); settings-only changes get *only* an apply unit |
| **Merge gate 6** | `scripts/apply-keywords.sh` — no closing keyword may bind an apply unit, and an infra-touching PR may not close a ship issue with no apply twin. Republished as the `ralph-apply-keywords` status (recomputed on `edited`) |
| **Close gate** | `transition()` refuses Done without a shape-valid `ralph-apply-evidence:v1` comment (`scripts/apply-evidence.sh` posts one). No `--why` escape. `kind=run` evidence must bind `run.head_sha == merge_sha` **and descend from the fix merge (GH-1961)** — derived from the apply unit's `blockedBy` twin, reachable-from-default-branch tested (never the PR's recorded base name). `--fix-merge <sha>` only *adds* to the derived set, never suppresses it. **The ancestry reason is typed and the gate reads it (GH-2261)**: `no_subject` (settings-only, passes) vs `read_failed` (refuses, posts nothing) — closing the hole where a failed read once rendered as a pass and `board.ts` never checked `ancestry` at all. An **absent** `ancestry` refuses (grandfathered forward-only against one dated constant, GH-1841's precedent) |
| **Surfacing** | doctor's `merged-unapplied`, `apply-verify-elapsed` (honours `<!-- ralph-verify-after: ISO -->` in the body), `apply-closed-unevidenced` (strict-fail; `--fix` reopens to Human Needed) |

Honestly labelled limits: GitHub has no pre-close hook, so a UI close is
*corrected within one reconcile pass*, not prevented (tens of minutes, not
15 — see the cron ceiling under Enforcement layers); a label added after a
PR's status was computed doesn't recompute it (merge time is the backstop);
non-run evidence proves a command exited 0, not that the operator's claim
is true. Full ancestry rationale:
`thoughts/shared/research/2026-09-02-claude-md-apply-units-history.md`.
Plan: `thoughts/shared/plans/2026-08-01-infra-apply-isolation.md`.

### Lane selectors and the doctor sweep

Branch and agent names are **derived, once** (GH-1807) — `board name NNN` is
the only grammar; details in `ralph/CLAUDE.md`.

**Lane selectors** (GH-1712): `board deliver-queue` (quiescent In Review
items with actionable PR signal — marker-gated per PR, gate truth from
`merge-pr.sh --dry-run`, bounded verdict-agnostic retry) and `board
tend-queue` (stale bodies, cleared/truncated deps, unjudged high-overlap dep
candidates — `deps-unwired`, GH-2136, dismissals via `board dep --dismiss` —
unformed intake, unaudited closes).

**The Done audit is O(exceptions), not O(closes) (GH-2151).** A close
carrying the gated Done lane's own evidence — a merged closing PR, or
shape-valid `ralph-decision-evidence:v1` / `ralph-apply-evidence:v1`
evidence judged by the gate's OWN validators — self-audits at read time,
withheld from `done-audit` as a counted `evidenced` line (never silent),
with no marker written. NOT_PLANNED closes are excluded entirely
(`reconcile`'s own rule). What still surfaces is the no-closing-keyword
population the audit exists for (epic-root rollup closes, `--why` closes,
GH-1996 branch-linkage-only closes). Doctor's `done-audit-pending` `i` line
counts the current window's still-curable exceptions, never the
already-expired.

**`deliver-queue` also refuses a unit a live local session is driving
(GH-1929)** — reads the per-(worktree, unit) lock `board claim` already
publishes (GH-1956); held rows surface as `local-session-active`,
self-clearing on `RALPH_LOCK_TTL_MIN`. An unreadable sessions dir yields
**null, never an empty probe**.

**`board pr-orphans` is the one selector not keyed on the board (GH-2048).**
Reads GitHub's own `closingIssuesReferences`, never the PR body
(app-writable, GH-1940); doctor carries the count as an advisory `i` line
under `board-volume`'s rules. Bot authors are skipped by default
(`RALPH_PR_ORPHAN_IGNORE_AUTHORS`, default `dependabot,renovate,github-actions`,
a trailing `[bot]` stripped on both sides); set it EMPTY to surface
everyone.

`board doctor [--fix] [--strict]` is the invariant sweep, plus four
`i`-level **state smells** (GH-1715: `repeated-claim-expiry`,
`escalation-ping-pong`, `review-stalled`; GH-1777: `tend-proposal-stale`)
read from the comment trail. Info lines are advisory by construction:
`--strict` never escalates them, `--fix` never acts on them. `board-volume`
(GH-1788) is a fifth `i` line (scanned nodes/pages vs
`RALPH_VOLUME_MAX_ITEMS`, 800), with **`board prune [--apply]`** as the
remedy: a dry run unless `--apply`, removing long-closed terminal issues
*from the project only* — the GitHub issue stays fully intact; only the
board item's Workflow State and Claim values are lost, the one-way half.
`--limit` (200), 5-consecutive-failure breaker, `--json` reports the run it
actually performed. **The `i` marker is gated on the remedy existing, not
the threshold (GH-2052)**: over-threshold with nothing prunable reads `ok`,
not `i`. `board sweep-non-issues [--apply]` is the separate one-time
removal of PR/draft board items (GH-2050) — same bounds, an **allowlist**
predicate (`PULL_REQUEST`, `DRAFT_ISSUE`), never by-exclusion, so
`REDACTED` and any future item kind stay on the retained side.

`installed-plugin` (GH-1825) resolves the copy agents actually call
(`installPath` from `~/.claude/plugins/installed_plugins.json`,
`$CLAUDE_CONFIG_DIR` honoured; version read from that copy's own manifest)
against `CAPABILITY_FLOORS`, a floor **derived, never configured** from
ralph's release history and each repo's own merge-policy opt-ins. `board
readiness` is the advisory agent-readiness report (3 levels: interactive /
unattended / autonomous loop). Its Level-3 `integration-policy` check
(GH-2138) emits a recommended integration policy, never a table, and every
unreadable input degrades to `info`, never `miss`. `board help` lists
everything.

Full rationale for this subsection:
`thoughts/shared/research/2026-09-02-claude-md-lane-selectors-and-doctor-history.md`.

### Enforcement layers (honestly labeled)

1. `board.ts` — typed gates at the path all sanctioned traffic uses.
2. `.github/workflows/state-guard.yml` — the corrective wall: issue-event
   lane (adopt/reconcile/parent gate) + reconciler cron (`doctor --fix`,
   configured `*/15`). **The cron cadence is a ceiling, not a guarantee
   (GH-1703)** — measured here at a 14-min median with a 33-min tail; every
   "one reconcile pass" claim below means tens of minutes, not 15. Needs the
   `ROUTING_PAT` secret. Every correction is a visible comment.
   - **Doctor's `state-guard` line names the cause, not just the count
     (GH-2282).** Reads the newest failure's log (`gh run view
     --log-failed`, one extra call, only on a failure) and classifies into
     `rate-limited, self-healed — no action`, `rate-limited — wait, do not
     rotate the PAT`, `auth — rotate ROUTING_PAT`, or `other — debug <run
     URL>`. Rate-limit evidence is tested before auth evidence.
3. `ralph/hooks/funnel-{board,merge,push}.sh` — short courtesy redirects to
   the CLI / merge gate / push lease, registered once in
   `ralph/hooks/hooks.json`. **Never counted as enforcement.**
   - `funnel-push.sh` (GH-1930) redirects a raw **force** push on a branch
     with an open PR to `ralph/scripts/deliver-push.sh`, whose `--expect`
     pins the remote head (GH-1917). A fast-forward push is never in scope;
     an unreadable PR state fails **open**.
   - `funnel-gate-watch.sh` (GH-1845) is **advisory**: points a `gh pr
     checks` polling loop at `scripts/pr-gate-watch.sh` and **exits 0**,
     never 2 (`ralph-attestation` is pending by design until
     `attest-pr.sh` runs, so the loop cannot terminate here). Registered
     for Monitor as well as Bash. `gh` must be in **command position**, and
     the `-R` bypass requires the `owner/repo` argument.
   - **Quoted is not run**: all three funnels strip quoted spans before
     matching (`ralph/hooks/lib/cmdscan.sh`, GH-2058 — the one shared
     reader). `funnel-board.sh` keeps one exact exception: `gh api`'s
     GraphQL mutation is matched whole even inside quotes.
   - `ralph/hooks/hint-pr-linkage.sh` (GH-1717) is the non-redirect sibling:
     a PostToolUse observation on an unlinked `gh pr create` that never
     exits 2. Stays silent on apply units.
4. `.github/workflows/doctor.yml` — weekly `doctor --strict` from CI: the
   watcher-of-the-watcher (this repo has observed silent Actions non-fire
   and an expired PAT).

## Skills, Agent, Workflows

Nine skills under `ralph/skills/` (`work` is the only execution verb; `deliver`, `tend`, and `dispatch` are the lanes — `dispatch` carrying the standing authorities and the reserved set, GH-2177, with `hero` as its attended transport, GH-2182; `board` and `help` are human surfaces; `w` and `d` are shortcuts — whisper via the GH-2216 wrappers and `dispatch up`, GH-2220), one read-only agent (`ralph/agents/investigator.md`), and optional ultracode fan-out equipment in `.claude/workflows/`. Each skill's own description is the routing contract.

Model tiers (stated once in work/SKILL.md): sonnet default, haiku for mechanical fan-out, frontier (`fable`→`opus`) only as in-session bookends on epic roots and M units; XS/S singles never touch frontier; escalate-never-preempt. `CLAUDE_CODE_SUBAGENT_MODEL=opus` is the harness escape hatch (flattens every tier).

## The Loop

`ralph/scripts/tick.sh` runs ONE iteration, scheduler-owned (launchd/cron via `install-loop.sh --enable`). Autopilot is a typed fail-closed opt-in and tick refuses to spawn under `ANTHROPIC_API_KEY`; mechanics in `ralph/CLAUDE.md`.

## Merge Gate (GH-1589; gate 6 added in GH-1694)

`main` is ruleset-protected — all changes land via PR; merge through `bash
scripts/merge-pr.sh PR` (never bare `gh pr merge`; the funnel hook
redirects — only in repos that ship the gate; host repos without
`scripts/merge-pr.sh` keep their own merge flow).

**The gate family is installable into host repos (GH-2083).** The plugin
ships the whole family vendored under `ralph/kit/` (14 scripts + `lib/` +
`validate-attestation.yml` + a minimal policy seed); `bash
<plugin>/scripts/install-gates.sh` from a host repo installs it —
idempotent, respects host-modified and host-deleted files (no overwrite
without `--force`), stamps `.github/ralph-kit.json`, and PRINTS what it
cannot do (the branch ruleset, the reviewer opt-in, the `workflow` token
scope). Vendoring is forced, not chosen: `validate-attestation.yml` runs
the gate scripts in Actions, where no plugin install exists.
`ralph/scripts/kit-sync.sh` is the one writer of the kit and `kit.test.ts`
asserts byte-identity with the canonical repo-root `scripts/` in CI, while
doctor's `gate-kit` advisory line (`i` only) compares a host repo's stamp
against the installed plugin's kit manifest and names `install-gates.sh` as
the remedy. state-guard.yml and doctor.yml joined the kit in GH-2088 as
self-adapting workflows: a resolve step uses the in-tree board CLI when
present and otherwise clones the kit's source repo at the release tag the
host's stamp pins. The installer WITHHOLDS both from a host with no board
config, and at run time a configured board with a missing/rotten
`ROUTING_PAT` fails loudly.

The script enforces: no `CHANGES_REQUESTED`, CI green, a head_sha-bound
attestation (`scripts/attest-pr.sh` with real exit codes), an external
review per `.github/ralph-merge-policy.json`, and apply-keyword hygiene
(gate 6, above — armed here; inert in a repo that has not opted in).

**Gate 5 is one scoped review per head (GH-1847).** Two modes, derived from
the policy: `review` (a formal APPROVED review at the head) and
**findings**, opted into by naming `head_marker`, for reviewers that do
not. Findings mode carries two request protocols (GH-2087): the
comment-marker protocol below (Codex), and `request_mode:
"review-request"` for GitHub Copilot in kit host repos (requestable login
`Copilot`; reviews filed by `copilot-pull-request-reviewer[bot]`;
predicate in `scripts/copilot-review-evidence.sh`). This repo runs findings
mode against Codex: request exactly ONE review per head — `@codex review
for P0 issues only` plus `<!-- ralph-review-head: <full-sha> -->` — and the
gate passes when the bot has ANSWERED at that head (a review object, or a
bot comment naming the head commit) with **zero unresolved P0 threads**.
P1/P2 are advisory: visible, adjudicated by the driver, never blocking. The
predicate is one script, `scripts/codex-review-evidence.sh`, RUN (not
mirrored) by `merge-pr.sh`, `validate-attestation.sh` and
`pr-gate-watch.sh`. CodeRabbit is gone (GH-1847). `validate-attestation.yml`
republishes the verdict as the required `ralph-attestation` status. Gates
are RUN, not predicted.

**Sub-P0 findings are counted, never gated (GH-1945).**
`scripts/advisory-findings.sh PR` counts unresolved, non-outdated badged
threads beyond what gate 5 already blocks on; `pr-gate-watch.sh` appends
the count to `GATE-READY` and `GATE-YOURS attestation`. It changes no
verdict and blocks no merge — reviewer-agnostic by measurement (severity is
badged differently per reviewer). Zero is printed explicitly
(`no unresolved advisory findings`); an unreadable count says `NOT
COUNTED`. **A count of zero is not a clean PR (GH-1971).** The script
reports `reviewed` beside the count in three states (`true`/`false`/
`unknown`), and an unreviewed head renders as `NO ADVISORY REVIEW AT THIS
HEAD` rather than borrowing clean's wording. The PR author is excluded from
counting as a reviewer; `reviewed` is never inferred from the findings
themselves.

**The rules the gates read live in one file (GH-1843).**
`scripts/lib/merge-evidence.sh` is the one reader for policy parsing,
evidence-mode derivation, the `norm()` bot-login rule, exempt-author
waivers, and attestation payload extraction/validation — published on two
surfaces over one definition: `ME_JQ_LIB` (jq, prepended by
`pr-gate-watch.sh`) and `me_*` bash wrappers over that same source.
Attestation validity returns a **reason code**, not a boolean (`stale`
re-attests, `rejected` blocks — opposite responses); a malformed policy
reports a distinct exit 2.

**The attestation is read from the paginated comment list (GH-1842).**
`me_attestation_comment` reads `gh pr view --json comments --paginate`
(like gate 5), so a valid attestation past GitHub's bounded comment window
is found rather than reading absent. An unreadable comment list is a
distinct exit 3 (`MERGE GATE PENDING` / `pending` / `GATE-WAIT
attestation`), never conflated with a genuinely absent attestation.

**A PR body is app-writable (GH-1940).** Gate 6 reads GitHub's own
`closingIssuesReferences`, never the body (Greptile rewrites bodies in
place between markers). `scripts/pr-linkage-drift.sh PR` asserts every
closing keyword still visible in the body or the commits appears in the
derived linkage; appended to the same two verdicts as the advisory count.
**Gates nothing** — the load-bearing output is `where`, not the count: a
keyword the commits still carry while the body lost it is a rewrite
signature. Own-repo references only; code stripped from both body and
commit messages before scanning.

**The review loop has a termination condition (GH-1849).**
`scripts/review-convergence.sh PR`: `stalled` (no strict decrease across
the last two completed passes) or `cap-reached` (`--cap`, else
`RALPH_REVIEW_ROUND_CAP`, else 5; unattended lanes set 2) both mean stop
iterating and escalate rather than re-request — hitting the cap is an
escalation, not a failure. `pr-gate-watch.sh` appends only these two to
`GATE-YOURS review`. Derived from the `ralph-review-head` request trail,
never recorded. `converged` is checked first and outranks the cap, since
zero findings is the floor, not a stall. **`board deliver-queue` gates
queue pickup on it (GH-1977)**: `stalled`/`cap-reached` rows surface as a
`convergence-stalled` blocked row, budgeted at
`RALPH_DELIVER_CONVERGENCE_MAX` (3), run after classification.

**Every gate can pass a merge GitHub will refuse (GH-2057).** The ruleset
enumerates required status checks by literal name, per-matrix entries
included — a diff that drops a matrix leg produces no context the ruleset
still requires. `scripts/ruleset-contexts.sh PR` compares the base
branch's effective rules against the contexts actually produced and names
the difference. **Gates nothing** (GitHub's refusal is authoritative);
appended to `GATE-READY` alone. **Fails open** on no ruleset or an
unreadable one, distinguished from `ok:true, count:0`.

**Quoted-is-not-run was line-based (GH-2057 second finding), fixed
repo-wide as GH-2058.** `ralph/hooks/lib/cmdscan.sh` is the one shared
reader every `funnel-*.sh` sources (`cmdscan.test.sh` asserts it, matched
on the regex rather than the tool). Backticks outside quotes are never
stripped (real command substitution); a `#` comment runs to end of line,
not the whole command; `funnel-board`'s `gh api` exception and
`funnel-gate-watch`'s `$(...)`-preserving exception both survive unchanged.

**The attestation is bound to the base, not only the head (GH-1841).**
`attest-pr.sh` records `base_ref` beside `head_sha`; a retarget
(`pull_request_target` `edited` with `github.event.changes.base` present)
recomputes the status to pending via a `base-changed` reason code, mapped
to the same re-attest remedy everywhere. A payload with no `base_ref` lands
on the same code (predates the binding); an unreadable base skips the
check.

**A blocking review is not evidence the author has work to do (GH-1816).**
`scripts/review-staleness.sh PR` compares each blocking review's
`commit_id` against `headRefOid`: `live` (demote, unchanged), `stale` (hold
at In Review, nudge), `no-block`. `pr-gate-watch.sh` appends only `stale`
and not-evaluated to `GATE-FAIL review`. Gate 1 (`reviewDecision`) is
untouched and still unforceable. Recorded in the
`<!-- ralph-deliver:v1 -->` marker as `review_staleness`.

**Never wait on a PR with a `gh pr checks` poll loop** —
`ralph-attestation` is pending *by design* until `attest-pr.sh` runs, so
`until ! grep -q pending` can never fire. Use `bash scripts/pr-gate-watch.sh
PR --watch`: it classifies whose turn it is and exits on the first
terminal verdict — `GATE-YOURS attestation` (hands back the runnable
`attest-pr.sh` line), `GATE-YOURS review` (incl. a rate-limited check
reporting `pass` while reviewing nothing), `GATE-FAIL`, `GATE-READY`,
`GATE-DONE`. Review outranks attestation. It reads the same
`.github/ralph-merge-policy.json` and, in findings mode, *runs* the gate's
own predicate rather than mirroring it. `GATE-READY` requires `mergeable ==
MERGEABLE`.

Full incident history and every rejected alternative for this section:
`thoughts/shared/research/2026-09-02-claude-md-merge-gate-history.md`.

## CI/CD

Six workflows in `.github/workflows/` — read their `on:` blocks for triggers. `state-guard.yml` is the corrective wall (see above); the rest are CI, the weekly doctor sweep, attestation republishing, and the two release jobs.

**Verify release fired after merging `ralph/**`** — push-event workflows have silently not fired here before: `gh run list --commit <merge-sha>`; `workflow_dispatch` is the manual backup. A release that *ran and failed* now files its own issue (GH-1952) — adopted onto the board by state-guard, so it reaches a driver without anyone remembering to look. A release that never fired at all still does not, which is why the manual check survives.

**The release version is computed from main's tip, not the merge commit
(GH-1952)** — a double bug (a stale checkout re-computing an already-taken
version, plus tagging before rebasing and leaving the tag on the pre-rebase
commit) shipped a tagged release from a tree missing a merged commit,
though main's own manifest and tree stayed correct. The job now fetches and
advances onto main's tip before reading anything, floors the version at
`max(manifest, highest ralph-v tag)`, walks the patch forward on a
collision, and rebases *before* tagging. `release-knowledge.yml` has the
same checkout shape and is tracked separately. Full incident:
`thoughts/shared/research/2026-09-02-claude-md-release-pipeline-history.md`.

## Configuration

Scope vars live in the tracked `.claude/settings.json` `env` block: `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` (+ optional `RALPH_GH_HOST` for GHE). A repo-root `.ralph.json` (`{owner, repo, projectNumber, host?}`) takes precedence when present. Auth is gh-keychain (`gh auth login -s repo,project`). Machine-local: `RALPH_LOCK_TTL_MIN`, `RALPH_CLAIM_HOLDER`, `RALPH_TICK_RUNNER`, `RALPH_TICK_TIMEOUT_MIN`, `RALPH_ALLOW_API_BILLING`, `RALPH_SMELL_CLAIM_EXPIRIES` / `RALPH_SMELL_ESCALATIONS` / `RALPH_SMELL_REVIEW_DAYS` / `RALPH_SMELL_PROPOSAL_DAYS` / `RALPH_SMELL_INTAKE_DAYS` / `RALPH_SMELL_ANSWER_MIN` / `RALPH_SMELL_DISPATCH_MIN` (doctor's state-smell thresholds, 2/3/7d/7d/14d/30min/1440min — the last is GH-2212's `dispatch-heartbeat` advisory, minutes since an event hook or hero sitting stamped `~/.ralph/<owner>/<repo>/dispatch-heartbeat`), `RALPH_UNIT_CTX_MAX` (GH-2347 — doctor's `unit-cost` advisory, 200000: a live unit past it in prompt cost is named with `board estimate` as the remedy, never a cap — compaction is a full rewrite and stopping a worker mid-unit strands it; sourced from the herdr ledger's `usage` events, joined by `claude_session`; `board brief`/`board events` carry the same numbers), `RALPH_GQL_COST=1` (log GitHub's own `rateLimit{cost}` per query to stderr — measurement mode, cost-neutral; table: `thoughts/shared/research/2026-08-11-graphql-cost-measurement.md`), `RALPH_VOLUME_MAX_ITEMS` / `RALPH_PRUNE_AFTER_DAYS` (board-volume advisory + prune age window, 800/180), `RALPH_ALLOW_FOREIGN_REPO_ITEMS` (GH-1815 — multi-repo opt-in; unset = deny, distinguishable from an explicit `false`), `RALPH_ITEM_CACHE_TTL_SEC` (item-cache Δ, default 90, 0 disables, max 600 — see below), `RALPH_ITEM_ORACLE_MAX_SEC` (GH-1804 — T_max, the hard staleness ceiling the change oracle may extend a cached walk to, default 600, 0 disables, max 3600), `RALPH_REVIEW_ROUND_CAP` (GH-1849 — review round cap, default 5; unattended lanes set 2), `RALPH_DELIVER_CONVERGENCE_MAX` (GH-1977 — convergence checks `deliver-queue` spends per pass, default 3), `RALPH_CREATE_DEDUPE_SEC` (GH-1973 — how far back `board create`'s duplicate guard looks, default 300, 0 disables), `RALPH_DEP_CANDIDATES_MAX` (GH-2135 — candidate cap on `board dep-candidates`, default 10), `RALPH_DEP_OVERLAP_MIN` (GH-2136 — the `deps-unwired` qualification threshold on the scale-free overlap coefficient, default 0.2; out-of-range warns and uses the default), `RALPH_PR_ORPHAN_IGNORE_AUTHORS` (GH-2048 — authors whose unlinked open PRs `board pr-orphans` skips, default `dependabot,renovate,github-actions`; a trailing `[bot]` is stripped on both sides; set it EMPTY to surface everyone), `RALPH_SESSION_ID` (GH-1948 — overrides `CLAUDE_CODE_SESSION_ID` as the session→unit binding key, for non-Claude runners; unset and no Claude id = the guard is not evaluated), `RALPH_CLAIM_MAX_ESTIMATE` (GH-2134 — claim-size ceiling: a fresh claim refuses at/above it and warns one notch under; unset = `XL`, empty = disabled, a value outside XS..XL is a loud config error; no Estimate on the item = not evaluated; the remedy the refusal names is `board estimate NNN <size>`), `RALPH_GH_BUDGET_FLOOR` (GH-1817 — GraphQL points below which a polling loop backs off instead of spending, default 500), `RALPH_MODEL_<LANE>` for `DRIVER`/`LEAD`/`DISPATCH`/`DELIVER`/`TEND` (GH-2350 — the model a spawn asks the harness for, per lane; resolved by ONE reader, `roles.sh ralph_lane_model`, as process env → `.ralph.json` `models.<lane>` → the settings `env` block, falling through per lane; unset everywhere = no `--model` = inherit the account default; a value that cannot ride an argv is a loud refusal, never a silent inherit; `tick.sh` restates the same chain with its old `sonnet` as the floor; the spawn record carries `model_requested` so #2352 can compare asked-for against billed), `~/.ralph/config` (`autopilot=true`; `cockpit_glyphs=nerd|unicode|ascii`, GH-2405 — the cockpit's glyph tier, a MACHINE property read here when `RALPH_COCKPIT_GLYPHS` is unset in the pane's env).

### Item cache — reads may be stale, writes see truth (GH-1806)

The item walk is memoized for 90 s (`RALPH_ITEM_CACHE_TTL_SEC`); `--fresh` forces a walk, and a cached answer always says so. This is **client-side bounded staleness, not a lease** — the cache never drives a write-guard evaluation. The three rules carrying that safety argument are in `ralph/CLAUDE.md`.

Past Δ the walk is **gated by a change oracle, not automatic (GH-1804)**: a
REST conditional request against the repo's issues list, whose 304 costs
zero rate limit on a budget measurably independent of the GraphQL one the
walk spends (#1801 observed GraphQL 0/5000 while REST read 4983/5000). A
304 extends the cached entry up to `RALPH_ITEM_ORACLE_MAX_SEC` (T_max,
600). What it buys is smaller than "an unchanged board is free to confirm
unchanged": **project-field writes are invisible to issue-level
`updated_at`**, so a plain `board move`/`board claim` returns 304, and a
full Backlog → In Progress → In Review sequence returns 304 the whole way —
for those writes, T_max is the correctness-relevant bound, a hard ceiling
no certification overrides. Foreign-repo board items sit outside the probed
repo and are invisible to the oracle entirely; T_max alone bounds them.
`gh api` **exits 1 on a 304**, so the verdict is read from the HTTP status
line and never the exit code, and the certification is refused unless the
etag's capture instant precedes the walk it vouches for. `doctor` never
uses it, at any staleness.

## Gotchas

- **Projects V2 has no compare-and-swap.** The claim protocol makes races visible and refused (read-back + doctor), not impossible. One flock-serialized scheduler per machine keeps real concurrency rare.
- **The board can hold items from other repos, but board.ts will not put
  one there.** Multi-repo is opt-in (`RALPH_ALLOW_FOREIGN_REPO_ITEMS`,
  unset = deny, GH-1815), guarded at the add-to-project mutation. GitHub
  has no pre-add hook, so a hand-added item is *caught* by doctor's
  `foreign-items` sweep (warns under deny), not prevented; pre-existing
  items are grandfathered — never auto-removed, not escalated by
  `--strict`, not touched by `--fix`. board.ts resolves bare numbers within
  the configured repo only.
- **Archived items** are returned by the items API but reject writes —
  filtered everywhere. **Archiving buys no scan relief** — it hides an item
  from the board's views while every full scan still pages through it;
  only `board prune` shrinks a scan.
- **`board sweep-non-issues [--apply]`** is the one-time removal of PR/draft
  board items (GH-2050) — a separate verb from `prune`, because prune's
  predicate reasons about issues other readers still need and a PR/draft
  item has none; removal is also safe in a way prune is not (their
  Workflow State/Claim were never written). An **allowlist** predicate
  (`PULL_REQUEST`, `DRAFT_ISSUE`), never by-exclusion — `REDACTED` (a
  content-hidden item, which may be a real issue) and any future item kind
  stay on the retained side by default.
- **A full scan pays for more than issues.** ~47% of this board's paged
  nodes are pull requests and drafts, invisible to `board.ts`'s Issue
  fragment yet costing a slot on every page. Volume is measured by the
  walk, never inferred from survivors.
- **An existing field's option set is API-editable in ONE direction
  (GH-2127).** `updateProjectV2Field` REPLACES the set; adding is safe only
  when every existing option comes back with its id (what `setup` does,
  verified by id survival). **Removal is not offered** — deleting an option
  clears the Workflow State of every item still holding it, unrecoverable
  and unbounded, so the 5 legacy v1 states stay a deliberate human act in
  the board UI. Not "the API cannot" — "this file will not".
- **Editing an existing field's options / creating fields**: `board setup`
  is idempotent and prints exactly which steps are manual.
- **Starvation is a property of the token, not of any one surface — and an
  exhausted-budget `gh` write fails SILENTLY (GH-1817).**
  `scripts/lib/gh-budget.sh` is the shared reader: a rate-limited `gh`
  write can print an error and **exit 0** (`gb_gh` searches both stdout and
  stderr, returns a distinct **exit 4**, mapped onto EX_TEMPFAIL 75 — wired
  at `attest-pr.sh` and `apply-evidence.sh`'s unread-back writes). A
  pre-spend check caps the *aggregate*, not just each bounded consumer:
  `gb_backoff_seconds` naps toward the reset (capped 300s, narrated on
  stderr) in `pr-gate-watch.sh --watch`; fails **open** on an unreadable
  budget (exit 3, distinct from exhausted's exit 4). **The budget authority
  is GraphQL's own `rateLimit` field, never REST `rate_limit`'s `graphql`
  sub-bucket (GH-2278)** — that sub-bucket mirrors `core` and reports 5000
  while GraphQL itself reads 0. `gb_snapshot graphql` (default) reads
  `{ rateLimit { remaining limit resetAt } }` directly and answers even at
  zero; a probe GitHub itself refuses on budget exits **4**, distinct from
  unreadable's 3. Diagnose with `gh api graphql -f
  query='{rateLimit{remaining resetAt}}'`; `gh api rate_limit --jq
  .resources.graphql` will tell you 5000 and lie.
- **GraphQL cost is per nested CONNECTION in the document** (not per field,
  not per node): each one over a 100-item page is +1 pt/page, so the item
  walk carries a `QueueSelect` and each caller asks only for what it reads
  (GH-1803 — `next`/`frontier`/`tend-queue` skip `labels`, `deliver-queue`
  skips both and runs at the 1-pt floor). An unselected group is **absent**
  from the item, never `[]` with `truncated: false`. Trimming a nested
  `first:` is worth exactly zero **on the walk** (measured, twice) — all
  its connections hang under one `items(first:100)` page — but worth
  hundreds of points one level deeper: 10,000 nodes for one aliased
  `deliver-queue` field measured **607 pts, not the 100 recorded earlier**
  (GH-1811, and GH-1807's own over-generalization of the zero-cost
  finding). **Probe the document you are actually sending**
  (`RALPH_GQL_COST=1`) rather than deriving a number from either
  measurement.
- **The ranking lanes no longer walk the project (GH-1814).**
  `next`/`frontier`/`deliver-queue` join `list` on the issues-rooted read
  (`repository.issues(states: OPEN)`, GH-1785), tracking open work instead
  of every item the board has ever held — measured 30 → 13 pts and
  **47 s → 5 s** (the cockpit's `boardTimeout` is 25 s). `closedTreeEdges()`
  resolves the pass-through Done-phase topology (an epic root above live
  grandchildren) by walking UPWARD from the open set instead of paging
  every closed item.
- **`tend-queue` joined them (GH-1891)** — 47 pts/22 queries → 17/6, via a
  bounded `repository.issues(states: CLOSED, orderBy: UPDATED_AT DESC)`
  read that stops at the first node older than the audit window (complete,
  not a heuristic: `updatedAt >= closedAt` always). Uses
  `fetchCommentTrails` (comments only, batched 100) instead of
  `fetchHistories` (batched 20) — doctor's smells keep `fetchHistories`
  since they need `stateUpdatedAt`.
- **The project scan can silently drop a live item (GH-1896).** GitHub's
  `items(first:100, after:)` cursor is not stable across a board being
  mutated under the walk. `listItemsFull` now **detects its own
  truncation**: reads the connection's `totalCount`, retries once, and
  raises a named error on a second short read rather than serving a board
  with a hole in it — costs nothing (a field, not a connection) and stays
  inert if GitHub answers without `totalCount`.

Full incident history for this section:
`thoughts/shared/research/2026-09-02-claude-md-gotchas-history.md`;
companion raw measurements:
`thoughts/shared/research/2026-08-11-graphql-cost-measurement.md`,
`thoughts/shared/research/2026-08-12-GH-1803-lean-query-measured.md`,
`thoughts/shared/research/2026-09-01-GH-2278-rest-rate-limit-graphql-bucket-mirrors-core.md`.

## History

v1 (9 verb skills, 16 agents, 40 hooks, 20.7k-line MCP server, 11-state machine) was replaced in GH-1662 (PRs #1664/#1665/#1666+). Rationale and evidence: the design record + `thoughts/shared/plans/2026-07-31-GH-1662-ralph-v2-minimal-harness.md`. The npm package `ralph-hero-mcp-server` is deprecated. Historical references under `thoughts/` are point-in-time records, deliberately intact.
