---
type: eval-scenarios
skill: draft
date: 2026-04-25
---

# Eval Scenarios — draft skill

These scenarios define grading criteria for the `draft` skill. Each scenario specifies an Input, the Expected Behavior, and explicit Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Inline argument capture

### Input

User invokes the skill with an inline idea passed as the argument:

```
/ralph-hero:draft we should add an operator comparison view that shows three operators side-by-side with their last 24h of usage data
```

The `thoughts/shared/ideas/` directory exists. Today's date is 2026-04-25. No existing idea file matches the topic.

### Expected Behavior

1. Skill detects the inline argument and skips the "What's on your mind?" prompt (Initial Response item 1).
2. Skill restates the idea in one sentence: e.g., "Got it - an operator comparison view showing three operators' last-24h usage side-by-side."
3. Skill asks 2-3 clarifying questions targeting the idea's most important gap, the prompt context, and the scope. Examples:
   - "Should this be a new dashboard panel or a standalone page?"
   - "What prompted this — a specific outage or a recurring need?"
   - "Three operators specifically, or a configurable N?"
4. Skill makes the "feel free to skip any" escape hatch explicit.
5. Skill optionally calls `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find files related to operator comparison or operator dashboard")` if the idea references concrete codebase areas.
6. Skill writes the draft to `thoughts/shared/ideas/2026-04-25-operator-comparison-view.md` (or similar slugified filename) using the lightweight template.
7. Skill confirms the path and suggests `/ralph-hero:form` as the next step.

### Assertions

- [ ] Skill does NOT call any GitHub MCP tools (drafts are pre-ticket).
- [ ] Skill does NOT call `Read` (allowed-tools is `[Write, Agent]` only — Read is not declared).
- [ ] Output file lives in `thoughts/shared/ideas/` with frontmatter `status: draft`, `type: idea`, `github_issue: null`.
- [ ] File contains four required sections: "The Idea", "Why This Matters", "Rough Shape", "Open Questions".
- [ ] Filename slug is derived from the idea topic and follows the `YYYY-MM-DD-description.md` pattern.
- [ ] Skill takes less than 60 seconds total (speed-over-polish principle).
- [ ] Final output suggests `/ralph-hero:form [path]` with the exact saved path.

## Scenario B: Empty argument with clarifying questions

### Input

User invokes the skill with no argument:

```
/ralph-hero:draft
```

### Expected Behavior

1. Skill detects no argument and emits the "What's on your mind?" prompt verbatim from Initial Response item 2.
2. Skill waits for user input.
3. After the user describes their idea (any reasonable freeform text), skill follows the same Step 1-4 capture process as Scenario A.
4. Skill does NOT proactively pick a topic or fabricate an idea.

### Assertions

- [ ] Skill emits the "What's on your mind?" prompt block exactly as specified in the SKILL body (or a substantially equivalent invitation).
- [ ] Skill does NOT write any file before receiving user input.
- [ ] Skill does NOT call any sub-agents before user input.
- [ ] After user input, file is saved to `thoughts/shared/ideas/` with the lightweight template.
- [ ] If the user replies "just capture it" or skips clarifying questions, skill writes the draft with whatever content is available and does NOT block.

## Scenario C: Idea file with attached context (knowledge-graph dedup hit)

### Input

User invokes the skill with an idea that overlaps with an existing draft:

```
/ralph-hero:draft we need to track demo recordings and link them back to issues
```

A knowledge search tool is available. A pre-existing draft `thoughts/shared/ideas/2026-03-12-demo-recording-tracking.md` covers a closely related topic.

### Expected Behavior

1. Skill detects the inline argument and restates the idea.
2. Skill asks 2-3 clarifying questions.
3. Skill performs a dedup check (Step 2b): searches the knowledge graph for similar ideas (type "idea", limit 3).
4. Skill surfaces the existing match: "There's an existing idea that may overlap: `thoughts/shared/ideas/2026-03-12-demo-recording-tracking.md` — Demo Recording Tracking. Want to continue with a new idea or build on that one?"
5. Skill waits for the user's choice. If user says "continue with new idea", proceed to write a new file. If user says "build on that one", suggest opening the existing file or running `/ralph-hero:form` against it.

### Assertions

- [ ] Skill calls the knowledge search tool exactly once with `type: "idea"` and a limit of 3 (or fewer).
- [ ] Skill surfaces the existing idea path in the response (not just a count).
- [ ] Skill does NOT silently overwrite the existing file.
- [ ] If knowledge search is unavailable, skill skips Step 2b and proceeds with capture (does not error).
- [ ] If the user opts to build on the existing idea, skill does NOT create a new file and instead points at `/ralph-hero:form [existing-path]`.
