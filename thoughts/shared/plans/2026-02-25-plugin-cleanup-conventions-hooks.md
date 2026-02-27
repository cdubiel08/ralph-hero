---
date: 2026-02-25
status: draft
github_issues: [407]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/407
primary_issue: 407
---

# Plugin Cleanup: Conventions Injection, Hook Pruning, Consistency

## Overview

Clean up the ralph-hero plugin by: (1) inlining conventions into skills so no layer ever Read()s conventions.md, (2) deleting orphaned and info-only hooks, (3) fixing stale validator/language references throughout.

## Current State Analysis

### Conventions problem
`shared/conventions.md` (293 lines) is linked 34 times across 9 skills via `See [shared/conventions.md]`. Skills run in forked `Task()` subagents that would need to `Read()` the file — burning tokens and a round-trip every invocation. No skill currently inlines the content it needs.

### Hook bloat
47 shell scripts in `hooks/scripts/`. Of those:
- **19 active blocking** — enforce real constraints
- **12 info-only** — warn/remind but never block (always exit 0)
- **9 orphaned** — not wired to any hook registration
- **1 utility** (`hook-utils.sh`)
- **2 data files** (JSON)

### Stale references
- `ralph-hero/SKILL.md` mentions "VALIDATOR PHASE" — validator agent was deleted
- `ralph-review/SKILL.md` uses `validator-review` filter profile — naming is stale (builder does reviews now)
- `ralph-integrator.md` references `ralph-hero:ralph-val` skill — still exists, actually used
- Various skills reference conventions via "See" links that should be self-contained

## Desired End State

1. **Zero `Read()` calls for conventions**: Every skill has the protocol text it needs inlined. `shared/conventions.md` becomes an archival reference only.
2. **~20 fewer hook scripts**: All orphaned and info-only hooks deleted. `hooks.json` trimmed to blocking hooks only.
3. **Consistent language**: No validator-as-agent references. Filter profile renamed. Role descriptions match reality.

### Verification:
- `npm test` passes (MCP server unaffected except filter profile rename)
- `npm run build` compiles
- `grep -r "conventions.md" plugin/ralph-hero/skills/` returns 0 results
- No orphaned .sh files in `hooks/scripts/`
- All hook registrations in `hooks.json` and SKILL.md frontmatter point to existing scripts

## What We're NOT Doing

- **Not touching workspace `~/projects/CLAUDE.md`** — out of scope
- **Not changing skill workflow logic** — only injecting text and deleting dead code
- **Not refactoring hook-utils.sh** — still needed by active hooks
- **Not removing `ralph-val` skill** — it's actively used by the integrator
- **Not changing MCP server logic** — `SuggestedRoster` is already clean (3 roles)

## Implementation Approach

Three phases: delete dead hooks first (safe, no dependencies), then inline conventions (bulk text changes), then consistency fixes (surgical edits).

---

## Phase 1: Delete Dead Hooks

### Overview
Remove 9 orphaned scripts, 5 info-only scripts from `hooks.json`, and 1 orphan info-only script. Update `hooks.json` and skill frontmatter to remove references to deleted scripts.

### Changes Required:

#### 1. Delete orphaned scripts (not wired anywhere)

**Delete these files** from `plugin/ralph-hero/hooks/scripts/`:
- `auto-state.sh` (123 lines) — header says "semantic intents resolved server-side"
- `state-gate.sh` (104 lines) — superseded by per-skill state gates
- `research-no-dup.sh` (44 lines) — overlaps with `pre-artifact-validator.sh`
- `plan-no-dup.sh` (44 lines) — overlaps with `pre-artifact-validator.sh`
- `plan-verify-commit.sh` (40 lines) — never wired
- `plan-verify-doc.sh` (37 lines) — never wired
- `research-verify-doc.sh` (33 lines) — never wired
- `debug-hook-counter.sh` (29 lines) — debug-only, never wired
- `val-postcondition.sh` (15 lines) — wired to `ralph-val` skill, but `ralph-val` is invoked via `Task()` from the integrator and stop hooks don't propagate into forked subagents — this hook never fires

#### 2. Delete info-only scripts from `hooks.json`

These are wired but only warn (never block, always exit 0):

**Delete from `plugin/ralph-hero/hooks/scripts/`:**
- `artifact-discovery.sh` (68 lines) — warns about missing artifact comments
- `pre-ticket-lock-validator.sh` (24 lines) — body is a no-op
- `post-blocker-reminder.sh` (47 lines) — injects blocker context, never blocks
- `pre-github-validator.sh` (59 lines) — outputs context JSON, always exit 0
- `post-github-validator.sh` (67 lines) — outputs context JSON, always exit 0

**Update `plugin/ralph-hero/hooks/hooks.json`:**

Remove all references to deleted scripts. The remaining `hooks.json` should be:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "description": "Ralph GitHub plugin hook registration",
  "version": "1.0.0",
  "note": "Most hooks are registered via skill frontmatter. This file provides plugin-level hooks that apply across all skills.",

  "hooks": {
    "PreToolUse": [
      {
        "matcher": "ralph_hero__get_issue",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/skill-precondition.sh"
          }
        ]
      },
      {
        "matcher": "ralph_hero__list_issues",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/skill-precondition.sh"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pre-artifact-validator.sh"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/pre-worktree-validator.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/post-git-validator.sh"
          }
        ]
      }
    ]
  }
}
```

#### 3. Delete info-only scripts from skill frontmatter

**File**: `plugin/ralph-hero/skills/ralph-split/SKILL.md`
- Remove `split-estimate-gate.sh` from PreToolUse hooks (always exits 0 via `allow_with_context`)
- Remove `split-verify-sub-issue.sh` from PostToolUse hooks (warn only, never blocks)
- Delete `plugin/ralph-hero/hooks/scripts/split-estimate-gate.sh` (20 lines)
- Delete `plugin/ralph-hero/hooks/scripts/split-verify-sub-issue.sh` (24 lines)

**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- Remove `convergence-gate.sh` from PreToolUse hooks (always exits 0, advisory only)
- Delete `plugin/ralph-hero/hooks/scripts/convergence-gate.sh` (52 lines)

**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
- Remove `review-verify-doc.sh` from PostToolUse hooks (warn only, never blocks)
- Delete `plugin/ralph-hero/hooks/scripts/review-verify-doc.sh` (38 lines)

**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- Remove `impl-verify-pr.sh` from PostToolUse hooks (warn only, never blocks)
- Delete `plugin/ralph-hero/hooks/scripts/impl-verify-pr.sh` (37 lines)

**File**: `plugin/ralph-hero/skills/ralph-team/SKILL.md`
- Remove `team-task-completed.sh` from TaskCompleted hooks (stderr logging only, always exit 0)
- Remove `team-teammate-idle.sh` from TeammateIdle hooks (stderr guidance only, always exit 0)
- Delete `plugin/ralph-hero/hooks/scripts/team-task-completed.sh` (27 lines)
- Delete `plugin/ralph-hero/hooks/scripts/team-teammate-idle.sh` (23 lines)

### Success Criteria:

#### Automated Verification:
- [ ] `ls plugin/ralph-hero/hooks/scripts/*.sh | wc -l` shows 25 (down from 47, minus 22 deleted)
- [ ] `npm test` passes (no MCP server changes in this phase)
- [ ] `npm run build` compiles
- [ ] All hook registrations in `hooks.json` and SKILL.md frontmatter point to existing scripts
- [ ] `grep -rn 'artifact-discovery\|pre-ticket-lock\|post-blocker-reminder\|pre-github-validator\|post-github-validator' plugin/ralph-hero/hooks/hooks.json` returns 0 results

#### Manual Verification:
- [ ] Run `/ralph-research` on a test issue — hooks fire correctly, no errors about missing scripts

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 2: Inline Conventions into Skills

### Overview
Replace all 34 `See conventions.md` references with the actual protocol text inlined directly into each SKILL.md. After this phase, no skill should reference `conventions.md`.

### Changes Required:

#### Convention sections and which skills need them:

| Section | Lines | Skills that reference it |
|---------|-------|------------------------|
| Artifact Comment Protocol | ~60 lines | ralph-plan, ralph-review, ralph-impl, ralph-research |
| Artifact Passthrough Protocol | ~55 lines | ralph-plan, ralph-review, ralph-impl, ralph-hero |
| Escalation Protocol | ~25 lines | ralph-plan, ralph-review, ralph-impl, ralph-research, ralph-triage, ralph-split, ralph-hero |
| Link Formatting | ~8 lines | ralph-plan, ralph-review, ralph-impl, ralph-research, ralph-triage, ralph-split, ralph-hero, implement-plan |
| Sub-Agent Team Isolation | ~15 lines | ralph-plan, ralph-review, ralph-split, ralph-triage, ralph-research, create-plan, draft-idea, implement-plan, research-codebase |
| Error Handling | ~4 lines | ralph-plan |
| Skill Invocation Convention | ~20 lines | (team skill only — already self-contained) |

#### Injection strategy per skill:

For each skill, replace `See conventions.md` links with a new `## Conventions` section at the bottom of the SKILL.md containing ONLY the sections that skill references. This keeps the conventions co-located and eliminates any Read() need.

**Template for injected section:**

```markdown
## Conventions

### Escalation Protocol

[inline the ~25 lines from conventions.md#escalation-protocol]

### Link Formatting

[inline the ~8 lines from conventions.md#link-formatting]

### Sub-Agent Team Isolation

[inline the ~15 lines]
```

#### Per-skill changes:

**1. `ralph-plan/SKILL.md`** (6 references → 0)
- Inline: Artifact Passthrough, Artifact Comment Protocol, Sub-Agent Team Isolation, Error Handling, Escalation, Link Formatting
- Replace all 6 "See conventions.md" links with inline references to the new `## Conventions` section at bottom

**2. `ralph-review/SKILL.md`** (7 references → 0)
- Inline: Artifact Passthrough, Artifact Comment Protocol, Sub-Agent Team Isolation, Escalation, Link Formatting

**3. `ralph-impl/SKILL.md`** (6 references → 0)
- Inline: Artifact Passthrough, Artifact Comment Protocol, Escalation, Link Formatting

**4. `ralph-split/SKILL.md`** (4 references → 0)
- Inline: Sub-Agent Team Isolation, Escalation, Link Formatting

**5. `ralph-triage/SKILL.md`** (3 references → 0)
- Inline: Sub-Agent Team Isolation, Escalation, Link Formatting

**6. `ralph-research/SKILL.md`** (3 references → 0)
- Inline: Sub-Agent Team Isolation, Artifact Comment Protocol (comment format only), Escalation, Link Formatting

**7. `ralph-hero/SKILL.md`** (3 references → 0)
- Inline: Artifact Passthrough, Escalation, Link Formatting

**8. `create-plan/SKILL.md`** (1 reference → 0)
- Replace ADR-001 reference with inline: "Do NOT pass `team_name` to sub-agent `Task()` calls."

**9. `implement-plan/SKILL.md`** (1 reference → 0)
- Inline: Link Formatting only

**10. `draft-idea/SKILL.md`** (1 reference → 0)
- Already almost inline. Replace "per conventions" with: "Do NOT pass `team_name` to sub-agent `Task()` calls."

**11. `research-codebase/SKILL.md`** (1 reference → 0)
- Already almost inline. Replace "per conventions" with: "Do NOT pass `team_name` to sub-agent `Task()` calls."

#### Shared conventions file:

**File**: `plugin/ralph-hero/skills/shared/conventions.md`
- Add a header note: `> **Archival reference only.** All content is inlined into the skills that use it. Do not link here from skills.`
- Keep the file for human reference but no skill should link to it.

### Success Criteria:

#### Automated Verification:
- [ ] `grep -r "conventions.md" plugin/ralph-hero/skills/` returns 0 results
- [ ] `grep -r "See.*shared/" plugin/ralph-hero/skills/` returns 0 results
- [ ] `npm test` passes
- [ ] `npm run build` compiles

#### Manual Verification:
- [ ] Spot-check 2-3 skills: the inlined convention sections are accurate and complete
- [ ] Run `/ralph-plan` or `/ralph-impl` on a test issue — skill works without needing to Read() any external file

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Phase 3: Consistency Fixes

### Overview
Clean up stale validator references, rename the misleading filter profile, and align language across skills and agents.

### Changes Required:

#### 1. Rename `validator-review` filter profile

**File**: `plugin/ralph-hero/mcp-server/src/lib/filter-profiles.ts`
Rename `"validator-review"` → `"review-queue"`.

**File**: `plugin/ralph-hero/mcp-server/src/__tests__/filter-profiles.test.ts`
Update test to use `"review-queue"`.

**File**: `plugin/ralph-hero/skills/ralph-review/SKILL.md`
Update all references from `validator-review` to `review-queue` (2 occurrences: the list_issues call and the Available Filter Profiles table).

#### 2. Fix "VALIDATOR PHASE" in ralph-hero SKILL.md

**File**: `plugin/ralph-hero/skills/ralph-hero/SKILL.md:56`
Change:
```
|  VALIDATOR PHASE (if RALPH_REVIEW_MODE == "interactive")           |
```
To:
```
|  REVIEW PHASE (if RALPH_REVIEW_MODE == "interactive")              |
```

#### 3. Clean up integrator agent reference to ralph-val

**File**: `plugin/ralph-hero/agents/ralph-integrator.md:34`
The reference to `ralph-hero:ralph-val` is correct — the skill exists. No change needed.

#### 4. Remove `val-postcondition.sh` wiring from ralph-val

**File**: `plugin/ralph-hero/skills/ralph-val/SKILL.md`
Remove the Stop hook for `val-postcondition.sh` from frontmatter. The skill runs in a `Task()` fork from the integrator — Stop hooks don't propagate into forked subagents, so this hook never fires. (The script itself was deleted in Phase 1.)

#### 5. Align agent descriptions

**File**: `plugin/ralph-hero/agents/ralph-analyst.md:3`
Current: `Analyst worker - composes triage, split, research, and plan skills for issue assessment, investigation, and planning`
Change to: `Analyst worker - composes triage, split, research, and plan skills for issue assessment and planning`
(Remove "investigation" — redundant with "research".)

**File**: `plugin/ralph-hero/agents/ralph-builder.md:3`
Current: `Builder worker - reviews plans and implements code for the full build lifecycle`
Change to: `Builder worker - composes review and implement skills for the build lifecycle`
(Align pattern with analyst: "composes X and Y skills for Z".)

**File**: `plugin/ralph-hero/agents/ralph-integrator.md:3`
Current: `Integration specialist - validates implementation against plan requirements, handles PR creation, merge, worktree cleanup, and git operations`
Change to: `Integration specialist - composes validate, PR creation, and merge skills for delivery and git operations`
(Align pattern.)

#### 6. Update README.md if it references validator agent

**File**: `plugin/ralph-hero/README.md`
Check for and remove any `ralph-validator` agent references. Update the agent table to show 3 workers.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes (filter profile rename is tested)
- [ ] `npm run build` compiles
- [ ] `grep -r "validator-review" plugin/ralph-hero/` returns 0 results
- [ ] `grep -r "VALIDATOR PHASE" plugin/ralph-hero/` returns 0 results
- [ ] `grep -r "ralph-validator" plugin/ralph-hero/agents/` returns 0 results

#### Manual Verification:
- [ ] Agent descriptions use consistent "composes X skills for Y" pattern
- [ ] `detect_pipeline_position` still returns correct roster (already clean, just verify)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation.

---

## Testing Strategy

### Unit Tests:
- Filter profile rename: update existing test in `filter-profiles.test.ts`
- No new unit tests needed — changes are structural (file deletions, text edits)

### Integration Tests:
- Run `/ralph-research` on a real issue to verify hook chain works after deletions
- Run `/ralph-plan` to verify conventions are accessible without Read()

### Manual Testing Steps:
1. Verify no orphaned hook references: `for f in plugin/ralph-hero/hooks/scripts/*.sh; do grep -r "$(basename $f)" plugin/ralph-hero/{hooks/hooks.json,skills/*/SKILL.md,agents/*.md} >/dev/null || echo "ORPHAN: $f"; done`
2. Verify convention coverage: spot-check that ralph-impl's inlined Artifact Comment Protocol matches the original

## Performance Considerations

- Inlining conventions adds ~50-100 lines per skill, but eliminates a Read() round-trip per invocation
- Deleting 22 hook scripts eliminates ~900 lines of shell that executes on every tool call match
- Net token cost per invocation should decrease (fewer hook outputs in context)

## References

- Hook inventory: analyzed in this planning session
- Conventions usage map: 34 references across 9 skills (grep results above)
- Current agent files: `plugin/ralph-hero/agents/{ralph-analyst,ralph-builder,ralph-integrator}.md`
