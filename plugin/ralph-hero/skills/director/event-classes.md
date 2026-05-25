# Director Event Classification Taxonomy

This file is the **canonical schema** for Director's event classifier. The classifier performs a lookup against this table to determine which team handles a given issue. Entries are evaluated in the order listed — `trigger:*` labels take highest priority, then `blocked:*` labels (watcher routing), then automation labels, and `workflow_state` matches are the fallback.

**Extending this taxonomy**: Features D and F will add new rows here via PR. Each row is independent; adding a new event class requires only appending a row to the appropriate section and updating the notes column to identify the producer. No changes to Director's classifier logic are required — the lookup is table-driven.

---

## Priority 1 — Explicit trigger labels (highest priority)

These labels are placed manually (by human or iOS remote-control shortcut) or by external event shims. A `trigger:<team>` label on any issue causes Director to dispatch that team regardless of workflow state. The label is consumed (removed) after dispatch.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `trigger:builders` | builders | Manual override: force builder dispatch. Hero handles the issue. |
| any | `trigger:watch` | watchers | Manual override: force watcher dispatch. Feature C ships `ralph-hero:watch`. |
| any | `trigger:scouts` | scouts | Manual override: force scout dispatch. Routes to `/ralph-hero:scouts --issue NNN`. |
| any | `trigger:caretake` | caretakers | Manual override: force caretaker dispatch. Feature G ships `ralph-hero:caretake`. |
| any | `trigger:memorykeepers` | memorykeepers | Manual override: force memorykeeper dispatch. No skill yet; Director emits `needs input:` marker. |

## Priority 2 — Blocked-condition labels (watcher routing)

These labels are written by triage's `WAIT-pr`/`WAIT-upstream` verdicts and park an item against a named, watched condition. Director fires the matching caretake **watcher sweep** (board-wide — it processes every parked item of that kind, including this one) so the condition is re-evaluated immediately rather than at the next heartbeat. The label is **NOT consumed** — the watcher owns its lifecycle and strips it only when the condition resolves.

> **Legacy caveat:** `watch-pr`/`watch-upstream` ship only on the slim `ralph:caretake` surface (#1406/#1407); the legacy `ralph-hero:caretake` implements only `hygiene|report|trends`, so this legacy routing is nominal/schema-parity until ported. The live, correctly-wired path is slim `/ralph:hero --mode classify`.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `blocked:pr-*` (prefix-match) | caretakers | Fire `Skill("ralph-hero:caretake", args="--mode watch-pr")` — board-wide sweep, no issue scoping. Label persists. Producer: triage `WAIT-pr` (#1404); consumer: watch-pr (#1406). |
| any | `blocked:upstream` (exact-match) | caretakers | Fire `Skill("ralph-hero:caretake", args="--mode watch-upstream")` — board-wide sweep. Label persists. Producer: triage `WAIT-upstream` (#1404); consumer: watch-upstream (#1407). |

## Priority 3 — Automation labels (label exists, producer pending until noted)

These labels are written by automated producers (event shims, dream-loop classifier, monitoring bridges). They signal that a specific team should handle the issue without requiring a manual trigger.

| workflow_state | labels | team | notes |
|----------------|--------|------|-------|
| any | `watcher-auto` | watchers | Label written by Cloud Monitoring → board bridge (`plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py`). Feature C ships the `ralph-hero:watch` entrypoint. |
| any | `debug-auto` | watchers | Label written by `ralph-debug-collate` (invoked from Watcher heartbeat). Observability follow-ups are owned by watchers. |
| any | `scout-auto` | scouts | Label written by `.github/workflows/playwright-auto.yml` (per-PR) and `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (nightly batch). Routes to `/ralph-hero:scouts`. |
| any | `process-improvement` | caretakers | Label written by dream-loop cluster classifier (`scripts/dream/reflect.py::emit_process_improvement_issue`). Feature G ships `ralph-hero:caretake`. |

## Priority 4 — Workflow state (fallback routing)

When no trigger, blocked, or automation labels are present, Director routes by workflow state.

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
| scouts | `ralph-hero:scouts` | live |
| memorykeepers | manual `dream-now` | no skill yet; Director emits `needs input:` |
| caretakers | `ralph-hero:caretake` | pending Feature G (GH-1274) |

---

## Classification algorithm (for implementors)

Director evaluates in this order:

1. Fetch the candidate issue's labels array.
2. Check for any `trigger:*` label (Priority 1). First match wins.
3. Check for a `blocked:*` label (Priority 2): prefix-match `blocked:pr-` → fire `caretake --mode watch-pr`; exact-match `blocked:upstream` → fire `caretake --mode watch-upstream`. Dispatch is a board-wide watcher sweep (no issue scoping); the label is NOT consumed.
4. Check for any automation label: `watcher-auto`, `debug-auto`, `scout-auto`, `process-improvement` (Priority 3). First match wins.
5. Fall through to `workflow_state` lookup (Priority 4).
6. If the resolved team's entrypoint does not yet exist, emit `needs input: team <name> not yet implemented (Feature <X>); skipping dispatch` and continue to the next event.

---

## iOS-mode sentinel (Feature H contract)

Director writes the sentinel file `${TMPDIR:-/tmp}/ralph-ios-mode` immediately before `Skill()` dispatch when `DISPATCH_REASON` matches `trigger:*` or `RemoteTrigger`. Downstream producers (`ralph-pr`, `ralph-postmortem`, scout-nightly, `ralph-merge`) test for this file to decide whether `--push-drive` and ntfy completion hooks default ON.

The legacy `RALPH_IOS_MODE=1` env var is also honored as a manual operator override (e.g., for desk-mode forced pushes during testing). If either the sentinel file OR `RALPH_IOS_MODE=1` is set, producers treat iOS-mode as active.

Priority 4 (workflow_state-driven) dispatches do NOT write the sentinel — only Priority 1 (`trigger:*`) and `RemoteTrigger` paths do. (Priority 2 `blocked:*` and Priority 3 automation dispatches also do not write it.) The sentinel persists until `$TMPDIR` rotation or session end; no explicit cleanup is required.

---

## Producers

This table is the canonical inventory of automated label producers as of Feature D (GH-1271). New producers should add a row here when they land.

| Label | Producer file | Trigger condition |
|-------|---------------|-------------------|
| `watcher-auto` | `plugin/ralph-hero/scripts/monitoring-bridge/subscribe.py` | GCP Cloud Monitoring alert delivered to the configured Pub/Sub subscription |
| `debug-auto` | `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` (invoked from Watcher heartbeat) | Langfuse error grouping with ≥ N occurrences in window (default: 3) |
| `process-improvement` | `scripts/dream/reflect.py::emit_process_improvement_issue` | Dream-loop cluster of size ≥ threshold (default: 5) with ≥ N% `tool_use_error` or `verdict: BLOCKED` signals (default: 30%) |
| `scout-auto` | `.github/workflows/playwright-auto.yml` (per-PR) and `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (nightly batch) | PR opened/synchronized/reopened with UI-touching changes; nightly schedule |
