---
date: 2026-04-25
github_issue: 574
github_url: https://github.com/cdubiel08/ralph-hero/issues/574
status: complete
type: research
tags: [skill-audit, onboarding, setup, multi-repo, github-projects]
---

# Setup and Setup-Repos Skills Audit — Onboarding Experience

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit targets individual skills for deep content and eval review. This audit covers `setup` (GitHub Project V2 creation, env config) and `setup-repos` (multi-repo registry bootstrapping), both Tier 3 specialty skills used only at onboarding time. The question is whether a first-time user can successfully reach a working Ralph installation by following these two skills, and whether the skills are robust to interruption, partial state, and multi-repo scenarios.

## Current State Analysis

### setup/SKILL.md

Located at `plugin/ralph-hero/skills/setup/SKILL.md`. Skill metadata:
- `context: fork`, `model: haiku`, no `user-invocable` flag (implicitly user-invocable), argument-hint `[project-number]`
- Allowed tools: `Bash`, `ralph_hero__health_check`, `ralph_hero__get_project`, `ralph_hero__setup_project`
- No branch-gate hook — setup doesn't require a git branch
- No postcondition hook — no structural validation on exit

The skill has a 7-step workflow:
1. Detect install scope (`installed_plugins.json` → `"scope"` field)
2. Ask about project owner (AskUserQuestion) + optional dual-token guidance
3. Create or verify project (via `setup_project` MCP tool)
4. Update field colors/descriptions (via raw GraphQL or GitHub UI)
5. Store config to `.claude/ralph-hero.local.md`
6. Verify setup (health check) + optional routing/sync enablement (3 sub-steps)
7. Final report

### setup-repos/SKILL.md

Located at `plugin/ralph-hero/skills/setup-repos/SKILL.md`. Skill metadata:
- `context: fork`, `model: sonnet`, no `user-invocable` flag, argument-hint `[path-to-output-file]`
- Allowed tools: `Bash`, `Read`, `Write`, `ralph_hero__health_check`, `ralph_hero__pipeline_dashboard`, `ralph_hero__list_issues`, `ralph_hero__decompose_feature`, `ralph_hero__create_issue`
- No branch-gate hook, no postcondition hook

The skill has a 9-step workflow:
1. Confirm target path (AskUserQuestion, handle existing file)
2. Discover linked repos (GraphQL `repositories` query; `user` then `organization` fallback; also pipeline dashboard or issues fallback)
3. Infer domains/tech stacks (name patterns, `gh api repos` languages, filesystem checks)
4. Confirm inferences (AskUserQuestion, edit options)
5. Configure per-repo defaults (labels, estimate, assignees)
6. Define decomposition patterns (optional, guided dialog)
7. Generate and write `.ralph-repos.yml`
8. Verify with MCP tools (`decompose_feature` without pattern)
9. Final summary

## Key Discoveries

### 1. Setup — Workflow State Count Discrepancy (Documentation Gap)

The `setup_project` MCP tool creates **11 workflow states**: Backlog, Research Needed, Research in Progress, Ready for Plan, Plan in Progress, Plan in Review, In Progress, In Review, Done, Human Needed, **Canceled**.

The documentation table in `setup/SKILL.md` (Step 5, "Workflow States" section of the local config) lists only **10 states** — `Canceled` is absent from the table.

This creates a documentation/reality mismatch: users reading `.claude/ralph-hero.local.md` after setup will see an incomplete list of states. It is a minor documentation bug, not a functional one (the field is created correctly).

File: `plugin/ralph-hero/skills/setup/SKILL.md` lines 404–419
File: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` lines 35–83 (WORKFLOW_STATE_OPTIONS)

### 2. Setup — No Idempotency Guard on Project Creation

Step 3 creates a new project unconditionally when `RALPH_GH_PROJECT_NUMBER` is not set or project was inaccessible. There is no guard to check whether a project with the same title already exists for the owner. A user who runs `/ralph-hero:setup` twice (e.g., after a failed first attempt) will create duplicate projects.

The health check in Step 1 catches the case where the project IS accessible with the right project number. But if the user lost track of the project number and re-runs setup, a duplicate is created. No deduplication is present in `setup_project` either — the tool creates a blank project and immediately creates fields on it, with no "does a project named X already exist?" check.

File: `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` lines 319–388

### 3. Setup — Interrupted Setup Recovery

If setup is interrupted after project creation (Step 3) but before config file write (Step 5), the user has a project number they don't know about. Re-running setup will create another project. There is no recovery path in the skill to resume from a known project number.

The `argument-hint` exposes `[project-number]` which suggests the skill can accept an existing project number — but the skill body does not implement this argument. Step 3 only branches on whether `RALPH_GH_PROJECT_NUMBER` is set as an env var, not on whether a project number was passed as an argument. This is a dead feature advertised in the hint.

File: `plugin/ralph-hero/skills/setup/SKILL.md` lines 4, 213–220

### 4. Setup — `.claude/ralph-hero.local.md` Is Not `.gitignore`d Automatically

Step 5 writes `.claude/ralph-hero.local.md` with a comment "Do not commit this file (add to .gitignore)". The skill tells the user to add it to `.gitignore` but does not do it for them. This is a manual step that a first-time user may miss, potentially committing token metadata (though not the raw token value itself) to git.

File: `plugin/ralph-hero/skills/setup/SKILL.md` lines 268–272

### 5. Setup — GitHub Views Are Manual-Only (Documented, But No Auto-Path)

Step 4b correctly documents that the GitHub GraphQL API does not support creating views programmatically and instructs the user to create two views manually (Ralph Table, Ralph Kanban). This is an accurate limitation. However, there is no validation step to confirm the user completed this. The final report lists views as "create manually" without checking if they were created. This is an acceptable limitation but should be noted as a gap in the verification loop.

File: `plugin/ralph-hero/skills/setup/SKILL.md` lines 242–263

### 6. Setup — Repository Variables Table Has Hardcoded Values

Step 6b-ii shows a table of repository variables with hardcoded defaults:
- `RALPH_PROJECT_OWNER` defaults to `cdubiel08`
- `RALPH_PROJECT_NUMBER` defaults to `3`

These are the maintainer's own values, left in as example defaults. Any user following this step will see the wrong defaults for their setup. This is a template pollution bug.

File: `plugin/ralph-hero/skills/setup/SKILL.md` lines 487–497

### 7. Setup — Scope Detection Step Races Ahead of Token/Config Validation

Step 1b (detect install scope) runs before the health check in Step 1. If the skill runs in the wrong working directory or outside a project directory for a project-scoped install, the scope detection may write config to the wrong path (falls back to `settings.local.json`). The skill does warn about this fallback but the logic is: read `installed_plugins.json`, check `scope` field — if the file is missing or the entry is absent, fall back. The health check in Step 1 is listed first in the workflow numbering but Step 1b is described as happening "before writing configuration."

The practical risk: a user who runs setup from a temporary directory may write their env vars to the wrong location.

File: `plugin/ralph-hero/skills/setup/SKILL.md` lines 31–50

### 8. Setup — Description Triggering (XS Estimate Context)

The description: "One-time setup for Ralph GitHub workflow - creates GitHub Project V2 with required custom fields, workflow states, priorities, estimates, and configuration. Use when setting up a new repository for Ralph, configuring GitHub Projects, or troubleshooting missing workflow states."

This is precise and accurate. The use-case hints ("setting up a new repository", "troubleshooting missing workflow states") are effective trigger phrases. No mismatch between description and behavior. The `user-invocable` field is absent (defaults to true for setup-class skills). XS estimate is appropriate — the skill is 700 lines of SKILL.md but the implementation surface is bounded: one project creation call, one config file write.

### 9. Setup-Repos — GraphQL Query Uses Owner As User/Org Fallback

Step 2 shows two explicit GraphQL queries — first `user(login: $owner)`, then `organization(login: $owner)` — for discovering linked repos. This is the correct pattern (matching `project-tools.ts`). The fallback to `pipeline_dashboard` or `list_issues` if the GraphQL enumeration fails is a good defensive layer.

However, the `ralph_hero__pipeline_dashboard` tool is in `allowed-tools` but the skill falls back to it only if the GraphQL `repositories` query fails. The dashboard returns issues grouped by repo, not repos themselves — so this fallback is approximate and may miss repos with zero issues in the project.

File: `plugin/ralph-hero/skills/setup-repos/SKILL.md` lines 63–108

### 10. Setup-Repos — Verification Step Uses Undocumented Side-Channel

Step 8 verifies the registry by calling `decompose_feature` without a `pattern` parameter. The `decompose_feature` tool does return available patterns and repos when no pattern is specified — this is documented behavior in the tool's description. However, the `ralph-research` SKILL.md explicitly warns against this pattern:

> "Why `Read` instead of `decompose_feature`? The research skill has `Read` in its `allowed-tools` and can parse YAML from the file contents directly. Using `decompose_feature` with no `pattern` is an undocumented side-channel."

The setup-repos skill does this same side-channel call (Step 8) as its verification step. The problem: `decompose_feature` reads the registry from memory at MCP server startup — it does NOT re-read the file written in Step 7. So the verification will report "no patterns" even if the file was written successfully, until Claude Code is restarted. The skill correctly handles this by displaying a "restart Claude Code" message in Step 8 if patterns aren't found. But calling it "verification" is misleading — it verifies the old (pre-write) registry state.

File: `plugin/ralph-hero/skills/setup-repos/SKILL.md` lines 338–356
File: `plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts` lines 222–247

### 11. Setup-Repos — `localDir` Detection Incomplete

Step 2b detects local checkout paths by checking `$HOME/projects/$repo`, `$HOME/$repo`, and `$(pwd)/../$repo`. This only handles simple single-word repo names. For orgs with namespace prefixes (e.g., `my-org/frontend`), the loop variable `$repo` in the shown bash snippet holds the short name `frontend` — the code works for short names. But if the repo is checked out at a path like `~/projects/work/frontend`, it won't be found.

The fallback is to prompt the user, which is correct, but the auto-detection will miss common checkout patterns (e.g., nested org directories).

File: `plugin/ralph-hero/skills/setup-repos/SKILL.md` lines 111–129

### 12. Setup-Repos — No Existing File Merge Logic Implemented

Step 1 offers a "Merge new repos into it" option when a file already exists. The workflow says "Continue, preserve existing entries, add new ones" — but Step 7 (Generate and Write File) assembles the YAML purely from the gathered data in the current session. There is no implementation of the merge logic; the skill would overwrite the existing file with only the newly discovered repos, silently losing any manually added entries or custom patterns that were not re-discovered in this session.

This is a significant data-loss risk for users who have refined their `.ralph-repos.yml` over time.

File: `plugin/ralph-hero/skills/setup-repos/SKILL.md` lines 53–57, 295–321

### 13. Setup-Repos — Description Triggering

The description: "Bootstrap .ralph-repos.yml by analyzing repositories linked to your GitHub Project. Detects repo domains and tech stacks, generates a starter registry, and optionally creates decomposition patterns. Use when setting up multi-repo portfolio management or adding new repos to an existing registry."

This is accurate and specific. "Adding new repos to an existing registry" is a correct trigger phrase but the merge implementation gap (finding #12) makes the second use case risky. XS estimate is appropriate for a bounded interactive setup session.

### 14. Anti-Pattern: Both Skills Lack Recovery Documentation

Neither skill documents what to do if the skill is interrupted partway through. Specifically:
- `setup`: If interrupted after project creation (Step 3), the user has a dangling project with no local config. No recovery path is documented.
- `setup-repos`: If interrupted after file write but before verification, the user has an unvalidated `.ralph-repos.yml`. Since MCP server hasn't restarted, any tool calls that rely on the registry will use stale state.

## Failure Modes and Recovery

| Failure Point | Result | Recovery |
|---|---|---|
| `setup` interrupted after Step 3 (project created) | Dangling project, no config written | Manual: find project number in GitHub UI, set env var, re-run setup |
| `setup` re-run without clearing env var | Creates duplicate project | Manual: delete duplicate in GitHub UI |
| `setup-repos` interrupted mid-session | Partial file or no file | Safe to re-run; no side effects until Step 7 |
| `setup-repos` re-run with "Merge" option | Overwrites file, loses custom entries | Manual: git restore or re-enter custom entries |
| Registry written but MCP not restarted | `decompose_feature` sees old state | Restart Claude Code |
| `setup_project` called with wrong `owner` | Project created under wrong account | Manual: delete and re-run |

## Recommended Next Steps

1. **Fix Canceled state in documentation table** — Add `Canceled` row to the Workflow States table in `setup/SKILL.md`. Low effort, zero risk.

2. **Fix hardcoded defaults in routing config table** — Replace `cdubiel08` and `3` with `[YOUR_PROJECT_OWNER]` and `[YOUR_PROJECT_NUMBER]` template placeholders in Step 6b-ii.

3. **Implement argument-hint recovery path** — The `[project-number]` argument-hint implies the skill can accept an existing project number. Implement this: if a number is provided as argument, skip project creation and go straight to Step 3 verification with that number.

4. **Add `.gitignore` automation** — In Step 5, after writing `.claude/ralph-hero.local.md`, check if `.gitignore` exists and whether the path is already in it. If not, append it. This prevents accidental commit.

5. **Fix merge logic in setup-repos** — If "Merge" is chosen in Step 1, the skill must read the existing YAML, parse it, and merge by repo key before writing. New repo keys are added; existing keys are preserved unless overridden by user input.

6. **Add interruption guidance** — Both skills should document a recovery header (e.g., "If interrupted: run `/ralph-hero:setup [existing-project-number]`") at the top of the skill.

7. **Clarify Step 8 in setup-repos** — Rename to "Note on registry load" rather than "Verify with MCP Tools" and set accurate expectation that verification requires a restart.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/setup/SKILL.md` - Fix Canceled state table, fix hardcoded routing defaults, implement argument-hint project-number path, add .gitignore automation step, add recovery guidance
- `plugin/ralph-hero/skills/setup-repos/SKILL.md` - Fix merge logic implementation, clarify Step 8 framing, add recovery guidance

### Will Read (Dependencies)
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts` - WORKFLOW_STATE_OPTIONS source of truth for state count
- `plugin/ralph-hero/mcp-server/src/tools/decompose-tools.ts` - decompose_feature no-pattern behavior
- `plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts` - Registry schema and merge semantics
- `plugin/ralph-hero/mcp-server/src/lib/registry-loader.ts` - Load-at-startup behavior (explains why verification requires restart)
- `plugin/ralph-hero/mcp-server/src/index.ts` - Registry loading lifecycle
