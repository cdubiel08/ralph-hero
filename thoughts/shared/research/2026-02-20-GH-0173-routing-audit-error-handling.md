---
date: 2026-02-20
github_issue: 173
github_url: https://github.com/cdubiel08/ralph-hero/issues/173
status: complete
type: research
---

# GH-173: Add Audit Trail Comment and Error Handling to Routing Workflow

## Problem Statement

Extend the routing script from #171 with: (1) audit comments on routed issues showing which project + field values were applied, (2) retry logic on transient API failures (429, 5xx) with exponential backoff, (3) fallback to a default project on config error, and (4) idempotency to prevent duplicate routing on repeated events.

## Current State Analysis

### Extends #171's `scripts/routing/route.js`

All changes are additive to the standalone routing script from #171. No new files needed. The audit and error handling logic augments the `main()` function and helper functions from #171.

### Audit Comment GraphQL Mutation

GitHub's `addComment` GraphQL mutation adds a comment to an issue or PR:

```graphql
mutation($subjectId: ID!, $body: String!) {
  addComment(input: { subjectId: $subjectId, body: $body }) {
    commentEdge {
      node { id url }
    }
  }
}
```

- `subjectId`: the issue or PR **node ID** (the same `contentId` resolved in #171's `fetchContentNodeId()`)
- `body`: markdown comment text

The `contentId` from #171 is already the issue/PR node ID — no additional lookup needed.

### Idempotency Pattern

To prevent duplicate audit comments when the same issue triggers the workflow multiple times (e.g., multiple label events in quick succession), check for an existing routing comment before adding a new one.

**Pattern**: Query recent issue comments for one starting with a known prefix:
```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      comments(last: 10) {
        nodes { body }
      }
    }
  }
}
```

If any comment body starts with `"<!-- routing-audit -->"`, skip adding another. This is a lightweight marker that doesn't require a separate field or label.

### Retry Pattern

GitHub API returns HTTP 429 (rate limit) and occasionally 5xx errors. `@octokit/graphql` throws on non-200 responses. Implement a `withRetry` wrapper:

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

All GraphQL calls in #171 (`addToProject`, `setField`, `addAuditComment`) are wrapped with `withRetry`.

### Fallback to Default Project

If `.ralph-routing.yml` is missing, empty, or malformed, and `ROUTING_DEFAULT_PROJECT` env var is set, add the issue to the default project with no field assignments:

```javascript
async function handleNoRulesMatch(graphqlWithAuth, contentId, context) {
  const defaultProjectNum = parseInt(process.env.ROUTING_DEFAULT_PROJECT ?? '', 10);
  if (!defaultProjectNum || isNaN(defaultProjectNum)) {
    console.log('No default project configured. Skipping fallback routing.');
    return;
  }
  const owner = process.env.GH_OWNER;
  const { projectId } = await fetchProjectMeta(graphqlWithAuth, owner, defaultProjectNum);
  await withRetry(() => addToProject(graphqlWithAuth, projectId, contentId));
  console.log(`Fallback: routed #${context.number} to default project #${defaultProjectNum}`);
}
```

Called when: (a) no routing config exists, OR (b) no rules matched the issue.

### Actions Step Summary

GitHub Actions supports `$GITHUB_STEP_SUMMARY` for structured output visible in the workflow run UI:

```javascript
const summary = matchedRules.map(r =>
  `- Routed to project #${r.action.projectNumber} (${Object.entries(r.action)
    .filter(([k]) => k !== 'projectNumber')
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')})`
).join('\n');

fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null',
  `## Routing Results for #${ITEM_NUMBER}\n${summary || 'No rules matched.'}\n`
);
```

## Implementation Plan

### Changes to `scripts/routing/route.js`

**1. Add `withRetry` helper** (new function, ~15 lines):
```javascript
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) { ... }
```

**2. Add `addAuditComment` function** (~20 lines):
```javascript
async function addAuditComment(graphqlWithAuth, contentId, matchedRules) {
  const lines = matchedRules.map(r =>
    `- Project #${r.action.projectNumber}` +
    (r.action.workflowState ? ` | Workflow State: ${r.action.workflowState}` : '') +
    (r.action.priority ? ` | Priority: ${r.action.priority}` : '') +
    (r.action.estimate ? ` | Estimate: ${r.action.estimate}` : '')
  );
  const body = `<!-- routing-audit -->\n**Routing applied** by \`.ralph-routing.yml\`:\n${lines.join('\n')}`;

  await withRetry(() => graphqlWithAuth(`
    mutation($subjectId: ID!, $body: String!) {
      addComment(input: { subjectId: $subjectId, body: $body }) {
        commentEdge { node { id } }
      }
    }
  `, { subjectId: contentId, body }));
}
```

**3. Add `hasExistingAuditComment` check** (~20 lines):
```javascript
async function hasExistingAuditComment(graphqlWithAuth, owner, repo, number, eventName) {
  const field = eventName === 'pull_request' ? 'pullRequest' : 'issue';
  const result = await graphqlWithAuth(`
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        item: ${field}(number: $number) {
          comments(last: 20) { nodes { body } }
        }
      }
    }
  `, { owner, repo, number });
  const comments = result.repository?.item?.comments?.nodes ?? [];
  return comments.some(c => c.body.startsWith('<!-- routing-audit -->'));
}
```

**4. Wrap existing calls with `withRetry`**:
```javascript
// Before (from #171):
const projectItemId = await addToProject(graphqlWithAuth, projectId, contentId);
// After:
const projectItemId = await withRetry(() => addToProject(graphqlWithAuth, projectId, contentId));
```

**5. Update `main()` to wire audit + idempotency + fallback**:
```javascript
async function main() {
  // ... (existing: load config, build issueContext, evaluateRules)

  // Idempotency check
  const alreadyRouted = await hasExistingAuditComment(graphqlWithAuth, GH_OWNER, GH_REPO, itemNumber, EVENT_NAME);
  if (alreadyRouted) {
    console.log(`#${itemNumber} already has a routing audit comment. Skipping.`);
    return;
  }

  if (!matchedRules.length) {
    await handleNoRulesMatch(graphqlWithAuth, contentId, { number: itemNumber });
    return;
  }

  // ... (existing: for each rule, add to project + set fields)

  // Audit comment (after all mutations succeed)
  await addAuditComment(graphqlWithAuth, contentId, matchedRules);

  // Actions step summary
  writeStepSummary(itemNumber, matchedRules);
}
```

### File Changes

| File | Change | Effort |
|------|--------|--------|
| `scripts/routing/route.js` | Add `withRetry`, `addAuditComment`, `hasExistingAuditComment`, `handleNoRulesMatch`, `writeStepSummary`; wrap existing calls with `withRetry`; update `main()` | Primary (extends #171) |
| `.github/workflows/route-issues.yml` | No changes needed — `ROUTING_DEFAULT_PROJECT` is already an env var pattern | None |

### Environment Variables (extends #169)

Add to the `env:` block in `route-issues.yml`:
```yaml
ROUTING_DEFAULT_PROJECT: ${{ vars.ROUTING_DEFAULT_PROJECT }}  # optional, repo variable
```

### Tests

```javascript
// withRetry tests
it('withRetry succeeds on first attempt')
it('withRetry retries on 429, succeeds on second attempt')
it('withRetry throws after maxRetries exhausted')
it('withRetry does not retry on 4xx non-transient errors')

// addAuditComment tests
it('addAuditComment generates correct comment body with routing-audit marker')
it('addAuditComment includes all set fields in comment')

// hasExistingAuditComment tests
it('returns true when audit comment exists')
it('returns false when no audit comment present')

// handleNoRulesMatch tests
it('routes to default project when ROUTING_DEFAULT_PROJECT is set')
it('skips gracefully when ROUTING_DEFAULT_PROJECT is unset')
```

## Group Summary

**Group: #169 → #171 → #173** (GitHub Actions routing workflow, parent #126)

| Issue | Title | Estimate | State |
|-------|-------|----------|-------|
| #169 | Workflow scaffold | XS | Ready for Plan |
| #171 | Routing evaluation script | S | Ready for Plan |
| **#173** | Audit trail + error handling | XS | Research in Progress |

Implementation order: #169 and #171 can be merged in one PR; #173 extends the script from #171.

## Risks

1. **`addComment` on PRs vs. issues**: The `addComment` mutation accepts any node ID with a `comments` connection. Both issues and PRs support this — same mutation, no branching needed.

2. **Idempotency marker in HTML comment**: `<!-- routing-audit -->` is invisible to users but present in the raw body. If the user edits the comment, the marker is preserved. This is the simplest approach; alternatives (labels, fields) are heavier.

3. **Rate limit on idempotency check**: `hasExistingAuditComment` is an extra API call per event. For low-volume repos this is fine. For high-volume, consider skipping the check and accepting occasional duplicate comments (the audit is informational, not critical).

4. **`labeled` event fires per label**: If an issue gets labeled rapidly (3 labels at once via API), 3 concurrent `labeled` events may fire. The concurrency group from #169 serializes them, and the idempotency check in `main()` ensures only the first one adds the audit comment.

## Recommended Approach

1. Implement after #171 is merged
2. Add `withRetry` wrapper first — smallest, highest value (protects all mutations)
3. Add audit comment + idempotency check
4. Add `handleNoRulesMatch` fallback
5. Add `writeStepSummary` for Actions UI output
6. Ship as a follow-up PR to #171's PR, or bundle with #171 if timing works out
