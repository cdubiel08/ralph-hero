# Artifact commit (autonomous modes)

How an autonomous mode lands a `thoughts/` artifact — a research findings doc, an implementation plan, a plan-of-plans, a UI baseline — in git.

**`main` takes no direct pushes.** It is ruleset-protected (GH-1589) and rejects *every* direct push, including from automation and from an admin. `git push origin main` is not "the fast path" here; it is a command that fails. Every artifact commit lands through a pull request merged by `scripts/merge-pr.sh`.

## The path

```bash
BRANCH="docs/GH-NNN-<artifact-kind>"     # e.g. docs/GH-1590-plan-of-plans
git checkout -b "$BRANCH" origin/main
git add thoughts/shared/<dir>/<the-file-you-wrote>.md
git commit -m "docs(<scope>): GH-NNN <one-line summary>"
git push -u origin "$BRANCH"

gh pr create --base main --head "$BRANCH" \
  --title "docs(<scope>): GH-NNN <one-line summary>" \
  --body "Autonomous <verb> artifact for #NNN. Doc-only change."

bash scripts/attest-pr.sh <pr-number>    # head_sha-bound verification evidence
bash scripts/merge-pr.sh <pr-number>     # the ONLY sanctioned merge

git checkout main && git pull --ff-only
```

Stage the artifact **by path**, never `git add -A` / `git add .` — an autonomous mode must publish only the file it wrote.

## Rules

- **Never `git push origin main`.** The ruleset rejects it; a mode that documents it is documenting a failure.
- **Never bare `gh pr merge`.** `merge-review-decision-gate.sh` blocks it, and it skips the review / CI / attestation gates `scripts/merge-pr.sh` enforces (`CLAUDE.md` § Merge gate).
- **A blocked merge is not a failed mode.** If the gates hold the PR (CI still running, review pending), leave it open, report the PR URL, and continue — the artifact is already durable on the branch and in the PR. Do not force, do not retry in a loop.
- **Return to `main`** before the mode ends, so the next tick's branch check passes.
- **After a merge touching `ralph/**`**, confirm `release-ralph.yml` fired (`gh run list --commit <merge-sha>`); it has `workflow_dispatch` as the manual backup when a push-event workflow silently does not fire.

## Where this applies

| Caller | Artifact |
|---|---|
| `research/SKILL.md` § --mode auto Step 7 | `thoughts/shared/research/…` findings doc |
| `research/playwright-baseline.md` § Autonomous-mode commit | `## UI Baseline` append to that findings doc |
| `plan/SKILL.md` § --mode auto Step 7 | `thoughts/shared/plans/…` implementation plan |
| `plan/decomposition.md` § Dispatch order Step 6 | `thoughts/shared/plans/…` plan-of-plans |

`caretake --mode enrich` follows the same no-direct-push rule but keeps its own long-lived `chore/enrich-ideas` branch and standing PR (it batches across heartbeat ticks rather than opening one PR per artifact) — see `caretake/modes/enrich.md` §Step 2b/§Step 4.
