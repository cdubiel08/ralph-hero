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

```text
--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop suitability for the canonical detail.
```

**`--loop` refusal** — if `--loop` appears in `$ARGUMENTS`, emit the following and STOP (see `ralph/skills/shared/loop-wrapper.md` § Refusal message):

```text
--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability.
```

## Step 1: Intake routing

Read `intake-shapes.md` to set `INPUT_TYPE` (`"idea"` | `"research"`) and (if applicable) capture `LINKED_ISSUE`. If no argument and not `--mode draft`, follow the no-args fallback in `intake-shapes.md` to list recent ideas.

If `LINKED_ISSUE` is set, fetch the linked issue's title and current workflow state via `get_issue` — Step 4 surfaces them so the user understands why the picker default below is biased toward "Implementation plan".

## Default flow

Steps 2-6 (understand → research → present context → output picker → the output shapes) are in [default-flow.md](default-flow.md). The picker offers **5 options** routing to **4** Step-6 sub-steps — *Implementation plan* and *Research topic* both hand off via Step 6c.

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
