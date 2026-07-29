---
date: 2026-07-27
status: draft
type: plan
tags: [4cs, relanding, surface-reduction, server-side-invariants, pivot]
github_issues: [1590, 1591, 1592, 1593, 1603, 1604, 1605, 1606, 1607, 1608, 1609, 1610, 1611, 1612, 1613, 1614, 1615, 1616, 1617, 1618, 1619]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1588
primary_issue: 1588
estimate: L
research_doc: thoughts/shared/research/2026-07-26-GH-1592-server-side-invariants-sweep.md
research_waived: "no GH-1588-named doc by design — epic-level research exists as the four feature sweeps (GH-1590/1591/1592/1593, copied into this branch and cited in Prior Work); pivot directed by the user 2026-07-27"
---

# GH-1588 relanding + simplification pivot — land the verified tree, delete the transitional machinery

## Prior Work

- supersedes:: [[2026-07-26-GH-1590-group-skill-surface-reduction]] — **landing strategy only** (single stacked PR #1620) plus Phase 4 §2(a–d)/§5 (the `epic-split` env-arming apparatus, deleted here). All other content stands as the authoritative spec of what the skill wave delivers.
- supersedes:: [[2026-07-26-GH-1591-group-tool-surface-reduction]] — **landing strategy only** (PR position in the stack). All seven phases stand and land in Phase 1 (PR-A).
- supersedes:: [[2026-07-26-GH-1592-group-server-side-invariants]] — **landing strategy only**, plus Phase 5's "split-postcondition.sh stays (#1605's remit)" carve-out (deleted here). Phases 1–4 land in PR-A; Phase 5 lands in PR-B.
- builds_on:: [[2026-07-26-GH-1593-capability-tier-model-config]] — lands unchanged as PR-C.
- builds_on:: research sweeps [[2026-07-26-GH-1590-skill-surface-reduction-sweep]], [[2026-07-26-GH-1591-tool-surface-reduction-sweep]], [[2026-07-26-GH-1592-server-side-invariants-sweep]], [[2026-07-26-GH-1593-capability-tier-model-config]] (all four remain authoritative for their factual inventories).
- builds_on:: [[2026-07-27-GH-1619-zero-hook-lifecycle-evidence]] — re-run at the PR-B head (Phase 2).

**User directive (2026-07-27, verbatim intent):** iterate the plan so it *simplifies the code while making it safe and implementable*; **breaking changes to existing interfaces are explicitly authorized.** The 2026-07-26 group plans were written under a no-lost-workflow, no-breaking-changes constraint that this directive lifts. Every deletion below that was previously "relocate/re-key/preserve" is now "delete" on that authority.

## Overview

Epic #1588's five features are implemented and verified, but the landing strategy failed: four stacked branches, of which only the first became a PR (#1620), now at **12 CodeRabbit rounds, CHANGES_REQUESTED, 91 files, with a non-decaying finding rate** (13/15/10 actionable in rounds 10–12). This plan replaces the stack with three **layer-sliced re-cut PRs derived from the verified stack tip** (`feature/GH-1593` @ `18f53463`), applies a simplification pass that deletes the transitional machinery the review could not converge on, and maps every re-cut PR back to the existing 18 leaf issues so the board stays truthful.

The pivot is possible because of a fact the state report missed: the three stacked branches fork from `61c2f910` — the exact commit CodeRabbit round 1 reviewed. **All 11 review-spiral commits (rounds 1–10 fixes: the `enrich.md` +190-line rework, the untrusted-content envelope hardening, the extracted-shell test escalation) exist only on `feature/GH-1603` and are absent from the verified tip.** The tip is the four features as planned, green, without the material that drew 98 of 114 findings.

## Current State Analysis

Verified in this session (2026-07-27), not inherited from the state report:

- **Branches**: `feature/GH-1603` (24 ahead), `feature/GH-1609` (20), `feature/GH-1615` (25), `feature/GH-1593` (29) — **all four pushed; remote SHAs match local HEADs** (the report's "74 unpushed commits" risk is already resolved). Worktrees clean.
- **PR #1620**: OPEN, CHANGES_REQUESTED (round 12, 2026-07-28T00:55Z, head `53836761`), 91 files +9,724/−2,540. 118 actionable findings over 12 rounds; 18 threads still open.
- **Stack topology**: merge-base(GH-1609, GH-1603) = `61c2f910` (13 commits after main) = the round-1 reviewed commit. The 11-commit tail on GH-1603 is exclusively review-fix material.
- **Tip tree** (`18f53463`): 1,824 mcp-server tests pass (2 skipped), hook/script suites + ShellCheck green, `check-doc-rosters` / `check-tool-consumers` / `check-model-tiers` pass. Mode count **35** (machine-asserted via the Phase-6 awk), default tool surface **22** (asserted `EXPECTED_TOOLS.length === 22`, tool-registration.test.ts:309), hooks **40 → 35** files (−841/+384 lines).

### Key Discoveries

- **Review pressure was 100% markdown/bash; zero on TypeScript.** Of 114 inline findings across 12 rounds: `ralph/skills/**.md` 78, `ralph/hooks/scripts/` 20 (+11 in hook tests) — **`mcp-server/src/`: 0 findings** (no mcp-server files in the PR). Severity: 2 Critical, 85 Major. The convergent review surface is typed, vitest-covered TS; the divergent one is prose state machines.
- **Four files absorbed 38 findings** — `caretake/modes/enrich.md` (14), `hero/auto-tick.md` (9), `shared/event-taxonomy.md` (8), `plan/decomposition.md` (7) — and rounds 10–12 kept producing new findings on files already fixed 3–5×. Each fix pass added error-path prose/tests that the next full review saw for the first time.
- **The hottest file's rework is review-spiral only**: `enrich.md` is +190/−11 on GH-1603 but **+2/−2 at the tip**. Same for the extracted-shell tests (`enrich-outcome-tokens.test.sh`, `hero-watch-envelope.test.sh`, `loop-dispatch-no-double-mode.test.sh`) and the envelope hardening — none exist at the tip (`grep -rln 'untrusted' ralph/hooks/scripts/*.sh ralph/skills/` → 0 at tip).
- **The last env-armed gate in plan context is `split-postcondition.sh`** (tip `plan/SKILL.md:150` calls it "the one exception"), keyed on `RALPH_SUBCOMMAND=epic-split` via a Step-0 case export + a `decomposition.md` re-export. Round 12 finding #3 (stale env arms the Stop gate for unrelated `/ralph:plan` sessions → blocks them) attacks exactly this channel, and the GH-1590 plan's own § Risks already conceded the env-propagation channel is unproven. The other split gates (`split-size-gate.sh`, `split-estimate-gate.sh`) are already deleted at tip, their contracts moved server-side (`create_sub_issues` `maxChildEstimate` defaults `"M"`, up-front edge sanity — GH-1618).
- **`RALPH_SUBCOMMAND` consumers at tip** (8 hooks): only `split-postcondition.sh` keys on a plan-context value; the rest are caretake-scoped (`unblock-state-gate`, `unblock-request-postcondition`, `triage-*`) or autopilot/logging (`autopilot-*`, `hero-dispatch-log`) and are out of this pivot's scope.
- **Server-side invariants are in and tested at tip**: transition legality from live current state at all six writers, lock side-doors closed + holder/heldSince in refusals, loud `force`, stale-lock clock on the field-value `updatedAt`, tree ceiling — with the zero-hook evidence doc produced by driving the compiled server over stdio (`thoughts/shared/reviews/2026-07-27-GH-1619-zero-hook-lifecycle-evidence.md`).
- **Board**: epic #1588 + features #1590–#1593 + all 18 leaves open. #1589 Done (merged 2026-07-26).

## Desired End State

1. `main` contains the tip tree's content minus the transitional machinery deleted in Phase 2, landed as three PRs (server core → plugin sweep → model tiers), each independently CI-green, attested, and merged via `scripts/merge-pr.sh`.
2. PR #1620 is closed with a pivot comment; `feature/GH-1603` is preserved (not deleted) as the reference for selectively re-applied review fixes.
3. All 18 leaf issues + 4 features + the epic reach Done through the normal `Closes #NNN` / `sync-pr-merge.yml` / `advance-parent.yml` path — no manual board surgery beyond the #1620 closure comment.
4. Simplification deltas beyond the tip (all breaking-authorized):
   - `split-postcondition.sh` + its test + registration + the `epic-split`/Step-0 `RALPH_SUBCOMMAND` export in plan context are **deleted**; the ≥2-children rule becomes one prose line. Hook count lands at **34**. `grep -rn 'epic-split\|RALPH_SPLIT_COUNT' ralph/` → 0.
   - No test anywhere executes shell extracted from markdown (`loop-arg-strip.test.sh` deleted — its drift-guard rationale died when single-sourcing removed the copies).
   - Surviving skill-side static tests run in CI (`ci.yml` discovery glob gains `ralph/skills/*/__tests__`), closing the report's CI-silent follow-up by inclusion, not by growing the eval pattern.
5. The four structural finding classes from PR #1620 are dissolved or descoped, not ground through: prose-git-flow (A) and envelope (I) additions dropped with the spiral tail; env-arming (H) deleted where it was load-bearing, patched where it survives; extracted-shell (G) banned. The two heavy security findings (decision-hold authentication; watch-mode contract enforcement) become follow-up issues.
6. Nothing delivered is silently lost: post-landing, `git diff feature/GH-1593 main -- mcp-server/ scripts/` is empty except the Phase 2 deletions and re-applied fixes named in this plan.

### Verification

- Per-PR: `cd mcp-server && npm run build && npm test`; `bash scripts/check-doc-rosters.sh`; `bash scripts/check-tool-consumers.sh`; hook/script loop `find ralph/hooks/scripts/__tests__ scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -print0 | xargs -0 -n1 bash`; `shellcheck -S error ralph/hooks/scripts/*.sh scripts/*.sh`; `bash scripts/check-model-tiers.sh` (PR-C).
- Counts re-asserted at each head: 22 default tools / 26 with `RALPH_SRE_ENABLE=true`; 35 modes; 34 hooks (after PR-B).
- Zero-hook evidence re-run at the PR-B head.
- `gh run list --commit <merge-sha>` after each merge (release workflows have silently not fired before — root CLAUDE.md § CI/CD).

## What We're NOT Doing

- **Not grinding PR #1620 to convergence.** 12 rounds with a non-decaying finding rate on a 91-file prose diff is structural, not effort-bound.
- **Not landing the stack as-is in sequence.** That path re-reviews the same divergent material three more times and inherits the spiral tail.
- **Not re-applying the GH-1603 spiral tail wholesale.** Only the specific fixes named in Phase 2's disposition ledger come across; the enrich rework, envelope hardening, and extracted-shell tests do not.
- **Not redesigning autopilot dispatch, the trigger-label state machine, or enrich's git flow** in this landing. The root fixes CodeRabbit's churn points at (git flows as tested scripts, ledger-based arming for the surviving env-scoped hooks) are follow-up issues, not scope growth here.
- **Not touching the surviving caretake/autopilot env-scoped hooks** (`unblock-state-gate.sh`, `triage-*`, `autopilot-*`) beyond the one Critical fix re-applied in Phase 2. Global `RALPH_SUBCOMMAND` elimination is a follow-up.
- **Not adding compatibility aliases or shims for anything removed/renamed** — the directive authorizes hard breaks; the Migration Notes register is the only compatibility artifact.
- **Not pursuing wave-3 mode cuts or the ≤22-tool round numbers.** The evidence-backed 35/22 stand; wave-3 remains backlog (GH-1590 plan § Mode-count target).
- **Not deleting any feature branch.** All four stay on origin until the epic is Done.

## Design Decisions & Open Ambiguities

- **Re-cut from the verified tip vs. grind #1620 vs. land the stack sequentially** — **Decided: re-cut from tip.** The tip is green and spiral-free; the finding classes cluster on material the pivot deletes; grinding produced rounds 10–12 as heavy as rounds 5–6. Evidence: 0 TS findings ever, 98/114 on `ralph/` prose+hooks; fork point = round-1 commit.
- **Slice by layer (server → plugin → tiers), not by feature** — **Decided: layer.** (a) The epic's own ordering principle — "enforcement had to exist before the rails come out" (GH-1590 plan-of-plans) — puts server-side invariants on main before the hook/mode deletions; (b) review-material homogeneity: PR-A is typed TS the reviewer converges on, PR-B becomes overwhelmingly deletions once nothing needs relocating; (c) the board survives layer slicing because a PR may close leaves of two features (`Closes` lines are per-issue, `advance-parent.yml` closes features when all children are Done).
- **Close #1620; keep its branch** — **Decided: close with a pivot comment linking this plan.** Retargeting would drag 114 threads of context into the re-cut; the branch stays as the cherry-pick source for the disposition ledger.
- **Delete the `epic-split` env-arming + `split-postcondition.sh`; demote ≥2-children to prose** — **Decided: delete.** The server ceiling (`maxChildEstimate` default `"M"`) and up-front edge sanity carry the actual safety; the Stop-gate's channel is the PR's only remaining env-armed plan gate, round 12 showed it blocks unrelated sessions when the env goes stale, and the GH-1590 plan itself flagged the channel as unproven-and-possibly-fail-open-all-along. A ≥2 guarantee enforced through an unreliable channel is ceremony, not safety. Breaking change authorized.
- **Ban tests that execute markdown-extracted shell; CI-run the static survivors** — **Decided.** The G-class escalation (`eval` → param expansion → `sed -e 'e'` allowlist bypass) is not convergent; `loop-arg-strip.test.sh` is deleted (single-sourcing already removed the copies it guarded), static-grep tests stay and join the CI glob. New-test harness rule: SBX/REPO/NOGIT `run_case` per `plan-research-required.test.sh` (folds the three open F-class threads).
- **Descope the two heavy security findings to issues** — **Decided.** Decision-hold authentication (round-12 #2) hardens the pre-existing GH-1544 flow; watch-mode contract enforcement (round-10) is a design question (server-side, per this epic — not more hooks). Absorbing heavy-lifts mid-landing is the exact anti-pattern that stalled #1620.
- **PR-C (model tiers) stays in scope, last** — **Decided.** Work is done and verified; it renders frontmatter across `ralph/`, so it must follow PR-B's SKILL.md churn. It is severable — deferring it does not block features 2–4 or the leaves they close — but there is no evidence-backed reason to defer.
- **Feature/leaf issues stay as-is; no re-decomposition** — **Decided.** Every leaf maps to landed content; only the PR vehicle changes.

None — no open design decisions.

## Implementation Approach

Four phases. Phase 1 (PR-A) and Phase 3 (PR-C) are derivations from the verified tip; Phase 2 (PR-B) is derivation **plus** the simplification deltas; Phase 4 is closeout. Each PR is built in its own worktree branched from current `origin/main`, populated by `git checkout feature/GH-1593 -- <paths>` (file-level, not cherry-pick — the tip tree is the source of truth), adjusted, verified, attested (`scripts/attest-pr.sh`), and merged via `bash scripts/merge-pr.sh <PR>` before the next phase starts. Sessions run from a bridge/worktree, so worktrees are created manually (`git worktree add -b <branch> .claude/worktrees/<name> origin/main`) per root CLAUDE.md § Environment Variables.

The three existing group plans remain the line-level spec for their content; this plan governs **what lands where, in what order, and what is deleted on the way**.

## Phase 1: PR-A — server core (mcp-server + CI checkers): closes #1609–#1618

- **depends_on**: null

### Overview

Land features 3 (tool surface, GH-1591 all phases) and 4's server half (GH-1592 Phases 1–4) in one TypeScript-dominant PR: 33 → 26 registrations (22 default + 4 SRE-gated), the four parameter-merges, both orphan deletions, the `get_issue` dependency-read fix, transition/lock/stale-clock/tree enforcement, and the `check-tool-consumers.sh` CI gate. Zero findings landed on this material across 12 rounds — it is the convergence-safe opening move, and it puts enforcement on main before Phase 2 removes the rails.

### Changes Required

1. **Open the pivot**: close PR #1620 — comment: superseded by this plan (link), branch preserved, findings disposition in Phase 2's ledger. Do not delete `feature/GH-1603`.
2. **Worktree**: `git worktree add -b feature/GH-1609-server-core .claude/worktrees/GH-1609-server-core origin/main`.
3. **Import from tip** (`git checkout feature/GH-1593 -- …`): `mcp-server/` (entire tree — src, tests, fixtures; leave `package.json` version to `release.yml`), `scripts/check-tool-consumers.sh`, `scripts/__tests__/check-tool-consumers.test.sh`, the `ci.yml` checker-step hunk (hand-apply; do not import model-tier steps — those are PR-C).
4. **Minimal `ralph/` companion edits** (required for `check-doc-rosters.sh` documented⊆source and `check-tool-consumers.sh` Direction A on the *pre-sweep* plugin tree; the neutralizing edits are already specified line-by-line in the GH-1591 plan — apply them against main's tree, NOT imported from tip, because tip deletes some of these files): roster-line deletions (`hero/SKILL.md` detect_stream_positions; `catch-up/SKILL.md` pipeline_status_summary; `setup/SKILL.md` get_project; `caretake/SKILL.md` archive_items + capture_snapshot) and call-site retargets (`brief-composition.md` → `pipeline_dashboard {view:"summary"}` incl. both headless allowlists; `setup/*` → `health_check {includeFields:true}`; `caretake/modes/hygiene.md` → `batch_update` filter-archive; `caretake/modes/trends.md` → `metrics_trends {capture:true}`; `caretake/modes/debug.md` collate_debug neutralize; `plan/plan-shapes.md` + `plan/decomposition.md` sync_plan_graph prose per GH-1591 Phase 4 §3; `sre-fixit.md` RALPH_SRE_ENABLE prerequisite).
5. **Docs**: CLAUDE.md/README tool-module + lib + env tables (RALPH_SRE_ENABLE, RALPH_LOCK_STALE_HOURS rows; tool tables at 22+4) — take the tip's versions of these table sections where they don't reference Phase-2 content.
6. **PR mechanics**: body carries GH-1591 Phase 7's release-notes section verbatim (removals/replacements/gated/behavior changes) + GH-1592's regression-inventory link + `Closes #1609 … Closes #1618` (ten lines). Merge commit message includes `#minor` (seven tool removals must not ride a patch bump). Attest, merge via `scripts/merge-pr.sh`, then `gh run list --commit <merge-sha>` → confirm `release.yml` fired and the `ralph/.mcp.json` pin advanced.

### Success Criteria

#### Automated Verification
- [ ] `cd mcp-server && npm run build && npm test` green at the PR head (≈1,824 pass / 0 fail)
- [ ] `tool-registration.test.ts` asserts 22; `tool-registration-sre-enabled.test.ts` asserts the 4 `sre__*` names
- [ ] `bash scripts/check-doc-rosters.sh` and `bash scripts/check-tool-consumers.sh` exit 0 on the PR tree; fixture suite `scripts/__tests__/check-tool-consumers.test.sh` passes
- [ ] Hook-test loop + `shellcheck -S error` green (hooks untouched in this PR)
- [ ] `grep -rn "detect_stream_positions\|pipeline_status_summary\|ralph_hero__get_project\|capture_snapshot\|archive_items\|sync_plan_graph\|collate_debug" ralph/ --include='*.md' | grep -v __tests__` → 0 hits
- [ ] Transition/lock/tree suites green: `workflow-transitions.test.ts`, `lock-guard`, `save-issue`, `advance-issue`, `batch-tools`, `tree-tools`, `directions`, `state-resolution` (two-way parity, real path)

#### Manual Verification
- [ ] Live board: `get_issue(1610)` reports `blockedBy: [#1609]`; illegal transition refused with legal-next-states named; `batch_update` filter-archive dry-run reports open-children skips; `metrics_trends {capture:true}` appends a snapshot row
- [ ] `merge-pr.sh` merged with attestation + CodeRabbit review present; release fired; board: #1609–#1618 Done, #1591 auto-advanced

## Phase 2: PR-B — plugin sweep + simplification deltas: closes #1603–#1608, #1619

- **depends_on**: [phase-1]

### Overview

Land feature 2 (GH-1590 all phases) and GH-1592 Phase 5 (hook demotion + zero-hook evidence) from the tip, then apply the pivot's deletions on top. Because PR-A already landed enforcement and the relocation apparatus is deleted rather than reviewed, this PR is dominated by deletions and mechanical retargets — the review surface that could not converge (prose git flows, envelope fencing, extracted-shell tests, env re-keying) is simply not in it.

### Changes Required

1. **Worktree** from post-A main: `git worktree add -b feature/GH-1603-plugin-sweep .claude/worktrees/GH-1603-plugin-sweep origin/main`; import `ralph/`, `specs/`, root `CLAUDE.md`/`README.md` doc sections, and `thoughts/shared/{research,plans,reviews}/2026-07-2{6,7}-GH-159*` from `feature/GH-1593`. Reconcile the three files PR-A edited on main against the tip's versions (tip wins where it deletes: `modes/trends.md`, `modes/debug.md` are gone; `modes/hygiene.md` keeps the tip version — verify the `batch_update` archive call and the rehomed `metrics_trends {capture:true}` heartbeat line survive).
2. **Simplification delta — decomposition gate** (breaking-authorized): delete `ralph/hooks/scripts/split-postcondition.sh` + `__tests__/split-postcondition.test.sh`; remove the registration (`plan/SKILL.md:76` region) and the Step-0 `RALPH_SUBCOMMAND` case export; restore `plan/SKILL.md:150` to the file-path-discrimination statement (no exceptions clause); remove the `epic-split` re-export and `RALPH_SPLIT_COUNT` export from `decomposition.md` §Atomic split and `plan/SKILL.md:204`, replacing them with one prose rule: *"An atomic split that creates fewer than 2 children is a failed split — report it, do not advance the parent."* Sweep the prose references (`form/SKILL.md:144`, `plan/SKILL.md:52`). Server-side ceiling + edge sanity (landed in PR-A) remain the enforced contract.
3. **Simplification delta — test policy**: delete `ralph/skills/shared/__tests__/loop-arg-strip.test.sh`. Port `caretake-watch.test.sh` and `hero-auto-tick-audience.test.sh` to the SBX/REPO/NOGIT `run_case` harness (three open review threads). Extend the `ci.yml` hook-test discovery glob with `ralph/skills/*/__tests__` so `auto-alias`, `loop-continuation`, `loop-refusal`, `mcp-prefix` run in CI (all static greps — verify none executes extracted content before wiring).
4. **Disposition ledger — the 18 open #1620 threads + finding classes** (each must be accounted for in the PR body):
   - *Dissolved by re-cut* (target machinery absent at tip): enrich git-flow findings (A-class, 14), envelope injection + its tests (I-class on `watch-dispatch.md` fencing, G-class `enrich-outcome-tokens`/`hero-watch-envelope`/`loop-dispatch-no-double-mode` tests), auto-tick marker machinery (round-12 #4), `split-*` arming findings (H-class on the deleted gates, round-12 #3).
   - *Re-applied from the GH-1603 tail* (file-level cherry-pick; each verified against the PR-B tree): the `autopilot-enable-gate.sh` Critical fix (arming must not trust `RALPH_SUBCOMMAND` alone); the `event-taxonomy.md` watcher-route correction (round-4 open thread); incidental D/J fixes where the target line exists at tip — `research/playwright-baseline.md:110` literal `...`, `research/SKILL.md:181` bare `scripts/merge-pr.sh`, markdown-fence lint on surviving files.
   - *Folded fresh*: the six E-class altitude moves (procedure prose out of `hero/SKILL.md` §Auto tick → `auto-tick.md` sibling, `plan/SKILL.md` ×2, `form/SKILL.md`, `research/SKILL.md`, `shared/auto-alias.md`) — this is the PR's own thesis, held to it.
   - *Follow-up issues* (Phase 4): decision-hold authentication; watch-mode contract enforcement design; enrich git-flow extraction to a tested script; ledger/payload-based arming for the surviving env-scoped hooks.
5. **Zero-hook evidence refresh**: re-run the GH-1592 Phase 5 §3 stdio drive against the PR-B head; update the evidence doc's SHAs/date in place.
6. **PR mechanics**: body carries the mode tally (45 → 35 awk output), per-deletion audit evidence lines (GH-1590 requirement), the disposition ledger, and the breaking-changes register (§ Migration Notes). `Closes #1603 … Closes #1608, Closes #1619`. Attest, merge, confirm `release-ralph.yml` fired.

### Success Criteria

#### Automated Verification
- [ ] Mode-count awk prints **35** (per-verb: catch-up 3, form 2, research 2, plan 5, impl 4, review 4, caretake 8, hero 4, setup 3); hook count `ls ralph/hooks/scripts/*.sh | wc -l` → **34**
- [ ] `grep -rn 'epic-split\|RALPH_SPLIT_COUNT\|split-postcondition' ralph/ scripts/ CLAUDE.md README.md` → 0 hits; `grep -rn 'RALPH_SUBCOMMAND' ralph/skills/plan/` → 0 hits
- [ ] GH-1590's per-phase sweep set green at the final tree: no `--mode debug|postmortem|trends|narrative|dashboard|retro|classify|prove|split` dispatches, no `watch-pr|watch-upstream|watch-blockers`, no `label-routing|event-classes`, no `triage-agent`, roster heading at 15 agents
- [ ] `grep -rln 'eval' ralph/skills/*/__tests__/ ralph/hooks/scripts/__tests__/` → no test evals extracted markdown (manually inspect any hit)
- [ ] Full hook/script/skill test loops green **in CI** (new glob active); ShellCheck green; `check-doc-rosters.sh` + `check-tool-consumers.sh` green
- [ ] Zero-hook evidence doc updated with PR-B head SHA; every invariant row still shows a server-side refusal transcript

#### Manual Verification
- [ ] `/ralph:plan --mode epic` on an M issue: atomic split runs with server ceiling only; a single-child split reports failure without a Stop-hook block
- [ ] `hero --mode auto` arming smoke: `--tick` string observed, watcher arms, one dispatch + `result:` line
- [ ] `/ralph:caretake --mode watch` (bare) sweeps all three kinds; board: #1603–#1608 + #1619 Done; #1590 + #1592 auto-advanced

## Phase 3: PR-C — capability-tier model config: closes #1593

- **depends_on**: [phase-2]

### Overview

Land GH-1593 unchanged (all four phases: registry + renderer + drift gate, site-manifest sweep, `claude-code-opus` second mapping, attestation `models[]`). Runs last because the renderer rewrites `model:` frontmatter across `ralph/` and must render against the post-PR-B tree.

### Changes Required

1. Worktree from post-B main; import from tip: `.ralph-models.yml`, `scripts/model-tiers/`, `scripts/check-model-tiers.sh`, `mcp-server/src/lib/model-tier-registry.ts` + its tests, `scripts/attest-pr.sh` / `validate-attestation.sh` + `scripts/__tests__/` extensions, `docs/model-tier-policy.md`, the `ci.yml` model-tier step.
2. Re-run the renderer `--check` against the post-B tree; where PR-B's SKILL.md/agent churn moved a manifest site, update `sites:` in `.ralph-models.yml` rather than hand-editing pins. Re-verify the second-mapping demonstration still retargets exactly the 5 frontier sites (vs `CLAUDE_CODE_SUBAGENT_MODEL` flattening 18 of 23) — the epic's AC-5 evidence.
3. PR body: `Closes #1593`. Attest, merge, confirm both release workflows' behavior (touches `mcp-server/` and `ralph/`).

### Success Criteria

#### Automated Verification
- [ ] `npx vitest run src/__tests__/model-tier-registry.test.ts` green (incl. AC-2 byte-identical default-mapping regression); `node --test scripts/model-tiers/`; `bash scripts/check-model-tiers.sh` exit 0 on the tree and exit 1 on a hand-edited pin (spot check)
- [ ] `attest-pr.test.sh` + `validate-attestation.test.sh` green (models[] optional, malformed → failure)
- [ ] Full per-PR gate set green

#### Manual Verification
- [ ] One verb run under the `claude-code-opus` rendering; the PR's own attestation carries `models[]`
- [ ] Board: #1593 Done; #1588 epic auto-advanced (all five features Done)

## Phase 4: Closeout — follow-ups, equivalence check, board truth

- **depends_on**: [phase-3]

### Changes Required

1. **File the four follow-up issues** (each with the finding citations from the PR #1620 digest): (a) authenticate the `## Decision Request` hold path (bind holds to bot-authored comment IDs or an issue-body marker); (b) design server-side handling for untrusted issue-body content in watch dispatch (replace prose fencing); (c) extract enrich's git/PR flow into a tested script under `scripts/` (A-class root fix); (d) replace `RALPH_SUBCOMMAND` arming with payload/ledger discrimination in the surviving env-scoped hooks (H-class root fix).
2. **Equivalence assertion**: `git diff feature/GH-1593 main -- mcp-server/ scripts/` → empty except intended deltas; `git diff feature/GH-1593 main -- ralph/` → exactly the Phase 2 deletions + re-applied fixes + PR-C renders. Any unexplained hunk is investigated before the epic closes.
3. **Board sweep**: epic #1588 Done with all ACs checked (restated where the plans restated them: 45→35 modes, 22 tools); #1620 closed; branches `feature/GH-{1603,1609,1615,1593}` may now be deleted **only on explicit operator confirmation** (not automated).

### Success Criteria

- [ ] Four follow-up issues exist and are linked from the epic's closing comment
- [ ] Equivalence diffs reviewed; zero unexplained hunks
- [ ] Epic #1588 Done; 18 leaves + 4 features Done; no dangling In Progress locks

## Testing Strategy

- **Per-PR gates** (all three): full mcp-server vitest, hook/script/skill bash loops, ShellCheck, the three checkers, attestation, CodeRabbit review — merged only through `scripts/merge-pr.sh`.
- **Convergence watch**: if any re-cut PR exceeds **3** CodeRabbit rounds with a non-decaying finding rate, stop fixing in-place and re-slice the offending surface — that signal was ignored for 9 rounds on #1620.
- **Cross-PR invariant**: main is releasable after every merge (each PR is self-consistent: PR-A carries its own prose neutralization; PR-B carries its own roster/doc sweeps).
- **Evidence artifacts**: zero-hook transcript (PR-B), second-mapping diff (PR-C), disposition ledger (PR-B body).

## Performance Considerations

None beyond those recorded in the superseded plans (summary-view payload guarantee, snapshot cadence 6h → 1h, archive-scan `subIssuesSummary` field).

## Migration Notes — breaking-changes register (no aliases; operator-facing)

- **Tools removed** (→ replacement): `detect_stream_positions` (none), `pipeline_status_summary` (→ `pipeline_dashboard {view:"summary"}`), `get_project` (→ `health_check {includeFields:true}`), `capture_snapshot` (→ `metrics_trends {capture:true}`), `archive_items` (→ `batch_update` archive ops + filter), `sync_plan_graph` (none — wire edges at decomposition), `collate_debug` (none). **Gated**: 4 `sre__*` behind `RALPH_SRE_ENABLE=true`.
- **Modes removed/renamed** (hard stop, no alias): `caretake --mode debug|postmortem|trends|split`; `retro` → `reflect`; `watch-{pr,upstream,blockers}` → `watch [--kind pr|upstream|issue]`; `catch-up --mode narrative|dashboard`; `hero --mode classify` → internal `--tick`; `research --mode prove` → default intake. `caretake:split` queue-drain capability ends.
- **Contracts removed**: `RALPH_SUBCOMMAND=epic-split` arming; `RALPH_SPLIT_COUNT`; the ≥2-children Stop gate (now prose + server ceiling); `RETRO *` → `REFLECT *`, watcher tokens → `WATCH-<KIND> *`.
- **Behavior changes**: server-refused illegal transitions/locks everywhere (any harness); loud `force`; filter-archive skips open-children parents; `get_issue` blocking/blockedBy from native edges; stale-lock clock from field `updatedAt`.
- **Out-of-repo consumers to retarget**: headless `--allowedTools` lists naming `pipeline_status_summary`; scheduled `capture_snapshot` calls; any schedule invoking removed caretake modes.
- **Releases**: PR-A `#minor` (mcp-server), PR-B `release-ralph`, PR-C both. Verify each fired per root CLAUDE.md.

## References

- Superseded-in-part plans: `2026-07-26-GH-1590-group-skill-surface-reduction.md`, `2026-07-26-GH-1591-group-tool-surface-reduction.md`, `2026-07-26-GH-1592-group-server-side-invariants.md`; landing-order source: the three `*-plan-of-plans.md` docs.
- Research sweeps (authoritative inventories): `2026-07-26-GH-159{0,1,2,3}-*.md` (copied onto this branch under `thoughts/shared/research/`).
- Evidence: `thoughts/shared/reviews/2026-07-27-GH-1619-zero-hook-lifecycle-evidence.md`; PR #1620 review history (12 rounds; digest distilled into § Key Discoveries; branch `feature/GH-1603` tail `61c2f910..53836761`).
- Issues: #1588 (epic), #1590–#1593 (features), #1603–#1619 (leaves), #1589/PR #1602 (merge gate, Done), GH-1538 (feature=PR unit — layer-sliced here by decision), GH-1544 (decision-hold flow, follow-up target).

## Execution Log

### 2026-07-29 — Phase 1 (PR-A) complete; unplanned release-tooling fix

**Phase 1 landed as intended.** [PR #1624](https://github.com/cdubiel08/ralph-hero/pull/1624) merged at `1a5dfc24` through `scripts/merge-pr.sh` (`attestation=true external=true force=false` — no override). Closes #1609–#1618; #1591 auto-advanced via `advance-parent.yml`. PR #1620 closed with a pivot comment; `feature/GH-1603` preserved.

Shape matched the thesis: 83 files, **93% `mcp-server/src`**, `ralph/` net **−158 lines**.

**The slice hypothesis held.** Review convergence, against #1620's 12 rounds with a non-decaying rate:

| Round | Actionable | Verdict |
|---|---|---|
| 1 | 12 | CHANGES_REQUESTED |
| 2 | 1 | CHANGES_REQUESTED |
| 3 | 0 | COMMENTED |
| 4 | 0 | APPROVED |

**Defects the review caught that the plan did not anticipate** (all fixed in PR-A, all in code imported from the verified tip — i.e. they predate this pivot and would have shipped either way):

- 🔴 **Lock destruction** (`issue-tools.ts`) — the GH-1617 claim-clock refresh cleared `Workflow State` and relied on the step-4e aliased batch to restore it. A failure there unwound with the field cleared, and an absent state is permissive to *both* `isLegalTransition` and `isLockConflict` — so the claim being refreshed was silently destroyed and the issue left claimable. Re-set is now immediate and adjacent.
- 🟠 **Guard bypass** (`batch-tools.ts`) — transition legality and the lock guard validated the *first* `workflow_state` op via `.find()` while step 3 wrote *every* op; a duplicate applied unchecked. Duplicates now refused up front.
- 🟠 **Destructive preview** (`batch-tools.ts`) — `{issues, dryRun: true}` routed to the explicit path, which never read the flag: a preview performed a real archive and reported `dryRun: false`. Now honored on both paths.
- 🟠 **Unbounded query** (`tree-tools.ts`) — up to ~2500 unchunked aliases would exceed GitHub's complexity limits and fail a legitimate batch wholesale. Now chunked, under a single `repository(...)` selection.
- 🟡 **Self-granting checker** — `check-tool-consumers.sh` collected grants from the whole `SKILL.md`, so a fully-prefixed tool name in the *body* satisfied its own grant check, masking the drift the checker exists to catch. Scoped to frontmatter, with a body-only fixture.

Plus the earlier round: `resolveLockStaleHours(0)` marking every lock stale, `isLegalParentGateAdvance` failing open on an unrecognized state, and a `ProjectV2Item` read on the repo endpoint that breaks split-token setups.

**Deviations from the plan as written:**

1. `ralph/hooks/scripts/ralph-state-machine.json` moved into PR-A (plan implied PR-B). The repaired two-way parity test — previously passing vacuously on a nonexistent path — fails without it. All edges are additive; `state-gate.sh` only becomes more permissive.
2. `caretake/modes/hygiene.md` took main's version, not the tip's. The tip adds a rehomed `capture_snapshot` step because PR-B deletes `trends.md`; in PR-A `trends.md` still exists, so it was retargeted to `metrics_trends {capture: true}` instead. Exactly one snapshot producer exists at every point in the sequence.
3. `caretake/modes/debug.md` became a retirement stub rather than a prose-neutralized body — its tool is deleted in PR-A and the mode row in PR-B, so a stub prevents an intermediate `main` from instructing an agent to call a tool that no longer exists.
4. `git checkout <ref> -- <path>` adds and modifies but never deletes; 18 removed files had to be deleted explicitly. Worth knowing for PR-B and PR-C, which use the same import mechanism.

**Unplanned but required — release tooling was broken.** PR-A carried `#minor` for seven tool removals and published as **2.5.204, a patch**. Root cause: `release.yml` detected markers with `\b#minor\b`, and `\b` matches only at a word/non-word transition — a marker preceded by whitespace is non-word followed by non-word, so no boundary exists and the match *never fired*. Every release had silently taken the patch branch. `gh pr merge --merge` puts the PR title in the commit body, so the marker always lands after a space: precisely the case that never matched.

Fixed in [PR #1625](https://github.com/cdubiel08/ralph-hero/pull/1625) (merged `e71c1ce2`) with `(^|[^[:alnum:]])#minor([^[:alnum:]]|$)`, guarded by `scripts/__tests__/release-bump-detection.test.sh` — 14 cases, patterns extracted *from* the workflow so a regression there fails the test rather than drifting from a copy. Verified the guard can fail: 3 failures against the old regex, and it detects a swapped major/minor branch order. **2.6.0 published** via `workflow_dispatch` (npm, `package.json`, `ralph/.mcp.json`, and tag `v2.6.0` all verified consistent).

**Operational notes for PR-B/PR-C:**

- A `Review rate limited` CodeRabbit check does **not** self-heal — clearing the quota only permits a *new* request. Treat it as "needs an explicit `@coderabbitai full review`", never as "wait". Six full reviews on #1624 (several redundant) exhausted the plan quota; let the automatic push review do the work.
- The `ralph-attestation` status goes stale whenever `validate` runs between the push and the re-attest. Expect one `gh run rerun` per PR; it is not a signal.
- Bump detection now works from the commit message, so PR-B (`release-ralph`) and PR-C need no manual dispatch.

**Remaining:** Phase 2 (PR-B) and Phase 3 (PR-C) unchanged. Board: 10 of 18 leaves closed; #1590, #1592, #1593 open.
