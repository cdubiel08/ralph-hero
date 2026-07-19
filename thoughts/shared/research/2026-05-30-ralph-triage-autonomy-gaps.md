---
date: 2026-05-30
researcher: claude (verification workflow)
git_commit: ec9c8f2d2ea281aa659b975e862eed36738c2a9d
branch: main
repository: ralph-hero
topic: "Removing the human from Human Needed — four automatable triage gaps"
tags: [research, triage, picker, next_actions, save_issue, caretake, dependencies, autonomy]
status: complete
---

# Removing the Human from "Human Needed": Four Automatable Gaps in ralph-hero Triage

## Executive summary

A session in the landcrawler-ai project asked "what's in Human Needed" and found four items
whose dispositions were 100% mechanical — every one followed a machine-readable rule the
system *should* have applied itself (advance #512/#515 when blocker #904 closed; move
CLOSED #669/#670 to a terminal board column). The unifying defect is that ralph-hero's
autonomous picker and `save_issue` are **blind to `add_dependency` (blockedBy) edges and to
the issueState→workflowState direction**, so dependency-blocked Backlog items churn (six
caretaker flip-flops on #512/#515) and CLOSED-not-planned items strand in non-terminal
columns — and the triage skill never documents the picker's actual actionable-phase rule, so
each pass re-derives it wrong. The four changes below close every gap so this triage runs
without a human; all four are verified to still exist in current source (none already fixed).

> Provenance: produced by a 5-agent verification workflow (4 analyzers + 1 synthesizer) run
> 2026-05-30 against the live `ralph-hero` tree. Line refs are current as of git_commit above.

## Prioritized proposals

| P | Area | Gap | Files | Risk | Est |
|---|------|-----|-------|------|-----|
| **P0** | next_actions Backlog-fallback ignores `add_dependency` edges (Gap A) | confirmed | `mcp-server/src/lib/dashboard-fetch.ts`, `mcp-server/src/lib/directions.ts` | medium | S |
| **P0** | `save_issue` close does not move board to terminal column (Gap B) | confirmed | `mcp-server/src/tools/issue-tools.ts`, `ralph/skills/caretake/modes/triage.md` | low | S |
| **P1** | triage.md lacks authoritative actionable-phase + blocked-parking rule (Gap D) | confirmed | `ralph/skills/caretake/modes/triage.md`, `ralph/skills/caretake/outcome-tokens.md` | low | S |
| **P2** | No watcher auto-advances issues whose blockedBy edges all close (Gap C) | confirmed | `ralph/skills/caretake/modes/watch-blockers.md` (new), `ralph/skills/caretake/SKILL.md`, `ralph/skills/caretake/modes/triage.md` | medium | M |

---

### P0 — Gap A: picker fallback is blind to dependency edges

**Gap.** A Backlog issue dependency-blocked by an OPEN issue (e.g. #512 blocked by #904) is
surfaced as the rank-1 autopilot direction, forcing a human to park it in Human Needed to
stop the churn.

**Root cause.** `DASHBOARD_ITEMS_QUERY` fetches only the `trackedIssues` task-list connection
and maps *that* into `DashboardItem.blockedBy` (`dashboard-fetch.ts:107-110`, query at `:152`).
The real dependency edges written by `add_dependency` / `addBlockedBy` live in the GraphQL
`blockedBy` connection (proven by `list_dependencies` at `relationship-tools.ts:574`), which
the dashboard query never selects. So `hasOpenBlockers()` (`directions.ts:309-313`) sees
`blockedBy === []` and returns false; the agent Backlog-fallback (`directions.ts:853-867`, no
blocker check) pushes the item, and the step-2 filter (`:870-880`) can't drop what it can't
see. Secondary: state is collapsed to `Done|null`, losing `Canceled` (a Canceled blocker maps
to `null`=open).

**Change.**
1. `dashboard-fetch.ts` — add to the Issue fragment a real dependency selection alongside
   `trackedIssues`: `blockedBy(first: 20) { nodes { number state } }`. Add
   `blockedBy?: { nodes: Array<{ number: number; state: string }> }` to `RawDashboardItem`.
2. `dashboard-fetch.ts:107-110` — map `DashboardItem.blockedBy` from `r.content.blockedBy.nodes`
   instead of `trackedIssues`; keep `n.state === "CLOSED" ? "Done" : null` (both Done and
   Canceled are non-blocking, so CLOSED→"Done" keeps `hasOpenBlockers` correct). Preserve
   `trackedInIssues`→`parentNumber/parentState` untouched (`:111-112`).
3. `directions.ts` — `hasOpenBlockers` is unchanged and now sees the real edges.
   **Defense-in-depth (recommended):** in the fallback loop (`:853-867`) `continue` when
   `hasOpenBlockers(item)` is true, so a blocked Backlog item never enters `scored` and the
   "surface blocked anyway" fallthrough branch (`:874-877`) can't re-surface it as the sole
   candidate. Per the session rule, the fallback should return `[]` rather than a blocked item.

**Acceptance criteria.**
- `DASHBOARD_ITEMS_QUERY` selects the issue `blockedBy(first: N)` dependency connection (same
  one `list_dependencies` uses), not only `trackedIssues`.
- An issue blocked via `add_dependency` by an OPEN issue yields a non-empty `blockedBy` with a
  non-Done/Canceled entry.
- Agent fallback: a Backlog issue dependency-blocked by an OPEN issue is NOT returned (`[]` if
  sole candidate); the same issue IS returned once the blocker closes.
- A CLOSED blocker does not suppress the issue.
- `parentNumber/parentState` behavior from `trackedInIssues` unaffected.

**Test impact.** Add to `directions.test.ts`: (a) "agent fallback excludes a Backlog item
blocked by an OPEN dependency" → `toHaveLength(0)`; (b) "...surfaces it once blocker is Done".
Add a `dashboard-fetch` test asserting `toDashboardItems` reads `content.blockedBy` into
`DashboardItem.blockedBy`. Update any fixture that relied on `trackedIssues` populating
`blockedBy`.

**Risk** medium · **Estimate** S

---

### P0 — Gap B: closing an issue doesn't move the board to a terminal column

**Gap.** `save_issue({issueState: "CLOSED_NOT_PLANNED"})` with no `workflowState` closes the
GitHub issue but leaves the board field at e.g. "Human Needed" — the exact #669/#670 strand.

**Root cause.** `save_issue` bridges only forward: a terminal `workflowState` auto-closes the
issue (`issue-tools.ts:1271-1276`). There is no reverse inference. `hasProjectFields`
(`:1224-1226`) is computed from `workflowState/estimate/priority/iteration` only, so a
close-only call has `hasProjectFields === false` and short-circuits past the entire
board-update block guarded by `if (hasProjectFields)` (`:1412`) — including the 4a
Workflow-State update (`:1448`) and its Status sync (`:1456`). triage.md compounds it: CLOSE
verdicts lead with `issueState` and treat the board move as a soft, agent-dependent step.

**Change.**
1. `issue-tools.ts` — after the forward auto-close block (`>:1276`), before step 3, add
   reverse inference:
   ```ts
   let inferredFromClose = false;
   if (resolvedWorkflowState === undefined && targetState === "CLOSED") {
     resolvedWorkflowState = stateReason === "NOT_PLANNED" ? "Canceled" : "Done";
     inferredFromClose = true;
     changes.workflowStateInferred = resolvedWorkflowState;
   }
   ```
2. Change the guard at `:1412` from `if (hasProjectFields)` to
   `if (hasProjectFields || inferredFromClose)`. The 4a branch (`:1448 if (resolvedWorkflowState)`)
   already does the Workflow-State option update + `WORKFLOW_STATE_TO_STATUS` Status sync — no
   new mutation code. Done/Canceled are not `LOCK_STATES`, so the lock guard (`:1427`) is
   untouched. The `resolvedWorkflowState === undefined` precondition guarantees an explicit
   `workflowState` always wins.
3. Update the tool description (`:1190`) to document the reverse direction.
4. `triage.md` (verdict table `:67-72`, branches `:103-110`) — rewrite CLOSE branches to lead
   with the board transition: `CLOSE-done → save_issue(workflowState: "Done", command: "ralph_triage")`
   (forward auto-close sets CLOSED/COMPLETED); `CLOSE-canceled → save_issue(workflowState: "Canceled", ...)`.
   Drop the separate "update workflow state" step.

**Acceptance criteria.**
- `save_issue({issueState: "CLOSED_NOT_PLANNED"})` (no workflowState) → closes issue AND
  Workflow State = Canceled, Status = Done.
- `save_issue({issueState: "CLOSED"})` (no workflowState) → Workflow State = Done, Status = Done.
- Explicit wins: `save_issue({issueState: "CLOSED", workflowState: "Backlog"})` leaves board at Backlog.
- Reverse inference triggers a board write only when `targetState === "CLOSED"`; OPEN/reopen and
  metadata-only calls unaffected.
- Inferred Done/Canceled do not trip the lock guard.
- triage.md CLOSE-done/CLOSE-canceled express close as a single `workflowState` transition.

**Test impact.** Add a reverse-inference block to `save-issue.test.ts`: helper
`inferWorkflowFromClose(issueState, workflowState)` → CLOSED→Done, CLOSED_NOT_PLANNED→Canceled,
OPEN→undefined, undefined-when-explicit. Structural test asserting `inferredFromClose` guard +
`|| inferredFromClose` in the project-field guard. Optional cross-tool test:
`next_actions`/`project_hygiene` no longer surface CLOSED items in non-terminal columns.

**Risk** low · **Estimate** S

---

### P1 — Gap D: triage.md has no authoritative actionable-phase / blocked-parking rule

**Gap.** triage.md never states the picker's actionable phases, never warns that a
blockedBy-OPEN item left in Backlog will be re-surfaced, and has no verdict for "blocked on an
OPEN sibling issue." This is why six caretaker passes argued "siblings are In Progress so the
fallback stays dormant" — false and unrefuted in the docs.

**Root cause.** triage.md anchors all "will it be re-picked?" reasoning on the `ralph-triage`
label (which only suppresses *this mode's* §Step 2 Backlog query — `:133-135`), never on the
`next_actions` picker's Backlog-fallback. The actionable-phase list (Plan in Review / In
Review / Ready for Plan / Research Needed; In Progress NOT included) lives only in the compiled
MCP tool description, so each pass re-derives it from memory and gets it wrong. There is no
honest parking verdict for an OPEN-sibling blocker — the agent must choose between Backlog
(churn) and WAIT-decision→Human Needed (correct, but undocumented).

**Change.**
1. New **§Step 4a "Picker actionable phases (authoritative)"** stating the four phases verbatim,
   that In Progress is NOT actionable, that the fallback applies NO dependency filtering, that
   **an item blocked by an OPEN issue MUST NOT be left in Backlog** (canonical honest state:
   Human Needed via WAIT-decision / WAIT-issue=NNN), and an explicit refutation of the
   "In-Progress sibling keeps the fallback dormant" reasoning. Cross-link the `next_actions`
   source as source of truth.
2. New verdict row `WAIT-issue=NNN | Human Needed + ## Escalation naming #NNN | unblock workflow
   (auto-advances when #NNN closes)` plus a §Step 5 branch that **first checks blocker state via
   `get_issue`** — if CLOSED, advance per the embedded condition (do NOT park); if OPEN, set
   Human Needed, post `## Escalation` naming #NNN + the machine-readable advance condition, and
   ensure an `add_dependency` edge exists.
3. Blocked-item **decision table** keyed on blocker kind + state (OPEN sibling+OPEN →
   WAIT-issue; OPEN sibling+CLOSED → advance; PR → WAIT-pr, Backlog ok; URL → WAIT-upstream,
   Backlog ok; nothing → normal). Note the asymmetry: WAIT-pr/WAIT-upstream may stay in Backlog
   because a watcher owns them; an OPEN-issue blocker has no watcher (until Gap C), so Backlog
   is unsafe.
4. Amend §Step 6 rationale (`:135`) distinguishing the two re-pick mechanisms.
5. `outcome-tokens.md` + §Step 8: add `TRIAGED WAIT-issue=NNN`; add `WAIT-issue` to the
   `RALPH_TRIAGE_ACTION` allowlist note.
6. Forward cross-ref to Gap A: once the picker honors dependency edges, the Backlog-unsafe rule
   relaxes (a blocked-on-OPEN item MAY stay in Backlog with a dependency edge); until then,
   Human Needed is the only churn-free honest state.

**Acceptance criteria.**
- triage.md states the four phases verbatim and that In Progress is not actionable.
- Explicitly states a blockedBy-OPEN item must NOT stay in Backlog; names Human Needed as canonical.
- Explicitly refutes the In-Progress-sibling reasoning.
- `WAIT-issue=NNN` verdict exists with decision-table row + §Step 5 branch that checks blocker
  state and advances when CLOSED.
- Decision table makes the Backlog-vs-Human-Needed choice mechanical.
- `outcome-tokens.md` lists `TRIAGED WAIT-issue=NNN`; allowlist includes `WAIT-issue`.
- Gap A cross-reference present.

**Test impact.** Doc-only; validated via the `Stop` hook. Add `WAIT-issue` to
`ralph/hooks/scripts/triage-postcondition.sh` token allowlist and the legacy
`plugin/ralph-hero/hooks/scripts/triage-postcondition.sh` `RALPH_TRIAGE_ACTION` allowlist; add
a hook test asserting `TRIAGED WAIT-issue=512` passes while a bare blocked-in-Backlog with no
token fails.

**Risk** low · **Estimate** S

---

### P2 — Gap C: no watcher auto-advances issues whose blockedBy edges all close

**Gap.** When a parked item's `blockedBy` edges all close, nothing advances it. `advance_issue`
only walks sub-issue trees (`relationship-tools.ts:632-648` — direction enum is
`children`/`parent` only), and the two watchers key off `blocked:*` labels
(`watch-upstream.md:29`), never dependency edges or Human Needed.

**Root cause.** A `blockedBy` edge + Human Needed has no resolver; `advance_issue` is
dependency-blind.

**Change.** New mode **`watch-blockers.md`** (modeled on `watch-upstream.md`): sweep OPEN
Human-Needed / Backlog items, call `list_dependencies`, and advance any whose `blockedBy` edges
are **all** CLOSED to an "Unblock-When" marker target (default Ready for Plan); `save_issue`
drops blocked labels; items with any open blocker are left untouched. Wire the mode into
`SKILL.md` (mode table + fan-out); have triage post the Unblock-When marker and set the
`add_dependency` edge (interlocks with Gap D's WAIT-issue=NNN).

**Acceptance criteria.** All-closed → advances; any open blocker → untouched; no-blocker item →
skipped.

**Test impact.** Reuses `list_dependencies` / `save_issue`; add a `SKILL.md` mode-table
assertion and a closed-vs-open dependency fixture.

**Risk** medium · **Estimate** M

---

## Sequencing

1. **Gap A and Gap B are independent P0s** — ship in parallel. Gap A fixes the picker data
   plane (no more churn-by-resurfacing); Gap B fixes the close→board write (no more
   CLOSED-in-Human-Needed strands). Together they retire the #512/#515 (A) and #669/#670 (B)
   classes mechanically.
2. **Gap A unblocks and simplifies Gap D.** While the picker is dependency-blind, the only
   churn-free honest state for an OPEN-sibling blocker is Human Needed, so Gap D must mandate
   WAIT-issue=NNN → Human Needed. Once Gap A ships, a blocked-on-OPEN item can safely stay in
   **Backlog with a dependency edge**, so Gap D's decision table relaxes (its WAIT-issue=NNN
   target moves from Human Needed to Backlog+edge). Build Gap D *now* with the explicit Gap-A
   cross-reference so the relaxation is a one-line edit later, not a rewrite.
3. **Gap A + Gap D together make Gap C low-stakes.** With the picker honoring edges (A) and
   triage parking blocked items behind a dependency edge with a machine-readable advance
   condition (D), Gap C (`watch-blockers`) becomes the closing loop that re-activates parked
   items when edges clear — replacing the by-hand advance done this session. Gap C depends on
   the `add_dependency` edges that Gap A reads and Gap D writes, so ship it **after** A and D.

Net: **A → D → C** on the dependency-edge track; **B** in parallel. After A+B, the four observed
Human-Needed dispositions are fully automatable; D removes the agent guesswork; C removes the
last manual advance step.

## Provenance / triggering session

- landcrawler-ai issues that exposed each gap: #512, #515 (Gap A churn + Gap C missing
  auto-advance), #669, #670 (Gap B strand).
- All four were dispositioned by hand 2026-05-30 (advance #512/#515 → Ready for Plan; cancel
  #669/#670) — each disposition was a pure function of board + dependency state, which is the
  motivation for this doc.
