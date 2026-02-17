---
date: 2026-02-16
status: draft
github_issue: 24
github_url: https://github.com/cdubiel08/ralph-hero/issues/24
---

# Smart Duplicate Detection During Triage

## Overview

Add a `ralph_hero__find_duplicates` MCP tool that detects potential duplicate issues using a two-phase approach: (1) GitHub GraphQL `search` connection for keyword-based candidate retrieval, and (2) Dice-Sorensen bigram coefficient for local title similarity scoring. Returns ranked candidates with transparent similarity scores for the triage agent to make the final duplicate determination. No external APIs, no embeddings, no persistent storage — pure keyword retrieval + lightweight string similarity.

## Current State Analysis

### Duplicate Detection Is Entirely Manual

The triage skill's only programmatic support is a case-insensitive substring match via the `query` parameter in `list_issues` ([issue-tools.ts:528-537](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L528-L537)):

```typescript
if (args.query) {
  const q = args.query.toLowerCase();
  items = items.filter((item) => {
    const title = ((content?.title as string) || "").toLowerCase();
    const body = ((content?.body as string) || "").toLowerCase();
    return title.includes(q) || body.includes(q);
  });
}
```

This misses rewording (e.g., "Add user authentication" vs "Implement auth flow"), returns unranked binary matches, and requires fetching up to 500 items client-side before filtering.

### No GitHub Search API Integration

The MCP server uses GraphQL exclusively via `@octokit/graphql` ([github-client.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts)). GitHub's GraphQL `search` connection is available but not integrated:

```graphql
search(query: "repo:owner/repo is:issue in:title,body keywords", type: ISSUE, first: 20) {
  issueCount
  nodes { ... on Issue { number title body state url } }
}
```

Key capabilities: `in:title`, `in:body` targeting, quoted phrases, up to 1,000 results. Separate rate limit: 30 req/min. Query strings limited to 256 characters.

### MCP Server is Stateless

4 production dependencies, no database, no file I/O. All state lives in GitHub. This rules out embedding storage, local indices, or persistent similarity caches.

### Relevant Infrastructure

| Component | Location | Reusable For |
|-----------|----------|-------------|
| `client.query()` | [github-client.ts:173-191](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts#L173-L191) | GraphQL `search` queries (repo-level, cached) |
| `resolveConfig()` | [issue-tools.ts:329-344](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L329-L344) | Owner/repo resolution pattern |
| `toolSuccess`/`toolError` | [types.ts:246-257](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/types.ts#L246-L257) | Standard response formatting |
| `get_issue` tool | [issue-tools.ts:585-879](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L585-L879) | Fetching target issue data |

## Desired End State

1. `ralph_hero__find_duplicates` tool accepts an issue number and returns ranked duplicate candidates with similarity scores
2. Candidate retrieval uses GitHub GraphQL `search` (keyword-based, efficient for large repos)
3. Local Dice-Sorensen coefficient provides title similarity scoring (no dependencies)
4. Results include enough context (title, url, state, workflow state) for the triage agent to judge
5. Similarity scoring logic is in a testable `lib/similarity.ts` module

### Verification
- [ ] `npm run build` compiles with no type errors
- [ ] `npm test` passes with similarity and find_duplicates tests
- [ ] Calling `find_duplicates` on an issue with a known near-duplicate returns it as a candidate
- [ ] Calling `find_duplicates` on a unique issue returns few or no candidates above threshold
- [ ] Similarity scores are between 0.0 and 1.0 and correlate with actual text similarity
- [ ] GitHub search query is visible in the response for debugging

## What We're NOT Doing

- Not implementing embedding-based semantic matching (requires external API + storage)
- Not auto-closing duplicates (tool is advisory — triage agent decides)
- Not updating the triage skill to call this tool (follow-up integration task)
- Not adding npm dependencies for similarity (DIY Dice-Sorensen is ~15 lines)
- Not comparing issue bodies for similarity (title comparison is sufficient for MVP; body keywords are used for search retrieval only)
- Not persisting similarity results or caching across sessions

## Implementation Approach

Two phases:
1. **Similarity module**: Pure `lib/similarity.ts` with Dice-Sorensen coefficient and keyword extraction. Zero API dependencies, fully unit-testable.
2. **MCP tool**: `find_duplicates` tool in `issue-tools.ts` (alongside other issue tools). Uses GitHub `search` for candidate retrieval, applies similarity scoring, returns ranked results.

---

## Phase 1: Similarity Scoring Module

### Overview

Create a pure utility module with text similarity functions and keyword extraction. No API dependencies — operates entirely on strings.

### Changes Required

#### 1. Create similarity module
**File**: `plugin/ralph-hero/mcp-server/src/lib/similarity.ts` (new)

**Contents**:

**`diceSorensen(a: string, b: string): number`** — Dice-Sorensen bigram coefficient:
```typescript
export function diceSorensen(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().trim();
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.length < 2 || nb.length < 2) return 0.0;

  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.slice(i, i + 2));
    }
    return set;
  };

  const bg1 = bigrams(na);
  const bg2 = bigrams(nb);
  let intersection = 0;
  for (const b of bg1) {
    if (bg2.has(b)) intersection++;
  }
  return (2 * intersection) / (bg1.size + bg2.size);
}
```

**`extractSearchKeywords(title: string, body?: string): string`** — Extract top keywords for GitHub search query:
1. Tokenize title: split on whitespace and punctuation
2. Remove stop words (common English words: "the", "a", "an", "is", "are", "to", "for", "in", "on", "of", "and", "or", "with", "from", "by", "as", "at", "this", "that", "it", "be", "not", "do", "have", "will", "can", "should", "would", "add", "new", "use")
3. Take first 5 meaningful words from title
4. Optionally extract 2-3 keywords from body section headers (`##` lines)
5. Join with spaces, truncate to 200 chars (leaving room for `repo:` and `is:issue` qualifiers in the 256-char limit)

**`STOP_WORDS`** — Exported constant `Set<string>` for reuse and testing.

#### 2. Add similarity tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/similarity.test.ts` (new)

**Tests**:
- **Dice-Sorensen**:
  - Identical strings → 1.0
  - Completely different strings → ~0.0
  - Similar strings ("pipeline analytics" vs "pipeline metrics") → > 0.4
  - Case-insensitive: "Hello" vs "hello" → 1.0
  - Empty string or single char → 0.0
  - One string contains the other ("auth" vs "authentication") → moderate score
- **Keyword extraction**:
  - Filters stop words ("Add new authentication for users" → "authentication users")
  - Respects 5-word limit from title
  - Handles empty body gracefully
  - Truncates to 200 chars
  - Strips punctuation ("Fix: crash on login!" → "Fix crash login")

### Success Criteria

#### Automated Verification
- [x] `npm run build` — no type errors
- [x] `npx vitest run src/__tests__/similarity.test.ts` — all tests pass

#### Manual Verification
- [ ] `diceSorensen("pipeline analytics", "pipeline metrics")` returns reasonable score (> 0.3)

**Dependencies created for next phase**: `lib/similarity.ts` with `diceSorensen()` and `extractSearchKeywords()`.

---

## Phase 2: find_duplicates MCP Tool

### Overview

Implement the `ralph_hero__find_duplicates` MCP tool that combines GitHub search for candidate retrieval with local similarity scoring for ranking.

### Changes Required

#### 1. Add find_duplicates tool to issue-tools.ts
**File**: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts`

**Location**: Add after the `create_comment` tool ([~line 1465](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L1465)), before `detect_pipeline_position`.

**Tool name**: `ralph_hero__find_duplicates`

**Tool description**: `"Find potential duplicate issues using keyword search + title similarity scoring. Returns ranked candidates above a similarity threshold. Used during triage to detect duplicates before research. Recovery: if no candidates found, the issue is likely unique."`

**Input schema**:
```typescript
{
  owner: z.string().optional().describe("GitHub owner. Defaults to env var"),
  repo: z.string().optional().describe("Repository name. Defaults to env var"),
  number: z.number().describe("Issue number to check for duplicates"),
  threshold: z.number().optional().default(0.3)
    .describe("Minimum title similarity score (0.0-1.0, default 0.3)"),
  maxCandidates: z.number().optional().default(10)
    .describe("Maximum candidates to return (default 10)"),
  includeClosed: z.boolean().optional().default(false)
    .describe("Include closed issues in search (default false)"),
}
```

**Handler implementation**:

1. **Resolve config**: `resolveConfig(client, args)` → `{ owner, repo }`

2. **Fetch target issue** (title and body needed for keyword extraction):
   ```graphql
   query($owner: String!, $repo: String!, $number: Int!) {
     repository(owner: $owner, name: $repo) {
       issue(number: $number) {
         number title body
       }
     }
   }
   ```

3. **Extract search keywords**: Call `extractSearchKeywords(title, body)` from `lib/similarity.ts`

4. **Build GitHub search query**:
   ```typescript
   const stateFilter = args.includeClosed ? "" : "is:open";
   const searchQuery = `repo:${owner}/${repo} is:issue ${stateFilter} in:title ${keywords}`;
   ```

5. **Execute GitHub search** via `client.query()`:
   ```graphql
   query($searchQuery: String!) {
     search(query: $searchQuery, type: ISSUE, first: 50) {
       issueCount
       nodes {
         ... on Issue {
           number
           title
           url
           state
           labels(first: 5) { nodes { name } }
           projectItems(first: 5) {
             nodes {
               fieldValues(first: 10) {
                 nodes {
                   ... on ProjectV2ItemFieldSingleSelectValue {
                     __typename name
                     field { ... on ProjectV2FieldCommon { name } }
                   }
                 }
               }
             }
           }
         }
       }
     }
   }
   ```
   Variable: `{ searchQuery }` — note: the variable name `searchQuery` avoids the reserved `query` name in `@octokit/graphql` v9.

6. **Filter out self**: Remove the target issue from results (`number !== args.number`)

7. **Score candidates**: For each candidate, compute `diceSorensen(targetTitle, candidateTitle)`

8. **Filter by threshold**: Keep only candidates with score >= `args.threshold`

9. **Sort by score descending**, limit to `args.maxCandidates`

10. **Extract workflow state** from project field values (if available)

11. **Return result**:
    ```typescript
    toolSuccess({
      issue: { number: targetIssue.number, title: targetIssue.title },
      candidates: rankedCandidates.map(c => ({
        number: c.number,
        title: c.title,
        url: c.url,
        state: c.state,
        workflowState: c.workflowState || null,
        similarity: c.score,
        labels: c.labels,
      })),
      candidateCount: rankedCandidates.length,
      searchQuery: searchQuery,  // For debugging/transparency
    })
    ```

**Import needed**: Add `import { diceSorensen, extractSearchKeywords } from "../lib/similarity.js";` to imports at the top of `issue-tools.ts`.

#### 2. Add tool tests
**File**: `plugin/ralph-hero/mcp-server/src/__tests__/find-duplicates.test.ts` (new)

**Tests** (unit tests on the scoring/filtering logic, no API mocking):

Extract the candidate scoring/filtering logic into a testable helper function (e.g., `scoreCandidates(targetTitle, candidates, threshold, maxCandidates)`):

- Candidates with high title similarity score above threshold
- Candidates with low similarity score filtered out
- Self-issue (same number) excluded from results
- Results sorted by score descending
- Results limited to maxCandidates
- Empty candidate list returns empty results
- Threshold of 0.0 returns all candidates
- Threshold of 1.0 returns only exact title matches

### Success Criteria

#### Automated Verification
- [ ] `npm run build` — no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] `npx vitest run src/__tests__/find-duplicates.test.ts` — focused test pass

#### Manual Verification
- [ ] Call `find_duplicates` on an issue — verify search results return with similarity scores
- [ ] Verify `searchQuery` field shows the GitHub search query used
- [ ] Verify self-issue is excluded from candidates
- [ ] Verify scores correlate with actual title similarity

**Depends on**: Phase 1 (`lib/similarity.ts` module).

---

## Testing Strategy

### Unit Tests (Phase 1)
Pure function testing of Dice-Sorensen and keyword extraction with hardcoded strings. No mocking needed.

### Unit Tests (Phase 2)
Extract `scoreCandidates()` as a pure function that takes a target title and array of candidate objects, returning scored and filtered results. Test this without API mocking.

### Manual Validation
After implementation, run `find_duplicates` on:
- An issue known to have a near-duplicate → verify candidate appears with high score
- A unique issue → verify few/no candidates above threshold
- An issue with different wording but same concept → verify if keyword search finds it (expected: may miss semantic duplicates, which is a known limitation of keyword-based approach)

---

## Integration Testing

After all phases complete:
- [ ] `npm run build` — clean compile, no type errors
- [ ] `npm test` — all tests pass (existing + new)
- [ ] Call `find_duplicates` on several issues — verify results are reasonable
- [ ] Verify GitHub search rate limits are not hit during normal usage
- [ ] Verify existing `list_issues` tool is unaffected

## API Cost Analysis

| Operation | API Points | Frequency |
|-----------|-----------|-----------|
| Fetch target issue | ~2 points | Once per `find_duplicates` call |
| GitHub search query | ~2-4 points | Once per call (separate rate limit: 30/min) |
| **Total per call** | **~4-6 points** | On-demand during triage |

Negligible impact on the 5000/hour budget. The search API has its own 30 req/min limit, which is never approached during normal triage (1 call per issue).

## Future Considerations (Out of Scope)

- **Triage skill integration**: Update `ralph-triage/SKILL.md` to call `find_duplicates` as first triage step with auto-close for >0.9 similarity
- **Body similarity scoring**: Add Jaccard similarity on tokenized body text for more nuanced scoring
- **Multi-algorithm scoring**: Use `cmpstr` package for Jaro-Winkler, Cosine, etc. alongside Dice-Sorensen
- **Embedding-based matching**: Voyage AI integration for true semantic similarity (requires API key + storage decisions)

## References

- [Issue #24](https://github.com/cdubiel08/ralph-hero/issues/24)
- [Research: GH-24](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-02-16-GH-0024-smart-duplicate-detection-triage.md)
- [issue-tools.ts — list_issues query parameter](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L528-L537)
- [issue-tools.ts — get_issue](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L585-L879)
- [github-client.ts — query method](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts#L173-L191)
