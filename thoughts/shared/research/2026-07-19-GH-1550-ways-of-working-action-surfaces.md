---
date: 2026-07-19
status: complete
type: research
tags: [ways-of-working, action-surfaces, daily-brief, intake, catch-up, form, decision-queue, human-attention]
git_commit: f5b629db5cdb1cf285cc097f031c1d4675641143
branch: main
github_issue: 1550
github_url: https://github.com/cdubiel08/ralph-hero/issues/1550
---

# Research: Ways-of-working action surfaces — brain dump, in-progress detail, daily brief

## Research Question

The human should be able to (1) brain-dump to a session and have work get formed and flow into the pipeline without further ceremony, (2) ask for details about in-progress work at any time, and (3) sit one daily brief that walks through and resolves all open design decisions (Decision Requests from GH-1544, Unblock Requests, held plans) in a single sitting. What do existing surfaces cover, where are the gaps, and what does prior art already settle?

## Prior Work

- builds_on:: [[2026-07-17-GH-1544-decision-gated-plan-approval-merge-auto]] — shipped the decision-gated plan hold (`## Decision Request` + `PLAN AWAITING DECISION`); this research asks how those decisions get *batched and resolved daily*.
- builds_on:: [[2026-05-02-hello-composable-rewrite]] — the settled layered architecture (deterministic ranking / stochastic narrative / thin wrapper) that any brief surface must reuse.
- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] — the 9-verb surface discipline (P2/P3/P9) that caps how this work may add surfaces.
- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]] and [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]] — the deleted chief-of-staff morning brief; the direct precedent for J3.
- builds_on:: [[2026-05-05-GH-0706-retro-skill-session-pain-point-capture]] — unbuilt session-friction capture; establishes the `context: inline` constraint for conversational capture.
- builds_on:: [[2026-05-06-pipeline-status-summary-tool]] and [[2026-05-06-flow-state-vs-health]] — unbuilt ideas that directly serve J2.
- tensions:: `~/projects/thoughts/wiki/dont-notify-about-state-visible-through-data-plane.md` — constrains what a scheduled brief may push.

## Summary

All three jobs are close: the signals, tools, and answer protocols exist; what's missing is **chaining and enumeration**, not new machinery.

- **J1 (brain dump):** `/ralph:form` handles single-idea intake well, but everything it creates parks in `Backlog` with no onward motion — triage is a separate, later invocation — and drafts in `thoughts/shared/ideas/` never promote themselves. There is no multi-item dump (one invocation = one idea).
- **J2 (in-progress detail):** board-state reads exist (`pipeline_dashboard`, narrative, activity log) but nothing reports *phase-level* progress of an in-flight impl, the activity log only records hero's own dispatches, and `pipeline_dashboard`'s ~60KB payload makes it a poor programmatic source.
- **J3 (daily brief):** every decision signal is already scanned comprehensively (`directions-tools.ts` builds decision/unblock signal maps across the whole board) but `next_actions` slices to `limit` (default 3) — it is a ranker, not an enumerator. No surface lists all held decisions + unblocks + blocked items together; no walk-through-resolve loop exists; nothing scheduled delivers a brief since cos-mode was deleted.

The corpus has already settled the architecture (deterministic ranking + stochastic narrative + thin wrapper; interactive vs headless differ only at the picker layer) and the constraints (never prompt in auto paths; don't push what the data plane already shows; verb-count discipline). The cos-mode precedent shows the failure mode to avoid: a parallel stack that can be deleted out from under the workflow. The new work should compose the 9 verbs and the GH-1544 decision queue instead.

## Detailed Findings

### J1 — intake mechanics and gaps

- `/ralph:form` default flow (`ralph/skills/form/SKILL.md:60-167`): restate → parallel dedup sub-agents (`duplicate-detection.md`) → 5-option output picker → `create_issue(workflowState: "Backlog")` (`SKILL.md:132`, `issue-template.md:77`). **Nothing advances the issue past Backlog**; `caretake --mode triage` acts only on Backlog items in a separate invocation (`caretake/modes/triage.md:3,62-64`).
- `--mode draft` (`SKILL.md:169-197`): 2-3 clarifying questions → `thoughts/shared/ideas/YYYY-MM-DD-*.md`, no GitHub write. Promotion requires manually re-running `/ralph:form <path>` (`intake-shapes.md:12`).
- Draft-issue MCP tools exist and are underused for this: `create_draft_issue` / `convert_draft_issue` (`mcp-server/src/tools/project-management-tools.ts`).
- Conversational capture (harvesting a session's ideas/friction rather than a dictated single idea) was researched but never built (GH-706): it must run `context: inline` — a forked agent cannot see the conversation it would summarize. GH-706 also settled "extract first, confirm after" over "ask upfront."
- Anti-duplication is a first-class form step and must survive any batch-dump mode (research-doc inputs skip codebase re-investigation; `github_issue` frontmatter biases toward update-not-create).

### J2 — in-progress-detail mechanics and gaps

- `pipeline_dashboard` (`mcp-server/src/lib/dashboard.ts:37-89`) carries board `workflowState`, priority, estimate, age, locks, blockers — **no worktree, no plan-phase, no session data** (no "worktree" reference anywhere in the module). "In Progress" is as granular as it gets.
- `recent_activity` reads `~/.ralph-hero/activity/` JSONL, but the only in-repo writer is `hero-dispatch-log.sh` (one event per hero→verb dispatch). Manually-run `/ralph:impl` sessions and phase completions write nothing (the per-session writer died with `plugin/ralph-hero/`, GH-1438).
- The unbuilt `pipeline_status_summary` idea (2026-05-06) targets exactly this: ~10 numeric fields + top-N stuck issues in a 1-2KB payload vs `pipeline_dashboard`'s ~60KB (which exceeds tool-result caps and forces subagent round-trips). Companion idea `flow_state-vs-health` fixes the false-alarm OFF_TRACK signal on drained boards.
- `catch-up --mode dashboard` is deliberately read-only with a production-hardened "NEVER editorialize" rule (`dashboard-render.md:32-44`) — any richer progress surface should stay a *render*, not a recommender.

### J3 — daily-brief mechanics and gaps

- Decision signals are already fully scanned: `directions-tools.ts:254-317` (`buildDecisionSignalMap` / `buildUnblockSignalMap`) fetches comments for **every** Plan-in-Review and Human-Needed candidate. But output is sliced to `limit` (default 3) at `directions-tools.ts:596-644` — the comprehensive scan is used to rank, never to enumerate.
- `audience: "agent"` excludes `plan-decision` directions entirely (`directions.ts:955` — "an agent cannot answer a design decision"); `audience: "human"` includes them with `PLAN_DECISION_BOOST` (`directions.ts:325`). So the human-audience ranking already prioritizes decisions; only the enumeration surface is missing.
- Walk-through machinery exists piecewise: per-decision `Decision:`-headed pickers with answer fold-in (`plan-review.md:91-130`), unblock Q&A with state-return confirmation (`caretake/modes/unblock.md:22-142`). No surface chains them across all held items in one sitting.
- Answer protocols the human is expected to use today: reply on the issue or `/ralph:plan --mode review NNN` (Decision Requests); `/ralph:caretake --mode unblock` (Unblock Requests). Three PushNotification call sites exist (unblock post, decision-request post, hero double-BLOCKED) — all best-effort, all paired with a durable comment.
- Scheduled delivery is dead: the cos morning brief (GH-1255) shipped 2026-05-16 — weekday 06:30 launchd job, pi-based (zero Claude Code), ntfy push, brief written to `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md` — and was deleted with `plugin/ralph-hero/` (GH-1438). Machine remnants: `ntfy` still installed, `~/.ralph-hero/cos/` state dir, dream-loop launchd template as the surviving scheduled-job pattern (`scripts/dream/`). The restructure explicitly kept cos out of `/ralph:catch-up` because its value was zero-Claude-Code delivery.
- `caretake --mode all` is an existing heartbeat fan-out (hygiene + watch-* + report + trends) — the natural place a scheduled brief-preparation step could hang without a new scheduler.

### Settled architecture and constraints (corpus positions to preserve)

1. **Layered composition** (`2026-05-02-hello-composable-rewrite`): activity log (hooks, never LLM) → deterministic MCP tools (`next_actions`, `recent_activity`) → LLM narrative (`catch-up`) → thin wrapper (picker for interactive, follow-`recommended` for headless). "Both modes use the same compute."
2. **Auto mode is end-to-end** (`~/projects/thoughts/wiki/auto-mode-is-end-to-end.md`): no AskUserQuestion anywhere in an auto path; heuristics + fail-safe instead. The daily brief is *the* interactive sitting; everything else must not pause.
3. **Don't notify data-plane-visible state** (`~/projects/thoughts/wiki/dont-notify-about-state-visible-through-data-plane.md`): a scheduled push may carry only what the detached human can't see ("N decisions waiting"), not duplicate the board.
4. **Verb-count discipline** (`2026-05-22-ralph-slim-plugin-restructure`, P2/P3/P9): new capability lands as a `--mode` on an existing verb with 3-4 reference files, not a new verb; a 5th reference needs a structurally-distinct sub-mode to justify it.
5. **Production-hardened render rules**: dashboard never editorializes; ranking reasons never quote templated `reason` verbatim; estimate honesty ("never describe XL work as 'small'"); tiebreak transparency.
6. **Notification-fatigue history** (GH-466): the previous team-mode surface drowned the human in idle notifications; the fix was fewer, better-targeted events — a brief must aggregate, not multiply, pushes.

### The cos post-mortem lesson

The morning brief succeeded technically and died organizationally: it was a parallel stack (pi + own scripts + own prompts + own launchd) with no tie to the plugin's verb surface, so the GH-1438 restructure deleted it without anyone noticing the loss. Any resurrection should (a) live in the ralph plugin's own surfaces so refactors carry it forward, and (b) keep the *delivery* concern (schedule + push) as the only out-of-band piece, reusing the dream-loop launchd pattern.

## Open Assumptions to Walk Through Before Planning

1. **Brief host verb**: `catch-up --mode brief` (orientation cluster) vs `caretake` (board maintenance) vs a compositional wrapper. Restructure history says catch-up absorbed `hello/status/report/cos` — but cos's CLI paths were deliberately excluded.
2. **Enumeration home**: extend `next_actions` with an `enumerate: true`/`kind` filter vs a new small `decision_queue` MCP tool vs `pipeline_status_summary` absorbing it.
3. **J1 depth**: is "no further ceremony" satisfied by form auto-chaining into triage (issue lands, triage classifies, pipeline pulls), or does the user want dumped items to skip Backlog entirely (form sets Research Needed directly)? Multi-item dump: one session parsing N ideas → N form passes, or a batch mode?
4. **J2 depth**: is a compact status summary + narrative enough, or is phase-level impl progress (requires new activity-log writers in impl skill hooks) in scope now?
5. **Scheduled delivery**: launchd + ntfy resurrection (zero-Claude-Code, machine-local) vs relying on the user opening the daily sitting themselves (push-free) vs Claude-Code-based schedule (cloud Routines are documented as not honoring settings — deprecated path).
6. **Brief scope**: decisions/unblocks only, or also blocked PRs, stale locks, and CHANGES_REQUESTED items (the "everything needing a human" queue)?

## Files Affected

### Will Modify (candidates for the eventual plan)
- `ralph/skills/catch-up/SKILL.md` + a new brief reference sibling — brief mode host (assumption 1)
- `ralph/skills/form/SKILL.md`, `ralph/skills/form/intake-shapes.md` — dump/chaining changes (assumption 3)
- `mcp-server/src/lib/directions.ts`, `mcp-server/src/tools/directions-tools.ts` — enumeration (assumption 2)
- `mcp-server/src/tools/dashboard-tools.ts`, `mcp-server/src/lib/dashboard.ts` — compact summary (assumption 4)
- `ralph/skills/caretake/SKILL.md` (`--mode all` fan-out) and `scripts/` launchd template — scheduled delivery (assumption 5)

### Will Read (dependencies)
- `ralph/skills/plan/plan-review.md` — decision picker + fold-in contract (GH-1544, reuse as-is)
- `ralph/skills/caretake/modes/unblock.md` — unblock Q&A contract (reuse as-is)
- `ralph/skills/catch-up/next-action-ranking.md`, `dashboard-render.md` — hardened render rules
- `scripts/dream/` launchd templates — scheduled-job precedent

## References

- Deleted precedent: `thoughts/shared/plans/2026-05-14-GH-1252-ralph-hero-cos-mode.md`, `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md` (all phases CLOSED 2026-05-16; code deleted in GH-1438)
- Unbuilt ideas: `thoughts/shared/ideas/2026-05-06-pipeline-status-summary-tool.md`, `thoughts/shared/ideas/2026-05-06-flow-state-vs-health.md`, `thoughts/shared/research/2026-05-05-GH-0706-retro-skill-session-pain-point-capture.md`
- Architecture: `thoughts/shared/research/2026-05-02-hello-composable-rewrite.md`, `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`
- Mobile/dispatch surfaces: `thoughts/shared/research/2026-05-17-claude-code-dispatch-surfaces.md`, `thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md`, `thoughts/shared/plans/2026-05-18-GH-1300-remotetrigger-producer-critical-alerts.md`
- Notification history: `thoughts/shared/research/2026-03-01-GH-0466-idle-notification-spam.md`
- Wiki axioms: `~/projects/thoughts/wiki/auto-mode-is-end-to-end.md`, `~/projects/thoughts/wiki/dont-notify-about-state-visible-through-data-plane.md`, `~/projects/thoughts/wiki/lede-must-answer-the-title.md`
