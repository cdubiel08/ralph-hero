---
description: Crystallize draft ideas, research findings, or inline descriptions into
  structured GitHub issues, implementation plans, research topics, or refined drafts.
  Use whenever the user says "form this", "turn this into an issue", "make a ticket
  from this", "shape this idea", "what should this become", or hands over an idea
  file or research doc. --mode draft is the lightweight quick-capture variant for
  "just write this down before I forget".
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

Spawn sub-tasks in parallel. Wait for ALL to complete before synthesizing. Do NOT pass `team_name` to any `Agent()` call.

### Step 4: Present larger context

Surface to the user:

- **Related existing work** — issues / plans / research that overlap or connect.
- **Potential duplicates** — issues that cover similar ground (call out if `LINKED_ISSUE` is already set from intake).
- **Natural home** — where this fits in the project structure; which epic or initiative it aligns with.
- **Complexity assessment** — XS / S / M / L / XL with key dependencies and risk areas.

### Step 5: Output picker

Use `AskUserQuestion` with these 5 options. The first option is the default-selected one for ideas without `LINKED_ISSUE`; for ideas with `LINKED_ISSUE`, default to "Implementation plan" instead.

| Label | Behavior |
|---|---|
| **GitHub issue** | Create a well-scoped issue ready for the backlog → Step 6a |
| **Implementation plan** | Hand off to `/ralph:plan` (or `/ralph-hero:plan` until Plan 4 ships) → Step 6c |
| **Research topic** | Hand off to `/ralph:research` (or `/ralph-hero:research` until Plan 3 ships) → Step 6c |
| **Ticket tree** | Break into parent + children sub-issues → Step 6b |
| **Keep as refined idea** | Update the source file with context; no GitHub mutation → Step 6d |

Wait for the user's structured response, then branch to the matching Step 6 sub-step.

### Step 6: Output paths

_(Filled by Phase 3.)_

## --mode draft

_(Filled by Phase 4.)_

## References

- `intake-shapes.md` — input detection, per-input-type research routing, draft template
- `duplicate-detection.md` — codebase / thoughts / issue-keyword dedup strategies
- `issue-template.md` — issue body shape, research-aware variant, ticket-tree structure
