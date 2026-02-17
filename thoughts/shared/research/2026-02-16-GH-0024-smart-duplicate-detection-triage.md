---
date: 2026-02-16
github_issue: 24
github_url: https://github.com/cdubiel08/ralph-hero/issues/24
status: complete
type: research
---

# Research: GH-24 - Smart Duplicate Detection During Triage Using Semantic Similarity

## Problem Statement

Duplicate issues waste research and planning effort. Currently, the triage skill relies entirely on the LLM manually reading through issues and making judgment calls about duplicates. The only programmatic support is a simple case-insensitive substring match on issue title/body via the `query` parameter in `list_issues`. There is no structured similarity scoring, no GitHub search API integration, and no automated flagging of potential duplicates.

## Current State Analysis

### How Triage Handles Duplicates Today

The triage skill ([ralph-triage/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-triage/SKILL.md)) has two duplicate-related mechanisms:

1. **Step 2 (Assessment)**: Spawns a `list_issues` call with keywords from the issue title to find similar issues. The `query` parameter performs case-insensitive substring matching ([issue-tools.ts:528-537](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L528-L537)):
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

2. **CLOSE action**: Can auto-close only for "exact duplicate issue found" (high confidence). Ambiguous cases with multiple potential duplicates are escalated to a human.

**Key limitations**:
- Substring matching misses rewording (e.g., "Add user authentication" vs "Implement auth flow")
- No similarity scoring - results are unranked binary matches
- No GitHub search API integration - all matching is client-side after fetching up to 500 items
- The LLM's judgment is the entire deduplication system

### Existing MCP Server Infrastructure

| Component | Location | Relevance |
|-----------|----------|-----------|
| `list_issues` tool | [issue-tools.ts:376-583](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L376-L583) | Fetches up to 500 issues with title, body, labels, field values |
| `get_issue` tool | [issue-tools.ts:586-879](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts#L586-L879) | Full issue context including last 10 comments |
| GraphQL client | [github-client.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/github-client.ts) | `@octokit/graphql` v9 - GraphQL only, no REST API |
| Pagination | [pagination.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/pagination.ts) | Cursor-based, up to 500 items |
| Session cache | [cache.ts](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/cache.ts) | In-memory TTL cache, no persistence |

**The MCP server is deliberately stateless** - 4 production dependencies (`@modelcontextprotocol/sdk`, `@octokit/graphql`, `@octokit/plugin-paginate-graphql`, `zod`), no database, no file I/O in production code, no ML libraries. All state lives in GitHub.

### No GitHub Search API Integration

The MCP server uses GraphQL exclusively via `@octokit/graphql`. There is no integration with GitHub's `search` GraphQL connection or REST search endpoint, which support richer query syntax (`in:title`, `in:body`, quoted phrases, boolean operators).

## Key Discoveries

### 1. GitHub Search API is Available but Not Integrated

GitHub's GraphQL `search` connection supports issue text search with qualifiers:
```graphql
search(query: "repo:cdubiel08/ralph-hero is:issue in:title,body authentication", type: ISSUE, first: 50) {
  issueCount
  nodes { ... on Issue { number title body state url } }
}
```

Key capabilities:
- `in:title`, `in:body`, `in:comments` field targeting
- Quoted phrase matching (`"exact phrase"`)
- Boolean operators (AND implicit, up to 5 NOT operators)
- Up to 1,000 results via pagination
- Separate rate limit: 30 requests/minute (authenticated)

**What GitHub search does NOT support**: fuzzy matching, stemming, synonym expansion, or exposed relevance scores. It is keyword-based only.

### 2. Lightweight Similarity Libraries Exist

Several zero-dependency npm packages can provide text similarity scoring:

| Package | Size | Algorithm | TypeScript | Status |
|---------|------|-----------|------------|--------|
| `string-similarity-js` | ~700 bytes | Dice-Sorensen bigram | Has types | Active |
| `cmpstr` | Small | 11 metrics (Dice, Jaccard, Jaro-Winkler, Levenshtein, Cosine, etc.) | Native TS | Active (v3.2.1, Jan 2026) |
| `string-comparison` | Small | 7 metrics + `sortMatch()` | Has types | Less active |
| `tiny-tfidf` | Small | BM25 + cosine | No types | Stale (6 years) |

**DIY is also viable**: Dice-Sorensen coefficient is ~15 lines of TypeScript, Jaccard similarity is ~10 lines. Both are sufficient for title-to-title comparison.

### 3. Two-Phase Architecture is the Standard Approach

The standard pattern for duplicate detection without embeddings:

1. **Candidate retrieval**: Use GitHub search API to find keyword-relevant issues (narrows to ~20-50 candidates)
2. **Local similarity scoring**: Apply text similarity algorithms to rank candidates by score

This avoids comparing every issue against every other issue (O(n^2)) and keeps the search fast.

### 4. Claude Can Serve as the Semantic Layer

The MCP server cannot call back into the Claude conversation, but the *calling agent* (Claude Code) can perform semantic comparison after receiving structured candidate data. The optimal architecture:
- MCP tool returns ranked candidates with similarity scores and full text
- Claude (the triage agent) makes the final duplicate determination using its own reasoning
- This provides semantic understanding without embedding APIs

### 5. Anthropic Does Not Offer Embeddings

Anthropic recommends Voyage AI for embeddings. Adding an embedding API dependency (Voyage AI, OpenAI, etc.) would:
- Require an API key and network calls
- Add latency and a point of failure
- Add cost per token
- Be overkill for repos with <500 open issues

For the Phase 1 MVP, keyword retrieval + bigram similarity is sufficient.

### 6. No Existing Research on This Topic

No documents in `thoughts/shared/` address duplicate detection, similarity matching, or triage improvements for finding duplicates. This is a greenfield feature area.

## Potential Approaches

### Approach A: GitHub Search + Local Scoring (Recommended for MVP)

Add a `ralph_hero__find_duplicates` MCP tool that:
1. Extracts key terms from the target issue title (strip stop words, take top keywords)
2. Uses GitHub GraphQL `search` to retrieve keyword-relevant candidates
3. Applies Dice-Sorensen coefficient on titles for similarity scoring
4. Optionally applies Jaccard similarity on tokenized body text
5. Returns ranked candidates above a configurable threshold

**New dependency**: None (DIY similarity) or `string-similarity-js` (~700 bytes)

**Parameters**:
```typescript
{
  number: z.number(),           // Issue to check for duplicates
  threshold: z.number().default(0.4),  // Minimum similarity score
  max_candidates: z.number().default(10),
  include_closed: z.boolean().default(false)
}
```

**Response**:
```typescript
{
  issue: { number, title },
  candidates: Array<{
    number: number,
    title: string,
    url: string,
    state: string,
    workflowState: string,
    similarity: {
      title: number,    // 0-1 Dice coefficient on title
      body: number,     // 0-1 Jaccard on body tokens
      combined: number  // Weighted average
    }
  }>,
  search_query: string  // The GitHub search query used
}
```

**Pros**:
- Zero or minimal new dependencies
- Leverages GitHub's search for candidate retrieval
- Fast execution (1 search API call + local computation)
- Returns structured data for Claude to make final judgment
- Works without external embedding APIs

**Cons**:
- Keyword-based, not truly semantic
- Misses duplicates with completely different wording
- Dice-Sorensen works best on titles, less effective on long body text

### Approach B: Multi-Algorithm Scoring with `cmpstr`

Same as Approach A but uses the `cmpstr` package for multiple similarity metrics (Dice, Jaro-Winkler, Cosine, Jaccard). Returns multiple scores so the calling agent can make nuanced decisions.

**New dependency**: `cmpstr` (zero transitive deps, native TypeScript)

**Pros**:
- Multiple algorithms catch different types of similarity
- Jaro-Winkler is optimized for short strings (titles)
- Cosine similarity handles word-frequency patterns in body text

**Cons**:
- Slightly more complexity in the response structure
- Marginal improvement over single-algorithm approach for typical issue titles

### Approach C: Embedding-Based Semantic Matching (Phase 2)

Add Voyage AI or OpenAI embedding API integration for true semantic similarity:
1. Generate embeddings for all existing issue titles/bodies
2. Store embeddings in SessionCache (session-scoped) or SQLite (persistent)
3. Compute cosine similarity between new issue and existing embeddings
4. Return semantically similar issues regardless of wording

**New dependencies**: `openai` or Voyage AI SDK, optionally `better-sqlite3`

**Pros**:
- True semantic matching (catches "auth flow" ~ "login system")
- Higher accuracy for non-obvious duplicates
- Industry-standard approach

**Cons**:
- External API dependency (API key, network, cost)
- Latency (~500ms per embedding call)
- Storage complexity (embeddings per issue)
- Breaks stateless MCP server design
- Overkill for most repos (<500 issues)

### Approach D: Claude-as-Judge Pattern

Don't build similarity scoring in the MCP tool at all. Instead:
1. MCP tool fetches all open issues (via `list_issues`)
2. Returns issue titles and summaries to the calling agent
3. Claude (the triage agent) uses its own reasoning to identify duplicates

**Pros**:
- Zero new code or dependencies
- True semantic understanding
- Already partially implemented (current triage behavior)

**Cons**:
- Token-intensive (must send all issue titles/bodies to Claude)
- Slow for large backlogs (100+ issues)
- Non-deterministic (Claude might miss duplicates across sessions)
- No structured scoring for automation

## Triage Skill Integration

Regardless of approach, the triage skill should be updated to:
1. **Auto-run duplicate check** as the first step of triage (before assessment)
2. **High confidence (>0.9 combined score)**: Auto-close with reference comment
3. **Medium confidence (0.5-0.9)**: Present candidates to agent for judgment
4. **Below threshold (<0.5)**: Proceed with normal triage

The skill update involves adding a `find_duplicates` call at the beginning of Step 2 and handling the results in the assessment logic.

## Risks and Considerations

1. **False positives**: Aggressive thresholds could auto-close valid issues. The default threshold should be conservative (0.4 for flagging, 0.9+ for auto-close) and let Claude make the final call.

2. **GitHub search rate limits**: Search API has a separate 30 req/min limit. A single `find_duplicates` call uses 1 search request, so this is not a concern unless called repeatedly in rapid succession.

3. **Issue body length**: GitHub search queries are limited to 256 characters. Keyword extraction from long issue bodies must be selective (top 3-5 terms from title, optionally 2-3 from body headings).

4. **Closed issue handling**: Duplicates of closed issues are still valuable to detect (the issue may have been resolved differently). The `include_closed` parameter should default to `false` but be available.

5. **Scale**: For repos with 1000+ issues, the GitHub search pre-filtering ensures only ~20-50 candidates need local similarity scoring. The O(n) local scoring step is negligible.

6. **Estimate mismatch**: This issue is estimated as L (Large), which is appropriate given Phase 1 (keyword + scoring tool) + Phase 2 (triage integration) + tests. However, the MVP (Phase 1 tool only) could be implemented as an S/M.

7. **NPM publish required**: Adding the new tool requires a new version of `ralph-hero-mcp-server`.

## Recommended Next Steps

1. **Phase 1 (MVP tool)**: Create `ralph_hero__find_duplicates` MCP tool using GitHub GraphQL `search` for candidate retrieval + Dice-Sorensen coefficient for title similarity scoring. Either implement the ~15-line algorithm inline or add `string-similarity-js` (~700 bytes). Place in `issue-tools.ts` alongside other issue tools.

2. **Phase 2 (Triage integration)**: Update `ralph-triage/SKILL.md` to call `find_duplicates` as the first step of assessment. Add decision logic for auto-close (>0.9) vs. flag-for-review (0.5-0.9) vs. proceed (<0.5).

3. **Phase 3 (Tests)**: Unit tests for similarity scoring logic, integration tests with mocked GitHub search responses.

4. **Future (Phase 2 from issue)**: If keyword-based detection proves insufficient, evaluate embedding-based approach with Voyage AI. This would require architectural decisions about storage and API key management.
