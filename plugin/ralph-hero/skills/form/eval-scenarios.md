---
type: eval-scenarios
skill: form
date: 2026-04-25
---

# Eval Scenarios — form skill

These scenarios define grading criteria for the `form` skill. Each scenario specifies an Input, the Expected Behavior, and explicit Assertions a reviewer (human or automated grader) can check. Execution of these scenarios is tracked separately; this file is the rubric.

## Scenario A: Form from idea file (issue output)

### Input

User invokes the skill with a path to an existing draft idea:

```
/ralph-hero:form thoughts/shared/ideas/2026-04-20-operator-comparison-view.md
```

The idea file exists with `status: draft`, `type: idea`, `github_issue: null`, and a clear description of an operator-comparison-view feature. The codebase has a `dashboard/` module and a `dashboard-tools.ts` file that this idea would extend. No duplicate issues exist on the project board.

### Expected Behavior

1. Skill reads the file FULLY and sets `INPUT_TYPE = "idea"`.
2. Skill restates the idea (Step 1) and waits for confirmation.
3. After confirmation, skill spawns parallel sub-tasks: codebase-locator, codebase-analyzer, thoughts-locator, plus an issue search.
4. Skill waits for ALL sub-tasks before presenting the larger context (Step 3).
5. Skill calls `AskUserQuestion` for the Step 4 output-format choice with 5 labeled options.
6. User picks "GitHub issue" via the structured picker. Skill drafts a title + body + labels + estimate (Step 5a) and asks for approval.
7. After approval, skill creates the issue, sets workflow state to "Backlog", and updates the source file's frontmatter:
   - `status: forming` → `status: formed`
   - `github_issue: null` → `github_issue: NNN`
8. Skill reports the new issue URL and suggests next steps.

### Assertions

- [ ] Skill reads the file once at start (not multiple re-reads).
- [ ] Skill calls `AskUserQuestion` for the Step 4 output-format choice (not inline markdown numbered list).
- [ ] All sub-agents are dispatched via `Agent()` calls (not deprecated `Task` syntax).
- [ ] No sub-agent call passes `team_name`.
- [ ] Issue is created with `workflowState: "Backlog"` and an explicit `estimate`.
- [ ] Source file's `github_issue` field is updated to the new issue number.
- [ ] Source file's `status` field is updated to `formed` (not `refined`).
- [ ] Final report includes the issue URL using the resolved `$RALPH_GH_OWNER/$RALPH_GH_REPO` values.

## Scenario B: Form from research doc (research-input branch)

### Input

User invokes the skill with a path to an existing research document:

```
/ralph-hero:form thoughts/shared/research/2026-04-15-GH-0512-streaming-data-pipeline.md
```

The research doc has `type: research` in frontmatter, `github_issue: 512` (already linked), a Summary section, code references, and detailed findings. The user wants to spawn implementation work from the research.

### Expected Behavior

1. Skill detects the path matches `thoughts/shared/research/*.md` and reads frontmatter — sets `INPUT_TYPE = "research"`, `LINKED_ISSUE = 512`.
2. Skill restates the core idea pulled from the research Summary section (Step 1).
3. After confirmation, skill takes the research-input branch in Step 2:
   - SKIPS codebase-locator and codebase-analyzer (research already covers code analysis).
   - Still runs thoughts-locator + issue dedup search.
4. Skill calls `AskUserQuestion` for Step 4. User picks "Implementation plan".
5. Skill takes Step 5c hand-off branch — does NOT update the research doc's `type: research` or write a new `status` field (research docs don't have a `status` field).
6. Skill suggests `/ralph-hero:plan #512 [context summary]` and offers to invoke it directly.

### Assertions

- [ ] Skill correctly detects the research-input mode based on path or frontmatter.
- [ ] Skill does NOT spawn `codebase-locator` or `codebase-analyzer` (research-input optimization).
- [ ] Skill DOES spawn `thoughts-locator` and runs an issue dedup search.
- [ ] Skill calls `AskUserQuestion` for the output-format choice.
- [ ] Skill does NOT overwrite the research doc's `type: research` field.
- [ ] Skill does NOT add a `status` field to the research doc frontmatter.
- [ ] Final hand-off references the linked issue (#512) and the gathered context.

## Scenario C: Form from inline description with output choice

### Input

User invokes the skill with a raw text description (not a file path):

```
/ralph-hero:form add a feature flag system to gate experimental dashboards behind a per-user toggle
```

No idea file exists for this topic. The codebase has no existing feature-flag infrastructure (codebase-locator returns no matches).

### Expected Behavior

1. Skill detects the input is not a file path and treats it as inline description; sets `INPUT_TYPE = "idea"`.
2. Skill restates the idea (Step 1) and confirms.
3. Skill spawns codebase-locator + codebase-analyzer + thoughts-locator + issue dedup. The codebase-locator returns no matches; skill reports this honestly in the larger-context block (Step 3) and notes "no existing infrastructure — this is greenfield".
4. Skill calls `AskUserQuestion` for Step 4. User picks "Ticket tree" (option 4) because the feature is large enough to need parent + children.
5. Skill takes Step 5b: presents the tree (parent + 3-4 children at XS/S), gets approval, creates the parent at "L" estimate + workflow state Backlog, then creates each child as a sub-issue at XS/S estimate.
6. Since input was inline (no source file), no source-file frontmatter update occurs.
7. Skill reports the parent + children URLs.

### Assertions

- [ ] Skill correctly detects inline-description mode (not file mode, not research-doc mode).
- [ ] Skill spawns the FULL research suite (codebase-locator, codebase-analyzer, thoughts-locator, issue search) — does NOT skip codebase analysis.
- [ ] Skill calls `AskUserQuestion` for the output-format choice with all 5 labeled options.
- [ ] Parent issue is created with estimate "L" and workflow state "Backlog".
- [ ] Each child is linked as a sub-issue under the parent via `add_sub_issue`.
- [ ] Each child has estimate XS or S (autonomous-implementation-ready).
- [ ] Skill does NOT attempt to update a non-existent source file's frontmatter.
- [ ] Final report lists parent URL and each child URL using resolved env values.
