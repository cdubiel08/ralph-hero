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
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
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
args: ""                           -> issue_number=nil, queue-pick (see below)
```

Export: `export RALPH_TICKET_ID="NNN"`

**If no issue number** is provided, run the queue-picking branch:

1. Query `list_issues(workflowState: "In Progress", limit: 10)` for candidates ready for validation.
2. For each candidate (in returned order), check whether `worktrees/GH-NNN` exists relative to the git root (`git rev-parse --show-toplevel`). The first candidate with an existing worktree is the selected issue.
3. If no candidate has a worktree, output BOTH lines and STOP:

   ```
   VALIDATION PASS — no work
   Queue empty.
   ```

   Both lines are required: `VALIDATION PASS — no work` satisfies the `val-postcondition.sh` Stop hook (which accepts `VALIDATION PASS`, `VALIDATION FAIL`, or `Queue empty` as terminal verdicts), and `Queue empty.` is the literal token the loop runner greps for to detect an empty queue (`grep -qiE "Queue empty|Triage complete"`).

4. Otherwise, set `issue_number` to the selected candidate and continue with Step 2 as if the number had been passed in as an argument.

This branch mirrors the queue-picking pattern in `ralph-impl/SKILL.md` Step 1 so the loop runner can invoke `just val` argument-less.

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

**Citation Gate (required for every file-content check):**

Before claiming any file fails a content check, you MUST:

1. Run `cat <file>` or the equivalent read command from the worktree
2. Quote the relevant lines verbatim in the verdict (use a fenced code block)
3. State explicitly why the quoted content does or does not satisfy the plan criterion

You may NOT report a file-content failure based on inference from the plan text alone.
If you cannot read the file (missing, permission error), record that as the failure reason — not an inferred content assertion.

**Example — correct citation chain for a failing file-content check:**

````
- [ ] plugin/ralph-playwright/.claude-plugin/plugin.json — FAIL (missing `skills` array)

  Read from worktree:
  ```json
  {
    "name": "ralph-playwright",
    "version": "0.1.0",
    "description": "..."
  }
  ```

  Plan requires a `skills` array with 7 entries. The quoted content has no `skills` key,
  so the criterion is not satisfied.
````

**Example — what NOT to do (fabricated assertion, no citation):**

```
- [ ] plugin.json — FAIL (4 substantive failures)
  1. Missing `skills` array
  2. Missing `agents` array
  3. Prohibited fields present
  4. Wrong version (0.2.0 instead of 0.1.0)
```

This form is prohibited because none of the four claims is backed by quoted file content. The model is inferring from the plan body rather than reading the file. If the file genuinely has these problems, the verdict must quote the actual offending lines.

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

**Verdict format (strict):**

The verdict line MUST begin with exactly one of:

```
VALIDATION PASS
VALIDATION FIX
VALIDATION FAIL
```

Do NOT substitute other status words (e.g. `BLOCKED`, `COMPLETE`, `Phase Assessment`, `Status: ❌`). These are not recognized by `val-postcondition.sh` and will cause the Stop hook to block. Use the literal `VALIDATION PASS|FIX|FAIL` prefix verbatim — no emoji, no bold, no alternate vocabulary.

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

**Negative example — DO NOT emit verdicts like this:**

```
### Phase Assessment

**Status**: ❌ **BLOCKED** — Does not meet acceptance criteria
```

The string `BLOCKED` is borrowed from issue-workflow vocabulary and is NOT a valid val verdict. Replace with:

```
VALIDATION FAIL
Issue: #NNN
Plan: [plan path]
Worktree: [worktree path]

### Substantive Failures:
- [ ] [specific failing check with details]
```

Similarly invalid: `Status: ❌`, `COMPLETE`, `Phase Assessment` as the verdict prefix. Only `VALIDATION PASS`, `VALIDATION FIX`, or `VALIDATION FAIL` (followed by the report body) is accepted.

## Step 8: Post GitHub Comment

Post the validation report as a GitHub comment on the issue. Use the header `## Validation` to follow Artifact Comment Protocol.

## Notes

- Do NOT change workflow state — integrator handles that based on verdict
- Do NOT fix issues yourself — report the verdict and let the caller route to impl for fixes
- Run all checks even after first failure (collect full picture)
- If a command times out or errors unexpectedly, count it as FAIL with the error details
- Focus on automated checks only; do not try to interpret code quality subjectively
