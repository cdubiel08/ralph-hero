# Director Event Classification Taxonomy

This file is the **canonical schema** for Director's event classifier. The classifier performs a lookup against this table to determine which team handles a given issue. Entries are evaluated in the order listed — `trigger:*` labels take highest priority, then `blocked:*` labels (watcher routing), then automation labels, and `workflow_state` matches are the fallback.

**Extending this taxonomy**: Features D and F will add new rows here via PR. Each row is independent; adding a new event class requires only appending a row to the appropriate section and updating the notes column to identify the producer. No changes to Director's classifier logic are required — the lookup is table-driven.

---

## Priority 1 — Explicit trigger labels (highest priority)

These labels are placed manually (by human or iOS remote-control shortcut) or by external event shims. A `trigger:<team>` label on any issue causes Director to dispatch that team regardless of workflow state. The label is consumed (removed) after dispatch.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `trigger:builders` | builders | Manual override: force builder dispatch. Hero handles the issue. |
| any | `trigger:watch` | watchers | Manual override: force watcher dispatch. Feature C ships `ralph:hero --mode watch`. |
| any | `trigger:scouts` | scouts | Manual override: force scout dispatch. Dispatches `ralph-playwright` skills (a11y-scan / test-e2e / storybook-test / visual-diff) directly for the issue. |
| any | `trigger:caretake` | caretakers | Manual override: force caretaker dispatch. Feature G ships `ralph:caretake`. |
| any | `trigger:memorykeepers` | memorykeepers | Manual override: force memorykeeper dispatch. No skill yet; Director emits `needs input:` marker. |

## Priority 2 — Blocked-condition labels (watcher routing)

These labels are written by triage's `WAIT-pr`/`WAIT-upstream` verdicts and park an item against a named, watched condition. Director fires the matching caretake **watcher sweep** (board-wide — it processes every parked item of that kind, including this one) so the condition is re-evaluated immediately rather than at the next heartbeat. The label is **NOT consumed** — the watcher owns its lifecycle and strips it only when the condition resolves.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `blocked:pr-*` (prefix-match) | caretakers | Fire `Skill("ralph:caretake", args="--mode watch --kind pr")` — board-wide sweep, no issue scoping. Label persists. Producer: triage `WAIT-pr` (#1404); consumer: `caretake --mode watch --kind pr` (#1406). |
| any | `blocked:upstream` (exact-match) | caretakers | Fire `Skill("ralph:caretake", args="--mode watch --kind upstream")` — board-wide sweep. Label persists. Producer: triage `WAIT-upstream` (#1404); consumer: `caretake --mode watch --kind upstream` (#1407). |

## Priority 3 — Automation labels (label exists, producer pending until noted)

These labels are written by automated producers (event shims, dream-loop classifier, monitoring bridges). They signal that a specific team should handle the issue without requiring a manual trigger.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `watcher-auto` | watchers | Label applied manually or by a custom monitoring bridge (see `ralph/hooks/` for the watcher entrypoint). `ralph:hero --mode watch` handles the team dispatch. |
| any | `scout-auto` | scouts | Label applied manually or by a custom CI step. Dispatches `ralph-playwright` skills directly (a11y-scan / test-e2e / storybook-test / visual-diff). (`playwright-auto.yml` and the nightly scout script were retired with `plugin/ralph-hero/` in GH-1438.) |
| any | `process-improvement` | caretakers | Label written by dream-loop cluster classifier (`scripts/dream/reflect.py::emit_process_improvement_issue`). Feature G ships `ralph:caretake`. |

## Priority 4 — Workflow state (fallback routing)

When no trigger, blocked, or automation labels are present, Director routes by workflow state.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| `Backlog` | none | caretakers | New issues need triage. Caretakers handle intake and routing. Feature G ships `ralph:caretake`; until then Director emits `needs input:` marker. |
| `Research Needed` | none | builders | Issue is queued for research. Hero handles the full analyst → builder pipeline. |
| `Research in Progress` | none | builders | Research is underway. Hero manages continuation. |
| `Ready for Plan` | none | builders | Research complete; issue needs a plan. Hero handles planning. |
| `Plan in Progress` | none | builders | Planning is underway. Hero manages continuation. |
| `Plan in Review` | none | builders | Plan needs review. Hero handles the review gate. |
| `In Progress` | none | builders | Active implementation. Hero orchestrates impl-agent. |
| `In Review` | none | builders | PR open, awaiting review. Hero manages the merge gate. |
| `Human Needed` | none | caretakers | Issue is blocked and needs human attention. Caretakers handle the unblock flow. Feature G ships `ralph:caretake`; until then Director emits `needs input:` marker. |
| `Done` | none | — | Terminal state. Director skips — no dispatch needed. |
| `Canceled` | none | — | Terminal state. Director skips — no dispatch needed. |

---

## Team → entrypoint mapping

| team | skill entrypoint | status |
|------|-----------------|--------|
| builders | `ralph:hero` | live |
| watchers | `ralph:hero --mode watch` | pending Feature C (GH-1270) |
| scouts | `Skill("ralph-playwright:a11y-scan")` / `Skill("ralph-playwright:test-e2e")` / `Skill("ralph-playwright:storybook-test")` / `Skill("ralph-playwright:visual-diff")` | live |
| memorykeepers | manual `dream-now` | no skill yet; Director emits `needs input:` |
| caretakers | `ralph:caretake` | pending Feature G (GH-1274) |

---

## Classification algorithm (for implementors)

Director evaluates in this order:

1. Fetch the candidate issue's labels array.
2. Check for any `trigger:*` label (Priority 1). First match wins.
3. Check for a `blocked:*` label (Priority 2): prefix-match `blocked:pr-` → fire `caretake --mode watch --kind pr`; exact-match `blocked:upstream` → fire `caretake --mode watch --kind upstream`. Dispatch is a board-wide watcher sweep (no issue scoping); the label is NOT consumed.
4. Check for any automation label: `watcher-auto`, `scout-auto`, `process-improvement` (Priority 3). First match wins.
5. Fall through to `workflow_state` lookup (Priority 4).
6. If the resolved team's entrypoint does not yet exist, emit `needs input: team <name> not yet implemented (Feature <X>); skipping dispatch` and continue to the next event.

---

## Producers

This table is the canonical inventory of automated label producers as of Feature D (GH-1271). New producers should add a row here when they land.

| Label | Producer file | Trigger condition |
|-------|---------------|-------------------|
| `watcher-auto` | manual or custom monitoring bridge | GCP Cloud Monitoring alert (or equivalent) delivered to the board; the automated bridge was retired with `plugin/ralph-hero/` in GH-1438 |
| `process-improvement` | `scripts/dream/reflect.py::emit_process_improvement_issue` | Dream-loop cluster of size ≥ threshold (default: 5) with ≥ N% `tool_use_error` or `verdict: BLOCKED` signals (default: 30%) |
| `scout-auto` | manual or custom CI step | PR opened/synchronized/reopened with UI-touching changes; `playwright-auto.yml` and the nightly scout script were retired with `plugin/ralph-hero/` in GH-1438 |
