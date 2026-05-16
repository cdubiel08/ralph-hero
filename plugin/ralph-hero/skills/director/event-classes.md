# Director Event Classification Taxonomy

This file is the **canonical schema** for Director's event classifier. The classifier performs a lookup against this table to determine which team handles a given issue. Entries are evaluated in the order listed — `trigger:*` labels take highest priority, automation labels come next, and `workflow_state` matches are the fallback.

**Extending this taxonomy**: Features D and F will add new rows here via PR. Each row is independent; adding a new event class requires only appending a row to the appropriate section and updating the notes column to identify the producer. No changes to Director's classifier logic are required — the lookup is table-driven.

---

## Priority 1 — Explicit trigger labels (highest priority)

These labels are placed manually (by human or iOS remote-control shortcut) or by external event shims. A `trigger:<team>` label on any issue causes Director to dispatch that team regardless of workflow state. The label is consumed (removed) after dispatch.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `trigger:builders` | builders | Manual override: force builder dispatch. Hero handles the issue. |
| any | `trigger:watch` | watchers | Manual override: force watcher dispatch. Feature C ships `ralph-hero:watch`. |
| any | `trigger:scouts` | scouts | Manual override: force scout dispatch. Feature F ships `ralph-hero:scouts`. |
| any | `trigger:caretake` | caretakers | Manual override: force caretaker dispatch. Feature G ships `ralph-hero:caretake`. |
| any | `trigger:memorykeepers` | memorykeepers | Manual override: force memorykeeper dispatch. No skill yet; Director emits `needs input:` marker. |

## Priority 2 — Automation labels (label exists, producer pending until noted)

These labels are written by automated producers (event shims, dream-loop classifier, monitoring bridges). They signal that a specific team should handle the issue without requiring a manual trigger.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `watcher-auto` | watchers | Label written by Cloud Monitoring → board bridge. Producer ships in Feature D (GH-1271). Feature C ships the `ralph-hero:watch` entrypoint. |
| any | `scout-auto` | scouts | Label written by Scout scheduling hook (on-PR + nightly). Producer ships in Feature F (GH-1273). Feature F also ships `ralph-hero:scouts`. |
| any | `process-improvement` | caretakers | Label written by dream-loop cluster classifier output. Producer ships in Feature D (GH-1271). Feature G ships `ralph-hero:caretake`. |

## Priority 3 — Workflow state (fallback routing)

When no trigger or automation labels are present, Director routes by workflow state.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| `Backlog` | none | caretakers | New issues need triage. Caretakers handle intake and routing. Feature G ships `ralph-hero:caretake`; until then Director emits `needs input:` marker. |
| `Research Needed` | none | builders | Issue is queued for research. Hero handles the full analyst → builder pipeline. |
| `Research in Progress` | none | builders | Research is underway. Hero manages continuation. |
| `Ready for Plan` | none | builders | Research complete; issue needs a plan. Hero handles planning. |
| `Plan in Progress` | none | builders | Planning is underway. Hero manages continuation. |
| `Plan in Review` | none | builders | Plan needs review. Hero handles the review gate. |
| `In Progress` | none | builders | Active implementation. Hero orchestrates impl-agent. |
| `In Review` | none | builders | PR open, awaiting review. Hero manages the merge gate. |
| `Human Needed` | none | caretakers | Issue is blocked and needs human attention. Caretakers handle the unblock flow. Feature G ships `ralph-hero:caretake`; until then Director emits `needs input:` marker. |
| `Done` | none | — | Terminal state. Director skips — no dispatch needed. |
| `Canceled` | none | — | Terminal state. Director skips — no dispatch needed. |

---

## Team → entrypoint mapping

| team | skill entrypoint | status |
|------|-----------------|--------|
| builders | `ralph-hero:hero` | live |
| watchers | `ralph-hero:watch` | pending Feature C (GH-1270) |
| scouts | `ralph-hero:scouts` | pending Feature F (GH-1273) |
| memorykeepers | manual `dream-now` | no skill yet; Director emits `needs input:` |
| caretakers | `ralph-hero:caretake` | pending Feature G (GH-1274) |

---

## Classification algorithm (for implementors)

Director evaluates in this order:

1. Fetch the candidate issue's labels array.
2. Check for any `trigger:*` label (Priority 1). First match wins.
3. Check for any automation label: `watcher-auto`, `scout-auto`, `process-improvement` (Priority 2). First match wins.
4. Fall through to `workflow_state` lookup (Priority 3).
5. If the resolved team's entrypoint does not yet exist, emit `needs input: team <name> not yet implemented (Feature <X>); skipping dispatch` and continue to the next event.
