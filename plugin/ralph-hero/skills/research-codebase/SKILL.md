---
description: Interactive codebase research - asks for a research question, spawns parallel sub-agents, synthesizes findings into a research document. Documents what IS, not what SHOULD BE.
argument-hint: "[optional: research question or #NNN issue number]"
model: opus
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
env:
  RALPH_GH_OWNER: "${RALPH_GH_OWNER}"
  RALPH_GH_REPO: "${RALPH_GH_REPO}"
  RALPH_GH_PROJECT_NUMBER: "${RALPH_GH_PROJECT_NUMBER}"
---

# Research Codebase

You are tasked with conducting comprehensive research across the codebase to answer user questions by spawning parallel sub-agents and synthesizing their findings.

## CRITICAL: YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY
- DO NOT suggest improvements or changes unless the user explicitly asks for them
- DO NOT perform root cause analysis unless the user explicitly asks for them
- DO NOT propose future enhancements unless the user explicitly asks for them
- DO NOT critique the implementation or identify problems
- DO NOT recommend refactoring, optimization, or architectural changes
- ONLY describe what exists, where it exists, how it works, and how components interact
- You are creating a technical map/documentation of the existing system

## Initial Setup

When this command is invoked:

1. **If a research question or `#NNN` issue number was provided** (via `ARGUMENTS`):
   - If `#NNN`: fetch the issue via `ralph_hero__get_issue(number=NNN)` to understand the context
   - Set `LINKED_ISSUE = NNN` for optional linking later
   - Use the issue title/body as the research question, or let the user refine it
   - If a research question was provided directly, proceed with it

2. **If no parameters provided**, respond with:
```
I'm ready to research the codebase. Please provide your research question or area of interest, and I'll analyze it thoroughly by exploring relevant components and connections.

You can also provide a GitHub issue number (e.g., #42) to research in context of a specific issue.
```

Then wait for the user's research query.

## Steps to follow after receiving the research query:

### Step 1: Read any directly mentioned files first
- If the user mentions specific files (docs, configs, source code), read them FULLY first
- **IMPORTANT**: Use the Read tool WITHOUT limit/offset parameters to read entire files
- **CRITICAL**: Read these files yourself in the main context before spawning any sub-tasks
- This ensures you have full context before decomposing the research

### Step 2: Analyze and decompose the research question
- Break down the user's query into composable research areas
- Take time to think deeply about the underlying patterns, connections, and architectural implications the user might be seeking
- Identify specific components, patterns, or concepts to investigate
- Consider which directories, files, or architectural patterns are relevant

### Step 3: Spawn parallel sub-agent tasks for comprehensive research

Create multiple Task agents to research different aspects concurrently. Use these specialized agents:

**For codebase research:**
- Use the **ralph-hero:codebase-locator** agent to find WHERE files and components live
- Use the **ralph-hero:codebase-analyzer** agent to understand HOW specific code works (without critiquing it)
- Use the **ralph-hero:codebase-pattern-finder** agent to find examples of existing patterns (without evaluating them)

**For thoughts directory:**
- Use the **ralph-hero:thoughts-locator** agent to discover what documents exist about the topic
- Read and synthesize the returned documents yourself in the main context

**For web research (only if user explicitly asks):**
- Use the **ralph-hero:web-search-researcher** agent for external documentation and resources
- IF you use web-research agents, instruct them to return LINKS with their findings, and please INCLUDE those links in your final report

**For GitHub Issues (if relevant):**
- Use `ralph_hero__get_issue(number=NNN)` directly for issue details
- Use `ralph_hero__list_issues(query="...")` to search for related issues

**IMPORTANT**: All agents are documentarians, not critics. They will describe what exists without suggesting improvements or identifying issues.

**Sub-agent team isolation**: Do NOT pass `team_name` to any internal `Task()` calls (per conventions).

The key is to use these agents intelligently:
- Start with locator agents to find what exists
- Then use analyzer agents on the most promising findings to document how they work
- Run multiple agents in parallel when they're searching for different things
- Each agent knows its job - just tell it what you're looking for
- Don't write detailed prompts about HOW to search - the agents already know
- Remind agents they are documenting, not evaluating or improving

### Step 4: Wait for all sub-agents to complete and synthesize findings
- IMPORTANT: Wait for ALL sub-agent tasks to complete before proceeding
- Compile all sub-agent results (both codebase and thoughts findings)
- Prioritize live codebase findings as primary source of truth
- Use thoughts/ findings as supplementary historical context
- Connect findings across different components
- Include specific file paths and line numbers for reference
- Highlight patterns, connections, and architectural decisions
- Answer the user's specific questions with concrete evidence

### Step 5: Gather metadata for the research document
- Get current commit: `git rev-parse HEAD`
- Get current date: `date +%Y-%m-%d`
- Get current branch: `git branch --show-current`

### Step 6: Generate research document

Filename: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md`
- Format: `YYYY-MM-DD-GH-NNNN-description.md` where:
  - YYYY-MM-DD is today's date
  - GH-NNNN is the GitHub issue number, zero-padded to 4 digits (omit if no linked issue)
  - description is a brief kebab-case description of the research topic
- Examples:
  - With issue: `2026-01-21-GH-0146-ticket-resolution.md`
  - Without issue: `2026-01-21-authentication-flow.md`

Structure the document with YAML frontmatter followed by content:

```markdown
---
date: YYYY-MM-DD
github_issue: NNN        # optional - only if linked to an issue
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN  # optional
topic: "[Research Question]"
tags: [research, codebase, relevant-component-names]
status: complete
type: research
---

# Research: [Research Question/Topic]

## Research Question
[Original user query]

## Summary
[High-level documentation of what was found, answering the user's question by describing what exists]

## Detailed Findings

### [Component/Area 1]
- Description of what exists ([file.ext:line](permalink))
- How it connects to other components
- Current implementation details (without evaluation)

### [Component/Area 2]
...

## Code References
- `path/to/file.py:123` - Description of what's there
- `another/file.ts:45-67` - Description of the code block

## Architecture Documentation
[Current patterns, conventions, and design implementations found in the codebase]

## Historical Context (from thoughts/)
[Relevant insights from thoughts/ directory with references]

## Related Research
[Links to other research documents in thoughts/shared/research/]

## Open Questions
[Any areas that need further investigation]
```

### Step 7: Add GitHub permalinks (if applicable)
- Check if on main branch or if commit is pushed: `git branch --show-current` and `git status`
- If on main/master or pushed, generate GitHub permalinks:
  - Create permalinks: `https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/{commit}/{file}#L{line}`
- Replace local file references with permalinks in the document

### Step 8: Optional issue linking

If `LINKED_ISSUE` was set (user provided `#NNN`), offer to post an Artifact Comment to the issue:

```
Would you like me to link this research document to issue #NNN?
```

If the user agrees, post a comment via `ralph_hero__create_comment`:

```markdown
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

Key findings: [1-3 line summary of the most important discoveries]
```

### Step 9: Present findings
- Present a concise summary of findings to the user
- Include key file references for easy navigation
- Ask if they have follow-up questions or need clarification

### Step 10: Handle follow-up questions
- If the user has follow-up questions, append to the same research document
- Update the frontmatter: add `last_updated: YYYY-MM-DD` and `last_updated_note: "Added follow-up research for [brief description]"`
- Add a new section: `## Follow-up Research [timestamp]`
- Spawn new sub-agents as needed for additional investigation
- Continue updating the document

## Important notes
- Always use parallel Task agents to maximize efficiency and minimize context usage
- Always run fresh codebase research - never rely solely on existing research documents
- The thoughts/ directory provides historical context to supplement live findings
- Focus on finding concrete file paths and line numbers for developer reference
- Research documents should be self-contained with all necessary context
- Each sub-agent prompt should be specific and focused on read-only documentation operations
- Document cross-component connections and how systems interact
- Include temporal context (when the research was conducted)
- Link to GitHub when possible for permanent references
- Keep the main agent focused on synthesis, not deep file reading
- Have sub-agents document examples and usage patterns as they exist
- **CRITICAL**: You and all sub-agents are documentarians, not evaluators
- **REMEMBER**: Document what IS, not what SHOULD BE
- **NO RECOMMENDATIONS**: Only describe the current state of the codebase
- **File reading**: Always read mentioned files FULLY (no limit/offset) before spawning sub-tasks
- **Critical ordering**: Follow the numbered steps exactly
  - ALWAYS read mentioned files first before spawning sub-tasks (step 1)
  - ALWAYS wait for all sub-agents to complete before synthesizing (step 4)
  - ALWAYS gather metadata before writing the document (step 5 before step 6)
  - NEVER write the research document with placeholder values
- **Frontmatter consistency**:
  - Always include frontmatter at the beginning of research documents
  - Keep frontmatter fields consistent across all research documents
  - Update frontmatter when adding follow-up research
  - Use snake_case for multi-word field names (e.g., `last_updated`, `git_commit`)
  - Tags should be relevant to the research topic and components studied
