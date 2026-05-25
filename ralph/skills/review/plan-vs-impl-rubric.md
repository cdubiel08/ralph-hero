# Plan-vs-Impl Rubric

How `/ralph:review --mode val` validates that an implementation matches its plan. The verdict-token tokens (`VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL`) are load-bearing — `closeout-postcondition.sh` blocks Stop without one.

## Plan discovery

Use the **Artifact Comment Protocol** to locate the plan:

1. **`--plan-doc <path>`** override (Artifact Passthrough): use the path directly.
2. **Issue comments**: search for `## Implementation Plan` or any comment containing a path matching `thoughts/shared/plans/YYYY-MM-DD-GH-NNN-*.md`. Take the most recent if multiple.
3. **Glob fallback**: search `thoughts/shared/plans/*NNN*.md` and `thoughts/shared/plans/*GH-NNN*.md`. If found via glob only, self-heal by posting the missing `## Implementation Plan` comment.

If no plan resolves, emit:

```
VALIDATION FAIL
Issue: #NNN
Reason: No plan document found — cannot validate without a plan
```

And STOP. The `VALIDATION FAIL` prefix is the terminal token — emit it as the FIRST line of the verdict block (closeout-postcondition.sh grep is line-agnostic but the leading token is the convention).

## Worktree-or-fail

Validation runs against `worktrees/GH-NNN`. If the directory does not exist (pruned post-merge, never created, deleted), the verdict is **`VALIDATION FAIL`** with `Reason: No worktree found at worktrees/GH-NNN`. The hook (`closeout-postcondition.sh`) blocks any `VALIDATION PASS` emitted alongside a `Merged to main` note without a `worktrees/GH-` path token — the agent is forbidden from fabricating a "validate against main" fallback.

**Forbidden anti-pattern:**

```
VALIDATION PASS

Issue: #NNN
Plan: thoughts/shared/plans/...
Implementation: Merged to main
```

Two signals identify this as fabricated: (1) no `worktrees/GH-NNN` path is referenced, (2) verdict is `PASS` despite the absent worktree. The caller (orchestrator or human) decides what to do — re-create the worktree, route to impl, or close as obsolete. Validation's job is the verdict, not the remediation.

## Citation Gate

**Required for every file-content check.** Before claiming any file fails a content check, you MUST:

1. Run `cat <file>` (or equivalent read) from the worktree.
2. Quote the relevant lines verbatim in the verdict, inside a fenced code block.
3. State why the quoted content does or does not satisfy the plan criterion.

Inferring failures from plan text alone is **prohibited**. If you cannot read the file (missing, permission error), record that as the failure reason — not an inferred content assertion.

**Correct citation:**

````
- [ ] ralph/skills/review/SKILL.md ≤ 200 lines — FAIL

  Read from worktree:
  ```
  $ wc -l ralph/skills/review/SKILL.md
  237 ralph/skills/review/SKILL.md
  ```

  Plan requires SKILL.md ≤ 200 lines. 237 > 200, so the criterion is not satisfied.
````

**Anti-pattern (no citation, inferred):**

```
- [ ] SKILL.md — FAIL (probably over the line cap based on phase count)
```

Forbidden. The model is inferring from the plan body rather than reading the file.

## Drift Analysis

Search issue comments for `## Drift Log — Phase N` headers (posted by the impl phase's quality-review sub-agent). For each drift log:

1. Parse entries (lines starting with `- DRIFT:` or containing `DRIFT:` prefix).
2. Verify each minor drift's adaptation is consistent with plan intent.
3. Verify a `DRIFT:` commit message exists in `git log --oneline | grep "DRIFT:"`.
4. Flag any undocumented drift — files in `git diff --name-only <base>..HEAD` that aren't in any task's declared file list AND have no `DRIFT:` commit.

Emit a drift summary block:

```
Drift Analysis:
- Phase 1: 2 minor drifts (documented)
- Phase 2: 0 drifts
- Undocumented changes: none
```

If no drift logs exist on the issue, emit: `Drift Analysis: No drift logs found (clean implementation)`.

## Cross-Phase Integration

Skipped for single-phase plans. Multi-phase plans:

1. Verify each phase's "Creates for next phase" items exist in the worktree.
2. Check imports between phase outputs — if Phase 1 exports types used by Phase 2, verify the import paths resolve.
3. Run the plan's `## Integration Testing` section commands if present.

Emit an integration block:

```
Cross-Phase Integration:
- Phase 1 → Phase 2: types.ts exports used correctly ✓
- Phase 2 → Phase 3: parser.ts interface matches ✓
- Integration tests: 3/3 passing ✓
```

## Delegation

Opt-in via `RALPH_DELEGATE_ENABLED`. When enabled, the plan's `## Desired End State` snippet + per-check summary + drift summary + cross-phase result are sent to a local LLM via `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh` (task name `val_classify`). Returns a strict 3-value enum (`pass|fail|needs-review`).

**Threshold gate** (skip delegation when not worth it): `total_checks >= 2 AND failed_checks >= 1`. All-pass cases classify natively as `VALIDATION PASS`; below-threshold cases skip the wrapper call entirely.

**Cross-check rule**: delegate is advisory, not authoritative. Inconsistency with automated-check results triggers native fallback. Never let delegated text reach the comment body or any GitHub mutation — see `skills/shared/delegation-conventions.md` for the no-mutation rule.

**Wrapper invocation pattern** (the standard delegation-wrapper invocation, shown inline below):

```bash
set +e
if OUTPUT=$(bash "$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" \
              --task val_classify \
              --max-tokens 128 --temperature 0.0 \
              --prompt-file "$PROMPT_FILE" 2>/dev/null); then
    CLASSIFICATION=$(echo "$OUTPUT" | jq -er '.classification' 2>/dev/null || echo "")
    case "$CLASSIFICATION" in
        pass)          VERDICT_PREFIX="VALIDATION PASS" ;;
        fail)          VERDICT_PREFIX="VALIDATION FAIL" ;;
        needs-review)  VERDICT_PREFIX="VALIDATION FAIL" ;; # conservative
        *)             VERDICT_PREFIX="" ;; # native fallback
    esac
fi
rm -f "$PROMPT_FILE"
set -e
```

If the delegate is disabled (`RALPH_DELEGATE_ENABLED` unset), exits 126, or returns an unrecognized enum, the skill classifies natively from the per-check results. 8 KB prompt cap with per-check-summary truncation as fallback; over-cap after truncation falls back to native.

## Verdict tokens (strict)

The val-mode body MUST emit exactly one of:

| Token | Meaning |
|---|---|
| `VALIDATION PASS` | All checks green; desired end state satisfied. |
| `VALIDATION FIX` | Only mechanical failures (formatting, lint, auto-fixable). Default-mode orchestrator may dispatch a 1-cycle fix. |
| `VALIDATION FAIL` | Substantive failures (logic, behavior, missing files). Stops the close-out. |
| `Queue empty.` | No-work short-circuit from queue-pick path. Paired with `VALIDATION PASS — no work` synthetic verdict. |

No substitutes. `closeout-postcondition.sh` blocks Stop without one of these tokens in the transcript.
