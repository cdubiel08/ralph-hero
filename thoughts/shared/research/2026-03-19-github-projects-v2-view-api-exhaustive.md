---
date: 2026-03-19
topic: "GitHub Projects V2 API — Exhaustive View Management Research"
tags: [research, github-api, projects-v2, views, graphql, rest-api]
status: complete
type: research
git_commit: f03ace1844b662086d18d6fc45448b1cbdb64ade
github_issue: 615
github_url: https://github.com/cdubiel08/ralph-hero/issues/615
---

# Research: GitHub Projects V2 API — Exhaustive View Management

## Prior Work

- builds_on:: [[2026-02-18-GH-0066-github-projects-v2-docs-guidance]]
- builds_on:: [[2026-02-18-GH-0064-github-projects-v2-api-automation]]
- builds_on:: [[2026-02-20-GH-0161-golden-project-views-documentation]]
- builds_on:: [[2026-02-20-GH-0162-copy-project-v2-setup-project]]
- builds_on:: [[2026-02-20-GH-0101-copy-project-mcp-tool]]
- builds_on:: [[view-recipes]]
- builds_on:: [[golden-project-views]]

## Research Question

Can GitHub Projects V2 views be created or copied programmatically via any API (GraphQL or REST)? Was the prior "it's impossible" conclusion complete? Is there a REST POST endpoint for view creation?

## Summary

The GitHub Projects V2 API is **asymmetric for views**: reading is fully supported via GraphQL; creating is partially supported via REST (name + layout + filter, but no sort/group configuration); updating and deleting are entirely absent from both APIs. The only way to programmatically deploy a fully-configured view set is via the `copyProjectV2` GraphQL mutation, which copies an entire project (including all its views). This is the approach the ralph-hero codebase already implements via the `templateProjectNumber` parameter in `setup_project`.

**The key gap for the current problem** (adding views to an existing project #7): `copyProjectV2` creates a NEW project — it cannot retroactively add views to an existing one. However, the REST POST endpoint can create views with name, layout, and filter string, which covers the most critical configuration for the 6 views from project #3.

## Detailed Findings

### GraphQL API — No View Mutations Exist

The official [GraphQL mutations reference](https://docs.github.com/en/graphql/reference/mutations) lists all `ProjectV2`-prefixed mutations. **None relate to views.** The complete list:

- `addProjectV2DraftIssue`, `addProjectV2ItemById`
- `archiveProjectV2Item` / `unarchiveProjectV2Item`
- `clearProjectV2ItemFieldValue`
- `copyProjectV2` ← copies entire project including views
- `createProjectV2` / `deleteProjectV2`
- `createProjectV2Field` / `deleteProjectV2Field`
- `createProjectV2IssueField`
- `createProjectV2StatusUpdate` / `deleteProjectV2StatusUpdate`
- `deleteProjectV2Item`, `deleteProjectV2Workflow`
- `linkProjectV2ToRepository` / `unlinkProjectV2FromRepository`
- `linkProjectV2ToTeam` / `unlinkProjectV2FromTeam`
- `markProjectV2AsTemplate` / `unmarkProjectV2AsTemplate`
- `updateProjectV2`, `updateProjectV2ItemFieldValue`, `updateProjectV2ItemPosition`

`createProjectV2View`, `updateProjectV2View`, `deleteProjectV2View`, `copyProjectV2View` — **none of these exist**. The [input objects reference](https://docs.github.com/en/graphql/reference/input-objects) similarly has no view-related input types.

A [Community Discussion #153532](https://github.com/orgs/community/discussions/153532) noted that GitHub Copilot autocompletes `createProjectV2View` — this is a hallucination based on the naming pattern from `createProjectV2Field`. The mutation does not execute.

### REST API — Create-Only View Endpoints (Significant Finding)

The [REST API reference for Project views](https://docs.github.com/en/enterprise-cloud@latest/rest/projects/views) (documented under Enterprise Cloud, likely available broadly) exposes **two POST endpoints**:

| Method | Path |
|--------|------|
| `POST` | `/orgs/{org}/projectsV2/{project_number}/views` |
| `POST` | `/users/{user_id}/projectsV2/{project_number}/views` |

**Parameters:**
- `name` (string, required)
- `layout` (string, required): `table`, `board`, or `roadmap`
- `filter` (string, optional): filter query string
- `visible_fields` (array of integers, optional): field IDs to show (not valid for roadmap)

**Returns**: HTTP 201 with view object including `id`, `name`, `layout`, `creator`, timestamps.

**What is NOT available via this endpoint:**
- `sortBy` configuration
- `groupBy` configuration
- `GET` (list views) or `GET` (single view)
- `PATCH` (update view)
- `DELETE` (delete view)

This REST endpoint was announced in the [January 2026 Hierarchy View changelog](https://github.blog/changelog/2026-01-15-hierarchy-view-now-available-in-github-projects/).

### `copyProjectV2` — The Whole-Project Copy Workaround

The `copyProjectV2` GraphQL mutation (also available as `gh project copy` CLI) copies an entire project including:
- ✅ All views (with their names, layouts, filter strings, sort/group configuration)
- ✅ Custom fields
- ✅ Draft issues and their field values
- ✅ Workflows (except auto-add)
- ✅ Insights

Does NOT copy:
- ❌ Actual issues/PRs (items)
- ❌ Collaborators
- ❌ Team links
- ❌ Repository links (requires separate `linkProjectV2ToRepository`)

**Limitation**: Creates a NEW project. Cannot add views to an existing project.

### How Ralph-Hero Already Implements This

The `setup_project` tool in `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts:182` has a `templateProjectNumber` parameter that triggers `copyProjectV2` instead of creating a blank project. This is the pattern: maintain a "golden project" with all views pre-configured, then copy it for new projects.

The golden project workflow is documented in:
- `thoughts/shared/research/golden-project-views.md` — step-by-step manual view setup instructions
- `thoughts/shared/research/view-recipes.md` — comprehensive view recipe library

### Codebase State — Views Are Read-Only

In `plugin/ralph-hero/mcp-server/src/types.ts:170-196`:
- `ProjectV2ViewLayout` type is defined (`BOARD_LAYOUT`, `TABLE_LAYOUT`, `ROADMAP_LAYOUT`)
- `ProjectV2View` interface is defined (`id`, `name`, `number`, `layout`, `filter`)
- `views: Connection<ProjectV2View>` exists in the `ProjectV2` interface

However, **no GraphQL queries currently fetch the `views` field** — the type exists in the schema but is not queried by any tool today.

### Feature Requests — Unanswered

[Community Discussion #150130](https://github.com/orgs/community/discussions/150130) — "ProjectsV2: Manage Project Views via GraphQL" — explicitly requests `create|update|delete ProjectV2View` mutations. **Closed as inactive with no official GitHub response.**

## Direct Answers

| Question | Answer |
|----------|--------|
| `createProjectV2View` GraphQL mutation exists? | **No** — not in schema. Copilot hallucination only. |
| `copyProjectV2View` GraphQL mutation exists? | **No** — does not exist. |
| REST API for creating views? | **Yes** — POST `/orgs/{org}/projectsV2/{N}/views` and `/users/{user_id}/projectsV2/{N}/views` |
| REST supports filter strings? | **Yes** — `filter` parameter accepted on POST |
| REST supports sort/group config? | **No** — only name, layout, filter, visible_fields |
| Can read existing views via GraphQL? | **Yes** — `project.views { nodes { id name layout filter } }` is fully queryable |
| `copyProjectV2` copies views? | **Yes** — but creates a whole new project |
| Can add views to existing project programmatically? | **Partially** — REST POST creates views with name/layout/filter, not full config |

## Practical Implication for Project #7

Since project #7 already exists with correct fields, `copyProjectV2` is not applicable. The REST POST endpoint can be used to recreate the 6 views from project #3 with their names, layouts, and filter strings. Sort/group configuration would need manual UI adjustment after API creation, but the filter strings (most critical for routing issues to correct views) are fully automatable.

## Code References

- `plugin/ralph-hero/mcp-server/src/types.ts:170-196` — `ProjectV2View` type definitions
- `plugin/ralph-hero/mcp-server/src/tools/project-tools.ts:182` — `templateProjectNumber` in `setup_project`

## External Links

- [Mutations — GitHub Docs](https://docs.github.com/en/graphql/reference/mutations)
- [REST API endpoints for Project views](https://docs.github.com/en/enterprise-cloud@latest/rest/projects/views)
- [Copying an existing project — GitHub Docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/creating-projects/copying-an-existing-project)
- [gh project copy — CLI Manual](https://cli.github.com/manual/gh_project_copy)
- [Community Discussion #153532 — "Does GitHub's Projects V2 API have any ProjectV2View-related mutations?"](https://github.com/orgs/community/discussions/153532)
- [Community Discussion #150130 — "ProjectsV2: Manage Project Views via GraphQL"](https://github.com/orgs/community/discussions/150130)
- [January 2026 Hierarchy View Changelog](https://github.blog/changelog/2026-01-15-hierarchy-view-now-available-in-github-projects/)
- [September 2025 REST API for GitHub Projects Changelog](https://github.blog/changelog/2025-09-11-a-rest-api-for-github-projects-sub-issues-improvements-and-more/)
