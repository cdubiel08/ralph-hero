---
description: Validate that implementation satisfies plan requirements. Reads the plan, checks code in worktree, runs automated verification. Use when you want to validate an implementation before PR creation.
argument-hint: <issue-number> [--plan-doc path]
context: fork
model: sonnet
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=val RALPH_REQUIRES_PLAN=true"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/val-postcondition.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
---

# Ralph Val

Validate that the implementation in a worktree satisfies the plan's requirements.

## Step 1: Parse Arguments

Extract issue number and optional `--plan-doc` flag from args:

```
args: "NNN"                        -> issue_number=NNN, plan_doc=nil
args: "NNN --plan-doc path/to/doc" -> issue_number=NNN, plan_doc=path
```

Export: `export RALPH_TICKET_ID="NNN"`

## Step 2: Fetch Issue

```
ralph_hero__get_issue(number=NNN)
```

Get issue title, state, and comments for context.

## Step 3: Find Plan Document

If `--plan-doc` was provided, use that path directly (Artifact Passthrough).

Otherwise, use Artifact Comment Protocol discovery:
- Search issue comments for `## Implementation Plan` or a comment containing a path like `thoughts/shared/plans/YYYY-MM-DD-GH-NNN-*.md`
- If found, read that file
- If not found, search `thoughts/shared/plans/` for files matching `*NNN*` or `*GH-NNN*`

If no plan is found, output:
```
VALIDATION FAIL
Issue: #NNN
Reason: No plan document found — cannot validate without a plan
```
And stop.

## Step 4: Find Worktree

Check `worktrees/GH-NNN` relative to the git root. If the directory exists, use it.

If not found, check task metadata or issue comments for worktree path.

If no worktree found, output:
```
VALIDATION FAIL
Issue: #NNN
Reason: No worktree found at worktrees/GH-NNN — cannot validate without implementation
```
And stop.

## Step 5: Extract Verification Criteria

Parse the plan for:

1. **"Desired End State"** section — high-level description of what should be true
2. **Per-phase "Success Criteria > Automated Verification"** checkboxes — specific commands and file checks

Look for patterns like:
- `- [ ] test -f path/to/file` — file existence check
- `- [ ] test -x path/to/script` — executable check
- `- [ ] grep "pattern" file` — content check
- `- [ ] npm test` — command to run
- `- [ ] npm run build` — command to run

## Step 6: Run Automated Checks

From the worktree directory, execute each automated verification criterion:

**File existence checks**: Run `test -f file` or `test -d dir` or `test -x script`

**Command execution**: Run `npm test`, `npm run build`, `bash -n script.sh`, etc. Capture stdout/stderr and exit code.

**Content checks**: Use Grep to verify expected patterns exist in files.

Record each check as PASS or FAIL with details.

## Step 7: Produce Verdict

If all automated criteria pass: `PASS`
If any criterion fails: `FAIL`

Output the validation report:

```
VALIDATION [PASS/FAIL]
Issue: #NNN
Plan: [plan path]
Worktree: [worktree path]

Checks:
- [x] npm test — passed (exit 0)
- [x] npm run build — passed (exit 0)
- [x] test -f plugin/ralph-hero/skills/ralph-val/SKILL.md — exists
- [ ] grep "RALPH_COMMAND: \"val\"" ... — MISSING

Verdict: [PASS/FAIL]
[If FAIL: list each failing criterion with specific details]
```

## Step 8: Post GitHub Comment

Post the validation report as a GitHub comment on the issue using `ralph_hero__create_comment`. Use the header `## Validation` to follow Artifact Comment Protocol.

## Notes

- Do NOT change workflow state — integrator handles that based on verdict
- Run all checks even after first failure (collect full picture)
- If a command times out or errors unexpectedly, count it as FAIL with the error details
- Focus on automated checks only; do not try to interpret code quality subjectively
