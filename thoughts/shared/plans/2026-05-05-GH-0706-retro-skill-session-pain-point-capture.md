---
date: 2026-05-05
status: draft
type: plan
github_issue: 706
github_issues: [706]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/706
primary_issue: 706
tags: [skills, retro, feedback-loop, conversation-context, inline-skill]
---

# ralph-hero:retro — Session Pain-Point Capture Skill — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-05-GH-0706-retro-skill-session-pain-point-capture]] (research — primary evidence; defines Option A approach, sub-agent grounding pattern, output format contract)
- builds_on:: [[2026-03-21-autonomous-experiment-loop-patterns]] (research — feedback loop gap analysis; experiment ledger insight)
- builds_on:: [[2026-03-20-skill-dispatch-inventory]] (research — inline vs. fork context semantics)

## Overview

Single-issue plan with one implementation phase plus optional inventory update.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-706 | feat(skill): add ralph-hero:retro for session pain-point capture | S |

## Shared Constraints

The following constraints apply to all phases of this plan, derived from the research document and the existing skill conventions:

1. **Inline context is non-negotiable** — the skill must NOT declare `context: fork`. Either omit the `context:` field entirely (defaults to inline) or explicitly set `context: inline`. A forked retro would have an empty conversation window and no pain points to extract.

2. **Output format must satisfy `/form` and `/plan` intake contracts** — the research doc produced by retro must include:
   - YAML frontmatter with `type: research`, `status: complete`, `date`, `tags`
   - `## Prior Work` section
   - `## Files Affected` with `### Will Modify` and `### Will Read` subsections (use "None" entries explicitly when no files apply — the postcondition hook validates section presence, not non-emptiness)
   - `## Summary` and `## Detailed Findings` sections

3. **Sub-agent grounding is conditional, not universal** — `codebase-locator` and `codebase-analyzer` must only be dispatched for pain points that explicitly reference specific code paths or components. Dispatching them for tooling/UX/conceptual friction wastes tokens and produces low-signal output. Follow the `draft` skill's "Only if the idea references specific parts of the codebase" pattern.

4. **No `team_name` parameter on internal `Agent()` calls** — sub-agent team isolation per project convention (consistent with `draft`, `research`, `form`).

5. **Model selection: opus** — the core value of retro is extraction quality + categorization judgment over conversation context. Sonnet produces shallower analysis per the research recommendation.

6. **Postmortem dedup detection** — if `TaskList` is available in the calling session (signals a team-mode shutdown), the skill must surface a recommendation to use `ralph-postmortem` instead before producing output. This prevents overlap when both skills could capture the same friction.

7. **Standard skill location** — `plugin/ralph-hero/skills/retro/SKILL.md` (single-file skill, matching `ralph-postmortem` layout). Optional `eval-scenarios.md` is not required for this issue.

## Current State Analysis

The repository has 30+ skills under `plugin/ralph-hero/skills/`. There is no `retro/` directory — the slot is open. The closest analogs are:

- **`ralph-postmortem/SKILL.md`** — autonomous, called by team skill at shutdown, reads `TaskList`/`TaskGet` for structured task data, writes to `thoughts/shared/reports/`. Different scope: team sessions only, no codebase grounding, no conversation extraction.
- **`draft/SKILL.md`** — inline (no `context:`), user-invocable, optional single sub-agent dispatch (`codebase-locator`), AskUserQuestion closing. Produces `idea` docs in `thoughts/shared/ideas/`. Closest structural template for retro's invocation flow.
- **`research/SKILL.md`** (interactive) — `model: opus`, full sub-agent dispatch (locator + analyzer + thoughts-locator + thoughts-analyzer), AskUserQuestion findings review and next-steps picker, writes `thoughts/shared/research/`. Closest template for retro's output format and dispatch pattern.

The two sub-agents retro will reuse exist and require no modification:
- `plugin/ralph-hero/agents/codebase-locator.md` — haiku model, Grep/Glob/Bash tools
- `plugin/ralph-hero/agents/codebase-analyzer.md` — sonnet model, Read/Grep/Glob/Bash tools

The form skill's research-doc intake path (Step 2 of `form/SKILL.md`) confirms downstream compatibility: when `INPUT_TYPE == "research"`, `/form` skips the locator/analyzer dispatch and runs only `thoughts-locator` + duplicate search. Retro's output format is therefore already compatible — no `/form` changes are required.

## Desired End State

### Verification

- [ ] `plugin/ralph-hero/skills/retro/SKILL.md` exists with valid YAML frontmatter
- [ ] Skill description follows ralph-hero conventions (matches issue #706's design table)
- [ ] Skill declares `model: opus` (or omits and inherits caller's model where appropriate)
- [ ] Skill does NOT declare `context: fork`
- [ ] Skill `allowed-tools` includes the tools required by Step bodies (Write, Read, Agent, AskUserQuestion, Bash, Glob, Grep, optional knowledge_search/knowledge_record_outcome)
- [ ] Skill body produces a research doc compatible with `/form` and `/plan` intake (frontmatter, Prior Work, Files Affected, Summary, Detailed Findings)
- [ ] Skill includes a postmortem-dedup branch (TaskList availability check)
- [ ] Skill closes with an AskUserQuestion next-steps picker offering `/form`, `/plan`, or "Done"

## What We're NOT Doing

- Not creating a new sub-agent — `codebase-locator` and `codebase-analyzer` are reused as-is
- Not modifying `/form` or `/plan` — the research doc format is already a supported intake
- Not modifying `ralph-postmortem` — its scope (team-session structured data) is intentionally distinct
- Not adding `retro` to `hello`'s next-actions routing in this plan — that is a separate enhancement (research doc Recommended Next Step #4 is explicitly optional)
- Not writing `eval-scenarios.md` — single-skill issue scope; eval scenarios can be added in a follow-up
- Not implementing the optional skill-dispatch-inventory thoughts doc update — it is a thoughts-only edit, not a code change, and is listed as optional in the research

## Implementation Approach

The skill is a single-file artifact (`SKILL.md`) following the documented structural template. The implementation follows three logical sub-steps within one phase:

1. Compose the YAML frontmatter (description, argument-hint, model, allowed-tools)
2. Write the skill body Steps (Initial response → conversation scan → optional sub-agent grounding → user confirmation → research doc write → next steps picker)
3. Verify against the dispatchability and constraint checks in the Shared Constraints section

Because this is a documentation-only artifact (no TypeScript source, no test runner integration), Phase Success Criteria focus on file presence, frontmatter validity, and structural correctness — not test execution.

---

## Phase 1: Create ralph-hero:retro skill (GH-706)

- **depends_on**: null

### Overview

Author the `plugin/ralph-hero/skills/retro/SKILL.md` file containing a complete inline user-invocable skill that scans the current session's conversation for pain points, optionally dispatches `codebase-locator`/`codebase-analyzer` for code-anchored findings, presents the findings via `AskUserQuestion`, writes a research doc to `thoughts/shared/research/YYYY-MM-DD-retro-[description].md`, and offers next-step routing into `/form` or `/plan`.

### Tasks

#### Task 1.1: Create retro skill directory and SKILL.md frontmatter
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Directory `plugin/ralph-hero/skills/retro/` exists
  - [ ] File `plugin/ralph-hero/skills/retro/SKILL.md` exists
  - [ ] File begins with `---`-delimited YAML frontmatter
  - [ ] Frontmatter includes `description:` field describing the skill's purpose with the trigger phrases from issue #706 (session pain-point capture, retro, friction)
  - [ ] Frontmatter includes `argument-hint: "[optional: scope hint or session description]"`
  - [ ] Frontmatter includes `model: opus`
  - [ ] Frontmatter does NOT include `context: fork` (either omits the field or sets `context: inline`)
  - [ ] Frontmatter `allowed-tools:` lists at minimum: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `Agent`, `AskUserQuestion`
  - [ ] If knowledge tools are referenced in the body, frontmatter `allowed-tools` includes `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search` and `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome`

#### Task 1.2: Write skill body — Initial Response and Postmortem Dedup Check
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Body opens with a top-level `# Ralph Retro` (or equivalent) heading and a 1-2 paragraph description of the skill's purpose
  - [ ] Body includes a "Step 1: Initial Response" (or equivalent) that handles two cases: scope hint provided via `ARGUMENTS` (use it to scope the conversation slice) and no arguments (proceed with full conversation analysis)
  - [ ] Body includes a "Postmortem Dedup Check" sub-step that detects whether `TaskList` is available in the current session (e.g., via attempted `TaskList()` call or by checking for a recent team-session signal); if a team session is detected, surface a recommendation: "A team session was detected — consider running `/ralph-postmortem` instead, which captures structured task-level blockers. Continue with retro? [Y/n]"
  - [ ] The dedup check does NOT block — if user confirms continue, the skill proceeds; if user opts to switch, the skill exits cleanly with a pointer to `/ralph-postmortem`

#### Task 1.3: Write skill body — Conversation Scan and Pain-Point Extraction
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: high
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Body includes a "Step 2: Scan Conversation Context" (or equivalent) that instructs the model to scan the visible conversation history for friction signals: errors encountered, retries, workarounds, expressions of confusion, repeated manual steps
  - [ ] Body lists the 6 pain-point categories from the research doc: API confusion, Missing tooling, Error-prone workflows, Missing abstractions, Performance friction, Scope ambiguity
  - [ ] Body instructs the model to assign each pain point a severity tier (blocking / annoying / minor) and an optional codebase anchor (file path or component name) when one is implicit in the conversation
  - [ ] Body includes guidance for very long conversations: if the conversation exceeds a model-judged threshold (suggested guidance: more than ~200k tokens visible), constrain analysis to the most recent N turns or ask the user to identify the session portion to analyze
  - [ ] Body explicitly states no tool calls are required for the extraction itself — this is a summarization+classification task on the conversation context

#### Task 1.4: Write skill body — Optional Sub-Agent Grounding
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] Body includes a "Step 3: Sub-Agent Grounding (Conditional)" (or equivalent) that instructs the model to dispatch `codebase-locator` and/or `codebase-analyzer` ONLY for pain points with a code anchor identified in Step 2
  - [ ] Body includes the exact `Agent()` call shapes: `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find files related to [pain-point area]")` and `Agent(subagent_type="ralph-hero:codebase-analyzer", prompt="Analyze how [component] currently works (without critiquing)")`
  - [ ] Body includes the team-isolation note: "Do NOT pass `team_name` to these `Agent()` calls"
  - [ ] Body explicitly states that pain points without a clear code anchor (tooling, UX, conceptual friction) skip the sub-agent dispatch and use "None" entries in the resulting `## Files Affected` section

#### Task 1.5: Write skill body — User Confirmation via AskUserQuestion
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] Body includes a "Step 4: Present Findings for Review" that displays a concise summary of extracted pain points (category, severity, anchor) and uses `AskUserQuestion` to gather feedback
  - [ ] The AskUserQuestion call includes options similar to: "Looks good, write it" / "Drop a pain point" / "Add a pain point" / "Re-classify a pain point"
  - [ ] Body documents the routing logic for each option: write proceeds to Step 5; modifications loop back to Step 4 after applying the change
  - [ ] The pattern matches `research/SKILL.md` Step 6 (lines 149-172) for consistency

#### Task 1.6: Write skill body — Research Document Output
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.5]
- **acceptance**:
  - [ ] Body includes a "Step 5: Write Research Document" that writes to `thoughts/shared/research/YYYY-MM-DD-retro-[description].md` (kebab-case description derived from the dominant pain-point theme)
  - [ ] The template embedded in the skill body specifies frontmatter with `type: research`, `status: complete`, `date`, `tags` (must include `retro`), `github_issue: null` (since this is unlinked at write time)
  - [ ] The template includes the required sections: `## Prior Work`, `## Summary`, `## Detailed Findings` (with one subsection per pain-point category that has findings), `## Files Affected` (with `### Will Modify` and `### Will Read` subsections — must use "None" entries explicitly when empty)
  - [ ] The template includes an explicit instruction that `## Files Affected` MUST be populated even when no code anchors exist — using `- None - this retro covers tooling/UX friction with no specific code files implicated.` or equivalent
  - [ ] The template includes a `## Recommended Next Steps` section listing concrete suggestions (file an issue, run /form, run /plan) per pain point

#### Task 1.7: Write skill body — Next-Steps Picker and Optional Knowledge Record
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.6]
- **acceptance**:
  - [ ] Body includes a "Step 6: Next Steps" section using `AskUserQuestion` with options: "Create issue from findings" (route to `/ralph-hero:form thoughts/shared/research/[filename].md`), "Deep-dive a specific pain point" (spawn targeted research sub-agent), "Save for later — done"
  - [ ] Body includes an optional "Step 7: Record Outcome" that calls `knowledge_record_outcome` with `event_type: "retro_completed"` and a payload containing `pain_point_count`, `categories`, `created_doc_path` (gated on tool availability — skill must degrade gracefully if the tool is not available)
  - [ ] Body closes with a brief "Guidelines" section listing key constraints (inline context required, conditional sub-agent dispatch, no `team_name` on Agent calls, opus model for extraction quality)

#### Task 1.8: Self-verify the skill against constraint and dispatchability checks
- **files**: `plugin/ralph-hero/skills/retro/SKILL.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.7]
- **acceptance**:
  - [ ] Re-read the completed file and verify each Shared Constraint is satisfied: no `context: fork`, output format includes the four required sections, sub-agent dispatch is conditional, no `team_name` on Agent calls, model is opus, postmortem dedup check is present
  - [ ] Verify the file's frontmatter parses as valid YAML (no tab characters in YAML, balanced quotes, list items use `-` prefix)
  - [ ] Verify the dispatchability self-check from the planning template: a sub-agent reading only this skill body would have enough information to execute it end-to-end

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/retro/SKILL.md` — file exists
- [ ] `head -1 plugin/ralph-hero/skills/retro/SKILL.md | grep -q '^---$'` — file starts with frontmatter delimiter
- [ ] `awk '/^---$/{n++; if(n==2) exit} n==1' plugin/ralph-hero/skills/retro/SKILL.md | grep -q 'model: opus'` — frontmatter declares opus model
- [ ] `awk '/^---$/{n++; if(n==2) exit} n==1' plugin/ralph-hero/skills/retro/SKILL.md | grep -vq 'context: fork'` — frontmatter does NOT declare context: fork
- [ ] `grep -q 'codebase-locator' plugin/ralph-hero/skills/retro/SKILL.md && grep -q 'codebase-analyzer' plugin/ralph-hero/skills/retro/SKILL.md` — both sub-agents referenced
- [ ] `grep -q 'AskUserQuestion' plugin/ralph-hero/skills/retro/SKILL.md` — interactive confirmation present
- [ ] `grep -q 'thoughts/shared/research/' plugin/ralph-hero/skills/retro/SKILL.md` — research doc output path is referenced
- [ ] `grep -q 'ralph-postmortem' plugin/ralph-hero/skills/retro/SKILL.md` — postmortem dedup mention present

#### Manual Verification:
- [ ] Reading the skill end-to-end conveys a coherent flow from invocation to research doc output
- [ ] The skill description in frontmatter would surface in skill-discovery for queries like "capture session pain points", "retro", "what was painful in this session"
- [ ] The 6 pain-point categories from the research doc are reflected in the skill body
- [ ] The output template's `## Files Affected` section explicitly handles the "None" case so the postcondition hook does not flag empty-section research docs

**Creates for next phase**: A complete `ralph-hero:retro` skill discoverable to Claude Code via the standard skill loader. No follow-up phases — this is a single-phase plan.

---

## Integration Testing

The skill is a documentation artifact, not executable code, so integration is verified via skill-discovery and a single end-to-end exercise:

- [ ] After writing the skill, run `/ralph-hero:retro` in a fresh session that has accumulated some friction (any session works) and confirm the skill loads, scans the conversation, and produces a research doc at the expected path
- [ ] The produced research doc must pass `/ralph-hero:form thoughts/shared/research/YYYY-MM-DD-retro-[description].md` ingestion without format errors (form-skill's research-doc intake path; manual smoke test, not part of automated CI)

These integration checks are not blocking for plan completion — they are smoke tests for a follow-up session. The Phase Success Criteria above are sufficient for acceptance.

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-05-GH-0706-retro-skill-session-pain-point-capture.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/706
- Pattern source — `draft` skill: `plugin/ralph-hero/skills/draft/SKILL.md`
- Pattern source — `research` skill: `plugin/ralph-hero/skills/research/SKILL.md`
- Pattern source — `ralph-postmortem` skill: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`
- Sub-agent — codebase-locator: `plugin/ralph-hero/agents/codebase-locator.md`
- Sub-agent — codebase-analyzer: `plugin/ralph-hero/agents/codebase-analyzer.md`
- Convention fragment: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`
