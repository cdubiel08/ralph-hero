# `--mode enrich`

Background enrichment pass over freshly captured idea files: for each `status: draft` file in `thoughts/shared/ideas/`, run three bounded lookups (codebase locator sweep, prior-art search, related-issue search), append the findings under `## Enrichment`, and flip `status: forming` + stamp `enriched`. Bounded and non-committal — never a full research doc, never board mutation. Emits one terminal token per invocation (see [outcome-tokens.md](../outcome-tokens.md)).

```bash
export RALPH_SUBCOMMAND=enrich
```

This is the background half of the capture custody chain: `/ralph:form --mode draft` (#1559) writes `status: draft` + `captured`; this mode grounds each draft in codebase/prior-art/issue context before the daily brief (#1553, downstream reader) ever sees it.

No `Stop` hook gates this mode (parity with `--mode hygiene`/`--mode watch`) — it never mutates GitHub workflow state. The terminal token is emitted by convention, not hook-enforced. **It does write to git** (§Step 4) — `main` is ruleset-protected (GH-1589: no direct pushes, even from automation), so this mode lands its commit through a PR, never a direct push to `main`.

## §Step 1: Verify branch

```bash
git branch --show-current
```

If NOT on `main`, STOP and emit:

```
ENRICH SKIPPED — branch <name> is not main
```

Idea files are tracked in git on `main`; enrichment commits must not land on a stray feature branch (parity with the watch-mode branch guard).

## §Step 2: Select drafts

Glob `thoughts/shared/ideas/*.md`. Read each file's frontmatter; select files with `status: draft` — skip `forming`, `refined`, or anything else (idempotency; see `intake-shapes.md` § Idea-file lifecycle contract — hand-off `forming` files are never touched here, selection keys on `status: draft` only).

If no `status: draft` file is found, emit:

```
Queue empty.
```

and STOP.

**Per-pass cap.** Sort the selected files by `captured` ascending (oldest first; files missing `captured` sort last) and process at most the **5 oldest**. If more than 5 files are eligible, note the remainder count in the summary line so a backlog drains across successive heartbeats instead of straining one tick.

## §Step 2b: Prepare the enrichment branch (BEFORE any file edit)

Establish `chore/enrich-ideas` **before** §Step 3 touches a file. Doing it after the edits would run `git checkout -B` / `git merge --ff-only` against a dirty worktree (the merge refuses; the checkout can carry or clobber the edits), and — worse — force-resetting the local branch would silently discard an enrichment commit that a previous pass created but could not push (§Step 4's push-failure rule leaves exactly that).

```bash
BRANCH="chore/enrich-ideas"
# Fetch BOTH refs. `origin/main` is the base for every create/fast-forward
# below; a stale local `origin/main` would branch the standing PR off an
# outdated base and produce a stale-or-conflicting PR.
git fetch origin main 2>/dev/null || true
git fetch origin "$BRANCH" 2>/dev/null || true

if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  # Local branch exists. NEVER -B it: it may hold a recovered, unpushed
  # enrichment commit. Switch to it as-is and fast-forward onto origin/main
  # only if that is a clean no-merge-commit move.
  git checkout "$BRANCH"
  git merge --ff-only origin/main 2>/dev/null || true
elif git rev-parse --verify --quiet "refs/remotes/origin/$BRANCH" >/dev/null; then
  git checkout -b "$BRANCH" "origin/$BRANCH"
  git merge --ff-only origin/main 2>/dev/null || true
else
  git checkout -b "$BRANCH" origin/main
fi
```

If the checkout fails for any reason, STOP before editing and emit `ENRICH SKIPPED branch-setup-failed` — never fall back to enriching on `main`.

## §Step 3: Enrich each selected file (bounded, serial)

**Re-validate the selection first.** §Step 2 read frontmatter on `main`; §Step 2b may then have checked out `chore/enrich-ideas` carrying a prior pass's unpushed enrichment commit, in which case a file that was `status: draft` during selection is `status: forming` on the branch now checked out. Re-read each selected file's frontmatter **after** the checkout and drop any that is no longer `status: draft` — enriching one twice appends a second `## Enrichment` section. If the re-read empties the selection, emit `Queue empty.`, return to `main` (§Step 4's `return_to_main`), and STOP. Keep the surviving paths in `SELECTED_FILES` — §Step 4 stages exactly those.

For each of the (surviving, up to 5) selected files, run exactly three bounded lookups keyed on the idea's topic (title + "The Idea" body):

1. One `Agent(subagent_type="ralph:codebase-locator", prompt="Find files related to [idea topic]")` sweep — one-line entries only, no deep read.
2. One `knowledge_search` prior-art query (`type: "idea"`, `limit: 3`) — skip silently (empty subsection, noted as unavailable) if the tool is not available.
3. One related-issues lookup: `list_issues(query: "[idea topic keywords]", limit: 5)`.

Append a `## Enrichment` section to the file:

```markdown
## Enrichment

_Enriched: <UTC ISO-8601 timestamp>_

### Codebase

- [path] — [one-line finding] (or "No related files found.")

### Prior art

- [path] — [title] (or "No related ideas/plans found." / "knowledge_search unavailable.")

### Related issues

- #NNN — [title] ([workflow state]) (or "No related issues found.")
```

Update frontmatter: `status: forming`, `enriched: <same UTC ISO-8601 timestamp>`.

## §Step 4: Commit and open (or update) a PR — never push `main` directly

This step only runs when §Step 2 selected at least one file (N=0 already short-circuited to `Queue empty.`). The branch is already checked out from §Step 2b; `main` rejects all direct pushes (GH-1589 ruleset), so the commit lands through that standing PR-only branch:

```bash
# EVERY exit path returns to main — the commit is already safe on the local
# `chore/enrich-ideas` ref, and leaving that branch checked out would strand the
# next heartbeat at §Step 1's main-only gate (it would emit `ENRICH SKIPPED —
# branch chore/enrich-ideas is not main` forever and never reach §Step 2b's
# recovery path). The return itself is checked: an unchecked `git checkout main`
# that fails would claim recovery while leaving the session on the branch,
# producing exactly the strand it exists to prevent.
return_to_main() {
  if ! checkout_err=$(git checkout main 2>&1); then
    printf '%s\n' "ENRICH BLOCKED checkout-main-failed: ${checkout_err}"
    exit 0
  fi
}

# Stage ONLY the files this invocation enriched (§Step 3's SELECTED_FILES).
# `git add thoughts/shared/ideas` swept in every modified idea file, including
# unrelated worktree edits — contradicting the "mutates only the idea files it
# enriches" constraint and publishing that unrelated content in the PR.
git add -- "${SELECTED_FILES[@]}"

# The commit is checked like every other command in this block. An unchecked
# commit that fails (pre-commit hook, empty staging set, identity not
# configured) leaves the push below a no-op that "succeeds", the PR-already-
# exists fallback then returns a URL, and the mode reports
# `ENRICHED <N> (PR <url>)` for findings that never reached a PR — while §Step 3
# has already flipped those files to `status: forming`, so they are never
# re-selected. The findings would be lost silently.
if ! commit_err=$(git commit -m "chore(ideas): enrich <N> idea file(s)" 2>&1); then
  return_to_main
  printf '%s\n' "ENRICH BLOCKED commit-failed: ${commit_err}"
  exit 0
fi

# Classify BEFORE retrying. Only a remote-branch rejection is retryable — that
# is what the fetch + fast-forward actually repairs. Authentication, permission,
# protected-branch, and network failures are NOT fixed by fetching; retrying
# them and then reporting `push-rejected` mislabels a credentials outage as a
# routine branch divergence and hides the stderr an operator needs.
if ! push_err=$(git push origin "$BRANCH" 2>&1); then
  if printf '%s' "$push_err" | grep -qiE '\[rejected\]|non-fast-forward|fetch first|stale info|updates were rejected'; then
    git fetch origin "$BRANCH" 2>/dev/null || true
    git merge --ff-only "origin/$BRANCH" 2>/dev/null || true
    if ! push_err=$(git push origin "$BRANCH" 2>&1); then
      # Retry exhausted on a genuine branch rejection. The commit survives on
      # the local branch ref; only the checkout returns.
      return_to_main
      printf '%s\n' "ENRICH SKIPPED push-rejected"
      exit 0
    fi
  else
    # Auth / permission / network / anything else: not retryable, and not a
    # rejection. Surface the diagnostics instead of laundering them.
    return_to_main
    printf '%s\n' "ENRICH BLOCKED push-failed: ${push_err}"
    exit 0
  fi
fi
return_to_main
```

Open the PR (idempotent across heartbeat ticks — reuse the existing one if still open):

```bash
if pr_err=$(gh pr create --base main --head "$BRANCH" \
      --title "chore(ideas): enrich idea file(s)" \
      --body "Automated background enrichment (see the appended ## Enrichment sections). File-only change — no board/workflow-state mutation." 2>&1); then
  PR_URL="$pr_err"
elif printf '%s' "$pr_err" | grep -qi 'already exists'; then
  # Expected on every tick after the first: the new commit lands as an update
  # to the open PR. This is the ONLY failure that is not a failure — but the
  # lookup that recovers the URL is itself fallible (auth, network, rate limit),
  # and swallowing it would report `ENRICHED <N> (PR )` for a pass with no
  # reviewable PR URL. Check the exit status AND the emptiness of the result.
  if ! view_err=$(gh pr view "$BRANCH" --json url -q .url 2>&1) || [[ -z "$view_err" ]]; then
    printf '%s\n' "ENRICH BLOCKED pr-create-failed: PR already exists but lookup failed: ${view_err:-empty url}"
    exit 0
  fi
  PR_URL="$view_err"
else
  printf '%s\n' "ENRICH BLOCKED pr-create-failed: ${pr_err}"
  exit 0
fi
```

Only the literal "already exists" failure falls back to `gh pr view`. Authentication failures, validation errors, rate limiting, and network errors must **not** be swallowed — masking them behind the duplicate-PR fallback would report `ENRICHED <N> (PR <url>)` for a pass whose findings never reached a reviewable PR. Those emit `ENRICH BLOCKED pr-create-failed: <stderr>` instead; the branch and commit are already pushed, so re-running the mode (or opening the PR by hand) recovers.

The fallback `gh pr view` is checked the same way, for the same reason: it can fail (or return an empty URL) on exactly the auth/network/rate-limit conditions the branch above exists to surface. A failed lookup emits `ENRICH BLOCKED pr-create-failed: PR already exists but lookup failed: <stderr>` — never `ENRICHED <N> (PR )`.

**Push-failure rule.** `push-rejected` is reserved for **retryable remote-branch rejections** — the non-fast-forward / `fetch first` / stale-info family, which is precisely what the fetch + fast-forward retry repairs. On one of those, the retry runs once; if it also fails, **return to `main`** and emit `ENRICH SKIPPED push-rejected` — the commit stays on the local `chore/enrich-ideas` ref, which §Step 2b's non-destructive branch setup preserves and re-checks-out on the next pass. Every other push failure (authentication, permission, protected branch, network, rate limit) is **not** a rejection and is **not** retried: it returns to `main` and emits `ENRICH BLOCKED push-failed: <stderr>` with the diagnostics intact. Classifying those as `push-rejected` would report a credentials outage as routine branch divergence and burn a pointless retry against a remote that is not reachable. The return to `main` is itself checked on every path — a failed `git checkout main` emits `ENRICH BLOCKED checkout-main-failed: <stderr>` rather than silently claiming recovery from the wrong branch. Returning to `main` is what keeps that recovery reachable: §Step 1's branch gate stops the whole mode when the session is not on `main`, so leaving the enrichment branch checked out would strand the commit permanently (`ENRICH SKIPPED — branch chore/enrich-ideas is not main` every heartbeat, §Step 2b never reached). Findings are not lost, but the enriched files are already at `status: forming` and will not be re-selected, so the local commit is the only copy until it pushes.

## §Step 5: Emit terminal token

Emit exactly one (see [outcome-tokens.md](../outcome-tokens.md)):

- `ENRICHED <N> (PR <url>)` — `<N>` files enriched, appended, and stamped this pass; committed to `chore/enrich-ideas` and opened/updated as a PR against `main` (never pushed directly). A noted remainder (§Step 2) belongs in the surrounding summary line, not the token itself.
- `Queue empty.` — no `status: draft` files found (§Step 2 short-circuit).
- `ENRICH SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit.
- `ENRICH SKIPPED branch-setup-failed` — §Step 2b could not check out `chore/enrich-ideas`; no file was edited.
- `ENRICH SKIPPED push-rejected` — §Step 4 branch-push **rejection** (non-fast-forward / fetch-first / stale info) survived the one fetch + fast-forward retry; commit stays local on `chore/enrich-ideas` and the checkout returns to `main` so the next heartbeat can retry.
- `ENRICH BLOCKED commit-failed: <stderr>` — §Step 4 `git commit` failed (pre-commit hook, nothing staged, unconfigured identity, …). The enriched files are already at `status: forming` on the branch but nothing was committed, so the pass is reported as blocked rather than as an `ENRICHED <N> (PR <url>)` that points at a PR containing none of these findings. The checkout returns to `main`.
- `ENRICH BLOCKED push-failed: <stderr>` — §Step 4 `git push` failed for a **non-retryable** reason (auth, permission, protected branch, network, rate limit). Not retried, not relabeled as `push-rejected`; the commit stays local and the checkout returns to `main`.
- `ENRICH BLOCKED checkout-main-failed: <stderr>` — §Step 4's return to `main` failed. The commit is safe on `chore/enrich-ideas` but the session is still on that branch, so the next heartbeat will stop at §Step 1's gate until an operator runs `git checkout main`.
- `ENRICH BLOCKED pr-create-failed: <stderr>` — §Step 4 `gh pr create` failed for a reason OTHER than an already-open PR (auth, validation, rate limit, network), **or** the already-exists fallback's `gh pr view` failed / returned an empty URL. The commit is pushed; only the PR (or its URL) is missing.

## §Constraints

- One pass per invocation; process at most 5 `status: draft` files, oldest-`captured`-first.
- Never dispatch research agents beyond the single locator sweep — no sub-agent fan-out, no full `/ralph:research` doc.
- Never create issues, never mutate board/workflow state — read-only against GitHub (`list_issues` search only).
- Mutates only the idea files it enriches (frontmatter + `## Enrichment` append) plus the commit/push of that change.
- Never force-resets `chore/enrich-ideas` (`git checkout -B`) — an existing local branch may hold an unpushed enrichment commit from a prior pass, and that commit is the only copy of those findings.
- Hand-off `forming` files (form Step 6c — `../../form/output-paths.md`) are never re-selected or re-enriched — selection keys on `status: draft` only (see `intake-shapes.md` § Idea-file lifecycle contract).
