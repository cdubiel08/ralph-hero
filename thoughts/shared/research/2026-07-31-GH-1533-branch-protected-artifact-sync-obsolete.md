---
date: 2026-07-31
status: complete
type: research
tags: [harness, branch-protection, git, artifacts, pr-flow, ralph-v2, cutover]
---

# GH-1533's problem no longer exists post-GH-1662

## Summary

GH-1533 (and its four phase children, GH-1534–1537) plan to build `sync-artifact.sh`:
a tool that detects whether a target repo's `main` is branch-protected and, if so,
routes doc-artifact commits (research findings, plan docs, post-mortems, UI baselines)
through a PR instead of `git push origin main`. The plan (`thoughts/shared/plans/2026-07-07-branch-protected-artifact-pr-sync.md`)
targets **five specific call sites** in the v1 ralph plugin that did inline
`git add … && git commit … && git push origin main` for doc artifacts, bypassing
the PR flow that code changes already used.

**All five call sites, and the v1 skill/hook architecture they lived in, were deleted
in the GH-1662 v2 cutover** (commit `e5ba8446`, "GH-1662 Phase 2 — the v2 cutover
surface"). The problem GH-1533 set out to solve — doc artifacts bypassing PR flow
on protected repos — was eliminated as a side effect of that rewrite, not solved by
building the tool this epic describes.

## Evidence

- `git log --oneline --diff-filter=D -- ralph/skills/research/SKILL.md ralph/skills/plan/SKILL.md ralph/skills/caretake/modes/postmortem.md ralph/hooks/scripts/doc-structure-validator.sh`
  → single commit `e5ba8446` deletes all of them.
- Current `ralph/skills/` tree: only `board/`, `work/`, `using-html/` remain (2 verb
  skills + 1 formatting skill). `ralph/hooks/` holds only `funnel-board.sh` and
  `funnel-merge.sh` — the `doc-structure-validator.sh` / `branch-gate.sh` /
  `artifact-write-tracker.sh` / `impl-verify-commit.sh` / `plan-postcondition.sh` /
  `research-postcondition.sh` hooks the plan's "Key Discoveries" section is built
  around no longer exist.
- `grep -rn "push origin main" ralph/` → zero matches. No skill in v2 does an inline
  doc-artifact push of any kind.
- `ralph/skills/work/SKILL.md` rule 6 (Provenance): *"Branch `feature/GH-NNN`;
  commits and the PR reference GH-NNN; one worktree per unit"* — this applies
  uniformly to **all** work `/ralph:work` does, docs included. v2 has one write path
  (branch → PR → `scripts/merge-pr.sh`), not two (code-via-PR, docs-via-direct-push)
  the way v1 did. There is no special-cased "doc commit" step left to reroute.
- CLAUDE.md (current, this repo): *"main is ruleset-protected — all changes land via
  PR."* This also inverts the plan's own "Migration Notes" section, which asserted
  *"No migration for ralph-hero itself — it does not protect `main`"* as of
  2026-07-07/05-28. ralph-hero's `main` has protected direct pushes since 2026-07-26
  (see memory `project_main_ruleset_no_direct_push`), so even the plan's stated
  baseline assumption about this repo is now stale.

## Why this happened

GH-1533 was filed/planned 2026-07-07, before GH-1662 (2026-07-31) replaced the
9-verb-skill v1 harness with the 2-skill v2 minimal harness. The v2 rewrite
unified all git write paths — code and docs alike — under the worktree +
`feature/GH-NNN` branch + PR + `merge-pr.sh` flow that only `impl` used to own.
That unification incidentally solved GH-1533's stated problem (doc artifacts
skipping the PR gate on protected repos) as a consequence of deleting the
special-cased direct-push mechanic entirely, not by adding branch-protection
detection to it.

## Recommendation

Close GH-1533 and its four children (GH-1534–1537) as superseded/obsolete rather
than implementing the plan. There is no `sync-artifact.sh` call site left to build
for — `/ralph:work`'s single write path already goes through PR unconditionally,
on every repo, protected or not. If a future need arises for *optional* direct-push
fast-pathing on unprotected repos (an optimization, not a correctness fix), that
would be new work against the v2 architecture, not a resumption of this plan.

## References

- `thoughts/shared/plans/2026-07-07-branch-protected-artifact-pr-sync.md` — the stale plan
- `thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md` — the v2 design record (normative)
- commit `e5ba8446` — "feat(ralph)!: GH-1662 Phase 2 — the v2 cutover surface" (deletes the five call sites + supporting hooks)
- `ralph/skills/work/SKILL.md` rule 6 — the single unified provenance rule that replaces the v1 direct-push special case
