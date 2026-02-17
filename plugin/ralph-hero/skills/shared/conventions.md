# Shared Conventions

Common protocols referenced by all Ralph skills. Skills should link here rather than duplicating this content.

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via GitHub issue comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the issue has an assignee
2. **Project owner** - If the issue belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Issue scope larger than estimated | @mention: "This is [M/L/XL] complexity, not [XS/S]. Needs re-estimation or splitting." |
| Missing context/requirements | @mention: "Cannot proceed effectively. Need clarification on: [specific questions]." |
| Architectural decision needed | @mention: "Multiple valid approaches found: [A vs B]. Need architectural guidance." |
| External dependency discovered | @mention: "This requires [external API/service/team]. Need confirmation before proceeding." |
| Conflicting existing patterns | @mention: "Found conflicting patterns: [pattern A] vs [pattern B]. Which to follow?" |
| Plan doesn't match codebase | @mention: "Plan assumes [X] but found [Y]. Need updated plan." |
| Tests fail unexpectedly | @mention: "Tests fail: [error]. Not a simple fix - need guidance." |
| Breaking changes discovered | @mention: "Implementation would break [component]. Scope larger than planned." |
| Security concern identified | @mention: "Potential security issue: [description]. Need review before proceeding." |

**How to escalate:**

1. **Move issue to "Human Needed"**:
   ```
   ralph_hero__update_workflow_state
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - state: "__ESCALATE__"
   - command: "[current-command]"
   ```
   For group plans, move ALL group issues to "Human Needed".

2. **Add comment with @mention**:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: "@$RALPH_GH_OWNER Escalation: [issue description]"
   ```

3. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Issue: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   Status: Human Needed

   Waiting for guidance before proceeding.
   ```

## Link Formatting

When referencing code in documents, PRs, or GitHub comments, use GitHub links with environment variables:

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

## Common Error Handling

**Tool call failures**: If `update_workflow_state` returns an error, read the error message -- it contains valid states/intents and a specific Recovery action. Retry with the corrected parameters.

**State gate blocks**: Hooks enforce valid state transitions at the tool level. If a hook blocks your action, the state machine requires a different transition. Check the current workflow state and re-evaluate.

**Postcondition failures**: Stop hooks verify expected outputs (research doc, plan doc, commits). If a postcondition fails, check the specific requirement and satisfy it before retrying.

## Pipeline Handoff Protocol

Workers hand off to the next pipeline stage via peer-to-peer SendMessage, bypassing the lead for routine progression. The lead only handles exceptions and intake.

### Pipeline Order

| Current Role (agentType) | Next Stage | agentType to find |
|---|---|---|
| `ralph-researcher` | Planner | `ralph-planner` |
| `ralph-planner` | Reviewer | `ralph-advocate` |
| `ralph-advocate` | Implementer | `ralph-implementer` |
| `ralph-implementer` | Lead (PR creation) | `team-lead` |

### Handoff Procedure (after completing a task)

1. Check `TaskList` for more tasks matching your role
2. If found: self-claim and continue (no handoff needed)
3. If none available: hand off to the next-stage peer:
   - Read team config at `~/.claude/teams/[TEAM_NAME]/config.json`
   - Find the member whose `agentType` matches your "Next Stage" from the table above
   - SendMessage using the member's `name` field:
     ```
     SendMessage(
       type="message",
       recipient="[name from config]",
       content="Pipeline handoff: check TaskList for newly unblocked work",
       summary="Handoff: task unblocked"
     )
     ```
4. If the next-stage teammate is NOT found in the config (role not spawned):
   ```
   SendMessage(
     type="message",
     recipient="team-lead",
     content="No [next-role] teammate exists. Unblocked tasks may need a new worker.",
     summary="No peer for handoff"
   )
   ```

### Rules

- **Never use TaskUpdate with `owner` parameter** to assign tasks to other teammates. Workers self-claim only.
- **SendMessage is fire-and-forget** -- no acknowledgment mechanism. The handoff wakes the peer; they self-claim from TaskList.
- **Lead gets visibility** via idle notification DM summaries -- no need to CC the lead on handoffs.
- **Multiple handoffs are fine** -- if 3 researchers complete and all message the planner, the planner wakes 3 times and claims one task each time.
