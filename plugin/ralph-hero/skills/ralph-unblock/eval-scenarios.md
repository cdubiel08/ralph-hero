# Eval Scenarios — `ralph-hero:ralph-unblock`

Each scenario describes a fixture state, the expected skill behavior, and pass/fail
criteria. Scenarios are intended to be run manually (or via a future automated
harness) against a test repo configured with the ralph-hero plugin.

## 1. `escalation-comment-present`

**Setup**:
- Issue #N is in workflow state `Human Needed`.
- Issue body describes an `ralph-impl` failure with one ambiguous decision.
- The most recent comment is a `## Escalation` posted by `ralph-impl` containing the line
  `Escalation: Cannot decide between approach A and approach B during ralph_impl.`

**Expected behavior**:
- Skill picks issue #N (oldest eligible Human Needed without a fresh `## Unblock Request`).
- Reads the `## Escalation` comment, extracts `originating_command = "ralph_impl"`.
- Synthesizes 1–3 questions that reference the A vs B decision concretely.
- Posts a `## Unblock Request` comment containing the questions and the line
  `Originating skill: \`ralph_impl\``.
- Records `unblock_requested` outcome event with payload
  `{ question_count: <n>, escalation_comment_present: true, originating_command: "ralph_impl" }`.
- Sets `RALPH_UNBLOCK_REQUEST_POSTED=1` and exits cleanly via the Stop hook.

**Pass criteria**:
- Comment is posted with the expected header and structure.
- Issue remains in `Human Needed` (no `save_issue` called).
- Outcome event row appears in `~/.ralph-hero/knowledge.db` with the expected payload.

---

## 2. `escalation-comment-absent`

**Setup**:
- Issue #N is in `Human Needed` (e.g., a human moved it manually).
- No `## Escalation` comment exists.
- An earlier comment links to a research doc via `## Research Document` header.

**Expected behavior**:
- Skill picks issue #N.
- Notes absence of `## Escalation`.
- Falls back to issue body + linked research doc for context.
- Synthesizes questions grounded in the research doc / issue body.
- Posts `## Unblock Request` with `Originating skill: (unknown)`.
- Records outcome event with `escalation_comment_present: false, originating_command: null`.

**Pass criteria**:
- Comment is posted with `Originating skill: (unknown)` rendered literally.
- Questions reference real material from the issue body or linked doc (not invented).
- Outcome event payload reflects the missing escalation correctly.

---

## 3. `queue-empty`

**Setup**:
- No issues are in `workflowState: "Human Needed"`. (Or all Human Needed issues
  already have a fresh `## Unblock Request` since their last `## Escalation`.)

**Expected behavior**:
- Skill calls `list_issues` with `workflowState: "Human Needed"` and finds 0 candidates
  (or all candidates are skipped by the idempotency guard).
- Sets `RALPH_UNBLOCK_QUEUE_EMPTY=1`.
- Prints `No Human Needed issues need an unblock request. Queue empty.`.
- Stop hook allows exit.

**Pass criteria**:
- No comment posted on any issue.
- No outcome event recorded.
- Skill exits with success status (Stop hook does not block).

---

## 4. `idempotency`

**Setup**:
- Issue #N is in `Human Needed`.
- Issue has a `## Escalation` comment dated T0.
- Issue has a `## Unblock Request` comment dated T1 (T1 > T0) — already posted by a
  previous run.
- Issue #M is also in `Human Needed`, has an `## Escalation` but no `## Unblock Request`.

**Expected behavior**:
- Skill iterates the candidate list, examines #N first (oldest), notes that a
  `## Unblock Request` already exists since the latest `## Escalation`, and skips it.
- Picks #M as the next eligible candidate.
- Posts a `## Unblock Request` on #M only.
- Issue #N is left untouched (no second comment).

**Pass criteria**:
- Issue #N has exactly ONE `## Unblock Request` comment after the run (not two).
- Issue #M has a new `## Unblock Request` comment.
- Outcome event references #M, not #N.

---

## 5. `arg-provided`

**Setup**:
- Skill invoked with argument `42`.
- Issue #42 is in `Human Needed` and has an `## Escalation` comment.
- Issue #41 is also in `Human Needed` but is NOT the target.

**Expected behavior**:
- Skill fetches issue #42 directly via `get_issue`, ignores #41.
- Verifies state is `Human Needed`, proceeds to context-read and question synthesis.
- Posts `## Unblock Request` on #42.

**Pass criteria**:
- Comment posted on #42, NOT on #41.
- Idempotency guard still applies — if #42 already has a fresh `## Unblock Request`,
  skill exits with empty-queue declaration rather than posting a duplicate.

---

## 6. `arg-provided-wrong-state`

**Setup**:
- Skill invoked with argument `42`.
- Issue #42 is in `In Progress` (not `Human Needed`).

**Expected behavior**:
- Skill fetches issue #42, sees `workflowState: "In Progress"`.
- Aborts with the message:
  `Issue #42 is in In Progress (expected: Human Needed). Aborting.`
- Sets `RALPH_UNBLOCK_QUEUE_EMPTY=1` so the Stop hook allows clean exit.

**Pass criteria**:
- No comment posted.
- No `save_issue` call attempted.
- No outcome event recorded.
- Skill exits cleanly (Stop hook does not block).
