---
name: linear
description: Manage Linear tickets from thoughts documents
argument-hint: <action> [ticket-or-path]
model: opus
---

# Linear Ticket Management

You are tasked with managing Linear tickets for your project. This command handles creating tickets from documents, updating existing tickets, and adding comments.

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
   - `LINEAR_TEAM_ID` from `linear.teamId`
   - All state IDs from `linear.states.*`
   - `GITHUB_REPO_URL` from `github.repoUrl`
   - `GITHUB_DEFAULT_BRANCH` from `github.defaultBranch`
   - `PLANS_DIR` from `paths.plansDir`
   - `RESEARCH_DIR` from `paths.researchDir`
   - `TICKETS_DIR` from `paths.ticketsDir`

## Actions

When invoked, parse the action from arguments:

- `/ralph:linear create <document-path>` - Create ticket from document
- `/ralph:linear update <ticket-id>` - Update ticket from linked document
- `/ralph:linear link <ticket-id> <document-path>` - Link existing ticket to document
- `/ralph:linear comment <ticket-id> <message>` - Add comment to ticket
- `/ralph:linear status` - Show tickets linked to recent documents
- `/ralph:linear fetch <ticket-id>` - Fetch ticket to local markdown file
- `/ralph:linear pick <status>` - Pick highest-priority XS/Small ticket by status

## Configuration Reference

**Team**: [LINEAR_TEAM_NAME from config]
**Team ID**: [LINEAR_TEAM_ID from config]

**Document URL Mapping**:
- `[PLANS_DIR]/` -> `[GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/[PLANS_DIR]/`
- `[RESEARCH_DIR]/` -> `[GITHUB_REPO_URL]/blob/[GITHUB_DEFAULT_BRANCH]/[RESEARCH_DIR]/`

**Workflow States** (from config):
| State | Config Key | When to Use |
|-------|------------|-------------|
| Backlog | linear.states.backlog | Initial triage |
| Research Needed | linear.states.researchNeeded | Needs investigation |
| Research in Progress | linear.states.researchInProgress | Active research |
| Ready for Plan | linear.states.readyForPlan | Research complete |
| Plan in Progress | linear.states.planInProgress | Active planning |
| Plan in Review | linear.states.planInReview | Plan awaiting approval |
| Todo | linear.states.todo | Ready for development |
| In Progress | linear.states.inProgress | Active development |
| In Review | linear.states.inReview | Code review |
| Done | linear.states.done | Completed |
| Human Needed | linear.states.humanNeeded | Blocked, needs human |

**Label Auto-Assignment**:
- Document in `[PLANS_DIR]/` -> add `planning` label
- Document in `[RESEARCH_DIR]/` -> add `research` label
- Document mentions `frontend` -> add `frontend` label
- Document mentions `api` or `backend` -> add `backend` label
- Document mentions `data` or `pipeline` -> add `data-architecture` label

## Create Ticket Workflow

When `/ralph:linear create <document-path>`:

1. **Read the source document FULLY**
2. **Extract key information**:
   - Title from first `#` heading
   - Overview/Summary section
   - Success criteria (if present)
   - Related files mentioned
3. **Determine appropriate state**:
   - Research document -> `Research in Progress`
   - Plan document -> `Plan in Progress` or `Plan in Review`
4. **Generate ticket description**:
   ```markdown
   ## Summary
   [1-2 sentence overview from document]

   ## Document Link
   [GitHub URL to document]

   ## Key Points
   - [Bullet from document]
   - [Another bullet]

   ## Success Criteria
   [From document if present]

   ---
   *Created from: `[document-path]`*
   ```
5. **Create ticket** using Linear MCP tools:
   - Set title, description, team, state, labels
   - Add link attachment to GitHub document URL
6. **Update document frontmatter** with ticket ID:
   ```yaml
   linear_ticket: ENG-XXX
   linear_url: https://linear.app/[team]/issue/ENG-XXX
   ```
7. **Report success** with ticket URL

## Update Ticket Workflow

When `/ralph:linear update <ticket-id>`:

1. **Get ticket details** using `mcp__plugin_linear_linear__get_issue`
2. **Find linked document** from ticket links or search by title
3. **Read document and compare** to current ticket state
4. **Identify changes**:
   - New sections added
   - Status/phase changes
   - Success criteria updates
5. **Update ticket description** if significant changes
6. **Add comment** summarizing changes:
   ```markdown
   ## Document Updated

   Changes in latest update:
   - [Change 1]
   - [Change 2]

   [GitHub commit link if available]
   ```
7. **Update ticket state** if warranted:
   - Plan marked approved -> move to `Todo`
   - Research completed -> move to `Ready for Plan`

## Link Ticket Workflow

When `/ralph:linear link <ticket-id> <document-path>`:

1. **Verify ticket exists** using `mcp__plugin_linear_linear__get_issue`
2. **Read the document FULLY**
3. **Add document link to ticket** using the links parameter in `update_issue`
4. **Update ticket description** with document summary
5. **Update document frontmatter** with ticket link:
   ```yaml
   linear_ticket: ENG-XXX
   linear_url: https://linear.app/[team]/issue/ENG-XXX
   ```
6. **Report success** with both URLs

## Comment Workflow

When `/ralph:linear comment <ticket-id> <message>`:

1. **Add comment** using `mcp__plugin_linear_linear__create_comment`
2. **Report success**

## Status Workflow

When `/ralph:linear status`:

1. **Find recent documents** in `[PLANS_DIR]/` and `[RESEARCH_DIR]/`
2. **Check frontmatter** for `linear_ticket` field
3. **For each linked document**, get ticket status from Linear
4. **Report summary**:
   ```
   Recent documents with Linear tickets:

   | Document | Ticket | Status |
   |----------|--------|--------|
   | 2026-01-19-feature.md | ENG-123 | Plan in Review |
   | 2026-01-18-research.md | ENG-122 | Research in Progress |
   ```

## Comment Quality Guidelines

Focus comments on:
- Key decisions made
- Tradeoffs considered
- Blockers or open questions
- Changes from original scope

Avoid:
- Mechanical change lists
- Verbose summaries
- Duplicate information

## Example Interactions

**Create from plan**:
```
User: /ralph:linear create [PLANS_DIR]/2026-01-19-feature.md
Assistant: [Reads document, creates ticket ENG-123, updates frontmatter]
Created Linear ticket: ENG-123
URL: https://linear.app/[team]/issue/ENG-123
State: Plan in Progress
Labels: planning, frontend
```

**Update existing**:
```
User: /ralph:linear update ENG-123
Assistant: [Fetches ticket, finds linked document, compares]
Updated ENG-123 with latest changes:
- Added Phase 3 for error handling
- Updated success criteria
Added comment with change summary.
```

**Link existing ticket**:
```
User: /ralph:linear link ENG-100 [PLANS_DIR]/2026-01-19-feature.md
Assistant: [Verifies ticket, reads document, updates both]
Linked ENG-100 to [PLANS_DIR]/2026-01-19-feature.md
- Added document link to ticket
- Updated document frontmatter with ticket reference
```

**Add comment**:
```
User: /ralph:linear comment ENG-123 Blocked on API design review
Assistant: Added comment to ENG-123: "Blocked on API design review"
```

**Check status**:
```
User: /ralph:linear status
Assistant: [Scans recent documents, queries Linear]
Recent documents with Linear tickets:

| Document | Ticket | Status |
|----------|--------|--------|
| 2026-01-19-linear-workflow-integration.md | ENG-123 | Plan in Review |
```

**Fetch ticket**:
```
User: /ralph:linear fetch ENG-100
Assistant: [Fetches ticket details and comments, creates local file]
Fetched ENG-100: Linear Integration Workflow
File: [TICKETS_DIR]/ENG-100.md
```

**Pick ticket**:
```
User: /ralph:linear pick "Research Needed"
Assistant: [Queries for XS/Small tickets in Research Needed status]
Picked ENG-105: API Rate Limiting (XS estimate, Priority 2)
File: [TICKETS_DIR]/ENG-105.md
```

## Fetch Ticket Workflow

When `/ralph:linear fetch <ticket-id>`:

1. **Get ticket details** using `mcp__plugin_linear_linear__get_issue` with `includeRelations: true`
2. **Get ticket comments** using `mcp__plugin_linear_linear__list_comments`
3. **Create local ticket file** at `[TICKETS_DIR]/ENG-XXX.md`:
   ```markdown
   ---
   ticket_id: ENG-XXX
   title: [Title]
   status: [Current Status]
   priority: [Priority 0-4]
   estimate: [XS/S/M/L/XL or null]
   labels: [label1, label2]
   created: [ISO date]
   updated: [ISO date]
   fetched: [ISO date of fetch]
   url: https://linear.app/[team]/issue/ENG-XXX
   ---

   # ENG-XXX: [Title]

   ## Description
   [Ticket description]

   ## Comments
   ### [Author] - [Date]
   [Comment text]

   ## Linked Documents
   - [List of attachments/links from ticket]
   ```
4. **Report success** with file path

## Pick Ticket Workflow

When `/ralph:linear pick <status>`:

1. **Query Linear** for tickets in specified status, ordered by priority:
   ```
   mcp__plugin_linear_linear__list_issues
   - team: [LINEAR_TEAM_NAME from config]
   - state: [status from argument]
   - limit: 50
   ```
2. **Filter to XS/Small estimates only**:
   - XS = estimate value 1
   - Small = estimate value 2
   - Skip tickets without estimates or with M/L/XL (3/4/5)
3. **Select highest priority** ticket:
   - Priority 1 = Urgent
   - Priority 2 = High
   - Priority 3 = Normal (default)
   - Priority 4 = Low
   - Priority 0 = No priority
4. **Fetch to local file** (same as `/ralph:linear fetch`)
5. **Report selection** with ticket details:
   ```
   Picked ENG-XXX: [Title]
   Estimate: [XS/Small]
   Priority: [1-4]
   File: [TICKETS_DIR]/ENG-XXX.md
   ```

If no eligible tickets found, report:
```
No XS/Small tickets in "[status]" status. Queue empty.
```

**Estimate Mapping**:
| Value | Size | Eligible |
|-------|------|----------|
| 1 | XS | Yes |
| 2 | Small | Yes |
| 3 | Medium | No |
| 4 | Large | No |
| 5 | XL | No |
| null | None | No |
