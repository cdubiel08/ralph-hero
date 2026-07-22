---
description: Crystallize draft ideas, research findings, or inline descriptions into
  structured GitHub issues, implementation plans, research topics, or refined drafts.
  Use whenever the user says "form this", "turn this into an issue", "make a ticket
  from this", "shape this idea", "what should this become", or hands over an idea
  file or research doc. Use --mode draft (or trigger on "jot this down", "save this
  thought", "before I forget", "capture an idea") for the lightweight quick-capture
  variant — saves to thoughts/shared/ideas/ without touching GitHub.
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
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_sub_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
---

# /ralph:form — Intake

The unified intake verb. Default flow crystallizes ideas, research findings, or
inline descriptions into structured GitHub artifacts via an interactive picker.
`--mode draft` is the lightweight quick-capture alternative — saves to
`thoughts/shared/ideas/` without touching GitHub.

## Mode dispatch

| Mode | Behavior |
|---|---|
| (default) | Intake → research → dedup → picker (5 output formats) |
| `--mode draft` | Quick capture: any-maturity input, maturity-aware clarification, one file per extracted thought → `thoughts/shared/ideas/` |
| `--help` / `-h` | Print this table and exit |

## Step 0: Flag guard

**`--auto` refusal** — if `--auto` appears in `$ARGUMENTS`, emit the following and STOP (see `ralph/skills/shared/auto-alias.md` § Refusal targets):

```
--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop and --auto suitability matrix for the canonical table.
```

**`--loop` refusal** — if `--loop` appears in `$ARGUMENTS`, emit the following and STOP (see `ralph/skills/shared/loop-wrapper.md` § Refusal message):

```
--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability.
```

## Step 1: Intake routing

Read `intake-shapes.md` to set `INPUT_TYPE` (`"idea"` | `"research"`) and (if applicable) capture `LINKED_ISSUE`. If no argument and not `--mode draft`, follow the no-args fallback in `intake-shapes.md` to list recent ideas.

If `LINKED_ISSUE` is set, fetch the linked issue's title and current workflow state via `get_issue` — Step 4 surfaces them so the user understands why the picker default below is biased toward "Implementation plan".

## Default flow

### Step 2: Understand the idea

Read the idea (from the file resolved in Step 1, or treat the inline argument as the idea body). Identify:

- What problem does this solve?
- Who benefits?
- What's the scope?

Present your understanding to the user and wait for confirmation:

```
Here's what I understand:

**Core idea**: [one sentence]
**Problem it solves**: [brief]
**Scope**: [small / medium / large]

Does this capture it correctly?
```

If the user corrects you, restate and re-confirm before proceeding.

### Step 3: Research & contextualize

Branch by `INPUT_TYPE` per `intake-shapes.md`:

- `INPUT_TYPE == "research"`: skip codebase-locator / codebase-analyzer (the doc IS the investigation); still run thoughts-locator + thoughts-analyzer + `list_issues` keyword search.
- `INPUT_TYPE == "idea"`: run the full suite per `duplicate-detection.md`.

Spawn sub-tasks in parallel per `duplicate-detection.md` (which carries the ADR-001 team-isolation rule). Wait for ALL to complete before synthesizing.

### Step 4: Present larger context

Surface to the user:

- **Linked issue** (only when `LINKED_ISSUE` is set) — show its number, title, and current workflow state from the `get_issue` call in Step 1. This is the issue already attached to this research; it explains why the Step 5 picker default below is biased toward "Implementation plan".
- **Related existing work** — other issues / plans / research that overlap or connect.
- **Potential duplicates** — issues that cover similar ground.
- **Natural home** — where this fits in the project structure; which epic or initiative it aligns with.
- **Complexity assessment** — XS / S / M / L / XL with key dependencies and risk areas.

### Step 5: Output picker

Use `AskUserQuestion` with these 5 options. Default-selected option:

- If `LINKED_ISSUE` is set → **Implementation plan** (the linked issue already exists — creating a separate one would duplicate).
- Otherwise → **GitHub issue** (the first option; the most common path for ideas without prior linkage).

| Label | Behavior |
|---|---|
| **GitHub issue** | Create a well-scoped issue ready for the backlog → Step 6a |
| **Implementation plan** | Hand off to `/ralph:plan` → Step 6c |
| **Research topic** | Hand off to `/ralph:research` → Step 6c |
| **Ticket tree** | Break into parent + children sub-issues → Step 6b |
| **Keep as refined idea** | Update the source file with context; no GitHub mutation → Step 6d |

Wait for the user's structured response, then branch to the matching Step 6 sub-step.

**Source-file presence:** Steps 6a-d's frontmatter updates assume a source file exists. If the input was an inline description (no path argument), offer to write a `thoughts/shared/ideas/YYYY-MM-DD-description.md` first per the draft template in `intake-shapes.md`, then proceed using that file as the source. For Step 6d (refined draft), this file IS the output.

### Step 6a: Create GitHub issue

Draft the issue body per `issue-template.md` (use the research-aware variant when `INPUT_TYPE == "research"`). Show it for approval along with suggested labels, estimate, and priority. On approval:

1. Call `create_issue` with the drafted title and body; set `estimate` and `workflowState: "Backlog"`.
2. Update the source-file frontmatter per `issue-template.md` (`status: formed, github_issue: NNN` for ideas; `github_issue: NNN, github_url: https://...` for research docs).
3. If `INPUT_TYPE == "research"`, post the `## Research Document` artifact comment on the new issue (see `issue-template.md`).
4. Report the issue URL + suggested next steps (research / plan / iterate). Then offer, interactively, to kick off work now: *"Kick off on this now? (`/ralph:hero NNN`)"* — declining is free (default on no answer), and this offer is never made in `--auto`/headless contexts.

### Step 6b: Create ticket tree

Break the idea into a parent + 2-6 children. Show the tree for approval. On approval:

1. Create the parent issue (`create_issue`, `estimate: L`, `workflowState: "Backlog"`).
2. Create all children in ONE `create_sub_issues(parentNumber: <parent-number>, children: [{title, body, estimate: "XS", workflowState: "Backlog", dependsOn: [...]}, ...])` call — for sequential children, give the later entry `dependsOn: [<earlier sibling's index>]` so the dependency edge is wired in the same call (`dependsOn` holds sibling indices into this call's children array; a blocker that is a pre-existing GitHub issue goes in `dependsOnIssues`). Check the response's per-child status for `error` and repair only the failed children.
3. Update the source-file frontmatter with the parent issue link per `issue-template.md`.

See `issue-template.md` for the tree shape and estimate defaults.

### Step 6c: Hand off to another skill

For "Implementation plan" or "Research topic":

1. Update the source file's frontmatter (`status: forming` for ideas; preserve `type: research` for research docs — no status change).
2. Suggest the next command with the gathered context inlined:
   - Plan: `/ralph:plan <context summary>`
   - Research: `/ralph:research <topic>`

Offer to invoke it directly if the user wants.

### Step 6d: Refined draft

For "Keep as refined idea":

1. Update the source file with the enriched content: codebase context, related issues / plans / research, refined scope, updated tags.
2. Frontmatter: `status: refined` for ideas; preserve `type: research` for research docs (no status field).
3. Report the path and what was added.

No GitHub mutations.

## --mode draft

Lightweight quick-capture. No GitHub mutation, no AskUserQuestion picker, no full research suite. The goal is to get the idea into a file before it's lost. **Capture never mutates board/project state** — no `create_issue`, no `save_issue`, nothing beyond writing files under `thoughts/shared/ideas/`.

### Step 1 (draft): capture intent

Accept input at any maturity — a one-line fragment ("we should batch these API calls") is exactly as valid as a multi-paragraph dump describing three unrelated problems. Never demand structure or completeness.

If a topic was provided as the argument, begin capturing. Otherwise prompt: *"What's on your mind? Describe a feature idea, a problem you've noticed, a technical concept, or a workflow improvement worth remembering."* Wait for the user.

Determine whether the input is a **single thought** or a **multi-thought dump** (more than one distinct idea present in the same input) before proceeding — this decides which Step 2 path applies.

### Step 2 (draft): maturity-aware clarification

- **Single thought**: restate in one sentence, then ask 2-3 focused clarifying questions (most-important first). If the user replies "just capture it" or similar, proceed with what you have — don't block.
- **Multi-thought dump**: skip clarifying questions entirely — extraction replaces interrogation (GH-706: "extract first, confirm after"). Extract N distinct thoughts from the input, then present ONE confirmation listing the N titles:

  ```
  Captured as N ideas:
  1. [Title 1]
  2. [Title 2]
  ...
  Merge any, drop any, or good as-is?
  ```

  "Good as-is" — or no answer — is the default; proceed to Step 3/4 for all N. Only re-split or merge on an explicit correction. Never ask per-thought clarifying questions for a dump.

### Step 3 (draft): optional light grounding

Only if the idea references specific code areas:

- One `Agent(subagent_type="ralph:codebase-locator", prompt="Find files related to [idea topic]")` to confirm the relevant area exists. Don't go deep.

Only if `knowledge_search` is available, run an optional dedup check (`type: "idea"`, `limit: 3`). If a close match is found, mention it: *"There's an existing idea that may overlap: `[path]` — [title]. Continue with a new idea or build on that one?"*

Skip both steps entirely for purely conceptual ideas — speed over polish.

### Step 4 (draft): write the file(s)

For each thought from Step 2 (one for a single capture, N for a dump), save to `thoughts/shared/ideas/YYYY-MM-DD-description.md` using the draft template from `intake-shapes.md`, with `status: draft` and `captured: <current UTC ISO-8601 timestamp>` in frontmatter. Each file gets its own `captured` stamp.

### Step 5 (draft): report + suggest next steps

Report every file path written (one per extracted thought). Suggest next-step verbs: `/ralph:form <path>` (crystallize into an issue / plan / research / tree), `/ralph:research` (deep dive), `/ralph:plan` (jump straight to planning). No frontmatter mutation beyond `status`/`captured` set at write time, no GitHub integration — drafts are pre-ticket.

## References

- `intake-shapes.md` — input detection, per-input-type research routing, draft template
- `duplicate-detection.md` — codebase / thoughts / issue-keyword dedup strategies
- `issue-template.md` — issue body shape, research-aware variant, ticket-tree structure
