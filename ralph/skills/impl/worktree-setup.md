# Worktree setup

_Filled by Phase 2 (suggestion + reuse) and Phase 5 (auto-mode lifecycle + cross-repo)._

Sections planned:

- §Suggestion — optional UX prompt for default-mode worktree creation
- §Reuse path — detect existing worktree at `worktrees/GH-NNN`, `git pull --no-edit`
- §Auto-mode lifecycle — epic detection, WORKTREE_ID selection (stream / epic / group / single), base-branch detection, create-or-reuse, rebase-onto-main if predecessor merged
- §Cross-repo (multi-worktree) — `.ralph-repos.yml` registry read, per-repo worktree creation, `RALPH_WORKTREE_PATHS` env var
- §Tilde expansion — always expand `~` in `localDir` before setting `RALPH_WORKTREE_PATHS` (hook compares against absolute `file_path`)
- §Escalation on merge conflict — `workflowState="__ESCALATE__"`, comment with conflicted files, STOP
