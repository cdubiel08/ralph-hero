---
date: 2026-05-19
status: draft
type: plan
github_issue: 1318
github_issues: [1318]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1318
primary_issue: 1318
tags: [scouts, playwright, team-skill, soul, agent, director]
---

# Author Scouts Team-Skill, SOUL, and scouts-agent — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-19-GH-1317-extract-shared-ui-heuristic]]
- builds_on:: [[2026-05-16-GH-1273-scout-scheduling]]

(Note: the parent plan-of-plans `2026-05-18-GH-1314-wire-ralph-playwright-into-director-teams.md` referenced in the GH-1314 issue body was not present on disk at planning time; this plan reconstructs scope from the issue body, sibling Phase 1 plan, and the existing watch/caretake skill patterns. No `--parent-plan` flag was passed.)

## Overview

Single-issue atomic plan to author the missing `ralph-hero:scouts` team-skill, its `SOUL.md` (already exists — verify and integrate), and the per-phase `scouts-agent.md` agent definition. The skill orchestrates `a11y-scan` always and conditionally dispatches `test-e2e`, `storybook-test`, and `visual-diff` based on detected project artifacts, then writes a `## Scout Report` PR comment whose `Verdict: GREEN|YELLOW|RED` is consumed by ralph-merge's existing scout-report gate. Models its shape on the existing `watch` team-skill.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1318 | Author scouts team-skill, SOUL, and scouts-agent | S |

## Shared Constraints

These constraints are inherited from the GH-1314 epic (reconstructed from the epic issue body and Phase 1 plan, since the on-disk plan-of-plans file is missing) and extended with feature-specific constraints from this issue's research.

1. **Consumer contract is fixed.** The output is dictated by the existing `ralph-merge` consumer at `plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276`. Match the `## Scout Report` header and `Verdict: GREEN|YELLOW|RED` line shape exactly — ralph-merge greps for the literal strings `## Scout Report` and `Verdict: GREEN` (case-insensitive on `GREEN`). Do not invent a new schema or rename fields.
2. **Watch is the dispatch-pattern model.** Mirror `plugin/ralph-hero/skills/watch/SKILL.md` in argument parsing, dispatch table, terminal handlers, and `# TODO(GH-1272)` outcome-recorder stubs. Diverge only where scouts-specific logic requires it (conditional sub-skill dispatch instead of single-issue routing).
3. **SOUL is auto-loaded by `load-team-soul.sh`.** Naming the directory `scouts/` and the file `SOUL.md` is sufficient — the SessionStart hook (`plugin/ralph-hero/hooks/scripts/load-team-soul.sh`) handles loading. The `SOUL.md` file already exists at `plugin/ralph-hero/skills/scouts/SOUL.md` (verified during planning); the plan VERIFIES that it loads correctly rather than recreating it.
4. **Sourced heuristic, not re-implemented.** When detecting UI artifacts, source `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` (created by Phase 1, GH-1317) rather than inlining the regex. If Phase 1 has not yet merged at impl time, impl-agent must wait — this issue is dependency-blocked by GH-1317 via the `blockedBy` graph maintained by GitHub.
5. **Director consumes `trigger:scouts` and `scout-auto`, not scouts itself.** Per the Director taxonomy (`plugin/ralph-hero/skills/director/event-classes.md:17,29`) and watch's Constraint 6, the scouts skill never reads `trigger:*` labels — Director removes them after dispatch. Scouts only accepts `--issue NNN` (direct) or a bare issue number (Director's canonical dispatch form).
6. **Bundled playwright skills are invoked via `Skill()`, never re-implemented.** Like caretake (`plugin/ralph-hero/skills/caretake/SKILL.md`), the scouts orchestrator invokes `/ralph-playwright:a11y-scan`, `/ralph-playwright:test-e2e`, `/ralph-playwright:storybook-test`, and `/ralph-playwright:visual-diff` via `Skill()` and aggregates their results. The skill bodies are not modified.
7. **Outcome-recorder stubs are mandatory** (Constraint 7 from watch). Every terminal handler MUST include a `# TODO(GH-1272): wire outcome-recorder(...)` comment matching the pattern in `watch/SKILL.md:124,130,136`. Feature E (GH-1272) wires the actual call later.
8. **Director event-classes.md and CLAUDE.md updates are OUT OF SCOPE.** Phase 4 (GH-1320) flips the taxonomy `status` column from `pending Feature F (GH-1273)` to `live` and registers the agent in CLAUDE.md / docs/model-tier-policy.md. This phase only CREATES the entrypoint files.
9. **Per-PR producer is OUT OF SCOPE.** Phase 3 (GH-1319) builds `.github/workflows/playwright-auto.yml` that emits `scout-auto` labeled issues. This phase only consumes those issues once they arrive.

## Current State Analysis

### What exists today

- **`SOUL.md` exists**: `plugin/ralph-hero/skills/scouts/SOUL.md` is already authored with team voice (`curious-mischievous`), 5 refusals, and example exchanges. Auto-loaded by `load-team-soul.sh` SessionStart hook because the directory is named `scouts/`.
- **`scout-nightly.sh` exists**: `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` is a separate batch path that invokes `/ralph-playwright:test-e2e` via `claude -p`. It continues to operate independently (per the epic body: "Not migrating scout-nightly").
- **ralph-pr Scout Trigger producer exists**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417` posts `## Scout Trigger` PR comments using the same UI heuristic. The trigger comment names this skill: `**Why scouts?** See ... \`plugin/ralph-hero/skills/scouts/SOUL.md\``.
- **ralph-merge Scout Report consumer exists**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276` (Step 4b) gates merges on `## Scout Report` + `Verdict: GREEN`. Currently no-op'd because nothing produces the report.
- **Director taxonomy declares scouts**: `event-classes.md:17,29,58` lists `trigger:scouts`, `scout-auto` label, and `ralph-hero:scouts` skill entrypoint as `pending Feature F (GH-1273)`.
- **Shared UI heuristic in progress**: `plugin/ralph-hero/scripts/shared/ui-heuristic.sh` will exist after Phase 1 (GH-1317) merges. Currently the heuristic is inline at `plugin/ralph-hero/scripts/scout-heuristic-smoke.sh:32-38`.
- **Playwright sub-skills exist**: `plugin/ralph-playwright/skills/{a11y-scan,test-e2e,storybook-test,visual-diff}/SKILL.md` are all available for `Skill()` dispatch.

### What's missing (this phase delivers)

- `plugin/ralph-hero/skills/scouts/SKILL.md` — the orchestrator entrypoint.
- `plugin/ralph-hero/agents/scouts-agent.md` — the per-phase agent for hero/team dispatch.

### Pattern source files (read, not modified)

- `plugin/ralph-hero/skills/watch/SKILL.md` — frontmatter shape, argument parsing, dispatch table, terminal handlers, SOUL refusal enforcement pattern.
- `plugin/ralph-hero/skills/caretake/SKILL.md` — bundled-skills aggregation pattern (caretake wraps 6 skills the same way scouts will wrap 4).
- `plugin/ralph-hero/agents/impl-agent.md` / `plugin/ralph-hero/agents/research-agent.md` — minimal agent definition shape (`name`, `description`, `model`, `tools`, `skills`).
- `plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276` — exact consumer regex to match.
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417` — Scout Trigger producer shape (informs the matching Scout Report shape).

## Desired End State

### Verification

- [x] `plugin/ralph-hero/skills/scouts/SKILL.md` exists with frontmatter declaring `allowed-tools`, `SessionStart` hooks (`set-skill-env.sh RALPH_COMMAND=scouts` + `load-team-soul.sh`), and a documented dispatch matrix.
- [x] `/ralph-hero:scouts --issue NNN` is a valid invocation — `argument-hint` reflects this.
- [x] `/ralph-hero:scouts 1318` (bare number — Director's canonical form) is also valid.
- [x] Skill body documents the always-dispatch (`a11y-scan`) and conditional dispatch (`test-e2e` if `playwright-stories/` exists; `storybook-test` if Storybook detected; `visual-diff` if Chromatic/Applitools baselines exist).
- [x] Skill writes a `## Scout Report` PR comment whose body contains exactly `Verdict: GREEN`, `Verdict: YELLOW`, or `Verdict: RED` — confirmed by grep against the literal strings ralph-merge uses (`## Scout Report` and `Verdict: GREEN` per `ralph-merge/SKILL.md:248,259`).
- [x] Skill emits `result:` and `needs input:` markers per harness convention (mirrors watch).
- [x] Skill emits `# TODO(GH-1272): wire outcome-recorder(...)` in every terminal handler.
- [x] `plugin/ralph-hero/agents/scouts-agent.md` exists with `name: scouts-agent`, tier-appropriate `model:` (sonnet — orchestration role with multi-skill coordination matches log-reader/research-agent tier), a tools allowlist sufficient for dispatch (Bash, Skill, Read, MCP github tools), and `skills: [ralph-hero:scouts]` preload.
- [x] Loading `/ralph-hero:scouts` does not fail; SOUL is loaded as evidenced by a `RALPH_SOUL_LOADED=scouts` env var or equivalent (per `load-team-soul.sh` side effect).
- [x] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` continues to pass (no regression; this phase does not touch the heuristic).

## What We're NOT Doing

- Not extracting or modifying the UI heuristic (Phase 1, GH-1317 — blocker).
- Not building `.github/workflows/playwright-auto.yml` per-PR producer (Phase 3, GH-1319 — sibling).
- Not flipping `event-classes.md`, `CLAUDE.md`, or `docs/model-tier-policy.md` to mark scouts live (Phase 4, GH-1320 — sibling).
- Not running self-host validation against a fixture PR (Phase 5, GH-1321 — sibling).
- Not modifying `ralph-pr` (already produces `## Scout Trigger`) or `ralph-merge` (already consumes `## Scout Report`).
- Not modifying any `plugin/ralph-playwright/skills/*/SKILL.md` body — the orchestrator invokes them, does not change them.
- Not migrating `scripts/schedule/scout-nightly.sh` to use the new skill — per epic body, nightly stays as-is.
- Not implementing the outcome-recorder wrapper (Feature E, GH-1272 — separate epic). Only stubs are added.
- Not rewriting `SOUL.md` — it already exists and is correct. Plan verifies it loads.
- Not adding any new tooling dependencies (no python, no new MCP servers). The skill is bash + Skill() + existing MCP tools only.
- Not adding integration with `scout-merge-gate-smoke.sh` beyond verifying it still passes — that smoke covers the merge-gate side, not the producer side.

## Implementation Approach

One phase, four tasks:

1. **Task 1.1 — Author `SKILL.md`** with the full orchestrator: frontmatter, argument parsing, artifact-detection logic (sourcing the shared heuristic library when invoked from a PR context), conditional dispatch matrix, Scout Report composition, terminal handlers.
2. **Task 1.2 — Author `scouts-agent.md`** as a thin agent wrapper that preloads the skill via `skills: [ralph-hero:scouts]`, mirroring impl-agent's shape.
3. **Task 1.3 — Verify `SOUL.md` integration** end-to-end: confirm the file exists, confirm `load-team-soul.sh` discovers it, and add an assertion script if missing.
4. **Task 1.4 — Lint + smoke validation**: run the existing scout-heuristic-smoke (regression check), grep that the literal Scout Report strings match what ralph-merge expects, and confirm the skill frontmatter parses (basic YAML lint).

---

## Phase 1: Author scouts team-skill, SOUL verification, and scouts-agent
- **depends_on**: [GH-1317]

### Overview

Create the missing scouts orchestrator skill and its per-phase agent so Director can dispatch scout work as a first-class team. Mirror `watch/SKILL.md` for orchestrator shape; mirror `impl-agent.md` for the agent file. SOUL already exists — verify loading. Output contract is fixed by `ralph-merge/SKILL.md:213-276`.

### Tasks

#### Task 1.1: Author `plugin/ralph-hero/skills/scouts/SKILL.md`

- **files**: `plugin/ralph-hero/skills/scouts/SKILL.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] Frontmatter declares `description` summarizing scout dispatch (one sentence, mirrors `watch/SKILL.md:2`).
  - [x] Frontmatter declares `argument-hint: "[--issue NNN]"` (matches watch).
  - [x] Frontmatter declares `context: inline` (matches watch).
  - [x] Frontmatter declares `SessionStart` hooks block with TWO hooks, in this exact order:
    1. `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh RALPH_COMMAND=scouts RALPH_REQUIRED_BRANCH=main`
    2. `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/load-team-soul.sh`
  - [x] Frontmatter `allowed-tools` includes at minimum: `Skill`, `Agent`, `Bash`, `Read`, `Glob`, and the four MCP tools used (`mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`).
  - [x] Body opens with `## Configuration (resolved at load time)` block exposing `Owner`, `Repo`, `Project` via the `!`echo ${RALPH_GH_OWNER:-NOT_SET}`` pattern (matches watch:23-28).
  - [x] Body contains an `## Argument parsing` section accepting `--issue NNN`, a bare numeric (Director's canonical form), and unrecognized → exit 1 with a `needs input:` line (mirrors `watch/SKILL.md:38-56`). Heartbeat mode is NOT supported (scouts is event-driven only — `scout-auto` issues are produced by Phase 3's workflow per PR).
  - [x] Body contains an `## Artifact detection` section that sources the shared heuristic library: `source "${CLAUDE_PLUGIN_ROOT}/scripts/shared/ui-heuristic.sh"`. This step is allowed to no-op when invoked outside a PR context — the heuristic only fires when changed files are available.
  - [x] Body contains a `## Dispatch matrix` table with four rows in this exact priority order:
    | Condition | Action |
    |-----------|--------|
    | Always (per scout invocation) | `Skill("ralph-playwright:a11y-scan", "<target-url>")` |
    | `test -d playwright-stories` returns 0 | `Skill("ralph-playwright:test-e2e", "<target-url>")` |
    | `test -f .storybook/main.js` OR `test -f .storybook/main.ts` returns 0 | `Skill("ralph-playwright:storybook-test")` |
    | `grep -q '"chromatic"\\|"applitools"' package.json` (when package.json exists) | `Skill("ralph-playwright:visual-diff")` |
  - [x] Each conditional row documents the exact bash check used to detect the artifact.
  - [x] Body contains a `## Scout Report composition` section specifying the exact output shape:
    ```
    ## Scout Report

    Verdict: <GREEN|YELLOW|RED>

    Dispatched: <comma-separated list of skills actually run>

    Findings:
    - <bullet per signal>

    Evidence:
    - <bullet per artifact path>
    ```
  - [x] Verdict computation rule documented: GREEN = zero critical/high signals; YELLOW = ≥1 medium/low; RED = ≥1 critical/high. (Signal severity taxonomy is the same one SOUL.md references.)
  - [x] Body contains a `## Posting the Scout Report` section that uses `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment` to post the composed report to the PR linked to the issue (PR resolution via `get_issue` → comments search for `## Pull Request` marker).
  - [x] Body contains a `## SOUL refusal enforcement` section mirroring `watch/SKILL.md:62-72` — refuses to file findings without a screenshot/trace ref (matches SOUL.md refusal #1) and refuses to file flaky-on-first-fail (matches SOUL.md refusal #2).
  - [x] Body contains a `## Terminal handlers` section emitting `result:` lines on success, escalation, and SOUL refusal — each handler block MUST include a `# TODO(GH-1272): wire outcome-recorder(...)` stub matching the exact comment shape in `watch/SKILL.md:124,130,136`.
  - [x] Body contains a `## Shared constraints (referenced)` section listing Constraints 6 (Director consumes labels) and 7 (outcome-recorder stubs).
  - [x] Skill body does NOT inline the UI heuristic regex (`\.(tsx|svelte|vue|css|scss)$|/components/|(^|/)storybook/`) anywhere — sources from the shared library only.
  - [x] Skill body does NOT re-implement `a11y-scan`, `test-e2e`, `storybook-test`, or `visual-diff` logic — only dispatches them via `Skill()`.

#### Task 1.2: Author `plugin/ralph-hero/agents/scouts-agent.md`

- **files**: `plugin/ralph-hero/agents/scouts-agent.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Frontmatter declares `name: scouts-agent`.
  - [x] Frontmatter declares `description:` summarizing the agent role in one sentence (e.g., "Scout team agent — dispatches product-user-testing skills against a UI-touching PR and posts a `## Scout Report` consumed by ralph-merge.").
  - [x] Frontmatter declares `model: sonnet` (orchestration role with multi-skill coordination — matches log-reader/research-agent/impl-agent/val-agent tier per `docs/model-tier-policy.md`; can be overridden via `RALPH_SCOUTS_MODEL` env var documented in the agent body).
  - [x] Frontmatter declares a `tools:` allowlist that is the same set declared in the skill's `allowed-tools` (so `tools:` is a true superset of what the skill needs at runtime — per the wiki entry on allowlist-not-blacklist semantics).
  - [x] Frontmatter declares `skills: [ralph-hero:scouts]` preloading the skill (matches `impl-agent.md:6-7`).
  - [x] Body is a thin wrapper: 1–3 sentences directing the agent to follow the preloaded scouts instructions for the issue specified in its task prompt (matches `impl-agent.md:10` shape).
  - [x] File does NOT declare `hooks`, `mcpServers`, or `permissionMode` — per CLAUDE.md Plugin Agents rule, only allowed frontmatter is `name`, `description`, `model`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `effort`, `maxTurns`.

#### Task 1.3: Verify SOUL integration

- **files**: `plugin/ralph-hero/skills/scouts/SOUL.md` (read-only verification)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] `plugin/ralph-hero/skills/scouts/SOUL.md` exists with frontmatter `team: scouts` and ≥5 `refuses:` entries (already true — verify, do not modify).
  - [x] `load-team-soul.sh` discovery is exercised: a manual invocation like `RALPH_COMMAND=scouts bash plugin/ralph-hero/hooks/scripts/load-team-soul.sh` emits a JSON envelope with `hookSpecificOutput.additionalContext` containing the SOUL body. Capture the output and assert it is non-empty.
  - [x] The `## SOUL refusal enforcement` section in `SKILL.md` (added in Task 1.1) explicitly cites at least two of the SOUL refusals — confirmed by grep for `"claiming a finding without a screenshot"` and `"filing a flaky test failure"` substrings in SKILL.md.
  - [x] If verification fails (SOUL not loaded, or refusal text not cited), the task fails — impl-agent must fix SKILL.md, not SOUL.md.

#### Task 1.4: Lint + smoke validation

- **files**: (no file edits; runs existing scripts)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [x] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` exits 0 with `FAIL=0` (regression check — this phase should not affect the heuristic smoke).
  - [x] `bash plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh` exits 0 if present (regression check — this phase should not affect the merge-gate smoke).
  - [x] `grep -c '^## Scout Report' plugin/ralph-hero/skills/scouts/SKILL.md` returns ≥ 1 (the literal header ralph-merge greps for is documented). Result: 2
  - [x] `grep -c 'Verdict: GREEN' plugin/ralph-hero/skills/scouts/SKILL.md` returns ≥ 1 (the literal verdict string ralph-merge greps for is documented). Result: 2
  - [x] `grep -c 'TODO(GH-1272)' plugin/ralph-hero/skills/scouts/SKILL.md` returns ≥ 3 (one stub per terminal handler — success, escalation, SOUL refusal). Result: 5
  - [x] `python3 -c "import yaml,sys; yaml.safe_load(open('plugin/ralph-hero/skills/scouts/SKILL.md').read().split('---')[1])"` exits 0 (frontmatter is valid YAML). If `python3` is not available, fall back to `node -e "require('js-yaml').load(...)"` or any installed YAML parser.
  - [x] `python3 -c "import yaml,sys; yaml.safe_load(open('plugin/ralph-hero/agents/scouts-agent.md').read().split('---')[1])"` exits 0 (agent frontmatter is valid YAML).
  - [x] `grep -c 'is_ui_touching\|_ui_heuristic' plugin/ralph-hero/skills/scouts/SKILL.md` returns ≥ 1 (heuristic is referenced by function name, not by inlined regex). Result: 2
  - [x] `grep -cE '\\.(tsx\\|svelte\\|vue\\|css\\|scss)\\$' plugin/ralph-hero/skills/scouts/SKILL.md` returns 0 (regex is NOT inlined — sourced from shared library only). Result: 0

### Phase Success Criteria

#### Automated Verification:

- [x] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` exits 0 (regression). PASS=19 FAIL=0
- [x] `test -f plugin/ralph-hero/skills/scouts/SKILL.md && test -f plugin/ralph-hero/agents/scouts-agent.md` exits 0.
- [x] `grep -E '^name:\s*scouts-agent' plugin/ralph-hero/agents/scouts-agent.md` returns one match.
- [x] `grep -E 'skills:\s*$' plugin/ralph-hero/agents/scouts-agent.md` returns one match AND the next line contains `ralph-hero:scouts`.
- [x] `grep -c '## Scout Report' plugin/ralph-hero/skills/scouts/SKILL.md` ≥ 1. Result: 2
- [x] `grep -c 'Verdict: GREEN' plugin/ralph-hero/skills/scouts/SKILL.md` ≥ 1. Result: 2
- [x] `grep -c 'TODO(GH-1272)' plugin/ralph-hero/skills/scouts/SKILL.md` ≥ 3. Result: 5
- [x] `bash plugin/ralph-hero/hooks/scripts/load-team-soul.sh` with `RALPH_COMMAND=scouts` emits a JSON envelope containing `additionalContext` with the SOUL body (manual or scripted check). VERIFIED: additionalContext non-empty, hookEventName=SessionStart
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` continues to pass (no impact on MCP server). (deferred to val-agent — no MCP changes in this phase)

#### Manual Verification:

- [ ] Read `plugin/ralph-hero/skills/scouts/SKILL.md` end-to-end: the dispatch matrix, Scout Report shape, and terminal handlers are all unambiguous. A new reader could implement the orchestrator from the doc alone (dispatchability test).
- [ ] Confirm the `## Scout Report` shape would pass ralph-merge's Step 4b: pasted into a fake PR comment with `Verdict: GREEN`, the grep at `ralph-merge/SKILL.md:248,259` would match.
- [ ] Confirm by reading both `SOUL.md` and `SKILL.md` that the team voice carries through (curious-mischievous tone is reflected in the refusal-enforcement section, not just the SOUL file).

**Creates for next phase**: A live `/ralph-hero:scouts --issue NNN` entrypoint and a registered `scouts-agent`, both consumable by Phase 3 (per-PR producer creates `scout-auto` issues which Director will route to this entrypoint once Phase 4 flips the taxonomy from `pending` to `live`).

---

## Integration Testing

This phase ships the orchestrator but does not exercise the end-to-end loop — that's Phase 5 (GH-1321, self-host validation). Integration here is bounded to:

- [ ] `bash plugin/ralph-hero/scripts/scout-heuristic-smoke.sh` passes (regression — heuristic untouched).
- [ ] `bash plugin/ralph-hero/scripts/scout-merge-gate-smoke.sh` passes if present (regression — merge gate untouched).
- [ ] Manual SOUL loading check: `RALPH_COMMAND=scouts bash plugin/ralph-hero/hooks/scripts/load-team-soul.sh | jq -r '.hookSpecificOutput.additionalContext' | head -5` prints the first lines of `SOUL.md`.
- [ ] MCP server tests still green (no MCP changes here, but worth running as a sanity check): `cd plugin/ralph-hero/mcp-server && npm test`.

The closed-loop test (open a fixture PR → workflow files scout-auto issue → Director dispatches → scouts skill runs → Scout Report posted → ralph-merge unblocks) is owned by Phase 5.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1318
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/1314
- Sibling phases: #1317 (heuristic — blocker), #1319 (per-PR producer — sibling), #1320 (docs flip — sibling), #1321 (self-host validation — sibling)
- Watch (orchestrator pattern model): `plugin/ralph-hero/skills/watch/SKILL.md`
- Caretake (bundled-skills aggregation pattern): `plugin/ralph-hero/skills/caretake/SKILL.md`
- ralph-merge Scout Report consumer: `plugin/ralph-hero/skills/ralph-merge/SKILL.md:213-276`
- ralph-pr Scout Trigger producer: `plugin/ralph-hero/skills/ralph-pr/SKILL.md:367-417`
- Existing scouts SOUL: `plugin/ralph-hero/skills/scouts/SOUL.md`
- SessionStart SOUL loader: `plugin/ralph-hero/hooks/scripts/load-team-soul.sh`
- Director taxonomy (scouts entries): `plugin/ralph-hero/skills/director/event-classes.md:17,29,58`
- Agent shape reference: `plugin/ralph-hero/agents/impl-agent.md`, `plugin/ralph-hero/agents/log-reader.md`
- Model tier policy: `plugin/ralph-hero/docs/model-tier-policy.md`
- Playwright sub-skills (dispatch targets, not modified): `plugin/ralph-playwright/skills/a11y-scan/SKILL.md`, `plugin/ralph-playwright/skills/test-e2e/SKILL.md`, `plugin/ralph-playwright/skills/storybook-test/SKILL.md`, `plugin/ralph-playwright/skills/visual-diff/SKILL.md`
- Phase 1 plan (heuristic library this phase consumes): `thoughts/shared/plans/2026-05-19-GH-1317-extract-shared-ui-heuristic.md`
