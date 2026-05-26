# PR creation

How `/ralph:impl --mode pr` composes the PR body, evaluates cross-repo, optionally pushes the body to Drive, and fires the scout-trigger heuristic.

## §Body template

PR title: `GH-NNN: <issue title>`.

PR body, in order:

```
## Summary

<1-3 sentences describing what this PR does. Sourced from the issue body or
plan Overview when delegation is disabled or below threshold.>

## Plan

<Link to the plan doc, e.g.:
 https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNNN-*.md>

Phases shipped: N of M    (group issues only — omit for standalone)

## Test plan

- [ ] Automated verification per plan Success Criteria
- [ ] Manual verification per plan Success Criteria
- [ ] Cross-phase integration check (multi-phase plans only)

<Replace bullets with the actual checklist items from the plan's Success
Criteria sections.>

Closes #NNN
<For group issues, one Closes line per sub-issue:>
Closes #NNN_child1
Closes #NNN_child2
```

## §Cross-repo

When the issue has multiple worktrees (cross-repo scope), create one PR per repo and cross-reference them via PR body links.

For each repo with a worktree:

```bash
cd <repo>/worktrees/GH-NNN
git push -u origin feature/GH-NNN
gh pr create \
  --repo <owner>/<repo> \
  --title "GH-NNN: <title>" \
  --body "$(cat <<'BODY'
## Summary
<summary scoped to this repo>

## Cross-Repo Context
This PR is part of GH-NNN. Related PRs:
- <other-repo> PR #<num> (<upstream|downstream>, merge <first|after>)

Closes #NNN
BODY
)"
```

After creating all PRs, edit each PR body to link the others. Merge order comes from the `dependency-flow` field in the registry pattern.

## §Scout Trigger

Conservative heuristic — false-positive cost (backend PRs flagged) exceeds false-negative cost (UI PR slips through, recoverable via manual `/scout`).

After PR creation, fetch the diff's file list:

```bash
gh pr diff <PR_NUMBER> --name-only
```

The heuristic fires when ANY changed file matches one of:

- `**/*.tsx`, `**/*.svelte`, `**/*.vue`
- `**/components/**`, `**/storybook/**`
- `**/*.css`, `**/*.scss`

When no files match, skip silently — no comment, no error. When at least one matches, post a `## Scout Trigger` comment with `/scout` body and a list of matched files. The comment is **advisory** — failures of `gh pr comment` are logged to stderr but do NOT block the PR creation flow.
