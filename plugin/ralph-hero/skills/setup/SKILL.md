---
description: One-time setup for Ralph GitHub workflow - creates GitHub Project V2 with required custom fields, workflow states, priorities, estimates, and configuration. Use when setting up a new repository for Ralph, configuring GitHub Projects, or troubleshooting missing workflow states.
argument-hint: "[project-number]"
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=setup"
allowed-tools:
  - Bash
  - ralph_hero__health_check
  - ralph_hero__get_project
  - ralph_hero__setup_project
---

# Ralph GitHub Setup

One-time interactive setup skill for configuring a GitHub repository with the Ralph workflow. Creates a GitHub Project V2 with all required custom fields, views, and configuration.

## Quick Start

Ralph needs **one token** and **three settings**. The token is stored securely via the Claude Code plugin config system.

### 1. Configure Your Token

Run `claude plugin configure ralph-hero` in your terminal. You will be prompted for your GitHub Personal Access Token.

Go to https://github.com/settings/tokens > **Generate new token (classic)**
- Scopes needed: `repo`, `project`, `read:org` (if using org repos)

Your token is stored securely:
- **macOS**: System Keychain (encrypted, OS-managed)
- **WSL2/Linux**: `~/.claude/.credentials.json` (mode 0600, user-only access)

### 2. Add Non-Sensitive Config

Create or edit `.claude/settings.local.json` in your project (this file is gitignored):

```json
{
  "env": {
    "RALPH_GH_OWNER": "your-github-username-or-org",
    "RALPH_GH_REPO": "your-repo-name",
    "RALPH_GH_PROJECT_NUMBER": "1"
  }
}
```

If you don't have a project number yet, omit it -- this skill will create one for you.

### 3. Restart Claude Code

The MCP server reads environment variables at startup. After changing settings, restart Claude Code, then run `/ralph-hero:setup` again.

### Where NOT to put tokens

- **Don't put tokens in `.mcp.json`** -- the plugin config system handles token delivery securely
- **Don't put tokens in `.bashrc` after the interactive guard** -- non-interactive processes (like MCP servers) won't see them
- **Don't commit tokens to git** -- use `claude plugin configure` for tokens, `settings.local.json` for non-sensitive config

### Advanced: Split-Owner / Dual-Token

If your repo is in an org but the project is under your personal account, see Step 2 below for split-owner configuration and dual-token setup.

## Workflow

### Step 1: Detect Token

1. Call `ralph_hero__health_check`
2. Display all check results clearly:

```
Health Check Results
====================
Auth:            [ok/fail] -- [detail]
Repo Access:     [ok/fail/skip] -- [detail]
Project Access:  [ok/fail/skip] -- [detail]
Required Fields: [ok/fail/skip] -- [detail]

Config:
  Repo Owner:     [value]
  Repository:     [value]
  Project Owner:  [value]
  Project Number: [value]
  Token Mode:     [single-token/dual-token]
  Token Source:   [RALPH_HERO_GITHUB_TOKEN/RALPH_GH_REPO_TOKEN]
```

3. **If `auth` passes**: Skip to Step 3 (Collect Config) -- token is already configured.

4. **If `auth` fails**: STOP. Display:
   ```
   Authentication failed. Your token may be missing, expired, or invalid.

   Fix: Run this command in your terminal to configure your token:

     claude plugin configure ralph-hero

   You will be prompted for your GitHub Personal Access Token.
   Generate one at: https://github.com/settings/tokens
   Required scopes: repo, project

   Your token will be stored securely:
   - macOS: System Keychain (encrypted, OS-managed)
   - WSL2/Linux: ~/.claude/.credentials.json (mode 0600, user-only access)

   WSL2 note: If the browser does not open automatically, set the BROWSER
   environment variable or copy the URL manually when prompted.

   After configuring, restart Claude Code and re-run /ralph-hero:setup.
   ```

5. **If `repoAccess` fails**: STOP. Display:
   ```
   Cannot access repository [owner]/[repo].

   Possible causes:
   - RALPH_GH_OWNER or RALPH_GH_REPO is incorrect
   - Token lacks 'repo' scope
   - Token doesn't have access to this org

   Fix: Verify your env vars in .claude/settings.local.json and token scopes,
   then restart Claude Code.
   ```

6. **If `projectAccess` fails or is skipped**: This is expected for first-time setup or org repos without project access. **Do NOT stop** -- continue to Step 2 which will handle project creation.

7. **If all checks pass**: Skip to Step 4 (Create or Verify Project).

### Step 2: Choose Setup Mode

Ask the user using AskUserQuestion:

**Question**: "What kind of setup do you need?"
**Options**:
- **"Same owner for repo and project"** -- Simple setup. The repo owner and project owner are the same user or org.
- **"Split setup (org repo + personal project)"** -- Your repo is in an org but the project is under your personal account.

**If split setup**, ask a follow-up:

**Question**: "What is your GitHub username for the project?"
- Pre-fill with the `authenticatedUser` from the health check if available

Record the chosen project owner. If it differs from `RALPH_GH_OWNER`, note that we're in **split-owner mode**.

#### Split-Owner: Check Token Configuration

If project owner differs from repo owner, ask using AskUserQuestion:

**Question**: "Does your current token have both org repo access AND personal project access?"
**Options**:
- **"Yes, one token works for both"** -- Single token mode. Continue.
- **"No, I need separate tokens"** -- Guide them through dual-token setup.

**If they need separate tokens**, display:

```
Dual-Token Setup
================

You need two Personal Access Tokens. Create them at:
https://github.com/settings/tokens

1. Repo token -- scopes: repo, read:org
2. Project token -- scopes: project

Add both to .claude/settings.local.json:

{
  "env": {
    "RALPH_GH_REPO_TOKEN": "ghp_repo_token_here",
    "RALPH_GH_PROJECT_TOKEN": "ghp_project_token_here",
    "RALPH_GH_PROJECT_OWNER": "your-github-username"
  }
}

Note: The primary token (configured via `claude plugin configure`) is used
for repo operations. RALPH_GH_REPO_TOKEN and RALPH_GH_PROJECT_TOKEN override
the primary token when set. For most dual-token setups, set these two env
vars in settings.local.json alongside the plugin-configured primary token.

Then restart Claude Code and run /ralph-hero:setup again.
```

**STOP here** if they need to create new tokens -- they must restart Claude Code for the MCP server to pick up new env vars.

### Step 3: Collect Config

Prompt the user interactively for non-sensitive configuration values:

**For simple setup (same owner):**
1. Ask for `RALPH_GH_OWNER` (GitHub username or org)
2. Ask for `RALPH_GH_REPO` (repository name)
3. Ask for `RALPH_GH_PROJECT_NUMBER` (if known; can be omitted if creating new project)

**For split-owner setup:**
1. Ask for `RALPH_GH_OWNER` (org or repo owner)
2. Ask for `RALPH_GH_REPO` (repository name)
3. Ask for `RALPH_GH_PROJECT_OWNER` (personal GitHub username)
4. Ask for `RALPH_GH_PROJECT_NUMBER` (if known)

Write the collected values to `.claude/settings.local.json` under `"env"`. Token is NOT written to `settings.local.json` -- it is delivered via the plugin config system.

Example for simple setup:
```json
{
  "env": {
    "RALPH_GH_OWNER": "my-org",
    "RALPH_GH_REPO": "my-repo",
    "RALPH_GH_PROJECT_NUMBER": "3"
  }
}
```

Example for split-owner setup:
```json
{
  "env": {
    "RALPH_GH_OWNER": "my-org",
    "RALPH_GH_REPO": "my-repo",
    "RALPH_GH_PROJECT_OWNER": "my-username",
    "RALPH_GH_PROJECT_NUMBER": "3"
  }
}
```

### Step 4: Create or Verify Project

**If `RALPH_GH_PROJECT_NUMBER` is set and project was accessible in Step 1:**
1. Call `ralph_hero__get_project` to verify the project exists
2. Verify it has the required custom fields (Workflow State, Priority, Estimate)
3. If fields are missing, report what's missing and offer to create them
4. Skip to Step 5

**If `RALPH_GH_PROJECT_NUMBER` is NOT set (or project wasn't accessible):**
1. Call `ralph_hero__setup_project` with `owner` set to the **project owner** determined in Step 2 (NOT the repo owner, unless they're the same)
2. This creates:
   - **Workflow State** single-select field with 11 options:
     Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, Canceled
   - **Priority** single-select field with 4 options:
     P0 (Critical), P1 (High), P2 (Medium), P3 (Low)
   - **Estimate** single-select field with 5 options:
     XS(1), S(2), M(3), L(4), XL(5)
3. Record the project number from the response

### Step 4b: Create Default Views (Manual)

**Note**: GitHub's GraphQL API does NOT support creating views programmatically. Instruct the user to create these two views manually in the GitHub UI:

#### 1. Ralph Table View
1. Click **New view** > choose **Table**
2. Name it **Ralph Table**
3. **Group by**: Click the group icon > select **Priority**
4. **Enable sub-issue hierarchy**: Click the kebab menu > toggle on **Sub-issues**
5. **Filter**: Set the filter bar to `-has:parent-issue` (shows only top-level issues)
6. **Save** the view

#### 2. Ralph Kanban
1. Click **New view** > choose **Board**
2. Name it **Ralph Kanban**
3. **Set columns**: Click the column header dropdown > select **Workflow State** as the column field
4. **Hide non-active columns**: Set the filter bar to `-workflow-state:Canceled,Done,"Research in Progress","Plan in Progress","Plan in Review"`
5. **Save** the view

This gives two complementary views:
- **Ralph Table** -- Priority-grouped hierarchy of all top-level issues with expandable sub-issues
- **Ralph Kanban** -- Board showing only actionable workflow columns

### Step 5: Store Local Config

Create a local configuration file at `.claude/ralph-hero.local.md` in the current project.

**For simple setup (same owner):**

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
| Token Delivery | Plugin config (secure) |

## Non-Sensitive Environment Variables

Set in `.claude/settings.local.json`:

```json
{
  "env": {
    "RALPH_GH_OWNER": "[owner]",
    "RALPH_GH_REPO": "[repo]",
    "RALPH_GH_PROJECT_NUMBER": "[number]"
  }
}
```

Token is managed via `claude plugin configure ralph-hero` (stored in system keychain).
```

**For split-owner setup:**

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
| Token Delivery | Plugin config (secure) |

## Non-Sensitive Environment Variables

Set in `.claude/settings.local.json`:

```json
{
  "env": {
    "RALPH_GH_OWNER": "[repo-owner]",
    "RALPH_GH_REPO": "[repo]",
    "RALPH_GH_PROJECT_OWNER": "[project-owner]",
    "RALPH_GH_PROJECT_NUMBER": "[number]"
  }
}
```

Token is managed via `claude plugin configure ralph-hero` (stored in system keychain).
For dual-token setups, add `RALPH_GH_REPO_TOKEN` and `RALPH_GH_PROJECT_TOKEN` to `settings.local.json`.
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
2. Display the results including the `tokenSource` field from the config output:
   ```
   Verification: All checks passed.
   Token source: [tokenSource from health_check config]
   Token mode:   [tokenMode from health_check config]
   ```
3. Call `ralph_hero__get_project` to confirm project is accessible
4. If verification fails, display what went wrong and remediation steps

### Step 6b: Enable Routing & Sync (Optional)

This step introduces the routing and sync infrastructure shipped with Ralph. The workflows are already installed in `.github/workflows/` but require a `ROUTING_PAT` secret to function.

Display context, then ask the user using AskUserQuestion:

```
Routing & Sync (Optional)
=========================
Ralph can automatically:
- Route new issues/PRs to your project based on label rules
- Sync Workflow State when issues are closed/reopened
- Advance linked issues when PRs are merged
- Sync state across multiple projects

These features require a ROUTING_PAT repository secret.
The workflows are already installed in .github/workflows/.
```

**Question**: "Would you like to enable automated issue routing and workflow state sync?"
**Options**:
- **"Yes, set it up now"** -- Continue with sub-steps below
- **"Skip for now"** -- Record `routingEnabled: false` and skip to Step 7

**If "Skip for now"**: Record routing state and proceed to Step 7.

**If "Yes, set it up now"**, guide through three sub-steps:

#### 6b-i. ROUTING_PAT Secret

Display instructions (secret creation cannot be automated via API):

```
Step 1: Add ROUTING_PAT Secret
===============================
Go to: https://github.com/[owner]/[repo]/settings/secrets/actions
Click "New repository secret"

Name:  ROUTING_PAT
Value: (paste your GitHub PAT -- the same token you configured via plugin config works)

Required scopes: repo, project
Note: GITHUB_TOKEN cannot write to Projects V2 -- a PAT is required.
```

Then ask using AskUserQuestion:

**Question**: "Have you added the ROUTING_PAT secret?"
**Options**:
- **"Yes, it's added"** -- Record `routingPatAdded: true`, continue
- **"I'll do it later"** -- Record `routingPatAdded: pending`, continue

#### 6b-ii. Repository Variables (Optional)

Display the variables table and explain defaults:

```
Step 2: Repository Variables (Optional)
========================================
The sync workflows use these variables with defaults.
Only set them if your values differ from the defaults.

Go to: https://github.com/[owner]/[repo]/settings/variables/actions

| Variable              | Default      | Set if...                          |
|-----------------------|--------------|------------------------------------|
| RALPH_PROJECT_OWNER   | cdubiel08    | Your project owner differs         |
| RALPH_PROJECT_NUMBER  | 3            | Your project number differs        |
| ROUTING_DEFAULT_PROJECT | (none)     | You want a fallback project        |
| SYNC_PROJECT_FILTER   | (none)       | You use cross-project sync         |
```

Then ask using AskUserQuestion:

**Question**: "Do you need to set any repository variables?"
**Options**:
- **"No, defaults are fine"** -- Record `repoVarsConfigured: true`, continue
- **"Yes, I'll set them now"** -- Display the Settings > Variables URL, wait for confirmation, record `repoVarsConfigured: true`
- **"I'll configure later"** -- Record `repoVarsConfigured: pending`, continue

#### 6b-iii. Routing Config Stub (Optional)

Ask using AskUserQuestion:

**Question**: "Would you like to create a starter `.ralph-routing.yml` config?"
**Options**:
- **"Yes, create a starter config"** -- Create or edit `.ralph-routing.yml`:
  ```yaml
  rules:
    - match:
        labels: ["enhancement"]
      action:
        workflowState: "Backlog"
        projectNumber: [project-number]
  ```
  Record `routingConfigCreated: true`
- **"No, I'll create it manually"** -- Display: `See docs/cross-repo-routing.md for the full config format.` Record `routingConfigCreated: false`
- **"Skip routing config"** -- Record `routingConfigCreated: false`, continue

#### Record Routing State

After completing (or skipping) the sub-steps, record state for use in the config file and final report:

- `routingEnabled`: true/false
- `routingPatAdded`: true/false/pending
- `repoVarsConfigured`: true/false/pending
- `routingConfigCreated`: true/false

**Append to `.claude/ralph-hero.local.md`** (written in Step 5):

If `routingEnabled` is true, append:

```markdown
## Routing & Sync

| Setting | Value |
|---------|-------|
| Routing Enabled | [yes/no] |
| ROUTING_PAT Secret | [added/pending/not configured] |
| Repository Variables | [defaults/custom/pending] |
| Routing Config | [created at .ralph-routing.yml / not created] |

Sync workflows (auto-activate when ROUTING_PAT is set):
- sync-issue-state.yml -- Syncs Workflow State on close/reopen
- sync-pr-merge.yml -- Advances linked issues on PR merge
- sync-project-state.yml -- Cross-project state sync

For cross-repo routing setup, see: docs/cross-repo-routing.md
```

### Step 7: Final Report

**For simple setup (same owner):**
```
Setup Complete
==============

Project: [project title]
URL: [project URL]
Project Number: [number]
Token: Stored securely via plugin config (tokenSource: [tokenSource from health_check])

Custom Fields:
  - Workflow State: 11 options configured
  - Priority: 4 options configured
  - Estimate: 5 options configured

Views (create manually in GitHub UI):
  - Ralph Table (Table, grouped by Priority, sub-issue hierarchy, -has:parent-issue)
  - Ralph Kanban (Board, Workflow State columns, hidden: Canceled/Done/locked states)

Configuration saved to: .claude/ralph-hero.local.md
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
Token: Stored securely via plugin config (tokenSource: [tokenSource from health_check])

Custom Fields:
  - Workflow State: 11 options configured
  - Priority: 4 options configured
  - Estimate: 5 options configured

Views (create manually in GitHub UI):
  - Ralph Table (Table, grouped by Priority, sub-issue hierarchy, -has:parent-issue)
  - Ralph Kanban (Board, Workflow State columns, hidden: Canceled/Done/locked states)

Configuration saved to: .claude/ralph-hero.local.md
```

**If routing was enabled**, append to either template:
```
Routing & Sync:
  - ROUTING_PAT secret: [Added / Pending -- add at Settings > Secrets > Actions]
  - Repository variables: [Defaults OK / Custom set / Pending]
  - Routing config: [Created (.ralph-routing.yml) / Not created]
  - Sync workflows: Pre-installed (activate when ROUTING_PAT is set)
```

**If routing was skipped**, append:
```
Routing & Sync: Skipped (run /ralph-hero:setup again to enable later)
  See docs/cross-repo-routing.md for manual setup
```

**Next steps (if routing was enabled):**
```
Next steps:
1. Restart Claude Code if you changed any env vars
2. [If ROUTING_PAT pending] Add ROUTING_PAT secret: https://github.com/[owner]/[repo]/settings/secrets/actions
3. [If routing config not created] Create .ralph-routing.yml (see docs/cross-repo-routing.md)
4. Run /ralph-triage to start processing issues
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

Items 2 and 3 are conditional -- only include them if the corresponding state is pending/not created.

**Next steps (if routing was skipped):**
```
Next steps:
1. Restart Claude Code if you changed any env vars
2. Run /ralph-triage to start processing issues
Tip: To use Ralph from your terminal, run /ralph-hero:setup-cli to install the global `ralph` command.
```

## Error Handling

- If token validation fails: Report `claude plugin configure ralph-hero` as the fix, not manual settings editing
- If project creation fails on org: Suggest personal project as alternative
- If project creation fails on personal: Check token has `project` scope
- If view creation fails: Continue (views are optional, can be created manually)
- If configuration file write fails: Print the configuration to stdout instead
- If user needs new tokens: STOP with clear instructions, they must restart after reconfiguring
