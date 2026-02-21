---
date: 2026-02-20
github_issue: 101
github_url: https://github.com/cdubiel08/ralph-hero/issues/101
status: complete
type: research
---

# GH-101: Add `copy_project` MCP Tool -- Duplicate Project from Template

## Problem Statement

Ralph-hero currently supports creating new projects from scratch via `setup_project`, which generates a blank project and adds custom fields (Workflow State, Priority, Estimate). However, there is no way to duplicate an existing project to preserve pre-configured views, field layouts, workflows (except auto-add), and insights. Teams that have invested in crafting a "golden" project board layout must manually recreate this configuration for each new project.

Issue #101 requests a standalone `copy_project` MCP tool wrapping the `copyProjectV2` GraphQL mutation, enabling project duplication from templates.

## Current State Analysis

### Existing Project Tools

The MCP server registers tools across several modules:

1. **`project-tools.ts`** (line 160-549): `setup_project`, `get_project`, `list_project_items`
2. **`project-management-tools.ts`** (line 24-393): `archive_item`, `remove_from_project`, `add_to_project`, `link_repository`, `clear_field`
3. **`index.ts`** (line 286-306): All tool modules registered in `main()`

The `setup_project` tool (project-tools.ts:168-303) is the most closely related. It:
- Resolves an owner node ID (tries user, then organization)
- Creates a blank project via `createProjectV2`
- Adds three custom single-select fields (Workflow State, Priority, Estimate)
- Populates the field cache for the new project
- Returns project id, number, url, title, and field results

### GraphQL API: `copyProjectV2` Mutation

Confirmed via schema introspection:

**Input (`CopyProjectV2Input`)**:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `projectId` | ID | Yes | The ID of the source project to copy |
| `ownerId` | ID | Yes | The owner ID of the new project (user or org node ID) |
| `title` | String | Yes | The title of the new project |
| `includeDraftIssues` | Boolean | No | Include draft issues in the new project (default: false) |
| `clientMutationId` | String | No | Standard mutation client ID |

**Payload (`CopyProjectV2Payload`)**:
- `projectV2`: Full `ProjectV2` object (id, title, number, url, fields, views, etc.)
- `clientMutationId`: Echo of client mutation ID

**What gets copied**:
- Views (board, table, roadmap layouts with configurations)
- Custom fields (all field definitions and their options)
- Workflows (built-in automations except auto-add)
- Insights

**What does NOT get copied**:
- Items (issues, PRs, draft issues -- unless `includeDraftIssues: true` for drafts)
- Collaborators
- Team links
- Repository links

### Related Mutations

Two related mutations exist for template management:
- `markProjectV2AsTemplate(input: { projectId: ID! })` -- marks a project as a template
- `unmarkProjectV2AsTemplate(input: { projectId: ID! })` -- removes the template mark

The `ProjectV2` type has a `template: Boolean!` field indicating whether a project is marked as a template. Note that `copyProjectV2` does NOT require the source to be marked as a template -- any project can be copied.

### Relationship to Issue #111

Issue #111 ("Enhance `setup_project` to support copy-from-template mode") plans to add a `templateProjectNumber` parameter to `setup_project`. That enhancement would use `copy_project` (#101) as the underlying mechanism. The dependency order is:
1. #101: Standalone `copy_project` tool (this issue)
2. #111: Enhanced `setup_project` that optionally delegates to `copy_project`

This means #101 should be implemented first and #111 should depend on it.

### Owner Resolution Pattern

The existing `setup_project` tool (project-tools.ts:186-217) resolves owner node IDs by trying user first, then organization:

```typescript
// Try user first
const userResult = await client.query<{ user: { id: string } | null }>(...);
ownerId = userResult.user?.id;

// If not user, try org
if (!ownerId) {
  const orgResult = await client.query<{ organization: { id: string } | null }>(...);
  ownerId = orgResult.organization?.id;
}
```

The `copy_project` tool will need the same pattern for resolving the target `ownerId`. It also needs to resolve the source project's node ID from a project number.

### Source Project Resolution

To resolve a source project ID from a project number, we need to query the project. The `fetchProject` helper in `project-tools.ts` (line 584-682) already does this -- it tries user then org and returns the project with its ID. However, this helper is module-private (not exported). The `helpers.ts` module has `fetchProjectForCache()` which is also internal.

For `copy_project`, we need the source project's node ID. Options:
1. Accept `sourceProjectId` directly (the issue description suggests this)
2. Accept `sourceProjectNumber` + `sourceOwner` and resolve the ID

Approach 2 is more user-friendly and consistent with other tools that accept project numbers. The tool could accept either a direct `sourceProjectId` or a `sourceProjectNumber`/`sourceOwner` pair.

## Key Discoveries

### 1. The mutation is straightforward
The `copyProjectV2` mutation has only 4 meaningful parameters and returns the full `ProjectV2` object. No post-mutation field setup is needed since fields are copied from the source.

### 2. Cross-owner copy is supported
The `ownerId` parameter accepts any user or organization node ID, enabling copying a project from one owner to another. This is useful for creating projects in an organization based on a personal template, or vice versa.

### 3. Field cache must be refreshed after copy
After copying, the new project has its own field IDs (different from the source). If subsequent operations target the new project, the field cache must be invalidated and repopulated. The `ensureFieldCacheForNewProject` pattern in `project-tools.ts:734-744` handles this.

### 4. Repository links are NOT copied
The copied project will not have any linked repositories. Users will need to separately call `link_repository` to associate repos. This should be documented in the tool description.

### 5. Best home for the tool
The triage comment suggests either `project-management-tools.ts` or `project-tools.ts`. Given that:
- `project-tools.ts` already contains `setup_project` (most closely related functionality)
- `project-management-tools.ts` handles item-level operations (archive, remove, add, link, clear)
- `copy_project` is a project-level creation operation like `setup_project`

**Recommendation**: Place `copy_project` in `project-tools.ts` alongside `setup_project`.

### 6. No need for source template marking
`copyProjectV2` works on any project, not just those marked as templates. The `markProjectV2AsTemplate` / `unmarkProjectV2AsTemplate` mutations are separate organizational features. The tool should not require the source to be a template.

## Potential Approaches

### Approach A: Minimal Tool (Recommended)

Register a single `ralph_hero__copy_project` tool with these parameters:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourceProjectNumber` | number | Yes* | Source project number |
| `sourceOwner` | string | No | Source project owner (defaults to env) |
| `title` | string | Yes | Title for the new project |
| `targetOwner` | string | No | Target owner for new project (defaults to env) |
| `includeDraftIssues` | boolean | No | Include draft issues (default: false) |

*Alternative: accept `sourceProjectId` directly for advanced use.

**Implementation steps**:
1. Resolve source project node ID from `sourceProjectNumber` + `sourceOwner`
2. Resolve target owner node ID from `targetOwner`
3. Execute `copyProjectV2` mutation
4. Return new project id, number, url, title

**Pros**: Simple, single-purpose, follows existing patterns.
**Cons**: Does not handle field cache population for the new project.

### Approach B: Full Tool with Cache Population

Same as Approach A, but additionally:
- After copy, populate the field cache for the new project
- Return field information in the response

**Pros**: Ready for immediate follow-up operations on the new project.
**Cons**: Slightly more complex; cache population may be unnecessary if no immediate follow-up.

### Approach C: Minimal Tool + Template Marking Helpers

Approach A plus two additional tools:
- `ralph_hero__mark_as_template` (wraps `markProjectV2AsTemplate`)
- `ralph_hero__unmark_as_template` (wraps `unmarkProjectV2AsTemplate`)

**Pros**: Complete template management capability.
**Cons**: Over-scoped for issue #101; template marking is niche.

## Risks and Edge Cases

1. **Permission errors**: The authenticated token must have `project` scope with write access to both the source project (read) and target owner (write). Cross-org copies may require additional permissions.

2. **Source project not found**: If the source project number is invalid or the owner is wrong, the GraphQL query will fail. Standard error handling applies.

3. **Large project copy latency**: Projects with many views, fields, and workflows may take longer to copy. The mutation is server-side so no client-side timeout concern, but rate limiting may apply.

4. **Draft issues duplication**: When `includeDraftIssues: true`, draft issues are copied as new draft issues in the new project. This may create unexpected duplicates if the user is not aware.

5. **Workflow state field options**: If the source project has custom Workflow State options, they will be copied exactly. If the source has a different field configuration than Ralph expects, the field cache may not match expectations.

6. **Field ID divergence**: The new project's field IDs will differ from the source. Any cached field IDs from the source project must not be reused for the new project.

## Recommended Next Steps

1. **Implement `copy_project` in `project-tools.ts`** following Approach A (minimal tool)
2. **Reuse the owner resolution pattern** from `setup_project` for resolving both source owner and target owner
3. **Add source project resolution** -- query project by number + owner to get node ID
4. **Return comprehensive result**: project id, number, url, title, and a note about what was/was not copied
5. **Add tests** in a new test file or extend `project-management-tools.test.ts`:
   - Mutation structure validation (matching existing test pattern)
   - Parameter handling (default owner resolution)
   - Cross-owner copy scenario
6. **Update `index.ts`** if the tool is in a new module (not needed if added to existing `project-tools.ts`)
7. **Defer template marking tools** to a future issue -- they are not part of #101's acceptance criteria
