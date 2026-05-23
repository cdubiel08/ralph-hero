# Plan compliance

How `/ralph:impl` follows the plan's File Ownership Summary, stages files, and handles drift. The slim plugin pushes enforcement into hooks; this reference describes the workflow body's responsibilities.

## §File Ownership

The plan's **File Ownership Summary** table (or per-phase "Changes Required" file list) is the source of truth for which files this phase is allowed to touch. Workflow body responsibilities:

1. Read the table before starting the phase. Note exact paths.
2. Stage **only** files listed in the table (specific paths via `git add <file1> <file2> ...`).
3. Never use `git add -A`, `git add .`, or `git add --all`. The `impl-staging-gate.sh` hook blocks these commands when `RALPH_COMMAND=impl`; staying inside the rule keeps the hook from firing.
4. If a phase has no File Ownership Summary, fall back to staging only files you explicitly created or modified during this phase.

The hook does NOT enforce the positive case (you must enumerate). It enforces the negative case (no bulk-add).

Example staged-add session:

```bash
# Plan's File Ownership table lists: ralph/skills/impl/SKILL.md, ralph/hooks/scripts/impl-state-gate.sh
git add ralph/skills/impl/SKILL.md ralph/hooks/scripts/impl-state-gate.sh
git commit -m "feat(ralph): Plan 5 Phase 1 — /ralph:impl scaffold + hook ports"
```

## §Drift Log

When `git status` shows files modified or created that are NOT in the current phase's ownership:

1. **Do not stage them.** Skip.
2. Emit a warning to stderr (and optionally the issue's `## Drift Log` comment if running in auto mode):
   ```
   WARNING: Unexpected files not in Phase [N] ownership:
   - path/to/unexpected-file
   Skipping. These may belong to another agent or phase.
   ```
3. The `drift-tracker.sh` hook (PostToolUse on Write|Edit) records each off-ownership write to `${TMPDIR}/ralph-drift-${RALPH_TICKET_ID}.log`. Auto-mode phase quality review reads this log to populate the `## Drift Log — Phase N` issue comment.

Drift is a signal, not a failure. A small amount of drift is normal (formatting changes, generated files). A large drift indicates the plan needs iterating — surface it to the user (default mode) or commit + log + continue (auto mode).

Common drift sources to expect (and skip silently if they're not in the table):

- Build artifacts (`dist/`, `coverage/`, `*.log`).
- Lockfile bumps (`package-lock.json`, `Cargo.lock`) when an unrelated dep was touched.
- IDE state files (`.vscode/`, `.idea/`) — should be `.gitignore`d.
- Test snapshot updates (`__snapshots__/`) — usually in scope; if the plan lists `*.test.ts`, the matching snapshot is implicit.

> §Staging Algorithm, §Multi-repo Commits, §Mismatch Handling are filled in Phase 3 of [GH-1366](https://github.com/cdubiel08/ralph-hero/issues/1366).
