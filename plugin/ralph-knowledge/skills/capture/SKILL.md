---
description: Capture an insight, decision, or session learning as a raw memory in ralph-knowledge — the in-flow "remember this" surface. Distills what just happened (an exchange, a debugging breakthrough, a whole session) into 1-3 atomic raw memories via the knowledge_remember MCP tool, so the nightly dream-loop reflection pass can synthesize them. Use when the user says "remember this", "capture this", "save this insight", "make a memory of this", "don't let me forget", "TIL", "turn this session into memories", or wants to bank a learning without leaving flow. Not for curated knowledge — wiki promotion is the human-gated /ralph-knowledge:curate surface.
argument-hint: "[what to remember — omit to capture the current exchange]"
---

# Capture — In-Flow Memory Capture

Turn what is happening *right now* into raw memories. This is the intentional counterpart to the two ambient paths (the dream-loop's `claude-code` session ingester and the per-turn agent Stop hook): those capture broadly and shallowly; this captures one thing well, at the moment it matters.

## How you talk

You are a librarian. Cite the memory tier and the path for every write. State what was captured as fact, and say how it flows downstream (next reflection pass).

## Workflow

### Step 1: Resolve scope

- **Argument text given** → that is the subject. Pull supporting context from the conversation.
- **"this" / no argument** → the most recent exchange: what was just figured out, decided, or learned.
- **"this session"** → the whole conversation: distill its decisions and learnings, not its narrative.

### Step 2: Distill

Write 1–3 atomic memories. Each must stand alone when read months from now by someone (or some reflection pass) with zero conversation context:

- **One claim per memory.** A finding, a decision + rationale, a gotcha + workaround — not a session summary.
- **Self-contained.** Name the project, file paths, issue/PR numbers, error messages. "The fix discussed above" is worthless in six months.
- **Why it matters.** One line on consequence or applicability.
- **No secrets.** Scrub tokens, keys, and credentials before writing.

Do not pad. If the session produced one insight, write one memory.

### Step 3: Write

Call `knowledge_remember` once per memory:

- `text` — the distilled markdown body
- `source` — `capture` (or `capture:<topic-slug>` when the topic is crisp)
- `tags` — 2–4 lowercase topical tags for retrieval
- `github_issue` — when the conversation is anchored to an issue

The tool writes `memory_tier: raw` under `~/projects/thoughts/dream-memories/agent/YYYY/MM/DD/` and incrementally reindexes. Tier stays `raw` — promotion to reflection happens via the dream-loop, and to wiki via the human-gated `/ralph-knowledge:curate`.

### Step 4: Report

State as facts: each path written, its tier, whether it was indexed, and that the next dream-loop reflection pass will pick it up. If `knowledge_remember` is unavailable (MCP server not connected), say so and direct the user to `/ralph-knowledge:setup` — do not hand-write files as a fallback.

## Relationship to other surfaces

- **Ambient session ingestion** — `scripts/dream/ingest.py` distills every Claude Code session (prompts + outcome) nightly. Capture exists because ambient distillation can't know which insight mattered; you do, in the moment.
- **`/ralph-knowledge:dream-loop`** — synthesizes captured raw memories into reflections on demand.
- **`/ralph-knowledge:curate`** — the human-gated wiki tier. Never write wiki/reflection tiers from here.
