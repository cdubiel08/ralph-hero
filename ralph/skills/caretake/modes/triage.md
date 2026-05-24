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
   Agent(subagent_type="ralph-hero:codebase-locator",
         prompt="Search for [keywords from issue title]. Does this feature/fix already exist?")
   ```

   Do NOT pass `team_name` to `Agent()` calls — sub-agents must run outside any team context. Also search GitHub for similar issues by keywords from the title (limit 5).
3. **Wait for sub-tasks to complete.**
4. **Synthesize** based on the agent findings:
   - Does the feature/fix already exist?
   - Are there duplicate issues?
   - What's the realistic scope (XS/S/M/L/XL)?

## §Step 4: Determine action

Choose ONE:

- **CLOSE** — feature already implemented, bug already fixed, duplicate, or no longer applicable.
- **SPLIT** — issue is too large or covers multiple distinct items. Recommend XS/S sub-issues.
- **RE-ESTIMATE** — current estimate missing or wrong; propose new value with reasoning.
- **ROUTE-TO-Research Needed** — issue is valid but needs investigation before planning; move to "Research Needed".
- **ROUTE-TO-Ready for Plan** — issue is well-specified; skip research and queue directly for planning.
- **ROUTE-TO-In Progress** — trivial fix; assign and start immediately.

When uncertain, prefer `ROUTE-TO-Research Needed` (route for investigation) or `HUMAN` (escalate) over closing valid work.

## §Step 5: Take action

If `save_issue`, `create_issue`, `add_sub_issue`, or `add_dependency` returns an error, read the error message — it contains valid states/intents and a specific recovery action. Retry with corrected parameters. If the error indicates a permanent problem (invalid permissions, missing field, etc.), escalate per §Escalation below.

**CLOSE.** Choose the destination state by closure reason:

- **Done** — already implemented, already fixed, duplicate of completed work. Use `issueState: "CLOSED"` (reason: completed).
- **Canceled** — no longer relevant (tech changed, product direction shifted). Use `issueState: "CLOSED_NOT_PLANNED"` (reason: not planned).

Update workflow state accordingly (`command: "ralph_triage"`). Add a comment explaining the closure reason and chosen destination state.

**SPLIT.** First, `list_sub_issues` on the parent. If children already exist and cover the proposed scope, add a comment noting the existing children — do NOT create duplicates. If coverage is partial, create only net-new sub-issues. If no children exist, create XS sub-issues via the three-step pattern:

1. `create_issue` with a descriptive title.
2. `add_sub_issue` to link under the original.
3. Set estimate "XS" and workflow state "Backlog".

Add a comment on the parent listing sub-issues (reused and/or created). **Do NOT close the original** — the parent stays in Backlog until all children reach Done.

**RE-ESTIMATE.** Update the issue with the new estimate (XS/S/M/L/XL). Add a comment explaining the reasoning. Workflow state remains Backlog.

**ROUTE-TO.** Set `workflowState: <target>` via `save_issue(command: "ralph_triage")` where `<target>` is one of `"Research Needed"`, `"Ready for Plan"`, or `"In Progress"`. Add a `## Triage Decision` comment explaining the routing choice and what downstream work is expected (e.g., what to investigate, what the plan should cover, or what the trivial fix is).

**Before completing (REQUIRED for all branches):** export `RALPH_TRIAGE_ACTION` so `triage-postcondition.sh` can verify the action was taken:

```bash
# Pick the value that matches your action:
export RALPH_TRIAGE_ACTION=ROUTE_TO_RESEARCH   # routed to Research Needed
export RALPH_TRIAGE_ACTION=ROUTE_TO_PLAN       # routed to Ready for Plan
export RALPH_TRIAGE_ACTION=ROUTE_TO_IMPL       # routed to In Progress
# export RALPH_TRIAGE_ACTION=SPLIT | CLOSE | HUMAN | CANCEL | RE-ESTIMATE
```

Valid values: `ROUTE_TO_RESEARCH | ROUTE_TO_PLAN | ROUTE_TO_IMPL | SPLIT | CLOSE | HUMAN | CANCEL | RE-ESTIMATE`. The postcondition hook blocks exit if `RALPH_TRIAGE_ACTION` is unset or holds an unrecognized value.

## §Step 6: Mark issue as triaged

Apply the `ralph-triage` label only on `HUMAN` and `SPLIT` outcomes — the two that leave the issue in Backlog. Read current labels first, then include them all plus `ralph-triage` in the `save_issue` call.

`ROUTE-TO` outcomes move the issue out of Backlog; the issue is naturally invisible to triage's Backlog query after routing, so no label is needed.

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

Emit exactly one of the tokens defined in [outcome-tokens.md](../outcome-tokens.md):

- `TRIAGED routed → Research Needed` — issue routed to Research Needed for investigation.
- `TRIAGED routed → Ready for Plan` — issue routed to Ready for Plan (well-specified, skip research).
- `TRIAGED routed → In Progress` — trivial fix; issue routed directly to In Progress.
- `TRIAGED duplicate` — closed as duplicate; references `## Duplicate Of` comment.
- `TRIAGED canceled` — closed not-planned.
- `TRIAGED needs-split` — left in Backlog with `needs-split` label so `--mode split` picks it up.
- `TRIAGED escalated` — escalated to Human Needed; `ralph-triage` label applied.
- `TRIAGED re-estimated` — estimate updated; issue stays in Backlog.
- `Queue empty.` — no untriaged Backlog issues (emitted at §Step 2).

`triage-postcondition.sh` greps the transcript for one of these tokens. Anything else fails the Stop hook with exit 2.

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
