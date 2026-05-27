---
date: 2026-05-26
status: ready
type: plan
tags: [docs, archive, plugin-ralph-hero, doc-consistency]
github_issue: 1453
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1453
primary_issue: 1453
estimate: S
---

# GH-1453 — Archive stale docs describing the deleted plugin/ralph-hero/

## Prior Work

- Child of epic #1459 (Documentation hardening); follows merged sibling #1452 (roster fix). Sibling #1457 (docs/README index separating living vs historical) owns the broader corpus organization — this issue is scoped to the 3 live-guide docs + `ralph/README.md`.
- `plugin/ralph-hero/` was deleted in GH-1438 (epic #1430, Phase 8), which is what stranded these docs.

## Overview

Three `docs/` files document the deleted `plugin/ralph-hero/` and the superseded Director→Teams architecture, sitting in the live docs tree with broken intra-repo links and confusing readers about what's current. `ralph/README.md` still advertises a mid-migration "Plan 7 of 11" status though the migration is complete. This plan archives the three stale guides and updates `ralph/README.md` to its post-migration state. Doc-only — no code, no behavior change.

## Current State Analysis

Verified on `main` (2026-05-26):
- `docs/cli.md` exists — entirely about the removed justfile / `ralph-cli.sh`.
- `docs/unified-agent-system.md` + `docs/agent-teams.md` exist — describe the retired Director/Teams + analyst/builder/integrator model that no longer exists. (`unified-agent-system.md` + `cli.md` already carry "Historical note (GH-1438)" banners but still sit in the live tree.)
- `ralph/README.md:7` reads "**Plan 7 of 11 (caretake shipped).** … Verbs are migrated in one at a time per the plan-of-plans." and `:20` has a "## Migration progress" section — stale; the migration is done (all 9 verbs shipped, `plugin/ralph-hero/` deleted).
- `docs/archive/` does not exist yet.

### Key Discoveries

- **Scope is bounded to live-guide docs.** A repo-wide grep finds 748 `plugin/ralph-hero` references, but 693 are in `thoughts/` (historical corpus) and the remaining `docs/` hits are mostly in `docs/plans/**` + `docs/superpowers/plans/**` (dated 2026-03-xx historical design/impl docs). Those are *intentional historical* mentions and are explicitly out of scope (the living-vs-historical separation is sibling #1457). This issue touches only the 3 named live guides + `ralph/README.md`.
- Doc-only: no code paths, no tests assert on these files. CI does not test doc prose.

## Desired End State

1. `docs/cli.md`, `docs/unified-agent-system.md`, `docs/agent-teams.md` moved to `docs/archive/` (preserving git history via `git mv`).
2. `ralph/README.md` reflects the post-migration state (all verbs shipped; `plugin/ralph-hero/` deleted; no "Plan 7 of 11" / migration-in-progress framing).
3. No **live-guide** doc links resolve to `plugin/ralph-hero/...` paths. `docs/plans/**` + `thoughts/**` references remain untouched (intentional historical).
4. No code change; no behavior change.

### Verification

- Automated: `ls docs/archive/cli.md docs/archive/unified-agent-system.md docs/archive/agent-teams.md` all exist; `ls docs/cli.md` etc. → gone from live tree. `grep -nE 'Plan 7 of 11|Migration progress|migrated in one at a time' ralph/README.md` → no hits. `git log --follow docs/archive/cli.md` shows history preserved.
- Manual: read `ralph/README.md` and confirm it describes the completed migration; spot-check that no remaining *live-guide* doc (not `docs/plans/**`) links to `plugin/ralph-hero/`.

## What We're NOT Doing

- NOT touching `thoughts/**` or `docs/plans/**` / `docs/superpowers/plans/**` — those are the historical corpus (sibling #1457 owns their organization).
- NOT deleting content irreversibly where archiving preserves useful history — prefer `git mv` to `docs/archive/` over `rm` (the implementer may delete `docs/cli.md` if it's purely obsolete, but archiving is the safer default).
- NOT creating the `docs/README.md` index (that is sibling #1457).
- NOT addressing the `impl/SKILL.md:194 → §Delegated Summary` dangling ref (flagged on #1383; different file/issue).

## Implementation Approach

Two phases. Phase 1 archives the three stale guides (create `docs/archive/`, `git mv`). Phase 2 updates `ralph/README.md` to post-migration state. Both doc-only; Phase 2 is independent of Phase 1 (different files) but a single implementer does them in order.

## Phase 1: Archive the three stale guides
depends_on: null

### Overview
Move `docs/cli.md`, `docs/unified-agent-system.md`, `docs/agent-teams.md` into `docs/archive/`, preserving git history.

### Changes Required
#### 1. Create docs/archive/ and move the three files
**Files**: `docs/cli.md`, `docs/unified-agent-system.md`, `docs/agent-teams.md` → `docs/archive/`
**Changes**: `mkdir -p docs/archive`; `git mv docs/cli.md docs/archive/cli.md`; `git mv docs/unified-agent-system.md docs/archive/unified-agent-system.md`; `git mv docs/agent-teams.md docs/archive/agent-teams.md`. Stage BOTH the deletions and additions (a `git mv` is one rename, but verify `git status` shows the renames). Optionally prepend/keep a one-line "Archived (GH-1453): describes the pre-GH-1438 architecture" banner at the top of each if not already present.

### Success Criteria
#### Automated Verification
- [ ] `ls docs/archive/cli.md docs/archive/unified-agent-system.md docs/archive/agent-teams.md` — all exist.
- [ ] `test ! -e docs/cli.md && test ! -e docs/unified-agent-system.md && test ! -e docs/agent-teams.md` — gone from the live tree.
- [ ] `git log --oneline --follow docs/archive/cli.md | head -2` shows pre-move history (rename preserved).

#### Manual Verification
- [ ] The three archived files are clearly marked as historical.

## Phase 2: Update ralph/README.md to post-migration state
depends_on: null

### Overview
Replace the mid-migration "Plan 7 of 11" framing in `ralph/README.md` with the completed-migration state.

### Changes Required
#### 1. ralph/README.md post-migration rewrite
**File**: `ralph/README.md`
**Changes**: Rewrite line ~7 ("Plan 7 of 11 (caretake shipped)… migrated in one at a time per the plan-of-plans") to state the migration is complete — `ralph` is the sole Claude-Code-facing plugin (9 verbs), `plugin/ralph-hero/` was deleted in GH-1438. Update/remove the "## Migration progress" section (line ~20): either drop it or convert to a one-line "Migration complete (GH-1438)" note. Ensure no link points to `plugin/ralph-hero/...`.

### Success Criteria
#### Automated Verification
- [ ] `grep -nE 'Plan 7 of 11|migrated in one at a time' ralph/README.md` returns no hits.
- [ ] `grep -nE 'Migration progress' ralph/README.md` returns no hits (or only a "complete" note).
- [ ] `grep -n 'plugin/ralph-hero' ralph/README.md` returns no live link.
- [ ] `bash ralph/hooks/scripts/__tests__/*.test.sh` pass (no regression).

#### Manual Verification
- [ ] `ralph/README.md` reads as describing a completed migration, not an in-progress one.

## Testing Strategy

### Unit Tests
None — markdown moves + prose edits.

### Integration Tests
`bash ralph/hooks/scripts/__tests__/*.test.sh` (no regression; they don't assert on docs but confirm nothing breaks).

### Manual Testing Steps
1. `git status` confirms 3 renames into `docs/archive/`.
2. Read `ralph/README.md` for post-migration accuracy.
3. Grep the live-guide docs for residual `plugin/ralph-hero` links.

## Migration Notes

No data/config migration. `git mv` preserves history. Archived docs remain readable under `docs/archive/` for historical reference. `thoughts/**` and `docs/plans/**` are intentionally left as-is.

## References

- Issue #1453 (parent epic #1459); sibling #1457 (docs/README index) owns broader corpus organization
- GH-1438 / epic #1430 (the deletion that stranded these docs)
