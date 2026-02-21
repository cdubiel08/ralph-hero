---
date: 2026-02-20
github_issue: 171
github_url: https://github.com/cdubiel08/ralph-hero/issues/171
status: complete
type: research
---

# GH-171: Implement Routing Evaluation and Project Field Assignment in Actions

## Problem Statement

Implement the core routing logic as a Node.js script called from the `route-issues.yml` workflow (#169). The script reads `.ralph-routing.yml`, evaluates routing rules against the triggering issue/PR, and calls GitHub GraphQL to add matched items to project(s) and set field values (Workflow State, Priority, Estimate).

## Current State Analysis

### No Standalone Node.js Script Exists

The repository has zero standalone `.js` scripts outside `node_modules`/`dist`. All GitHub API access goes through the TypeScript MCP server. GH-171 creates the first standalone routing script — a new pattern in this codebase.

### GraphQL Mutations Needed

**`addProjectV2ItemById`** — adds an issue to a project (from `project-management-tools.ts:204-218`):
```graphql
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: {
    projectId: $projectId,
    contentId: $contentId
  }) {
    item { id }
  }
}
```
- `projectId`: project node ID (fetched by project number via GraphQL)
- `contentId`: issue/PR node ID (fetched by issue number via `repository.issue.id`)
- Returns: `item.id` — the project item node ID (needed for field updates)

**`updateProjectV2ItemFieldValue`** — sets a field value (from `helpers.ts:248-260`):
```graphql
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}
```
- `fieldId`: project field node ID (fetched by field name)
- `optionId`: option node ID (fetched by option name within the field)

### Resolution Chain

The MCP server's resolution chain provides the blueprint:
1. **Project node ID** ← `ProjectV2.id` queried by project number + owner
2. **Issue/PR node ID** ← `repository.issue.id` or `repository.pullRequest.id` queried by number
3. **Project item node ID** ← returned by `addProjectV2ItemById.item.id`
4. **Field node ID** ← `ProjectV2SingleSelectField.id` queried by field name in project fields
5. **Option node ID** ← `ProjectV2SingleSelectField.options[].id` filtered by option name

### Script Language Choice

**Options:**
- **Plain JavaScript (CommonJS)** — no build step, runs directly with `node`
- **Plain JavaScript (ESM)** — no build step, runs with `node` (needs `"type": "module"` in package.json)
- **TypeScript with `tsx`** — type-safe, consistent with codebase, but needs `npm install tsx` in workflow
- **TypeScript compiled** — add a build step to the Actions workflow

**Recommendation: Plain JavaScript (CommonJS)** for the Actions script. Rationale:
- Zero build step in the workflow (faster CI, simpler)
- The routing script is a standalone utility, not part of the MCP server codebase
- `@octokit/graphql` works equally well in JS and TS
- Types can be documented via JSDoc comments for readability

### Dependencies

- `@octokit/graphql` — for GitHub GraphQL API calls (same library the MCP server uses)
- No other runtime dependencies needed

The script lives at `scripts/routing/route.js` with `scripts/routing/package.json` listing `@octokit/graphql`.

### Config Loading

Until #168 (config loader with validation) ships, the script uses a simple inline loader:
```javascript
const yaml = require('yaml');  // or js-yaml
const fs = require('fs');

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) return { rules: [] };
  return yaml.parse(fs.readFileSync(configPath, 'utf-8')) ?? { rules: [] };
}
```

Once #168 ships, this can be replaced with an import from the config loader module if it's structured as a shared library. However, since #168 also uses the MCP server's TypeScript environment, a reusable plain-JS loader may need to be maintained separately.

### Matching Engine

Until #167 (matching engine) ships, the script uses a stub evaluator:
```javascript
function evaluateRules(rules, issueContext) {
  // TODO: replace with import from #167 matching engine
  return rules.filter(rule => {
    if (!rule.match) return false;
    if (rule.match.labels) {
      return rule.match.labels.some(l => issueContext.labels.includes(l));
    }
    return false;
  });
}
```

## Implementation Plan

### Script Location and Structure

```
scripts/routing/
├── package.json          # { "dependencies": { "@octokit/graphql": "^7" } }
├── package-lock.json
└── route.js              # main entry point
```

### `route.js` Flow

```javascript
#!/usr/bin/env node
'use strict';

const { graphql } = require('@octokit/graphql');
const yaml = require('yaml');
const fs = require('fs');

// 1. Read env vars (set by route-issues.yml workflow from #169)
const {
  ROUTING_PAT,
  GH_OWNER,
  GH_REPO,
  ITEM_NUMBER,
  ITEM_LABELS,      // JSON string: [{ name, color, ... }]
  EVENT_NAME,       // "issues" or "pull_request"
  RALPH_ROUTING_CONFIG = '.ralph-routing.yml',
} = process.env;

if (!ROUTING_PAT) {
  console.error('::error::ROUTING_PAT is not set. Cannot write to Projects V2.');
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${ROUTING_PAT}` },
});

async function main() {
  // 2. Load routing config
  const config = loadConfig(RALPH_ROUTING_CONFIG);
  if (!config.rules?.length) {
    console.log('No routing rules configured. Skipping.');
    return;
  }

  // 3. Build issue context from env
  const labels = JSON.parse(ITEM_LABELS || '[]').map(l => l.name);
  const itemNumber = parseInt(ITEM_NUMBER, 10);
  const issueContext = { number: itemNumber, labels, repo: GH_REPO, owner: GH_OWNER, eventName: EVENT_NAME };

  // 4. Evaluate rules
  const matchedRules = evaluateRules(config.rules, issueContext);
  if (!matchedRules.length) {
    console.log(`No routing rules matched for #${itemNumber}.`);
    return;
  }

  // 5. Fetch issue/PR node ID
  const contentId = await fetchContentNodeId(graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME);

  // 6. For each matched rule: add to project + set fields
  for (const rule of matchedRules) {
    const projectNumber = rule.action.projectNumber;
    const projectOwner = rule.action.projectOwner ?? GH_OWNER;

    console.log(`Routing #${itemNumber} to project #${projectNumber}...`);

    // Resolve project ID and field IDs
    const { projectId, fields } = await fetchProjectMeta(graphqlWithAuth, projectOwner, projectNumber);

    // Add item to project
    const projectItemId = await addToProject(graphqlWithAuth, projectId, contentId);

    // Set field values from rule action
    if (rule.action.workflowState) {
      await setField(graphqlWithAuth, projectId, projectItemId, fields, 'Workflow State', rule.action.workflowState);
    }
    if (rule.action.priority) {
      await setField(graphqlWithAuth, projectId, projectItemId, fields, 'Priority', rule.action.priority);
    }
    if (rule.action.estimate) {
      await setField(graphqlWithAuth, projectId, projectItemId, fields, 'Estimate', rule.action.estimate);
    }

    console.log(`✓ Routed #${itemNumber} to project #${projectNumber}`);
  }
}

main().catch(err => {
  console.error('::error::Routing failed:', err.message);
  process.exit(1);
});
```

### Key Helper Functions

**`fetchContentNodeId`** — resolves issue/PR node ID by number:
```javascript
async function fetchContentNodeId(graphqlWithAuth, owner, repo, number, eventName) {
  const field = eventName === 'pull_request' ? 'pullRequest' : 'issue';
  const result = await graphqlWithAuth(`
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        item: ${field}(number: $number) { id }
      }
    }
  `, { owner, repo, number });
  if (!result.repository?.item?.id) throw new Error(`#${number} not found`);
  return result.repository.item.id;
}
```

**`fetchProjectMeta`** — resolves project node ID + field IDs + option IDs:
```javascript
async function fetchProjectMeta(graphqlWithAuth, owner, projectNumber) {
  // Try user, then org
  for (const ownerType of ['user', 'organization']) {
    try {
      const result = await graphqlWithAuth(`
        query($owner: String!, $number: Int!) {
          ${ownerType}(login: $owner) {
            projectV2(number: $number) {
              id
              fields(first: 20) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id name
                    options { id name }
                  }
                }
              }
            }
          }
        }
      `, { owner, number: projectNumber });
      const project = result[ownerType]?.projectV2;
      if (project) {
        const fields = {};
        for (const f of project.fields.nodes) {
          if (f.name) fields[f.name] = { id: f.id, options: f.options ?? [] };
        }
        return { projectId: project.id, fields };
      }
    } catch {}
  }
  throw new Error(`Project #${projectNumber} not found for owner "${owner}"`);
}
```

**`addToProject`** — adds item and returns project item node ID:
```javascript
async function addToProject(graphqlWithAuth, projectId, contentId) {
  const result = await graphqlWithAuth(`
    mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }
  `, { projectId, contentId });
  return result.addProjectV2ItemById.item.id;
}
```

**`setField`** — updates a single-select field by name:
```javascript
async function setField(graphqlWithAuth, projectId, itemId, fields, fieldName, optionName) {
  const field = fields[fieldName];
  if (!field) { console.warn(`Field "${fieldName}" not found in project`); return; }
  const option = field.options.find(o => o.name === optionName);
  if (!option) { console.warn(`Option "${optionName}" not valid for field "${fieldName}"`); return; }

  await graphqlWithAuth(`
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
        value: { singleSelectOptionId: $optionId }
      }) { projectV2Item { id } }
    }
  `, { projectId, itemId, fieldId: field.id, optionId: option.id });
}
```

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `scripts/routing/route.js` | NEW — main routing script | Primary |
| `scripts/routing/package.json` | NEW — `@octokit/graphql` + `yaml` dependencies | Trivial |
| `.github/workflows/route-issues.yml` | Add `npm ci` step in `scripts/routing/` before routing step | Minor (extends #169) |

### Workflow Update (extends #169)

Add before the routing step:
```yaml
      - name: Install routing script dependencies
        run: npm ci
        working-directory: scripts/routing
```

### Tests

The script is difficult to unit-test in isolation because it uses env vars and makes live API calls. Approach:
- Extract business logic into testable pure functions: `evaluateRules`, `loadConfig`
- Mock `@octokit/graphql` in vitest tests for `fetchProjectMeta`, `addToProject`, `setField`
- Integration test: run against a test project with known routing rules

For v1, focus tests on the pure functions (`evaluateRules`, `loadConfig`) which are fully deterministic.

## Dependency Coordination

| Dependency | Status | Impact |
|-----------|--------|--------|
| #169 (workflow scaffold) | Ready for Plan | Provides env vars; merge before or with #171 |
| #167 (matching engine) | Backlog | `evaluateRules` stub until #167 ships |
| #168 (config loader) | Backlog | Inline `loadConfig` until #168 ships |

The stub implementations (`evaluateRules`, `loadConfig`) are clearly marked as `TODO: replace with #167/#168` in the code.

## Risks

1. **`ROUTING_PAT` scope**: PAT must have both `repo` and `project` scopes. The script validates presence and exits early with a clear error if missing.

2. **Organization vs. user owner type**: `fetchProjectMeta` tries both `user` and `organization` (same pattern as MCP server's `fetchProjectForCache`). This handles both personal and org-owned projects.

3. **API rate limiting**: Routing 1 item may use up to 4 API calls (fetch content ID, fetch project meta, add to project, set 3 fields). For labeled events that fire repeatedly, rate limiting could be hit. The `ROUTING_PAT` has its own rate limit quota (5000 req/hr) separate from `GITHUB_TOKEN`.

4. **Item already in project**: `addProjectV2ItemById` is idempotent — adding an item already in a project returns the existing project item ID without error. No special handling needed.

5. **Script language divergence**: The routing script is plain JS while the MCP server is TypeScript. If #167's matching engine is TypeScript, it cannot be directly `require()`d. The matching logic may need to be duplicated or the script converted to TypeScript.

## Recommended Approach

1. Create `scripts/routing/package.json` with `@octokit/graphql` and `yaml` dependencies
2. Create `scripts/routing/route.js` with inline stubs for `loadConfig` (superseded by #168) and `evaluateRules` (superseded by #167)
3. Update `route-issues.yml` (from #169) to add `npm ci` step in `scripts/routing/`
4. Tag all stub functions with `// TODO: replace with import from #NNN` comments
5. Test pure functions (`evaluateRules`, `loadConfig`) with vitest or plain Node.js assertions
6. Merge as a single PR with the #169 workflow file
