# Artifact Metadata

## Purpose

Defines file naming patterns, frontmatter schemas, and the Artifact Comment Protocol for all Ralph workflow artifacts.

## Definitions

- **Artifact**: A file produced by a Ralph skill (research document, plan, critique, report)
- **Frontmatter**: YAML metadata block at the top of a markdown file, delimited by `---`
- **Artifact Comment**: A GitHub issue comment that links an artifact to its issue using a standardized header
- **Zero-padding**: 4-digit issue number format in filenames (`GH-0019`, not `GH-19`)
- **Passthrough**: Caching mechanism that avoids redundant artifact validation across hook calls within a single skill invocation

## Requirements

### File Naming Patterns

| Requirement | Enablement |
|-------------|------------|
| Research artifacts MUST be named `YYYY-MM-DD-GH-{NNNN}-{slug}.md` | [ ] not enforced |
| Research artifacts MUST be placed in `thoughts/shared/research/` | [x] `research-postcondition.sh` |
| Plan (single) artifacts MUST be named `YYYY-MM-DD-GH-{NNNN}-{slug}.md` | [ ] not enforced |
| Plan (group) artifacts MUST be named `YYYY-MM-DD-group-GH-{NNNN}-{slug}.md` | [ ] not enforced |
| Plan (stream) artifacts MUST be named `YYYY-MM-DD-stream-GH-{NNN}-{NNN}-{slug}.md` | [ ] not enforced |
| Plan artifacts MUST be placed in `thoughts/shared/plans/` | [x] `plan-postcondition.sh` |
| Critique artifacts MUST be named `YYYY-MM-DD-GH-{NNNN}-critique.md` | [ ] not enforced |
| Critique artifacts MUST be placed in `thoughts/shared/reviews/` | [x] `review-postcondition.sh` |
| Report artifacts MUST be named `YYYY-MM-DD-{slug}.md` | [ ] not enforced |
| Report artifacts MUST be placed in `thoughts/shared/reports/` | [x] `report-postcondition.sh` |
| Issue numbers in filenames MUST use 4-digit zero-padding (`GH-0019`) | [ ] not enforced (convention only) |
| There MUST NOT be duplicate research artifacts for the same issue | [x] `pre-artifact-validator.sh` |
| There MUST NOT be duplicate plan artifacts for the same issue | [x] `pre-artifact-validator.sh` |
| There MUST NOT be duplicate review artifacts for the same issue | [x] `pre-artifact-validator.sh` |

### Frontmatter Schemas

#### Research Documents

| Requirement | Enablement |
|-------------|------------|
| Research docs MUST include `date` field (YYYY-MM-DD) | [ ] not enforced |
| Research docs MUST include `github_issue` field (integer) | [ ] not enforced (declared in `ralph-command-contracts.json` but no hook validates) |
| Research docs MUST include `github_url` field (full issue URL) | [ ] not enforced |
| Research docs MUST include `status` field (`draft` or `complete`) | [ ] not enforced |
| Research docs MUST include `type: research` field | [ ] not enforced |

#### Plan Documents (Single Issue)

| Requirement | Enablement |
|-------------|------------|
| Plan docs MUST include `date` field (YYYY-MM-DD) | [ ] not enforced |
| Plan docs MUST include `status` field (`draft` or `complete`) | [ ] not enforced |
| Plan docs MUST include `github_issues` field (array of integers) | [ ] not enforced |
| Plan docs MUST include `github_urls` field (array of full issue URLs) | [ ] not enforced |
| Plan docs MUST include `primary_issue` field (integer) | [ ] not enforced |

#### Plan Documents (Group)

| Requirement | Enablement |
|-------------|------------|
| Group plan docs MUST include all single-plan fields | [ ] not enforced |
| Group plan docs MAY include `stream_id` field (when part of a stream) | [ ] not enforced |
| Group plan docs MAY include `stream_issues` field (array, when part of a stream) | [ ] not enforced |
| Group plan docs MAY include `epic_issue` field (integer, when under an epic) | [ ] not enforced |

#### Critique Documents

| Requirement | Enablement |
|-------------|------------|
| Critique docs MUST include `date` field (YYYY-MM-DD) | [ ] not enforced |
| Critique docs MUST include `github_issue` field (integer) | [ ] not enforced |
| Critique docs MUST include `status` field (`approved` or `needs-iteration`) | [ ] not enforced |
| Critique docs MUST include `type: critique` field | [ ] not enforced |

### Artifact Comment Protocol

Skills link artifacts to issues by posting a GitHub comment with a standardized header.

| Requirement | Enablement |
|-------------|------------|
| Research artifacts MUST be linked with a `## Research Document` comment header | [ ] `artifact-discovery.sh` warns but does not block |
| Plan artifacts MUST be linked with a `## Implementation Plan` comment header | [ ] `artifact-discovery.sh` warns but does not block |
| The artifact URL MUST appear on the line immediately after the header | [ ] not enforced |
| Artifact discovery MUST search issue comments for the header, then extract the URL | [ ] not enforced (implemented in skill prompts, not hooks) |
| When multiple comments match a header, the MOST RECENT (last) match MUST be used | [ ] not enforced |

### Artifact Discovery Sequence

When a skill needs to locate a linked artifact:

1. Search issue comments for the standardized header (`## Research Document` or `## Implementation Plan`)
2. Extract the GitHub URL from the line after the header
3. Convert to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
4. If no comment found, fall back to glob: `thoughts/shared/{type}/*GH-{NNNN}*` (try both padded and unpadded)
5. If fallback finds a match, self-heal by posting the missing comment

| Requirement | Enablement |
|-------------|------------|
| Skills MUST follow the discovery sequence when locating artifacts | [ ] not enforced (implemented in skill prompts) |
| Skills MUST self-heal missing artifact comments when fallback glob succeeds | [ ] not enforced |

### Artifact Passthrough Protocol

| Requirement | Enablement |
|-------------|------------|
| `RALPH_ARTIFACT_CACHE` env var MUST cache validation results between hook calls | [x] `artifact-discovery.sh` |
| Hooks MUST check `RALPH_ARTIFACT_CACHE` before making redundant API calls | [x] `artifact-discovery.sh` |

### Research Document Content Requirements

| Requirement | Enablement |
|-------------|------------|
| Research docs MUST include a `## Files Affected` section | [x] `research-postcondition.sh` |
| `## Files Affected` MUST contain `### Will Modify` and `### Will Read (Dependencies)` subsections | [x] `research-postcondition.sh` |

## Cross-References

- [skill-io-contracts.md](skill-io-contracts.md) — which skills create which artifact types
- [document-protocols.md](document-protocols.md) — detailed content requirements per document type (Phase 2)
