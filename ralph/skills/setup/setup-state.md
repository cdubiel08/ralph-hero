# Setup state classification

> Consulted by `/ralph:setup` default mode Step 2. Makes the mode idempotent: re-running never blindly re-triggers the mutating bootstrap (owner Q&A, project creation, field extension, env-var write) — it first classifies what's already there and only proceeds on explicit confirmation.

## Why this exists

Before this step existed, default mode ran `health_check` for display purposes only and then fell straight through into "determine project owner" → "create-or-verify project" regardless of what `health_check` reported. A user re-running `/ralph:setup` to check on a flaky setup would watch it silently start mutating (asking owner questions, calling `setup_project`) instead of telling them what was actually wrong. This step closes that gap.

## Step 2: classify

Run `health_check` unconditionally — it is read-only, safe to call regardless of config state. Classify purely from its `checks` object (`auth`, `repoAccess`, `projectAccess`, `requiredFields`, each `ok` / `fail` / `skip`, `requiredFields` may be absent entirely when `projectAccess` never resolved a project) — do not gate on the env vars beyond what `health_check` already resolved, since a `broken` config (e.g. wrong project number) still has env vars *set*, just pointing at something invalid.

Classify into exactly one of three states, checked in this order:

| State | Condition |
|---|---|
| `broken` | Any of `auth` / `repoAccess` / `projectAccess` / `requiredFields` has `status === "fail"`. Checked first — a `fail` always means something. |
| `healthy` | No `fail` anywhere, AND `auth` / `repoAccess` / `projectAccess` / `requiredFields` are all present with `status === "ok"` (nothing skipped, nothing missing) |
| `not-set-up` | No `fail` anywhere, but not fully green — at least one of `repoAccess` / `projectAccess` is `skip`, or `requiredFields` is absent. Covers both "nothing configured yet" and "repo configured, project not created yet." |

Do not classify on `RALPH_GH_OWNER`/`RALPH_GH_PROJECT_NUMBER` presence directly — `health_check`'s `checks` already encodes that (a `skip` status *is* "this var wasn't set"). Checking `fail` first prevents a subtle miscount: an auth failure cascades into `repoAccess`/`projectAccess` also failing, which could look like "everything's broken" — that's correct, it's still just `broken`, and the diagnosis step below surfaces `auth` as the root cause via the fail-first table walk.

This step **never mutates** — no `AskUserQuestion`, no writes, no `setup_project` calls happen here. It only reads and reports.

## Branch on state

### `healthy`

Print a one-line status summary from `health_check.config` (owner, repo, project number, project title) and **STOP**. Do not run steps 4-8 unless the user passes an explicit project-number arg (treated as an intentional re-verify/extend request) or explicitly asks to proceed anyway.

```
result: Setup already healthy — project #<N> "<title>", owner <owner>, repo <repo>. Nothing to do.
```

### `broken`

Map each `fail` check to a diagnosis + recommended fix using the table below. Print the diagnosis (which check failed, the `detail` message `health_check` returned, and the fix) and then `AskUserQuestion` with these options before touching anything:

- **Attempt the fix now** — only offered when the fix is something this skill can safely automate (see "Automatable?" column below). Proceeds to steps 4-8.
- **Show me the fix, I'll do it myself** — print the fix instructions (rotation command, scope-detection guidance, etc.) and STOP without mutating.
- **Cancel** — STOP without mutating.

If multiple checks failed, diagnose all of them before asking — don't stop at the first failure, since `auth` failing cascades into `repoAccess`/`projectAccess` also failing and the user needs the root one, not just the first one alphabetically.

```
result: Setup broken — <check> failed (<detail>). Recommended fix: <fix>. <chosen action>.
```

### `not-set-up`

**Worktree check first.** Before treating this as a fresh install, run `git rev-parse --git-dir --git-common-dir` — if the two paths differ, the session is in a **linked worktree**, and the likely cause is not "never configured" but "config didn't travel": scope vars live in the main checkout's gitignored `.claude/settings.local.json`, which no worktree checkout contains (see [scope-detection.md](scope-detection.md) § Worktrees and bridge sessions). Diagnose it as such and offer the two remedies from that section (track scope vars in `.claude/settings.json`, or copy `settings.local.json` into this worktree's `.claude/`), instead of the project-creation flow below.

```
result: Setup gap — worktree session missing RALPH_GH_* (main checkout config is gitignored settings.local.json). Fix: track scope vars in .claude/settings.json or hydrate this worktree. <chosen action>
```

Otherwise, explain, in plain language, what running setup will do:

- Create a new GitHub Project V2 (or, if the user passes a project number, verify + extend an existing one)
- Add the required custom fields (Workflow State, Priority, Estimate — see [project-fields.md](project-fields.md))
- Write `RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER` to the settings file resolved in Step 1

Then `AskUserQuestion`: **Proceed** / **Cancel**. Only continue to steps 4-8 on **Proceed**.

```
result: Setup paused — not configured yet. Declined to proceed. Resume anytime: /ralph:setup
```

## Diagnosis → fix table

| Check | `fail` meaning | Recommended fix | Automatable? |
|---|---|---|---|
| `auth` | Token invalid, expired, or missing required scopes | Rotate/re-auth — see [token-setup.md](token-setup.md). `gh auth login -s repo,project,read:org` (keychain mode) or regenerate the PAT and update the settings file (PAT modes). Requires a Claude Code restart after. | No — needs a human to run `gh auth login` interactively or paste a new PAT |
| `repoAccess` | Auth OK but the token/owner/repo combination can't see the repo | Check `RALPH_GH_OWNER`/`RALPH_GH_REPO` values are correct; confirm the token has `repo` scope and (for org repos) org access. See [token-setup.md](token-setup.md) § Required scopes. | No — depends on which value is wrong; ask before changing env vars |
| `projectAccess` | Auth + repo OK but the project number/owner combination doesn't resolve | If the repo and project have different owners, this is a split-owner setup — see [token-setup.md](token-setup.md) § dual-token, or re-run `/ralph:setup` with `AskUserQuestion` to pick the right owner (Step 4). If the project simply doesn't exist yet, this is really `not-set-up` for the project layer — offer to create one. | Partially — offering the owner-selection re-ask (Step 4) is safe; creating a brand-new project is a bigger action and should still go through the `not-set-up` confirmation copy |
| `requiredFields` | Project exists and is reachable, but is missing `Workflow State` / `Priority` / `Estimate` | Extend the existing project with the missing fields via `setup_project` in extend mode — this is additive and non-destructive (it only adds fields, never removes or renames). | Yes — offer as the default "Attempt the fix now" action |

## Idempotency guarantee

Re-running `/ralph:setup` with no arguments and a fully healthy config must be a **no-op that only reads** (`health_check`) — it must never call `setup_project`, write env vars, or ask owner questions unless the state classification found something to fix or the user explicitly opted in. This is what makes it safe to run `/ralph:setup` as a status check at any time, the same way `ralph doctor` used to.
