# Copilot code review: measured evidence shapes (GH-2087)

Date: 2026-08-19. Method: live API captures from the public corpus — GitHub's
search reports **4,948,979** public PRs with `reviewed-by:
copilot-pull-request-reviewer[bot]` — sampled across ~35 PRs / 31 review
objects from unrelated repos (microsoft/vscode, besu-eth/besu,
firedancer-io/firedancer, getlantern/radiance, dutchdronesquad/trackdraw,
and ~25 smaller ones). The issue assumed the measurement needed a throwaway
PR on a Copilot-entitled repo; the artifacts turned out to be public, which
made the sample far larger than two heads would have been. What a private
pass would still add is noted at the end.

Every claim below is an observation, not a doc citation. The predicate in
`scripts/copilot-review-evidence.sh` is written from exactly these.

## 1. Request path

- The **requestable login is `Copilot`** — a timeline `review_requested`
  event records `requested_reviewer.login: "Copilot"` (microsoft/vscode
  #331735). Reviews are then **filed by** `copilot-pull-request-reviewer[bot]`
  (REST `user.login`) / `copilot-pull-request-reviewer` (GraphQL
  `author.login` — the `[bot]` strip, same asymmetry GH-2048 measured for
  dependabot; `me_norm` bridges it).
- **A request on an unentitled repo fails silently**: `POST
  …/requested_reviewers` with either login returns HTTP 200 with the full PR
  object, and nothing is recorded — `requested_reviewers` stays empty, no
  timeline event. Verified twice on this repo (no Copilot seat). Any tooling
  that requests a Copilot review must read the request back, the same
  read-back-verify shape `board claim` uses.
- A review request is **PR-level, not head-bound**. The binding that matters
  is on the answer: every review object carries `commit_id`.

## 2. Evidence shape

- **31/31 sampled reviews have `state: "COMMENTED"`** — no APPROVED verb
  observed, confirming the findings-mode classification.
- **A clean diff still produces a review object.** Two success-body formats
  observed *in one sample* — a prose sentence ("Copilot reviewed 4 out of 4
  changed files in this pull request and generated no comments.",
  dutchdronesquad/trackdraw #757) and a bullet list ("**Files reviewed:** 3/3
  changed files / **Comments generated:** 1 / **Review effort level:**
  Balanced", microsoft/vscode #331735). Consequences:
  - The GH-1847 unsatisfiable-predicate trap does **not** apply: "answered at
    head" = a review object at the head, no plain-comment fallback needed.
  - The summary format is **unstable**, so counts must come from
    `reviewThreads` ground truth, never from parsing the body.

## 3. The trap: the failure family

A quota-exhausted or cannot-review Copilot **files a real COMMENTED review
object at the head**. Two body variants observed:

- "Copilot was unable to review this pull request because the user who
  requested the review has reached their quota limit." — **9 of 31** in the
  sample, so this is the *common* state on quota-capped seats, not an edge.
- "Copilot wasn't able to review any files in this pull request." (all files
  unsupported/too large — tablackburn/ScheduledTasksManager #73)

A bare "non-dismissed review object at head" predicate — the issue's own
sketch — scores these as answered. The predicate excludes bodies matching
`^Copilot (was unable|wasn.t able) to review` (start-anchored; every observed
success body opens `## Pull request overview`). This is the **only** body
parsing in the predicate, and it fails open on an unrecognized future failure
phrasing — the thread count still gates, and the review body is visible on
the PR for the driver to read.

## 4. Severity: none

Inline review comments are **plain prose** — no `![P0 Badge]` (Codex), no
`<img alt="P1">` (Greptile), no severity tokens of any kind (samples:
microsoft/vscode #331735, getlantern/radiance #612 ×3). Threads carry the
standard GraphQL `isResolved` / `isOutdated`. So the gate predicate is:

> answered at this head (non-dismissed, non-failure review object with
> `commit_id == head`) **and** zero unresolved non-outdated threads from the
> bot — every finding blocks until fixed (thread goes outdated) or resolved
> (driver-adjudicated, audit-logged).

`advisory-findings.sh` is unaffected in practice — unbadged threads were
never in its count — but its gate-5 subtraction is request-mode aware now, so
a hypothetically badged bot thread cannot double-report as advisory while
also blocking the gate.

## What a private measurement pass would still add

- The `requested_reviewers` **login as recorded while pending** (the predicate
  matches both `Copilot` and the filing login case-insensitively to cover it).
- Whether an org's Copilot config (custom instructions, automatic reviews)
  changes any of the shapes above.
- Re-review latency after a re-request at a new head.

None of these change the predicate's structure; they would tighten the
pending-request match and the remedy text.
