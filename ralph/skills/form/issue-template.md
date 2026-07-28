# Issue template

This reference is consulted by `/ralph:form` Step 6a (single issue) and Step 6b (epic parent, decomposed later by `/ralph:plan --mode epic`). It carries the issue body shape, the research-aware variant, the artifact-comment protocol, the tree structure plan epic will produce, and the source-file frontmatter updates.

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

## Epic tree preview (Step 6b)

Show only a preview of what `/ralph:plan --mode epic` will later build from the parent — **form does not create this tree** (GH-1605). Form's Step 6b creates only the parent issue; decomposition into feature children is entirely `/ralph:plan --mode epic`'s job, per `decomposition.md` § Child creation:

```text
Proposed epic:

**Parent**: [Epic title] (L)
(features + internal tasks decomposed later by `/ralph:plan --mode epic`)
```

Do not preview specific feature titles or estimates here — the plan-of-plans decomposition (`ralph/skills/plan/decomposition.md` § Feature Decomposition) is what names features, and doing that work twice (once loosely in form, once for real in plan) invites drift between the two.

**What `/ralph:plan --mode epic` builds later** (for context — form does not execute any of this):

- Each **feature child is the PR unit** (GH-1538) — sized **S or M**, never XS, and never a further sub-issue. Typical fan-out: an **L** epic decomposes into 3-5 S children; an **XL** epic into 3-5 M children, or 6-10 S children.
- A feature's internal work is represented as plan **phases** inside that child's own implementation plan (executed one per tick by `/ralph:impl --mode auto`, committed per phase on one branch) — **not** as additional XS task-level sub-issues under it.
- All children are created together in one `create_sub_issues` call, with dependency edges (`dependsOn` sibling indices / `dependsOnIssues` for pre-existing blockers) wired inline in the same request.

Creation order — **form performs step 1 only**:

1. Parent: `create_issue` with `estimate: L` (or `XL`), `workflowState: "Backlog"`.
2. (Later, by `/ralph:plan --mode epic`, not form) All feature children in ONE `create_sub_issues(...)` call, each `estimate: "S"` or `"M"` per the fan-out table above.

Estimate defaults — **L** (or **XL** for a larger epic) for the parent. Form does not assign a child estimate at all; that is `/ralph:plan --mode epic`'s decision once the Feature Decomposition exists.

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
