# Narrative synthesis

This reference is consulted by `/ralph:catch-up` (and the `ralph:catch-up-agent` sub-agent it dispatches) to turn the local activity log into a 2-4 sentence prose narrative of what changed since the user last checked.

## Cursor mechanics

Read `~/.ralph-hero/cursors/catch-up.json`. If it exists, parse `last_event_ts`. If missing or corrupt, default the cursor to 24 hours before now (in ISO8601 UTC). Do not warn the user about a missing cursor — that's the normal first-run experience.

**Cursor write is automatic.** The `cursor-advance-catch-up.sh` PostToolUse hook (wired in `ralph/hooks/hooks.json`) persists `~/.ralph-hero/cursors/catch-up.json` from the `recent_activity` response. This consumer must NOT write the cursor file directly.

## Memory read (optional)

Read the project's `MEMORY.md` (path varies by install — same logic as the catch-up skill body). Memory is supplementary context for the synthesis prompt; it never gates execution.

If memory is missing or empty, proceed without it.

## recent_activity call shape

Invoke `ralph_hero__recent_activity` with:

- `since` = the cursor timestamp from above
- `category` = `"work"`
- `limit` = `50`
- `compact` = `true`

> Internal: `limit=50` is the long-absence cap (was 200 before the context-flood fix). `compact=true` drops `actor`, `session_id`, `category`, and the wrapper `target` — narrative synthesis only needs `ts`, `kind`, `tool`, and `project`.

Capture the response: `events[]` and `cursor_advanced_to`.

## Empty case

If `events.length == 0`, output exactly:

> Nothing's changed since last time you checked.

Stop. No picker, no follow-up text.

## Populated case

Write 2-4 sentences describing what happened. Lean on:

- What kinds of events fired (PRs opened/merged, issues advanced, agents dispatched)
- Which issues / PRs by number were touched (e.g., "#921 moved into review, #933 was opened")
- Any patterns worth noting ("three PRs all from the playwright group")

## Long-absence prefix

If `events.length` was at the `limit` cap, prefix the narrative with:

> A lot has happened since last time — here are the highlights:

This tells the reader that the picture is partial (oldest events fell off the window).

## Tone rules

- No severity tags (CRITICAL, STUCK, etc.)
- No dashboard formatting, no markdown tables, no JSON blocks, no bullet lists
- Prose only
- ≤ 4 sentences in the populated case

## Output contract

Return only the narrative text — no frontmatter, no headers, no metadata. The caller (the interactive `/ralph:catch-up` default flow, or a programmatic invoker like `cos`) takes the text as-is.
