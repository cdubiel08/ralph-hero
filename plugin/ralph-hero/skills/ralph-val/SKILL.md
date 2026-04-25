---
description: Validate that implementation satisfies plan requirements. Reads the plan, checks code in worktree, runs automated verification. Use when you want to validate an implementation before PR creation.
user-invocable: false
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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
---

## Configuration (resolved at load time)

- Owner: !`echo ${RALPH_GH_OWNER:-NOT_SET}`
- Repo: !`echo ${RALPH_GH_REPO:-NOT_SET}`
- Project: !`echo ${RALPH_GH_PROJECT_NUMBER:-NOT_SET}`

Use these resolved values when constructing GitHub URLs or referencing the repository.

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

Fetch the full issue details for issue NNN.

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

**Worktree freshness check**: Once the worktree is located, refresh it before running validation so checks don't pass against a stale base:

```bash
cd worktrees/GH-NNN
git fetch origin main
git pull --ff-only
```

If `git pull --ff-only` fails (non-fast-forward), record the staleness as a substantive failure note but continue validation. Do NOT auto-merge or rebase — surface it in the verdict so the caller can route to impl/human resolution. Skip the pull if the worktree branch is detached or if there is no upstream tracking branch.

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

**Missing `Automated Verification` handler**: If a phase has no `Automated Verification` section (or it is empty), record this as **PASS-with-warning** — do NOT silently skip. Note the phase number and the missing section in the verdict output so the reviewer knows the phase was not auto-checked. Example warning line:

```
- [!] Phase 3: no Automated Verification section — recorded as PASS-with-warning, manual review required
```

## Step 6: Run Automated Checks

From the worktree directory, execute each automated verification criterion:

**File existence checks**: Run `test -f file` or `test -d dir` or `test -x script`

**Command execution**: Run `npm test`, `npm run build`, `bash -n script.sh`, etc. Capture stdout/stderr and exit code.

**Content checks**: Use Grep to verify expected patterns exist in files.

Record each check as PASS or FAIL with details.

## Step 6.5: Drift Log Verification

Search the issue comments (from the fetched issue response) for `## Drift Log — Phase N` headers.

For each drift log found:
1. Parse drift entries (lines starting with `- DRIFT:` or containing `DRIFT:` prefix)
2. For each minor drift: verify the adaptation is consistent with plan intent
3. For each entry: verify a `DRIFT:` commit message exists in the worktree git log via `git log --oneline | grep "DRIFT:"`
4. Flag any undocumented drift — files in `git diff --name-only [base]..HEAD` that aren't in any task's declared file list AND have no `DRIFT:` commit

Report drift summary:
```
Drift Analysis:
- Phase 1: 2 minor drifts (documented)
- Phase 2: 0 drifts
- Undocumented changes: none
```

If no drift logs exist on the issue, report: `Drift Analysis: No drift logs found (clean implementation)`

## Step 6.6: Cross-Phase Integration Check (multi-phase plans only)

If the plan has more than one `## Phase N:` section:

1. Verify each phase's "Creates for next phase" items actually exist in the worktree
2. Check imports between phase outputs — if Phase 1 exports types used by Phase 2, verify the import paths resolve
3. Run the plan's `## Integration Testing` section checks if that section exists

Report integration status:
```
Cross-Phase Integration:
- Phase 1 → Phase 2: types.ts exports used correctly ✓
- Phase 2 → Phase 3: parser.ts interface matches ✓
- Integration tests: 3/3 passing ✓
```

If the plan has only one phase, report: `Cross-Phase Integration: Single-phase plan — skipped`

## Step 7: Produce Verdict

Classify each failure, then choose the verdict:

**Failure classification:**
- **Mechanical**: has a deterministic auto-fix — formatter (`prettier --write`), linter (`eslint --fix`), missing trailing newline, import sorting. No judgment needed.
- **Substantive**: tests fail, missing functionality, wrong behavior, missing files the plan requires. Requires implementation work.

**Verdict rules:**
- All checks pass → `PASS`
- Only mechanical failures → `FIX` (list the fix commands)
- Any substantive failure → `FAIL`

Output the validation report:

```
VALIDATION [PASS/FIX/FAIL]
Issue: #NNN
Plan: [plan path]
Worktree: [worktree path]

### Automated Checks:
- [x] npm test — passed (exit 0)
- [x] npm run build — passed (exit 0)
- [x] test -f plugin/ralph-hero/skills/ralph-val/SKILL.md — exists
- [ ] prettier --check — FAILED (mechanical, fix: prettier --write .)

### Drift Analysis:
- Phase 1: 1 minor drift (documented)
- Undocumented changes: none

### Cross-Phase Integration:
- All phase outputs verified ✓

Verdict: [PASS/FIX/FAIL]
[If FIX: list each mechanical fix command]
[If FAIL: list each substantive failure with specific details]
```

## Step 8: Post GitHub Comment

Post the validation report as a GitHub comment on the issue. Use the header `## Validation` to follow Artifact Comment Protocol.

## Notes

- Do NOT change workflow state — integrator handles that based on verdict
- Do NOT fix issues yourself — report the verdict and let the caller route to impl for fixes
- Run all checks even after first failure (collect full picture)
- If a command times out or errors unexpectedly, count it as FAIL with the error details
- Focus on automated checks only; do not try to interpret code quality subjectively
