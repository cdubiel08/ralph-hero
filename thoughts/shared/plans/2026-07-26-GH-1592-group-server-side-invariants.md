---
date: 2026-07-26
status: draft
type: plan
tags: [mcp-server, state-machine, lock-guard, tree-contracts, portable-enforcement]
github_issues: [1615, 1616, 1617, 1618, 1619]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1615
  - https://github.com/cdubiel08/ralph-hero/issues/1616
  - https://github.com/cdubiel08/ralph-hero/issues/1617
  - https://github.com/cdubiel08/ralph-hero/issues/1618
  - https://github.com/cdubiel08/ralph-hero/issues/1619
primary_issue: 1615
estimate: S
research_doc: thoughts/shared/research/2026-07-26-GH-1592-server-side-invariants-sweep.md
last_updated: 2026-07-26
last_updated_note: "Iteration 1 vs critique 2026-07-26-GH-1592-critique.md — regression inventory re-derived by reachable-FROM-set (10 new rows), transition check moved ahead of ALL mutation in save_issue, both parent writers brought under validation, lock-release takeover closed, maxChildEstimate given a default. See ## Iteration Log."
---

# GH-1592 Group Plan — Server-side invariants: transitions, locks, tree contracts, hook demotion

Group plan (GH-1538: feature = PR unit) covering the five children of #1592.
One worktree `GH-1615`, one branch `feature/GH-1615`, ONE PR closing
#1615, #1616, #1617, #1618, #1619.

**Merge path note:** `main` is ruleset-protected — all changes land via PR
(`scripts/attest-pr.sh` + `scripts/merge-pr.sh`). The research doc
(`thoughts/shared/research/2026-07-26-GH-1592-server-side-invariants-sweep.md`),
the plan-of-plans (`thoughts/shared/plans/2026-07-26-GH-1592-plan-of-plans.md`),
and THIS plan ride in the same PR branch as the code. Merging triggers
`release.yml` (the diff touches `mcp-server/src/**`), so enforcement ships as
a published `ralph-hero-mcp-server` version, and `release-ralph.yml` (the diff
touches `ralph/**`) for the hook demotion.

## Prior Work

- builds_on:: [[2026-07-26-GH-1592-server-side-invariants-sweep]] (research — authoritative evidence base; refutes the "advisory lock guard" premise, proves fail-open, supplies the caller regression list)
- builds_on:: [[2026-07-26-GH-1592-plan-of-plans]] (plan — feature decomposition this plan implements; sequencing corrected here per research § Risks)
- builds_on:: [[2026-03-21-group-GH-652-server-side-lock-guard]] (plan — precedent: the lock guard was born as a server-side hard refusal; this plan extends, does not create, that layer)
- builds_on:: [[2026-03-03-GH-0000-state-machine-transition-audit]] (research — the drift problem that produced JSON-driven `state-gate.sh`; the same drift now exists between the JSON and `state-resolution.ts`)
- tensions:: [[2026-07-26-GH-1591-plan-of-plans]] (plan — tool wave 2; the `#1614 → #1615` hard ordering it implies is over-serialized, see Design Decisions)

## Overview

Move the state invariants that today live only in Claude-Code hooks — and
fail open there — into the MCP server, where every harness inherits them.
Five phases, one per member issue: (1) transition legality enforced at a
single choke point in `save_issue` / `advance_issue` / `batch_update`,
(2) lock-guard side doors closed and refusals enriched with holder identity
and claim time, (3) stale-lock detection moved to the correct clock and made
actionable, (4) tree contracts (parameterized estimate ceiling, up-front edge
sanity) inside `create_sub_issues`, (5) the superseded hooks demoted and a
zero-hook hero-fable lifecycle producing refusal-transcript evidence.

The main planning problem is **regression risk**: transition validation
touches every workflow-state writer in the system. Phase 1 carries a full
caller inventory with per-caller mitigations; the transition table is the
JSON's `allowed_transitions` PLUS a documented set of added edges, because
the JSON as written forbids flows the system already depends on (lock
release, plan-reuse fast-path, NEEDS_ITERATION re-lock).

## Current State Analysis

Three enforcement layers exist today (research § Architecture):

1. **Claude-Code hooks** — client-side, env-scoped, fail-open by policy.
   `state-gate.sh:84-90` explicitly allows on unknown command keys or
   unreadable JSON, and `state-gate.test.sh:88` pins that as expected.
2. **The MCP server** — the only layer every harness shares. Already owns
   status sync, parent auto-advance, terminal auto-close, intent resolution,
   per-command output validation (`state-resolution.ts`), and a HARD lock
   guard in `save_issue` (`issue-tools.ts:1602-1614`, GH-652).
3. **GitHub Actions** — out-of-band trusted writers (`route-issues.yml`,
   `sync-issue-state.yml`, `sync-project-state.yml`, `advance-parent.yml`,
   `sync-pr-merge.yml`) mutating Workflow State via raw GraphQL with
   `ROUTING_PAT`. They do not call the MCP server and are out of scope as
   enforcement targets — documented as trusted writers.

### Key Discoveries

All verified against the working tree during planning (not inherited from
the research doc unchecked):

- **Lock guard is already a hard refusal** — `issue-tools.ts:1602-1614`
  returns `toolError` on `isLockConflict`; the `force` bypass at `:1602` is
  silent (no log, no response marker). #1616's "advisory → hard" framing is
  wrong; the re-scope is settled (Design Decisions).
- **Three unguarded side doors**: `batch_update` performs ZERO validation on
  `workflow_state` ops (`batch-tools.ts:379-487` — only the optional
  `skipIfAtOrPast` filter); `advance_issue direction='children'` checks only
  `isValidState` + forward-only (`relationship-tools.ts:632-638, 741-751`)
  and can SET lock states; `create_sub_issues` passes `workflowState`
  through with no validity check (`tree-tools.ts:58-61`).
- **No layer enforces current-state transition legality.** The JSON's
  `states.*.allowed_transitions` (`ralph-state-machine.json:6-80`) is read
  by no hook and no server code.
- **The parity tests are silent no-ops** (stronger than the research's
  "one-directional" finding): `state-resolution.test.ts:392,422` resolve the
  JSON at `../../../hooks/scripts/ralph-state-machine.json` — repo-root
  `hooks/`, which does not exist (the JSON lives at
  `ralph/hooks/scripts/`) — and `if (!fs.existsSync(jsonPath)) return;`
  makes both tests pass vacuously. This is how the
  `COMMAND_ALLOWED_STATES` drift survived.
- **Confirmed drift** (server map `state-resolution.ts:36-61` vs JSON):
  `ralph_pr_drain` missing entirely (JSON has
  `["In Progress","Done","Human Needed"]`); `ralph_triage` missing
  `Backlog`; `ralph_hero` is `["In Review","Human Needed"]` vs the JSON's
  nine states.
- **Live prose/contract mismatch**: `plan/SKILL.md:203` instructs
  NEEDS_ITERATION as `save_issue(workflowState: "Plan in Progress",
  command: "review")` — refused by BOTH the server map and the JSON
  (`ralph_review` lacks `Plan in Progress`, and `Plan in Review`'s
  `allowed_transitions` lack it too). The hook masks this because the plan
  skill's gate unions `plan plan_epic review` keys.
- **Stale-lock clock is wrong**: `detectLockStale` (`directions.ts:427-430`)
  uses `item.updatedAt` = issue CONTENT `updatedAt`
  (`dashboard-fetch.ts:100`), which project-field-only claims do not bump.
  The Workflow State field value carries its own `updatedAt` + `creator`
  via `ProjectV2ItemFieldValueCommon` — the correct claim clock AND the
  missing holder identity. `next_actions` ALREADY exposes a per-call
  `lockStaleHours` param (`directions-tools.ts:645-651`, default from
  `thresholds.ts:17` `LOCK_STALE_HOURS = 24`).
- **`create_sub_issues` already fails closed on edges**: out-of-range
  `dependsOn` and cycles (incl. self-edges) are up-front `toolError`s before
  any mutation (`tree-tools.ts:371-394`); `dependsOnIssues` resolvability is
  stage-4 per-child partial failure. Estimate is explicit passthrough
  ("policy gating lives in hooks", `tree-tools.ts:56, 345-346`).
- **Hook registrations to remove** (verified lines): `state-gate.sh` at
  `research/SKILL.md:27`, `impl/SKILL.md:30`, `plan/SKILL.md:42`,
  `review/SKILL.md:15`, `caretake/SKILL.md:36`, `hero/SKILL.md:27,29,33`;
  `lock-release-on-failure.sh` at `research/SKILL.md:42`,
  `impl/SKILL.md:53`, `plan/SKILL.md:74`, `review/SKILL.md:32`,
  `caretake/SKILL.md:50`, `hero/SKILL.md:46`; `split-size-gate.sh` at
  `caretake/SKILL.md:23`; `split-estimate-gate.sh` at
  `caretake/SKILL.md:19,32`.
- **#1619's CLAUDE.md claim is stale** (settled): root `CLAUDE.md` no longer
  cites `split-estimate-gate.sh`; the canonical-example prose lives in
  `ralph/skills/caretake/split-decomposition.md:100,124`,
  `specs/skill-io-contracts.md:70` (§ Precondition Enforcement table), and
  `ralph/skills/caretake/outcome-tokens.md:87`.
- **hero-fable is the zero-hook vehicle**: its SKILL.md registers no hooks;
  its prose contains command-less `save_issue(workflowState: "In Progress")`
  (`:43`) and `"Human Needed"` (`:49`) calls that the new validation must
  keep viable (see regression inventory).

## Desired End State

1. Every workflow-state mutation through the MCP server is validated for
   transition legality from the LIVE current state, after semantic-intent
   resolution, with or without `command` — refusals name the current state,
   the attempted state, and the legal next states. There are **six**
   Workflow State writers, not three, and all six are accounted for
   (enumerated by `grep -rn "updateProjectItemField(" mcp-server/src/` plus
   the two direct aliased-mutation writers):

   | Writer | Site | Treatment |
   |---|---|---|
   | `save_issue` | `issue-tools.ts:1624` (field block) | transition-validated (Phase 1 §4) |
   | `advance_issue direction='children'` | `relationship-tools.ts:762` | transition-validated, per-issue `errors[]` (Phase 1 §4) |
   | `batch_update` | `batch-tools.ts:437+` (aliased mutations) | transition-validated, per-issue `errors[]` (Phase 1 §4) |
   | `advance_issue direction='parent'` | `relationship-tools.ts:999` | parent-gate-validated (Phase 1 §6) |
   | `autoAdvanceParent` | `helpers.ts:830`, called from `save_issue:1743` and `tree-tools.ts:715` | parent-gate-validated (Phase 1 §6) |
   | `create_issue` | `issue-tools.ts:1283` | transition check vacuous — the issue was created milliseconds earlier, current state is empty by construction; gets an up-front `isValidState` check only (Phase 1 §6) |

2. Validation fails closed: malformed/unknown states, illegal transitions,
   AND current-state fetch failures are all `toolError`s; there is no
   silent pass-through path server-side. "Field genuinely absent" is
   distinguished from "fetch failed" and only the former passes.
3. Validation runs ahead of **all** mutation, not just ahead of the field
   write. A refusal never leaves the GitHub issue mutated with the board
   stale — `save_issue` mutates the issue (close/reopen/title/body/labels/
   assignees) at `issue-tools.ts:1452-1584` and only reaches the
   project-field block at `:1585+`, so the check moves ahead of `:1452`.
4. `force: true` bypasses transition + lock guards for repair, and is loud:
   the response carries a `forced*` marker with the previous state, and a
   debug-logger event records it.
5. Lock refusals name the holder (`creator.login`) and claim time (field
   value `updatedAt`); the three side doors (`batch_update`,
   `advance_issue`, `create_sub_issues`) no longer bypass validation. A
   lock cannot be stolen by a two-call release-then-claim: the added
   backward release edges are themselves gated on `heldSince` or `force`
   (Phase 2 §4b).
6. Stale-lock detection uses the Workflow State field value's `updatedAt`;
   lock-stale `next_actions` directions carry concrete reclaim
   instructions; threshold configurable per-call (existing param) and via
   env default.
7. `create_sub_issues` enforces a child-estimate ceiling that is **armed by
   default** (`maxChildEstimate` defaults to `"M"`, so no surface can create
   L/XL children by forgetting a param) and overridable per call; it also
   validates `workflowState` + `dependsOnIssues` up front — contract
   violations create zero issues.
8. `state-gate.sh`, `split-size-gate.sh`, `split-estimate-gate.sh`,
   `lock-release-on-failure.sh` and their registrations are deleted; hook
   suite, ShellCheck, doc rosters green; a zero-hook hero-fable transcript
   in the PR proves each invariant server-side.
9. The JSON ↔ server parity test actually runs (fixed path), fails when the
   JSON is missing, and asserts set equality in BOTH directions.

### Verification

- `cd mcp-server && npm test` — all suites green, including the new
  `workflow-transitions.test.ts` and extended `state-resolution.test.ts`,
  `lock-guard.test.ts`, `save-issue.test.ts`, `advance-issue.test.ts`,
  `batch-tools.test.ts`, `tree-tools.test.ts`, `directions.test.ts`,
  `dashboard-fetch.test.ts`.
- `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` — green after hook deletion.
- `shellcheck -S error ralph/hooks/scripts/*.sh` — green.
- `bash scripts/check-doc-rosters.sh` — green.
- Zero-hook lifecycle evidence doc committed and linked from the PR body.
- Manual: refusal error texts are actionable when triggered against the live
  board (see per-phase Manual Verification).

## What We're NOT Doing

Grounded in the research doc:

- **No scheduled reclamation workflow** (research § 5 Candidate B). The
  server-side TTL surfaced via `next_actions` meets #1617's AC as written;
  a cron fork of state policy into YAML is the regression vector the epic
  exists to remove. Recorded as an optional follow-on, not built.
- **No mandatory `command` on `save_issue`** (research § 3 caller list —
  hero-fable, pr-drain, human/CLI repair calls are legitimately
  command-less). Transition legality from live current state covers the
  command-less path instead.
- **No ≥2-children postcondition in `create_sub_issues`** (settled): the
  tool's own partial-failure design makes single-child repair calls
  legitimate; the ≥2 rule is the SPLIT verb's semantics and stays with the
  decomposition surface (#1605).
- **No parent-M/L/XL precondition in the tool** (research § 6): `form`
  legitimately creates trees under unestimated parents; stays
  workflow-level (#1605).
- **Not enforcing anything on the GitHub Actions writers** — they bypass
  the MCP server by design (`ROUTING_PAT` + raw GraphQL). Documented as
  trusted writers; the zero-hook proof does not claim to cover them.
- **Not demoting `unblock-state-gate.sh`** (`caretake/SKILL.md:38`) — a
  fifth state gate not named in this feature; folding it in is scope growth
  (research Open Question 1). Flagged as a follow-up candidate.
- **Not fixing `get_issue`'s legacy `trackedIssues` relationship mapping**
  (`issue-tools.ts:998-1007`, research § Summary 6) — real bug, separate
  fast fix; filing it as its own issue keeps this PR's revert scope clean.
- **Not rewriting the state machine itself** — states, ordering, and
  categories in `workflow-states.ts` are unchanged; only enforcement moves.
- **Not removing the `force` escape hatch** — it becomes loud, not gone.
- **Not binding the cross-repo `dependency-flow` target state** (inventory
  row 27) — the sibling lives in another repo/project, the target state is
  not enumerated in the prose, `.ralph-repos.yml`, or `repo-registry.ts`,
  and inventing a schema field is scope growth into #1591's territory.
  Phase 5 requires the flow to name a target and read the sibling first;
  the plan does NOT claim to have proved this caller legal, and the
  evidence doc says so. This is the one acknowledged hole in the
  MCP-mediated coverage claim.
- **Not distinguishing lock holders by identity** — `creator.login` is
  captured and shown when available, but every local agent shares one token
  login, so identity cannot separate "same agent resuming" from "second
  agent stealing". `heldSince` carries the weight; the same-state re-claim
  carve-out stays for exactly this reason.
- **Not making child `estimate` mandatory on `create_sub_issues`** — under
  the implicit `"M"` default an unestimated child is created and reported
  in `unestimatedChildren` rather than refused. Making it mandatory would
  be a breaking contract change for repair callers and is not needed to
  close the hole the research named (which was L/XL children, not missing
  estimates). Explicitly arming `maxChildEstimate` still fails closed on a
  missing estimate.

## Design Decisions & Open Ambiguities

Settled during planning (directives + research evidence); none are open:

- **#1616 re-scoped away from "advisory → hard"** — options: keep issue
  framing; re-scope to side doors + metadata + loud force. **Decided:
  re-scope.** `isLockConflict` is ALREADY a hard `toolError` in `save_issue`
  (`issue-tools.ts:1602-1614`, shipped with GH-652). The real work is the
  three unguarded side doors, holder/claim-time in the refusal (free via
  `ProjectV2ItemFieldValueCommon.creator/updatedAt`), and making `force`
  loud. Phase 2 is written to that scope.
- **Transition table = JSON edges + documented additions** — options:
  enforce JSON verbatim; enforce JSON + additions; skip transition legality.
  **Decided: JSON + additions**, because the JSON verbatim FORBIDS flows the
  system depends on. Additions (each with a consuming caller): (a) release
  edges `Research in Progress → Research Needed` and
  `Plan in Progress → Ready for Plan` — required by #1617 reclamation and
  by today's `lock-release-on-failure.sh:59` advice; NO release edge for
  `In Progress` (preserves the no-rollback asymmetry,
  `lock-release-on-failure.sh:61-64`); (b) universal edges: every
  non-terminal state → `Human Needed` / `Done` / `Canceled` — mirrors the
  `__ESCALATE__`/`__CLOSE__`/`__CANCEL__` wildcard intents, the auto-close
  path, and the reverse-inference path (`issue-tools.ts:1442-1450`), and
  keeps triage/hygiene close-from-anywhere working; (c)
  `Ready for Plan → In Progress` — parent-plan-reuse fast path
  (`intake-routing.md:104`) and `ralph_plan`'s existing allowlist; (d)
  `Research Needed → Backlog` — `ralph_split` `__COMPLETE__` re-queue; (e)
  `Plan in Review → Plan in Progress` — NEEDS_ITERATION re-lock, fixing the
  live `plan/SKILL.md:203` mismatch. Same-state writes and unknown/empty
  current state always pass (idempotency; new/stateless items).
  `Done`/`Canceled` have no outbound edges — reopen repair requires `force`.
- **`force` bypasses BOTH transition and lock guards, loudly** — options:
  separate flags; one flag silent; one flag loud. **Decided: one flag,
  loud.** Response gains `changes.forcedTransition` /
  `changes.forcedLockOverride` (previous state, holder, heldSince) and a
  debug-logger event. No bot comment (costs an API call per repair; the
  response marker + debug log satisfy "explicit and logged" — durable-
  comment option recorded as not-doing).
- **Same-state re-claim carve-out stays, but becomes visible** — options:
  refuse same-state re-claims; keep carve-out. **Decided: keep.** Holder
  identity is the token's user — every local agent shares one login, so
  "same agent" vs "second agent" is not distinguishable by identity alone.
  Refusing would break legitimate resume flows. Instead, a same-state
  re-claim response gains `changes.lockReclaim: {heldSince}` so callers and
  humans can see a re-claim happened.
- **`#1614 → #1615` de-serialized** (settled) — #1591 explicitly KEEPS
  `save_issue`/`advance_issue`/`create_sub_issues` ("Keep the composed
  workflow tools … push MORE logic server-side"); none of #1609–#1613
  rename or remove the tools this plan hardens. The only genuine coupling
  is `batch_update` (#1611 merges `archive_items` into it) — a
  merge-conflict-level coordination with ONE file (`batch-tools.ts`), not a
  semantic dependency. Phase 1 therefore has `depends_on: null`; whichever
  of this PR / #1611 lands second rebases `batch-tools.ts`.
- **#1617 clock source = project field `updatedAt`** (settled) — issue
  content `updatedAt` is the wrong clock (field-only claims don't bump it);
  the same fetch that gives #1616 its holder gives #1617 its claim clock.
- **#1618 ceiling parameterized, fail-closed when armed** (settled +
  extension) — new `maxChildEstimate` request param, no default. When SET,
  every child MUST carry an estimate ≤ ceiling — a child with NO estimate
  is refused (the hook's no-estimate allow at `split-size-gate.sh:64-66`
  was a fail-open hole; the tool contract fails closed). When UNSET, the
  tool remains passthrough for estimates (epic decomposition with M
  children stays legal — this very group's siblings are the
  counter-example). The split skill prose arms it with `"S"`.
- **`batch_update` refusal granularity: per-issue** — options: refuse whole
  batch; per-issue skip + error. **Decided: per-issue**, consistent with
  the tool's existing partial semantics (`skipped[]`/`errors[]`); a batch
  of 20 with one illegal transition should not strand the other 19.
  `create_sub_issues` contract violations stay whole-batch up-front
  refusals (nothing is created) — creation is different from mutation:
  partial creation orphans issues.
- **Evidence transcript location** —
  `thoughts/shared/reviews/YYYY-MM-DD-GH-1619-zero-hook-lifecycle-evidence.md`
  (the run date at authoring time — `YYYY-MM-DD` is a placeholder to
  substitute, not a literal) on the PR branch, linked from a
  `## Zero-hook evidence` section in the PR body (details in Phase 5).
- **JSON stays, updated in lockstep** — `ralph-state-machine.json` remains
  (still consumed by `hook-utils.sh` intents and the parity test); Phase 1
  adds the new edges/drift fixes to BOTH the JSON and the TS port, and the
  repaired two-way parity test keeps them locked together.

None — no open design decisions.

## Implementation Approach

Five phases, one per member, executed sequentially in the shared
`GH-1615` worktree on `feature/GH-1615`, one commit per phase. Phases 1–4
are `mcp-server/src/**` + tests; Phase 5 is `ralph/**` + `specs/` + docs +
evidence. File ownership is disjoint per phase EXCEPT `issue-tools.ts`,
`batch-tools.ts`, `relationship-tools.ts` (Phase 1 adds transition
validation; Phase 2 threads lock metadata through the same choke points —
Phase 2 builds directly on Phase 1's code, which is why they are ordered)
and the shared helper in `helpers.ts` (Phase 2 creates it; Phase 3 reuses
it).

**File ownership revised in iteration 1**: Phase 1 grew three files it did
not own before, all disjoint from Phase 2's additions to the same files —
`helpers.ts` (the `autoAdvanceParent` guard at `:825-827`; Phase 2 adds
`getFieldValueDetail` elsewhere in the file), `relationship-tools.ts` (the
parent-direction guard at `:973-975`, alongside the children-direction
check Phase 1 already owned), and two one-line non-code edits
(`lock-release-on-failure.sh:78`, the plan-of-plans' stale block claims).

The choke-point pattern, corrected: `resolveState` (existing) →
auto-close / reverse-inference (existing, `:1430-1450`) → **transition
legality (new, Phase 1) → lock guard + release gate (existing, enriched
Phase 2)** → ISSUE mutation (`:1452+`) → project-field mutation (`:1585+`).
Both guards sit ahead of the issue mutation, not between the two mutation
blocks — that ordering is the split-brain fix and is the single most
important structural change in this iteration.

## Phase 1: GH-1615 — Transition legality server-side (`save_issue`, `advance_issue`, `batch_update`) + drift repair

- **depends_on**: null
  (Cross-plan coordination, not a blocker: #1611 merges `archive_items`
  into `batch-tools.ts` — whichever lands second rebases that one file.
  Evidence for de-serializing the board's `#1614 → #1615` edge is in
  Design Decisions.)

### Overview

Port `allowed_transitions` into `workflow-states.ts` (with the documented
added edges), enforce it after intent resolution at all three mutation choke
points, fix the `COMMAND_ALLOWED_STATES` drift, and repair the parity test
so drift cannot silently return.

### Changes Required

#### 1. Transition table + predicate

**File**: `mcp-server/src/lib/workflow-states.ts`
**Changes**: Add `ALLOWED_TRANSITIONS: Record<string, readonly string[]>` —
the JSON table (`ralph-state-machine.json:6-80`) plus the added edges from
Design Decisions, each addition commented with its consuming caller. Add:

- `isLegalTransition(current: string | undefined, target: string): boolean`
  — `true` when current is undefined/empty (new/stateless item), when
  `current === target` (idempotent), or when
  `ALLOWED_TRANSITIONS[current]` includes target. **The predicate stays
  pure and permissive on `undefined`; discriminating "genuinely unset" from
  "could not read" is the CALLER's job** (Phase 1 §4's three-outcome
  table). Keeping the fail-closed decision at the call site is what lets
  the predicate be unit-tested without API stubs.
- `legalNextStates(current: string): string[]` — for error text.
- `isLegalParentGateAdvance(current, gate)` — see §6.

#### 2. JSON kept in lockstep

**File**: `ralph/hooks/scripts/ralph-state-machine.json`
**Changes**: Add the same edges to `states.*.allowed_transitions` (release
edges, universal Human Needed/Done/Canceled targets where missing,
`Ready for Plan → In Progress`, `Research Needed → Backlog`,
`Plan in Review → Plan in Progress`). Add `"Plan in Progress"` to
`commands.ralph_review.valid_output_states`. (File ownership note: this
file is otherwise Phase 5 territory prose-wise; Phase 1 owns its DATA.)

#### 3. Drift fixes

**File**: `mcp-server/src/lib/state-resolution.ts`
**Changes**: `COMMAND_ALLOWED_STATES` — add
`ralph_pr_drain: ["In Progress", "Done", "Human Needed"]`; add `"Backlog"`
to `ralph_triage`; reconcile `ralph_hero` to the JSON's nine states (the
JSON is truth — hero is an orchestrator that performs repair moves and the
hook test `state-gate.test.sh:79` already allows `Done` for hero); add
`"Plan in Progress"` to `ralph_review` (NEEDS_ITERATION re-lock).

#### 4. Choke points

**File**: `mcp-server/src/tools/issue-tools.ts` (`save_issue`)

**Placement is load-bearing and was wrong in the first draft.** `save_issue`
mutates the GitHub ISSUE first — close / reopen / title / body / labels /
assignees at `:1452-1584` — and only reaches the project-field block at
`:1585+`. Putting the check "before the mutation batch" (i.e. before the
field block) means `save_issue(number: N, issueState: "OPEN", workflowState:
<illegal>)` reopens the issue on GitHub and THEN returns `toolError`: OPEN
on GitHub, stale on the board. Same shape for any `title`/`body`/`labels` +
illegal-state call.

**Changes**:

- **Hoist the project-context resolution.** Move `resolveFullConfig` /
  `ensureFieldCache` / `resolveProjectItemId` / `getProjectId` (today the
  head of the `:1585+` block) up to just after the reverse-inference block
  ends at `:1450`, guarded on `resolvedWorkflowState !== undefined`. This
  is what makes a pre-mutation current-state read possible at all. On
  `!hasProjectFields && !inferredFromClose` nothing is hoisted and the
  issue-only path is unchanged (zero new queries for a pure title/body
  edit).
- **Validate at `:1451`, ahead of the `// 3. Issue state mutations` block
  at `:1452`** — not ahead of `// 4. Project-field mutations` at `:1585`.
  Placing it here also means it sees `resolvedWorkflowState` after BOTH
  the auto-close path (`:1430-1435`) and the reverse-inference path
  (`:1442-1450`), which already run before `:1452` — so no re-ordering of
  the inference logic is needed.
- **Fail closed on fetch failure.** `getFieldValueDetail` (Phase 2; a
  `getCurrentFieldValue`-shaped read in Phase 1) must distinguish three
  outcomes, because today `getCurrentFieldValue` returns `undefined` for
  *any* reason — item not on the board, cache miss, transient API error —
  and `isLegalTransition(undefined, target)` is specified to PASS:

  | Outcome | Meaning | Behavior |
  |---|---|---|
  | field value present | live current state | validate normally |
  | query succeeded, no `Workflow State` value on the item | genuinely unset (new / just-added item) | PASS (the empty-current rule) |
  | query threw / item not resolvable | unknown | **`toolError`, zero mutations** |

  Without this split, Desired End State 2 is false on the primary path.
  Pinned by a stubbed-rejection test.
- **Reverse-inference terminal-source carve-out** (replaces the withdrawn
  "legal by construction" claim). When `inferredFromClose` is true the
  target is `Done` or `Canceled`. From a NON-terminal current state that is
  legal via universal edge (b). From a TERMINAL current state it is either
  same-state (`Done → Done` — legal, idempotent) or a cross-terminal
  RE-CLASSIFICATION (`Done → Canceled` via `issueState:
  "CLOSED_NOT_PLANNED"`, or `Canceled → Done`), which is **refused without
  `force`**. Because the check now runs at `:1451`, the refusal happens
  before `closeIssue` re-writes the state reason — the split-brain instance
  the critique found. Pin both directions with tests.
- With `force`, proceed and set `changes.forcedTransition = { from:
  current, to: target }` + debug-log event (`debug-logger.ts` pattern,
  gated on `RALPH_DEBUG`).

Refusal text (exact shape):

```
Illegal transition for #{n}: "{current}" → "{target}".
Legal next states from "{current}": {legalNextStates.join(", ")}.
Recovery: move through the pipeline via one of the legal states, or — for
human repair (e.g. reopening a closed issue) — retry with force=true; the
override is recorded in the response.
```

**File**: `mcp-server/src/tools/relationship-tools.ts` (`advance_issue`,
children direction)
**Changes**: Inside the per-issue loop (after the current-state fetch at
`:721-729`, alongside the existing forward-only check at `:741-751`):
illegal transitions go to the `errors[]` array with the same refusal text
(per-issue, batch continues). **The parent direction is NOT exempt** — the
first draft's "PARENT_GATE_STATES logic is itself a legality proof"
rationale is withdrawn as factually wrong (see Design Decisions and
inventory rows 28-29); it is handled in §6 below.

**File**: `mcp-server/src/tools/batch-tools.ts` (`batch_update`)
**Changes**: When any op has `field: "workflow_state"`: (a) up-front
`isValidState` check on the op VALUE (whole-batch refusal — a typo'd state
name is a caller bug, not a per-issue condition); (b) fetch current states
for all resolved issues via the existing `buildBatchFieldValueQuery`
machinery (today only used under `skipIfAtOrPast`, now unconditional for
workflow_state ops — one batched query, no per-issue roundtrips). **Do NOT
piggyback on the existing error handling**: the one existing consumer wraps
the query in `try { … } catch { /* proceed without filtering */ }`
(`batch-tools.ts:431-433`), which is fail-OPEN and would silently disable
the new check for the whole batch. The unconditional fetch gets its own
handler: query error → whole-batch `toolError`, zero mutations, pinned by a
stubbed-rejection test. (Fail-open is acceptable for an optional
`skipIfAtOrPast` optimization and not acceptable for a guard.); (c)
per-issue transition check — illegal transitions land in `result.errors`
with the refusal text and the issue is dropped from the mutation batch.
No `force` param exists on `batch_update` and none is added — bulk force
is exactly the disaster the guard exists to prevent; repair goes through
`save_issue(force: true)` one issue at a time.

#### 5. Parity test repair + refusal suites

**File**: `mcp-server/src/__tests__/state-resolution.test.ts`
**Changes**: Fix BOTH json paths (`:392`, `:422`) to
`../../../ralph/hooks/scripts/ralph-state-machine.json`; replace
`if (!fs.existsSync(jsonPath)) return;` with a hard failure (a missing
state machine must fail CI, not skip); make the command parity two-way
(every JSON command exists in `COMMAND_ALLOWED_STATES` with SET-EQUAL
states, and every TS command exists in the JSON); add
`ALLOWED_TRANSITIONS` ↔ JSON `allowed_transitions` set-equality.

**File**: `mcp-server/src/__tests__/workflow-transitions.test.ts` (new)
**Changes**: Pure-predicate matrix: every JSON edge legal; gate-skip
refusals (`Backlog → In Progress`, `Research Needed → In Review`,
`Ready for Plan → In Review`); release edges legal; NO
`In Progress → Ready for Plan` release edge; universal terminal/escalation
edges from every non-terminal state; `Done → *` and `Canceled → *` illegal;
same-state legal; undefined/empty current legal.

**Files**: `mcp-server/src/__tests__/save-issue.test.ts`,
`advance-issue.test.ts`, `batch-tools.test.ts`
**Changes**: Refusal-path cases per tool: illegal transition refused with
error naming legal next states; `force` succeeds + response carries
`forcedTransition`; command + transition BOTH validated when `command`
passed; command-less path still transition-validated; `advance_issue`
per-issue errors; `batch_update` per-issue errors + whole-batch invalid
state name refusal; existing happy paths updated where they now need a
stubbed current-state fetch. Port the allow/block matrix from
`state-gate.test.sh` (~25 cases) as the spec baseline (deleted in Phase 5).

#### 6. Parent-gate writers + `create_issue` (new in iteration 1)

**File**: `mcp-server/src/lib/workflow-states.ts`
**Changes**: Add `isLegalParentGateAdvance(current: string | undefined,
gate: string): { ok: true } | { ok: false; reason: string }`. The parent
gate legitimately performs a MULTI-HOP forward jump — a parent at `Backlog`
whose children all reach `In Review` should advance — so validating it
against `isLegalTransition` verbatim is too strong. The children's own
(now-validated) transitions are the evidence for each skipped phase; that
is the documented carve-out, and it is a real argument, unlike the one it
replaces. Refuse when:

| Condition | Reason string | Why |
|---|---|---|
| `current` is unresolvable (fetch failed) | `parent state unresolvable` | fail closed; today `stateIndex("")` is `-1` and advances |
| `current === "Human Needed"` | `parent is escalated` | `stateIndex` returns `-1`, so today this ALWAYS advances and silently overwrites an escalation |
| `current` ∈ `TERMINAL_STATES` | `parent is terminal` | `-1` again; a Done parent must not be re-opened by a gate check |
| `current` ∈ `LOCK_STATES` and `current !== gate` | `parent is locked by an active claim` | a parent at `Plan in Progress` is currently being worked; `stateIndex(4) < stateIndex(In Review)` so today it is overwritten with no lock-guard consultation |
| `gate` ∉ `PARENT_GATE_STATES` | `not a gate state` | only gate states may be reached this way |
| `stateIndex(gate) <= stateIndex(current)` | `already at or past` | the existing behavior, kept |

**File**: `mcp-server/src/lib/helpers.ts` (`autoAdvanceParent`)
**Changes**: Replace the `stateIndex(parentState || "") >=
stateIndex(gateState)` guard at `:825-827` with
`isLegalParentGateAdvance`. Keep the function best-effort — it must never
throw and never fail the primary `save_issue` (`:1743`) or
`create_sub_issues` (`tree-tools.ts:715`) call. On refusal return
`{ advanced: false, parentNumber, skippedReason: <reason> }` and emit a
debug-log event, so the skip is observable instead of silent. (File
ownership note: `helpers.ts` is otherwise Phase 2's file — Phase 1 owns
this one guard; Phase 2's `getFieldValueDetail` addition is disjoint.)

**File**: `mcp-server/src/tools/relationship-tools.ts`
(`advance_issue direction='parent'`)
**Changes**: Same predicate at `:973-975`. Because this is an explicit tool
call rather than a side effect, a refusal returns
`toolSuccess({ advanced: false, reason: <reason>, parent: {...} })` naming
the refused transition — consistent with the existing
`"Parent already at or past target state"` shape.

**File**: `mcp-server/src/tools/issue-tools.ts` (`create_issue`)
**Changes**: `effectiveState = args.workflowState ?? "Backlog"` (`:1089`)
goes straight to `updateProjectItemField` (`:1283`) with no validity check —
this is the sixth Workflow State writer and had none. Add an up-front
`isValidState(effectiveState)` refusal naming `VALID_STATES`, before the
issue is created. No transition check: the issue was created milliseconds
earlier, so the current state is empty by construction.

**File**: `ralph/hooks/scripts/lock-release-on-failure.sh`
**Changes**: One line — the emitted release instruction at `:78` gains
`force=true`, so the crashed-agent self-release stays viable during the
phases 1-4 rollout window under Phase 2's release gate (a fresh crash means
`heldSince` is recent, so staleness cannot carry it). The file is deleted
in Phase 5; this keeps the window regression-free.

#### 7. Plan-of-plans alignment (new in iteration 1)

**File**: `thoughts/shared/plans/2026-07-26-GH-1592-plan-of-plans.md`
**Changes**: Amend the three "board-blocked on #1614" claims (`:38`, `:53`,
`:117-121`) to match this plan's `depends_on: null` and its evidence, so an
orchestrator reading the plan-of-plans does not disagree with the plan it
governs. **No `remove_dependency` call is needed** — verified during
iteration: `get_issue(1615)` returns `blockedBy: []` and `get_issue(1614)`
returns `blocking: []`, so the board edge the critique asked to remove does
not exist. The stale claim is prose-only.

### Regression inventory — every caller affected by transition validation

#### Derivation method (read this before auditing a row)

**Rebuilt in iteration 1 on the reachable-FROM-set method.** The first pass
enumerated each caller's *happy-path* FROM state — the state the issue is in
when the flow runs as designed. That method is what made the table
non-exhaustive, and a spot-fix of the misses would have left more. The
method now is:

1. For each caller, find the **selection step** that put the issue in front
   of it, and quote its state filter.
2. Ask what happens when that filter is **bypassed**. Most ralph queue-picks
   are `ARG=#NNN → get_issue; else list_issues(profile: …, workflowState: X)`
   — the state filter lives ONLY on the queue-pick arm, so passing `#NNN`
   explicitly (a human running the skill directly, or an orchestrator
   re-dispatching) reaches the same write with **no state check**. Those
   callers' reachable FROM set is *every* state.
3. Ask what happens on **re-entry** — resumption, retry, a racing GitHub
   Action, a prior partial run. (This is what makes `merge-gate.md:161` a
   `Done →` write and `pr-drain.md:161`'s reuse arm an any-state write.)
4. Check **every** state in that set against `ALLOWED_TRANSITIONS`, not just
   the designed one.

Callers with NO state precondition anywhere in their prose — reachable FROM
set is literally every state, so they are audited against the full column:
`sre-fixit.md:62`, `plan/SKILL.md:147`, `plan/SKILL.md:171`,
`plan/SKILL.md:199`, `impl/SKILL.md:131`, `hero-fable/SKILL.md:43`,
`hero-fable/SKILL.md:52`, `pr-drain.md:161` (reuse arm), `split.md:187`
(REUSED-children arm).

Callers whose precondition holds only on the queue-pick arm and evaporates
under an explicit `#NNN`: `research/SKILL.md:177`, `plan/SKILL.md:156`,
`impl/SKILL.md:196`, `review/SKILL.md:123`, `review/SKILL.md:133`.
(`impl/SKILL.md:170` is the exception that proves the rule — it carries an
explicit "STOP if any issue is not In Progress" guard on the call line
itself, so its set stays bounded.)

Two call-site facts worth pinning, because the first pass got them wrong:
the repo contains exactly **one** `advance_issue` call site
(`split.md:193`, `direction: "parent"`) and exactly **one** `batch_update`
workflow-state call site (`split.md:187-190`). Every other mention of
either tool is an `allowed-tools` roster entry or a spec table.

#### The table

The mitigation column is what Phase 1 (or a named later phase) does about
each. GitHub workflows are listed for completeness: they do NOT call the
MCP server and cannot regress; they are trusted writers whose transitions
(e.g. `sync-issue-state.yml` writing Done from ANY state) are consistent
with the universal terminal edges.

| # | Caller (file:line) | Transition(s) used | Legal after Phase 1? | Mitigation |
|---|---|---|---|---|
| 1 | `hero-fable/SKILL.md:43` claim (command-less) | any → In Progress | Backlog → In Progress ILLEGAL | Legal two-step exists (Backlog → Ready for Plan → In Progress) or `force` with journal entry; prose updated in Phase 5 |
| 2 | `hero-fable/SKILL.md:49` surface | any → Human Needed | LEGAL (universal edge) | none needed |
| 3 | `hero/pr-drain.md:192` (command-less Done) | In Review → Done | LEGAL | ALSO fixed properly: `ralph_pr_drain` added to server map, prose may now pass `command` |
| 4 | `hero/pr-drain.md:198` (command-less) | any → Human Needed | LEGAL (universal edge) | none needed |
| 5 | `plan/SKILL.md:203` NEEDS_ITERATION | Plan in Review → Plan in Progress, `command: "review"` | broken TODAY; LEGAL after fix | edge + `ralph_review` allowlist entry added (Phase 1 §2-3) |
| 6 | `intake-routing.md:104` parent-plan reuse | Ready for Plan → In Progress | LEGAL (added edge c) | none needed |
| 7 | Group planning (this flow) | Ready for Plan → Plan in Progress → Plan in Review | LEGAL (JSON edges) | none needed |
| 8 | `caretake/modes/split.md` §6 (`create_sub_issues`) + §10 `batch_update` NET-NEW/deferred arm | new children (no current state); deferred children (state unset) → Ready for Plan / Research Needed / Backlog | LEGAL (empty-current rule) | none needed. The REUSED arm of the same `batch_update` is a different reachable set — split out as **row 23** |
| 9 | `ralph_split` `__COMPLETE__` → Backlog | Research Needed → Backlog | LEGAL (added edge d) | none needed |
| 10 | Triage verdicts (`command: "triage"`) | Backlog → Research Needed / Ready for Plan / Done / Canceled / Human Needed; Backlog re-assert | LEGAL (JSON + universal + same-state); Backlog re-assert broken TODAY server-side | `Backlog` added to `ralph_triage` (Phase 1 §3) |
| 11 | Unblock (`command: "unblock"`) | Human Needed → Backlog / Research Needed / Ready for Plan / In Progress | LEGAL (JSON `:61`) | none needed |
| 12 | Research bookends, `--mode auto` (`research/SKILL.md:177,183,186`) | Research Needed → Research in Progress → Ready for Plan / Human Needed; abort → Research Needed | forward path LEGAL; abort LEGAL via release edge (a) but now **gated** | release edge (a) requires stale `heldSince` OR `force` (Phase 2 §4b). Its only in-repo consumer is `lock-release-on-failure.sh:78`, whose emitted instruction Phase 1 amends to include `force=true` (that file is deleted in Phase 5). Explicit-`#NNN` entry bypasses the `analyst-research` queue filter → any-state `__LOCK__`: see **row 30** |
| 13 | Plan bookends, `--mode auto` (`plan/SKILL.md:156,159,162,165`) | Ready for Plan → Plan in Progress → Plan in Review / In Progress / Human Needed; abort → Ready for Plan | forward path LEGAL (incl. `Plan in Progress → In Progress` short-circuit, JSON edge); abort LEGAL via gated release edge (a) | as row 12. Group arm's `intake-routing.md:62-67` filter ("≥2 OPEN members currently in Ready for Plan") keeps the group set bounded; explicit-`#NNN` single arm does not — **row 30** |
| 14 | Impl / review / merge pipeline | Plan in Review → In Progress → In Review → Done; address In Review → In Progress | LEGAL (JSON edges) | none needed |
| 15 | Human reopen repair (`issueState: "OPEN"` + workflowState), CLI/manual | Done/Canceled → anything | ILLEGAL by design | refusal text names `force`; this IS the intended behavior for a human repair call. **Corrected in iteration 1:** this row previously also swallowed the autonomous `merge-gate.md:161-168` epic-gaps write, where "intended behavior" produces exactly the outcome that code exists to prevent — split out as **row 22** |
| 16 | Close-as-obsolete from any state (triage/hygiene/form dedup; reverse inference `issue-tools.ts:1442-1450`) | any non-terminal → Done/Canceled | LEGAL (universal edges b) | none needed |
| 17 | `advance_issue` — the repo's ONLY call site, `split.md:193` (`direction: "parent"`, parent gate re-fire after §Step 10) | parent at Backlog → the gate state the children reached | **Corrected in iteration 1:** the parent direction is NOT exempt (its "legality proof" was false) | now validated by `isLegalParentGateAdvance` (Phase 1 §6). `Backlog → Ready for Plan` is a legal forward gate jump; a parent at Human Needed / terminal / lock state is now SKIPPED with a named reason instead of silently overwritten. The first pass also mis-attributed watch-blockers to `advance_issue` — it uses `save_issue`, see **row 24** |
| 18 | mcp-server test fixtures stubbing `save_issue`/`advance_issue`/`batch_update` flows | various | n/a | updated in this phase's test files (the refusal classes ARE the AC) |
| 19 | Hooks & repo scripts (`scripts/routing/route.js`, `merge-pr.sh`) | raw GraphQL / gh CLI | n/a — not MCP callers | none; documented trusted writers |
| 20 | `.github/workflows/` (`sync-issue-state.yml`, `sync-project-state.yml`, `advance-parent.yml`, `route-issues.yml`, `sync-pr-merge.yml`) | raw GraphQL with `ROUTING_PAT` (e.g. Done from any state on issue close) | n/a — not MCP callers | none; their writes are consistent with universal terminal edges; documented in plan + evidence doc as the accepted structural limit |

**Rows 21–33 are new in iteration 1**, derived by the reachable-FROM-set
method above. Rows 21–24 and 27–28 are the critique's findings; rows 25,
26, 29–33 came out of the independent re-sweep and were not in the
critique.

| # | Caller (file:line) | Reachable FROM set (and why) | Illegal members after Phase 1 | Mitigation |
|---|---|---|---|---|
| 21 | `plan/SKILL.md:171` — `--mode epic` Step 1 lock (`__LOCK__` → Plan in Progress) | **every state**: `intake-routing.md:114` states no input-state precondition for `--mode epic`, and the mode has no selection/filter step — the epic arrives as an argument in whatever state it is in. **Live counterexample: epic #1588 is at `Backlog` right now.** | Backlog, Research Needed, Research in Progress, In Progress, In Review, Done, Canceled (only `Ready for Plan → Plan in Progress` and the idempotent re-lock are legal) | **Prose, not a new edge** (settled — an edge would re-open the gate-skip). Phase 5 rewrites Step 1 to use the shared **Legal claim path** fragment: read current state → if not `Ready for Plan`/`Plan in Progress`, first `save_issue(workflowState: "Ready for Plan")` (command-less; legal from Backlog, Research Needed, Plan in Review, Human Needed) → then `__LOCK__`. From `In Progress`/`In Review`/terminal there is no legal path — STOP and tell the human, because planning an in-flight or closed epic is a real mistake, not a transition-table artifact |
| 22 | `review/merge-gate.md:161-168` — epic-gaps corrective override, autonomous | **Done (+ CLOSED)** is the designed case: the write targets a parent that `advance-parent.yml` may already have driven to Done, and `:168` documents a re-assert loop adding `issueState: "OPEN"` | `Done → Human Needed` (Done has no outbound edges). Command level PASSES (`ralph_merge` allows Human Needed) — only the transition level refuses | Phase 5 adds `force: true` to both the initial call and the re-assert, and adds `merge-gate.md` to Phase 5's Changes Required file list (it was absent; the `grep -rn 'issueState: "OPEN"' ralph/` sweep lived only in Migration Notes prose). `forcedTransition` in the response is the durable record the prose already asks for |
| 23 | `caretake/modes/split.md:178-191` §Step 10 — REUSED-children arm of the `batch_update` | **every state**: §Step 5 REUSED children are pre-existing issues under the parent, in whatever state they were already in | `Ready for Plan → Research Needed`, `Ready for Plan → Backlog` (`Ready for Plan` allows only Plan in Progress / Human Needed), plus `In Progress → Ready for Plan`, `Plan in Review → Backlog`, and every demotion out of a lock state | `batch_update` has NO `force` and none is added (settled). Refusals land per-issue in `errors[]`. Phase 5 adds the recovery instruction to `split.md` §Step 10 explicitly — "a demotion refused in `errors[]` is a real signal that the reused child is further along than the split assumes: leave it, or repair one issue at a time via `save_issue(force: true)` with a note on the child" — because row 8's mitigation was never written into the skill |
| 24 | `caretake/modes/watch-blockers.md:66-69` — advance after all blockers close | **Human Needed** (`:31`, the canonical `WAIT-issue=NNN` parking state) OR **Backlog** (`:32`, Gap-A forward-compat). Uses `save_issue(command: "ralph_triage")`, NOT `advance_issue` | target is **free-form**, read out of the `## Escalation` line's `Move to <state> once #NNN closes`. From Human Needed the legal set is {Backlog, Research Needed, Ready for Plan, In Progress}; from Backlog it is {Research Needed, Ready for Plan, Done, Canceled} — so e.g. `In Progress` is legal from one source and illegal from the other, and any other embedded target is illegal from both | Phase 5 bounds it: compute the target, intersect with the legal set for the item's ACTUAL current state, and fall back to the documented default `Ready for Plan` (legal from both sources) with a note in the `## Unblocked` comment when the embedded target was dropped. Also note `command: "ralph_triage"` does not allow `In Progress` at the command level either, so that target needs `command: "ralph_unblock"` |
| 25 | `plan/SKILL.md:147` — **default (interactive) flow** Step 6, `save_issue(workflowState: "Plan in Review", command: "plan")` | **every state**: the default flow has NO `__LOCK__` step at all (Steps 1-5 are intake → discovery → structure → write → picker) and Step 1 resolves `ARG` from issue / research-doc / plan-path / free-form | `Ready for Plan → Plan in Review` — **the single most common case**, since `Ready for Plan` is exactly where a human-planned issue sits. Also Backlog, Research Needed, In Progress, In Review, terminal | **New in iteration 1 — not in the critique, and it would have broken the primary human entry point (`/ralph:plan 1234`) on day one.** Phase 5 rewrites Step 6 to claim before it completes, via the same **Legal claim path** fragment as row 21: `__LOCK__` (legal from Ready for Plan) then `__COMPLETE__`. This also fixes a real modeling bug — the interactive flow was writing a plan without ever taking the lock, so two humans could plan the same issue |
| 26 | `impl/SKILL.md:131` — **default (interactive) mode** Step 3, "Transition the linked issue to In Progress (skip if already)" | **every state**: Step 1 (`:118`) resolves the plan by `#NNN` or `<plan-path>` and never checks issue state | Backlog, Research Needed, Research in Progress → In Progress. Legal: `Plan in Review → In Progress` (JSON), `Ready for Plan → In Progress` (added edge c), `In Review → In Progress` (JSON), same-state | **New in iteration 1.** Phase 5 adds the precondition sentence: implementing from Backlog / Research Needed is a pipeline skip and should STOP with the refusal text, not be routed around. The "(skip if already)" clause already handles the idempotent case |
| 27 | `review/merge-gate.md:120` + `review/SKILL.md:134` — cross-repo `dependency-flow` sibling advancement | unknown — the sibling's state is in another repo/project and is not read before the write | **cannot be checked**: the target state is not enumerated in the prose, in `.ralph-repos.yml`'s schema, or in `repo-registry.ts` | Bounded rather than fixed: Phase 5 adds one sentence requiring the flow to name an explicit target state and to `get_issue` the sibling first. Recorded honestly — this row is the one caller the plan cannot prove legal, and the evidence doc says so |
| 28 | `autoAdvanceParent` (`helpers.ts:830`) — server-side, fired from `save_issue:1743` and `create_sub_issues` (`tree-tools.ts:715`) | **every state** the parent can be in. Guard is only `stateIndex(parent) >= stateIndex(gate) → skip` (`:825-827`), and `stateIndex` is `STATE_ORDER.indexOf` (`workflow-states.ts:84-86`) → `-1` for Human Needed / Canceled / unset, so `-1 >= n` is false and it always advances | `Backlog → In Review` (four-gate skip), `Research Needed → Plan in Review`, `Human Needed → *` (silently overwriting an escalation), and writes straight over a parent in a live lock state | Phase 1 §6: `isLegalParentGateAdvance`. Stays best-effort (never throws, never fails the primary `save_issue`) but now SKIPS with a reason instead of writing |
| 29 | `advance_issue direction='parent'` (`relationship-tools.ts:999`) — server-side | as row 28: identical guard at `:973-975` | as row 28 | Phase 1 §6, same predicate. Unlike row 28 this is an explicit tool call, so a skip returns `toolSuccess({advanced: false, reason})` naming the refused transition rather than staying silent |
| 30 | Explicit-`#NNN` entry into any queue-drainer (`research/SKILL.md:177`, `plan/SKILL.md:156`, `impl/SKILL.md:196`, `review/SKILL.md:123`, `review/SKILL.md:133`) | **every state** — the `workflowState` filter lives only on the `list_issues` queue-pick arm; `ARG=#NNN → get_issue` skips it entirely | the `__LOCK__` cases (research, plan) are the sharp ones: locking from Backlog / In Review / terminal. The `__COMPLETE__` / `__CLOSE__` / `__ESCALATE__` cases are mostly covered by universal edges | This is the class, not a one-off, so the fix is the refusal itself: a server `toolError` naming the legal next states is a BETTER outcome than today's silent gate-skip, and the agent can act on it. No prose change beyond rows 21/25/26, which are the three cases where the flow would otherwise dead-end |
| 31 | `impl/worktree-setup.md:162`, `impl/phase-execution.md:62` — `save_issue(workflowState="__ESCALATE__")` with **no `command`** | In Progress (post-lock) | Transition is LEGAL (universal edge to Human Needed) — but these calls are **rejected TODAY**, before this plan: without `command`, `save_issue` takes the `isValidState(args.workflowState)` branch (`issue-tools.ts:1403-1408`) and `"__ESCALATE__"` is not a valid state name | Pre-existing bug, folded into Phase 5's sweep: add `command: "ralph_impl"` at both sites. Worth fixing here because the zero-hook evidence claims escalation works server-side |
| 32 | `hero-fable/SKILL.md:40` and `pr-drain.md:161` — `create_issue(workflowState: "In Progress" / …)` | net-new issue: current state empty by construction | none — vacuous. BUT `pr-drain.md:161`'s **reuse arm** ("if match, set `SYNTH_NUMBER` and advance to In Progress") is a `save_issue` against an existing OPEN synth issue in whatever state a prior drain left it — `Human Needed → In Progress` is legal (JSON), `In Review → In Progress` is legal, `Done → In Progress` is not | `create_issue` gains an up-front `isValidState` check only (Phase 1 §6) — it is the sixth writer and had none. The pr-drain reuse arm is covered by the refusal text; an OPEN issue is not normally Done, so this is a narrow tail |
| 33 | `agents/sre-fixit.md:62` — `save_issue(workflowState: "Human Needed")` on the originating issue | **every state**: the Watcher-team dispatch names no state constraint | terminal sources only (`Done`/`Canceled` → Human Needed) | LEGAL from every non-terminal state via universal edge (b). No change needed; listed so the row exists rather than being discovered later |

### Success Criteria

#### Automated Verification

- [ ] `cd mcp-server && npm run build` exits 0
- [ ] `cd mcp-server && npx vitest run src/__tests__/workflow-transitions.test.ts` passes (full predicate matrix)
- [ ] `cd mcp-server && npx vitest run src/__tests__/state-resolution.test.ts` passes — and temporarily renaming `ralph/hooks/scripts/ralph-state-machine.json` makes it FAIL (no more silent skip)
- [ ] `cd mcp-server && npx vitest run src/__tests__/save-issue.test.ts src/__tests__/advance-issue.test.ts src/__tests__/batch-tools.test.ts` passes with the new refusal cases
- [ ] **Placement test**: `save_issue` with an illegal transition PLUS `issueState: "OPEN"` PLUS `title` issues ZERO mutations of any kind (assert the GraphQL stub recorded no `reopenIssue`/`updateIssue`/`updateProjectV2ItemFieldValue` call) and returns the refusal
- [ ] **Terminal-source test**: `save_issue(issueState: "CLOSED_NOT_PLANNED")` on a `Done` issue refuses without `force` and does NOT call `closeIssue`; succeeds with `force` and reports `forcedTransition`; `Done → Done` re-close still passes
- [ ] **Fail-closed fetch tests**: `save_issue` current-state read rejects → `toolError`, zero mutations; item present with no Workflow State value → PASSES; `batch_update` field-value query rejects → whole-batch `toolError`, zero mutations
- [ ] `cd mcp-server && npx vitest run src/__tests__/helpers.test.ts src/__tests__/relationship-tools.test.ts` — `isLegalParentGateAdvance` matrix: parent at Human Needed / Done / Canceled / a lock state / unresolvable is NOT advanced (reason returned); `Backlog → Ready for Plan` and `Backlog → In Review` multi-hop gate jumps ARE advanced; `autoAdvanceParent` never throws on refusal
- [ ] `create_issue` with an unknown `workflowState` returns `toolError` and creates no issue
- [ ] `grep -n "force=true" ralph/hooks/scripts/lock-release-on-failure.sh` matches (release advice survives the Phase 2 gate during the rollout window)
- [ ] `grep -n "board-blocked on #1614" thoughts/shared/plans/2026-07-26-GH-1592-plan-of-plans.md` returns nothing
- [ ] `cd mcp-server && npm test` — no regressions in untouched suites

#### Manual Verification

- [ ] On the live board: `save_issue` on a sandbox Backlog issue with `workflowState: "In Review"` returns the refusal naming legal next states; with `force: true` it succeeds and the response shows `forcedTransition`
- [ ] `batch_update` with one illegal-transition member reports it in `errors[]` and still mutates the rest

## Phase 2: GH-1616 — Lock-guard side doors, holder identity, loud force

- **depends_on**: [phase-1]

### Overview

Close the three unguarded lock side doors, enrich refusals with who holds
the lock and since when (from the field value's `creator`/`updatedAt`), and
make `force` and same-state re-claims visible. (The guard itself is already
hard — settled re-scope; this phase says so in code comments too.)

### Changes Required

#### 1. Field-value detail fetch

**File**: `mcp-server/src/lib/helpers.ts`
**Changes**: Add `getFieldValueDetail(...): Promise<{ name?: string;
updatedAt?: string; creator?: string }>` — same query shape as
`getCurrentFieldValue` (`:341-`) with `updatedAt` and `creator { login }`
added to the `ProjectV2ItemFieldSingleSelectValue` fragment (both are on
`ProjectV2ItemFieldValueCommon`; verify against the live schema in the
first commit — research Open Question 4 — and fall back to omitting
`creator` gracefully if a fine-grained token cannot read it: the refusal
then says "held since T" without the login). Keep `getCurrentFieldValue`
delegating to it so existing callers are untouched.
Two calibration notes carried in from the critique's caveats, to be pinned
in the first commit rather than assumed: (i) `creator` on a field value is
"the actor associated with the value record" and it could not be
distinguished on a live sample whether GitHub returns the ORIGINAL or the
LAST setter — and since every local agent shares one token login, holder
identity carries little signal on this deployment either way. `heldSince`
is the load-bearing half; the refusal text must degrade gracefully to
"held since T" and must not over-claim. (ii) This function must ALSO return
a `fetchFailed` discriminator (see Phase 1 §4) — "no value" and "could not
read" are different answers and only the first may pass validation.

#### 2. Lock guard result enrichment

**File**: `mcp-server/src/lib/lock-guard.ts`
**Changes**: Keep `isLockConflict` (pure, existing 17 tests intact). Add
pure `describeLockConflict(current, target, holder?, heldSince?)` returning
the refusal string, so message shape is unit-tested without API stubs:

```
Issue #{n} is locked: "{current}" held by {@holder ?? "unknown"} since {heldSince} ({age}).
Another agent may be working on it. Recovery: wait for release; if the
claim is stale (see next_actions lock-stale directions), release it via
save_issue(workflowState: "{preLockQueueState}") — or override with
force=true (the override is recorded in the response).
```

#### 3. `save_issue` wiring

**File**: `mcp-server/src/tools/issue-tools.ts`
**Changes**: The hoisted current-state fetch from Phase 1 becomes
`getFieldValueDetail`. On conflict → enriched refusal. On `force` past a
lock conflict → `changes.forcedLockOverride = { previousState, holder,
heldSince }` + debug-log event. On same-state re-claim →
`changes.lockReclaim = { heldSince }` (no refusal — settled decision).

#### 4. Side doors

**File**: `mcp-server/src/tools/batch-tools.ts`
**Changes**: Piggyback on Phase 1's unconditional current-state fetch: a
`workflow_state` op whose value ∈ `LOCK_STATES` gets `isLockConflict`
applied per issue; conflicts land in `errors[]` with the enriched text.
(No `force` on batch — see Phase 1.)

**File**: `mcp-server/src/tools/relationship-tools.ts`
**Changes**: `advance_issue direction='children'` with a lock-state
`targetState` applies `isLockConflict` per issue (current state already
fetched in the loop); conflicts → `errors[]`.

**File**: `mcp-server/src/tools/tree-tools.ts`
**Changes**: none here — new children have no current state, so lock
conflict is vacuous by construction; `workflowState` validity moves up
front in Phase 4 (file ownership: `tree-tools.ts` belongs to Phase 4).

#### 4b. Close the lock-release takeover (new in iteration 1)

**Files**: `mcp-server/src/lib/lock-guard.ts`,
`mcp-server/src/tools/issue-tools.ts`

Phase 1's added release edges (a) open a two-call steal of a LIVE lock that
never touches `isLockConflict`, because that function short-circuits on
`if (!LOCK_STATES.includes(targetState)) return false;`
(`lock-guard.ts:37-39`): call 1 writes `Research in Progress → Research
Needed` (target is not a lock state → guard bypassed), call 2 writes
`→ Research in Progress` (current is no longer a lock state → guard
bypassed). No `force`, no marker, no trace. Phase 2's own refusal text and
Phase 3's reclaim instruction publish that exact recipe, gated only by the
prose "if the claim is stale".

Add pure `isGuardedLockRelease(current, target): boolean` — true iff
`current` ∈ `LOCK_STATES` AND `(current, target)` is one of the two
BACKWARD release edges this plan adds:

| Edge | Guarded |
|---|---|
| `Research in Progress → Research Needed` | yes |
| `Plan in Progress → Ready for Plan` | yes |
| `Research in Progress → Ready for Plan` (completion) | no |
| `Plan in Progress → Plan in Review` / `→ In Progress` (completion) | no |
| any lock state → `Human Needed` (escalation) | no |
| any lock state → `Done` / `Canceled` (terminal) | no |
| `In Progress → *` | no — there is no `In Progress` release edge |

The asymmetry is the whole point: a lock holder finishing, escalating, or
closing its OWN work must stay unconditional. Only the backward release —
the one move whose ONLY purpose is to make the issue claimable again — is
gated.

In `save_issue`, when `isGuardedLockRelease` is true, refuse unless
`args.force` OR `heldSince` is older than the lock-stale threshold
(`RALPH_LOCK_STALE_HOURS` ?? `LOCK_STALE_HOURS`, shared with Phase 3):

```
Issue #{n} is locked: "{current}" held since {heldSince} ({age}) — not yet
stale (threshold: {N}h). Releasing it to "{target}" would let another agent
claim it out from under the holder.
Recovery: wait for the holder to finish or escalate; if you ARE the holder
releasing after a failure, retry with force=true (the release is recorded
in the response).
```

On a permitted release (either branch) set
`changes.lockReleased = { previousState, heldSince, forced: <bool> }`, for
symmetry with `lockReclaim` / `forcedLockOverride`, plus a debug-log event.

**All three real consumers survive the gate**, which is why it can be this
strict: (1) `next_actions` lock-stale reclaim directions (Phase 3) fire only
for locks already past the threshold, so they take the stale branch;
(2) `lock-release-on-failure.sh:78` — the crashed-agent self-release, where
`heldSince` is by definition recent — takes the `force` branch via the
one-line amendment in Phase 1 §6, and the file is deleted in Phase 5
anyway; (3) human repair passes `force`. No skill prose in the repo
performs an ungated backward release: the independent caller sweep found
the release path only in that hook, never in `research/SKILL.md` or
`plan/SKILL.md` (their bookends are `__LOCK__` → `__COMPLETE__` /
`__ESCALATE__`, all unguarded completion or escalation exits).

Phase 2 §2's refusal text and Phase 3's reclaim instruction must both be
written to match — they may no longer present a bare two-call release as
the recovery.

#### 5. Tests

**Files**: `mcp-server/src/__tests__/lock-guard.test.ts` (describe-function
cases: holder present/absent, age rendering, pre-lock queue state per lock
state), `save-issue.test.ts` (enriched refusal, `forcedLockOverride`,
`lockReclaim` marker), `batch-tools.test.ts` + `advance-issue.test.ts`
(side-door conflicts land in `errors[]`), `helpers.test.ts`
(`getFieldValueDetail` parses name/updatedAt/creator; tolerates missing
creator).

### Success Criteria

#### Automated Verification

- [ ] `cd mcp-server && npx vitest run src/__tests__/lock-guard.test.ts src/__tests__/helpers.test.ts` passes (existing 17 lock cases untouched, new describe/detail cases green)
- [ ] `isGuardedLockRelease` matrix green: both backward release edges guarded; completion, escalation, terminal, and `In Progress` exits unguarded
- [ ] **Takeover test**: the two-call steal (`→ Research Needed` then `→ Research in Progress`) against a fresh lock is refused at call 1; the same sequence against a lock older than the threshold succeeds and reports `lockReleased`; with `force` on call 1 it succeeds and reports `lockReleased.forced: true`
- [ ] `getFieldValueDetail` returns a `fetchFailed` discriminator distinct from "no value present"
- [ ] `cd mcp-server && npx vitest run src/__tests__/save-issue.test.ts src/__tests__/batch-tools.test.ts src/__tests__/advance-issue.test.ts` passes
- [ ] `cd mcp-server && npm test` green

#### Manual Verification

- [ ] Live board: claim a sandbox issue into `Plan in Progress`, then attempt `save_issue(workflowState: "In Progress")` from a second call — refusal names holder login + claim time; `force: true` succeeds with `forcedLockOverride` in the response
- [ ] `batch_update` setting `In Progress` on an issue already in `Research in Progress` reports the conflict per-issue instead of silently mutating

## Phase 3: GH-1617 — Stale-lock clock fix + actionable reclamation via `next_actions`

- **depends_on**: [phase-2]

### Overview

Point staleness at the claim clock (Workflow State field value `updatedAt`),
keep the existing per-call threshold param, add an env default, and make
lock-stale directions carry concrete reclaim instructions that are LEGAL
under Phase 1's release edges. Candidate A from research § 5; no scheduled
workflow.

### Changes Required

#### 1. Claim clock plumb

**File**: `mcp-server/src/lib/dashboard-fetch.ts`
**Changes**: Add `updatedAt` to the `ProjectV2ItemFieldSingleSelectValue`
fragment in the items query (`:167` area); populate a new
`workflowStateUpdatedAt?: string` on the item alongside `updatedAt`
(`:100`). Content `updatedAt` stays for every other consumer.

**File**: `mcp-server/src/lib/directions.ts`
**Changes**: `DashboardItem` (or its local type) gains
`workflowStateUpdatedAt?`; `detectLockStale` (`:427-430`) uses
`item.workflowStateUpdatedAt ?? item.updatedAt` (fallback keeps old
behavior when the field is absent, e.g. stale fixtures). `signals` for
lock-stale directions gain `heldSince` so renderers can show claim age,
and the lock-stale rendering (`:868-873` area) appends the reclaim
instruction: for `Research in Progress` → release via
`save_issue(workflowState: "Research Needed")`; for `Plan in Progress` →
`"Ready for Plan"`; for `In Progress` → do NOT auto-suggest rollback
(no-rollback asymmetry) — suggest checkpoint/inspect-worktree or escalate
to Human Needed.

#### 2. Threshold configurability

**File**: `mcp-server/src/lib/thresholds.ts`
**Changes**: `LOCK_STALE_HOURS` default stays 24; document it.

**File**: `mcp-server/src/tools/directions-tools.ts`
**Changes**: The per-call `lockStaleHours` param ALREADY exists
(`:645-652`) — keep it (it is also what makes the Phase 5 evidence
demonstrable without waiting out a TTL). Add env default:
`RALPH_LOCK_STALE_HOURS` consulted between the param and the constant
(`args.lockStaleHours ?? env ?? DEFAULT_RANK_CONFIG.lockStaleHours`).

**Corrected in iteration 1 — the first draft specified dead code.** The
schema at `:649` carries `.default(24)`, so `args.lockStaleHours` is ALWAYS
defined by the time the handler runs and the `?? env` branch is
unreachable. **Drop `.default(24)` from the zod schema** (keep `.optional()`
and keep "default: 24" in the `.describe()` text so the tool contract still
documents it) and resolve precedence in the handler. Pinned by a test that
sets `RALPH_LOCK_STALE_HOURS` with no param and asserts the env value wins
over the constant.

Document in the param description and root `CLAUDE.md` env-var table
(Phase 5 owns the CLAUDE.md edit; note the cross-phase file ownership).

**Claim-clock calibration (carried from the critique's caveats).** A
same-VALUE re-write may not bump the field value's `updatedAt` — on a live
read of #1592, Status/Estimate/Priority still showed `updatedAt ==
createdAt` while the changed Workflow State showed a later `updatedAt`. If
an idempotent re-claim does NOT refresh the clock, a long legitimate resume
eventually reads as stale, and Phase 2 §4b's release gate would then let it
be released. Phase 3's first commit must determine this empirically (write
the same value twice against a sandbox item, re-read `updatedAt`). If it
does not refresh: Phase 2's same-state re-claim path must write the field
unconditionally (a real mutation, not a no-op) so `lockReclaim` genuinely
refreshes the claim clock. Record the finding in the evidence doc either
way.

#### 3. Tests

**Files**: `mcp-server/src/__tests__/dashboard-fetch.test.ts`
(`workflowStateUpdatedAt` parsed), `directions.test.ts` — the
no-false-positive matrix: (a) field claimed NOW but content `updatedAt` 3
days old → NOT stale (the false positive today); (b) field claimed 25h ago
while agent comments keep bumping content `updatedAt` → STALE (the false
negative today); (c) fallback when `workflowStateUpdatedAt` absent; (d)
threshold override via config; reclaim-instruction rendering per lock
state incl. the In Progress asymmetry. `directions-tools.test.ts`: env
default resolution order.

### Success Criteria

#### Automated Verification

- [ ] `cd mcp-server && npx vitest run src/__tests__/directions.test.ts src/__tests__/dashboard-fetch.test.ts src/__tests__/directions-tools.test.ts` passes
- [ ] `cd mcp-server && npm test` green

#### Manual Verification

- [ ] Live board with a sandbox issue freshly claimed into a lock state: `next_actions(lockStaleHours: <tiny>)` surfaces a `lock-stale` direction with the correct claim age and reclaim instruction; with the default threshold it does NOT surface (no false positive right after claim)

## Phase 4: GH-1618 — Tree contracts in `create_sub_issues` (parameterized ceiling, up-front sanity)

- **depends_on**: [phase-1]
  (Parallel-safe with Phases 2–3 — disjoint files: `tree-tools.ts` vs
  lock/directions modules.)

### Overview

Add the caller-parameterized child-estimate ceiling and complete the
up-front validation story (workflowState validity, `dependsOnIssues`
resolvability), and reverse the "policy gating lives in hooks" tool
description. Violations create ZERO issues.

### Changes Required

#### 1. Ceiling + up-front checks

**File**: `mcp-server/src/tools/tree-tools.ts`
**Changes**:

- New request param
  `maxChildEstimate: z.enum(["XS","S","M","L","XL"]).optional()` with a
  **resolved default of `"M"`** (resolved in the handler, NOT via
  `.default()` on the schema — the handler must be able to tell "caller
  armed it explicitly" from "fell back to the default", because the two
  differ on no-estimate handling; this is the same zod trap Phase 3 §2
  fixes). Every child's estimate must be ≤ ceiling in
  `["XS","S","M","L","XL"]` order. Whole-batch up-front `toolError` before
  stage 1 (nothing created).

  **Why a default at all** (revised in iteration 1, full rationale in
  Design Decisions): with no default, `plan --mode epic`
  (`plan/SKILL.md:174`) and `form` Step 6b (`form/SKILL.md:143`) — the two
  surfaces research § 6 named as having zero size gating today — stay
  ungated, and the fail-open class merely relocates from bash to markdown.
  `"M"` closes the L/XL hole everywhere at once while keeping the M feature
  child that epic decomposition emits by contract (`decomposition.md:62`,
  `estimate: <S|M>`) legal.

  **No-estimate handling splits on arming**: explicit `maxChildEstimate` →
  a child with no estimate is REFUSED (fail-closed on an armed contract);
  implicit default → the child is created and the response carries
  `unestimatedChildren: [<indices>]` (visible, not silent). This is what
  keeps the default from breaking repair callers that legitimately omit
  estimates. Exact texts:

  ```
  Child #{i} ("{title}") has estimate {E}, which exceeds maxChildEstimate={C}.
  No issues were created. Split this child further, or raise/omit
  maxChildEstimate if this is an epic-level decomposition (feature children
  may legitimately be M).
  ```

  ```
  Child #{i} ("{title}") has no estimate, but maxChildEstimate={C} is set —
  the ceiling cannot be verified. No issues were created. Add an estimate
  to every child (XS–{C}) and retry.
  ```

- Up-front `isValidState` check on every child `workflowState` (import from
  `workflow-states.js`); refusal names `VALID_STATES`. (Entry states that
  are lock states remain allowed — `SKIP_ENTRY_STATES` sets
  `In Progress` for plan children by design.)
- Up-front `dependsOnIssues` resolvability: one aliased query resolving all
  referenced issue numbers before stage 1; unknown numbers → whole-batch
  `toolError` naming them. (Range/self-edge/cycle checks at `:371-394`
  already fail closed — unchanged.)
- Description rewrite at `:56` and `:345-346`: drop "policy gating lives in
  hooks"; describe `maxChildEstimate`, its `"M"` default, and the up-front
  contract ("contract violations are rejected before any issue is
  created").

#### 2. Arm the contract in the split surface

**Files**: `ralph/skills/caretake/modes/split.md`,
`ralph/skills/plan/decomposition.md`, `ralph/skills/form/SKILL.md`,
`ralph/skills/form/issue-template.md`
**Changes**: split.md's `create_sub_issues` call (§Step 6, `:99`) gains
`maxChildEstimate: "S"` — the atomic-split contract (`split.md:100`: "every
child MUST be XS or S"), replacing `split-size-gate.sh`'s job. `form`'s
Step 6b call (`SKILL.md:143`) and the ticket-tree template
(`issue-template.md:78`) gain `maxChildEstimate: "S"`, matching their own
stated contract ("each entry gets `estimate: XS` (occasionally `S`)") —
this is the coverage hole research § 6 named, now closed at the surface
rather than only by the default. decomposition.md § Child creation gets one
sentence noting epic decomposition relies on the `"M"` default and may
raise the ceiling explicitly for a deliberately coarse decomposition.
(These are prose files also touched by Phase 5's hook-reference sweep —
ownership split: Phase 4 owns the tool-call lines, Phase 5 owns hook-name
references.)

#### 3. Tests

**File**: `mcp-server/src/__tests__/tree-tools.test.ts`
**Changes**: New rejection cases: ceiling violation (M child under `"S"`),
missing estimate under an EXPLICIT ceiling (refused), missing estimate
under the DEFAULT ceiling (created + `unestimatedChildren` reported),
default `"M"` → M children pass (the epic-decomposition counter-example
pinned as a test) but XL children are now REFUSED (the closed hole, pinned
as a test), explicit `maxChildEstimate: "XL"` → XL passes (the deliberate
coarse-decomposition escape hatch), invalid
`workflowState`, unresolvable `dependsOnIssues` number — each asserting
`toolError` AND zero mutation calls issued (up-front, not partial). Port
`split-size-gate.test.sh`'s batch matrix as the spec baseline (deleted in
Phase 5).

### Success Criteria

#### Automated Verification

- [ ] `cd mcp-server && npx vitest run src/__tests__/tree-tools.test.ts` passes
- [ ] `grep -n "policy gating lives in hooks" mcp-server/src/tools/tree-tools.ts` returns nothing
- [ ] `cd mcp-server && npm test` green

#### Manual Verification

- [ ] Live board: `create_sub_issues` with `maxChildEstimate: "S"` and one M child refuses up front; `get_issue` on the parent confirms zero children were created
- [ ] The same call WITHOUT the ceiling succeeds (epic-decomposition path intact)

## Phase 5: GH-1619 — Hook demotion, doc sweep, zero-hook hero-fable evidence

- **depends_on**: [phase-2, phase-3, phase-4, GH-1605]
  (GH-1605 rewrites the split-* hook story and owns
  `split-postcondition.sh`; whichever PR lands second rebases the
  `caretake/SKILL.md` frontmatter + split prose. Per research § Risks this
  is the only true cross-PR gate for this group.)

### Overview

Delete the four superseded hooks and their registrations, sweep the stale
documentation pointers (the real locations, not root CLAUDE.md — settled),
and produce the zero-hook lifecycle evidence.

### Changes Required

#### 1. Hook + registration removal

**Files**: delete `ralph/hooks/scripts/state-gate.sh`,
`ralph/hooks/scripts/split-size-gate.sh`,
`ralph/hooks/scripts/split-estimate-gate.sh`,
`ralph/hooks/scripts/lock-release-on-failure.sh`; delete
`ralph/hooks/scripts/__tests__/state-gate.test.sh` and
`__tests__/split-size-gate.test.sh` (their matrices were ported to vitest
in Phases 1 and 4 — verify the mapping in the PR description with a
case-by-case table).

**Files**: `ralph/skills/research/SKILL.md` (`:27`, `:42`),
`ralph/skills/impl/SKILL.md` (`:30`, `:53`), `ralph/skills/plan/SKILL.md`
(`:42`, `:74`), `ralph/skills/review/SKILL.md` (`:15`, `:32`),
`ralph/skills/caretake/SKILL.md` (`:19`, `:23`, `:32`, `:36`, `:50`),
`ralph/skills/hero/SKILL.md` (`:27`, `:29`, `:33`, `:46`)
**Changes**: remove the listed registrations. `unblock-state-gate.sh`
(`caretake/SKILL.md:38`) and `split-postcondition.sh`
(`caretake/SKILL.md:46`) stay (out of scope / #1605's remit).

#### 2. Prose + spec sweep

**Files and changes**:

- `ralph/skills/caretake/split-decomposition.md:100,124` — replace the
  `split-estimate-gate.sh` canonical-example prose and stale hook
  cross-references; the surviving canonical PostToolUse
  response-inspection example is `cursor-advance-catch-up.sh` (PostToolUse
  on `recent_activity` — already documented in root CLAUDE.md § Activity
  log). Point the size contract at `create_sub_issues(maxChildEstimate)`.
- `specs/skill-io-contracts.md:70` area — § Precondition Enforcement rows
  for split size/estimate now map to server enforcement
  (`create_sub_issues` ceiling; decomposition surface for the parent
  precondition), and the "canonical example" paragraph is rewritten.
- `ralph/skills/caretake/outcome-tokens.md:87` — `SPLIT SKIPPED
  already-atomic` re-worded (the estimate check is a skill-step decision +
  server contract, not `split-estimate-gate.sh`).
- `ralph/skills/plan/SKILL.md:52,66,137,151,189,203` and
  `ralph/skills/research/SKILL.md:173` — remove/reword state-gate.sh
  behavioral references (server refusals are now the gate). `:203` keeps
  its transition, which Phase 1 legalized.
- `ralph/skills/hero-fable/SKILL.md:40,43,52` — claim prose acknowledges the
  server transition guard: claim legally (two-step through Ready for Plan
  when starting pre-plan) or `force: true` with a decision-journal entry.
  `:52` ("`In Review` / `Done` per the repo's norms") is the loosest write
  surface in the repo — add one sentence that an illegal transition comes
  back as a tool error naming the legal next states, and that the journal
  entry is where a `force` gets justified.

**Inventory-driven prose fixes (new in iteration 1).** Each of these
corresponds to a numbered regression-inventory row and is the mitigation
that row names; without them the row is a live break, not a documented one:

- **Shared fragment — "Legal claim path"** (new file,
  `ralph/skills/shared/fragments/legal-claim-path.md`, included via `!cat`
  the way `link-formatting.md` already is): read the issue's current state;
  if it is already the lock state, proceed (idempotent re-claim); if it is
  the lock's entry state, `__LOCK__`; if it is an earlier queue state
  (`Backlog`, `Research Needed`, `Plan in Review`, `Human Needed`), first
  `save_issue(workflowState: "Ready for Plan")` command-less, then
  `__LOCK__`; if it is `In Progress` / `In Review` / terminal, STOP and
  report — there is no legal path and planning it is a real mistake.
  Consumed by rows 21 and 25.
- `ralph/skills/plan/SKILL.md:171` (`--mode epic` Step 1) — **row 21**. Use
  the Legal claim path fragment before `__LOCK__`. Live case: epic #1588 is
  at `Backlog`.
- `ralph/skills/plan/SKILL.md:147` (default flow Step 6) — **row 25**, and
  the one that would have broken the primary human entry point. The default
  flow never locks; Step 6 currently writes `Plan in Review` directly, which
  is illegal from `Ready for Plan` — the state a human-planned issue is
  normally in. Rewrite to claim then complete: Legal claim path → `__LOCK__`
  → `__COMPLETE__`.
- `ralph/skills/plan/intake-routing.md:114` — record that `--mode epic` now
  has an effective input precondition (reachable via the promote hop), so
  the "no state precondition" line is no longer accurate.
- `ralph/skills/impl/SKILL.md:131` (default mode Step 3) — **row 26**. Add
  the precondition: In Progress is reachable from `Plan in Review`,
  `Ready for Plan`, `In Review`, or already-In-Progress; from `Backlog` /
  `Research Needed` / `Research in Progress` the server refuses and that is
  correct — STOP and report the pipeline skip rather than routing around it.
- `ralph/skills/review/merge-gate.md:161-168` — **row 22**. Both the initial
  epic-gaps `save_issue(workflowState: "Human Needed", command:
  "ralph_merge")` and the documented re-assert (with `issueState: "OPEN"`)
  gain `force: true`, because the parent is `Done` by then and `Done` has no
  outbound edges. Note in the prose that `forcedTransition` in the response
  is the durable record. **`merge-gate.md` was absent from this file list in
  the first draft** — the `grep` for `issueState: "OPEN"` lived only in
  Migration Notes prose and would not have produced an edit.
- `ralph/skills/caretake/modes/split.md:178-191` (§Step 10) — **row 23**.
  Add the recovery instruction for REUSED-child demotions refused in
  `errors[]`: `batch_update` has no `force` by design, so a refusal means
  the reused child is further along than the split assumes — leave it, or
  repair one issue at a time via `save_issue(force: true)` with a note on
  the child. Also drop `:100`'s `split-size-gate.sh` reference (the hook is
  deleted) and point at `create_sub_issues(maxChildEstimate)`.
- `ralph/skills/caretake/modes/watch-blockers.md:66-69` — **row 24**. Bound
  the free-form advance target: intersect the state read from the
  `## Escalation` line with the legal set for the item's ACTUAL current
  state (`Human Needed` and `Backlog` have different legal sets), fall back
  to the documented default `Ready for Plan` when it does not fit, and say
  so in the `## Unblocked` comment. Also fix the command: `ralph_triage`
  does not allow `In Progress` at the command level — that target needs
  `command: "ralph_unblock"`. Drop the now-false "this mode's transitions
  are unguarded" sentence.
- `ralph/skills/impl/worktree-setup.md:162`,
  `ralph/skills/impl/phase-execution.md:62` — **row 31**, a PRE-EXISTING
  bug: `save_issue(workflowState="__ESCALATE__")` with no `command` is
  rejected today by `isValidState` (`issue-tools.ts:1403-1408`). Add
  `command: "ralph_impl"`. Folded in here because the zero-hook evidence
  claims escalation works server-side.
- `ralph/skills/review/merge-gate.md:120` + `ralph/skills/review/SKILL.md:134`
  — **row 27**, the one caller the plan cannot prove legal. Require the
  cross-repo `dependency-flow` to name an explicit target state and to
  `get_issue` the sibling before writing. If the registry schema cannot
  express it, the flow posts the unblock comment and does not write state.
- Root `CLAUDE.md` — Hook Patterns section: verify no dangling references
  (research confirms none for split-estimate); add `RALPH_LOCK_STALE_HOURS`
  to the env-var table (Phase 3 cross-ownership); update the lib-modules
  table if new files were added (transition predicate lives in existing
  `workflow-states.ts`, so likely no roster change — CI
  `check-doc-rosters.sh` is the arbiter).
- `ralph/CLAUDE.md` / hook counts anywhere they appear — sweep with
  `grep -rn "state-gate\|split-size-gate\|split-estimate-gate\|lock-release-on-failure" --include="*.md"`
  and fix every survivor.

#### 3. Zero-hook lifecycle evidence

**File**: `thoughts/shared/reviews/YYYY-MM-DD-GH-1619-zero-hook-lifecycle-evidence.md` — the actual run date at authoring time; the first draft's literal `2026-07-DD` was a placeholder, not a filename (new; committed on the PR branch; linked from a `## Zero-hook evidence` section in the PR body)

Vehicle: a `/ralph:hero-fable` session (its SKILL.md registers zero hooks)
against two disposable sandbox issues (created via `create_issue`, labeled
`test:zero-hook`, canceled afterward). The doc records, per invariant, the
exact tool call, the verbatim tool result, and which invariant it proves:

1. **Transition refusal (server, both classes)** — sandbox issue A at
   `Research Needed`: `save_issue(number: A, workflowState: "Done",
   command: "impl")` → `toolError` "not a valid output for ralph_impl"
   (command class); then command-less `save_issue(number: A,
   workflowState: "In Review")` → transition `toolError` naming the legal
   next states from Research Needed (transition class); then the legal
   `workflowState: "Research in Progress"` succeeds. Proof criterion: the
   refusal text is the SERVER's `toolError` payload, and the transcript
   contains no hook-block banner anywhere (grep the session transcript for
   `PreToolUse`/`blocked` — zero hits). **Be precise about what "zero hooks"
   means**: `ralph/hooks/hooks.json` registers two PLUGIN-level hooks that
   load regardless of which skill runs — `set-skill-env.sh` (SessionStart)
   and `cursor-advance-catch-up.sh` (PostToolUse on `recent_activity`).
   Neither gates state, but "the skill registers no hooks" is not by itself
   the argument; the doc must name those two and show why they are inert
   for this proof.
2. **Lock refusal + loud force** — issue A now `Research in Progress`:
   `save_issue(number: A, workflowState: "Plan in Progress")` → refusal
   naming holder + claim time; then `force: true` → success AND the
   response JSON shows `forcedLockOverride`. Both tool results pasted
   verbatim.
3. **Tree contract** — `create_sub_issues(parentNumber: B,
   maxChildEstimate: "S", children: [XL child, XS child])` → up-front
   `toolError`; follow with `get_issue(B)` showing `subIssuesSummary.total`
   unchanged (zero orphans — up-front, not partial, is the assertion).
4. **Stale lock** — not live-waitable; two-part proof: (a) link the
   Phase 3 vitest no-false-positive matrix (CI run URL via
   `gh run list --commit <sha>`); (b) live `next_actions(audience:
   "agent", lockStaleHours: <tiny>)` against issue A showing a
   `lock-stale` direction whose text carries the reclaim instruction —
   the per-call threshold param exists precisely so this is demonstrable.
5. **Parent-gate refusal** (new in iteration 1, so the evidence covers all
   six writers rather than three) — with sandbox issue B parked at
   `Human Needed` and its children driven to a gate state, show
   `advance_issue(direction: "parent", number: <child>)` returning
   `advanced: false` with the `parent is escalated` reason instead of
   silently overwriting the escalation, and show the same skip firing as a
   side effect of `save_issue` on the last child (the `autoAdvanceParent`
   path at `helpers.ts:830`). This is the invariant whose absence made the
   first draft's "proves each invariant server-side" claim overstated.
6. **Scope statement** — one paragraph noting the GitHub Actions writers
   remain out-of-band trusted writers (the proof covers MCP-mediated
   mutations, per the epic's structural limit), and naming row 27
   (cross-repo `dependency-flow`) as the one MCP-mediated caller whose
   target state the plan bounded rather than proved.

Cleanup: both sandbox issues → `save_issue(issueState:
"CLOSED_NOT_PLANNED")` (legal from any state via universal edges).

### Success Criteria

#### Automated Verification

- [ ] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` — all remaining hook tests pass
- [ ] `shellcheck -S error ralph/hooks/scripts/*.sh` — green
- [ ] `bash scripts/check-doc-rosters.sh` — green
- [ ] `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` — green after frontmatter edits
- [ ] `grep -rn "state-gate.sh\|split-size-gate\|split-estimate-gate\|lock-release-on-failure" ralph/ specs/ CLAUDE.md --include="*.md" --include="*.json"` returns only intentional historical references (thoughts/ archive excluded)
- [ ] `grep -rn '__ESCALATE__' ralph/skills/ | grep -v command` returns nothing (row 31 fixed — every `__ESCALATE__` carries a `command`)
- [ ] `grep -n 'force: true' ralph/skills/review/merge-gate.md` matches on both the epic-gaps write and the re-assert (row 22)
- [ ] `grep -rn 'legal-claim-path' ralph/skills/plan/SKILL.md` matches at both the `--mode epic` Step 1 and the default-flow Step 6 sites (rows 21, 25)
- [ ] `grep -rn 'maxChildEstimate' ralph/skills/` matches in `caretake/modes/split.md`, `form/SKILL.md`, `form/issue-template.md` (Phase 4 §2 arming)
- [ ] `ls thoughts/shared/reviews/*GH-1619-zero-hook-lifecycle-evidence.md` matches exactly one file whose name carries a real date (no `YYYY-MM-DD` / `2026-07-DD` literal)
- [ ] `cd mcp-server && npm test` — full suite green

#### Manual Verification

- [ ] The zero-hook evidence doc exists on the branch, each invariant section contains a verbatim refusal, and the PR body links it
- [ ] A normal railed-skill session (e.g. `/ralph:caretake --mode triage`) still functions with the hooks gone — the server refusals surface as tool errors the agent can act on, not as broken flows

## Testing Strategy

### Unit Tests

- `workflow-transitions.test.ts` — pure transition predicate matrix (Phase 1).
- `state-resolution.test.ts` — repaired, hard-failing, two-way parity (Phase 1).
- `lock-guard.test.ts` — existing 17 conflict cases untouched + message-shape cases (Phase 2).
- `directions.test.ts` / `dashboard-fetch.test.ts` — claim-clock matrix (Phase 3).
- `tree-tools.test.ts` — up-front contract rejections with zero-mutation assertions (Phase 4).

### Integration Tests

- Tool-level suites (`save-issue`, `advance-issue`, `batch-tools`) with
  stubbed GraphQL asserting refusal classes, per-issue error routing,
  loud-force markers, and that the current-state fetch happens once per
  `save_issue` call.
- The state-gate and split-size shell matrices are ported case-for-case
  before their `.test.sh` files are deleted (mapping table in the PR).

### Manual Testing Steps

Per-phase Manual Verification boxes above, all against sandbox issues
labeled `test:zero-hook` on the live board; the Phase 5 evidence run doubles
as the end-to-end manual pass.

## Performance Considerations

- `save_issue` with a `workflowState` now ALWAYS fetches current state
  (previously only for lock-state targets): +1 GraphQL query per
  state-writing call, hoisted so lock guard and transition check share it.
  Acceptable — state writes are low-frequency and the rate limiter
  (warn 100 / block 50) is nowhere near threatened.
- `batch_update` reuses its existing single batched field-value query for
  all members — no per-issue roundtrips added.
- `advance_issue` already fetched per-issue current state in its loop — no
  new queries.

## Migration Notes

- **Published-package consumers**: enforcement ships via `release.yml` as a
  new `ralph-hero-mcp-server` version pinned into `ralph/.mcp.json`. Old
  plugin versions with the hooks still registered remain compatible — the
  hooks and the server checks overlap harmlessly during the rollout window
  (hook allows → server validates; hook blocks → server never sees it).
- **Force semantics widen**: `force: true` now also bypasses transition
  legality (previously lock-only). Existing `force` callers were
  crash-recovery paths whose transitions become legal anyway (release
  edges); the widened bypass is strictly more permissive for them.
- **Reopen flows must add `force`**: any script/prose reopening
  Done/Canceled issues with a workflowState needs `force: true` — swept in
  Phase 5 (`grep -rn "issueState: \"OPEN\"" ralph/`). The one live
  in-repo instance is `review/merge-gate.md:168` (inventory row 22); it is
  now a named Phase 5 edit rather than something the grep was expected to
  find.
- **Cross-terminal re-classification now needs `force`**: closing an
  already-`Done` issue as `CLOSED_NOT_PLANNED` (reverse-inferring
  `Canceled`), or the reverse, is refused without `force`. Same-state
  re-close is unaffected. This is a deliberate narrowing of the reverse-
  inference path, which the first draft wrongly believed was "legal by
  construction".
- **Backward lock release now needs `force` or a stale claim** (Phase 2
  §4b): `Research in Progress → Research Needed` and
  `Plan in Progress → Ready for Plan`. Completion, escalation, and terminal
  exits from a lock state are unchanged and unconditional. The only in-repo
  consumer is `lock-release-on-failure.sh:78`, amended in Phase 1 §6 to
  emit `force=true` so the rollout window has no gap; the file is deleted
  in Phase 5.
- **Parent auto-advance can now decline.** `autoAdvanceParent` and
  `advance_issue direction='parent'` stop writing over parents that are
  escalated (`Human Needed`), terminal, or holding a live lock. Callers
  that assumed the parent always follows its children — chiefly
  `split.md:193` and `create_sub_issues` — get an explicit
  `advanced: false` + reason instead. This CHANGES observable behavior on
  the board: a parent parked at Human Needed will now stay there. That is
  the intent (the old behavior silently erased escalations), but it is a
  behavior change, not a pure hardening.
- **`create_sub_issues` now refuses L/XL children by default**
  (`maxChildEstimate` defaults to `"M"`). Any caller that legitimately
  wants coarse children must pass an explicit higher ceiling. The three
  in-repo surfaces are updated in Phase 4 §2; a downstream consumer
  creating L/XL children would break and gets a named refusal telling it
  which param to pass.
- **JSON edits land BEFORE hook deletion** (Phase 1 vs Phase 5): during
  phases 1–4 the still-registered `state-gate.sh` reads the updated JSON —
  its unions only widen (new edges/outputs), so no hook-block regressions
  mid-stack.
- **#1611 / #1605 coordination**: `batch-tools.ts` (#1611) and the split
  hook/prose story (#1605) — whichever PR lands second rebases; both are
  bounded, single-file-class conflicts.

## Iteration Log

### Iteration 1 — 2026-07-26, against `thoughts/shared/reviews/2026-07-26-GH-1592-critique.md` (NEEDS_ITERATION, Risk coverage FAIL)

Surgical iteration. Phase count, phase numbering, and phase→issue mapping
are unchanged (5 phases, #1615-#1619); no phase was added, removed, or
renumbered. Every claim below was re-verified against the working tree
during this iteration rather than taken from the critique.

**The method changed, not just the rows.** The critique's core finding was
methodological: the regression inventory enumerated each caller's
happy-path FROM state instead of its reachable FROM set, so a spot-fix of
the named misses would have left more. The inventory now carries an
explicit `#### Derivation method` section, and re-deriving on that method
produced **13 new rows (21-33)** — four from the critique, **nine the
critique did not find**, including one (row 25) that would have broken the
primary human entry point.

| Change | Where | Why |
|---|---|---|
| Derivation method stated + inventory re-derived | Regression inventory | The FAIL. Rows 21-33 added; rows 8, 12, 13, 15, 17 revised |
| Transition check moved ahead of ALL mutation | Phase 1 §4 | `save_issue` mutates the issue at `:1452-1584` and reaches the field block only at `:1585+`; checking at `:1585` reopens the issue and THEN refuses. Hoists project-context resolution to `:1451` |
| Reverse-inference "legal by construction" claim withdrawn | Phase 1 §4, Design Decisions | False for terminal SOURCE states: universal edges run FROM non-terminal states, so `Done → Canceled` re-classification closed the issue and then refused. Now force-only, with a Migration Note |
| Fail-closed fetch semantics on both paths | Phase 1 §4 | `getCurrentFieldValue` returns `undefined` for "unset" AND "fetch failed", and the empty-current rule PASSES; `batch-tools.ts:431-433` precedent is `catch { proceed }`. Three-outcome table + stubbed-rejection tests |
| Both parent writers brought under validation | Phase 1 §6 (new) | The exemption rationale ("PARENT_GATE_STATES logic is itself a legality proof") was false. `helpers.ts:825-827` and `relationship-tools.ts:973-975` guard only with `stateIndex(parent) >= stateIndex(gate)`, and `stateIndex` is `STATE_ORDER.indexOf` → `-1` for Human Needed / Canceled / unset. New `isLegalParentGateAdvance` with a documented forward-only gate-jump carve-out |
| `create_issue` added as the sixth writer | Phase 1 §6, Desired End State 1 | Independent find: `effectiveState` (`:1089`) reaches `updateProjectItemField` (`:1283`) with no validity check. Gets `isValidState` only — transition check is vacuous |
| Lock-release takeover closed | Phase 2 §4b (new) | The added release edges legalized a two-call steal that never trips `isLockConflict` (`lock-guard.ts:37-39` short-circuits when the target is not a lock state). New `isGuardedLockRelease` gates only the two BACKWARD edges on `heldSince`-or-`force`; completion / escalation / terminal exits stay unconditional |
| `lockStaleHours` zod `.default(24)` dropped | Phase 3 §2 | The specified `args ?? env ?? const` precedence was dead code — `.default(24)` at `directions-tools.ts:649` makes the param always defined |
| `maxChildEstimate` given a `"M"` default | Phase 4 §1, Design Decisions | With no default, `plan --mode epic` and `form` Step 6b stayed ungated — the exact hole research § 6 said moving the ceiling into the tool would close, relocated from bash to markdown. `"M"` closes L/XL everywhere while keeping legitimate M feature children (`decomposition.md:62`). Split and form arm `"S"` explicitly; no-estimate stays fail-closed only when armed explicitly |
| Inventory-driven prose fixes named as edits | Phase 5 §2 | Rows 21-27 and 31 each get a named file+line edit, plus a new shared `legal-claim-path.md` fragment. `merge-gate.md` was absent from the file list entirely |
| Parent-gate refusal added to the evidence doc | Phase 5 §3 | The "proves each invariant server-side" claim was overstated while two of six writers were unvalidated |
| Plan-of-plans prose amended | Phase 1 §7 (new) | Three "board-blocked on #1614" claims contradict `depends_on: null` |

**Findings rejected, with counter-evidence:**

1. **"Add `remove_dependency` on the `1614 → 1615` board edge" — CORRECTION
   (round 2 re-review): this rejection was WRONG, and it was wrong for a
   reason this plan itself already names.** The iteration-1 text below is
   preserved struck-through for the record; do not repeat its method.
   Round-2 re-verification read the edge via raw GraphQL (not `get_issue`):
   `issue(1615).blockedBy → [1614]` and `issue(1614).blocking → [1615]`,
   confirmed live. `get_issue(1615) → blockedBy: []` is the **known-broken
   legacy `trackedIssues` mapping** (`issue-tools.ts:998-1007`) that this
   very plan's research doc calls out by name and that What We're NOT
   Doing lists as a real bug deliberately left unfixed here — the
   iteration used a tool it had already declared unreliable for exactly
   this read as the evidence for a settled decision. Consequence: #1615
   was board-blocked on #1614 (itself open, blocked by #1610–#1613), so an
   autonomous queue-pick that respects `blockedBy` would skip #1615
   entirely. The de-serialization argument ON THE MERITS is still correct
   (#1614 is a CI doc-roster check with no semantic coupling to transition
   validation) — only the operationalization was missing. Fix, carried as
   a Phase 1 acceptance item: (a) remove the `1614 → 1615` dependency edge
   — **attempted during this implementation pass and blocked by the
   session's Bash permission classifier** on the mutating
   `removeBlockedBy` GraphQL call; neither the `ralph_hero__remove_dependency`
   MCP tool nor an approved raw-GraphQL mutation path was available to the
   implementer. **This edge removal remains outstanding** and must be
   completed (via `ralph_hero__remove_dependency(blockedNumber: 1615,
   blockingNumber: 1614)` or an approved `gh api graphql` mutation) before
   Phase 1 is treated as fully accepted; (b) this Iteration Log correction
   itself, done. The plan-of-plans' three prose claims are amended in
   Phase 1 §7 regardless of the edge-removal timing.
   ~~Rejected — the edge does not exist. `get_issue(1615)` returns
   `blockedBy: []` and `get_issue(1614)` returns `blocking: []`, read live
   during this iteration. The critique inherited the claim from research §
   Risks; whatever was true at research time is not true now.~~

2. **"Row 15's class is 'Reopen repair' and its mitigation is wrong"** —
   accepted for `merge-gate.md`, **rejected as a wholesale re-label of row
   15.** Row 15 was covering two different callers under one heading. The
   human CLI/manual reopen genuinely IS intended behavior and force-only is
   the right answer for it; only the autonomous epic-gaps write needed
   different treatment. Row 15 keeps its scope, narrowed to the human path,
   and row 22 carries the autonomous one.

3. **"Validate the parent writers against `isLegalTransition`"**
   (recommendation 5, first option). **Rejected in favor of a purpose-built
   predicate.** Verbatim `isLegalTransition` would refuse the legitimate
   multi-hop gate jump (`Backlog → In Review` when all children reach In
   Review), stranding parents permanently. The children's own validated
   transitions are the evidence for each skipped phase — that is a real
   legality argument, and it is what `isLegalParentGateAdvance` encodes.
   The critique's own fallback ("with a documented gate-jump carve-out if
   needed") anticipated this.

4. **"Make `maxChildEstimate` required"** (recommendation 10, second
   option). **Rejected.** A required param breaks every existing caller and
   every test fixture for no gain over a default that fails closed on the
   class that matters. `"M"` + explicit arming at the two tight surfaces
   covers the same ground without a breaking signature change.

5. **"Surface recommendations 1, 4, 5, 8, 10 as `#### Decision:` blocks"**
   (hold-or-advance note). **Rejected — each had a determinate answer in
   the source, so deferring would have been theater**: the mutation
   ordering at `issue-tools.ts:1452` vs `:1585`, `stateIndex`'s `-1`
   behavior at `workflow-states.ts:84-86`, the `isLockConflict`
   short-circuit at `lock-guard.ts:37-39`, and the estimate contracts
   already written into `decomposition.md:62`, `split.md:100`, and
   `form/issue-template.md:78`. All five are recorded as settled decisions
   with their options and rationale in Design Decisions instead.

**Findings accepted without change to the critique's framing:** the
`batch_update` fail-open precedent, the `save_issue` unset-vs-unreadable
conflation, the `lockStaleHours` dead branch, the lock-release takeover,
the four missed callers, the two unvalidated parent writers, the
`2026-07-DD` placeholder filename, the `advance_issue`-vs-`save_issue`
mis-attribution in row 17, the `__ESCALATE__`-without-`command`
pre-existing bug, and the plugin-level-hooks nuance in the zero-hook proof
criterion.

**Not re-litigated** (the critique verified these against source and this
iteration did not disturb them): the five GitHub workflows plus
`scripts/routing/route.js` and `sync-project-state.js` genuinely bypass the
MCP server; `merge-pr.sh` never writes Workflow State; the `isLockConflict`
refusal at `issue-tools.ts:1599-1614` is as described; the three side doors
are unguarded; `ProjectV2ItemFieldValueCommon.creator`/`updatedAt` are real
and track the state change; the drift list is exactly complete.

## References

- Research (authoritative): `thoughts/shared/research/2026-07-26-GH-1592-server-side-invariants-sweep.md`
- Plan-of-plans: `thoughts/shared/plans/2026-07-26-GH-1592-plan-of-plans.md`
- Epic: #1588; feature: #1592; members: #1615 #1616 #1617 #1618 #1619
- Lock-guard precedent: `thoughts/shared/plans/2026-03-21-group-GH-652-server-side-lock-guard.md`
- State machine JSON: `ralph/hooks/scripts/ralph-state-machine.json`
- Merge gate contract: root `CLAUDE.md` § CI/CD (GH-1589)
