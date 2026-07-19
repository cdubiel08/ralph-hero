---
date: 2026-07-19
status: draft
type: plan-of-plans
tags: [ways-of-working, action-surfaces, daily-brief, intake, catch-up, form, epic]
github_issue: 1550
github_issues: [1550, 1551, 1552, 1553, 1554, 1555]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1550
primary_issue: 1550
estimate: L
research_waived: research EXISTS at thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md (artifact comment on #1550) — plan-research-required.sh mis-roots to the workspace dir when the session CWD is ~/projects and cannot see it; human-approved override 2026-07-19
---

# Epic: Ways-of-working action surfaces — brain-dump custody chain, compact status, daily decision brief

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the research this epic crystallizes (gap table, cos post-mortem, corpus constraints).
- builds_on:: [[2026-07-17-GH-1544-decision-gated-plan-approval-merge-auto]] — the decision-hold machinery this epic batches into a daily sitting.
- builds_on:: [[2026-05-02-hello-composable-rewrite]] — layered composition contract (deterministic tools / stochastic narrative / thin wrapper) all features honor.
- builds_on:: [[2026-05-06-pipeline-status-summary-tool]] — Feature B implements this idea doc.
- tensions:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]] — the deleted parallel-stack morning brief; this epic deliberately inverts its architecture (logic in the plugin, only the trigger out-of-band).

## Overview

Three human jobs from the 2026-07-19 assumptions walkthrough, shipped as five features with **zero new verbs** — modes and tools on existing surfaces only:

1. **Brain dump (J1)**: capture thoughts at any maturity, enrich in the background, resurface in the brief. Capture never starts work.
2. **In-progress detail (J2)**: a compact accurate status read plus phase-level progress events.
3. **Daily brief (J3)**: one sitting that empties the whole human queue — plan decisions, unblocks, incubating thoughts, flagged items.

## Strategic Context

The 2026-07-17 investigation showed human attention going to merge-nudging and polling while design decisions surfaced late and badly. GH-1544 fixed the gate topology (decisions hold plans; merges run autonomously). This epic fixes the *cadence*: decisions currently arrive as scattered push notifications and board states; thoughts get lost unless the human commits to a full form session; "what's happening" requires reading a 60KB dashboard. The target operating model: **dump thoughts anytime with near-zero ceremony; one scheduled sitting per day resolves everything waiting on a human; status is one cheap question away.**

The cos-mode post-mortem is the architectural warning: the last daily brief was a parallel stack (pi + own scripts + own launchd) and was deleted wholesale by a refactor that couldn't see it. Here, all logic lives in ralph's verb surfaces and MCP server; the only out-of-band piece is a thin scheduled trigger.

## Design Decisions & Open Ambiguities

Resolved (2026-07-19 assumptions walkthrough with the user):

- **Brief host** — options: catch-up mode; caretake mode; new verb. **Decided: `catch-up --mode brief`.** Catch-up owns the orientation cluster; the 9-verb discipline forbids a new verb for this.
- **Enumeration home** — options: extend `next_actions`; new `decision_queue` tool. **Decided: extend `next_actions`** — the comprehensive scan already lives there; requirement attached: tested contract + one canonical caller (the brief).
- **Capture vs mobilization** — options: form auto-chains triage; dumped items skip Backlog; capture never starts work. **Decided: capture never starts work.** Mobilization is natural language, loop engineering, or an optional "kick off?" offer at form completion. Custody chain: capture → background enrichment → reminder via the brief.
- **J2 depth** — **Decided: start simple** — `pipeline_status_summary` + one `phase_completed` activity event; richer progress deferred.
- **Scheduled delivery** — options: launchd+ntfy resurrection; local Claude Code scheduled task; cloud Routines. **Decided: local Claude Code scheduled task** ("good enough right now"); cloud Routines are documented as not honoring committed plugin settings and are not viable.
- **Brief scope** — **Decided: the full human queue** (decisions, unblocks, incubating thoughts, flagged tail), not just design decisions.

None — no open design decisions.

## Shared Constraints

- **Auto-mode-is-end-to-end** (`~/projects/thoughts/wiki/auto-mode-is-end-to-end.md`): `--prepare`, enrichment, and every scheduled path are prompt-free; the interactive brief is the *only* sitting.
- **Data-plane axiom** (`~/projects/thoughts/wiki/dont-notify-about-state-visible-through-data-plane.md`): at most one push per day — "brief ready: N decisions, M unblocks, K thoughts" — nothing the board already shows.
- **Layered composition**: deterministic enumeration/summary in the MCP server (tested), stochastic narrative in the skill, thin wrapper for interactive-vs-headless. Both modes use the same compute.
- **Surface discipline** (restructure P2/P3/P9): each feature is a mode/tool on an existing surface; reference-file budget 3-4 per skill unless a structurally distinct sub-mode justifies more.
- **Reuse the answer contracts as-is**: GH-1544 `Decision:` pickers + fold-in (`ralph/skills/plan/plan-review.md:91-130`), unblock Q&A + state-return confirmation (`ralph/skills/caretake/modes/unblock.md:22-142`). The brief *orchestrates* them; it does not reimplement them.
- **Hardened render rules**: `dashboard-render.md` never-editorialize list, estimate honesty, tiebreak transparency.
- **Enrichment is cheap and non-committal**: locator sweep + `knowledge_search` + related issues appended to the idea file — never a full research doc per thought.

## Feature Decomposition

### Feature A: next_actions human-queue enumeration (#1551, S)
Extend `ralph_hero__next_actions` (`mcp-server/src/tools/directions-tools.ts`, `src/lib/directions.ts`) with an enumeration mode returning every human-actionable item unsliced — plan-decision holds, human-needed unblocks, blocked PRs, stale locks — reusing the existing full-board signal scans (`buildDecisionSignalMap`/`buildUnblockSignalMap`). Stable per-item shape (`kind`, ref, age, source-comment pointer). Vitest contract coverage. Default ranked-top-N path byte-compatible.

### Feature B: pipeline_status_summary + phase-completed activity event (#1552, S)
Implement the 2026-05-06 idea: compact summary tool in `dashboard-tools.ts` reusing `lib/dashboard.ts` aggregation (~1-2KB). Add one `phase_completed` activity event from the impl hook chain (`impl-verify-commit.sh`) so `recent_activity`/narrative can report in-flight progress. No flow_state split (deferred).

### Feature C: catch-up --mode brief (#1553, M)
The daily sitting. Interactive: narrative header → enumerate (Feature A) → walk decisions (GH-1544 pickers), unblocks (unblock Q&A), incubating thoughts (Feature D contract: flesh out / promote via form / keep / drop) → read-only flagged tail → closing summary. Headless `--prepare`: enumeration + at-most-one push, idempotent per day, zero prompts, zero comment posts. One new reference sibling (`brief-composition.md`). Dispatches follow-ups via existing verbs only.

### Feature D: capture custody chain (#1554, M)
Polymorphic capture on `/ralph:form --mode draft`: accepts any-maturity thoughts, multi-thought dumps yield N idea files (extract first, confirm after — GH-706 principle). Never touches board state; form default completion may offer "kick off?" (interactive only). Background enrichment pass in the `caretake --mode all` fan-out: `status: draft` idea files get `## Enrichment` (locator + prior art + related issues) and `status: forming`. Frontmatter contract (`status`, `captured`, `enriched`) consumed by Feature C.

### Feature E: scheduled brief preparation (#1555, S)
Local Claude Code scheduled task running `/ralph:catch-up --mode brief --prepare` weekday mornings. Idempotency guard, setup/teardown runbook in the catch-up docs. Only the trigger is out-of-band (cos lesson).

## Integration Strategy

- **A → C** is the load-bearing contract: the brief renders exactly what enumeration returns; no second scan, no skill-side re-ranking. Contract enforced by vitest on the tool side and by C's reference doc naming A as the only source.
- **D → C**: the idea-file frontmatter contract is the *entire* interface — the brief globs `thoughts/shared/ideas/` for `status: draft|forming` and reads `## Enrichment` if present. No MCP surface between them.
- **B → C** is soft: the brief's narrative header uses `pipeline_status_summary` when available, degrading to the existing narrative path — B is not a blocker for C.
- **C → E**: the schedule invokes the same skill mode; there is no schedule-only code path. Testing E is running C's `--prepare` by hand.
- Answer machinery (GH-1544 pickers, unblock Q&A) is consumed by reference, so plan-review/unblock changes propagate to the brief automatically.

## Feature Sequencing

1. **Wave 1 (parallel)**: Feature A (#1551), Feature B (#1552), Feature D (#1554) — no interdependencies.
2. **Wave 2**: Feature C (#1553) — blocked by A (#1551) and D (#1554); B soft-feeds it.
3. **Wave 3**: Feature E (#1555) — blocked by C (#1553).

Dependency edges on the board: #1551→#1553, #1554→#1553, #1553→#1555.

## What We're NOT Doing

- No new verbs, no new plugins, no pi/cos parallel stack.
- No cloud Routines (documented plugin-settings gap) and no launchd+ntfy resurrection in this epic — the local scheduled task is the v1; ntfy remains a future option if phone push becomes necessary.
- No auto-advancement of captured thoughts into the pipeline — mobilization stays human-initiated.
- No full research docs per captured thought; enrichment is bounded.
- No flow_state/health split, no per-task progress streaming, no Streamlit-style dashboard (J2 stays simple).
- No changes to the GH-1544 decision/unblock answer contracts themselves.
- No mobile-answering integration (GH-1275/GH-1300 territory) — the brief is a desk sitting for now.

## Migration Notes

Purely additive: new tool + tool param (mcp-server minor release), new skill mode + reference, new caretake fan-out step, new activity event kind (readers ignore unknown kinds), new scheduled task (operator opt-in via runbook). No state-machine changes; no existing-surface behavior changes except the optional "kick off?" offer at form completion. Rollback = don't run the schedule; each feature reverts independently.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1550 (children #1551–#1555)
- Research: `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md`
- Contracts consumed: `ralph/skills/plan/plan-review.md` (decision pickers), `ralph/skills/caretake/modes/unblock.md` (unblock Q&A), `ralph/skills/catch-up/*` (narrative/render rules), `mcp-server/src/tools/directions-tools.ts` (signal scans)
- Idea docs implemented: `thoughts/shared/ideas/2026-05-06-pipeline-status-summary-tool.md`
- Precedent inverted: `thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md` (cos post-mortem)
