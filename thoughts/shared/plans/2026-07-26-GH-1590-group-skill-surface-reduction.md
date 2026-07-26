---
date: 2026-07-26
status: draft
type: plan
tags: [surface-reduction, skills, hooks, caretake, hero, group-plan]
github_issues: [1603, 1604, 1605, 1606, 1607, 1608]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1603
  - https://github.com/cdubiel08/ralph-hero/issues/1604
  - https://github.com/cdubiel08/ralph-hero/issues/1605
  - https://github.com/cdubiel08/ralph-hero/issues/1606
  - https://github.com/cdubiel08/ralph-hero/issues/1607
  - https://github.com/cdubiel08/ralph-hero/issues/1608
primary_issue: 1603
estimate: S
research_doc: thoughts/shared/research/2026-07-26-GH-1590-skill-surface-reduction-sweep.md
---

# GH-1590 group plan — Skill surface reduction wave 2 (six siblings, one PR)

## Prior Work

- builds_on:: [[2026-07-26-GH-1590-skill-surface-reduction-sweep]] (research — authoritative reference sweep; corrects several issue-body claims)
- builds_on:: [[2026-07-26-GH-1590-plan-of-plans]] (plan-of-plans — sequencing corrected here, see § Design Decisions)
- builds_on:: [[2026-07-25-ralph-4cs-surface-reduction]] (idea — the condensed audit; its drifted claims are superseded by the research doc)
- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] (research — wave-1 design that created these mode surfaces)

## Overview

One group plan for the six children of #1590 (GH-1538: one plan, one worktree, one branch, one PR closing #1603–#1608). Wave 2 prunes the mode surfaces *inside* the 9 verbs: five dead/duplicate modes deleted, three watcher modes merged into one, three decomposition surfaces merged into one, `hero --mode classify` folded into `--mode auto`, the duplicated shared substrate single-sourced, `research --mode prove` folded into default research intake, and `triage-agent` deleted.

The research doc is authoritative over the issue bodies — five of six bodies contain drifted claims (research § Corrections). Every phase below edits **call sites, not just rosters**, and names the capability that survives each deletion.

**Merge path**: `main` is ruleset-protected (GH-1589) — everything lands via one PR through `scripts/attest-pr.sh` + `scripts/merge-pr.sh`. The research doc, the plan-of-plans, and THIS plan ride in the same PR branch as the code (they were committed on the bridge worktree branch and reach `main` only with the group PR).

## Current State Analysis

45 modes exist across the 9 verbs (counting rule below). The surfaces this plan touches:

- `caretake` has 14 modes (`ralph/skills/caretake/SKILL.md:90-105`), including three near-identical watchers (86/88/91 lines), a debug mode whose tool is unrostered and env-gated off, a postmortem mode whose data producer (team/worker sessions) no longer exists, and a trends mode that is two MCP calls.
- `hero --mode auto` is a `/loop` wrapper around `--mode classify` (`hero/SKILL.md:150-174`); the arming hook greps the literal `'--mode classify'` (`autopilot-director-postcheck.sh:56`).
- Three surfaces decompose work: `caretake --mode split`, `plan --mode epic`, `form` Step 6b — split exists explicitly to evade `plan-research-required.sh` (`split-decomposition.md:85`, `modes/split.md:140`).
- Two taxonomy files with a one-directional "keep both in sync" instruction (`label-routing.md:79`) have already diverged in 3 rows and ~19 row-existence asymmetries.
- `research --mode prove` is dispatched from exactly one place (`hero/dispatch.md:10`) with no defined producer; `triage-agent` is dispatched from exactly two rows (`catch-up/next-action-ranking.md:102-103`).

### Key Discoveries (all verified against the working tree)

- `hero/SKILL.md:156-157` — classify steps 3–4 carry the `DISPATCH_ARG="--mode watch-pr"` / `"--mode watch-upstream"` values AND are the section #1606 relocates → #1604 and #1606 are NOT parallel-safe.
- `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh:124` hard-greps the literal `"7 total"`; `:111-147` hard-code all three watch token shapes, mode names, `modes/watch-blockers.md` path, and a ≥5-occurrence count. This test is a doc-structure test and breaks at phase 1 and again at phase 3.
- `scripts/check-doc-rosters.sh:54` awk-anchors on the literal heading `### ralph Plugin — 16 Agents` — the agent deletion must edit the checker in the same phase or `doc_agents` extracts empty.
- `autopilot-director-postcheck.sh:56` greps `'--mode classify'` in `Skill("loop", …)` args; if the string changes without updating the grep, the watcher silently never arms and `autopilot-stop-gate.sh` never blocks (fail-open).
- `narrative-synthesis.md` is consumed by catch-up default Step 1 (`catch-up/SKILL.md:65,77`) and external invokers; `dashboard-render.md` is inherited by `--mode brief` (`brief-composition.md:51`). The MODES go, the FRAGMENTS stay.
- `--mode debug` is dispatched from `hero --mode watch` (`watch-dispatch.md:26,51`); `--mode prove` from `hero/dispatch.md:10`; `triage-agent` from `next-action-ranking.md:102-103`. All three deletions must edit these call sites.
- `plan-research-required.sh:36-102` has NO plan-of-plans carve-out; the fence-stripped discriminator in `doc-structure-validator.sh:60-69` is the precedent for adding one. The three split hooks all scope on `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=split` — re-registration without re-keying the env guards would no-op them.
- `ralph/skills/shared/__tests__` is NOT in the CI hook-test glob (`ci.yml:111-127` covers only `ralph/hooks/scripts/__tests__` + `scripts/__tests__`) — shared-test edits must be verified locally.

## Desired End State

1. Mode count is **35** under the stated counting rule (baseline 45, delta −10) — see § Mode-count target.
2. `caretake` has 8 modes: default, all, triage, hygiene, unblock, reflect, watch, enrich. `catch-up` has 3: default, report, brief. `hero` has 4: default, auto, watch, pr-drain. `research` has 2: default, auto. `plan` keeps 5 (epic is now the only decomposition surface).
3. No dangling reference to `--mode debug|postmortem|retro|trends|narrative|dashboard|classify|prove|split|watch-pr|watch-upstream|watch-blockers` anywhere in `ralph/`, `scripts/`, `CLAUDE.md`, `README.md` (as mode dispatches; historical thoughts/docs excluded).
4. Exactly one authoritative copy each of: the label/event taxonomy, the loop/auto substrate, the terminal-token table. No "keep in sync" instruction in `ralph/skills/**`.
5. Split guarantees survive in plan context: M/L/XL parent gate, XS/S child gate, ≥2-children postcondition, plus the plan-of-plans shape now Stop-validated (it is enforced by nothing today in caretake context).
6. Autopilot contract intact: agent-audience queue read, `result:` line contract, stop-gate arming on the new string, never-terminate semantics.
7. `triage-agent` deleted (roster 16 → 15), both catch-up dispatch rows rewritten, `check-doc-rosters.sh` updated and green.

### Verification

- `bash scripts/check-doc-rosters.sh` exits 0.
- Hook tests green: `find ralph/hooks/scripts/__tests__ scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash`.
- `shellcheck -S error ralph/hooks/scripts/*.sh scripts/*.sh` clean.
- Local (CI-silent) shared tests: `bash ralph/skills/shared/__tests__/loop-arg-strip.test.sh` and `auto-alias.test.sh`.
- `cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts` green (caretake/research/plan frontmatter stays parseable).
- Repo-wide grep sweeps per phase prove zero dangling mode references.
- Manual: one interactive pass each of `caretake --mode watch`, `plan --mode epic` on an M+ issue, `hero --mode auto` arming, catch-up default.

## Mode-count target (restated for #1590 — settled, not open)

**Counting rule** (research § Mode tally): one mode = one row of the verb's SKILL.md mode-dispatch table; `default` counts once per verb; `--help`, sub-flag variants (`--kind`, `--question`, `--dry-run`), and internal entrypoints not in the mode table count zero; `hero-fable` is outside the 9-verb set and uncounted.

**Baseline: 45** (not the 47 in #1590 — the audit's 47 does not reproduce under any single rule). **After this plan: 35.**

| Verb | Before | After | Delta |
|---|---|---|---|
| catch-up | 5 | 3 | −2 (narrative, dashboard) |
| form | 2 | 2 | 0 |
| research | 3 | 2 | −1 (prove) |
| plan | 5 | 5 | 0 (epic absorbs split; no new mode) |
| impl | 4 | 4 | 0 |
| review | 4 | 4 | 0 |
| caretake | 14 | 8 | −6 (debug, postmortem, trends, split, watch-×3 → watch) |
| hero | 5 | 4 | −1 (classify) |
| setup | 3 | 3 | 0 |
| **Total** | **45** | **35** | **−10** |

#1590's first acceptance criterion is restated to: *"Mode count 45 → 35 under the stated counting rule; every deletion audit-substantiated."* We do NOT invent deletions to hit ≤22 — evidence beats the round number. **Wave-3 candidates** that a future feature would need, each with the evidence it requires:

| Candidate cut | Would remove | Evidence a wave 3 must produce |
|---|---|---|
| `review` val/code/merge → flags of the default drain | −3 | Reference sweep of hero review dispatch rows + review token consumers (mirror of this research doc's #1604 section) |
| `impl` pr/address → default/auto | −2 | hero pr-drain and address-feedback dispatch analysis; PR-event routing map |
| `caretake --mode all` → bare `--loop` default | −1 | loop-wrapper manifest + heartbeat-consumer sweep |
| `plan --mode iterate` → default intake rule 3 | −1 | Confirmation that intake-routing's existing-plan prompt fully covers iterate |
| `form --mode draft` → default flag | −1 | Draft-mode dispatch/consumer sweep |
| `setup` cli/repos → steps of project | −2 | Setup invocation audit (docs + hooks) |
| `catch-up` report/brief consolidation | −1 | report/brief consumer sweep (`cos`, schedules) |
| `hero watch`/`pr-drain` analysis | −1..2 | watch-dispatch/pr-drain event-source audit |

## What We're NOT Doing

- **Not chasing ≤22.** The six children as scoped land at 35; the remainder is a wave-3 backlog (table above), not silent scope creep.
- **Not deleting `narrative-synthesis.md` or `dashboard-render.md`** — consumed by catch-up default Step 1 and `--mode brief`. Only the mode branches go.
- **Not deleting `catch-up-agent`** — it backs default Step 1 (`catch-up/SKILL.md:65,75`) and is rostered.
- **Not adding a `blocked:*` event-class row for `--kind issue`** — subtractive work only; `WAIT-issue` items keep fan-out-only watcher coverage (research Open Q3, resolved below).
- **Not touching** MCP tools (#1591), server-side invariants (#1592), model-tier config (#1593), `hero-fable`, or `.github/workflows/`.
- **Not editing historical docs** (`docs/superpowers/**`, old thoughts/) — dangling references there are acceptable; sweeps target `ralph/`, `scripts/`, root `CLAUDE.md`, `README.md`.
- **Not splitting into multiple PRs** — one PR, one revert scope, one `release-ralph.yml` bump; intermediate phase states only need to be green at the commit granularity, but each phase below is written to keep the three tripwire tests green at its own boundary anyway.

## Design Decisions & Open Ambiguities

Settled by the feature bookend (do NOT re-open):

- **Mode-count target** — options: invent cuts to hit ≤22; restate to the evidence. **Decided: restate to 45 → 35 with the counting rule, delta, and wave-3 table above.** Research proved baseline 45 and scoped landing ~34–36; unjustified deletions to hit a round number are exactly the failure mode this epic exists to prevent.
- **#1604/#1606 ordering** — options: parallel (per plan-of-plans); serialize. **Decided: serialize, #1606 before #1604.** Both rewrite `hero/SKILL.md:156-157` (classify steps 3–4 / the `DISPATCH_ARG` lines) and both touch `event-classes.md`. Folding classify first means the watch merge rewrites the relocated dispatch lines exactly once. This corrects the plan-of-plans' "parallel-safe (disjoint mode bodies)" claim.
- **Call sites over rosters** — `--mode prove` IS dispatched (`hero/dispatch.md:10`) and `triage-agent` IS dispatched (`next-action-ranking.md:102-103`). Both removals stay in scope; Phases 3/6 edit the call sites and name the replacement capability at each.
- **Undeletable fragments** — `narrative-synthesis.md` and `dashboard-render.md` stay; only `--mode narrative`/`--mode dashboard` branches go (Phase 1).
- **`check-doc-rosters.sh` self-edit** — the `### ralph Plugin — 16 Agents` heading regex (`:54`) is updated in the same phase as the agent deletion (Phase 6).

Resolved by this plan (judgment calls settled from the research evidence):

- **Merged decomposition surface lives in plan context** (`plan --mode epic`) — options: plan; caretake. **Decided: plan.** Both enforcement gates (`plan-research-required.sh` Write gate, `doc-structure-validator.sh` Stop gate) are already armed there — moving split INTO plan context *adds* the shape enforcement split currently lacks, and deletes the hook-evasion rationale outright. The three split hooks are re-keyed to `RALPH_COMMAND=plan` + `RALPH_SUBCOMMAND=epic` and re-registered in plan's frontmatter (both steps required — re-registration alone leaves the env guards no-op'ing).
- **Watch token family** — **Decided: `WATCH-<KIND> ADVANCED <N>` / `WATCH-<KIND> IDLE` / `WATCH-<KIND> SKIPPED — branch <name> is not main`, `KIND ∈ {PR, UPSTREAM, ISSUE}`.** watch-blockers' two-number `<m> still blocked` moves to summary prose — nothing executable greps it (research: no hook greps `WATCH-*`; the only consumer is the doc-structure test being rewritten anyway).
- **Classify fold mechanism** — **Decided: internal `--tick` entrypoint.** `--mode auto`'s inner loop command becomes `Run /ralph:hero --tick on the next-most-important event…`; Step 0 routes `--tick` to the tick section (the former classify steps 1–6, verbatim, `audience:"agent"` preserved); `--tick` appears in no mode table or argument-hint (not a public mode, counts zero). Arming grep in `autopilot-director-postcheck.sh:56` becomes `grep -q -- '/ralph:hero --tick'` — unique across all loop wrappers (no other inner command contains it), preserving the design record's uniquely-identifying-string requirement. `result:` lines unchanged, so wakeup cadence marks survive.
- **`--kind issue` dispatch coverage** — **Decided: fan-out-only** (status quo for watch-blockers: hero classifies only `blocked:pr-*`/`blocked:upstream`). Adding a `blocked:*` tier row for dependency-parked items would be new capability — out of scope.
- **Prove rehoming shape** — options: own surface; fold into default intake. **Decided: fold.** A claim is a research question with a verdict-shaped answer; `research/intake-routing.md` rule 4 (free-form) absorbs it, the verdict rubric moves into `findings-format.md`, and `hero/dispatch.md:10`'s claim-check option is deleted (nothing defines a claim-check event — the evidence-consistent move per research Open Q4). Capability preserved: claim-shaped free-form intake produces a verdict-first summary.
- **Taxonomy home** — **Decided: new `ralph/skills/shared/event-taxonomy.md`**; both `label-routing.md` and `event-classes.md` deleted, all references repointed. Reconciliation of the 3 conflicting rows is specified in Phase 5.
- **`loop-arg-strip.test.sh` copy** — **Decided: extract the snippet from `loop-wrapper.md` at test time** (awk between fences) instead of keeping a third copy — true single-sourcing; fixes the existing 1-token drift by construction.
- **`--mode all` fan-out end state** — Phase 1 leaves 6 children ("6 total"); Phase 3 leaves 4 ("4 total"): hygiene, watch, enrich, report. Bare `--mode watch` (no `--kind`) sweeps all three kinds serially so the fan-out needs one row, not three.

None — no open design decisions.

## Implementation Approach

Six phases, one per member, in corrected dependency order: 1603 → 1606 → 1604 → 1605 → 1607 → 1608. Deletions first (they shrink everything downstream), hero classify fold before the watch merge (shared `hero/SKILL.md` lines), decomposition consolidation independent after the deletions, substrate dedup after all row churn, closeout last. Shared files (`caretake/SKILL.md`, `outcome-tokens.md`, `loop-wrapper.md`, `ralph/CLAUDE.md`, root `CLAUDE.md`, `README.md`) are touched by multiple phases — ownership is sequential; each later phase edits the file as left by the earlier phase. The tripwire tests (`caretake-watch-blockers.test.sh`, `hero-classify-audience.test.sh`, `autopilot-auto-watcher.test.sh`) are updated in the same phase as the surface they anchor on.

## Phase 1: GH-1603 — Delete dead caretake + catch-up modes (debug, postmortem→reflect, trends, narrative, dashboard)

- **depends_on**: null

### Overview

Delete `caretake --mode debug|postmortem|trends` and `catch-up --mode narrative|dashboard`; rename `retro` → `reflect` as the single reflection mode. Caretake 14 → 10 modes, catch-up 5 → 3.

### Changes Required

#### 1. Mode bodies (delete/rename)

- DELETE `ralph/skills/caretake/modes/debug.md`, `modes/postmortem.md`, `modes/trends.md`.
- RENAME `ralph/skills/caretake/modes/retro.md` → `modes/reflect.md`; fold postmortem's surviving session-reflection intent into it and unwind the retro↔postmortem coupling (`retro.md:11,29,39,42,50` team-session dedup prompt offering `--mode postmortem` — delete that prompt; `outcome-tokens.md:66` `RETRO SKIPPED team-session-redirect` token — delete). Retro's token family renames `RETRO *` → `REFLECT *`.
- **Capability accounting**: debug — dead by default env (`collate_debug` unrostered in `caretake/SKILL.md:51-84`, registered only under `RALPH_DEBUG=true`, hardcoded Langfuse path); replacement: none needed — Langfuse-trace investigation remains available manually via the debug tools when `RALPH_DEBUG=true`. postmortem — its data producer (team/worker sessions) was deleted in GH-1438; it degenerates to `POSTMORTEM SKIPPED no-session-data` (`postmortem.md:19`); replacement: `reflect`. trends — two MCP calls (`trends.md:21,27`); replacement: `capture_snapshot`/`metrics_trends` stay callable directly (belongs on a schedule; the tool surface is #1591's).

#### 2. Caretake dispatch + reference surface

**File**: `ralph/skills/caretake/SKILL.md`
- `:2,3` description/argument-hint mode enumerations; `:48` DELETE `postmortem-completeness.sh` registration; `:97-100` mode-table rows (postmortem/retro→reflect, trends, debug); `:122,124,126` `--loop` routing rows; `:144-152` `--mode all` fan-out: drop item 7 (trends) → 6 children, reword `:152` "one line per child — **6 total**"; `:163-166` mode-bodies links; `:181-184` token quick-ref lines.

**File**: `ralph/skills/caretake/outcome-tokens.md` — delete `## Debug terminal tokens` (`:76-82`), postmortem + retro sections (`:55-70`, retro→reflect), trends section (`:72-74`), drain-modes list (`:130,132`), and the four "parity with hygiene/trends" prose hits (`:99,107,115,124`).

**File**: `ralph/skills/caretake/label-routing.md` — `:14` `trends-check` row DELETE; `:17` `process-improvement` row retargets `--mode retro` → `--mode reflect`; `:18` `debug-auto` row DELETE; `:22-35` `trigger:caretake` fan-out: delete item 5 (debug) and item 6 (postmortem), retarget item 7 retro → reflect → 6-item fan-out.

#### 3. Hero call sites (the corrections — debug is NOT unreachable)

**File**: `ralph/skills/hero/watch-dispatch.md` — `:26` `langfuse-trace:` row: DELETE the `--mode debug` dispatch; replace action with `Agent(subagent_type="ralph:log-reader", …)` (the adjacent `watcher-investigate` pattern at `:27`) so trace-bearing issues still get an investigation path. `:51` heartbeat debug-collate step: DELETE (with its `RALPH_DEBUG` preflight); renumber step 5.
**File**: `ralph/skills/hero/event-classes.md` — `:37,93` `debug-auto` producer/consumer rows DELETE.
**File**: `ralph/skills/hero/SKILL.md` — `:92` watch-mode role text drops "debug-collate".

#### 4. Catch-up mode branches (fragments stay)

**File**: `ralph/skills/catch-up/SKILL.md` — `:9,10` description/argument-hint; `:48` refusal-list mention; `:55-56` mode-table rows (narrative, dashboard); `:113-117` `--mode narrative` branch DELETE; `:119-130` `--mode dashboard` branch DELETE; `:165` sibling-list entry. **Keep** `narrative-synthesis.md` (default Step 1 consumes it, `SKILL.md:65,77`) and `dashboard-render.md` (`brief-composition.md:51` inherits its never-editorialize list). Keep `catch-up-agent`.

#### 5. Hooks, tests, docs

- DELETE `ralph/hooks/scripts/postmortem-completeness.sh` (registration deleted above; no dedicated test exists — deletion is test-silent).
- **File**: `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh:124` — `"7 total"` → `"6 total"` (full rewrite comes in Phase 3; this phase only keeps it green).
- **File**: `ralph/skills/shared/loop-wrapper.md:48-49` — delete `caretake:trends` and `caretake:debug` manifest rows; update `caretake:retro`-adjacent rows to reflect.
- **File**: `ralph/CLAUDE.md` — matrix rows `:73-74` (trends, debug) DELETE, `:81-82` (postmortem, retro) → single reflect row, `:86-87` (narrative, dashboard) DELETE.
- **File**: root `CLAUDE.md` — verb-table one-liners: caretake row drops "trends, debug", catch-up row drops "narrative + dashboard" phrasing (`:71,78` region).
- **File**: `README.md:78-79` — caretake/catch-up one-liners.

### Success Criteria

#### Automated Verification
- [ ] `grep -rn -- '--mode debug\|--mode postmortem\|--mode trends\|--mode narrative\|--mode dashboard\|--mode retro' ralph/ scripts/ CLAUDE.md README.md` → 0 hits
- [ ] `grep -rln 'postmortem-completeness' ralph/` → 0 hits
- [ ] `find ralph/hooks/scripts/__tests__ scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` → all pass (incl. the "6 total" edit)
- [ ] `bash scripts/check-doc-rosters.sh` exits 0
- [ ] `shellcheck -S error ralph/hooks/scripts/*.sh` clean
- [ ] `ls ralph/skills/catch-up/narrative-synthesis.md ralph/skills/catch-up/dashboard-render.md ralph/agents/catch-up-agent.md` — all three still exist

#### Manual Verification
- [ ] `/ralph:catch-up` (default) still produces the narrative via catch-up-agent; `--mode brief` still renders with the inherited never-editorialize constraints
- [ ] `/ralph:caretake --mode reflect` runs the former retro flow without offering a postmortem redirect
- [ ] `/ralph:caretake` (no args) fan-out reports 6 children

## Phase 2: GH-1606 — Remove `hero --mode classify` as a public mode; fold into `--mode auto`

- **depends_on**: [phase-1]

### Overview

Classify becomes the internal `--tick` entrypoint of `--mode auto`. Hero 5 → 4 modes. Serialized BEFORE the watch merge because this phase relocates `hero/SKILL.md:156-157`, which Phase 3 then edits in place.

### Changes Required

#### 1. Hero skill body

**File**: `ralph/skills/hero/SKILL.md`
- `:2,3` description/argument-hint drop classify; `:91` mode-table row DELETE; `:120` `RALPH_SUBCOMMAND=classify` case → `--tick` case (export `RALPH_SUBCOMMAND=auto`; no hook consumes a `tick` value — research: nothing keys on `RALPH_SUBCOMMAND=classify` either); `:127` loop-gate note; `:150-160` `## --mode classify` section → `## Auto tick (internal — dispatched only by --mode auto's loop wrapper)` housing the former steps 1–6 verbatim, **including** the step-2 `next_actions({ audience: "agent" })` requirement and its rationale, and the steps 3–4 `DISPATCH_ARG`/board-wide-sweep text (Phase 3 edits those lines next); `:143` default-mode cross-ref rewording (human-vs-agent audience split now references the tick); `:165` inner command → `Run /ralph:hero --tick on the next-most-important event…`; `:167-170` continuation contract unchanged (`result: Dispatched #NNN …` / `result: Queue empty.` — both re-fire); `:174,195` result-line callout + pr-drain intro rewording.
- **Capability preserved**: agent-audience queue read (XS/S `audiencePenalty`, Backlog-fallback), one-tick-per-dispatch, never-terminate contract.

#### 2. Arming hook (silent-fail-open tripwire)

**File**: `ralph/hooks/scripts/autopilot-director-postcheck.sh:56` — `grep -q -- '--mode classify'` → `grep -q -- '/ralph:hero --tick'`. This is the ONLY hook coupling (research correction: no hook keys on `RALPH_SUBCOMMAND=classify`). `autopilot-enable-gate.sh`, `autopilot-wakeup-clear.sh`, `autopilot-stop-gate.sh` unaffected.

#### 3. Tests

- **File**: `ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` — re-anchor the awk extractor (`:55-61`) from `/^## --mode classify[[:space:]]*$/` to the new tick heading; assertions (agent-audience present in block `:82-88`, no bare `next_actions({})` in block `:92-100`) unchanged in intent. Rename to `hero-auto-tick-audience.test.sh`.
- **File**: `ralph/hooks/scripts/__tests__/autopilot-auto-watcher.test.sh:53-58` — arming fixture args → `"Run /ralph:hero --tick on the queue"`. Result-line cases (`:68-120`) survive untouched (contract preserved).

#### 4. Docs and idiom sweep

- **File**: `ralph/skills/hero/dispatch.md:3,20` — classify-path notes → tick-path.
- **File**: `ralph/skills/plan/plan-review.md:134` and `ralph/skills/plan/SKILL.md:200` — "classify tick" idiom → "auto tick".
- **File**: `ralph/skills/shared/loop-wrapper.md:54` — hero:auto manifest row: inner-command text and "wraps `--mode classify`" → `--tick`.
- **File**: `ralph/CLAUDE.md` — `:91` classify matrix row DELETE; `:103` ScheduleWakeup prose arming-string mention → new string.
- **File**: root `CLAUDE.md:76` — hero one-liner "auto … + watch + classify + pr-drain" → "auto … + watch + pr-drain".
- Cosmetic, non-blocking: `scripts/dream/tests/test_ingest.py:539` embeds the old string as an ingest fixture — leave (tests dream ingest, not hero; it is data, not a dispatch).

### Success Criteria

#### Automated Verification
- [ ] `grep -rn -- '--mode classify' ralph/ scripts/*.sh CLAUDE.md README.md` → 0 hits (dream fixture excluded by path)
- [ ] `bash ralph/hooks/scripts/__tests__/hero-auto-tick-audience.test.sh` and `bash ralph/hooks/scripts/__tests__/autopilot-auto-watcher.test.sh` pass
- [ ] Full hook-test sweep + `shellcheck -S error ralph/hooks/scripts/*.sh` + `bash scripts/check-doc-rosters.sh` green
- [ ] `grep -c '/ralph:hero --tick' ralph/hooks/scripts/autopilot-director-postcheck.sh` → 1

#### Manual Verification
- [ ] With `RALPH_AUTOPILOT_ENABLE=true`, `/ralph:hero --auto` emits `Skill("loop", …/ralph:hero --tick…)`, the watcher arms (sentinel file appears), and a tick emits a `result:` line
- [ ] `/ralph:hero --mode classify` no longer resolves as a documented mode

## Phase 3: GH-1604 — Merge watch-pr / watch-upstream / watch-blockers into `--mode watch --kind {pr,upstream,issue}`

- **depends_on**: [phase-2]

### Overview

One `modes/watch.md` with a per-kind table replaces three 86/88/91-line bodies. Caretake 10 → 8 modes (with Phase 1 done). Runs after Phase 2 so the hero dispatch lines it rewrites are already in their tick-section home.

### Changes Required

#### 1. Merged mode body

**File**: `ralph/skills/caretake/modes/watch.md` (NEW; DELETE `watch-pr.md`, `watch-upstream.md`, `watch-blockers.md`)
- Shared skeleton (identical today, research § What is identical): `export RALPH_SUBCOMMAND=watch` fence; branch guard (`git branch --show-current` off-main → `WATCH-<KIND> SKIPPED — branch <name> is not main`); IDLE path; no-Stop-hook preamble; `command: "ralph_triage"` unguarded-transition note; explicit-labels-array warning; §Constraints closer.
- Per-kind table (the 6-axis diff from research § #1604): match predicate (pr: Backlog + `^blocked:pr-([0-9]+)$` regex; upstream: Backlog + server-side `label: "blocked:upstream"`; issue: Human Needed + Backlog sweeps, `blockedBy` edge or `## Escalation` body), resolution predicate (pr: `gh pr view --json state,mergedAt` → MERGED; upstream: per-URL-type conservative check; issue: ALL blockers CLOSED via `get_issue`), action on resolution (pr: strip label + deferred 4-verdict map + `## Watch-PR Resolution` comment; upstream: strip label + promote-family-only + `## Watch-Upstream Resolution`; issue: `remove_dependency` + advance + strip `blocked:*`+`ralph-triage` + `## Unblocked`), escalation (pr: closed-unmerged → Human Needed; upstream: dead URL → Human Needed, 5xx transient → leave; issue: none — leave and count).
- Bare `--mode watch` (no `--kind`) = all three kinds serially. Tokens: `WATCH-<KIND> ADVANCED <N>` / `IDLE` / `SKIPPED — branch <name> is not main`; blockers' `<m> still blocked` becomes summary prose.

#### 2. Caretake dispatch surface

**File**: `ralph/skills/caretake/SKILL.md` — `:2,3` enumerations; `:93` all-row; `:102-104` three mode rows → one; `:146-148` fan-out items 2–4 → one `Skill("ralph:caretake", args="--mode watch")` → **4 children**, `:152` → "**4 total**"; `:168-170` mode-body links → `modes/watch.md`; `:186-188` token quick-ref → new family.
**File**: `ralph/skills/caretake/outcome-tokens.md` — `:16-18` triage tokens naming the watchers (`WAIT-pr`/`WAIT-upstream`/`WAIT-issue` consumers); `:93-115` three token sections → one; `:124,132`.
**File**: `ralph/skills/caretake/modes/triage.md:92-93,109-111,115-117,167,201,259-261` — producer-side prose: `caretake --mode watch-pr` → `--mode watch --kind pr` etc.
**Correction honored**: `label-routing.md` has NO watch/`blocked:*` rows — nothing to edit there (the issue body's claim is false; the asymmetry is Phase 5 evidence).

#### 3. Hero call sites (in the tick section Phase 2 created)

**File**: `ralph/skills/hero/SKILL.md` tick steps 3–4 (formerly `:156-157`) — `DISPATCH_ARG="--mode watch-pr"` → `"--mode watch --kind pr"`; `"--mode watch-upstream"` → `"--mode watch --kind upstream"`; step-4 examples likewise (board-wide sweep semantics unchanged).
**File**: `ralph/skills/hero/event-classes.md:27-28,79` — tier rows + prose restated with `--kind`. (No hero watch-blockers dispatch exists — fan-out-only for `--kind issue`, per resolved decision.)

#### 4. Test rewrite (plan work, not incidental)

**File**: `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` → REWRITE as `caretake-watch.test.sh`. Every current assertion breaks by design: `RALPH_SUBCOMMAND=watch-blockers` fixture (`:78`) → `watch`; three token-shape greps (`:111-118`) → the `WATCH-<KIND>` family incl. the SKIPPED variant; `'mode watch-blockers'` / `"7 total"` (now "6 total" after Phase 1) / `modes/watch-blockers.md` / ≥5-occurrence greps (`:123-127`) → `'mode watch'` / `"4 total"` / `modes/watch.md` / occurrence threshold recomputed against the merged SKILL.md; `## Watch-Blockers terminal tokens` heading + ≥3 occurrences (`:132-135`) → merged section; triage.md `caretake --mode watch-blockers` grep (`:140-147`) → `--kind issue` form.

#### 5. Substrate + docs

- **File**: `ralph/skills/shared/loop-wrapper.md` — three watch manifest rows → one `caretake:watch` row (heartbeat, no `Queue empty.`).
- **File**: `ralph/CLAUDE.md:76-78` — three matrix rows → one.
- **File**: `README.md:78` if watch modes named.

### Success Criteria

#### Automated Verification
- [ ] `grep -rn 'watch-pr\|watch-upstream\|watch-blockers' ralph/ scripts/ CLAUDE.md README.md` → 0 hits
- [ ] `bash ralph/hooks/scripts/__tests__/caretake-watch.test.sh` passes; old test file gone
- [ ] Full hook-test sweep + ShellCheck + `bash scripts/check-doc-rosters.sh` green
- [ ] `grep -c 'WATCH-' ralph/skills/caretake/outcome-tokens.md` ≥ 3 (family documented once, all variants present)

#### Manual Verification
- [ ] `/ralph:caretake --mode watch --kind pr` on a board with a `blocked:pr-NNN` item: correct predicate, resolution, comment shape
- [ ] `/ralph:caretake --mode watch` (bare) sweeps all three kinds; off-main emits the SKIPPED token
- [ ] Escalation paths intact: closed-unmerged PR → Human Needed; dead upstream URL → Human Needed

## Phase 4: GH-1605 — One decomposition surface (plan `--mode epic`) + `plan-research-required.sh` scoping fix

- **depends_on**: [phase-1]

### Overview

`plan --mode epic` becomes the single decomposition surface (plan-of-plans AND atomic M/L/XL→XS/S split); `caretake --mode split` deleted; `form` Step 6b forwards. The hook gains a legitimate plan-of-plans carve-out so no context-based escape hatch remains. Parallel-safe with Phases 2–3 except a trivial disjoint-line overlap in `hero/dispatch.md` (SPLIT row `:9` vs classify notes `:3,20`) — kept sequential here for one-branch simplicity.

### Changes Required

#### 1. Hook scoping fix (the fork's stated reason dies here)

**File**: `ralph/hooks/scripts/plan-research-required.sh` — insert a discrimination branch between steps 3 and 4 (i.e. after the `GH-` token check at `:47-50`, before the research-doc lookup at `:52-57`): parse `.tool_input.content`, fence-strip, and if it matches `^type:[[:space:]]*plan-of-plans` OR `^## Feature Decomposition`, allow-with-context — mirroring `doc-structure-validator.sh:60-69`'s existing discriminator. Hole bounded: a mislabeled implementation plan then fails the plan skill's Stop-side shape enforcement (`doc-structure-validator.sh:68-93` requires `## Feature Decomposition` + `## Feature Sequencing` + Design Decisions).
**File**: `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` — add carve-out cases (plan-of-plans content allowed without research doc; fence-wrapped variant; ordinary plan still blocked), using the existing SBX/REPO/NOGIT harness.

#### 2. Split hooks re-keyed AND re-registered (both, or they no-op)

**Files**: `ralph/hooks/scripts/split-estimate-gate.sh`, `split-size-gate.sh`, `split-postcondition.sh` — scope guards `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=split` → `RALPH_COMMAND=plan` + `RALPH_SUBCOMMAND=epic`. Guarantees preserved verbatim: Pre/Post estimate gate (parent ∈ M/L/XL), size gate (children ∈ XS/S, batch + scalar), ≥2-children Stop postcondition via `RALPH_SPLIT_COUNT` (env-var-trust, NOT transcript grep — research correction of `split-decomposition.md:98`).
**File**: `ralph/skills/plan/SKILL.md` frontmatter — ADD the four registrations (estimate-gate Pre+Post on `get_issue`, size-gate Pre on `create_issue|create_sub_issues`, postcondition Stop). **File**: `ralph/skills/caretake/SKILL.md` — REMOVE the four registrations (`:16-34` Pre/Post pairs, `:46` Stop).
**File**: `ralph/hooks/scripts/__tests__/split-size-gate.test.sh` — env fixtures re-keyed to plan/epic.

#### 3. Merge the surfaces

- DELETE `ralph/skills/caretake/modes/split.md` and `ralph/skills/caretake/split-decomposition.md`. Salvage into **`ralph/skills/plan/decomposition.md`**: an `## Atomic split` section (M+ parent analysis rules, `create_sub_issues` batch with inline `dependsOn`, `## Issue Split` comment shape, child-state `batch_update`, `SPLIT <N>` terminal token, `RALPH_SPLIT_COUNT` export) alongside the existing plan-of-plans shape. Delete both hook-evasion statements (`split-decomposition.md:85`, `modes/split.md:140`) with the files.
- **File**: `ralph/skills/plan/SKILL.md:167-179` — epic-mode body absorbs the atomic-split path (epic-shaped input → plan-of-plans; M+ atomic input → XS/S split); note `decompose_feature` remains rostered-but-uninvoked (`:100`) — leave for #1591/#1612 (tool surface is out of scope).
- **File**: `ralph/skills/form/SKILL.md:138-146` — Step 6b's inline parent+children `create_sub_issues` shape → forward: create the parent only, then instruct `/ralph:plan --mode epic #<parent>` for the tree (form registers no hooks today, so its inline path was gate-free; forwarding closes that too). Capability preserved: intake can still produce a tree, now through the gated surface.
- **File**: `ralph/skills/caretake/SKILL.md` — split rows out (`:96` region, `:122,185`); `--auto`→triage keeps emitting `SPLIT` verdicts.
- **File**: `ralph/skills/caretake/label-routing.md` — `:19` `needs-split` row → `/ralph:plan --mode epic #NNN`; `:28` `trigger:caretake` fan-out item 3 (split) DELETE → 5-item fan-out; `:48`.
- **File**: `ralph/skills/caretake/outcome-tokens.md:84-91` — split token section moves to plan's documentation (token family unchanged: `SPLIT <N>`, `Queue empty.`).

#### 4. Hero SPLIT dispatch call sites

**File**: `ralph/skills/hero/dispatch.md:9` SPLIT row → `/ralph:plan --auto --mode epic` args `#NNN`; `:26` Skill-vs-Agent table; `:96` split-failure row.
**Files**: `ralph/skills/hero/state-machine.md:18,76,88`; `ralph/skills/hero/task-graph.md:11,14-15,97` — SPLIT phase now dispatches plan.
**Files**: `ralph/skills/shared/loop-wrapper.md` (`caretake:split` manifest row → plan-side entry), `ralph/CLAUDE.md:75` (matrix row), `README.md:78`, root `CLAUDE.md` caretake one-liner drops "split".

### Success Criteria

#### Automated Verification
- [ ] `grep -rn -- '--mode split\|split-decomposition' ralph/ scripts/ CLAUDE.md README.md` → 0 hits
- [ ] `bash ralph/hooks/scripts/__tests__/plan-research-required.test.sh` passes with the new carve-out cases; `bash ralph/hooks/scripts/__tests__/split-size-gate.test.sh` passes re-keyed
- [ ] `grep -n 'RALPH_COMMAND.*plan' ralph/hooks/scripts/split-*.sh` → 3 hits (one per script); `grep -n 'split-' ralph/skills/plan/SKILL.md` shows 4 registrations; `grep -n 'split-' ralph/skills/caretake/SKILL.md` → 0
- [ ] Full hook-test sweep + ShellCheck + `bash scripts/check-doc-rosters.sh` + skill-frontmatter vitest green

#### Manual Verification
- [ ] `/ralph:plan --mode epic #<M-estimate issue>` performs an atomic split: estimate gate fires on a small parent, size gate blocks an M child, ≥2-children postcondition enforced, plan-of-plans write passes `plan-research-required.sh` without a research doc
- [ ] A deliberately mislabeled `type: plan-of-plans` implementation plan is caught by the Stop-side `doc-structure-validator.sh`
- [ ] `/ralph:form` tree intake forwards to plan epic instead of inlining `create_sub_issues`

## Phase 5: GH-1607 — Single-source the shared substrate (taxonomy, loop/auto, token table)

- **depends_on**: [phase-3, phase-4]

### Overview

Reconcile — not concatenate — the two taxonomy files into one shared file; make `loop-wrapper.md`/`auto-alias.md` the only loop/auto copies; make `outcome-tokens.md` the only token table. Must run after Phases 1–4: their row churn (debug/retro/trends, watch-×3, split, classify) is exactly the content being merged.

### Changes Required

#### 1. One taxonomy file

**File**: `ralph/skills/shared/event-taxonomy.md` (NEW) — merged from `caretake/label-routing.md` + `hero/event-classes.md` (both DELETED). Reconciliation of the three conflicting rows:
- `trigger:caretake` — keep label-routing's explicit serial fan-out semantics (as amended by Phases 1/4: hygiene, triage, unblock, reflect, report — 5 items), label consumed after dispatch; hero's row references the same fan-out instead of "dispatch the caretakers team".
- `debug-auto` — GONE entirely (Phase 1 deleted both its producer and consumer; neither direction survives).
- `process-improvement` — routes to `caretake --mode reflect` (specific beats generic; matches Phase 1's rename).
Rows unique to each file carry over as-is (label-routing's `stale`/`status-update-needed`/`needs-triage`/`human-needed`/`needs-split`(now → plan epic)/no-label default; event-classes' `trigger:*` team tiers, `blocked:*` watcher tier (now `--kind` form), automation labels, Priority-4 workflow-state fallback). The one-directional "keep both in sync" line (`label-routing.md:79`) dies with the file — acceptance requires zero "keep in sync" instructions in `ralph/skills/**`.
**Repoint every reference** to either old file: `caretake/SKILL.md`, `modes/triage.md`, `modes/watch.md`, `hero/SKILL.md` (tick step 3), `hero/dispatch.md`, `hero/watch-dispatch.md`, `catch-up/next-action-ranking.md:102-103` (prompt text references `label-routing.md` — repoint now; the rows themselves are rewritten in Phase 6), `ralph/CLAUDE.md`, and any `${CLAUDE_PLUGIN_ROOT}` path strings (`grep -rn 'label-routing\|event-classes' ralph/` drives the sweep).

#### 2. One loop/auto substrate

- **Files**: `ralph/skills/shared/loop-wrapper.md:3`, `auto-alias.md:3` — fix the stale "SKILL.md bodies copy the snippets below" framing → "consumers reference this file" (research: no SKILL.md inlines the snippet; all seven consumers already point).
- **File**: `ralph/CLAUDE.md:48-99` — replace the 40-row duplicated suitability matrix + verbatim refusal strings (`:97,99`) with a short pointer to the two shared files (keep the ScheduleWakeup-rules section, updating its content refs). The manifest/alias tables in the shared files become the ONLY copies.
- **File**: `ralph/skills/shared/__tests__/loop-arg-strip.test.sh:23-35` — replace the embedded snippet copy with awk extraction from `loop-wrapper.md:7-27`'s fenced block at test time (kills the third copy and the existing `printf`-vs-`echo` drift by construction). NOTE: this test is NOT in the CI glob — run locally.

#### 3. One token table

**File**: `ralph/skills/caretake/SKILL.md:173-190` — the drifted quick-ref (4 drift points: `<N archived>` vs `<N>`, lost `<reason>` placeholder, missing `UNBLOCK REQUEST SKIPPED` variant, missing split `Queue empty.`) → one pointer line to `outcome-tokens.md`. `outcome-tokens.md` (as amended by Phases 1/3/4) is the single home. Grep-verify no other SKILL.md grew a token table since the research (none exists today).

### Success Criteria

#### Automated Verification
- [ ] `grep -rn 'keep.*in sync\|keep both in sync' ralph/skills/` → 0 hits
- [ ] `test ! -f ralph/skills/caretake/label-routing.md && test ! -f ralph/skills/hero/event-classes.md && test -f ralph/skills/shared/event-taxonomy.md`
- [ ] `grep -rn 'label-routing\|event-classes' ralph/ CLAUDE.md README.md` → 0 hits
- [ ] `bash ralph/skills/shared/__tests__/loop-arg-strip.test.sh` and `bash ralph/skills/shared/__tests__/auto-alias.test.sh` pass locally (CI-silent — must be run by hand)
- [ ] Full hook-test sweep + ShellCheck + `bash scripts/check-doc-rosters.sh` green

#### Manual Verification
- [ ] `/ralph:caretake --auto` triage on a labeled issue routes per the merged taxonomy (spot-check `needs-triage`, a `trigger:*`, and a `blocked:pr-*` item)
- [ ] `--loop` refusal on an interactive mode still emits the canonical refusal string (now sourced only from `loop-wrapper.md`)

## Phase 6: GH-1608 — Fold `--mode prove` into research intake, delete `triage-agent`, final tally

- **depends_on**: [phase-4, phase-5]

### Overview

Closeout: prove folded into default research intake, triage-agent deleted with both dispatch rows rewritten, roster checker self-edit, and the epic-facing before/after tally.

### Changes Required

#### 1. Prove fold (call site edited, capability named)

- **File**: `ralph/skills/research/SKILL.md` — `:9,11` description/argument-hint; `:78-80` prove notes; `:87` mode-table row DELETE; `:188-196` body DELETE; `:204` sibling list. Frontmatter comment `:17-20` (branch-gate deliberately unregistered "partly because of prove") reworded.
- DELETE `ralph/skills/research/prove-claim.md`; salvage the verdict rubric into `ralph/skills/research/findings-format.md` as a `## Claim-check shape` variant of default findings (verdict-first summary; the `:177-189` per-mode matrix drops its prove column and gains the claim-shaped-question row). **File**: `ralph/skills/research/intake-routing.md:7` — prove rule → note that a claim-shaped free-form arg is a research question answered verdict-first. **File**: `ralph/skills/research/research-shapes.md:3`.
- **Call site**: `ralph/skills/hero/dispatch.md:10` — DELETE the "(or `NNN --mode prove` for claim-checks)" option (no event class or board state produces a claim-check; evidence-consistent deletion). Capability preserved: an operator can still hand `/ralph:research "claim: X"` a claim and get a verdict — via default intake, with all four Stop hooks now applicable rather than inherited-and-no-op'd.
- **File**: `ralph/skills/shared/__tests__/auto-alias.test.sh:121-127` — retarget the `--auto --mode prove` conflict case to a surviving mode conflict (e.g. `--auto --mode epic` on plan). Local-only test — run by hand.
- **File**: `ralph/CLAUDE.md:55` prove matrix row (if it survived Phase 5's matrix collapse — otherwise no-op).

#### 2. triage-agent deletion (call sites first)

- **File**: `ralph/skills/catch-up/next-action-ranking.md:102-103` — rewrite both rows: `tree-continue` and `lock-stale` → `Skill("ralph:caretake", args="--mode triage #NNN")` (the inline triage mode is the same procedure the agent shelled to; capability preserved in-session; prompt-path references now point at `shared/event-taxonomy.md` per Phase 5).
- DELETE `ralph/agents/triage-agent.md`. Not in `skill-frontmatter.test.ts`'s AGENTS list (`:28-34`) — vitest-silent by design.
- **File**: root `CLAUDE.md` — heading `### ralph Plugin — 16 Agents` → `15 Agents`; the "8 per-phase agents" bullet → 7, removing `triage-agent`.
- **File**: `scripts/check-doc-rosters.sh:54` — awk anchor `/^### ralph Plugin — 16 Agents/` → the new heading (same phase, or `doc_agents` extracts empty and CI flags every agent). The bullet-count regex at `:55` tolerates the count change.

#### 3. Final tally + PR evidence

- Append the before/after per-verb tally (the § Mode-count target table, verified against the merged tree by re-counting mode-table rows) to this plan's PR body, with the counting rule and the per-deletion audit evidence lines (#1590 acceptance requirement). Update `#1590`'s acceptance checkbox phrasing via comment (45 → 35, rule-stated).
- Root `CLAUDE.md` + `README.md` verb one-liners final pass (research row drops prove; hero row done in Phase 2; caretake/catch-up done in Phases 1/3/4).

### Success Criteria

#### Automated Verification
- [ ] `grep -rn -- '--mode prove\|prove-claim\|triage-agent' ralph/ scripts/ CLAUDE.md README.md` → 0 hits
- [ ] `bash scripts/check-doc-rosters.sh` exits 0 with the 15-agent roster (proves the `:54` anchor edit landed)
- [ ] Full hook-test sweep, ShellCheck (`ralph/hooks/scripts/*.sh` + `scripts/*.sh` — the roster script changed), skill-frontmatter vitest green
- [ ] Local: `bash ralph/skills/shared/__tests__/auto-alias.test.sh` passes with the retargeted conflict case
- [ ] Mode-table row recount over the merged tree: `catch-up 3, form 2, research 2, plan 5, impl 4, review 4, caretake 8, hero 4, setup 3` = 35

#### Manual Verification
- [ ] `/ralph:research "claim: <some claim>"` produces a verdict-first findings shape via default intake
- [ ] Catch-up `tree-continue` / `lock-stale` directions dispatch inline caretake triage successfully
- [ ] PR body carries the tally + per-deletion evidence; #1590's criterion restated

## Risks

Grounded in the research doc's § Risks and ordering constraints:

- **#1604/#1606 collision** (`hero/SKILL.md:156-157`, both also touch `event-classes.md`): mitigated by hard serialization — Phase 2 relocates the classify section, Phase 3 edits the relocated lines. Implementing these out of order re-introduces the double-rebase the plan-of-plans missed.
- **Silent fail-open of the autopilot stop-gate**: if Phase 2 changes the loop inner-command string without updating `autopilot-director-postcheck.sh:56`, the watcher never arms and `autopilot-stop-gate.sh` never blocks — no error is raised anywhere. The Phase 2 automated check (`grep -c '/ralph:hero --tick' …postcheck.sh` = 1) plus `autopilot-auto-watcher.test.sh` are the tripwires.
- **Cross-phase test file ownership**: `caretake-watch-blockers.test.sh` is edited in Phase 1 ("7 total" → "6 total") and rewritten in Phase 3 (as `caretake-watch.test.sh`, "4 total"). Phase 3's rewrite MUST be based on Phase 1's result; the phase ordering encodes this.
- **Split-hook no-op risk**: re-registering the split hooks in plan's frontmatter without re-keying the `RALPH_COMMAND`/`RALPH_SUBCOMMAND` env guards (or vice versa) silently disables all three guarantees. Phase 4 does both and greps for the re-key in its automated checks.
- **Hook-carve-out hole**: the `type: plan-of-plans` allow-branch in `plan-research-required.sh` could be abused to skip research by mislabeling; bounded because the plan-context Stop validator enforces the plan-of-plans shape (`doc-structure-validator.sh:68-93`) — a mislabeled implementation plan fails at Stop. Phase 4's manual check exercises exactly this.
- **CI-silent shared tests**: `ralph/skills/shared/__tests__` is outside the CI hook-test glob; Phases 5–6 edit those tests and MUST run them locally — drift there ships silently.
- **Roster-checker self-edit**: deleting `triage-agent` without the `check-doc-rosters.sh:54` heading-regex edit makes `doc_agents` extract empty and flags every agent — same-phase coupling in Phase 6 (phase-internal only, since everything ships as one PR).
- **Operator-facing renames land at once** (reflect, watch --kind, plan-epic split, --tick): a stale external invoker (schedule, muscle memory) hits a hard stop, not an alias. Migration Notes lists the spellings; the PR body must repeat them.
- **Single-PR blast radius**: one revert reverts all six members. Accepted trade (plan-of-plans integration strategy): one shared surface, one version bump, no mid-stack broken plugin releases.

## Testing Strategy

### Unit Tests
- Hook tests are the regression net: `caretake-watch.test.sh` (rewritten, Phase 3), `hero-auto-tick-audience.test.sh` (re-anchored, Phase 2), `autopilot-auto-watcher.test.sh` (arming fixture, Phase 2), `plan-research-required.test.sh` (+carve-out cases, Phase 4), `split-size-gate.test.sh` (re-keyed, Phase 4). Tests that hard-code strings are plan work, called out in their owning phases — notably `caretake-watch-blockers.test.sh`'s literal `"7 total"` (`:124`), token shapes (`:111-118`), and occurrence thresholds (`:123-135`).
- `mcp-server` vitest: `skill-frontmatter.test.ts` guards the edited SKILL.md frontmatter shapes.

### Integration Tests
- Full CI sweep locally before PR: doc rosters, both hook-test globs, ShellCheck both scandirs, vitest. Plus the two CI-silent shared tests by hand.

### Manual Testing Steps
1. Autopilot smoke: arm `hero --auto`, observe `--tick` arming + one dispatch + wakeup.
2. Watch smoke: seed a `blocked:pr-NNN` item, run `--mode watch --kind pr`, verify resolution comment + token.
3. Decomposition smoke: `plan --mode epic` on an M issue end-to-end (gates + plan-of-plans write + `SPLIT <N>`).
4. Catch-up default + brief render.

## Performance Considerations

None material — this is documentation/hook surface work; no runtime code paths in mcp-server change.

## Migration Notes

- **Single PR, single version bump**: all six phases ship as one PR; `release-ralph.yml` fires once on merge (verify `gh run list --commit <merge-sha>` per root CLAUDE.md).
- **Docs ride the branch**: research doc, plan-of-plans, and this plan are committed on the same branch; `main`'s ruleset admits them only through the group PR.
- **Operator-visible renames**: `--mode retro` → `--mode reflect`; `--mode watch-{pr,upstream,blockers}` → `--mode watch [--kind …]`; `caretake --mode split #NNN` → `plan --mode epic #NNN`; `hero --mode classify` → internal `--tick`. Any external schedules/scripts invoking the old spellings (e.g. launchd heartbeats invoking `caretake --mode trends`) must be updated by the operator — the modes hard-stop rather than alias.
- **Stale-lock note**: if implementation stalls mid-group, all six issues sit in "In Progress" on one branch; recovery is per-phase git revert, not per-issue.

## References

- Research (authoritative): `thoughts/shared/research/2026-07-26-GH-1590-skill-surface-reduction-sweep.md`
- Plan-of-plans (sequencing superseded by this plan): `thoughts/shared/plans/2026-07-26-GH-1590-plan-of-plans.md`
- Arming-string design record: `docs/superpowers/specs/2026-05-25-autopilot-never-terminate-adaptive-watcher-design.md`
- Issues: #1590 (parent), #1603–#1608 (members), #1588 (epic), GH-1538 (feature = PR unit), GH-1589 (merge gate)
