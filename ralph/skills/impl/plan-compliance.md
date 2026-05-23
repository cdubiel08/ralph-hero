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

## §Staging Algorithm

After implementing the phase, before committing:

1. `git status --porcelain` — list all modified + new files.
2. Diff against the phase's File Ownership table.
3. For each file IN the table: `git add <path>`.
4. For each file NOT in the table: log to drift, skip.
5. `git diff --cached --stat` — sanity-check the staged set matches the phase.
6. Commit with a message identifying the phase: `feat(component): [phase description]` body line `Phase [N] of [M]: #NNN - [Title]`.
7. Push: `git push -u origin feature/GH-NNN`.

The `impl-verify-commit.sh` hook (PostToolUse on Bash) inspects the commit's `tool_output` for `nothing to commit`, `rejected`, or `pre-commit hook ... failed` and blocks the workflow when push fails.

## §Multi-repo Commits

When the plan spans multiple repos (research doc has a "Cross-Repo Scope" section):

1. **Commit and push separately in each repo's worktree.** Each repo gets its own PR.
2. Stage specific files only — never `git add -A`/`.`/`--all` in any repo.
3. Commit messages identify the repo: `feat(ralph-hero): [change]` vs `feat(landcrawler-ai): [change]`.
4. Push each branch separately: `cd <repo>/worktrees/GH-NNN && git push -u origin feature/GH-NNN`.

The `impl-staging-gate.sh` hook gates `Bash` calls across all worktrees uniformly via `RALPH_COMMAND=impl`; no per-repo configuration needed.

## §Mismatch Handling

When reality doesn't match the plan exactly, STOP and surface the gap. Do NOT silently adapt:

```
Issue in Phase [N]:
Expected: [what the plan says]
Found:    [actual situation]
Why this matters: [explanation]

How should I proceed?
```

Common mismatch sources:

- File listed in ownership but the path moved between plan-writing and implementation.
- Dependency added in a prior phase that changes the API the current phase consumes.
- Test framework upgraded; old assertion style no longer compiles.

In **default mode**, the user resolves the mismatch interactively (the question becomes part of the phase pause). In **auto mode**, the mismatch is itself a BLOCKED signal — emit `IMPL BLOCKED model=<current> needs=opus reason=<mismatch>` per [phase-execution.md §IMPL BLOCKED escalation](phase-execution.md) so hero can re-dispatch at a higher tier.
