# Plan compliance

_Filled by Phase 2 (file-ownership + drift) and Phase 3 (staging + multi-repo + mismatch)._

Sections planned:

- §File Ownership — the plan's File Ownership Summary table is the source of truth; workflow body enumerates files; `impl-staging-gate.sh` blocks `git add -A`/`.`/`--all`
- §Drift Log — unexpected files: warn and skip, do not stage; `drift-tracker.sh` logs to `${TMPDIR}/ralph-drift-*.log`
- §Staging Algorithm — `git status --porcelain` → diff against File Ownership → `git add <file1> <file2>` (specific) → commit + push
- §Multi-repo Commits — when changes span multiple repos, commit and push separately per worktree; never global add
- §Mismatch Handling — STOP-and-think pattern with Expected / Found / Why-this-matters surface to the user
