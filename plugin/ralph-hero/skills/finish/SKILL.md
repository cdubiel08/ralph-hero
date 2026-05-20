---
description: Validate, run code review, merge, and watch CI for a completed implementation. Owns the code review gate (preserves depth-0 fan-out for the code-review:code-review plugin); when RALPH_REVIEW_MODE=auto and code review flags issues, dispatches impl-agent to fix them then re-runs code review (max 1 fix cycle). Once review resolves, dispatches merge-agent for merge mechanics only.
user-invocable: true
argument-hint: <issue-number> [--pr-url url] [--plan-doc path]
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=finish RALPH_VALID_OUTPUT_STATES='Done,Human Needed'"
  PreToolUse:
    - matcher: "ralph_hero__save_issue|ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Skill
  - Agent
  - Monitor
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Review mode: !`echo ${RALPH_REVIEW_MODE:-interactive}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

# Ralph Finish

Validate, run code review, merge, and watch CI for a completed implementation. Finish owns the code review gate (so the `code-review:code-review` plugin's parallel-agent fan-out always runs at depth 0, depth-2 safe). When `RALPH_REVIEW_MODE=auto` and code review flags issues, finish dispatches impl-agent to fix them, then re-runs code review (max 1 fix cycle). Once review passes, finish dispatches `merge-agent` for merge mechanics only.

## Step 1: Parse Arguments

Extract issue number and optional flags from args:

```
args: "NNN"                                          -> issue_number=NNN, pr_url=nil, plan_doc=nil
args: "NNN --pr-url https://..."                     -> issue_number=NNN, pr_url=provided, plan_doc=nil
args: "NNN --plan-doc path/to/doc"                   -> issue_number=NNN, pr_url=nil, plan_doc=provided
args: "NNN --pr-url https://... --plan-doc path/doc" -> all three provided
```

Export: `export RALPH_TICKET_ID="GH-NNN"`

## Step 2: Fetch Issue & Find PR

Fetch the full issue details for issue NNN.

Verify the issue is in "In Review" state. If not, output:

```
FINISH BLOCKED
Issue: #NNN
Current state: [state]
Required state: In Review
```

And stop.

Find the PR:

1. If `--pr-url` was provided, extract the PR number from it.
2. Otherwise, search for the PR:

```bash
gh pr list --head feature/GH-NNN --json number,url,state --jq '.[0]'
```

If no PR found, output:

```
FINISH BLOCKED
Issue: #NNN
Reason: No pull request found for feature/GH-NNN
```

And stop.

Store PR_NUMBER and PR_URL for use in later steps.

## Step 3: Validate (dispatch val-agent)

Dispatch validation as an agent:

```
Agent(subagent_type="ralph-hero:val-agent", prompt="Validate GH-NNN. Plan doc: {plan_doc or 'discover from issue comments'}")
```

Check the agent output for the verdict:

- If output contains `VALIDATION PASS`: continue to Step 4.
- If output contains `VALIDATION FIX`: mechanical issues only (formatting, lint). Dispatch impl-agent to apply the listed fix commands in the worktree, commit, then re-run val-agent. Max 1 fix cycle — if it still fails after fixes, treat as FAIL.
- If output contains `VALIDATION FAIL`: stop with the validation report. Substantive failures require implementation work.

## Step 4: Code Review Gate

> **Why code review runs HERE (not inside ralph-merge):**
>
> The `code-review:code-review` plugin spawns 5 parallel Sonnet reviewers + N parallel Haiku scorers via the `Agent` tool. Those parallel agents land at depth 1 only when `code-review:code-review` itself is invoked from depth 0. By keeping the code review gate inline in finish (which runs at depth 0), we preserve the parallel-agent fan-out. If code review were dispatched from inside an agent context, the runtime's no-depth-2-Agent rule would silently break the parallel reviewers.

Read the initial verdict from the deterministic helper:

```bash
verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)
```

`case` on `$verdict`:

- **`APPROVED`**: formal review approval or self-authored clean pass — continue to Step 5.
- **`NEEDS_FIX`**: formal `CHANGES_REQUESTED` or self-authored code-review found issues — proceed to Step 4a.
- **`BLOCKED`**: multi-author repo with no formal review decision and no self-authored fallback. Branch on `RALPH_REVIEW_MODE`:
  - **`auto`** (`RALPH_REVIEW_MODE=auto`): run code review inline — do NOT prompt the user:
    ```
    Skill("code-review:code-review", "PR_NUMBER")
    ```
    The `code-review:code-review` skill runs inline at depth 0; its parallel reviewer agents land at depth 1 (legal). After the review skill completes, re-read the verdict:
    ```bash
    verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)
    ```
    `case` on the new `$verdict` using the same four arms above.
  - **`interactive`** (`RALPH_REVIEW_MODE=interactive`, default): present a choice:

    !cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/ask-user-question.md

    ```
    AskUserQuestion(
      questions=[{
        "question": "This PR has no code review yet. Would you like to run one before merging?",
        "header": "Code Review",
        "options": [
          {"label": "Run code review", "description": "Invoke /code-review:code-review on PR #PR_NUMBER before merging"},
          {"label": "Merge without review", "description": "Skip code review and proceed to merge"}
        ],
        "multiSelect": false
      }]
    )
    ```

    - If user selects **"Run code review"**: invoke `Skill("code-review:code-review", "PR_NUMBER")`. After it completes, re-read the verdict:
      ```bash
      verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)
      ```
      `case` on the new `$verdict` using the same four arms above.
    - If user selects **"Merge without review"**: continue to Step 5.
    - If user selects **"Other"**: stop.

  If the `code-review:code-review` skill is NOT installed:

  ```
  This PR has no code review. Consider installing the code-review plugin:
    claude plugins install @anthropic/code-review
  ```

  Then present:

  ```
  AskUserQuestion(
    questions=[{
      "question": "Proceed without code review?",
      "header": "No Code Review Plugin",
      "options": [
        {"label": "Merge without review", "description": "Skip code review and proceed to merge"},
        {"label": "Stop", "description": "Stop here — install the code-review plugin first"}
      ],
      "multiSelect": false
    }]
  )
  ```

  - If user selects **"Merge without review"**: continue to Step 5.
  - If user selects **"Stop"** or **"Other"**: stop.

- **`ERROR: *`**: transient `gh` failure. Retry once:
  ```bash
  verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)
  ```
  If still `ERROR: *`: output `FINISH BLOCKED` with the error message and stop.

## Step 4a: Code Review Fix Cycle

Triggered when Step 4 verdict is `NEEDS_FIX`.

Dispatch impl-agent in Address Mode to fix the flagged issues. The issue is already "In Review" with an open PR that has review comments — impl-agent will auto-detect Address Mode.

```
Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for GH-NNN. The automated code review flagged issues on PR #PR_NUMBER. Fix the MUST_FIX and SHOULD_FIX items, push, and reply to comments.")
```

After impl-agent completes, re-run code review once:

```
Skill("code-review:code-review", "PR_NUMBER")
```

Then re-read the verdict via the helper:

```bash
verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)
```

- If `APPROVED`: continue to Step 5.
- If `NEEDS_FIX` again: stop. Max 1 fix cycle. Output:

```
FINISH BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Code review feedback unresolved after 1 fix cycle.
```

- If `BLOCKED` or `ERROR: *`: stop with `FINISH BLOCKED` and `Reason: Code review feedback unresolved after 1 fix cycle`.

## Step 5: Merge (dispatch ralph-merge)

Code review has resolved (approved, skipped by user, or no skill available). Dispatch the merge-agent (forked, isolated 200k context) for merge mechanics only — always pass the PR URL to avoid redundant lookup:

```
Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR for GH-NNN. PR URL: PR_URL", description="Merge GH-NNN")
```

Dispatching via Agent() forks ralph-merge into an isolated 200k haiku context. The parent session (Opus 4.7 / Sonnet 4.6 / 1M) is not compacted. See [GH-1265](https://github.com/cdubiel08/ralph-hero/issues/1265).

ralph-merge is now a leaf skill: it handles PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment. It does NOT run code review (that's owned by Step 4 above).

Check the skill output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 6.

## Step 6: CI Watch

After merge completes, watch CI checks on the merge commit.

CI watch uses the `Monitor` tool — a streaming-notification primitive — rather than a 30-second polling loop. The Monitor runs a background poll script whose stdout lines arrive as conversation notifications **only when the run summary changes** (state transitions only, not every poll cycle). The agent does not burn a tool turn per poll; the underlying `sleep 30` lives inside the Monitor script. A `timeout_ms=600000` (10 minutes) safety net kills the script if CI never reaches a terminal state.

First, capture the merge SHA:

```bash
MERGE_SHA=$(gh pr view PR_NUMBER --json mergeCommit --jq '.mergeCommit.oid')
```

Then invoke Monitor with the poll script. The script emits a one-line summary on each state transition, and a final terminal verdict line (`CI PASSED:`, `CI FAILED:`, or `CI SKIPPED:`) immediately before exiting. Use `printf '%s\n'` (not `echo`) so newlines are deterministic, and guard every `gh`/`jq` invocation with `2>/dev/null || ...` so transient API failures don't kill the loop. **Substitute the literal merge SHA into the `command` string before invoking Monitor** — Monitor runs the command in its own subshell and does not inherit shell-local variables from prior Bash calls; the `$MERGE_SHA` placeholder below is illustrative and must be replaced with the actual SHA captured above:

```
Monitor(
  command='last_status=""
while true; do
  current=$(gh run list --commit "$MERGE_SHA" --json status,conclusion,name --limit 10 2>/dev/null || echo "[]")
  count=$(printf "%s" "$current" | jq -r "length" 2>/dev/null || echo "0")
  if [ "$count" = "0" ]; then
    printf "%s\n" "CI SKIPPED: no runs found for $MERGE_SHA"
    exit 0
  fi
  summary=$(printf "%s" "$current" | jq -r "[.[] | \"\\(.name): \\(.status)/\\(.conclusion)\"] | join(\", \")" 2>/dev/null || echo "")
  if [ "$summary" != "$last_status" ]; then
    printf "%s\n" "$summary"
    last_status="$summary"
  fi
  if printf "%s" "$current" | jq -e "length > 0 and all(.status == \"completed\")" >/dev/null 2>&1; then
    if printf "%s" "$current" | jq -e "all(.conclusion == \"success\")" >/dev/null 2>&1; then
      printf "%s\n" "CI PASSED: all runs succeeded"
    else
      failed=$(printf "%s" "$current" | jq -r "[.[] | select(.conclusion != \"success\") | \"\\(.name): \\(.conclusion)\"] | join(\", \")" 2>/dev/null || echo "unknown")
      printf "%s\n" "CI FAILED: $failed"
    fi
    exit 0
  fi
  sleep 30
done',
  description='CI watch for merge SHA',
  timeout_ms=600000
)
```

The script's contract:

1. Initialize `last_status=""`.
2. Loop forever (`while true`).
3. Fetch CI runs via `gh run list --commit "$MERGE_SHA" --json status,conclusion,name --limit 10` (stderr suppressed, fallback to `[]`).
4. **Empty array** (`length == 0`): print `CI SKIPPED: no runs found for $MERGE_SHA` and `exit 0` immediately — no looping forever when no CI is configured.
5. Compute a one-line `summary` via `jq -r` of `name: status/conclusion` per run, joined with `, `.
6. Print `summary` via `printf '%s\n'` only when it differs from `last_status` (then update `last_status`).
7. Check terminal state: `length > 0 and all(.status == "completed")`. (Using `status == "completed"` rather than `.conclusion != null` is intentional — `gh run list --json status,conclusion` returns `conclusion: ""` (empty string) for in-progress runs, not `null`, so a `.conclusion != null` predicate falsely matches in-flight runs.)
8. Terminal: print `CI PASSED: all runs succeeded` (all `conclusion == "success"`) **or** `CI FAILED: <failed run names with conclusions>` (any non-success). The terminal verdict line is the LAST line emitted before `exit 0`.
9. Otherwise, `sleep 30` and re-loop.

The four terminal outcomes the agent sees:

| Outcome | Source signal |
|---------|---------------|
| `CI PASSED: ...`   | Last Monitor line begins with `CI PASSED:` (script exited 0 after all-success terminal). |
| `CI FAILED: ...`   | Last Monitor line begins with `CI FAILED:` (script exited 0 after any-failure terminal). |
| `CI SKIPPED: ...`  | Last Monitor line begins with `CI SKIPPED:` (script exited 0 immediately on empty array). |
| `CI PENDING`       | Monitor reached `timeout_ms` (10 minutes) without ever emitting a `CI PASSED:` / `CI FAILED:` / `CI SKIPPED:` line. (Monitor sends SIGTERM on timeout, so the script cannot reliably emit a final line itself — absence of a terminal-prefix line within 10 min IS the `PENDING` signal.) |

## Step 7: Report Final Status

Parse the LAST notification received from the Monitor (Step 6) as the CI verdict, mapping its prefix to one of `PASS`, `FAIL`, `SKIPPED`, or `PENDING`:

- `CI PASSED:` -> `PASS`
- `CI FAILED:` -> `FAIL` (also surface the failed run names from the Monitor line — they are included after the colon by the Step 6 script)
- `CI SKIPPED:` -> `SKIPPED`
- (Monitor reached `timeout_ms` with no terminal-prefix line emitted) -> `PENDING`

Then emit the report:

```
FINISHED
Issue: #NNN
PR: https://github.com/OWNER/REPO/pull/PR_NUMBER
Validation: PASS
Merge: Done
CI: [PASS / FAIL / PENDING (timeout) / SKIPPED (no runs)]
[If CI FAIL: links to failed runs]
```

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
