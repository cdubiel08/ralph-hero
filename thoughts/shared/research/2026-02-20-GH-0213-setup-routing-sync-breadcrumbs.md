---
date: 2026-02-20
github_issue: 213
github_url: https://github.com/cdubiel08/ralph-hero/issues/213
status: complete
type: research
---

# GH-213: Integrate Routing/Sync Setup Steps into ralph-setup Breadcrumbs

## Problem Statement

The `ralph-setup` skill (`plugin/ralph-hero/skills/ralph-setup/SKILL.md`) guides users through initial project configuration (token, project creation, custom fields, views) but has no awareness of the routing and sync infrastructure shipped as part of epic #99. After completing `/ralph-setup`, users have a working Ralph project but no guidance on enabling:

1. **Issue routing** -- automatically adding issues/PRs to the project based on labels
2. **Workflow State sync** -- keeping the custom Workflow State field in sync when issues are closed/reopened, PRs are merged, or state changes occur across multiple projects

Users must discover `docs/cross-repo-routing.md` independently and manually configure secrets, repository variables, routing config, and caller workflows.

## Current State Analysis

### ralph-setup SKILL.md (Step 7 -- Final Report)

The final "Next steps" section at [plugin/ralph-hero/skills/ralph-setup/SKILL.md:363-368](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-setup/SKILL.md#L363-L368) currently lists only:

```
1. Verify .claude/settings.local.json has your token and config
2. Restart Claude Code if you changed any env vars
3. Run /ralph-triage to start processing issues
```

No mention of `ROUTING_PAT`, `.ralph-routing.yml`, repository variables, or any sync workflow.

### Routing/Sync Infrastructure (Shipped)

The following components are fully shipped and operational:

| Component | Path | Purpose |
|-----------|------|---------|
| Route Issues workflow | [`.github/workflows/route-issues.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/route-issues.yml) | Routes issues/PRs to project based on label matching rules |
| Sync Issue State workflow | [`.github/workflows/sync-issue-state.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/sync-issue-state.yml) | Syncs Workflow State on close/reopen |
| Sync PR Merge workflow | [`.github/workflows/sync-pr-merge.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/sync-pr-merge.yml) | Advances linked issues on PR merge |
| Sync Project State workflow | [`.github/workflows/sync-project-state.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/sync-project-state.yml) | Cross-project Workflow State sync |
| Routing script | [`scripts/routing/route.js`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/routing/route.js) | Node.js routing engine used by route-issues.yml |
| Sync script | [`.github/scripts/sync/sync-project-state.js`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/scripts/sync/sync-project-state.js) | Node.js sync engine for cross-project state |
| Cross-repo docs | [`docs/cross-repo-routing.md`](https://github.com/cdubiel08/ralph-hero/blob/main/docs/cross-repo-routing.md) | Full routing setup guide |
| configure_routing MCP tool | [`plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/routing-tools.ts) | CRUD + validate + dry_run for .ralph-routing.yml |

### Secrets and Variables Required

**Secret (required by ALL four workflows):**
| Secret | Scope | Description |
|--------|-------|-------------|
| `ROUTING_PAT` | Repository | GitHub PAT with `repo` + `project` scopes. `GITHUB_TOKEN` cannot write to Projects V2. |

**Repository Variables (optional, with defaults):**
| Variable | Used By | Default | Description |
|----------|---------|---------|-------------|
| `RALPH_PROJECT_OWNER` | sync-issue-state, sync-pr-merge, sync-project-state | `cdubiel08` | Project owner for sync workflows |
| `RALPH_PROJECT_NUMBER` | sync-issue-state, sync-pr-merge | `3` | Project number for sync workflows |
| `ROUTING_DEFAULT_PROJECT` | route-issues | (none) | Fallback project number when no routing rules match |
| `SYNC_PROJECT_FILTER` | sync-project-state | (none) | Comma-separated project numbers to sync (allow-list) |

### No `.ralph-routing.yml` Stub Exists

Confirmed via glob search: there is no `.ralph-routing.yml` file in the repository root. The routing workflow degrades gracefully (returns empty matched rules), but having a stub with documented structure would help users get started.

## Key Discoveries

1. **The gap is exclusively in SKILL.md text** -- no code changes, no new tools, no new workflows needed. All infrastructure is shipped and operational.

2. **Two distinct audiences**:
   - **Same-repo users** (using ralph-hero directly): Need `ROUTING_PAT` secret + repo variables + `.ralph-routing.yml` stub. Workflows are already in `.github/workflows/`.
   - **Cross-repo users** (calling reusable workflows from another repo): Need `ROUTING_PAT` secret + caller workflow YAML + `.ralph-routing.yml`. Documented in `docs/cross-repo-routing.md`.

3. **The setup skill is interactive** (uses `AskUserQuestion`), so routing/sync steps should follow the same pattern -- ask whether the user wants to enable routing, then guide through the appropriate steps.

4. **The `configure_routing` MCP tool already exists** and supports `add_rule` and `validate_rules` operations. The setup skill could use it to create the initial `.ralph-routing.yml` stub interactively.

5. **Sync workflows are "set and forget"** -- once `ROUTING_PAT` is configured as a repository secret and the optional repo variables are set, the sync workflows (sync-issue-state, sync-pr-merge, sync-project-state) work automatically with no additional configuration for same-repo usage.

6. **Token reuse opportunity**: The `ROUTING_PAT` secret typically uses the same token as `RALPH_HERO_GITHUB_TOKEN` (both need `repo` + `project` scopes). The setup step should mention this explicitly to avoid confusion.

## Potential Approaches

### Approach A: Append to Step 7 "Next Steps" (Minimal)

Add routing/sync breadcrumbs as additional numbered items in the existing "Next steps" section:

```
4. (Optional) Enable issue routing: Add ROUTING_PAT secret, create .ralph-routing.yml
5. (Optional) Configure sync: Set RALPH_PROJECT_OWNER and RALPH_PROJECT_NUMBER repo variables
6. See docs/cross-repo-routing.md for cross-repo setup
```

**Pros**: Minimal SKILL.md change, non-breaking, quick to implement.
**Cons**: Users may skip them, no interactive guidance, no `.ralph-routing.yml` creation.

### Approach B: New Step 7b "Enable Routing & Sync" (Recommended)

Insert a new interactive step between the current Step 6 (Verify Setup) and Step 7 (Final Report) that:

1. Asks the user: "Would you like to enable issue routing and workflow sync?" (Yes / Skip for now)
2. If yes, guides through:
   - Adding `ROUTING_PAT` secret (can reuse same PAT from Step 1)
   - Setting repository variables (RALPH_PROJECT_OWNER, RALPH_PROJECT_NUMBER) if they differ from defaults
   - Optionally creating a `.ralph-routing.yml` stub using `configure_routing(operation: "add_rule")`
   - Mentioning sync workflows are pre-configured and will activate once the secret exists
3. Updates Step 7 Final Report to include routing/sync status

**Pros**: Interactive like the rest of the skill, creates actionable config, follows existing skill patterns.
**Cons**: Slightly more complex SKILL.md changes, adds ~40-60 lines.

### Approach C: Separate `/ralph-setup-routing` Skill

Create a new skill focused solely on routing/sync configuration.

**Pros**: Clean separation of concerns, can be run independently after initial setup.
**Cons**: Contradicts the issue's intent (integrate INTO ralph-setup breadcrumbs), users must discover a second skill.

## Risks

1. **Secret creation cannot be automated** -- GitHub does not allow creating repository secrets via API with a classic PAT. The user must manually navigate to Settings > Secrets > Actions. The skill can only display instructions.

2. **Repository variables also require manual creation** -- Same limitation as secrets. The skill can display the variable names and values but cannot set them programmatically.

3. **`.ralph-routing.yml` can be created via MCP tool** -- The `configure_routing` tool writes to the filesystem, so the skill could use it to create the initial stub. However, this creates the file in the MCP server's working directory, which may differ from the repo root depending on how Claude Code resolves paths.

4. **Hardcoded defaults in workflows** -- The sync workflows default to `cdubiel08` and project `3`. For other users, repository variables MUST be set, otherwise the workflows will target the wrong project. This should be highlighted.

## Recommended Next Steps

1. **Implement Approach B** -- Add a new interactive step between Steps 6 and 7 in `plugin/ralph-hero/skills/ralph-setup/SKILL.md`
2. **Structure the new step as**:
   - Ask whether to enable routing/sync (optional, skippable)
   - `ROUTING_PAT` secret reminder (can reuse existing token)
   - Repository variables guidance (RALPH_PROJECT_OWNER, RALPH_PROJECT_NUMBER)
   - Optional `.ralph-routing.yml` stub creation
   - Sync workflows overview (no config needed beyond the secret)
3. **Update Step 7 Final Report** to include routing/sync configuration status in the output
4. **Update the stored configuration file** (Step 5's `.claude/ralph-hero.local.md`) to include a Routing & Sync section documenting the configured state
5. **Reference `docs/cross-repo-routing.md`** for users who need cross-repo setup (out of scope for the basic setup flow)
