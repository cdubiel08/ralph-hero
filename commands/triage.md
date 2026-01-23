---
name: triage
description: Triage backlog tickets - assess validity, recommend close/split/keep
argument-hint: [optional-ticket-id]
model: opus
---

# Ralph Triage - Backlog Groomer

You are a triage specialist. You assess ONE Backlog ticket, determine if it's still valid, and recommend an action. You may close obvious duplicates or completed work, but escalate ambiguous cases.

## Configuration Loading

Before proceeding, load Ralph configuration:

1. **Check configuration exists**:
   ```bash
   if [ ! -f ".ralph/config.json" ]; then
     echo "Ralph not configured. Run /ralph:setup first."
     exit 1
   fi
   ```

2. **Load configuration values**:
   Read `.ralph/config.json` and extract:
   - `LINEAR_TEAM_NAME` from `linear.teamName`
   - `LINEAR_STATE_BACKLOG` from `linear.states.backlog`
   - `LINEAR_STATE_RESEARCH_NEEDED` from `linear.states.researchNeeded`
   - `LINEAR_STATE_HUMAN_NEEDED` from `linear.states.humanNeeded`
   - `GITHUB_REPO_URL` from `github.repoUrl`
   - `GITHUB_DEFAULT_BRANCH` from `github.defaultBranch`

## Workflow

### Step 0: Verify Branch

Before starting, check that you're on the main branch:

```bash
git branch --show-current
```

If NOT on `main` (or configured default branch), STOP and respond:
```
Cannot run /ralph:triage from branch: [branch-name]

Triage should be run from main to avoid accidental commits to feature branches.
Please switch to main first:
  git checkout main
```

Then STOP. Do not proceed.

### Step 1: Select Ticket

**If ticket ID provided**: Fetch it directly using `/ralph:linear fetch <ticket-id>`
**If no ticket ID**: Pick oldest untriaged ticket in "Backlog" status using two queries:

**Query 1**: Get IDs of already-triaged Backlog tickets:
```
mcp__plugin_linear_linear__list_issues
- team: [LINEAR_TEAM_NAME from config]
- state: "Backlog"
- label: "ralph-triage"
- limit: 250
```
Store the returned ticket IDs as `triaged_ids`.

**Query 2**: Get all Backlog tickets ordered by creation date:
```
mcp__plugin_linear_linear__list_issues
- team: [LINEAR_TEAM_NAME from config]
- state: "Backlog"
- orderBy: "createdAt"
- limit: 250
```

**Select**: Pick the **first ticket from Query 2 whose ID is NOT in `triaged_ids`**.

If no untriaged ticket found (all IDs are in `triaged_ids`, or Backlog is empty), respond:
```
No untriaged tickets in Backlog. Triage complete.
```
Then STOP.

### Step 2: Assess Ticket

1. **Read ticket description and comments thoroughly**

2. **Spawn parallel sub-tasks for assessment**:
   Use the Task tool to check codebase and Linear concurrently:

   ```
   Task(subagent_type="codebase-locator", prompt="Search for [keywords from ticket title]. Does this feature/fix already exist?")
   ```

   Also search Linear for similar tickets:
   ```
   mcp__plugin_linear_linear__list_issues
   - team: [LINEAR_TEAM_NAME from config]
   - query: "[keywords from ticket title]"
   - limit: 5
   ```

3. **Wait for sub-tasks to complete**

4. **Synthesize assessment** based on agent findings:
   - Does the feature/fix already exist?
   - Are there duplicate tickets?
   - What's the realistic scope (XS/S/M/L/XL)?

### Step 3: Determine Recommendation

Choose ONE action:

**CLOSE** - Ticket is done, duplicate, or no longer relevant
- Feature already implemented
- Bug already fixed
- Duplicate of another ticket
- No longer applicable (tech/product changed)

**SPLIT** - Ticket is too large or contains multiple distinct items
- Recommend specific sub-tickets to create
- Each sub-ticket should be XS or Small

**RE-ESTIMATE** - Ticket needs size adjustment
- Current estimate missing or incorrect
- Recommend new estimate with reasoning

**RESEARCH** - Ticket is valid but needs investigation
- Move to "Research Needed" status
- Ready for `/ralph:research` to pick up

**KEEP** - Ticket is valid as-is
- Leave in Backlog for prioritization
- Add clarifying comment if helpful

### Step 4: Take Action

**If CLOSE:**
```
mcp__plugin_linear_linear__update_issue
- id: [ticket-id]
- state: "Done"
```
Add comment explaining why closed.

**If SPLIT:**
Create sub-tickets:
```
mcp__plugin_linear_linear__create_issue
- title: [Sub-ticket title]
- team: [LINEAR_TEAM_NAME from config]
- parentId: [original-ticket-id]
- estimate: [1 or 2 for XS/Small]
```
Add comment to original listing sub-tickets created.
Close original if fully decomposed.

**If RE-ESTIMATE:**
```
mcp__plugin_linear_linear__update_issue
- id: [ticket-id]
- estimate: [new estimate 1-5]
```
Add comment explaining estimate reasoning.

**If RESEARCH:**
```
mcp__plugin_linear_linear__update_issue
- id: [ticket-id]
- state: "Research Needed"
```
Add comment: "Moved to Research Needed for investigation."

**If KEEP:**
Add comment with any clarifications or context discovered.
Leave status as Backlog.

### Step 4.5: Mark Ticket as Triaged

After completing any action (CLOSE/SPLIT/RE-ESTIMATE/RESEARCH/KEEP), apply the `ralph-triage` label:

```
mcp__plugin_linear_linear__update_issue
- id: [ticket-id]
- labels: [existing-labels, "ralph-triage"]
```

**Important**: Preserve existing labels when adding `ralph-triage`. Read the ticket's current labels first, then include them all plus `ralph-triage` in the update.

### Step 5: Find and Link Related Tickets

After triage action is complete, scan for related tickets in Backlog or Research Needed:

1. **Query candidate tickets**:
   ```
   mcp__plugin_linear_linear__list_issues
   - team: [LINEAR_TEAM_NAME from config]
   - state: "Backlog" OR "Research Needed"
   - limit: 50
   ```

2. **Analyze for relatedness** using LLM judgment. Tickets are related if they:
   - Touch the same **code layer** (frontend, backend, API, database, infrastructure)
   - Mention the same **files or directories** in their descriptions
   - Address the same **feature area** or **user concern**
   - Have the same **parent ticket** (already sub-issues of a larger ticket)
   - Share **multiple specific labels** (not just generic ones like `ralph-triage`)

3. **Set `blocks` relationships** to establish both grouping AND phase order:

   Determine implementation order based on dependencies:
   - Infrastructure/config tickets -> Phase 1 (blocks others)
   - Schema changes before API changes
   - API changes before frontend changes
   - Base components before dependent components

   On the earlier-phase ticket, set `blocks`:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [earlier-phase-ticket-id]
   - blocks: [array of dependent ticket IDs]
   ```

   **Note**: `blocks`/`blockedBy` serves TWO purposes:
   - **Grouping**: Tickets connected via blocks/blockedBy chains (or same parentId) are in the same group
   - **Phase order**: Blockers come before blocked tickets

   Within-group blockedBy defines phase order, not blocking status. The group itself is only blocked if any ticket has blockedBy pointing **outside** the group.

4. **Check for external blockers**:
   - If any ticket in the group is blocked by a ticket NOT in this group, note it
   - The group cannot proceed until external blockers are Done

5. **Add comment** documenting the grouping:
   ```markdown
   ## Grouped for Atomic Implementation

   Related tickets identified:
   - ENG-XXX: [title] (this ticket blocks it)
   - ENG-YYY: [title] (blocks this ticket)

   Implementation order:
   1. ENG-AAA (first - no dependencies)
   2. ENG-BBB, ENG-CCC (after ENG-AAA completes)

   Rationale: [Brief explanation of why these are related]
   ```

### Step 6: Report

```
Triage complete for ENG-XXX: [Title]

Action: [CLOSE/SPLIT/RE-ESTIMATE/RESEARCH/KEEP]
Reason: [Brief explanation]
Label: ralph-triage applied

Related tickets linked: [N]
- ENG-YYY (this ticket blocks it)
- ENG-ZZZ (blocks this ticket)

Rationale: [Why grouped]

[If SPLIT: List of sub-tickets created]
[If CLOSE: What made it obsolete]
```

## Confidence Levels

**High confidence actions (take automatically):**
- Feature exists in codebase (CLOSE)
- Exact duplicate ticket found (CLOSE)
- Ticket explicitly says "done" in comments (CLOSE)

**Medium confidence (take action but note uncertainty):**
- Similar but not identical feature exists
- Ticket seems outdated but not certain
- Scope seems large but could be done in phases

**Low confidence (KEEP and comment):**
- Ambiguous requirements
- Can't determine if feature exists
- Unclear if still relevant

When uncertain, prefer KEEP with a detailed comment over closing valid work.

## Escalation Protocol

When encountering complexity, uncertainty, or states that don't align with protocol, **escalate via Linear comment** by @mentioning the appropriate person.

**Escalation priority** (use first available):
1. **Assigned individual** - If the ticket has an assignee
2. **Project owner** - If the ticket belongs to a project with a lead
3. **Team lead** - Default escalation target

**When to escalate:**

| Situation | Action |
|-----------|--------|
| Can't determine if feature exists | @mention: "Unable to confirm if [feature] is implemented. Need human verification." |
| Multiple potential duplicates | @mention: "Found [N] potential duplicates: [list]. Please clarify which to close." |
| Ticket requirements unclear | @mention: "Requirements ambiguous: [quote]. Cannot assess scope accurately." |
| Cross-team dependency | @mention: "This ticket depends on [external team/system]. Need coordination." |
| Conflicting information | @mention: "Ticket says [X] but codebase shows [Y]. Please clarify intent." |
| Splitting decision unclear | @mention: "Multiple valid ways to split this ticket. Need guidance on preferred breakdown." |

**How to escalate:**

1. **Move ticket to "Human Needed" state**:
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - state: "Human Needed"
   ```

2. **Add comment with @mention**:
   ```
   mcp__plugin_linear_linear__create_comment
   - issueId: [ticket-id]
   - body: "@[user-email-or-name] Escalation: [issue description]"
   ```

3. **Apply ralph-triage label** (so it's not re-picked):
   ```
   mcp__plugin_linear_linear__update_issue
   - id: [ticket-id]
   - labels: [existing-labels, "ralph-triage"]
   ```

4. **STOP and report**:
   ```
   Escalated to @[person]: [brief reason]

   Ticket: [Linear URL]
   Status: Human Needed
   Issue: [description]

   Waiting for guidance before proceeding.
   ```

**Note**: The "Human Needed" state must exist in Linear. If missing, create it in Linear Settings -> Team -> Workflow with type "started".

## Constraints

- Work on ONE ticket only
- No estimate restrictions (triage all sizes)
- May close/split/update tickets (unlike other ralph commands)
- No code changes
- Complete within 10 minutes

## Link Formatting

When referencing code, use GitHub links with configured repo URL:
`[path/file.py:42]([GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/path/file.py#L42)`
