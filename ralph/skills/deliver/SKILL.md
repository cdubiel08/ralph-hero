---
description: Shepherd In Review PRs from open to merged — one pass over the deliver queue. Reacts to concluded checks, review deltas, stale attestations, and merge-gate PENDING verdicts; maintains branch topology; demotes semantic rework; closes out items whose PRs already merged. Mechanical remediation only — never authors feature semantics. Triggers on "deliver", "shepherd the review queue", "work the In Review items", "chase the open PRs".
argument-hint: "[<issue-number> | (empty = take the deliver queue's next)]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# /ralph:deliver — follow-through, not authorship

One pass over the deliver lane: the In Review items whose open PRs have an actionable signal. `/ralph:work` runs the gates once at PR-up (its rule 7); this lane owns everything rule 7 deliberately does not — the follow-through after that session exited (gates pending, a review that landed later, an attestation unbound by a later push, a merged PR whose issue never closed). You remediate mechanically and merge through the host repo's own gate; you never author feature semantics.

The board CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder resolves to wherever this plugin is installed; never substitute a repo-relative path. Below, `board` is shorthand for it.

## One pass

`board deliver-queue --json` picks the work: take `next` (or the argument's issue if given — it must be in the queue). Empty `next` ⇒ nothing to do: write the exit report and stop. Handle ONE item per pass, end to end, then exit at a surfaced state. You are a single-pass operator: whatever invoked you decides whether and when another pass happens — never arrange one yourself, and never wait around for state to change.

Inherited from /ralph:work, verbatim: board truthful at all times; exit only at surfaced states; findings outlive the transcript; decisions journaled via `board comment`; gates are run, not predicted; scope is the selected item.

## The gate decides — you react to its token

Merge exclusively through the host repo's own gate: `bash scripts/merge-pr.sh PR` where the repo ships it (**never `--force` — contract rule**: any situation that seems to need it is Human Needed with the gate output quoted). Map outcomes on the machine-parseable `MERGE GATE <verdict> — <gate>` token, never the bare exit code:

- **PENDING** (exit 75) — evidence not in yet. Leave In Review, journal, exit. Not a failure.
- **FAIL — state** — re-read reality: the PR is usually already merged (native auto-merge, or a prior run). Treat per the post-merge rule below; anything else → Human Needed.
- **FAIL — mergeable** — CONFLICTING → rebase onto main, resolve preserving both sides' stated intent, push, exit at In Review (quiescence restarts the clock). UNKNOWN → wait, exit at In Review; never rebase or push on mere uncertainty.
- **FAIL — checks** — remediate mechanically: re-run flakes, fix lint/format. A genuinely failing test at unchanged semantics is a rework signal → demotion.
- **FAIL — review** (CHANGES_REQUESTED) — rework demotion.
- **FAIL — attestation** — re-run the attested commands at the current head via `scripts/attest-pr.sh PR --run "<cmd>" --carry-review` — **contract rules: re-attestation only ever through `--run` (observed exit codes, never caller-typed), and the review verdict only ever carried forward, never authored or retyped**. Commands fail → demotion. Refusals key on their tokens, never the shared exit code: `ATTESTATION REFUSED — head moved` is not a test failure (re-check quiescence, retry once, else exit at In Review); `ATTESTATION REFUSED — no prior review` → Human Needed, never a fresh self-approval.
- Any unclassified FAIL → Human Needed with the gate output quoted.

Reviewer nudges take the shape the merge policy declares. When
`external_review.head_marker` is absent, the reviewer files formal APPROVED
reviews and the nudge is just the policy's `external_review.trigger` — do not
invent a marker it never reads. When the policy declares both `head_marker` and
`clean_comment_marker` (comment-evidence mode, which is what this repo runs),
the nudge is an exact two-line comment: the trigger, then
`<!-- <head_marker>: <full-head-sha> -->` using the current 40-character head
SHA. With the current policy, the body is:

```text
@codex review
<!-- ralph-review-head: <full-head-sha> -->
```

Post that body at most once per head SHA; never substitute another reviewer's
trigger. Read rate-limiting from the reviewer's check *description*, never its
state. Thread replies are evidence-only — commit link, line link, test output
link; anything argumentative is a rework signal, not a reply.

## Close-out, demotion, safety rails

- **`no-open-pr` rows**: verify at least one linked PR actually MERGED, then `board move NNN done` (a closing-reference merged PR satisfies the Done-evidence guard; a convention-linked one needs `--why` naming the merged PR). A linked PR closed *unmerged* → Human Needed with the finding. This lane is the only thing that un-strands these. **Apply units are different by design**: on an apply-labeled item the close gate refuses Done without `ralph-apply-evidence:v1` — that refusal means the deploy, not the merge, is the outcome; leave it open (or escalate), never route around the gate.
- **Post-merge state writes yield to reconcile — contract rule.** After a successful merge (or FAIL — state on an already-merged PR), re-read the issue: already Done/Canceled means the event lane won — journal and exit. Only `board move NNN done` when the issue did not auto-close, and treat a refusal (lost race) as success after re-read.
- **Rework demotion**: post ONE findings comment enumerating every unresolved thread, then the legal two-hop — In Review → In Progress → Backlog (`RALPH_CLAIM_HOLDER=deliver@<host>` for the transient hop) — and release. Never self-fix semantics: any change a reviewer would call a design decision belongs to a work session.
- **Stack safety**: before merging a PR that is the base of another open PR, retarget the dependent first — GitHub *closes*, not retargets, dependents on base-branch deletion.
- **Pre-push quiescence re-check**: immediately before any push (rebase, conflict fix, format), re-check the item is still quiescent (`board deliver-queue --json` — the item must not read `settling`); fresh activity aborts the push, exit at In Review.
- Host repos without `scripts/merge-pr.sh`: use the repo's native merge flow and branch protection; never import ralph-hero's policy.

## Exit — every pass, even an empty one

1. Update the item's marker so the selector can gate re-selection: PATCH (or post) the issue's `<!-- ralph-deliver:v1 -->` comment with fenced JSON, one entry per PR you touched (`at` = now; `verdict`/`gate` = the last gate token you observed; unknown cursors are `null`). Only sessions write this marker; the selector reads it. Example:

   ```json
   {"prs": {"1730": {"head_sha": "f47fa9a8c0ffee00", "verdict": "PENDING", "gate": "external-review", "check_conclusions": "board-tests=success,test-hooks=success", "review_cursor": "2026-08-09T03:10:00Z", "thread_cursor": null, "at": "2026-08-09T03:12:00Z"}}}
   ```

2. `mkdir -p "$RALPH_HOME"` (default `~/.ralph`) first, then append `<iso8601> deliver GH-<n> rc=<code> checked=<N> acted=<M>` to `$RALPH_HOME/deliver.outcomes.log` and touch `$RALPH_HOME/deliver.heartbeat` — surface a write failure rather than swallowing it; a lane always logging `checked=0` must be visibly dead, never silently green. An empty pass (no item selected) writes `GH-none` in the subject slot; the line still lands.
3. Report, as your final output: `checked`/`acted` counts, the blocked-reason set from the queue read, and the earliest `windowExpiresAt` among time-bounded rows (`settling`, `retry-window`, `deferred`). The lane's goal state — for whatever invoked you — is: empty `next` AND no time-bounded blocked rows; rows only a human can clear (`no-pr`, Human Needed) don't count against it.
