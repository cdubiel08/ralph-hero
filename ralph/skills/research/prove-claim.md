# Prove-claim investigation

5-step evidence reasoning over the knowledge graph. Consulted by `/ralph:research --mode prove`. The skill does not write a doc — it produces an inline verdict report. Do not speculate beyond the documents.

## Evidence weighting

Before investigating, understand which document types carry what evidentiary weight:

| Type | Weight | Interpretation |
|---|---|---|
| `research` | Primary | Findings, prior art, discovered facts, decisions made. Strongest evidence of what is true or was decided. |
| `review` | Secondary | Post-implementation observations. May confirm or contradict plans. More reliable than plans for "did it work?" questions. |
| `plan` | Weak | Intended future state. A plan describing Feature X does NOT prove Feature X exists or works. Plans describe intent, not reality. |
| `idea` | Weakest | Unvetted proposals. May never have been acted on. Use only to establish that a concept was considered. |

Always qualify conclusions by the document type of the supporting evidence.

## Decomposition

Accept the claim as a string argument. Break it into 2-5 entities and the relationship to investigate.

- **Entities**: concept names, document topics, technical terms, or system components likely to appear in documents in the knowledge base.
- **Relationship**: what the claim asserts connects those entities (e.g., "A caused B", "A supersedes B", "A was decided because of B").

Write out:

```
Claim: [original claim]
Entities: [e1, e2, ...]
Relationship to investigate: [...]
Search terms per entity: [what to search for each]
```

## Step-by-step workflow detail

### Step 1: Decompose the claim

As above. Lock in entities + relationship before any search.

### Step 2: Find entity documents

For each entity:

1. `knowledge_search(query: "<entity>", brief: true)` — try a specific term first; if zero results, broaden to related concepts.
2. Record the top 3 document IDs per entity. Prefer `research` and `review` over `plan` and `idea` at similar relevance.
3. If an entity produces zero matches after two attempts with different terms, note *"no documents found for [entity]"* and continue — this factors into the confidence score.

### Step 3: Find connections

For each pair of entity documents:

1. `knowledge_paths(source, target)` — assess path quality. A path through topically relevant docs is stronger than one through generic hub nodes. Shorter relevant paths beat longer ones.
2. `knowledge_traverse(start_doc, depth: 3, types: [builds_on, tensions, superseded_by])` from each entity doc in both `outgoing` and `incoming` directions — find direct typed connections.
3. `knowledge_common(doc_a, doc_b)` — shared neighbors. Bridge documents that may explain the relationship.

### Step 4: Read evidence

Select the top 3-5 documents from the strongest paths and connections.

For each selected document:

1. `Read` the file at the `path` field from search results. Retrieve full content.
2. Extract specific quotes that directly support or contradict the claim. Quotes must be verbatim, not paraphrased.
3. Note the doc's type, date, and any status field (draft / approved / complete / superseded).

Cap at 5 documents. If the top docs are all `plan` type, note the evidence weakness explicitly.

### Step 5: Report

Produce the structured verdict report. Do not speculate beyond the evidence. If evidence is sparse, say so.

## Confidence calibration

| Range | Meaning | Typical evidence profile |
|---|---|---|
| 0.8 – 1.0 | High | Multiple corroborating `research` documents with direct quotes; typed edges directly linking the entities; no contradicting documents found |
| 0.5 – 0.7 | Medium | Some supporting evidence but gaps; key support from `review` or indirect paths; one weak contradicting signal |
| 0.2 – 0.4 | Low | Sparse evidence; support mostly from `plan` or `idea` documents; long indirect paths; no direct typed relationships |
| 0.0 – 0.1 | Insufficient | No meaningful evidence found; all entity searches failed; paths exist but intermediary documents are topically unrelated to the claim |

## Anti-patterns

1. **Community co-membership is not evidence.** Two documents appearing in the same Louvain community means they are structurally nearby in the graph — not that they are semantically related to the claim. Always read the actual documents.
2. **Hub-node paths are weak.** If a path between two entity documents passes through a document with many connections (high betweenness), the path may be incidental. Prefer paths through documents whose titles and content are topically relevant.
3. **Plan documents are not proof of reality.** A `plan` describing "Feature X will be implemented using approach Y" is evidence of intent, not outcome. Do not conclude Feature X works that way unless a `research` or `review` document confirms it.
4. **Path existence is not evidence.** Finding a graph path between A and B does not confirm the claim. Read the documents on the path and verify the connection is semantically relevant.
5. **Paraphrase is not evidence.** Only verbatim quotes from document content count. Summaries from search results are discovery aids, not proof.

## Graceful degradation

- **Graph-algorithm tools unavailable** (`knowledge_paths` / `knowledge_common` return tool-not-found): fall back entirely to `knowledge_traverse` with `builds_on`/`tensions`/`superseded_by` at depth 3 from each entity document. Supplement with `knowledge_search` using combined entity terms (e.g., `"entity1 entity2"`). Note in the report: *"Graph path analysis unavailable — results based on typed relationship traversal only."*
- **Brief mode unsupported** (`brief: true` parameter rejected): proceed with full content results but cap each entity search at 5 results to manage context. Read titles and dates from results before deciding which to read in full.
- **Entity searches return zero documents**: try 2-3 alternative search terms (synonyms, related concepts, abbreviated names). If still nothing: note the entity as *"not found in corpus"* and explain what was searched. Do not invent connections to compensate for missing documents — report *"insufficient evidence"*.
- **Paths exist but intermediaries are unrelated**: report these paths as structurally present but semantically weak. Do not count path existence toward confidence; count only after reading and confirming relevance.

## Report template

```markdown
## Claim Investigation Report

**Claim**: [original claim]

**Verdict**: [supported | contradicted | partially supported | insufficient evidence]

**Confidence**: [0.0 – 1.0] — [brief calibration note]

### Evidence Chains

[For each supporting or contradicting piece:]
- **Document**: [title] ([type], [date]) — [path]
  > "[verbatim quote]"
  **Relevance**: [one sentence on why this quote bears on the claim]

### Document Type Qualifications

[Note if key evidence comes from weak document types:]
- [e.g., "The primary evidence is from plan documents, which describe intent not reality. No research documents confirm the outcome."]

### Graph Connection Summary

[Describe the structural relationship found — direct typed edge, multi-hop path, shared neighbors — and assess its strength relative to the claim.]

### Caveats

[List limitations: missing documents, failed searches, evidence gaps, alternative interpretations. Be specific.]

### What Would Change This Verdict

[State what additional evidence would shift the verdict and where it might be found.]
```
