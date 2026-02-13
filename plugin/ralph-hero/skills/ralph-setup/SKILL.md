---
description: One-time setup for Ralph GitHub workflow - creates GitHub Project V2 with required custom fields, workflow states, priorities, estimates, and configuration. Use when setting up a new repository for Ralph, configuring GitHub Projects, or troubleshooting missing workflow states.
argument-hint: "[project-number]"
model: haiku
env:
  RALPH_COMMAND: "setup"
---

# Ralph GitHub Setup

One-time interactive setup skill for configuring a GitHub repository with the Ralph workflow. Creates a GitHub Project V2 with all required custom fields, views, and configuration.

## Prerequisites

Before running this skill, ensure you have at minimum:

1. **A GitHub Personal Access Token** with `repo` and `project` scopes
2. **`RALPH_GH_OWNER`** and **`RALPH_GH_REPO`** set to target your repository

The setup will guide you through everything else, including token configuration for org repos with personal projects.

## Workflow

### Step 1: Health Check & Diagnosis

1. Call `ralph_hero__health_check`
2. Display all check results clearly:

```
Health Check Results
====================
Auth:            [ok/fail] — [detail]
Repo Access:     [ok/fail/skip] — [detail]
Project Access:  [ok/fail/skip] — [detail]
Required Fields: [ok/fail/skip] — [detail]

Config:
  Repo Owner:     [value]
  Repository:     [value]
  Project Owner:  [value]
  Project Number: [value]
  Token Mode:     [single-token/dual-token]
```

3. **If `auth` fails**: STOP. Display:
   ```
   Authentication failed. Your token may be expired or invalid.

   Fix: Set a valid token:
     export RALPH_HERO_GITHUB_TOKEN="ghp_your_token_here"

   Generate one at: https://github.com/settings/tokens
   Required scopes: repo, project

   After setting the variable, restart Claude Code.
   ```

4. **If `repoAccess` fails**: STOP. Display:
   ```
   Cannot access repository [owner]/[repo].

   Possible causes:
   - RALPH_GH_OWNER or RALPH_GH_REPO is incorrect
   - Token lacks 'repo' scope
   - Token doesn't have access to this org

   Fix: Verify your env vars and token scopes, then restart Claude Code.
   ```

5. **If `projectAccess` fails or is skipped**: This is expected for first-time setup or org repos without project access. **Do NOT stop** — continue to Step 2 which will handle project creation.

6. **If all checks pass**: Great — skip to Step 3 (verify existing project).

### Step 2: Determine Project Owner

This step runs when there's no accessible project yet (projectAccess failed/skipped).

Ask the user using AskUserQuestion:

**Question**: "Where should the GitHub Project be created?"
**Options**:
- **"Under [RALPH_GH_OWNER] (org/user)"** — Use the repo owner. Works when your token has org-level project permissions.
- **"Under my personal account"** — Use your personal GitHub username. Works when you don't have org project access but want to track org repo issues in a personal project.

**If they choose personal account**, ask a follow-up:

**Question**: "What is your GitHub username for the project?"
- Pre-fill with the `authenticatedUser` from the health check if available

Record the chosen project owner. If it differs from `RALPH_GH_OWNER`, note that we're in **split-owner mode**.

### Step 2b: Check Token Scopes for Split-Owner Mode

If project owner differs from repo owner:

Ask using AskUserQuestion:

**Question**: "Does your current token have both org repo access AND personal project access?"
**Options**:
- **"Yes, one token works for both"** — Single token mode. Continue.
- **"No, I need separate tokens"** — Guide them through dual-token setup.

**If they need separate tokens**, display:

```
Dual-Token Setup
================

You need two Personal Access Tokens:

1. Repo token (for org issues/PRs):
   - Go to: https://github.com/settings/tokens
   - Create a token with scopes: repo, read:org
   - Set: export RALPH_GH_REPO_TOKEN="ghp_..."

2. Project token (for personal project):
   - Go to: https://github.com/settings/tokens
   - Create a token with scopes: project
   - Set: export RALPH_GH_PROJECT_TOKEN="ghp_..."

Also set:
   export RALPH_GH_PROJECT_OWNER="[their-username]"

After setting these variables, restart Claude Code and run /ralph-setup again.
```

**STOP here** if they need to create new tokens — they must restart Claude Code for the MCP server to pick up new env vars.

### Step 3: Create or Verify Project

**If `RALPH_GH_PROJECT_NUMBER` is set and project was accessible in Step 1:**
1. Call `ralph_hero__get_project` to verify the project exists
2. Verify it has the required custom fields (Workflow State, Priority, Estimate)
3. If fields are missing, report what's missing and offer to create them
4. Skip to Step 4

**If `RALPH_GH_PROJECT_NUMBER` is NOT set (or project wasn't accessible):**
1. Call `ralph_hero__setup_project` with `owner` set to the **project owner** determined in Step 2 (NOT the repo owner, unless they're the same)
2. This creates:
   - **Workflow State** single-select field with 11 options:
     - Backlog, Research Needed, Research in Progress
     - Ready for Plan, Plan in Progress, Plan in Review
     - In Progress, In Review, Done, Human Needed, Canceled
   - **Priority** single-select field with 4 options:
     - P0 (Critical), P1 (High), P2 (Medium), P3 (Low)
   - **Estimate** single-select field with 5 options:
     - XS(1), S(2), M(3), L(4), XL(5)
3. Record the project number from the response

### Step 4: Update Field Colors and Descriptions

Use `ralph_hero__update_field_options` to apply color coding and descriptions to all custom fields (Workflow State, Priority, Estimate). The setup_project tool creates fields with the correct colors, but this step can be used to adjust them after creation.

### Step 4b: Create Default Views (Manual)

**Note**: GitHub's GraphQL API does NOT support creating views programmatically. Instruct the user to create these two views manually in the GitHub UI:

#### 1. Ralph Table View
1. Click **New view** → choose **Table**
2. Name it **Ralph Table**
3. **Group by**: Click the group icon → select **Priority**
4. **Enable sub-issue hierarchy**: Click the kebab menu (⋯) → toggle on **Sub-issues**
5. **Filter**: Set the filter bar to `-has:parent-issue` (shows only top-level issues)
6. **Save** the view

#### 2. Ralph Kanban
1. Click **New view** → choose **Board**
2. Name it **Ralph Kanban**
3. **Set columns**: Click the column header dropdown → select **Workflow State** as the column field
4. **Hide non-active columns**: Set the filter bar to `-workflow-state:Canceled,Done,"Research in Progress","Plan in Progress","Plan in Review"`
5. **Save** the view

This gives two complementary views:
- **Ralph Table** — Priority-grouped hierarchy of all top-level issues with expandable sub-issues
- **Ralph Kanban** — Board showing only actionable workflow columns (Backlog, Research Needed, Ready for Plan, In Progress, In Review, Human Needed)

### Step 5: Store Configuration

Create a local configuration file at `.claude/ralph-hero.local.md` in the current project.

**If repo owner == project owner (simple setup):**

```markdown
---
# Ralph GitHub Plugin - Local Configuration
# Generated by ralph-setup on [date]
# Do not commit this file (add to .gitignore)
---

# Ralph GitHub Configuration

## Project Settings

| Setting | Value |
|---------|-------|
| Owner | [owner] |
| Repository | [repo] |
| Project Number | [number] |
| Project URL | [url] |

## Environment Variables

Set these in your shell profile or `.env` file:

```bash
export RALPH_HERO_GITHUB_TOKEN="[token]"  # or keep existing
export RALPH_GH_OWNER="[owner]"
export RALPH_GH_REPO="[repo]"
export RALPH_GH_PROJECT_NUMBER="[number]"
```
```

**If repo owner != project owner (split-owner setup):**

```markdown
---
# Ralph GitHub Plugin - Local Configuration
# Generated by ralph-setup on [date]
# Do not commit this file (add to .gitignore)
---

# Ralph GitHub Configuration

## Project Settings

| Setting | Value |
|---------|-------|
| Repo Owner | [repo-owner] |
| Repository | [repo] |
| Project Owner | [project-owner] |
| Project Number | [number] |
| Project URL | [url] |
| Token Mode | [single-token or dual-token] |

## Environment Variables

Set these in your shell profile or `.env` file:

```bash
export RALPH_GH_OWNER="[repo-owner]"
export RALPH_GH_REPO="[repo]"
export RALPH_GH_PROJECT_OWNER="[project-owner]"
export RALPH_GH_PROJECT_NUMBER="[number]"

# Token configuration:
# Option A: Single token with both org repo + personal project access
export RALPH_HERO_GITHUB_TOKEN="ghp_..."

# Option B: Separate tokens (if single token doesn't cover both)
export RALPH_GH_REPO_TOKEN="ghp_..."      # org repo access
export RALPH_GH_PROJECT_TOKEN="ghp_..."   # personal project access
```
```

Also include the Workflow States table in both cases:

```markdown
## Workflow States

| State | Description |
|-------|-------------|
| Backlog | Untriaged issues |
| Research Needed | Needs research before planning |
| Research in Progress | Currently being researched |
| Ready for Plan | Research complete, ready for planning |
| Plan in Progress | Implementation plan being created |
| Plan in Review | Plan ready for review |
| In Progress | Implementation underway |
| In Review | PR created, awaiting review |
| Done | Completed |
| Human Needed | Requires human intervention |
```

### Step 6: Verify Setup

1. Call `ralph_hero__health_check` to confirm all checks pass
2. Call `ralph_hero__get_project` to confirm project is accessible
3. If verification fails, display what went wrong and remediation steps

### Step 7: Final Report

**For simple setup (same owner):**
```
Setup Complete
==============

Project: [project title]
URL: [project URL]
Project Number: [number]

Custom Fields:
  - Workflow State: 11 options configured
  - Priority: 4 options configured
  - Estimate: 5 options configured

Views (create manually in GitHub UI):
  - Ralph Table (Table, grouped by Priority, sub-issue hierarchy, -has:parent-issue)
  - Ralph Kanban (Board, Workflow State columns, hidden: Canceled/Done/locked states)

Configuration saved to: .claude/ralph-hero.local.md

Next steps:
1. Set environment variables (see configuration file)
2. Restart Claude Code for env changes to take effect
3. Run /ralph-triage to start processing issues
```

**For split-owner setup:**
```
Setup Complete
==============

Repository: [repo-owner]/[repo]
Project: [project title] (owned by [project-owner])
URL: [project URL]
Project Number: [number]
Token Mode: [single-token/dual-token]

Custom Fields:
  - Workflow State: 11 options configured
  - Priority: 4 options configured
  - Estimate: 5 options configured

Views (create manually in GitHub UI):
  - Ralph Table (Table, grouped by Priority, sub-issue hierarchy, -has:parent-issue)
  - Ralph Kanban (Board, Workflow State columns, hidden: Canceled/Done/locked states)

Configuration saved to: .claude/ralph-hero.local.md

IMPORTANT: Set these environment variables and restart Claude Code:
  export RALPH_GH_PROJECT_OWNER="[project-owner]"
  export RALPH_GH_PROJECT_NUMBER="[number]"
  [+ any token exports needed]

The MCP server reads env vars at startup — changes require a restart.
```

## Error Handling

- If token validation fails: Report required scopes and how to create a new token
- If project creation fails on org: Suggest personal project as alternative
- If project creation fails on personal: Check token has `project` scope
- If view creation fails: Continue (views are optional, can be created manually)
- If configuration file write fails: Print the configuration to stdout instead
- If user needs new tokens: STOP with clear instructions, they must restart after setting vars
