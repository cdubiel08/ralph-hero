---
date: 2026-06-10
status: formed
type: idea
author: user
tags: [fable, harness-engineering, artifact-contracts, decision-journal, hero, memory-ingestion]
github_issue: 1491
---

# Fable-native ralph: artifact contracts over procedural rails

## The Idea

When Fable is the executing model, ralph should stop prescribing *how* to work and start requiring only *what must exist afterward*. Per Anthropic's own Fable guidance ("describe the outcome, not the steps"; "skip the verification reminders"; "hand it ambiguous problems"), the step-ordered skill bodies, verdict-token choreography, fixed agent fan-outs, and complexity ladders are rails built for smaller models — on Fable they are likely wasteful and possibly constraining. Hand Fable the issue and the outcome; require an **artifact contract**: document the issues you find, journal the decisions you make and defer, keep the provenance trail so every decision can be re-walked by a human or ingested by the memory tiers (dream-loop raw → reflection → wiki).

## Why This Matters

- **Token waste**: procedure-following and gate choreography spend tokens keeping a model on task that doesn't drift. Anthropic's docs say Fable "investigates before acting, and verifies its work more often than smaller models."
- **Prior art already warned us**: the five-pillars distillation flags "skill bodies + hook gate logic trending toward the 'cascading-if' brittleness" (Pillar 3 watch item); the rails-must-pull-their-weight principle (feedback memory) says the same.
- **The record is the durable value**: decisions and deferrals are what humans re-walk and what the dream-loop ingests. The board and thoughts/ corpus survive any session; the choreography does not.
- **Just shipped GH-1487 makes this timely**: hero/research/plan now pin `model: fable` (ralph-v0.1.37) — the surfaces are already on Fable, still carrying opus-era rails.

## Rough Shape

- **One grossly simplified prompt per entry point**: outcome + boundaries (operational grants) + artifact contract. No instruction to perform research / planning / implementation as separate steps — Fable self-organizes the path.
- **Artifact contract** (the new heart of the harness):
  - Append-only **decision journal** per issue: decision, rationale, alternatives considered, deferrals, timestamp. Cheap to write, designed for re-walking and memory ingestion. Plan files become optional (only when a real multi-phase build warrants one).
  - **Canonical surface = a managed memory bank** (preferred: Vertex AI Agent Engine Memory Bank, piloted privately in a downstream project before guidance ships). After the pilot, ralph ships setup guidance so users can provision their own. **Non-opt-in fallback: Claude Code's built-in memory tools** (file-based auto-memory). **Issue comments are NOT canonical** — at most a convenience mirror.
  - Issues found along the way get documented (research-doc-like notes or new tickets).
  - Provenance trappings stay: issue/PR links, thoughts/ corpus shapes, board updates.
- **What survives from today's harness**:
  - **Board state machine, narrowed mission**: "what is being worked on, what decisions were made, what was deferred." A visibility/coordination ledger (WIP claim + decisions + deferrals), not a procedural pipeline to be walked state-by-state.
  - **Escalation for operational decisions not expressly granted**: Human Needed remains the boundary for permissions (destructive ops, scope changes, cross-project work) — not for capability/model-tier escalation.
- **What goes (on Fable)**: step-ordered skill bodies, verdict tokens (`IMPL BLOCKED needs=...`), per-phase agent choreography, complexity ladders, most gate hooks.
- **Isolation**: the Fable-native path is a separate, opt-in surface — NOT an in-place rewrite. Fable access is not universal and not guaranteed even for the author (entitlement, version gates, safety-classifier reroutes to Opus), which is hard to design around; isolating the path sidesteps it. The existing harness remains the non-Fable path, unchanged.
- **State machine unchanged**: the 9-state workflow ladder stays as-is (shared infrastructure — GitHub Actions sync, MCP state logic, parent advancement, and the non-Fable path all depend on it). The Fable path simply moves through it coarsely; the "WIP + decisions + deferrals" framing describes how the Fable path *uses* the board, not a schema change.

## Decisions So Far (2026-06-10 session)

- **D1 — Scope**: full lifecycle on Fable; do not even prescribe research/plan/impl as separate steps. Skill prompts grossly simplified.
- **D2 — Keep**: board state machine (narrowed to WIP + decisions + deferrals) and escalation for ungranted operational decisions. Everything else presumed unnecessary "more than likely" — burden of proof is on the rail.
- **D3 — Record shape**: lighter append-only decision journal per issue (not the full plan-file format); plans optional by artifact role.
- **D4 — open**: fate of the drafted "graceful model degradation for non-Fable users" issue (`~/.claude/jobs/94550051/tmp/issue-draft-fable-degradation.md`) — orthogonal hygiene vs. fold into this rethink. Undecided.
- **D5 — Canonical record surface**: a managed memory bank, preferably — pilot Vertex AI (Agent Engine) Memory Bank in a private downstream project first, then write setup guidance for opt-in users. Users who don't opt in fall back to Claude Code's built-in memory tools. Issue comments are explicitly not the canonical surface.
- **D6 — Isolation**: the Fable path must be isolated right now. Not all users — nor even the author at all times — have Fable access, which is hard to design around; the old harness remains the non-Fable path.
- **D7 — State machine**: no reduction — the existing workflow-state ladder stays.
- **D8 (revised) — Entry point**: a separate `hero-fable` skill, with `/ralph:hero --model fable` kept as a one-line forwarding alias (same pattern as the existing `--auto` alias). Rationale: isolation in Claude Code is frontmatter-level — a separate skill gets its own `model: fable` pin (which genuinely switches the model; a flag cannot), its own `hooks:` (old hero keeps its gates verbatim; hero-fable ships rail-free), its own `effort`, and leaves the old hero body untouched (add-don't-modify). The slim body still opens with a self-identity guard: if the executor isn't actually Fable (entitlement, version gate, classifier reroute), surface it and hand off to the railed `/ralph:hero`. Side effect: the old harness's `model: fable` pins (GH-1487) are freed to become `best` or revert to `opus`, making it honestly the non-Fable path (resolves into D4).

## Implementation Journal (v1 — GH-1491, 2026-06-10)

v1 implemented same-day as the design session (D1–D3, D6–D8). Decisions made at implementation time:

- **I1 — Zero hooks**: `hero-fable/SKILL.md` ships with no `hooks:` block at all (not even SessionStart env tagging). Per D2, every rail must prove its weight first; enforcement starts at zero and is added only on observed failure.
- **I2 — "9 verbs + 1 experimental"**: docs keep the 9-verb identity and present hero-fable as an experimental surface outside the set, rather than renumbering everything to 10. Cheap to revert if the experiment dies.
- **I3 — CI not extended**: the skill-frontmatter test enumerates a fixed skill list; hero-fable is deliberately not added while experimental, so CI doesn't pin a surface that may be deleted.
- **I4 — `--model <x≠fable>` refused**: the hero alias only forwards `fable`; other values get a one-line refusal pointing at frontmatter pins / `RALPH_IMPL_MODEL`.
- **I5 — Scrub folded in**: `docs/model-tier-policy.md` carried a private-project mention (shipped via GH-1487); replaced with generic phrasing per the no-private-refs directive.
- **Deferred**: D4 (old-harness pin flip to `best`/`opus`) — still the user's call; D5 managed-bank pilot + setup guidance; journal schema + corpus bridge; measurement.

## Open Questions

- **Memory-bank ↔ corpus bridge** (follows D5): the dream-loop and ralph-knowledge ingest `thoughts/` files; the built-in memory fallback lives in `~/.claude/projects/<project>/memory/` (per-user, outside the repo); a Vertex Memory Bank is API-side. Does the bank export/sync into the corpus for reflection-tier ingestion, does ralph-knowledge grow a memory-bank reader, or is the bank itself the re-walk surface (queried by catch-up/caretake)?
- **Decision-entry schema**: minimum fields for a journal entry in the bank (decision, rationale, alternatives, deferrals, timestamp, issue/PR refs) so both the managed bank and the built-in fallback hold the same shape?
- **Read path for re-walking**: which surfaces query the canonical record — `/ralph:catch-up` narrative, `/ralph:caretake` retro/post-mortem, hero resumption after Human Needed?
- **Contract enforcement**: stated-and-trusted in the slim prompt, validated post-hoc by `/ralph:caretake` hygiene, or a minimal Stop-hook artifact check (doc-structure-validator style)? D2's spirit says the rail must prove its weight first.
- **"Expressly granted" mechanics**: where do operational grants live — a per-project grants file (e.g. `.ralph-grants.yml`), settings env, or the existing hook allowlists?
- **Entry-point residual** (follows D8): skill naming only — `hero-fable` vs something else; guard-failure behavior is settled (surface + hand off to railed `/ralph:hero`).
- **GH-1487 pin consistency** (follows D6): the *old* harness currently pins hero/research/plan at `model: fable` (shipped in ralph-v0.1.37). If the old harness is the non-Fable path, those pins arguably should become `best` (Fable-when-available) or revert to `opus` — this is exactly the parked graceful-degradation issue (D4).
- **Measurement**: how do we know the slimming worked — token spend per merged issue before/after (the tokconomics gap from the five-pillars doc), artifact completeness, human re-walk satisfaction?

## Related

- `thoughts/shared/research/2026-06-10-skill-subagent-fallback-model-best-alias.md` — fallback/`best`-alias research that seeded this conversation
- `thoughts/shared/research/2026-05-26-harness-engineering-five-pillars-distillation.md` — cascading-if watch item; tokconomics gap; rent-vs-own
- `thoughts/shared/research/2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero.md` — durable-spine vs in-session-muscle framing; "state lives in GitHub" rationale
- `docs/model-tier-policy.md` — the fable ladder this would partially supersede (per-phase tiers matter less without prescribed phases)
- GH-1487 (Done) — shipped the fable pins this idea builds on
- Anthropic docs: code.claude.com/docs/en/model-config § "Work with Fable 5"
- Vertex AI Agent Engine Memory Bank (managed memory for agents; ADK `VertexAiMemoryBankService`) — D5 pilot target (private downstream project)
- Claude Code built-in memory (file-based auto-memory + MEMORY.md index) — D5 fallback for non-opt-in users
