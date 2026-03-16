---
date: 2026-03-14
github_issue: 564
github_url: https://github.com/cdubiel08/ralph-hero/issues/564
topic: "Does ralph-hero have a research-to-issue workflow for creating issues from research findings?"
tags: [research, codebase, skills, workflow, research-to-issue]
status: complete
type: research
---

# Research: Research-to-Issue Workflow Gap

## Prior Work

- builds_on:: [[2026-03-01-hello-session-briefing]]

## Research Question

Does ralph-hero have a workflow for creating GitHub issues from research findings? Specifically, the pattern where you start with a question, investigate the codebase, discover something that needs work, and create an issue from the findings.

## Summary

Ralph-hero has three related but distinct workflow paths, and none of them cover the "research first, create issue from findings" pattern:

1. **Idea-to-Issue** (`draft` → `form`): Starts from a rough idea, researches context, creates a ticket. Entry point is an idea, not a question.
2. **Interactive Research** (`research`): Starts from a question, investigates codebase, writes findings. Can optionally **link** to an existing issue, but has no path to **create** a new issue.
3. **Autonomous Research** (`ralph-research`): Picks an existing issue in "Research Needed" state and researches it. Always starts from an issue.

The missing workflow is: **Research → Discover → Create Issue**. You ask a question, investigate, and the findings reveal actionable work that should become an issue. This is exactly what happened in the session where we researched multi-repo hygiene aggregation and created #563 from the findings.

## Detailed Findings

### Interactive Research Skill (`skills/research/SKILL.md`)

- **Step 8 (Issue Linking)**: Only supports linking to an **existing** issue. The flow is:
  - If user provided `#NNN`, offer to link the research doc to that issue
  - If user asks to link, post an artifact comment
  - No option to create a **new** issue from findings
- **No "create issue" step**: The skill ends at Step 9 (present findings) and Step 10 (handle follow-ups). Neither suggests or enables issue creation.
- **Arguments**: Accepts `#NNN` for existing issue context or a raw research question. No way to signal "I want to create an issue from this."

### Form Skill (`skills/form/SKILL.md`)

- **Entry point is an idea file**: Reads from `thoughts/shared/ideas/` or an inline description
- **Step 4 outputs**: GitHub issue, implementation plan, research topic, ticket tree, or refined idea
- **Not research-aware**: Doesn't accept a research document as input. Can't consume findings from a completed research session.
- **Step 2 duplicates research**: Spawns its own codebase research (locator, analyzer, thoughts-locator, issue search) — redundant if research was already done.

### Draft Skill (`skills/draft/SKILL.md`)

- **Quick capture only**: Saves a rough idea to `thoughts/shared/ideas/`
- **Suggests `form` as next step**: But this means going through the full form workflow, which re-researches from scratch
- **No research-to-draft path**: Can't create a draft from research findings

### Autonomous Research Skill (`skills/ralph-research/SKILL.md`)

- **Issue-first**: Always starts from a GitHub issue (provided or picked from "Research Needed" queue)
- **Step 8**: Posts research doc link and summary to the issue, moves to "Ready for Plan"
- **No issue creation**: This skill consumes issues, it doesn't create them

### The Gap

The missing transition is between the `research` skill output and the `form`/`create_issue` input:

```
Current paths:
  idea → draft → form → issue
  question → research → document (dead end for issue creation)
  issue → ralph-research → document → plan

Missing path:
  question → research → document → issue (with findings as context)
```

When a user runs `/research` and discovers something actionable, they currently have to:
1. Manually call `ralph_hero__create_issue` with hand-crafted content
2. Manually link the research doc to the new issue
3. Manually update the research doc frontmatter with the issue number

This is exactly what we did in the session that produced #563. The research skill could natively support this flow.

## Code References

- `plugin/ralph-hero/skills/research/SKILL.md:181-230` - Step 8: issue linking (link-only, no create)
- `plugin/ralph-hero/skills/research/SKILL.md:231-245` - Step 9: present findings (no issue creation suggestion)
- `plugin/ralph-hero/skills/form/SKILL.md:129-192` - Step 5a: GitHub issue creation from idea
- `plugin/ralph-hero/skills/form/SKILL.md:72-92` - Step 2: research phase (would be redundant after /research)
- `plugin/ralph-hero/skills/draft/SKILL.md:116-127` - Step 4: suggests form as next step
- `plugin/ralph-hero/skills/ralph-research/SKILL.md:170-200` - Step 8: posts to existing issue

## Architecture Documentation

The skills are designed as a linear pipeline with clear handoff points:

- `draft` → `form` → `create_issue` (idea pipeline)
- `ralph-research` → `ralph-plan` → `ralph-impl` (autonomous pipeline)
- `research` stands alone as an interactive exploration tool

The gap is that `research` doesn't connect to the idea pipeline. Adding an optional "Step 8b: Create Issue from Findings" to the research skill would complete the circuit.

## Open Questions

- Should this be a new step in the existing `research` skill, or a separate skill/command?
- Should the research document automatically become the issue body, or should it be summarized?
- Should the new issue automatically get the research doc linked as an artifact comment?
- Should the flow support creating ticket trees (parent + children) from research findings, similar to `form`'s Step 5b?
