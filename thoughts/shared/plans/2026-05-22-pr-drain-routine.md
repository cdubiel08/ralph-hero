---
date: 2026-05-22
status: draft
type: plan
tags: [pr-drain, routine, director, next_actions, dependabot, observability]
spec_reference: thoughts/shared/research/2026-05-22-pr-drain-routine-design.md
---

# PR-Drain Routine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Filter unlinkable PRs out of `next_actions` and handle them in a dedicated cloud Claude Code Routine that classifies, code-reviews, acts (merge/comment/close), and threads work through a synthetic Ralph issue for observability — fixing Director's wasteful re-skip on Dependabot PRs identified in the 2026-05-21 autopilot-loop-handoff research.

**Architecture:** `next_actions` (in `directions.ts`) drops `kind: "pr" && linkedIssueNumber === null` rows so Director never dispatches them. A new Claude Code Routine `pr-drain`, fired by the native GitHub trigger on `pull_request` events, invokes a new local skill `/ralph-hero:ralph-pr-drain --pr <N>`. The skill is the operator: classifies the PR, runs `code-review:code-review` as the merge gate for auto-merge candidates, acts, creates a synthetic Ralph issue threaded through the project board, and records a `pr_drain` outcome event. Director and pr-drain are independent loops sharing only GitHub state (issues, labels, comments).

**Tech Stack:** TypeScript + vitest (MCP server filter and tests), Markdown (skill body), `gh` CLI (PR mechanics), `ralph_hero__*` MCP tools (issue lifecycle), `knowledge_record_outcome` MCP (dream-loop feedback), `code-review:code-review` plugin skill (merge gate), Anthropic Routines (cloud Claude Code) with native GitHub trigger.

**Spec reference:** [`thoughts/shared/research/2026-05-22-pr-drain-routine-design.md`](../research/2026-05-22-pr-drain-routine-design.md)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `plugin/ralph-hero/mcp-server/src/lib/directions.ts` | Modify (~5 lines added) | Filter PR rows with null `linkedIssueNumber` out of the merged list so Director never sees unlinkable PRs. |
| `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` | Modify (one new describe block) | Test: 3 PRs (2 linked, 1 Dependabot) → only 2 emitted. |
| `plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md` | Create (~180 lines) | New skill: classify → synth-issue → code-review gate → act → audit trail → outcome. |
| `plugin/ralph-hero/skills/director/SKILL.md` | Modify (~5 lines removed) | Delete dead `linkedIssueNumber` absent branch in Step 2a. |
| `claude.ai/code/routines` (cloud UI, not in repo) | Create | New Routine "pr-drain" with native GitHub `pull_request` trigger. |

---

## Phase 1 — MCP filter (TDD)

### Task 1.1: Write the failing test

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` (append a new describe block at the end)

- [ ] **Step 1: Append the new test block to the end of the file**

Open `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` and append:

```typescript
// ---------------------------------------------------------------------------
// PR filter — drop unlinkable PRs (no feature/GH-NNNN head-ref)
// ---------------------------------------------------------------------------

describe("rankDirections — unlinkable PR filter", () => {
  it("drops PRs whose headRefName does not match feature/GH-NNNN", () => {
    const items = [
      makeItem({ number: 1, workflowState: "Plan in Review", priority: "P1" }),
    ];
    const openPRs: OpenPR[] = [
      makePR({ number: 100, headRefName: "feature/GH-1" }),       // linked → keep
      makePR({ number: 101, headRefName: "feature/GH-2" }),       // linked → keep
      makePR({ number: 102, headRefName: "dependabot/pip/idna-3.8" }), // unlinked → drop
    ];
    const result = rankDirections(items, openPRs, makeConfig({ limit: 10 }));

    const prDirections = result.filter((d) => d.kind === "pr");
    expect(prDirections).toHaveLength(2);
    const prNumbers = prDirections.map((d) => d.pr?.number).sort();
    expect(prNumbers).toEqual([100, 101]);
  });

  it("returns empty PR slice when every PR is unlinkable", () => {
    const openPRs: OpenPR[] = [
      makePR({ number: 200, headRefName: "dependabot/pip/idna-3.8" }),
      makePR({ number: 201, headRefName: "dependabot/npm/typescript-5.6" }),
    ];
    const result = rankDirections([], openPRs, makeConfig({ limit: 10 }));
    const prDirections = result.filter((d) => d.kind === "pr");
    expect(prDirections).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `plugin/ralph-hero/mcp-server/`:

```bash
npx vitest run src/__tests__/directions.test.ts -t "unlinkable PR filter"
```

Expected: 2 tests FAIL. The first fails with something like `expected [...] to have length 2 but got 3` (Dependabot PR is still emitted). The second fails with `expected [...] to have length 0 but got 2`.

### Task 1.2: Implement the filter

**Files:**
- Modify: `plugin/ralph-hero/mcp-server/src/lib/directions.ts:895-897` (replace 3 lines with a filter-aware version)

- [ ] **Step 1: Edit `directions.ts` to drop unlinkable PRs when building the merged list**

Find this block at line 895:

```typescript
  const merged: Entry[] = [];
  for (const c of candidates) merged.push({ kind: "issueRow", payload: c });
  for (const p of prScored) merged.push({ kind: "prRow", payload: p });
```

Replace with:

```typescript
  const merged: Entry[] = [];
  for (const c of candidates) merged.push({ kind: "issueRow", payload: c });
  // Filter unlinkable PRs (no linked issue) so they don't appear in next_actions.
  // These are handled by the pr-drain Routine (out of band of Director).
  // See: thoughts/shared/research/2026-05-22-pr-drain-routine-design.md
  for (const p of prScored) {
    if (p.linkedIssueNumber === null) continue;
    merged.push({ kind: "prRow", payload: p });
  }
```

- [ ] **Step 2: Run the new tests to verify they pass**

```bash
npx vitest run src/__tests__/directions.test.ts -t "unlinkable PR filter"
```

Expected: both new tests PASS.

- [ ] **Step 3: Run the full directions test file to verify no regressions**

```bash
npx vitest run src/__tests__/directions.test.ts
```

Expected: all tests PASS (including the 35+ pre-existing rankDirections tests).

- [ ] **Step 4: Run the full MCP server test suite**

```bash
npm test
```

Expected: all tests PASS. Pay special attention to `directions-tools.test.ts`, `cross-tool-consistency.test.ts`, and any test that builds a `next_actions` fixture with PRs.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-hero/mcp-server/src/lib/directions.ts plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts
git commit -m "$(cat <<'EOF'
feat(directions): drop unlinkable PRs from next_actions

Filter kind:"pr" rows whose linkedIssueNumber is null out of the
merged candidate list. These PRs (typically Dependabot bumps with
dependabot/* head-refs) cannot be dispatched by Director under the
current architecture — Director STOPs on them and /loop re-ticks
into the same skip, spinning on a wasteful no-op.

Unlinkable PRs are now handled out-of-band by the pr-drain Routine
(see thoughts/shared/research/2026-05-22-pr-drain-routine-design.md).

Refs: 2026-05-21-autopilot-loop-handoff research

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — ralph-pr-drain skill

The skill body is markdown that the model follows; there is no unit-test surface for it. Validation is via Phase 4 smoke testing. The full SKILL.md content is shown inline below so the engineer doesn't need to assemble it from the spec.

### Task 2.1: Create the skill directory and SKILL.md

**Files:**
- Create: `plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p plugin/ralph-hero/skills/ralph-pr-drain
```

- [ ] **Step 2: Write the full SKILL.md content**

Write to `plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md`:

````markdown
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

1. **`dependabot-auto-merge` candidate** — all of:
   - `PR_JSON.author.login == "app/dependabot"` (or `.author.is_bot == true` with login starting `dependabot`)
   - Title parses as a patch or minor version bump. The Dependabot convention is `Bump <pkg> from X.Y.Z to A.B.C`. Compute the bump type by comparing `X.Y.Z` and `A.B.C`:
     - If `X != A` → major
     - Else if `Y != B` → minor
     - Else → patch
     - Match only if the bump type is patch or minor.
   - All CI checks green: every element of `PR_JSON.statusCheckRollup` has `conclusion == "SUCCESS"` or `state == "SUCCESS"` (the JSON shape varies — check both).
2. **`dependabot-needs-review`** — `author == "app/dependabot"` AND bump is major (or title doesn't parse as a version bump).
3. **`stale-close`** — `now - updatedAt > 30 days` (compute in bash: `[ "$(( ($(date +%s) - $(date -d "$updatedAt" +%s)) / 86400 ))" -gt 30 ]`).
4. **`stale-ping`** — `now - updatedAt > 14 days` (same shape, threshold 14).
5. **`needs-human`** — default.

### Step 4: Create-or-reuse the synthetic Ralph issue

First, check for an existing synthetic issue for this PR:

```
ralph_hero__list_issues({ labels: ["kind:pr-drain"], state: "OPEN", limit: 50 })
```

Scan returned issue titles for the substring `PR #<N>`. If a match is found, set `SYNTH_NUMBER` to its issue number and skip to "advance to In Progress" below.

Otherwise create a new issue:

```
ralph_hero__create_issue({
  title: "Drain: PR #<N> — <PR_JSON.title>",
  labels: ["pr-drain", "kind:pr-drain"],
  body: "Auto-created by ralph-pr-drain.\n\nClassification: <CLASS>\nPR: <PR_JSON.url>\nAuthor: <PR_JSON.author.login>\nHead ref: <PR_JSON.headRefName>"
})
```

Capture the returned issue number as `SYNTH_NUMBER`.

Advance to In Progress:

```
ralph_hero__save_issue({ number: SYNTH_NUMBER, workflowState: "In Progress" })
```

### Step 5: Act per CLASS

#### `dependabot-auto-merge` candidate

Run code review as the merge gate:

```
Skill("code-review:code-review", "<N>")
```

Parse the review output. The review skill emits a verdict line:
- `GREEN` (or `LGTM` / `APPROVED`) → safe to merge
- `MUST_FIX` (or `BLOCK` / `RED`) → hold for human

**If GREEN:**

```bash
gh pr merge <N> --squash --auto
```

Set `FINAL_CLASS = "dependabot-auto-merge"`. Set `REVIEW_VERDICT = "GREEN"`.

**If MUST_FIX:**

```bash
gh pr comment <N> --body "## Code Review — MUST_FIX

ralph-pr-drain ran code-review:code-review as the auto-merge gate. Review flagged issues; holding for human review.

<paste review findings here>
"
```

Set `FINAL_CLASS = "dependabot-review-flagged"`. Set `REVIEW_VERDICT = "MUST_FIX"`. Do NOT merge.

**If the review skill errors or times out (no verdict line parseable):**

```bash
gh pr comment <N> --body "## Code Review — error

ralph-pr-drain tried to run code-review:code-review as the auto-merge gate but the review did not complete. Holding for human review.
"
```

Set `FINAL_CLASS = "review-error"`. Set `REVIEW_VERDICT = "n/a"`. Do NOT merge.

#### `dependabot-needs-review`

Run code review anyway to give the human a head start, but do not merge:

```
Skill("code-review:code-review", "<N>")
```

Then:

```bash
gh pr comment <N> --body "## Major version bump — needs human review

ralph-pr-drain classified this as a major Dependabot bump. Posting pre-digested code review for the reviewer.

## Code Review

<paste review findings here>
"
```

Set `FINAL_CLASS = "dependabot-needs-review"`. Set `REVIEW_VERDICT = GREEN | MUST_FIX | "n/a"` based on what the review emitted (even though we don't merge either way).

#### `stale-close`

```bash
gh pr close <N> --comment "Closing as stale: this PR has had no activity in 30+ days. Reopen if still relevant."
```

Set `FINAL_CLASS = "stale-close"`. Set `REVIEW_VERDICT = "n/a"`.

#### `stale-ping`

```bash
gh pr comment <N> --body "This PR has been open >14 days with no activity. @<PR_JSON.author.login> — is this still active? If not, ralph-pr-drain will close it in another ~16 days."
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

If the action attempted in Step 5 failed (e.g. `gh pr merge` exited non-zero for a reason other than "already merged"):

```bash
gh pr comment <N> --body "## PR Drain — merge failed

ralph-pr-drain attempted to act on this PR but the operation failed. Holding for human review.

Synthetic issue: #<SYNTH_NUMBER>
Classification: <CLASS>
Error: <captured stderr>
"
```

Set `FINAL_CLASS = "merge-failed"` and proceed to Step 7 (advance synth to Human Needed). Do NOT add the `pr-drained` label.

Otherwise, post the success audit comment:

```bash
gh pr comment <N> --body "## PR Drain

ralph-pr-drain processed this PR.

- Classification: <FINAL_CLASS>
- Synthetic issue: #<SYNTH_NUMBER>
- Review verdict: <REVIEW_VERDICT>
"
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

Then record the outcome:

```
mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome({
  event: "pr_drain",
  outcome: FINAL_CLASS,
  metadata: {
    pr: <N>,
    synth_issue: SYNTH_NUMBER,
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
````

- [ ] **Step 3: Verify the file is syntactically valid markdown with parseable YAML frontmatter**

```bash
head -20 plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md
```

Expected: the YAML frontmatter prints cleanly between `---` markers, ending with `---` followed by the `## Configuration` block.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md
git commit -m "$(cat <<'EOF'
feat(skills): add ralph-pr-drain for unlinkable PRs

Drains PRs that Director cannot dispatch (typically Dependabot
bumps). Classifies the PR, runs code-review:code-review as the
merge gate for auto-merge candidates, acts (merge/comment/close),
and threads a synthetic Ralph issue through the project board for
observability.

Synthetic issue path: Backlog -> In Progress -> Done (or Human
Needed for needs-human / merge-failed). Outcome event recorded
via knowledge_record_outcome for dream-loop feedback.

Three-layer idempotency:
  1. pr-drained label pre-flight check
  2. Synth-issue reuse-by-title in Step 4
  3. gh pr merge --auto natural idempotency

Invoked by the cloud pr-drain Routine on pull_request events;
also user-invocable for one-off cases.

Refs: thoughts/shared/research/2026-05-22-pr-drain-routine-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Director SKILL.md dead-code cleanup

The filter from Phase 1 makes the `linkedIssueNumber === null` branch in Director's Step 2a unreachable. Removing it prevents future-reader confusion.

### Task 3.1: Delete the dead branch

**Files:**
- Modify: `plugin/ralph-hero/skills/director/SKILL.md:58-61` (collapse the bullet for `kind: "pr"` so only the linked-issue case remains)

- [ ] **Step 1: Replace the `kind: "pr"` branch with the linked-only version**

Find this block in `plugin/ralph-hero/skills/director/SKILL.md` (around line 58–61):

```markdown
  - `kind: "pr"` → `direction.issue` is `null`. Use the linked-issue fallback:
    - If `direction.signals.linkedIssueNumber` is set: `TARGET_ISSUE = direction.signals.linkedIssueNumber`. Proceed to Step 2b; Step 3 classifies the linked issue's `workflowState` via the taxonomy.
    - If `linkedIssueNumber` is absent (the PR's `headRefName` did not match `feature/GH-NNNN`): emit `result: Top direction is PR #<N> with no linked issue. Skipping.` and STOP. Do NOT iterate the rest of the list — Director processes one direction per invocation, and `/loop` owns the re-tick cadence.
```

Replace with:

```markdown
  - `kind: "pr"` → `direction.issue` is `null`. `direction.signals.linkedIssueNumber` is guaranteed to be set because `next_actions` filters out PRs with a null `linkedIssueNumber` at the source (see `mcp-server/src/lib/directions.ts`; unlinkable PRs are handled by the pr-drain Routine, not Director). Set `TARGET_ISSUE = direction.signals.linkedIssueNumber` and proceed to Step 2b; Step 3 classifies the linked issue's `workflowState` via the taxonomy.
```

- [ ] **Step 2: Verify the skill markdown still parses cleanly**

```bash
head -80 plugin/ralph-hero/skills/director/SKILL.md
```

Expected: Step 2a still has clean numbered sub-bullets, no orphaned indentation, no broken markdown lists.

- [ ] **Step 3: Run the full MCP server test suite (Director changes don't break compile or any test fixture)**

```bash
cd plugin/ralph-hero/mcp-server && npm test
```

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/director/SKILL.md
git commit -m "$(cat <<'EOF'
docs(director): remove dead unlinkable-PR branch from Step 2a

The next_actions filter added in feat(directions) drops kind:"pr"
rows with null linkedIssueNumber at the source. Director's
"if linkedIssueNumber is absent → STOP" branch is now unreachable;
removing it prevents future-reader confusion.

PRs that Director cannot dispatch are now handled by the pr-drain
Routine (skills/ralph-pr-drain).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — Local smoke test of the skill

Validate the skill end-to-end against a real PR before wiring up the cloud Routine. This catches misconfigured `allowed-tools`, broken `gh` command syntax, classification edge cases, and `knowledge_record_outcome` integration issues in an environment where you can see and fix them quickly.

### Task 4.1: Pick or open a smoke-test PR

- [ ] **Step 1: Find an existing Dependabot PR on `cdubiel08/ralph-hero` to smoke against, or open a sacrificial one**

```bash
gh pr list --repo cdubiel08/ralph-hero --author "app/dependabot" --state open --json number,title,headRefName --limit 5
```

If at least one Dependabot PR exists, pick the smallest patch-bump (e.g. `Bump idna from 3.7 to 3.8`) and record its PR number as `SMOKE_PR`.

If no Dependabot PRs are open, open a draft PR manually with a Dependabot-shaped title for testing (or wait for the next Dependabot run). Record the PR number as `SMOKE_PR`.

### Task 4.2: Invoke the skill locally

- [ ] **Step 1: Build + reload the MCP server so the filter change takes effect locally**

```bash
cd plugin/ralph-hero/mcp-server && npm run build
```

Then restart Claude Code so the MCP server picks up the new `dist/`.

- [ ] **Step 2: Invoke the skill against the smoke PR**

In a fresh Claude Code session:

```
/ralph-hero:ralph-pr-drain --pr <SMOKE_PR>
```

Expected output: a sequence of tool calls matching Steps 1–8 of the skill body, ending with a single `result:` line.

### Task 4.3: Verify each step's side effect

- [ ] **Step 1: Verify the synthetic issue was created with the right shape**

```bash
gh issue list --repo cdubiel08/ralph-hero --label "kind:pr-drain" --json number,title,labels,state --limit 5
```

Expected: one new issue titled `Drain: PR #<SMOKE_PR> — <pr.title>` with labels `pr-drain` and `kind:pr-drain`, in state `CLOSED` (workflowState `Done`) or `OPEN` with workflowState `Human Needed`.

- [ ] **Step 2: Verify the audit comment was posted on the PR**

```bash
gh pr view <SMOKE_PR> --comments --repo cdubiel08/ralph-hero | grep -A 5 "## PR Drain"
```

Expected: a comment containing `## PR Drain`, `Classification: <CLASS>`, `Synthetic issue: #<SYNTH>`, `Review verdict: <VERDICT>`.

- [ ] **Step 3: Verify the `pr-drained` label was added**

```bash
gh pr view <SMOKE_PR> --json labels --jq '.labels[].name' --repo cdubiel08/ralph-hero
```

Expected: includes `pr-drained`. (Will not be present if classification was `needs-human` or `merge-failed`.)

- [ ] **Step 4: Verify the outcome event was recorded**

```bash
sqlite3 ~/.ralph-hero/knowledge.db "SELECT event, outcome, metadata FROM outcome_events ORDER BY ts DESC LIMIT 1;"
```

Expected: one row with `event = 'pr_drain'`, `outcome` matching the classification, and `metadata` JSON containing `pr`, `synth_issue`, `review_verdict`.

- [ ] **Step 5: For auto-merge candidates: verify the PR was queued for merge**

```bash
gh pr view <SMOKE_PR> --json autoMergeRequest,mergeStateStatus --repo cdubiel08/ralph-hero
```

Expected (if classification was `dependabot-auto-merge` and review was GREEN): `autoMergeRequest` is non-null with `mergeMethod: "SQUASH"`. If CI was green, the PR may already be merged by the time you check.

### Task 4.4: Verify idempotency

- [ ] **Step 1: Re-invoke the skill on the same PR**

In a fresh Claude Code session:

```
/ralph-hero:ralph-pr-drain --pr <SMOKE_PR>
```

Expected: skill emits `result: PR #<SMOKE_PR> already drained. Skipping.` and exits without creating a second synth issue, posting a second audit comment, or recording a second outcome event.

- [ ] **Step 2: Verify no duplicate synth issue was created**

```bash
gh issue list --repo cdubiel08/ralph-hero --label "kind:pr-drain" --search "PR #<SMOKE_PR>" --json number --limit 10
```

Expected: exactly one issue matches.

---

## Phase 5 — Cloud Routine setup

Manual configuration in the claude.ai UI. The routine prompt is short because all classification + action logic lives in the skill.

### Task 5.1: Create the routine

- [ ] **Step 1: Open the routines UI**

Navigate to https://claude.ai/code/routines and click **New Routine**.

- [ ] **Step 2: Configure the routine prompt**

Name: `pr-drain`

Prompt body:

```
You receive a GitHub pull_request event as a text payload (e.g. "PR 1316 opened
in cdubiel08/ralph-hero"). Parse the PR number from the text. Then invoke:

  /ralph-hero:ralph-pr-drain --pr <N>

The skill classifies the PR, runs code review for auto-merge candidates, acts
(merge / comment / close), creates a synthetic Ralph issue for board visibility,
and records the outcome. Emit the skill's `result:` line and exit.

If you cannot parse a PR number from the payload, emit:
  needs input: could not parse PR number from payload: <payload>
and exit.
```

- [ ] **Step 3: Select repository and environment**

Repo: `cdubiel08/ralph-hero`. Cloud environment: ensure the ralph-hero plugin is installed (the cloud environment needs the same plugin manifest as your local install).

- [ ] **Step 4: Configure the GitHub trigger**

Trigger type: **GitHub**

Event: `pull_request`

Actions: `opened`, `synchronize`, `ready_for_review`

Save the routine.

### Task 5.2: End-to-end smoke test

- [ ] **Step 1: Open a sacrificial PR to trigger the routine**

Either wait for the next Dependabot PR, or open a draft PR with a Dependabot-shaped title:

```bash
git checkout -b dependabot/pip/smoke-test-1.0-to-1.0.1
echo "# smoke test" >> SMOKE.md
git add SMOKE.md
git commit -m "Bump smoke from 1.0 to 1.0.1"
git push -u origin dependabot/pip/smoke-test-1.0-to-1.0.1
gh pr create --title "Bump smoke from 1.0 to 1.0.1" --body "Smoke test" --draft
```

Record the PR number as `SMOKE_PR_2`.

- [ ] **Step 2: Verify the routine fired**

Within ~30 seconds, the routine should fire. Check the routine's run history in the claude.ai UI for a new run. Inspect the run's output for the skill's `result:` line.

- [ ] **Step 3: Verify side effects (same checks as Task 4.3)**

```bash
gh issue list --repo cdubiel08/ralph-hero --label "kind:pr-drain" --search "PR #<SMOKE_PR_2>" --json number,title --limit 5
gh pr view <SMOKE_PR_2> --comments --repo cdubiel08/ralph-hero | grep -A 5 "## PR Drain"
gh pr view <SMOKE_PR_2> --json labels --jq '.labels[].name' --repo cdubiel08/ralph-hero
```

Expected: synth issue exists, audit comment posted, `pr-drained` label present.

- [ ] **Step 4: Clean up the sacrificial PR (if applicable)**

```bash
gh pr close <SMOKE_PR_2> --comment "Smoke test complete; closing."
git push origin --delete dependabot/pip/smoke-test-1.0-to-1.0.1
```

Close the synthetic issue manually if it was left in `Human Needed` (the smoke PR is non-Dependabot in author so it likely classified as `needs-human`).

### Task 5.3: Document the routine in the repo

- [ ] **Step 1: Add a brief reference to the routine in the spec's Open Questions section being resolved**

Edit `thoughts/shared/research/2026-05-22-pr-drain-routine-design.md` and update the spec's Open Questions section to record:

- Routine ID (visible in the claude.ai UI URL)
- Date created
- Smoke-test PR number used for verification

This is post-hoc operational metadata, not a logic change. Append at the end of the Open Questions section:

```markdown
## Operational metadata (filled in after setup)

- Routine ID: <fill in after Task 5.1>
- Created: <date>
- Smoke test PR: #<SMOKE_PR_2>
- Smoke test result: <pass / fail with notes>
```

- [ ] **Step 2: Commit the operational metadata**

```bash
git add thoughts/shared/research/2026-05-22-pr-drain-routine-design.md
git commit -m "$(cat <<'EOF'
docs(spec): record pr-drain routine operational metadata

Adds routine ID, creation date, and smoke-test outcome to the
pr-drain design spec so the runtime configuration is discoverable
from the repo.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria

All of these must hold before this plan is considered complete:

- [ ] Phase 1 tests pass; `npm test` from `mcp-server/` shows zero regressions.
- [ ] Phase 2 skill loads (visible in `/help` or when invoking the Skill tool by name).
- [ ] Phase 3 Director skill change committed; full test suite still green.
- [ ] Phase 4 smoke test ran end-to-end against a real PR; all 4 side effects (synth issue, audit comment, label, outcome event) verified.
- [ ] Phase 4 idempotency verified (second invocation is a no-op).
- [ ] Phase 5 routine created in claude.ai UI; smoke PR fired the routine; same side-effect checks pass for the cloud-fired run.
- [ ] Spec updated with routine ID and smoke-test metadata.

## Out of scope (per the spec)

- `drainedPRs` counter on `pipeline_dashboard`
- `record_activity_remote` MCP tool to close the cloud→local activity-log gap
- Fix for GH-1346 (autopilot silent-drop stop-gate)
- Audit of the `RemoteTrigger` tool URL discrepancy and `subscribe.py` URL path
- Heartbeat/cron sweep as a safety net for missed routine fires
- Grouped Dependabot updates (the bump-classification heuristic assumes single-package bumps; grouped updates land as `needs-human` until a follow-up)
