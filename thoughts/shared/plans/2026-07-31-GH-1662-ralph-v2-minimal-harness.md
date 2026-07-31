---
date: 2026-07-31
status: draft
type: plan
tags: [ralph-v2, harness-rewrite, state-machine, board-cli]
github_issue: 1662
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1662
primary_issue: 1662
estimate: L
research_waived: human-approved — plan builds on the same-day design record (thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md), itself produced by an in-session ultracode research pass (6 parallel readers, 3-designer/3-judge panel, repo-verified red-team); no separate research doc adds signal
---

# ralph v2 — minimal harness rewrite (GH-1662)

## Prior Work

- builds_on:: [[2026-07-31-ralph-v2-minimal-harness]] (the design record — normative for this plan; all component specs live there)
- builds_on:: [[2026-07-25-ralph-4cs-surface-reduction]] (enforcement-inversion diagnosis), [[2026-07-27-GH-1588-relanding-simplification-pivot]] (review-convergence evidence: typed code converges, prose doesn't), [[2026-06-10-fable-native-ralph-artifact-contracts]] (hero-fable, the 64-line minimal-shape existence proof)
- tensions:: [[2026-05-22-ralph-slim-plugin-restructure]] — v2 abandons its 9-verb/hooks-own-enforcement architecture rather than iterating it (evidence: strong — the restructure's own friction log plus the CodeRabbit-era flag data)

## Overview

Replace the ~33,700-line harness (9,682 skill prose / 3,326 hook bash / 20,715 MCP-server TS) with ~2,355 lines: one typed `board.ts` CLI as the sole board mutation path, a 6-state machine, a two-lane `state-guard.yml` corrective wall, a cron-owned tick loop, two skills in the hero-fable shape, and four optional ultracode workflows. The design record `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md` is normative; this plan sequences it into four PR-sized phases and pins verification.

## Current State Analysis

The repo runs the slim 9-verb plugin backed by `ralph-hero-mcp-server` (npm, version-pinned via `ralph/.mcp.json`), 40 hook scripts, an 11-state Projects V2 machine (`ralph/hooks/scripts/ralph-state-machine.json` + `mcp-server/src/lib/workflow-states.ts`), five board-sync GitHub Actions, and a sentinel-string `/loop` protocol. Main is ruleset-protected; merges go through `scripts/merge-pr.sh` + `scripts/attest-pr.sh` + `validate-attestation.yml` (GH-1589) — that gate is kept verbatim.

### Key Discoveries

- Only 6 of 11 states carry information; phase is artifact-derivable. Locks reduce to holder + age in one field value (design §1; `workflow-states.ts` lock trio).
- Exactly one hook pattern held: the ~30-line funnel (`merge-review-decision-gate.sh` → `merge-pr.sh`). The other ~30 scripts are fail-open ceremony (transcript greps, agent-exported env self-attestation) — hooks-audit, design §Why.
- Enforcement that held was typed code at the sole mutation path (PR #1624 server-side invariants, `mcp-server/src/tools/issue-tools.ts:1475-1616`); the pure logic ports to ~250-400 CLI lines.
- **`projects_v2_item` is not an Actions trigger** — the repo's own dead `sync-project-state.yml` `repository_dispatch` listener proves it. Field-level enforcement must be a scheduled reconciler; issue/PR events cover the rest (red-team finding 1).
- `Closes #NNN` closes the issue but never moves the custom Workflow State field — every sync workflow header says so; state-guard's event lane must own the closed/merged→board mappings (red-team finding 2).
- Board writes from Actions require the classic `ROUTING_PAT` (GITHUB_TOKEN and fine-grained PATs cannot write a personal-account Projects V2 board), and this repo has lived both an expired automation PAT and silent push-event non-fire — doctor must check run conclusions and PAT validity, not just recency.
- The old autonomous surface selects work BY the phase states the collapse removes, and old skills keep producing them until deleted — so state collapse, new surface, and old-surface deletion must ride one PR (red-team finding 3).

## Desired End State

1. `board.ts` is the sole sanctioned board mutation path; every invariant in design §2 (live-state legality, claim `holder|iso8601` + TTL, no `--force` anywhere, scope check against `git remote`, mutation echo, read/write parity) is vitest-covered.
2. The live board runs the 6-state machine; the 5 old sync Actions are replaced by `state-guard.yml` (event lane + 15-min reconciler) + `validate-attestation.yml`.
3. The plugin surface is 2 skills + 1 agent + 4 optional workflows + 2 funnel hooks (~400 prose lines the model ever loads); no MCP server, no `.mcp.json`, no npm release treadmill.
4. Autonomy runs as `tick.sh` under launchd/cron — flock, worktree-per-job, sonnet driver, hard timeout, heartbeat — with zero sentinel parsing and zero in-session wakeup obligations.
5. `mcp-server/`, all 40 old hooks, 9 of 10 old skills, 15 of 16 agents, `ralph-state-machine.json`, `release.yml`, and the roster-consistency CI are deleted; `merge-pr.sh`/`attest-pr.sh`/ruleset unchanged.

### Verification

- Automated: vitest suite green (machine legality, lock/TTL, scope, ranker, parity); shellcheck + actionlint on the new scripts/workflows; `board doctor` exits 0 against the live board; CI green on every phase PR.
- Manual: one real XS issue driven end-to-end interactively after Phase 2; one day of supervised drain after Phase 3; board UI shows exactly 6 states; plugin reinstall from marketplace works after Phase 4.

## What We're NOT Doing

- Not touching `scripts/merge-pr.sh`, `scripts/attest-pr.sh`, `validate-attestation.yml`, or the main ruleset (the evidence gate stays as-is).
- Not touching `plugin/ralph-knowledge` (and its `release-knowledge.yml`), `plugin/ralph-playwright`, `plugin/ralph-demo`, or the `thoughts/` corpus.
- Not replacing Projects V2 with labels (loses board UI, single-select exclusivity, claim metadata, cross-repo boards — design §2).
- Not building any per-phase skills, phase states, sentinel vocabulary, dashboards, trends, hygiene tooling, or SRE tools in v2.
- Not migrating open issues' prose/labels beyond the state collapse mapping; stale `trigger:*`/`blocked:*` label semantics die with the old classifier.
- Not unpublishing `ralph-hero-mcp-server` from npm (deprecate only).

## Design Decisions & Open Ambiguities

- **Ticket substrate** — options: labels + gh CLI; Projects V2 + typed CLI; trimmed MCP server. **Decided: Projects V2 + typed CLI.** Board UI, native single-select exclusivity, claim metadata; the plumbing tax is paid once in one file (judge panel, 2-of-3 lenses).
- **Enforcement medium** — options: bash hook validators; typed CLI at the funnel + server-side wall; MCP tool boundary. **Decided: typed CLI + two-lane state-guard; hooks demoted to courtesy redirects.** Hooks fail open by construction in this harness; typed code is what review-converges and held historically.
- **Corrective wall transport** — options: `projects_v2_item` event trigger (does not exist); issue/PR events + scheduled reconciler. **Decided: event lane + 15-min reconciler**, with drift latency accepted and doctor watching run conclusions + PAT validity.
- **Choreography** — options: plan-first routing in the scheduler; driver-sequenced work. **Decided: driver-sequenced.** tick.sh always dispatches sonnet; frontier enters only as in-session bookend `Agent(model="fable")` dispatches on feature/epic units (model-freedom judge veto of scheduler-side routing).
- **Cutover shape** — options: incremental parallel-run; fused cutover PR with declared outage. **Decided: fused, outage declared** — the old surface selects work by states the collapse removes; parallel-run is the half-migration failure mode this repo has already lived twice.
- **Tracking** — options: epic + 4 children; one L issue; no issue. **Decided: one tracking issue (#1662)** — the phases are strictly sequential; child ceremony adds nothing (human-approved in planning session).
- **Loop transport** — options: hard-wire `claude -p`; transport-agnostic runner with billing guard. **Decided: transport-agnostic (`RALPH_TICK_RUNNER`, default `claude -p`), with tick.sh refusing to spawn under a stray `ANTHROPIC_API_KEY`** — headless `claude -p` under OAuth login draws on the Max subscription like any session, but a scheduler env can silently flip to API-key billing; the guard makes that loud, and interactive / bridge-routine drives stay first-class (human-raised in planning session).

None — no open design decisions.

## Implementation Approach

Four phases, 1:1 with PRs, strictly sequential (each merges through the existing gate; steps 1/3/4 revert independently; Phase 2 is the one-way door). All new code lands under `ralph/scripts/` and `ralph/skills/` in place — no parallel `ralph2/` dir. Component line budgets and exact behaviors are specified in design §§1-8; this plan does not restate them.

## Phase 1: board.ts + tests (PR 1)

depends_on: null

### Overview

Land the sole mutation path with its full test suite, read-only-verified against the live board. Old system untouched; no behavior change.

### Changes Required

#### 1. The CLI
**File**: `ralph/scripts/board.ts` (create, ~900 ln)
**Changes**: All subcommands and invariants per design §2: `get/list/next/tree`, `create/claim/release/move/cancel/reopen/link/dep/comment`, `parent-check`, `doctor [--fix]`, `setup`, `migrate`. Pure core with injected exec; transport = `gh api graphql`; option-ID/item-ID disk cache under `~/.ralph/cache/`. The 6-state `MACHINE` table, claim `{holder}|{iso8601}` + TTL (default 120 min, `RALPH_LOCK_TTL_MIN`), `--steal` with eviction comment, no `--force` flag anywhere, scope check against `git remote get-url origin` + checked-in config, mutation echo.

#### 2. Tests
**File**: `ralph/scripts/board.test.ts` (create, ~400 ln)
**Changes**: vitest over the pure core — transition legality (full 6-state table incl. cancel/reopen), lock/TTL math + steal, scope refusal, ranker ordering, parity ("get reads exactly the fields move/claim write" as a named invariant), cache staleness, migrate mapping (11→6 incl. the Plan-in-Review decision-block split).

#### 3. Build plumbing
**File**: root `package.json` + `tsconfig.json` (create, ~35 ln)
**Changes**: `"private": true`, vitest dev-dep only. No publish config.

#### 4. CI job
**File**: `.github/workflows/ci.yml` (modify)
**Changes**: add a `board-tests` job (bun/tsx + vitest run of `ralph/scripts/board.test.ts`). Full ci.yml rewrite waits for Phase 4.

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run ralph/scripts/board.test.ts` passes
- [ ] `bun ralph/scripts/board.ts --help` exits 0; `board.ts get 1662` returns issue + fields
- [ ] `bun ralph/scripts/board.ts doctor` exits 0 against the live board (read-only)
- [ ] CI green on the PR

#### Manual Verification
- [ ] `board.ts get` output spot-checked against `ralph_hero__get_issue` for 3 issues (number, state, estimate, parent/children, deps)
- [ ] Scope check refuses a mutation attempted from a non-matching clone

## Phase 2: the cutover (PR 2) — state collapse + new surface + old-surface deletion

depends_on: [phase-1]

### Overview

The fused one-way PR: collapse the live board 11→6, land state-guard + the new skill surface, delete the old one. **Autonomy is down from this merge until Phase 3 — declared.** Run one real XS issue end-to-end interactively before proceeding to Phase 3.

### Changes Required

#### 1. Board collapse
**Run**: `board.ts setup` (adds/renames Workflow State options to the 6-state set) then `board.ts migrate` once against the live board ({Research Needed, Ready for Plan}→Backlog · {R/P in Progress}→In Progress after stale check · Plan in Review→Human Needed if open `#### Decision:` blocks else Backlog). Delete the `migrate` subcommand in Phase 4.

#### 2. Corrective wall
**File**: `.github/workflows/state-guard.yml` (create, ~100 ln)
**Changes**: event lane (`issues: opened/closed/reopened`, `pull_request: closed`) + reconciler lane (`schedule: */15` running `board doctor --fix`), per design §3. Uses `ROUTING_PAT`. Every correction posts a comment.
**Files**: `.github/workflows/{route-issues,advance-parent,sync-issue-state,sync-pr-merge,sync-project-state}.yml` (delete — state-guard subsumes the first four; the fifth is already dead).

#### 3. New skill surface
**Files**: `ralph/skills/work/SKILL.md` (~140), `ralph/skills/board/SKILL.md` (~60), `ralph/agents/investigator.md` (~35), `.claude/workflows/{research-panel,plan-critique,tree-impl,adversarial-review}.md` (~165), `ralph/hooks/funnel-board.sh` (~40), `ralph/hooks/funnel-merge.sh` (~30, derived from merge-review-decision-gate.sh), `ralph/.claude-plugin/plugin.json` (rewrite: manifest-level hook registration) — all per design §§3,5,7 including the 8-rule artifact contract inline in work/SKILL.md.

#### 4. Old-surface deletion
**Files**: delete 10 old skill dirs under `ralph/skills/` (incl. hero-fable, absorbed into work; keep `using-html/` vendored utility), 16 old agent files, all 40 `ralph/hooks/scripts/*` + `__tests__` + `hooks.json`, `ralph-state-machine.json`.

### Success Criteria

#### Automated Verification
- [ ] `actionlint` + `shellcheck -S error` pass on state-guard.yml and both funnel hooks
- [ ] vitest still green; CI green (hook-test and roster jobs updated to the new file set in this PR)
- [ ] `grep -rl 'ralph_hero__\|RALPH_COMMAND\|outcome-tokens' ralph/` returns nothing
- [ ] state-guard fires on a test issue open/close and applies Backlog/Done (visible run + comment)

#### Manual Verification
- [ ] Board UI shows exactly 6 Workflow State options; migrated items land per the mapping (spot-check 10 incl. one held Plan-in-Review)
- [ ] One real XS issue driven end-to-end interactively via `/ralph:work` — claim → change → PR → attest → merge-pr.sh → Done
- [ ] Funnel hooks redirect a raw `gh project item-edit` and a bare `gh pr merge`

## Phase 3: the loop (PR 3)

depends_on: [phase-2]

### Overview

Structural continuation: the scheduler owns cadence; autonomy returns.

### Changes Required

#### 1. Tick + installer
**Files**: `ralph/scripts/tick.sh` (create, ~75 ln — flock, heartbeat, `board next --json` early-exit, worktree-per-job, spawn via `$RALPH_TICK_RUNNER` (default `claude -p --model sonnet`) with hard timeout, per-issue log, timeout→`board release`), `ralph/scripts/install-loop.sh` (create, ~40 ln, prints launchd plist / cron line; typed autopilot opt-in via machine-local config).
**Transport-agnostic + billing guard** (design §4): the tick's contract is only "invoke one work session"; interactive `/ralph:work` and bridge-env scheduled routines are equally valid drives. tick.sh refuses to spawn when `ANTHROPIC_API_KEY` is present in its environment unless `RALPH_ALLOW_API_BILLING=true` — prevents a launchd env with a stray key from silently billing API credits instead of the Max subscription. `board doctor` reports the last tick's auth mode.

#### 2. Watchdog
**File**: `.github/workflows/ci.yml` (modify)
**Changes**: weekly `board doctor` cron job checking state-guard run conclusions, PAT validity, heartbeat age.

### Success Criteria

#### Automated Verification
- [ ] `shellcheck -S error` passes on both scripts
- [ ] tick.sh with empty queue exits 0 without spawning claude; refuses when autopilot config unset
- [ ] tick.sh refuses to spawn with `ANTHROPIC_API_KEY` set and `RALPH_ALLOW_API_BILLING` unset; spawns under OAuth-only env
- [ ] Weekly doctor CI job runs green on workflow_dispatch

#### Manual Verification
- [ ] One day of supervised drain: ticks.log one line per tick, heartbeat fresh, per-issue logs written, no stranded claims (doctor clean), state-guard conclusions green
- [ ] A deliberately killed tick releases its claim via TTL within one reconciler cycle

## Phase 4: the deletion (PR 4)

depends_on: [phase-3]

### Overview

Remove the MCP server and its release treadmill; rewrite the repo's self-description.

### Changes Required

#### 1. Deletions
**Files**: `mcp-server/` (entire tree), `ralph/.mcp.json`, `.github/workflows/release.yml`, `scripts/check-doc-rosters.sh`, `scripts/check-tool-consumers.sh`, `scripts/__tests__/` entries for them; `board.ts migrate` subcommand.

#### 2. Rewrites
**Files**: `.github/workflows/ci.yml` (full rewrite: board-tests + shellcheck + actionlint + weekly doctor), root `CLAUDE.md` (~250 ln, v2 description), `ralph/CLAUDE.md` (trim to v2 conventions). `release-ralph.yml` kept (version-bump + tag only).

#### 3. Registry
**Run**: `npm deprecate ralph-hero-mcp-server "replaced by in-repo board.ts (ralph v2)"`.

### Success Criteria

#### Automated Verification
- [ ] CI green; `gh workflow list` shows exactly: ci, state-guard, validate-attestation, release-ralph, release-knowledge
- [ ] `grep -rl 'mcp-server\|ralph-hero-mcp-server' --exclude-dir=thoughts --exclude-dir=node_modules .` returns only historical docs
- [ ] Plugin version bumps via release-ralph.yml on merge

#### Manual Verification
- [ ] Fresh plugin install from the marketplace clone works; `/ralph:work` and `/ralph:board` load; no MCP server spawn attempt
- [ ] npm shows the deprecation notice

## Testing Strategy

- **Unit**: the Phase-1 vitest suite is the machine's contract — every invariant named in design §2 has a test; parity and migrate-mapping tests are named invariants.
- **Integration**: Phase-2's live XS issue and Phase-3's supervised drain are the integration tests, by design — no staging board.
- **Manual**: the unchecked Manual Verification boxes above are the human sign-off surface per phase.

## Migration Notes

- Phase branches: `feature/GH-1662-p1` … `-p4` off `origin/main`, one PR each through `merge-pr.sh`; this plan doc rides the Phase-1 PR.
- The Phase-2 board collapse is irreversible; misplacements are hand-fixed in the board UI (kept for exactly this reason). Announce the outage window in a comment on #1662 before merging Phase 2.
- `ROUTING_PAT` must be valid before Phase 2 (state-guard depends on it); check with the existing secret before the cutover merge.
- In-flight work at cutover: anything in a lock state gets the stale check during `migrate`; open PRs are unaffected (merge gate unchanged).

## References

- Design record (normative): `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`
- Tracking issue: https://github.com/cdubiel08/ralph-hero/issues/1662
- Evidence corpus: GH-1588 plan (review convergence), 4Cs idea (enforcement inversion), hero-fable design record (minimal shape), hooks/tool/prose audits summarized in the design's §Why
