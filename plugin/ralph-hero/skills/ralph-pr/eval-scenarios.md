---
type: eval-scenarios
skill: ralph-pr
date: 2026-04-25
status: defined
---

# Ralph-PR Eval Scenarios

Three scenarios used to grade the ralph-pr skill on its primary PR-creation paths: standalone, group, and cross-repo. Manual or future-automated execution should produce structured outputs that can be checked against the assertions below.

> **Execution note**: These scenarios are written but **not executed** by this audit. Manual eval runs are tracked outside the audit plan (see #566). When grading, dispatch the `pr-agent` against a test issue matching the Input column and compare the actual `gh pr view` output and the `## Pull Request` issue comment to the Assertions.

---

## Scenario A: Standalone PR creation

### Input

An "In Progress" issue with the following shape:

- **Title**: "Add `--json` flag to `pipeline_dashboard`"
- **Estimate**: S
- **No sub-issues** (standalone). `list_sub_issues` returns an empty list.
- **Plan document**: `thoughts/shared/plans/2026-04-NN-GH-NNN-pipeline-dashboard-json.md`. Linked via `## Implementation Plan` comment on the issue.
- **Worktree**: `worktrees/GH-NNN`, branch `feature/GH-NNN`, all commits pushed-ready.

### Expected Behavior

1. Skill parses args, exports `RALPH_TICKET_ID="GH-NNN"`.
2. Skill fetches issue and confirms it is standalone (`list_sub_issues` returns empty).
3. Skill verifies worktree `worktrees/GH-NNN` exists.
4. Skill pushes branch via `git push -u origin feature/GH-NNN`.
5. Skill builds the enriched PR body with: `## Summary`, `## Plan` (link to the plan doc resolved from Step 2 comments), `## Test plan` checklist (sourced from plan Success Criteria), and a single `Closes #NNN` line.
6. Skill creates the PR via `gh pr create`, captures the URL.
7. Skill calls `save_issue(number=NNN, workflowState="In Review", command="ralph_pr")` to advance the standalone issue.
8. Skill posts a `## Pull Request` comment on the issue with the PR URL.
9. Skill outputs `PR CREATED` block with the captured PR URL.

### Assertions

- [ ] PR created on GitHub against `feature/GH-NNN` head and `main` base
- [ ] PR body contains `## Summary`, `## Plan`, `## Test plan`, and `Closes #NNN`
- [ ] `## Plan` section links to the plan doc URL
- [ ] No `Closes #` lines for non-existent sub-issues (standalone)
- [ ] No "Phases shipped: N of M" line (omitted for standalone)
- [ ] Issue workflow state advanced to "In Review" via `save_issue` with `command: "ralph_pr"`
- [ ] `## Pull Request` comment posted on issue with PR URL
- [ ] State gate hook (`pr-state-gate.sh`) does NOT block (transition is to a valid output state)
- [ ] `PR CREATED` block emitted with PR URL

---

## Scenario B: Group PR with child closes lines

### Input

An "In Progress" parent issue with the following shape:

- **Title**: "Bundled skill audits — Phase 2"
- **Estimate**: M (group)
- **Sub-issues**: 9 children (#NNN_1 through #NNN_9), all in "In Progress" or "In Review".
- **Plan document**: A single bundled plan covering all 9 phases. Linked via `## Implementation Plan` comment on the parent.
- **Worktree**: `worktrees/GH-NNN` (named after primary), branch `feature/GH-NNN`. Contains commits for all 9 phases.

### Expected Behavior

1. Skill detects the group via `list_sub_issues` returning 9 children.
2. Skill uses primary issue number for branch and worktree (already enforced by orchestrator).
3. Skill pushes the branch.
4. Skill builds the enriched PR body with:
   - `## Summary` (one paragraph describing the bundle).
   - `## Plan` linking to the bundled plan doc.
   - `Phases shipped: 9 of 9` line (group issue).
   - `## Test plan` checklist sourced from the plan's Success Criteria section.
   - `Closes #NNN` for parent + `Closes #NNN_K` for each of the 9 children.
5. Skill creates the PR.
6. Skill calls `list_sub_issues` and advances all 9 children to "In Review" via `save_issue` (one call per child, `command: "ralph_pr"`). Skill does NOT explicitly advance the parent — parent advancement is handled server-side.
7. Skill posts a `## Pull Request` comment on the parent and outputs `PR CREATED`.

### Assertions

- [ ] PR body contains exactly 10 `Closes #` lines (1 parent + 9 children)
- [ ] PR body contains `Phases shipped: 9 of 9`
- [ ] All 9 children advanced to "In Review" via `save_issue`
- [ ] Parent NOT explicitly advanced by ralph-pr
- [ ] `list_sub_issues` invoked at least once
- [ ] Single PR created (not 9)
- [ ] State gate hook does NOT block any of the 9 child transitions
- [ ] `## Pull Request` comment posted on parent issue (children may or may not get the comment per orchestrator preference)

---

## Scenario C: Multi-repo PR set with cross-references

### Input

An "In Progress" cross-repo issue with the following shape:

- **Title**: "Add cross-repo issue dependency tracking"
- **Estimate**: S
- **Cross-repo scope**: 2 repos (ralph-hero + landcrawler-ai), per `.ralph-repos.yml` registry.
- **Worktrees**: Both `~/projects/ralph-hero/worktrees/GH-NNN` and `~/projects/landcrawler-ai/worktrees/GH-NNN` exist, both with commits ready to push, both on branch `feature/GH-NNN`.
- **Plan document**: A single plan doc in `ralph-hero` covering both repos.
- **Dependency direction**: ralph-hero changes are upstream (must merge first); landcrawler-ai depends on the upstream.

### Expected Behavior

1. Skill detects multi-repo scope from the registry (`.ralph-repos.yml`) and from the presence of multiple worktrees (Step 3a).
2. Skill creates one PR per repo:
   - Push branch in each worktree.
   - Build PR body for each repo with: `## Summary` (per-repo), `## Plan` (link to plan doc — resolved against the appropriate `owner/repo` per the Link Formatting cross-repo rule), `## Test plan`, `## Cross-Repo Context` section, `Closes #NNN` (target repo only).
3. Skill cross-references the PRs: edits each PR body after creation to include a link to the other PR with merge-order metadata (`upstream`/`downstream`).
4. Skill advances the issue in the primary repo (and any per-repo issue records) to "In Review" via `save_issue`.
5. Skill posts a `## Pull Request` comment listing both PR URLs and the recommended merge order.

### Assertions

- [ ] Two PRs created — one in each repo (`gh pr list --repo {owner}/{repo}` lists each)
- [ ] Each PR body contains a `## Cross-Repo Context` section naming the other PR
- [ ] Cross-references include explicit merge-order labels (`merge first` / `merge after`)
- [ ] `## Plan` section URL uses the correct `owner/repo` for the plan doc's home repo (Link Formatting cross-repo rule)
- [ ] No PR body hardcodes `$RALPH_GH_OWNER/$RALPH_GH_REPO` for files in the other repo
- [ ] Issue workflow state advanced to "In Review"
- [ ] `## Pull Request` comment lists both URLs and the recommended merge order
- [ ] Stale `advance_issue` tool NOT invoked (Phase 4 audit removed it from allowed-tools)

---

## Grading Rubric

| Dimension | A (Standalone) | B (Group) | C (Multi-repo) |
|-----------|----------------|-----------|----------------|
| Sub-issue detection | Empty list | 9 children | Per-repo issues (separate from sub-issues) |
| PR body — Summary | Yes | Yes | Yes per repo |
| PR body — Plan link | Yes | Yes | Yes (with cross-repo URL resolution) |
| PR body — Test plan | Yes | Yes | Yes per repo |
| PR body — Phases shipped | Omitted | "9 of 9" | Optional per repo |
| PR body — Closes lines | 1 | 10 (parent + 9 children) | 1 per repo |
| Children advanced | N/A | All 9 | N/A (no children) |
| Parent advance | N/A (standalone is the "parent") | Not by pr | N/A |
| Cross-repo PRs | N/A | N/A | 2 PRs with cross-refs |
| Stale advance_issue | Not used | Not used | Not used |
| `## Pull Request` comment | Posted | Posted on parent | Posted with both URLs |

A run is graded **PASS** if all `[ ]` assertions for its scenario hold. **FAIL** otherwise.

## Anti-Patterns to Watch For

1. **Sparse PR body**: PR created with only `## Summary` and `Closes #NNN` (the pre-Phase-4 template). The enriched template MUST include `## Plan`, `## Test plan`, and (for groups) `Phases shipped`.
2. **Stale advance_issue invocation**: Skill body or agent attempts `advance_issue(...)` instead of `save_issue(workflowState=..., command="ralph_pr")`. Phase 4 removed `advance_issue` from `allowed-tools` — runtime allowlist should reject the call.
3. **Group misrouted as standalone**: Skill skips `list_sub_issues` and only closes the parent issue, leaving 9 children stuck in "In Progress".
4. **Cross-repo URL hardcoded**: PR body contains a link to a file in repo B but uses repo A's owner/name, producing a 404.
5. **Silent gh pr create failure**: `gh pr create` returns malformed output (no URL on stdout) and skill continues anyway. Should report and stop.
