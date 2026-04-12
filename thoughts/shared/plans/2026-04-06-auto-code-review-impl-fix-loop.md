---
date: 2026-04-06
status: draft
type: plan
tags: [code-review, ralph-merge, finish, impl-agent, automation, plan-skill, auto-mode]
github_issues: [756]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/756
primary_issue: 756
github_issue: 756
---

# Auto Mode Pipeline Gaps — Implementation Plan

## Prior Work

- builds_on:: [[2026-04-05-env-var-backtick-resolution]]
- builds_on:: [[2026-04-05-hero-pipeline-handoff-ux-inventory]]

## Overview

Close two gaps where `auto` mode env vars don't flow through to downstream skills:

1. **`RALPH_REVIEW_MODE=auto` → ralph-merge**: The code review gate always prompts via AskUserQuestion. Should auto-run `code-review:code-review` and dispatch impl-agent if issues are flagged.
2. **`RALPH_REVIEW_PLAN=auto` → plan skill Step 6**: The plan skill skips human review (Step 5) but then presents a prose menu at Step 6 (GitHub Integration). Should auto-search for matching issues, link or create, and auto-advance without prompting.

## Current State Analysis

- `RALPH_REVIEW_MODE` is resolved in `hero/SKILL.md:49` via backtick preprocessing, defaults to `interactive`
- `ralph-merge/SKILL.md:81-153` has the Code Review Gate (Step 4) — always prompts via AskUserQuestion when no review decision exists
- `finish/SKILL.md:94-106` already has a val→fix→re-val cycle pattern (max 1 fix cycle)
- `ralph-impl/SKILL.md:410-441` has Address Mode — activated when issue is "In Review" with open PR + review comments. Gathers comments, classifies MUST_FIX/SHOULD_FIX/DISCUSS, pushes fixes, replies to PR comments
- Neither ralph-merge nor finish currently reference `RALPH_REVIEW_MODE`

### Key Discoveries:
- `finish/SKILL.md:105` — existing fix cycle pattern: "Dispatch impl-agent to apply the listed fix commands in the worktree, commit, then re-run val-agent. Max 1 fix cycle"
- `ralph-merge/SKILL.md:124` — when code-review flags issues: "output the review findings and stop"
- `ralph-impl/SKILL.md:91-95` — Address Mode detection: issue in "In Review" + open PR with review comments → auto-activates
- `RALPH_REVIEW_MODE` flows through process environment, so ralph-merge and finish can read it without explicit arg passing

## Desired End State

When `RALPH_REVIEW_MODE=auto`:
1. ralph-merge auto-runs `code-review:code-review` when no review decision exists (no AskUserQuestion)
2. If code-review flags issues, ralph-merge returns `CODE_REVIEW_FEEDBACK` (not `MERGE BLOCKED`)
3. finish catches `CODE_REVIEW_FEEDBACK`, dispatches impl-agent in Address Mode, then re-runs ralph-merge
4. Max 1 fix cycle — if code-review still flags issues after the fix, finish stops

When `RALPH_REVIEW_MODE=interactive` (default): behavior is unchanged.

### Verification:
- Read `ralph-merge/SKILL.md` Step 4 and confirm auto path skips AskUserQuestion
- Read `finish/SKILL.md` Step 4 and confirm `CODE_REVIEW_FEEDBACK` handling exists with impl-agent dispatch
- Confirm human-reviewer `CHANGES_REQUESTED` still produces `MERGE BLOCKED` (not `CODE_REVIEW_FEEDBACK`)

## What We're NOT Doing

- Not changing how `RALPH_REVIEW_MODE` controls the hero orchestrator's merge gate (that's already correct)
- Not adding `RALPH_REVIEW_MODE` as a CLI flag — it remains an env var only
- Not changing the interactive-mode behavior (AskUserQuestion stays for interactive)
- Not auto-fixing human reviewer feedback — only automated code-review feedback triggers the fix cycle
- Not changing the val→fix→re-val cycle in finish (Phase 2 adds a parallel pattern, doesn't modify it)
- Not changing the autonomous `ralph-plan` skill — it's already fully autonomous via hero dispatch

## Implementation Approach

Phase 1 modifies ralph-merge to read `RALPH_REVIEW_MODE` and branch on it in Step 4. Phase 2 modifies finish to handle the new `CODE_REVIEW_FEEDBACK` output status. Phase 3 makes the plan skill's Step 6 fully autonomous when `RALPH_REVIEW_PLAN=auto`. Phase 4 updates documentation.

## Phase 1: ralph-merge — Auto Code Review Gate

### Overview
Teach ralph-merge to read `RALPH_REVIEW_MODE` and, when `auto`, run `code-review:code-review` without prompting. Introduce `CODE_REVIEW_FEEDBACK` as a new output status for automated review findings.

### Changes Required:

#### 1. Add RALPH_REVIEW_MODE to configuration section
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Lines**: 31-36 (Configuration section)
**Changes**: Add review mode resolution

```markdown
## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`
- Review mode: !`echo ${RALPH_REVIEW_MODE:-interactive}`

Use these resolved values when constructing GitHub URLs or referencing the repository.
```

#### 2. Rewrite Step 4: Code Review Gate
**File**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md`
**Lines**: 81-153 (entire Step 4)
**Changes**: Replace the current Step 4 with a version that branches on review mode. The full replacement:

```markdown
## Step 4: Code Review Gate

Check whether the PR has received a code review:

\`\`\`bash
gh pr view NNN --json reviewDecision
\`\`\`

**If `reviewDecision` is `APPROVED`**: a code review has been performed and approved. Proceed to Step 5.

**If `reviewDecision` is `CHANGES_REQUESTED`**: a code review was performed but the reviewer requested changes. Output:

\`\`\`
MERGE BLOCKED
Issue: #NNN
PR: #PR_NUMBER
Reason: Reviewer requested changes — address feedback before merging.
\`\`\`

And stop.

**If no review decision exists** (`reviewDecision` is null or empty):

1. Check if the `code-review:code-review` skill is available by looking for it in the available skills list (it is an official Anthropic plugin).

2. **If the skill is available AND review mode is "auto":**

   Run code review automatically — do NOT prompt the user:

   \`\`\`
   Skill("code-review:code-review", "PR_NUMBER")
   \`\`\`

   After the review completes, re-check `reviewDecision` via `gh pr view`.

   - If the PR was approved: continue to Step 5.
   - If changes were requested: output the review findings with a distinct status so the caller (finish) can dispatch a fix cycle:

   \`\`\`
   CODE_REVIEW_FEEDBACK
   Issue: #NNN
   PR: #PR_NUMBER
   Reason: Automated code review flagged issues — impl-agent fix cycle available.
   \`\`\`

   And stop. Do NOT output `MERGE BLOCKED` for automated review feedback — the `CODE_REVIEW_FEEDBACK` status signals that finish should attempt a fix cycle.

3. **If the skill is available AND review mode is "interactive" (default):**

   Present a choice:

   !cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/ask-user-question.md

   \`\`\`
   AskUserQuestion(
     questions=[{
       "question": "This PR has no code review yet. Would you like to run one before merging?",
       "header": "Code Review",
       "options": [
         {"label": "Run code review", "description": "Invoke /code-review:code-review on PR #NNN before merging"},
         {"label": "Merge without review", "description": "Skip code review and proceed to merge"}
       ],
       "multiSelect": false
     }]
   )
   \`\`\`

   - If user selects **"Run code review"**: invoke `Skill("code-review:code-review", "PR_NUMBER")` where PR_NUMBER is the PR number obtained in Step 3 (not the issue number). After the review completes, re-check `reviewDecision` via `gh pr view`. If the PR was approved, continue to Step 5. If changes were requested, output the review findings and stop — the user needs to address feedback first.
   - If user selects **"Merge without review"**: proceed to Step 5.
   - If user selects **"Other"**: stop.

4. **If the skill is NOT available**, inform the user:

   \`\`\`
   This PR has no code review. Consider installing the code-review plugin:
     claude plugins install @anthropic/code-review
   \`\`\`

   Then present:

   \`\`\`
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
   \`\`\`

   - If user selects **"Merge without review"**: proceed to Step 5.
   - If user selects **"Stop"** or **"Other"**: stop.
```

### Success Criteria:

#### Automated Verification:
- [x] `ralph-merge/SKILL.md` contains `RALPH_REVIEW_MODE` in configuration section
- [x] `ralph-merge/SKILL.md` Step 4 contains `CODE_REVIEW_FEEDBACK` output block
- [x] `ralph-merge/SKILL.md` Step 4 contains "review mode is \"auto\"" branch
- [x] `ralph-merge/SKILL.md` Step 4 still contains AskUserQuestion for interactive mode
- [x] `ralph-merge/SKILL.md` Step 4 still contains `MERGE BLOCKED` for human reviewer CHANGES_REQUESTED

#### Manual Verification:
- [ ] Read through Step 4 and confirm the auto/interactive/no-plugin branches are logically correct
- [ ] Confirm the `CODE_REVIEW_FEEDBACK` status is only emitted from the auto code review path

---

## Phase 2: finish — Code Review Fix Cycle

### Overview
Add a code-review fix cycle to finish, mirroring the existing val FIX pattern. When ralph-merge returns `CODE_REVIEW_FEEDBACK`, dispatch impl-agent in Address Mode then re-run ralph-merge. Max 1 fix cycle.

### Changes Required:

#### 1. Update finish Step 4 description
**File**: `plugin/ralph-hero/skills/finish/SKILL.md`
**Lines**: 108-121 (Step 4: Merge)
**Changes**: Replace Step 4 with version that handles `CODE_REVIEW_FEEDBACK`:

```markdown
## Step 4: Merge (dispatch ralph-merge)

Build args for ralph-merge — always pass the PR URL to avoid redundant lookup:

\`\`\`
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
\`\`\`

ralph-merge handles: code review gate (including optional `code-review:code-review` dispatch), PR readiness check, merge via `merge-pr.sh`, worktree cleanup, state transition to Done, parent advancement, cross-repo unblock, and posting the Merged comment.

Check the skill output:

- If output contains `MERGE BLOCKED` or `MERGE NOT READY`: report the status and stop.
- If output contains `MERGED`: continue to Step 5.
- If output contains `CODE_REVIEW_FEEDBACK`: automated code review flagged issues. Proceed to Step 4a.

## Step 4a: Code Review Fix Cycle

Dispatch impl-agent in Address Mode to fix the flagged issues. The issue is already "In Review" with an open PR that has review comments — impl-agent will auto-detect Address Mode.

\`\`\`
Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for GH-NNN. The automated code review flagged issues on PR #PR_NUMBER. Fix the MUST_FIX and SHOULD_FIX items, push, and reply to comments.")
\`\`\`

After impl-agent completes, re-run ralph-merge:

\`\`\`
Skill("ralph-hero:ralph-merge", args="NNN --pr-url PR_URL")
\`\`\`

Check the output again:

- If `MERGED`: continue to Step 5.
- If `MERGE BLOCKED`, `MERGE NOT READY`, or `CODE_REVIEW_FEEDBACK` again: stop. Max 1 fix cycle — report the status and let the human intervene.
```

### Success Criteria:

#### Automated Verification:
- [x] `finish/SKILL.md` contains `CODE_REVIEW_FEEDBACK` handling
- [x] `finish/SKILL.md` contains `Step 4a: Code Review Fix Cycle`
- [x] `finish/SKILL.md` contains impl-agent dispatch with Address Mode prompt
- [x] `finish/SKILL.md` contains "Max 1 fix cycle" constraint

#### Manual Verification:
- [ ] Read through Steps 4 and 4a and confirm the flow is logically correct
- [ ] Confirm impl-agent dispatch matches the Address Mode activation pattern (issue in "In Review" + open PR)
- [ ] Confirm the max-1-cycle guard prevents infinite loops

---

## Phase 3: Plan Skill — Auto Mode GitHub Integration (#756)

### Overview
When `RALPH_REVIEW_PLAN=auto`, the plan skill's Step 6 (GitHub Integration) should be fully autonomous: search for matching issues, link or create, auto-advance, and continue without prompting. Currently it presents a prose menu that defeats auto mode.

### Changes Required:

#### 1. Rewrite Step 5 auto path to include GitHub Integration
**File**: `plugin/ralph-hero/skills/plan/SKILL.md`
**Location**: Step 5 (Review) — the auto-mode branch currently says "skip human review, proceed directly to Step 6"
**Changes**: When auto, instead of just skipping to Step 6 (which then prompts), merge Steps 5+6 into a single autonomous flow:

```markdown
If plan review is "auto", skip human review and proceed to autonomous GitHub integration:

1. **Search for matching open issues**: Use `list_issues` to search by keywords from the plan title. Look for issues in Backlog, Research Needed, or Ready for Plan states that match the plan's scope.

2. **If a matching issue exists**: Link the plan to it:
   - Rename the plan file to include `GH-NNNN` if not already present
   - Update plan frontmatter with `github_issue`, `github_issues`, `github_urls`, `primary_issue`
   - Post an Artifact Comment on the issue (per the Artifact Comment Protocol):
     ```markdown
     ## Implementation Plan

     https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/blob/main/thoughts/shared/plans/[filename].md

     Summary: [1-3 line summary of the plan]
     ```

3. **If no matching issue exists**: Create a new issue:
   - Create a GitHub issue with the plan summary as the body
   - Set estimate based on plan complexity (XS/S/M)
   - Rename the plan file to include the new issue number
   - Post the Artifact Comment (same as above)
   - Update plan frontmatter with the new issue reference

4. **Auto-advance**: Update the issue workflow state to "Plan in Review" so the review-agent can pick it up.

5. **Report result**:
   ```
   Plan linked to GitHub issue: #NNN
   URL: https://github.com/$RALPH_GH_OWNER/$RALPH_GH_REPO/issues/NNN
   State: Plan in Review
   Ready for review. Use /ralph-hero:ralph-review #NNN or /ralph-hero:impl #NNN after approval.
   ```
```

#### 2. Keep Step 6 for interactive mode only
**File**: `plugin/ralph-hero/skills/plan/SKILL.md`
**Location**: Step 6 (GitHub Integration)
**Changes**: Add a guard at the top of Step 6:

```markdown
### Step 6: GitHub Integration (Interactive Mode Only)

> This step only applies when plan review is "interactive". When "auto", GitHub integration is handled in Step 5.
```

The rest of Step 6 (AskUserQuestion pickers for link/create/skip) remains unchanged for interactive mode.

### Success Criteria:

#### Automated Verification:
- [x] `plan/SKILL.md` Step 5 auto path contains `list_issues` search
- [x] `plan/SKILL.md` Step 5 auto path contains issue creation logic
- [x] `plan/SKILL.md` Step 5 auto path contains auto-advance to "Plan in Review"
- [x] `plan/SKILL.md` Step 6 is guarded with "Interactive Mode Only"
- [x] `plan/SKILL.md` Step 6 AskUserQuestion pickers remain intact for interactive mode

#### Manual Verification:
- [ ] Run `/plan` with `RALPH_REVIEW_PLAN=auto` — verify no prompts, issue auto-created/linked, state advanced
- [ ] Run `/plan` with `RALPH_REVIEW_PLAN=interactive` — verify AskUserQuestion pickers still work

---

## Phase 4: Documentation Updates

### Overview
Update hero skill env var table and finish skill description to document the new behavior.

### Changes Required:

#### 1. Update hero env var table
**File**: `plugin/ralph-hero/skills/hero/SKILL.md`
**Lines**: 510-513 (Environment Variables table)
**Changes**: Expand `RALPH_REVIEW_MODE` description:

```markdown
| `RALPH_REVIEW_MODE` | `interactive` | Merge review: `interactive` (stop at PR, prompt for code review), `auto` (auto-run code review, fix flagged issues via impl-agent, merge) |
```

#### 2. Update finish skill description
**File**: `plugin/ralph-hero/skills/finish/SKILL.md`
**Lines**: 2 (description in frontmatter)
**Changes**: Mention code review fix cycle:

```yaml
description: Validate, merge, and watch CI for a completed implementation. Chains ralph-val → ralph-merge → CI watch into one command. Code review is handled by ralph-merge's built-in gate; when RALPH_REVIEW_MODE=auto and code review flags issues, dispatches impl-agent to fix them.
```

#### 3. Update finish preamble
**File**: `plugin/ralph-hero/skills/finish/SKILL.md`
**Lines**: 43 (preamble text)
**Changes**: Update to reflect new behavior:

```markdown
Validate, merge, and watch CI for a completed implementation. Code review is handled by ralph-merge's built-in gate — when `RALPH_REVIEW_MODE=auto`, finish also orchestrates a code-review → impl-fix → re-merge cycle if the automated review flags issues (max 1 fix cycle).
```

### Success Criteria:

#### Automated Verification:
- [x] `hero/SKILL.md` env var table mentions "auto-run code review" and "impl-agent"
- [x] `finish/SKILL.md` description mentions `RALPH_REVIEW_MODE=auto`
- [x] `finish/SKILL.md` preamble mentions code-review fix cycle

#### Manual Verification:
- [ ] Documentation accurately describes the implemented behavior

---

## Testing Strategy

### Manual Testing Steps:
1. Set `RALPH_REVIEW_MODE=auto` in settings, run `/ralph-hero:finish NNN` on a PR with no review — verify code-review runs automatically
2. If code-review flags issues, verify impl-agent is dispatched in Address Mode
3. After impl-agent pushes fixes, verify ralph-merge is re-invoked
4. Set `RALPH_REVIEW_MODE=interactive` (or unset), verify AskUserQuestion still appears
5. Have a human reviewer request changes on a PR, verify `MERGE BLOCKED` (not `CODE_REVIEW_FEEDBACK`)

## References

- ralph-merge code review gate: `plugin/ralph-hero/skills/ralph-merge/SKILL.md:81-153`
- finish val fix cycle pattern: `plugin/ralph-hero/skills/finish/SKILL.md:105`
- impl Address Mode: `plugin/ralph-hero/skills/ralph-impl/SKILL.md:410-441`
- hero env vars: `plugin/ralph-hero/skills/hero/SKILL.md:508-517`
- plan skill Step 5/6: `plugin/ralph-hero/skills/plan/SKILL.md` (Steps 5-6)
- #756: Plan skill auto mode GitHub Integration
- #745: Mode-aware pipeline handoff UX (prior art, completed)
- Backtick resolution plan: `thoughts/shared/plans/2026-04-05-env-var-backtick-resolution.md`
