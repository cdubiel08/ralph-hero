# Dashboard render

This reference is consulted by `/ralph:catch-up --mode brief` (`brief-composition.md:51`), which inherits its render rules and never-editorialize constraint list by reference. It carries the pipeline-render rules and the load-bearing negative-constraint prose ported verbatim from `plugin/ralph-hero/skills/status/SKILL.md`.

## pipeline_dashboard call shape

Fetch `ralph_hero__pipeline_dashboard` with:

- `format` — parsed from the trailing argument; default `markdown`. Valid: `markdown`, `ascii`, `json`.
- `includeHealth` — `true`
- `issuesPerPhase` — `5`

## Format routing

### If `format == "json"`

- Emit the dashboard object literally inside a fenced ```json``` code block, using `JSON.stringify(dashboard, null, 2)` (pretty-printed, 2-space indent).
- **DO NOT narrate or summarize the JSON.** Do not add a preamble like "Here's the pipeline status..." or a postamble like "The pipeline has N critical warnings." Emit the fenced JSON block and stop.
- Do not re-render the JSON as markdown bullet lists, headings, tables, or prose. The response in JSON mode is the fenced JSON code block — nothing else.

### If `format == "markdown"` or `format == "ascii"`

- Emit the dashboard's `formatted` field verbatim.
- Do not re-render or restructure the content.

## Critical health warnings

If health warnings exist with severity `critical`, highlight them prominently. In JSON mode, the warnings are already in the JSON payload — do not re-surface them in prose.

In markdown/ascii mode, surface the raw warning list under a `### Critical Health Warnings (N)` heading after the formatted block.

## Output scope

This render is a **read-only, passive render of pipeline state plus raw warnings**. It is NOT a triage tool, NOT an analyst, NOT a recommender.

**NEVER:**

- Prescribe actions, fixes, or remediation steps ("should be split", "needs closure", "ought to be archived", "Here's what you should do").
- Add diagnostic framing or interpretive commentary ("Pipeline gaps indicate no active work", "Backlog congestion suggests stale work", "This indicates...").
- Synthesize "Key Findings", "Recommendations", "Next Steps", "Suggested Actions", or any analyst-style summary section.
- Group, rank, editorialize, or contextualize warnings beyond what the dashboard payload already encodes.
- Cross-reference issues to call out which "should" be split, closed, or archived.

Remediation, triage, and follow-up analysis belong to `/ralph:caretake` — NOT to this render. After surfacing the raw warning list, STOP.

## Negative example (do NOT produce output like this)

```markdown
### Critical Issues

**48 CRITICAL health warnings** — issues stuck beyond 96-hour threshold:
- **Backlog**: 23 issues stuck (oldest: #362, #503 at 1490h)

### Key Findings

1. **Pipeline gaps**: All active phases are empty — work flows straight
   from Ready for Plan to Done with no intermediate stops.
2. **Backlog congestion**: 22 issues waiting; #503 and #505-#507 are
   62+ days old.
3. **#731 should be split** — it's a P1, L item blocking the loop.
4. **Archive eligible**: 135 items in Done/Canceled can be archived.
```

The "Key Findings" block, the "should be split" recommendation, the "can be archived" suggestion, and the "Pipeline gaps indicate..." diagnostic framing are all out of scope. Surface the raw warning list and stop.

## Correct shape

```text
[dashboard.formatted verbatim]

### Critical Health Warnings (N)

- #362 — stuck 1490h in Backlog
- #503 — stuck 1488h in Backlog
- ...
```

No analysis, no recommendations, no framing — just the raw list.
