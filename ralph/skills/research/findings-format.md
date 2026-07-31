# Findings format

Document structure consumed by both interactive and autonomous `/ralph:research` modes. The autonomous flow's `doc-structure-validator.sh` hook enforces a subset of these sections; the interactive flow doesn't enforce but follows the same shape for consistency.

## Filename convention

`thoughts/shared/research/YYYY-MM-DD-[GH-NNNN-]description.md` where:

- `YYYY-MM-DD` is today's date (from `date +%Y-%m-%d`).
- `GH-NNNN` is the GitHub issue number, zero-padded to 4 digits — present only when linked to an issue.
- `description` is a brief kebab-case description of the research topic.

Examples:

- With issue: `2026-01-21-GH-0146-ticket-resolution.md`
- Without issue: `2026-01-21-authentication-flow.md`
- Rename when linking post-write: `mv 2026-03-06-auth.md 2026-03-06-GH-0042-auth.md` (insert `GH-NNNN-` after the date prefix).

## Frontmatter

```yaml
---
date: YYYY-MM-DD
github_issue: NNN                                       # optional, only if linked
github_url: https://github.com/OWNER/REPO/issues/NNN    # optional
topic: "[Research question]"
tags: [research, codebase, relevant-component-names]    # 2-5 tags, lowercase-hyphenated, reuse existing tags
status: complete
type: research
last_updated: YYYY-MM-DD                                # only on follow-ups (Step 10)
last_updated_note: "Added follow-up research for X"     # only on follow-ups
---
```

## Section order

```markdown
# Research: [Question / Topic]

## Prior Work
[builds_on:: / tensions:: wikilinks with evidence weighting — see below]

## Research Question
[Original user query, verbatim]

## Summary
[High-level documentation of what was found]

## Detailed Findings

### [Component / Area 1]
- Description of what exists (`file.ext:line` or [permalink](https://github.com/...))
- How it connects to other components
- Current implementation (no evaluation)

### [Component / Area 2]
...

## Code References
- `path/to/file.py:123` — Description
- `another/file.ts:45-67` — Description

## Architecture Documentation
[Current patterns / conventions / design implementations found in the codebase]

## Historical Context (from thoughts/)
[Insights from thoughts/ directory with references]

## Related Research
[Links to other research docs in thoughts/shared/research/]

## Open Questions
[Areas needing further investigation]

## UI Baseline                                      # optional — appended after the main flow when Playwright baseline ran (see playwright-baseline.md)
```

## Prior Work + evidence weighting

The `## Prior Work` section immediately follows the title (before `## Research Question`):

```markdown
## Prior Work

- builds_on:: [[prior-research-doc]] (research — primary evidence)
- builds_on:: [[prior-plan-doc]] (plan — describes intent, may not reflect outcome)
- tensions:: [[conflicting-idea-doc]] (idea — unvetted, but flags a considered alternative)
```

Evidence-weight qualifiers signal evidence strength:

| Doc type | Weight | Interpretation |
|---|---|---|
| `research` | Primary | Verified findings about what exists |
| `review` | Secondary | Findings validated against actual implementation |
| `plan` | Weak | Describes intent — may diverge from what was built |
| `idea` | Weakest | Unvetted thinking, useful as alternative-considered context |

Qualifiers are encouraged on new docs; existing Prior Work entries do not need retroactive annotation. Use filenames without `.md` extension as wikilink targets. If no relevant prior work exists, write `None identified.`.

## Files Affected (required by `--mode auto`)

```markdown
## Files Affected

### Will Modify
- `src/auth/middleware.ts` — Add token refresh logic
- `src/auth/types.ts` — New RefreshToken type

### Will Read (Dependencies)
- `src/config/auth-config.ts` — Token expiry settings
- `src/lib/http-client.ts` — Existing request interceptor pattern
```

Rules:

- Paths are relative to the repo root.
- `Will Modify` = files this issue creates or changes.
- `Will Read` = files this issue depends on but won't change.
- Each path must be backtick-wrapped (`doc-structure-validator.sh` regex: `` `[^`]+` ``).
- Both subsections required even if empty (use `None` if no files apply).
- Cross-repo: prefix paths with repo key — `api-service:src/lib/client.ts`, `web-client:src/hooks/use-api.ts`. Required for downstream work-stream detection.

## Pipeline History (optional, autonomous-only)

```markdown
## Pipeline History
Based on outcome_events for component area `[area]`:
- N total events, X passed, Y failed
- Average drift count: Z files
- Estimate accuracy: [summary]
- Most common blocker: [if patterns emerge]
```

Populated from `knowledge_query_outcomes` results in autonomous Step 3c. Omit entirely if no outcome data was retrieved. Do not invent data.

## Cross-Repo Scope (optional)

```markdown
## Cross-Repo Scope

Repos involved:
- `api-service` (<localDir>) — [what changes are needed]
- `web-client` (<localDir>) — [what changes are needed]

Dependency relationship: api-service → web-client (web-client imports from api-service)
```

Consumed by plan and impl skills to set up per-repo worktrees and wire `blockedBy` dependencies.

## Permalink format

When converting local file references to permalinks (Step 7), the shape is:

```
https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/<commit>/<file>#L<line>
```

Use the commit SHA from `git rev-parse HEAD` at the time the doc was written. Only convert when on `main` or when the commit has been pushed — otherwise the permalink resolves to nothing.

## Artifact comment

When linking the doc to an issue (Step 8 interactive, Step 7 autonomous):

```markdown
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

Key findings: [1-3 line summary of the most important discoveries]
```

Post via `create_comment(number: NNN, body: ...)`. The `## Research Document` header is load-bearing — downstream tools (hooks, dashboards) discover the doc by grepping for this exact heading.

## Per-mode required-sections matrix

| Section | Default (interactive) | `--mode auto` | `--mode prove` |
|---|---|---|---|
| Frontmatter | required | required | n/a (no doc) |
| Prior Work | required | required | n/a |
| Research Question | required | required | (Claim instead) |
| Summary | required | required | (Verdict instead) |
| Detailed Findings | required | required | (Evidence Chains instead) |
| Files Affected | recommended | **required** (hook-enforced) | n/a |
| Pipeline History | optional | optional | n/a |
| Cross-Repo Scope | optional | optional | n/a |
| UI Baseline | conditional | conditional | n/a |

`--mode prove` does not write a doc — it produces an inline verdict block per `prove-claim.md` § Report template.
