# Plan shapes

Plan-doc structure consumed by default, `--mode auto`, and `--mode epic` (with epic-specific variant). The `doc-structure-validator.sh` hook enforces a subset of these sections for plan-mode writes.

## Filename convention

`thoughts/shared/plans/YYYY-MM-DD-[GH-NNNN-]description.md` where:

- `YYYY-MM-DD` is today's date.
- `GH-NNNN` is the zero-padded primary issue number. Omit if no linked issue.
- `description` is brief kebab-case.

Examples:

- With issue: `2026-05-23-GH-1364-ralph-plan-4-plan.md`
- Without issue: `2026-05-23-multi-tenant-tokens.md`
- Plan-of-plans (epic): `2026-05-23-GH-1300-epic-mobile-app-decomposition.md`

## Frontmatter

```yaml
---
date: YYYY-MM-DD
status: draft                    # draft → ready → approved → in-progress → complete
type: plan                       # or "plan-of-plans" for epic mode
tags: [relevant, topic, tags]    # 2-5 lowercase-hyphenated
github_issue: NNN                # optional
github_issues: [NNN, NNN, ...]   # for multi-issue groups
github_urls:
  - https://github.com/OWNER/REPO/issues/NNN
primary_issue: NNN
estimate: XS|S|M|L|XL             # optional; copied from the linked issue
research_waived: <reason>         # optional; human override (interactive only)
---
```

- `estimate:` — copied from the linked issue. Lets `plan-research-required.sh`
  waive the research requirement for sub-threshold work (estimates below
  `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE`, default `M`).
- `research_waived:` — set **only** when a human explicitly approves planning
  without research (interactive "plan anyway"). Auto mode never sets this.

## Section order (standard plan)

```markdown
# [Plan title — descriptive, references the work]

## Prior Work
[builds_on:: / tensions:: wikilinks with evidence weighting]

## Overview
[1-3 paragraphs: what + why]

## Current State Analysis
[What exists today, where the work lives, key constraints]

### Key Discoveries
[Bullet list of load-bearing facts the plan reacts to — file:line refs]

## Desired End State
[Numbered list of post-merge invariants]

### Verification
[Bullet list — automated and manual checks proving Desired End State]

## What We're NOT Doing
[Bullet list — scope boundaries]

## Design Decisions & Open Ambiguities
[Resolved decisions as bullets; open items as `#### Decision:` blocks;
sentinel line when no open items — see § Design decisions anatomy]

## Implementation Approach
[1-2 paragraphs — high-level shape, phase count, file ownership intent]

## Phase 1: [Descriptive name]
### Overview
[1-2 sentences]

### Changes Required
#### 1. [Component / File group]
**File**: `relative/path.ts`
**Changes**: [What changes]

### Success Criteria
#### Automated Verification
- [ ] `command to run` returns expected result
- [ ] tests pass

#### Manual Verification
- [ ] User-visible behavior matches

## Phase 2: [...]
...

## Testing Strategy
### Unit Tests
### Integration Tests
### Manual Testing Steps

## Performance Considerations

## Migration Notes

## References
```

## Design decisions anatomy

The `## Design Decisions & Open Ambiguities` section is the plan's human-interface contract: every judgment call the planner made or could not settle lives here, authored at the moment of uncertainty — never buried in phase prose. `doc-structure-validator.sh` enforces the section's presence (all plan shapes) and requires EITHER ≥1 open `#### Decision:` block OR the literal sentinel.

**Resolved decisions** — bullets, one per settled judgment call:

```markdown
- **<Decision title>** — options: <option A>; <option B>; <option C>. **Decided: <choice>.** <1-2 sentence rationale>
```

**Open decisions** — one `#### Decision:` block per unsettled judgment call. The agent's recommendation is listed FIRST among the options and marked:

```markdown
#### Decision: <short title>

- **Context**: <why this must be decided — what the plan cannot settle from research alone>
- **Options**:
  1. <recommended option> *(agent recommendation)*
  2. <alternative>
  3. <alternative>
- **Recommendation**: <option 1 restated + 1-2 sentence rationale>
- **Blocked without it**: <which phases/files cannot proceed or would embed a guess>
```

**Sentinel** — when there are NO open `#### Decision:` blocks, the section MUST end with the literal line (it may follow resolved-decision bullets):

```markdown
None — no open design decisions.
```

Downstream contract: `/ralph:plan --mode review` presents open blocks to the human (decision pickers in interactive mode; a `## Decision Request` comment in auto mode) and auto-advances sentinel-only plans. Auto-mode planners: unresolved judgment calls that research cannot settle become `#### Decision:` blocks instead of silent assumptions or `__ESCALATE__` (escalation remains for missing-research / conflicting-implementation triggers).

## Phase-section anatomy

Each `## Phase N:` section MUST include:

1. **`depends_on:`** — annotation immediately under the heading. Values:
   - `null` — no dependencies, can start immediately.
   - `[phase-N]` — blocked by another phase in this plan.
   - `[phase-N, phase-M]` — blocked by both.
   - `[GH-NNN]` — blocked by a specific issue (cross-plan reference).
   - If omitted, phases are treated as sequential (Phase N depends on Phase N-1).
   Consumed by orchestrators (hero, autopilot) to decide which phases can dispatch in parallel and by `sync_plan_graph` for graph snapshots.
2. **Overview** — 1-2 sentences describing the phase's outcome.
3. **Changes Required** — concrete file paths + what changes. Backtick-wrap each path.
4. **Success Criteria** with TWO subsections:
   - **`#### Automated Verification`** — commands / tests that prove correctness without human eyes. The `doc-structure-validator.sh` hook checks for this header pattern.
   - **`#### Manual Verification`** — what the user must observe themselves (UI behavior, data integrity post-migration).

File ownership rule: each phase owns a tightly-scoped file set. Phases should not stomp on each other's files. Document file ownership explicitly when a file is touched in multiple phases.

## Task anatomy (opt-in, per phase)

A `### Tasks` section is an opt-in upgrade for a single phase, not a required plan section. Add one when a phase splits into ≥2 file-disjoint chunks that benefit from parallel sub-agent dispatch or per-task model-tier routing — `/ralph:impl --mode auto` then runs that phase through its task-graph controller (`phase-execution.md`). Phases without `### Tasks` are implemented directly by the same skill; that is the normal shape for most plans, especially XS/S.

Tasks use `#### Task N.M:` subheadings, each carrying four YAML fields below the heading. The fields are consumed by the impl controller when dispatching implementer sub-agents. (The per-phase `depends_on:` annotation is separate: `plan-postcondition.sh` greps for `depends_on.*\[` to warn when `sync_plan_graph` hasn't been called, and `sync_plan_graph` reads only those phase-level annotations — it does not parse task blocks.)

```markdown
#### Task 1.1: [descriptive name]
- **files**: `path/to/file.ts` (create|modify|read)
- **tdd**: true | false
- **complexity**: low | medium | high
- **depends_on**: null | [N.M, ...]
- **acceptance**:
  - [ ] [Specific verifiable criterion with concrete values]
  - [ ] [Another criterion]
```

Field semantics:

| Field | Values | Why |
|---|---|---|
| `files` | one or more backtick-wrapped paths with `(create\|modify\|read)` action | File ownership at task granularity — lets the parallel-dispatch graph detect write conflicts. |
| `tdd` | `true` / `false` (default `false`) | When `true`, the implementer writes the failing test first. Honored by `/ralph:impl --mode auto`. |
| `complexity` | `low` / `medium` / `high` | Sub-agent model-tier hint. `high` tasks dispatch at opus by default; `low`/`medium` at sonnet/haiku per the model-tier policy. |
| `depends_on` | `null` / `[N.M, ...]` | Same shape as the per-phase annotation, scoped to sibling tasks within the phase. |
| `acceptance` | markdown checkbox list | One verifiable criterion per checkbox. Surfaced in the implementer's context packet (`implementer-prompt.md`). |

Worked example:

```markdown
#### Task 1.1: extract token parser into shared module
- **files**: `src/lib/token-parser.ts` (create), `src/handlers/auth.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] `npm test src/lib/token-parser.test.ts` passes (parser has its own test file)
  - [ ] `src/handlers/auth.ts` imports the new module; inline parser code deleted
  - [ ] `npm run build` exits 0

#### Task 1.2: wire feature flag for new parser
- **files**: `src/config/flags.ts` (modify), `src/handlers/auth.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Flag defaults to `false`; old code path preserved for rollback
  - [ ] `grep -r "useNewParser" src/` returns ≥1 hit in flags.ts and auth.ts
```

Tasks without the four YAML fields still parse — no hook blocks on their absence. `plan-postcondition.sh` warns only when the per-phase `depends_on:` annotation is present but `sync_plan_graph` was not called.

## Group plans (feature = PR unit)

A group plan covers a set of sibling issues that ship as ONE PR (GH-1538).
It is a **standard plan** — same required sections, same
`doc-structure-validator.sh` branch — distinguished only by frontmatter and
the phase↔member convention:

- **Frontmatter**: `github_issues: [NNN, NNN, ...]` (every member),
  `primary_issue:` (lowest member number — keys the worktree
  `GH-[primary]` and branch `feature/GH-[primary]`), `estimate:` set to the
  HIGHEST member estimate (drives the research-required gate honestly).
- **Phase↔member mapping**: one `## Phase N: GH-NNN — <name>` per member,
  in dependency order. Phase `depends_on:` mirrors the members' `blockedBy`
  edges (intra-group edges become phase ordering; they do NOT keep members
  out of the group).
- **Downstream**: `/ralph:impl --mode auto` executes phases in the shared
  worktree; `--mode pr` emits one `Closes #NNN` per member;
  `sync-pr-merge.yml` advances every member on merge.

Authored by `--mode auto` Step 2a (sibling-group detection, see
`intake-routing.md` § Sibling-group planning) or by hand. Late-arriving
siblings are appended to `github_issues:` by the parent-plan-reuse path.

## Plan-of-plans variant (epic mode)

Epic mode writes a different shape — see `decomposition.md` § Plan-of-plans shape. Key differences:

- No phases; instead `## Feature Decomposition` with `### Feature A`, `### Feature B`, etc.
- `## Strategic Context` replaces `## Current State Analysis`.
- `## Feature Sequencing` replaces phase ordering.
- `## Integration Strategy` describes how features compose.
- `## Design Decisions & Open Ambiguities` is required here too (§ Design decisions anatomy) — epic decomposition is decision-dense by nature; author it alongside Feature Decomposition.

## Estimate / complexity decision guide

| Estimate | Phase count | When |
|---|---|---|
| XS | 1 phase | Single concern, < 100 LOC, no schema changes |
| S | 2-3 phases | Single concern, < 500 LOC, optional schema |
| M | 5-7 phases | Multiple concerns; needs `--mode epic` if there are independent features |
| L | 7-10 phases | Multi-tier; `--mode epic` required |
| XL | Plan of plans | Always `--mode epic` |

Plan 4 `--mode auto` targets XS/S only — advisory in the body, no hook enforcement (the slim plugin's `plan-tier-validator.sh` only catches shape corruption, not estimate gating). Default and iterate modes accept M too. L+ requires `--mode epic`.

## Per-mode required-sections matrix

| Section | default (interactive) | `--mode auto` | `--mode epic` |
|---|---|---|---|
| Frontmatter | required | required | required |
| Prior Work | required | required | required |
| Overview | required | required | required |
| Current State Analysis | required | required | replaced by Strategic Context |
| Desired End State | required | required | replaced by Integration Strategy |
| What We're NOT Doing | required | required | required |
| Design Decisions & Open Ambiguities | required | required | required |
| Implementation Approach | required | required | replaced by Feature Decomposition |
| Phase N sections | required | required | n/a (no phases) |
| Feature Decomposition | n/a | n/a | required |
| Feature Sequencing | n/a | n/a | required |
| Testing Strategy | recommended | required | optional |
| Performance Considerations | optional | optional | optional |
| Migration Notes | optional | required | required |
| UI Validation Phase | conditional | conditional | n/a |

`--mode iterate` consumes an existing plan and preserves its section shape — no new required sections.

`--mode review` writes a separate critique doc per `plan-review.md` § Critique-doc structure.
