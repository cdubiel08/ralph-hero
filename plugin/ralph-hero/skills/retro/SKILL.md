---
description: Capture session pain points (friction, retries, workarounds, confusion) into a structured research document while the conversation context is fresh. Runs inline so it has access to the full conversation history. Scans the current session for friction signals, optionally cross-references findings against the codebase via sub-agents, and writes a /form- and /plan-ingestible research doc to thoughts/shared/research/. Use when a session is wrapping up and you want to route intra-session friction into the project backlog. Different from ralph-postmortem (team sessions, structured TaskList data) — retro analyzes conversation context.
argument-hint: "[optional: scope hint or session description]"
model: opus
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Retro

You are tasked with capturing pain points from the current Claude Code session — friction encountered while working, confusing APIs, missing tooling, workarounds, repeated manual steps, and any other intra-session frustrations — and turning them into a structured research document that downstream skills (`/ralph-hero:form`, `/ralph-hero:plan`) can ingest.

This skill MUST run inline (no `context: fork`) so it can read the conversation history as the primary data source. The core value is extracting structured pain points from what just happened in this session, before that context evaporates. A forked retro would have an empty conversation window and no signal to work with.

## Step 1: Initial Response and Postmortem Dedup Check

When this command is invoked:

1. **If a scope hint was provided** (via `ARGUMENTS`):
   - Use it to scope the conversation slice you analyze (e.g., "the part where we wrestled with the worktree gate", "the initial design discussion only")
   - Note the hint in the eventual research doc's frontmatter `tags` and Summary

2. **If no arguments provided**, respond briefly:
```
Capturing pain points from this session. Scanning the conversation for friction signals...

(If you want to scope this to a specific section, re-run with a hint, e.g., `/ralph-hero:retro the worktree gate debugging part`. Otherwise I'll analyze the full conversation.)
```

### Postmortem Dedup Check

Before scanning, detect whether the calling session is a team-mode session (in which case `ralph-postmortem` is the better tool):

1. Attempt to call `TaskList`. If the call succeeds AND returns a non-empty list of tasks, this is a team session — set `TEAM_SESSION_DETECTED = true`.
2. If `TaskList` is unavailable or returns nothing, set `TEAM_SESSION_DETECTED = false`.

If `TEAM_SESSION_DETECTED == true`, surface a recommendation via `AskUserQuestion`:

```
AskUserQuestion(
  questions=[{
    "question": "A team session was detected. ralph-postmortem captures structured task-level blockers and may be a better fit. What would you like to do?",
    "header": "Postmortem vs. Retro",
    "options": [
      {"label": "Use ralph-postmortem", "description": "Switch to /ralph-hero:ralph-postmortem (designed for team sessions)"},
      {"label": "Continue with retro", "description": "Keep capturing pain points from the conversation context — retro complements postmortem"}
    ],
    "multiSelect": false
  }]
)
```

- **"Use ralph-postmortem"**: Reply with `Recommend running '/ralph-hero:ralph-postmortem' instead — it captures TaskList-driven blockers that retro cannot see.` and STOP.
- **"Continue with retro"**: Note the team-session context in the eventual research doc and proceed to Step 2.

This check does NOT block — it surfaces the recommendation, then continues based on user choice.

## Step 2: Scan Conversation Context for Pain Points

This is the core extraction step. No tools are required — this is a summarization + classification task on the conversation context already in your window.

Scan the visible conversation history for friction signals:

- **Errors encountered** — tool failures, runtime errors, stack traces, lints, test failures
- **Retries** — places where you re-attempted the same operation with adjusted inputs
- **Workarounds** — non-obvious paths taken because the obvious path didn't work
- **Confusion expressions** — "let me check…", "actually that's not right", "I'm not sure why this…"
- **Repeated manual steps** — sequences that recurred 3+ times and could plausibly be automated
- **Unclear specifications** — moments where ambiguity in the request caused rework

For each pain point, classify it into one of these 6 categories (from the research doc):

1. **API confusion** — surprising behavior, missing docs, confusing parameter naming, hidden side effects
2. **Missing tooling** — repeated manual steps that should be automated; absent helpers; manual data assembly
3. **Error-prone workflows** — sequences that require care not to break things; multi-step recipes with implicit ordering
4. **Missing abstractions** — patterns copy-pasted across the session that should have been extracted; repeated bespoke code
5. **Performance friction** — slow operations that interrupted flow (CI runs, builds, test runs, agent dispatches)
6. **Scope ambiguity** — issues, plans, or specs that were underspecified and caused rework or backtracking

For each pain point, also assign:

- **Severity tier**: `blocking` (prevented progress until resolved), `annoying` (slowed flow but didn't block), or `minor` (mildly inconvenient)
- **Codebase anchor (optional)**: a file path or component name if one is implicit in the conversation. If no specific code is implicated (purely UX/conceptual friction), leave this empty — Step 3 will skip sub-agent dispatch for that point.

### Long Conversation Guidance

If the visible conversation is very long (a useful threshold is more than ~200k tokens of conversation context, or roughly more than ~150 turns), the extraction quality may degrade. In that case:

- Constrain analysis to the most recent N turns where friction was concentrated, OR
- Ask the user via AskUserQuestion which slice of the session to analyze (e.g., "the past hour", "the implementation phase", "after the build started failing"), then bound your scan to that slice.

Do NOT skip the scan entirely on a long conversation — instead, narrow it intelligently.

## Step 3: Sub-Agent Grounding (Conditional)

For pain points that have a clear codebase anchor identified in Step 2, ground them in actual code via sub-agents. For pain points without a clear anchor (tooling, UX, or conceptual friction), skip sub-agent dispatch entirely — these will use `None` entries in the resulting `## Files Affected` section.

**When to dispatch:**

- Pain point references a specific file path → dispatch `codebase-locator` to confirm the area exists and find related files
- Pain point references a specific component or behavior whose mechanics are unclear → dispatch `codebase-analyzer` to document how it currently works (without critiquing it)

**Exact dispatch shapes:**

```
Agent(subagent_type="ralph-hero:codebase-locator",
      prompt="Find files related to [pain-point area]")

Agent(subagent_type="ralph-hero:codebase-analyzer",
      prompt="Analyze how [component] currently works (without critiquing)")
```

**Important constraints:**

- Do NOT pass `team_name` to these `Agent()` calls — sub-agent team isolation per project convention
- Dispatch in parallel where multiple anchored pain points reference different areas (single message, multiple Agent calls)
- Dispatch is conditional, not universal — pain points with no code anchor go straight to the doc with `None` entries

After all sub-agents return, fold their findings into the relevant pain-point sections (file paths, line numbers, current behavior).

### Optional Knowledge Graph Dedup

If `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search` is available, run a brief dedup check for each high-severity pain point:

```
knowledge_search(query="[pain point summary]", type="research", brief=true, limit=3)
```

If a close match is found, mention it in the eventual research doc (`Prior Work` section). If the tool is unavailable, skip this — degrade gracefully.

## Step 4: Present Findings for Review

Before writing the research document, display a concise summary of the extracted pain points and use `AskUserQuestion` to gather feedback. This catches misclassifications and gives the user a chance to drop or refine entries.

Display format (one line per pain point):

```
Found N pain points across this session:

1. [API confusion / blocking] Plugin permissions don't propagate to subagent dispatches → plugin/ralph-hero/skills/research/SKILL.md
2. [Missing tooling / annoying] Worktree creation and rebase is a 4-command dance — no one-shot automation
3. [Error-prone workflow / annoying] git add . is footgunny mid-impl, but git add <file> is tedious
... etc
```

Then ask:

```
AskUserQuestion(
  questions=[{
    "question": "How do these pain points look?",
    "header": "Retro Findings Review",
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

**Routing logic:**

- **"Looks good, write it"**: Proceed to Step 5
- **"Drop a pain point"**: Ask which one (by number), remove it, re-display the list, re-ask this question
- **"Add a pain point"**: Ask for a description, classify it (category + severity + optional anchor), insert into the list, re-ask this question
- **"Re-classify a pain point"**: Ask which one and what to change, apply the edit, re-ask this question

This pattern matches `research/SKILL.md` Step 6 (lines 149-172).

## Step 5: Write Research Document

Filename: `thoughts/shared/research/YYYY-MM-DD-retro-[description].md`

- `YYYY-MM-DD`: today's date (use `date +%Y-%m-%d`)
- `[description]`: a kebab-case slug derived from the dominant pain-point theme (e.g., `subagent-permission-confusion`, `worktree-workflow-friction`, `mixed-session-friction`)

Use this template:

```markdown
---
date: YYYY-MM-DD
status: complete
type: research
github_issue: null
tags: [retro, session-friction, [+ relevant component tags]]
---

# Retro: [Session Theme]

## Prior Work

- builds_on:: [[any-related-research-doc]] (research — primary evidence, if found via knowledge_search)
- builds_on:: [[any-related-postmortem]] (report — if a recent team session covered overlapping ground)

(If no prior work found, leave a single line: `_No prior work found via knowledge graph or thoughts scan._`)

## Summary

[2-4 sentence narrative: what session this captures, the dominant pain-point theme, the most actionable finding]

## Detailed Findings

### API Confusion

[One subsection per category that has at least one finding. If a category had no findings in this session, omit its subsection entirely.]

- **[Pain point title]** ([severity tier])
  - What happened: [1-2 sentences from the conversation]
  - Anchor: `path/to/file.ext` (or "no specific code anchor")
  - Sub-agent grounding: [one-line summary of what codebase-locator/analyzer returned, or "n/a"]
  - Suggested next step: [file an issue / explore in /research / propose a tooling change]

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

- [List files implicated by anchored pain points; one bullet per file with a one-line note]
- If no files are implicated: `- None - this retro covers tooling/UX friction with no specific code files implicated.`

### Will Read (Dependencies)

- [List supporting files referenced during analysis]
- If none: `- None.`

## Recommended Next Steps

[Concrete suggestions, one per pain point or grouped by theme]

- For [pain point]: run `/ralph-hero:form thoughts/shared/research/[this-filename].md` to create an issue
- For [pain point]: explore further with `/ralph-hero:research [topic]` before filing
- For [pain point]: discuss with team — may not warrant a ticket
```

**Critical: `## Files Affected` MUST be present even when no code anchors exist.** The downstream postcondition hooks validate section presence, not non-emptiness — using explicit `None` entries (e.g., `- None - this retro covers tooling/UX friction with no specific code files implicated.`) satisfies the hook while honestly representing that no code is implicated.

After writing, confirm to the user:

```
Wrote retro to:
`thoughts/shared/research/YYYY-MM-DD-retro-[description].md`

Captured N pain points across [list categories that had findings].
```

## Step 6: Next Steps

Offer downstream actions via `AskUserQuestion`:

```
AskUserQuestion(
  questions=[{
    "question": "Retro doc written. What would you like to do next?",
    "header": "Next Steps",
    "options": [
      {"label": "Create issue from findings", "description": "Run /ralph-hero:form on this research doc to crystallize findings into a GitHub issue"},
      {"label": "Deep-dive a specific pain point", "description": "Spawn targeted research sub-agents to explore one finding further"},
      {"label": "Save for later — done", "description": "No further action; the doc is on disk and ready for /form or /plan when you're ready"}
    ],
    "multiSelect": false
  }]
)
```

**Routing:**

- **"Create issue from findings"**: Invoke `/ralph-hero:form thoughts/shared/research/YYYY-MM-DD-retro-[description].md`
- **"Deep-dive a specific pain point"**: Ask which pain point, then dispatch `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="...")` or similar targeted sub-agents, then append findings to the same retro doc as a new `## Follow-up Investigation` section
- **"Save for later — done"**: STOP

## Step 7: Record Outcome (Optional)

If `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` is available, record a `retro_completed` outcome event:

```
knowledge_record_outcome(
  event_type="retro_completed",
  payload={
    pain_point_count: <N>,
    categories: [<list of categories with findings>],
    created_doc_path: "thoughts/shared/research/YYYY-MM-DD-retro-[description].md",
    team_session_detected: <bool from Step 1>
  }
)
```

If the tool is unavailable, skip this step silently — degrade gracefully. This is a fire-and-forget telemetry call; do not block on it.

## Guidelines

1. **Inline context is non-negotiable** — this skill MUST run inline (no `context: fork`). A forked retro has no conversation to analyze.
2. **Conditional sub-agent dispatch** — only dispatch `codebase-locator` / `codebase-analyzer` for pain points with a clear code anchor. Tooling/UX/conceptual friction skips sub-agents and uses `None` entries.
3. **No `team_name` on `Agent()` calls** — sub-agent team isolation per project convention (consistent with `draft`, `research`, `form`).
4. **Opus model for extraction quality** — pain-point extraction and categorization is the core value of this skill; sonnet produces shallower analysis. The frontmatter declares `model: opus`.
5. **Always include `## Files Affected`** — even when no code is implicated, use explicit `None` entries to satisfy the postcondition hook for downstream `/form` and `/plan` ingestion.
6. **Postmortem dedup is a soft signal** — when a team session is detected, surface the recommendation but let the user decide. Retro and postmortem complement each other (different data sources) and may both be appropriate.
7. **Long conversations get narrowed, not skipped** — if the conversation is very long, ask the user to scope or constrain to the most recent friction-heavy turns. Don't bail out on long sessions.
8. **Research doc, not idea doc** — the output is `type: research` (not `idea`) so it flows through the `/form` research-doc intake path which preserves codebase grounding. Do not change the type.
