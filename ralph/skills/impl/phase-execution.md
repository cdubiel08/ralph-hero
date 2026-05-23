# Phase execution

_Filled by Phase 4 (auto-mode workflow body + phase-execution.md)._

Sections planned:

- §Task graph — parse `### Tasks` for `#### Task N.M:` blocks; extract files / tdd / complexity / depends_on / acceptance; identify parallel groups
- §Controller pattern — dispatch implementer sub-agent (model from complexity), handle status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED), max 3 retries
- §IMPL BLOCKED escalation — emit `IMPL BLOCKED model=<current> needs=opus reason=<short>` and STOP when sub-agent budget exhausted at non-opus tier; hero re-dispatches at opus
- §Phase quality review — `git diff [phase-start]..HEAD` → reviewer sub-agent (opus) → APPROVED / NEEDS_FIXES → fixer sub-agent; post `## Phase N Review` + `## Drift Log — Phase N` comments
- §Legacy plan fallback — when phase lacks `### Tasks`, fall back to monolithic implementation (read phase, implement directly, no sub-agent dispatch)
