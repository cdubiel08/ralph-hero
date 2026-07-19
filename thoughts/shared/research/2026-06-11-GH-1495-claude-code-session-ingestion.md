---
date: 2026-06-11
type: research
status: complete
github_issue: 1495
tags: [dream-loop, ralph-knowledge, claude-code, memory-tiers]
---

# GH-1495 — Claude Code session ingestion: schema facts + reindex fragility incident

Findings from building the `claude-code` dream-loop source and the `/ralph-knowledge:capture` skill.

## Claude Code transcript schema (verified 2026-06-11, CC ~2.1.x)

- Transcripts are **plain JSONL** at `~/.claude/projects/<project-slug>/<session-uuid>.jsonl` (not msgpack; an Explore sub-agent confidently claimed msgpack — always verify on disk).
- Sub-agent transcripts live at `<project-slug>/<session-uuid>/subagents/*.jsonl` — a depth-2 glob (`*/*.jsonl`) naturally selects only main sessions.
- Line `type` values seen: `user`, `assistant`, `summary`, `system`, `attachment`, `file-history-snapshot`, `ai-title`, `agent-name`, `agent-setting`, `permission-mode`, `last-prompt`.
- Real human prompts: `type=="user"` with `message.content` as a **string**; tool results arrive as content arrays. Harness-injected user lines carry `isMeta: true` or start with `<task-notification>` / `<local-command-stdout>`. Sub-agent traffic inside a main transcript carries `isSidechain: true`.
- Slash commands arrive wrapped in `<command-name>` / `<command-args>` / `<command-message>` tags.
- Useful metadata per line: `timestamp`, `cwd`, `gitBranch`, `sessionId`, `version`. `ai-title` lines hold the session title.
- **Loop noise**: `/loop` wakeups re-inject the same continuation prompt dozens of times per session (one observed session: 82 prompts, ~5 distinct). Any transcript distillation must dedupe repeated prompts.

## Reindex fragility incident (fixed in GH-1495)

The full `npm run reindex` had been **aborting on a single corpus file** with invalid YAML frontmatter — an unquoted `title:` containing a colon-space (`title: GH-410 — Permits API: support ...`, a YAML nested-mapping error). One bad file in any root killed the entire run, so the knowledge DB silently went stale and freshly-ingested raw memories never became searchable. The dream-loop's `_run_reindex` surfaced the stderr tail (GH-1203) but nothing retried.

Fix: `parser.ts` now falls back to empty frontmatter on YAML parse errors (warn + index with body-derived title), and `reindex.ts` isolates per-file stat/read/parse failures (warn + skip). Two corpus files in a sibling project's thoughts root still have unquoted colon titles; they now index fine via the fallback, but quoting those titles is cheap hygiene for whoever touches them next.

## What ships in GH-1495

1. `scripts/dream/ingest.py`: `claude-code` source — one distilled raw memory per session (title, deduped human prompts, final-assistant outcome, project/branch metadata; tool I/O never ingested; remember-turn.sh secret patterns applied). Config key `claude_code_projects` (default `~/.claude/projects`; omit to disable).
2. `/ralph-knowledge:capture` skill: the intentional "remember this" surface over `knowledge_remember`.
3. Forgiving reindex (above).

Memory path is now: ambient (sessions nightly + agent turns per-Stop) + intentional (capture) → raw → reflection (dream-loop) → wiki (curate).
