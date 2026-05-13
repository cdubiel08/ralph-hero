---
description: Split large GitHub issues (M/L/XL) into smaller XS/S sub-issues for atomic implementation. Use when you want to split issues, break down tickets, decompose epics, or make large work items implementable.
user-invocable: false
argument-hint: [optional-issue-number]
context: fork
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=split RALPH_REQUIRED_BRANCH=main RALPH_MIN_ESTIMATE=M RALPH_VALID_SUB_ESTIMATES='XS,S'"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
    - matcher: "ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "ralph_hero__create_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-size-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-estimate-gate.sh"
    - matcher: "ralph_hero__add_sub_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-verify-sub-issue.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/split-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph GitHub Split - Issue Decomposition

You are an issue decomposition specialist. You take ONE large issue (M/L/XL), research its scope, and split it into XS/Small sub-issues that can be implemented atomically.

## Workflow

### Step 1: Select Issue for Splitting

**If issue number provided**: Fetch it directly
**If no issue number**: Find oldest M+ issue in Research Needed or Backlog. "Oldest" means earliest `createdAt` — pass `orderBy: "CREATED_AT"` (ascending) when listing issues.

Use a subagent to find candidates:
```
Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find issues with M/L/XL estimates in Research Needed or Backlog workflow state. Return oldest first by createdAt.")
```

> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls. Sub-agents must run outside any team context.

Or query directly: list issues with workflowState "Backlog" and estimate "M" (limit 50, `orderBy: "CREATED_AT"` ascending), then with estimate "L", then "XL". Also repeat each query for workflowState "Research Needed". Pick the oldest issue found across all queries by `createdAt`.

If no eligible issues found, respond:
```
No M/L/XL issues need splitting. Queue empty.
```
Then STOP.

### Step 2: Fetch and Analyze Issue

1. **Get full issue details**: Fetch the full issue details including comments.

2. **Read any linked research documents** from comments

3. **Verify issue needs splitting**:
   - Estimate must be M, L, or XL
   - If already XS/Small, respond:
     ```
     #NNN is already [XS/S]. No splitting needed.
     ```
     Then STOP.

### Step 3: Discover Existing Children

List any existing sub-issues of the parent issue.

Record the results:
- **No children found**: Proceed to Step 4 (research scope) and Step 6 (create all new)
- **Children found**: Read each child's title, description, estimate, and state. Carry this list forward to Step 5 for scope comparison.

If children exist, add a note to the analysis: "Found [N] existing children. Will compare against proposed split before creating new issues."

### Step 4: Research Scope

Spawn parallel sub-tasks to understand the full scope:

```
Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find all files related to [issue topic]. What components are involved?")

Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Analyze [primary component]. What are the distinct pieces of work?")
```

> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls. Sub-agents must run outside any team context.

**Goal**: Identify natural boundaries for splitting:
- Separate layers (database, API, frontend)
- Separate data sources (TX vs WY)
- Separate concerns (extraction vs loading vs transformation)
- Sequential dependencies (schema before data, data before queries)

### Step 5: Propose Split

Design sub-issues that are:
- **XS**: < 2 hours work, single file or trivial multi-file
- **Small (S)**: 2-4 hours work, focused scope

**Split strategies by issue type**:

| Original Type | Split Strategy |
|---------------|----------------|
| Database schema | One issue per table/view |
| ETL pipeline | Extract, Transform, Load as separate issues |
| API endpoint | Repository, Service, Router as separate issues |
| Multi-state feature | One issue per state |
| Frontend feature | Component, State, Integration as separate issues |
| Skill audit (multi-skill) | One issue per skill or skill family — each child owns its own SKILL.md / agent / hook updates and `eval-scenarios.md` |
| Fragment extraction | One issue per fragment to extract — each child names the fragment, the canonical home, and the consumer skills to update |
| Documentation update | One issue per document or section being rewritten — group by audience or surface, not by file size |
| Cross-cutting refactor | One issue per pattern instance or call site cluster — group by behavior preserved, not by file count |

For non-code work (skill audits, fragment extractions, doc updates, refactors), the natural decomposition almost always follows the **artifact** boundary already named in the issue body. Read the issue body first and look for an enumerated list (skills, fragments, docs, patterns) before applying the table.

**If existing children were found in Step 3**, compare proposed sub-issues against them:

For each proposed sub-issue, check if an existing child covers the same scope:
- **Match found**: Mark the existing child for reuse (update its estimate/description/dependencies if needed)
- **No match**: Mark as net-new (will be created in Step 5)
- **Existing child with no matching proposal**: Leave as-is (it may cover scope outside the current split)

**Matching guidance**: If unsure whether an existing child covers a proposed scope, prefer reusing the existing child and adjusting its description rather than creating a duplicate. Err on the side of reuse.

Produce a split plan summary:
| Action | Issue | Title | Estimate |
|--------|-------|-------|----------|
| Reuse | #AA | [existing title] | S |
| Update | #BB | [adjusted title] | XS |
| Create | (new) | [new title] | XS |

### Step 6: Create or Update Sub-Issues

**For each sub-issue in the split plan from Step 5:**

**If reusing an existing child** (match found): Update the existing child's body and/or estimate if the scope or sizing has been refined.

**If creating a new sub-issue** (no match), use the three-step pattern:

1. **Create the issue** with a descriptive title, scoped body (scope, references, acceptance criteria), and labels inherited from the parent.

2. **Link as sub-issue** under the original issue. If linking fails, retry once; if still failing, document the orphan issue in a comment on the parent.

3. **Set estimate** based on the child's actual scope. Do NOT default every child to XS — the split-size-gate accepts XS **or** S, and reflexively picking XS is a frequent under-sizing failure mode (e.g., per-skill audit children that require multi-file edits are S, not XS):

   | Child scope signal | Estimate |
   |--------------------|----------|
   | Single file, < 2 hours, trivial multi-file edit | XS |
   | Multi-file content work (e.g., SKILL.md + eval-scenarios.md + hooks), 2-4 hours | S |
   | Service / repository / router layer with tests | S |
   | One-pattern audit or refactor with no new files | XS |
   | One-skill audit pass (read SKILL.md + author eval-scenarios.md + grade outputs + apply fixes) | S |
   | Fragment extraction with consumer-skill rewrites in 3+ files | S |

   When the split strategy table row maps to a per-artifact decomposition where each child owns multiple authored files (skill audits, fragment extractions with multi-skill rewrites, multi-file content updates), pick **S**. Reserve **XS** for genuinely single-file or one-edit children.

4. **Set initial workflow state**: advance the issue to "Ready for Plan" (command: "ralph_split"), unless Step 10's gating conditions apply. This applies **uniformly** to every child — including children that are blocked by a sibling via the dependency-chain pattern (Step 7). A blocking dependency is a `blockedBy` relationship; it does NOT replace the workflow state. Set the workflow state on every child regardless of where it sits in a dependency chain. If an error is returned, read the message — it contains valid states/intents and a Recovery action. Retry with corrected parameters.

**Sub-issue description template**:
```markdown
## Summary
[What this sub-issue accomplishes]

## Scope
[Specific files/components to modify]

## Acceptance Criteria
- [ ] [Specific criterion 1]
- [ ] [Specific criterion 2]

## References
- Parent: #[parent-number]
- Related: [File paths, documentation]

## Out of Scope
- [What's handled by sibling issues]
```

### Step 7: Establish Dependencies

Set up blocking relationships between sub-issues. For each dependency pair, add a dependency: the dependent issue is blocked by the earlier-phase issue.

**Dependency rules**:
- Schema issues block loader issues
- Loader issues block API issues
- Backend issues block frontend issues
- Config/setup issues block implementation issues

### Step 8: Update Original Issue

1. **Add split summary comment** on the original issue:
   ```markdown
   ## Issue Split

   This issue has been decomposed into [N] sub-issues:

   | Order | Issue | Title | Estimate |
   |-------|-------|-------|----------|
   | 1 | #AA | [title] | XS |
   | 2 | #BB | [title] | S |
   | 3 | #CC | [title] | XS |

   **Dependency chain**: #AA -> #BB -> #CC

   Original estimate: [M/L/XL]
   Total after split: [sum] points across [N] issues

   ---
   *Split by `/ralph-split`*
   ```

2. **Keep parent in Backlog** (do NOT change its workflow state at all):

   The parent issue stays in its current state (typically Backlog). It only reaches Done when all children are Done, which happens naturally through the pipeline.

   Update the original issue body to prepend "## Split into Sub-Issues\nThis issue has been decomposed. See children and comments for details.\n\n" to the existing body.

   **Do NOT** call `save_issue` on the parent with a `workflowState` argument. In particular, do not advance the parent to "Ready for Plan", "Plan in Progress", "Done", or "Canceled" as part of this skill. The parent remains active as an epic/umbrella in whatever state it was already in (typically Backlog).

   > **Why this matters**: `save_issue` includes an `autoAdvanceParent` helper that fires when a child reaches a parent-gate state (e.g., "Ready for Plan"). That helper only advances the parent when **all** children are at the gate; it is the intended path for parent-state progression and runs independently of this skill. The split skill itself must never set the parent's workflow state — the auto-advance helper owns parent transitions, and any manual advance in this skill races or duplicates that contract. If the parent appears to have advanced after split, that is the helper firing (because every child reached the gate); it is not this skill's responsibility to mirror that behavior.

### Step 9: Research Notes to Affected Children

Any context discovered during Steps 2-5 that is **specific to one child** must be embedded in that child's body — not left only in the parent split-summary comment.

**Anti-pattern (avoid)**: A research note in the parent comment like "Note: shared/fragments/link-formatting.md may already exist; verify before extracting" is invisible to the implementer working on the child unless they read every parent comment. The child agent will re-discover (or miss) the constraint.

**Correct pattern**: For each child, before moving on to Step 10, scan your scratchpad / Step 4 research output for any note that:

- Names a file, function, or fragment that this specific child will touch
- Calls out a partial existing implementation, edge case, or sibling overlap
- Records a decision deferred to implementation (e.g., "extend existing helper vs create new")

If such a note exists, append it to the child's body under a `## Research Notes` section using `save_issue` (body update). Keep parent-wide notes in the parent comment; only push child-specific notes into the child body.

**Verification**: After updating each affected child, the child's body should be readable in isolation — an implementer should not need to read the parent comment to understand the scope.

### Step 10: Move Sub-Issues to Appropriate State

Based on research done during splitting, set the workflow state for **every** child (including children with sibling `blockedBy` dependencies — Step 7 dependencies are orthogonal to workflow state):

- **If scope is clear** -> Update workflow state to "Ready for Plan" (command: "ralph_split")
- **If scope needs more research** -> Keep in "Research Needed"
- **If blocked by an issue OUTSIDE this split** -> Keep in "Backlog" with the external blocker set

> **Uniformity check**: After this step, run `list_sub_issues` on the parent and verify every child has a non-null `workflowState`. The dependency-chain pattern (repo -> service -> router) is a common pitfall: agents sometimes advance only the unblocked head of the chain and leave the rest with no workflow state, which strands them outside any pipeline query. Set the state on every child — `blockedBy` is what enforces ordering, not workflow state.

### Step 11: Team Result Reporting

When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata (sub-ticket IDs, estimates) and a human-readable summary in the description. Then check TaskList for more work matching your role.

### Step 12: Report

```
Split complete for #NNN: [Original Title]

Original: [M/L/XL] estimate
Result: [N] sub-issues totaling [sum] points

Original issue: Preserved in [its prior state] (epic/umbrella) — split skill did NOT touch parent workflow state

Sub-issues:
1. #AA: [title] (XS) -> [state] [REUSED]
2. #BB: [title] (S) -> [state] [UPDATED]
3. #CC: [title] (XS) -> [state] [NEW]

Dependency chain: #AA -> #BB -> #CC
```

> Reminder: the "Original issue" line above must report the parent's pre-split workflow state. If you find yourself writing "auto-advanced to Ready for Plan" or "moved to ..." for the parent in your report, you violated Step 8.2 — go back and do not call `save_issue(workflowState=...)` on the parent.

## Escalation Protocol

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md

Use `command="ralph_split"` in state transitions.

**Split-specific triggers:**

| Situation | Action |
|-----------|--------|
| Can't identify natural decomposition boundaries | Escalate: "Unable to decompose GH-NNN. Scope is atomic or unclear — no natural artifact, layer, or phase boundary found." |
| Circular dependencies in proposed split | Escalate: "Proposed split has circular dependency. Need guidance." |
| Issue is actually XS/Small after research | Update estimate instead of splitting (no escalation needed) |

> Note: there is **no fixed cap** on sub-issue count. A skill audit epic may legitimately fan out to 10+ children (one per skill), and a fragment-extraction epic may fan out to 4-8. Escalate only when you cannot identify *natural* boundaries — not when the count happens to be large.

## Constraints

- Work on ONE issue only
- M/L/XL issues only (estimate must be M, L, or XL)
- Create only XS/Small sub-issues (estimate XS or S)
- No implementation, only issue creation
- Complete within 20 minutes (M/L/XL splits with sub-agent research routinely take 15-20 minutes; rushing produces under-researched children)
- Step 4 (codebase research via sub-agents) is **optional** if the issue body already enumerates the artifacts to split (e.g., a list of skills, fragments, or files). Skip Step 4 in that case and decompose directly from the body.

## Quality Guidelines

Good splits have:
- Clear boundaries between sub-issues
- Minimal coupling (each can be understood independently)
- Logical dependency order
- Balanced sizing (avoid 1 XS + 4 S pattern)
- Preserved context from original issue

Avoid:
- Artificial splits (splitting for the sake of splitting)
- Forced granularity (don't decompose past the natural artifact boundary; 10 children is fine if 10 artifacts genuinely exist)
- Missing dependencies (sub-issues that should block each other but don't)
- Lost context (sub-issues that don't reference original scope; child-specific research notes belong inside the child body, not the parent comment)

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
