---
date: 2026-02-20
github_issue: 160
github_url: https://github.com/cdubiel08/ralph-hero/issues/160
status: complete
type: research
---

# GH-160: Create Golden Project with Fields and Built-in Automations

## Problem Statement

Ralph-managed projects need a consistent set of custom fields (Workflow State, Priority, Estimate) and built-in automations. The `setup_project` tool creates projects programmatically, but there's no reference "golden" project that serves as the canonical template for `copyProjectV2` (GH-101, GH-162). This issue creates that golden project manually with all required fields and automation configuration.

## Current State Analysis

### `setup_project` Already Creates Fields

[`project-tools.ts:168-304`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L168) creates a new project with three custom single-select fields:

**Workflow State** ([`project-tools.ts:33-81`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L33), 11 options):

| Option | Color | Description |
|--------|-------|-------------|
| Backlog | GRAY | Awaiting triage |
| Research Needed | PURPLE | Needs investigation before planning |
| Research in Progress | PURPLE | Investigation underway (locked) |
| Ready for Plan | BLUE | Research complete, ready for planning |
| Plan in Progress | BLUE | Plan being written (locked) |
| Plan in Review | BLUE | Plan awaiting approval |
| In Progress | ORANGE | Implementation underway |
| In Review | YELLOW | PR created, awaiting code review |
| Done | GREEN | Completed and merged |
| Human Needed | RED | Escalated - requires human intervention |
| Canceled | GRAY | Ticket canceled or superseded |

**Priority** ([`project-tools.ts:83-92`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L83), 4 options): P0 (RED), P1 (ORANGE), P2 (YELLOW), P3 (GRAY)

**Estimate** ([`project-tools.ts:94-100`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/project-tools.ts#L94), 5 options): XS (BLUE), S (GREEN), M (YELLOW), L (ORANGE), XL (RED)

### What `setup_project` Does NOT Do

- Does not configure built-in automations (API limitation — UI-only)
- Does not create views (board, table, roadmap — API limitation)
- Does not set project description, README, or visibility
- Does not link repositories
- Does not configure the built-in Status field options

### Built-in Automation Guidance (GH-66)

The [GH-66 guidance document](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-18-GH-0066-github-projects-v2-docs-guidance.md) recommends:

| Automation | Recommendation | Rationale |
|------------|---------------|-----------|
| Auto-close issues when Status = Done | **Enable** | When Ralph moves to Done/Canceled, Status syncs to "Done", triggering auto-close |
| Auto-set Status when issue closed | **Disable** | Creates feedback loop if issues are closed manually |
| Auto-add to project on issue creation | **Disable** (default) | Only enable if you want ALL new issues added; prefer selective `create_issue`/`add_to_project` |
| Auto-set Status when PR merged | **Safe either way** | Harmless but redundant since Ralph manages Workflow State independently |

### No `copyProjectV2` Tool Exists Yet

No `copy_project` tool exists in the codebase. GH-101 researched the `copyProjectV2` mutation and GH-162 plans to implement it. The golden project created by this issue becomes the source template for that tool.

## Key Discoveries

### 1. This Is Primarily a Manual/UI Task

Creating the golden project's fields can be done via `setup_project`, but configuring automations and views requires the GitHub UI. The research phase for this issue is about documenting what to create, not discovering code patterns.

### 2. Recommended Golden Project Configuration

**Step 1 — Create via MCP tool:**
```
ralph_hero__setup_project(owner: "cdubiel08", title: "Ralph Golden Template")
```
This creates the project with all 3 custom fields and 20 total options.

**Step 2 — Set project metadata via MCP tool:**
```
ralph_hero__update_project(
  shortDescription: "Golden template for Ralph-managed projects. Do not add issues directly.",
  readme: "# Ralph Golden Template\n\nThis project serves as the canonical template...",
  public: false
)
```

**Step 3 — Configure automations (UI-only):**
- Enable: "Auto-close issue" when Status = Done
- Disable: "Auto-set Status when issue closed"
- Disable: "Auto-add to project"
- Leave default: "Auto-set Status when PR merged" (optional)

**Step 4 — Record project number** in `CLAUDE.md` and `.mcp.json` defaults for `copyProjectV2` source.

### 3. Views Are Out of Scope (Sibling #161)

Views configuration is handled by #161 ("Configure 7 pre-defined views and document golden project template"). This issue focuses only on fields + automations.

### 4. Group Context

Parent #110 has 2 children:
1. **#160** — Fields + automations (this issue) — no dependencies
2. **#161** — Views + documentation — blocked by #160

Related cross-group:
- **#101** — `copy_project` MCP tool (uses golden project as source)
- **#162** — `copyProjectV2` mutation in `setup_project` (uses golden project as template)
- **#111** — Enhance `setup_project` with copy-from-template mode

### 5. Idempotency Consideration

If the golden project already exists on cdubiel08's account, `setup_project` should NOT be called again (it creates a new project each time). The implementer should first check if a "Ralph Golden Template" project exists.

## Potential Approaches

### Approach A: MCP Tool + Manual UI (Recommended)

Use `setup_project` for fields, then configure automations manually in GitHub UI.

**Pros:** Fastest path, leverages existing tool, automations are simple checkbox toggles.
**Cons:** Automation config not reproducible via code; must be documented for others.

### Approach B: Fully Manual

Create everything in the GitHub UI manually.

**Pros:** One-stop setup, can see all options.
**Cons:** Error-prone for 20 field options, doesn't validate against `WORKFLOW_STATE_OPTIONS` constants.

### Recommendation: Approach A

Use `setup_project` to ensure field names/colors/descriptions exactly match the codebase constants, then manually toggle 3 automation checkboxes in the UI.

## Risks

1. **Automation config drift**: If automation recommendations change, the golden project must be updated manually. Document the expected automation state in CLAUDE.md.
2. **Project number stability**: The golden project's number must be recorded and not change. If the project is deleted and recreated, all references break.
3. **Visibility**: If set to private, `copyProjectV2` may fail for users who lack access. Consider making it public (read-only) or documenting the access requirement.

## Recommended Next Steps

1. Check if "Ralph Golden Template" project already exists on cdubiel08 account
2. If not, run `setup_project(owner: "cdubiel08", title: "Ralph Golden Template")`
3. Run `update_project` to set description and README
4. Configure 3 automation toggles in GitHub UI per GH-66 guidance
5. Record project number in issue comment and CLAUDE.md
6. Set dependency: #161 blocked by #160
