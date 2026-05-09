---
description: Curate the personal wiki tier — the third memory tier above raw and reflection. Iterates through atomic axiom candidates one at a time, fact-checks each against the corpus, external sources, and code, applies governance gates (outside-code-surface, atomicity, lede-writability, MUSTIE, domain freshness), and presents fully-evidenced candidates for the user to gate y/n/edit. Use whenever the user mentions "curate the wiki", "promote to wiki", "find canonical entries", "add to my wiki", "wiki tier", "wiki axioms", or wants to grow their thoughts/wiki/ directory. Also trigger when the user wants to distill recurring patterns from their thoughts/ corpus into canonical entries, synthesize reflections into wiki-grade material, or when they ask to "find atomic axioms" in their notes. The wiki resists growth — the gate is biased toward rejection.
argument-hint: "[domain]"
---

# Curate the personal wiki tier

This skill is the human-gated curator for the third memory tier — the personal wiki at `~/projects/thoughts/wiki/`. It iterates one atomic axiom at a time: hunt → distill → fact-check → gate → write or log. Most candidates are rejected. That's the system working.

The companion infrastructure: raw memories live at `~/projects/thoughts/dream-memories/`, reflections at the same path under `reflections/`. The wiki sits above both as the user-curated canonical layer.

## When to use this skill

Trigger when the user wants to grow their personal wiki: "curate the wiki", "promote axioms", "find canonical entries", "add to my wiki", "let's add wiki entries about X". Also trigger when they ask to distill recurring patterns from their notes corpus into atomic claims.

## When NOT to use this skill

- **Documenting our own code's behavior** — the code is the truth, the wiki should not shadow it. Use CLAUDE.md, code comments, or in-repo docs instead.
- **Bulk imports** — never bulk-promote. The "attention is sacred" principle applies to curation decisions themselves; one axiom per iteration.
- **Capturing fleeting notes** — that's what the raw tier is for. Use `/ralph-hero:draft` or `/ralph-hero:form`.
- **Drafting research or implementation plans** — different surface entirely.

## Prerequisites

The `knowledge_search` MCP tool from ralph-knowledge must be available. If it's not, tell the user the ralph-knowledge MCP server isn't connected and direct them to `/ralph-knowledge:setup`.

The wiki directory `~/projects/thoughts/wiki/` should exist. If it doesn't, create it with a single `mkdir -p` before the first iteration.

## The governance rule (load-bearing)

**The wiki is for knowledge whose source of truth lives outside the code surface we operate on.** If the truth is in code we maintain, do not promote — that creates duplication that drifts. The operational test:

> "If I needed to know this tomorrow, would I `grep` our repo or look it up externally?"

If the answer is `grep` → reject as code-shadow. If the answer is "look it up" (external docs, library quirks, info-science principles, personal heuristics not encoded anywhere) → promotable.

**Eligible domains**: external platform behavior (Claude Code, GitHub API, library quirks), information science / cognitive science principles, personal design heuristics not encoded in code, decisions about external constraints.

**Ineligible domains**: our state machines, our MCP tool implementations, our sync logic, our configurations — anything reachable by `grep` in our own repos.

## The workflow

### Step 1: Receive the domain

If a domain argument was passed (`/ralph-knowledge:curate cognitive-science`), use it as the search scope. Otherwise, ask the user once which domain to scope to. Examples of useful domains:

- Information science / curation / knowledge management
- Cognitive science / attention / productivity
- External platform behavior (Claude Code, GitHub, library quirks)
- Personal engineering heuristics
- Design principles / UX patterns

Scope matters: searching unscoped over a 3000+ document corpus dilutes the signal. Insist on a domain.

### Step 2: Hunt for candidates

Use `knowledge_search` (semantic) plus `knowledge_central` (find central documents in communities) to surface 5–10 candidate atomic axioms within the chosen domain.

A candidate is high-signal if it:
- States a principle in declarative form ("X must Y", "always X", "never X", "the rule is")
- Recurs across 3+ documents (corroboration is the strongest durability signal)
- Is prescriptive, not descriptive (a rule, constraint, or heuristic — not "here's what we did")
- Appears durable: not tied to a specific date, project name, or version

Read existing wiki entries from `~/projects/thoughts/wiki/*.md` and the rejection log `~/projects/thoughts/wiki/_rejected.jsonl` before presenting. **Skip any candidate that's already covered by an existing entry** (orthogonality) **or already in the rejection log** (don't re-propose what was already rejected).

Output of this step: a ranked candidate list, ordered by promotability. Keep it internal — do not show it to the user as a bulk list.

### Step 3: Distill the atomic claim

For the top candidate:

1. Extract ONE declarative sentence in your own words — not the original quote
2. Reject if compound (contains "and also", multiple verbs, or two ideas)
3. Reject if context-dependent (can't stand alone without referring back to the source doc)

If the top candidate fails distillation, drop it and try the next one. Don't "rescue" weak candidates by editing aggressively — most candidates fail. That's normal.

### Step 4: Fact-check via three lenses

Apply lenses conditionally based on claim type:

**Lens 1 — Corpus consistency (always)**: Vector-search for corroborating + contradicting passages across the user's thoughts/ corpora. List corroborating documents and any contradicting passages. **Surface contradictions explicitly** — they're load-bearing.

**Lens 2 — External validity (only for empirical / platform claims)**: For claims about external systems, libraries, APIs, or platform behavior, dispatch a research agent or use WebSearch / WebFetch to consult authoritative sources. For Claude Code questions specifically, dispatch the `claude-code-guide` agent (it has direct docs access).

**Lens 3 — Code consistency (only for project-convention claims)**: If the claim references project conventions, grep current code to verify the claim still matches reality. If the code has drifted from the claim, surface the drift; don't promote a stale claim.

Compute a confidence rating: **high** (3+ corroborating, 0 contradicting, external/code agree), **medium** (some corroboration, no contradictions, no external check possible), **low** (single source, or contradictions present).

### Step 5: Apply governance gates (fail-fast)

Run the candidate through these gates in order. Stop at the first failure and move to the next candidate.

1. **Outside-code-surface gate**: Apply the `grep` test. If our code is the truth → reject as code-shadow.
2. **Atomicity**: One concept, one sentence. No "and also". No compound clauses.
3. **Lede-writable**: Can you write a single first sentence that fully answers the entry's title question and stands alone without context? If not → reject.
4. **MUSTIE in reverse**: Not Misleading (factually wrong/dated), Ugly (malformed), Superseded (newer source covers it better), Trivial (not consequential), Irrelevant (out of wiki scope), or Elsewhere-obtained (the classic CREW criterion — knowledge already adequately answered by an external authoritative source the user can reach in one hop, OR reachable by `grep` in our own repos; this is the same test as the outside-code-surface gate but applied symmetrically to external sources too). Orthogonality within the wiki itself (no near-duplicate of an existing entry) is enforced separately at the candidate-hunt step (Step 2) — read existing entries' bodies and `## Implications` sections, not just titles.
5. **Domain freshness**: Don't promote a candidate from the same conceptual domain as the previous 2 entries. The wiki should have a varied diet; three+ similar entries in a row dilute it. (Inspect the most recent entries in `~/projects/thoughts/wiki/` by date to apply this gate.)

Surviving candidates proceed to presentation. If no candidates survive, tell the user and ask whether to re-hunt with a different domain or stop.

### Step 6: Present to the user

Show the candidate with all the work visible. Use this exact structure (the outer fence is four backticks so the inner three-backtick fence around the proposed entry renders correctly):

````markdown
## Candidate axiom #N

**Proposed claim**: [single declarative sentence]

### Verification: [HIGH | MEDIUM | LOW] confidence

**Source of truth**: [where the claim's truth lives — external docs, library, principle, user's stated stance]

**Corpus support** (N corroborating):
- path/to/file.md:LINE — short paraphrase or quote

**Corpus contradictions** (N — surfaced explicitly):
- path/to/file.md:LINE — what the contradiction is, [why the candidate is still right]

**External validation** (if applicable):
- [docs link] — what it confirms

**Code consistency** (if applicable):
- file.ts:LINE — code matches/diverges from claim

### Gate checks

| Check | Result |
|---|---|
| Atomicity | PASS / FAIL |
| Lede-writable | PASS / FAIL |
| MUSTIE | PASS / FAIL — reasoning |
| Durability | HIGH / MEDIUM / LOW |
| Scope | universal / personal / project/X |
| Outside-code-surface | PASS / FAIL |
| Domain freshness | PASS / FAIL |

### Proposed wiki entry

```markdown
[full proposed entry including frontmatter and body]
```

### Side-effects (if approved)

- [list any memory updates, doc corrections, related-link additions, etc.]

---

**Promote #N to wiki?** `y` / `n` / `edit`
````

Show every check, every source. The user's gate decision should be informed by all the evidence, not a summary.

### Step 7: Handle the gate response

**On `y`**:
1. Write the entry to `~/projects/thoughts/wiki/<slug>.md` — slug is a kebab-case version of the title, no stop words
2. Apply any side-effects (memory updates, related-link additions to other wiki entries) — show what's changing
3. Append to a session log so subsequent iterations know what was added
4. Move to next candidate

**On `n`**:
1. Append to `~/projects/thoughts/wiki/_rejected.jsonl` — JSONL format, one line per rejection
2. Move to next candidate

**On `edit`**:
1. Ask the user what to change (claim wording, scope, body structure)
2. Re-apply gates after edit (atomicity, lede-writable can fail after editing)
3. Re-present for final y/n

After any of the three responses, move to the next candidate. Continue until: candidates exhausted, user says `stop`, or 5 promotions in this session (cap to keep the wiki disciplined).

## Wiki entry frontmatter spec

```yaml
---
memory_tier: wiki
date: YYYY-MM-DD
valid_from: YYYY-MM-DD
invalid_at: null
review_cadence: quarterly | monthly | weekly
scope: universal | personal | project/<name>
tags: [comma, separated, kebab-case]
related:                    # optional
  - other-entry-slug.md
provenance:                 # optional but recommended
  - source: URL or path
    role: authoritative | corroborating
supersedes:                 # optional, when entry corrects a stored belief
  - file: path/to/superseded.md
    reason: short reason
---
```

Notes:
- `valid_from` is when the supporting evidence first accumulated, not when you wrote the entry. Often same as `date` for new entries; can be earlier if backfilling.
- `invalid_at` stays `null` until the entry is retired. **Never delete entries** — close them by stamping `invalid_at` with the date.
- `review_cadence` choices: `quarterly` for stable platform/library facts and info-science / cognitive principles, `monthly` for practices that evolve, `weekly` for fast-moving areas (e.g., model performance, library betas).
- `scope`: `universal` (true for anyone), `personal` (the user's stated heuristic), `project/<name>` (true within a specific project's context).

## Wiki entry body structure

Hard rules (the "attention is sacred" contract):

1. **Lede sentence**: First sentence ≤ ~25 words, fully answers the title's question, stands alone. This is what gets returned by default in retrieval.
2. **Body**: 150 words hard cap. If you exceed, the entry is too big — split or simplify.
3. **`## Implications`**: Up to 5 bullets. If you need more than 5, you're packing too much; cut to the most durable.
4. **`## Sources`**: Required if external. Links and file:line references for corpus citations.
5. **No emojis**, no decorative formatting. Functional structure only.

Example structure:

```markdown
# [Title — declarative form, the axiom itself]

[Lede sentence answering the title's question completely.]

## Implications
- [bullet 1]
- [bullet 2]
- [bullet 3]

## Sources
- [authoritative source]
- [corroborating source]
```

## Side-effect handling

When an approved entry **contradicts** an existing memory, doc, or piece of CLAUDE.md content, the side-effect is to update those sources. The skill should:

1. **Identify** the contradicted source during fact-check (it appears in the "Corpus contradictions" section)
2. **Propose** a specific edit to the contradicted source — show the exact diff
3. **Ask** "Apply this side-effect too? `y/n`" before making the edit
4. **Apply** if confirmed; record `supersedes:` frontmatter on the new wiki entry

This was the load-bearing pattern from the original iteration: the first wiki entry corrected an existing auto-memory, and the wiki entry's `supersedes:` field made the supersession explicit. Don't skip this step — it keeps the user's other knowledge surfaces consistent with their canonical wiki.

## Rejection log format

`~/projects/thoughts/wiki/_rejected.jsonl` — JSONL, append-only, one rejection per line:

```json
{"date": "YYYY-MM-DD", "claim": "the proposed atomic claim", "reason": "concrete reason — code-shadow / repetitive / failed atomicity / etc.", "candidate_source": "where the candidate came from"}
```

Read this file before each hunt to skip already-rejected claims (recurrence within a session is fine; recurrence across sessions wastes the user's attention).

## Domain re-hunt

When the original candidate list is exhausted but the user wants to continue, ask whether to:
- **Re-hunt with a different domain**: cleaner pivot, better signal
- **Re-hunt the same domain with different seed terms**: useful if the first hunt missed angles
- **Stop**: a session that produces 0–2 entries is fine — the wiki resists growth

Never auto-rerun. The user's attention is the gating resource.

## Hard constraints

- **Never auto-promote.** The skill surfaces and fact-checks; the user gates. Fully automated promotion recreates the collector's fallacy at speed.
- **Never bulk-propose.** One candidate per turn. The "attention is sacred" rule applies to the curation decision itself.
- **Never skip fact-checking.** Surfacing a candidate without verification wastes the user's gate decision.
- **Never edit the wiki without explicit approval.** Even side-effects are gated.
- **Never delete entries.** Use `invalid_at` to close.

## Reference design

The original design rationale, MUSTIE framework treatment, fact-checking lens taxonomy, anti-patterns, and the open questions that informed the governance rule live at:

- `~/projects/ralph-hero/thoughts/shared/research/2026-05-06-personal-wiki-curator-design.md`

Read this if you need deeper reasoning on why a particular gate exists or how to handle an edge case the workflow doesn't cover.
