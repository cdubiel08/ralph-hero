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
review_doc: thoughts/shared/reviews/2026-07-26-GH-1590-critique.md
last_updated: 2026-07-26
last_updated_note: "Iterated against the NEEDS_ITERATION critique (F1, F2, G1-G7); see § Iteration Log"
---

# GH-1590 group plan — Skill surface reduction wave 2 (six siblings, one PR)

## Prior Work

- builds_on:: [[2026-07-26-GH-1590-skill-surface-reduction-sweep]] (research — authoritative reference sweep; corrects several issue-body claims)
- builds_on:: [[2026-07-26-GH-1590-plan-of-plans]] (plan-of-plans — sequencing corrected here, see § Design Decisions)
- iterated_from:: [[2026-07-26-GH-1590-critique]] (review — NEEDS_ITERATION; every finding folded in or rebutted, see § Iteration Log)
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
- **`plan/SKILL.md` sets no `RALPH_SUBCOMMAND` at all** (`grep -rn 'RALPH_SUBCOMMAND' ralph/skills/plan/` → 0 hits), deliberately per `plan/SKILL.md:135` ("No env-flip is needed between modes: the hooks discriminate by the file path being written"). Re-keying the split guards to a plan-context subcommand value therefore requires ADDING the arming step and amending `:135` — see Phase 4 §2.
- **File-path discrimination cannot arm the split guards.** `split-estimate-gate.sh` fires on `get_issue` (Pre/Post) and `split-size-gate.sh` on `create_issue|create_sub_issues` (Pre) — MCP tool payloads with no `file_path` key; only `split-postcondition.sh` (Stop) could in principle inspect written docs. The in-repo precedent that DOES work in this shape is the Step 0 `case` export: `hero/SKILL.md:119-123`, `setup/SKILL.md:62-65`, and the two-valued variant in `caretake/modes/unblock.md:10-14`.
- **The estimate contracts of the two decomposition paths conflict.** `split-size-gate.sh:34` defaults `RALPH_VALID_SUB_ESTIMATES=XS,S`, while plan-of-plans feature children are `S | M` by spec (`decomposition.md:32,62`, M the documented default for L/XL at `:68-70`). One shared scope key across both paths would block every epic with an M child.
- `modes/trends.md:21` is the plugin's **only** `capture_snapshot` call site, and `catch-up --mode report --with-trends` (`catch-up/SKILL.md:146`, `report-composition.md:96`) is a live consumer of the store it appends to — deleting `--mode trends` without rehoming the producer silently degrades `--with-trends` to "insufficient history".
- `ralph/skills/shared/__tests__/loop-continuation.test.sh` hard-codes `caretake:trends` (`:59`), `caretake:debug` (`:94`) and `caretake:split` (`:95`) as manifest keys; `loop-refusal.test.sh:105-116` parses the `ralph/CLAUDE.md` suitability matrix for `prove`/`narrative`/`postmortem`/`retro`. Both break in this plan and both are CI-silent.
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
- Local (CI-silent) shared tests — **all four affected, not two** (G3): `loop-arg-strip.test.sh` (Phase 5), `auto-alias.test.sh` (Phase 6), `loop-continuation.test.sh` (Phases 1, 3, 4 — hard-codes `caretake:trends` `:59`, `caretake:debug` `:94`, `caretake:split` `:95`), `loop-refusal.test.sh` (Phases 1, 5, 6 — parses the `ralph/CLAUDE.md` matrix Phase 5 collapses). `mcp-prefix.test.sh` is untouched. Run: `for t in ralph/skills/shared/__tests__/*.test.sh; do bash "$t" || echo "FAILED: $t"; done`.
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

- **Merged decomposition surface lives in plan context** (`plan --mode epic`) — options: plan; caretake. **Decided: plan.** Both enforcement gates (`plan-research-required.sh` Write gate, `doc-structure-validator.sh` Stop gate) are already armed there — moving split INTO plan context *adds* the shape enforcement split currently lacks, and deletes the hook-evasion rationale outright.
- **Split-hook scope key under `--mode epic`** — options: one shared `RALPH_SUBCOMMAND=epic` for both decomposition paths; a path-scoped `RALPH_VALID_SUB_ESTIMATES` widening; a distinct scope value per path. **Decided: distinct scope value — `epic` for plan-of-plans, `epic-split` for the atomic path**, with all three split hooks keyed to `RALPH_COMMAND=plan` + `RALPH_SUBCOMMAND=epic-split`. A single shared key is not implementable: the size gate blocks any child ∉ `{XS,S}` (`split-size-gate.sh:34,38-56`) while plan-of-plans children are `S | M` by spec (`decomposition.md:32,62,68-70`), so one key either disarms the guards or blocks every epic with an M feature child. The two-valued export mirrors `caretake/modes/unblock.md:10-14` (one mode, two hook-visible variants). `epic-split` is an internal env value, not a mode row — mode count unchanged.
- **Where the scope value is armed** — **Decided: a Step 0 `case` export in `plan/SKILL.md`** (mirroring `hero/SKILL.md:119-123` and `setup/SKILL.md:62-65`) plus a re-export to `epic-split` inside `decomposition.md`'s `## Atomic split` entry (mirroring `unblock.md:10-14`). `plan/SKILL.md:135`'s "No env-flip is needed between modes" sentence is amended in the same edit — it is true for the file-path-discriminated doc hooks and false once the split guards land. Without this step the re-keyed guards fall through their `!= "epic-split"` early-exits (`split-estimate-gate.sh:31`, `split-size-gate.sh:27`, `split-postcondition.sh:22`) and all three guarantees silently vanish.
- **Merged `--mode watch` loop-suitability** — options: leave fan-out-only (status quo of the manifest); make it loop-suitable. **Decided: loop-suitable.** `ralph/CLAUDE.md:76-78` already advertises all three watchers as `--loop` Yes / heartbeat, but `loop-wrapper.md:36-55` has **no `caretake:watch-*` rows** and `caretake/SKILL.md:122` has no watch branch — the promise is unbacked today. Phase 3 adds ONE `caretake:watch` heartbeat manifest row and one routing branch, which is strictly less surface than three phantom matrix rows and gives the merged mode a real continuation contract.
- **Snapshot producer after `--mode trends` dies** — options: accept the degradation; rehome the call. **Decided: rehome.** `modes/trends.md:21` is the only `capture_snapshot` call site in the plugin and `catch-up --mode report --with-trends` still reads that store. Phase 1 moves a bare one-line `capture_snapshot` call into `modes/hygiene.md` (already the 1h heartbeat and already inside the `--mode all` fan-out). Cadence changes 6h → 1h; snapshot rows are small and `metrics_trends` windows are day-scale, so this is a strict improvement in history density. No new mode, no new tool.
- **`caretake:split` drain loop retires without a plan-side replacement** — `plan --mode epic` is `--loop`-unsuitable (`plan/SKILL.md:139`, `ralph/CLAUDE.md`), so the "drain the M/L/XL queue" loop capability ends here. Named, not hidden: atomic split becomes one-issue-at-a-time, dispatched by hero's SPLIT phase (`dispatch.md:9`) and by triage's `SPLIT` verdict (`modes/triage.md:106`) — both already per-issue. Restoring a queue drain would be new capability, out of scope.
- **`loop-refusal.test.sh` after the `ralph/CLAUDE.md` matrix collapses** — options: delete the test; retarget it. **Decided: retarget to `loop-wrapper.md`.** Phase 5 moves the matrix's unsuitable ("No") rows into a `## Unsuitable surfaces` section of `loop-wrapper.md` and repoints the test's section-4 checks there. The canonical refusal string is left byte-identical (it names `ralph/CLAUDE.md`, and the test asserts it verbatim at `:63-67`); `ralph/CLAUDE.md` keeps a `## Loop suitability` pointer section so that reference still resolves.
- **Watch token family** — **Decided: `WATCH-<KIND> ADVANCED <N>` / `WATCH-<KIND> IDLE` / `WATCH-<KIND> SKIPPED — branch <name> is not main`, `KIND ∈ {PR, UPSTREAM, ISSUE}`.** watch-blockers' two-number `<m> still blocked` moves to summary prose — nothing executable greps it (research: no hook greps `WATCH-*`; the only consumer is the doc-structure test being rewritten anyway).
- **Classify fold mechanism** — **Decided: internal `--tick` entrypoint.** `--mode auto`'s inner loop command becomes `Run /ralph:hero --tick on the next-most-important event…`; Step 0 routes `--tick` to the tick section (the former classify steps 1–6, verbatim, `audience:"agent"` preserved); `--tick` appears in no mode table or argument-hint (not a public mode, counts zero). Arming grep in `autopilot-director-postcheck.sh:56` becomes `grep -q -- '/ralph:hero --tick'` — unique across all loop wrappers (no other inner command contains it), preserving the design record's uniquely-identifying-string requirement. `result:` lines unchanged, so wakeup cadence marks survive.
- **`--kind issue` dispatch coverage** — **Decided: fan-out-only** (status quo for watch-blockers: hero classifies only `blocked:pr-*`/`blocked:upstream`). Adding a `blocked:*` tier row for dependency-parked items would be new capability — out of scope.
- **Prove rehoming shape** — options: own surface; fold into default intake. **Decided: fold.** A claim is a research question with a verdict-shaped answer; `research/intake-routing.md` rule 4 (free-form) absorbs it, the verdict rubric moves into `findings-format.md`, and `hero/dispatch.md:10`'s claim-check option is deleted (nothing defines a claim-check event — the evidence-consistent move per research Open Q4). Capability preserved: claim-shaped free-form intake produces a verdict-first summary.
- **Taxonomy home** — **Decided: new `ralph/skills/shared/event-taxonomy.md`**; both `label-routing.md` and `event-classes.md` deleted, all references repointed. Reconciliation of the 3 conflicting rows is specified in Phase 5.
- **`loop-arg-strip.test.sh` copy** — **Decided: extract the snippet from `loop-wrapper.md` at test time** (awk between fences) instead of keeping a third copy — true single-sourcing; fixes the existing 1-token drift by construction. Mechanism specified in Phase 5 §2 (the harness contract at `:23-35` is NOT part of the extracted text).
- **`--mode all` fan-out end state** — Phase 1 leaves 6 children ("6 total"); Phase 3 leaves 4 ("4 total"): hygiene, watch, enrich, report. Bare `--mode watch` (no `--kind`) sweeps all three kinds serially so the fan-out needs one row, not three.

None — no open design decisions.

## Implementation Approach

Six phases, one per member, in corrected dependency order: 1603 → 1606 → 1604 → 1605 → 1607 → 1608. Deletions first (they shrink everything downstream), hero classify fold before the watch merge (shared `hero/SKILL.md` lines), decomposition consolidation independent after the deletions, substrate dedup after all row churn, closeout last. Shared files (`caretake/SKILL.md`, `outcome-tokens.md`, `loop-wrapper.md`, `ralph/CLAUDE.md`, root `CLAUDE.md`, `README.md`) are touched by multiple phases — ownership is sequential; each later phase edits the file as left by the earlier phase. The tripwire tests (`caretake-watch-blockers.test.sh`, `hero-classify-audience.test.sh`, `autopilot-auto-watcher.test.sh`) are updated in the same phase as the surface they anchor on.

## Phase 1: GH-1603 — Delete dead caretake + catch-up modes (debug, postmortem→reflect, trends, narrative, dashboard)

- **depends_on**: null

### Overview

Delete `caretake --mode debug|postmortem|trends` and `catch-up --mode narrative|dashboard`; rename `retro` → `reflect` as the single reflection mode. Caretake **14 → 11** modes (three deletions; `retro`→`reflect` is a rename, not a removal — G6 correction), catch-up 5 → 3.

### Changes Required

#### 1. Mode bodies (delete/rename)

- DELETE `ralph/skills/caretake/modes/debug.md`, `modes/postmortem.md`, `modes/trends.md`.
- RENAME `ralph/skills/caretake/modes/retro.md` → `modes/reflect.md`; fold postmortem's surviving session-reflection intent into it and unwind the retro↔postmortem coupling (`retro.md:11,29,39,42,50` team-session dedup prompt offering `--mode postmortem` — delete that prompt; `outcome-tokens.md:66` `RETRO SKIPPED team-session-redirect` token — delete). Retro's token family renames `RETRO *` → `REFLECT *`.
- **Capability accounting**: debug — dead by default env (`collate_debug` unrostered in `caretake/SKILL.md:51-84`, registered only under `RALPH_DEBUG=true`, hardcoded Langfuse path); replacement: none needed — Langfuse-trace investigation remains available manually via the debug tools when `RALPH_DEBUG=true`. postmortem — its data producer (team/worker sessions) was deleted in GH-1438; it degenerates to `POSTMORTEM SKIPPED no-session-data` (`postmortem.md:19`); replacement: `reflect`. trends — two MCP calls (`trends.md:21,27`); replacement: **the producer is rehomed, not dropped** (G4). `modes/trends.md:21` is the plugin's ONLY `capture_snapshot` call site and `catch-up --mode report --with-trends` (`catch-up/SKILL.md:146`, `report-composition.md:96`) still reads that JSONL store — deleting the mode with no producer would silently degrade `--with-trends` to the "insufficient history" payload as the rolling window advances. So: add a bare one-line `capture_snapshot` call (no arguments, no new mode) as the last step of `ralph/skills/caretake/modes/hygiene.md`, which is already the 1h heartbeat and already item 1 of the `--mode all` fan-out. Cadence 6h → 1h; rows are small and `metrics_trends` windows are day-scale. Keep `capture_snapshot` in `caretake/SKILL.md:79` allowed-tools; DELETE `metrics_trends` from `:80` (no surviving caretake mode calls it — `catch-up/SKILL.md:26` has its own entry). The markdown trend *report* is the only capability actually removed; `metrics_trends` remains reachable via `catch-up --mode report --with-trends`.

#### 2. Caretake dispatch + reference surface

**File**: `ralph/skills/caretake/SKILL.md`
- `:2,3` description/argument-hint mode enumerations; `:48` DELETE `postmortem-completeness.sh` registration; `:88` prose "Twelve named modes plus a default event-driven dispatcher" → the post-phase count (already drifted — 13 named rows today, 10 after this phase) (G1); `:93` `all`-row role text drops "+ trends" (G1); `:97-100` mode-table rows (postmortem/retro→reflect, trends, debug); `:122,124,126` `--loop` routing rows (`:124` refusal list: `--mode retro` → `--mode reflect`); `:144-152` `--mode all` fan-out: drop item 7 (trends) → 6 children, reword `:152` "one line per child — **6 total**"; `:163-166` mode-bodies links; `:181-184` token quick-ref lines.

**File**: `ralph/skills/caretake/outcome-tokens.md` — delete `## Debug terminal tokens` (`:76-82`), postmortem + retro sections (`:55-70`, retro→reflect), trends section (`:72-74`), drain-modes list (`:130,132`), and the four "parity with hygiene/trends" prose hits (`:99,107,115,124`).

**File**: `ralph/skills/caretake/label-routing.md` — `:11` "Full fan-out (all 8 modes serially)" → 6 (G1); `:14` `trends-check` row DELETE; `:17` `process-improvement` row retargets `--mode retro` → `--mode reflect`; `:18` `debug-auto` row DELETE; `:24` "the dispatcher invokes **all eight modes serially**" → six (G1); `:22-35` `trigger:caretake` fan-out: delete item 5 (debug) and item 6 (postmortem), retarget item 7 retro → reflect → 6-item fan-out; `:48` idempotency prose drops `debug-auto` from the state-label list (G1).

#### 3. Hero call sites (the corrections — debug is NOT unreachable)

**File**: `ralph/skills/hero/watch-dispatch.md` — `:3` intro line ("routing watcher events to gcp-incident-triage / debug-collate / log-reader / sre-fixit") drops `debug-collate`, and `:50` drops the `RALPH_DEBUG` preflight log line `debug-collate skipped: RALPH_DEBUG unset` (both found while validating the bare-token sweep below). `:26` `langfuse-trace:` row: DELETE the `--mode debug` dispatch; replace action with `Agent(subagent_type="ralph:log-reader", …)` (the adjacent `watcher-investigate` pattern at `:27`) so trace-bearing issues still get an investigation path. `:51` heartbeat debug-collate step: DELETE (with its `RALPH_DEBUG` preflight); renumber step 5. `:54` result template `result: heartbeat: N alerts dispatched, M debug-collate issues filed` → drop the debug-collate clause — it counts the step deleted at `:49-51` (G1).
**File**: `ralph/skills/hero/event-classes.md` — `:37,93` `debug-auto` producer/consumer rows DELETE; `:80` Priority-3 automation-label list drops `debug-auto` (G1).
**File**: `ralph/skills/hero/SKILL.md` — `:92` watch-mode role text drops "debug-collate".

#### 4. Catch-up mode branches (fragments stay)

**File**: `ralph/skills/catch-up/SKILL.md` — `:9,10` description/argument-hint; `:48` refusal-list mention; `:55-56` mode-table rows (narrative, dashboard); `:113-117` `--mode narrative` branch DELETE; `:119-130` `--mode dashboard` branch DELETE; `:165` sibling-list entry. **Keep** `narrative-synthesis.md` (default Step 1 consumes it, `SKILL.md:65,77`) and `dashboard-render.md` (`brief-composition.md:51` inherits its never-editorialize list). Keep `catch-up-agent`.

**The two kept fragments name the deleted modes and must be reworded in this phase** (G2 — otherwise the phase sweep cannot pass at its own boundary):
- `ralph/skills/catch-up/dashboard-render.md:3` ("consulted by `/ralph:catch-up --mode dashboard`") → "consulted by `/ralph:catch-up --mode brief` (`brief-composition.md:51`)"; `:34` ("`--mode dashboard` is a **read-only, passive render**…") and `:44` ("belong to `/ralph:caretake` — NOT to `--mode dashboard`") → restate the constraint about *this render fragment* rather than a mode.
- `ralph/skills/catch-up/narrative-synthesis.md:63` — the caller list reads "the interactive `/ralph:catch-up` default flow, the `--mode narrative` branch, or a programmatic invoker like `cos`" → drop the `--mode narrative` clause. **This corrects the critique**, whose G3 parenthetical claims `narrative-synthesis.md:63` is not a sweep hit because the line reads "Return only the narrative text". Both statements are on `:63`; `grep -n -- '--mode narrative' ralph/skills/catch-up/narrative-synthesis.md` returns `63`. The original review pass was right; the correction was wrong.
- `ralph/skills/caretake/modes/watch-pr.md:11` — parity note "(parity with `--mode hygiene`/`--mode trends`)" → drop the trends half (G2). The file is deleted in Phase 3, but Phase 1's sweep runs first, so the one-token edit lands here.

#### 5. Hooks, tests, docs

- DELETE `ralph/hooks/scripts/postmortem-completeness.sh` (registration deleted above; no dedicated test exists — deletion is test-silent).
- **File**: `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh:124` — `"7 total"` → `"6 total"` (full rewrite comes in Phase 3; this phase only keeps it green).
- **File**: `ralph/skills/shared/loop-wrapper.md:48-49` — delete the `caretake:trends` and `caretake:debug` manifest rows. **Correction (G1)**: there is no `caretake:retro` manifest row to update — the full caretake set is `triage` (`:45`), `hygiene` (`:46`), `unblock` (`:47`), `trends` (`:48`), `debug` (`:49`), `split` (`:50`), `all` (`:51`), `default-event` (`:52`); retro is loop-refused at `caretake/SKILL.md:124`, so the only retro→reflect edit is that refusal list.
- **File**: `ralph/skills/shared/__tests__/loop-continuation.test.sh` (CI-silent — run by hand) — remove `"caretake:trends"` from `HEARTBEAT_MODES` (`:59`) and `"caretake:debug"` from `DRAIN_MODES` (`:94`). Both assert "manifest row exists" and fail the moment those rows are deleted (G3).
- **File**: `ralph/skills/shared/__tests__/loop-refusal.test.sh` (CI-silent) — drop the `catch-up default/narrative` (`:112`), `caretake postmortem` (`:115`) and `caretake retro` (`:116`) checks; add a `caretake reflect` check. These parse the `ralph/CLAUDE.md` matrix rows this phase deletes (G3). Phase 5 retargets the same section at `loop-wrapper.md`.
- **File**: `ralph/CLAUDE.md` — matrix rows `:73-74` (trends, debug) DELETE, `:81-82` (postmortem, retro) → single reflect row, `:86-87` (narrative, dashboard) DELETE.
- **File**: root `CLAUDE.md` — verb-table one-liners. **Corrected refs (G5)**: the caretake row is `:75` (not `:71`) — "Caretaking: triage, hygiene, unblock, trends, split, debug, report" drops "trends" and "debug". The catch-up row is `:69` (not `:78`) and reads "Orientation: narrative + picker or single-surface mode" — it contains no "dashboard", and its "narrative" names the SURVIVING default narrative. The stale phrase is "single-surface mode"; edit that, and do NOT strip "narrative" (the plan's original instruction would have made the row less accurate).
- **File**: `README.md:78-79` — caretake one-liner (`:78`, drops trends/debug) and catch-up one-liner (`:79`, "narrative, dashboard, or status report" → drops "dashboard").

### Success Criteria

#### Automated Verification
- [ ] `grep -rn -- '--mode debug\|--mode postmortem\|--mode trends\|--mode narrative\|--mode dashboard\|--mode retro' ralph/ scripts/ CLAUDE.md README.md` → 0 hits. **Passable at this boundary only because §4 rewords `dashboard-render.md:3,34,44`, `narrative-synthesis.md:63` and `watch-pr.md:11`** — those were the three unowned hits that made this sweep unachievable as originally written (G2).
- [ ] Bare-token residue sweep (catches the non-`--mode` spellings — G1; token set validated against today's tree so the target is reachable): `grep -rn 'debug-auto\|debug-collate\|postmortem-completeness\|trends-check\|RETRO ' ralph/ scripts/ CLAUDE.md README.md` → 0 hits. Current owners of each: `debug-auto` → `label-routing.md:18,48`, `event-classes.md:37,80,93`; `debug-collate` → `watch-dispatch.md:3,50,54`, `hero/SKILL.md:92`; `RETRO ` → `caretake/SKILL.md:182`, `outcome-tokens.md:65-68`, `modes/retro.md:277,283` (all renamed to `REFLECT`).
- [ ] `grep -rln 'postmortem-completeness' ralph/` → 0 hits
- [ ] `grep -rn 'capture_snapshot' ralph/skills/caretake/modes/hygiene.md` → ≥1 hit (**fails if the snapshot producer was dropped rather than rehomed** — G4)
- [ ] `find ralph/hooks/scripts/__tests__ scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash` → all pass (incl. the "6 total" edit)
- [ ] Local (CI-silent): `bash ralph/skills/shared/__tests__/loop-continuation.test.sh` and `bash ralph/skills/shared/__tests__/loop-refusal.test.sh` both exit 0
- [ ] `bash scripts/check-doc-rosters.sh` exits 0
- [ ] `shellcheck -S error ralph/hooks/scripts/*.sh` clean
- [ ] `ls ralph/skills/catch-up/narrative-synthesis.md ralph/skills/catch-up/dashboard-render.md ralph/agents/catch-up-agent.md` — all three still exist

#### Manual Verification
- [ ] `/ralph:catch-up` (default) still produces the narrative via catch-up-agent; `--mode brief` still renders with the inherited never-editorialize constraints
- [ ] `/ralph:caretake --mode reflect` runs the former retro flow without offering a postmortem redirect
- [ ] `/ralph:caretake` (no args) fan-out reports 6 children, and a hygiene run appends one row to `~/.ralph-hero/snapshots/<owner>/<projectNumber>.jsonl`
- [ ] `/ralph:catch-up --mode report --with-trends` still renders a `## Trends` section after ≥2 hygiene heartbeats

## Phase 2: GH-1606 — Remove `hero --mode classify` as a public mode; fold into `--mode auto`

- **depends_on**: [phase-1]

### Overview

Classify becomes the internal `--tick` entrypoint of `--mode auto`. Hero 5 → 4 modes. Serialized BEFORE the watch merge because this phase relocates `hero/SKILL.md:156-157`, which Phase 3 then edits in place.

### Changes Required

#### 1. Hero skill body

**File**: `ralph/skills/hero/SKILL.md`
- `:2,3` description/argument-hint drop classify; `:85` intro "fans out to **four** mode-specific orchestrations" → three (G1); `:91` mode-table row DELETE; `:120` `RALPH_SUBCOMMAND=classify` case → `--tick` case (export `RALPH_SUBCOMMAND=auto`; no hook consumes a `tick` value — research: nothing keys on `RALPH_SUBCOMMAND=classify` either); `:127` loop-gate note; `:150-160` `## --mode classify` section → `## Auto tick (internal — dispatched only by --mode auto's loop wrapper)` housing the former steps 1–6 verbatim, **including** the step-2 `next_actions({ audience: "agent" })` requirement and its rationale, and the steps 3–4 `DISPATCH_ARG`/board-wide-sweep text (Phase 3 edits those lines next); `:143` default-mode cross-ref rewording (human-vs-agent audience split now references the tick); `:165` inner command → `Run /ralph:hero --tick on the next-most-important event…`; `:174,195` result-line callout + pr-drain intro rewording.
- **Correction (G5)**: the plan previously said "`:167-170` continuation contract unchanged". The *contract* is unchanged (`result: Dispatched #NNN …` / `result: Queue empty.` both still re-fire, bullets `:168-169` untouched), but two lines in that region embed the old spelling and MUST change: `:170` carries the arming string verbatim ("armed once `Skill("loop", …--mode classify…)` is observed") and `:172` reads "`/loop` and `--mode classify` own that". Also `:174`'s callout block repeats "`--mode auto` wraps `--mode classify`". The `--mode classify` sweep catches all three, but they belong in the change list for a top-down implementer.
- **Capability preserved**: agent-audience queue read (XS/S `audiencePenalty`, Backlog-fallback), one-tick-per-dispatch, never-terminate contract.

#### 2. Arming hook (silent-fail-open tripwire)

**File**: `ralph/hooks/scripts/autopilot-director-postcheck.sh:56` — `grep -q -- '--mode classify'` → `grep -q -- '/ralph:hero --tick'`. This is the ONLY *behavioural* hook coupling (research correction: no hook keys on `RALPH_SUBCOMMAND=classify`). `autopilot-enable-gate.sh` and `autopilot-wakeup-clear.sh` are functionally unaffected.
**Comment residue in the same two files (G1 — the plan previously declared stop-gate "unaffected", true of behaviour but not of text)**: `autopilot-director-postcheck.sh:16,18,51,52` and `autopilot-stop-gate.sh:10` all spell `--mode classify` in header comments describing the arming contract. Update them in this phase — the phase sweep greps `ralph/` including `hooks/scripts/`, so leaving them fails the check.

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

One `modes/watch.md` with a per-kind table replaces three 86/88/91-line bodies. Caretake **11 → 9** modes (G6 correction: Phase 1 lands at 11, not 10 — `retro`→`reflect` was a rename; the final 8 comes after Phase 4 removes split). Runs after Phase 2 so the hero dispatch lines it rewrites are already in their tick-section home.

### Changes Required

#### 1. Merged mode body

**File**: `ralph/skills/caretake/modes/watch.md` (NEW; DELETE `watch-pr.md`, `watch-upstream.md`, `watch-blockers.md`)
- Shared skeleton (identical today, research § What is identical): `export RALPH_SUBCOMMAND=watch` fence; branch guard (`git branch --show-current` off-main → `WATCH-<KIND> SKIPPED — branch <name> is not main`); IDLE path; no-Stop-hook preamble; `command: "ralph_triage"` unguarded-transition note; explicit-labels-array warning; §Constraints closer.
- Per-kind table (the 6-axis diff from research § #1604): match predicate (pr: Backlog + `^blocked:pr-([0-9]+)$` regex; upstream: Backlog + server-side `label: "blocked:upstream"`; issue: Human Needed + Backlog sweeps, `blockedBy` edge or `## Escalation` body), resolution predicate (pr: `gh pr view --json state,mergedAt` → MERGED; upstream: per-URL-type conservative check; issue: ALL blockers CLOSED via `get_issue`), action on resolution (pr: strip label + deferred 4-verdict map + `## Watch-PR Resolution` comment; upstream: strip label + promote-family-only + `## Watch-Upstream Resolution`; issue: `remove_dependency` + advance + strip `blocked:*`+`ralph-triage` + `## Unblocked`), escalation (pr: closed-unmerged → Human Needed; upstream: dead URL → Human Needed, 5xx transient → leave; issue: none — leave and count).
- Bare `--mode watch` (no `--kind`) = all three kinds serially. Tokens: `WATCH-<KIND> ADVANCED <N>` / `IDLE` / `SKIPPED — branch <name> is not main`; blockers' `<m> still blocked` becomes summary prose.

#### 2. Caretake dispatch surface

**File**: `ralph/skills/caretake/SKILL.md` — `:2,3` enumerations; `:88` named-mode count prose (again — G1; 10 → 9 after this phase); `:93` all-row; `:102-104` three mode rows → one; `:146-148` fan-out items 2–4 → one `Skill("ralph:caretake", args="--mode watch")` → **4 children**, `:152` → "**4 total**"; `:168-170` mode-body links → `modes/watch.md`; `:186-188` token quick-ref → new family.
**File**: `ralph/skills/caretake/modes/enrich.md:11` — parity note "(parity with `--mode hygiene`/`--mode watch-pr`)" → `--mode watch` (G1 — this file is a sweep hit the phase did not list).
**File**: `ralph/skills/caretake/outcome-tokens.md` — `:16-18` triage tokens naming the watchers (`WAIT-pr`/`WAIT-upstream`/`WAIT-issue` consumers); `:93-115` three token sections → one; `:124,132`.
**File**: `ralph/skills/caretake/modes/triage.md:92-93,109-111,115-117,167,201,259-261` — producer-side prose: `caretake --mode watch-pr` → `--mode watch --kind pr` etc.
**Correction honored**: `label-routing.md` has NO watch/`blocked:*` rows — nothing to edit there (the issue body's claim is false; the asymmetry is Phase 5 evidence).

#### 3. Hero call sites (in the tick section Phase 2 created)

**File**: `ralph/skills/hero/SKILL.md` tick steps 3–4 (formerly `:156-157`) — `DISPATCH_ARG="--mode watch-pr"` → `"--mode watch --kind pr"`; `"--mode watch-upstream"` → `"--mode watch --kind upstream"`; step-4 examples likewise (board-wide sweep semantics unchanged).
**File**: `ralph/skills/hero/event-classes.md:27-28,79` — tier rows + prose restated with `--kind`. (No hero watch-blockers dispatch exists — fan-out-only for `--kind issue`, per resolved decision.)

#### 4. Test rewrite (plan work, not incidental)

**File**: `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` → REWRITE as `caretake-watch.test.sh`. Every current assertion breaks by design: `RALPH_SUBCOMMAND=watch-blockers` fixture (`:78`) → `watch`; three token-shape greps (`:111-118`) → the `WATCH-<KIND>` family incl. the SKIPPED variant; `'mode watch-blockers'` / `"7 total"` (now "6 total" after Phase 1) / `modes/watch-blockers.md` / ≥5-occurrence greps (`:123-127`) → `'mode watch'` / `"4 total"` / `modes/watch.md` / occurrence threshold recomputed against the merged SKILL.md; `## Watch-Blockers terminal tokens` heading + ≥3 occurrences (`:132-135`) → merged section; triage.md `caretake --mode watch-blockers` grep (`:140-147`) → `--kind issue` form.

#### 5. Substrate + docs

- **File**: `ralph/skills/shared/loop-wrapper.md` — **corrected instruction (G1)**: the manifest (`:36-55`) contains **no `caretake:watch-*` rows at all** — the full caretake set is `triage`/`hygiene`/`unblock`/`trends`/`debug`/`split`/`all`/`default-event`. There is nothing to collapse; there is a row to **add**. Per § Design Decisions, insert ONE new `caretake:watch` manifest row: progress sentinels `WATCH-<KIND> ADVANCED <N>`, terminal sentinels *(none — heartbeat; re-fire always)*, default interval `1h`, note "sweeps pr/upstream/issue kinds; bare invocation runs all three serially". This closes the existing drift where `ralph/CLAUDE.md:76-78` advertises the watchers as `--loop`-suitable while neither the manifest nor `caretake/SKILL.md:122` backs it.
- **File**: `ralph/skills/caretake/SKILL.md:122` — add `--mode watch` to the `--loop` routing branch list (`caretake:watch` row, default `1h`, no `Queue empty.` terminal, re-fires on clock). Today `:122` has no watch branch at all.
- **File**: `ralph/skills/shared/__tests__/loop-continuation.test.sh` (CI-silent) — add `"caretake:watch"` to `HEARTBEAT_MODES` (`:57-63`) so the new row is asserted to exist and to carry no `Queue empty.` terminal (G3).
- **File**: `ralph/CLAUDE.md:76-78` — three matrix rows → one `caretake --mode watch` row.
- **File**: `README.md:78` if watch modes named.

### Success Criteria

#### Automated Verification
- [ ] `grep -rn 'watch-pr\|watch-upstream\|watch-blockers' ralph/ scripts/ CLAUDE.md README.md` → 0 hits. Owning-file list verified by `grep -rln` at plan time: `ralph/CLAUDE.md`, `caretake-watch-blockers.test.sh`, `caretake/SKILL.md`, `caretake/outcome-tokens.md`, `modes/watch-{pr,upstream,blockers}.md`, `modes/triage.md`, **`modes/enrich.md`** (added this iteration — G2), `hero/event-classes.md`, `hero/SKILL.md`. All are owned by §1–§5 above.
- [ ] `bash ralph/hooks/scripts/__tests__/caretake-watch.test.sh` passes; old test file gone
- [ ] Full hook-test sweep + ShellCheck + `bash scripts/check-doc-rosters.sh` green
- [ ] Local (CI-silent): `bash ralph/skills/shared/__tests__/loop-continuation.test.sh` exits 0 with the new `caretake:watch` heartbeat row
- [ ] `grep -c 'WATCH-' ralph/skills/caretake/outcome-tokens.md` ≥ 3 (family documented once, all variants present). *Weak on its own — near-unfalsifiable (G2); the real net is the rewritten `caretake-watch.test.sh`, which greps each of the three kind-specific token shapes plus the `SKIPPED` variant by name.*

#### Manual Verification
- [ ] `/ralph:caretake --mode watch --kind pr` on a board with a `blocked:pr-NNN` item: correct predicate, resolution, comment shape
- [ ] `/ralph:caretake --mode watch` (bare) sweeps all three kinds; off-main emits the SKIPPED token
- [ ] Escalation paths intact: closed-unmerged PR → Human Needed; dead upstream URL → Human Needed

## Phase 4: GH-1605 — One decomposition surface (plan `--mode epic`) + `plan-research-required.sh` scoping fix

- **depends_on**: [phase-1]

### Overview

`plan --mode epic` becomes the single decomposition surface (plan-of-plans AND atomic M/L/XL→XS/S split); `caretake --mode split` deleted; `form` Step 6b forwards. The hook gains a legitimate plan-of-plans carve-out so no context-based escape hatch remains. Caretake **9 → 8** modes. Parallel-safe with Phases 2–3 except a trivial disjoint-line overlap in `hero/dispatch.md` (SPLIT row `:9` vs classify notes `:3,20`) — kept sequential here for one-branch simplicity.

**Rewritten this iteration (critique F1 + F2).** The two decomposition paths that now share `--mode epic` have incompatible child-estimate contracts, and the plan skill exports no `RALPH_SUBCOMMAND` at all. §2 below specifies the arming step and the per-path discriminator; §5 adds a check that fails when the guards are dead.

### Changes Required

#### 1. Hook scoping fix (the fork's stated reason dies here)

**File**: `ralph/hooks/scripts/plan-research-required.sh` — insert a discrimination branch between steps 3 and 4 (i.e. after the `GH-` token check at `:47-50`, before the research-doc lookup at `:52-57`): parse `.tool_input.content`, fence-strip, and if it matches `^type:[[:space:]]*plan-of-plans` OR `^## Feature Decomposition`, allow-with-context — mirroring `doc-structure-validator.sh:60-69`'s existing discriminator. Hole bounded: a mislabeled implementation plan then fails the plan skill's Stop-side shape enforcement (`doc-structure-validator.sh:68-93` requires `## Feature Decomposition` + `## Feature Sequencing` + Design Decisions).
**File**: `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` — add carve-out cases (plan-of-plans content allowed without research doc; fence-wrapped variant; ordinary plan still blocked), using the existing SBX/REPO/NOGIT harness.

#### 2. Split hooks: arm, discriminate, re-key, re-register (all four, or they no-op or regress epic)

Three separate steps are required. Doing any subset silently breaks something:

**(a) Arm `RALPH_SUBCOMMAND` in plan context.** `grep -rn 'RALPH_SUBCOMMAND' ralph/skills/plan/` returns **nothing** today, and `plan/SKILL.md:135` states the omission is deliberate ("No env-flip is needed between modes: the hooks discriminate by the file path being written"). That statement is true for plan's current hooks and false once the split guards land — the split gates fire on `get_issue` / `create_issue|create_sub_issues` (MCP payloads with **no `file_path` key**) and on Stop, so file-path discrimination cannot arm them. Add a Step 0 `case` export to `ralph/skills/plan/SKILL.md`, mirroring `hero/SKILL.md:119-123` and `setup/SKILL.md:62-65`:

```bash
case "$ARGUMENTS" in
  --mode\ auto*)    export RALPH_SUBCOMMAND=auto ;;
  --mode\ epic*)    export RALPH_SUBCOMMAND=epic ;;
  --mode\ iterate*) export RALPH_SUBCOMMAND=iterate ;;
  --mode\ review*)  export RALPH_SUBCOMMAND=review ;;
  *)                export RALPH_SUBCOMMAND=default ;;
esac
```

Amend `plan/SKILL.md:135` in the same edit: the file-path-discrimination sentence keeps its scope (review-no-dup / review-verify-doc / doc-structure-validator / state-gate) and gains "the `split-*` gates are the exception — they fire on MCP tool payloads and Stop, and key on `RALPH_SUBCOMMAND` set at Step 0."

**(b) Discriminate the two decomposition paths.** `--mode epic` now serves both plan-of-plans and atomic split, and their child-estimate contracts conflict: `split-size-gate.sh:34,38-56` blocks any child ∉ `RALPH_VALID_SUB_ESTIMATES` (default `XS,S`), while plan-of-plans feature children are `S | M` by spec (`decomposition.md:32`, `:62`, with M the documented default for L/XL at `:68-70`). A single shared scope key blocks every epic with an M feature child — a regression of an existing capability. So the atomic path gets its **own** scope value: the `## Atomic split` entry in `decomposition.md` re-exports `RALPH_SUBCOMMAND=epic-split` before any `get_issue` / `create_sub_issues` call (the two-valued-mode precedent is `caretake/modes/unblock.md:10-14`, whose two hook-visible variants live under one mode). `epic-split` is an internal env value, never a mode-table row — the mode count is unaffected.

**(c) Re-key the guards to the atomic value.** **Files**: `ralph/hooks/scripts/split-estimate-gate.sh:30-32`, `split-size-gate.sh:26-28`, `split-postcondition.sh:21-23` — scope guards `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=split` → `RALPH_COMMAND=plan` + `RALPH_SUBCOMMAND=epic-split`. Guarantees preserved verbatim on the atomic path: Pre/Post estimate gate (parent ∈ M/L/XL), size gate (children ∈ XS/S, batch + scalar), ≥2-children Stop postcondition via `RALPH_SPLIT_COUNT` (env-var-trust, NOT transcript grep — research correction of `split-decomposition.md:98`). Also update each script's block message, which names `/ralph:caretake --mode split` (`split-size-gate.sh:47`).

**What each registration does on the plan-of-plans path** (`RALPH_SUBCOMMAND=epic`) — all three early-exit at their scope guard, i.e. behave exactly as they do today when caretake is not in split mode:

| Hook | Event | Plan-of-plans (`epic`) | Atomic split (`epic-split`) |
|---|---|---|---|
| `split-estimate-gate.sh` | Pre+Post `get_issue` | early-exit `allow` — epic parents are fetched without an M/L/XL assertion | blocks when the parent is XS/S |
| `split-size-gate.sh` | Pre `create_issue`/`create_sub_issues` | early-exit `allow` — **S and M feature children pass**, per `decomposition.md:32,62` | blocks any child ∉ `{XS,S}` |
| `split-postcondition.sh` | Stop | early-exit `allow` — a pure plan-of-plans session never reaches the `RALPH_SPLIT_COUNT` check, so an unset counter can never block it | blocks Stop when `RALPH_SPLIT_COUNT < 2` with `RALPH_TICKET_ID` set |

**(d) Re-register.** **File**: `ralph/skills/plan/SKILL.md` frontmatter — ADD the four registrations (estimate-gate Pre+Post on `get_issue`, size-gate Pre on `create_issue|create_sub_issues`, postcondition Stop). **File**: `ralph/skills/caretake/SKILL.md` — REMOVE the four registrations (`:16-34` Pre/Post pairs, `:46` Stop). Re-registration without (a)+(c) leaves the guards no-op; (a)+(c) without re-registration means the hooks never run at all.

**File**: `ralph/hooks/scripts/__tests__/split-size-gate.test.sh` — env fixtures re-keyed to `RALPH_COMMAND=plan` + `RALPH_SUBCOMMAND=epic-split`.

#### 3. Merge the surfaces

- DELETE `ralph/skills/caretake/modes/split.md` and `ralph/skills/caretake/split-decomposition.md`. Salvage into **`ralph/skills/plan/decomposition.md`**: an `## Atomic split` section (the `export RALPH_SUBCOMMAND=epic-split` fence from §2(b) FIRST, then M+ parent analysis rules, `create_sub_issues` batch with inline `dependsOn`, `## Issue Split` comment shape, child-state `batch_update`, `SPLIT <N>` terminal token, `RALPH_SPLIT_COUNT` export) alongside the existing plan-of-plans shape. The salvaged section restates the four-hook contract table from `split-decomposition.md:91` with the new keys. Delete both hook-evasion statements (`split-decomposition.md:85`, `modes/split.md:140`) with the files.
- **File**: `ralph/skills/plan/SKILL.md:167-179` — epic-mode body absorbs the atomic-split path (epic-shaped input → plan-of-plans; M+ atomic input → XS/S split); note `decompose_feature` remains rostered-but-uninvoked (`:100`) — leave for #1591/#1612 (tool surface is out of scope).
- **File**: `ralph/skills/form/SKILL.md:138-146` — Step 6b's inline parent+children `create_sub_issues` shape → forward: create the parent only, then instruct `/ralph:plan --mode epic #<parent>` for the tree (form registers no hooks today, so its inline path was gate-free; forwarding closes that too). Capability preserved: intake can still produce a tree, now through the gated surface.
- **File**: `ralph/skills/caretake/SKILL.md` — split rows out. **Corrected refs (G5)**: the split mode-table row is **`:101`**, not the `:96` region (`:96` is the `unblock` row); `:122` (`--loop` routing) and `:185` (token quick-ref) are correct as written. Additional split-bearing lines the phase did not list (G1): `:2` and `:3` frontmatter enumerations carry `split` inside the pipe-alternation (`…|debug|split|watch-pr|…`), not as `--mode split`, so the `--mode split` sweep misses them; `:88` named-mode count prose (9 → 8); `:107` references `split-decomposition.md` in the References line; `:167` `[modes/split.md](modes/split.md)` mode-bodies link. `--auto`→triage keeps emitting `SPLIT` verdicts.
- **File**: `ralph/skills/caretake/modes/triage.md:106` — verdict table row `` `SPLIT` `` → action `caretake --mode split` becomes `/ralph:plan --mode epic #NNN` (G1 — the producer of every `SPLIT` verdict; the phase never listed triage.md).
- **File**: `ralph/skills/caretake/label-routing.md` — `:11` fan-out row "6 modes" → 5 and `:24` "six modes serially" → five (both amended by Phase 1 first — G1); `:19` `needs-split` row → `/ralph:plan --mode epic #NNN`; `:28` `trigger:caretake` fan-out item 3 (split) DELETE → 5-item fan-out; `:48` idempotency prose keeps `needs-split` (still a state label, now owned by plan).
- **File**: `ralph/skills/caretake/outcome-tokens.md:84-91` — split token section moves to plan's documentation (token family unchanged: `SPLIT <N>`, `Queue empty.`); `:130` drain-modes list drops `split` (G1 — bare token, not a `--mode` spelling); `:13` the surviving `TRIAGED SPLIT` row's clause "`--mode split` / the picker doesn't re-select it" retargets to `/ralph:plan --mode epic` (round-2 GAP — the plan's own file list missed this line).

#### 4. Hero SPLIT dispatch call sites

**File**: `ralph/skills/hero/dispatch.md:9` SPLIT row → `/ralph:plan --auto --mode epic` args `#NNN`; `:26` Skill-vs-Agent table; `:96` split-failure row.
**Files**: `ralph/skills/hero/state-machine.md:18,76,88`; `ralph/skills/hero/task-graph.md:11,14-15,97` — SPLIT phase now dispatches plan.
**Files**: `ralph/skills/shared/loop-wrapper.md` — **DELETE the `caretake:split` manifest row with no plan-side replacement**, not "→ plan-side entry" as originally written: `plan --mode epic` is `--loop`-unsuitable (`plan/SKILL.md:139` refuses it; `ralph/CLAUDE.md` matrix agrees), so there is no row to move it to. Capability accounting: the "drain the M/L/XL queue on a loop" capability ends here; atomic split becomes one-issue-at-a-time via hero's SPLIT phase (`dispatch.md:9`) and triage's `SPLIT` verdict (`modes/triage.md:106`), both already per-issue dispatches. Adding a plan-side drain would be new capability — out of scope (§ Design Decisions).
**File**: `ralph/skills/shared/__tests__/loop-continuation.test.sh` (CI-silent) — remove `"caretake:split"` from `DRAIN_MODES` (`:95`); it asserts the manifest row exists and fails the moment the row is deleted (G3).
**Files**: `ralph/CLAUDE.md:75` (matrix row), `README.md:78`, root `CLAUDE.md:75` caretake one-liner drops "split".

#### 5. A check that can fail (new — closes the F1 verification defect)

The phase's original checks (`grep 'RALPH_COMMAND.*plan' split-*.sh` → 3; registrations present in plan, absent in caretake) **all pass in the fully-broken state**, because they assert the re-key and the re-registration but never that anything arms the guards. Add:

**File**: `ralph/hooks/scripts/__tests__/split-hooks-plan-scope.test.sh` (NEW; copy the SBX/REPO/NOGIT + `run_case` harness from `plan-research-required.test.sh` per `ralph/CLAUDE.md` § Conventions). Cases, each driving the hook with the env the plan skill actually produces:

| # | Env | Payload | Expect |
|---|---|---|---|
| 1 | `RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split` | `create_sub_issues` children `[{estimate: M}]` | **exit 2** (blocked) — atomic guard armed |
| 2 | `RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic` | same payload | **exit 0** (allowed) — plan-of-plans M children unregressed (F2) |
| 3 | `RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split` | children `[{estimate: S},{estimate: XS}]` | exit 0 |
| 4 | `RALPH_COMMAND=caretake RALPH_SUBCOMMAND=split` | children `[{estimate: M}]` | exit 0 — old key fully retired |
| 5 | `RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic` + `RALPH_TICKET_ID=GH-1` , no `RALPH_SPLIT_COUNT` | Stop | exit 0 — a pure plan-of-plans session cannot be blocked by the postcondition |
| 6 | `RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split` + `RALPH_TICKET_ID=GH-1 RALPH_SPLIT_COUNT=1` | Stop | **exit 2** |
| 7 | `RALPH_COMMAND=plan RALPH_SUBCOMMAND=epic-split` + Post `get_issue` returning estimate `S` | `get_issue` | **exit 2** — parent too small |

**Plus a static arming assertion in the same test** — extract the required scope value from the hooks themselves and assert the plan skill exports it, so the check fails if either side drifts:

```bash
required=$(sed -n 's/.*RALPH_SUBCOMMAND:-}" != "\([a-z-]*\)".*/\1/p' ralph/hooks/scripts/split-size-gate.sh | head -1)
grep -rq "export RALPH_SUBCOMMAND=${required}" ralph/skills/plan/ || fail "split guards are not armed in plan context"
```

Cases 1, 2, 5 and the arming assertion are the four that fail in the states the critique identified (guards dead / epic regressed).

### Success Criteria

#### Automated Verification
- [ ] `grep -rn -- '--mode split\|split-decomposition' ralph/ scripts/ CLAUDE.md README.md` → 0 hits
- [ ] Bare-token residue sweep (G1 — catches the frontmatter pipe-alternations, mode-body links and prose lists that the `--mode split` sweep misses). Two greps. The first grep is bounded, not the naive `\bsplit\b` (round-2 correction: `grep -v 'needs-split'` alone is unreachable — `caretake/modes/triage.md:285,293` carry legitimate English prose about triage's own ability to split issues, e.g. "Multiple valid ways to split this issue" and "May close/split/update issues"; excluding those two lines by content keeps the sweep meaningful without special-casing line numbers):
  - `grep -rn 'split' ralph/skills/caretake/ | grep -v 'needs-split\|split this issue\|close/split'` → 0 hits
  - `grep -rn 'caretake:split\|caretake --mode split\|modes/split\|split-decomposition' ralph/ scripts/ CLAUDE.md README.md` → 0 hits
- [ ] `bash ralph/hooks/scripts/__tests__/split-hooks-plan-scope.test.sh` passes — **including case 2 (M child allowed on the plan-of-plans path) and the arming assertion**
- [ ] `bash ralph/hooks/scripts/__tests__/plan-research-required.test.sh` passes with the new carve-out cases; `bash ralph/hooks/scripts/__tests__/split-size-gate.test.sh` passes re-keyed
- [ ] `grep -c 'RALPH_SUBCOMMAND' ralph/skills/plan/SKILL.md` → ≥1 (0 today; **this is the F1 tripwire** — the three greps below all pass with the guards dead, this one does not)
- [ ] `grep -n 'RALPH_COMMAND.*plan' ralph/hooks/scripts/split-*.sh` → 3 hits (one per script); `grep -n 'epic-split' ralph/hooks/scripts/split-*.sh` → 3 hits; `grep -n 'split-' ralph/skills/plan/SKILL.md` shows 4 registrations; `grep -n 'split-' ralph/skills/caretake/SKILL.md` → 0
- [ ] Local (CI-silent): `bash ralph/skills/shared/__tests__/loop-continuation.test.sh` exits 0 without the `caretake:split` row
- [ ] Full hook-test sweep + ShellCheck + `bash scripts/check-doc-rosters.sh` + skill-frontmatter vitest green

#### Manual Verification
- [ ] **Atomic path** — `/ralph:plan --mode epic #<M-estimate issue>` routed to `## Atomic split`: estimate gate blocks on an XS/S parent, size gate blocks an M child, ≥2-children postcondition enforced at Stop
- [ ] **Plan-of-plans path (F2 regression check)** — `/ralph:plan --mode epic #<L/XL epic>` writing a Feature Decomposition with an **M** feature child completes: `create_sub_issues` is NOT blocked, Stop is NOT blocked, and the plan-of-plans write passes `plan-research-required.sh` without a research doc. *(The plan previously asserted "size gate blocks an M child" as the desired behaviour for this mode — correct on the atomic path, fatal here.)*
- [ ] **Live propagation smoke** — confirm the Step 0 export actually reaches hook subprocesses: run the atomic path and verify the size gate blocks an M child in a real session, not just in the test harness (which sets the env itself). See § Risks for the fallback if it does not.
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
**Repoint every reference** to either old file: `caretake/SKILL.md` (`:107` References line, `:142` dispatch line), `modes/triage.md`, `modes/watch.md`, `hero/SKILL.md` (`:95` References line, `:152`, tick step 3 `:156`), `hero/dispatch.md`, `hero/watch-dispatch.md`, `catch-up/next-action-ranking.md:102-103` (prompt text references `label-routing.md` — repoint now; the rows themselves are rewritten in Phase 6), **`ralph/agents/triage-agent.md:8`** (prompt prose names `label-routing.md`; repoint the token here even though the file is deleted in Phase 6 — otherwise this phase's own sweep cannot pass at its boundary, G2), `ralph/CLAUDE.md`, and any `${CLAUDE_PLUGIN_ROOT}` path strings (`grep -rn 'label-routing\|event-classes' ralph/` drives the sweep).

#### 2. One loop/auto substrate

- **Files**: `ralph/skills/shared/loop-wrapper.md:3`, `auto-alias.md:3` — fix the stale "SKILL.md bodies copy the snippets below" framing → "consumers reference this file" (research: no SKILL.md inlines the snippet; all seven consumers already point).
- **File**: `ralph/CLAUDE.md:48-99` — replace the 40-row duplicated suitability matrix + verbatim refusal strings (`:97,99`) with a short `## Loop suitability` pointer section naming the two shared files (keep the ScheduleWakeup-rules section, updating its content refs). The manifest/alias tables in the shared files become the ONLY copies. **Keep the section heading** — the canonical refusal string says "See ralph/CLAUDE.md § Loop suitability" and `loop-refusal.test.sh:63-67` asserts that string verbatim; a dangling pointer would be a real regression.
- **File**: `ralph/skills/shared/loop-wrapper.md` — the matrix's **unsuitable ("No") rows have no home in the manifest**, which lists only loop-suitable `skill:mode` rows. Add a `## Unsuitable surfaces` section carrying them (post-Phases-1–4 set: `form` all modes; `plan` default/iterate/epic; `impl` default/address; `research` default (+`prove` until Phase 6); `catch-up` default; `setup` all modes; `hero` default/pr-drain; `caretake --mode reflect`; `caretake --mode unblock --question`), each with its one-line reason. This is where the refusal test now looks.
- **File**: `ralph/skills/shared/__tests__/loop-refusal.test.sh` — **decision (G3): retarget, do not delete.** Its section 4 (`:88-116`) parses `ralph/CLAUDE.md` for the unsuitable surfaces this phase collapses to a pointer, which guts its premise. Repoint `RALPH_CLAUDE` → the new `## Unsuitable surfaces` section of `loop-wrapper.md` and update the `check_unsuitable` list to the post-phase set above. Sections 1–3 (refusal-message shape, `auto-alias.md` refusal targets) already read the shared files and stay untouched — including the `full_canonical` assertion, which is why the refusal string itself is NOT reworded. CI-silent — run by hand.
- **File**: `ralph/skills/shared/__tests__/loop-arg-strip.test.sh:23-35` — replace the embedded snippet copy with extraction from `loop-wrapper.md` at test time. **Mechanism (G7 — "extract at test time" alone has a non-obvious failure mode in a test CI never runs):** the current `run_snippet()` wraps the snippet in four `local` declarations (`ARGUMENTS`, `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`) plus a trailing `printf` output contract; the canonical fenced block at `loop-wrapper.md:12-21` has neither. So: awk-extract **the first fenced block after the `## Arg-parsing snippet` heading** into a variable, `eval` it inside `run_snippet` *after* the `local` declarations, and keep the `printf` contract outside the extracted text. Fail loudly (non-zero, explicit message) if the extraction yields an empty block — a silently-empty `eval` would make every case pass on stale defaults. This kills the third copy and the existing `printf`-vs-`echo` drift by construction. NOTE: this test is NOT in the CI glob — run locally.

#### 3. One token table

**File**: `ralph/skills/caretake/SKILL.md:173-190` — the drifted quick-ref (4 drift points: `<N archived>` vs `<N>`, lost `<reason>` placeholder, missing `UNBLOCK REQUEST SKIPPED` variant, missing split `Queue empty.`) → one pointer line to `outcome-tokens.md`. `outcome-tokens.md` (as amended by Phases 1/3/4) is the single home. Grep-verify no other SKILL.md grew a token table since the research (none exists today).

### Success Criteria

#### Automated Verification
- [ ] `grep -rn 'keep.*in sync\|keep both in sync' ralph/skills/` → 0 hits
- [ ] `test ! -f ralph/skills/caretake/label-routing.md && test ! -f ralph/skills/hero/event-classes.md && test -f ralph/skills/shared/event-taxonomy.md`
- [ ] `grep -rn 'label-routing\|event-classes' ralph/ CLAUDE.md README.md` → 0 hits. **Passable at this boundary only because §1 repoints `ralph/agents/triage-agent.md:8`** — that file is not deleted until Phase 6 and was the one unowned hit (G2).
- [ ] `grep -n '## Loop suitability' ralph/CLAUDE.md` → 1 hit (the refusal string's target still resolves)
- [ ] `grep -n '## Unsuitable surfaces' ralph/skills/shared/loop-wrapper.md` → 1 hit
- [ ] All four affected CI-silent shared tests pass locally (must be run by hand): `loop-arg-strip.test.sh`, `auto-alias.test.sh`, **`loop-refusal.test.sh`** (retargeted), **`loop-continuation.test.sh`** (G3)
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
- **File**: `ralph/skills/shared/loop-wrapper.md` § Unsuitable surfaces — drop the `research --mode prove` entry. **Corrected ownership**: Phase 5 collapses `ralph/CLAUDE.md`'s matrix, so the prove row lives in `loop-wrapper.md` by the time this phase runs; the original instruction pointed at `ralph/CLAUDE.md:55`, which no longer holds it.
- **File**: `ralph/skills/shared/__tests__/loop-refusal.test.sh` — drop the `research default/prove` check (`:111` pre-iteration; in the retargeted list after Phase 5). CI-silent — run by hand (G3).

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
- [ ] Mode-table row recount over the merged tree is **machine-asserted**, not hand-counted (G2). This awk reproduces the 45 baseline exactly on today's tree (verified at iteration time: catch-up 5, form 2, research 3, plan 5, impl 4, review 4, caretake 14, hero 5, setup 3 = 45), and must print `35` after this phase — with the per-verb line `catch-up 3, form 2, research 2, plan 5, impl 4, review 4, caretake 8, hero 4, setup 3`:

```bash
total=0
for f in catch-up form research plan impl review caretake hero setup; do
  n=$(awk '/^\| *Mode *\|/{t=1;next} t&&/^\|[ :-]*-/{next} t&&/^\|/{if($0 !~ /--help/)c++;next} t&&!/^\|/{exit} END{print c+0}' "ralph/skills/$f/SKILL.md")
  printf '%s: %s\n' "$f" "$n"; total=$((total+n))
done
echo "TOTAL: $total"   # must be 35
```

The awk encodes the stated counting rule directly: it counts rows of the `| Mode |` table only, skips the separator, excludes the `--help` row, and stops at the first non-table line (so `hero-fable` and non-mode tables are never reached).

#### Manual Verification
- [ ] `/ralph:research "claim: <some claim>"` produces a verdict-first findings shape via default intake
- [ ] Catch-up `tree-continue` / `lock-stale` directions dispatch inline caretake triage successfully
- [ ] PR body carries the tally + per-deletion evidence; #1590's criterion restated

## Risks

Grounded in the research doc's § Risks and ordering constraints:

- **#1604/#1606 collision** (`hero/SKILL.md:156-157`, both also touch `event-classes.md`): mitigated by hard serialization — Phase 2 relocates the classify section, Phase 3 edits the relocated lines. Implementing these out of order re-introduces the double-rebase the plan-of-plans missed.
- **Silent fail-open of the autopilot stop-gate**: if Phase 2 changes the loop inner-command string without updating `autopilot-director-postcheck.sh:56`, the watcher never arms and `autopilot-stop-gate.sh` never blocks — no error is raised anywhere. The Phase 2 automated check (`grep -c '/ralph:hero --tick' …postcheck.sh` = 1) plus `autopilot-auto-watcher.test.sh` are the tripwires.
- **Cross-phase test file ownership**: `caretake-watch-blockers.test.sh` is edited in Phase 1 ("7 total" → "6 total") and rewritten in Phase 3 (as `caretake-watch.test.sh`, "4 total"). Phase 3's rewrite MUST be based on Phase 1's result; the phase ordering encodes this.
- **Split-hook no-op risk (upgraded — critique F1)**: the failure mode is broader than re-key-vs-re-register. `plan/SKILL.md` exports **no** `RALPH_SUBCOMMAND` today, so re-keying alone leaves every guard falling through its early-exit while all of the phase's greps still pass. Phase 4 §2 therefore does four things (arm at Step 0, discriminate the two paths, re-key, re-register) and §5 adds `split-hooks-plan-scope.test.sh`, whose cases 1/2/5 and static arming assertion fail in exactly the broken states.
- **Env-propagation channel is unproven for hook subprocesses**: `set-skill-env.sh`'s own header states that the `CLAUDE_ENV_FILE` write "is the only path that survives the per-call subshell isolation of the Bash tool — bare `export` in this script's own process is throwaway", and `autopilot-director-postcheck.sh:22-24` greps the Skill payload rather than trusting `RALPH_SUBCOMMAND`. Every mode-body `export RALPH_SUBCOMMAND=…` in the plugin (`caretake/modes/*.md`, `hero/SKILL.md:119-123`, `setup/SKILL.md:62-65`) rides that same uncertain channel. Phase 4's live propagation smoke test is the tripwire. **If it shows fail-open**: the caretake split gates have been fail-open all along, this plan neither creates nor worsens the defect, and the fix (routing `RALPH_SUBCOMMAND` through `CLAUDE_ENV_FILE`, or converting the guards to payload discrimination) is a plugin-wide change — **file it as a separate issue, do not expand this PR**.
- **`plan-review.md` prescribes a transition the state machine rejects (pre-existing defect — do NOT fix here)**: `ralph/skills/plan/plan-review.md:167` maps NEEDS_ITERATION to `save_issue(workflowState: "Plan in Progress", command: "review")`, but `ralph/hooks/scripts/ralph-state-machine.json:256-259` gives `ralph_review` `valid_output_states: ["In Progress", "Ready for Plan", "Human Needed"]` — no `Plan in Progress` — and its own postconditions say "returned to Ready for Plan (needs-iteration)". `state-gate.sh` validates against that JSON, so the documented transition would be blocked. Real mismatch, confirmed against the tree this iteration; **out of scope for #1590** (nothing in these six members touches plan review's transitions) — file as its own issue.
- **Snapshot cadence changes 6h → 1h** when `capture_snapshot` moves into `modes/hygiene.md` (G4). The JSONL store grows ~6× faster; rows are small and `metrics_trends` windows are day-scale, so this is denser history rather than a problem — but it is a behaviour change worth one line in the PR body.
- **Hook-carve-out hole**: the `type: plan-of-plans` allow-branch in `plan-research-required.sh` could be abused to skip research by mislabeling; bounded because the plan-context Stop validator enforces the plan-of-plans shape (`doc-structure-validator.sh:68-93`) — a naively mislabeled implementation plan fails at Stop. Phase 4's manual check exercises exactly this. **The bound holds only against the naive case**: a deliberate evader who adds `## Feature Decomposition` + `## Feature Sequencing` headings satisfies both gates. Accepted — the carve-out replaces a *documented* evasion instruction (`split-decomposition.md:85`, `modes/split.md:140`) with a shape-checked one, which is strictly tighter than today.
- **CI-silent shared tests**: `ralph/skills/shared/__tests__` is outside the CI hook-test glob; **Phases 1, 3, 4, 5 and 6** edit four of the five tests there and MUST run them locally — drift ships silently. (The plan previously named only the two surviving tests and missed `loop-continuation.test.sh` and `loop-refusal.test.sh` entirely — critique G3.)
- **Roster-checker self-edit**: deleting `triage-agent` without the `check-doc-rosters.sh:54` heading-regex edit makes `doc_agents` extract empty and flags every agent — same-phase coupling in Phase 6 (phase-internal only, since everything ships as one PR).
- **Operator-facing renames land at once** (reflect, watch --kind, plan-epic split, --tick): a stale external invoker (schedule, muscle memory) hits a hard stop, not an alias. Migration Notes lists the spellings; the PR body must repeat them.
- **Single-PR blast radius**: one revert reverts all six members. Accepted trade (plan-of-plans integration strategy): one shared surface, one version bump, no mid-stack broken plugin releases.

## Testing Strategy

### Unit Tests
- Hook tests are the regression net: `caretake-watch.test.sh` (rewritten, Phase 3), `hero-auto-tick-audience.test.sh` (re-anchored, Phase 2), `autopilot-auto-watcher.test.sh` (arming fixture, Phase 2), `plan-research-required.test.sh` (+carve-out cases, Phase 4), `split-size-gate.test.sh` (re-keyed, Phase 4), **`split-hooks-plan-scope.test.sh` (NEW, Phase 4 — the only check in the plan that fails when the split guards are unarmed or when the plan-of-plans path is regressed)**.
- CI-silent shared tests (`ralph/skills/shared/__tests__`, run by hand): `loop-continuation.test.sh` (Phases 1, 3, 4), `loop-refusal.test.sh` (Phases 1, 5, 6 — retargeted at `loop-wrapper.md` in Phase 5), `loop-arg-strip.test.sh` (Phase 5), `auto-alias.test.sh` (Phase 6). Tests that hard-code strings are plan work, called out in their owning phases — notably `caretake-watch-blockers.test.sh`'s literal `"7 total"` (`:124`), token shapes (`:111-118`), and occurrence thresholds (`:123-135`).
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
- Critique folded in this iteration: `thoughts/shared/reviews/2026-07-26-GH-1590-critique.md`

## Iteration Log

### 2026-07-26 — iteration 1, against `2026-07-26-GH-1590-critique.md` (NEEDS_ITERATION: 2 FAIL + 1 GAP)

Every finding was re-verified against the working tree before folding. Phase numbering is unchanged (no insertions, no renumbering); all edits are in-place within existing phases plus one new sub-section (Phase 4 §5).

**Folded in — blocking:**

| Finding | Change |
|---|---|
| **F1** — split hooks re-keyed to a `RALPH_SUBCOMMAND` the plan skill never sets; all three guarantees no-op and every phase check still passes | Phase 4 §2 rewritten into four explicit steps: **(a)** add a Step 0 `case` export to `plan/SKILL.md` (precedent `hero/SKILL.md:119-123`, `setup/SKILL.md:62-65`) and amend `plan/SKILL.md:135`'s "no env-flip is needed" sentence; **(b)** discriminate the two paths; **(c)** re-key; **(d)** re-register. New § Design Decisions entry records the arming choice. |
| **F1 (verification half)** | New Phase 4 §5: `split-hooks-plan-scope.test.sh` with 7 env-driven cases plus a static arming assertion that extracts the required scope value from `split-size-gate.sh` and greps for its export in `ralph/skills/plan/`. Cases 1/2/5 + the assertion fail in the broken states. Added `grep -c 'RALPH_SUBCOMMAND' ralph/skills/plan/SKILL.md → ≥1` to Automated Verification as the headline tripwire. |
| **F2** — one shared scope key blocks every epic with an M feature child | Atomic path gets its own value `RALPH_SUBCOMMAND=epic-split` (precedent: the two-variant `caretake/modes/unblock.md:10-14`); plan-of-plans keeps `epic` and all three guards early-exit there. Phase 4 §2 carries a per-registration behaviour table for both paths. **Manual Verification corrected** — the old "size gate blocks an M child" assertion is now scoped to the atomic path, and a new plan-of-plans regression check asserts an M child is *allowed*. |
| **G3** — two CI-silent shared tests break unmentioned | `loop-continuation.test.sh` added to Phases 1 (`caretake:trends` `:59`, `caretake:debug` `:94`), 3 (add `caretake:watch`), 4 (`caretake:split` `:95`). `loop-refusal.test.sh` added to Phases 1, 5, 6, with the Phase 5 fate decided explicitly: **retarget, not delete** — its section 4 repoints at a new `## Unsuitable surfaces` section in `loop-wrapper.md`, and `ralph/CLAUDE.md` keeps a `## Loop suitability` heading so the canonical refusal string (asserted verbatim by the same test) still resolves. § Verification and § Testing Strategy updated. |

**Folded in — gaps:**

- **G1** — all twelve missed call sites added to their owning phases (`triage.md:106`, `enrich.md:11`, `autopilot-stop-gate.sh:10` + `autopilot-director-postcheck.sh:16,18,51,52`, `watch-dispatch.md:54`, `event-classes.md:80`, `label-routing.md:11,24,48`, `caretake/SKILL.md:2,3,88,167`, `hero/SKILL.md:85`, `outcome-tokens.md:130`), plus bare-token residue sweeps in Phases 1 and 4 to catch non-`--mode` spellings. Both non-existent-row instructions corrected: there are **no** `caretake:watch-*` rows and **no** `caretake:retro` row in `loop-wrapper.md:36-55`.
- **G2** — every phase sweep made passable at its own boundary: Phase 1 now owns `dashboard-render.md:3,34,44`, `narrative-synthesis.md:63` and `watch-pr.md:11`; Phase 5 now repoints `triage-agent.md:8`; Phase 3's owning-file list adds `enrich.md`. Phase 6's mode count is now a runnable awk (verified to reproduce the 45 baseline on today's tree) instead of a hand count. The weak `grep -c 'WATCH-'` check is kept but labelled as backstopped by the rewritten hook test.
- **G4** — snapshot producer resolved rather than accepted: a bare one-line `capture_snapshot` moves into `modes/hygiene.md` (already the 1h heartbeat and item 1 of the `--mode all` fan-out); `metrics_trends` drops out of caretake's allowed-tools. New Design Decision + a Phase 1 automated check that fails if the producer was dropped. Cadence change noted in Risks.
- **G5** — line references corrected: root `CLAUDE.md` caretake row is `:75` and catch-up row is `:69`; the catch-up instruction is rewritten (its "narrative" is the surviving default — the original edit would have made the row *less* accurate; the stale phrase is "single-surface mode"). `caretake/SKILL.md` split row is `:101`, not `:96` (unblock). Phase 2's "`:167-170` unchanged" corrected — `:170`, `:172` and `:174` embed the old string.
- **G6** — intermediate caretake counts fixed: 14 → **11** (Phase 1) → **9** (Phase 3) → **8** (Phase 4). Final 8 and the −6 delta were already right.
- **G7** — `loop-arg-strip.test.sh` extraction mechanism specified: awk the first fenced block after `## Arg-parsing snippet`, `eval` it inside `run_snippet` after the `local` declarations, keep the `printf` contract outside, and fail loudly on an empty extraction.

**Rejected, with counter-evidence:**

- **The critique's own G3 parenthetical is wrong.** It states: *"`narrative-synthesis.md:63` was cited [in the earlier pass] as a Phase 1 sweep hit. It is not — that line reads 'Return only the narrative text'."* Both statements sit on line 63; `grep -n -- '--mode narrative' ralph/skills/catch-up/narrative-synthesis.md` returns `63` ("The caller (the interactive `/ralph:catch-up` default flow, the `--mode narrative` branch, or a programmatic invoker like `cos`) takes the text as-is."). The earlier review pass was right and the correction was wrong, so the line is now owned by Phase 1 §4. Also `dashboard-render.md` has **three** hits (`:3,34,44`), not two.
- **The critique's suggested fix "a path-scoped `RALPH_VALID_SUB_ESTIMATES` widening"** was considered and not taken: widening the valid set to `XS,S,M` on the plan-of-plans path would also widen it on the atomic path unless something already discriminates the paths — which is the thing being built. The distinct scope value subsumes it.
- **The caveat suggesting `estimate: S` be raised** — left as-is. The frontmatter `estimate` mirrors `primary_issue: 1603`'s board field; changing it in the doc would desynchronise it from the board without changing anything. The group-plan convention (one doc, six member estimates) is unchanged.
- **Not changed, per the critique's own confirmation**: the 45 → 35 mode-count restatement (independently re-verified this iteration — the awk in Phase 6 reproduces 45 exactly), the 1603 → 1606 → 1604 serialization, and the 7→6→4 / 8→6→5 fan-out arithmetic.

**Noted, not fixed (filed separately):** `plan-review.md:167`'s NEEDS_ITERATION transition to `Plan in Progress` versus `ralph-state-machine.json:256-259`'s `ralph_review.valid_output_states` (`In Progress`, `Ready for Plan`, `Human Needed`). Confirmed real; out of scope for these six members. Recorded in § Risks.
