---
date: 2026-05-30
status: draft
type: plan
tags: [hero, autopilot, next-actions, audience, regression-guard]
github_issue: 1479
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1479
primary_issue: 1479
estimate: S
---

# GH-1479 — Hero `--mode classify` must read the queue with `audience: "agent"`

## Prior Work

- builds_on:: [[2026-05-02-hello-composable-rewrite]] — the design intent: one deterministic ranker, two consumers (interactive=human, headless=agent), differentiated *only* by the `audience` param. The plan explicitly specified hero call `next_actions(limit=1, audience="agent")`.
- tensions:: #1159 removed the `pick_actionable_issue` alias (which internally routed to `audience="agent"`), landing the hero call site on the bare `next_actions({})` human default — a silent regression away from documented intent.
- prior art (board): #936 (epic — agent audience), #948, #942, #1154 (Backlog fallback), #1159 (alias removal that introduced the regression), #1470 (agent Backlog fallback excludes open-blocker items).

## Overview

The hero orchestrator's `--mode classify` step reads the work queue via `next_actions({})` with **no `audience` argument**, so it defaults to `audience: "human"`. Hero is the autonomous orchestrator (and `--mode classify` is the engine of `--mode auto`); it must pass `audience: "agent"`. As shipped it silently loses both behaviors the agent audience exists to provide:

1. **Estimate-size preference** — `audiencePenalty()` adds +20/+40/+60 to M/L/XL so autonomous loops favor XS/S. With human audience this is a no-op, so hero ranks an XL the same as an XS.
2. **Backlog/null-state triage fallback** — gated on `audience === "agent" && scored.length === 0`. It widens the candidate set to Backlog/null items so autopilot can drive triage when the actionable queue empties. With human audience it never fires, so hero emits `result: Queue empty.` and idles even while Backlog has untriaged items it should be routing to `caretake --mode triage`.

The fix is a one-token change at the autonomous call site plus a regression guard that asserts the call site (not just the tool) requests `audience: "agent"`.

## Current State Analysis

The deterministic ranker `rankDirections` in `mcp-server/src/lib/directions.ts` is fully audience-aware and thoroughly tested at the tool level. The gap is purely in the **skill call site** that invokes it.

### Key Discoveries

- **Only two `next_actions(` call sites exist in the entire `ralph/` plugin**, both in `ralph/skills/hero/SKILL.md`:
  - `ralph/skills/hero/SKILL.md:139` — **Default mode**, Step 1 "Detect phase": `pick from next_actions({}) via AskUserQuestion`. This feeds an **interactive** picker → `human` is correct here.
  - `ralph/skills/hero/SKILL.md:151` — **`--mode classify`**, Step 2: `Read next_actions({})`. This is the **autonomous/headless** path (no `AskUserQuestion`) and the engine of `--mode auto` → it must be `agent`. **This is the bug.**
- The sibling hero references `ralph/skills/hero/dispatch.md` and `ralph/skills/hero/watch-dispatch.md` contain **no** `next_actions(` call sites (verified) — nothing to change there; the issue's "audit siblings" item resolves to "no other call sites."
- `mcp-server/src/lib/directions.ts`:
  - `:221` — `DEFAULT_RANK_CONFIG.audience = "human"` (the default that bites the bare call).
  - `:325-330` — `audiencePenalty()`: `XS/S → 0`, `M → 20`, `L → 40`, `XL → 60`, `null → 30`; returns `0` for non-agent. Applied at `:504` (`score += estPenalty`); lower score wins.
  - `:846-873` — Backlog/null fallback, guard `config.audience === "agent" && scored.length === 0`; widens to `workflowState === "Backlog" || === null`, skipping open-blocker items, with `AGENT_BACKLOG_FALLBACK_PENALTY` so fallback items rank below any actionable item.
- **Tool-level coverage is already complete** — `mcp-server/src/__tests__/directions.test.ts` has `describe("audience param")`, `describe("audience=agent Backlog fallback")`, signal-shape tests, and `directions-tools.test.ts` exercises `audience: "agent"` through the full tool layer. The missing coverage is the **consumer/call site**, not the tool.
- **Regression-guard home**: skill-body content assertions live as bash tests in `ralph/hooks/scripts/__tests__/` (e.g. `caretake-watch-blockers.test.sh`, `triage-postcondition-palette.test.sh`), using `assert_file_contains` / `assert_file_count_ge` against the skill `.md` files. CI auto-discovers them: `.github/workflows/ci.yml:123` runs `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \)` — so a new `*.test.sh` there runs in CI with no wiring.

## Desired End State

1. `ralph/skills/hero/SKILL.md` `--mode classify` reads the queue via `next_actions({ audience: "agent" })`.
2. The default-mode picker call site (`:139`) keeps `next_actions({})` (human) **with an explicit inline note** documenting *why* it is human (it feeds an interactive `AskUserQuestion`).
3. The `--mode classify` call site carries an explicit inline note documenting *why* it is `agent` (autonomous; enables XS/S penalty + Backlog triage fallback).
4. A bash regression guard in `ralph/hooks/scripts/__tests__/` asserts the autonomous call site passes `audience: "agent"` and fails if it regresses to a bare `next_actions({})`.
5. `npm test` (mcp-server) and the hook-test suite both pass.

### Verification

- `grep -n 'next_actions' ralph/skills/hero/SKILL.md` shows the classify line as `next_actions({ audience: "agent" })` and the picker line as `next_actions({})` with a documented human rationale.
- `bash ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` exits 0.
- Reverting the SKILL.md edit makes that test exit 1 (guard actually guards).
- `cd mcp-server && npm test` stays green (no tool changes, so this is a no-regression check).

## What We're NOT Doing

- **No changes to `mcp-server/src/lib/directions.ts`** — the ranker is correct and fully tested; this is a call-site fix only.
- **Not changing the default-mode picker (`:139`) to `agent`** — it feeds an interactive human picker; flipping it would mis-rank for the human surface. We only document its intent.
- **Not adding a new MCP tool, flag, or env var.** No behavioral surface area beyond the audience token.
- **Not touching `--mode watch` / `--mode pr-drain`** — they have no `next_actions` call site.
- **Not reworking `caretake --mode triage` routing** — the Backlog fallback already surfaces Backlog items as directions; how the classify step routes a surfaced Backlog item is existing behavior (event-classes `Backlog → caretakers`), not in scope here.

## Implementation Approach

Two tightly-scoped phases with disjoint file ownership. Phase 1 is the core one-token fix plus per-call-site audience documentation in `ralph/skills/hero/SKILL.md`. Phase 2 adds a bash regression guard under `ralph/hooks/scripts/__tests__/` modeled on `caretake-watch-blockers.test.sh`. Phase 2 depends on Phase 1 because the guard asserts the post-fix content.

## Phase 1: Fix the autonomous call site + document audience per call site
depends_on: null

### Overview
Change the `--mode classify` queue read to request `audience: "agent"`, and add a one-line rationale at both `next_actions` call sites so each documents its intended audience.

### Changes Required

#### 1. Hero skill body
**File**: `ralph/skills/hero/SKILL.md`
**Changes**:
- In the `## --mode classify` section, Step 2 (currently `2. **Read `next_actions({})`.** Empty queue → …`): change the call to `next_actions({ audience: "agent" })` and append a short inline rationale, e.g. *"(autonomous path — `audience: "agent"` enables the XS/S estimate penalty and the Backlog/null-state triage fallback; see `directions.ts` audiencePenalty + the `scored.length === 0` fallback)."*
- In the `## Default mode` section, Step 1 (currently `… if none, pick from `next_actions({})` via `AskUserQuestion`. …`): keep `next_actions({})` but add a short inline rationale, e.g. *"(interactive picker — `audience: "human"` is intentional here because the result feeds an `AskUserQuestion` human picker, not the autonomous loop)."*
- Do **not** alter `dispatch.md` / `watch-dispatch.md` (verified: no `next_actions` call sites). Optionally add a one-line note in the classify section that the sibling-file audit found no other call sites, so a future reader doesn't re-audit.

### Success Criteria

#### Automated Verification
- [x] `grep -n 'next_actions({ audience: "agent" })' ralph/skills/hero/SKILL.md` returns the `--mode classify` line (exactly 1 hit).
- [x] `grep -c 'next_actions({})' ralph/skills/hero/SKILL.md` returns `1` (only the default-mode picker retains the bare call).
- [x] `grep -n 'next_actions' ralph/skills/hero/SKILL.md` shows both lines carry an inline audience rationale (the words `audience` / `human` / `agent` appear adjacent to each call).

#### Manual Verification
- [ ] Reading the `--mode classify` Step 2 and Default-mode Step 1, a reader can tell *why* each call site uses its audience without consulting the issue.

## Phase 2: Regression guard for the autonomous call site
depends_on: [phase-1]

### Overview
Add a bash test that asserts the `--mode classify` call site passes `audience: "agent"` and that the autonomous path is not a bare `next_actions({})`. Guards the consumer, complementing the existing tool-level coverage in `directions.test.ts`.

### Changes Required

#### 1. New hook test
**File**: `ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` (create)
**Changes**: Model on `caretake-watch-blockers.test.sh` — `#!/bin/bash`, `set -euo pipefail`, `PASS`/`FAIL` counters, `pass()`/`fail()`/`assert_file_contains()` helpers, `REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"`, `SKILL_FILE="${REPO_ROOT}/ralph/skills/hero/SKILL.md"`, and a `Results: N passed, M failed` summary that `exit 1`s on any failure. Assertions:
- The hero SKILL.md contains `next_actions({ audience: "agent" })` (autonomous call site present).
- A targeted check that the `--mode classify` section is the one carrying the agent audience — e.g. assert the line containing `audience: "agent"` co-occurs with the classify step (grep for the `next_actions({ audience: "agent" })` token; optionally `awk`/range-grep the `## --mode classify` … next-`## ` block to confirm the token lives inside it).
- A negative guard that the autonomous path is no longer the bare default: assert that `next_actions({})` does **not** appear inside the `## --mode classify` section (it may still appear once in the default-mode picker, so scope the negative assertion to the classify block, not the whole file).

### Success Criteria

#### Automated Verification
- [ ] `bash ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` exits 0 against the Phase-1 content.
- [ ] Temporarily reverting the Phase-1 edit (classify line back to `next_actions({})`) makes the test exit 1 (proves the guard guards). Restore afterward.
- [ ] The new test is picked up by the CI discovery glob: `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f` lists `hero-classify-audience.test.sh`.
- [ ] `bash -n ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` (syntax check) passes, and ShellCheck is clean (CI runs ShellCheck on `ralph/hooks`).

#### Manual Verification
- [ ] Test output names what it guards (autonomous classify call site uses `audience: "agent"`), readable by someone who never saw this issue.

## Testing Strategy

### Unit Tests
No new unit tests for `directions.ts` — tool behavior is already covered by `directions.test.ts` (`audience param`, `audience=agent Backlog fallback`, signal-shape) and `directions-tools.test.ts`. This plan deliberately does not duplicate that coverage.

### Integration Tests
The Phase-2 bash test is the integration-level guard: it asserts the orchestrator's consumer call site, closing the gap the issue identifies ("every phase's tests verified the tool, not hero's call site").

### Manual Testing Steps
1. `grep -n next_actions ralph/skills/hero/SKILL.md` — eyeball both call sites and their rationale notes.
2. `bash ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` — confirm green.
3. Revert the classify edit, re-run the test, confirm red, restore.
4. (Optional) Run `/ralph:hero --mode classify` when the actionable queue is empty but Backlog has unblocked items; confirm it surfaces a Backlog item instead of `result: Queue empty.`

## Migration Notes

No data migration, no schema change, no published-package change. This touches only `ralph/` plugin files (skill body + a new bash test), which version under `release-ralph.yml` (ralph plugin tag bump), not the mcp-server npm release. No `.mcp.json` pin change. Behavior change is limited to the autonomous orchestrator preferring XS/S and driving Backlog triage instead of idling — strictly the documented intent restored.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1479
- `ralph/skills/hero/SKILL.md:139` (default-mode picker, human), `:151` (`--mode classify`, must be agent)
- `mcp-server/src/lib/directions.ts:221` (human default), `:325-330` (audiencePenalty), `:504` (apply), `:846-873` (agent Backlog fallback)
- `mcp-server/src/__tests__/directions.test.ts` (tool-level coverage), `directions-tools.test.ts:435-471` (tool integration with audience)
- `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` (regression-guard template), `.github/workflows/ci.yml:112-127` (hook-test discovery)
- thoughts: `shared/research/2026-05-02-hello-composable-rewrite.md`, `shared/plans/2026-05-02-hello-composable-rewrite.md`
