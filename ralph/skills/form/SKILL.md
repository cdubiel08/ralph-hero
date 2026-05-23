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

_(Filled by Phase 2 and Phase 3.)_

## --mode draft

_(Filled by Phase 4.)_

## References

- `intake-shapes.md` — input detection, per-input-type research routing, draft template
- `duplicate-detection.md` — codebase / thoughts / issue-keyword dedup strategies
- `issue-template.md` — issue body shape, research-aware variant, ticket-tree structure
