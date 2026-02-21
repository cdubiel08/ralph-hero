---
title: "Implement list_project_repos tool"
github_issue: 223
status: complete
estimate: XS
created: 2026-02-20
---

# GH-223: Implement `list_project_repos` tool

## Overview

Add a new `list_project_repos` MCP tool that queries `ProjectV2.repositories` to return all repositories linked to the project. Also add a shared `queryProjectRepositories()` helper function.

## Phase 1: Implementation (Single Phase - XS)

### Changes

1. **`plugin/ralph-hero/mcp-server/src/lib/helpers.ts`**
   - Add `queryProjectRepositories()` shared helper
   - Use user/organization fallback pattern from `fetchProjectForCache()`
   - Cache results with 10-min TTL via `projectQuery` with cache option

2. **`plugin/ralph-hero/mcp-server/src/tools/project-tools.ts`**
   - Register `ralph_hero__list_project_repos` tool
   - Accept optional `owner` and `number` params (defaulting from env)
   - Call `queryProjectRepositories()` helper
   - Return `{ projectId, repos: [{ owner, repo, nameWithOwner }], totalRepos }`

3. **`plugin/ralph-hero/mcp-server/src/__tests__/project-tools.test.ts`**
   - Add structural tests for the new tool

### Automated Verification

- [x] `npm run build` passes
- [x] `npm test` passes
