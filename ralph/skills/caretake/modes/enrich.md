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

## §Step 3: Enrich each selected file (bounded, serial)

For each of the (up to 5) selected files, run exactly three bounded lookups keyed on the idea's topic (title + "The Idea" body):

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

This step only runs when §Step 2 selected at least one file (N=0 already short-circuited to `Queue empty.`). `main` rejects all direct pushes (GH-1589 ruleset) — land the commit through a standing PR-only branch instead:

```bash
BRANCH="chore/enrich-ideas"
git fetch origin "$BRANCH" 2>/dev/null
if git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  git checkout -B "$BRANCH" "origin/$BRANCH"
  git merge --ff-only origin/main
else
  git checkout -B "$BRANCH" origin/main
fi
git add thoughts/shared/ideas
git commit -m "chore(ideas): enrich <N> idea file(s)"
git push origin "$BRANCH"
git checkout main
```

Open the PR (idempotent across heartbeat ticks — reuse the existing one if still open):

```bash
gh pr create --base main --head "$BRANCH" \
  --title "chore(ideas): enrich idea file(s)" \
  --body "Automated background enrichment (see the appended ## Enrichment sections). File-only change — no board/workflow-state mutation." \
  || gh pr view "$BRANCH" --json url -q .url
```

`gh pr create` fails with "already exists" once a PR is open for `$BRANCH` — that failure is expected on every subsequent tick; the new commit lands as an update to the existing open PR, so fall back to looking up its URL rather than treating the failure as an error.

**Push-failure rule.** On a branch-push reject (rare — `$BRANCH` is rebased onto `origin/main` above), retry the push once. If the retry also fails, emit `ENRICH SKIPPED push-rejected` — the commit stays local (findings are not lost; on the next pass those files are already at `status: forming` and will be skipped, so re-run manually to retry the push).

## §Step 5: Emit terminal token

Emit exactly one (see [outcome-tokens.md](../outcome-tokens.md)):

- `ENRICHED <N> (PR <url>)` — `<N>` files enriched, appended, and stamped this pass; committed to `chore/enrich-ideas` and opened/updated as a PR against `main` (never pushed directly). A noted remainder (§Step 2) belongs in the surrounding summary line, not the token itself.
- `Queue empty.` — no `status: draft` files found (§Step 2 short-circuit).
- `ENRICH SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit.
- `ENRICH SKIPPED push-rejected` — §Step 4 branch-push retry exhausted; commit stays local.

## §Constraints

- One pass per invocation; process at most 5 `status: draft` files, oldest-`captured`-first.
- Never dispatch research agents beyond the single locator sweep — no sub-agent fan-out, no full `/ralph:research` doc.
- Never create issues, never mutate board/workflow state — read-only against GitHub (`list_issues` search only).
- Mutates only the idea files it enriches (frontmatter + `## Enrichment` append) plus the commit/push of that change.
- Hand-off `forming` files (form Step 6c) are never re-selected or re-enriched — selection keys on `status: draft` only (see `intake-shapes.md` § Idea-file lifecycle contract).
