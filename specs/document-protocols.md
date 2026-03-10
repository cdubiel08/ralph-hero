# Document Protocols

## Purpose

Defines content structure, quality criteria, and enforcement status for documents produced by Ralph skills — research, plan, and review/critique.

## Definitions

- **Research Document**: Investigation output created by ralph_research. Analyzes codebase, extracts data, and recommends next steps.
- **Plan Document**: Implementation specification created by ralph_plan. Defines phased changes with success criteria.
- **Critique Document**: Review output created by ralph_review (AUTO mode). Contains verdict and findings.
- **Phase Structure**: Plan documents organize work into numbered phases (`## Phase N: Title`), each with its own success criteria.
- **Convergence Verification**: For group plans, validation that all grouped issues are addressed coherently before proceeding.
- **Artifact Comment**: A GitHub issue comment posted after document creation, containing a header and blob URL linking to the committed document.

## Requirements

### 1. Research Documents

**Required sections**:
- Frontmatter block (YAML)
- Problem statement
- Current state analysis
- Key discoveries with `file:line` references
- Potential approaches (pros/cons)
- Risks
- Recommended next steps
- `## Files Affected` section with `### Will Modify` and `### Will Read (Dependencies)` subsections

**Frontmatter schema**: See [artifact-metadata.md](artifact-metadata.md) for the research frontmatter schema. Required fields: `date`, `github_issue`, `github_url`, `status: complete`, `type: research`.

| Requirement | Enablement |
|-------------|------------|
| Research documents MUST contain a `## Files Affected` section | `[x]` `research-postcondition.sh` |
| Research documents MUST be committed and pushed before linking | `[x]` `research-postcondition.sh` |
| Research documents MUST NOT duplicate an existing research artifact for the same issue | `[x]` `pre-artifact-validator.sh` |
| Research documents MUST contain frontmatter with `github_issue` and `status` fields | `[ ]` not enforced (declared in `artifact_types.research.validates` but no hook validates schema) |
| Research documents MUST contain all required sections (problem statement, analysis, discoveries, approaches, risks, next steps) | `[x]` `doc-structure-validator.sh` |
| An Artifact Comment with `## Research Document` header MUST be posted after creation | `[ ]` not enforced (`artifact-discovery.sh` warns only, does not block) |

**Quality criteria** (from quality-standards.md):
1. **Depth** — problem understood from user perspective, root cause analysis
2. **Feasibility** — existing codebase patterns identified
3. **Risk** — edge cases and failure modes identified
4. **Actionability** — recommendations with `file:line` references

| Requirement | Enablement |
|-------------|------------|
| Research documents SHOULD meet all four quality dimensions | `[ ]` not enforced (skill-prompt guidance only) |

### 2. Plan Documents

**Required sections**:
- Frontmatter block (YAML)
- Overview with phase table
- Current state analysis
- Desired end state with verification criteria
- "What We're NOT Doing" section
- Per-phase sections (`## Phase N: Title` pattern)
- Success criteria per phase (`- [ ] Automated:` / `- [ ] Manual:` format)
- Integration testing section
- References

**Frontmatter schema**: See [artifact-metadata.md](artifact-metadata.md) for the three plan frontmatter variants (single issue, group, stream). Required fields vary by variant; all include `date`, `status: draft`, `github_issues`, `github_urls`, `primary_issue`.

**Research prerequisite**: A research document MUST be attached to the issue before a plan can be created.

| Requirement | Enablement |
|-------------|------------|
| Plan documents MUST be committed before the skill completes | `[x]` `plan-postcondition.sh` |
| A research document MUST exist before plan creation | `[x]` `plan-research-required.sh` |
| Plan documents MUST NOT duplicate an existing plan artifact for the same issue | `[x]` `pre-artifact-validator.sh` |
| Plan documents MUST use `## Phase N:` header pattern for each phase | `[x]` `doc-structure-validator.sh` |
| Each phase MUST have success criteria in `- [ ] Automated:` / `- [ ] Manual:` format | `[x]` `doc-structure-validator.sh` |
| Plan documents MUST contain frontmatter with required fields | `[ ]` not enforced |
| An Artifact Comment with `## Implementation Plan` header MUST be posted after creation | `[ ]` not enforced (`artifact-discovery.sh` warns only) |

**Quality criteria** (from quality-standards.md):
1. **Completeness** — all requirements addressed
2. **Feasibility** — implementable with existing patterns
3. **Clarity** — success criteria are specific and testable
4. **Scope** — boundaries clearly defined

| Requirement | Enablement |
|-------------|------------|
| Plan documents SHOULD meet all four quality dimensions | `[ ]` not enforced (skill-prompt guidance only) |

### 3. Review/Critique Documents

**Required sections**:
- Frontmatter block (YAML)
- Verdict (APPROVED or NEEDS_ITERATION)
- Critique/findings

**Frontmatter schema**: See [artifact-metadata.md](artifact-metadata.md) for the critique frontmatter schema. Required fields: `date`, `github_issue`, `github_url` (if applicable), `status: complete` (if applicable), `type: review`.

**Verdict values**: APPROVED transitions the issue to In Progress. NEEDS_ITERATION transitions to Ready for Plan and adds `needs-iteration` label.

**AUTO vs INTERACTIVE modes**:
- **AUTO**: Critique document MUST be created and committed. `review-postcondition.sh` blocks if missing.
- **INTERACTIVE**: No critique document required. Human reviews the plan directly.

| Requirement | Enablement |
|-------------|------------|
| In AUTO mode, a critique document MUST be created and committed | `[x]` `review-postcondition.sh` |
| Critique documents MUST NOT duplicate an existing critique for the same issue | `[x]` `review-no-dup.sh` |
| Critique frontmatter MUST include `status`, `github_issue`, and `type: review` fields | `[x]` `review-verify-doc.sh` (blocks on missing fields) |
| Critique documents MUST contain a verdict section (APPROVED or NEEDS_ITERATION) | `[x]` `doc-structure-validator.sh` |
| An Artifact Comment with `## Plan Critique` header MUST be posted after creation | `[ ]` not enforced |

### 4. Convergence Verification (Group Plans)

For group plans (multiple issues planned together), convergence verification ensures all grouped issues are addressed coherently.

| Requirement | Enablement |
|-------------|------------|
| Group plans SHOULD have convergence verified before proceeding to `Plan in Progress` | `[ ]` warns only (`convergence-gate.sh` warns on missing `RALPH_CONVERGENCE_VERIFIED`, does not block) |
| Full convergence check is available via `ralph_hero__check_convergence` MCP tool | `[x]` `check_convergence` tool |

### 5. Document Quality Dimensions

Quality criteria are defined in `quality-standards.md` and referenced by skill prompts. They are not machine-enforced.

| Document Type | Quality Dimensions |
|--------------|-------------------|
| Research | Depth, Feasibility, Risk, Actionability |
| Plan | Completeness, Feasibility, Clarity, Scope |

| Requirement | Enablement |
|-------------|------------|
| Skills SHOULD evaluate documents against their type-specific quality dimensions | `[ ]` not enforced (quality is skill-prompt guidance only) |

## Cross-References

- [artifact-metadata.md](artifact-metadata.md) — File naming patterns, frontmatter schemas, Artifact Comment Protocol
- [skill-io-contracts.md](skill-io-contracts.md) — Which skills produce which documents (postconditions)
- [issue-lifecycle.md](issue-lifecycle.md) — State transitions that trigger document creation (e.g., Research Needed triggers research, Ready for Plan triggers planning)
