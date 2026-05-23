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
- **RESEARCH** — issue is valid but needs investigation; move to "Research Needed".
- **KEEP** — issue is valid as-is; leave in Backlog with a clarifying comment if helpful.

When uncertain, prefer KEEP with a detailed comment over closing valid work.

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

**RESEARCH.** Set `workflowState: "Research Needed"` (`command: "ralph_triage"`). Add a comment: "Moved to Research Needed for investigation." Briefly note what needs research so downstream `/ralph:research` has actionable context.

**KEEP.** Add a comment with any clarifications or context discovered. Leave workflow state as Backlog.

**Before completing (REQUIRED for all branches):** export `RALPH_TRIAGE_ACTION` so `triage-postcondition.sh` can verify the action was taken:

```bash
export RALPH_TRIAGE_ACTION=RESEARCH   # or SPLIT, CLOSE, KEEP, HUMAN, CANCEL, RE-ESTIMATE
```

Valid values: `RESEARCH`, `SPLIT`, `CLOSE`, `KEEP`, `HUMAN`, `CANCEL`, `RE-ESTIMATE`. The postcondition hook blocks exit if `RALPH_TRIAGE_ACTION` is unset or holds an unrecognized value.

## §Step 6: Mark issue as triaged

After completing any action, update labels to include `ralph-triage` while preserving existing labels. Read current labels first, then include them all plus `ralph-triage` in the `save_issue` call.

## §Step 7: Emit terminal token

Emit exactly one of the five tokens defined in [outcome-tokens.md](../outcome-tokens.md):

- `TRIAGED valid` — moved to Research Needed or Ready for Plan.
- `TRIAGED duplicate` — closed as duplicate; references `## Duplicate Of` comment.
- `TRIAGED canceled` — closed not-planned.
- `TRIAGED needs-split` — left in Backlog with `needs-split` label so `--mode split` picks it up.
- `Queue empty.` — no untriaged Backlog issues (emitted at §Step 2).

`triage-postcondition.sh` greps the transcript for one of these tokens. Anything else fails the Stop hook with exit 2.

## §Confidence levels

- **High** (take action automatically): feature exists in codebase (CLOSE), exact duplicate found (CLOSE), issue explicitly marked "done" in comments (CLOSE).
- **Medium** (act + note uncertainty): similar-but-not-identical feature, possibly-outdated issue, scope seems large but doable in phases.
- **Low** (KEEP + comment): ambiguous requirements, can't determine if feature exists, unclear relevance.

When uncertain, prefer KEEP over closing.

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
