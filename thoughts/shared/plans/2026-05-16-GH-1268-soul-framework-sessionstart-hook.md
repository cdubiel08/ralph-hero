---
date: 2026-05-16
status: draft
type: plan
github_issue: 1268
github_issues: [1268]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1268
primary_issue: 1268
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [soul, sessionstart-hook, agent-teams, voice, director]
---

# SOUL Framework + SessionStart Hook — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-16-unified-agent-system-architecture]]

## Overview
Single issue, decomposed into four sequential phases inside one PR. This is the ground-floor enabler for Features B (Director), C (Watcher), F (Scouts), and G (Caretakers) — each consumes the SOUL schema and the SessionStart hook defined here.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1268 | SOUL schema document | (part of S) |
| 2 | GH-1268 | `load-team-soul.sh` SessionStart hook script | (part of S) |
| 3 | GH-1268 | Five team SOUL.md files (builders authored, others stubbed) | (part of S) |
| 4 | GH-1268 | Smoke test for the hook | (part of S) |

**Why grouped**: All four phases land in one PR because the schema, hook, SOUL files, and smoke test form a single indivisible unit — the hook is meaningless without the schema, the schema is unverified without SOUL files, and the SOUL files cannot be loaded without the hook. The smoke test exists to bind the contract.

## Shared Constraints

Inherited verbatim from the parent plan-of-plans (`thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md` § Shared Constraints). The constraints that directly govern this feature:

1. **No new runtime layers.** This feature adds documentation, one bash script, five markdown files, and one smoke script. No daemon, no new dependency, no new MCP server.
2. **Skill / agent surface conventions.** New artifacts live under `plugin/ralph-hero/skills/...` and `plugin/ralph-hero/hooks/scripts/...`. Hook frontmatter shape follows existing conventions (see `hero/SKILL.md`).
3. **SOUL files use a fixed schema.** Frontmatter `team:`, `voice:`, `refuses: [list]`. Body ~150–250 words covering "How you talk" + at least one **Bad / Good** exchange. Loaded by a *single* shared SessionStart hook script — not five copies.
4. **Style inheritance.** SOULs inherit `plugin/ralph-hero/skills/STYLE.md` (mechanics) and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` (link format). STYLE wins for mechanics; SOUL wins for voice and refusals.
5. **Atomicity.** This feature is S — produces 4 phases of atomic work, all in one PR. No child issues.

Feature-specific constraints discovered during planning:

- The SessionStart hook must be a no-op when `$RALPH_COMMAND` is unset or when no matching SOUL exists. Silent exit 0 — do not warn, do not fail, do not write to the env file, do not emit stdout.
- The hook reads `$RALPH_COMMAND` from the environment (already set by `set-skill-env.sh` in each team's frontmatter). When a matching SOUL exists it emits a **JSON envelope** to stdout — `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: <SOUL body> } }` — using `jq -n --arg ctx ...`, mirroring the canonical pattern in `plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh`. Raw `cat` of the SOUL file is **not** how Claude Code SessionStart context injection works in this repo and would ship as a silent no-op in production.
- When a SOUL is loaded, the hook also appends `export RALPH_SOUL_LOADED=<team>` to `$CLAUDE_ENV_FILE` (when `$CLAUDE_ENV_FILE` is set), mirroring `RALPH_SUPERPOWERS_BRIDGE=true` from the superpowers bridge. Downstream hooks in Features B/C/F/G can assert SOUL injection occurred via this env var.
- `jq` is a required runtime dependency. Both `superpowers-bridge-session.sh` and `load-team-soul.sh` use it; document the dependency in the schema doc and in the hook header.
- Stub SOUL files (watch, scouts, memorykeepers, caretake) must satisfy the schema (valid frontmatter + non-empty body) so the smoke test passes uniformly across teams — Features C/F/G replace bodies later.
- `hero/SOUL.md` is the **fully authored** reference SOUL for builders; the other four are stubs.
- The `memorykeepers` skill directory does not yet exist. The SOUL file is placed at `plugin/ralph-hero/skills/memorykeepers/SOUL.md` and the parent directory is created. No SKILL.md is added — that lives in a future feature.

## Current State Analysis

The repo already has the substrate this feature builds on:

- `plugin/ralph-hero/skills/STYLE.md` — global tone rules (filter rationale out of user output; render results, not reasoning).
- `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` — canonical comment header taxonomy for skill-to-skill linking.
- `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` — SessionStart helper that exports `RALPH_COMMAND=<skill-name>` into `CLAUDE_ENV_FILE` for every skill session. Hero already wires this in its frontmatter (`SessionStart` → `set-skill-env.sh RALPH_COMMAND=hero`).
- `plugin/ralph-hero/scripts/cos/smoke.sh` and `plugin/ralph-hero/scripts/cos/self-improve-smoke.sh` — established smoke-test pattern (PASS/FAIL counters, exit non-zero on failure, suitable for manual invocation).

What's missing:

- A canonical document describing the SOUL.md schema. No file currently defines what a "team voice" looks like or what frontmatter it needs.
- A SessionStart hook that reads `$RALPH_COMMAND`, locates `plugin/ralph-hero/skills/<command>/SOUL.md`, and emits its content as additional system context.
- The five SOUL files themselves.
- A smoke test asserting the hook loads SOUL content when present and is silent otherwise.

## Desired End State

### Verification
- [ ] `plugin/ralph-hero/skills/shared/soul-schema.md` exists, documents the frontmatter shape (`team:`, `voice:`, `refuses: [list]`), body conventions (~150–250 words: "How you talk" + Bad/Good exchange), and STYLE-vs-SOUL precedence rule.
- [ ] `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` exists, is executable, and exits 0 silently when `$RALPH_COMMAND` is unset or no SOUL file exists for the command.
- [ ] When `$RALPH_COMMAND` is set and the matching SOUL exists, the script emits a JSON envelope on stdout — `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: <SOUL body> } }` — and appends `export RALPH_SOUL_LOADED=<team>` to `$CLAUDE_ENV_FILE` when that var is set.
- [ ] Five SOUL files exist at: `plugin/ralph-hero/skills/hero/SOUL.md`, `plugin/ralph-hero/skills/watch/SOUL.md`, `plugin/ralph-hero/skills/scouts/SOUL.md`, `plugin/ralph-hero/skills/memorykeepers/SOUL.md`, `plugin/ralph-hero/skills/caretake/SOUL.md`. Hero is fully authored; the other four are schema-valid stubs.
- [ ] `plugin/ralph-hero/scripts/soul/smoke.sh` exists, runs without external dependencies, exercises the hook against each of the five SOUL files plus an unset-`$RALPH_COMMAND` case, and exits 0 when all assertions pass.

## What We're NOT Doing

- Authoring full voice bodies for watch, scouts, memorykeepers, caretake. Stubs only — Feature C fills watch, Feature F fills scouts, Feature G fills caretake. memorykeepers stays a stub until that team's feature is planned separately.
- Registering the SessionStart hook in any team skill frontmatter beyond `hero` (which already wires `set-skill-env.sh`). Features B, C, F, G each wire their own `load-team-soul.sh` in their own SessionStart block when the team skill is created.
- Creating any team SKILL.md (Director, Watch, Scouts, Caretake, Memorykeepers) — those are Features B, C, F, G.
- Adding the load hook to plugin-level `hooks.json`. The hook is per-skill, wired in each skill's frontmatter — keeping it scoped prevents accidental SOUL injection in non-team skills.
- Changing the `set-skill-env.sh` script. The existing one already exports `RALPH_COMMAND` correctly; we read it, we do not change it.
- Touching `STYLE.md`. STYLE rules are stable; SOUL extends, not replaces.

## Implementation Approach

Four phases in dependency order. Phase 1 (schema doc) is the contract; Phase 2 (hook script) is the runtime; Phase 3 (SOUL files) populates the schema; Phase 4 (smoke test) verifies the contract. Each subsequent phase depends on the prior.

The PR includes all four phases. The smoke test is the gate — if it fails, the PR does not merge.

---

## Phase 1: SOUL Schema Document
- **depends_on**: null

### Overview
Author the canonical reference for what a SOUL.md looks like. This document is referenced by every team feature (B, C, F, G) and by the load hook itself. It is the contract between team authors and the orchestrator runtime.

### Tasks

#### Task 1.1: Author `soul-schema.md`
- **files**: `plugin/ralph-hero/skills/shared/soul-schema.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File begins with a one-paragraph statement of purpose ("a SOUL gives an orchestrator skill durable voice and refusals across sessions").
  - [ ] Documents the frontmatter shape explicitly:
    - `team:` (string, required) — team name matching the skill directory (e.g., `builders`, `watchers`).
    - `voice:` (string, required) — one-line voice descriptor (e.g., "paranoid-but-disciplined").
    - `refuses:` (array of strings, required, may be empty `[]`) — list of behaviors the team refuses (e.g., "claims without trace IDs").
  - [ ] Documents the body conventions: target ~150–250 words; required headings `## How you talk` and `## Bad / Good`; at least one Bad/Good example exchange.
  - [ ] Includes a "Precedence" section: STYLE wins for mechanics (file paths, link formats, comment headers); SOUL wins for voice and refusals. When the two conflict, STYLE wins for mechanics; SOUL wins for tone.
  - [ ] Includes one inline example SOUL block (frontmatter + body) showing the full shape.
  - [ ] Cross-references `plugin/ralph-hero/skills/STYLE.md` and `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` with relative links.

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/shared/soul-schema.md` — file present.
- [ ] `grep -q '^## How you talk' plugin/ralph-hero/skills/shared/soul-schema.md` and `grep -q '^## Bad / Good' plugin/ralph-hero/skills/shared/soul-schema.md` — body convention headings documented.
- [ ] `grep -q 'team:' plugin/ralph-hero/skills/shared/soul-schema.md` and `grep -q 'voice:' plugin/ralph-hero/skills/shared/soul-schema.md` and `grep -q 'refuses:' plugin/ralph-hero/skills/shared/soul-schema.md` — frontmatter keys documented.

#### Manual Verification:
- [ ] A new team feature author can read this doc end-to-end and write a valid SOUL without further questions.

**Creates for next phase**: The frontmatter shape and body conventions that Phase 2 (hook script) and Phase 3 (SOUL files) must satisfy.

---

## Phase 2: SessionStart Hook Script
- **depends_on**: [phase-1]

### Overview
Implement the single shared SessionStart hook that resolves `$RALPH_COMMAND` to a SOUL file and emits its content via the Claude Code SessionStart JSON envelope. The hook is deliberately tiny — read env var, check file exists, wrap content in `{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: <body> } }` using `jq`, write JSON to stdout, append `RALPH_SOUL_LOADED=<team>` to `$CLAUDE_ENV_FILE` — but the silent-exit semantics on missing inputs and the JSON-envelope contract are both load-bearing. Raw `cat` of the SOUL file to stdout is ignored by the runtime; the canonical pattern lives in `plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh`.

### Tasks

#### Task 2.1: Implement `load-team-soul.sh`
- **files**: `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` (create), `plugin/ralph-hero/hooks/scripts/set-skill-env.sh` (read for pattern reference), `plugin/ralph-hero/hooks/scripts/superpowers-bridge-session.sh` (read for canonical JSON-envelope pattern)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Script begins with `#!/usr/bin/env bash` and `set -euo pipefail`.
  - [ ] Resolves `CLAUDE_PLUGIN_ROOT` via `${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}` so it works both as a registered hook and when invoked manually for testing.
  - [ ] If `${RALPH_COMMAND:-}` is empty, exits 0 silently with no stdout output and without touching `$CLAUDE_ENV_FILE`.
  - [ ] Resolves the candidate SOUL path as `${CLAUDE_PLUGIN_ROOT}/skills/${RALPH_COMMAND}/SOUL.md`.
  - [ ] If the candidate path does not exist as a regular file, exits 0 silently with no stdout output and without touching `$CLAUDE_ENV_FILE`.
  - [ ] If the candidate exists, reads the file contents and emits a JSON envelope on stdout using `jq`: `jq -n --arg ctx "$(cat "$SOUL_PATH")" '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $ctx } }'`. The runtime parses this JSON and injects `additionalContext` into the model's system context. Raw `cat` is **not** sufficient — see `superpowers-bridge-session.sh` for the canonical pattern.
  - [ ] When the candidate exists and `$CLAUDE_ENV_FILE` is set and non-empty, appends `export RALPH_SOUL_LOADED=<team>` to that file (where `<team>` is `$RALPH_COMMAND`). Mirrors the `RALPH_SUPERPOWERS_BRIDGE=true` precedent so downstream hooks can detect SOUL injection.
  - [ ] Depends on `jq` being on `$PATH` — same hard requirement as `superpowers-bridge-session.sh`. No fallback needed; both hooks share the dependency.
  - [ ] Has executable bit set (`chmod +x`).
  - [ ] Final `exit 0` is explicit.

#### Task 2.2: Document the hook contract in a header comment
- **files**: `plugin/ralph-hero/hooks/scripts/load-team-soul.sh` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Header comment block describes: trigger (SessionStart), expected env (`RALPH_COMMAND`), exit semantics (always 0; stdout empty when no SOUL), output contract (JSON envelope with `hookSpecificOutput.hookEventName="SessionStart"` and `hookSpecificOutput.additionalContext=<SOUL body>`), side effect (appends `RALPH_SOUL_LOADED=<team>` to `$CLAUDE_ENV_FILE` when SOUL loaded), runtime dependency (`jq`), wiring (per-skill frontmatter, not plugin-level `hooks.json`), and reference to `soul-schema.md` plus `superpowers-bridge-session.sh` as the canonical envelope pattern.

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -x plugin/ralph-hero/hooks/scripts/load-team-soul.sh` — script is executable.
- [ ] `bash -n plugin/ralph-hero/hooks/scripts/load-team-soul.sh` — script parses without syntax errors.
- [ ] `env -u RALPH_COMMAND bash plugin/ralph-hero/hooks/scripts/load-team-soul.sh` produces no stdout and exit 0.
- [ ] `RALPH_COMMAND=nonexistent-skill bash plugin/ralph-hero/hooks/scripts/load-team-soul.sh` produces no stdout and exit 0.
- [ ] With a SOUL present (e.g. `hero/SOUL.md` created in Phase 3), `RALPH_COMMAND=hero bash plugin/ralph-hero/hooks/scripts/load-team-soul.sh | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"'` exits 0 — output is parseable JSON with the correct envelope shape.
- [ ] Same invocation: `... | jq -r '.hookSpecificOutput.additionalContext' | grep -q '^team: builders'` — `additionalContext` contains the SOUL frontmatter body.
- [ ] With `CLAUDE_ENV_FILE` set to a tempfile and SOUL present, after invocation the tempfile contains `export RALPH_SOUL_LOADED=hero`.

#### Manual Verification:
- [ ] Wiring the hook into a test skill's `SessionStart` block surfaces the SOUL body in the next Claude turn's context.

**Creates for next phase**: The runtime contract that Phase 3 (SOUL files) must satisfy — and the envelope shape that Phase 4 (smoke test) must assert against.

---

## Phase 3: Team SOUL Files
- **depends_on**: [phase-1, phase-2]

### Overview
Create five SOUL.md files. `hero/SOUL.md` is the fully authored reference; the other four are schema-valid stubs that Features C, F, G replace with full bodies later.

### Tasks

#### Task 3.1: Author `hero/SOUL.md` (builders — fully written)
- **files**: `plugin/ralph-hero/skills/hero/SOUL.md` (create), `plugin/ralph-hero/skills/shared/soul-schema.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter: `team: builders`, `voice: "thorough, deferential to the plan"`, `refuses: ["implementing without a plan", "skipping the verification checklist", "rewriting scope mid-phase"]`.
  - [ ] Body ~150–250 words.
  - [ ] `## How you talk` section: terse, plan-first, defers questions to the plan document, surfaces blockers as `BLOCKED:` lines.
  - [ ] `## Bad / Good` section: one explicit Bad example (e.g., narrating filter logic, asking "should I…?") and one Good example (e.g., "Phase 2 complete; running tests; result: pass").
  - [ ] Inherits STYLE.md — no user-facing rationale narration.

#### Task 3.2: Stub `watch/SOUL.md` (paranoid-but-disciplined)
- **files**: `plugin/ralph-hero/skills/watch/SOUL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter: `team: watchers`, `voice: "paranoid-but-disciplined"`, `refuses: ["claims without trace IDs", "claims without LQL queries", "auto-remediation outside the sre-fixit allowlist"]`.
  - [ ] Body: at least one short paragraph under `## How you talk` (placeholder text acknowledging Feature C will author this) and one minimal Bad/Good exchange. Total body 30–80 words.
  - [ ] File header comment: `<!-- STUB: Feature C (GH-1270) replaces this body. -->`.
  - [ ] Parent directory `plugin/ralph-hero/skills/watch/` is created (no SKILL.md required yet).

#### Task 3.3: Stub `scouts/SOUL.md` (curious-mischievous)
- **files**: `plugin/ralph-hero/skills/scouts/SOUL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter: `team: scouts`, `voice: "curious-mischievous"`, `refuses: ["claiming a finding without a screenshot or trace", "merging UI changes without a Scout report"]`.
  - [ ] Body: minimal `## How you talk` paragraph + one Bad/Good exchange. Total body 30–80 words.
  - [ ] File header comment: `<!-- STUB: Feature F (GH-1273) replaces this body. -->`.
  - [ ] Parent directory `plugin/ralph-hero/skills/scouts/` is created.

#### Task 3.4: Stub `memorykeepers/SOUL.md` (librarian)
- **files**: `plugin/ralph-hero/skills/memorykeepers/SOUL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter: `team: memorykeepers`, `voice: "librarian"`, `refuses: ["promoting unverified reflections to wiki tier", "discarding raw memories without an outcome record"]`.
  - [ ] Body: minimal `## How you talk` paragraph + one Bad/Good exchange. Total body 30–80 words.
  - [ ] File header comment: `<!-- STUB: Memorykeepers team feature (TBD) replaces this body. -->`.
  - [ ] Parent directory `plugin/ralph-hero/skills/memorykeepers/` is created.

#### Task 3.5: Stub `caretake/SOUL.md` (quiet-steward)
- **files**: `plugin/ralph-hero/skills/caretake/SOUL.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter: `team: caretakers`, `voice: "quiet-steward"`, `refuses: ["archiving items without a written reason", "noisy status updates"]`.
  - [ ] Body: minimal `## How you talk` paragraph + one Bad/Good exchange. Total body 30–80 words.
  - [ ] File header comment: `<!-- STUB: Feature G (GH-1274) replaces this body. -->`.
  - [ ] Parent directory `plugin/ralph-hero/skills/caretake/` is created.

### Phase Success Criteria

#### Automated Verification:
- [ ] `test -f plugin/ralph-hero/skills/hero/SOUL.md && test -f plugin/ralph-hero/skills/watch/SOUL.md && test -f plugin/ralph-hero/skills/scouts/SOUL.md && test -f plugin/ralph-hero/skills/memorykeepers/SOUL.md && test -f plugin/ralph-hero/skills/caretake/SOUL.md` — all five files present.
- [ ] For each file: `head -1` is `---` (frontmatter starts) and the frontmatter block closes; the file contains `team:`, `voice:`, and `refuses:` lines; the body contains `## How you talk` and `## Bad / Good` headings.
- [ ] `hero/SOUL.md` word count (body only, excluding frontmatter) is ≥ 150 and ≤ 300 (allowing slight overshoot).

#### Manual Verification:
- [ ] `hero/SOUL.md` reads as a coherent voice — a reviewer can paraphrase the builders' tone after one read.
- [ ] The four stubs are clearly marked as stubs and direct the reader to the responsible feature.

**Creates for next phase**: Five SOUL files for the smoke test to exercise.

---

## Phase 4: Smoke Test
- **depends_on**: [phase-2, phase-3]

### Overview
Bind the contract: assert the hook loads each SOUL when `$RALPH_COMMAND` matches and is silent otherwise. The smoke test runs without external dependencies (no MLX server, no network) so it can execute in CI and locally without setup.

### Tasks

#### Task 4.1: Implement `smoke.sh`
- **files**: `plugin/ralph-hero/scripts/soul/smoke.sh` (create), `plugin/ralph-hero/scripts/cos/smoke.sh` (read for pattern reference)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [2.1, 3.1, 3.2, 3.3, 3.4, 3.5]
- **acceptance**:
  - [ ] File header: `#!/usr/bin/env bash`, `set -euo pipefail`, brief comment block describing what the smoke covers and how to invoke (`bash plugin/ralph-hero/scripts/soul/smoke.sh`). Hard-depends on `jq` — fail fast with a clear message if `command -v jq` returns non-zero.
  - [ ] Uses `PASS=0`/`FAIL=0` counters with `_pass`/`_fail` helpers mirroring `scripts/cos/smoke.sh`.
  - [ ] Resolves the hook path relative to the script location (no hard-coded absolute paths).
  - [ ] **Test A**: `env -u RALPH_COMMAND bash <hook>` — assert exit 0 and empty stdout (no JSON envelope when no command).
  - [ ] **Test B**: `RALPH_COMMAND=nonexistent bash <hook>` — assert exit 0 and empty stdout (no JSON envelope when no SOUL).
  - [ ] **Tests C1–C5**: For each of `hero`, `watch`, `scouts`, `memorykeepers`, `caretake` — invoke `RALPH_COMMAND=<name> bash <hook>`, capture stdout, then assert (a) exit 0, (b) stdout parses as JSON via `echo "$out" | jq -e '.' >/dev/null`, (c) `echo "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"'` exits 0, and (d) `echo "$out" | jq -r '.hookSpecificOutput.additionalContext'` contains `team: <expected-team-name>`. Raw substring matches against the unparsed stdout are explicitly disallowed — they would pass on a broken raw-`cat` implementation and mask the bug this contract guards.
  - [ ] **Test D**: For `hero` only — `jq -r '.hookSpecificOutput.additionalContext'` of the hook output contains both `## How you talk` and `## Bad / Good` headings.
  - [ ] **Test E** (CLAUDE_ENV_FILE side effect): create a tempfile, set `CLAUDE_ENV_FILE=$tempfile`, invoke `RALPH_COMMAND=hero bash <hook>`, then assert the tempfile contains `export RALPH_SOUL_LOADED=hero`. Cleanup the tempfile after the test.
  - [ ] Final summary line: `=== smoke: PASS=N FAIL=M ===`.
  - [ ] Exits non-zero when any FAIL > 0.

#### Task 4.2: Wire smoke into npm test entry point (optional)
- **files**: `plugin/ralph-hero/mcp-server/package.json` (read), `plugin/ralph-hero/scripts/soul/smoke.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1]
- **acceptance**:
  - [ ] If `package.json` has a `test:smoke` or equivalent aggregator script, append a `soul-smoke` step that invokes `bash plugin/ralph-hero/scripts/soul/smoke.sh`. If no such aggregator exists, document the manual invocation in the smoke script header instead and skip the package.json edit. **This task may be a no-op** depending on what exists at implementation time — the implementer should choose whichever path keeps the test discoverable without inventing new infrastructure.

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/scripts/soul/smoke.sh` exits 0 and the summary line shows `FAIL=0`.
- [ ] Running the smoke script twice in succession produces identical output (no statefulness, no side effects).

#### Manual Verification:
- [ ] Deleting any one SOUL file and re-running smoke produces a clear PASS/FAIL line identifying the missing file (graceful failure mode).

**Creates for next phase**: PR validation — this smoke is the gate that the PR's CI step (or manual review) runs to confirm the feature works end-to-end.

---

## Integration Testing

This feature does not exercise integration with other features because Features B, C, F, G do not yet exist. Integration testing happens when:

- [ ] Feature B (Director skill, GH-1269) lands a SessionStart hook entry pointing at `load-team-soul.sh` in `director/SKILL.md` frontmatter, and the resulting Director session shows the Director SOUL body in its system context.
- [ ] Feature C (Watcher entrypoint, GH-1270) lands `watch/SKILL.md` with the same hook wiring and replaces the watch SOUL stub with a full body.

The Phase 4 smoke test covers the contract that those downstream features will rely on.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1268
- Parent plan-of-plans: [thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md](2026-05-16-GH-1267-unified-agent-system-epic.md)
- Epic issue: https://github.com/cdubiel08/ralph-hero/issues/1267
- STYLE.md: `plugin/ralph-hero/skills/STYLE.md`
- Artifact comment protocol: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`
- Existing SessionStart pattern: `plugin/ralph-hero/skills/hero/SKILL.md` frontmatter
- Existing SessionStart helper: `plugin/ralph-hero/hooks/scripts/set-skill-env.sh`
- Smoke test reference: `plugin/ralph-hero/scripts/cos/smoke.sh`
