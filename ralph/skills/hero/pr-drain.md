# PR-Drain Mode

> Consulted by `/ralph:hero --mode pr-drain`. Defines PR classification rules, per-class actions, audit trail, and synth-issue threading.

## Classification (in priority order)

Date math is portable across macOS and Linux via Python 3 (no `date -d`, which is GNU-only):

```bash
DAYS_OLD=$(python3 -c "from datetime import datetime, timezone; print(int((datetime.now(timezone.utc) - datetime.fromisoformat('$updatedAt'.replace('Z','+00:00'))).total_seconds() / 86400))")
```

### Pre-classification guard — CI still running

Before classifying, check `PR_JSON.statusCheckRollup`. If any element has `conclusion` (or `state`) in `[PENDING, IN_PROGRESS, QUEUED]` AND no element is `FAILURE`/`ERROR`/`CANCELLED`, CI is still running. Exit the mode immediately without creating a synth issue, posting a comment, or applying the `pr-drained` label — the next routine fire will reclassify when CI reaches a terminal state. Emit:

```
result: PR #<N> CI still pending — will reclassify on next fire.
```

This is the only path that leaves the PR unlabeled on purpose. All terminal classifications below either apply `pr-drained` (success) or skip it intentionally (`needs-human`, `merge-failed`).

### Classification (CI is terminal — all checks have a non-pending conclusion)

1. **`dependabot-auto-merge` candidate** — all of:
   - `PR_JSON.author.login == "app/dependabot"`
   - Title parses as a patch or minor version bump. The Dependabot convention is `Bump <pkg> from X.Y.Z to A.B.C`. Compute the bump type:
     - `X != A` → major
     - `Y != B` → minor
     - otherwise → patch
     - Match only patch or minor.
   - Every `statusCheckRollup` element has `conclusion`/`state` in `[SUCCESS, SKIPPED, NEUTRAL]`. Any `FAILURE`/`ERROR`/`CANCELLED` → fall through to `dependabot-needs-review`.
2. **`dependabot-needs-review`** — `author == "app/dependabot"` AND any of: bump is major, title doesn't parse as a version bump, or any CI check failed/errored/cancelled. (PENDING is handled by the pre-classification guard.)
3. **`stale-close`** — `DAYS_OLD > 30`.
4. **`stale-ping`** — `DAYS_OLD > 14`.
5. **`needs-human`** — default.

## Per-class actions

### dependabot-auto-merge candidate

Run code review as the merge gate:

```
Skill("code-review:code-review", "<N>")
```

The code-review skill does NOT return a verdict directly — it posts a comment. Fetch the most recent code-review comment:

```bash
COMMENT=$(gh pr view <N> --comments --json comments --jq '.comments | map(select(.body | startswith("### Code review"))) | last.body // ""')
```

Verdict classification:

- Empty `COMMENT` → code-review opted out (Haiku eligibility agent treats Dependabot/automated PRs as not needing review). Trust signal → **GREEN**.
- Contains `No issues found` → **GREEN**.
- Contains `Found` and `issues:` → **MUST_FIX**.
- Otherwise → **review-error** (unparseable shape).

**If GREEN:**

```bash
gh pr merge <N> --squash --auto
MERGE_RC=$?
```

Set `FINAL_CLASS=dependabot-auto-merge`, `REVIEW_VERDICT=GREEN`. Carry `MERGE_RC` to the audit trail step.

**If MUST_FIX:**

Single-quoted heredoc (body is fully static):

```bash
gh pr comment <N> --body-file - <<'BODY_EOF'
## Code Review — MUST_FIX

/ralph:hero --mode pr-drain ran code-review:code-review as the auto-merge gate. Review flagged issues; holding for human review. See the code-review comment posted above for findings.
BODY_EOF
```

Set `FINAL_CLASS=dependabot-review-flagged`, `REVIEW_VERDICT=MUST_FIX`. Do NOT merge.

**If review-error:**

```bash
gh pr comment <N> --body-file - <<'BODY_EOF'
## Code Review — error

/ralph:hero --mode pr-drain tried to run code-review:code-review as the auto-merge gate but the verdict shape was not parseable. Holding for human review.
BODY_EOF
```

Set `FINAL_CLASS=review-error`, `REVIEW_VERDICT=n/a`. Do NOT merge.

### dependabot-needs-review

Run code review anyway (head start for the human), but do not merge:

```
Skill("code-review:code-review", "<N>")
```

Then post a routing comment pointing at the code-review findings:

```bash
gh pr comment <N> --body-file - <<'BODY_EOF'
## Major version bump — needs human review

/ralph:hero --mode pr-drain classified this as a Dependabot bump that needs human review (major bump, unparseable version, or non-passing CI). The code-review skill ran above; see its comment for findings.
BODY_EOF
```

Set `FINAL_CLASS=dependabot-needs-review`. Parse the code-review comment with the same logic as the auto-merge branch to capture `REVIEW_VERDICT` (`GREEN` / `MUST_FIX` / `n/a`). Informational — we don't merge either way.

### stale-close

```bash
gh pr close <N> --comment "Closing as stale: this PR has had no activity in 30+ days. Reopen if still relevant."
```

Set `FINAL_CLASS=stale-close`, `REVIEW_VERDICT=n/a`.

### stale-ping

Bind the author login first; use an unquoted heredoc so `${AUTHOR_LOGIN}` interpolates:

```bash
AUTHOR_LOGIN=$(printf '%s' "$PR_JSON" | jq -r '.author.login')
gh pr comment <N> --body-file - <<BODY_EOF
This PR has been open >14 days with no activity. @${AUTHOR_LOGIN} — is this still active? If not, /ralph:hero --mode pr-drain will close it in another ~16 days.
BODY_EOF
```

Set `FINAL_CLASS=stale-ping`, `REVIEW_VERDICT=n/a`.

### needs-human

Emit:

```
needs input: PR #<N> shape unrecognized by /ralph:hero --mode pr-drain — manual triage required. Author: <author>, headRef: <headRefName>, title: <title>.
```

Do NOT post audit comment and do NOT add the `pr-drained` label. Skip the audit step, proceed directly to synth advance (advance to Human Needed).

## Synthetic Ralph issue

Reuse-or-create one per PR. Listing first:

```
ralph_hero__list_issues({ label: "kind:pr-drain", state: "OPEN", limit: 50 })
```

Scan titles for `PR #<N>`. If match, set `SYNTH_NUMBER` and advance to In Progress (skip create). Otherwise create:

```
ralph_hero__create_issue({
  title: "Drain: PR #<N> — <PR title>",
  labels: ["pr-drain", "kind:pr-drain"],
  workflowState: "In Progress",
  body: "Auto-created by /ralph:hero --mode pr-drain.\n\nClassification: <CLASS>\nPR: <URL>\nAuthor: <login>\nHead ref: <ref>"
})
```

Threading invariant: synth issue created BEFORE PR mutation so a partial-completion failure leaves a queryable board artifact.

## Audit trail (non-`needs-human` classes only)

Determine success deterministically via the captured `MERGE_RC` (or equivalent for non-merge actions). If `MERGE_RC != 0` and stderr is not "already merged":

```bash
printf '## PR Drain — merge failed\n\n/ralph:hero --mode pr-drain attempted to act on this PR but the operation failed. Holding for human review.\n\nSynthetic issue: #%s\nClassification: %s\nError: %s\n' \
  "$SYNTH_NUMBER" "$CLASS" "$STDERR" | gh pr comment <N> --body-file -
```

Set `FINAL_CLASS=merge-failed`, advance synth to Human Needed, do NOT label `pr-drained`.

Otherwise, post success audit:

```bash
printf '## PR Drain\n\n/ralph:hero --mode pr-drain processed this PR.\n\n- Classification: %s\n- Synthetic issue: #%s\n- Review verdict: %s\n' \
  "$FINAL_CLASS" "$SYNTH_NUMBER" "$REVIEW_VERDICT" | gh pr comment <N> --body-file -
gh pr edit <N> --add-label pr-drained
```

## Synth advance + outcome record

Terminal-success classes (`dependabot-auto-merge`, `dependabot-needs-review`, `dependabot-review-flagged`, `review-error`, `stale-close`, `stale-ping`):

```
ralph_hero__save_issue({ number: SYNTH_NUMBER, workflowState: "Done" })
```

Terminal-handoff (`needs-human`, `merge-failed`):

```
ralph_hero__save_issue({ number: SYNTH_NUMBER, workflowState: "Human Needed" })
```

Record outcome:

```
knowledge_record_outcome({
  event_type: "pr_drain",
  issue_number: SYNTH_NUMBER,
  verdict: FINAL_CLASS,
  payload: { pr: <N>, review_verdict: REVIEW_VERDICT, author: <login> }
})
```

## Result marker

```
result: Drained PR #<N> (class: <FINAL_CLASS>, synthetic issue: #<SYNTH_NUMBER>)
```

## Constraints (preserved verbatim from source)

- MUST NOT add the `pr-drained` label until the Step-5 action has succeeded or been intentionally held (MUST_FIX / dependabot-needs-review). A failed merge MUST NOT be labeled drained — the next routine fire must retry.
- MUST exit early without labeling, commenting, or creating a synth issue when CI is still pending (any check `PENDING`/`IN_PROGRESS`/`QUEUED` AND no terminal failure).
- MUST create the synthetic issue BEFORE attempting any PR mutation.
- Code review verdict is the merge gate — never bypass it for auto-merge candidates, even if CI is green.
- Reuse the synthetic issue — do not create duplicates if the routine fires twice for the same PR before the first run completes.
- Verdict detection is deterministic — parse the most recent `### Code review` comment. Empty comment (opt-out) is treated as GREEN.
