---
description: Synthesize a short narrative of what changed since the user last
  ran catch-up. Reads the local activity log (written by harness hooks),
  optionally enriched with memory context, and writes a 2-4 sentence prose
  recap. Manages its own cursor under ~/.ralph-hero/cursors/catch-up.json.
  Used by /hello as the orientation step; also invokable standalone for
  generating status updates or memory writes.
argument-hint: ""
context: inline
allowed-tools:
  - Read
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__recent_activity
---

# Catch-up

You synthesize a short narrative of what's changed since the user last ran catch-up.

> **Note**: cursor advancement is automatic — the `cursor-advance-catch-up.sh` PostToolUse hook persists `~/.ralph-hero/cursors/catch-up.json` from the `recent_activity` response, so this skill no longer manages the cursor file directly.

## Step 1: Read cursor

Read `~/.ralph-hero/cursors/catch-up.json`. If it exists, parse `last_event_ts`. If missing or corrupt, default the cursor to 24 hours before now (in ISO8601 UTC). Do not warn the user about a missing cursor — that's the normal first-run experience.

## Step 2: Read memory (optional)

Read the project's `MEMORY.md` (path varies by install — same logic as the hello skill). Memory is supplementary context for the synthesis prompt; it never gates execution.

If memory is missing or empty, proceed without it.

## Step 3: Call recent_activity

Invoke `ralph_hero__recent_activity` with:
- `since` = the cursor timestamp from step 1
- `category` = `"work"`
- `limit` = `50` (long-absence cap; was 200 before context-flood fix)
- `compact` = `true` (drops `actor`, `session_id`, `category`, wrapper `target` — narrative synthesis only needs `ts`, `kind`, `tool`, `project`)

Capture the response: `events[]` and `cursor_advanced_to`.

## Step 4: Synthesize narrative

**Empty case** (events empty): output exactly:

> Nothing's changed since last time you checked.

Stop here.

**Populated case**: write 2-4 sentences describing what happened. Lean on:
- What kinds of events fired (PRs opened/merged, issues advanced, agents dispatched)
- Which issues / PRs by number were touched (e.g., "#921 moved into review, #933 was opened")
- Any patterns worth noting ("three PRs all from the playwright group")

Tone rules (same as /hello):
- No severity tags, no dashboard formatting, no JSON
- No bullet lists; prose only
- No more than 4 sentences

If `events.length` was at the `limit` cap, prefix with: *"A lot has happened since last time — here are the highlights:"*

## Step 5: Output

Return only the narrative text. No frontmatter, no headers, no metadata. The caller (interactive /hello, or a programmatic invoker) takes the text as-is.

## Constraints

- Single output: prose narrative or the empty-case sentence
- No more than 4 sentences in the populated case
