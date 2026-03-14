---
date: 2026-03-14
status: draft
type: plan
github_issue: 564
github_issues: [564]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/564
primary_issue: 564
tags: [skills, research, workflow, issue-creation, interactive]
---

# Add Research-to-Issue Workflow via Composable Skills - Implementation Plan

## Prior Work

- builds_on:: [[2026-03-14-GH-0564-research-to-issue-workflow-gap]]
- builds_on:: [[2026-03-01-hello-session-briefing]]

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-564 | Add research-to-issue workflow via composable `/research` + `/form` chain | S |

## Current State Analysis

The interactive `/research` skill produces research documents but has no built-in path to create GitHub issues from findings. Three workflows exist, but none cover the "question -> research -> discover actionable work -> create issue" pattern:

- **Idea pipeline** (`draft` -> `form`): Creates issues from ideas, not from research findings
- **Interactive research** (`research`): Can link to existing issues (Step 8), but cannot create new ones
- **Autonomous research** (`ralph-research`): Consumes existing issues, never creates them

When research reveals actionable work, users must manually call `ralph_hero__create_issue`, link the research doc, and update frontmatter -- exactly as happened with GH-563.

The codebase follows a "each skill does one thing" composable pattern: `draft` captures ideas, `form` crystallizes them into issues, `plan` creates implementation plans, `impl` executes plans. The solution should extend this composable chain rather than bolting issue creation onto the research skill.

### Key Files

- [`plugin/ralph-hero/skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md) - Interactive research skill (Step 9 modification)
- [`plugin/ralph-hero/skills/form/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/form/SKILL.md) - Form skill (input handling + research-aware Step 2)
  - Lines 25-44: Input handling (needs third branch for research doc paths)
  - Lines 71-91: Step 2 research phase (needs lighter path when input is already a research doc)
  - Lines 129-192: Step 5a issue creation (unchanged -- already has the full machinery)

## Desired End State

### Verification
- [x] The `/research` skill suggests `/form <research-doc-path>` in Step 9 when findings reveal actionable work
- [x] The `/form` skill accepts research doc paths (`thoughts/shared/research/*.md`) as input
- [x] When `/form` receives a research doc, Step 2 research is lighter (skips redundant codebase investigation since the doc already contains it)
- [x] Issue creation from research doc uses the existing `form` Step 5a pattern (interactive draft, approval, create, link)
- [x] The research document is linked to the new issue (frontmatter updated, artifact comment posted)
- [x] The composable chain works end-to-end: `/research` -> suggest `/form` -> `/form` creates issue
- [x] Both skills remain purely interactive (ask the user, wait for confirmation at each step)
- [x] Existing `/research` Step 8 (link to existing issue) and Step 10 continue to work unchanged
- [x] Existing `/form` with idea files and inline descriptions continues to work unchanged

## What We're NOT Doing
- Adding issue creation logic to the `/research` skill (that's the `form` skill's domain)
- Adding a new Step 8b to the research skill (the original plan approach -- superseded)
- Modifying the `ralph-research` autonomous skill (it already has a different workflow)
- Supporting ticket trees from research in this PR (that's already handled by `form` Step 5b once the input is accepted)
- Modifying the `draft` skill
- Adding MCP tools to the research skill's `allowed-tools` frontmatter

## Implementation Approach

Two surgical changes that extend existing skills without breaking their current behavior:

1. **Research skill (Step 9)**: Add a closing suggestion -- when findings reveal actionable work and no issue is already linked, suggest `/form <research-doc-path>` as the natural next step. This mirrors how `draft` suggests `/form` at the end of its flow.

2. **Form skill (input handling + Step 2)**: Add a third input branch that recognizes research doc paths (`thoughts/shared/research/*.md`). When a research doc is the input, Step 2's codebase research phase is lighter since the doc already contains the investigation. The existing Step 5a issue creation machinery handles everything else unchanged.

This preserves the composable "each skill does one thing" pattern: `/research` investigates and documents, `/form` crystallizes documents into issues. The chain becomes: `/research` -> `/form` -> issue, paralleling the existing `draft` -> `/form` -> issue chain.

---

## Phase 1: Composable Research-to-Issue Chain
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/564 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-14-GH-0564-research-to-issue-workflow-gap.md

### Changes Required

#### 1. Add `/form` suggestion to Step 9 of the research skill
**File**: `plugin/ralph-hero/skills/research/SKILL.md`
**Location**: Step 9 (lines ~213-217)

**Current Step 9**:
```markdown
### Step 9: Present findings
- Present a concise summary of findings to the user
- Include key file references for easy navigation
- Ask if they have follow-up questions or need clarification
```

**Updated Step 9**:
```markdown
### Step 9: Present findings
- Present a concise summary of findings to the user
- Include key file references for easy navigation
- If the research findings reveal actionable work AND `LINKED_ISSUE` was NOT set:
  - Suggest creating an issue from the findings via the composable `/form` chain:
    ```
    This research identified actionable work. To create a GitHub issue from these findings, run:

    `/form thoughts/shared/research/[filename].md`
    ```
- Ask if they have follow-up questions or need clarification
```

**Rationale**: This is the minimal change to the research skill. It stays true to its "document what IS" purpose and simply points the user to the right next skill, exactly like how `draft` suggests `/form` at the end of its flow (SKILL.md line 127).

#### 2. Add research doc input branch to the form skill
**File**: `plugin/ralph-hero/skills/form/SKILL.md`
**Location**: Initial Response section, input handling (lines 25-44)

**Current input handling** (two branches):
```markdown
1. **If an idea file path was provided** (e.g., `thoughts/shared/ideas/2026-02-21-feature.md`):
   - Read the file FULLY
   - Proceed to Step 1

2. **If a raw description was provided** (not a file path):
   - Treat it as an inline idea
   - Proceed to Step 1

3. **If no parameters provided**:
   ...list recent drafts...
```

**Updated input handling** (three branches):
```markdown
1. **If an idea file path was provided** (e.g., `thoughts/shared/ideas/2026-02-21-feature.md`):
   - Read the file FULLY
   - Set `INPUT_TYPE = "idea"`
   - Proceed to Step 1

2. **If a research doc path was provided** (e.g., `thoughts/shared/research/2026-03-14-GH-0564-topic.md`):
   - Read the file FULLY
   - Set `INPUT_TYPE = "research"`
   - Extract the research question, summary, detailed findings, and code references
   - If the research doc has `github_issue` in frontmatter, set `LINKED_ISSUE` to that value (the research is already linked to an issue -- the form skill should be aware)
   - Proceed to Step 1

3. **If a raw description was provided** (not a file path):
   - Treat it as an inline idea
   - Set `INPUT_TYPE = "idea"`
   - Proceed to Step 1

4. **If no parameters provided**:
   ...list recent drafts...
   Also mention: "You can also provide a research document: `/ralph-hero:form thoughts/shared/research/2026-03-14-topic.md`"
```

**Detection logic**: A path is a research doc if it matches `thoughts/shared/research/*.md` or has `type: research` in its frontmatter. An idea file matches `thoughts/shared/ideas/*.md` or has `type: idea` in its frontmatter.

#### 3. Make Step 2 research lighter for research doc inputs
**File**: `plugin/ralph-hero/skills/form/SKILL.md`
**Location**: Step 2: Research & Contextualize (lines 71-91)

**Current Step 2**: Always spawns full parallel research (codebase-locator, codebase-analyzer, thoughts-locator, issue search).

**Updated Step 2**: Add a conditional at the top of Step 2:

```markdown
### Step 2: Research & Contextualize

**If `INPUT_TYPE` is "research"** (input was a research document):
- The research document already contains codebase analysis, code references, and architectural context
- **Skip** the codebase-locator and codebase-analyzer sub-tasks (the research doc is the investigation)
- **Still run** the following (these provide project-management context the research doc may lack):
  - `Task(subagent_type="ralph-hero:thoughts-locator", prompt="Find related ideas, research, and plans about [topic from research doc]")` -- to find related work
  - `ralph_hero__list_issues(query=...)` -- to find duplicate or overlapping issues
- This avoids re-investigating what the research doc already covers while still grounding the idea in the project context

**If `INPUT_TYPE` is "idea"** (input was an idea file or inline description):
- Proceed with full research as currently defined:

1. **Codebase context** - Spawn parallel sub-tasks:
   ...existing codebase-locator and codebase-analyzer calls...
```

#### 4. Update Step 5a to handle research doc source (minor)
**File**: `plugin/ralph-hero/skills/form/SKILL.md`
**Location**: Step 5a (lines 129-192)

**Changes**: Minimal adjustments to Step 5a so it correctly handles the research doc source:

1. In the issue body template (Step 5a.1), add a `## Research` section linking back to the research doc when `INPUT_TYPE` is "research":
   ```
   ## Research
   See [research doc](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md)
   ```

2. In Step 5a.3 ("Update the idea file"), make this conditional:
   - **If `INPUT_TYPE` is "idea"**: Update the idea file as currently done (set `status: formed`, add `github_issue`)
   - **If `INPUT_TYPE` is "research"**: Update the research doc's frontmatter with `github_issue: NNN` and `github_url`, and post an artifact comment linking the research doc to the new issue (same pattern as the research skill's Step 8)

3. In Step 5a.4 ("Report"), adjust the "Next steps" suggestion:
   - **If `INPUT_TYPE` is "research"**: Suggest `/ralph-hero:plan #NNN` (skip research suggestion since research is already done)
   - **If `INPUT_TYPE` is "idea"**: Keep existing next steps unchanged

### Success Criteria
- [ ] Manual: Running `/research` with a question that reveals actionable work shows the `/form` suggestion in Step 9
- [ ] Manual: Running `/research #NNN` (with an existing issue) does NOT show the `/form` suggestion (LINKED_ISSUE is set)
- [ ] Manual: Running `/form thoughts/shared/research/2026-03-14-topic.md` reads the research doc and proceeds with lighter Step 2
- [ ] Manual: The lighter Step 2 skips codebase-locator/analyzer but still runs thoughts-locator and issue search
- [ ] Manual: Choosing "GitHub issue" in Step 4 drafts an issue with a Research section linking the doc, waits for approval, creates via MCP
- [ ] Manual: The research doc's frontmatter is updated with `github_issue` and artifact comment is posted
- [ ] Manual: Running `/form thoughts/shared/ideas/2026-02-21-feature.md` continues to work exactly as before (full Step 2 research)
- [ ] Manual: Running `/form "inline description"` continues to work exactly as before
- [ ] Manual: Existing Step 10 (follow-up questions) in the research skill still works after the Step 9 change

---

## Integration Testing
- [ ] End-to-end: Run `/research "does X have Y?"` where findings reveal work -> see `/form` suggestion -> run `/form thoughts/shared/research/[doc].md` -> choose "Create issue" -> verify issue exists in GitHub with Research section and research doc is linked via artifact comment
- [ ] End-to-end: Run `/research #NNN` -> verify Step 9 does NOT suggest `/form` -> verify Step 8 linking works as before
- [ ] End-to-end: Run `/form thoughts/shared/research/[doc].md` -> choose "Skip" (option 5) -> verify no issue created and research doc unchanged
- [ ] Regression: Run `/form thoughts/shared/ideas/[idea].md` -> verify full Step 2 research fires and issue creation works as before
- [ ] Regression: Verify existing `/research` Step 10 (follow-up questions) still works after the Step 9 change

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-14-GH-0564-research-to-issue-workflow-gap.md
- Related issues: https://github.com/cdubiel08/ralph-hero/issues/563 (the session that motivated this workflow gap)
- Pattern reference: `draft` skill Step 4 (suggests `/form` as next step -- same composable pattern)
- Pattern reference: `form` skill Step 5a (issue creation machinery -- unchanged, reused as-is)
