---
description: Autonomous research on a GitHub issue — investigates codebase, creates research findings document, updates issue state. Called by hero/team orchestrators, not directly by users. No human interaction — picks an issue, researches it, writes findings, and advances the workflow state. Unlike the interactive research skill (collaborative with user), this runs fully autonomously.
user-invocable: false
argument-hint: [optional-issue-number]
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main"
  PreToolUse:
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/branch-gate.sh"
  PostToolUse:
    - matcher: "ralph_hero__get_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-state-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/research-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - WebSearch
  - WebFetch
  - ralph_hero__get_issue
  - ralph_hero__list_issues
  - ralph_hero__save_issue
  - ralph_hero__create_comment
  - ralph_hero__add_dependency
  - ralph_hero__remove_dependency
---

# Ralph GitHub Research - Naive Hero Mode

You are a naive hero researcher. You pick ONE issue, research it thoroughly, document findings, and move on. No questions, no interruptions - just do your best work.

## Workflow

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/knowledge-metadata.md

### Step 1: Verify Branch

```bash
git branch --show-current
```

If NOT on `main`, STOP: "Cannot run /ralph-research from branch: [branch-name]. Please switch to main first."

### Step 2: Select Issue

**If issue number provided**: Call `ralph_hero__get_issue(owner, repo, number)`. Response includes group data (sub-issues, dependencies, parent).

**If no issue number**:

1. Call `ralph_hero__list_issues(owner, repo, profile="analyst-research", limit=50)`
   <!-- Profile expands to: workflowState="Research Needed" -->
2. Filter to XS/Small estimates
3. Filter to unblocked issues:
   - An issue is blocked only if `blockedBy` points to issues **outside** its group that are not Done
   - Within-group `blockedBy` is for phase ordering, not blocking
   - **You MUST check each blocker's workflow state** via `ralph_hero__get_issue` -- this is the most common error source
4. Select highest priority unblocked issue
5. Call `ralph_hero__get_issue(owner, repo, number)` on the selected issue to get full context including group data

If no eligible issues, respond: "No XS/Small issues need research. Queue empty." Then STOP.

### Step 3: Transition to Research in Progress

```
ralph_hero__save_issue
- number: [issue-number]
- workflowState: "__LOCK__"
- command: "ralph_research"
```

If `save_issue` returns an error, read the error message for valid states/intents and retry with corrected parameters.

### Step 3a: Registry Lookup (Cross-Repo Detection)

Before dispatching sub-agents, check if the issue may span multiple repos:

1. **Load registry:** Read `.ralph-repos.yml` from the repo root using the `Read` tool. Parse the YAML to extract available repos, their `localDir` paths, and patterns. If the file does not exist, skip this step (single-repo mode).

   > **Why `Read` instead of `decompose_feature`?** The research skill has `Read` in its `allowed-tools` and can parse YAML from the file contents directly. Using `decompose_feature` with no `pattern` is an undocumented side-channel. `Read` is simpler and always available.

2. **Check for cross-repo scope:** Look for signals in the issue body/title:
   - References to files in other repos (e.g., "update the MCP server" when researching a skill issue)
   - Mentions of repo names from the registry
   - Import paths or package references that map to other repos

3. **If cross-repo scope detected:**
   - Note which repos are involved and their `localDir` paths from the registry
   - Pass the additional repo directories to sub-agents in their spawn prompts:
     ```
     Additional repo directories to search:
     - ralph-hero: ~/projects/ralph-hero
     - landcrawler-ai: ~/projects/landcrawler-ai
     ```
   - Sub-agents use standard `Read`, `Grep`, `Glob` with those paths — no new tooling

4. **If single-repo:** Proceed unchanged (existing behavior).

### Step 3b: Cross-Repo Dependency Detection

When cross-repo scope is detected (during the registry lookup above), add an additional research task:

**Detect undeclared dependencies between repos:**

1. Search for direct imports between repos:
   ```
   For each pair of repos in scope:
   - Grep for import/require statements referencing the other repo's package name
   - Check package.json dependencies for cross-references
   - Look for shared types, API clients, or SDK references
   ```

2. **Compare against registry:** Check if found dependencies match the `dependency-flow` edges in the registry pattern.

3. **Flag discrepancies:** If imports exist but no `dependency-flow` edge is declared:
   ```markdown
   ## Dependency Discrepancy

   Found: `landcrawler-ai` imports from `ralph-hero` (package: `ralph-hero-mcp-server`)
   Registry: No `dependency-flow` edge declared between ralph-hero and landcrawler-ai

   Recommendation: Add `ralph-hero -> landcrawler-ai` to the pattern's dependency-flow
   ```

This information is consumed by the hero skill during tree expansion to override the default "assume independent" behavior when evidence contradicts the registry.

### Step 4: Conduct Research

1. **Read issue thoroughly** - understand the problem from user perspective
2. **Review any linked documents** - prior research, related issues
3. **Spawn parallel sub-tasks** using the Task tool with specialized agents:
   - `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find all files related to [issue topic]")`
   - `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Understand current implementation of [component]")`
   - `Agent(subagent_type="ralph-hero:codebase-pattern-finder", prompt="Find similar patterns to model after for [feature]")`
   - `Agent(subagent_type="ralph-hero:thoughts-locator", prompt="Find existing research or decisions about [topic]")`
   - `Agent(subagent_type="ralph-hero:thoughts-analyzer", prompt="Extract key findings and decisions from existing research about [topic]")`
   - `Agent(subagent_type="ralph-hero:web-search-researcher", prompt="External APIs, best practices for [topic]")` (if needed)

   > **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls. Sub-agents must run outside any team context.

4. **Wait for ALL sub-tasks** before proceeding
5. **Synthesize findings** - combine results into coherent understanding
6. **Document findings unbiasedly** - don't pre-judge the solution

### Step 5: Refine Group Dependencies

**Skip if single-issue group** (no blocking relationships or shared parent).

After researching, refine dependency relationships based on code analysis:

1. **Analyze implementation order**: Which issue creates foundational code? Which can be parallelized?
2. **Update GitHub relationships** if order differs from initial triage using `ralph_hero__add_dependency` / `ralph_hero__remove_dependency`
3. **Add research comment** with implementation order analysis

### Step 6: Create Research Document

Write to: `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md`

Frontmatter:
```yaml
---
date: YYYY-MM-DD
github_issue: NNN
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
status: complete
type: research
tags: [topic1, topic2]
---
```

Include 2-5 tags describing the key concepts (e.g., caching, auth, mcp-server, performance). Use lowercase, hyphenated terms. Reuse existing tags from prior documents when applicable.

The document must begin with a `## Prior Work` section immediately after the title (before Problem Statement):

```markdown
## Prior Work

- builds_on:: [[document-filename-without-extension]]
- tensions:: [[document-filename-without-extension]]
```

- `builds_on::` for documents this research extends or was informed by
- `tensions::` for documents whose conclusions conflict with findings here
- Populate from thoughts-locator and thoughts-analyzer results gathered during the research phase
- If no relevant prior work exists, include the section with "None identified."
- Use filenames without extension as wikilink targets

Include: problem statement, current state analysis, key discoveries with file:line references, potential approaches (pros/cons), risks, and recommended next steps.

The document **must** include a `## Files Affected` section with two subsections:

```markdown
## Files Affected

### Will Modify
- `src/auth/middleware.ts` - Add token refresh logic
- `src/auth/types.ts` - New RefreshToken type

### Will Read (Dependencies)
- `src/config/auth-config.ts` - Token expiry settings
- `src/lib/http-client.ts` - Existing request interceptor pattern
```

Rules:
- Paths are relative to repo root
- `Will Modify` = files this issue needs to create or change
- `Will Read` = files this issue depends on but won't change
- Each path must be backtick-wrapped (parseable via regex `` `[^`]+` ``)
- Both subsections are required even if empty (use "None" if no files apply)
- This section is validated by the research postcondition hook
- **Cross-repo:** For cross-repo issues, prefix file paths with the repo key:
  - `ralph-hero:plugin/ralph-hero/mcp-server/src/lib/repo-registry.ts`
  - `landcrawler-ai:src/api/client.ts`
  This repo-qualified format is required for correct work-stream detection when the hero skill clusters cross-repo issues.

### Cross-Repo Scope (if applicable)

If cross-repo scope was detected during research, include this section in the research document:

```markdown
## Cross-Repo Scope

Repos involved:
- `ralph-hero` (~/projects/ralph-hero) — [what changes are needed]
- `landcrawler-ai` (~/projects/landcrawler-ai) — [what changes are needed]

Dependency relationship: ralph-hero → landcrawler-ai (landcrawler-ai imports from ralph-hero)
```

This section is consumed by the plan and impl skills to set up per-repo worktrees and wire `blockedBy` dependencies.

### Step 7: Commit and Push

```bash
git add thoughts/shared/research/YYYY-MM-DD-GH-NNNN-*.md
git commit -m "docs(research): GH-NNN research findings"
git push origin main
```

### Step 8: Update GitHub Issue

1. **Add research document link** as comment with the `## Research Document` header:
   ```
   ralph_hero__create_comment
   - owner: $RALPH_GH_OWNER
   - repo: $RALPH_GH_REPO
   - number: [issue-number]
   - body: |
       ## Research Document

       https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

       Key findings: [1-3 line summary]
   ```
2. **Add summary comment** with key findings, recommended approach, and group context (if multi-issue group)
3. **Move to "Ready for Plan"**:
   ```
   ralph_hero__save_issue
   - number: [issue-number]
   - workflowState: "__COMPLETE__"
   - command: "ralph_research"
   ```

### Step 9: Team Result Reporting

When running as a team worker, mark your assigned task complete via TaskUpdate. Include key results in metadata (artifact path, workflow state) and a human-readable summary in the description. Then check TaskList for more work matching your role.

### Step 10: Report Completion

**Single-issue group:**
```
Research complete for #NNN: [Title]
Findings: thoughts/shared/research/[filename].md
Status: Ready for Plan
Key recommendation: [One sentence]
```

**Multi-issue group:**
```
Research complete for #NNN: [Title]
Findings: thoughts/shared/research/[filename].md
Status: Ready for Plan
Group status: [M of N] issues researched
[If all done]: Group ready for planning. Run /ralph-plan.
[If not]: Run /ralph-research to continue group research.
Key recommendation: [One sentence]
```

## Available Filter Profiles

| Profile | Expands To | Use Case |
|---------|-----------|----------|
| `analyst-research` | `workflowState: "Research Needed"` | Find items needing research |

Profiles set default filters. Explicit params override profile defaults.

## Constraints

- Work on ONE issue only
- XS/Small estimates only (exit if none available)
- No questions - make reasonable assumptions
- No code changes - research only
- Complete within 15 minutes

## Research Quality

See [shared/quality-standards.md](../shared/quality-standards.md) for canonical research quality dimensions (Depth, Feasibility, Risk, Actionability) and anti-patterns.

## Escalation Protocol

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md

**Research-specific triggers:**

| Situation | Action |
|-----------|--------|
| Issue scope larger than XS/S | Escalate: "This is [M/L/XL] complexity. Needs re-estimation or splitting." |
| Cannot find relevant codebase patterns | Escalate: "Unable to locate relevant code for [topic]. Need guidance." |
| Conflicting implementations found | Escalate: "Found conflicting patterns: [A] vs [B]. Which to follow?" |

## Link Formatting

**Single-repo (default):**

| Reference type | Format |
|---------------|--------|
| File only | `[path/file.py](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py)` |
| With line | `[path/file.py:42](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42)` |
| Line range | `[path/file.py:42-50](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/path/file.py#L42-L50)` |

**Cross-repo:** Resolve owner/repo from the registry entry for each file:
- `[repo-name:path/file.py](https://github.com/{owner}/{repo}/blob/main/path/file.py)`

When operating on a cross-repo issue, look up each file's repo in the registry to get the correct `owner` and repo name for link URLs. Do NOT hardcode `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in other repos.
