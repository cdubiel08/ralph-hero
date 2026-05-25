---
date: 2026-05-24
status: approved
type: plan
tags: [hooks, plan, research-gate, ralph-slim, estimate]
---

# Relax the plan-research-required gate — estimate-aware waiver + human override

## Prior Work

- `split-estimate-gate.sh` (`ralph/hooks/scripts/split-estimate-gate.sh`) is the canonical estimate-aware gate: `RALPH_MIN_ESTIMATE` → allowed-set via a `case` statement, `validate_state` helper, safe-default on missing estimate. This plan mirrors that shape, inverted (waive *below* a threshold instead of allow *at/above*).
- `set-skill-env.sh` (`ralph/hooks/scripts/set-skill-env.sh`) documents why bare `export` in a hook is throwaway and only `CLAUDE_ENV_FILE` writes (SessionStart only) survive — the reason this plan avoids any runtime mode-env propagation.

## Overview

`plan-research-required.sh` hard-blocks the Write of any plan doc whose filename carries a `GH-NNNN` token when no `thoughts/shared/research/*GH-NNNN*` file exists. The only escape is the global, undocumented `RALPH_REQUIRES_RESEARCH=false`. This contradicts the rest of the pipeline: triage explicitly offers `ROUTE-TO-Ready for Plan` ("well-specified; skip research and queue directly for planning"), and `--mode auto` is the **XS/S picker** — yet a Ready-for-Plan XS/S issue with no research gets bounced to **Human Needed** (auto) or blocked at the hook (interactive). A 1-line fix is forced to carry a research document.

This plan makes the gate *estimate-aware*: research is required only for issues at/above a configurable estimate threshold (default `M`), so XS/S work is waived. It also gives interactive planning a human-override path. The hook stays a pure content inspector — no GitHub call, no new persisted state, no runtime mode-env — and the waiver is auditable in the plan's own frontmatter.

Decisions locked with the user: **(A) estimate-threshold policy**, **slim `ralph/` plugin only**, **(ii) soften interactive / keep auto strict** (delivered via an explicit frontmatter stamp rather than a mode-env-dependent warn).

## Current State Analysis

The hook (`ralph/hooks/scripts/plan-research-required.sh`) and its `plugin/ralph-hero/` twin are byte-identical. Flow: allow if path not under `/plans/`; allow if `RALPH_REQUIRES_RESEARCH != true`; extract `GH-NNNN` from the path, allow if none; else require a matching research doc via `find_existing_artifact`, block if absent.

The hook is registered in `ralph/skills/plan/SKILL.md` frontmatter as `PreToolUse: Write`. SessionStart sets only `RALPH_COMMAND=plan` via `set-skill-env.sh`; the parsed `--mode` is **never** propagated to the hook environment.

### Key Discoveries

- The hook only sees `tool_input.file_path` and `tool_input.content` — it has no estimate, no workflow state, no labels. `tool_input.content` (the plan body, frontmatter included) is available at PreToolUse:Write. (`ralph/hooks/scripts/plan-research-required.sh:15-16`)
- Plan frontmatter does **not** currently carry `estimate` — only `date/status/type/tags/github_issue(s)/primary_issue`. (`ralph/skills/plan/plan-shapes.md:24-37`)
- `split-estimate-gate.sh` reads estimate from a `get_issue` *response* and computes an allowed-set from `RALPH_MIN_ESTIMATE` via a `case` statement + `validate_state`. (`ralph/hooks/scripts/split-estimate-gate.sh:36-47`)
- Triage already routes around research: `ROUTE-TO-Ready for Plan` = "skip research and queue directly for planning". (`ralph/skills/caretake/modes/triage.md:59-68`)
- `--mode auto` is the **XS/S picker** and today filters on `has-linked-research`, escalating to Human Needed when none exists. (`ralph/skills/plan/SKILL.md:146-159`; `ralph/skills/plan/intake-routing.md` § Linked-research check)
- `set-skill-env.sh` persists env via `CLAUDE_ENV_FILE` **only in a SessionStart context** — mid-body Bash cannot reliably write hook-visible env, so a literal "warn-in-interactive / block-in-auto" mode switch is fragile. (`ralph/hooks/scripts/set-skill-env.sh`)
- `plan-tier-validator.sh` blocks only when *both* epic and regular plan shapes appear; a regular `## Phase N:` plan is safe. (`ralph/hooks/scripts/plan-tier-validator.sh:30-37`)
- CI's `test-hooks` job globs only `plugin/ralph-hero/hooks/scripts/__tests__` — `ralph/hooks/scripts/__tests__` has **zero CI coverage** today. (`.github/workflows/ci.yml:135-150`)
- Slim hook tests are self-contained `*.test.sh` scripts (no bats). (`ralph/hooks/scripts/__tests__/`)

## Desired End State

1. `plan-research-required.sh` allows a plan Write when the plan frontmatter's `estimate:` is strictly below `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (default `M`), even with no research doc.
2. The hook allows a plan Write when frontmatter carries a non-empty `research_waived:` reason (human override).
3. Existing behavior is preserved as the safe default: research-doc-exists → allow; missing/unparseable estimate AND no waiver AND estimate ≥ threshold → block; `RALPH_REQUIRES_RESEARCH=false` → allow.
4. `--mode auto` (XS/S picker) no longer bounces research-less XS/S issues to Human Needed — it stamps `estimate:` and proceeds. M/L/XL paths (epic mode) are unchanged.
5. Interactive mode, on "plan anyway", stamps `research_waived:` so the human override is explicit and auditable.
6. `RALPH_REQUIRES_RESEARCH` and `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` are documented.
7. The new hook test runs in CI alongside the two existing slim hook tests.

### Verification

- New `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` passes for all branches (below-threshold allow, at/above-threshold block, waiver allow, research-exists allow, non-plans path allow, no-ticket allow, global-toggle allow, threshold override).
- `bash ralph/hooks/scripts/__tests__/plan-research-required.test.sh` exits 0.
- The `test-hooks` CI job discovers and runs the slim test (verify the `find` path includes `ralph/hooks/scripts/__tests__`).
- Manual: craft a plan-doc Write JSON with `estimate: S` and no research doc → hook exits 0; same with `estimate: M` → exits 2; add `research_waived: human-approved` to the `M` case → exits 0.

## What We're NOT Doing

- **Not** touching `plugin/ralph-hero/hooks/scripts/plan-research-required.sh` (slim-only scope; the copies diverge until the main plugin catches up — note this in the doc header comment).
- **Not** adding a GitHub/`gh` call inside the hook (keeps it fast and offline; estimate comes from the plan content the skill stamps).
- **Not** introducing a runtime mode-env (`RALPH_PLAN_MODE`/sentinel file) — the human-override stamp delivers (ii)'s intent without it.
- **Not** changing the workflow state machine or triage routing.
- **Not** changing epic-mode behavior (it already skips the linked-research check).

## Implementation Approach

Three phases, each independently testable. Phase 1 is the gate logic (self-contained, fully unit-testable). Phase 2 wires the skill to stamp the frontmatter fields the gate now reads. Phase 3 documents the knobs and closes the CI coverage gap. The trust boundary (an LLM could stamp a false `estimate`/`research_waived`) is accepted and mitigated by safe-default-to-block + visible audit trail, consistent with the rest of the hook system.

## Phase 1: Estimate-aware gate logic

### Overview

Rewrite `plan-research-required.sh` to add two allow-paths (estimate-threshold waiver, human-override waiver) parsed from the Write content's YAML frontmatter, keeping all existing early-allows and the terminal block.

### Changes Required

#### 1. Hook rewrite

**File**: `ralph/hooks/scripts/plan-research-required.sh`
**Changes**:
- Update the header comment: document `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (default `M`), the two new waiver paths, and a one-line note that this is the slim-only copy (intentionally ahead of the `plugin/ralph-hero/` twin).
- Keep the existing early-allows in order: non-`/plans/` path; `RALPH_REQUIRES_RESEARCH != true`; no `GH-NNNN` in path; research-doc-exists (`find_existing_artifact`).
- After those, before the terminal `block`, parse the frontmatter from `tool_input.content`:
  ```bash
  content=$(get_field '.tool_input.content')
  frontmatter=$(printf '%s\n' "$content" \
    | awk 'NR==1 && $0=="---"{f=1; next} f && $0=="---"{exit} f{print}')
  estimate=$(printf '%s\n' "$frontmatter" | grep -iE '^estimate:' | head -1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | tr -d '"'\''')
  waived_reason=$(printf '%s\n' "$frontmatter" | grep -iE '^research_waived:' | head -1 \
    | sed -E 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//')
  ```
- Human-override waiver:
  ```bash
  if [[ -n "$waived_reason" && "$waived_reason" != "null" ]]; then
    allow_with_context "Research requirement waived (human override): $waived_reason"
  fi
  ```
- Estimate-threshold waiver (waived set = estimates strictly below the threshold):
  ```bash
  min_estimate="${RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE:-M}"
  case "$min_estimate" in
    XS) waived="" ;;
    S)  waived="XS" ;;
    M)  waived="XS,S" ;;
    L)  waived="XS,S,M" ;;
    XL) waived="XS,S,M,L" ;;
    *)  waived="XS,S" ;;
  esac
  if [[ -n "$estimate" ]] && validate_state "$estimate" "$waived"; then
    allow_with_context "Research waived: estimate=$estimate below threshold $min_estimate"
  fi
  ```
- Augment the terminal `block` message to list the two new escape paths (set an estimate below `$min_estimate`, or add `research_waived:`) alongside the existing `/ralph:research` suggestion.

### Success Criteria

#### Automated Verification
- [x] `bash -n ralph/hooks/scripts/plan-research-required.sh` (syntax OK)
- [x] Hand-run with `{"tool_input":{"file_path":".../plans/2026-05-24-GH-1-x.md","content":"---\nestimate: S\n---"}}` on stdin exits 0
- [x] Same content with `estimate: M` exits 2
- [x] Same `estimate: M` content plus `research_waived: human-approved` exits 0
- [x] `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S` + `estimate: S` exits 2 (threshold raised)

#### Manual Verification
- [ ] Reading the block message, an operator understands all three ways forward (research, smaller estimate, explicit waiver)

## Phase 2: Plan authoring wiring

### Overview

Teach the plan skill to stamp `estimate:` (all modes) and `research_waived:` (interactive override) so the gate's new allow-paths actually trigger, and relax the auto-mode research filter for waived estimates.

### Changes Required

#### 1. Frontmatter spec

**File**: `ralph/skills/plan/plan-shapes.md`
**Changes**: Add to the frontmatter block two optional fields with usage notes:
- `estimate: XS|S|M|L|XL` — "copied from the linked issue; lets `plan-research-required.sh` waive the research requirement for sub-threshold work."
- `research_waived: <reason>` — "set only when a human explicitly approves planning without research (interactive 'plan anyway'). Auto mode never sets this."

#### 2. Intake / linked-research check

**File**: `ralph/skills/plan/intake-routing.md`
**Changes**: In § Linked-research check:
- Interactive branch: when the user chooses "plan anyway", instruct the skill to stamp `research_waived: human-approved — <one-line reason>` into the plan frontmatter.
- Auto branch: replace "no research doc → escalate to Human Needed" with "no research doc AND estimate ≥ `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` → escalate; otherwise stamp `estimate:` and proceed (the gate waives sub-threshold work)."

#### 3. Skill body

**File**: `ralph/skills/plan/SKILL.md`
**Changes**:
- Default + auto write steps: stamp `estimate:` into frontmatter from the fetched issue.
- `--mode auto` Step 2: drop the hard `has-linked-research` filter (XS/S no longer require research); keep XS/S scoping.
- `--mode auto` Step 3 escalation: gate the missing-research escalation on estimate ≥ threshold (a no-op for the XS/S picker today, but future-proofs against a raised threshold).

### Success Criteria

#### Automated Verification
- [x] `grep -n 'estimate:' ralph/skills/plan/plan-shapes.md` shows the new field documented
- [x] `grep -n 'research_waived' ralph/skills/plan/intake-routing.md ralph/skills/plan/plan-shapes.md` shows the override documented

#### Manual Verification
- [ ] Dry read of SKILL.md auto flow confirms an XS/S Ready-for-Plan issue with no research now proceeds to a plan write rather than escalating
- [ ] Interactive "plan anyway" path clearly results in a `research_waived:` stamp

## Phase 3: Docs, tests, and CI coverage

### Overview

Document the two env knobs, add a self-contained hook test, and wire the slim hook-test directory into CI so the test (and the two pre-existing slim tests) actually run.

### Changes Required

#### 1. Env documentation

**File**: `ralph/README.md` (and a one-line pointer in `ralph/CLAUDE.md` if an env table exists there)
**Changes**: Document `RALPH_REQUIRES_RESEARCH` (global off-switch, default `true`) and `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (research-required threshold, default `M`; estimates below it are waived).

#### 2. Hook test

**File**: `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` (new)
**Changes**: Self-contained `.test.sh` (mirror `triage-postcondition-palette.test.sh` structure) that invokes the hook with crafted JSON on stdin and asserts exit codes for: non-`/plans/` path (allow); no-ticket path (allow); research-doc-exists (allow — create a temp research file under a temp project root); `estimate: S` below default threshold (allow); `estimate: M` at threshold + no research (block); `research_waived:` present (allow); `RALPH_REQUIRES_RESEARCH=false` (allow); `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S` + `estimate: S` (block). Use a `TMPDIR` sandbox + `CLAUDE_PROJECT_DIR` override so `get_project_root`/`find_existing_artifact` resolve deterministically.

#### 3. CI coverage

**File**: `.github/workflows/ci.yml`
**Changes**: In the `test-hooks` job, extend the `find` to also traverse `ralph/hooks/scripts/__tests__` (either add the path to the existing `find` arg list or add a second `find` invocation with the same glob/sort/xargs pipeline).

### Success Criteria

#### Automated Verification
- [x] `bash ralph/hooks/scripts/__tests__/plan-research-required.test.sh` exits 0 with all assertions passing
- [x] `find ralph/hooks/scripts/__tests__ \( -name '*.test.sh' -o -name 'test-*.sh' \) -type f` lists the new test
- [x] CI `test-hooks` job (per the edited `ci.yml`) includes the slim path — verify by reading the diff / a local dry-run of the find pipeline

#### Manual Verification
- [ ] README env section reads clearly for a user deciding whether to lower the threshold or disable the gate

## Testing Strategy

### Unit Tests
- `plan-research-required.test.sh` exercises every hook branch via stdin JSON + exit-code assertions (Phase 3 #2). This is the primary safety net.

### Integration Tests
- None automated (the skill-side stamping is prose). Covered by manual dry-runs in Phase 2.

### Manual Testing Steps
1. In a scratch repo with the slim plugin, run `/ralph:plan` on an XS issue with no research doc → plan writes successfully (estimate waiver).
2. Run on an M issue with no research → blocked; choose "plan anyway" → `research_waived:` stamped → write succeeds.
3. `export RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE=S` and retry the XS case → still allowed; the S case → now blocked.

## Performance Considerations

The hook adds one `awk` + two `grep`/`sed` passes over the in-memory plan content — negligible, and strictly cheaper than the alternative (a `gh` call per plan write). No network, no disk state beyond the existing `find_existing_artifact` lookup.
