# Worktree setup

How `/ralph:impl` creates, reuses, and isolates worktrees. Default mode is interactive (suggestion + reuse); auto mode is the full lifecycle (epic detection, base-branch detection, cross-repo).

**Creation mechanism (all modes, GH-1583):** worktrees are created via the built-in `EnterWorktree` tool, never a raw `git worktree add`, so the consuming repo's `WorktreeCreate` hook fires and provisions the tree (env/credential symlinks, package builds — whatever that repo's hook does). `EnterWorktree({name: "<WORKTREE_ID>"})` creates under that repo's `.claude/worktrees/<WORKTREE_ID>` and returns the path — capture it; never hardcode `worktrees/<WORKTREE_ID>` or assume a specific parent directory. `EnterWorktree({path: "<existing-path>"})` enters an *existing* worktree (the "enter what a script just made" flow) — this is how the CLI-script fallback below composes with the tool.

**Branch contract.** Ralph's `--mode pr` always resolves `feature/<WORKTREE_ID>` (SKILL.md `--mode pr` step 5). Whether `EnterWorktree({name})` produces that branch depends on the consuming repo's own `WorktreeCreate` hook configuration (e.g. landcrawler-ai's `LANDCRAWLER_WORKTREE_BRANCH_MAP=GH-*:feature/` — see that repo's `.claude/hooks/worktree-create.sh`). After creating, verify the branch:

```bash
ACTUAL_BRANCH=$(git -C "$WORKTREE_PATH" branch --show-current)
```

- `ACTUAL_BRANCH == "feature/$WORKTREE_ID"` → tool-first path succeeded fully. Continue.
- Anything else (e.g. the platform default `claude/$WORKTREE_ID`, meaning this repo's hook doesn't map this id pattern) → **fallback (Decision Option 2)**: if the repo has its own `scripts/create-worktree.sh` (or equivalent), remove the just-created tree (`git worktree remove "$WORKTREE_PATH"`, its branch is empty so this is safe), run that script instead (it names the branch `feature/$WORKTREE_ID` directly), then `EnterWorktree({path: "$WORKTREE_PATH"})` to enter it — creation bypassed the hook (the tool has no per-call branch-name parameter), but the script's own provisioning still runs, and the session enters through the tool-supported path. If the repo has no fallback script either, proceed on the platform-default branch and flag it in the phase report — a downstream `--mode pr` push against `feature/$WORKTREE_ID` will simply fail to find the branch, which is a clearer signal than silently mismatching.

## §Suggestion (default mode)

Default-mode worktree setup is **optional UX** — the user can implement in place if they prefer. Prompt:

```
Would you like me to set up an isolated worktree for this implementation?

This creates a separate working directory (via the built-in worktree tool,
so this repo's provisioning hook runs) so your main branch stays clean:
  EnterWorktree({name: "GH-NNN"})

Or we can implement directly in the current directory if you prefer.
```

If the user agrees:

```
EnterWorktree({name: "GH-NNN"})
```

`cd` into the path the tool returns (do not assume a literal `worktrees/GH-NNN` — see the creation-mechanism note above for the branch-verification + fallback steps).

## §Reuse path

If a worktree for `GH-NNN` already exists (recorded from a prior creation, or discovered via `git worktree list`), reuse it instead of creating a new one:

```
EnterWorktree({path: "<recorded worktree path>"})
```

```bash
git fetch origin main
git pull origin "$(git branch --show-current)" --no-edit
```

If `git pull` fails with a merge conflict, do NOT attempt to resolve — escalate per §Escalation.

**After entering the worktree**: all subsequent Read/Write/Edit/Bash operations must use paths inside the worktree (absolute or relative). `impl-worktree-gate.sh` enforces this for Write/Edit; staying inside the worktree is also necessary for git commands to operate on the correct branch.

## §Auto-mode lifecycle

`--mode auto` worktree setup is **mandatory** (not optional like default mode) and richer — it handles epic-member streams, base-branch detection, and rebase-onto-main when a predecessor branch has merged.

**Step 1: Detect epic membership.** From the issue's `parent` field (Step 3 of the auto-mode body), if `parent.estimate ∈ {"M","L","XL"}`, set `IS_EPIC_MEMBER=true` and `EPIC_NUMBER=parent.number`.

**Step 2: Choose WORKTREE_ID** based on context:

| Condition | WORKTREE_ID |
|-----------|-------------|
| Stream member (plan frontmatter has `stream_id`) | `GH-[EPIC_NUMBER]-stream-[SORTED-ISSUES]` |
| Group plan (frontmatter declares `github_issues`) | `GH-[primary_issue]` from plan frontmatter |
| Epic member (no stream, no group plan) | `GH-[EPIC_NUMBER]` |
| Single issue | `GH-[issue-number]` |

Precedence is the table order: stream > **group plan** > epic member > single. The group row outranks the epic-member row (GH-1538) — a sibling group plan is the authoritative shipping unit, and its `GH-[primary_issue]` ID is what `--mode pr` queue-pick resolves, so both halves agree on one worktree, one branch, one PR per group. The epic-member row applies only when NO group plan declares the member.

**Step 3: Base-branch detection.** If plan frontmatter or task description contains `base_branch: feature/GH-XX`, use that as the worktree's base (a stacked branch). Otherwise the base is whatever the consuming repo's `WorktreeCreate` hook resolves by default (typically `origin/<default-branch>`; see that repo's hook config) — never hardcode `origin/main` here.

```bash
BASE_BRANCH_ARG="${base_branch:-}"  # empty = repo's own hook default
```

**Step 4: Create or reuse worktree.**

```bash
if git worktree list | grep -q "/$WORKTREE_ID\$"; then
    WORKTREE_PATH=$(git worktree list | grep "/$WORKTREE_ID\$" | awk '{print $1}')
    # Reuse:
    # EnterWorktree({path: WORKTREE_PATH})
    git fetch origin main
    git pull origin "$(git branch --show-current)" --no-edit
elif [ -z "$BASE_BRANCH_ARG" ]; then
    # Common case: no stacked base — the tool-first path (see the
    # creation-mechanism note above for the post-create branch check +
    # Option-2 fallback).
    # EnterWorktree({name: WORKTREE_ID})
    :
else
    # Stacked branch: EnterWorktree has no per-call base-ref parameter (base
    # is governed by the repo/session's worktree.baseRef setting, not
    # overridable per invocation), so a custom base genuinely requires the
    # raw git command here — this is the one creation path that cannot go
    # through the hook. Provision manually via the repo's shared provisioner
    # if it has one, then enter through the tool's "enter what a script just
    # made" flow so the session and gate hooks treat it identically to a
    # tool-created tree.
    GIT_ROOT=$(git rev-parse --show-toplevel)
    WORKTREE_PATH="$GIT_ROOT/.claude/worktrees/$WORKTREE_ID"
    git worktree add -b "feature/$WORKTREE_ID" "$WORKTREE_PATH" "origin/$BASE_BRANCH_ARG"
    [ -x "$GIT_ROOT/scripts/provision-worktree.sh" ] && "$GIT_ROOT/scripts/provision-worktree.sh" "$WORKTREE_PATH"
    # EnterWorktree({path: WORKTREE_PATH})
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

**Step 2: Create worktrees in each repo.** For each repo, `cd <localDir>` then create via the tool (so that repo's own `WorktreeCreate` hook — if any — fires):

```
EnterWorktree({name: "GH-NNN"})
```

Apply the branch-verification + Option-2 fallback from the creation-mechanism note above per repo (each repo's hook, if configured, may or may not map this id pattern independently).

Example for `#601` spanning ralph-hero + landcrawler-ai — the tool reports each repo's own `.claude/worktrees/GH-601`:

```
~/projects/ralph-hero/.claude/worktrees/GH-601/
~/projects/landcrawler-ai/.claude/worktrees/GH-601/
```

**Step 3: Export `RALPH_WORKTREE_PATHS`.** Colon-separated absolute paths (the tool-reported paths from Step 2, not a guessed convention) so `impl-worktree-gate.sh` accepts Write/Edit calls into any of them:

```bash
export RALPH_WORKTREE_PATHS="/Users/dubiel/projects/ralph-hero/.claude/worktrees/GH-601:/Users/dubiel/projects/landcrawler-ai/.claude/worktrees/GH-601"
```

**Step 4: Pass mapping to builder sub-agents.** Include the per-repo worktree directories in the dispatch prompt so the implementer knows which files go where.

## §Tilde expansion

`.ralph-repos.yml` may use `~` in `localDir` values (`~/projects/foo`). **Always expand to absolute paths** before exporting `RALPH_WORKTREE_PATHS`. The hook compares against `tool_input.file_path`, which is always absolute — a tilde-prefixed entry will never match and writes will be blocked.

```bash
expanded=$(eval echo "$localDir")  # ~/projects/foo → /Users/dubiel/projects/foo
```

## §Escalation on merge conflict

If `git pull` fails with a merge conflict during reuse, do NOT attempt to resolve in-flow:

1. `save_issue(workflowState="__ESCALATE__", command="ralph_impl")` for the primary issue. (The `command` is required — without it `save_issue` takes the direct-state-name branch, and `"__ESCALATE__"` is not a valid state name, so the call is rejected before any of this plan's transition validation even runs.)
2. Post a comment with the conflicted files list (`git status --porcelain | grep '^UU'`).
3. STOP. Human resolution required.

Auto-mode locks (`__LOCK__`) have no unconditional backward-release edge server-side (GH-1616) — a stuck `In Progress` claim surfaces as a stale-lock signal in the orchestrator's next-actions ranking (GH-1617) for a human or `hero` to reclaim via `save_issue(force: true)`, not by a Stop hook. There is deliberately no automatic release from `In Progress` (the no-rollback asymmetry the state machine preserves).
