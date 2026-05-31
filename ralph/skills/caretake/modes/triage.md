# `--mode triage`

Pick ONE Backlog issue, assess its validity, and route it. Autonomous — no human prompts. The mode emits one terminal token per invocation (see [outcome-tokens.md](../outcome-tokens.md)).

```bash
export RALPH_SUBCOMMAND=triage
```

`triage-state-gate.sh` (PostToolUse on `save_issue`) gates state transitions on `RALPH_SUBCOMMAND=triage`. `triage-postcondition.sh` (Stop) verifies the transcript carries a `TRIAGED <verdict>` or `Queue empty.` line before allowing exit.

## §Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP and emit:

```
TRIAGED skipped — branch <name> is not main
```

Triage must run from main to avoid accidental commits on feature branches.

## §Step 2: Select issue

**If issue number provided as argument**: fetch the full issue details for that issue number.

**If no issue number**: pick the oldest untriaged Backlog issue via two queries:

- **Query 1** — list Backlog issues that already carry the `ralph-triage` label (`profile: "analyst-triage"`, `label: "ralph-triage"`, `limit: 250`). Store the returned issue numbers as `triaged_numbers`.
- **Query 2** — list all Backlog issues ordered by creation date ascending (`profile: "analyst-triage"`, `orderBy: "CREATED_AT"`, `limit: 250`). The ascending direction is required so the **first** result is the oldest.

**Select** the first issue from Query 2 whose number is NOT in `triaged_numbers`. If no untriaged issue is found, emit:

```
Queue empty.
```

and STOP.

## §Step 3: Assess

1. **Read the issue body and comments thoroughly.**
2. **Dispatch parallel sub-tasks for assessment.** Use the `Agent` tool to check the codebase and GitHub concurrently:

   ```
   Agent(subagent_type="ralph:codebase-locator",
         prompt="Search for [keywords from issue title]. Does this feature/fix already exist?")
   ```

   Do NOT pass `team_name` to `Agent()` calls — sub-agents must run outside any team context. Also search GitHub for similar issues by keywords from the title (limit 5).
3. **Wait for sub-tasks to complete.**
4. **Synthesize** based on the agent findings:
   - Does the feature/fix already exist?
   - Are there duplicate issues?
   - What's the realistic scope (XS/S/M/L/XL)?

## §Step 4a: Picker actionable phases (authoritative)

**Triage acts ONLY on items in `Backlog` (or null/unset workflow_state).** Items in any other state are OUT of triage scope — skip and log.

Hard precondition: if the selected issue is NOT in Backlog (or null), emit:

```
TRIAGED skipped — <workflowState> is outside triage scope
```

and STOP. Do NOT triage, do NOT change the issue state.

**States that are out of scope** (hard skip):

| State | Why |
|---|---|
| Research Needed, Research in Progress | Already routed — awaiting or running research |
| Ready for Plan | Already promoted — awaiting planning |
| Plan in Progress, Plan in Review | Actively being planned |
| In Progress | Actively being implemented |
| In Review | Under review |
| Human Needed | Parked for human decision |
| Done, Canceled | Terminal — already closed |

**Actionable phases (picker fallback surface):** Plan in Review / In Review / Ready for Plan / Research Needed. **`In Progress` is NOT an actionable phase** — the picker's `next_actions` Backlog-fallback activates when NO item is in these four phases, meaning In-Progress work does NOT suppress the Backlog-fallback. An item left in Backlog IS surfaced by the picker regardless of what sibling items are In Progress. The "In-Progress siblings keep the fallback dormant" reasoning is **incorrect** and must not be used to justify leaving a blocked item in Backlog.

**Blocked-item decision table** (use this before choosing a verdict):

| Blocker kind | Blocker state | Correct action |
|---|---|---|
| OPEN issue (sibling/dep) | OPEN | `WAIT-issue=NNN` → Human Needed (Backlog is unsafe — picker will re-surface; no watcher owns this yet; see Gap A cross-ref below) |
| OPEN issue (sibling/dep) | CLOSED | Advance the item per the embedded condition — do NOT park |
| Open PR | open/merged? | `WAIT-pr=NNN` → stays Backlog (watch-pr watcher owns it, #1406) |
| External URL | active | `WAIT-upstream=URL` → stays Backlog (watch-upstream watcher owns it, #1407) |
| None | — | Normal verdict flow below |

**Gap A cross-reference:** once `next_actions` honors `add_dependency` edges (Gap A, #1470), a `WAIT-issue=NNN` item MAY safely stay in **Backlog with a dependency edge** (the picker will filter it out). Until Gap A ships, Human Needed is the only churn-free honest state for an OPEN-issue blocker — Backlog will re-surface it on every autopilot tick.

## §Step 4: Determine action

Choose ONE of the **9 structured verdicts**. Every verdict names its successor — items either advance now (`PROMOTE-*`), wait on a *named, watched condition* (`WAIT-*`), close (`CLOSE-*`), or decompose (`SPLIT`). There is no bare "keep" dead-end: a verdict that leaves an issue in Backlog must name what it waits on.

| Verdict | Workflow target | Downstream consumer |
|---|---|---|
| `CLOSE-done` | Done | — |
| `CLOSE-canceled` | Canceled | — |
| `SPLIT` | (stays Backlog, children created) | caretake `--mode split` |
| `PROMOTE-research` | Research Needed | `/ralph:research --mode auto` |
| `PROMOTE-plan` | Ready for Plan | `/ralph:plan --mode auto` |
| `WAIT-pr=NNN` | Backlog + `blocked:pr-NNN` label | watch-pr (Phase 3, #1406) |
| `WAIT-upstream=URL` | Backlog + `blocked:upstream` label | watch-upstream (Phase 3, #1407) |
| `WAIT-issue=NNN` | Human Needed + `## Escalation` naming #NNN | auto-advanced when #NNN closes by `caretake --mode watch-blockers` (#1473) |
| `WAIT-decision` | Human Needed + `## Escalation` comment | unblock workflow |

**`WAIT-*` verdict family — coherent design:** The three `WAIT-*` verdicts use the same parking pattern but differ in who watches them and whether Backlog is safe:
- `WAIT-pr=NNN` — stays **Backlog** (watch-pr owns it; PR merge is machine-detectable).
- `WAIT-upstream=URL` — stays **Backlog** (watch-upstream owns it; URL resolution is machine-detectable).
- `WAIT-issue=NNN` — moves to **Human Needed** (`caretake --mode watch-blockers` owns it; auto-advances when #NNN closes). Once Gap A (#1470) is fully adopted, this target can relax to Backlog+edge.

When uncertain, prefer `PROMOTE-research` (route for investigation) or `WAIT-decision` (escalate) over `CLOSE-*` on valid work.

**Orthogonal action — `RE-ESTIMATE`**: if the estimate is missing or wrong, correct it (issue stays in Backlog for re-triage on the next sweep). This is a field fix, not a routing verdict, so it composes with — rather than replaces — one of the 9 verdicts on a later tick.

> The `WAIT-*` verdicts only *park* the item against a labelled condition this phase (Phase 1, #1404). The watchers that strip the label and re-apply the deferred verdict ship in Phase 3 (#1406/#1407). Until then a `WAIT-*` item waits indefinitely with its `blocked:*` label.

## §Step 5: Take action

If `save_issue`, `create_issue`, `add_sub_issue`, or `add_dependency` returns an error, read the error message — it contains valid states/intents and a specific recovery action. Retry with corrected parameters. If the error indicates a permanent problem (invalid permissions, missing field, etc.), escalate per §Escalation below.

**CLOSE-done / CLOSE-canceled.** Choose the destination state by closure reason:

- **`CLOSE-done`** → Done — already implemented, already fixed, duplicate of completed work. Use `issueState: "CLOSED"` (reason: completed).
- **`CLOSE-canceled`** → Canceled — no longer relevant (tech changed, product direction shifted). Use `issueState: "CLOSED_NOT_PLANNED"` (reason: not planned).

Update workflow state accordingly (`command: "ralph_triage"`). Add a comment explaining the closure reason and chosen destination state.

**SPLIT.** First, `list_sub_issues` on the parent. If children already exist and cover the proposed scope, add a comment noting the existing children — do NOT create duplicates. If coverage is partial, create only net-new sub-issues. If no children exist, create XS sub-issues via the three-step pattern:

1. `create_issue` with a descriptive title.
2. `add_sub_issue` to link under the original.
3. Set estimate "XS" and workflow state "Backlog".

Add a comment on the parent listing sub-issues (reused and/or created). **Do NOT close the original** — the parent stays in Backlog until all children reach Done.

**RE-ESTIMATE.** Update the issue with the new estimate (XS/S/M/L/XL). Add a comment explaining the reasoning. Workflow state remains Backlog.

**PROMOTE-research / PROMOTE-plan.** Set `workflowState: <target>` via `save_issue(command: "ralph_triage")` where `<target>` is `"Research Needed"` (`PROMOTE-research`) or `"Ready for Plan"` (`PROMOTE-plan`). Add a `## Triage Decision` comment explaining the routing choice and what downstream work is expected (what to investigate, or what the plan should cover).

**WAIT-pr=NNN / WAIT-upstream=URL.** The issue is valid but blocked on a *named, watched condition*. Leave it in Backlog and apply the matching `blocked:*` label so the Phase 3 watcher can pick it up when the condition resolves:

- **`WAIT-pr=NNN`** — blocked on PR #NNN merging. Apply `blocked:pr-NNN` (e.g. `blocked:pr-1338`) + `ralph-triage`.
- **`WAIT-upstream=URL`** — blocked on an external/upstream condition. Apply `blocked:upstream` + `ralph-triage`. Record the URL in the `## Triage Decision` comment (the label carries no URL).

Add a `## Triage Decision` comment naming the exact condition being waited on.

**WAIT-issue=NNN.** The issue is valid but blocked by OPEN issue #NNN (a dependency edge exists or should exist). First check blocker state via `get_issue(NNN)`:

- **If CLOSED**: the blocker is already resolved — do NOT park. Advance the item per whatever verdict the issue merits now (re-evaluate without the blocking constraint). Note the resolved blocker in the `## Triage Decision` comment.
- **If OPEN**: set `workflowState: "Human Needed"` (`command: "ralph_triage"`). Then:
  1. Ensure the `add_dependency` edge exists: call `add_dependency` with `blockedByNumber: NNN` if not already present.
  2. Post a `## Escalation` comment naming #NNN and the machine-readable advance condition:
     ```
     Blocked by #NNN ([title]). Move to Ready for Plan once #NNN closes.
     ```
  3. Apply `ralph-triage` label.
  4. **Do NOT leave the item in Backlog** — the picker's Backlog-fallback will re-surface it on every autopilot tick (see §Step 4a for why In-Progress siblings do not suppress this).

Note: WAIT-issue stays in Human Needed (not Backlog) by design. The dependency edge written here enables `caretake --mode watch-blockers` (#1473) to auto-advance this item when #NNN closes.

**WAIT-decision.** Needs a human call before it can advance. Set `workflowState: "Human Needed"` (`command: "ralph_triage"`), post a `## Escalation` comment stating the specific decision required, and apply `ralph-triage`.

**Before completing (REQUIRED for all branches):** export `RALPH_TRIAGE_ACTION` so `triage-postcondition.sh` can verify the action was taken:

```bash
# Pick the value that matches your verdict:
export RALPH_TRIAGE_ACTION=PROMOTE-research    # → Research Needed
export RALPH_TRIAGE_ACTION=PROMOTE-plan        # → Ready for Plan
export RALPH_TRIAGE_ACTION=CLOSE-done          # → Done
export RALPH_TRIAGE_ACTION=CLOSE-canceled      # → Canceled
export RALPH_TRIAGE_ACTION=SPLIT               # children created; stays Backlog
export RALPH_TRIAGE_ACTION=WAIT-pr             # blocked:pr-NNN; stays Backlog
export RALPH_TRIAGE_ACTION=WAIT-upstream       # blocked:upstream; stays Backlog
export RALPH_TRIAGE_ACTION=WAIT-issue          # → Human Needed; add_dependency edge; blocked by OPEN issue
export RALPH_TRIAGE_ACTION=WAIT-decision       # → Human Needed
# Legacy values still accepted by the postcondition allowlist:
# ROUTE_TO_RESEARCH | ROUTE_TO_PLAN | ROUTE_TO_IMPL | CLOSE | HUMAN | CANCEL | RE-ESTIMATE
# (bare KEEP is REJECTED as of Phase 6 / #1410 — the legacy plugin hook exits 2 on it.)
```

Valid values: `CLOSE-done | CLOSE-canceled | SPLIT | PROMOTE-research | PROMOTE-plan | WAIT-pr | WAIT-upstream | WAIT-issue | WAIT-decision` (the 9 structured verdicts), plus the legacy set `ROUTE_TO_RESEARCH | ROUTE_TO_PLAN | ROUTE_TO_IMPL | CLOSE | HUMAN | CANCEL | RE-ESTIMATE` (bare `KEEP` is **rejected** as of Phase 6 / #1410 — the legacy plugin hook exits 2 on it). `RALPH_TRIAGE_ACTION` is a self-discipline marker for the model — the **slim** postcondition hook (`ralph/hooks/scripts/triage-postcondition.sh`) does NOT read it; it greps the transcript for a valid **terminal token** (`TRIAGED …` / `Queue empty.`). The **legacy plugin** hook (`plugin/ralph-hero/hooks/scripts/triage-postcondition.sh`) does validate this env var against its allowlist.

## §Step 6: Mark issue as triaged

Apply the `ralph-triage` label on every verdict that **leaves the issue in Backlog**: `SPLIT`, `WAIT-pr`, `WAIT-upstream`, and the orthogonal `RE-ESTIMATE` (plus legacy `HUMAN`). Read current labels first, then include them all plus `ralph-triage` (and any `blocked:*` label from §Step 5) in the `save_issue` call.

Rationale: **two distinct re-pick suppression mechanisms** are in play:

1. **§Step 2 Backlog-query suppression** (via `ralph-triage` label): verdicts that leave the issue in Backlog need this label to prevent §Step 2's untriaged-Backlog picker from re-selecting the issue on the next triage tick. Affects `SPLIT`, `WAIT-pr`, `WAIT-upstream`, `RE-ESTIMATE`.

2. **Workflow-state removal from Backlog** (no label needed): verdicts that move the issue OUT of Backlog are invisible to §Step 2's Backlog query. Affects `PROMOTE-*`, `CLOSE-*`, `WAIT-decision`, and `WAIT-issue=NNN` (all land in non-Backlog states).

`WAIT-issue=NNN` moves to **Human Needed** (not Backlog) — it does NOT need the `ralph-triage` label for re-pick suppression because it exits the Backlog query entirely. The dependency edge ensures `caretake --mode watch-blockers` (#1473) can find and auto-advance it when #NNN closes. The `WAIT-pr` and `WAIT-upstream` verdicts stay in Backlog (a watcher owns them); `WAIT-issue` lands in Human Needed (watch-blockers owns it). These three are siblings in the `WAIT-*` family but differ in safe parking state.

## §Step 7: Find and Link Related Issues

> **Best-effort within time budget**: Step 7 is optional when the overall 10-minute time budget is tight. The primary triage action (Step 5) and label application (Step 6) take priority. If the candidate query below returns more than ~30 issues to evaluate, defer grouping and note in the report that grouping was skipped due to scope size.

After triage action is complete, scan for related issues in Backlog or Research Needed:

**Knowledge context (optional)**: If `knowledge_search` is available, search for related research documents by issue title and key concepts (limit 5) before querying issues. Use returned documents as additional context when analyzing relatedness — surfaces conceptual relationships not visible from issue titles alone.

1. **Query candidate issues** — `list_issues(profile: "analyst-triage", limit: 50)` for Backlog + `list_issues(profile: "analyst-research", limit: 50)` for Research Needed.

2. **Analyze for relatedness** via LLM judgment. Issues are related if they:
   - Touch the same **code layer** (frontend, backend, API, database, infra).
   - Mention the same **files or directories** in their descriptions.
   - Address the same **feature area** or **user concern**.
   - Have the same **parent issue** (already siblings of a larger work item).
   - Share **multiple specific labels** (not just generic ones like `ralph-triage`).

3. **Set dependency relationships** to establish grouping AND phase order:

   Determine implementation order based on dependencies:
   - Infrastructure/config issues → Phase 1 (blocks others).
   - Schema changes before API changes.
   - API changes before frontend changes.
   - Base components before dependent components.

   For each dependency pair, call `add_dependency` to set the dependent issue as blocked by the earlier-phase issue.

   Dependencies serve TWO purposes: **grouping** (issues connected via dependency chains are in one group) and **phase order** (blockers come before blocked issues). Within-group dependencies define phase order, not blocking status — the group is blocked only if any issue has dependencies pointing OUTSIDE the group.

4. **Check for external blockers** — if any issue in the group is blocked by an issue NOT in the group, note it. The group cannot proceed until external blockers are Done.

5. **Add a `## Grouped for Atomic Implementation` comment** documenting the grouping:

   ```markdown
   ## Grouped for Atomic Implementation

   Related issues identified:
   - #XX: [title] (this issue blocks it)
   - #YY: [title] (blocks this issue)

   Implementation order:
   1. #AA (first — no dependencies)
   2. #BB, #CC (after #AA completes)

   Rationale: [Brief explanation of why these are related]
   ```

## §Step 8: Emit terminal token

Emit exactly one token, matching the verdict from §Step 4. One token per verdict (see [outcome-tokens.md](../outcome-tokens.md) for the full contract):

- `TRIAGED CLOSE-done` — closed as done/implemented/duplicate (`## Duplicate Of` comment when a duplicate).
- `TRIAGED CLOSE-canceled` — closed not-planned.
- `TRIAGED SPLIT` — children created; issue stays in Backlog with `ralph-triage`.
- `TRIAGED PROMOTE-research` — routed to Research Needed for investigation.
- `TRIAGED PROMOTE-plan` — routed to Ready for Plan (well-specified, skip research).
- `TRIAGED WAIT-pr=NNN` — parked in **Backlog** with `blocked:pr-NNN` (the `=NNN` is part of the token; watch-pr owns it).
- `TRIAGED WAIT-upstream` — parked in **Backlog** with `blocked:upstream` (URL recorded in the `## Triage Decision` comment, not the token; watch-upstream owns it).
- `TRIAGED WAIT-issue=NNN` — moved to **Human Needed** with `## Escalation` naming #NNN and `add_dependency` edge written (the `=NNN` is part of the token; `caretake --mode watch-blockers` owns resolution — #1473). **NOT parked in Backlog** — stays Human Needed until #NNN closes.
- `TRIAGED WAIT-decision` — escalated to Human Needed with a `## Escalation` comment.
- `Queue empty.` — no untriaged Backlog issues (emitted at §Step 2).

Legacy tokens (`TRIAGED routed → …`, `duplicate`, `canceled`, `needs-split`, `escalated`, `re-estimated`, `skipped …`) remain accepted by the postcondition for back-compat; new triage runs SHOULD emit the verdict-named tokens above. `triage-postcondition.sh` greps the transcript for one of these tokens — anything else fails the Stop hook with exit 2.

## §Confidence levels

- **High** (take action automatically): feature exists in codebase (CLOSE), exact duplicate found (CLOSE), issue explicitly marked "done" in comments (CLOSE).
- **Medium** (act + note uncertainty): similar-but-not-identical feature, possibly-outdated issue, scope seems large but doable in phases.
- **Low** (ROUTE-TO-Research Needed + comment): ambiguous requirements, can't determine if feature exists, unclear relevance.

When uncertain, prefer `ROUTE-TO-Research Needed` over closing, or `HUMAN` when you cannot make even a routing call.

## §Escalation

If the agent cannot make a confident triage call, escalate by posting a `## Escalation` comment and setting `RALPH_TRIAGE_ACTION=HUMAN`. Common triggers:

| Situation | Comment text |
|---|---|
| Can't determine if feature exists | "Unable to confirm if [feature] is implemented. Need human verification." |
| Multiple potential duplicates | "Found [N] potential duplicates: [list]. Please clarify which to close." |
| Requirements ambiguous | "Requirements ambiguous: [quote]. Cannot assess scope accurately." |
| Cross-team dependency | "This issue depends on [external team/system]. Need coordination." |
| Splitting decision unclear | "Multiple valid ways to split this issue. Need guidance." |

After escalating, apply the `ralph-triage` label so the issue is not re-picked.

## §Constraints

- Work on ONE issue per invocation.
- No estimate restrictions (triage assesses all sizes).
- May close/split/update issues (unlike other ralph commands).
- No code changes.
- Complete within 10 minutes.
- The `triage-state-gate.sh` hook validates state transitions; `triage-postcondition.sh` validates the terminal token.

## §Migration note

Existing issues carrying the `ralph-triage` label from verdicts made under the prior palette continue to be excluded from re-pick by §Step 2's query (which filters out `ralph-triage`-labeled issues). To re-evaluate a dormant issue, manually remove the `ralph-triage` label and re-run triage. No automated batch cleanup ships with this phase.
