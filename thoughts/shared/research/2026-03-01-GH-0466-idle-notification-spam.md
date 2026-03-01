---
date: 2026-03-01
github_issue: 466
github_url: https://github.com/cdubiel08/ralph-hero/issues/466
status: complete
type: research
---

# Research: GH-466 — Idle Notification Spam in Ralph-Team Sessions

## Problem Statement

Workers in `ralph-team` sessions generate excessive idle notifications, cluttering the team lead's coordination flow. The GH-451 session post-mortem observed the integrator sending 3 consecutive idle notifications, requiring active filtering by the team lead. This research identifies the root causes and current state of mitigations.

## Current State Analysis

### How Idle Notifications Are Generated

The `TeammateIdle` hook fires when a worker's agent turn ends without producing output. It routes through `team-teammate-idle.sh` ([`plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh)):

```bash
cat >&2 <<EOF
$TEAMMATE is idle. This is normal -- upstream stages may still be in progress.
EOF
exit 0
```

The hook itself is correct and minimal — one line to stderr, exit 0 (non-blocking). The problem is not the hook behavior, but the **frequency** of idle events due to multiple upstream causes.

### Root Cause 1: Phantom Teammates from Skill Sub-Agents (GH-231)

**Mechanism**: When a worker (e.g., analyst) invokes `Skill("ralph-hero:ralph-research")`, the skill internally spawns 3–5 sub-agents via `Agent()` calls (`codebase-locator`, `codebase-analyzer`, `thoughts-locator`, etc.). These sub-agents inherit the parent's team context from the session environment, enrolling as **phantom teammates**. Each phantom teammate generates an idle notification when it finishes.

**Scale**: 3 workers × 3–5 sub-agents each = 9–15 phantom teammates per session, each generating one or more idle notifications.

**Current fix status**: GH-231 was researched and a prompt-level fix was applied. The `ralph-research` SKILL.md now contains:
> **Team Isolation**: Do NOT pass `team_name` to these sub-agent `Agent()` calls. Sub-agents must run outside any team context.

This instruction appears in the current skill at `plugin/ralph-hero/skills/ralph-research/SKILL.md` (Step 4). However, it relies on LLM compliance — no automated enforcement exists.

### Root Cause 2: Worker Stop Gate Cascade

**Mechanism**: `worker-stop-gate.sh` ([`plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh)) **always blocks on the first stop attempt** (exit 2), regardless of whether TaskList is empty:

```bash
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0  # Second attempt: allow
fi
# ... always exit 2 on first attempt
```

This forces each worker through two stop cycles:
1. First stop attempt → blocked → worker wakes → checks TaskList → finds nothing → tries to stop again → another idle notification
2. Second stop attempt → re-entry flag set → allowed

**Impact**: Every worker generates at least 2 idle notifications during shutdown (one per attempt). With 3 workers, that's 6+ idle notifications from normal shutdown alone.

**Why the hook can't self-optimize**: The hook is a bash script without access to the MCP task tools. It cannot check TaskList inline, so it falls back to always blocking on first attempt as the safe default.

### Root Cause 3: Redundant SendMessage → Nudge Loops (GH-353)

**Mechanism**: The lead historically called `SendMessage` after `TaskUpdate(owner=worker)`, creating a double signal. Workers went idle after receiving the message (normal behavior), which the lead interpreted as "didn't get the message" and sent another nudge. This created 3–4 idle notifications per task assignment.

**Current fix status**: The `ralph-team` SKILL.md now explicitly states (line 62):
> Workers going idle between turns is normal — don't nudge them. Task assignment is the communication mechanism.

GH-353 research documented additional changes needed in `conventions.md` (Communication Discipline section) and stricter FORBIDDEN rules in SKILL.md. These may not be fully implemented yet.

### Root Cause 4: TaskUpdate Self-Notification (GH-52)

**Mechanism**: When a worker marks a task complete with `TaskUpdate(taskId, status="completed")`, the SDK auto-notifies the task owner. Since workers claim tasks by setting `owner` to themselves, they receive a self-notification that triggers an unnecessary extra turn — generating another idle notification when that turn ends without meaningful work.

**Current fix status**: GH-52 is known but relies on an SDK-level fix or workaround. No mitigation currently exists.

## Key Discoveries

### 1. Idle notifications are a symptom, not the root problem

The `TeammateIdle` hook is already minimal and compliant. The notifications themselves are low-cost (one stderr line). The problem is that *too many idle events occur* due to phantom teammates, stop gate design, nudge loops, and self-notification. Fixing the hook output would mask the problem without addressing the cause.

### 2. GH-231 fix is prompt-level only — LLM compliance is not guaranteed

The team isolation instruction in skill SKILL.md files prevents phantom teammates when the LLM follows it. But there is no automated enforcement (no hook, no postcondition check). Sessions under high context load or with LLMs that deprioritize system-level instructions may regress.

### 3. The stop gate design is intentionally conservative but creates overhead

The double-attempt pattern was a deliberate safety mechanism to prevent workers from stopping while work exists. However, it generates unnecessary idle events in the common case where TaskList is genuinely empty. The hook cannot distinguish "empty TaskList" from "full TaskList" without calling MCP tools.

### 4. The GH-451 session predates most current fixes

The observed spam (integrator sending 3 consecutive idle notifications) likely combined all four causes: phantom teammates (pre-GH-231 fix), nudge loops (pre-GH-353 fix), stop gate cascade (still present), and self-notification (GH-52, still present). The current state is substantially better due to GH-231 and GH-353 fixes.

### 5. Remaining idle spam after current fixes

With GH-231 and GH-353 addressed, the remaining sources are:
- **Stop gate cascade**: 2 idle notifications per worker on shutdown (always)
- **Self-notification (GH-52)**: ~1 wasted turn per task completion per worker
- **Phantom teammate regression risk**: If LLM ignores team isolation instruction

## Potential Approaches

### Approach A: Conditional stop gate (Recommended)

**Description**: Modify `worker-stop-gate.sh` to write a flag file with worker name + timestamp on first block, then check whether that flag is "fresh" (< N seconds) before deciding to block again. This prevents the cascade when the worker genuinely has no work but still ensures a real check on the first attempt.

**Limitation**: Still can't check TaskList from bash. Can only skip the second block if the first one was recent, not if TaskList is empty.

**Alternative**: Pass a hook signal from TaskList results (would require Claude Code framework support — not currently available).

**Pros**: Reduces guaranteed 2× idle events per worker to 1× in the common case.
**Cons**: Shell state management is fragile; timing-based logic adds complexity.

### Approach B: Remove stop gate, rely on agent instructions

**Description**: Delete `worker-stop-gate.sh` and rely entirely on agent-level instructions to check TaskList before stopping. Worker agents already have "Check TaskList again for more work before stopping" in their agent definitions.

**Pros**: Eliminates the guaranteed stop-gate cascade. Simpler architecture.
**Cons**: Less reliable than hook enforcement; agents may not always check TaskList as instructed.

### Approach C: Strengthen GH-231 phantom teammate enforcement

**Description**: Add a `PostToolUse` hook for `Agent` calls that checks if `team_name` was passed in the args. Block the call if `team_name` is set and the current session is a team skill invocation (detectable via `RALPH_COMMAND=team` env var).

**Pros**: Automated enforcement of team isolation — not reliant on LLM compliance.
**Cons**: Hook intercepts all Agent calls, including legitimate ones. Needs careful scoping to avoid false positives. Complex hook implementation.

### Approach D: Accept residual idle notifications, improve filtering

**Description**: Accept that some idle notifications are unavoidable (stop gate, self-notification) and focus on making the team lead more resilient to them rather than eliminating them. The SKILL.md already says "Workers going idle between turns is normal — don't nudge them." The team lead shouldn't need to actively filter — it should naturally ignore them.

**Pros**: No implementation cost. Aligns with the current hook design philosophy.
**Cons**: Doesn't reduce token waste from self-notification (GH-52) or the extra worker turns caused by stop gate cascade.

## Risks and Considerations

1. **GH-231 regression risk**: The prompt-level fix for phantom teammates is the single most impactful mitigation but lacks enforcement. Monitoring new sessions for phantom teammate patterns is important.

2. **GH-52 is SDK-level**: Self-notification cannot be fixed within the ralph-hero codebase. It requires a Claude Code framework change or a workaround (e.g., workers could detect and ignore self-completion notifications).

3. **Stop gate purpose must be preserved**: Any change to `worker-stop-gate.sh` must ensure workers don't stop while unclaimed tasks exist. Reducing aggressiveness trades reliability for reduced noise.

4. **Interaction with dynamic scaling (#464)**: If worker count scales dynamically (more workers = more shutdown events), the stop gate cascade impact grows proportionally.

## Recommended Next Steps

1. **Verify GH-231 effectiveness**: Review a recent session post-mortem to check if phantom teammates still appear. If they do, consider Approach C (hook enforcement).

2. **Implement Approach B (remove stop gate)**: Workers already have agent-level instructions to check TaskList. The stop gate adds guaranteed overhead for uncertain benefit. Remove it and observe behavior across 2–3 sessions.

3. **Document GH-52 workaround pattern**: Add guidance to worker agent definitions to explicitly detect and ignore self-completion notifications (check if the notified task's owner matches own name, skip the turn).

4. **Scope #466 as XS**: Implementing Approach B (remove `worker-stop-gate.sh`) is a single-file deletion with no TypeScript changes. The most impactful remaining change (GH-52 workaround) requires updating 3 agent definition files with a detection pattern.

## Files Affected

### Will Modify
- `plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh` — Remove or replace with passthrough (Approach B), or add fresh-flag logic (Approach A)
- `plugin/ralph-hero/agents/ralph-analyst.md` — Add GH-52 self-notification ignore pattern
- `plugin/ralph-hero/agents/ralph-builder.md` — Add GH-52 self-notification ignore pattern
- `plugin/ralph-hero/agents/ralph-integrator.md` — Add GH-52 self-notification ignore pattern

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` — Current idle hook implementation (already compliant, no changes)
- `plugin/ralph-hero/skills/ralph-team/SKILL.md` — Team coordinator behavior
- `plugin/ralph-hero/skills/ralph-research/SKILL.md` — Team isolation instruction location
- `thoughts/shared/research/2026-02-20-GH-0231-skill-subagent-team-context-pollution.md` — GH-231 findings
- `thoughts/shared/research/2026-02-23-GH-0353-communication-discipline.md` — GH-353 findings
- `thoughts/shared/research/2026-02-17-GH-0052-taskupdate-self-notification.md` — GH-52 self-notification behavior
