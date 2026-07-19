---
date: 2026-07-19
github_issue: 1556
github_url: https://github.com/cdubiel08/ralph-hero/issues/1556
topic: "plan-research-required.sh mis-roots to session CWD — cannot see repo research docs from workspace-root sessions"
tags: [research, hooks, hook-utils, path-resolution, worktrees]
status: complete
type: research
---

# Research: plan-research-required.sh mis-roots to session CWD

## Prior Work

- builds_on:: [[2026-05-03-GH-0983-impl-branch-gate-cwd-bug]] (research — primary evidence; same class of session-CWD-vs-target-path hook bug, fixed via path-derived context in `resolve_target_branch()`)
- builds_on:: [[2026-05-24-relax-plan-research-required-gate]] (plan — introduced the estimate-aware gate and the `find_existing_artifact` + `get_project_root` pairing this bug lives in)
- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] (research — the doc the hook failed to see, triggering the `research_waived:` workaround in the GH-1550 plan)
- builds_on:: [[2026-03-18-GH-0596-hook-infrastructure]] (plan — original `get_project_root` usage patterns)

## Research Question

`ralph/hooks/scripts/plan-research-required.sh` resolves the research dir via `get_project_root` (hook-utils), which walks from the session CWD. In a session whose CWD is the multi-repo workspace root (`~/projects`, not a git repo), it resolves to `~/projects/thoughts/shared/research` and cannot see `~/projects/ralph-hero/thoughts/shared/research/`. The hook should resolve the research dir relative to the target file being written (walk up from `tool_input.file_path`). Audit siblings for the same bug.

## Summary

Confirmed. `get_project_root()` (`ralph/hooks/scripts/hook-utils.sh:43-45`) is a one-liner — `${CLAUDE_PROJECT_DIR:-$(pwd)}` — with no upward walk and no file-path input. `plan-research-required.sh:52` concatenates its output with `thoughts/shared/research` to compute the search dir, while using `tool_input.file_path` (already available at line 37) only for a `/plans/` substring test and a `GH-NNNN` regex. When the session CWD is `~/projects` and `CLAUDE_PROJECT_DIR` points there (or is unset), the hook searches the wrong tree and blocks a legitimate plan Write.

**8 hook scripts** call `get_project_root`; 6 of them use it to locate repo-rooted artifacts and are exposed to the same mis-rooting when the session CWD is not the target repo. There is **no existing shared helper** that walks up from a file path to its containing repo root — the closest analog (inline in `impl-worktree-gate.sh:30-36`) uses `git rev-parse` but is still CWD-relative. The natural fix is a new `resolve_root_from_path()` helper in `hook-utils.sh` that walks up from `tool_input.file_path` to the nearest ancestor containing a repo marker (`.git`), falling back to the current `get_project_root` behavior, then migrating the artifact-locating hooks to it.

Note: PR #1542 (referenced in the issue as the "worktree env gap" sibling) turned out to be **docs-only** (commit `e0288fd7` touches `CLAUDE.md` + `ralph/skills/setup/*` only) — it established the *principle* (path-derived context beats session-derived context) but shipped no hook helper to reuse. GH-983 (`8ee9e940`) is the real code precedent: `impl-branch-gate` gained a 3-tier `resolve_target_branch()` that prefers path-derived context and falls back to CWD.

## Detailed Findings

### The defect chain (plan-research-required.sh)

1. `plan-research-required.sh:36` — `read_input` caches the PreToolUse JSON payload.
2. `:37` — `file_path=$(get_field '.tool_input.file_path')` — the target path IS available, as an absolute path (the Write tool passes absolute paths; sibling hook `impl-worktree-gate.sh:43,52` relies on absolute-prefix matching against it).
3. `:39-50` — `file_path` is used only for the `/plans/` substring gate and `GH-NNNN` ticket extraction.
4. `:52` — `research_dir="$(get_project_root)/thoughts/shared/research"` — root comes from env/CWD, not from `file_path`.
5. `:53` — `find_existing_artifact "$research_dir" "$ticket_id"` (`hook-utils.sh:235-258`) searches the mis-rooted dir.
6. `:93` — block message embeds the wrong dir: "Expected: Research document in $research_dir" — exactly the message observed for GH-1550.

### get_project_root and its call sites

`hook-utils.sh:43-45`:
```bash
get_project_root() {
  echo "${CLAUDE_PROJECT_DIR:-$(pwd)}"
}
```

8 scripts call it; exposure to the mis-rooting bug:

| Script | Call site | Usage | Exposed? |
|---|---|---|---|
| `plan-research-required.sh` | :52 | research-dir lookup | **Yes — the reported bug** |
| `impl-plan-required.sh` | :43, :72-73 | plans-dir lookup + plan-ref existence checks | **Yes** — same artifact-lookup shape |
| `plan-postcondition.sh` | :58 | artifact path validation (Stop hook) | **Yes** |
| `research-postcondition.sh` | :19 | research-dir validation (Stop hook) | **Yes** |
| `review-no-dup.sh` | :26 | artifact discovery | **Yes** |
| `artifact-write-tracker.sh` | :31 | rel→abs normalization of `file_path` | Partial — only fires when `file_path` is relative; absolute paths bypass it |
| `drift-tracker.sh` | :33-34 | abs→rel prefix-strip (`${file_path#$project_root/}`) | Partial — wrong root leaves path unstripped (silent misbehavior, not a block) |
| `hook-utils.sh` (`check_branch`) | :87 | `cd` target for `git branch` | Different class — branch checks, covered by GH-983-style logic where needed |

Note on Stop-hook callers (`plan-postcondition.sh`, `research-postcondition.sh`): Stop hooks have **no** `tool_input.file_path` — a file-path-derived helper only applies to PreToolUse/PostToolUse callers. Postcondition hooks would need session-tracked artifact paths (they already read the artifact tracker's session file) or stay on `get_project_root`.

### Existing patterns to model after

- **`impl-worktree-gate.sh:30-36`** — inline git-based root resolution (`git rev-parse --path-format=absolute --git-common-dir`), worktree-aware but CWD-relative; not a shared helper.
- **GH-983 fix (`8ee9e940`)** — `resolve_target_branch()` 3-tier fallback in `impl-branch-gate.sh`: parse path from tool input → env (`RALPH_WORKTREE_PATHS`) → CWD fallback with warn-don't-block. This is the established repo precedent for "path-derived context first, session-derived fallback."
- **`artifact-write-tracker.sh:29-31`** — the rel→abs normalization guard, showing hooks already defend against non-absolute `file_path`.

### Proposed shape (for the plan phase)

A shared helper in `hook-utils.sh`, e.g.:

```bash
# Walk up from a file path to the nearest ancestor containing .git;
# fall back to get_project_root when no marker found (or path empty).
resolve_root_from_path() {
  local dir; dir=$(dirname "$1")
  while [[ "$dir" != "/" && -n "$dir" ]]; do
    [[ -e "$dir/.git" ]] && { echo "$dir"; return; }
    dir=$(dirname "$dir")
  done
  get_project_root
}
```

`-e` (not `-d`) matters: in linked worktrees `.git` is a file. Then `plan-research-required.sh:52` becomes `research_dir="$(resolve_root_from_path "$file_path")/thoughts/shared/research"`. Sibling migrations (`impl-plan-required.sh`, `review-no-dup.sh`) follow the same substitution where a `file_path` is in hand. XS scope holds if the fix targets `plan-research-required.sh` + the helper + tests, with sibling migration noted as follow-up or included if trivial.

## Code References

- `ralph/hooks/scripts/hook-utils.sh:43-45` — `get_project_root` definition (env/CWD only)
- `ralph/hooks/scripts/plan-research-required.sh:37` — `file_path` extraction (available but unused for rooting)
- `ralph/hooks/scripts/plan-research-required.sh:52-53` — mis-rooted research-dir computation + artifact search
- `ralph/hooks/scripts/plan-research-required.sh:90-102` — block message embedding the wrong dir
- `ralph/hooks/scripts/hook-utils.sh:235-258` — `find_existing_artifact` (searches whatever root it's given)
- `ralph/hooks/scripts/impl-worktree-gate.sh:30-36` — inline git-based root resolution (closest analog)
- `ralph/hooks/scripts/impl-plan-required.sh:43,72-73` — sibling with same exposure
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh:35` — tests force `CLAUDE_PROJECT_DIR="$SBX"`, confirming env/CWD dependency

## Architecture Documentation

Hook scripts are bash gates sourced from `hook-utils.sh`, registered per-skill as PreToolUse/PostToolUse/Stop. The repo's established correction pattern for session-vs-target context bugs (GH-983) is a tiered resolver: derive context from the tool call's own inputs first, fall back to env vars, then CWD. Tests run hooks in a `TMPDIR` sandbox with `CLAUDE_PROJECT_DIR` overridden, so a new path-derived resolver needs sandbox fixtures where the target file lives in a *different* tree than `CLAUDE_PROJECT_DIR` to prove the fix.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md` — carries the live `research_waived:` workaround for this exact bug (human-approved override 2026-07-19).
- `thoughts/shared/research/2026-05-03-GH-0983-impl-branch-gate-cwd-bug.md` — the sibling CWD bug and its fix pattern.
- `thoughts/shared/plans/2026-05-24-relax-plan-research-required-gate.md` — where the gate's current structure (estimate waiver, `research_waived:`) was built.
- `ralph/skills/setup/scope-detection.md` § Worktrees and bridge sessions — the PR #1542 docs on session-derived env gaps.

## Related Research

- `thoughts/shared/research/2026-05-03-GH-0983-impl-branch-gate-cwd-bug.md`
- `thoughts/shared/research/2026-03-02-GH-0500-artifact-comment-protocol-gaps.md` — documents `find_existing_artifact` usage
- `thoughts/shared/research/2026-05-14-GH-1250-pr1251-elegant-fixes-from-ralph-hero.md` — documents `find_existing_artifact()` helper internals

## Files Affected

### Will Modify
- `ralph/hooks/scripts/hook-utils.sh` — Add `resolve_root_from_path()` helper (walk up from a file path to nearest `.git` ancestor, fall back to `get_project_root`)
- `ralph/hooks/scripts/plan-research-required.sh` — Compute `research_dir` from `resolve_root_from_path "$file_path"` instead of `get_project_root`
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` — Add a case where the plan Write targets a repo tree different from `CLAUDE_PROJECT_DIR` (workspace-root session repro)

### Will Read (Dependencies)
- `ralph/hooks/scripts/impl-worktree-gate.sh` — Reference for git-based root resolution and absolute-path assumptions
- `ralph/hooks/scripts/impl-plan-required.sh` — Sibling exposure; candidate for same substitution if in scope
- `ralph/hooks/scripts/review-no-dup.sh` — Sibling exposure; candidate for same substitution if in scope
- `ralph/hooks/scripts/artifact-write-tracker.sh` — Rel→abs normalization precedent

## Open Questions

- Should sibling migrations (`impl-plan-required.sh`, `review-no-dup.sh`, `artifact-write-tracker.sh`, `drift-tracker.sh`) ship in this XS fix or as a follow-up issue? (Stop-hook postconditions can't use the helper at all — they have no `tool_input.file_path`.)
- Should the helper prefer `git -C "$(dirname "$file_path")" rev-parse --show-toplevel` over a manual `.git`-marker walk? Manual walk avoids a git dependency and behaves identically for the repro case; git handles nested/odd layouts better but resolves linked worktrees to the worktree root (which is actually the desired behavior for locating `thoughts/`... in worktree checkouts that contain their own `thoughts/` tree — worth a decision in the plan).
