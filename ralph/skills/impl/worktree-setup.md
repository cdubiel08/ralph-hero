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

## §Auto-mode lifecycle

`--mode auto` worktree setup is **mandatory** (not optional like default mode) and richer — it handles epic-member streams, base-branch detection, and rebase-onto-main when a predecessor branch has merged.

**Step 1: Detect epic membership.** From the issue's `parent` field (Step 3 of the auto-mode body), if `parent.estimate ∈ {"M","L","XL"}`, set `IS_EPIC_MEMBER=true` and `EPIC_NUMBER=parent.number`.

**Step 2: Choose WORKTREE_ID** based on context:

| Condition | WORKTREE_ID |
|-----------|-------------|
| Stream member (plan frontmatter has `stream_id`) | `GH-[EPIC_NUMBER]-stream-[SORTED-ISSUES]` |
| Epic member (no stream) | `GH-[EPIC_NUMBER]` |
| Group plan (not epic) | `GH-[primary_issue]` from plan frontmatter |
| Single issue | `GH-[issue-number]` |

Stream rows take precedence over epic-member rows. Group rows take precedence over single-issue when plan frontmatter declares `github_issues`.

**Step 3: Base-branch detection.** If plan frontmatter or task description contains `base_branch: feature/GH-XX`, use that as the worktree's base. Otherwise default to `origin/main`.

```bash
BASE_BRANCH_ARG="${base_branch:-}"  # empty = origin/main
```

**Step 4: Create or reuse worktree.**

```bash
GIT_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="$GIT_ROOT/worktrees/$WORKTREE_ID"

if [ -d "$WORKTREE_PATH" ]; then
    cd "$WORKTREE_PATH"
    git fetch origin main
    git pull origin "$(git branch --show-current)" --no-edit
else
    "$GIT_ROOT/scripts/create-worktree.sh" "$WORKTREE_ID" "" "$BASE_BRANCH_ARG"
    cd "$WORKTREE_PATH"
fi
```

**Step 5: Rebase onto main if predecessor merged.** When `BASE_BRANCH_ARG` is set (stacked branch), check whether the predecessor branch has already been merged to main — if so, rebase onto main so the worktree doesn't carry a redundant merge base:

```bash
if [[ -n "$BASE_BRANCH_ARG" ]]; then
  git fetch origin main
  if git merge-base --is-ancestor "origin/$BASE_BRANCH_ARG" origin/main 2>/dev/null; then
    git rebase origin/main
  fi
fi
```

## §Cross-repo (multi-worktree)

When the research doc has a "Cross-Repo Scope" section, the implementation spans multiple repos and each repo gets its own worktree.

**Step 1: Identify repos.** Read `.ralph-repos.yml` from the project root; for each repo listed in the cross-repo scope, capture its `localDir`.

**Step 2: Create worktrees in each repo.** For each repo:

```bash
cd <localDir>
git worktree add worktrees/GH-NNN -b feature/GH-NNN
```

Example for `#601` spanning ralph-hero + landcrawler-ai:

```
~/projects/ralph-hero/worktrees/GH-601/
~/projects/landcrawler-ai/worktrees/GH-601/
```

**Step 3: Export `RALPH_WORKTREE_PATHS`.** Colon-separated absolute paths so `impl-worktree-gate.sh` accepts Write/Edit calls into any of them:

```bash
export RALPH_WORKTREE_PATHS="/Users/dubiel/projects/ralph-hero/worktrees/GH-601:/Users/dubiel/projects/landcrawler-ai/worktrees/GH-601"
```

**Step 4: Pass mapping to builder sub-agents.** Include the per-repo worktree directories in the dispatch prompt so the implementer knows which files go where.

## §Tilde expansion

`.ralph-repos.yml` may use `~` in `localDir` values (`~/projects/foo`). **Always expand to absolute paths** before exporting `RALPH_WORKTREE_PATHS`. The hook compares against `tool_input.file_path`, which is always absolute — a tilde-prefixed entry will never match and writes will be blocked.

```bash
expanded=$(eval echo "$localDir")  # ~/projects/foo → /Users/dubiel/projects/foo
```

## §Escalation on merge conflict

If `git pull` fails with a merge conflict during reuse, do NOT attempt to resolve in-flow:

1. `save_issue(workflowState="__ESCALATE__")` for the primary issue.
2. Post a comment with the conflicted files list (`git status --porcelain | grep '^UU'`).
3. STOP. Human resolution required.

Auto-mode locks (`__LOCK__`) are released by `lock-release-on-failure.sh` (Stop hook) if the flow stops without committing — so the issue returns to "Ready for Plan" or "In Progress" rather than being stuck in `__LOCK__`.
