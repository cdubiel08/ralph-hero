# `--mode hygiene`

Scan the project board for archive candidates, stale items, orphaned tickets, field gaps, WIP violations, and duplicate candidates. Optionally archive items that exceed the configured threshold. Read-only by default (dry-run); the auto-archive path is opt-in via `RALPH_HYGIENE_DRY_RUN=false`.

```bash
export RALPH_SUBCOMMAND=hygiene
```

No hook gates this mode beyond the plugin-level scope guard. Hygiene does not mutate workflow states and does not create or close issues — it only archives terminal items (Done/Canceled) when the threshold is met.

## §Configuration (resolved at load time)

- Hygiene threshold: `${RALPH_HYGIENE_THRESHOLD:-10}`
- Dry run: `${RALPH_HYGIENE_DRY_RUN:-true}`
- WIP limits: `${RALPH_HYGIENE_WIP_LIMITS:-<unset>}`

`RALPH_HYGIENE_WIP_LIMITS` is a JSON object like `{"In Progress": 3, "In Review": 2}`. If unset, the WIP category in the hygiene report is empty (`findWipViolations()` has no built-in defaults).

## §Step 1: Run project_hygiene (primary)

Call `ralph_hero__project_hygiene` with:

- `format: "markdown"`
- `archiveAgeDays: 14`
- `staleDays: 7`
- `orphanDays: 14`
- `wipLimits`: parsed JSON from `RALPH_HYGIENE_WIP_LIMITS` if set; otherwise omit.

The tool returns seven categories in one response:

- **Archive candidates** — Done/Canceled items stale beyond `archiveAgeDays`.
- **Stale items** — non-terminal items not updated within `staleDays`. Caveat: a Plan in Review item whose latest comment is an unanswered `## Decision Request` is HELD on a design decision, not abandoned — annotate it as `(held — awaiting decision)` in the report instead of implying it needs unsticking; the human answers on the issue.
- **Orphaned items** — Backlog-only, no assignees, older than `orphanDays`.
- **Field gaps** — non-terminal items missing `estimate`, `priority`, or `workflowState`. (`fieldCoveragePercent` in Summary stats tracks estimate/priority only — a board can read 100% coverage while stateless items sit in the workflow-state gap bucket.)
- **WIP violations** — states exceeding caller-supplied `wipLimits` (empty unless provided).
- **Duplicate candidates** — non-terminal item pairs with title similarity ≥ 0.8.
- **Summary stats** — aggregate counts + `fieldCoveragePercent`.

## §Step 2: Report hygiene sections

Print the full hygiene report from the `project_hygiene` response. Shape:

```
Hygiene Report
==============

Archive Candidates: N items (stale > 14 days)
  #42 - Fix login timeout (Done, 21 days stale)
  #38 - Update dependencies (Done, 18 days stale)

Stale Items: N items (no update in > 7 days)
  #51 - Refactor auth module (In Progress, 9 days stale)

Orphaned Items: N items (Backlog, unassigned, > 14 days old)
  #60 - Investigate cache thrash (Backlog, 21 days)

Field Gaps: N items missing estimate/priority/workflow state
  #62 - Add settings page (missing: estimate, priority)
  #63 - Imported from UI (missing: workflow state)

WIP Violations: N (or "skipped — RALPH_HYGIENE_WIP_LIMITS not set")
  In Progress: 5 items (limit: 3)

Duplicate Candidates: N pairs (title similarity >= 0.8)
  #71 / #72 - "Fix sidebar overflow" / "Fix sidebar layout overflow"

Summary:
  Field coverage: NN%
  Total scanned: N
```

## §Step 3: Supplement with pipeline-health warnings

`project_hygiene` does not generate pipeline-health warnings (lock collisions, oversized issues, etc). For those, call `ralph_hero__pipeline_dashboard` with:

- `format: "markdown"`
- `includeHealth: true`
- `archiveAgeDays: 14`

Append the dashboard's `health` section warnings to the report:

```
Health Warnings: [from dashboard health section]
  [CRITICAL] lock_collision: #44 stuck in __LOCK__ state for 4 hours
  [WARNING] oversized_in_pipeline: #55 (XL) in In Progress
```

If the dashboard returns no health warnings, omit this section.

## §Step 4: Auto-archive (if configured)

Use the resolved configuration above to decide:

- **`RALPH_HYGIENE_DRY_RUN=true`** (default): report what would be archived. Do NOT call any archive tools.
- **`RALPH_HYGIENE_DRY_RUN=false` AND eligible count > `RALPH_HYGIENE_THRESHOLD`**: call `ralph_hero__batch_update` with a filter-mode archive operation:
  - `operations: [{action: "archive"}]`
  - `filter: {workflowStates: ["Done", "Canceled"], updatedBefore: <ISO date 14 days ago>}`
  - `dryRun: false`

  Report `archivedCount` from the response. Parents with any sub-issues are skipped server-side and reported under `skipped` — do not retry those; they need manual review, not a blind re-archive attempt.

If `batch_update` errors, do NOT retry blindly — emit `HYGIENE BLOCKED <reason>` (see [outcome-tokens.md](../outcome-tokens.md)) and surface the error in the summary.

## §Step 5: Summary + terminal token

Output the summary block and then emit exactly one terminal token (see [outcome-tokens.md](../outcome-tokens.md)).

```
Hygiene complete.
  Items scanned: [totalScanned from project_hygiene]
  Archive eligible: N
  Stale: N
  Orphaned: N
  Field gaps: N
  WIP violations: N (or "not checked")
  Duplicate pairs: N
  Archived: N (or "0 - dry run mode")
  Health warnings: N
```

Then emit:

- `HYGIENE COMPLETE <N archived>` — scan ran cleanly; `N` is the archived count (0 if dry-run or threshold not exceeded).
- `HYGIENE BLOCKED <reason>` — scan failed (project not found, MCP error, archive call failed, etc.).

## §Constraints

- **Read-only by default.** The dry-run mode is the safe path; the operator must explicitly set `RALPH_HYGIENE_DRY_RUN=false` to mutate the board.
- **No workflow-state changes.** Hygiene does not advance, regress, or close issues — it only archives Done/Canceled items.
- **No issue creation or closure.** Surfacing duplicate candidates is the limit; the operator (or a triage sweep) decides whether to close.
- **Archive confidence is timestamp-only.** `findArchiveCandidates()` does not currently filter items with open PRs or recent comments. Review the dry-run output before flipping to non-dry-run.
- **No `Stop` hook for this mode.** Hygiene has no postcondition gate because it does not mutate semantic state — only archive bookkeeping.
