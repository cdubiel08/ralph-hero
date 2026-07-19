---
date: 2026-05-30
status: complete
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

The research corrected the target: `review --mode code`'s reviewers are external (the `code-review` plugin), so the genuine "reuse ralph's own agents unchanged" fit is **`research` Step 3** (parallel investigators). This plan front-loads a gating smoke-test of the `agentType` reuse assumption. If that fails, the spike stops with that finding (still a valid spike outcome).

## Plan Update (2026-07-19 walkthrough)

A pre-build walkthrough cross-checked this plan against the **current** Workflow tool schema (the 2026-05-30 research predates it by 7 weeks). Corrections applied inline below; summary:

1. **agentType is now documented, and names are plugin-prefixed.** The current schema states `agentType` is "resolved from the same registry as the Agent tool", and that registry lists ralph's agents as `ralph:<name>` (e.g. `ralph:codebase-locator`), consistent with ralph's own `subagent_type="ralph:plan-agent"` dispatches. The Phase 1 probe string is corrected accordingly — bare `"codebase-locator"` would false-negative the spike. The probe survives as cheap confirmation (tools honored, MCP reachable via ToolSearch), no longer a coin flip.
2. **The keyword-collision caveat is obsolete.** The trigger keyword changed from "workflow" to `ultracode`; prose containing "workflow" triggers nothing. Sanctioned opt-in paths now include *"a skill or slash command whose instructions tell Claude to call Workflow"* and *"running a named/saved workflow"* — so the flag-gated skill branch is itself legitimate opt-in (this dissolves the escalation blocker recorded on #1474). The saved-file choice is kept for new reasons: versioned/reviewable artifact + named-workflow opt-in path.
3. **New authoring constraints:** scripts must open with a pure-literal `export const meta = {...}`; plain JS only; `Date.now()` / `Math.random()` / argless `new Date()` throw (resume safety) — pass timestamps via `args`.
4. **Blocking semantics:** `Workflow()` returns immediately (background task); the skill branch must wait for the completion notification before Step 4 synthesis, unlike blocking inline `Agent()` calls.
5. **Token-cost methodology upgraded (Phase 3):** `budget.spent()` counts output tokens in a shared main-loop+workflows pool — not workflow-only, and output-only. Headline metric is now **claude-trace-lab OTLP traces** (both paths run on the same issue; full input+output+cache totals from captured spans); `budget.spent()` demoted to secondary sanity check.

## Current State Analysis

`research` Step 3 (`ralph/skills/research/SKILL.md`) fans out `codebase-locator`, `codebase-analyzer`, `codebase-pattern-finder`, `thoughts-locator`, `thoughts-analyzer` via parallel `Agent()` calls in a single message. These are ralph's own agents (`ralph/agents/*`), each exposing a `name:` frontmatter field (no `subagent_type:`). No `RALPH_USE_WORKFLOWS` flag or `Workflow()` usage exists anywhere in the repo (confirmed).

### Key Discoveries

- The 16 agents are `.md` files keyed by `name:` (e.g. `codebase-locator`); in the harness agent registry they surface plugin-prefixed as `ralph:<name>` — the `agentType` value. The current Workflow schema documents `agentType` as resolved from the same registry as the `Agent` tool; the smoke test confirms tools/MCP behavior empirically (research §4).
- Flag-read convention: `=== "true"` (mirrors `RALPH_HERO_AUTO`/`RALPH_DEBUG`, `mcp-server/src/index.ts` `resolveEnv()`); flags documented in the CLAUDE.md env table.
- The `Workflow` `budget` primitive exposes `budget.spent()` — output tokens only, shared main-loop+workflows pool (secondary sanity metric; see Phase 3).
- Keyword collision obsolete (trigger is now `ultracode`); saved `.claude/workflows/<name>` script kept as a versioned artifact + named-workflow opt-in path.
- A `Workflow()` must be dispatched from a depth-0 skill body (not from inside `Agent()`), and returns a background task — the dispatch site waits for the completion notification before synthesizing.

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
A minimal throwaway Workflow that dispatches ONE ralph investigator agent via `agent(prompt, {agentType: "ralph:codebase-locator"})` (plugin-prefixed — the registry name; bare `"codebase-locator"` is expected to fail resolution) and confirms it runs, requires no `SKILL.md`, and honors its `tools:` list. This is the load-bearing assumption for the entire spike.

### Changes Required
#### 1. Throwaway probe workflow
**File**: `.claude/workflows/gh1474-agenttype-probe.js` (create; throwaway)
**Changes**: A 1-agent workflow script opening with the required pure-literal `export const meta = {...}` block: `const r = await agent("List where the ralph agents live.", {agentType: "ralph:codebase-locator"})` then `return r`. Plain JS; no `Date.now()`/`Math.random()`. Run it; record whether the agentType resolved and the agent's tools worked.

### Success Criteria
#### Automated Verification
- [x] The probe workflow runs without an "unknown agentType" / resolution error (prefixed `ralph:codebase-locator`; bare name fails — documented).
- [x] The dispatched agent returns a non-empty result (proving it executed with its tools).

#### Manual Verification
- [x] Confirm the agent ran with its declared `tools:` — FINDING: `tools:` is NOT honored (Bash-centric worker set; Grep/Glob unavailable, MCP tools reachable). Functionally sufficient for investigators; see Spike Results.
- [ ] If the probe FAILS: stop the spike, append the negative finding to the research doc, and report "agentType reuse unsupported" (a valid spike outcome — do NOT proceed to Phase 2).

## Phase 2: Flag-gated Workflow prototype of `research` Step 3
depends_on: [phase-1]

### Overview
Author a saved workflow that fans out the `research` Step 3 investigators via `parallel(agent(..., {agentType}))`, wired into `research` behind `RALPH_USE_WORKFLOWS` (default-off). The off-path is the existing inline `Agent()` dispatch, untouched.

### Changes Required
#### 1. Saved workflow script
**File**: `.claude/workflows/research-investigators.js` (create)
**Changes**: `parallel()` over the investigator set, each via `agent(prompt, {agentType: "ralph:<name>"})`; return the synthesized findings. Opens with the required `export const meta = {...}` literal; research question + repo dirs passed via `args`. Saved-file form = versioned artifact + named-workflow opt-in path (keyword-collision rationale obsolete).
#### 2. Flag branch in research
**File**: `ralph/skills/research/SKILL.md` (modify — Step 3)
**Changes**: Add a `RALPH_USE_WORKFLOWS=true` branch that dispatches the saved workflow instead of the inline `Agent()` block, then **waits for the workflow's background-task completion notification** before proceeding to Step 4 synthesis. Default-off → inline path unchanged.
#### 3. Flag documentation
**File**: `CLAUDE.md` (modify — Environment Variables table)
**Changes**: Add the `RALPH_USE_WORKFLOWS` row (default off; research-preview; gates Workflow dispatch).

### Success Criteria
#### Automated Verification
- [x] `grep -n RALPH_USE_WORKFLOWS ralph/skills/research/SKILL.md CLAUDE.md` shows the branch + the doc row.
- [x] With `RALPH_USE_WORKFLOWS` unset, `research` Step 3 prose still describes the inline `Agent()` dispatch (off-path regression check).

#### Manual Verification
- [x] The saved workflow runs and returns investigator findings equivalent in shape to the inline path (5/5 agents, quality parity verified on the measurement question).

## Phase 3: Token-cost measurement + recommendation writeup
depends_on: [phase-2]

### Overview
Run the prototype and the inline baseline on one representative issue, capture the token-cost delta, and append a whether/where-to-adopt recommendation to the implementation-depth research doc.

**Measurement instrument (updated 2026-07-19):** headline numbers come from **claude-trace-lab OTLP spans** (`~/.claude-traces/spans.jsonl` — every Claude Code session is captured with full token usage: input + output + cache). Run both paths against the same research question and compare span-derived per-run totals. `budget.spent()` is recorded as a secondary in-run sanity figure only — it counts output tokens in a pool shared between the main loop and all workflows, so it is neither workflow-only nor total-cost.

### Changes Required
#### 1. Recommendation writeup
**File**: `thoughts/shared/research/2026-05-30-GH-1474-workflows-prototype-impl-depth.md` (modify — append `## Spike Results`)
**Changes**: Record trace-derived token totals for the workflow path vs. the inline baseline on the same issue (plus `budget.spent()` as the secondary figure), and a one-paragraph adopt/don't-adopt recommendation with the concrete numbers.

### Success Criteria
#### Automated Verification
- [x] The doc's `## Spike Results` section contains a numeric token-cost figure from an actual run (2,617,423 vs 2,403,980 total; +8.9%).

#### Manual Verification
- [x] The recommendation states adopt / don't-adopt / adopt-only-for-size-X with the measured cost as justification (ADOPT, scoped to within-verb read-only fan-out).

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
