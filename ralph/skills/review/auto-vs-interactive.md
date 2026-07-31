# Auto vs. Interactive

How `/ralph:review`'s default mode orchestrates val + code-review + merge + CI watch. Owns the depth-0 invocation contract for `code-review:code-review` and the `RALPH_REVIEW_MODE` switch between auto and prompted code-review-gate behavior.

## Depth-0 fan-out

**The `code-review:code-review` skill MUST be invoked inline via `Skill()` from default-mode**, NOT via `Agent()`.

Why: the `code-review:code-review` plugin spawns 5 parallel Sonnet reviewers + N parallel Haiku scorers via the `Agent` tool. Those parallel agents land at depth 1 only when the wrapping skill runs at depth 0. The Claude Code runtime forbids depth-2 `Agent` dispatch — so if `code-review:code-review` is invoked from inside an `Agent` context (depth 1), its internal parallel-reviewer `Agent` calls would land at depth 2 and silently break the fan-out.

Verified pattern (preserves the contract):

```
# Inside /ralph:review's default-mode body (running at depth 0):
Skill("code-review:code-review", "PR_NUMBER")
```

Anti-pattern (breaks fan-out):

```
# Dispatching the wrapping skill via Agent puts code-review at depth 1,
# its internal Agent calls land at depth 2, runtime drops them.
Agent(subagent_type="some-wrapper", prompt="Run code-review:code-review on PR_NUMBER")
```

This is why default-mode is `model: opus` at depth 0 — the depth-0 leaf must be top-tier because it owns the parallel-reviewer fan-out.

## Code Review Gate

Read the deterministic verdict via the helper:

```bash
verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)
```

The helper's stdout contract is exactly one of:

| Token | Meaning |
|---|---|
| `APPROVED` | Formal review approval OR self-authored clean pass. Continue to merge. |
| `NEEDS_FIX` | Formal `CHANGES_REQUESTED` OR self-authored code-review found issues. Run the Fix Cycle. |
| `BLOCKED` | Multi-author repo with no formal review and no self-authored fallback. Branch on `RALPH_REVIEW_MODE`. |
| `ERROR: <msg>` | Transient `gh` failure. Retry once. Still error → `FINISH BLOCKED`. |

Use a `case` statement, never if/elif chains — the helper's tokens are deterministic enums and `case` makes the exhaustiveness audit-able.

```bash
case "$verdict" in
  APPROVED)   ;;  # continue
  NEEDS_FIX)  ;;  # Step 3a
  BLOCKED)    ;;  # RALPH_REVIEW_MODE branch
  ERROR:*)    ;;  # retry once
esac
```

## `RALPH_REVIEW_MODE` switch

Orchestration knob — **NOT** a verb mode. Governs behavior when the Code Review Gate returns `BLOCKED`.

| Value | Behavior |
|---|---|
| `auto` (default; unset or `auto`) | Run code review inline without prompting: `Skill("code-review:code-review", "PR_NUMBER")`. After it completes, re-read the verdict ONCE and branch on the result. **2nd consecutive `BLOCKED` is terminal** (see below). |
| `interactive` (explicit opt-in: `RALPH_REVIEW_MODE=interactive`) | Prompt via `AskUserQuestion`: "This PR has no code review yet. Would you like to run one before merging?" Options: Run code review / Merge without review. Selected "Run code review" → inline `Skill()` invocation, then re-read once with the same 2nd-`BLOCKED`-is-terminal rule. Selected "Merge without review" → continue to merge. |

**Second-consecutive `BLOCKED` is terminal.** After running `code-review:code-review` inline, the re-read verdict can be:

- `APPROVED` → continue to merge.
- `NEEDS_FIX` → Code Review Fix Cycle (max 1, see §Code Review Fix Cycle).
- `BLOCKED` (still) → STOP with `FINISH BLOCKED — Code review did not produce a verdict and no self-authored fallback applies`. **Do NOT re-loop into another `code-review:code-review` invocation.** `code-review:code-review` posts comments but cannot mutate `reviewDecision`; on multi-author PRs with no formal review, the verdict will remain `BLOCKED` forever — looping would be unbounded.
- `ERROR: *` → retry once. Still error → STOP with `FINISH BLOCKED <error>`.

Distinct from `--mode val|code|merge` which selects a leaf verb. The switch is consumed only in default-mode's Step 3 BLOCKED branch.

## Code Review Fix Cycle

**Max 1 cycle in default-mode.** When the gate returns `NEEDS_FIX`:

1. Dispatch impl-agent in Address Mode:
   ```
   Agent(subagent_type="ralph:impl-agent", prompt="Address PR review feedback for GH-NNN. The automated code review flagged issues on PR #PR_NUMBER. Fix MUST_FIX + SHOULD_FIX items, push, reply to comments. Follow the Address Mode procedure in ${CLAUDE_PLUGIN_ROOT}/skills/impl/address-mode.md exactly.")
   ```
2. Re-invoke code review ONCE: `Skill("code-review:code-review", "PR_NUMBER")`.
3. Re-read the verdict via the helper.
4. If still `NEEDS_FIX` → STOP `FINISH BLOCKED — Code review feedback unresolved after 1 fix cycle`.

**Three rounds is the leaf's prerogative.** `/ralph:review --mode code` loops up to 3 rounds because the leaf owns the multi-round contract (per [code-review-prompt.md §Loop invariants](code-review-prompt.md)). The orchestrator does ONE fix cycle then escalates — preserves the boundary: orchestrator does not own the multi-round loop.

Caller's option to escalate further: re-run `/ralph:review --mode code #NNN` directly, which starts fresh at Round 1 of 3 in the leaf's own loop.

## `code-review:code-review` not installed

If the plugin isn't installed, the BLOCKED branch (both auto and interactive) prompts:

```
This PR has no code review. Consider installing the code-review plugin:
  claude plugins install @anthropic/code-review
```

Then present:

```
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
```

- "Merge without review" → continue to Step 5.
- "Stop" / "Other" → STOP.

This is the only place in default-mode where the absence of `code-review:code-review` produces a user-visible prompt; the gate auto-skips when the helper reports `APPROVED` for self-authored clean PRs even without the plugin installed.

## Verdict tokens (strict)

Default-mode's own terminals:

| Token | Meaning |
|---|---|
| `FINISHED` | Close-out succeeded end-to-end. CI verdict appended. |
| `FINISH BLOCKED — <reason>` | Validation, code review, merge, or CI gate failed. |

Plus inherited terminals from the leaves (val/code/merge): `VALIDATION PASS|FAIL`, `CODE REVIEW PASSED|ESCALATED`, `MERGED`, `MERGE BLOCKED|NOT READY`. `closeout-postcondition.sh` accepts the union.
