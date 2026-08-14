# Spec: Loop-agent lanes for ralph v2 — deliver + tend

- **Status**: **reviewed — PASS** (adversarial Opus review, 6 rounds, 2026-08-07; final round's two advisories folded in)
- **Amendment 2026-08-08 — transport uniformity**: lanes no longer assume a scheduler
  (launchd/cron) or shell loop scripts as their drive. All three lanes — including work —
  are driven through Claude Code primitives (`/loop` fixed and dynamic modes,
  `ScheduleWakeup` pacing owned by `/loop`, scheduled routines for unattended coverage),
  with `tick.sh` demoted to one transport example among several. Amended items are marked
  **[T-2026-08-08]**; affected: §1, §2, D5, D10, §4.7 (rewritten), A4, A5, A10, §7, §8.
  Primitive facts verified against
  `thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md`.
- **Date**: 2026-08-07
- **Author**: Chad Dubiel + Claude (Fable 5)
- **Design exploration**: `thoughts/shared/html-out/2026-08-06-ralph-loop-agents-design.html`
- **Normative ancestors**: `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md` (v2 design record), `thoughts/shared/ideas/2026-08-01-agent-readiness-guide.md` (recommend-never-impose)

## 1. Overview

ralph v2 ships one loop-drivable lane: **work** (`board next` → `/ralph:work`).
**[T-2026-08-08]** Lanes are transport-neutral: a lane is a **typed selector + a judgment
skill + a goal (termination condition)** — cadence is *derived per pass from what the queue
is blocked on*, not configured. The v2 design record already scoped the scheduler contract
to "invoke one work session per tick" and called `tick.sh` "a convenience, not the
architecture"; this amendment cashes that in. This spec adds the two lanes the
design exploration selected, partitioned by board state:

- **deliver** — owns quiescent In Review items and their open PRs. Shepherds PRs from open
  to merged: reacts to concluded checks, review deltas, stale attestations, and merge-gate
  PENDING verdicts; maintains branch topology (rebases, stacks, retargets); demotes semantic
  rework. Closes the waystone *merge→effective* edge (W5).
- **tend** — owns Backlog shape and the Done audit. Forms observations into deduped,
  dependency-wired issues; detects stale issue bodies against the live tree; proposes
  closures. Closes the waystone *observation→tracked work* edge (W2, rung 6).

**Design axiom (binding for every deliverable): scripts are examples; contracts are doctrine.**
The mutation path (`board.ts` claim/scope/state gates, `merge-pr.sh` gates, `state-guard.yml`)
is the enforcement line. Everything above it — loops, schedules, wiring — is user-owned
scripting. ralph ships typed capabilities with stable contracts plus example recipes (and,
for the scheduler transport, example scripts) users copy and own. Nothing in this spec adds
a scheduler, harness, or registry that ralph executes on the user's behalf.

The split rule that produced these lanes (recorded here; it gates future lane proposals):
**[T-2026-08-08, amended]** a new lane is justified only when **signal source, write lane,
pacing signal, and permission set all four differ simultaneously** from every existing lane.
The third axis was originally "cadence" (a configured interval); with transport uniformity
cadence is derived per pass, so the axis is restated honestly as the *pacing signal* — the
observable each lane derives its next wake from (work: queue depth; deliver: check
conclusions, review deltas, retry/settle windows; tend: accumulation age). The three-lane
split still clears the test on all four axes; a proposal that differs only in derived
cadence numbers does not.

**Relationship to `/ralph:work` (unchanged, by design).** work/SKILL.md is not amended. A
work session still runs the gates once at PR-up per its rule 7 and merges when they pass;
deliver exists for everything rule 7 deliberately does not do — the follow-through after the
work session exits with the item at In Review (gates pending, review landed later, attestation
unbound by a later push). The two lanes are kept off the same PR by quiescence, not by claim
(§4.2 clause 4, §8.2).

## 2. Non-goals

- **No `lane.sh` harness and no `lanes` registry** in `.ralph.json` or anywhere else ralph
  reads to spawn work. **[T-2026-08-08]** No new lane shell scripts either: lanes ship no
  `deliver-loop.sh`/`tend-loop.sh`. `tick.sh` + `install-loop.sh` are **kept but demoted**
  to one transport example among several (the scheduler recipe) — they are not deleted
  (working, tested, and the only unattended-without-routines option), but no deliverable
  depends on them and docs stop presenting launchd as *the* loop.
- **No new board states and no `MACHINE` edits.** Rework demotion uses the existing legal
  two-hop (In Review → In Progress → Backlog, `board.ts:41-48`). A direct In Review → Backlog
  edge is deferred until observed rework frequency justifies it.
- **No lane-to-lane messaging, lane priorities, scheduler-side routing, or orchestrator
  agent.** Lanes coordinate only through board state and durable marker comments (§4.6).
- **No Actions-hosted model lanes.** GitHub Actions remains the deterministic corrective wall.
- **No host-repo requirements.** Both lanes degrade gracefully where conventions are absent
  (§4.7). `readiness` recommends; nothing gates.
- **No `--force` in `board.ts`** (typed absence, preserved). `merge-pr.sh --force` exists as
  a human override; **the deliver lane never passes it** — any situation that would need it is
  Human Needed with the gate output quoted (§4.4, A9).
- **No changes to `doctor`'s scope.** Doctor stays board invariants; it never audits user
  scripts or lane conventions.

## 3. Deliverables

| ID | Deliverable | Kind |
|----|-------------|------|
| D1 | `/ralph:deliver` skill (`ralph/skills/deliver/SKILL.md`) | judgment (prose) |
| D2 | `/ralph:tend` skill (`ralph/skills/tend/SKILL.md`) | judgment (prose) |
| D3 | `board deliver-queue [--json]` typed selector in `board.ts` (thin composition; gate truth delegated to D8) | contract (code) |
| D4 | `board tend-queue [--json]` typed selector in `board.ts` | contract (code) |
| D5 | **[T-2026-08-08, amended]** Transport recipes `ralph/examples/README.md` (markdown, no new shell scripts): per-lane drive recipes in Claude Code primitives — `/loop <lane-skill>` (dynamic, ScheduleWakeup-paced by `/loop`) and `/loop <interval> <lane-skill>` (fixed) — each lane's goal (§4.7.0), pacing-derivation guidance, a BRIDGE-env routine prompt template for unattended coverage, and the scheduler recipe (pointing at `tick.sh` as the work-lane example of that transport) | example (copy-and-own) |
| D6 | `readiness` level-3 additions: per-lane convention detection (always `info`, recommend-only) | contract (code) |
| D7 | Docs: `ralph/README.md` + `ralph/CLAUDE.md` lane sections (incl. the four-dimension lane test, stated once in `ralph/CLAUDE.md`) | docs |
| D8 | `merge-pr.sh --dry-run`: evaluate all gates, emit the same `MERGE GATE <verdict> — <gate>` tokens and exit codes, guarantee no merge and no side effects | contract (code) |
| D9 | `attest-pr.sh --run "<cmd>" [--run ...]`: execute each command, capture its real exit code, and compose `tests[]` from observed runs only | contract (code) |
| D10 | **[T-2026-08-08, amended]** CI wiring: contract tests for D3/D4/D8/D9 in the existing suites (the shellcheck-scandir extension is dropped with D5's scripts; it returns if a future recipe ships a script) | contract (code) |

Selector placement note (funnel test applied to CLI surface): D3/D4 are `next`-class typed
read-only queries — the sanctioned selector pattern `board next` already establishes. They
stay thin by construction: `deliver-queue` composes the existing In Review listing, marker
comparison (§4.6), the quiescence clock, and at most `RALPH_DELIVER_DRYRUN_MAX`
`merge-pr.sh --dry-run` subprocesses per pass; it re-implements no gate logic (that is
D8's single source of truth, which also dissolves the prior duplication of gates 4/5
inside eligibility).

## 4. Contracts

### 4.1 Lane ownership (the state partition)

| Lane | Owns | May write | Never touches |
|------|------|-----------|---------------|
| work (existing, unamended) | In Progress (exclusive via claim); its own PR through first gate run per rule 7 | code, branches, PRs, transitions on claimed issue | other lanes' items; cross-repo |
| deliver | **quiescent** In Review items (§4.2 clause 4) + linked open PRs | PR branches (rebase/conflict/stack/retarget), re-attestation via D9 only, reviewer nudges, evidence-bearing thread replies, `merge-pr.sh` (never `--force`), transitions per §4.4 | feature semantics (any change a reviewer would call a design decision); `merge-pr.sh --force` |
| tend | Backlog shape; Done audit | issue bodies/titles/comments, `board dep`/`link`, Priority/Estimate fields, `board create` | code, branches, PRs, claims, In Progress / In Review items (comments at most) |

Claim-holder identity carries the lane where a claim exists at all:
`RALPH_CLAIM_HOLDER=deliver@<host>` during the rework two-hop (the only moment deliver holds
a claim), `tend@<host>` never (tend takes no claims), vs the work lane's `tick@<host>`.
**[T-2026-08-08]** The holder prefix names the drive: `tick.sh` keeps `tick@<host>`;
session/routine transports of the work lane set `RALPH_CLAIM_HOLDER=work@<host>` (or any
distinct holder) — what matters is that holders are distinct per driver so read-back and
doctor attribute claims correctly.
Outside the two-hop, deliver's item carries no claim — a claim on a non-In-Progress item is a
doctor anomaly (doctor's claim-anomalies check in board.ts) and this spec keeps it that way. Exclusivity for deliver
comes from quiescence + the shared spawn lock + SHA-pinned merges, not from claims (§8.2).

### 4.2 `board deliver-queue [--json]` (D3)

Deterministic and side-effect-free apart from read-only `gh` calls and invoking
`merge-pr.sh --dry-run` (D8, itself side-effect-free).

An item is **eligible** iff clause 1 and the quiescence guard (clause 4) hold, **and**
either clause 2's `no-open-pr` close-out case applies **or** the item has ≥1 linked open PR
satisfying clause 3:
1. On-board, own-repo (`ownRepo()` partition), not archived, state = In Review.
2. **Linkage** (defined): a PR is *linked* iff it carries a closing reference to the issue
   (`closedByPullRequestsReferences` — the only linkage `board.ts` populates today,
   `board.ts:725`) **or** its head branch matches the provenance convention
   `feature/GH-NNN` (work rule 6; detect-if-present — hosts without the convention degrade
   to closing references only). Three-way split:
   - ≥1 linked **open** PR → normal candidate (clauses 3–4 apply);
   - ≥1 linked PR, all merged/closed → eligible with reason `no-open-pr`, taking §4.4's
     close-out branch (neither `reconcile` nor `doctor` covers an open In Review issue
     with a merged PR; without this branch such items strand forever);
   - **zero linked PRs** → `blocked` row, reason `no-pr` — rollup-advanced epic parents
     (`parentCheck()` in board.ts — line numbers drift; cite symbols) and human-placed
     items are not deliver's business and never reach clause 3.
3. At least one **actionable signal** for a linked open PR, marker-gated per PR (§4.6).
   The selector never writes markers — only deliver sessions do, at exit; the selector is
   read-only apart from dry-run invocations (which are themselves side-effect-free).
   a. a **cheap re-arm delta** against that PR's marker entry: `head_sha` changed,
      check-conclusion digest (`check_conclusions`) changed, a new review submitted
      (`review_cursor` delta), or an unresolved-thread delta (`thread_cursor`) — or no
      marker entry exists yet. A budgeted `merge-pr.sh --dry-run` (D8) confirms
      actionability: **the tuple `{head_sha, verdict, gate}` differs from the marker
      entry** — the sole confirm condition (a marker-less PR trivially differs). A probed
      PR whose tuple still equals its entry is `blocked`, reason `marker-current`, until
      its retry window (b) expires — a recorded PASS included: a mergeable PR that failed
      to merge re-arms via (b) like any other verdict, never via a special case; or
   b. **bounded retry, any verdict**: the marker entry's `at` is older than
      `RALPH_RETRY_MIN` (default 60) minutes. This catches every transition no cheap
      signal can observe — a stuck external gate (PENDING), *and* a recorded PASS/FAIL
      whose PR never merged (post-retarget stack bases, transient merge failures): without
      it those stall silently forever while the lane logs `checked=N acted=0`. Retry
      candidates are eligible **without** a selector-side dry-run — the session runs the
      gates itself and refreshes the marker's `at`, so a stuck PR costs one session per
      window, never one per pass. An entry inside its window with no cheap delta is
      `blocked`, reason `retry-window`, and is not probed.
4. **Quiescence guard** (replaces a bare settle window): the newest of — PR head push
   timestamp, issue state-change to In Review, latest issue/PR comment, latest thread
   update — is older than `RALPH_SETTLE_MIN` (default 5) minutes. An active work session
   pushing or commenting keeps the item settling; quiescence, not claims, is the
   work/deliver exclusion primitive (§8.2 carries the residual race).

**Per-pass cost bound**: the cheap checks (state, linkage, marker deltas, quiescence
timestamps) are fetched in **one batched GraphQL document across all candidates** (items →
linked PRs → checkSuites, reviews, reviewThreads, timeline timestamps) plus one marker read
per candidate — never one ad-hoc call per signal per candidate. The dry-run budget
(`RALPH_DELIVER_DRYRUN_MAX`, default 3, per pass) is spent only on cheap-delta/marker-less
candidates, **newest delta first** (the delta's own timestamp; stateless) — a freshly green
PR outranks a stale thread delta, so persistent `marker-current` candidates cannot pin the
budget; unprobed ones are `blocked` rows with reason `deferred`. **Queue order**: confirmed cheap-delta candidates first (oldest first), then
window-expired retries — a confirmed actionable item always outranks a retry, so stuck
retries can never starve fresh work (A1 asserts this with an N&nbsp;&gt;&nbsp;cap fixture).

Output shape mirrors `next`: `{ next, queue, blocked }` where `blocked` carries
ineligible-with-reason rows (`settling`, `no-pr`, `marker-current`, `retry-window`,
`deferred`).
Empty `next` ⇒ the caller spawns nothing (idle-exit is the caller's contract, stated in the
`--json` docs and the D5 recipes).

### 4.3 `board tend-queue [--json]` (D4)

Deterministic hygiene queue over own-repo items:
1. **Stale-body candidates**: Backlog items with no updates in > `RALPH_STALE_DAYS`
   (default 30).
2. **Dependency anomalies**: Backlog items whose blockers are all closed, and
   truncated-blocker Backlog items (scoped to Backlog — §4.1 keeps tend out of In
   Progress / In Review beyond comments).
3. **Formation candidates**: items with no estimate, no parent, and no dependencies, older
   than 7 days (likely unformed intake).
4. **Done-audit candidates**: issues closed within the last `RALPH_AUDIT_DAYS` (default 14),
   fetched via `gh` closed-since query, that carry no `ralph-tend:v1 audited` marker comment
   (§4.6). The marker is the cursor; no local state.
5. **Observation intake**: present only as a queue slot — the selector does not read
   dream-loop reflections itself; the tend skill decides whether to pull surfaced
   observations during its session. (Keeps the selector free of MCP dependencies.)

Same `{ next, queue, blocked }` shape; ordering is oldest-first within category, categories
in the order above. The selector **classifies**; all judgment (is this actually stale? is
the dup real?) belongs to the skill.

### 4.4 Skill contracts (D1, D2)

Both skills inherit the `/ralph:work` structural rules verbatim where applicable: board
truthful at all times; exit only at surfaced states; findings outlive the transcript;
decisions journaled via `board comment`; gates are run, not predicted; scope is the selected
item. **[T-2026-08-08]** Both skills are single-pass operators with a uniform exit step:
append the §4.7.2.4 outcome line and touch the lane heartbeat, and end the pass with a
report of `checked/acted`, the blocked-reason set, and the earliest window expiry — the
transport (a human, `/loop`, or a routine) reads that report to pace or stop per §4.7.0;
the skills never self-schedule (A8). Lane-specific rules:

**`/ralph:deliver`** (model: sonnet):
- Mechanical remediation only: rebase onto main, conflict resolution preserving both sides'
  stated intent, lint/format, CI re-run, re-attestation **via `attest-pr.sh --run` (D9)
  only** — never with caller-typed exit codes — and reviewer nudges (`@coderabbitai review`;
  at most one per head SHA; rate-limit read from check `description`, never state).
- Thread replies are **evidence-only**: commit link, line link, test output link. Anything
  argumentative is a rework signal, not a reply.
- Merge exclusively through the host repo's own gate (`scripts/merge-pr.sh` when present),
  **never with `--force`**. Outcome handling maps on the machine-parseable
  `MERGE GATE <verdict> — <gate>` token, not the bare exit code:
  - PENDING (exit 75) → leave In Review, journal, exit; the next tick retries.
  - FAIL — `state` → re-read reality: the PR is usually already merged (native auto-merge,
    or a prior successful run); treat per the post-merge rule below, else Human Needed.
  - FAIL — `mergeable`: CONFLICTING → rebase, push, exit at In Review (quiescence
    restarts); UNKNOWN (mergeability not yet computed) → wait, exit at In Review — never
    rebase or push on mere uncertainty.
  - FAIL — `checks` → remediate mechanically (re-run flakes, fix lint/format); a genuinely
    failing test at unchanged semantics is a rework signal → demotion.
  - FAIL — `review` (CHANGES_REQUESTED) → rework demotion.
  - FAIL — `attestation` → re-run the attested commands via D9 at the current head; if they
    fail, demotion. Re-attestation **refreshes `tests[]` and `head_sha` only and carries
    the prior attestation's `review` block forward via D9's `--carry-review` mode** —
    deliver never authors, and never retypes, a review verdict (§4.1 forbids it; gate 5's
    head-bound external review is the independent check). No prior attestation on the PR →
    Human Needed, never a fresh self-approval. D9 refusals are keyed on their tokens,
    never the shared exit code: `ATTESTATION REFUSED — head moved` is **not** a test
    failure (re-check quiescence, retry once, else exit at In Review);
    `ATTESTATION REFUSED — no prior review` → Human Needed.
  - Any unclassified FAIL → Human Needed with the gate output quoted.
- **`no-open-pr` close-out branch**: for an In Review item whose linked PRs are all
  merged/closed — verify at least one linked PR actually merged, then `board move NNN done`
  (the merged linked PR satisfies `transition()`'s Done-evidence guard in board.ts);
  a linked PR closed *unmerged* → Human Needed with the finding. This is the only lane that
  un-strands such items (see §4.2 clause 2).
- **Post-merge state writes belong to reconcile.** After a successful merge (or FAIL —
  `state` on an already-merged PR), re-read the issue: already Done/Canceled (state-guard's
  event lane typically wins within seconds) is success — journal and exit. Only issue
  `board move NNN done` when the issue did not auto-close (no `Closes #NNN` link), and
  treat a refusal (lost race) as success after re-read.
- **Rework demotion**: post one findings comment enumerating every unresolved thread, then
  In Review → In Progress → Backlog (holder `deliver@<host>` for the transient hop) and
  release. Never self-fix semantics.
- **Stack safety**: before merging any PR that is a base of another open PR, retarget the
  dependent PR first (GitHub closes, not retargets, dependents on base-branch deletion).
- **Pre-push quiescence re-check**: immediately before any push to a PR branch (rebase,
  conflict fix, format), re-evaluate §4.2 clause 4; fresh activity aborts the push and exits
  at In Review. `--match-head-commit` protects the merge; this rule protects the branch.
- Update the item's `ralph-deliver:v1` marker (§4.6) at every session exit.
- Host repos without `scripts/merge-pr.sh`: fall back to the repo's native merge flow and
  branch protection; never import ralph-hero's policy.

**`/ralph:tend`** (model: sonnet):
- Metadata-only writes. Grep the live tree before trusting any issue body (the repo's
  documented stale-issue failure mode).
- Dedup and wire: merge duplicates by comment + dep/link edges; `board create` for
  observations with a provenance comment (what was observed, where, when).
- **Closures are proposals**: close-as-stale / cancel-as-superseded go to Human Needed with
  evidence, never executed unilaterally. This is the trust ratchet's starting position;
  promoting tend to direct closure is a deliberate future loosening, not a default.
- Post the `ralph-tend:v1 audited` marker on each Done item it audits (§4.6).
- Hard per-session budget: process at most `RALPH_TEND_BATCH` (default 5) queue items per
  session, then exit at a surfaced state.

### 4.5 Gate-tool contracts (D8, D9)

- **`merge-pr.sh --dry-run`**: runs gates 0–5 exactly as the merge path does, using the
  same exit codes (0/1/75), performs no merge, no worktree cleanup, no comment, no mutation
  of any kind. **The verdict is the last `MERGE GATE` line plus the exit code** — WARN lines
  are non-terminal advisories that never appear alone (a zero-checks run emits WARN then
  PASS; consumers must not key on the first match). In dry-run mode gate 2 makes a single
  attempt with no retry sleep and `mergeable == UNKNOWN` maps to PENDING — `mergeable`:
  this is the **one sanctioned divergence** from the merge path (which routes UNKNOWN
  through gate 2's retry-then-soft-gate in merge-pr.sh — cited by construct; line numbers
  drift), and A2 carves exactly this case out. This is the single source of truth for "is this PR mergeable and why not" —
  selectors and skills read it; nothing re-implements gate logic.
- **`attest-pr.sh --run "<cmd>"`** (repeatable): executes each command in the current
  checkout, captures the real exit code, a truncated output digest, and
  `git rev-parse HEAD` at execution time (`ran_at_sha`), and composes `tests[]` exclusively
  from those observed runs. Posting **refuses when any `ran_at_sha` differs from the PR's
  current `headRefOid`** — evidence is bound to the attested commit, not just to a real
  run. The refusal has its own contract: single line `ATTESTATION REFUSED — head moved`,
  exit 75 (retryable; distinct from a failing test run, which posts an honest failing
  attestation and exits 0). A companion `--carry-review` mode reads the PR's existing
  attestation comment and copies its `review` block verbatim, refusing with its own token —
  `ATTESTATION REFUSED — no prior review`, exit 75 — when none exists; consumers key on
  the token, never the shared exit code (head-moved → retry per §4.4; no-prior-review →
  Human Needed). Re-attestation never retypes, and never invents, a review verdict.
  The existing caller-supplied mode remains for interactive use; **the deliver skill is
  contractually restricted to `--run`** (A9). The head_sha binding and server-side
  `validate-attestation.sh` re-checks are unchanged.

### 4.6 Durable marker comments (the only cross-session memory)

Lane cursors live in HTML-marker comments on the issue/PR — the proven
`<!-- ralph-attestation:v1 -->` pattern; no local files, no board fields, deterministic from
any machine:

- `<!-- ralph-deliver:v1 -->` + JSON keyed by PR number:
  `{"prs": {"<pr#>": {head_sha, verdict, gate, check_conclusions, review_cursor,
  thread_cursor, at}}}` — one marker comment per issue, PATCHed in place (paginate before
  search, as attest-pr.sh does). Per-PR entries gate re-selection (§4.2.3), so multiple
  open PRs on one item (stacks) each carry their own tuple and never alternate; each
  entry's `at` anchors that PR's bounded retry (§4.2.3b, any verdict). `check_conclusions`
  is a digest of check-run conclusions; `review_cursor` the latest review `submittedAt`.
  Only deliver sessions write this marker; the selector reads it.
- `<!-- ralph-tend:v1 audited -->` + JSON `{at, artifacts_checked}` on audited Done items.

Markers are cursors, not authority: board state and GitHub reality always win; a deleted
marker merely re-queues the item once.

### 4.7 Transports & conventions (documented + detected, never required) **[T-2026-08-08, rewritten]**

*(Prior text assumed bash loop scripts under a scheduler; superseded by transport
uniformity. Conventions now bind per-transport and are carried in the D5 recipes and the
skills' exit contracts, detected by `readiness` (D6).)*

#### 4.7.0 Lane goals (termination conditions)

Cadence is derived; **goals are typed against the selectors**. Every transport, attended or
not, stops (or sleeps long) when its lane's goal holds:

- **work**: `board next` returns empty `next` — everything remaining is blocked, foreign,
  or Human Needed. One item per pass, as today.
- **deliver**: `deliver-queue` returns empty `next` **and** no blocked row carries a
  time-bounded reason (`settling`, `retry-window`, `deferred`). Time-bounded rows don't
  stop the lane — they set the next wake to the earliest window expiry (clamped to
  ScheduleWakeup's [60, 3600] s); rows only a human can clear (`no-pr`, Human Needed
  escalations) never keep the lane awake.
- **tend**: one clean sweep — a pass with `checked>0, acted=0` and no new observations
  pulled — ends the loop; re-entry is by accumulation (next scheduled/routine fire), not
  polling.

#### 4.7.1 Sanctioned transports (all equivalent against the same contracts)

| Transport | Surface | Coverage | Opt-in |
|---|---|---|---|
| Single pass | `/ralph:work`, `/ralph:deliver`, `/ralph:tend` invoked directly | attended | the invocation itself |
| Session loop, self-paced | `/loop /ralph:<lane>` (dynamic mode; `/loop` owns `ScheduleWakeup`, the lane's report tells it what to pass for `delaySeconds` per §4.7.0) | attended (dies with the session; 7-day cap) | the user typing `/loop` — explicit, per-session, per-lane |
| Session loop, fixed | `/loop 15m /ralph:<lane>` (CronCreate-backed) | attended (same session bounds) | same |
| Scheduled routine | BRIDGE-env routine running the lane skill locally with plugins (verified; anthropic_cloud routines cannot load plugins) | unattended | config keys (below) |
| Scheduler script | `tick.sh` under launchd/cron via `install-loop.sh` — the work-lane example of this transport; a user wanting deliver/tend here copies and owns the pattern | unattended | config keys (below) |

The lane **skills stay single-pass operators**: no ScheduleWakeup, sentinel, or polling
vocabulary in any SKILL.md (A8, now load-bearing) — pacing belongs to `/loop`/the
transport; each skill ends its pass by reporting `checked/acted`, the blocked-reason set,
and the earliest window expiry, which is exactly what a dynamic `/loop` needs to choose a
delay or stop.

#### 4.7.2 Conventions, per transport

1. **Fail-closed opt-in.** *Attended transports*: the user's explicit `/loop` (or direct)
   invocation is the opt-in — per-session, per-lane, dies with the session; no config key
   consulted. *Unattended transports* (routines, scheduler scripts): typed and fail-closed
   as before — `autopilot=true` in `~/.ralph/config` **and** `autopilot.<lane>=true` for
   deliver/tend (work stays single-key, unchanged); the routine prompt / script must check
   both before doing anything and exit loudly otherwise. Global-off disables everything;
   the per-lane key alone is never sufficient.
2. **Billing guard.** Lives wherever a *new process* is spawned: routine prompts and
   scheduler scripts refuse when `ANTHROPIC_API_KEY` is set unless
   `RALPH_ALLOW_API_BILLING=true` (tick.sh already does). Session transports cannot
   re-decide billing mid-session — the D5 recipes state this honestly rather than
   pretending a skill rule enforces it; an interactive session's billing mode is
   user-visible at start, which is the risk profile the guard existed for (headless
   scheduler envs) not applying.
3. **One driver per lane per board** (replaces the shared spawn lock as the stated
   serializer). The flock/pidfile only ever serialized *script transports* on one machine;
   session loops never held it. The per-item backstop is unchanged and is the real line:
   claim write + read-back verify + back-off in `board.ts` (work, and deliver's two-hop),
   quiescence + marker tuples + SHA-pinned merges (deliver), metadata-only writes (tend).
   Script transports keep contending on `$RALPH_HOME/tick.pid` exactly as before.
4. **Heartbeat + proof-of-input outcome lines — now a skill exit step**, transport-
   independent: each lane pass appends
   `<iso8601> <lane> GH-<n> rc=<c> checked=<N> acted=<M>` to
   `$RALPH_HOME/<lane>.outcomes.log` and touches `$RALPH_HOME/<lane>.heartbeat` before
   exiting. A lane always logging `checked=0` is visibly dead, never silently green
   (waystone W1). Script transports additionally log `skipped=lock` on lock skips — still
   §7's contention datum.
5. **Idle/goal exit**: selector first; empty result means no model work that pass, and the
   goal conditions of §4.7.0 decide stop-vs-sleep.

`readiness` (D6) gains level-3 rows per lane: opt-in flags present, heartbeat file present
and its age, outcomes log present/non-empty. **All lane rows are `info` unconditionally**
(matching readiness's existing `loop` row and the stated invariant that `info` is never a
gap): a stale heartbeat on one machine must never change the repo's `readyFor`.

## 5. Acceptance criteria

- **A1**: `board.test.ts` contract coverage for D3/D4: eligible/ineligible fixtures per
  clause — quiescence boundary; linkage three-way split (closing-reference PR,
  branch-convention fallback PR, rollup parent with zero linked PRs → `no-pr`);
  `no-open-pr` eligibility (merged-PR close-out case and closed-unmerged case);
  `marker-current` and `retry-window` suppression; bounded retry re-arming after
  `RALPH_RETRY_MIN` for **each** verdict class — an unchanged PENDING *and* an unchanged
  PASS whose PR never merged; cheap re-arm deltas (each of head/checks/review/thread,
  per-PR); marker-absent eligibility; dry-run verdict mapping (PASS/PENDING/FAIL-by-gate);
  **anti-starvation**: N&nbsp;&gt;&nbsp;cap **cheap-delta** candidates whose oldest three
  are persistently `marker-current`, assert the newest-delta item still gets probed
  (newest-delta-first budget), and that retries never consume the dry-run budget;
  probed-PASS-tuple-equal → `marker-current`;
  foreign-repo and archived exclusion; truncated blockers (tend); Done-audit marker cursor.
  All existing tests untouched and green.
- **A2**: merge-gate suite covers D8: `--dry-run` emits verdicts identical to the merge path
  across the existing gate fixtures **except the sanctioned UNKNOWN divergence** (dry-run
  PENDING — `mergeable`, no retry sleep; merge path retry-then-soft-gate), the parsed
  verdict is the **last** `MERGE GATE` line (WARN-then-PASS fixture included), and the run
  provably performs no mutation (no `gh pr merge`, no comment, no worktree removal invoked).
- **A3**: attest suite covers D9: `--run` records real exit codes (fixture commands exiting
  0 and non-0); a non-zero observed exit produces an honest failing attestation (exit 0),
  not a doctored one; posting on `ran_at_sha` ≠ current `headRefOid` emits
  `ATTESTATION REFUSED — head moved` and exits 75 — asserted distinct from the
  failing-test case; `--carry-review` copies the existing `review` block byte-for-byte and
  refuses with `ATTESTATION REFUSED — no prior review` (exit 75) when no prior attestation
  exists — both refusal tokens asserted distinct from each other and from the failing-test
  case.
- **A4**: **[T-2026-08-08, amended]** `npx tsc --noEmit` clean; `shellcheck -S error`
  unchanged (no new scripts; the scandir extension is dropped with D5's scripts).
- **A5**: **[T-2026-08-08, amended]** The D5 recipes doc carries §4.7.0's goals and
  §4.7.2's conventions per transport, marking which are safety-relevant ("keep this") vs
  preference — including the honest statements that the billing guard binds only
  spawn-point transports and that session loops die with their session; verified in PR
  review (no CI prose-grep is claimed or added).
- **A6**: `readiness` `readyFor` is unchanged for every pre-existing check combination
  (test-asserted); new lane rows are `info` in all states, including enabled-but-stale.
- **A7**: `doctor` behavior unchanged — existing doctor tests pass unmodified; no new
  checks, no new fix lanes.
- **A8**: No lanes-registry key in any config-reading code path (`git grep -n lanes`
  over `ralph/scripts` returns only comments/docs); no ScheduleWakeup/sentinel/polling-loop
  vocabulary in either SKILL.md (review-checked, per A5's method). **[T-2026-08-08]** Now
  load-bearing, not just hygiene: skills are single-pass operators; pacing vocabulary lives
  only in the D5 recipes (§4.7.1). The skills' end-of-pass report (checked/acted, blocked
  reasons, earliest window expiry) is the sanctioned interface to whatever paces them.
- **A9**: `/ralph:deliver` SKILL.md states, as contract rules: never `merge-pr.sh --force`;
  re-attest only via `attest-pr.sh --run`; post-merge Done writes yield to reconcile.
- **A10**: **[T-2026-08-08, amended]** Docs (D7) land with the four-dimension lane test —
  in its amended pacing-signal form (§1) — stated once in `ralph/CLAUDE.md` and referenced
  elsewhere; docs present the transport table (§4.7.1) with `tick.sh` as one recipe among
  several, never as *the* loop.

## 6. Measurement (post-ship, informational)

- work lane: ticks/day > 0 (waystone W4 baseline is 0 — enabling the existing loop precedes
  this spec's deliverables and is tracked separately).
- deliver: median In-Review dwell time; `retry-window` re-arms observed in outcomes logs,
  broken down by verdict class (the PASS-that-never-merged class is the one most worth
  watching); stranded head-unbound attestations trending to zero.
- tend: issues created from observations (with provenance) per week; duplicate-work
  incidents; stale-item age distribution.

## 7. Resolved-by-default open questions

| Question | Default (revisit trigger) |
|---|---|
| Thread-reply depth | Evidence-only; argument ⇒ rework demotion (revisit if reviewers report unhelpful replies) |
| Host repos without merge gate | Native flow fallback (revisit never — recommend-never-impose is standing policy) |
| Direct In Review → Backlog edge | Two-hop until measured rework frequency justifies a MACHINE edit |
| Per-lane locks | **[T-2026-08-08]** Superseded as a lane primitive: the shared lock only ever serialized script transports (§4.7.2.3); script transports keep `tick.pid`, session/routine transports rely on the per-item backstop + one-driver-per-lane convention. Revisit if outcomes logs show claim-race refusals, not lock skips |

## 8. Weakest points (named, accepted)

Following the design record's practice of naming residual risk rather than hiding it:

1. **Attestation commands remain model-chosen.** D9 binds recorded exit codes to real runs,
   but the deliver session still chooses *which* commands to run. Mitigations already in
   place: server-side `validate-attestation.sh` recomputes file classes from the live diff
   and fails on under-coverage, and the external-review gate is independent of the agent.
   Residue: a model could run an irrelevant-but-passing command; accepted, same as the
   work lane today. The review half is not residue at all: re-attestation carries the
   prior `review` block forward verbatim (§4.4) — deliver never authors a verdict.
2. **Work/deliver exclusion is probabilistic, not typed.** Quiescence (§4.2.4), the shared
   lock (which serializes *loop scripts* only), the pre-push quiescence re-check (§4.4), and
   `--match-head-commit` SHA-pinning narrow the race — but an **interactive** `/ralph:work`
   session, on any machine including this one, never holds `tick.pid`; if it sits idle
   longer than `RALPH_SETTLE_MIN`, deliver can rebase and push a branch that live session
   still considers its own. The merge is protected by SHA-pinning; the branch is protected
   only by the pre-push re-check and the settle window. Visible-and-refused at merge time,
   messy-but-recoverable at branch level (the work session's next push conflicts loudly).
   Accepted; users running interactive work sessions alongside an enabled deliver loop
   should size `RALPH_SETTLE_MIN` to their idle habits.
3. **Conventions fail open by nature.** Opt-in flags, billing guard, spawn lock, and outcome
   lines live in user-owned scripts; a user who strips them keeps a working but less safe
   loop. That is the deliberate price of scripts-as-examples; the enforcement line (board.ts,
   merge-pr.sh, state-guard) is unaffected.
4. **Marker comments are deletable.** A deleted or hand-edited marker re-queues (deliver) or
   re-audits (tend) an item once. Cost is a redundant session, never a wrong mutation.
5. **The shared lock can starve the new lanes** — *script transports only*
   **[T-2026-08-08]**. `tick.sh` holds `tick.pid` for the whole work session (up to
   `RALPH_TICK_TIMEOUT_MIN`, default 45 min); with skip-don't-queue, a busy script-driven
   work loop can shut script-driven deliver/tend out for most of an hour. Session/routine
   transports don't contend on it at all — which is both the cure for starvation and the
   source of point 6.
6. **[T-2026-08-08] Claim safety widens from "races rare" to "races visible-and-refused".**
   The old stated margin — one flock-serialized scheduler per machine — does not exist for
   session/routine transports. What actually protects claims now, in order: (a) the claim
   protocol itself — write, read-back verify, loser backs off (`board.ts`; it never
   depended on the flock, the flock only made concurrent writers rare); (b) distinct
   `RALPH_CLAIM_HOLDER` per driver; (c) doctor's claim-anomaly and TTL sweeps; (d) the
   one-driver-per-lane convention (§4.7.2.3 — prose + readiness, not code). Because
   Projects V2 has no CAS, the read-back has a window: two drivers claiming the same item
   in the same few seconds can both believe they won until the next read. The cost is a
   duplicated session refused at merge time (SHA-pinned, gate-guarded), never a corrupt
   board — but it is honestly *weaker* than the flock era, and the weakening is the price
   of the transport uniformity. Users running multiple concurrent drivers should expect
   occasional visible refusals, not silence.
7. **[T-2026-08-08] Session transports die with their session — attended coverage only.**
   A `/loop` lane ends on session close, Esc, or the 7-day cap; there is no parity claim
   with a scheduler. Unattended coverage is exactly two transports: BRIDGE-env routines
   and the scheduler recipe (tick.sh-style). The billing guard likewise only exists at
   spawn-point transports (§4.7.2.2). Named, not papered over.
