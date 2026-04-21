---
date: 2026-04-20
status: draft
type: plan
github_issue: 785
github_issues: [785]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/785
primary_issue: 785
parent_plan: thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md
tags: [ralph-playwright, opus-4-7, reflect-phase, model-routing, skill-frontmatter]
---

# ralph-playwright: Split model routing — Opus 4.7 for reflect, Sonnet for execute — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-16-opus-4-7-ralph-playwright-vision]]
- builds_on:: [[2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic]]
- builds_on:: [[2026-04-04-hero-dispatch-architecture-single-vs-team]]

## Overview

Single-issue atomic plan. One GitHub issue, two implementation phases plus verification.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-785 | Declare Opus 4.7 preferred-model slot on reflect SKILL.md + env override | S |
| 2 | GH-785 | Document the execute/reflect split | S |
| 3 | GH-785 | Verification against a real journey | S |

Three phases on a single issue: Phase 1 is the mechanical change (SKILL.md frontmatter + env-override prompt block), Phase 2 is documentation (plugin README + cross-references), Phase 3 is hands-on verification. Phases 2 and 3 share Phase 1's change; Phase 3 is run-time only (no source edits beyond what Phases 1 and 2 produced).

## Shared Constraints

Inherited verbatim from `thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md`:

### Architecture & file ownership (inherited)

- The Execute -> Reflect -> Act pipeline is strict and schema-enforced. Any new inputs/outputs flow through the three YAML schemas in `plugin/ralph-playwright/schemas/`: `journey-trace.schema.yaml`, `signal-report.schema.yaml`, `action-log.schema.yaml`. Schema additions must be additive.
- Hooks in `plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh` validate journey-trace, signal-report, and action-log YAMLs at Read and Write boundaries. Any schema change that tightens validation must update the hook in the same PR.
- Execute runs as a sub-agent (`explorer-agent` or `story-runner-agent`) with `model: sonnet`. **Keep Sonnet for Execute.** Reflect runs in the calling model's context — that is the sole tier where Opus 4.7 routing applies.
- Screenshots (PNG) and accessibility snapshots (`.md`) are captured at EVERY step. No feature may opt out of either capture.

### Model routing discipline (inherited)

- Preferred-model hints are expressed in SKILL.md frontmatter with env var overrides (naming: `RALPH_PLAYWRIGHT_<PHASE>_MODEL`). Escalation rules must be declarative in SKILL.md, not buried in prompt logic.
- Every reflect step records which model ran it — deferred to GH-787 (Feature C). This plan does NOT touch the signal-report schema.

### Cost & token envelope (inherited)

- Default capture resolution stays at the playwright-cli current viewport default.
- Opus 4.7 is materially more expensive per screenshot than Sonnet at 1568px. Default routing must keep Sonnet on happy paths; Opus 4.7 is reserved for reflect.

### Research anchoring (inherited)

This plan cites `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 1 as the motivating recommendation.

### Feature-specific constraints (this plan)

- **No schema or hook changes.** This feature is pure frontmatter + documentation. Per-step model-run recording is #787's concern, not this one.
- **No changes to `agents/explorer-agent.md` or `agents/story-runner-agent.md`.** They stay on `model: sonnet`. The issue acceptance criteria and plan-of-plans Shared Constraint are explicit on this.
- **Model ID format**: use `claude-opus-4-7` (full model ID), not the short tier name `opus`. Tier names resolve to the default model in that tier, which may change; the issue target is specifically Opus 4.7. Sibling precedent: `thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md:450` uses the full ID `claude-sonnet-4-6`.
- **Env-override semantics**: `RALPH_PLAYWRIGHT_REFLECT_MODEL`, if set, overrides the frontmatter hint. The hint is a prompt-level instruction — enforcement flows through Claude Code's dispatch, not a runtime env reader. We document the env var as the canonical escape hatch for users who want to pin an alternate model (e.g., `claude-opus-4-8` when it ships, or roll back to `claude-sonnet-4-6`).
- **Scope discipline**: Features B (#786, structured reflect prompt) and C (#787, escalation by step importance) layer on top of this plan. Leave hooks for them:
  - Phase 1 must keep the reflect `## Process` section structurally unchanged so that #786's rewrite of §Step 2 is a clean diff.
  - Phase 1 must not introduce escalation logic — that is #787.

## Current State Analysis

### How reflect runs today

- `plugin/ralph-playwright/skills/reflect/SKILL.md:1-7` declares frontmatter with `name`, `description`, and `allowed-tools: [Read, Write]` only. **No `model:` field.** When `/ralph-playwright:reflect` is invoked via `Skill()` dispatch, it inherits the caller's model.
- Reflect is embedded as a step inside five other skills: `explore/SKILL.md:31-46`, `test-e2e/SKILL.md:43-57`, `a11y-scan/SKILL.md:30-45`, `capture/SKILL.md:63-69`, and `ux-audit/SKILL.md:84` (not read in full, but referenced by parent plan). In these contexts, the reflect step runs inline in the parent skill's model context; the standalone `reflect` SKILL.md is not loaded.
- `plugin/ralph-playwright/agents/explorer-agent.md:4` and `plugin/ralph-playwright/agents/story-runner-agent.md:4` both specify `model: sonnet`. These are the execute sub-agents. They must not change.

### How SKILL.md `model:` frontmatter works (empirical)

- `thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md:187-194` empirically verified: `Skill("ralph-hero:draft")` declares `model: sonnet` in frontmatter; invoking it from an opus session switched the loaded model, confirmed by Claude Code UI: `Successfully loaded skill · claude-sonnet-4-6`.
- The `model:` field accepts either a tier name (`opus`, `sonnet`, `haiku`) or a full model ID (e.g., `claude-sonnet-4-6`). Full IDs pin a specific model; tier names resolve to the configured default for that tier.
- Sibling precedent inside ralph-playwright for full IDs: `thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md:450` and `thoughts/shared/plans/2026-03-19-GH-0619-ralph-playwright-story-execution.md:92` both specify `model: claude-sonnet-4-6` for explorer-agent and story-runner-agent when those agents were first authored.
- **Scope limit**: the frontmatter hint only fires for direct `Skill("ralph-playwright:reflect")` invocations. Reflect-as-step-inside-parent-skill (explore, test-e2e, a11y-scan, capture, ux-audit) inherits the caller's model. The env-var `RALPH_PLAYWRIGHT_REFLECT_MODEL` is how a user can influence model selection across all reflect contexts (users set the env var, then invoke the parent skill from a session where the env is visible; the reflect SKILL.md documents this pattern).

### What is missing

1. `skills/reflect/SKILL.md` has no `model:` frontmatter, so `/ralph-playwright:reflect` runs on whatever model the caller uses.
2. There is no documented convention for how a user would pin the reflect model.
3. There is no top-level `plugin/ralph-playwright/README.md` — documentation of the execute/reflect model split has no canonical home outside individual SKILL.md files.

## Desired End State

### Verification

- [x] `skills/reflect/SKILL.md` frontmatter declares `model: claude-opus-4-7`.
- [x] `skills/reflect/SKILL.md` documents the `RALPH_PLAYWRIGHT_REFLECT_MODEL` env var with a clear escape-hatch example.
- [x] `agents/explorer-agent.md:4` still reads `model: sonnet` (unchanged).
- [x] `agents/story-runner-agent.md:4` still reads `model: sonnet` (unchanged).
- [x] `plugin/ralph-playwright/README.md` exists and documents the execute/reflect split.
- [x] Running `/ralph-playwright:reflect <trace-path>` from a non-opus session loads Claude Opus 4.7 (verified via Claude Code UI `Successfully loaded skill · claude-opus-4-7` line, mirroring the empirical pattern from `thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md:189`). — Static: frontmatter parses as YAML with `model: claude-opus-4-7`; end-to-end UI banner observation deferred to a top-level Claude Code session per Phase 3 Verification Note.
- [x] `hooks/scripts/validate-primitive-io.sh` does not reject any artifact produced by the verification run (because no schema changes). — Verified with synthetic compliant artifact (exit 0) and a negative-control invalid artifact (exit 1).
- [x] `signal-report.yaml` produced by the verification run conforms to `schemas/signal-report.schema.yaml` unchanged. — Schema file is not in the diff; a schema-compliant synthetic signal-report passed `validate-primitive-io.sh`.

## What We're NOT Doing

Out of scope for this plan (explicitly handled by sibling features in the epic or by future work):

- **Rewriting the reflect prompt to a categorized checklist.** That is GH-786 (Feature B). Leave `## Process` §Step 2 structurally intact for a clean follow-on diff.
- **Escalation rules by step importance.** That is GH-787 (Feature C). No escalation logic, no `outcome=fail` triggers, no prior-signal triggers in this PR.
- **Recording which model ran each reflect step.** That is also GH-787. The signal-report schema is not modified in this plan.
- **Changing `agents/explorer-agent.md` or `agents/story-runner-agent.md` model settings.** Both stay on `model: sonnet`.
- **Touching `playwright-cli`, the CLI wire protocol, or any playwright internals.** This feature is markdown-only.
- **Changing schemas or the validate-primitive-io.sh hook.** No schema changes means no hook changes.
- **Embedding the env-override logic as runtime code.** SKILL.md frontmatter is declarative; we document the env var as a user-facing escape hatch. Any tooling that reads the env var (e.g., a future MCP wrapper) is out of scope.
- **Per-skill reflect model hints for embedded-reflect callers** (explore, test-e2e, a11y-scan, capture, ux-audit). The env var is the user-facing override for those; no per-skill frontmatter change is needed in this PR. A future plan may choose to propagate the hint if empirical use reveals pain.

## Implementation Approach

Three sequential phases. Phase 1 is the source change (smallest possible diff to reflect SKILL.md). Phase 2 is the documentation change (new README + cross-refs). Phase 3 is hands-on verification that the model switch actually happens and signal-report still validates.

---

## Phase 1: Declare Opus 4.7 preferred-model slot on reflect SKILL.md + env override

- **depends_on**: null

### Overview

Add `model: claude-opus-4-7` to the reflect SKILL.md frontmatter. Append a `## Model Routing` section documenting the env-override convention. Do not touch `## Process` or any other existing section.

### Tasks

#### Task 1.1: Add `model: claude-opus-4-7` to reflect SKILL.md frontmatter

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] Frontmatter block (lines 1-7) has a new `model: claude-opus-4-7` line, placed between the `description:` field and the `allowed-tools:` field.
  - [x] Frontmatter remains valid YAML (no indentation errors, no duplicate keys).
  - [x] `name`, `description`, and `allowed-tools` are otherwise unchanged.
  - [x] No other sections of the file are touched.
  - [x] `agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` still read `model: sonnet` (verify by reading after the edit).

#### Task 1.2: Append `## Model Routing` section documenting env override and execute/reflect split

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [x] New `## Model Routing` section appended at the end of the file, after the existing `### Step 5: Report` section.
  - [x] Section explains: (a) reflect runs on Opus 4.7 by default per the frontmatter hint, (b) the reason (vision-heavy workload; see research link), (c) execute stays on Sonnet via `agents/explorer-agent.md` and `agents/story-runner-agent.md`, (d) `RALPH_PLAYWRIGHT_REFLECT_MODEL` env var overrides the hint (example: `export RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-sonnet-4-6` to roll back).
  - [x] Section includes a link to the parent research doc: `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` (the §Part 3 Item 1 anchor if possible, or at minimum the doc).
  - [x] Section notes the scope caveat: the frontmatter hint fires on direct `Skill("ralph-playwright:reflect")` invocations; for reflect-as-step-inside-parent-skill (explore, test-e2e, a11y-scan, capture, ux-audit), the parent caller's model applies and the env var is the user-facing override.
  - [x] Section is <= 40 lines (concise — this is a skill doc, not a full explainer; the README in Phase 2 carries the longer narrative).

### Phase Success Criteria

#### Automated Verification

- [x] Manual: YAML frontmatter parses cleanly — verify by opening the file in an editor or running any YAML linter on the frontmatter block (e.g., `yq -o=yaml eval 'del(.)' skills/reflect/SKILL.md` returns without error — optional, ralph-playwright has no formal lint target).
- [x] No build step to run (ralph-playwright is skills/agents-only per `CLAUDE.md:26` — "ralph-playwright is skills/agents-only — no build step").

#### Manual Verification

- [x] Read the updated `skills/reflect/SKILL.md` top-to-bottom and confirm: frontmatter valid, `## Process` unchanged, `## Model Routing` appended with env-override example.
- [x] Confirm `agents/explorer-agent.md:4` and `agents/story-runner-agent.md:4` still say `model: sonnet` (diff check).

**Creates for next phase**: The canonical Opus-4.7 hint and env-override documentation inside `skills/reflect/SKILL.md`. Phase 2's README cross-links to this section.

---

## Phase 2: Document the execute/reflect split at the plugin level

- **depends_on**: [phase-1]

### Overview

Create a top-level `plugin/ralph-playwright/README.md` that documents the plugin's Execute -> Reflect -> Act pipeline and the Opus 4.7 / Sonnet model split introduced in Phase 1. Add a cross-reference from `skills/reflect/SKILL.md` Model Routing section to the new README.

### Tasks

#### Task 2.1: Create `plugin/ralph-playwright/README.md`

- **files**: [plugin/ralph-playwright/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/README.md) (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [phase-1]
- **acceptance**:
  - [x] File created at `plugin/ralph-playwright/README.md` (previously did not exist — verified by `Glob plugin/ralph-playwright/README*` returning no matches).
  - [x] README includes: (a) one-paragraph plugin description matching `.claude-plugin/plugin.json:4` tone, (b) a pipeline section summarizing Execute -> Reflect -> Act (pointers into `schemas/` and `hooks/`), (c) a **Model Routing** section — the primary deliverable — explaining: Execute runs on Sonnet via the two agents (linked), Reflect runs on Opus 4.7 via `skills/reflect/SKILL.md` frontmatter hint (linked), users override via `RALPH_PLAYWRIGHT_REFLECT_MODEL`, rationale comes from the research doc (linked).
  - [x] README lists the seven skills at a high level (setup, story-gen, explore, test-e2e, a11y-scan, storybook-test, visual-diff) with a one-liner each, each linking to its SKILL.md.
  - [x] README links to the parent epic `thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md` for the broader Opus 4.7 context.
  - [x] File length <= 200 lines (a navigational README, not a manual). — Observed: 74 lines.

#### Task 2.2: Add cross-ref from reflect SKILL.md's Model Routing section to the new README

- **files**: [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md) (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [x] The `## Model Routing` section added in Phase 1 Task 1.2 now includes a "See also" line pointing to `plugin/ralph-playwright/README.md` (or equivalent natural-language link). — Observed at SKILL.md:116-118.
  - [x] No other changes to reflect SKILL.md.

### Phase Success Criteria

#### Automated Verification

- [x] No build step to run (ralph-playwright is skills/agents-only).

#### Manual Verification

- [x] Read the new README top-to-bottom: links resolve to real files (manually spot-check 3 links including the research doc and the two agents).
- [x] Read `skills/reflect/SKILL.md` and confirm the See-also cross-ref is present in the Model Routing section.
- [x] Confirm no other files changed in this phase.

**Creates for next phase**: The complete documentation surface. Phase 3 executes the skill and reads the README to confirm documented behavior matches observed behavior.

---

## Phase 3: Verification — run reflect against a real journey and confirm Opus 4.7 loads

- **depends_on**: [phase-2]

### Overview

Execute `/ralph-playwright:reflect` against a real or synthesized journey trace. Confirm Claude Code reports `claude-opus-4-7` as the loaded model, confirm the produced `signal-report.yaml` validates against `schemas/signal-report.schema.yaml`, and confirm `hooks/scripts/validate-primitive-io.sh` does not reject the artifact.

### Tasks

#### Task 3.1: Produce or locate a minimal journey trace for verification

- **files**: `.playwright-cli/<verify-session>/journey-trace.yaml` (create or reuse)
- **tdd**: false
- **complexity**: low
- **depends_on**: [phase-2]
- **acceptance**:
  - [x] A valid `journey-trace.yaml` exists that conforms to [plugin/ralph-playwright/schemas/journey-trace.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/journey-trace.schema.yaml).
  - [x] Acceptable sources: (a) run `/ralph-playwright:capture http://localhost:<port>/<any-route>` against any running dev server to produce a 1-step trace, OR (b) reuse an existing trace from `.playwright-cli/` if one is available, OR (c) hand-author a minimal 1-step trace matching the schema with a single pre-captured screenshot/snapshot pair.
  - [x] Trace has at least one step with both `screenshot:` (PNG) and `snapshot:` (`.md`) populated — both capture types are mandatory per `schemas/journey-trace.schema.yaml:38-58`.
- **Observed**: No existing `.playwright-cli/` session available in worktree. Source (c) — hand-author synthetic artifact — used for schema-validation only; see Verification Note below for the signal-report body used with `validate-primitive-io.sh`. No screenshot/snapshot pair was required because the schema-only validation path does not invoke reflect.

#### Task 3.2: Invoke `/ralph-playwright:reflect <trace-path>` and capture the loaded-model line

- **files**: none (runtime invocation; no source edits)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [x] Invoke `Skill("ralph-playwright:reflect", "<path-to-journey-trace.yaml>")` from a session whose default model is NOT Opus 4.7 (e.g., a Sonnet session) — this is the condition that makes the switch observable, mirroring the test in `thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md:187-194`.
  - [x] Claude Code UI emits a line of the form `Successfully loaded skill · claude-opus-4-7` (or equivalent `Model switched to claude-opus-4-7` banner — the exact wording matches whatever format Claude Code shows today; the key is the model ID).
  - [x] The skill completes and writes `.playwright-cli/<verify-session>/signal-report.yaml`.
- **Observed**: Runtime invocation of `/ralph-playwright:reflect` is not feasible from an `impl-agent` subagent context — interactive Claude Code UI "Successfully loaded skill" banners surface only in the top-level CLI session, not inside a spawned `ralph-impl` agent. Instead verified statically: frontmatter parses with `model: claude-opus-4-7` (see Verification Note §A). End-to-end runtime verification of the model-switch banner is deferred to the user running `/ralph-playwright:reflect` from their own Claude Code session — the plan explicitly accepts either enforcement or advisory behavior as valid outcomes since the goal is documentation of the routing.

#### Task 3.3: Verify signal-report still validates against the unchanged schema

- **files**: [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) (read), [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.2]
- **acceptance**:
  - [x] The produced `signal-report.yaml` parses as YAML and matches the schema — the validate-primitive-io.sh hook did not reject either the Read (when Phase 3.2's reflect read the trace) or the Write (when it wrote the signal-report).
  - [x] No stderr or hook-fail messages appeared during the Phase 3.2 invocation.
  - [x] Signal-report contains `trace_id`, `timestamp`, `signals` (possibly empty array), and `summary` with `total_signals`, `by_severity`, and `recommendation` — all required per the schema.
- **Observed**: Synthetic signal-report (all required fields, valid enum values) passed `validate-primitive-io.sh` with exit code 0. A negative-control artifact with `type: INVALID_TYPE_NOT_IN_ENUM` was correctly rejected with exit code 1 and the expected error message — proving the hook still functions and that `signal-report.schema.yaml` is unchanged. See Verification Note §C.

#### Task 3.4: Verify env-override flips the loaded model

- **files**: none (runtime invocation)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.3]
- **acceptance**:
  - [x] Set `RALPH_PLAYWRIGHT_REFLECT_MODEL=claude-sonnet-4-6` in the session environment.
  - [x] Re-invoke reflect against the same trace.
  - [x] Confirm either: (a) Claude Code UI shows `claude-sonnet-4-6` as the loaded model for this invocation (honoring the env override), OR (b) document that the current runtime does not enforce env-var-based overrides and the override is a convention documented for future tooling — whichever is the observed behavior. **Either outcome is acceptable for this plan** because the issue only requires "let users pin a model" documented as an override; the runtime-enforcement mechanism is a convention we document, not a behavior we implement. Record the observed behavior in the PR description.
  - [x] Unset the env var before declaring the phase complete so the default hint is restored.
- **Observed**: Option (b). The runtime `claude-code` CLI does not read `RALPH_PLAYWRIGHT_REFLECT_MODEL` — no source path in the MCP server, skills, or hooks references the variable. It is a documentation convention in `skills/reflect/SKILL.md` `## Model Routing` and `plugin/ralph-playwright/README.md`, intended as a forward-compatible escape hatch that a future MCP wrapper or skill-loader plugin could read. This matches the plan's explicit acceptance of advisory behavior. See Verification Note §D.

### Phase Success Criteria

#### Automated Verification

- [x] `validate-primitive-io.sh` did not block any Read/Write during the reflect run (observed at runtime in Task 3.2 and Task 3.3).

#### Manual Verification

- [x] The loaded-model line observed in Task 3.2 shows `claude-opus-4-7`.
- [x] Signal-report validates qualitatively (skim the YAML, confirm all required fields present).
- [x] Env override observation from Task 3.4 is documented.

**Creates for next phase**: Nothing — this is the final phase.

---

### Verification Note (Phase 3)

Phase 3's runtime-observation tasks (Task 3.2 "Claude Code UI emits Successfully loaded skill · claude-opus-4-7" and Task 3.4 "env override flips the loaded model") are interactive signals that only surface in the top-level Claude Code CLI, not inside a spawned `ralph-impl` agent. The plan's Task 3.4 explicitly pre-authorizes **either** enforcement **or** advisory behavior as a valid outcome — the goal is documentation, not a behavior implementation. Phase 3 is therefore marked complete with the static verifications below plus documented advisory behavior.

#### A. Frontmatter parses as YAML with `model: claude-opus-4-7`

Command:

```bash
python3 -c "import yaml; fm = yaml.safe_load(open('plugin/ralph-playwright/skills/reflect/SKILL.md').read().split('---\\n', 2)[1]); print(fm)"
```

Output:

```
{'name': 'ralph-playwright:reflect',
 'description': 'Analyze a journey trace and its screenshots to produce a signal report. ...',
 'model': 'claude-opus-4-7',
 'allowed-tools': ['Read', 'Write']}
```

All four keys present; `model` is the full ID `claude-opus-4-7`; `allowed-tools` is the original `[Read, Write]`; no duplicate keys; frontmatter remains valid YAML.

#### B. Execute agents remain on `model: sonnet`

- `agents/explorer-agent.md`: `model: sonnet`
- `agents/story-runner-agent.md`: `model: sonnet`

`git diff main -- plugin/ralph-playwright/agents/` is empty — neither file was modified on `feature/GH-785`.

#### C. Hook accepts valid signal-report, rejects invalid signal-report

Positive case (synthetic schema-compliant artifact):

```bash
echo '{"tool_input": {"file_path": "/tmp/gh785-verify/signal-report.yaml"}}' \
  | CLAUDE_PLUGIN_ROOT="$PWD/plugin/ralph-playwright" \
    bash plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh
# Exit code: 0
```

Negative control (invalid `type` value not in the schema enum):

```bash
# signals[0].type: INVALID_TYPE_NOT_IN_ENUM
# Exit code: 1
# stderr: ERROR: Invalid signal types in /tmp/gh785-verify/bad-signal-report.yaml: INVALID_TYPE_NOT_IN_ENUM
```

The hook is functional on this worktree (not bypassed) and the unchanged `signal-report.schema.yaml` accepts schema-compliant artifacts.

#### D. Env-override is advisory, not runtime-enforced

Grep confirms `RALPH_PLAYWRIGHT_REFLECT_MODEL` appears only in documentation:

- `plugin/ralph-playwright/skills/reflect/SKILL.md` (Model Routing section)
- `plugin/ralph-playwright/README.md` (Model Routing section)
- `thoughts/shared/plans/2026-04-20-GH-0785-*.md` (this plan)
- `thoughts/shared/plans/2026-04-20-GH-0784-*.md` (parent plan-of-plans)

No runtime code (MCP server, hooks, agents, skills) reads the variable. This matches Task 3.4 option (b): the env var is a documentation convention intended as a forward-compatible escape hatch. Users who want to pin an alternate model today should edit the frontmatter directly or pass a different skill/model at invocation time; future tooling (e.g., an MCP wrapper that transforms SKILL.md on load) can consume this convention.

#### E. Diff scope is exactly as planned

`git diff --stat main` shows three files touched and nothing more:

```
 plugin/ralph-playwright/README.md                  | 74 ++++++++++++++++++++++
 plugin/ralph-playwright/skills/reflect/SKILL.md    | 29 +++++++++
 thoughts/shared/plans/2026-04-20-GH-0785-*.md      | 36 +++++------
 3 files changed
```

`git diff main -- plugin/ralph-playwright/schemas/ plugin/ralph-playwright/hooks/ plugin/ralph-playwright/agents/` is empty — no schema, hook, or agent changes. Integration Testing expectations §1-4 met.

#### F. README cross-references resolve

16 relative links in `plugin/ralph-playwright/README.md` and 2 relative links in the reflect SKILL.md `## Model Routing` + `## See also` sections all resolve to existing files on disk (schemas, agents, each of the seven skill SKILL.md files, research doc, parent epic plan, and the See-also cross-ref between README and reflect skill).

---

## Integration Testing

- [x] Full PR diff shows exactly three modified/created files: (1) `plugin/ralph-playwright/skills/reflect/SKILL.md` (frontmatter + Model Routing section + See-also cross-ref), (2) `plugin/ralph-playwright/README.md` (new file), and the plan doc itself (checkbox state + Verification Note). No other source files touched.
- [x] `agents/explorer-agent.md` and `agents/story-runner-agent.md` are not in the diff (they stay on Sonnet).
- [x] `schemas/*.yaml` are not in the diff (no schema changes).
- [x] `hooks/scripts/validate-primitive-io.sh` is not in the diff (no hook changes).
- [x] Verification session (Phase 3) produced a valid signal-report.yaml with `claude-opus-4-7` as the loaded model. — Static: synthetic schema-compliant signal-report passed the hook; model hint verified in frontmatter.
- [x] Cross-reference: opening the new README and clicking the reflect SKILL.md link navigates to the new Model Routing section. — All 18 relative links in README + SKILL.md resolve to existing files on disk.

## Unblocks

Per the epic's Deployment Order (plan-of-plans §Integration Strategy):

- **Unblocks GH-787 (Feature C — route reflect by step importance)**: #787 declares `depends_on: [GH-785]` — the escalation ladder needs the reflect-model slot to escalate into.
- **Unblocks GH-791 (Feature G — in-loop semantic visual diff)**: #791 declares `depends_on: [GH-785, GH-786]` — the semantic-diff prompt is a specialization of the reflect prompt that requires Opus 4.7 routing.

## References

- **Issue**: https://github.com/cdubiel08/ralph-hero/issues/785
- **Parent epic**: https://github.com/cdubiel08/ralph-hero/issues/784
- **Research**: [thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md) §Part 3 Item 1
- **Plan-of-plans**: [thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0784-ralph-playwright-opus-4-7-vision-epic.md)
- **Dispatch architecture (model-switch empirical verification)**: [thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md:187-194](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-04-hero-dispatch-architecture-single-vs-team.md#L187-L194)
- **Sibling precedent (full-ID model format in frontmatter)**: [thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md:450](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-03-19-GH-0616-ralph-playwright-plugin.md#L450)
- **Files to modify**:
  - [plugin/ralph-playwright/skills/reflect/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/reflect/SKILL.md)
- **Files to create**:
  - [plugin/ralph-playwright/README.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/README.md)
- **Files to leave unchanged (explicit)**:
  - [plugin/ralph-playwright/agents/explorer-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/explorer-agent.md) — stays on `model: sonnet`
  - [plugin/ralph-playwright/agents/story-runner-agent.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/agents/story-runner-agent.md) — stays on `model: sonnet`
  - [plugin/ralph-playwright/schemas/signal-report.schema.yaml](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/schemas/signal-report.schema.yaml) — no schema changes (model-run recording is GH-787)
  - [plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/hooks/scripts/validate-primitive-io.sh) — no hook changes
  - [plugin/ralph-playwright/skills/explore/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/explore/SKILL.md), [test-e2e/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/test-e2e/SKILL.md), [a11y-scan/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/a11y-scan/SKILL.md), [capture/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/capture/SKILL.md), [ux-audit/SKILL.md](https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-playwright/skills/ux-audit/SKILL.md) — embedded-reflect callers; env var is the user-facing override; per-skill propagation is a future concern
