# Worktree setup

How `/ralph:impl` creates, reuses, and isolates worktrees. Default mode is interactive (suggestion + reuse); auto mode is the full lifecycle (epic detection, base-branch detection, cross-repo).

## §Suggestion (default mode)

Default-mode worktree setup is **optional UX** — the user can implement in place if they prefer. Prompt:

```
Would you like me to set up an isolated worktree for this implementation?

This will create a separate working directory so your main branch stays clean:
  scripts/create-worktree.sh GH-NNN

The worktree will be at: worktrees/GH-NNN/ (branch: feature/GH-NNN)

Or we can implement directly in the current directory if you prefer.
```

If the user agrees:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
"$GIT_ROOT/scripts/create-worktree.sh" GH-NNN
cd "$GIT_ROOT/worktrees/GH-NNN"
```

## §Reuse path

If a worktree already exists at `worktrees/GH-NNN`, reuse it instead of creating a new one:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="$GIT_ROOT/worktrees/GH-NNN"

if [ -d "$WORKTREE_PATH" ]; then
    cd "$WORKTREE_PATH"
    git fetch origin main
    git pull origin "$(git branch --show-current)" --no-edit
fi
```

If `git pull` fails with a merge conflict, do NOT attempt to resolve — escalate per §Escalation.

**After `cd` into the worktree**: all subsequent Read/Write/Edit/Bash operations must use paths inside the worktree (absolute or relative). `impl-worktree-gate.sh` enforces this for Write/Edit; staying inside the worktree is also necessary for git commands to operate on the correct branch.

> §Auto-mode lifecycle, §Cross-repo, §Tilde expansion, §Escalation are filled in Phase 5 of [GH-1366](https://github.com/cdubiel08/ralph-hero/issues/1366).
