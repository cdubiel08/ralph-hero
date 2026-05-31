---
date: 2026-05-30
status: draft
type: plan
tags: [hero, workflows, spike, research, prototype]
github_issue: 1474
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1474
primary_issue: 1474
estimate: S
---

# GH-1474 — Spike: prototype a ralph verb as a Dynamic Workflow (flag-gated, throwaway)

## Prior Work

- builds_on:: [[2026-05-30-GH-1474-workflows-prototype-impl-depth]] (research — primary; corrected prototype target, exact insertion points, flag mechanics, token-cost methodology, the gating smoke-test)
- builds_on:: [[2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero]] (research — strategic muscle-vs-spine comparison)

## Overview

A spike to empirically validate whether Claude Code Dynamic Workflows can replace ralph's hand-rolled fan-out inside one verb, behind a default-off `RALPH_USE_WORKFLOWS` flag. Deliverable per the issue: a **throwaway** flag-gated prototype + a short recommendation writeup with a concrete token-cost number. Explicitly **no production wiring** — the flag defaults off so the prototype is dormant on merge.

The research corrected the target: `review --mode code`'s reviewers are external (the `code-review` plugin), so the genuine "reuse ralph's own agents unchanged" fit is **`research` Step 3** (parallel investigators). This plan front-loads a gating smoke-test because the entire approach rests on one unverified assumption — that `agent(prompt, {agentType: "<ralph-agent-name>"})` resolves ralph's `.md` agents unchanged. If that fails, the spike stops with that finding (still a valid spike outcome).

## Current State Analysis

`research` Step 3 (`ralph/skills/research/SKILL.md`) fans out `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `thoughts-analyzer` via parallel `Agent()` calls in a single message. These are ralph's own agents (`ralph/agents/*`), each exposing a `name:` frontmatter field (no `subagent_type:`). No `RALPH_USE_WORKFLOWS` flag or `Workflow()` usage exists anywhere in the repo (confirmed).

### Key Discoveries

- The 16 agents are `.md` files keyed by `name:` (e.g. `codebase-locator`) — the `agentType` candidate. Whether the `Workflow` `agent()` primitive resolves these unchanged is **unverified** (research §4, "the gating smoke test").
- Flag-read convention: `=== "true"` (mirrors `RALPH_HERO_AUTO`/`RALPH_DEBUG`, `mcp-server/src/index.ts` `resolveEnv()`); flags documented in the CLAUDE.md env table.
- The `Workflow` `budget` primitive exposes `budget.spent()` for the token-cost number.
- The literal word "workflow" triggers the feature — prefer a saved `.claude/workflows/<name>` script over the keyword path.
- A `Workflow()` must be dispatched from a depth-0 skill body (not from inside `Agent()`).

## Desired End State

1. A documented yes/no on whether ralph's agents work unchanged as `agentType` workers (Phase 1).
2. A throwaway, flag-gated (`RALPH_USE_WORKFLOWS`, default-off) Workflow prototype of `research` Step 3 (Phase 2) — only if Phase 1 passes.
3. A concrete token-cost delta (workflow `budget.spent()` vs. inline-dispatch baseline) on one representative issue, plus a whether/where-to-adopt recommendation appended to the implementation-depth research doc (Phase 3).
4. `RALPH_USE_WORKFLOWS` defaults off → no runtime behavior change on merge.

### Verification

- `grep -rn RALPH_USE_WORKFLOWS ralph/ CLAUDE.md` shows the flag declared + read with a default-off branch.
- The recommendation writeup contains a real token-cost number from an actual run (not an estimate).
- With the flag unset, `research` Step 3 behaves exactly as today (regression check).

## What We're NOT Doing

- **No production adoption** — the flag defaults off; this is a throwaway prototype, not a wiring change.
- **Not prototyping `review --mode code`** — its reviewers are the external `code-review` plugin; wrapping it means re-implementing prompts (out of scope, per research §1).
- **Not migrating the hero task-graph** to `pipeline()`/`parallel()` — larger follow-up, not this spike.
- **No multi-issue / autopilot-spanning workflows** — single-verb, single-issue scope only.
- **Not removing or altering the existing inline `Agent()` dispatch** — the flag branches around it; the off-path is untouched.

## Implementation Approach

Three sequential phases, each a hard gate on the next. Phase 1 is a cheap throwaway probe that de-risks the whole spike. Phase 2 builds the flag-gated prototype only if Phase 1 passes. Phase 3 measures and writes up. Because the prototype is flag-gated and default-off, the net diff is mergeable as a dormant experiment + a research-doc update.

## Phase 1: Gating smoke-test — does `agentType` resolve ralph agents unchanged?
depends_on: null

### Overview
A minimal throwaway Workflow that dispatches ONE ralph investigator agent via `agent(prompt, {agentType: "codebase-locator"})` and confirms it runs, requires no `SKILL.md`, and honors its `tools:` list. This is the load-bearing assumption for the entire spike.

### Changes Required
#### 1. Throwaway probe workflow
**File**: `.claude/workflows/gh1474-agenttype-probe.js` (create; throwaway)
**Changes**: A 1-agent workflow script: `const r = await agent("List where the ralph agents live.", {agentType: "codebase-locator"})` then `return r`. Run it; record whether the agentType resolved and the agent's tools worked.

### Success Criteria
#### Automated Verification
- [ ] The probe workflow runs without an "unknown agentType" / resolution error.
- [ ] The dispatched agent returns a non-empty result (proving it executed with its tools).

#### Manual Verification
- [ ] Confirm the agent ran with its declared `tools:` (e.g. it used Grep/Glob), not a stripped toolset.
- [ ] If the probe FAILS: stop the spike, append the negative finding to the research doc, and report "agentType reuse unsupported" (a valid spike outcome — do NOT proceed to Phase 2).

## Phase 2: Flag-gated Workflow prototype of `research` Step 3
depends_on: [phase-1]

### Overview
Author a saved workflow that fans out the `research` Step 3 investigators via `parallel(agent(..., {agentType}))`, wired into `research` behind `RALPH_USE_WORKFLOWS` (default-off). The off-path is the existing inline `Agent()` dispatch, untouched.

### Changes Required
#### 1. Saved workflow script
**File**: `.claude/workflows/research-investigators.js` (create)
**Changes**: `parallel()` over the investigator set, each via `agent(prompt, {agentType})`; return the synthesized findings. Avoids the `workflow` keyword by being a saved `/name` script.
#### 2. Flag branch in research
**File**: `ralph/skills/research/SKILL.md` (modify — Step 3)
**Changes**: Add a `RALPH_USE_WORKFLOWS=true` branch that dispatches the saved workflow instead of the inline `Agent()` block. Default-off → inline path unchanged.
#### 3. Flag documentation
**File**: `CLAUDE.md` (modify — Environment Variables table)
**Changes**: Add the `RALPH_USE_WORKFLOWS` row (default off; research-preview; gates Workflow dispatch).

### Success Criteria
#### Automated Verification
- [ ] `grep -n RALPH_USE_WORKFLOWS ralph/skills/research/SKILL.md CLAUDE.md` shows the branch + the doc row.
- [ ] With `RALPH_USE_WORKFLOWS` unset, `research` Step 3 prose still describes the inline `Agent()` dispatch (off-path regression check).

#### Manual Verification
- [ ] The saved workflow runs and returns investigator findings equivalent in shape to the inline path.

## Phase 3: Token-cost measurement + recommendation writeup
depends_on: [phase-2]

### Overview
Run the prototype and the inline baseline on one representative issue, capture the token-cost delta, and append a whether/where-to-adopt recommendation to the implementation-depth research doc.

### Changes Required
#### 1. Recommendation writeup
**File**: `thoughts/shared/research/2026-05-30-GH-1474-workflows-prototype-impl-depth.md` (modify — append `## Spike Results`)
**Changes**: Record `budget.spent()` (workflow path) vs. the inline baseline token usage on the same issue, plus a one-paragraph adopt/don't-adopt recommendation with the concrete number.

### Success Criteria
#### Automated Verification
- [ ] The doc's `## Spike Results` section contains a numeric token-cost figure from an actual run (grep for a digit-bearing "tokens" line).

#### Manual Verification
- [ ] The recommendation states adopt / don't-adopt / adopt-only-for-size-X with the measured cost as justification.

## Testing Strategy

### Unit Tests
None — this is a throwaway spike; no production code paths gain permanent test coverage. The flag's off-path is the existing, already-exercised inline dispatch.

### Integration Tests
The Phase-2 off-path regression check (flag unset → inline path unchanged) is the integration guard.

### Manual Testing Steps
1. Run the Phase-1 probe; confirm agentType resolution.
2. Run `research` with `RALPH_USE_WORKFLOWS=true` on a representative issue; confirm investigator findings return.
3. Run the same with the flag unset; confirm identical inline behavior.
4. Compare token cost; record the number.

## Migration Notes

No migration. `RALPH_USE_WORKFLOWS` defaults off, so merging changes no runtime behavior — the prototype is dormant until explicitly enabled. The throwaway probe (`.claude/workflows/gh1474-agenttype-probe.js`) should be deleted before merge or kept clearly marked throwaway. This is a `ralph/`-surface change (ralph plugin release), no mcp-server npm release. If Phase 1 fails, only the research doc is updated (negative finding) and no flag/prototype lands.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1474
- Research: `thoughts/shared/research/2026-05-30-GH-1474-workflows-prototype-impl-depth.md` (impl-depth), `2026-05-30-GH-1474-dynamic-workflows-vs-ralph-hero.md` (strategic)
- `ralph/skills/research/SKILL.md` Step 3 (prototype site), `ralph/agents/*` (agentType candidates), `mcp-server/src/index.ts` `resolveEnv()` (flag convention)
