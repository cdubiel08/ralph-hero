# Issue template

This reference is consulted by `/ralph:form` Step 6a (single issue) and Step 6b (ticket tree). It carries the issue body shape, the research-aware variant, the artifact-comment protocol, the tree structure, and the source-file frontmatter updates.

## Single-issue body

Use this template for the issue body. Show it to the user for approval before calling `create_issue`.

```markdown
## Summary

[What and why — 1-3 sentences]

## Acceptance Criteria

- [ ] [Specific, testable criterion]
- [ ] [Another criterion]
- [ ] [Etc — keep these concrete and verifiable]

## Context

- Related: [links to related issues / docs found during dedup]
- Idea source: [link to draft idea file, if applicable]
```

Alongside the body, propose:

- **Title** — concise, actionable (≤ 70 chars).
- **Labels** — based on dedup findings + idea content.
- **Estimate** — XS / S / M / L / XL.
- **Priority** — P0 / P1 / P2 / P3.

## Research-aware variant

When `INPUT_TYPE == "research"`, append a `## Research` section to the body:

```markdown
## Research

See [research doc](https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md)
```

This signals to downstream verbs that the research phase is already done; `/ralph:plan` can skip straight to planning.

## Artifact comment (research inputs)

After creating the issue from a research input, post a comment on the new issue using the Artifact Comment Protocol:

```markdown
## Research Document

https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/research/[filename].md

Key findings: [1-3 line summary from the research doc's Summary section]
```

This mirrors the protocol used by `/ralph:research` so the issue's comment history shows the artifact provenance in a consistent shape.

## Ticket-tree shape

For Step 6b:

```
Proposed ticket tree:

**Parent**: [Epic title] (L)
├── #??: [Sub-task 1] (XS)
├── #??: [Sub-task 2] (XS)
├── #??: [Sub-task 3] (S)
└── #??: [Sub-task 4] (XS)

Each sub-issue is scoped to XS/S for autonomous implementation.
```

Creation order:

1. Parent: `create_issue` with `estimate: L`, `workflowState: "Backlog"`.
2. All children in ONE `create_sub_issues(parentNumber: <parent-number>, children: [{title, body, estimate: "XS", workflowState: "Backlog", dependsOn: [...]}, ...])` call — each entry gets `estimate: XS` (occasionally `S`). The call links every child under the parent and wires dependency edges in the same request; check the response's per-child status for `error` and repair only the failed children.
3. Sequential children only: give the later child's entry `dependsOn: [<earlier sibling's index>]` so the edge is wired inline (a `dependsOn` value is a sibling index into this call's children array; use `dependsOnIssues` for a pre-existing GitHub issue blocker). Independent children get no `dependsOn` entry — parallelism is the default.

Estimate defaults — **L** for parent, **XS** for child. Bump to **S** for any child that touches >1 component or has nontrivial design surface; bump to **M** only if the child should probably be its own sub-tree.

## Source-file frontmatter updates

After Step 6a or 6b lands the issue(s):

### For `INPUT_TYPE == "idea"`

```yaml
type: idea
github_issue: NNN
status: formed
```

### For `INPUT_TYPE == "research"`

```yaml
github_issue: NNN
github_url: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
```

Do NOT overwrite the existing `type: research` — preserve it.

### For Step 6c handoff

Idea: `status: forming` (still in motion, awaiting plan/research).
Research: no change (research docs don't have a `status` field).

### For Step 6d refined draft

Idea: `status: refined` (enriched but no GitHub artifact created yet).
Research: no change.
