---
type: eval-scenarios
skill: idea-hunt
date: 2026-04-25
---

# idea-hunt — Eval Scenarios

Three scenarios for grading the multi-agent GitHub trend-hunt coordinator. Each scenario fixes the topic input and lists the assertions a reviewer should check against the generated `thoughts/shared/ideas/<topic>.md` report.

The output quality of `idea-hunt` is governed by qualitative judgment in `github-lister` and `github-analyzer`. These scenarios provide a concrete rubric to anchor that judgment.

## Scenario A: Mainstream topic — "AI agents"

**Input**: `idea-hunt AI agents`

**Expected Behavior**:
- Coordinator breaks topic into 3-4 search angles (frameworks, novel architectures, RFCs/discussions, emerging tools)
- Spawns 2 `github-lister` workers, then 1 `github-analyzer`
- Writes a structured report to `thoughts/shared/ideas/`
- Presents a brief summary highlighting top finds, emerging patterns, and report path

**Assertions**:
- [ ] At least **5 distinct projects/repos** discovered across the search angles
- [ ] At least **1 project with >100 stars** (signals mainstream traction)
- [ ] At least **1 emerging find** (project < 6 months old or low star count but novel pattern)
- [ ] Synthesis section names **>= 2 cross-cutting patterns** (e.g., "tool-use APIs are converging on JSON-schema function calling")
- [ ] Report file exists at `thoughts/shared/ideas/<slug>.md` and renders cleanly
- [ ] No duplicate repos within a single report
- [ ] User-facing summary is <= 5 bullet points

## Scenario B: Niche topic with sparse results — "rust-based git porcelain"

**Input**: `idea-hunt rust-based git porcelain`

**Expected Behavior**:
- Coordinator still produces 3-4 angles even though the topic is narrow
- Listers return fewer hits per task; some search tasks may complete with 0-3 finds
- Analyzer produces a graceful "low-yield" report rather than padding with irrelevant repos

**Assertions**:
- [ ] Report explicitly acknowledges low yield (e.g., "Search returned <5 high-relevance projects; the rust git-tooling space is small")
- [ ] No off-topic projects are included to fill space (e.g., generic Rust CLI projects unrelated to git)
- [ ] At least one section pivots to "adjacent inspiration" or names tangential opportunities, OR explicitly states no inspiration was found
- [ ] User-facing summary signals "limited results" so the user can decide whether to broaden the topic

## Scenario C: Re-run dedup — same topic invoked twice

**Input**: Run `idea-hunt AI agents` twice in the same session (or within 24h)

**Expected Behavior**:
- Second run does not return the identical set of repos as the first
- Analyzer either references the prior report or surfaces new finds since the last run

**Assertions**:
- [ ] Second-run report path differs from first (e.g., timestamp suffix or topic-rerun-2)
- [ ] **At least 30%** of repos in the second report are not in the first
- [ ] Second report's synthesis section calls out novelty vs. prior run, OR explicitly notes "topic re-explored — see prior report at <path> for the original findings"
- [ ] No repos are listed in both reports without acknowledgment

## Notes

- These are graded by a human reviewer reading the generated report file. Automation could assert (1) project count, (2) star threshold via GitHub API, (3) overlap percentage between two reports, but full grading is qualitative.
- For Scenario C, dedup logic is currently not implemented in `github-analyzer` — the assertion exists to drive a future improvement.
