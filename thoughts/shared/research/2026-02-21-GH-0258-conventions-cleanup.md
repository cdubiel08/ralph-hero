---
date: 2026-02-21
github_issue: 258
github_url: https://github.com/cdubiel08/ralph-hero/issues/258
status: complete
type: research
---

# GH-258: Clean Up conventions.md -- Remove Conflicting Handoff Rules and Peer-Wake Messaging

## Problem Statement

After the GH-230 worker redesign series (#231, #255, #256, #257), several sections of `conventions.md` and `team-teammate-idle.sh` contain outdated rules that conflict with the new architecture:
- Mid-pipeline assignment prohibition conflicts with bough model (#257)
- Peer-to-peer handoff protocol is no longer the primary cross-phase mechanism (bough advancement is)
- "Peers will wake this teammate" messaging is inaccurate (Stop hook drives work discovery)
- `general-purpose` subagent reference is outdated (typed agents from #256)

## Current State Analysis

### Target 1: conventions.md Line 133 -- Assignment Prohibition

```
- **Lead pre-assigns at spawn only**: The lead sets `owner` via `TaskUpdate` immediately
  before spawning a worker. After spawn, workers self-claim subsequent tasks. Do NOT
  assign tasks mid-pipeline via TaskUpdate or SendMessage.
```

**Why it conflicts**: The bough model (#257) requires the lead to create AND assign new-bough tasks when convergence is detected. The lead must be able to assign tasks mid-pipeline to idle workers.

**Proposed change**: Replace with:
```
- **Lead assigns at spawn and bough advancement**: The lead sets `owner` via `TaskUpdate`
  before spawning a worker and when creating new-bough tasks. Workers also self-claim
  unclaimed tasks via Stop hook.
```

### Target 2: conventions.md Lines 91-136 -- Pipeline Handoff Protocol

The entire section describes peer-to-peer cross-phase handoffs (analyst -> builder -> validator -> integrator). Post-bough model:
- **Within-phase** handoffs remain valid (analyst-1 finishes, messages analyst-2 about remaining work)
- **Cross-phase** progression is now lead-driven (lead creates next-bough tasks on convergence)

**Proposed change**: Simplify the section:
1. Keep the Pipeline Order table (lines 97-103) -- still useful reference for within-phase handoffs
2. Simplify the Handoff Procedure (lines 105-129) -- remove the cross-phase handoff steps (read team config, find next-stage peer). Replace with: "Check TaskList for more tasks matching your role. If none, notify team-lead."
3. Update Rules (lines 131-136):
   - Line 133: Replace assignment prohibition (see Target 1 above)
   - Line 134: Keep "SendMessage is fire-and-forget"
   - Line 135: Keep "Lead gets visibility"
   - Line 136: Keep "Multiple handoffs are fine"

The Pipeline Order table is kept for reference but the procedure is simplified. Workers no longer need to discover next-stage peers via config.json.

### Target 3: conventions.md Lines 249-273 -- Skill Invocation Convention

Line 254:
```
Task(subagent_type="general-purpose",
     prompt="Skill(skill='ralph-hero:ralph-research', args='42')",
     description="Research GH-42")
```

**Why it's outdated**: #256 changed team workers from `general-purpose` to typed agents (`ralph-analyst`, `ralph-builder`, etc.).

Lines 265-273 (Note: Team Agents):
```
Team members are spawned as `general-purpose` subagents via `Task()`, so they follow
the same isolation pattern as the default.
```

**Proposed change**:
1. Line 254: Change `general-purpose` to a typed agent example (e.g., `ralph-analyst`) or keep `general-purpose` for the non-team "Default: Fork via Task()" example since that's still valid for standalone skill invocation
2. Lines 265-273: Update "Team Agents" note to mention typed agents:
   ```
   Team members are spawned as typed subagents (e.g., `ralph-analyst`, `ralph-builder`)
   via `Task()`. Each team member invokes its skill inline...
   ```

**Scope clarification**: The `general-purpose` references in other SKILL.md files (`ralph-hero/SKILL.md`, `ralph-review/SKILL.md`) are out of scope -- they are separate standalone orchestrators, not the team system.

### Target 4: team-teammate-idle.sh Lines 5-7, 22-23 -- Peer-Wake Messaging

Comment block (lines 5-7):
```bash
# Workers go idle when no tasks match their role. This is normal
# if upstream stages haven't completed yet. Peers will wake this
# teammate when work unblocks.
```

Output block (lines 22-23):
```
Peers will wake this teammate when work unblocks.
```

**Why it's outdated**: Workers now discover work via the Stop hook (`worker-stop-gate.sh`), not peer SendMessage. The lead creates new-bough tasks on convergence; the Stop hook blocks worker shutdown and directs them to check TaskList.

**Proposed change**:
Comment block:
```bash
# Workers go idle when no tasks match their role. This is normal
# if upstream stages haven't completed yet. The Stop hook will
# block shutdown if matching tasks exist in TaskList.
```

Output block:
```
Stop hook will block shutdown if matching tasks appear in TaskList.
```

## Complete File Change List

| File | Lines | Change | Type |
|---|---|---|---|
| `skills/shared/conventions.md` | 133 | Replace assignment prohibition with bough-aware rule | Edit |
| `skills/shared/conventions.md` | 93 | Update intro sentence (lead-driven, not peer-to-peer for cross-phase) | Edit |
| `skills/shared/conventions.md` | 105-129 | Simplify handoff procedure (remove cross-phase config.json lookup) | Edit |
| `skills/shared/conventions.md` | 267 | Update "Team Agents" note (`general-purpose` -> typed agents) | Edit |
| `hooks/scripts/team-teammate-idle.sh` | 5-7 | Update comment (Stop hook, not peers) | Edit |
| `hooks/scripts/team-teammate-idle.sh` | 22-23 | Update output (Stop hook, not peers) | Edit |

**Total**: 2 files, ~25 lines changed. XS estimate is correct.

## Risks

1. **Premature removal**: If GH-257 (bough model) hasn't merged yet, removing the assignment prohibition creates a gap where no rule exists. Mitigation: implement GH-258 only after #257 merges.

2. **Pipeline Handoff Protocol simplification**: The within-phase handoff procedure (check TaskList, self-claim) is valid and useful. Only the cross-phase part (read config.json, find next-stage peer) should be removed. Care needed not to over-simplify.

3. **Default Fork convention**: The `general-purpose` example in "Default: Fork via Task()" (line 254) is actually correct for standalone (non-team) skill invocation. Only the "Note: Team Agents" section needs updating. The example itself can stay as-is since it demonstrates isolated fork pattern, not team spawning.

## Recommended Approach

1. Update conventions.md line 133 (assignment rule)
2. Simplify Pipeline Handoff Protocol (lines 93-129) -- keep table, simplify procedure
3. Update "Note: Team Agents" section (lines 265-273)
4. Update team-teammate-idle.sh (lines 5-7, 22-23)
5. Leave "Default: Fork via Task()" example at line 254 as-is (it's correct for non-team usage)

This is a strong fast-track candidate. All changes are specific text edits with no architectural decisions.
