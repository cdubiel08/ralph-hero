---
date: 2026-05-28
status: draft
type: plan
tags: [ci, documentation, doc-consistency, epic-1459]
github_issue: 1458
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1458
primary_issue: 1458
estimate: M
research: thoughts/shared/research/2026-05-28-GH-1458-ci-doc-consistency-check.md
---

# Add CI Doc-Consistency Check for Agent/Skill/Tool Rosters (GH-1458)

## Prior Work

- builds_on:: [[2026-05-28-GH-1458-ci-doc-consistency-check]] — the research doc for this issue; it settled the extraction approach and the per-roster check directions this plan implements.
- builds_on:: [[GH-1452-readme-claude-roster-drift]] — the phantom-agent-name drift this check exists to prevent recurring.
- Sibling under epic [[GH-1459-documentation-hardening]] — the last open child (#1452–#1457 Done).

## Overview

Add a CI check asserting that the agent/skill/tool rosters documented in `CLAUDE.md`/`README.md` match the source files, so docs and code can't silently diverge (the failure mode #1452 had to fix by hand). Implementation is one bash script plus one independent `ci.yml` job — small, self-validating (it runs on its own PR), and modeled on the repo's existing `verify-mcp-pins` check.

## Current State Analysis

Per the research doc:
- **Documented rosters**: agents in `CLAUDE.md:76-78` (prose, backtick-delimited; README has only a tree-comment, no names); skills in `CLAUDE.md:62-72` + `README.md:70-81` (markdown tables, `/ralph:<verb>`); tools in `CLAUDE.md:104-118` + `README.md:87-113` (markdown tables, **explicitly a curated subset**).
- **Sources**: agents = `ralph/agents/*.md` (16); skills = `ralph/skills/*/` (9 verb dirs **plus** non-verb `shared/`, `using-html/`); tools = `server.tool("ralph_hero__…")` call sites in `mcp-server/src/tools/*.ts` (38 always + 2 `RALPH_DEBUG`-only).
- **CI**: `.github/workflows/ci.yml` has independent jobs (no `needs:`); `verify-mcp-pins` (inline bash, `set -euo pipefail`, `FAILED` counter, `::error::` annotations) is the closest model. No doc-consistency check exists.

### Key Discoveries

- **Check direction differs per roster** (the crux): agents & skills are documented exhaustively → **bidirectional** equality; tools are a curated subset → **one-directional** (documented ⊆ source) to avoid constant false failures.
- Skill comparison must **exclude** `ralph/skills/shared/` and `ralph/skills/using-html/` (not verbs).
- Tool extraction source of truth is `server\.tool\(\s*"(ralph_hero__[^"]+)"`; account for the 2 `RALPH_DEBUG`-only tools (`collate_debug`, `debug_stats`) so they aren't flagged as undocumented.
- The check should **pass on current `main`** (rosters are consistent post-#1452), so it won't block existing PRs.

## Desired End State

1. `scripts/check-doc-rosters.sh` exists: extracts the three documented rosters, compares to source per the directions above, and exits non-zero with an actionable message on divergence.
2. The script is wired into `.github/workflows/ci.yml` as a new independent job that fails CI on divergence.
3. The check passes on current `main`.
4. The check detects an injected divergence (phantom/removed name).

### Verification

- Automated: `bash scripts/check-doc-rosters.sh` exits 0 on current `main`; `shellcheck` clean; `actionlint` clean on the updated workflow; the new CI job is green on the PR.
- Manual: inject a fake agent name into `CLAUDE.md` → script exits non-zero naming the phantom → revert.

## What We're NOT Doing

- NOT checking Node-version doc drift (docs "18+" vs CI 20/22) — out of scope per the issue; separate follow-up.
- NOT making the tool check bidirectional — the docs are intentionally a curated subset, so documented⊆source only.
- NOT auto-fixing drift — the check only detects and fails.
- NOT writing it as a vitest — a bash script matches the repo's existing check conventions (`verify-mcp-pins`, `test-hooks`, `shellcheck-hooks`) and stays runnable locally. (Node is a fallback only if markdown parsing proves too fiddly for grep/sed.)

## Implementation Approach

One bash script (`scripts/check-doc-rosters.sh`, structured like `scripts/test-branch-isolation.sh`: strict mode, `pass`/`fail` counters, `=== Results ===`, `exit 0|1`) plus one `ci.yml` job (modeled on `test-hooks`/`shellcheck-hooks`). Two phases: write+self-verify the script, then wire it into CI.

## Phase 1: Write the doc-consistency check script

depends_on: null

### Overview
Create `scripts/check-doc-rosters.sh` that extracts the documented agent/skill/tool rosters and compares them to source with the per-roster directions, failing with clear messages.

### Changes Required
#### 1. New check script
**File**: `scripts/check-doc-rosters.sh` (create)
**Changes**:
- `#!/usr/bin/env bash`, `set -euo pipefail`, `pass`/`fail` counters, `=== Results ===` summary, `exit 1` if any fail.
- **Agents (bidirectional)**: extract backtick names under the `### ralph Plugin — 16 Agents` heading in `CLAUDE.md`; compare as a set to `ralph/agents/*.md` basenames. Report both directions (documented-but-missing, source-but-undocumented).
- **Skills (bidirectional)**: extract `` `/ralph:<verb>` `` names from the `### ralph Plugin — 9 Verbs` table in `CLAUDE.md`; compare to `ralph/skills/*/` dir names **excluding** `shared` and `using-html`.
- **Tools (one-directional, documented ⊆ source)**: extract short tool names from the `CLAUDE.md`/`README.md` tool tables, prepend `ralph_hero__`; extract source names via `server\.tool\(\s*"(ralph_hero__[^"]+)"` across `mcp-server/src/tools/*.ts`; assert every documented name exists in source (ignore the reverse). Account for `collate_debug`/`debug_stats` (RALPH_DEBUG-only) being present in source.
- Failure messages name the specific divergence, e.g. `Documented agent 'foo-agent' not found in ralph/agents/`.

### Success Criteria
#### Automated Verification
- [ ] `bash scripts/check-doc-rosters.sh` exits 0 on current `main` (rosters consistent post-#1452).
- [ ] `shellcheck scripts/check-doc-rosters.sh` reports no errors.

#### Manual Verification
- [ ] Temporarily add a fake agent name to `CLAUDE.md`'s agent roster → script exits non-zero with a message naming the phantom → revert.

## Phase 2: Wire the check into CI

depends_on: [phase-1]

### Overview
Add an independent `ci.yml` job that runs the script and fails CI on divergence.

### Changes Required
#### 1. New CI job
**File**: `.github/workflows/ci.yml` (modify)
**Changes**: add a `check-doc-rosters` job (peer — no `needs:`), `runs-on: ubuntu-latest`, `permissions: contents: read`, steps = `actions/checkout` (pinned, matching sibling jobs) + a `Run doc-roster consistency check` step invoking `bash scripts/check-doc-rosters.sh`. Place after `shellcheck-hooks` to keep lint/check jobs grouped.

### Success Criteria
#### Automated Verification
- [ ] `actionlint` passes on the updated `ci.yml` (the `lint-workflows` job).
- [ ] The new `check-doc-rosters` job appears in the PR's check rollup and is green (self-validation).

#### Manual Verification
- [ ] Confirm the new job shows in the PR's CI and passes.

## Testing Strategy

### Unit Tests
The script's primary test is self-validation: it must exit 0 on current `main` and fail on injected drift (manual step above). A fixture-based test under `ralph/hooks/scripts/__tests__/` style is optional and not required for this M.

### Integration Tests
The `ci.yml` job IS the integration test — it runs the check on every PR/push to `main`.

### Manual Testing Steps
1. Run `bash scripts/check-doc-rosters.sh` locally → expect exit 0.
2. Inject a phantom agent name in `CLAUDE.md` → rerun → expect non-zero + a clear message → revert.

## Migration Notes

No migration. Net-new script + CI job. The check passes on current `main` (post-#1452), so it does not block existing work. Because the new job runs on its own PR, any bug (false positive) fails that PR's CI and is caught before merge.

## References

- Research: `thoughts/shared/research/2026-05-28-GH-1458-ci-doc-consistency-check.md`
- Issue #1458 · Epic #1459 (Documentation hardening)
- CI models: `.github/workflows/ci.yml` — `verify-mcp-pins` (lines ~135-210), `test-hooks`, `shellcheck-hooks`
