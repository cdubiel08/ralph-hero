# Intake shapes

This reference is consulted by `/ralph:form` (Step 1 of the default flow and `--mode draft` Step 1). It carries input-detection rules, per-input-type research routing, and (after Phase 4) the lightweight draft template.

## Detection rules

The single positional argument (after `--mode draft` if present) determines `INPUT_TYPE`:

| Argument | INPUT_TYPE | Detection |
|---|---|---|
| Path matching `thoughts/shared/research/*.md` | `"research"` | Path glob |
| Path matching `thoughts/shared/ideas/*.md` | `"idea"` | Path glob |
| Any other path with `type: research` in frontmatter | `"research"` | Frontmatter `type` field (authoritative) |
| Any other path with `type: idea` in frontmatter (or no `type:`) | `"idea"` | Frontmatter, then default |
| Inline description (non-path string) | `"idea"` | Treat as inline idea |
| No argument provided | (interactive) | List recent ideas; wait for input |

**Frontmatter `type:` is authoritative when present** — it overrides path-based detection. This matters for ideas promoted from research or research imported from elsewhere whose path doesn't match the canonical glob.

## Linked-research handling

If `INPUT_TYPE == "research"` and the doc's frontmatter has `github_issue: NNN`, set `LINKED_ISSUE = NNN`. The research is already linked to an issue.

SKILL.md Step 5 is the source of truth for the picker default when `LINKED_ISSUE` is set — this skill is the source of truth for the routing rule (when to capture `LINKED_ISSUE`); SKILL.md is the source of truth for what the picker does with it.

## Per-input-type research routing

Step 3 of the default flow branches research strategy:

### For `INPUT_TYPE == "research"`

The research doc already contains codebase analysis, code references, and architectural context. Skip the codebase-locator and codebase-analyzer sub-tasks — they would re-investigate what the doc already covers. Still run:

- `Agent(subagent_type="ralph:thoughts-locator", prompt="Find related ideas, research, and plans about [topic from research doc]")` — for project-management context the research doc may lack.
- `Agent(subagent_type="ralph:thoughts-analyzer", prompt="Extract key decisions and prior art from documents about [topic]")` — dispatch on top thoughts-locator findings.
- `list_issues` keyword search — to find duplicates / overlapping work / parent epics.

This avoids re-investigating while still grounding the idea in the project context.

> **Intentional enrichment vs source skill** — the source plugin's research-input branch ran `thoughts-locator` only (no analyzer). The slim plugin adds `thoughts-analyzer` because a user feeding a research doc into `/ralph:form` typically wants prior-art decisions surfaced too, not just adjacent documents — that produces a better-grounded issue. Token cost is bounded: the analyzer runs on the top-N `thoughts-locator` hits, not the corpus.

### For `INPUT_TYPE == "idea"`

Run the full research suite per `duplicate-detection.md`: codebase-locator + codebase-analyzer + thoughts-locator + thoughts-analyzer + `list_issues` keyword search (and optional `knowledge_search`).

## No-args fallback

If no argument is provided (and not `--mode draft`), print the help block followed by the recent-ideas file list:

```
I'll help you crystallize an idea into something actionable.

Provide one of:
1. A path to a draft idea: `/ralph:form thoughts/shared/ideas/2026-02-21-feature.md`
2. A research document: `/ralph:form thoughts/shared/research/2026-03-14-topic.md`
3. A description of the idea: `/ralph:form we should add operator comparison charts`
4. Just run `/ralph:form` and pick from recent drafts below

Recent ideas:

1. 2026-05-22-feature-x.md — [first sentence of "The Idea" section]
2. 2026-05-21-improve-y.md — [first sentence]
...
```

List files from `thoughts/shared/ideas/` sorted by date (most recent first, max 10). Then wait for the user to pick by number, supply a path, or supply an inline description.

## Draft template

Used by `--mode draft` Step 4 to write `thoughts/shared/ideas/YYYY-MM-DD-description.md`. Lightweight by design — drafts are pre-ticket and should be scannable in under a minute.

```markdown
---
date: YYYY-MM-DD
status: draft
type: idea
author: user
tags: [relevant, tags]
github_issue: null
---

# [Idea Title]

## The Idea

[2-4 sentence description of the core idea, written conversationally. Preserve the user's voice and framing — don't over-formalize.]

## Why This Matters

[1-3 bullet points on motivation or context]

## Rough Shape

[Sketch of what this might look like — bullet points, not detailed spec]
- [Key aspect 1]
- [Key aspect 2]
- [Key aspect 3]

## Open Questions

- [Things to figure out later]

## Related

- [Any related files, tickets, or ideas mentioned during capture]
```

Filename derivation:

- `YYYY-MM-DD` — today's date in UTC.
- `description` — 3-6 hyphen-separated lowercase words derived from the title; strip punctuation.

Tag generously — tags are how `/ralph:form` will rediscover related ideas later via knowledge-search and thoughts-locator. Aim for 3-5 tags drawn from the topic, the affected area, and any cross-cutting concerns (e.g., `[performance, dashboard, mvp]`).
