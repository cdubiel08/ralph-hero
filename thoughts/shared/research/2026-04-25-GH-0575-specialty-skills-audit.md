---
date: 2026-04-25
github_issue: 575
github_url: https://github.com/cdubiel08/ralph-hero/issues/575
status: complete
type: research
tags: [skill-audit, idea-hunt, record-demo, design-system-audit, description-triggering, team-orchestration]
---

# Audit: idea-hunt, record-demo, design-system-audit — Specialty Skills Eval

## Prior Work

- builds_on:: None identified.
- tensions:: None identified.

## Problem Statement

Phase 2 of the skill audit (#566) requires deep evaluation of the three specialty skills in Tier 3: `idea-hunt` (GitHub-wide trend scouting via multi-agent team), `record-demo` (OBS-based screen capture for issue showcase), and `design-system-audit` (5-ring, 6-tier AI-readiness maturity assessment). The questions are:

1. What is the current SKILL.md content quality for each?
2. How well does each skill perform in its primary function?
3. Does grouping these three together make sense, or should they be split?
4. Are the description fields high enough quality to trigger correctly?

## Current State Analysis

### idea-hunt/SKILL.md

**Location:** `plugin/ralph-hero/skills/idea-hunt/SKILL.md`

**Key characteristics:**
- `user-invocable: false` — cannot be called directly by users; invoked by a coordinator agent
- No `description` field in frontmatter — relying only on the `name` "idea-hunt"
- Model: `sonnet`
- Spawns a `TeamCreate` / multi-agent workflow using `github-lister` and `github-analyzer` worker agents
- The coordinator role is clearly defined: break topic into 3-4 angles, create search tasks, spawn 2 lister workers, wait for completion, then spawn 1 analyzer for synthesis
- Output location: `thoughts/shared/ideas/` (written by github-analyzer agent)
- Terminates with a summary to the user after shutting down the team

**Structural observations:**
- The orchestrator role in SKILL.md is lean and readable — 80 lines total
- The worker agents (`github-lister.md`, `github-analyzer.md`) contain the substance of what actually runs
- The skill relies on `TeamCreate`, `TaskCreate`, `TaskList`, `TaskUpdate`, `SendMessage` — a full team coordination pattern that requires these tools in `allowed-tools`, which they are
- **Critical gap**: The skill has no `description` field. The `argument-hint` field exists (`[topic or area to explore, e.g. 'AI agents', 'developer tools', 'rust CLI tools']`), but without a `description`, triggering from natural language is impossible. A coordinator that calls this must know to invoke it by name.
- The skill asks for a topic argument but then interactively prompts if none is provided ("ask what domain or theme they want to explore") — this is appropriate for a user-facing skill but contradicts `user-invocable: false`

**Output quality (github-lister + github-analyzer agents):**
- `github-lister` uses GitHub search tools, WebSearch, and WebFetch with specific query strategies (trending, recently active, novel approaches, community buzz, deep cuts) — well-specified
- Minimum 5-10 finds per search task with structured output format
- `github-analyzer` synthesizes into a report with executive summary, top finds, emerging patterns, ideas worth exploring, raw sources — good output structure
- The `github-analyzer` writes to `thoughts/shared/ideas/` — correct output location
- **False-positive risk**: The lister's "What makes something interesting" criteria are qualitative ("Novel architectural patterns", "Clever solutions") — entirely LLM judgment with no rubric or scoring, so output quality varies per run. No assertion-based quality gates exist.
- The overall flow is well-designed but the quality guarantee depends heavily on model judgment, which is not stable across invocations.

**Gap summary for idea-hunt:**
1. Missing `description` field — not triggerable by natural language
2. Interactive prompt for missing argument conflicts with `user-invocable: false`
3. No eval criteria or assertions for what "interesting" means — false-positive rate ungoverned
4. No dedup check — reports can repeat the same repos across runs

---

### record-demo/SKILL.md

**Location:** `plugin/ralph-hero/skills/record-demo/SKILL.md`

**Key characteristics:**
- `user-invocable: false` and `context: inline`
- No `description` field in frontmatter
- Model: `sonnet`
- Orchestrates an OBS-based screen capture workflow via `obs-cli` (a Go CLI tool)
- Prerequisite-heavy: requires OBS Studio installed, `obs-cli` installed, WebSocket server enabled, scene configured
- Uses `AskUserQuestion` for interactive pacing during recording
- Uploads via `gh release upload` or issue attachment, then posts a `## Demo Recording` comment

**Structural observations:**
- The skill is 91 lines and reads as a clear step-by-step procedure
- It is highly infrastructure-dependent: OBS must be running before the skill can function at all
- Step 1 checks OBS reachability with `obs-cli recording status` — fails gracefully with guidance
- The Step 5 "ask user" options (trim, thumbnail, upload) imply interactive use, contradicting `user-invocable: false`
- `context: inline` means it runs in the user's current conversation — correct for an interactive skill
- **Workflow viability**: The obs-cli tool (`github.com/muesli/obs-cli`) is a real CLI; the integration is architecturally sound but requires the user to have OBS pre-configured. This is not a zero-setup skill.
- **Integration with ralph-hero**: The skill posts a `## Demo Recording` comment on a GitHub issue using `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment` — the MCP tool is present in `allowed-tools`. The issue fetching path (`mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`) is also present.
- **Missing `description`**: Without a description, the skill cannot be triggered by natural language. A user saying "record a demo of issue #123" has no way to invoke this skill through normal triggers.
- The `argument-hint` format `#NNN` is documented, but without a `description`, the trigger mechanism is undefined.

**Gap summary for record-demo:**
1. Missing `description` field — not triggerable by natural language
2. Prerequisite dependencies (OBS + obs-cli) make this fragile in most environments
3. `user-invocable: false` contradicts the interactive AskUserQuestion flow throughout the skill
4. No fallback for when OBS is not available beyond "guide the user to start OBS"
5. No mention of alternative screen capture tools (QuickTime, built-in macOS recorder)

---

### design-system-audit/SKILL.md

**Location:** `plugin/ralph-hero/skills/design-system-audit/SKILL.md`

**Key characteristics:**
- Has a `description` field — the only one of the three with one, and it is exceptionally long (4 sentences, 146 words)
- Has `name: design-system-audit` set explicitly in frontmatter
- No `user-invocable` field (defaults to true — user-invocable)
- Model: `sonnet`
- No `context` field — runs in a new conversation context (fork)
- No `allowed-tools` restriction — inherits all tools from caller context
- 253 lines — the most substantive of the three skills
- References three bundled reference files in `references/` directory: `maturity-checklist.md`, `angular-playbook.md`, `figma-hygiene.md`

**Description quality:**
The description field is:
> "Assess and score a design system's maturity for AI-driven frontend development using a 5-ring, 6-tier maturity model. Produces a scored report with a prioritized action plan tailored to the user's framework, team size, and goals. Use this skill whenever someone asks about design system readiness, AI readiness for frontend, design-to-code maturity, Figma-to-code pipeline health, component library quality, or wants to know 'how ready is my design system for AI.' Also trigger when users mention design tokens, Code Connect, Figma MCP, component registries, want to accelerate frontend development with Claude Code, or are migrating between frameworks (e.g., React to Angular) and want to set up their design system right. Trigger proactively if a user describes building a design system, setting up tokens, or connecting Figma to code — even if they don't say 'audit.' Covers React, Angular, Vue, Svelte, and framework-agnostic setups."

This description is trigger-engineering: it lists all the semantic contexts that should activate the skill, including edge cases like framework migration. This is excellent for eliminating false negatives. However:
- At 146 words, it is the longest description of any skill in the codebase
- The sheer length means the model must parse a multi-clause trigger specification, which adds cognitive load
- The description doubles as a capability summary — this is appropriate
- No false-positive risk analysis: the description says "trigger proactively" for a broad set of mentions, which could cause unwanted activations when a user is just mentioning Figma tokens in passing

**5-ring 6-tier scoring rubric quality:**
The maturity model in `design-system-audit/references/maturity-checklist.md` is comprehensive:
- 5 rings: Foundation, Design-Code Bridge, AI Automation, Quality & Governance, Portability & Export
- 6 tiers per ring: Not Started (0), Ad Hoc (1), Defined (2), Systematic (3), AI-Ready (4), Autonomous (5)
- ~60 checkpoints total across all rings, each with specific tier definitions
- Blank scoring template included for consistent output format
- Companion playbooks: `angular-playbook.md` (phased roadmap, CLAUDE.md template, component manifest schema), `figma-hygiene.md` (design team checklist)

**Framework adaptability assessment:**
The skill explicitly handles:
- React (shadcn ecosystem, v0, Figma Make)
- Angular (detailed playbook with CLAUDE.md template and component manifest JSON schema)
- Vue, Svelte, framework-agnostic
- Migration scenarios: scores surviving vs. non-surviving assets differently
- Fast tracks for "no design system at all" and "no Figma" cases

The framework-specific guidance is strong. The Angular playbook is the most developed (separate reference file). Vue/Svelte/other are acknowledged but not as deeply specified.

**Scoring rubric quality assessment:**
The tier definitions are specific and evidence-based (e.g., Ring 1 token tier: "DTCG token files, Style Dictionary pipeline, CI lint for hardcoded values" = Tier 3). This specificity enables consistent scoring across different runs. The "scan first, ask second" principle is well-specified. However:
- The SKILL.md instructs the skill to read `maturity-checklist.md` before scoring, but does not specify what happens if the file is not found (Glob may return empty results)
- The gap between "AI-Ready" (Tier 4) and "Autonomous" (Tier 5) in most rings is aspirational — most real-world design systems will not reach Tier 5, but the rubric does not adjust expectations for this

**Gap summary for design-system-audit:**
1. Description is excellent for triggering but may over-trigger on casual Figma mentions
2. No `allowed-tools` restriction — inherits caller context, which could vary
3. No error handling if reference files are not found via Glob
4. Vue/Svelte guidance is acknowledged but less developed than Angular
5. Tier 5 definitions ("autonomous") are aspirational but may confuse users who see them as near-term targets

---

## Key Discoveries

### 1. Missing description fields in idea-hunt and record-demo

Both `plugin/ralph-hero/skills/idea-hunt/SKILL.md` (line 1-19) and `plugin/ralph-hero/skills/record-demo/SKILL.md` (line 1-15) have no `description` field in their frontmatter. This means they cannot be triggered by natural language matching — they can only be invoked by name. This is consistent with `user-invocable: false` but means any orchestrator that wants to invoke them must use exact skill identifiers.

### 2. user-invocable: false conflicts with interactive flow

Both `idea-hunt` and `record-demo` are marked `user-invocable: false` yet their workflow content assumes a user is present:
- `idea-hunt`: "If no argument, ask what domain or theme they want to explore"
- `record-demo`: Uses `AskUserQuestion` at Steps 3, 4, and 5

If these are truly not user-invocable, the interactive prompts should be replaced with required argument parsing. If they are interactive, the `user-invocable` flag should be removed.

### 3. design-system-audit has no allowed-tools restriction

`plugin/ralph-hero/skills/design-system-audit/SKILL.md` (line 1-8) has no `allowed-tools` key. This means the skill inherits whatever tools are available in the caller's context. Combined with the reference file Glob pattern (`**/design-system-audit/references/maturity-checklist.md`), it requires `Read` and `Glob` to be available, which may not always be the case.

### 4. idea-hunt output quality depends on unspecified model judgment

The `github-lister` agent defines what is "interesting" as a list of qualitative criteria with no scoring rubric or minimum threshold. This means two runs of the same hunt can produce dramatically different quality outputs. No assertions exist to evaluate output quality.

### 5. Logical grouping is questionable

The three skills are grouped in issue #575 as "specialty skills" but they are heterogeneous in dimension:
- `idea-hunt`: Team orchestration, async GitHub intelligence gathering, multi-agent coordination
- `record-demo`: Infrastructure-dependent, OBS hardware integration, linear screen capture workflow
- `design-system-audit`: Consulting-mode assessment, codebase scanning, knowledge-intensive scoring

The only unifying characteristic is "they don't fit neatly into the core pipeline (triage → research → plan → impl → pr → merge)." They are Tier 3 by exclusion, not by shared pattern.

## Potential Approaches

### Option A: Fix in place, keep grouped (low effort)
- Add `description` fields to `idea-hunt` and `record-demo`
- Clarify `user-invocable` status for both (remove if interactive, keep if truly orchestrator-only)
- Add error handling for missing reference files in `design-system-audit`
- Trim `design-system-audit` description or add trigger guard against false positives

**Pros**: Low effort, single implementation ticket  
**Cons**: Grouping remains heterogeneous, which makes the audit scope unfocused

### Option B: Split into per-skill tickets (correct but more overhead)
- Issue A: `idea-hunt` — fix description, resolve user-invocable conflict, add quality assertions for lister output
- Issue B: `record-demo` — fix description, add fallback capture strategy, resolve interactive vs. autonomous conflict
- Issue C: `design-system-audit` — trim description, add allowed-tools, add Glob error handling

**Pros**: Each skill gets targeted fixes without interference  
**Cons**: Three more issues to track; the current grouping in #575 had a rationale (they are the remaining Tier 3 specialty skills)

### Option C: Rationalize user-invocable semantics across all three
- Remove `user-invocable: false` from `idea-hunt` and `record-demo` if they are intended to be interactive
- Add descriptions to both
- Ensure all three have explicit `allowed-tools` lists

**Pros**: Aligns skill metadata with actual behavior  
**Cons**: Expands scope slightly

## Risks

1. **record-demo is fragile by design**: The OBS dependency means this skill will silently break whenever a user runs it in an environment without OBS. There is no documented fallback. Any improvement to record-demo must address this or explicitly document the limitation.

2. **design-system-audit over-triggering**: The aggressive "trigger proactively" language in the description could cause the skill to activate on casual mentions of Figma or tokens in unrelated conversations. This is a false-positive risk in any system that does semantic skill matching.

3. **idea-hunt quality is ungoverned**: Without eval assertions or a scoring rubric for what constitutes a "good" find, the output quality of idea-hunt is unpredictable across model versions and topic changes. The audit issue itself (Phase 2) is asking for evals, which do not currently exist.

4. **Grouping in implementation phase may cause conflicts**: If all three are in a single implementation ticket, a plan that changes `idea-hunt`'s `user-invocable` flag may conflict with a plan that leaves `record-demo` in `user-invocable: false` state. The heterogeneity of the skills means impl changes are unlikely to be parallelizable.

## Recommended Next Steps

1. **Immediate (in Plan phase):** Add `description` fields to `idea-hunt` and `record-demo`. Align `user-invocable` flag with actual interaction model for each.

2. **Structural clarification:** Decide whether `idea-hunt` and `record-demo` are user-invocable interactive skills (remove the flag, add descriptions) or orchestrator-dispatched non-interactive skills (remove interactive prompts). They cannot be both.

3. **design-system-audit:** Add an explicit `allowed-tools` list (minimum: `Read`, `Glob`, `Bash`, `AskUserQuestion`, `Write`). Add a check: if `maturity-checklist.md` is not found via Glob, tell the user where to find it or fail gracefully with a message.

4. **Eval criteria for idea-hunt:** Before Phase 2 eval can be run, someone must define what a "good" idea-hunt output looks like. Minimum criteria: at least 5 projects discovered, at least 1 project with stars >100, at least 1 "emerging" find (< 6 months old), and synthesis identifies at least 2 cross-cutting patterns.

5. **Consider splitting for implementation:** The three skills are heterogeneous enough that separate implementation tickets would reduce plan complexity. However, if the Phase 2 methodology (read, run 2-3 evals, grade, improve) is applied uniformly, keeping them grouped is acceptable with a clear partition in the plan.

6. **Grouping verdict:** Keep #575 grouped for research and planning. Split into three separate implementation issues if the plan identifies non-overlapping code changes. The heterogeneity is real but manageable at the audit/planning level.

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/idea-hunt/SKILL.md` - Add description field; clarify user-invocable vs. interactive model
- `plugin/ralph-hero/skills/record-demo/SKILL.md` - Add description field; clarify user-invocable vs. interactive model; document OBS prerequisite as explicit limitation
- `plugin/ralph-hero/skills/design-system-audit/SKILL.md` - Add allowed-tools list; add Glob error handling for reference files; optionally trim description

### Will Read (Dependencies)
- `plugin/ralph-hero/skills/idea-hunt/SKILL.md` - Current content (read)
- `plugin/ralph-hero/skills/record-demo/SKILL.md` - Current content (read)
- `plugin/ralph-hero/skills/design-system-audit/SKILL.md` - Current content (read)
- `plugin/ralph-hero/skills/design-system-audit/references/maturity-checklist.md` - Scoring rubric (read)
- `plugin/ralph-hero/skills/design-system-audit/references/angular-playbook.md` - Framework playbook (read)
- `plugin/ralph-hero/skills/design-system-audit/references/figma-hygiene.md` - Design checklist (read)
- `plugin/ralph-hero/agents/github-lister.md` - Lister agent backing idea-hunt (read)
- `plugin/ralph-hero/agents/github-analyzer.md` - Analyzer agent backing idea-hunt (read)
