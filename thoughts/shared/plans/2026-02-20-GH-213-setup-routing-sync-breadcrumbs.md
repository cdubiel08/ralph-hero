---
date: 2026-02-20
status: complete
github_issues: [213]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/213
primary_issue: 213
---

# Integrate Routing/Sync Setup Steps into ralph-setup Breadcrumbs - Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-213 | Integrate routing/sync setup steps into ralph-setup breadcrumbs | S |

## Current State Analysis

The `ralph-setup` skill (`plugin/ralph-hero/skills/ralph-setup/SKILL.md`) guides users through initial project configuration across 7 steps: health check, project owner selection, project creation/verification, field colors, default views, configuration storage, verification, and final report. The final "Next steps" section (lines 363-368) lists only three items: verify settings, restart Claude Code, and run `/ralph-triage`.

Meanwhile, the full routing and sync infrastructure from epic #99 is shipped and operational:
- 4 GitHub Actions workflows: `route-issues.yml`, `sync-issue-state.yml`, `sync-pr-merge.yml`, `sync-project-state.yml`
- Routing engine (`scripts/routing/route.js`) and sync engine (`.github/scripts/sync/sync-project-state.js`)
- `configure_routing` MCP tool with 6 operations (list, add, update, remove, validate, dry_run)
- Comprehensive docs at `docs/cross-repo-routing.md`

Users completing `/ralph-setup` today have no awareness that routing and sync exist, and must discover `docs/cross-repo-routing.md` independently.

## Desired End State

### Verification
- [x] SKILL.md contains a new interactive Step 6b "Enable Routing & Sync (Optional)" between current Step 6 (Verify Setup) and Step 7 (Final Report)
- [x] The new step uses the `AskUserQuestion` pattern consistent with Steps 2, 2b
- [x] The step covers: ROUTING_PAT secret, repository variables, optional `.ralph-routing.yml` stub creation, sync workflow overview
- [x] Step 7 Final Report includes routing/sync configuration status
- [x] Step 5 (Store Configuration) includes a Routing & Sync section in the `.claude/ralph-hero.local.md` template
- [x] Cross-repo setup is deferred to `docs/cross-repo-routing.md` (out of scope for basic setup)

## What We're NOT Doing
- Not creating a separate `/ralph-setup-routing` skill (contradicts the issue's intent)
- Not automating secret/variable creation (GitHub API limitation with classic PATs)
- Not modifying the `configure_routing` MCP tool or any workflows
- Not changing cross-repo docs -- just referencing them
- Not adding new MCP tools or scripts
- Not modifying the routing engine, sync engine, or any workflow YAML files

## Implementation Approach

This is a single-file modification to `plugin/ralph-hero/skills/ralph-setup/SKILL.md`. The changes are organized into three logical groups that must be applied together: (1) a new interactive step for routing/sync enablement, (2) updates to the configuration storage template, and (3) updates to the final report output.

---

## Phase 1: GH-213 - Integrate routing/sync setup steps into ralph-setup breadcrumbs
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/213 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0213-setup-routing-sync-breadcrumbs.md

### Changes Required

#### 1. Add Step 6b: Enable Routing & Sync (Optional)
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Location**: Insert between Step 6 (Verify Setup, ends ~line 340) and Step 7 (Final Report, starts ~line 342)
**Changes**:

Add a new `### Step 6b: Enable Routing & Sync (Optional)` section that follows the existing interactive pattern. The step should:

1. **Ask the user** using `AskUserQuestion`:
   - **Question**: "Would you like to enable automated issue routing and workflow state sync?"
   - **Options**:
     - **"Yes, set it up now"** -- Continue with sub-steps below
     - **"Skip for now"** -- Record `routingEnabled: false` and skip to Step 7
   - **Context to display before asking**:
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

2. **If "Yes"**, guide through three sub-steps:

   **6b-i. ROUTING_PAT Secret**
   Display instructions (cannot be automated):
   ```
   Step 1: Add ROUTING_PAT Secret
   ===============================
   Go to: https://github.com/[owner]/[repo]/settings/secrets/actions
   Click "New repository secret"

   Name:  ROUTING_PAT
   Value: (paste your GitHub PAT -- same token as RALPH_HERO_GITHUB_TOKEN works)

   Required scopes: repo, project
   Note: GITHUB_TOKEN cannot write to Projects V2 -- a PAT is required.
   ```

   Then ask: "Have you added the ROUTING_PAT secret?"
   - **"Yes, it's added"** -- Continue
   - **"I'll do it later"** -- Note as pending, continue to next sub-step

   **6b-ii. Repository Variables (Optional)**
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

   Then ask: "Do you need to set any repository variables?"
   - **"No, defaults are fine"** -- Continue
   - **"Yes, I'll set them now"** -- Display the Settings > Variables URL, wait for confirmation
   - **"I'll configure later"** -- Note as pending, continue

   **6b-iii. Routing Config Stub (Optional)**
   Ask: "Would you like to create a starter `.ralph-routing.yml` config?"
   - **"Yes, create a starter config"** -- Use `ralph_hero__configure_routing(operation: "add_rule", rule: { match: { labels: ["enhancement"] }, action: { workflowState: "Backlog", projectNumber: [project-number] } })` to create a minimal stub, then display:
     ```
     Created .ralph-routing.yml with a starter rule:
     - Issues labeled "enhancement" → Project #[N], Workflow State: Backlog

     Edit this file to add more rules. See docs/cross-repo-routing.md for the full config format.
     ```
   - **"No, I'll create it manually"** -- Display reference to `docs/cross-repo-routing.md`
   - **"Skip routing config"** -- Continue without creating the file

3. **Record routing configuration state** for use in Step 5 and Step 7:
   - `routingEnabled`: true/false
   - `routingPatAdded`: true/false/pending
   - `repoVarsConfigured`: true/false/pending
   - `routingConfigCreated`: true/false

#### 2. Update Step 5: Store Configuration -- Add Routing & Sync Section
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Location**: Within Step 5 (Store Configuration), after the Workflow States table in both the simple and split-owner config templates (after line ~334)
**Changes**:

Add a conditional Routing & Sync section to the `.claude/ralph-hero.local.md` template. Only include this section if `routingEnabled` is true (from Step 6b). Since Step 6b runs after Step 5 in the current ordering, **reorder Steps 5 and 6b** so that 6b runs before Step 5's config write, OR update Step 5 to note that routing config will be appended after Step 6b completes.

**Recommended approach**: Keep step ordering as-is (Step 5 writes initial config, Step 6 verifies, Step 6b asks about routing) and have Step 6b **append** the routing section to the existing `.claude/ralph-hero.local.md` file rather than rewriting it. This avoids reordering steps and keeps the existing flow intact.

The appended section:

```markdown
## Routing & Sync

| Setting | Value |
|---------|-------|
| Routing Enabled | [yes/no] |
| ROUTING_PAT Secret | [added/pending/not configured] |
| Repository Variables | [defaults/custom/pending] |
| Routing Config | [created at .ralph-routing.yml / not created] |

Sync workflows (auto-activate when ROUTING_PAT is set):
- sync-issue-state.yml — Syncs Workflow State on close/reopen
- sync-pr-merge.yml — Advances linked issues on PR merge
- sync-project-state.yml — Cross-project state sync

For cross-repo routing setup, see: docs/cross-repo-routing.md
```

#### 3. Update Step 7: Final Report -- Add Routing & Sync Status
**File**: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
**Location**: Within Step 7 Final Report, after the "Configuration saved to" line, before "Next steps" (both simple and split-owner templates)
**Changes**:

Add a conditional routing/sync section to both report templates:

**If routing was enabled (`routingEnabled: true`):**
```
Routing & Sync:
  - ROUTING_PAT secret: [Added / Pending - add at Settings > Secrets > Actions]
  - Repository variables: [Defaults OK / Custom set / Pending]
  - Routing config: [Created (.ralph-routing.yml) / Not created]
  - Sync workflows: Pre-installed (activate when ROUTING_PAT is set)
```

**If routing was skipped:**
```
Routing & Sync: Skipped (run /ralph-setup again to enable later)
  See docs/cross-repo-routing.md for manual setup
```

Also update the "Next steps" section in both templates to include routing references:

```
Next steps:
1. Verify .claude/settings.local.json has your token and config
2. Restart Claude Code if you changed any env vars
3. [If ROUTING_PAT pending] Add ROUTING_PAT secret: https://github.com/[owner]/[repo]/settings/secrets/actions
4. [If routing config not created] Create .ralph-routing.yml (see docs/cross-repo-routing.md)
5. Run /ralph-triage to start processing issues
```

For users who skipped routing entirely, items 3 and 4 should not appear (keep the existing 3-item list).

### Success Criteria
- [x] Automated: `grep -c "Step 6b" plugin/ralph-hero/skills/ralph-setup/SKILL.md` returns 1
- [x] Automated: `grep -c "ROUTING_PAT" plugin/ralph-hero/skills/ralph-setup/SKILL.md` returns at least 3 (instructions, status display, next steps reference)
- [x] Automated: `grep -c "configure_routing" plugin/ralph-hero/skills/ralph-setup/SKILL.md` returns at least 1
- [x] Automated: `grep -c "cross-repo-routing.md" plugin/ralph-hero/skills/ralph-setup/SKILL.md` returns at least 2
- [x] Manual: The new step follows the `AskUserQuestion` interactive pattern used by Steps 2 and 2b
- [x] Manual: Step 7 Final Report displays routing/sync status for both "enabled" and "skipped" paths
- [x] Manual: The `.claude/ralph-hero.local.md` template includes routing section when enabled
- [x] Manual: No changes to any file other than SKILL.md
- [x] Manual: Cross-repo setup is deferred to docs (not inlined into the skill)

---

## Integration Testing
- [x] Read through the full SKILL.md flow from Step 1 to Step 7 to verify step numbering consistency
- [x] Verify the "Skip for now" path produces a clean final report without routing references cluttering it
- [x] Verify the "Yes, set it up now" path covers all three sub-steps (secret, variables, config stub)
- [x] Verify `configure_routing` tool call uses correct parameter format (operation, rule object, configPath)
- [x] Verify all GitHub Settings URLs use `[owner]/[repo]` placeholders consistently
- [x] Verify the `.claude/ralph-hero.local.md` routing section matches the format of existing sections (table style)

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0213-setup-routing-sync-breadcrumbs.md
- SKILL.md: `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
- Cross-repo docs: `docs/cross-repo-routing.md`
- Routing tools: `plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`
- Sync workflows: `.github/workflows/sync-issue-state.yml`, `.github/workflows/sync-pr-merge.yml`, `.github/workflows/sync-project-state.yml`
- Route workflow: `.github/workflows/route-issues.yml`
