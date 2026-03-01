## Artifact Comment Protocol

GitHub issue comments are the primary source of truth for all artifacts produced by the pipeline.

### Comment Section Headers

| Phase | Header |
|-------|--------|
| Research | `## Research Document` |
| Plan | `## Implementation Plan` |
| Review | `## Plan Review` |
| Implementation | `## Implementation Complete` |

### Discovery Steps

1. Fetch issue with comments: `ralph_hero__get_issue(owner, repo, number)`
2. Search comments for the section header (e.g., `## Research Document`)
3. If multiple comments match, use the **most recent** (last) match
4. Extract the URL from the first line after the header
5. Convert GitHub URL to local path: strip `https://github.com/OWNER/REPO/blob/main/` prefix
6. Read the local file

### Fallback Discovery

If comment search fails:

1. **Glob fallback**: Search `thoughts/shared/{type}/*GH-{number}*`. Try both unpadded and zero-padded patterns.
2. **Group glob fallback**: Try `*group*GH-{primary}*` where `{primary}` is the primary issue number.
3. **Stream glob fallback**: Try `*stream*GH-{number}*` to find stream plans containing this issue.
4. **If found, self-heal**: Post the missing comment to the issue using the correct section header, appending `(Self-healed: artifact was found on disk but not linked via comment)`.
5. **If not found**: Block and report the missing artifact.

### Deterministic File Naming

| Type | Pattern |
|------|---------|
| Research | `thoughts/shared/research/YYYY-MM-DD-GH-NNNN-description.md` |
| Plan | `thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-description.md` |
| Group Plan | `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md` |
| Review | `thoughts/shared/reviews/YYYY-MM-DD-GH-NNNN-critique.md` |

**Note on zero-padding**: Filenames use zero-padded 4-digit issue numbers (e.g., `GH-0042`). When constructing glob patterns, try BOTH padded and unpadded forms.

### Known Limitations

- **10-comment limit**: `get_issue` returns only the last 10 comments. The glob fallback provides a reliable secondary discovery path.
- **Group glob for non-primary issues**: Group plans use the primary issue number in filenames. Non-primary group members won't match `*GH-43*`. Try `*group*GH-{primary}*` after `*GH-{number}*` fails.
