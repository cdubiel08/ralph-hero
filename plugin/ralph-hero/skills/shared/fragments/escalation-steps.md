## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

| Situation | Action |
|-----------|--------|
| Issue scope larger than estimated | @mention: "This is [M/L/XL] complexity. Needs re-estimation or splitting." |
| Missing context/requirements | @mention: "Cannot proceed. Need clarification on: [specific questions]." |
| Architectural decision needed | @mention: "Multiple valid approaches: [A vs B]. Need guidance." |
| Conflicting existing patterns | @mention: "Found conflicting patterns: [A] vs [B]. Which to follow?" |
| Security concern identified | @mention: "Potential security issue: [description]. Need review." |

**How to escalate:**

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__save_issue(number=N, workflowState="__ESCALATE__", command="[current-command]")
   ```
   For group plans, move ALL group issues to "Human Needed".

2. **Post a `## Escalation` comment**. The `## Escalation` markdown header is **required** — `ralph-unblock`, `/ralph-hero:unblock`, and the MCP `human-needed-unblock` direction signal all discover this comment by header prefix (`body.startsWith("## Escalation")`). The body must also carry an `Escalation:` reason line (consumers extract the reason text) and an `Originating command: ralph_<cmd>` line (the interactive unblock skill uses this to route the issue back into the pipeline).

   Call shape:
   ```
   ralph_hero__create_comment(
     number,
     body=<<the markdown below>>
   )
   ```

   Comment body:
   ```markdown
   ## Escalation

   @$RALPH_GH_OWNER

   Escalation: [specific blocking question or constraint]

   Originating command: ralph_<current-command>
   ```

   Substitute `<current-command>` with the snake_case command name (e.g., `ralph_impl`, `ralph_plan`, `ralph_research`, `ralph_triage`, `ralph_review`, `ralph_split`).

3. **STOP and report**: Issue URL, status "Human Needed", brief reason.
