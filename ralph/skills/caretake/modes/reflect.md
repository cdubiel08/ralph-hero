# `--mode reflect`

Capture intra-session friction (errors, retries, workarounds, confusion, repeated manual steps, scope ambiguity) into a `/form`-ingestible research document. Runs inline so it has access to the full conversation history — that history IS the data source.

```bash
export RALPH_SUBCOMMAND=reflect
```

No hook gates reflect — it writes a research doc, no GitHub state mutates. The terminal token (see [outcome-tokens.md](../outcome-tokens.md)) is reported for parity with other modes.

## §Step 1: Initial response

1. **If a scope hint was provided** (via `$ARGUMENTS`): use it to scope the conversation slice analyzed. Note the hint in the doc frontmatter `tags` and `Summary`.

2. **If no arguments provided**, respond briefly:

   ```
   Capturing pain points from this session. Scanning the conversation for friction signals...

   (If you want to scope this to a specific section, re-run with a hint, e.g.,
   `/ralph:caretake --mode reflect "the worktree gate debugging part"`. Otherwise
   I'll analyze the full conversation.)
   ```

## §Step 2: Scan conversation context for pain points

This is a summarization + classification task on the conversation already in your window. Scan for friction signals:

- **Errors encountered** — tool failures, runtime errors, stack traces, lints, test failures.
- **Retries** — re-attempted operations with adjusted inputs.
- **Workarounds** — non-obvious paths taken because the obvious path didn't work.
- **Confusion expressions** — "let me check…", "actually that's not right", "I'm not sure why this…".
- **Repeated manual steps** — sequences that recurred 3+ times and could plausibly be automated.
- **Unclear specifications** — ambiguity in the request caused rework.

For each pain point, classify into one of six categories:

1. **API confusion** — surprising behavior, missing docs, hidden side effects.
2. **Missing tooling** — repeated manual steps that should be automated.
3. **Error-prone workflows** — multi-step recipes with implicit ordering.
4. **Missing abstractions** — patterns copy-pasted across the session.
5. **Performance friction** — slow operations that interrupted flow.
6. **Scope ambiguity** — issues, plans, or specs that were underspecified.

For each pain point, also assign:

- **Severity**: `blocking` (prevented progress) / `annoying` (slowed flow) / `minor`.
- **Codebase anchor** (optional): a file path or component name if implicit in the conversation. If none, leave empty — §Step 3 skips sub-agent dispatch for that point.

### Long-conversation guidance

If the visible conversation exceeds ~200k tokens or ~150 turns, narrow the scan — either constrain to the most recent N turns where friction was concentrated, or ask the user via `AskUserQuestion` which slice to analyze. Do NOT skip the scan entirely.

## §Step 3: Sub-agent grounding (conditional)

For pain points with a clear codebase anchor, ground them via sub-agents. For pain points without an anchor (tooling, UX, conceptual), skip sub-agents — these will use `None` entries in `## Files Affected`.

**When to dispatch:**

- Pain point references a specific file path → `codebase-locator` to confirm + find related files.
- Pain point references a specific component or behavior → `codebase-analyzer` to document how it works.

**Dispatch shape (no `team_name`):**

```
Agent(subagent_type="ralph:codebase-locator",
      prompt="Find files related to [pain-point area]")

Agent(subagent_type="ralph:codebase-analyzer",
      prompt="Analyze how [component] currently works (without critiquing)")
```

Dispatch in parallel where multiple anchored pain points reference different areas. Fold findings into the relevant pain-point sections.

### Optional knowledge-graph dedup

If `knowledge_recall` is available, run a brief dedup check for each high-severity pain point:

```
knowledge_recall(query="[pain point summary]", role="researcher", type="research", brief=true, limit=3)
```

If a close match is found, mention it in the `Prior Work` section. Fall back to `knowledge_search` if `knowledge_recall` is unavailable. Skip both gracefully if neither exists.

## §Step 4: Present findings for review

Display a concise summary (one line per pain point) and use `AskUserQuestion` to gather feedback. This catches misclassifications and gives the user a chance to drop or refine entries.

```
Found N pain points across this session:

1. [API confusion / blocking] Plugin permissions don't propagate to subagent dispatches → plugin/ralph-hero/skills/research/SKILL.md
2. [Missing tooling / annoying] Worktree creation and rebase is a 4-command dance — no one-shot automation
...
```

Then:

```
AskUserQuestion(
  questions=[{
    "question": "How do these pain points look?",
    "header": "Reflect Findings Review",
    "options": [
      {"label": "Looks good, write it", "description": "Finalize the research document as-is"},
      {"label": "Drop a pain point", "description": "Remove an entry that isn't really a pain point"},
      {"label": "Add a pain point", "description": "Add an entry I noticed and you missed"},
      {"label": "Re-classify a pain point", "description": "Change a category or severity"}
    ],
    "multiSelect": false
  }]
)
```

Routing: drop/add/re-classify re-displays the list and re-asks until the user picks "Looks good, write it".

## §Step 5: Write research document

Path: `thoughts/shared/research/YYYY-MM-DD-reflect-[description].md` where `[description]` is a kebab-case slug from the dominant pain-point theme.

```markdown
---
date: YYYY-MM-DD
status: complete
type: research
github_issue: null
tags: [reflect, session-friction, [+ component tags]]
---

# Reflect: [Session Theme]

## Prior Work

- builds_on:: [[any-related-research-doc]] (research — primary evidence)

(If no prior work found: `_No prior work found via knowledge graph or thoughts scan._`)

## Summary

[2-4 sentence narrative: what session this captures, dominant theme, most actionable finding]

## Detailed Findings

### API Confusion

- **[Pain point title]** ([severity])
  - What happened: [1-2 sentences]
  - Anchor: `path/to/file.ext` (or "no specific code anchor")
  - Sub-agent grounding: [one-line summary, or "n/a"]
  - Suggested next step: [file an issue / explore in /research / propose tooling change]

### Missing Tooling

...

### Error-Prone Workflows

...

### Missing Abstractions

...

### Performance Friction

...

### Scope Ambiguity

...

## Files Affected

### Will Modify

- [Files implicated by anchored pain points]
- If none: `- None - this reflect covers tooling/UX friction with no specific code files implicated.`

### Will Read (Dependencies)

- [Supporting files referenced during analysis]
- If none: `- None.`

## Recommended Next Steps

[Concrete suggestions, one per pain point or grouped by theme]

- For [pain point]: run `/ralph:form thoughts/shared/research/[this-filename].md` to create an issue
- For [pain point]: explore further with `/ralph:research [topic]` before filing
- For [pain point]: discuss with team — may not warrant a ticket
```

**Critical: `## Files Affected` MUST be present** — postcondition hooks validate section presence, not non-emptiness. Use explicit `None` entries when no code is implicated.

After writing, confirm to the user:

```
Wrote reflect to:
`thoughts/shared/research/YYYY-MM-DD-reflect-[description].md`

Captured N pain points across [list categories that had findings].
```

## §Step 6: Next steps

Offer downstream actions via `AskUserQuestion`:

```
AskUserQuestion(
  questions=[{
    "question": "Reflect doc written. What would you like to do next?",
    "header": "Next Steps",
    "options": [
      {"label": "Create issue from findings", "description": "Run /ralph:form on this research doc to crystallize findings into a GitHub issue"},
      {"label": "Deep-dive a specific pain point", "description": "Spawn targeted research sub-agents to explore one finding further"},
      {"label": "Save for later — done", "description": "No further action; the doc is on disk and ready for /form or /plan"}
    ],
    "multiSelect": false
  }]
)
```

Routing:

- **"Create issue from findings"**: invoke `Skill("ralph:form", args="thoughts/shared/research/YYYY-MM-DD-reflect-[description].md")`.
- **"Deep-dive a specific pain point"**: ask which one, dispatch `Agent(subagent_type="ralph:codebase-analyzer", ...)`, append findings to the same reflect doc as `## Follow-up Investigation`.
- **"Save for later — done"**: STOP.

## §Step 7: Record outcome (optional)

```
knowledge_record_outcome(
  event_type="reflect_completed",
  payload={
    pain_point_count: <N>,
    categories: [<list with findings>],
    created_doc_path: "thoughts/shared/research/YYYY-MM-DD-reflect-[description].md"
  }
)
```

If unavailable, skip silently.

## §Step 8: Emit terminal token

```
REFLECT <path>
```

Where `<path>` is the absolute path written in §Step 5. On the no-findings short-circuit:

```
REFLECT SKIPPED <reason>
```

## §Constraints

- **Inline context is non-negotiable** — reflect MUST run inline (no `context: fork`). A forked reflect has no conversation to analyze.
- **Conditional sub-agent dispatch.** Only anchored pain points dispatch `codebase-locator` / `codebase-analyzer`. Tooling/UX/conceptual friction skips sub-agents and uses `None` entries.
- **No `team_name`** on `Agent()` calls.
- **Sonnet model for extraction quality** — declared at the caretake top-level `model: sonnet` in SKILL.md frontmatter (reflect has no per-mode override).
- **`## Files Affected` always present** even when no code is implicated.
- **Long conversations are narrowed, not skipped.** Ask the user to scope or constrain.
- **Research doc, not idea doc.** Output is `type: research` (not `idea`) so it flows through `/form`'s research-doc intake path.
