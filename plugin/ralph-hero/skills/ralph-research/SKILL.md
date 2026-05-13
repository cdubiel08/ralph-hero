---
description: Autonomous research on a GitHub issue — investigates codebase, creates research findings document, updates issue state. Called by hero/team orchestrators, not directly by users. No human interaction — picks an issue, researches it, writes findings, and advances the workflow state. Unlike the interactive research skill (collaborative with user), this runs fully autonomously.
user-invocable: false
argument-hint: "[optional-issue-number] [--playwright] [--no-playwright] [--ux-audit]"
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
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/remember-turn.sh"
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_query_outcomes
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

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

**If issue number provided**: Fetch the full issue details. Response includes group data (sub-issues, dependencies, parent).

**If no issue number**:

1. List issues using profile "analyst-research" (expands to workflowState: "Research Needed"), limit 50.
2. Filter to XS/Small estimates
3. Filter to unblocked issues:
   - An issue is blocked only if `blockedBy` points to issues **outside** its group that are not Done
   - Within-group `blockedBy` is for phase ordering, not blocking
   - **You MUST check each blocker's workflow state** by fetching each blocker issue — this is the most common error source
4. Select highest priority unblocked issue
5. Fetch full issue details on the selected issue to get context including group data

If no eligible issues, respond: "No XS/Small issues need research. Queue empty." Then STOP.

### Step 3: Transition to Research in Progress

Lock the issue (set workflowState to "__LOCK__", command "ralph_research"). If an error is returned, read the message for valid states/intents and retry with corrected parameters.

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

### Step 3c: Knowledge Graph Prior Art Discovery

If `knowledge_search`, `knowledge_traverse`, or `knowledge_query_outcomes` MCP tools are available (from the ralph-knowledge plugin), perform prior-art discovery directly before dispatching sub-agents. If unavailable, skip to Step 4.

This step runs autonomously — no user questions, just detect-and-act. Run the following calls in order:

1. `knowledge_search(query="[issue topic]", type="research", brief=true)` — find prior research documents on this topic.
2. `knowledge_search(query="[issue topic]", type="plan", brief=true)` — find existing plans that may overlap with the issue.
3. `knowledge_query_outcomes(component_area="[area inferred from issue]", aggregate=true)` — if a component area is identifiable from the issue body, files referenced, or the registry lookup in Step 3a, retrieve aggregate pipeline history (pass/fail trends, drift counts, common blockers).

**How to use the results:**
- Skip dispatching `thoughts-locator` for topics already comprehensively covered by prior research found here.
- Target `thoughts-analyzer` at gap areas — components not covered by prior-art results.
- Include outcome trends and prior-art summaries in the research document's Prior Work and Pipeline History sections.

**Brief-first pattern:**
- Use `brief: true` for discovery (returns titles + snippets without full content). Only `Read` documents you select for deep analysis. This saves context window.

If the searches return nothing relevant, proceed to Step 4 with full sub-agent dispatch — the knowledge graph may be stale or sparse on this topic. Do NOT skip sub-agent dispatch on the basis of an empty knowledge result alone.

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
2. **Update GitHub relationships** if order differs from initial triage — add or remove dependency links as needed
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

- builds_on:: [[prior-research-doc]] (research — primary evidence)
- builds_on:: [[prior-plan-doc]] (plan — describes intent, may not reflect outcome)
- tensions:: [[conflicting-idea-doc]] (idea — unvetted, but flags a considered alternative)
```

- `builds_on::` for documents this research extends or was informed by
- `tensions::` for documents whose conclusions conflict with findings here
- Populate from thoughts-locator and thoughts-analyzer results gathered during the research phase, plus any prior-art discovered in Step 3c via `knowledge_search`
- If no relevant prior work exists, include the section with "None identified."
- Use filenames without extension as wikilink targets

**Evidence weighting**: When citing prior work, qualify each entry with its document type to signal evidence strength: `research` is primary evidence (verified findings about what exists), `review` is secondary evidence (findings validated against actual implementation), `plan` is weak evidence (describes intent — may diverge from what was actually built), and `idea` is weakest (unvetted thinking, useful as alternative-considered context). See `plugin/ralph-hero/skills/prove-claim/SKILL.md` (lines 25-35) for the canonical weighting table. Qualifiers are encouraged for new docs; existing Prior Work entries do not need retroactive annotation.

Include: problem statement, current state analysis, key discoveries with file:line references, potential approaches (pros/cons), risks, and recommended next steps.

If pipeline history was retrieved in Step 3c, include a `## Pipeline History` section in the document. Use this template:

```markdown
## Pipeline History
Based on outcome_events for component area `[area]`:
- N total events, X passed, Y failed
- Average drift count: Z files
- Estimate accuracy: [summary]
- Most common blocker: [if patterns emerge]
```

Omit this section entirely if no outcome data was retrieved or `knowledge_query_outcomes` is unavailable. Do not invent data.

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

### Step 7.5: Playwright UI Baseline (conditional)

After writing and committing the research document, optionally capture a UI baseline for frontend-relevant work.

**Skip entirely if:**
- `--no-playwright` was set in args

**Detection (when not skipped):**
1. Read `~/.claude/plugins/installed_plugins.json`
2. Check for a key containing `ralph-playwright` (e.g., `ralph-playwright@ralph-hero`)
3. If not found and `--playwright` not forced: skip — ralph-playwright is not installed

**Frontend relevance (when ralph-playwright detected):**
1. Review the research findings just written — affected files, issue description, component types
2. If the work involves frontend files (.tsx, .jsx, .css, .html, .vue, .svelte), component directories, route/page modifications, UI/UX/visual/layout/accessibility concerns: mark as frontend-relevant
3. If `--playwright` is set: always treat as frontend-relevant
4. If not frontend-relevant: skip baseline capture

**Dev server lifecycle:**
1. Resolve the start command in priority order:
   a. Env var `RALPH_PLAYWRIGHT_DEV_CMD`
   b. Memory — check if a prior conversation saved the dev command for this project
   c. Auto-detect from `package.json` (`dev`, `start`, or `serve` scripts)
2. Start the dev server in background via `Bash(command, run_in_background=true)`
3. Poll for readiness: `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>` every 2s, timeout 30s
4. If the dev server fails to start: log warning, skip baseline, continue
5. Teardown: use `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set, otherwise kill the background process PID

**Baseline capture:**
Dispatch an explorer-agent to capture the current UI state:
```
Agent(subagent_type="ralph-playwright:explorer-agent",
      prompt="Explore http://localhost:<port> with goal: capture accessibility baseline and key user flows relevant to issue #NNN. Focus on routes mentioned in the research: [routes from findings]. Take accessibility snapshots at each page. Session: <date>-baseline-GH-NNN",
      description="UI baseline GH-NNN")
```

**Detect tooling** (in parallel with explorer-agent):
- Check `playwright-stories/` directory: `ls playwright-stories/*.yaml 2>/dev/null | wc -l`
- Check `package.json` for storybook: `grep -E "storybook/addon-vitest|storybook/test-runner" package.json`
- Check `package.json` for visual regression: `grep -E "chromatic|@applitools" package.json`

**Append to research doc:**
After explorer-agent completes, read the journey trace from `.playwright-cli/<session>/journey-trace.yaml` and append a `## UI Baseline` section to the research document:

```markdown
## UI Baseline

**Captured**: YYYY-MM-DD
**Dev server**: `<resolved command>` (port <port>)
**Routes scanned**: /route1, /route2, ...

### Accessibility
- Total violations: N
- Critical: N, Serious: N, Moderate: N
- Categories: [category (count), ...]
- Full report: [journey trace](.playwright-cli/<session>/journey-trace.yaml)

### Flow State
- Entry point: /route
- Key flows: flow1 -> flow2, ...
- Screenshots: [screenshots](.playwright-cli/<session>/)

### Tooling Detected
- Storybook: yes/no (addon name if yes)
- Visual regression: chromatic/applitools/none
- Existing user stories: N files in playwright-stories/
```

**Commit the updated research doc:**
```bash
git add thoughts/shared/research/...
git commit -m "docs(research): add UI baseline for GH-NNN"
git push origin main
```

**Tear down dev server** (use `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` if set, otherwise kill the background process PID).

### Step 8: Update GitHub Issue

1. **Add research document link** as a comment on the issue (use `## Research Document` header):
   ```markdown
   ## Research Document

   https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

   Key findings: [1-3 line summary]
   ```
2. **Add summary comment** with key findings, recommended approach, and group context (if multi-issue group)
3. **Move to "Ready for Plan"**: advance the issue to the next state (workflowState "__COMPLETE__", command "ralph_research").
4. **Record outcome event** (if `knowledge_record_outcome` is available):

   ```
   knowledge_record_outcome(
     event_type="research_completed",
     issue_number=NNN,
     component_area="[discovered area, e.g., src/tools/]",
     verdict="complete",
     model="sonnet",
     agent_type="analyst"
   )
   ```

   Skip silently if the tool is unavailable — do not fail the workflow. This builds the outcome ledger that future research can query (Step 3c).

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
Key recommendation: [One sentence]
```

## Knowledge Tool Degradation

The Step 3c prior-art discovery, evidence weighting, Pipeline History section, and Step 8 outcome recording all depend on optional MCP tools from the ralph-knowledge plugin. They must degrade gracefully:

1. **Tools unavailable** (MCP server not running, plugin not installed, or tools not in the runtime allowlist): skip Step 3c entirely and rely on the `thoughts-locator` sub-agent in Step 4 — it always works via grep/glob and will populate Prior Work via filesystem scan. Add a footnote to the research document under Prior Work: `Knowledge graph unavailable — prior work discovery via file scan only`. Do not block the research workflow on missing knowledge tools.

2. **Tools available but `knowledge_search` returns zero results**: try broader search terms first (remove specific qualifiers, drop component prefixes), then fall back to grep-based search of the `thoughts/` directory. Do NOT skip sub-agent dispatch — an empty knowledge result may indicate a stale or sparsely-indexed graph rather than a true absence of prior art. Continue with full Step 4 sub-agent dispatch and let `thoughts-locator` cross-check the filesystem.

The Step 8 outcome recording (`knowledge_record_outcome`) is also subject to graceful degradation — silently skip the call if the tool is unavailable. The workflow advancement to "Ready for Plan" must still complete even when the outcome ledger cannot be written.

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

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
