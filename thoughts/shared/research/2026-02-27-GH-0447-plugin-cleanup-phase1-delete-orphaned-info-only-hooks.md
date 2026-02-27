---
date: 2026-02-27
github_issue: 447
github_url: https://github.com/cdubiel08/ralph-hero/issues/447
status: complete
type: research
---

# GH-447: Plugin Cleanup Phase 1 - Delete Orphaned and Info-Only Hook Scripts

## Problem Statement

The `plugin/ralph-hero/hooks/scripts/` directory contains 58 shell scripts, many of which are either:
1. **Orphaned**: not referenced anywhere in hooks.json, SKILL.md files, or agent definitions
2. **Info-only**: registered in SKILL.md frontmatter but never block (only warn or always allow)

The issue targets reducing the count from 58 to ~36 by removing ~22 scripts. Research has identified 16 concrete deletion candidates (8 orphaned + 8 info-only), bringing the count to 42.

## Current State Analysis

### Script Inventory

The scripts directory contains 58 `.sh` files plus 2 non-shell config files (`ralph-command-contracts.json`, `ralph-state-machine.json`).

**Reference locations checked:**
- `plugin/ralph-hero/hooks/hooks.json` - 9 registered scripts (plugin-level hooks)
- `plugin/ralph-hero/skills/*/SKILL.md` - 38 scripts referenced in skill frontmatter
- `plugin/ralph-hero/agents/*.md` - 2 scripts referenced (`require-skill-context.sh`, `worker-stop-gate.sh`)
- `hooks/scripts/*.sh` itself - `hook-utils.sh` is sourced as a library by 49 scripts (not a hook, must be kept)

### Category Breakdown

| Category | Count |
|----------|-------|
| Registered blocking hooks | 34 |
| `hook-utils.sh` (library, not a hook) | 1 |
| Registered info-only (warn/allow only) | 8 |
| Orphaned (no references anywhere) | 8 |
| Non-sh config files | 2 |
| **Total** | **58 + 2** |

## Key Discoveries

### Orphaned Scripts (8 scripts - safe to delete)

These scripts exist in the directory but are not referenced in any hook registration:

| Script | Reason for Orphan Status |
|--------|--------------------------|
| `auto-state.sh` | Header says "ORPHANED: semantic intents resolved server-side by MCP server" - functionality was moved into the MCP server |
| `debug-hook-counter.sh` | Debug-only script, never registered; appends to session logs when `RALPH_DEBUG=true` |
| `plan-no-dup.sh` | Header says "ORPHANED: overlaps with pre-artifact-validator.sh which already blocks duplicate plan docs globally" |
| `plan-verify-commit.sh` | Header says "ORPHANED: Created for ralph-plan but never wired up" - warn-only git commit check |
| `plan-verify-doc.sh` | Header says "ORPHANED: Created for ralph-plan but never wired up" - warn-only doc structure check |
| `research-no-dup.sh` | Header says "ORPHANED: overlaps with pre-artifact-validator.sh which already blocks duplicate research docs globally" |
| `research-verify-doc.sh` | Header says "ORPHANED: Created for ralph-research but never wired up" - warn-only doc structure check |
| `state-gate.sh` | Header says "ORPHANED: Superseded by per-skill state gates (research-state-gate.sh, plan-state-gate.sh, etc.)" |

Note: `hook-utils.sh` appeared in orphan analysis but is NOT orphaned - it's a shared library sourced by 49 registered scripts.

### Info-Only Registered Scripts (8 scripts - deletable with SKILL.md cleanup)

These scripts are registered in SKILL.md frontmatter but never call `block()` or `exit 2`:

| Script | Referenced In | Behavior |
|--------|---------------|----------|
| `hygiene-postcondition.sh` | `ralph-hygiene/SKILL.md` | Body is `# Lightweight check — warn only, don't block` then `allow` |
| `report-postcondition.sh` | `ralph-report/SKILL.md` | Body is `# Lightweight check — warn only, don't block` then `allow` |
| `setup-postcondition.sh` | `ralph-setup/SKILL.md` | Body is `# Lightweight check — warn only, don't block` then `allow` |
| `status-postcondition.sh` | `ralph-status/SKILL.md` | Body is `# Lightweight check — warn only, don't block` then `allow` |
| `merge-postcondition.sh` | `ralph-merge/SKILL.md` | Warns if PR not merged, but always exits 0 |
| `pr-postcondition.sh` | `ralph-pr/SKILL.md` | Warns if PR not found, but always exits 0 |
| `convergence-gate.sh` | `ralph-plan/SKILL.md` | Issues `allow_with_context` warning when `RALPH_CONVERGENCE_VERIFIED` unset; never blocks |
| `impl-verify-pr.sh` | `ralph-impl/SKILL.md`, `ralph-pr/SKILL.md` | Warns if PR creation failed, but always exits 0 |

### Scripts That Must Be Kept

The following scripts appeared in analysis but must NOT be deleted:

- `hook-utils.sh` - Shared library sourced by 49 scripts (not a hook registration, a dependency)
- `require-skill-context.sh` - Blocking hook registered in `ralph-analyst.md`, `ralph-builder.md`, `ralph-integrator.md`
- `worker-stop-gate.sh` - Blocking hook registered in the same 3 agent files

### SKILL.md Update Requirements

When deleting info-only scripts, their references in SKILL.md frontmatter hooks blocks must also be removed. Affected files:

- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` - remove `hygiene-postcondition.sh` hook entry
- `plugin/ralph-hero/skills/ralph-report/SKILL.md` - remove `report-postcondition.sh` hook entry
- `plugin/ralph-hero/skills/ralph-setup/SKILL.md` - remove `setup-postcondition.sh` hook entry
- `plugin/ralph-hero/skills/ralph-status/SKILL.md` - remove `status-postcondition.sh` hook entry
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` - remove `merge-postcondition.sh` hook entry
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` - remove `pr-postcondition.sh` and `impl-verify-pr.sh` hook entries
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - remove `convergence-gate.sh` hook entry
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - remove `impl-verify-pr.sh` hook entry

### hooks.json - No Changes Needed

All 9 scripts registered in `hooks.json` are blocking hooks and should be kept:
`pre-github-validator.sh`, `artifact-discovery.sh`, `pre-ticket-lock-validator.sh`, `skill-precondition.sh`, `pre-artifact-validator.sh`, `pre-worktree-validator.sh`, `post-github-validator.sh`, `post-blocker-reminder.sh`, `post-git-validator.sh`

## Potential Approaches

### Approach A: Delete Orphaned Only (Conservative)
Delete only the 8 orphaned scripts. No SKILL.md changes needed.

**Pros:** Minimal blast radius, zero risk of breaking registered hooks
**Cons:** Leaves 8 info-only scripts that add noise without providing value

### Approach B: Delete Orphaned + Info-Only (Recommended)
Delete all 16 scripts (8 orphaned + 8 info-only). Update 8 SKILL.md files to remove dead references.

**Pros:** Achieves the issue's goal of ~36 scripts, removes misleading "no-op" hooks
**Cons:** Requires updating 8 SKILL.md files; slightly more work

### Approach C: Delete Orphaned + Convert Info-Only to Blocking
Upgrade info-only postconditions to actually block (add `exit 2` for failure cases).

**Pros:** More comprehensive safety net
**Cons:** Out of scope for Phase 1; risks introducing regressions; `warn()` is intentional for permissive skills like hygiene/report/setup/status

## Risks

1. **hook-utils.sh must not be deleted** - It's a shared library. Deleting it breaks all 49 registered scripts.
2. **require-skill-context.sh and worker-stop-gate.sh must not be deleted** - They are referenced only in agent `.md` files (not SKILL.md), so the orphan analysis must check agents directory.
3. **SKILL.md hook entries must be cleaned** - Registered info-only scripts have entries in SKILL.md. Deleting the script file without removing the reference will cause Claude Code to fail to start hooks (file not found error). This is the highest-risk step.
4. **convergence-gate.sh deletion** - This hook emits a useful advisory warning. Deleting it removes a safety reminder without breaking functionality.
5. **merge-postcondition.sh and pr-postcondition.sh** - These call `gh pr list` which requires `RALPH_GH_OWNER`/`RALPH_GH_REPO` env vars. The current warn-only behavior means failures are silent; removing them is safe.

## Recommended Next Steps

1. Delete 8 orphaned scripts (can be done atomically):
   - `auto-state.sh`, `debug-hook-counter.sh`, `plan-no-dup.sh`, `plan-verify-commit.sh`
   - `plan-verify-doc.sh`, `research-no-dup.sh`, `research-verify-doc.sh`, `state-gate.sh`

2. Delete 8 info-only scripts and remove their references from SKILL.md files (must be done together):
   - `hygiene-postcondition.sh` + update `ralph-hygiene/SKILL.md`
   - `report-postcondition.sh` + update `ralph-report/SKILL.md`
   - `setup-postcondition.sh` + update `ralph-setup/SKILL.md`
   - `status-postcondition.sh` + update `ralph-status/SKILL.md`
   - `merge-postcondition.sh` + update `ralph-merge/SKILL.md`
   - `pr-postcondition.sh` + update `ralph-pr/SKILL.md`
   - `convergence-gate.sh` + update `ralph-plan/SKILL.md`
   - `impl-verify-pr.sh` + update `ralph-impl/SKILL.md` and `ralph-pr/SKILL.md`

3. Verify: `npm test && npm run build` should pass (hooks are shell scripts, not TypeScript)

4. Final count: 58 - 16 = 42 scripts (issue says ~36; gap analysis below)

**Gap note**: Issue targets ~36, research found 16 safe deletions yielding 42. The gap of ~6 could come from:
- The 4 stub postconditions (`hygiene`, `report`, `setup`, `status`) technically have no content to keep - this approach already captures them
- Additional review may identify more warn-only scripts missed in this pass
- The issue's "~36" estimate was approximate; 42 is a defensible outcome

## Files Affected

### Will Modify
- `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` - Remove hygiene-postcondition.sh hook entry
- `plugin/ralph-hero/skills/ralph-report/SKILL.md` - Remove report-postcondition.sh hook entry
- `plugin/ralph-hero/skills/ralph-setup/SKILL.md` - Remove setup-postcondition.sh hook entry
- `plugin/ralph-hero/skills/ralph-status/SKILL.md` - Remove status-postcondition.sh hook entry
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md` - Remove merge-postcondition.sh hook entry
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` - Remove pr-postcondition.sh and impl-verify-pr.sh hook entries
- `plugin/ralph-hero/skills/ralph-plan/SKILL.md` - Remove convergence-gate.sh hook entry
- `plugin/ralph-hero/skills/ralph-impl/SKILL.md` - Remove impl-verify-pr.sh hook entry

### Will Read (Dependencies)
- `plugin/ralph-hero/hooks/hooks.json` - Verify no references to deleted scripts (no changes needed)
- `plugin/ralph-hero/agents/ralph-analyst.md` - Verify require-skill-context.sh / worker-stop-gate.sh references (keep)
- `plugin/ralph-hero/agents/ralph-builder.md` - Same as above
- `plugin/ralph-hero/agents/ralph-integrator.md` - Same as above
- `plugin/ralph-hero/mcp-server/package.json` - Verify npm test / build pass after changes
