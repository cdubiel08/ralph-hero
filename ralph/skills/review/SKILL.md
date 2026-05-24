---
description: Validate an implementation against its plan, run code review, merge an approved PR, or do the full close-out (val → code-review → merge → CI watch). Use whenever the user says "review this", "validate the impl", "run code review", "merge the PR", "close the loop", "ship it", "finish #NNN", "is this ready to merge", "did the plan get fulfilled". Default mode runs the full close-out and owns the depth-0 fan-out for `code-review:code-review`. --mode val validates impl vs. plan with citation gate + drift log. --mode code runs the code-review-and-fix loop (up to 3 rounds). --mode merge is merge-only mechanics (refuses unreviewed PRs).
argument-hint: "[--mode val|code|merge] [<issue-number>] [--pr-url <url>] [--plan-doc <path>]"
context: inline
model: opus
hooks:
  SessionStart:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=review RALPH_VALID_OUTPUT_STATES='In Review,Done,Human Needed'"
  PreToolUse:
    - matcher: "mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue|mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-state-gate.sh"
    - matcher: "Bash"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/closeout-scout-gate.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/merge-review-decision-gate.sh"
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/closeout-postcondition.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/lock-release-on-failure.sh"
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/doc-structure-validator.sh"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Skill
  - Agent
  - Monitor
  - AskUserQuestion
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_dependencies
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__advance_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome
---

# /ralph:review — Close-out the loop

Validates, reviews, and merges completed implementations. Four modes share substrate (PR readiness, terminal verdicts, state transitions) but route to distinct workflow bodies. Default mode owns depth-0 fan-out for `code-review:code-review`.

| Mode | Trigger | Role |
|---|---|---|
| **default** | `/ralph:review #NNN` | Full close-out: val → code-review → merge → CI watch. Orchestrator. |
| **val** | `/ralph:review --mode val [#NNN]` | Validate impl against plan — citation gate, drift log, cross-phase integration |
| **code** | `/ralph:review --mode code [#NNN]` | Run code-review + impl-agent fix loop (up to 3 rounds), escalate on exhaustion |
| **merge** | `/ralph:review --mode merge [#NNN]` | Merge-only mechanics. Refuses unreviewed PRs even when caller skipped default. |

References: [plan-vs-impl-rubric.md](plan-vs-impl-rubric.md) (val rubric: citation gate, drift, integration), [code-review-prompt.md](code-review-prompt.md) (code-review loop invariants + escalation), [merge-gate.md](merge-gate.md) (pre-merge gates, CI watch, cross-repo, scout report), [auto-vs-interactive.md](auto-vs-interactive.md) (depth-0 fan-out, `RALPH_REVIEW_MODE` switch, fix-cycle bound).

## Step 0: Parse arguments

**`--auto` alias** — resolve BEFORE `--loop` detection. See `ralph/skills/shared/auto-alias.md`:
- If `--auto` in `$ARGUMENTS` AND `--mode` also present → emit `--auto cannot be combined with explicit --mode; pick one.` and STOP.
- If `--auto` in `$ARGUMENTS` → strip `--auto` token from `$ARGUMENTS` only (verb=review: default mode is already autonomous; no mode flag prepended). Continue to `--loop` detection with the rewritten args.

**`--loop` gate** — run the arg-parsing snippet from `ralph/skills/shared/loop-wrapper.md` § Arg-parsing snippet (sets `LOOP_RAW`, `LOOP_INTERVAL`, `STRIPPED_ARGS`). All review modes are queue-drainers — `--loop` is accepted for all. If `LOOP_RAW` is set:
- MODE `default` → `Skill("loop", …)` via `review:default` row + continuation-prompt template from `loop-wrapper.md`, then STOP.
- MODE `val` → `review:val` row; `code` → `review:code` row; `merge` → `review:merge` row. In each case: STOP after emitting `Skill("loop", …)`.

Resolve `MODE`, `TARGET`, optional flags from args:

- no args → `MODE=default`, prompt for `TARGET`
- `#NNN` / `NNN` → `MODE=default`, `TARGET=NNN`
- `--mode val [#NNN]` → `MODE=val`, `TARGET=NNN` or queue-pick
- `--mode code [#NNN]` → `MODE=code`, `TARGET=NNN` or queue-pick
- `--mode merge [#NNN]` → `MODE=merge`, `TARGET=NNN` or queue-pick
- `--pr-url <url>` → forward to merge-mode and default-mode (skips PR discovery)
- `--plan-doc <path>` → forward to val-mode + default-mode (Artifact Passthrough)

Export `RALPH_TICKET_ID="GH-${TARGET}"` when `TARGET` is an issue number.

## Default mode — full close-out

1. **Parse args + fetch issue + find PR** — same shape as merge-mode Steps 1-2. STOP `FINISH BLOCKED — wrong state` if not "In Review"; STOP `FINISH BLOCKED — no PR` if PR not found.
2. **Validate** — `Agent(subagent_type="ralph-hero:val-agent", prompt="Validate GH-NNN. Plan doc: ...")`. Parse verdict: `VALIDATION PASS` → continue; `VALIDATION FIX` → dispatch impl-agent for mechanical fixes (1 cycle max), re-run val; `VALIDATION FAIL` → STOP `FINISH BLOCKED`.
3. **Code Review Gate** — `verdict=$(bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/finish-review-verdict.sh PR_NUMBER)`. Branch per [auto-vs-interactive.md §Code Review Gate](auto-vs-interactive.md):
   - `APPROVED` → continue to merge.
   - `NEEDS_FIX` → Step 3a.
   - `BLOCKED` → branch on `RALPH_REVIEW_MODE` per [§RALPH_REVIEW_MODE switch](auto-vs-interactive.md): `auto` invokes `Skill("code-review:code-review", "PR_NUMBER")` inline (preserves [§Depth-0 fan-out](auto-vs-interactive.md)); `interactive` (default) prompts via `AskUserQuestion`. Re-read verdict ONCE; **2nd consecutive `BLOCKED` → STOP `FINISH BLOCKED — Code review did not produce a verdict and no self-authored fallback applies`** (do NOT re-loop; `code-review:code-review` posts comments but cannot mutate `reviewDecision`, so a persistent `BLOCKED` would loop forever). See [auto-vs-interactive.md §RALPH_REVIEW_MODE switch](auto-vs-interactive.md) for the full terminal table.
   - `ERROR: *` → retry once, then `FINISH BLOCKED`.
4. **Step 3a: Code Review Fix Cycle (max 1)** — per [§Code Review Fix Cycle](auto-vs-interactive.md): dispatch `Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback...")`, re-invoke `Skill("code-review:code-review", "PR_NUMBER")` once, re-read verdict. Still `NEEDS_FIX` → `FINISH BLOCKED — review unresolved after 1 fix cycle`. The orchestrator does NOT loop the leaf — that's `--mode code`'s 3-round prerogative.
5. **Merge** — `Agent(subagent_type="ralph-hero:merge-agent", prompt="Merge PR for GH-NNN. PR URL: <url>")`. Parse output: `MERGED` → continue; `MERGE BLOCKED|NOT READY` → STOP and report.
6. **CI Watch** — `Monitor` per [merge-gate.md §CI Watch](merge-gate.md). **Substitute `MERGE_SHA` literally** into the command string (Monitor subshell does NOT inherit shell vars). Parse last notification: `CI PASSED:` / `CI FAILED:` / `CI SKIPPED:` / no-terminal-line → `CI PENDING`.
7. **Report** — `FINISHED / Issue: #NNN / PR: <url> / Validation: PASS / Merge: Done / CI: <verdict>`.

## `--mode val` — validate impl vs. plan

1. **Parse args + select target** — `--mode val [#NNN] [--plan-doc <path>]`. Queue-pick when no `#NNN`: `list_issues(workflowState: "In Progress", limit: 10)`, first candidate with `worktrees/GH-NNN`. STOP with `VALIDATION PASS — no work\nQueue empty.` if none (BOTH lines required — postcondition hook + loop runner).
2. **Fetch issue + find plan + find worktree** — per [plan-vs-impl-rubric.md §Plan discovery](plan-vs-impl-rubric.md) (Artifact Comment Protocol → glob fallback). STOP with `VALIDATION FAIL` if no plan or no worktree. NEVER fall back to main (see §Worktree-or-fail anti-pattern).
3. **Worktree freshness** — `git fetch origin main && git rev-list --count HEAD..origin/main`; staleness recorded as a substantive failure note (no auto-rebase).
4. **Extract criteria** — parse plan for `## Desired End State` + per-phase `### Success Criteria > #### Automated Verification` checkboxes.
5. **Run checks** — from worktree, per check: file existence / command execution / content check. Apply [§Citation Gate](plan-vs-impl-rubric.md) — quote offending file lines verbatim before claiming any content failure.
6. **Drift + cross-phase** — per [§Drift Analysis](plan-vs-impl-rubric.md) and [§Cross-Phase Integration](plan-vs-impl-rubric.md).
7. **Classify verdict** — optional delegation per [§Delegation](plan-vs-impl-rubric.md) (threshold gate ≥2 checks AND ≥1 failure; strict enum cross-checked against automated results).
8. **Emit verdict** — `VALIDATION PASS` (all green) / `VALIDATION FIX` (mechanical only) / `VALIDATION FAIL` (substantive). Post a `## Validation Report` comment via `create_comment`. Record outcome via `knowledge_record_outcome(event_type="validation", verdict, ...)`.

## `--mode code` — code-review-and-fix loop

1. **Select issue** — arg or queue-pick (`list_issues(workflowState: "In Review", limit: 10)`, first with open PR). STOP with literal `Queue empty.` if none. Initialize `ROUND=1`, `MAX_ROUNDS=3`.
2. **Find PR** — `gh pr list --head feature/GH-NNN --json number,url,state`. STOP `CODE REVIEW BLOCKED — no open PR` if none.
3. **Check existing review state** — per [code-review-prompt.md §Pre-loop short-circuits](code-review-prompt.md): `APPROVED` → STOP clean; human `CHANGES_REQUESTED` → STOP blocked (human owns resolution).
4. **Run code review (round N of 3)** — per [§Loop invariants](code-review-prompt.md): snapshot `BEFORE_COUNT` via `gh pr view PR_NUMBER --json comments --jq '.comments | length'`, invoke `Skill("code-review:code-review", "PR_NUMBER")`, re-query `AFTER_COUNT` (identical command). If equal → clean (STOP `CODE REVIEW PASSED`); else proceed.
5. **Address feedback** — dispatch `Agent(subagent_type="ralph-hero:impl-agent", prompt="Address PR review feedback for #NNN — Address Mode")`. Wait for return.
6. **Re-review loop** — `ROUND=$((ROUND + 1))`. If `<= MAX_ROUNDS` → return to Step 4. Else escalate per [§Escalation Protocol](code-review-prompt.md): post BOTH `## Code Review` round-by-round summary AND canonical `## Escalation` comments; `save_issue(workflowState="__ESCALATE__", command="ralph_code_review")`.
7. **Report** — `CODE REVIEW PASSED` (clean) / `CODE REVIEW ESCALATED` (3 rounds exhausted). Record outcome via `knowledge_record_outcome(event_type="pr_review_decision", verdict, ...)`.

## `--mode merge` — merge mechanics

1. **Select issue** — arg or queue-pick per [merge-gate.md §Queue-pick](merge-gate.md). STOP `Queue empty.` if none.
2. **Fetch issue + find PR** — `gh pr list --head feature/GH-NNN` or use `--pr-url`. STOP `MERGE NOT READY` if not found.
3. **Pre-merge gates** — per [merge-gate.md §Pre-merge gates](merge-gate.md):
   - Review decision MUST be `APPROVED` (`null`/`REVIEW_REQUIRED` → `MERGE BLOCKED — review required`). Two carve-outs accept non-APPROVED PRs: XS-no-comments and self-authored-on-solo-repo (see [merge-gate.md §Carve-outs](merge-gate.md)). The deterministic gate lives in `merge-review-decision-gate.sh` PreToolUse:Bash hook.
   - Mergeable MUST be `MERGEABLE` (`CONFLICTING` → `MERGE BLOCKED — conflicts`).
   - Scout Report gate enforced by `closeout-scout-gate.sh` PreToolUse on the merge Bash command (no body duplication needed).
   - **When `RALPH_AUTO_MERGE=true`** (loop-runner autonomous merge), the three-criterion gate in [merge-gate.md §Autonomous mode](merge-gate.md) replaces this step. Failures emit `AUTO-MERGE BLOCKED` so the next loop tick can re-evaluate without a fix cycle.
4. **Merge** — `bash scripts/merge-pr.sh PR_NUMBER`. Capture `MERGE_SHA` via `gh pr view PR_NUMBER --json mergeCommit --jq '.mergeCommit.oid'`.
5. **Worktree cleanup** — `git worktree remove worktrees/GH-NNN --force`. Cross-repo: remove sibling worktrees per [merge-gate.md §Cross-repo](merge-gate.md).
6. **Transition issue to Done** — `save_issue(workflowState="__CLOSE__", command="ralph_merge")` (the `__CLOSE__` semantic intent maps `"*": "Done"` per `state-resolution.ts`). Group merges: per-child transition. Do NOT advance parent (server-side GH Action handles it — see [§Parent advancement](merge-gate.md)).
7. **Cross-repo unblock** — per [§Cross-repo](merge-gate.md): identify sibling repos with `awaits` dependency on this issue; advance / comment per registry `dependency-flow`.
8. **Post artifact comment + record outcome** — `## Merged` comment with URL + SHA. `knowledge_record_outcome(event_type="pr_merged", ...)`.
9. **Report** — `MERGED / Issue: #NNN / PR: <url> / SHA: <sha>`. Merge-mode terminates here; default-mode continues to CI watch.

## Link Formatting

!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/link-formatting.md
