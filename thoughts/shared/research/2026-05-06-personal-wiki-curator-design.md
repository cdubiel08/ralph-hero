---
date: 2026-05-06
status: complete
type: research
tags: [dream-loop, ralph-knowledge, personal-wiki, information-science, memory-tier, curator, fact-checking]
---

# Personal Wiki as Curator: Design Report for the Third Memory Tier

## Prior Work

- builds_on:: dream-loop infrastructure (raw + reflection tiers) — see `~/projects/CLAUDE.md` "ralph-knowledge dream-loop bootstrap"
- builds_on:: [[2026-04-26-dreaming-research-trail-and-self-containment]]
- builds_on:: GH-0761 dream-loop plan
- tensions:: Existing thoughts corpus is already large and pseudo-curated; the strict "wait for ~150 reflections" threshold from this report may not apply to a user who has been hand-writing research/plans/ideas for months.

## Problem Statement

The dream-loop today has two memory tiers: **raw** (everything ingested — git commits, gemma sessions, voice memos) and **reflection** (clustered synthesis written nightly by Gemma 4 26B). The user wants a third tier — a **curated personal wiki** — that sits above reflections.

Pain points driving the design:

1. **"Attention is sacred"** — when looking something up, the answer must be fast AND trustworthy. A wrong answer at 200ms is worse than no answer. A correct answer buried in 40 reflections is also failure.
2. **Curator, not collector** — the wiki should *resist* growth. Most reflections must NOT graduate. Need explicit promotion criteria.
3. **Fact-checker** — entries must have provenance and a mechanism to detect when they go stale or get contradicted by newer raw memories.

This document is the information-science-grounded research that should inform the design before any implementation begins.

---

## Top 5 Ideas to Pull Into the Design

### Idea 1: Apply the CREW/MUSTIE weeding standard to *promotion*, not just removal

Libraries have a battle-tested heuristic called [CREW (Continuous Review, Evaluation, and Weeding)](https://www.tsl.texas.gov/ld/pubs/crew/index.html), governed by the MUSTIE acronym: **M**isleading, **U**gly, **S**uperseded, **T**rivial, **I**rrelevant, **E**lsewhere-obtained. The insight worth stealing is that weeding is *continuous and scheduled*, not an annual event. More importantly, it is *symmetric*: the same criteria that trigger removal from a physical library are the criteria that should block promotion to your wiki in the first place.

Before promoting a reflection, run it through MUSTIE in reverse: is it *accurate*, *well-formed*, *not superseded*, *non-trivial*, *relevant to recurring decisions*, and *not already covered by an existing canonical entry*? This gives you a six-gate promotion checklist that takes five seconds per candidate and produces a defensible "no" 80% of the time — which is exactly what you want from a system that resists growth.

### Idea 2: Adopt Graphiti/Zep's edge-invalidation model as your provenance schema

The [Zep temporal knowledge graph architecture](https://arxiv.org/abs/2501.13956) (Jan 2025) uses bi-temporal modeling to track *when a fact was true* (`valid_time`/`invalid_time`) separately from *when it was recorded* (`created_at`/`expired_at`). When a new episode contradicts an old fact, the old edge gets `invalid_at` stamped — it is not deleted, it is *closed*.

This maps cleanly onto the existing pipeline: each wiki entry gets `valid_from` (when supporting evidence first accumulated) and `invalid_at` (null if still live). Nightly, the dream-loop's ingest step can flag contradictions between incoming raw memories and open wiki-entry claims. Far more tractable than full RDF reification or PROV-O — three timestamp columns per entry, not a new ontology. The [PAV ontology](https://pav-ontology.github.io/pav/) (Provenance, Authoring, Versioning) offers an even lighter-weight schema if you want named fields: `pav:createdOn`, `pav:lastUpdatedOn`, `pav:derivedFrom`.

### Idea 3: Borrow Google's knowledge-panel contract — one lede sentence that can stand alone

[Google's Knowledge Panels](https://www.nngroup.com/articles/key-serp-features/) and featured snippets operate on the principle that the answer to a well-formed question should be *completeable without a click*. The cognitive argument for this in personal retrieval is stronger than in web search: Gloria Mark's research found the average attention window on screens has collapsed to [47 seconds](https://gloriamark.com/attention-span/), and each interruption to look something up costs [23 minutes of recovery time from deep work](https://ics.uci.edu/~gmark/chi08-mark.pdf).

Wiki entries need a *contract*: the first sentence (the lede) must answer the question a future-you will ask in full. Everything below is context for the 10% of cases where you need more. This is a structural constraint, not a style suggestion — enforce in the promotion gate: a candidate cannot become a wiki entry unless it can be summarized as a single declarative sentence.

### Idea 4: Use Matuschak's "atomic + densely linked" test as a gate for entry scope

Andy Matuschak's [evergreen note principles](https://notes.andymatuschak.org/Evergreen_notes) prescribe that a note should be concept-oriented (one idea, one note), atomic (self-contained without its source context), and densely linked. The mistake most people make is conflating *topic pages* (broad, shallow) with *evergreen entries* (narrow, deep, connected).

For the wiki: a reflection about "my approach to GraphQL error handling in production" is promotable; a reflection titled "backend architecture thoughts" is not. The practical gate: if an entry would require a disambiguation page or contains the word "and" in its title concept, it is two entries or none. Apply mechanically. The [atomicity principle from Zettelkasten](https://zettelkasten.de/posts/concepts-sohnke-ahrens-explained/) adds a sharpness test: the entry is promotable when you can re-express it in your own words without referring back to the source.

### Idea 5: Treat the wiki as a "Map of Content" surface, not a flat store

Obsidian's [MOC (Map of Content) pattern](https://obsidian.rocks/maps-of-content-effortless-organization-for-notes/) draws a distinction between *index notes* (mechanical lists of links) and *MOC notes* (opinionated, curated entry-points that impose structure on a cluster of ideas). The wiki should contain mostly MOC-style entries — not encyclopedic articles but *navigational stances* that answer "what is my current understanding of X, and where do I look for the details?"

This keeps entries short (three to eight bullet points plus backlinks) and resilient to staleness, because the entry itself rarely contains facts — it contains pointers to the facts. The MOC entry on "memory pipeline design" might say: "I believe three tiers are right; see raw-ingest, reflection-clustering, and this wiki-entry. The key unsettled question is promotion criteria." That sentence won't go stale. The supporting detail lives in reflections.

---

## Promotion Criteria Menu

Concrete signals for "this reflection should become a wiki entry." Apply as a checklist; require a minimum of three "yes" answers:

- **Recurrence signal**: The same concept appears in three or more separate reflection clusters over different time windows. One-time insights are ephemeral; recurring ones are structural.
- **Decision dependency**: The knowledge is something you would want to look up *before making a consequential decision*, not after. (E.g., "which Gemma model variant is fastest for summarization" yes; "what the Gemma 4 changelog said in April 2026" no.)
- **Atomicity test**: The candidate can be expressed as a single non-compound sentence. Fails if it requires "and also."
- **Temporal durability**: The underlying fact is not expected to change on a weekly or monthly cadence. (Architecture preferences, yes. Library version numbers, no.)
- **Cross-context applicability**: The insight is useful across at least two different projects or problem domains, not just the current one. (Matuschak's "use in a completely different situation" test.)
- **Lede writability**: You can write the first sentence right now without looking anything up. If you can't, the cluster needs more raw evidence first.
- **No existing canonical entry**: An existing entry doesn't already cover the same ground. Duplication is a signal to *update* an existing entry, not create a new one.
- **MUSTIE pass**: Accurate, well-formed, not superseded by newer raw memory, non-trivial, relevant to your actual work, not better described elsewhere.

**Anti-criteria (auto-reject):**
- Contains a date reference that will make it false within six months
- Names a specific person in a non-pattern way (gossip, not insight)
- Describes a completed one-off decision ("we chose Postgres for project X in 2024")
- Was generated from a single raw-memory event with no corroboration

---

## Fact-Checking Mechanisms (Ranked by Effort vs Payoff)

### High payoff, low effort

- **Contradiction flag in nightly ingest**: During `ingest.py`, after embedding, do a cosine-similarity search against wiki-entry embeddings. If a new raw memory has similarity > 0.85 to an existing entry AND contains negating language ("actually", "turns out", "no longer", "deprecated", "changed"), append a `?contradicted_by` backlink to the entry and surface it in the next morning's summary. One SQL query + a regex.
- **`valid_from` / `invalid_at` timestamps on every entry**: Follow Zep's [bi-temporal edge model](https://arxiv.org/html/2501.13956v1). Never delete an entry; instead stamp `invalid_at` when closing it. A nightly report of entries with `invalid_at IS NULL AND valid_from < NOW() - interval '180 days'` is your review queue.
- **Source-link rot detection**: If an entry's provenance points to a reflection file, check the file still exists on disk. If the source was a URL, periodic `curl --head`. Dead sources downgrade an entry's trust level automatically.

### Medium effort, high payoff

- **Gemma-powered contradiction scan**: Once a week, pass each wiki entry plus topically-related raw memories from the past seven days (via vector search) to Gemma with the prompt: "Does any of this new evidence contradict or update the claim: [entry lede]? Answer yes/no and quote the contradicting passage if yes." Flag entries that get a "yes." One extra step in `reflect.py` or a new `audit.py`.
- **`review_cadence` field per entry**: Assign each entry to one of three cadences: `quarterly` (stable facts), `monthly` (practices that evolve), `weekly` (fast-moving areas like model performance). Nightly pipeline checks if overdue and surfaces. Modeled loosely on Wikipedia's [article assessment cycles](https://en.wikipedia.org/wiki/Wikipedia:Verifiability).
- **"Assertion inventory" per entry**: Enumerate the explicit factual claims in an entry (numbered sentences). Each claim gets its own `last_verified` date. Wikipedia's verifiability discipline applied at granularity of the claim, not the page.

### Higher effort, conditional payoff

- **Full PAV/PROV-O provenance trail**: Track `pav:derivedFrom` (which reflection cluster), `pav:createdOn`, `pav:importedFrom` (which raw memory files). Worth doing if you plan to query provenance in the MCP layer for ranking. Overhead: add three columns to the wiki entries table and populate at promotion time.

---

## Speed/Accuracy Patterns (Enforcing "Attention is Sacred")

- **Lede-first contract (mandatory)**: Every wiki entry begins with one declarative sentence that fully answers its title's question. No context, no hedging. The lede is what gets returned by default in MCP tool responses. The full entry body is only surfaced on explicit request. Featured-snippet pattern applied to personal retrieval — [NN/G's research](https://www.nngroup.com/articles/key-serp-features/) shows users satisfy informational queries from SERP features without clicking through when the answer is complete at a glance.
- **Confidence tier in retrieval response**: Return not just the entry but a `confidence` field: `canonical` (entry exists, `invalid_at IS NULL`, no contradiction flag), `stale` (entry exists but overdue or has contradiction flag), `absent` (no wiki entry — return top two reflections instead, labeled as such). "I don't know" is a first-class response; returning a stale reflection as if it were canonical is the failure mode you're optimizing against.
- **Hard entry-length limit**: Cap wiki entries at 150 words of body text (not counting backlinks). Entries that exceed this are not edited — they are *split*. Length is inversely correlated with lookup speed and directly correlated with staleness surface area.
- **No lists longer than five items**: A list of seven "considerations" is not a wiki entry; it is an unfinished reflection. Force the author (you, or the promotion pipeline) to synthesize the list into a sentence or cut to the three most durable items.
- **Two-second rule for the MCP tool**: The `ralph_hero__` tool that queries the wiki should return in under two seconds. If it doesn't, you'll stop using it under time pressure. This means the wiki lives in the same SQLite database as reflections, with a dedicated `memory_tier=wiki` value and a pre-built FTS index on entry titles and ledes.
- **"No result" beats wrong result**: The MCP layer should never silently fall back from wiki to reflections without marking the degradation. If a wiki query returns nothing, say so, and surface the best two reflections with their tier labeled. The user then decides whether to trust the lower-tier answer.

---

## Anti-Patterns to Avoid

Documented failure modes of personal knowledge systems — particularly relevant because most "second brain" collapses are caused by growth, not gaps.

- **The Collector's Fallacy** (Christian Tietze at [zettelkasten.de](https://zettelkasten.de/posts/concepts-sohnke-ahrens-explained/)): Capturing information feels like learning it. The wiki becomes a graveyard of promoted-but-never-used entries. Counter-measure: an entry with zero lookup events in 90 days gets automatically flagged for demotion back to reflection.
- **Hierarchical rot**: Starting with folders or categories that later become structurally wrong. Every note in the wrong folder is harder to find than a note with no folder. The [Dendron team calls this](https://blog.dendron.so/notes/072ed07tikrhv6e4ilwcv2q/) "the hierarchy trap." Use flat namespace + tags + backlinks, not folder hierarchies, for the wiki tier.
- **Promoting decisions, not insights**: A decision made in a specific context ("chose Redis for project X for reason Y") is not a wiki entry. A pattern that generalizes from that decision ("Redis is preferable over Memcached when TTL-per-key granularity matters") is. The test: strip all project names and dates from the entry. If it still makes sense, it's promotable.
- **Letting the pipeline drive the wiki**: Automated promotion from reflections without a human gate produces an automated version of the collector's fallacy. The pipeline should *surface candidates* and *score them*, but a human (even a 10-second "yes/no" decision) should trigger promotion. Fully autonomous promotion contradicts the stated goal of a curator, not a collector.
- **Stale provenance chain**: An entry citing a reflection that no longer exists (because you moved or renamed the dream-memory file) silently loses trustworthiness. Enforce referential integrity at promotion time. If the source file is gone, the entry is unverifiable and should be flagged.
- **Treating the wiki as a writing project**: The [common second-brain failure](https://medium.com/@BitsOfChris/self-organizing-second-brain-how-i-manage-information-overload-2266bd0d9e27) is spending more time on the system than on actual work. The wiki should be a lookup surface, not a creative writing exercise. Time-box entry writing to 90 seconds. If you can't write the lede in 90 seconds, the cluster is not ready.

---

## Governance Rule (Decided 2026-05-06 During First Iteration)

**The wiki is for knowledge whose source of truth lives outside the code surface we operate on.** If the code we maintain is the truth, do not promote facts about it — that creates duplication that drifts. Internal product documentation belongs in CLAUDE.md, code comments, and in-repo docs; the wiki is for things you genuinely cannot `grep` your way to.

**Eligible**: external platform behavior (Claude Code, GitHub API), library quirks, information science principles, personal design heuristics, lessons from external constraints.

**Ineligible**: ralph-hero internal architecture, our state machines, our MCP tool behavior, our sync logic, our configurations — read the code.

**Operational test**: "If I needed to know this tomorrow, would I `grep` our repo or look it up externally?" If grep → reject. If external → promotable.

This rule supersedes the looser "atomic axiom from the corpus" framing. The first three candidates of the first iteration revealed the issue: candidate #3 (ralph-hero Status sync is unidirectional) was technically true and well-corroborated, but its source of truth lives in `workflow-states.ts` — promoting it would shadow the code. Rejected.

---

## Open Questions (Decide Before Building)

These are design forks with no correct answer without your call. Don't let the pipeline decide implicitly.

1. **Who triggers promotion?** Three models: (a) fully automated pipeline based on scored signals, (b) pipeline surfaces candidates, human approves with a single keystroke, (c) human-only promotion (pipeline does nothing). Model (a) recreates the collector's fallacy at speed. Model (c) will be abandoned within two weeks. Model (b) is the safest default — but requires defining what a "promotion UI" looks like in your tooling.

2. **What is the demarcation between a wiki entry and a reflection?** Specifically: can a reflection *become* a wiki entry (promotion is a tier change on the same document), or does promotion *create a new document* (the reflection stays as-is and a new wiki entry is derived)? The copy-on-promotion model preserves provenance and lets the entry diverge from the source; the in-place-upgrade model is simpler but risks losing the original synthesis.

3. **How do you handle entries that are true but context-dependent?** E.g., "Gemma 4 26B is fastest for summarization" is true in May 2026 on your hardware at your quantization level. The wiki entry is not universally true — it is true *for you, now*. Do entries carry a `scope` field (personal, team, universal)? If not, you will silently serve locally-true answers as if they were globally true.

4. **What is the retention policy for invalidated entries?** When `invalid_at` is stamped, does the entry remain queryable (returned with a "stale" badge), get demoted to reflection tier, or become fully archived (not returned by default)? Affects whether historical queries are possible and how much cognitive noise stale entries add.

5. **What is the minimum corpus size before the wiki is useful?** Building the wiki-entry writing habit before there are enough reflections to draw from is premature optimization. A rough threshold: the wiki tier probably should not exist until the reflection tier has at least 150 entries across at least six months of nightly runs. Before that, the reflection tier is your canonical tier. **However**, this threshold assumes the dream-loop reflection tier is the *only* source. If the existing hand-written `thoughts/shared/` corpus (research, plans, ideas across all repos — ~3200 documents as of 2026-05-06) is treated as an alternate source, the threshold may already be met via that path. See "Bootstrap Path" below.

---

## Bootstrap Path: Existing Thoughts Corpus as a Pre-Filled Reflection Tier

(Added 2026-05-06 after corpus inventory.)

The original "150 reflections / 6 months" threshold was framed assuming the dream-loop is the *only* source feeding the wiki. The current state is more nuanced:

| Source | Count (2026-05-06) | Notes |
|---|---|---|
| Dream-loop raw memories | 17 | Spans 2026-04-26 → 2026-05-02 |
| Dream-loop reflections | 4 | All from a single day (2026-05-03) |
| `~/projects/thoughts/` (global) | 453 .md | Hand-written |
| `ralph-hero/thoughts/` | 1013 .md | Hand-written |
| `landcrawler-ai/thoughts/` | 1336 .md | Hand-written |
| `ralph-engine/thoughts/` | 396 .md | Hand-written |

The dream-loop reflection tier is far below threshold (4, needs ~150). But the user has been hand-writing research/plans/ideas for months — these are *already* a form of curated synthesis, just unstructured for fast lookup.

Two viable paths forward:

**Path A — Wait for dream-loop maturation.** Run the loop nightly; revisit wiki tier when reflections cross ~150 across ≥3 months. Conservative, low-bootstrap-cost, but means months of waiting. The wiki tier exists nowhere during that window.

**Path B — Bootstrap from existing thoughts corpus.** Treat hand-written `thoughts/shared/research/` and `thoughts/shared/plans/` as an alternate "reflection-equivalent" source. Build the wiki tier infrastructure now (schema, MCP tool, lede-first contract, MUSTIE gate), seed with a small handful (5–10) of high-confidence promotions hand-picked from existing thoughts, and let both the dream-loop and manual promotion feed it over time. The risk: existing thoughts are not atomic in the Matuschak sense — they are long-form research docs. Most will fail the lede-writability gate. This is a feature, not a bug — it surfaces which existing docs are actually canonical-grade.

Recommendation: **Path B with discipline**. Build the infra; seed with no more than 10 entries from existing thoughts; require all 10 to pass the full MUSTIE gate AND lede-writability AND atomicity test. If fewer than 5 pass the gate, defer to Path A — the wiki tier isn't ready and seeding it with weak entries will train the wrong habits.

---

## Sources

- [Fleeting to Permanent notes — Zettelkasten Forum](https://forum.zettelkasten.de/discussion/3142/fleeting-to-permanent-notes)
- [From Fleeting Notes to Project Notes — Zettelkasten.de](https://zettelkasten.de/posts/concepts-sohnke-ahrens-explained/)
- [Evergreen notes — Andy Matuschak](https://notes.andymatuschak.org/Evergreen_notes)
- [Evergreen note-writing as fundamental unit of knowledge work — Andy Matuschak](https://notes.andymatuschak.org/Evergreen_note-writing_as_fundamental_unit_of_knowledge_work)
- [The Cost of Interrupted Work: More Speed and Stress — Gloria Mark, CHI 2008 (PDF)](https://ics.uci.edu/~gmark/chi08-mark.pdf)
- [Attention Span — Gloria Mark](https://gloriamark.com/attention-span/)
- [Three Key SERP Features: Featured Snippets, People Also Ask, and Knowledge Panels — NN/G](https://www.nngroup.com/articles/key-serp-features/)
- [Progressive Disclosure — NN/G](https://www.nngroup.com/articles/progressive-disclosure/)
- [Wikipedia: Verifiability](https://en.wikipedia.org/wiki/Wikipedia:Verifiability)
- [Zep: A Temporal Knowledge Graph Architecture for Agent Memory (arxiv, Jan 2025)](https://arxiv.org/abs/2501.13956)
- [Zep Temporal Knowledge Graph Architecture — Graphiti GitHub](https://github.com/getzep/graphiti)
- [PAV Ontology — Provenance, Authoring and Versioning](https://pav-ontology.github.io/pav/)
- [PROV-O: The PROV Ontology — W3C](https://www.w3.org/TR/prov-o/)
- [CREW: A Weeding Manual for Libraries — Texas State Library](https://www.tsl.texas.gov/ld/pubs/crew/index.html)
- [Collection Maintenance and Weeding — ALA](https://www.ala.org/tools/challengesupport/selectionpolicytoolkit/weeding)
- [Maps of Content: Effortless organization for notes — Obsidian Rocks](https://obsidian.rocks/maps-of-content-effortless-organization-for-notes/)
- [The PARA Method — Forte Labs](https://fortelabs.com/blog/para/)
- [Karpathy LLM Wiki Pattern — MindStudio](https://www.mindstudio.ai/blog/karpathy-llm-wiki-knowledge-base-pattern)
- [Tagging for Personal Knowledge Management — Forte Labs](https://fortelabs.com/blog/a-complete-guide-to-tagging-for-personal-knowledge-management/)
- [Growing Knowledge Bases from the Bottom Up — Dendron Blog](https://blog.dendron.so/notes/072ed07tikrhv6e4ilwcv2q/)
- [Self-Organizing Second Brain — Medium](https://medium.com/@BitsOfChris/self-organizing-second-brain-how-i-manage-information-overload-2266bd0d9e27)
- [Bitemporal Modeling Overview — Emergent Mind](https://www.emergentmind.com/topics/bitemporal-modeling)
