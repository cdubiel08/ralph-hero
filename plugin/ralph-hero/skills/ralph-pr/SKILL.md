---
description: Create a pull request for a completed implementation — pushes branch, creates PR via gh, moves issues to In Review. Use when you want to create a PR for a completed issue.
user-invocable: false
argument-hint: <issue-number> [--worktree path] [--push-drive | --no-push-drive]
context: fork
model: haiku
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=pr RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__save_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pr-state-gate.sh"
allowed-tools:
  - Read
  - Glob
  - Bash
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph PR

Create a pull request for a completed implementation and move issues to In Review.

## Step 1: Parse Arguments

Extract issue number and optional `--worktree` flag from args:

```
args: "NNN"                           -> issue_number=NNN, worktree=nil
args: "NNN --worktree path/to/dir"    -> issue_number=NNN, worktree=path
args: ""                              -> issue_number=nil, queue-pick (see below)
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

**If no issue number** is provided, run the queue-picking branch:

1. Query `list_issues(workflowState: "In Progress", limit: 10)` for candidates whose implementation has completed.
2. For each candidate (in returned order), check BOTH conditions:
   - `worktrees/GH-NNN` exists relative to the git root (`git rev-parse --show-toplevel`).
   - No open PR exists for the candidate's branch:
     ```bash
     gh pr list --head feature/GH-NNN --json number --jq '.[0]'
     ```
     A `null` (or empty) result means no PR exists yet — eligible.
3. The first candidate matching BOTH conditions is the selected issue.
4. If no candidate matches, output the literal line and STOP:

   ```
   Queue empty.
   ```

   This is the token the loop runner greps for to detect an empty PR queue (`grep -qiE "Queue empty|Triage complete"`).
5. Otherwise, set `issue_number` to the selected candidate and continue with Step 2 as if the number had been passed in as an argument.

This branch mirrors the queue-picking pattern in `ralph-impl/SKILL.md` Step 1 so the loop runner can invoke `just pr` argument-less.

## Step 2: Fetch Issue

Fetch the full issue details for issue NNN.

Get issue title, state, group context, and sub-issues.

## Step 3: Determine Worktree and Branch

If `--worktree` was provided, use that path directly.

Otherwise, check `worktrees/GH-NNN` relative to the git root.

For group issues (with sub-issues), use the primary issue number for the branch name.

Branch name: `feature/GH-NNN`

If no worktree exists, output an error and stop.

## Step 3a: Multi-Repo PR Detection

If the issue has cross-repo scope (multiple worktrees exist for this issue):

1. **Detect repos from worktrees:** Read `.ralph-repos.yml` from the repo root. For each repo with a `localDir`, check for worktrees:
   ```bash
   for repo_dir in {registry localDir paths}; do
     if [[ -d "$repo_dir/worktrees/GH-${ISSUE_NUMBER}" ]]; then
       echo "Found worktree in $(basename $repo_dir)"
     fi
   done
   ```

2. **Create one PR per repo:** For each repo with a worktree:
   ```bash
   cd {repo_localDir}/worktrees/GH-{issue_number}
   git push -u origin feature/GH-{issue_number}
   gh pr create --repo {owner}/{repo} \
     --title "GH-{issue_number}: {title}" \
     --body "$(cat <<'PREOF'
   ## Summary
   {summary for this repo}

   ## Cross-Repo Context
   This PR is part of GH-{issue_number}. Related PRs:
   - {other_repo} PR #{other_pr_number} ({upstream|downstream}, merge {first|after})

   Closes #{issue_number}
   PREOF
   )"
   ```

3. **Cross-reference PRs:** After creating all PRs, edit each PR body to include links to the other PRs. The merge order comes from the `dependency-flow` in the registry pattern.

**Single-repo (default):** If only one worktree exists, behavior is unchanged — continue to Step 4.

### Link Formatting in PR Bodies

When creating cross-repo PR bodies, resolve the correct owner/repo for each link:
- Links to files in the current repo: use the current repo's owner/name
- Links to files in other repos: look up the owner/name from the registry entry
- Links to related PRs: `https://github.com/{owner}/{repo}/pull/{number}`

## Step 4: Push Branch

From the worktree directory:

```bash
git push -u origin feature/GH-NNN
```

If push fails, report the error and stop.

## Step 5: Create Pull Request

Build the PR body using the enriched template below. The template reads the plan document (located via Artifact Comment Protocol — see Step 2 issue comments for `## Implementation Plan` link) so reviewers (human and the `code-review` skill) have full context.

### Step 5.0: Compose `## Summary` (optional delegation)

When delegation is enabled (`RALPH_DELEGATE_ENABLED=true`), the diff's stat-line view + the issue title + the plan's `## Overview` snippet are sent to a local LLM via the wrapper at `$CLAUDE_PLUGIN_ROOT/scripts/` (task name `pr_description`), which returns a 1-3-sentence summary. The skill substitutes the result into the `## Summary` section of the PR body heredoc below; everything else (`## Plan`, `## Test plan`, `Closes #NNN`, the `gh pr create` call) is composed natively. Delegation is opt-in (operator sets the env var); when off, the skill composes the summary natively as today.

**Delegation is for summary text only.** The `gh pr create` call in this step is composed and invoked natively in all cases — the delegate's output is text-in for the `## Summary` block and nothing else. Never let delegated text reach the `gh pr create` arguments outside the body heredoc. (See `skills/shared/delegation-conventions.md` for the eligibility matrix and the no-mutation rule.)

Operators may pin a different model for this task via `RALPH_DELEGATE_PR_DESCRIPTION_URL` / `RALPH_DELEGATE_PR_DESCRIPTION_MODEL`. The wrapper resolves per-task overrides without code changes here.

Run the following bash block. The control flow (`set +e`, `if OUTPUT=$(...)`, `case "$rc"`, unconditional `rm -f`) mirrors the reference pattern in `skills/delegate-test/SKILL.md` and F4a's `agents/codebase-locator.md` § "Candidate Ranking". The intentional deviations are (a) a **threshold-gate prelude** before the wrapper call (delegation fires only when ≥2 files OR ≥20 lines), (b) **byte-length + leading-character bash guards** on the wrapper output instead of `jq -e .ranked` (the response is plain prose, not JSON), and (c) `--max-tokens 256 --temperature 0.2` instead of `512 / 0.0` (matches the smaller summarize-task output budget).

```bash
# --- Inputs (set from the prior steps' context) ---
#   ISSUE_TITLE             — the fetched issue's title (from Step 2)
#   PLAN_OVERVIEW_SNIPPET   — first paragraph of the plan's ## Overview section
#                             (resolved via Artifact Comment Protocol; "" if no plan)
#   RECENT_COMMITS          — output of `git log --oneline -60 origin/main..HEAD`
#
# Output: SUMMARY_TEXT — a 1-3-sentence prose summary suitable for the
# ## Summary section of the PR body heredoc below.

# --- Threshold gate (Shared Constraint #10: >=2 files OR >=20 lines) ---
DIFF_STAT=$(git diff --stat origin/main..HEAD 2>/dev/null || echo "")
FILES_CHANGED=$(printf '%s\n' "$DIFF_STAT" | grep -cE '^ [^|]+ \|' || echo 0)
LINES_CHANGED=$(printf '%s\n' "$DIFF_STAT" \
    | grep -oE '[0-9]+ insertion|[0-9]+ deletion' \
    | grep -oE '^[0-9]+' \
    | awk '{s+=$1} END {print s+0}')

if [ "$FILES_CHANGED" -lt 2 ] && [ "$LINES_CHANGED" -lt 20 ]; then
    # Below threshold — compose natively, skip delegation entirely. No
    # tempfile is created and no wrapper is invoked, so no audit-log line is
    # written. SUMMARY_TEXT is a one-liner derived from the issue title.
    SUMMARY_TEXT="GH-NNN: ${ISSUE_TITLE}"
else
    # --- Threshold met — build prompt and try delegation ---
    PROMPT_FILE=$(mktemp -t pr-description-XXXXXX)
    cat > "$PROMPT_FILE" <<EOF
Summarize the following changes into 1-3 plain prose sentences.
No Markdown headings. No bullet lists. No code fences.

Issue: ${ISSUE_TITLE}
Plan overview: ${PLAN_OVERVIEW_SNIPPET}
Diff stat:
${DIFF_STAT}

Recent commits:
${RECENT_COMMITS}
EOF

    # 8 KB prompt size cap (Shared Constraint #9). If over, truncate the
    # Recent commits: block (least informative for summarization) first.
    # If still over after truncation, fall back to native.
    PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
    if [ "$PROMPT_BYTES" -gt 8192 ]; then
        # Re-render with truncated commits block.
        TRUNCATED_COMMITS=$(printf '%s' "$RECENT_COMMITS" | head -c 4096)
        cat > "$PROMPT_FILE" <<EOF
Summarize the following changes into 1-3 plain prose sentences.
No Markdown headings. No bullet lists. No code fences.

Issue: ${ISSUE_TITLE}
Plan overview: ${PLAN_OVERVIEW_SNIPPET}
Diff stat:
${DIFF_STAT}

Recent commits:
${TRUNCATED_COMMITS}
EOF
        PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
    fi

    if [ "$PROMPT_BYTES" -gt 8192 ]; then
        # Still oversized — fall back to native without invoking the wrapper.
        SUMMARY_TEXT="GH-NNN: ${ISSUE_TITLE}"
        rm -f "$PROMPT_FILE"
    else
        # Default native value — overwritten only if the delegate path
        # returns a shape-valid summary below.
        SUMMARY_TEXT="GH-NNN: ${ISSUE_TITLE}"

        set +e
        if OUTPUT=$("$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" \
                      --task pr_description \
                      --prompt-file "$PROMPT_FILE" \
                      --max-tokens 256 \
                      --temperature 0.2 2>/dev/null); then
            # Wrapper succeeded at HTTP. Validate shape with two bash guards:
            #   (1) byte length > 0 && < 1024 (1-3 sentences fit comfortably;
            #       larger means the model went off-script)
            #   (2) first character is NOT '#' (the delegate must not nest a
            #       Markdown heading inside the section the skill wraps)
            bytes=$(printf '%s' "$OUTPUT" | wc -c | tr -d ' ')
            first=$(printf '%s' "$OUTPUT" | head -c 1)
            if [ "$bytes" -gt 0 ] && [ "$bytes" -lt 1024 ] && [ "$first" != "#" ]; then
                SUMMARY_TEXT="$OUTPUT"
            else
                echo "delegation: fell back to native (rc=0, bad-shape)"
            fi
        else
            rc=$?
            case "$rc" in
                126) ;; # disabled — compose natively, no note printed
                127|124|1) echo "delegation: fell back to native (rc=$rc)" ;;
            esac
        fi
        set -e

        rm -f "$PROMPT_FILE"
    fi
fi
```

After this block, `SUMMARY_TEXT` holds either the delegate's 1-3-sentence prose (delegation path, shape-valid) or a native one-liner from the issue title (every other path: below-threshold, disabled, unreachable, timeout, bad-shape, oversized prompt). The substitution into the PR body heredoc below uses `--body-file` + `sed -i` to preserve the existing `<<'PREOF'` quoted-heredoc semantics.

### Step 5.1: Invoke `gh pr create`

```bash
BODY_FILE=$(mktemp -t pr-body-XXXXXX)
cat > "$BODY_FILE" <<'PREOF'
## Summary

[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview.]

## Plan

[Link to the implementation plan, e.g.: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/YYYY-MM-DD-GH-NNN-*.md]

Phases shipped: N of M (group issues only — omit for standalone)

## Test plan

- [ ] Automated verification per plan Success Criteria
- [ ] Manual verification per plan Success Criteria
- [ ] Cross-phase integration check (multi-phase plans only)

[Replace bullets with the actual checklist items from the plan's Success Criteria sections.]

Closes #NNN
[For group issues, add one Closes line per sub-issue:]
[Closes #NNN_child1]
[Closes #NNN_child2]
PREOF

# Substitute the ## Summary placeholder with the composed SUMMARY_TEXT. The
# heredoc above uses <<'PREOF' (quoted) so shell vars do NOT expand inside it;
# we use sed -i on the rendered file to inject the value without changing the
# quoted-heredoc semantics for the rest of the body.
sed -i.bak "s|\[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview\.\]|${SUMMARY_TEXT}|" "$BODY_FILE"
rm -f "$BODY_FILE.bak"

gh pr create \
  --title "GH-NNN: [issue title]" \
  --body-file "$BODY_FILE" \
  --head feature/GH-NNN \
  --base main

rm -f "$BODY_FILE"
```

For group issues, include `Closes #NNN` for each sub-issue in the body. Determine sub-issues via `list_sub_issues` (see Step 6).

Capture the PR URL from the output. If `gh pr create` returns malformed output (no URL on stdout), report the failure and stop — do not silently continue.

> **Follow-up**: The Link Formatting in PR Bodies subsection in Step 3a duplicates the Link Formatting table in ralph-merge and ralph-impl. Extraction to a shared fragment is tracked in #840 — do not extract here.

## Step 6: Move Issues to In Review

Determine whether the issue is **standalone** or **group** before advancing:

```
list_sub_issues(number=NNN)
```

- **Standalone** (no children): update the issue's own workflow state to "In Review" via `save_issue` with `command: "ralph_pr"`.
- **Group** (has children): advance every child returned by `list_sub_issues` to "In Review" via `save_issue`. Do NOT also advance the parent here — parent advancement is handled server-side by the `advance-parent` workflow when children reach the gate state.

## Step 6.5: Record Outcome Event

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/outcome-recorder.md

Call `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` with:
- `event_type`: `"pr_created"`
- `issue_number`: the issue number (NNN)
- `verdict`: `"created"`
- `payload`: `{ "pr_url": "<PR URL captured in Step 5>", "branch": "feature/GH-NNN", "repo": "<RALPH_GH_REPO>" }`

This step runs after Step 6 (Move Issues to In Review) completes on the success path.

If the MCP call fails, log to stderr (`echo "outcome-record failed: ..." >&2`) and continue to Step 7.

## Step 6.7: Drive Push (Feature H)

After the outcome event (Step 6.5), optionally push the PR body to Google Drive.

Parse `--push-drive` / `--no-push-drive` from the original arguments (forwarded unparsed to the helper — the helper performs centralized flag parsing).

```bash
# Drive push — Feature H (GH-1275)
# See: thoughts/shared/plans/2026-05-16-GH-1275-ios-remote-integration.md Phase 3
PR_BODY_TMP=$(mktemp -t "ralph-pr-${ISSUE_NUMBER}-body-XXXXXX.md")
# Write the PR body (same content as submitted to gh pr create) to the temp file
cat > "$PR_BODY_TMP" <<'BODYEOF'
[PR body content composed in Step 5 — substitute the actual rendered body here]
BODYEOF

DRIVE_URL=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/lib/push-artifact.sh" \
    "$PR_BODY_TMP" \
    "PR for GH-${ISSUE_NUMBER}" \
    ${PUSH_DRIVE_FLAG:+"$PUSH_DRIVE_FLAG"} 2>/dev/null || true)
rm -f "$PR_BODY_TMP"
```

Where `PUSH_DRIVE_FLAG` is `--push-drive`, `--no-push-drive`, or unset (if the user passed no flag — the helper then decides based on the sentinel / `RALPH_IOS_MODE`).

If `DRIVE_URL` is non-empty, append a `Drive: <URL>` line to the `## Pull Request` comment body composed in Step 7 BEFORE posting the comment. If `DRIVE_URL` is empty (skip or failure), the comment is posted unchanged — bit-identical to pre-Feature-H behavior.

`Bash` is already in ralph-pr's `allowed-tools`; no allowlist change needed.
## Step 6.8: Evaluate UI-Touching Heuristic

<!-- internal: this step is intentionally conservative — false negatives (UI PRs that slip
  through) are recoverable via manual `/scout` comment; false positives (backend PRs flagged)
  waste Scout-team budget and slow merges. Only flag when a changed file explicitly matches
  a frontend glob. -->

Fetch the list of changed files in the PR:

```bash
gh pr diff PR_NUMBER --name-only
```

The heuristic fires when ANY changed file matches one of the following patterns:
- `**/*.tsx`
- `**/*.svelte`
- `**/*.vue`
- `**/components/**`
- `**/*.css`
- `**/*.scss`
- `**/storybook/**`

**If zero files match**: skip this step entirely — no comment is posted, no error is raised.
The PR proceeds normally.

**If one or more files match**: post a `## Scout Trigger` comment on the PR. Failure of the
`gh pr comment` call is logged to stderr but does NOT block or fail the PR creation flow
(advisory, not blocking):

```bash
# Collect matched globs for the trigger comment
MATCHED_FILES=$(gh pr diff PR_NUMBER --name-only | grep -E '\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/' || true)

if [[ -n "$MATCHED_FILES" ]]; then
  gh pr comment PR_NUMBER --body "## Scout Trigger

/scout

This PR touches UI files — the Scout team has been queued to review.

**Matched files:**
\`\`\`
${MATCHED_FILES}
\`\`\`

**Why scouts?** See the Scout team voice and refusals: \`plugin/ralph-hero/skills/scouts/SOUL.md\`

Scouts will post a \`## Scout Report\` comment with a \`Verdict: GREEN\` or \`Verdict: RED\` result.
merge-agent will check for a green verdict before merging this PR." 2>/dev/null \
    || echo "[ralph-pr] WARNING: failed to post Scout Trigger comment (non-fatal)" >&2
fi
```

**Output contract:**

| Status | Meaning | Caller action |
|--------|---------|---------------|
| No comment posted | PR does not touch UI files — heuristic did not fire | None; proceed normally |
| `## Scout Trigger` posted | PR touches UI files — Scout team queued | merge-agent will gate on Scout Report |

## Step 7: Post Comment

Post a comment on the issue with the PR URL (include `Drive: <URL>` line if Step 6.7 returned a non-empty Drive URL):
```markdown
## Pull Request

PR created: [PR URL]

Issue moved to In Review.
```

## Step 8: Report Result

Output the PR URL for the caller:

```
PR CREATED
Issue: #NNN
PR: https://github.com/owner/repo/pull/NNN
State: In Review
```
