---
description: Drain a pull request that Director cannot dispatch (typically Dependabot bumps or stale unlinked PRs). Classifies the PR, runs code-review as the merge gate for auto-merge candidates, acts (merge/comment/close), and threads a synthetic Ralph issue through the board for observability. Invoked by the pr-drain cloud Routine on pull_request events; also user-invocable locally.
argument-hint: "--pr <PR-NUMBER>"
user-invocable: true
model: sonnet
context: inline
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=pr-drain"
allowed-tools:
  - Read
  - Bash
  - Skill
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

# Ralph PR-Drain

Drain a pull request that Director cannot dispatch. Typically invoked by the cloud `pr-drain` Routine on a `pull_request` event, or manually for one-off cases.

This skill is the operator for the pr-drain pipeline. It classifies a PR, gates auto-merge candidates through `code-review:code-review`, acts on the PR, and threads a synthetic Ralph issue through the project board so the pipeline dashboard, snapshots, dream loop, and cos summaries all see the work.

## Workflow

### Step 1: Parse arguments and idempotency check

Parse `$ARGUMENTS` for `--pr <N>`. If `--pr` is missing or `<N>` is not a positive integer, emit:

```
needs input: --pr <PR-NUMBER> is required.
```

and STOP.

Then check whether the PR has already been drained:

```bash
gh pr view <N> --json labels --jq '.labels[].name' | grep -q "^pr-drained$" && echo "ALREADY_DRAINED"
```

If `ALREADY_DRAINED` is printed, emit:

```
result: PR #<N> already drained. Skipping.
```

and STOP.

### Step 2: Fetch the PR

```bash
gh pr view <N> --json number,url,title,author,statusCheckRollup,mergeable,headRefName,createdAt,updatedAt,body,state,mergedAt
```

If `gh pr view` exits non-zero (PR does not exist, repo access denied, etc.), emit:

```
result: PR #<N> no longer accessible. Skipping.
```

and STOP.

If `state` is `MERGED` or `CLOSED`, emit:

```
result: PR #<N> already in terminal state (<state>). Skipping.
```

and STOP.

Store the parsed JSON as `PR_JSON` for the remaining steps.

### Step 3: Classify

Apply these rules in priority order. First match wins. Store the result as `CLASS`.

Date math is portable across macOS and Linux via a Python 3 one-liner (no `date -d`, which is GNU-only):

```bash
DAYS_OLD=$(python3 -c "from datetime import datetime, timezone; print(int((datetime.now(timezone.utc) - datetime.fromisoformat('$updatedAt'.replace('Z','+00:00'))).total_seconds() / 86400))")
```

1. **`dependabot-auto-merge` candidate** — all of:
   - `PR_JSON.author.login == "app/dependabot"`
   - Title parses as a patch or minor version bump. The Dependabot convention is `Bump <pkg> from X.Y.Z to A.B.C`. Compute the bump type by comparing `X.Y.Z` and `A.B.C`:
     - If `X != A` → major
     - Else if `Y != B` → minor
     - Else → patch
     - Match only if the bump type is patch or minor.
   - Every element of `PR_JSON.statusCheckRollup` has `conclusion` (or `state` — the JSON shape varies, check both) in `[SUCCESS, SKIPPED, NEUTRAL]`. If any element is `PENDING` or `IN_PROGRESS` → not yet ready, fall through to `dependabot-needs-review`. If any element is `FAILURE`, `ERROR`, or `CANCELLED` → also fall through to `dependabot-needs-review`.
2. **`dependabot-needs-review`** — `author == "app/dependabot"` AND any of: bump is major, title doesn't parse as a version bump, or any CI check is non-passing per rule 1.
3. **`stale-close`** — `DAYS_OLD > 30` (using the Python snippet above; threshold 30 days since `updatedAt`).
4. **`stale-ping`** — `DAYS_OLD > 14` (same snippet; threshold 14 days since `updatedAt`).
5. **`needs-human`** — default.

### Step 4: Create-or-reuse the synthetic Ralph issue

First, check for an existing synthetic issue for this PR:

```
ralph_hero__list_issues({ label: "kind:pr-drain", state: "OPEN", limit: 50 })
```

Scan returned issue titles for the substring `PR #<N>`. If a match is found, set `SYNTH_NUMBER` to its issue number. If its `workflowState` is not already `In Progress`, advance it:

```
ralph_hero__save_issue({ number: SYNTH_NUMBER, workflowState: "In Progress" })
```

Otherwise leave it alone, then skip to Step 5.

If no match is found, create a new issue already in `In Progress` (single call — `create_issue` accepts `workflowState` directly, no separate save_issue needed):

```
ralph_hero__create_issue({
  title: "Drain: PR #<N> — <PR_JSON.title>",
  labels: ["pr-drain", "kind:pr-drain"],
  workflowState: "In Progress",
  body: "Auto-created by ralph-pr-drain.\n\nClassification: <CLASS>\nPR: <PR_JSON.url>\nAuthor: <PR_JSON.author.login>\nHead ref: <PR_JSON.headRefName>"
})
```

Capture the returned issue number as `SYNTH_NUMBER`.

### Step 5: Act per CLASS

#### `dependabot-auto-merge` candidate

Run code review as the merge gate:

```
Skill("code-review:code-review", "<N>")
```

The code-review skill does NOT return a verdict to the caller — it posts a comment on the PR. After the skill completes, fetch the most recent code-review comment to detect the verdict:

```bash
COMMENT=$(gh pr view <N> --comments --json comments --jq '.comments | map(select(.body | startswith("### Code review"))) | last.body // ""')
```

Classify the verdict:

- **`COMMENT` is empty** → code-review opted out (its Haiku eligibility agent treats Dependabot/automated PRs as not needing review). We trust that signal and proceed to merge. Treat as **GREEN**.
- **`COMMENT` contains `No issues found`** → **GREEN**.
- **`COMMENT` contains `Found` and `issues:`** → **MUST_FIX**.
- **Otherwise** → **review-error** (unparseable shape).

**If GREEN:**

```bash
gh pr merge <N> --squash --auto
MERGE_RC=$?
```

Set `FINAL_CLASS = "dependabot-auto-merge"`. Set `REVIEW_VERDICT = "GREEN"`. Carry `MERGE_RC` to Step 6.

**If MUST_FIX:**

Use a single-quoted heredoc to suppress shell interpolation (the body is fully static here):

```bash
gh pr comment <N> --body-file - <<'BODY_EOF'
## Code Review — MUST_FIX

ralph-pr-drain ran code-review:code-review as the auto-merge gate. Review flagged issues; holding for human review. See the code-review comment posted above for findings.
BODY_EOF
```

Set `FINAL_CLASS = "dependabot-review-flagged"`. Set `REVIEW_VERDICT = "MUST_FIX"`. Do NOT merge.

**If review-error:**

```bash
gh pr comment <N> --body-file - <<'BODY_EOF'
## Code Review — error

ralph-pr-drain tried to run code-review:code-review as the auto-merge gate but the verdict shape was not parseable. Holding for human review.
BODY_EOF
```

Set `FINAL_CLASS = "review-error"`. Set `REVIEW_VERDICT = "n/a"`. Do NOT merge.

#### `dependabot-needs-review`

Run code review anyway to give the human a head start, but do not merge:

```
Skill("code-review:code-review", "<N>")
```

Then post a routing comment (the code-review skill has already posted its findings — or opted out — as a separate comment, so we just point at it):

```bash
gh pr comment <N> --body-file - <<'BODY_EOF'
## Major version bump — needs human review

ralph-pr-drain classified this as a Dependabot bump that needs human review (major bump, unparseable version, or non-passing CI). The code-review skill ran above; see its comment for findings.
BODY_EOF
```

Set `FINAL_CLASS = "dependabot-needs-review"`. Parse the code-review comment with the same logic as the auto-merge branch to capture `REVIEW_VERDICT` (`GREEN`, `MUST_FIX`, or `n/a`). The verdict is informational only — we don't merge either way.

#### `stale-close`

```bash
gh pr close <N> --comment "Closing as stale: this PR has had no activity in 30+ days. Reopen if still relevant."
```

Set `FINAL_CLASS = "stale-close"`. Set `REVIEW_VERDICT = "n/a"`.

#### `stale-ping`

Bind the author login first, then use an unquoted heredoc so `${AUTHOR_LOGIN}` interpolates:

```bash
AUTHOR_LOGIN=$(printf '%s' "$PR_JSON" | jq -r '.author.login')
gh pr comment <N> --body-file - <<BODY_EOF
This PR has been open >14 days with no activity. @${AUTHOR_LOGIN} — is this still active? If not, ralph-pr-drain will close it in another ~16 days.
BODY_EOF
```

Set `FINAL_CLASS = "stale-ping"`. Set `REVIEW_VERDICT = "n/a"`.

#### `needs-human`

Emit:

```
needs input: PR #<N> shape unrecognized by ralph-pr-drain — manual triage required. Author: <author>, headRef: <headRefName>, title: <title>.
```

Do NOT post an audit comment, do NOT add the `pr-drained` label, do NOT advance the synth issue. Instead set `FINAL_CLASS = "needs-human"` and skip directly to Step 7 (where the synth advances to Human Needed rather than Done).

### Step 6: Audit trail on the PR

Only run this step for non-`needs-human` classes.

Determine action success deterministically by capturing the exit code of the Step 5 action immediately after it runs (e.g. `gh pr merge <N> --squash --auto; MERGE_RC=$?`). If `MERGE_RC` is non-zero (and the failure is not "already merged" — distinguish via stderr inspection), the action failed. Build the failure body with printf so `SYNTH_NUMBER`, `CLASS`, and the captured stderr interpolate safely:

```bash
printf '## PR Drain — merge failed\n\nralph-pr-drain attempted to act on this PR but the operation failed. Holding for human review.\n\nSynthetic issue: #%s\nClassification: %s\nError: %s\n' \
  "$SYNTH_NUMBER" "$CLASS" "$STDERR" | gh pr comment <N> --body-file -
```

Set `FINAL_CLASS = "merge-failed"` and proceed to Step 7 (advance synth to Human Needed). Do NOT add the `pr-drained` label.

Otherwise, post the success audit comment:

```bash
printf '## PR Drain\n\nralph-pr-drain processed this PR.\n\n- Classification: %s\n- Synthetic issue: #%s\n- Review verdict: %s\n' \
  "$FINAL_CLASS" "$SYNTH_NUMBER" "$REVIEW_VERDICT" | gh pr comment <N> --body-file -
```

Then add the idempotency label:

```bash
gh pr edit <N> --add-label pr-drained
```

### Step 7: Advance synth issue and record outcome

For terminal-success classes (`dependabot-auto-merge`, `dependabot-needs-review`, `dependabot-review-flagged`, `review-error`, `stale-close`, `stale-ping`):

```
ralph_hero__save_issue({ number: SYNTH_NUMBER, workflowState: "Done" })
```

For terminal-handoff classes (`needs-human`, `merge-failed`):

```
ralph_hero__save_issue({ number: SYNTH_NUMBER, workflowState: "Human Needed" })
```

Then record the outcome using the real schema (`event_type`, `issue_number`, `verdict`, `payload` — verified in `plugin/ralph-knowledge/src/index.ts`):

```
mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome({
  event_type: "pr_drain",
  issue_number: SYNTH_NUMBER,
  verdict: FINAL_CLASS,
  payload: {
    pr: <N>,
    review_verdict: REVIEW_VERDICT,
    author: <PR_JSON.author.login>
  }
})
```

### Step 8: Emit result marker

```
result: Drained PR #<N> (class: <FINAL_CLASS>, synthetic issue: #<SYNTH_NUMBER>)
```

## Constraints

- ralph-pr-drain MUST NOT add the `pr-drained` label until the action attempted in Step 5 has either succeeded or been intentionally held (MUST_FIX / dependabot-needs-review). A failed merge must NOT be labeled drained — the next routine fire must retry.
- ralph-pr-drain MUST create the synthetic issue BEFORE attempting any PR mutation, so even a partial-completion failure leaves a queryable board artifact.
- Code review verdict is the merge gate — never bypass it for auto-merge candidates, even if CI is green.
- Reuse the synthetic issue (Step 4 list_issues check) — do not create duplicates if the routine fires twice for the same PR before the first run completes.
- Verdict detection is deterministic: parse the most recent `### Code review` comment posted on the PR by the code-review skill. An empty comment (opt-out) is treated as GREEN.

## Why this design

- **Synthetic issue threads PR work through the existing state machine** so the pipeline dashboard, snapshots, velocity metrics, dream loop, and cos summaries all see the work. No shadow channel.
- **Code review as the merge gate** mirrors `finish` — catches supply-chain attacks and behavior-changing patch bumps that CI-green doesn't.
- **Three-layer idempotency** (PR label, synth-issue reuse, `gh pr merge --auto`) prevents duplicate work even under race conditions or routine re-fires.
- **Out-of-band of Director** keeps Director a pure single-event dispatcher; pr-drain is its own loop.

## See also

- Design spec: [`thoughts/shared/research/2026-05-22-pr-drain-routine-design.md`](../../../../thoughts/shared/research/2026-05-22-pr-drain-routine-design.md)
- The cloud Routine that fires this skill: configured in `claude.ai/code/routines` (not in this repo)
- Reference for the code-review-as-merge-gate pattern: `plugin/ralph-hero/skills/finish/SKILL.md`
- Why Director never sees these PRs: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (filter at line ~895)
