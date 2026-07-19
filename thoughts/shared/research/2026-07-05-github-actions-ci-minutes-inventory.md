---
date: 2026-07-05
topic: "Inventory GitHub Actions workflows, recent runtime/failure hotspots, and CI minute reduction options"
tags: [research, ci, github-actions, operations]
status: complete
type: research
---

# Research: GitHub Actions CI Minutes Inventory

## Prior Work

- builds_on:: [[2026-05-09-list-issues-and-dashboard-state-aggregation]] (research — primary context for `Workflow State` writers)
- builds_on:: [[2026-02-20-GH-0169-routing-actions-workflow-scaffold]] (research — `route-issues.yml` design and `ROUTING_PAT` requirement)
- builds_on:: [[2026-02-20-GH-0175-actions-close-reopen-state-sync]] (research — close/reopen sync design and PAT-expiry risk)
- builds_on:: [[2026-02-20-GH-0176-actions-pr-merge-state-advance]] (research — PR merge state advancement design)
- builds_on:: [[2026-02-19-GH-0130-unified-release-automation]] (research — release automation design)
- builds_on:: [[2026-05-28-GH-1458-ci-doc-consistency-check]] (research — doc roster CI guard)
- builds_on:: [[2026-05-05-GH-0920-knowledge-search-retrieval-eval-ci-guard]] (research — retrieval eval quality gate)

## Research Question

"I'm ripping through GitHub Actions minutes. Use /ralph:research to inventory GitHub actions workflows -- in parallel look at runs to see what is failing/taking up the most time -- then consider ways to improve your understanding of how to manage CI for this project so you are a better operator -- then consider ways to reduce unecessary cpu-seconds -- you should have access to gh cli"

Assumption: "this project" is `cdubiel08/ralph-hero` at `/Users/dubiel/projects/ralph-hero`.

## Summary

The repo has 9 checked-in workflows plus two important **dynamic** GitHub-managed workflow families that do not live in `.github/workflows`: **CodeQL default setup** and **Dependabot Updates**.

Recent 100-run window (`2026-07-01T06:54:44Z` → `2026-07-04T22:28:46Z`) pulled 442 jobs via `gh`. Total measured job runtime was ~267.6 job-minutes:

1. **CI**: 161.2 job-minutes (60%). Biggest job is `build-and-test-knowledge (20)` at 68.3 job-minutes.
2. **CodeQL default setup**: 92.6 job-minutes (35%). Runs 3 language jobs (`javascript-typescript`, `python`, `actions`) on main pushes, PRs, and weekly schedule.
3. **Everything else**: ~13.8 job-minutes (5%). The event automation workflows are noisy when credentials fail, but not the main CPU sink.

Most actionable waste: Ralph writes research/plan/review docs to `thoughts/**` on main; each docs-only commit currently triggers full CI and CodeQL. Recent examples include `docs(research)`, `docs(plan)`, and `docs(review)` commits for GH-1524/1525/1526. A docs-only `thoughts/**` path ignore or split lightweight docs workflow should save more than tuning small issue automation jobs.

## Detailed Findings

### Checked-in workflow inventory

| Workflow | Trigger surface | Runtime/cost notes |
|---|---|---|
| `CI` (`.github/workflows/ci.yml:1`) | `push` to `main`, `pull_request` to `main` (`ci.yml:3-7`) | Largest checked-in workflow. Runs 3 package matrices (`mcp-server`, remotion demo, `ralph-knowledge`) on Node `[20, 22]`, then hooks/MCP pins/workflow lint/shellcheck/doc-roster jobs (`ci.yml:13-287`). No top-level concurrency. |
| `Release` (`.github/workflows/release.yml:1`) | `push` to main when `mcp-server/**` source/package files change, manual dispatch (`release.yml:21-31`) | Re-runs `npm ci`, build, test after CI, then `npm publish`; publish also invokes `prepublishOnly` build (`mcp-server/package.json:14-17`). |
| `Release Knowledge` (`.github/workflows/release-knowledge.yml:1`) | `push` to main for knowledge src/package/plugin/skill/agent/hook paths, manual dispatch (`release-knowledge.yml:35-65`) | Re-runs install/build/test after CI; `npm publish` can run `prepublishOnly` build (`plugin/ralph-knowledge/package.json:17-21`). |
| `Release Ralph` (`.github/workflows/release-ralph.yml:1`) | `push` to `ralph/**`, manual dispatch (`release-ralph.yml:25-31`) | Lightweight version bump/tag/release. Low CPU. |
| `Route Issues` (`.github/workflows/route-issues.yml:1`) | `issues` opened/labeled, `pull_request` opened/ready_for_review, `workflow_call` (`route-issues.yml:3-28`) | `npm ci && node route.js` on every routing event (`route-issues.yml:71-96`); fails noisily when `ROUTING_PAT` is bad/non-empty. |
| `Sync Workflow State on Close/Reopen` (`.github/workflows/sync-issue-state.yml:19`) | `issues` closed/reopened, manual dispatch (`sync-issue-state.yml:21-35`) | No checkout/setup; mostly `gh api graphql`; low CPU but depends on `ROUTING_PAT`. |
| `Advance Linked Issues on PR Merge` (`.github/workflows/sync-pr-merge.yml:20`) | `pull_request` closed, manual dispatch (`sync-pr-merge.yml:22-30`) | Low CPU; failure path wrote JSON error text to `$GITHUB_OUTPUT`, causing invalid-output errors. |
| `Sync Project State` (`.github/workflows/sync-project-state.yml:1`) | manual dispatch, `repository_dispatch` (`sync-project-state.yml:3-17`) | Event-driven Node utility job with `npm ci` in `.github/scripts/sync` (`sync-project-state.yml:35-57`). |
| `Advance Parent on Child Completion` (`.github/workflows/advance-parent.yml:15`) | `issues` closed, manual dispatch (`advance-parent.yml:17-25`) | Low CPU; missing concurrency while mutating parent issue/project state (`advance-parent.yml:32-327`). |

Dynamic/non-file workflows:

- **CodeQL default setup** is configured by repo settings, not by a workflow file. `gh api /repos/cdubiel08/ralph-hero/code-scanning/default-setup` reports `state=configured`, languages `actions`, `javascript`, `javascript-typescript`, `python`, `typescript`, query suite `default`, schedule `weekly`.
- **Dependabot Updates** are configured in `.github/dependabot.yml` for `mcp-server`, `plugin/ralph-knowledge`, `plugin/ralph-demo/remotion`, `.github/scripts/sync`, `scripts/routing`, and GitHub Actions (`dependabot.yml:10-74`).

### Recent runtime data

Command shape used:

```bash
gh run list --limit 100 --json databaseId,workflowName,status,conclusion,event,createdAt,updatedAt,headBranch,displayTitle,url,startedAt
# then for each run:
gh api /repos/cdubiel08/ralph-hero/actions/runs/$RUN_ID/jobs?per_page=100
```

Window: latest 100 runs, `2026-07-01T06:54:44Z` through `2026-07-04T22:28:46Z`; 442 jobs fetched. No queued or in-progress runs were found.

| Workflow | Runs | Jobs | Job-min | Wall-min | Success | Failure |
|---|---:|---:|---:|---:|---:|---:|
| CI | 28 | 308 | 161.2 | 70.5 | 26 | 2 |
| CodeQL | 31 | 93 | 92.6 | 48.2 | 31 | 0 |
| Dependabot Updates | 7 | 7 | 7.7 | 8.6 | 7 | 0 |
| Route Issues | 14 | 14 | 2.3 | 4.2 | 1 | 13 |
| Release | 3 | 3 | 2.2 | 2.5 | 2 | 1 |
| Release Ralph | 5 | 5 | 0.7 | 1.1 | 5 | 0 |
| Advance Linked Issues on PR Merge | 6 | 6 | 0.4 | 0.9 | 1 | 5 |
| Sync Workflow State on Close/Reopen | 3 | 3 | 0.2 | 0.4 | 0 | 3 |
| Advance Parent on Child Completion | 3 | 3 | 0.1 | 0.3 | 0 | 3 |

Top aggregate job costs:

| Job | Count | Job-min | Avg |
|---|---:|---:|---:|
| `build-and-test-knowledge (20)` | 28 | 68.3 | 2.4m |
| `Analyze (javascript-typescript)` | 31 | 45.4 | 1.5m |
| `build-and-test-knowledge (22)` | 28 | 29.1 | 1.0m |
| `Analyze (python)` | 31 | 27.2 | 0.9m |
| `Analyze (actions)` | 31 | 20.1 | 0.6m |
| `build-and-test-hero (20)` | 28 | 14.1 | 0.5m |
| `build-and-test-hero (22)` | 28 | 13.3 | 0.5m |
| `build-and-test-demo (20)` | 28 | 10.6 | 0.4m |
| `build-and-test-demo (22)` | 28 | 9.7 | 0.3m |

CodeQL breakdown:

| Display title | Jobs | Job-min |
|---|---:|---:|
| Push on main | 66 | 69.7 |
| PR #1530 | 6 | 4.9 |
| PR #1527 | 6 | 4.7 |
| PR #1531 | 6 | 4.7 |
| Scheduled | 3 | 3.3 |
| PR #1529 | 3 | 2.7 |
| PR #1532 | 3 | 2.6 |

### Failure signatures

Recent failures were clustered around 2026-07-01/02; newer 2026-07-04 routing/PR-merge examples were green.

| Pattern | Workflows | Evidence |
|---|---|---|
| `Bad credentials` from GitHub API | `Route Issues`, `Sync Workflow State`, `Advance Parent`, `Advance Linked Issues` | `gh run view 28559293221 --log-failed` showed `Routing failed: Bad credentials`; `28559859603` and `28559859579` showed `gh: Bad credentials (HTTP 401)`. |
| Raw JSON error written to `$GITHUB_OUTPUT` | `Advance Linked Issues on PR Merge` | `gh run view 28560795812 --log-failed` showed `Found linked issues: { "message": "Bad credentials" ... }` followed by `Invalid format '  "message": "Bad credentials",'`. |
| HuggingFace `429` during retrieval eval | `CI` / `build-and-test-knowledge (20)` | `gh run view 28558828013 --log-failed` showed repeated `Error (429)` for `Xenova/all-MiniLM-L6-v2` tokenizer/config during `npm run eval:retrieval`. |
| Publish duplicate version | `Release` | `gh run view 28559859099 --log-failed` showed `npm error You cannot publish over the previously published versions: 2.5.195`. |

### Why minutes are being burned

1. **Docs-only main commits trigger full CI + CodeQL.** Examples:
   - `docs(research): GH-1526 research findings` changed only `thoughts/shared/research/...` and still ran full CI.
   - `docs(plan): GH-1526 implementation plan` and `docs(review): GH-1526 plan critique` likewise changed only `thoughts/shared/...` and ran full CI.
   - Recent `gh run list --workflow CI --limit 30` shows many `docs(research)`, `docs(plan)`, `docs(review)` CI runs.

2. **Node 20 matrix leg is disproportionately expensive.** In the recent 100-run window, Node 20 package jobs consumed ~93.0 job-minutes (`knowledge20` 68.3, `hero20` 14.1, `demo20` 10.6). Node 20 is also past its useful operator horizon in 2026.

3. **`ralph-knowledge` quality gates are valuable but currently coupled to every CI run and both Node versions.** `npm test`, heap bench, and retrieval eval run inside both `build-and-test-knowledge` matrix legs (`ci.yml:101-110`). HF model downloads/cache misses can fail and waste a run.

4. **CodeQL default setup is hidden cost.** It runs outside `.github/workflows`, so inventorying only files misses ~35% of measured job runtime.

5. **Release workflows duplicate work already done by CI.** Release workflows reinstall/build/test packages after the main CI run; `npm publish` can rebuild through `prepublishOnly`.

## Files Affected

### Will Modify

None in this research pass. Candidate follow-up files/settings:

- `.github/workflows/ci.yml` — add concurrency, path-aware skipping, reduce Node matrix, gate expensive knowledge eval.
- `.github/workflows/release.yml` — remove duplicate release build/test where safe, or publish with `--ignore-scripts` after explicit build.
- `.github/workflows/release-knowledge.yml` — avoid full install/build/test for skill-only changes; avoid duplicate publish build.
- `.github/workflows/route-issues.yml` — add real `ROUTING_PAT` validation before checkout/setup/npm; cache tiny npm utility deps.
- `.github/workflows/sync-project-state.yml` — cache tiny npm utility deps.
- `.github/workflows/advance-parent.yml` — add concurrency and/or merge with close/reopen sync.
- GitHub repo CodeQL settings — switch from default setup to advanced setup if path/language filtering is needed.
- `docs/` or `thoughts/shared/runbooks/` — add a CI operator runbook.

### Will Read (Dependencies)

- `.github/workflows/ci.yml` — primary CI workflow.
- `.github/workflows/release.yml` — MCP server release workflow.
- `.github/workflows/release-knowledge.yml` — knowledge plugin release workflow.
- `.github/workflows/release-ralph.yml` — markdown/plugin release workflow.
- `.github/workflows/route-issues.yml` — issue/PR routing workflow.
- `.github/workflows/sync-issue-state.yml` — issue close/reopen state sync.
- `.github/workflows/sync-pr-merge.yml` — PR merge state advancement.
- `.github/workflows/sync-project-state.yml` — cross-project state sync.
- `.github/workflows/advance-parent.yml` — parent advancement workflow.
- `.github/dependabot.yml` — Dependabot update surface.
- `mcp-server/package.json` — CI/release scripts.
- `plugin/ralph-knowledge/package.json` — knowledge test/bench/eval scripts.

## Recommendations

### Highest-leverage minute reductions

1. **Skip full CI and CodeQL for `thoughts/**`-only commits.**
   - Add `paths-ignore: ['thoughts/**']` to `CI` if no code depends on thoughts docs.
   - For CodeQL, default setup cannot express this in-repo; switch to advanced setup if path filtering is required.
   - Keep a separate lightweight docs check only when docs that affect published rosters change.

2. **Drop Node 20 from default CI, or run it only on release/schedule.**
   - Estimated recent-window savings if default CI becomes Node 22 only: ~93 job-minutes per 100 recent runs (~35% of total measured job-minutes; ~58% of CI job-minutes).
   - If Node 20 support still matters, run a nightly/weekly compatibility workflow rather than every PR/docs commit.

3. **Run `ralph-knowledge` heap bench/retrieval eval once per CI run, not once per Node matrix leg.**
   - Gate `Heap regression bench` and `Retrieval eval` with `if: matrix.node-version == 22` or move them into a separate single-version job.
   - This also reduces concurrent HuggingFace cache-miss/rate-limit behavior.

4. **Make CodeQL deliberate.**
   - Current default setup scans `actions`, `javascript-typescript`, and `python` on pushes/PRs/schedule.
   - If minute pressure is severe: disable Python analysis (9 tracked Python files, mostly `scripts/dream/**`) or run Python only on schedule.
   - Best control: replace default setup with an advanced `.github/workflows/codeql.yml` that has `paths-ignore`, concurrency, and explicit languages.

5. **Avoid duplicate release work.**
   - `Release` and `Release Knowledge` can trust prior CI or run a targeted smoke check instead of full tests.
   - Use `npm publish --ignore-scripts` after explicit build to avoid `prepublishOnly` rebuilding in the workflow, while keeping `prepublishOnly` as manual-publish safety.

### Reliability/noise fixes

6. **Add a real `ROUTING_PAT` health check.**
   - Non-empty secret checks missed bad credentials. Use `GH_TOKEN=$ROUTING_PAT gh api user --jq .login` or a minimal Projects V2 query before expensive setup.
   - If the token is invalid, exit with a clear neutral/skip message when possible, or fail before checkout/setup/npm.

7. **Fix `$GITHUB_OUTPUT` writes in PR merge sync.**
   - Never write raw API JSON/errors to a single-line output. Use heredoc syntax or validate/sanitize first.

8. **Add job-level `timeout-minutes`.**
   - Cheap guard against runaway CPU-seconds. Most jobs here should have small bounds (CI package jobs ~10m, utility workflows ~5m, release ~15m).

9. **Add concurrency where missing.**
   - CI should cancel superseded PR runs: `group: ci-${{ github.event.pull_request.number || github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
   - `advance-parent.yml` should at least serialize per child issue; a unified close workflow could serialize better by parent after lookup.

## Operator Runbook Improvements

To be a better CI operator for this repo, maintain a short runbook with:

```bash
# Inventory recent runs
gh run list --limit 50 --json databaseId,workflowName,event,status,conclusion,createdAt,displayTitle,url

# Inspect a failed run
gh run view RUN_ID --log-failed

# Find active runs before canceling anything
gh run list --status in_progress --json databaseId,workflowName,displayTitle,url

# Fetch job-level runtime for a run
gh api /repos/cdubiel08/ralph-hero/actions/runs/RUN_ID/jobs?per_page=100

# Inspect hidden CodeQL default setup
gh api /repos/cdubiel08/ralph-hero/code-scanning/default-setup

# Check current CI workflow failures only
gh run list --status failure --limit 20 --json databaseId,workflowName,event,createdAt,displayTitle,url
```

Important operator facts:

- `.github/workflows` is not the whole Actions surface; CodeQL and Dependabot are dynamic.
- Project automation workflows depend on `ROUTING_PAT`; bad token state creates failure noise across several workflows.
- `CI` currently treats `thoughts/**` docs as code-impacting.
- Release has three channels: MCP server npm (`release.yml`), knowledge npm/plugin (`release-knowledge.yml`), and pure ralph plugin tag/release (`release-ralph.yml`).
- Prefer standalone scripts for checks so failures can be reproduced locally before spending Actions minutes.

## Code References

- `.github/workflows/ci.yml:3-7` — CI trigger on every push to main and PR to main.
- `.github/workflows/ci.yml:13-110` — Node matrices and package build/test/bench/eval jobs.
- `.github/workflows/ci.yml:87-110` — HuggingFace cache plus heap bench/retrieval eval in `ralph-knowledge`.
- `.github/workflows/release.yml:21-31` — MCP release path trigger.
- `.github/workflows/release.yml:77-84` — release reinstall/build/test duplication.
- `.github/workflows/release-knowledge.yml:35-65` — knowledge release path trigger.
- `.github/workflows/release-knowledge.yml:92-133` — classify/install/build/test sequence.
- `.github/workflows/route-issues.yml:3-8` — issue/PR routing triggers.
- `.github/workflows/route-issues.yml:62-96` — non-empty PAT check then `npm ci && node route.js`.
- `.github/workflows/sync-pr-merge.yml:51-104` — linked issue discovery/output path that failed on raw JSON error.
- `.github/workflows/advance-parent.yml:32-327` — parent advancement mutation workflow, currently no concurrency.
- `.github/dependabot.yml:10-74` — Dependabot update surfaces.
- `mcp-server/package.json:14-17` — build/test/prepublish scripts.
- `plugin/ralph-knowledge/package.json:17-21` — build/test/bench/eval/prepublish scripts.

## Architecture Documentation

Current CI architecture is a blend of:

- **Quality gate CI**: one broad workflow (`CI`) that runs all package tests and repository guards regardless of changed path.
- **Release automation**: three separate release workflows keyed by distribution channel.
- **Project state automation**: several small issue/PR workflows that mutate GitHub Projects V2 via a classic PAT.
- **GitHub-managed automation**: CodeQL default setup and Dependabot, both visible in Actions runs but not as checked-in workflow files.

The current model optimizes for broad safety and simple triggers, not minute economy. Minute economy requires path-aware gating and explicit treatment of docs-only Ralph artifact commits.

## Historical Context (from thoughts/)

Prior docs already identify the important operational risks:

- `Workflow State` is mutated by both Actions and MCP tools; treat it as a shared write surface.
- `ROUTING_PAT` is required because `GITHUB_TOKEN` cannot write the personal-account Projects V2 board.
- CI doc consistency checks were intentionally wired as standalone scripts, a good pattern for reproducible local debugging.
- Retrieval eval is valuable as a quality guard, but it was intended around a pinned corpus and conservative threshold; it should not require repeated live model fetches.

## Related Research

- [[2026-05-09-list-issues-and-dashboard-state-aggregation]]
- [[2026-02-20-GH-0169-routing-actions-workflow-scaffold]]
- [[2026-02-20-GH-0175-actions-close-reopen-state-sync]]
- [[2026-02-20-GH-0176-actions-pr-merge-state-advance]]
- [[2026-05-28-GH-1458-ci-doc-consistency-check]]
- [[2026-05-05-GH-0920-knowledge-search-retrieval-eval-ci-guard]]

## Open Questions

- Should `thoughts/**` commits ever run full CI, or should they only run a cheap markdown/doc-integrity check?
- Is Node 20 support still a supported target after mid-2026, or can default CI move to Node 22/24 only?
- Is Python CodeQL valuable enough for the 9 tracked `scripts/dream/**` Python files, or should it be scheduled only?
- Should CodeQL stay default setup, or should this repo own an advanced workflow for path filtering and concurrency?
- Can release workflows trust prior CI, or must releases remain self-contained for safety?
