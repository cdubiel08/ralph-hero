---
date: 2026-05-01
status: draft
type: plan
github_issue: 726
github_issues: [726, 727, 728]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/726
  - https://github.com/cdubiel08/ralph-hero/issues/727
  - https://github.com/cdubiel08/ralph-hero/issues/728
primary_issue: 726
parent_plan: null
tags: [ralph-knowledge, research-skill, knowledge-graph, prose-instructions, agents]
---

# Knowledge-Aware Research Skills - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-04-knowledge-aware-research-skills]]
- builds_on:: [[2026-03-24-GH-0668-prove-claim-investigative-skill]]
- builds_on:: [[2026-04-03-GH-0723-knowledge-quality-improvements]]

## Overview

3 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-728 | Enhance thoughts-locator and thoughts-analyzer sub-agents with knowledge graph tools | S |
| 2 | GH-726 | Add knowledge-aware prose instructions to `research` (interactive) skill | S |
| 3 | GH-727 | Add knowledge-aware prose instructions to `ralph-research` (autonomous) skill | S |

**Why grouped**: All three issues share the same parent (GH-725) and form a single coherent change — adding knowledge graph awareness to the research workflow. They touch separate files but share the same prose patterns (availability detection, evidence weighting, graceful degradation, brief-first discovery). Implementing them together preserves a consistent vocabulary and lets reviewers verify the pattern is applied uniformly across both skills and both sub-agents. Phase 1 (sub-agents) is sequenced first because both research skills dispatch to these agents — strengthening the agents first means the skills can reference enhanced sub-agent capabilities in their own prose.

## Shared Constraints

These constraints apply to ALL three phases:

1. **Prose-only changes**: No TypeScript, no executable code. Every change is markdown content (frontmatter `tools`/`allowed-tools` lists or skill body prose).
2. **Backward compatibility**: When the ralph-knowledge plugin is not installed, every modified skill/agent must still function via grep/glob/Read fallbacks. No hard dependency on knowledge tools.
3. **Availability detection pattern**: Use the same prose pattern across all four files: "If `knowledge_*` MCP tools are available (from the ralph-knowledge plugin), prefer them. Otherwise, fall back to [grep/glob/Read]." The `thoughts-locator` agent already establishes this pattern at line 49-58 — reuse it.
4. **Evidence weighting vocabulary**: When citing prior work, use the prove-claim weight vocabulary (research = primary, review = secondary, plan = weak, idea = weakest). Reference `plugin/ralph-hero/skills/prove-claim/SKILL.md` lines 25-35 for canonical wording.
5. **Brief-first pattern**: Where applicable, instruct callers to use `brief: true` for discovery and `Read` only for selected documents. This matches prove-claim Step 4 (two-pass reading).
6. **Frontmatter tool ordering**: When adding tools, append knowledge tools after the existing tools list. Preserve existing ordering — don't rewrite the whole list.
7. **Skill descriptions unchanged**: The `description:` field in frontmatter must remain the same — it drives skill triggering and changing it could affect routing.
8. **Hooks unchanged**: `ralph-research` SKILL.md has SessionStart/PreToolUse/PostToolUse/Stop hooks. Do not modify them.
9. **Out of scope**: `knowledge_subgraph` and `knowledge_community` (singular) — these ship with GH-723 and are not yet available. The research doc Opportunity 8 explicitly marks subgraph as post-GH-723. Reference these tools as "future" in prose if needed, but do not add them to allowed-tools yet.
10. **No evals or benchmarks**: Opportunity 10 (skill-creator eval suite) is out of scope for this group — it would be a separate issue under GH-725.

## Current State Analysis

From the research document and direct file inspection:

**Interactive research skill** (`plugin/ralph-hero/skills/research/SKILL.md`):
- 370 lines, opus model, user-invocable
- `allowed-tools` (lines 5-19) lists Read, Write, Edit, Glob, Grep, Bash, Task, Agent, WebSearch, WebFetch, three GitHub MCP tools, AskUserQuestion. No knowledge MCP tools.
- Step 3 (lines 76-110) dispatches sub-agents (codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator, thoughts-analyzer)
- Step 4 (lines 111-121) synthesizes, populates Prior Work
- Step 6.5 (lines 215-273) handles playwright UI baseline (do not modify)
- No availability detection for knowledge tools, no degradation guidance, no evidence weighting, no brief-first pattern, no outcome integration

**Autonomous research skill** (`plugin/ralph-hero/skills/ralph-research/SKILL.md`):
- 418 lines, sonnet model, user-invocable: false (orchestrator-only)
- Has hooks (SessionStart, PreToolUse, PostToolUse, Stop) — preserve all
- `allowed-tools` (lines 30-46) lists Read, Write, Glob, Grep, Bash, Task, Agent, WebSearch, WebFetch, six GitHub MCP tools. No knowledge MCP tools.
- Step 3a/3b (lines 93-145) handles registry lookup and cross-repo detection — these come BEFORE sub-agent dispatch in Step 4
- Step 4 (lines 146-163) dispatches sub-agents
- Step 6 (lines 174-235) writes the research document (frontmatter + Prior Work section + Files Affected)
- Step 8 (lines 336-347) advances the issue to "Ready for Plan" — this is the natural place to record an outcome event

**research-agent** (`plugin/ralph-hero/agents/research-agent.md`):
- 11 lines, single tools line, preloads ralph-research skill via `skills:` field
- Tool list (line 5) must mirror the SKILL.md allowed-tools for the runtime allowlist to admit them

**thoughts-locator** (`plugin/ralph-hero/agents/thoughts-locator.md`):
- 168 lines, haiku model
- Already has `knowledge_search` + `knowledge_traverse` (line 4)
- Already has a "Knowledge Graph (preferred, when available)" section (lines 49-58) — extend this pattern, do not replace it
- Already has a "Relationship Discovery" section (lines 117-148) with both knowledge-tool and grep fallback subsections — model the new tool prose on this same dual structure

**thoughts-analyzer** (`plugin/ralph-hero/agents/thoughts-analyzer.md`):
- 122 lines, sonnet model
- Already has `knowledge_search` + `knowledge_traverse` (line 4)
- Step 1 of "Analysis Strategy" (lines 43-47) mentions `knowledge_search` and `knowledge_traverse` with grep fallback — extend this section

**prove-claim** (reference only — do not modify):
- Lines 5-21 show canonical knowledge tools list (search, traverse, communities, central, bridges, paths, common)
- Lines 25-35 show the evidence weighting table
- Step 2 (multi-entity search fanout) and Step 4 (two-pass brief-then-read) are the patterns being adapted

## Desired End State

After all three phases ship and merge:

### Verification

- [ ] GH-726: `plugin/ralph-hero/skills/research/SKILL.md` lists `knowledge_search`, `knowledge_traverse`, `knowledge_query_outcomes` in `allowed-tools`
- [ ] GH-726: A new "Knowledge Graph Prior Art Discovery" step exists between Step 2 and Step 3 with availability detection, search instructions, and gap-targeting guidance
- [ ] GH-726: The Prior Work section template includes evidence weighting qualifiers (research/review/plan/idea)
- [ ] GH-726: A graceful degradation section exists describing fallback behavior
- [ ] GH-727: `plugin/ralph-hero/skills/ralph-research/SKILL.md` lists the four knowledge tools (search, traverse, query_outcomes, record_outcome) in `allowed-tools`
- [ ] GH-727: `plugin/ralph-hero/agents/research-agent.md` tools line includes the same four knowledge tools
- [ ] GH-727: A new "Knowledge Graph Prior Art Discovery" step exists between Step 3a and Step 4
- [ ] GH-727: The research document template includes a `## Pipeline History` section conditional on outcome data
- [ ] GH-727: Step 8 (or a new sub-step) records a `research_completed` outcome event, wrapped in availability check
- [ ] GH-728: `plugin/ralph-hero/agents/thoughts-locator.md` tools line includes `knowledge_communities`, `knowledge_central`, `knowledge_bridges`
- [ ] GH-728: `plugin/ralph-hero/agents/thoughts-analyzer.md` tools line includes `knowledge_paths`, `knowledge_common`, `knowledge_query_outcomes`
- [ ] GH-728: Both agents have prose explaining when to use each new tool, with grep/glob/Read fallback noted
- [ ] When ralph-knowledge is not installed, both research skills still produce complete research documents with Prior Work populated via thoughts-locator's grep fallback (manual end-to-end test)

## What We're NOT Doing

- Adding `knowledge_subgraph` or `knowledge_community` (singular) — these ship with GH-723 and are out of scope
- Modifying the `prove-claim` skill (it is the reference, not a target)
- Creating a new dedicated `knowledge-researcher` sub-agent — the research doc lists this as an open question (Q1) and the simpler choice is direct tool access
- Modifying `codebase-locator`, `codebase-analyzer`, or `codebase-pattern-finder` — they operate on source code, not thoughts
- Creating a skill-creator eval suite (Opportunity 10) — separate issue
- Changing how `ralph-postmortem` records outcomes (only `research_completed` is added; existing event types are unchanged)
- Modifying the SessionStart/PreToolUse/PostToolUse/Stop hooks on `ralph-research`
- Touching `plan` or `ralph-plan` skills — those have their own knowledge-awareness considerations
- Adding new GitHub Action workflows or release automation
- Bumping the plugin version (the auto-release workflow handles this if mcp-server source changes; these changes are skills-only and likely won't trigger a version bump — confirm during merge)
- Generating evals or benchmarks for the changed skills

## Implementation Approach

Phase 1 enhances both sub-agents with their additional knowledge tools and prose. This is foundational because both research skills dispatch to these agents. After Phase 1, the agents will surface community membership, centrality, bridges, paths, common neighbors, and outcome history — capabilities the research skills can reference in their own prose.

Phase 2 modifies the interactive research skill: adds three knowledge tools to its allowlist, inserts a "Knowledge Graph Prior Art Discovery" step (between current Step 2 and Step 3), adds evidence weighting to the Prior Work template, adds a graceful degradation section, and adds brief-first pattern guidance.

Phase 3 modifies the autonomous research skill and its agent: adds four knowledge tools to both allowlists, inserts the same prior-art discovery step (between current Step 3a/3b and Step 4 — preserving registry lookup ordering), adds a Pipeline History section to the research document template, adds outcome recording at Step 8, and adds the same evidence weighting + degradation prose as Phase 2.

Phase 2 and Phase 3 use almost identical prose patterns. Phase 2 is sequenced first because the interactive skill is simpler (no hooks, no registry lookup, no outcome recording) and validates the prose template before applying it to the more complex autonomous skill.

---

## Phase 1: Enhance thoughts-locator and thoughts-analyzer sub-agents (GH-728)
- **depends_on**: null

### Overview

Add three knowledge graph tools to each sub-agent's tools list and extend their existing prose sections with guidance on when and how to use the new tools. Both agents already have a knowledge-tools-with-grep-fallback pattern — extend it, don't replace it.

### Tasks

#### Task 1.1: Enhance thoughts-locator with community, central, bridges tools
- **files**: `plugin/ralph-hero/agents/thoughts-locator.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter `tools` line (line 4) appends `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_communities`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_central`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_bridges` after `knowledge_traverse`, comma-separated
  - [ ] The "Knowledge Graph (preferred, when available)" section (currently lines 49-58) gains three new numbered bullets after item 3, one per new tool, each with: (a) the call signature, (b) one sentence on when to use it, (c) one sentence on what it returns
  - [ ] Community discovery prose: "Use `knowledge_communities` to find document clusters on the search topic. Report the community label and member count alongside individual document results."
  - [ ] Central documents prose: "Use `knowledge_central` scoped to a community ID to find the most-cited documents in a cluster. These are likely foundational references."
  - [ ] Cross-cutting documents prose: "Use `knowledge_bridges` to find documents that connect different topic areas — these bridge documents often contain key architectural decisions."
  - [ ] An "Availability check" sentence is added: "All graph tools are optional. If unavailable, fall back to existing grep/glob patterns."
  - [ ] No existing content is removed; the grep fallback section (lines 59 onward) is unchanged
  - [ ] File still parses as valid markdown with valid YAML frontmatter

#### Task 1.2: Enhance thoughts-analyzer with paths, common, query_outcomes tools
- **files**: `plugin/ralph-hero/agents/thoughts-analyzer.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter `tools` line (line 4) appends `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_paths`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_common`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_query_outcomes` after `knowledge_traverse`, comma-separated
  - [ ] The "Analysis Strategy" -> "Step 1: Discover Context" section (lines 43-47) is extended with three new bullets, one per new tool:
    - "Use `knowledge_paths` between two documents to understand how they connect through the graph. Assess path quality — short paths through topically relevant intermediaries are stronger."
    - "Use `knowledge_common` to find documents that two analyzed docs share as neighbors — these often provide missing context."
    - "Use `knowledge_query_outcomes` to check whether conclusions from prior research were validated by implementation (pass/fail verdicts, drift counts)."
  - [ ] An "Availability check" sentence is added: "All tools are optional. If unavailable, fall back to existing grep/glob + Read patterns."
  - [ ] No existing content is removed
  - [ ] File still parses as valid markdown with valid YAML frontmatter

### Phase Success Criteria

#### Automated Verification:
- [x] Both files lint as valid YAML frontmatter (no parse errors when the agent loader reads them)
- [x] `grep -c "knowledge_communities" plugin/ralph-hero/agents/thoughts-locator.md` returns >= 1 (tool listed and used in prose)
- [x] `grep -c "knowledge_paths" plugin/ralph-hero/agents/thoughts-analyzer.md` returns >= 1

#### Manual Verification:
- [ ] Reading thoughts-locator.md end-to-end, the new tools' use cases are clear and distinct from each other
- [ ] Reading thoughts-analyzer.md end-to-end, the analyst would know when to use paths vs. common vs. query_outcomes
- [ ] Both agents' "if unavailable, fall back to..." prose is consistent in tone and structure

**Creates for next phase**: Sub-agents now expose richer knowledge graph capabilities that the research skills can reference in their prose (e.g., "thoughts-locator can find communities and bridge documents — use it for topic-landscape questions").

---

## Phase 2: Add knowledge-aware prose instructions to interactive `research` skill (GH-726)
- **depends_on**: [phase-1]

### Overview

Add `knowledge_search`, `knowledge_traverse`, and `knowledge_query_outcomes` to the interactive research skill's allowed-tools, insert a "Knowledge Graph Prior Art Discovery" step between current Step 2 (decompose question) and Step 3 (sub-agent dispatch), add evidence weighting qualifiers to the Prior Work template, add brief-first pattern guidance, and add a graceful degradation section.

### Tasks

#### Task 2.1: Add knowledge tools to allowed-tools frontmatter
- **files**: `plugin/ralph-hero/skills/research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] After line 18 (`AskUserQuestion`), three new entries are inserted in the `allowed-tools` list (or appended after `AskUserQuestion`):
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_query_outcomes`
  - [ ] Each entry uses the same `  - mcp__...` indentation as the existing entries
  - [ ] YAML frontmatter remains valid (no syntax errors)
  - [ ] Existing entries (Read, Write, Edit, etc.) are not removed or reordered

#### Task 2.2: Insert "Knowledge Graph Prior Art Discovery" step
- **files**: `plugin/ralph-hero/skills/research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] A new section titled `### Step 2.5: Knowledge Graph Prior Art Discovery` is inserted between current Step 2 (line 70-74) and Step 3 (line 76)
  - [ ] The section opens with availability detection prose: "If `knowledge_search`, `knowledge_traverse`, or `knowledge_query_outcomes` MCP tools are available (from the ralph-knowledge plugin), perform prior-art discovery directly before dispatching sub-agents. If unavailable, skip to Step 3."
  - [ ] The section instructs (in this order):
    1. `knowledge_search(query="[research topic]", type="research", brief=true)` — find prior research
    2. `knowledge_search(query="[research topic]", type="plan", brief=true)` — find existing plans
    3. (Optional) `knowledge_query_outcomes(component_area="[area]", aggregate=true)` if the issue maps to a known component area
  - [ ] The section explains how to use results: "Use these results to (a) skip dispatching `thoughts-locator` for topics already well-documented, (b) target `thoughts-analyzer` at the highest-relevance documents found, and (c) include prior-art summaries in the research document's Prior Work section."
  - [ ] The section explains brief-first pattern: "Use `brief: true` for discovery (returns titles + snippets without full content). Only `Read` documents you select for deep analysis. This saves context window."
  - [ ] After the new step, Step 3 (sub-agent dispatch) numbering is preserved (do not renumber subsequent steps — Step 2.5 is intentionally a half-step)
  - [ ] The section is at most ~40 lines of prose

#### Task 2.3: Add evidence weighting to Prior Work section template
- **files**: `plugin/ralph-hero/skills/research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] In the document template (Step 7, around line 178-181), the Prior Work example is extended to show evidence weight qualifiers in parenthetical comments:
    ```markdown
    ## Prior Work
    - builds_on:: [[prior-research-doc]] (research — primary evidence)
    - builds_on:: [[prior-plan-doc]] (plan — describes intent, may not reflect outcome)
    - tensions:: [[conflicting-idea-doc]] (idea — unvetted, but flags a considered alternative)
    ```
  - [ ] A short prose paragraph follows the example explaining the four-tier weighting (research = primary, review = secondary, plan = weak, idea = weakest), citing prove-claim as the canonical reference
  - [ ] The change does not require existing Prior Work entries in other plans/research to be re-annotated retroactively — qualifiers are encouraged for new docs only

#### Task 2.4: Add Knowledge Tool Degradation section
- **files**: `plugin/ralph-hero/skills/research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] A new top-level section `## Knowledge Tool Degradation` is added near the end of the file, before "## Important notes" (around line 343)
  - [ ] The section enumerates two scenarios:
    1. **Tools unavailable** (MCP server not running, tools not in allowlist): fall back to thoughts-locator sub-agent (always works via grep/glob); add a footnote in the research document: "Knowledge graph unavailable — prior work discovery via file scan only"
    2. **Tools available but `knowledge_search` returns zero results**: try broader terms (remove specific qualifiers), then fall back to grep-based search of `thoughts/` directory; do not skip sub-agent dispatch — knowledge graph may be stale
  - [ ] Each scenario is one short paragraph (3-5 sentences), no nested code blocks beyond what the example calls require

#### Task 2.5: Update Step 4 synthesis prose to mention knowledge-tool findings
- **files**: `plugin/ralph-hero/skills/research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.2]
- **acceptance**:
  - [ ] In Step 4 (lines 111-121), the bullet "Populate the `## Prior Work` section with `builds_on::` wikilinks..." (line 120) is extended to read: "Populate the `## Prior Work` section with `builds_on::` wikilinks to related research and plan documents discovered by the thoughts-locator agent **and by the Step 2.5 knowledge graph search (if performed)**."
  - [ ] A new bullet is added: "If pipeline history was queried in Step 2.5, summarize key outcome trends in the synthesis."
  - [ ] No other Step 4 bullets are modified

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "knowledge_search" plugin/ralph-hero/skills/research/SKILL.md` returns >= 3 (frontmatter + Step 2.5 + degradation section)
- [ ] `grep -c "Step 2.5" plugin/ralph-hero/skills/research/SKILL.md` returns >= 1
- [ ] `grep -c "Knowledge Tool Degradation" plugin/ralph-hero/skills/research/SKILL.md` returns >= 1
- [ ] `grep -c "primary evidence" plugin/ralph-hero/skills/research/SKILL.md` returns >= 1 (evidence weighting added)
- [ ] YAML frontmatter parses without errors

#### Manual Verification:
- [ ] Reading the skill end-to-end, the new flow is: read mentioned files -> decompose question -> Step 2.5 (knowledge graph prior art) -> dispatch sub-agents -> synthesize -> present findings -> generate document
- [ ] The degradation section reads as a clear, scoped fallback policy — not a new feature
- [ ] Evidence weighting prose is consistent with prove-claim's vocabulary

**Creates for next phase**: A working prose template (Step 2.5 wording, evidence weighting qualifiers, degradation section) that Phase 3 reuses for the autonomous skill.

---

## Phase 3: Add knowledge-aware prose instructions to autonomous `ralph-research` skill (GH-727)
- **depends_on**: [phase-2]

### Overview

Apply the same prose patterns from Phase 2 to the autonomous research skill, plus add outcome recording (autonomous-only) and a Pipeline History section in the research document template. Update the research-agent's tools list to mirror the skill's allowed-tools.

### Tasks

#### Task 3.1: Add knowledge tools to ralph-research allowed-tools frontmatter
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] After line 45 (`remove_dependency`), four new entries are appended in the `allowed-tools` list:
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_query_outcomes`
    - `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome`
  - [ ] Each entry uses the same `  - mcp__...` indentation as existing entries
  - [ ] Existing entries are not removed or reordered
  - [ ] Hooks block (lines 7-29) is unchanged
  - [ ] YAML frontmatter parses without errors

#### Task 3.2: Add knowledge tools to research-agent
- **files**: `plugin/ralph-hero/agents/research-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The `tools:` line (line 5) appends the same four knowledge tools (search, traverse, query_outcomes, record_outcome) at the end of the comma-separated list
  - [ ] The list remains a single line (existing format)
  - [ ] No other frontmatter fields change
  - [ ] The file is still 11 lines (or 11+1 if the line wraps — visual length doesn't matter, only parseability)

#### Task 3.3: Insert "Knowledge Graph Prior Art Discovery" step between Step 3b and Step 4
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] A new section titled `### Step 3c: Knowledge Graph Prior Art Discovery` is inserted between current Step 3b (lines 118-144) and Step 4 (line 146)
  - [ ] The section opens with availability detection prose mirroring Phase 2 wording: "If `knowledge_search`, `knowledge_traverse`, or `knowledge_query_outcomes` MCP tools are available, perform prior-art discovery directly before dispatching sub-agents. If unavailable, skip to Step 4."
  - [ ] The section instructs (in this order):
    1. `knowledge_search(query="[issue topic]", type="research", brief=true)`
    2. `knowledge_search(query="[issue topic]", type="plan", brief=true)`
    3. `knowledge_query_outcomes(component_area="[area inferred from issue]", aggregate=true)` if a component area is identifiable
  - [ ] The section explains how to use results: skip redundant `thoughts-locator` dispatch when prior research is already comprehensive, target `thoughts-analyzer` at gap areas, include outcome trends in the research document
  - [ ] The section explains brief-first pattern (same wording as Phase 2)
  - [ ] Step numbering of subsequent steps (Step 4, 5, 6, 7, 7.5, 8, 9, 10) is preserved — Step 3c is a half-step like Phase 2's Step 2.5
  - [ ] The section is at most ~40 lines of prose

#### Task 3.4: Add Pipeline History section to research document template
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] In Step 6 (Create Research Document, around line 207-209), after the "problem statement, current state analysis..." paragraph, add a new instruction: "If pipeline history was retrieved in Step 3c, include a `## Pipeline History` section in the document."
  - [ ] A template example is included:
    ```markdown
    ## Pipeline History
    Based on outcome_events for component area `[area]`:
    - N total events, X passed, Y failed
    - Average drift count: Z files
    - Estimate accuracy: [summary]
    - Most common blocker: [if patterns emerge]
    ```
  - [ ] A note is added: "Omit this section entirely if no outcome data was retrieved or `knowledge_query_outcomes` is unavailable. Do not invent data."

#### Task 3.5: Add outcome recording at Step 8
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] In Step 8 (lines 336-347), after the "Move to Ready for Plan" instruction, add a new sub-step `4. **Record outcome event** (if knowledge_record_outcome is available)`:
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
  - [ ] The instruction is wrapped in availability prose: "Skip silently if the tool is unavailable — do not fail the workflow."
  - [ ] A short rationale sentence: "This builds the outcome ledger that future research can query (Step 3c)."
  - [ ] The Step 8 numbered sequence remains coherent (existing items 1-3, new item 4)

#### Task 3.6: Add evidence weighting and degradation prose to ralph-research
- **files**: `plugin/ralph-hero/skills/ralph-research/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.3]
- **acceptance**:
  - [ ] The Prior Work section template in Step 6 (lines 192-206) is extended with evidence weighting prose mirroring Phase 2 Task 2.3 (research = primary, review = secondary, plan = weak, idea = weakest)
  - [ ] A new section `## Knowledge Tool Degradation` is added near the end of the file, before "## Available Filter Profiles" (around line 372), with the same two-scenario structure as Phase 2 Task 2.4
  - [ ] A note is added under the degradation section that outcome recording (Task 3.5) is also subject to graceful degradation — silent skip on unavailability
  - [ ] No existing sections (Constraints, Research Quality, Escalation Protocol, Link Formatting) are modified

### Phase Success Criteria

#### Automated Verification:
- [ ] `grep -c "knowledge_search" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 3
- [ ] `grep -c "knowledge_record_outcome" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 2 (frontmatter + Step 8)
- [ ] `grep -c "Step 3c" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [ ] `grep -c "Pipeline History" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [ ] `grep -c "Knowledge Tool Degradation" plugin/ralph-hero/skills/ralph-research/SKILL.md` returns >= 1
- [ ] `grep -c "knowledge_search\|knowledge_record_outcome" plugin/ralph-hero/agents/research-agent.md` returns >= 2
- [ ] YAML frontmatter on both files parses without errors
- [ ] Hooks block in ralph-research SKILL.md is unchanged (verify by reading lines 7-29 — same content as before)

#### Manual Verification:
- [ ] The autonomous skill's prose mirrors the interactive skill's structure (Step 2.5 in interactive corresponds to Step 3c in autonomous, accounting for registry-lookup steps)
- [ ] Outcome recording instructions are clear and the example call signature matches `knowledge_record_outcome`'s actual schema
- [ ] Pipeline History section template is clearly conditional (omit if no data)
- [ ] research-agent's tools list mirrors the skill's allowed-tools (per the architecture rule that agents must be a hard allowlist matching their preloaded skill)

**Creates for the integration test**: All four files (two skills + two agents) now have consistent knowledge-aware prose. The PR can be tested end-to-end.

---

## Integration Testing

- [ ] **Skill-load smoke test**: With the ralph-knowledge plugin installed and built, restart Claude Code and invoke `/ralph-hero:research` with a topic that has known prior research (e.g., "ralph-knowledge dream loop"). Verify the skill calls `knowledge_search` before dispatching sub-agents and the resulting research document's Prior Work section includes evidence weight qualifiers.
- [ ] **Degradation smoke test**: Temporarily remove the ralph-knowledge plugin from `~/.claude/plugins/installed_plugins.json` (or rename its directory). Invoke `/ralph-hero:research` on the same topic. Verify the skill still produces a research document, with thoughts-locator filling the Prior Work section via grep, and the document contains the degradation footnote.
- [ ] **Autonomous outcome recording**: Run `ralph-research` on a test issue (one in "Research Needed"). After it advances the issue to "Ready for Plan", check the knowledge DB: `sqlite3 ~/.ralph-hero/knowledge.db "SELECT event_type, issue_number, verdict FROM outcome_events ORDER BY id DESC LIMIT 5"` should show a new `research_completed` row.
- [ ] **Sub-agent capability test**: Spawn `thoughts-locator` directly with a query about a topic spanning multiple research clusters. Verify it reports community labels and central documents (when knowledge graph is available). Spawn `thoughts-analyzer` on two related research docs and verify it cites paths and common neighbors.
- [ ] **Frontmatter parse**: Run a YAML lint or simple node script that loads each modified file's frontmatter. None should error.
- [ ] **No regressions on hooks**: Inspect ralph-research skill loading in a session — SessionStart, PreToolUse, PostToolUse, Stop hooks all fire as before. The branch-gate, research-state-gate, research-postcondition, doc-structure-validator, and lock-release-on-failure scripts run unchanged.
- [ ] **Cross-repo behavior unchanged**: Run ralph-research on a cross-repo issue (one with `.ralph-repos.yml` registry entries). Verify Step 3a/3b registry lookup still occurs before the new Step 3c knowledge discovery.

## References

- Research: [knowledge-aware-research-skills](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-04-knowledge-aware-research-skills.md)
- Parent epic: [GH-725](https://github.com/cdubiel08/ralph-hero/issues/725)
- Component issues:
  - [GH-726 — Interactive research skill](https://github.com/cdubiel08/ralph-hero/issues/726)
  - [GH-727 — Autonomous ralph-research skill](https://github.com/cdubiel08/ralph-hero/issues/727)
  - [GH-728 — thoughts-locator/thoughts-analyzer](https://github.com/cdubiel08/ralph-hero/issues/728)
- Reference skill (do not modify): [`plugin/ralph-hero/skills/prove-claim/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/prove-claim/SKILL.md)
- Affected files (current state):
  - [`plugin/ralph-hero/skills/research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/research/SKILL.md)
  - [`plugin/ralph-hero/skills/ralph-research/SKILL.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/ralph-research/SKILL.md)
  - [`plugin/ralph-hero/agents/research-agent.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/research-agent.md)
  - [`plugin/ralph-hero/agents/thoughts-locator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/thoughts-locator.md)
  - [`plugin/ralph-hero/agents/thoughts-analyzer.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/thoughts-analyzer.md)
- Outcome events schema: [`plugin/ralph-knowledge/src/db.ts:130-151`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-knowledge/src/db.ts#L130-L151)
- Knowledge metadata fragment: [`plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/fragments/knowledge-metadata.md)
