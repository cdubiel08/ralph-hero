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
  - Skill
  - WebSearch
  - WebFetch
  - mcp__plugin_ralph_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__save_issue
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

**`--auto` refusal** — if `--auto` appears in `$ARGUMENTS`, emit `ralph/skills/shared/auto-alias.md` § Refusal targets' refusal text **verbatim**, then STOP. Not restated here: that file is the only copy (an inline duplicate is what let this skill keep emitting a § heading that no longer exists).

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

### Step 5: Output picker → Step 6

Present the 5-option `AskUserQuestion` picker and run the matching output path. Option semantics, the default-selection rule, the source-file-presence fallback, and the full Step 6a-6d procedures live in [output-paths.md](output-paths.md):

| Picker option | Path |
|---|---|
| **GitHub issue** | Step 6a — create a backlog-ready issue |
| **Implementation plan** | Step 6c — hand off to `/ralph:plan` |
| **Research topic** | Step 6c — hand off to `/ralph:research` |
| **Epic parent (decompose later)** | Step 6b — create the parent only, then offer the `/ralph:plan --mode epic` handoff (form does NOT build the tree) |
| **Keep as refined idea** | Step 6d — enrich the source file, no GitHub mutation |

Default-selected: **Implementation plan** when `LINKED_ISSUE` is set, otherwise **GitHub issue**.

## --mode draft

Lightweight quick-capture: any-maturity input, maturity-aware clarification, one file per extracted thought under `thoughts/shared/ideas/` with `status: draft`. No GitHub mutation, no picker, no research suite. Full procedure (Steps 1-5 draft) in [draft-capture.md](draft-capture.md).

## References

- `intake-shapes.md` — input detection, per-input-type research routing, draft template, idea-file lifecycle contract
- `duplicate-detection.md` — codebase / thoughts / issue-keyword dedup strategies
- `issue-template.md` — issue body shape, research-aware variant, ticket-tree structure
- `output-paths.md` — Step 5 picker semantics + the Step 6a-6d output procedures
- `draft-capture.md` — the `--mode draft` capture procedure
