# Eval Scenarios — `ralph-hero:unblock`

Each scenario describes a fixture state, the expected interactive skill behavior,
and pass/fail criteria. Scenarios are intended to be run manually (or via a
future automated harness) against a test repo configured with the ralph-hero
plugin. The interactive skill always involves a human at the keyboard answering
`AskUserQuestion` prompts; "expected behavior" describes the deterministic skill
behavior around those interactive moments.

---

## 1. `request-comment-present`

**Setup**:
- Issue #N is in workflow state `Human Needed`.
- Issue has a `## Escalation` comment (e.g., from `ralph_impl`) dated T0.
- Issue has a `## Unblock Request` comment dated T1 (T1 > T0) with 3 numbered
  questions.

**Expected behavior**:
- Skill is invoked as `/ralph-hero:unblock N`.
- Skill fetches issue, reads both `## Escalation` and `## Unblock Request`.
- Skill parses the 3 numbered questions verbatim.
- Skill walks the human through each question via `AskUserQuestion` (multiple-choice
  if the question enumerates options, freeform otherwise).
- Skill applies the originating-command heuristic and confirms return state.
- Skill posts `## Unblock Resolution` with all 3 Q&A pairs in order and the chosen
  routing state.
- Skill calls `save_issue(workflowState=<chosen>, command="ralph_unblock")`.
- Skill records `unblock_resolved` outcome event with `question_count: 3`.

**Pass criteria**:
- Resolution comment quotes each question and answer verbatim.
- Issue ends in the chosen state (one of the 4 re-entry states).
- Outcome event payload reflects the correct return state and question count.

---

## 2. `request-comment-absent`

**Setup**:
- Issue #N is in `Human Needed`.
- Issue has a `## Escalation` comment but no `## Unblock Request` (e.g., the user
  ran `/ralph-hero:unblock` directly without first running the autonomous variant).

**Expected behavior**:
- Skill notes absence of `## Unblock Request` and prints:
  `No \`## Unblock Request\` exists yet — I'll generate questions on the fly.
  To pre-generate, run \`/ralph-hero:ralph-unblock\` first next time.`
- Skill regenerates 1–5 questions inline grounded in the `## Escalation` text +
  issue body.
- Walks the human through the regenerated questions exactly as it would walk
  through pre-existing ones.
- Posts `## Unblock Resolution` with the regenerated Q&A and routing decision.
- Transitions state and records outcome event.

**Pass criteria**:
- The user-facing message about regeneration is rendered.
- Regenerated questions reference real material from `## Escalation` or issue body.
- Resolution comment + state transition behave identically to the
  `request-comment-present` scenario.

---

## 3. `originating-impl`

**Setup**:
- Issue #N has a `## Escalation` comment containing the phrase `during ralph_impl`.
- Skill is invoked as `/ralph-hero:unblock N`.

**Expected behavior**:
- Skill extracts `originating_command = "ralph_impl"`.
- Heuristic table maps `ralph_impl` → `In Progress` (default).
- Skill presents the 4-option `AskUserQuestion` confirmation with `In Progress`
  listed FIRST.
- Outcome event payload includes `originating_command: "ralph_impl"`.

**Pass criteria**:
- The confirmation picker shows `In Progress` as the first option.
- If the human accepts the default, the issue lands in `In Progress`.
- The `Routing to:` line in the resolution comment matches the user's pick.

---

## 4. `originating-research`

**Setup**:
- Issue #N has a `## Escalation` comment containing the phrase `ralph_research`.
- Skill is invoked as `/ralph-hero:unblock N`.

**Expected behavior**:
- Skill extracts `originating_command = "ralph_research"`.
- Heuristic table maps `ralph_research` → `Research Needed` (default).
- The confirmation picker presents `Research Needed` FIRST.
- Outcome event payload includes `originating_command: "ralph_research"` and
  `return_state: "Research Needed"` (assuming the human accepts the default).

**Pass criteria**:
- The confirmation picker bubbles `Research Needed` to position 1.
- The chosen state lands in the resolution comment and `save_issue` call.

---

## 5. `user-overrides-state`

**Setup**:
- Issue #N has a `## Escalation` from `ralph_impl` (heuristic suggests
  `In Progress`).
- The human picks `Backlog` at the routing confirmation prompt instead of the
  recommended default.

**Expected behavior**:
- Skill respects the user's choice — does NOT override it back to `In Progress`.
- Resolution comment renders `Routing to: \`Backlog\``.
- `save_issue` is called with `workflowState: "Backlog"`.
- Outcome event payload has `return_state: "Backlog"` and
  `originating_command: "ralph_impl"` (the heuristic suggestion is preserved
  in the payload as the originating command, but the actual return state
  reflects the human's override).

**Pass criteria**:
- Issue ends in `Backlog`, not `In Progress`.
- The resolution comment and outcome event both reflect the override.
- No warning or error is surfaced — the override is a normal flow.

---

## 6. `arg-omitted-multiple-candidates`

**Setup**:
- 3 issues are in `Human Needed` and each has a `## Unblock Request` comment.
- Skill is invoked as `/ralph-hero:unblock` (no arg).

**Expected behavior**:
- Skill calls `list_issues` for Human Needed, filters to those with
  `## Unblock Request`, and finds 3 candidates.
- Presents `AskUserQuestion` with one option per candidate, label format
  `"#NNN · <truncated title>"`.
- Description for each option names the originating skill (when extractable)
  and the age of the request.
- After the user picks, the rest of the workflow runs normally on the chosen
  issue.

**Pass criteria**:
- Picker presents exactly 3 options (one per candidate).
- Only the picked issue receives a `## Unblock Resolution` comment and a state
  transition.
- The other 2 issues remain unchanged.

---

## 7. `arg-omitted-single-candidate`

**Setup**:
- Exactly 1 issue is in `Human Needed` with a `## Unblock Request` comment.
- Skill is invoked as `/ralph-hero:unblock` (no arg).

**Expected behavior**:
- Skill detects the single candidate and auto-selects it (no picker friction).
- Prints `Selected #NNN: [Title]` and proceeds directly to Step 2.
- No `AskUserQuestion` picker is rendered for issue selection.

**Pass criteria**:
- The picker is skipped.
- The skill proceeds directly to question-walk on the single candidate.
- The auto-selection message is visible to the user.

---

## 8. `transition-blocked-by-gate`

**Setup**:
- Issue #N has all the right context (escalation, unblock request, answered
  questions).
- A buggy LLM (or a fixture-injected error) attempts
  `save_issue(workflowState="Done", command="ralph_unblock")`.

**Expected behavior**:
- The PostToolUse `unblock-state-gate.sh` hook inspects
  `tool_input.workflowState` and finds `Done` is NOT in the allowlist
  (`Backlog, Research Needed, Ready for Plan, In Progress, Human Needed`).
- Hook exits with code 2 and a stderr message naming the allowlist and
  the attempted state.
- The skill aborts subsequent steps — no outcome event is recorded with
  `return_state: "Done"`.
- Issue remains in `Human Needed` (the state-gate blocks the transition's
  forward effects on the skill, though the underlying GitHub mutation may
  have already executed; the gate is a skill-flow guard, not a transactional
  rollback).

**Pass criteria**:
- The hook stderr message clearly names the invalid state and the allowlist.
- The skill does not proceed to record an outcome event for an out-of-list
  return state.
- Re-running the skill on the issue lets the user re-attempt with a valid
  state.

**Regression coverage**: this scenario also exercises the Phase 1 wiring —
`human-needed-outbound-block.sh` allows the transition because
`RALPH_COMMAND=unblock`, but `unblock-state-gate.sh` then catches the
out-of-list target. The two hooks are complementary: outbound-block guards
which command may exit Human Needed; state-gate guards where it may go.
