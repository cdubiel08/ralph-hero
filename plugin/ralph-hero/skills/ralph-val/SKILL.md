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
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
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

**Do NOT fall back to validating against main.** Do NOT substitute any other path. The "no worktree" condition is a hard stop with VALIDATION FAIL. The following is a forbidden anti-pattern:

```
VALIDATION PASS

Issue: #NNN
Plan: thoughts/shared/plans/...
Implementation: Merged to main
```

Two signals identify this anti-pattern: (1) no `worktrees/GH-NNN` path is printed in the report, and (2) the verdict is `VALIDATION PASS` despite the absence of a worktree. If the worktree directory is missing for any reason (pruned post-merge, accidentally deleted, never created), the only correct verdict is `VALIDATION FAIL` with `Reason: No worktree found at worktrees/GH-NNN`. The caller will route to impl, human attention, or re-create the worktree as appropriate.

**Worktree freshness check**: Once the worktree is located, compare its branch against `origin/main` before running validation so checks don't pass against a stale base. We compare against `origin/main` explicitly because `git pull --ff-only` without a refspec pulls from the branch's tracked upstream, not from main — so it only proves the feature branch matches its own remote, not that the implementation is current with main.

```bash
cd worktrees/GH-NNN
git fetch origin main
behind=$(git rev-list --count HEAD..origin/main)
if [ "$behind" -gt 0 ]; then
  echo "STALENESS: worktree is $behind commits behind origin/main — record as substantive failure note"
fi
```

If `behind > 0`, record the staleness as a substantive failure note (e.g. `- [!] worktree is N commits behind origin/main — rebase before re-validating`) but continue validation. Do NOT auto-merge or rebase — surface it in the verdict so the caller can route to impl/human resolution. Skip the comparison if the worktree branch is detached or if `git rev-list` errors (no upstream/main reference resolvable).

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

## Step 7.0: Classify Verdict (optional delegation)

When delegation is enabled (`RALPH_DELEGATE_ENABLED=true`), the plan's `## Desired End State` snippet + the per-check summary (from Step 6) + the drift analysis summary (from Step 6.5) + the cross-phase integration result (from Step 6.6) are sent to a local LLM via the wrapper at `$CLAUDE_PLUGIN_ROOT/scripts/` (task name `val_classify`), which returns a strict 3-value enum (`pass`|`fail`|`needs-review`). The skill **cross-checks** the enum against the automated-check results — the delegate is advisory, not authoritative — and uses the result to inform the verdict-prefix selection in Step 7 below. Everything else (the `### Automated Checks` per-check list, the `### Drift Analysis`, the `### Cross-Phase Integration`, the `Verdict:` line, the failure-detail sections, the `create_comment` MCP call) is composed and invoked natively. Delegation is opt-in (operator sets the env var); when off, the skill classifies natively as today.

**Delegation is for classification only.** The verdict body (per-check list, drift analysis, cross-phase integration, fix-command list, substantive-failure detail list) is composed natively in Step 7. The `create_comment` MCP call in Step 8 is invoked natively in all cases — the delegate's output is text-in for the verdict-prefix selection and nothing else. Never let delegated text reach the comment body or any GitHub mutation. (See `skills/shared/delegation-conventions.md` for the eligibility matrix and the no-mutation rule.)

The `VERDICT_PREFIX` set here MUST be exactly one of `VALIDATION PASS`, `VALIDATION FIX`, or `VALIDATION FAIL` (the literal tokens the `val-postcondition.sh` Stop hook accepts). The skill MUST NOT substitute alternate vocabulary — see Step 7's "Verdict format (strict)" section. This guards against the delegate's `rationale` field leaking into the verdict prefix.

Operators may pin a different model for this task via `RALPH_DELEGATE_VAL_CLASSIFY_URL` / `RALPH_DELEGATE_VAL_CLASSIFY_MODEL`. The wrapper resolves per-task overrides without code changes here (F1's `_resolve_task_var` upper-cases `val_classify` → `VAL_CLASSIFY`).

Run the following bash block. The control flow (`set +e`, `if OUTPUT=$(...)`, `case "$rc"`, unconditional `rm -f`) mirrors the reference pattern in `skills/delegate-test/SKILL.md`, F4a's `agents/codebase-locator.md` § "Candidate Ranking", and F4b's `skills/ralph-pr/SKILL.md` § "Step 5.0". Task-specific deviations: (a) **threshold gate** counts checks (`total_checks >= 2 AND failed_checks >= 1`), (b) **strict 3-value enum JSON guard** via `jq -er .classification` + bash `case` statement instead of `jq -e .ranked` or byte-length prose guards, (c) **cross-check rule** — delegate is advisory; inconsistency with automated checks triggers native fallback, (d) `--max-tokens 128 --temperature 0.0` (small budget for the enum response).

```bash
# --- Inputs (set from the prior steps' context) ---
#   TOTAL_CHECKS              — total automated checks run (Step 6)
#   FAILED_CHECKS             — number of failed checks (Step 6)
#   SUBSTANTIVE_FAILURES      — number of substantive failures (Step 7's
#                               in-context mechanical/substantive classification,
#                               which runs regardless of delegation)
#   DESIRED_END_STATE_SNIPPET — first paragraph of the plan's ## Desired End State
#   PER_CHECK_SUMMARY         — compact per-check summary, one line per check,
#                               max 30 lines: "- <name>: PASS|FAIL [<reason>]"
#   DRIFT_SUMMARY             — one line per phase from Step 6.5, max 10 lines
#   CROSS_PHASE_RESULT        — one line summary from Step 6.6
#
# Output: VERDICT_PREFIX — exactly one of:
#   VALIDATION PASS | VALIDATION FIX | VALIDATION FAIL

TOTAL_CHECKS=${TOTAL_CHECKS:-0}
FAILED_CHECKS=${FAILED_CHECKS:-0}
SUBSTANTIVE_FAILURES=${SUBSTANTIVE_FAILURES:-0}

# --- Threshold gate (Constraint #10: >=2 checks AND >=1 failure) ---
if [ "$TOTAL_CHECKS" -lt 2 ] || [ "$FAILED_CHECKS" -eq 0 ]; then
    # Below threshold — compose natively, skip delegation entirely. All-pass
    # case is deterministic: VALIDATION PASS. No wrapper call, no tempfile,
    # no audit-log line.
    VERDICT_PREFIX="VALIDATION PASS"
else
    # --- Threshold met — build prompt and try delegation ---
    PROMPT_FILE=$(mktemp -t val-classify-XXXXXX)
    cat > "$PROMPT_FILE" <<EOF
You are classifying the outcome of an automated validation run.

Desired end state (from the plan):
${DESIRED_END_STATE_SNIPPET}

Per-check results (PASS|FAIL [reason]):
${PER_CHECK_SUMMARY}

Drift analysis summary:
${DRIFT_SUMMARY}

Cross-phase integration:
${CROSS_PHASE_RESULT}

Return a JSON object with this exact shape — no prose before or after:
{"classification": "pass" | "fail" | "needs-review", "rationale": "<one-sentence>"}

Rules:
- "pass" when every check is PASS and the desired end state is satisfied.
- "fail" when at least one check FAILed.
- "needs-review" only if the result is genuinely ambiguous (e.g., a check
  could not run or the desired end state is unclear).
EOF

    # 8 KB prompt size cap (Constraint #11). If over, truncate the per-check
    # summary block (the longest typically) first. If still over after
    # truncation, fall back to native.
    PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
    if [ "$PROMPT_BYTES" -gt 8192 ]; then
        TRUNCATED_PER_CHECK=$(printf '%s' "$PER_CHECK_SUMMARY" | head -c 4096)
        cat > "$PROMPT_FILE" <<EOF
You are classifying the outcome of an automated validation run.

Desired end state (from the plan):
${DESIRED_END_STATE_SNIPPET}

Per-check results (PASS|FAIL [reason]):
${TRUNCATED_PER_CHECK}

Drift analysis summary:
${DRIFT_SUMMARY}

Cross-phase integration:
${CROSS_PHASE_RESULT}

Return a JSON object with this exact shape — no prose before or after:
{"classification": "pass" | "fail" | "needs-review", "rationale": "<one-sentence>"}

Rules:
- "pass" when every check is PASS and the desired end state is satisfied.
- "fail" when at least one check FAILed.
- "needs-review" only if the result is genuinely ambiguous (e.g., a check
  could not run or the desired end state is unclear).
EOF
        PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" | tr -d ' ')
    fi

    if [ "$PROMPT_BYTES" -gt 8192 ]; then
        # Still oversized — fall back to native without invoking the wrapper.
        # Native classification: any substantive failure → FAIL; only
        # mechanical failures → FIX; all pass → PASS (the existing Step 7
        # logic).
        if [ "$SUBSTANTIVE_FAILURES" -gt 0 ]; then
            VERDICT_PREFIX="VALIDATION FAIL"
        else
            VERDICT_PREFIX="VALIDATION FIX"
        fi
        rm -f "$PROMPT_FILE"
    else
        # Default native value — overwritten only if the delegate path returns
        # a shape-valid + cross-check-passing classification below.
        if [ "$SUBSTANTIVE_FAILURES" -gt 0 ]; then
            VERDICT_PREFIX="VALIDATION FAIL"
        else
            VERDICT_PREFIX="VALIDATION FIX"
        fi

        set +e
        if OUTPUT=$("$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" \
                      --task val_classify \
                      --prompt-file "$PROMPT_FILE" \
                      --max-tokens 128 \
                      --temperature 0.0 2>/dev/null); then
            # Wrapper succeeded at HTTP. Validate the response shape in two
            # stages: (1) jq -er .classification extracts the field; (2) a
            # bash case statement restricts the value to exactly the three
            # accepted tokens (pass|fail|needs-review). Any other value is
            # treated as bad-shape and falls back.
            CLASSIFICATION=$(printf '%s' "$OUTPUT" | jq -er .classification 2>/dev/null)
            jq_rc=$?
            if [ "$jq_rc" -ne 0 ]; then
                echo "delegation: fell back to native (rc=0, bad-shape)"
            else
                case "$CLASSIFICATION" in
                    pass)
                        # Cross-check (Constraint #9): delegate=pass is only
                        # consistent when SUBSTANTIVE_FAILURES==0. If a
                        # substantive failure was recorded, fall back.
                        if [ "$SUBSTANTIVE_FAILURES" -gt 0 ]; then
                            echo "delegation: cross-check failed (delegate=pass, substantive_failures=$SUBSTANTIVE_FAILURES) — falling back to native"
                        else
                            VERDICT_PREFIX="VALIDATION PASS"
                        fi
                        ;;
                    fail)
                        # Cross-check (Constraint #9): delegate=fail is only
                        # consistent when FAILED_CHECKS>0 (which the threshold
                        # gate already enforces). If somehow no checks failed,
                        # fall back.
                        if [ "$FAILED_CHECKS" -eq 0 ]; then
                            echo "delegation: cross-check failed (delegate=fail, failed_checks=0) — falling back to native"
                        else
                            # Map gross fail to FIX vs FAIL via the native
                            # mechanical/substantive routing (Constraint #13).
                            if [ "$SUBSTANTIVE_FAILURES" -gt 0 ]; then
                                VERDICT_PREFIX="VALIDATION FAIL"
                            else
                                VERDICT_PREFIX="VALIDATION FIX"
                            fi
                        fi
                        ;;
                    needs-review)
                        # Delegate explicitly admitted uncertainty — fall back.
                        echo "delegation: needs-review — falling back to native"
                        ;;
                    *)
                        # Enum guard tripped — fall back.
                        echo "delegation: fell back to native (rc=0, bad-shape)"
                        ;;
                esac
            fi
        else
            rc=$?
            case "$rc" in
                126) ;; # disabled — compose natively, no note printed
                127|124|1) echo "delegation: fell back to native (rc=$rc)" ;;
            esac
        fi
        set -e

        rm -f "$PROMPT_FILE"
    fi
fi
```

After this block, `VERDICT_PREFIX` holds exactly one of `VALIDATION PASS`, `VALIDATION FIX`, or `VALIDATION FAIL`. Step 7 below uses `${VERDICT_PREFIX}` as the first line of the verdict block; every other line of the verdict body is composed natively per the existing Step 7 templates.

## Step 7: Produce Verdict

Classify each failure (mechanical-vs-substantive) and use the `${VERDICT_PREFIX}` set by Step 7.0 as the first line of the verdict block. The mechanical-vs-substantive classification feeds the in-context routing that Step 7.0's bash block consumes via `SUBSTANTIVE_FAILURES`; the `${VERDICT_PREFIX}` value is what the verdict line starts with.

**Failure classification:**
- **Mechanical**: has a deterministic auto-fix — formatter (`prettier --write`), linter (`eslint --fix`), missing trailing newline, import sorting. No judgment needed.
- **Substantive**: tests fail, missing functionality, wrong behavior, missing files the plan requires. Requires implementation work.

**Verdict rules** (these are the same rules Step 7.0's native fallback applies; Step 7.0's delegated path produces a `${VERDICT_PREFIX}` that is consistent with these rules after the cross-check guard):
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

Do NOT substitute other status words (e.g. `BLOCKED`, `COMPLETE`, `Phase Assessment`, `Status: ❌`). These are not recognized by `val-postcondition.sh` and will cause the Stop hook to block. Use the literal `VALIDATION PASS|FIX|FAIL` prefix verbatim — no emoji, no bold, no alternate vocabulary. The first line of the verdict report MUST be `${VERDICT_PREFIX}` (set by Step 7.0); the skill MUST NOT recompute the prefix in-context.

Output the validation report:

```
${VERDICT_PREFIX}
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

## Step 7.5: Record Outcome Event

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/outcome-recorder.md

Based on `${VERDICT_PREFIX}` (set by Step 7.0), call `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome` with:
- `event_type`: `"validation_passed"` when `VERDICT_PREFIX` is `VALIDATION PASS`; `"validation_failed"` when `VERDICT_PREFIX` is `VALIDATION FIX` or `VALIDATION FAIL`
- `issue_number`: the issue number (NNN)
- `verdict`: the literal `${VERDICT_PREFIX}` value (one of: `"VALIDATION PASS"`, `"VALIDATION FIX"`, `"VALIDATION FAIL"`)
- `payload`: `{ "total_checks": <TOTAL_CHECKS>, "failed_checks": <FAILED_CHECKS>, "substantive_failures": <SUBSTANTIVE_FAILURES> }`

This step runs on all three verdict paths (PASS, FIX, FAIL). A recorder failure does NOT prevent Step 8 (Post Comment) or the `val-postcondition.sh` Stop hook from succeeding.

If the MCP call fails, log to stderr (`echo "outcome-record failed: ..." >&2`) and continue to Step 8.

## Step 8: Post GitHub Comment

Post the validation report as a GitHub comment on the issue. Use the header `## Validation` to follow Artifact Comment Protocol.

## Notes

- Do NOT change workflow state — integrator handles that based on verdict
- Do NOT fix issues yourself — report the verdict and let the caller route to impl for fixes
- Run all checks even after first failure (collect full picture)
- If a command times out or errors unexpectedly, count it as FAIL with the error details
- Focus on automated checks only; do not try to interpret code quality subjectively
