---
date: 2026-02-17
status: needs-iteration
type: critique
plan_document: thoughts/shared/plans/2026-02-17-plan-3-skill-autonomy-self-validation.md
---

# Plan 3 Review: Skill Autonomy & Self-Validation - Devil's Advocate Critique

## Verdict: NEEDS ITERATION

The plan's goals are sound: skills should be self-validating, agents should be thin wrappers, and postconditions should enforce artifact creation. However, there are **3 critical bugs** that would break functionality if implemented as written, **7 significant issues** requiring plan corrections, and **4 warnings**. Most are fixable without restructuring phases, but Phase 2 and Phase 4 need concrete corrections before implementation.

---

## Blocking Issues

### B1: Phase 2 - `plan-research-required.sh` Registered on Wrong Matcher

**Severity**: Critical (would be a silent no-op)
**Phase affected**: 2

The plan registers `plan-research-required.sh` under the `ralph_hero__update_workflow_state` matcher:

```yaml
- matcher: "ralph_hero__update_workflow_state"
  hooks:
    - type: command
      command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/convergence-gate.sh"
    - type: command
      command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
```

But `plan-research-required.sh` (lines 16-19) parses `.tool_input.file_path`:

```bash
file_path=$(get_field '.tool_input.file_path')
if [[ "$file_path" != *"/plans/"* ]]; then
  allow
fi
```

The `update_workflow_state` tool input has `number`, `state`, `command` -- no `file_path`. So `file_path` would be empty, the condition `"" != *"/plans/"*` is TRUE, and the script immediately exits with `allow`. **The hook would be a complete no-op.**

The script is designed to trigger on the `Write` tool (checking if the write target is a plan file). It should be registered as:

```yaml
- matcher: "Write"
  hooks:
    - type: command
      command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/plan-research-required.sh"
```

**Fix**: Register on `Write` matcher, not `ralph_hero__update_workflow_state`.

### B2: Phase 4 - Researcher Agent Loses `Write` Tool

**Severity**: Critical (breaks research doc creation)
**Phase affected**: 4

The proposed `ralph-researcher.md` rewrite (plan line 344) has this tool list:

```
tools: Read, Glob, Grep, Skill, Task, Bash, TaskList, TaskGet, TaskUpdate, SendMessage, ralph_hero__*
```

The current `ralph-researcher.md` (line 4) includes `Write`:

```
tools: Read, Write, Glob, Grep, Skill, Task, Bash, ...
```

**The proposed rewrite drops `Write`.** When the researcher agent invokes `Skill(skill="ralph-hero:ralph-research")`, the skill runs within the agent's tool context. The research skill's Step 4 creates a research document via the `Write` tool. Without `Write` in the agent's tool list, this operation would be blocked.

**Evidence**: Current `ralph-researcher.md:4` includes `Write`. Proposed replacement (plan line 344) does not.

**Fix**: Add `Write` back to the researcher agent's tool list.

### B3: Phase 4 - Triager and Planner Agents Lose Required Tools

**Severity**: High (potential regressions in multiple workflows)
**Phase affected**: 4

**Triager**: The proposed rewrite removes `ralph_hero__update_priority` and `ralph_hero__list_dependencies` from the tool list.

- `update_priority` is used during triage to set/change issue priority (triage SKILL.md doesn't restrict this)
- `list_dependencies` is needed to check existing dependency chains before adding new ones (Step 5 of triage)
- Removing `list_dependencies` while keeping `add_dependency` is inconsistent -- you can add but never verify existing dependencies

**Planner**: The proposed rewrite removes `ralph_hero__list_sub_issues` and `ralph_hero__list_dependencies`.

- `list_sub_issues` may be needed when planning group issues that include sub-issues from splits
- `list_dependencies` is used to verify dependency chains during group context gathering (plan SKILL.md Step 2)

**Fix**: Preserve all current MCP tools in each agent's rewrite. Use the current tool lists as the baseline and only remove tools with explicit justification.

---

## Significant Issues

### S1: Phase 1 - Pipe `|` Matcher Syntax Unverified

**Severity**: Medium-High (could break Phase 1 entirely)
**Phase affected**: 1

The plan proposes this hooks.json matcher:

```json
"matcher": "ralph_hero__get_issue|ralph_hero__list_issues|ralph_hero__pick_actionable_issue"
```

All existing matchers in hooks.json are single tool names (e.g., `"ralph_hero__update_workflow_state"`, `"Bash"`, `"Write"`). The skill frontmatter also uses single names. **No existing hook uses pipe-separated matchers.** Claude Code's hook system may not support regex/pipe matching.

**Fix**: Either verify pipe syntax works, or register 3 separate matcher entries (one for each tool name). The separate entries approach is guaranteed to work based on existing patterns.

### S2: Phase 1 - `ralph_hero__pick_actionable_issue` Tool Doesn't Exist

**Severity**: Medium
**Phase affected**: 1

The proposed matcher includes `ralph_hero__pick_actionable_issue`, but this tool does not appear in the MCP server's tool definitions. The existing tools are: `get_issue`, `list_issues`, `update_issue`, `update_workflow_state`, `create_issue`, `create_comment`, `add_sub_issue`, `add_dependency`, `remove_dependency`, `list_sub_issues`, `list_dependencies`, `detect_group`, `update_estimate`, `update_priority`.

**Fix**: Remove `ralph_hero__pick_actionable_issue` from the matcher.

### S3: Phase 1 - Duplicate `ralph_hero__get_issue` Matcher in hooks.json

**Severity**: Medium
**Phase affected**: 1

hooks.json (line 19-26) already has a `ralph_hero__get_issue` PreToolUse matcher running `pre-ticket-lock-validator.sh`. Adding another matcher for the same tool creates two separate entries. The execution order of hooks from different matcher entries is undefined and could vary.

**Fix**: Document the expected execution order. Consider combining into one matcher entry with both hooks listed sequentially.

### S4: Phase 2 - Plan Misses 5+ Orphaned Hook Scripts

**Severity**: Medium
**Phase affected**: 2

The plan identifies 3 unregistered hooks (`plan-research-required.sh`, `research-no-dup.sh`, `plan-no-dup.sh`) and says to "Cross-check every hook script against skill frontmatter and hooks.json." But the full audit reveals **at least 5 additional orphaned scripts**:

| Orphaned Hook | Purpose | Expected Registration |
|---|---|---|
| `plan-verify-doc.sh` | PostToolUse: Verify plan doc structure | ralph-plan PostToolUse (Write) |
| `plan-verify-commit.sh` | PostToolUse: Verify git commit/push | ralph-plan PostToolUse (Bash) |
| `research-verify-doc.sh` | PostToolUse: Verify research doc structure | ralph-research PostToolUse (Write) |
| `state-gate.sh` | PreToolUse: Validate state transitions | Possibly superseded by per-skill state gates |
| `auto-state.sh` | PreToolUse: Resolve semantic intents to states | Should be in hooks.json (update_workflow_state) |

Notably, `auto-state.sh` resolves `__LOCK__`, `__COMPLETE__`, etc. to actual state names. If this is truly unregistered, semantic intents in all skills might be relying on the MCP server to resolve them, making this script dead code. OR the MCP server handles this server-side. This needs clarification -- if `auto-state.sh` should be registered, its absence is a pre-existing bug.

Also, `pre-artifact-validator.sh` (registered in hooks.json on `Write`) already does duplicate detection for research and plan docs. This **overlaps** with `research-no-dup.sh` and `plan-no-dup.sh`. Registering both would cause double-blocking on the same Write operation with confusingly similar error messages.

**Fix**: Complete the full orphan audit. Determine which scripts are dead code vs. missing registrations. Resolve the overlap between `pre-artifact-validator.sh` and the `*-no-dup.sh` scripts.

### S5: Phase 3 - Postcondition Assessment Partially Wrong

**Severity**: Medium
**Phase affected**: 3

The plan says postconditions "are often just warnings (exit 0) rather than blocks (exit 2)" and proposes upgrading them. But examining the actual scripts:

| Postcondition | Plan Says | Actual Behavior |
|---|---|---|
| `research-postcondition.sh` | "Should block if no research document" | **Already blocks** (line 23: `block "Research postcondition failed"`). Only uses `warn` for uncommitted doc (partial completion). |
| `plan-postcondition.sh` | "Should block if no plan document" | **Already blocks** (line 23: `block "Plan postcondition failed"`). Same warn pattern for uncommitted. |
| `review-postcondition.sh` | "Should block if no verdict" | **Already blocks** (line 77: `exit 2`). Has structured PASSED/FAILED/WARNINGS reporting. |
| `split-postcondition.sh` | "Should block if no sub-issues" | **Genuinely needs rewrite** -- currently a no-op that just prints and exits 0. Doesn't check if sub-issues were actually created. |
| `triage-postcondition.sh` | "Should block if no action taken" | **Genuinely needs rewrite** -- currently a no-op. Notes "Full validation would require GitHub API query." |
| `impl-postcondition.sh` | "Already upgraded in Plan 1" | Correct -- uses `block` for missing worktree, `warn` for no commits. |

Only 2 of 5 postconditions actually need the proposed upgrade (split and triage). The plan should scope Phase 3 to these two scripts. For split and triage, the work is larger than a warn-to-block swap -- they need fundamental logic additions to actually verify outcomes.

**Fix**: Narrow Phase 3 scope to `split-postcondition.sh` and `triage-postcondition.sh`. Acknowledge these need logic additions, not just exit code changes.

### S6: Phase 4 - Thin Wrappers Lose Important Edge Case Handling

**Severity**: Medium
**Phase affected**: 4

Current agent files contain domain-specific handling that the thin wrappers discard:

**Implementer**: Current file has "File Ownership Check" section (lines 37-39) instructing the agent to verify the skill only modified files in its assigned list and report conflicts. The thin wrapper has no such check.

**Planner**: Current file has "Handling Revision Requests" section (lines 59-62) for re-invoking the skill when the reviewer rejects. The thin wrapper says nothing about revision flow.

**Researcher/Planner/Reviewer**: Current files all have "hand off to next pipeline stage per shared/conventions.md" with explicit teammate lookup. The thin wrappers say "hand off per shared/conventions.md" but don't reference the team config reading step.

**Fix**: Either preserve these edge cases in the thin wrappers (adding ~5-10 lines each, still under 30 lines) or move them into the skills themselves. They shouldn't silently disappear.

### S7: Phase 4 - Agent Model Changes Not Justified

**Severity**: Low-Medium
**Phase affected**: 4

The proposed researcher agent changes `model: sonnet` -- matches current. But the proposed planner changes from current `model: opus` to... `model: opus` -- OK, same. Wait, looking more carefully at current triager: `model: sonnet`. Proposed: `model: sonnet`. OK.

Actually, the issue is that the plan doesn't mention model choices at all. The current model assignments are:
- researcher: sonnet, planner: opus, advocate: opus, implementer: sonnet, triager: sonnet

The proposed rewrites preserve these. This is fine, but should be explicitly noted since "thin wrapper" changes could easily accidentally change models.

---

## Warnings

### W1: Phase 5 - Fork Convention is Documentation-Only

The plan's "Current State Analysis" claims skills need `fork: true` in frontmatter, then acknowledges "There is no `fork: true` or equivalent." Phase 5 correctly lands on documenting a Task()-based workaround, which is the only current option. However, the overview (line 13) says "Skills default to being forked (running in isolated subprocesses)" which implies a behavior change, when Phase 5 is really just adding documentation.

**Recommendation**: Align the overview with Phase 5's actual scope -- this is a convention/documentation change, not a behavior change.

### W2: RALPH_TICKET_ID Lifecycle Gap

Multiple postcondition hooks depend on `RALPH_TICKET_ID` being set at runtime (research, plan, review, impl, triage, split postconditions all check it). But no SKILL.md env block sets it. It's presumably set by the skill during execution, but the plan's new `skill-precondition.sh` doesn't address this. If `RALPH_TICKET_ID` isn't set by the time postconditions run, they silently `allow` (short-circuit on empty check).

**Recommendation**: Document how RALPH_TICKET_ID gets set. Consider having skill-precondition.sh extract it from the first get_issue call and export it.

### W3: No Incremental Testing Strategy

The plan modifies hooks, agents, and skills simultaneously. A bad hook registration could silently break workflows. The Testing Strategy section lists unit and integration tests but doesn't describe incremental rollout (e.g., Phase 1 first, verify, then Phase 2, etc.).

**Recommendation**: Implement and verify each phase independently before proceeding to the next. Add a "verify current behavior unchanged" step between phases.

### W4: Stop Hook Blocking Could Create Infinite Loops

Phase 3 proposes making postcondition Stop hooks use `block` (exit 2) for missing artifacts. When a Stop hook returns exit 2, it prevents the agent from stopping and forces it to continue. If the agent genuinely cannot produce the missing artifact (e.g., GitHub API is down, env vars wrong), this creates an infinite loop: agent tries to stop -> hook blocks -> agent retries -> same failure -> tries to stop -> hook blocks...

**Recommendation**: Add a retry limit or fallback. After N blocked stop attempts, allow the stop with an error message. Or keep critical failures as `block` but add a `RALPH_FORCE_STOP` env var escape hatch.

---

## What's Good

- **Goals are well-motivated**: The problem statement accurately identifies that skills lack self-sufficient validation and agents are too thick. The current state analysis table (lines 21-28) is a useful audit.
- **Phase ordering is correct**: Universal precondition (Phase 1) -> artifact validation (Phase 2) -> postcondition upgrade (Phase 3) -> agent slimming (Phase 4) -> convention docs (Phase 5) is the right bottom-up order.
- **Scope exclusions are clear**: "What We're NOT Doing" correctly fences off spawn templates (Plan 2), memory layer (Plan 4), and MCP tools.
- **The thin-wrapper pattern is sound in principle**: Agents as identity + task-loop + skill-invocation is a clean separation. The execution issues are fixable without changing the architecture.
- **`skill-precondition.sh` concept is valuable**: A universal env-var check on first tool call catches configuration errors early, before skills waste time.
- **Success criteria are specific and testable**: "<30 lines per agent" and "standalone skill invocation works" are concrete, verifiable goals.

---

## Summary of Required Actions

| ID | Severity | Phase | Fix |
|----|----------|-------|-----|
| B1 | Critical | 2 | Register `plan-research-required.sh` on `Write` matcher, not `update_workflow_state` |
| B2 | Critical | 4 | Add `Write` back to researcher agent tool list |
| B3 | High | 4 | Preserve all current MCP tools in agent rewrites (don't remove update_priority, list_dependencies, list_sub_issues) |
| S1 | Medium-High | 1 | Verify pipe matcher syntax or use separate entries |
| S2 | Medium | 1 | Remove non-existent `pick_actionable_issue` from matcher |
| S3 | Medium | 1 | Address duplicate `get_issue` matcher in hooks.json |
| S4 | Medium | 2 | Complete full orphan audit; resolve overlap with `pre-artifact-validator.sh` |
| S5 | Medium | 3 | Narrow scope to split + triage postconditions only |
| S6 | Medium | 4 | Preserve edge case handling (file ownership, revision flow, handoff details) |
| S7 | Low-Medium | 4 | Explicitly note model preservation in plan |
| W1 | Low | 5 | Align overview with documentation-only scope |
| W2 | Low | All | Document RALPH_TICKET_ID lifecycle |
| W3 | Low | All | Add incremental verification between phases |
| W4 | Low | 3 | Add stop-hook retry limit or escape hatch |

**Recommendation**: Fix B1-B3 and S1-S6, then re-submit. The plan's architecture is sound but the implementation details have enough bugs to warrant a revision pass before coding begins.
