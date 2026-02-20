---
date: 2026-02-20
status: draft
github_issues: [173]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/173
primary_issue: 173
---

# Add Audit Trail Comment and Error Handling to Routing Workflow - Implementation Plan

## Overview
1 issue extending the routing script from GH-169/GH-171 with resilience and observability:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-173 | Add audit trail comment and error handling to routing workflow | XS |

## Current State Analysis

`scripts/routing/route.js` (from GH-171, merged via PR #196) is a 215-line standalone CommonJS script that:
- Reads env vars from the `route-issues.yml` workflow
- Loads `.ralph-routing.yml` config, evaluates rules, adds issues to projects, sets field values
- Has **no retry logic** — a transient 429/5xx fails the entire workflow run
- Has **no audit trail** — no record on the issue of what routing was applied
- Has **no fallback** — if no rules match or config is missing, it silently exits
- Has **no idempotency check** — re-triggered events re-run all mutations (though `addProjectV2ItemById` is idempotent, the lack of visibility is a concern)
- Has **no structured summary** in the GitHub Actions UI

The workflow YAML (`.github/workflows/route-issues.yml`) uses a `concurrency` group per issue number, which serializes concurrent routing events for the same issue. This means the idempotency check only needs to handle sequential re-runs, not true concurrent access.

## Desired End State

### Verification
- [ ] `withRetry` wraps all GraphQL calls with exponential backoff on 429/5xx
- [ ] `addAuditComment` posts a `<!-- routing-audit -->` marker comment after successful routing
- [ ] `hasExistingAuditComment` checks recent comments before routing, skipping if already routed
- [ ] `handleNoRulesMatch` falls back to `ROUTING_DEFAULT_PROJECT` when no rules match
- [ ] `writeStepSummary` writes structured output to `$GITHUB_STEP_SUMMARY`
- [ ] Workflow YAML adds `ROUTING_DEFAULT_PROJECT` env var (optional, from repo variable)
- [ ] All new functions have corresponding unit tests

## What We're NOT Doing
- No retry with `Retry-After` header parsing (exponential backoff is sufficient for low-volume repos)
- No structured error annotations beyond `::error::` (existing pattern)
- No deduplication across different routing configs (single config file assumed)
- No metrics or logging service integration
- No changes to the matching engine or config loader (GH-167, GH-168)

## Implementation Approach

All changes are additive to `scripts/routing/route.js`. The file grows from ~215 lines to ~320 lines. No new files except the test file. The implementation order follows the research doc's recommendation: retry first (protects all mutations), then audit + idempotency, then fallback, then step summary.

---

## Phase 1: GH-173 — Audit Trail, Error Handling, and Observability
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/173 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0173-routing-audit-error-handling.md

### Changes Required

#### 1. Add `withRetry` helper function
**File**: `scripts/routing/route.js`
**Where**: After the `graphqlWithAuth` declaration (line 29), before the config loader section

**Changes**: Add a `withRetry(fn, maxRetries, baseDelayMs)` async function:
- Retries on HTTP 429 (rate limit) and 5xx (server error) with exponential backoff
- Throws immediately on 4xx non-transient errors
- Default: 3 retries, 1000ms base delay (1s, 2s, 4s progression)
- Logs retry attempts with `console.warn` showing status code, delay, and attempt count
- Error detection: check `err.status` then fallback to `err.response?.status`

```javascript
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.response?.status;
      const isTransient = status === 429 || (status >= 500 && status < 600);
      if (!isTransient || attempt === maxRetries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(`API error ${status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

#### 2. Add `hasExistingAuditComment` idempotency check
**File**: `scripts/routing/route.js`
**Where**: After `withRetry`, in the GraphQL helpers section

**Changes**: Add function that queries the last 20 comments on an issue/PR and checks for the `<!-- routing-audit -->` marker:
- Uses the same `issue` vs `pullRequest` field branching as `fetchContentNodeId`
- Returns `true` if any comment body starts with the marker
- Wrapped in `withRetry` since it's a GraphQL call

```javascript
async function hasExistingAuditComment(gql, owner, repo, number, eventName) {
  const field = eventName === 'pull_request' ? 'pullRequest' : 'issue';
  const result = await withRetry(() => gql(
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        item: ${field}(number: $number) {
          comments(last: 20) { nodes { body } }
        }
      }
    }`,
    { owner, repo, number },
  ));
  const comments = result.repository?.item?.comments?.nodes ?? [];
  return comments.some(c => c.body.startsWith('<!-- routing-audit -->'));
}
```

#### 3. Add `addAuditComment` function
**File**: `scripts/routing/route.js`
**Where**: After `hasExistingAuditComment`

**Changes**: Add function that posts a markdown comment with the `<!-- routing-audit -->` marker:
- Lists each matched rule with project number and field values
- Uses `addComment` GraphQL mutation with `subjectId` = the content node ID from `fetchContentNodeId`
- Wrapped in `withRetry`

```javascript
async function addAuditComment(gql, contentId, matchedRules) {
  const lines = matchedRules.map(r => {
    const fields = [];
    if (r.action.workflowState) fields.push(`Workflow State: ${r.action.workflowState}`);
    if (r.action.priority) fields.push(`Priority: ${r.action.priority}`);
    if (r.action.estimate) fields.push(`Estimate: ${r.action.estimate}`);
    const fieldStr = fields.length ? ` | ${fields.join(' | ')}` : '';
    return `- Project #${r.action.projectNumber}${fieldStr}`;
  });
  const body = `<!-- routing-audit -->\n**Routing applied** by \`.ralph-routing.yml\`:\n${lines.join('\n')}`;

  await withRetry(() => gql(
    `mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }`,
    { subjectId: contentId, body },
  ));
}
```

#### 4. Add `handleNoRulesMatch` fallback function
**File**: `scripts/routing/route.js`
**Where**: After `addAuditComment`

**Changes**: Add function that routes to a default project when no rules match:
- Reads `ROUTING_DEFAULT_PROJECT` env var (optional, integer)
- If not set or invalid, logs and returns (no-op)
- If set, fetches project meta and adds item to project (no field assignments)
- Wrapped in `withRetry`

```javascript
async function handleNoRulesMatch(gql, contentId, context) {
  const defaultProjectNum = parseInt(process.env.ROUTING_DEFAULT_PROJECT ?? '', 10);
  if (!defaultProjectNum || isNaN(defaultProjectNum)) {
    console.log('No default project configured. Skipping fallback routing.');
    return;
  }
  const { projectId } = await fetchProjectMeta(gql, GH_OWNER, defaultProjectNum);
  await withRetry(() => addToProject(gql, projectId, contentId));
  console.log(`Fallback: routed #${context.number} to default project #${defaultProjectNum}`);
}
```

#### 5. Add `writeStepSummary` function
**File**: `scripts/routing/route.js`
**Where**: After `handleNoRulesMatch`

**Changes**: Add function that writes a markdown summary to `$GITHUB_STEP_SUMMARY`:
- Lists routing results per matched rule
- Falls back to `/dev/null` if `GITHUB_STEP_SUMMARY` is not set (local development)

```javascript
function writeStepSummary(itemNumber, matchedRules) {
  const summary = matchedRules.map(r =>
    `- Routed to project #${r.action.projectNumber}` +
    (r.action.workflowState ? ` (Workflow State: ${r.action.workflowState})` : '') +
    (r.action.priority ? ` (Priority: ${r.action.priority})` : '')
  ).join('\n');

  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY || '/dev/null',
    `## Routing Results for #${itemNumber}\n${summary || 'No rules matched.'}\n`,
  );
}
```

#### 6. Wrap existing GraphQL calls with `withRetry`
**File**: `scripts/routing/route.js`
**Where**: `main()` function (lines 151-210)

**Changes**: Wrap existing calls:
- `fetchContentNodeId` call: wrap with `withRetry`
- `fetchProjectMeta` call: wrap with `withRetry`
- `addToProject` call: wrap with `withRetry`
- `setField` internal `gql()` call: wrap with `withRetry`

Specifically in `main()`:
```javascript
// Before:
const contentId = await fetchContentNodeId(graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME);
// After:
const contentId = await withRetry(() =>
  fetchContentNodeId(graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME)
);
```

And the `fetchProjectMeta` and `addToProject` calls similarly. For `setField`, the `withRetry` wrap goes around the internal `gql()` call within the `setField` function itself.

#### 7. Update `main()` to wire new functions
**File**: `scripts/routing/route.js`
**Where**: `main()` function

**Changes**: Restructure `main()` to:
1. Load config (existing)
2. **Early exit if no rules AND no default project**: replace current "no rules" early return with call to `handleNoRulesMatch` when no rules match (after content ID fetch)
3. Build issue context (existing)
4. Evaluate rules (existing)
5. **Idempotency check**: call `hasExistingAuditComment` — if already routed, log and return
6. **Fallback**: if no matched rules, call `handleNoRulesMatch` and return
7. Fetch content ID (existing, wrapped with retry)
8. Route each matched rule (existing, wrapped with retry)
9. **Audit comment**: call `addAuditComment` after all mutations succeed
10. **Step summary**: call `writeStepSummary`

Updated `main()` flow:
```javascript
async function main() {
  const config = loadConfig(RALPH_ROUTING_CONFIG);
  const labels = JSON.parse(ITEM_LABELS || '[]').map(l => l.name);
  const itemNumber = parseInt(ITEM_NUMBER, 10);
  const issueContext = { number: itemNumber, labels, repo: GH_REPO, owner: GH_OWNER, eventName: EVENT_NAME };

  const matchedRules = config.rules?.length
    ? evaluateRules(config.rules, issueContext)
    : [];

  // Fetch content ID early — needed for both routing and fallback
  const contentId = await withRetry(() =>
    fetchContentNodeId(graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME)
  );

  // Idempotency: skip if already routed
  const alreadyRouted = await hasExistingAuditComment(
    graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME
  );
  if (alreadyRouted) {
    console.log(`#${itemNumber} already has a routing audit comment. Skipping.`);
    return;
  }

  // Fallback when no rules match
  if (!matchedRules.length) {
    console.log(`No routing rules matched for #${itemNumber}.`);
    await handleNoRulesMatch(graphqlWithAuth, contentId, { number: itemNumber });
    return;
  }

  // Route each matched rule
  for (const rule of matchedRules) { /* existing routing logic, wrapped with withRetry */ }

  // Audit comment after all mutations succeed
  await addAuditComment(graphqlWithAuth, contentId, matchedRules);

  // Actions step summary
  writeStepSummary(itemNumber, matchedRules);
}
```

#### 8. Add `ROUTING_DEFAULT_PROJECT` env var to workflow
**File**: `.github/workflows/route-issues.yml`
**Where**: In the `env:` block of the "Route issue or PR" step (line 41-53)

**Changes**: Add one line:
```yaml
          ROUTING_DEFAULT_PROJECT: ${{ vars.ROUTING_DEFAULT_PROJECT }}
```

This reads from GitHub repo variables (not secrets, since it's just a project number).

#### 9. Create unit tests
**File**: `scripts/routing/route.test.js` (NEW)

**Changes**: Create test file using Node.js built-in `node:test` and `node:assert` (no test framework dependency needed for a standalone script):

```javascript
const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
```

Test cases:
- **withRetry**:
  - `succeeds on first attempt` — fn resolves, returns value
  - `retries on 429 and succeeds` — fn throws `{ status: 429 }` once, then resolves
  - `retries on 5xx and succeeds` — fn throws `{ status: 503 }` once, then resolves
  - `throws after maxRetries exhausted` — fn always throws `{ status: 429 }`, verify throws after N retries
  - `does not retry on 4xx non-transient` — fn throws `{ status: 404 }`, verify throws immediately
  - `does not retry on non-HTTP errors` — fn throws `Error('network')`, verify throws immediately

- **hasExistingAuditComment** (mock graphql):
  - `returns true when audit comment exists` — mock returns comment with `<!-- routing-audit -->` prefix
  - `returns false when no audit comment` — mock returns comments without marker

- **addAuditComment** (mock graphql):
  - `generates correct comment body` — verify mutation called with body containing marker and rule details
  - `includes all set fields` — verify workflowState, priority, estimate all appear

- **handleNoRulesMatch** (mock graphql + env):
  - `routes to default project when env set` — verify `addToProject` called
  - `skips when env not set` — verify no GraphQL calls

- **writeStepSummary**:
  - `writes markdown to GITHUB_STEP_SUMMARY` — mock `fs.appendFileSync`, verify content

To make functions testable, export them from `route.js` when `module.parent` exists (or use a conditional export pattern):
```javascript
// At end of route.js:
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { withRetry, hasExistingAuditComment, addAuditComment, handleNoRulesMatch, writeStepSummary };
}
```

The `main()` call at the bottom only runs when the script is executed directly (not imported):
```javascript
if (require.main === module) {
  main().catch(err => {
    console.error('::error::Routing failed:', err.message);
    process.exit(1);
  });
}
```

### Success Criteria
- [ ] Automated: `node --test scripts/routing/route.test.js` — all tests pass
- [ ] Automated: `node -c scripts/routing/route.js` — syntax check passes
- [ ] Manual: Trigger workflow on a test issue — verify audit comment appears
- [ ] Manual: Re-trigger workflow — verify idempotency (no duplicate comment)
- [ ] Manual: Remove `.ralph-routing.yml` and set `ROUTING_DEFAULT_PROJECT` var — verify fallback routing
- [ ] Manual: Check Actions run summary — verify structured output appears

---

## Integration Testing
- [ ] `node --test scripts/routing/route.test.js` passes all unit tests
- [ ] `node -c scripts/routing/route.js` syntax check passes
- [ ] Existing `npm ci` in workflow still succeeds (no new dependencies)
- [ ] `route.js` exports functions when imported but only runs `main()` when executed directly
- [ ] `ROUTING_DEFAULT_PROJECT` env var is optional — workflow works without it

## References
- Research GH-173: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-20-GH-0173-routing-audit-error-handling.md
- Base script (GH-171): [`scripts/routing/route.js`](https://github.com/cdubiel08/ralph-hero/blob/main/scripts/routing/route.js)
- Workflow (GH-169): [`.github/workflows/route-issues.yml`](https://github.com/cdubiel08/ralph-hero/blob/main/.github/workflows/route-issues.yml)
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/126
- Group plan GH-169/171: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-02-20-group-GH-169-routing-actions-workflow.md
