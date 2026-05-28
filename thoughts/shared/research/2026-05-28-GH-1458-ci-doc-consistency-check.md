---
date: 2026-05-28
researcher: ralph (autopilot)
git_commit: a9fdd0138d1c55474b93e31d8dbe1441261402cb
branch: main
repository: ralph-hero
topic: "CI doc-consistency check for agent/skill/tool rosters (GH-1458)"
tags: [research, ci, documentation, doc-consistency, epic-1459]
status: complete
github_issue: 1458
github_url: https://github.com/cdubiel08/ralph-hero/issues/1458
estimate: M
---

# Research: CI doc-consistency check for agent/skill/tool rosters (GH-1458)

## Prior Work

- builds_on:: [[GH-1452-readme-claude-roster-drift]] — the original agent-roster drift (phantom agent names documented in `CLAUDE.md`/`README.md` that didn't exist in `ralph/agents/`) that this check exists to prevent recurring. That plan enumerated the correct rosters and ran *manual* verification scripts; #1458 automates them in CI.
- Sibling under epic [[GH-1459-documentation-hardening]] (children #1452–#1457 all Done; #1458 is the last).
- No prior research/plan doc for #1458 itself — this is the first.

## Summary / Recommendation

Build **one check** (a script run by a new, independent `ci.yml` job) that extracts the documented agent/skill/tool rosters from the markdown and compares them to source. The check direction differs per roster, which is the crux:

- **Agents** and **skills** are documented *exhaustively* (every name listed) → **bidirectional** equality (documented set == source set).
- **Tools** are documented as an *explicitly curated subset* ("Key tools" in CLAUDE.md, "a curated subset" in README) → **one-directional**: every documented `ralph_hero__*` name must *exist* in source (catches phantoms/typos/renames), but source may legitimately have undocumented tools.

This is ~2 phases (the check script + `ci.yml` wiring) and **self-validating** — the new check runs on its own PR, so a false positive fails that PR's CI before merge. Effectively an S build; estimate can be revisited at plan time.

## Detailed Findings

### Documented rosters (what the check reads)

- **Skills/verbs** — markdown tables, names as `` `/ralph:<verb>` `` in column 1:
  - `CLAUDE.md:62-72` (`### ralph Plugin — 9 Verbs`)
  - `README.md:70-81` (`## Skills`) — same 9, different row order
  - 9 names: catch-up, form, research, plan, impl, review, caretake, hero, setup
- **Agents** — **prose, backtick-delimited** (NOT a table), only authoritative in `CLAUDE.md:76-78` (`### ralph Plugin — 16 Agents`): 8 per-phase + 8 investigators. `README.md` only has a directory-tree comment ("16 agents (8 per-phase + 8 investigators)") with no individual names — so the agent check should read `CLAUDE.md`, not `README.md`.
- **Tools** — markdown tables, short names (no `ralph_hero__` prefix), **explicitly partial**:
  - `CLAUDE.md:104-118` (`**Tool modules**`, column labeled "Key tools")
  - `README.md:87-113` (`### Tools`, says "a curated subset")

### Source of truth (what the check compares against)

- **Agents**: `ralph/agents/*.md` — 16 files. Per-phase: catch-up-agent, impl-agent, merge-agent, plan-agent, research-agent, review-agent, triage-agent, val-agent. Investigators: codebase-analyzer, codebase-locator, codebase-pattern-finder, log-reader, sre-fixit, thoughts-analyzer, thoughts-locator, web-search-researcher.
- **Skills**: `ralph/skills/*/` — 9 verb dirs (catch-up, form, research, plan, impl, review, caretake, hero, setup) **plus** non-verb utility dirs `shared/` and `using-html/` that must be excluded from the comparison.
- **Tools**: `mcp-server/src/tools/*.ts` via `server.tool("ralph_hero__…", …)` call sites — the only complete, machine-parseable roster. 38 always-registered + 2 debug-only (`collate_debug`, `debug_stats`, gated on `RALPH_DEBUG=true`) = 40. Reliable extraction regex: `server\.tool\(\s*"(ralph_hero__[^"]+)"` across that directory.

### Extraction patterns (the crux)

| Roster | Documented source | Extraction | Direction |
|---|---|---|---|
| Skills | `CLAUDE.md` 9-verbs table | col-1 match `` `/ralph:([a-z-]+)` `` | bidirectional (== `ralph/skills/` dirs minus `shared`,`using-html`) |
| Agents | `CLAUDE.md` 16-agents prose | backtick names `` `([a-z][a-z0-9-]+)` `` under the heading | bidirectional (== `ralph/agents/*.md` basenames) |
| Tools | `CLAUDE.md`/`README.md` tool tables | short names, prepend `ralph_hero__` | **one-directional**: documented ⊆ source `server.tool()` names (account for the `RALPH_DEBUG` debug-only pair) |

### CI integration

`.github/workflows/ci.yml` has 6–7 **independent** jobs (no `needs:`). Good models:
- `verify-mcp-pins` (`ci.yml:135-210`) — inline bash, `set -euo pipefail`, a `FAILED` counter, GitHub `::error file=…::` annotations, `exit 1` on failure. Closest analogue.
- `test-hooks` (`ci.yml:112-128`) — find+run scripts in subshells, propagate first non-zero exit.
- `shellcheck-hooks` (`ci.yml:263-275`) — community action.

A new peer job (e.g. `check-doc-rosters`) slots in after `shellcheck-hooks` or beside `test-hooks` — no ordering constraints.

### Implementation approach (for the planner)

Two viable shapes, both repo-idiomatic:
1. **Bash script** `scripts/check-doc-rosters.sh` (model structure on `scripts/test-branch-isolation.sh`: strict mode, `pass`/`fail` counters, `=== Results ===`, `exit 0|1`) + a new `ci.yml` job that runs it. Preferred — keeps logic testable/runnable locally.
2. Inline bash in a new `ci.yml` job (model on `verify-mcp-pins`) if the logic stays compact.

Failure message must name the divergence (e.g. `Documented agent 'foo-agent' not found in ralph/agents/` / `Agent 'bar-agent' in ralph/agents/ is undocumented in CLAUDE.md`).

## Files Affected

- `.github/workflows/ci.yml` — **modify** (add the `check-doc-rosters` job).
- `scripts/check-doc-rosters.sh` — **create** (the check; or inline into ci.yml).
- Read-only inputs (the check consumes, does not modify): `CLAUDE.md`, `README.md`, `ralph/agents/`, `ralph/skills/`, `mcp-server/src/tools/*.ts`.

## Open Questions / Scope notes

- **Tool-check direction** is the key design decision: docs are curated subsets, so assert documented⊆source (phantom/typo detection), NOT full coverage. Bidirectional on tools would produce constant false failures.
- **Skill dir exclusions**: `ralph/skills/shared/` and `ralph/skills/using-html/` are not verbs — exclude them.
- **Node-version doc drift** (docs say "18+", CI matrix is 20/22) was flagged by #1452 but is **out of scope** for #1458 (AC is the agent/skill/tool rosters). Worth a separate follow-up.
