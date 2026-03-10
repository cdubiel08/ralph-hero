## Knowledge Graph Metadata

Documents in the `thoughts/` tree are indexed by the knowledge graph, making them discoverable via `knowledge_search` and `knowledge_traverse`. Include these fields so your output is findable by future sessions.

### Required Frontmatter Fields

| Field | Purpose | Valid Values / Example |
|-------|---------|----------------------|
| `type` | Enables filtering by document kind | `research`, `plan`, `review`, `idea`, `report` |
| `tags` | Enables topic-based search and filtering | `[mcp-server, caching, graphql]` |

Plan documents should also include `github_issue` (singular integer) for indexer linking:

```yaml
github_issue: 123        # singular — for the knowledge indexer
github_issues: [123, 124] # array — existing plan convention
```

Set `github_issue` to the same value as `primary_issue` in the frontmatter.

### Choosing Tags

- Pick 2-5 tags describing the document's subject matter
- Use existing tags when possible (check similar documents)
- Prefer specific component names over generic terms (e.g., `graphql-client` over `api`)
- Include the primary technology or domain

### Prior Work Section

Research and plan documents should include a `## Prior Work` section after the `# Title`, before the first content section. This creates navigable edges in the knowledge graph.

Syntax:
```markdown
## Prior Work

- builds_on:: [[related-research-filename-without-extension]]
- tensions:: [[document-this-disagrees-with]]
```

Populate from `thoughts-locator` results or `knowledge_search` during research. If no prior work exists, include the section with "None identified."
