---
date: 2026-03-01
status: draft
type: plan
github_issues: [466]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/466
primary_issue: 466
---

# Reduce Idle Notification Spam in Ralph-Team Sessions - Atomic Implementation Plan

## Overview
1 issue for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-466 | Idle notification spam in ralph-team sessions | XS |

## Current State Analysis

Workers in `ralph-team` sessions generate excessive idle notifications. Research (GH-466) identified four root causes:

1. **Phantom teammates (GH-231)** — skill sub-agents inherit team context, generating idle events. **Already mitigated** via prompt-level team isolation instructions in SKILL.md files.
2. **Stop gate cascade** — [`worker-stop-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh) unconditionally blocks the first stop attempt, forcing every worker through 2 stop cycles = 2 idle notifications per worker on shutdown. **Not yet fixed.**
3. **Redundant nudge loops (GH-353)** — lead double-signaled workers via SendMessage after TaskUpdate. **Already mitigated** via SKILL.md communication discipline rules.
4. **Self-notification (GH-52)** — TaskUpdate auto-notifies the task owner, causing wasted turns when workers complete their own tasks. **Not yet fixed** (SDK-level issue, requires workaround).

With GH-231 and GH-353 already addressed, this plan targets the two remaining causes: stop gate cascade and self-notification.

## Desired End State

Workers produce fewer idle notifications during normal operation and shutdown. The stop gate is removed (workers already have agent-level instructions to check TaskList before stopping), and workers detect and skip self-completion notification turns.

### Verification
- [x] Workers no longer trigger 2 idle notifications during shutdown (stop gate cascade eliminated)
- [x] Workers detect and skip self-completion notification turns (GH-52 workaround active)
- [x] No regression: workers still check TaskList before stopping (agent instructions preserved)

## What We're NOT Doing
- Modifying the `TeammateIdle` hook ([`team-teammate-idle.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh)) — it's already minimal and correct
- Implementing automated enforcement of GH-231 phantom teammate prevention (would require complex PostToolUse hook — separate effort)
- Fixing GH-52 at the SDK level — this is a Claude Code framework issue, we add a workaround only
- Modifying the team lead's stop gate ([`team-stop-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/team-stop-gate.sh)) — different mechanism, not affected

## Implementation Approach

Two independent changes that can be implemented in any order:
1. Remove the worker stop gate hook (eliminates the stop cascade)
2. Add self-notification detection guidance to all three worker agent definitions (GH-52 workaround)

---

## Phase 1: GH-466 — Reduce Idle Notification Spam
> **Issue**: https://github.com/cdubiel08/ralph-hero/issues/466 | **Research**: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0466-idle-notification-spam.md

### Changes Required

#### 1. Remove worker stop gate hook
**File**: [`plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh)
**Action**: Delete the file entirely.

**Rationale**: The stop gate forces every worker through 2 stop cycles, generating 6+ idle notifications across 3 workers on shutdown. Workers already have agent-level instructions to check TaskList before stopping (confirmed in all three agent definitions). The hook adds guaranteed overhead for uncertain benefit since agents can still ignore the hook's guidance. Removing it eliminates the cascade while maintaining the same behavioral intent via agent instructions.

#### 2. Remove stop gate hook references from agent definitions
**File**: [`plugin/ralph-hero/agents/ralph-analyst.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-analyst.md)
**Changes**: Remove the `Stop:` hook block (lines 13-16):
```yaml
  Stop:
    - hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/worker-stop-gate.sh"
```

**File**: [`plugin/ralph-hero/agents/ralph-builder.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md)
**Changes**: Remove the `Stop:` hook block (lines 13-16) — same content as analyst.

**File**: [`plugin/ralph-hero/agents/ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)
**Changes**: Remove the `Stop:` hook block (lines 13-16) — same content as analyst.

#### 3. Add self-notification detection to agent definitions
**File**: [`plugin/ralph-hero/agents/ralph-analyst.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-analyst.md)
**Changes**: Add the following paragraph after the existing "Check TaskList again for more work before stopping." line:

```
If you receive a notification about a task you just completed yourself (self-notification from TaskUpdate), ignore it — do not start a new turn or check TaskList again for that notification alone.
```

**File**: [`plugin/ralph-hero/agents/ralph-builder.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-builder.md)
**Changes**: Add the same self-notification detection paragraph after "Check TaskList again for more work before stopping."

**File**: [`plugin/ralph-hero/agents/ralph-integrator.md`](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/agents/ralph-integrator.md)
**Changes**: Add the same self-notification detection paragraph after "Check TaskList again for more work before stopping."

### Success Criteria
- [x] Automated: `worker-stop-gate.sh` file no longer exists — `test ! -f plugin/ralph-hero/hooks/scripts/worker-stop-gate.sh`
- [x] Automated: No agent definitions reference `worker-stop-gate.sh` — `grep -r "worker-stop-gate" plugin/ralph-hero/agents/ | wc -l` returns 0
- [x] Automated: All three agent definitions contain self-notification guidance — `grep -l "self-notification" plugin/ralph-hero/agents/ralph-{analyst,builder,integrator}.md | wc -l` returns 3
- [ ] Manual: Run a `ralph-team` session and observe reduced idle notifications during worker shutdown (expect ~1 per worker instead of ~2)

---

## Integration Testing
- [ ] Run `ralph-team` with a small workload (1-2 issues) and verify workers check TaskList before stopping (agent instruction compliance)
- [ ] Confirm no infinite stop loops occur (the re-entry safety was in the deleted hook — verify workers stop cleanly without it)
- [ ] Verify idle notification count is reduced compared to prior sessions

## References
- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0466-idle-notification-spam.md
- Related issues:
  - https://github.com/cdubiel08/ralph-hero/issues/231 (phantom teammates — already mitigated)
  - https://github.com/cdubiel08/ralph-hero/issues/353 (communication discipline — already mitigated)
  - https://github.com/cdubiel08/ralph-hero/issues/52 (self-notification — SDK-level, workaround applied here)
