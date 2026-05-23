---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, form, draft, intake, migration, plan-of-plans]
github_issue: 1359
github_issues: [1359]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1359
primary_issue: 1359
---

# Plan 2: `/ralph:form` — Intake Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: [[2026-05-23-ralph-plan-1-catch-up]] — validated the scaffold + flat-sibling references + cross-plugin MCP pattern. Plan 2 follows the same shape unless friction emerges.
- builds_on:: PR #1358 (Plan 1 catch-up implementation, branch `feature/GH-1357-catch-up`)

## Overview

Fold two existing `ralph-hero` skills (`draft` and `form`) into one user-facing slash command `/ralph:form` in the new `ralph/` plugin. The default surface is the heavyweight `form` flow (intake → research → context → output picker → create issue / ticket tree / handoff / refined idea). `--mode draft` is the lightweight quick-capture path (asks 2-3 questions, saves to `thoughts/shared/ideas/`, no GitHub integration). SKILL.md ≤ 200 lines (target ~150). Opinion content lives in three flat-sibling reference files: `intake-shapes.md`, `duplicate-detection.md`, `issue-template.md`.

This is the second low-risk migration plan (after catch-up) and the second pattern validator for the slim-plugin shape. It exercises an intake-shaped verb that doesn't touch the lifecycle pipeline — no plan compliance hook, no worktree gate, no PR creation. Pure board-mutation via the cross-plugin MCP server.

## Current State Analysis

Two source skills total **510 lines** of SKILL.md prose:

| Source | Lines | Shape | Side effects |
|---|---|---|---|
| `plugin/ralph-hero/skills/draft/SKILL.md` | 134 | Lightweight: ask 2-3 questions → write `thoughts/shared/ideas/YYYY-MM-DD-description.md` | No GitHub |
| `plugin/ralph-hero/skills/form/SKILL.md` | 376 | Heavyweight: intake-route + research + dedup + AskUserQuestion picker over 5 output formats | Writes to GitHub via 6 MCP tools |

`draft` model is `sonnet`; `form` model is `opus`. The lightweight path's only output is a markdown file under `thoughts/shared/ideas/`. The heavyweight path can produce: a single GitHub issue (Step 5a), a parent + children ticket tree with dependency links (Step 5b), a handoff to `/ralph:plan` or `/ralph:research` with gathered context (Step 5c), or an enriched draft with codebase context + related-work links + refined tags (Step 5d).

`form`'s intake routing detects three input shapes from a single positional argument:

1. **Idea file path** (matches `thoughts/shared/ideas/*.md`) → read fully; `INPUT_TYPE = "idea"`
2. **Research doc path** (matches `thoughts/shared/research/*.md` or has `type: research` in frontmatter) → read fully; `INPUT_TYPE = "research"`; if the doc has `github_issue` in frontmatter, capture `LINKED_ISSUE`
3. **Inline description** (anything else, or no argument) → treat as inline idea; `INPUT_TYPE = "idea"`

The research-doc path is the load-bearing one operationally — `/ralph-hero:form` is how research findings get crystallized into issues with the right artifact-comment threading per the Artifact Comment Protocol.

### Key Discoveries

- `form` Step 4 is an `AskUserQuestion` picker over 5 output formats: GitHub issue / Implementation plan handoff / Research topic handoff / Ticket tree / Keep as refined idea (`plugin/ralph-hero/skills/form/SKILL.md:154-168`). This is the most consequential UX decision in the skill and stays in the default flow body, not in a reference.
- `form` Step 2 branches research strategy by input type (`form/SKILL.md:100-128`): research docs skip codebase-locator/analyzer because the doc already covers them; idea inputs run the full research suite. Move into `intake-shapes.md` reference.
- `form` Step 5a/5b creates issues with explicit estimates and Backlog workflow state (`form/SKILL.md:207, 280-282`). The issue body template (Summary / Acceptance Criteria / Context, plus Research section for research-derived issues) moves into `issue-template.md`.
- `form` Step 5b creates the parent → children tree via `add_sub_issue` and optional `add_dependency` calls (`form/SKILL.md:278-284`). Estimate defaults: parent=L, children=XS.
- `draft` Step 2b's optional dedup check uses a knowledge-search tool if available (`draft/SKILL.md:67-71`). Promote this into `duplicate-detection.md` alongside the more thorough `form` Step 2 dedup approach (list_issues by keyword + thoughts-locator).
- `form` has no enforcement hooks. Nothing to port. The `ralph/hooks/` directory already has `set-skill-env.sh` and `cursor-advance-catch-up.sh` (Plan 1); Plan 2 adds nothing.
- The artifact-comment protocol for linking research docs to issues (`form/SKILL.md:223-230`) is a verbatim-stable block — moves into `issue-template.md` as the "research-aware variant".

## Desired End State

After Plan 2 merges:

1. `/ralph:form` is discoverable in any fresh Claude Code session under the ralph plugin.
2. `/ralph:form` with no args lists recent drafts from `thoughts/shared/ideas/` and waits for input (mirrors current `form` Step 4 fallback).
3. `/ralph:form <idea-file-path>` reads the file as an idea, runs research + dedup + presents the 5-option picker, then branches to the chosen output path.
4. `/ralph:form <research-doc-path>` reads the file as research, skips the codebase-locator/analyzer steps (already done in the research doc), still runs the thoughts-locator + issue-keyword dedup, presents the picker, branches.
5. `/ralph:form <inline description>` treats the argument as an inline idea, proceeds as for an idea file.
6. `/ralph:form --mode draft [idea]` runs the lightweight quick-capture flow: ask 2-3 questions, write `thoughts/shared/ideas/YYYY-MM-DD-description.md`, suggest `/ralph:form <path>` as the next step. No GitHub integration.
7. Old `ralph-hero:*` skills (`draft`, `form`) remain functional and untouched. Sunset is Plan 10.
8. `ralph/skills/form/SKILL.md` is ≤ 200 lines (target ~150). Opinion content lives in three flat-sibling reference files.
9. `ralph/README.md` migration table shows Plan 2 as "shipped".
10. Friction-log entry appended to the spec doc.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:form` without errors.
- Three real `/ralph:form` invocations cover the three intake shapes: inline description, idea file, research doc.
- One real `/ralph:form --mode draft` invocation produces a new file in `thoughts/shared/ideas/` and suggests `/ralph:form <path>` as the next step.
- `wc -l ralph/skills/form/SKILL.md` reports ≤ 200.
- Old `/ralph-hero:form` and `/ralph-hero:draft` still work unchanged.

## What We're NOT Doing

- **Not** introducing a `--mode tree` shortcut. Ticket-tree creation stays inside the default-flow picker (Step 5b). The user picks it interactively when they want it; preserves source UX.
- **Not** removing the WebSearch/WebFetch tools from the allowed-tools list. They aren't heavily used by `form` but are present in the source; keeping them allows research-doc enrichment to incorporate web sources when relevant.
- **Not** porting any hooks. `form`/`draft` have no enforcement hooks. Plan 2 adds zero new hook scripts.
- **Not** absorbing `idea-hunt` into `/ralph:form`. The spec explicitly removed `idea-hunt` from the new plugin (separate-plugin decision, deferred).
- **Not** sunsetting the source skills. They remain functional for the 2-week dogfooding window. Plan 10 owns sunset.
- **Not** adding a confirmation gate hook on `create_issue`. Source `form` is already interactive (presents the proposed issue for approval before creating); the natural confirmation point is the existing AskUserQuestion picker. P9 — YAGNI.
- **Not** changing the issue body shape (Summary / AC / Context / Research). That template is stable and consumed by downstream verbs that parse it.

## Implementation Approach

Five XS-sized phases, each owning a tightly-scoped file set:

1. **Scaffold + intake routing** owns: `ralph/skills/form/SKILL.md` (stub with frontmatter + mode-dispatch skeleton + Step 1 intake routing), three empty reference stubs.
2. **Default flow front-half** owns: `ralph/skills/form/SKILL.md` (research + context + picker bodies), `ralph/skills/form/intake-shapes.md` (detection rules + per-input-type routing), `ralph/skills/form/duplicate-detection.md` (codebase + thoughts + issue-keyword dedup strategies).
3. **Default flow output paths** owns: `ralph/skills/form/SKILL.md` (Step 5a/5b/5c/5d branches), `ralph/skills/form/issue-template.md` (issue body template, research-aware variant, tree-shape).
4. **`--mode draft`** owns: `ralph/skills/form/SKILL.md` (one new mode branch), appends draft-template section to `ralph/skills/form/intake-shapes.md`.
5. **Parity validation + dogfooding** owns: `ralph/README.md`, `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (append-only friction-log entry).

Only `ralph/skills/form/SKILL.md` is touched in multiple phases — each appends a discrete section. The reference files are single-owner with one exception: `intake-shapes.md` gets a draft-template section appended in Phase 4.

## Phase 1: Scaffold + intake routing

### Overview

Stand up the directory structure with the skill stub + three empty reference siblings. The stub carries the frontmatter, the mode-dispatch table, and the intake-routing Step 1 (since routing applies to both default and `--mode draft`).

### Changes Required

#### 1. Skill scaffold

**File**: `ralph/skills/form/SKILL.md`

```markdown
---
description: Crystallize draft ideas, research findings, or inline descriptions into
  structured GitHub issues, implementation plans, research topics, or refined drafts.
  Folds the ralph-hero draft and form verbs. Default flow is heavyweight (research
  + dedup + output picker); --mode draft is the lightweight quick-capture variant.
argument-hint: "[--mode draft] [<idea-path|research-doc-path|inline description>]"
context: inline
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - AskUserQuestion
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

# /ralph:form — Intake

The unified intake verb. Default flow crystallizes ideas, research findings, or
inline descriptions into structured GitHub artifacts via an interactive picker.
`--mode draft` is the lightweight quick-capture alternative — saves to
`thoughts/shared/ideas/` without touching GitHub.

## Mode dispatch

| Mode | Behavior | Equivalent to |
|---|---|---|
| (default) | Intake → research → dedup → picker (5 output formats) | `/ralph-hero:form` |
| `--mode draft` | Quick capture: ask 2-3 questions → write to `thoughts/shared/ideas/` | `/ralph-hero:draft` |
| `--help` / `-h` | Print this table and exit | — |

## Step 1: Intake routing

Consult `intake-shapes.md` for the input-detection rules. Set `INPUT_TYPE` to one of:

- `"idea"` — argument is a path matching `thoughts/shared/ideas/*.md`, OR an inline description, OR no argument provided (list recent drafts and wait for input).
- `"research"` — argument is a path matching `thoughts/shared/research/*.md`, OR a path whose frontmatter has `type: research`.

If `INPUT_TYPE == "research"` and the doc's frontmatter has `github_issue`, capture `LINKED_ISSUE` — the research is already linked, and downstream steps must be aware to avoid duplicate issue creation.

If no argument and not `--mode draft`: list files from `thoughts/shared/ideas/` sorted by date (most recent first, max 10), then wait for the user to pick one or supply an inline description.

## Default flow

_(Filled by Phase 2 and Phase 3.)_

## --mode draft

_(Filled by Phase 4.)_

## References

- `intake-shapes.md` — input detection, per-input-type research routing, draft template
- `duplicate-detection.md` — codebase / thoughts / issue-keyword dedup strategies
- `issue-template.md` — issue body shape, research-aware variant, ticket-tree structure
```

#### 2. Reference siblings (empty stubs)

- `ralph/skills/form/intake-shapes.md` — one-line stub: `# Intake shapes` + `_Filled by Phase 2; draft template appended by Phase 4._`
- `ralph/skills/form/duplicate-detection.md` — one-line stub: `# Duplicate detection` + `_Filled by Phase 2._`
- `ralph/skills/form/issue-template.md` — one-line stub: `# Issue template` + `_Filled by Phase 3._`

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/form/SKILL.md`
- [ ] `[ "$(wc -l < ralph/skills/form/SKILL.md)" -le 200 ]`
- [ ] All three references present: `for f in intake-shapes duplicate-detection issue-template; do test -f "ralph/skills/form/$f.md" || exit 1; done`
- [ ] SKILL.md references all three: `for f in intake-shapes duplicate-detection issue-template; do grep -q "$f.md" ralph/skills/form/SKILL.md || exit 1; done`

#### Manual Verification

- [ ] After `/reload-plugins`, `/ralph:form --help` returns the mode table.

---

## Phase 2: Default flow front-half (research + context + picker)

### Overview

Wire the default-flow front-half — research, context presentation, output picker. Move opinion content into `intake-shapes.md` and `duplicate-detection.md`.

### Changes Required

#### 1. Default-flow front-half body in SKILL.md

**File**: `ralph/skills/form/SKILL.md`
**Changes**: Replace the `## Default flow` placeholder with steps 2-4 of the form workflow.

Sections to add (~50 lines):

- **Step 2: Understand the idea** — read the idea (file or inline), restate it, ask one confirmation question, wait for the user.
- **Step 3: Research & contextualize** — branch on `INPUT_TYPE`. For `"research"`: skip codebase-locator/analyzer (research doc already covered it), still run thoughts-locator + issue-keyword dedup. For `"idea"`: full research suite (codebase-locator + codebase-analyzer + thoughts-locator + thoughts-analyzer + issue-keyword dedup). Consult `duplicate-detection.md` for the dedup strategy.
- **Step 4: Present larger context** — surface related work, potential duplicates, natural home, complexity assessment (XS/S/M/L/XL).
- **Step 5: Output picker** — `AskUserQuestion` with 5 labeled options (GitHub issue / Implementation plan handoff / Research topic handoff / Ticket tree / Keep as refined idea). Branch to the matching Step 6 sub-step.

The `AskUserQuestion` picker structure (labels + descriptions + the option table) stays inline in SKILL.md — it's workflow, not opinion. The branching is what the skill body specifies; the content of each output path is in `issue-template.md`.

#### 2. `intake-shapes.md` — replace stub

**File**: `ralph/skills/form/intake-shapes.md`
**Changes**: Replace stub with full intake-routing rules. Port `plugin/ralph-hero/skills/form/SKILL.md:38-74` reframed as a reference. Sections:

- **Detection rules**: how to identify idea path vs research path vs inline description. Use frontmatter `type:` field as the authoritative classifier when present; fall back to path glob.
- **Per-input-type research routing**: research docs skip codebase-locator/analyzer (the doc is the investigation); idea inputs run the full suite. Both run thoughts-locator + issue-keyword dedup.
- **Linked-research handling**: when an input research doc's frontmatter has `github_issue`, capture `LINKED_ISSUE` and bias downstream toward "update the linked issue" rather than "create a new one".
- **No-args fallback**: list files from `thoughts/shared/ideas/` sorted by date (max 10) and wait for user input.

Target ~60 lines.

#### 3. `duplicate-detection.md` — replace stub

**File**: `ralph/skills/form/duplicate-detection.md`
**Changes**: Replace stub with the dedup strategy. Port `form/SKILL.md:111-128` (existing issues + thoughts search) and `draft/SKILL.md:67-71` (optional knowledge-search dedup) reframed as a reference. Sections:

- **Codebase locator**: spawn `Agent(subagent_type="ralph-hero:codebase-locator", ...)` to find where the idea would live in the codebase. Skip for research-doc inputs.
- **Codebase analyzer**: spawn `Agent(subagent_type="ralph-hero:codebase-analyzer", ...)` to identify existing patterns to build on. Skip for research-doc inputs.
- **Thoughts locator + analyzer**: spawn `Agent(subagent_type="ralph-hero:thoughts-locator", ...)` to find related ideas/research/plans. Then spawn `Agent(subagent_type="ralph-hero:thoughts-analyzer", ...)` on the top findings to extract decisions and prior art.
- **Issue keyword search**: call `list_issues` with the idea topic as the `query` parameter. Surface duplicate or overlapping issues, plus parent epics this might fit under.
- **Knowledge-search dedup (optional)**: when `knowledge_search` is available, search for type `idea` with the topic summary. If close matches are found, surface them to the user via a "build on existing or create new" question.
- **Team-isolation reminder**: do NOT pass `team_name` to any `Agent()` call.

Target ~70 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/form/SKILL.md)" -le 200 ]`
- [ ] `intake-shapes.md` non-stub: `[ "$(wc -l < ralph/skills/form/intake-shapes.md)" -ge 40 ]`
- [ ] `duplicate-detection.md` non-stub: `[ "$(wc -l < ralph/skills/form/duplicate-detection.md)" -ge 40 ]`
- [ ] SKILL.md references both: `grep -q 'intake-shapes.md' ralph/skills/form/SKILL.md && grep -q 'duplicate-detection.md' ralph/skills/form/SKILL.md`

#### Manual Verification

- [ ] `/ralph:form thoughts/shared/ideas/<some-idea>.md` runs the full default-flow front-half: research dispatch, dedup surfacing, picker over 5 options. (Don't pick anything yet — Phase 3 wires the output paths.)
- [ ] `/ralph:form <inline description>` does the same with `INPUT_TYPE="idea"`.
- [ ] `/ralph:form thoughts/shared/research/<some-research>.md` skips codebase-locator/analyzer and surfaces the linked-issue note when applicable.

---

## Phase 3: Default flow output paths

### Overview

Wire the four output paths the picker branches into: Step 6a (single issue), 6b (ticket tree), 6c (handoff), 6d (refined draft). Move the issue-body template + ticket-tree shape into `issue-template.md`.

### Changes Required

#### 1. Output path bodies in SKILL.md

**File**: `ralph/skills/form/SKILL.md`
**Changes**: Append 4 output-path sections under the picker. Each section is short — the heavy content (issue body shape, tree structure) lives in `issue-template.md`.

Sections to add (~40 lines):

- **Step 6a: Create GitHub issue** — draft body per `issue-template.md`; show for approval; call `create_issue` with estimate + Backlog state; update source-file frontmatter (`status: formed`, `github_issue: NNN`); if research-doc input, post the Research Document artifact comment.
- **Step 6b: Create ticket tree** — break into parent + children; show tree for approval; create parent (estimate L, Backlog); for each child, `create_issue` + `add_sub_issue` (estimate XS, Backlog); optional `add_dependency` for sequential children; update source-file frontmatter.
- **Step 6c: Handoff to another skill** — for plan handoff: update source-file `status: forming`, suggest `/ralph:plan <context>`. For research handoff: same shape with `/ralph:research <topic>`. (Note: targets `/ralph:plan` and `/ralph:research` which don't exist yet — Plans 3 and 4. Until then, the handoff suggestion points at `/ralph-hero:plan` and `/ralph-hero:research` and is updated when those plans land.)
- **Step 6d: Refined draft** — enrich source file with codebase context + related links + refined tags; update frontmatter (`status: refined` for ideas; preserve `type: research` for research docs); report.

#### 2. `issue-template.md` — replace stub

**File**: `ralph/skills/form/issue-template.md`
**Changes**: Replace stub with the issue-body shapes. Port `form/SKILL.md:174-230` (issue body, AC, Context, Research-aware variant, artifact comment) and `form/SKILL.md:264-284` (ticket tree shape). Sections:

- **Single-issue template**: Title / Summary / Acceptance Criteria / Context block; estimate + priority + label suggestions.
- **Research-aware variant**: when input is a research doc, include a `## Research` section linking the research doc.
- **Artifact comment protocol**: when input is a research doc, post a `## Research Document` comment on the new issue with the doc URL and a key-findings summary (matches `research/SKILL.md` Step 8 — same protocol).
- **Ticket-tree shape**: parent (estimate L, Backlog) with children (estimate XS, Backlog) linked via `add_sub_issue`; sequential children get `add_dependency` edges.
- **Source-file frontmatter updates per input type**: idea → `status: formed, github_issue: NNN`; research → `github_issue: NNN, github_url: https://...`.

Target ~70 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/form/SKILL.md)" -le 200 ]`
- [ ] `issue-template.md` non-stub: `[ "$(wc -l < ralph/skills/form/issue-template.md)" -ge 40 ]`
- [ ] `issue-template.md` carries the artifact-comment template: `grep -q 'Research Document' ralph/skills/form/issue-template.md`
- [ ] `issue-template.md` carries the AC block: `grep -q 'Acceptance Criteria' ralph/skills/form/issue-template.md`
- [ ] SKILL.md output paths reference `issue-template.md`: `grep -c 'issue-template.md' ralph/skills/form/SKILL.md` ≥ 2

#### Manual Verification

- [ ] `/ralph:form <inline description>` → pick "GitHub issue" → issue is created with the templated body and Backlog state.
- [ ] `/ralph:form thoughts/shared/research/<doc>.md` → pick "GitHub issue" → issue includes the `## Research` section and the artifact comment is posted.
- [ ] `/ralph:form <inline description>` → pick "Ticket tree" → parent + children created with the right estimates and `add_sub_issue` linkage.
- [ ] `/ralph:form <inline description>` → pick "Implementation plan" → source file gets `status: forming` and the handoff prompt suggests the next command.
- [ ] `/ralph:form <inline description>` → pick "Keep as refined idea" → source file is enriched with research context and tags; no GitHub mutation.

---

## Phase 4: `--mode draft`

### Overview

Wire the lightweight quick-capture mode. Mirrors today's `/ralph-hero:draft` — ask 2-3 questions, write a markdown file, suggest the heavyweight form as the follow-up. No GitHub integration.

### Changes Required

#### 1. `--mode draft` branch in SKILL.md

**File**: `ralph/skills/form/SKILL.md`
**Changes**: Fill the `## --mode draft` placeholder section.

Sections to add (~20 lines):

- **Step 1 (draft mode)**: if topic provided, begin capturing; else ask "What's on your mind?" and wait.
- **Step 2 (draft mode)**: ask 2-3 focused clarifying questions; restate the idea in one sentence; don't block if the user says "just capture it".
- **Optional light research**: spawn one `Agent(subagent_type="ralph-hero:codebase-locator", ...)` if the idea references specific code areas. Skip entirely for purely conceptual ideas.
- **Optional dedup**: if `knowledge_search` is available, search for matching ideas (`type: "idea"`, limit 3). Surface close matches.
- **Step 3 (draft mode)**: write to `thoughts/shared/ideas/YYYY-MM-DD-description.md` using the draft template from `intake-shapes.md`.
- **Step 4 (draft mode)**: report the path; suggest `/ralph:form <path>` to crystallize, `/ralph:research` for deep dive (post-Plan-3), or `/ralph:plan` to skip ahead (post-Plan-4).

#### 2. Append draft template to `intake-shapes.md`

**File**: `ralph/skills/form/intake-shapes.md`
**Changes**: Append a new `## Draft template` section at the end. Port `draft/SKILL.md:78-113` (the lightweight YAML frontmatter + sections: The Idea / Why This Matters / Rough Shape / Open Questions / Related).

Target: +30 lines (intake-shapes.md grows to ~90 lines).

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/form/SKILL.md)" -le 200 ]`
- [ ] `intake-shapes.md` carries the draft template: `grep -q '## Draft template' ralph/skills/form/intake-shapes.md`
- [ ] `intake-shapes.md` carries the frontmatter block: `grep -q 'type: idea' ralph/skills/form/intake-shapes.md`
- [ ] SKILL.md `--mode draft` references intake-shapes: `awk '/^## --mode draft/,/^## References/' ralph/skills/form/SKILL.md | grep -q 'intake-shapes.md'`

#### Manual Verification

- [ ] `/ralph:form --mode draft "feature idea X"` asks 2-3 questions, writes `thoughts/shared/ideas/YYYY-MM-DD-feature-idea-x.md`, suggests `/ralph:form <path>` as the next step. No GitHub call.
- [ ] `/ralph:form --mode draft` (no topic) prompts "What's on your mind?" and proceeds after user input.
- [ ] The written file matches the draft template (frontmatter with `type: idea, status: draft, github_issue: null` + the 4 prose sections).

---

## Phase 5: Parity validation + dogfooding setup

### Overview

Final parity validation across real sessions, README update, friction-log entry.

### Changes Required

#### 1. README migration table

**File**: `ralph/README.md`
**Changes**:

```diff
-| 2 | `/ralph:form` | pending |
+| 2 | `/ralph:form` | shipped |
```

Update the `## Status` paragraph to "Plan 2 of 11 (form shipped). This plugin currently exposes two user-facing skills (`/ralph:catch-up`, `/ralph:form`)."

#### 2. Friction-log entry on the spec

**File**: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`
**Changes**: Append a `### Plan 2: /ralph:form (shipped YYYY-MM-DD)` subsection under the existing `## Friction Log` heading (created in Plan 1 Phase 5). Capture final-shape stats, design calls, and TODO checkboxes for the 2-week dogfooding window.

#### 3. Parity validation runs

No file changes. Execute four real `/ralph:form` invocations:

1. `/ralph:form <inline description>` → "GitHub issue" output. Verify against same-input `/ralph-hero:form` invocation.
2. `/ralph:form <idea-file>` → "Ticket tree" output. Verify parent + children + dependency linkage.
3. `/ralph:form <research-doc>` → "GitHub issue" output. Verify Research artifact-comment posted.
4. `/ralph:form --mode draft "<topic>"` → file written. Verify against `/ralph-hero:draft "<topic>"`.

Record observations in the friction-log entry.

### Success Criteria

#### Automated Verification

- [ ] `grep -q '| 2 | \`/ralph:form\` | shipped |' ralph/README.md`
- [ ] `grep -q 'Plan 2 of 11' ralph/README.md`
- [ ] Plan 2 friction-log subsection exists: `grep -q '### Plan 2:' thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`

#### Manual Verification

- [ ] Four real `/ralph:form` invocations completed (one per intake shape + one draft).
- [ ] Each session produces equivalent output to the corresponding old skill.
- [ ] No regressions in `/ralph-hero:form` or `/ralph-hero:draft`.

---

## Testing Strategy

### Unit Tests

None. Skill is markdown workflow; MCP tools it consumes are covered by the ralph-hero MCP server's existing test suite.

### Integration Tests

The "4 real sessions" parity check in Phase 5 is the integration test. No automated harness for skill execution.

### Manual Testing Steps

Per Phase 5's verification list, plus:

1. Verify `--mode draft` writes do NOT create GitHub issues.
2. Verify research-doc input with `github_issue` in frontmatter does NOT create a duplicate issue (the linked-issue path biases toward update, not create).
3. Verify the `add_sub_issue` linkage in the tree path produces a working parent → children hierarchy on the project board.

## Performance Considerations

- Default flow worst-case: 4-5 parallel sub-agent dispatches (codebase-locator + codebase-analyzer + thoughts-locator + thoughts-analyzer + optional knowledge-search) plus 1 `list_issues` call + 1 AskUserQuestion + 1 `create_issue` (or several for tree mode). Same as today's `/ralph-hero:form`. No new latency.
- `--mode draft` worst-case: 1 optional `Agent` call + 1 `Write` to disk. Fastest path; same as today's `/ralph-hero:draft`.

## Migration Notes

- Source skills (`draft`, `form`) remain functional and unmodified for the 2-week dogfooding window. Plan 10 owns sunset.
- The handoff suggestions in Step 6c will point at `/ralph-hero:plan` and `/ralph-hero:research` until Plans 3 and 4 land. Update is a one-line touch in `SKILL.md` per landing plan.
- No new hooks introduced. `ralph/hooks/hooks.json` is unchanged.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 2 at line 334).
- Plan 1: `thoughts/shared/plans/2026-05-23-GH-1357-ralph-plan-1-catch-up.md` (validated the scaffold + flat-sibling + cross-plugin MCP pattern). PR #1358.
- Source skill bodies:
  - `plugin/ralph-hero/skills/draft/SKILL.md` (134 lines)
  - `plugin/ralph-hero/skills/form/SKILL.md` (376 lines)
- ralph plugin scaffold: `ralph/.claude-plugin/plugin.json`, `ralph/hooks/hooks.json` (already wired for catch-up).
