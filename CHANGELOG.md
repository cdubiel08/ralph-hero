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

### Added

- **Lane passes are ledgered (GH-2342).** `tend-pass` / `deliver-pass` spawn
  as `t0-tend` / `r0-deliver` — grammar B at issue 0, the "belongs to no
  unit" convention `s0-watch` / `x0-relay` / `d0-fork-…` already use — so each
  pass mints a durable ref and writes the provisional C7 row every spawn path
  writes, closed `never_started` on a refused start. The tender's GH-2267
  outcomes now land on the ledger as a `containment` event (`tool_binding`,
  `process_containment`) after the in-pane probe, on success AND on refusal
  (then `exit containment_<outcome>`); the deliverer's row carries
  `not_requested` for both, read off the empty argv it is handed. Previously
  the fixed names `ralph-tend` / `ralph-deliver` parsed in no grammar, so no
  ref could be minted and the achieved containment was printed to the pass
  log and recorded nowhere. The names stay fixed (no epoch, no generation),
  so the one-live-pass-per-lane interlock is unchanged; the old names remain
  recognised as legacy singletons for panes from an older plugin. Two edges
  followed: C7 `ralph.lineage` admits `issue: 0` (and no other contract
  does — `parent_issue` stays positive), and reconcile's `recover_claim`
  skips issue 0 by name instead of aiming `board get 0` at every dead
  issue-0 row, which was latent for discovered forks.

- **Plugin staleness is announced at spawn time, not only in a doctor sweep
  (GH-2260)**. `herdr` has no auto-update, so the installed ralph-herdr tree
  drifts from the checkout silently — measured here at 0.14.0 against an
  expected 0.23.0 with 48 commits of divergence, latent on exactly the lanes
  that execute the installed copy (`herdr plugin action invoke`, the fleet
  lane, the dispatch seat). `ralph_plugin_freshness_notice` now runs beside
  `billing_guard` at every spawn entry point (`work-fleet`, `work-next`,
  `work-team`, `hero`, `dispatch-up`, `fork`, `deliver-pass`, `tend-pass`,
  and the cockpit's fzf rung), so the drift is stated where the risk is
  taken. It is **advisory and returns 0 on every path**: the remedy swaps
  code under live panes, so the moment of the swap stays the operator's with
  the fleet quiesced, and a spawn refused over a stale plugin is strictly
  worse than a spawn on one. The subject is anchored at `$REPO` and it runs
  the **source** copy of `herdr-plugin-sync.sh --check`, never the one beside
  `lib.sh` — when herdr executes the installed plugin those are the same
  directory, so a check hashing its own tree would let every stale cockpit
  certify itself fresh. Reusing that script rather than re-implementing its
  hash keeps the behavior surface at two mirrored definitions instead of
  three (GH-1843). Four outcomes, none conflated: a repo with no
  `plugin/ralph-herdr` source tree is **silent** (not applicable — no subject
  and no remedy, so a permanent line would be the GH-2052 trap), in-sync is
  silent, an unreadable input reads `NOT CHECKED` with its reason (GH-1971 —
  a failed measurement may not render like a clean one), and a divergence is
  loud with the sync command. The **measurement** is memoized per process
  (keyed on the resolved script path, so a different `$REPO` is re-measured
  rather than answered from another checkout's cache) while the **message**
  is re-rendered per call — hashing both trees forks `shasum` per file at
  ~1.1s, which the cockpit's fzf rung would otherwise pay on every spawn in
  its loop, usually to print nothing; but every spawn takes the risk, so
  every spawn is still told.

  Ships as ralph-herdr **0.38.0**; `ralph/scripts/herdr-plugin-version` moves
  with it (the two stamps are enforced equal by `herdr-setup.test.sh`, not
  floor-and-version), so doctor reports the cockpit stale on this machine
  until the plugin is reinstalled — the honest state, and the swap stays the
  operator's.

### Fixed

- **A self-closed unit left its worktree lock behind (GH-2367).**
  `transition()` released the caller's own `~/.ralph/sessions/wt-*` lock on
  exactly one edge — `In Progress → Backlog` (GH-2107) — so a session that
  closed its own unit (`board move NNN done`, incl. `--decision` and
  apply-evidence closes, or `move NNN canceled`) left a tombstone that
  `reap-leases` can never see when the checkout is the main repo (#2242:
  self-canceled 16 s after the lock was written, still present four days
  later). Every move into Done or Canceled, from any source state, now
  releases the lock under GH-2107's guard unchanged: own session only, after
  the read-back verify, best-effort unlink. `In Progress → In Review` still
  keeps it — deliver reads that lease for the unpushed-commits case
  (GH-1929) — and a non-owning closer still deletes nothing. The merge-close
  path (GitHub auto-close → `reconcile`) is the reaper's, not this edge's.
- **The freshness notice announced on nine spawn paths, missed three, and
  executed the checkout's sync script (GH-2340)**. `billing_guard` had
  twelve call sites and `ralph_plugin_freshness_notice` nine: `refill.sh`,
  the `link-offer` card's `[s]`, and the cockpit's `s` all spawned without
  it — and the cockpit's was worse than missing, since `spawnCmd` discards
  stderr on a successful spawn, so a notice wired there would have been
  announced to nobody. All three announce now; the cockpit lifts the verdict
  off stderr and appends `plugin STALE — sync with the fleet quiesced` /
  `plugin freshness NOT CHECKED` to the spawn status line, and the spawn
  suite pins the invariant as a set equality — every script that runs
  `billing_guard` runs the notice — rather than a list that has to be
  extended by hand. The second defect was the shape of the anchor itself:
  to avoid hashing the installed tree against itself, the notice ran
  `$REPO/plugin/ralph-herdr/scripts/herdr-plugin-sync.sh` — the INSTALLED
  plugin executing whatever script the worktree it was pointed at happened
  to carry, on any branch, with the cockpit's env, across a version boundary
  where `--check` and the exit codes belong to the other side. It now runs
  its **own sibling** and hands the checkout over as a `--source DIR` tree
  to hash: the checkout is a subject to be measured, never a program to be
  trusted, and a caller and callee from one tree cannot disagree about the
  flag contract. The GH-2260 anchor property is unchanged — the subject is
  still the checkout, so a stale installed copy cannot certify itself — and
  the test fixture now proves both halves at once with a tripwire: the
  checkout's copy would answer "in sync" if executed, so a drift that still
  speaks is the proof it was not. A missing sibling reads `NOT CHECKED`
  naming the install, never clean. Ships as ralph-herdr **0.40.0**.

- **The lane budget pre-flight and `gb_snapshot` read GraphQL's own
  `rateLimit` field; they had never been able to fire (GH-2278).** Both read
  REST `rate_limit`'s `graphql` sub-bucket, which mirrors `core`: measured
  five times first-hand during and after a real 5024-point exhaustion, it
  reported `5000/5000 used 0` byte-identical to `core` at the instant
  GraphQL's counter said `0/5000`. `board next|frontier|deliver-queue|
  tend-queue|dep-candidates|brief|inbox` now probe `{ rateLimit { remaining
  limit resetAt } }` (exempt, 0 points — two consecutive probes leave
  `remaining` unchanged) and defer under `RALPH_GH_BUDGET_FLOOR` on
  `remaining`, never on "the call came back" (the exempt probe answers at
  zero). A probe GitHub refuses on budget is authoritative and defers;
  `gb_snapshot` returns a distinct exit 4 for it and `gb_backoff_seconds`
  naps a bounded 60 s rather than printing 0. Fail-open on an unreadable
  budget (exit 3, transport flaps) is unchanged. `gb_snapshot core` and every
  other resource stay on REST, where they are reported correctly.
  `TransientError` carries a typed `reason` (`rate-limited` | `transport`).

### Changed

- **Doctor's `state-guard` line names the cause (GH-2282).** A rate limit, a
  rotten `ROUTING_PAT` and a real bug rendered identically as
  `N/5 recent runs not successful`; the newest failure's log is now read (one
  call, only when a failure exists) and the check emits a distinct verdict
  shape per cause — `rate-limited, self-healed` (`i`, once green runs follow),
  `rate-limited — wait` (names the reset), `auth — rotate ROUTING_PAT` (quotes
  the evidence), `other — debug <run URL>` (incl. an unreadable log). Per-run
  `event` (cron vs event lane) rides the existing list call.

- **Doctor's `ralph-herdr-content` / `ralph-herdr-version` lines stay `i`
  (GH-2260, decided explicitly)**. The case for escalating them is that their
  subject is the machinery the board's own automation runs on. It does not
  carry: the remedy is unautomatable by construction (`--fix` may not swap
  code under live panes), so a strict-failing check whose only remedy is a
  human's fleet-quiescing act is the GH-2052 unsatisfiable-remedy trap — and
  in CI, where no herdr install exists, the check reads `not evaluated`, so
  escalation would be either permanently inert there or permanently red on
  the one machine with a cockpit. The real complaint — that a human has to
  run doctor to see it — is answered by putting the observation at the spawn
  path (above), not by making doctor's exit code angrier.
- **`board answer` no longer claims the unit to the answerer — the resume
  edge belongs to the resuming agent (GH-2204)**. The verb's default is now
  comment-only: the **Answer** comment lands (timestamped by a
  `ralph-answer:v1` marker) and the item stays Human Needed; the driving
  session takes `Human Needed → In Progress` itself via `board claim NNN`, so
  the session→unit binding (GH-1948), worktree lock (GH-1956) and size
  ceiling (GH-2134) bind on the actual driver instead of the answering proxy.
  `--resume` keeps the one-invocation answer-and-resume for self-answer
  (answerer == driver); `--comment-only` now names the default and is inert.
  The answered-but-unresumed window is surfaced rather than silent: `board
  escalations` marks answered rows (`ANSWERED … resume pending`), and doctor
  gains an advisory `answer-unresumed` line (`RALPH_SMELL_ANSWER_MIN`, 30
  min; undated answers age as overdue — toward visibility). ralph-herdr's
  answer surfaces (popup + cockpit `a`) report "answered; resume pending" and
  nudge the paused agent to claim, never asserting a transition that did not
  happen (ralph-herdr 0.15.0).

### Added

- **Cockpit Inbox view — `I` swaps the third column to `board inbox` Tier 1
  (GH-2181, unit E of #2176)** — the fourth view on the `D`-toggle precedent:
  same column, same lazy shown-only read (dispatched on the keypress, refreshed
  on the second cadence only while on screen), same cursor clamp, and the two
  toggles displace each other rather than stacking. Cards keep the CLI's own
  section order (decisions > proposals > approvals > deliver-blocked) and carry
  their queue kind in the right slot; a decision card renders its why-line
  under the same phone-answerable contract as Human Needed (`a` disposes it in
  place), every other card renders its **literal disposition verb**, and
  `s` on an inbox card is a named refusal pointing at that verb. The GH-2108
  honesty rules carry through: unread, read-failed, and genuinely-empty render
  distinctly (a failed refresh over a non-empty list banners as stale), and
  withheld deliver rows are counted in a footer, never dropped silently.
  `InboxRow` gains a `repo` field (nameWithOwner) so the cockpit's `g` browser
  verb works on inbox cards without re-deriving config.

- **`board inbox` — the human's single surface, two tiers (GH-2180, unit D of
  #2176)** — one walk over the four human queues: Human Needed decisions (each
  carrying the first line of its latest `**Decision needed**` comment), tend
  proposals, Intake approvals (verbs honest about the readiness bar — a row
  missing Priority/Estimate renders the field step before `board move N
  backlog`), and the deliver-blocked rows only a human clears
  (`convergence-stalled`, `no-pr`). Admission is by disposition, in one
  declaration: a reason enters only if a human verb disposes it — the windowed
  self-clearing reasons, `deferred` (probe-budget backoff), and
  `reviewer-rate-limited` (no verb, no computable expiry) are **counted as
  withheld and named**, never silently dropped (the GH-2108 rule). The
  disposability invariant is structural: every row carries a literal verb,
  pinned by a test over every category. `--digest` is Tier 2 (GH-1553/1555
  restored on v2 primitives): completions since the last mark
  (machine-local stamp under `~/.ralph/inbox/`, atomically written) plus a
  `pushWorthy` verdict computed **before** any stamp write and keyed on the
  local calendar date — "at most one push a day" is the invariant, zero is
  legal; `--mark` closes the window, and the mark **is** Tier 2's expiry.
  One row per issue, precedence decisions > proposals > approvals >
  deliver-blocked. Rides the shared item cache like `brief`; probes OFF (an
  inbox is a glance, not a gate run); a failed decision-trail read degrades
  the row's text, never the row.

- **`board setup` adds a missing Workflow State option itself — the manual UI
  step is gone (GH-2127)** — the premise it rested on ("the API cannot edit an
  existing field's option set") was disproven in GH-2117 and verified live.
  `updateProjectV2Field` accepts `singleSelectOptions`, and
  `ProjectV2SingleSelectFieldOptionInput.id` exists for exactly this case:
  resubmit an option **with its id** and its identity — and every item value
  referencing it — survives.

  The gap this closes is doctor *enforcing* a field state the CLI had no verb
  to write: `state-field` is a hard ✗ on a missing option, and `mutationCache`
  fails every Intake filing and move closed on it, while the only remedy was a
  human in the board UI, one board at a time.

  The hazard is real and is handled as one, not asserted away. The mutation
  **replaces** the whole set, so an option resubmitted without its id is
  recreated fresh and every item holding it is cleared. Three bounds:

  - **Adding only.** Existing options are resubmitted verbatim — id, name,
    colour, description — and missing states are inserted at the position
    `STATES` implies. Nothing is reordered, renamed or removed.
  - **An unreadable current option set refuses the mutation**, falling back to
    the manual line with the reason named. A blind resubmit is precisely the
    destructive write the id mechanism exists to prevent, so a failed read may
    not become one.
  - **Verified by id survival, never by the ack.** The refreshed schema must
    return every pre-existing option under its original id; a mismatch is a
    named `VERIFY FAILED` and `ok: false`.

  Unchanged and deliberately so: **removal is not offered.** Deleting an
  option clears the state of every item still holding it, which is
  unrecoverable, so the 5 legacy v1 states stay a human act in the UI. The
  CLAUDE.md gotcha and doctor's legacy line now say *this file will not*
  rather than *the API cannot*. Idempotent as before — a complete option set
  produces no mutation.

- **Dead leases are no longer stale ones, and `board reap-leases` clears them
  (GH-2108)** — `board brief` printed every per-(worktree, unit) lock on the
  machine, forever. Measured on the reporting machine: 126 locks, **83 of them
  naming a checkout that no longer existed** (the ones the GH-2103 sweep
  removed, plus ordinary finished sessions), the oldest a week old, and of the
  43 live ones only **6** belonged to the repo the brief was for. The five real
  holds were unreadable under the tombstones.

  Three separable fixes, one per question the issue posed:

  - **Dead vs stale.** `readLocalLeases` now classifies each lock's worktree as
    `present`/`missing`/`unknown`. Staleness asks whether the holder might come
    back — the right question for a checkout that exists, and the wrong one
    forever for a checkout that is gone, since nothing can refresh that lock.
    `board who` renders `missing` as **DEAD**, checked *before* the age test so
    a lock swept minutes ago is not reported as live. `ENOENT` is the only
    reading that means gone: a permission error, an unmounted volume or a
    symlink loop is `unknown` and treated as present everywhere, because an
    unreadable path is not evidence of removal and the two mistakes do not cost
    the same.
  - **Scope.** `brief` is the repo-scoped orientation read, so it now shows only
    leases on this repo's own checkouts — issue numbers are per-repo, so another
    checkout's `lease: #76` names a *different* issue and the line was a wrong
    statement, not just noise. Repo identity is the resolved git common dir,
    read from the checkout's own `.git` (no exec), and compared only when **both**
    sides resolved: an unresolved side is `unknown`, never `different`, so no real
    lease is withheld because a read failed. What is held back is **counted and
    named** in one line, with `board who` pointed at as the machine-wide surface
    that still lists everything — withholding silently would recreate the defect
    one layer down. `--json` stays unfiltered; the new fields let a machine
    reader apply its own cut.
  - **Reaping.** `board reap-leases [--apply] [--json]` removes lock files whose
    worktree is gone — dry run by default, zero API. **The predicate is the
    missing checkout, never the lock's age**: a lease is what `deliver-queue`
    reads for `local-session-active` (GH-1929), so anything able to delete one
    must be unable to delete a live one, and age cannot tell them apart (a
    session idle three hours still owns its tree and its unpushed commits) while
    a missing directory can. The state is re-read at the moment of deletion, not
    trusted from the classification pass, since `git worktree add` can restore
    the path in between. Machine-wide like `who`, because a dead lock's repo can
    no longer be read off a directory that does not exist.

  `localSessionLease` — deliver's *blocking* predicate — is deliberately
  untouched: a dead lease there self-clears on `RALPH_LOCK_TTL_MIN`, so its
  cost is bounded at one TTL on one unit, while `brief`'s was unbounded and
  permanent. Adding a worktree test to a blocking read is a separable judgment
  with its own failure direction. Also corrected: the comment on
  `worktreeLockPath` claimed a 7-day pruner reaped these files. There is none,
  and there never was — which is how they accumulated.

- **The Intake tier — filing an issue is no longer approving it (GH-2077)** —
  a seventh Workflow State, upstream of Backlog, for work that is tracked but
  not yet approved for autonomous pickup. Before it, `next`'s pool was every
  unclaimed Backlog item, so every way to hold unapproved work was dishonest
  (fake blocker, fake claim, P3-and-hope) or kept it off the board entirely —
  invisible to `tend`, `doctor`, and anyone accountable for it, with an empty
  `board next` reading identically whether there was no work or no *filable*
  work (GH-2048's ambiguity, one tier upstream). Implements the GH-2060 design
  record.

  Exclusion is **by construction**, which is why it is a state and not a field
  or a label: every eligibility read already filters `state === "Backlog"`, so
  an Intake item leaves `next`/`frontier` with zero predicate change and there
  is no reader to forget. Edges are strictly one-way — `Intake → Backlog |
  Canceled` — so `board claim` on an unapproved item refuses via the MACHINE
  rather than via special code, and there is no demotion edge back (the
  argument `Backlog → Human Needed` already lost). Approval is the
  `Intake → Backlog` move and refuses without a Priority and an Estimate:
  Backlog means approved *and rankable*.

  **Breaking:** `board create` has no default landing state. Pass `--intake`
  (Priority/Estimate optional) or `--backlog` (both required, each missing one
  named in the refusal); neither is a refusal naming both lanes. This
  supersedes GH-1792's stderr nudge, which existed only because there was no
  lane for "I do not know the priority yet".

  Surfaces: `list` shows Intake by default, `tend-queue`'s `unformed` category
  takes Intake items with their age, and `doctor` gains an advisory
  `intake-stale` line (`RALPH_SMELL_INTAKE_DAYS`, 14 — never strict-escalated,
  never fixed). The epic in-flight probe was widened too: written as
  `state !== "Backlog"`, it would have read an unapproved *child* as work in
  progress and demoted its root out of the queue. **One manual UI step per
  board** — the API cannot add an option to an existing field, so `setup`
  prints it and until it exists every Intake filing fails closed with that
  hint. Deliberately unchanged: state-guard adoption and `reopen` still land in
  Backlog.

### Fixed

- **The release bump annotation is read where authors write it (GH-2122)** —
  `release-ralph.yml` took `#minor`/`#major` from `git log -1`: the **merge**
  commit, whose message `gh pr merge --merge` composes from the PR *title*. An
  annotation written in the branch commit — where an author naturally writes
  it — never appeared there, so the release silently took a patch bump. PR
  #2119 shipped a new public CLI verb (`board reap-leases`) as `ralph-v0.3.1`
  that way, with a green run reporting "Bump type: patch (default)". The rule
  was read from a surface nobody writes to, the same class as GH-1940.

  The reader now takes the merge commit's full message **and** the *subject
  line* of each commit the PR brought in (`<merge>^1..<merge>^2` — exactly the
  branch's own set, so a `#major` already on main, or one the branch merged
  *from* main, cannot leak in and re-major a later release). `#major` outranks
  `#minor` across the whole set, never first-commit-wins.

  Branch commits are read by **subject only**, and that bound is load-bearing.
  The first version of this fix scanned full bodies, and reported `major` for
  its own merge off a body line reading "`#major` outranks `#minor` across the
  whole set" — prose about the rule matching as the rule. That is strictly
  worse than the defect it closed, since the old reader only ever saw the short
  PR title. An annotation is a subject-line suffix (PR #2119, the founding
  case, wrote `... (GH-2108) #minor` at the end of its subject); a body is
  prose. The merge commit keeps its full-message scan, because that is where
  `gh pr merge --merge` puts the PR title. Fixed at the reader rather than by having `merge-pr.sh`
  propagate the annotation into the merge commit: that would be correct only
  for merges going through it, leaving the GitHub UI and auto-merge on the
  original silent failure, and would put the release rule in a second file to
  drift (GH-1843).

  Extracted to `scripts/release-bump-type.sh` with a real suite
  (`scripts/__tests__/release-bump-type.test.sh`, picked up by CI's existing
  glob). This logic has now been wrong twice — GH-2102's unbounded grep, this
  issue's surface — and neither defect was catchable while it lived as twelve
  lines of shell inside a YAML step. It **exits 2** rather than answering
  `patch` when a source it expected to read is unreadable: a wrong patch bump
  is silent forever, while a failed release job files its own issue (GH-1952).
  A commit with no second parent is the expected shape of a non-merge push, not
  a failure, and degrades to reading its own message.

- **Fleet spawns tell the host provisioner where the worktree is (GH-2106)** —
  `provision_worktree` ran `bash scripts/provision-worktree.sh` with no
  argument, so a host script opening with `${1:?Usage}` exited 1 on *every*
  spawn. Provisioning is fail-open, so the run continued and each agent landed
  in a tree with no install — unable to type-check, test or build until it
  rediscovered that itself (observed on every spawn of one pilot repo's fleet
  run). The worktree path is now passed as `$1`; a host script that ignores
  argv is unaffected. The provisioner's rc is also carried out of the spawn, so
  `work-fleet.sh`'s summary names the spawns that landed unprovisioned instead
  of leaving the only trace in mid-spawn stderr — a provisioner failing on
  every spawn read exactly like one broken host script. ralph-herdr plugin
  0.10.0 → 0.10.1 (stamp pair in lockstep).

- **The cockpit action is focus-or-open (GH-2074)** — invoking `Ralph: cockpit`
  twice used to stack a second cockpit over the live one (measured 2026-08-18 on
  three live agent panes). The action now runs `scripts/cockpit-open.sh` in the
  action process; `cockpit-launch.sh` records its pane per board, and "live" is
  checked as two independent facts (the pid still runs *and* the pane is still in
  a validated snapshot). Every unreadable read still opens — the fail-open
  direction the ladder already takes. ralph-herdr plugin 0.9.0 → 0.10.0 (stamp
  pair in lockstep).

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
