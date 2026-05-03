---
date: 2026-05-03
status: draft
type: plan
github_issue: 975
github_issues: [975]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/975
primary_issue: 975
tags: [hello-skill, mcp-tools, directions, llm-synthesis, design-philosophy]
---

# Direction Signals + LLM-Synthesized Prose - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-02-hello-composable-rewrite]]
- builds_on:: [[2026-04-30-group-GH-0921-hello-directions-implementation]]
- tensions:: None identified — issue body explicitly calls out that the GH-938/941 implementation diverged from the spec it was built against; this plan restores the spec's intent.

## Overview

Single-issue atomic plan. One PR, three phases mapping to the three concerns in the bug:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-975 | Restructure `Direction` shape: add `signals`, deprecate `reason` | S |
| 2 | GH-975 | Rewrite `/hello` SKILL.md to synthesize prose from `signals` + title + memory | S |
| 3 | GH-975 | Test coverage: signal shape per branch, tied-at-score, fixture-based prose smoke | S |

**Why phased (single issue)**: Each phase is independently verifiable and respects a clear data-flow dependency: Phase 2 (skill rewrite) consumes the new shape produced in Phase 1; Phase 3 (tests) asserts both. Splitting them inside the same PR keeps review surfaces small and lets the implementer run vitest after Phase 1 before touching the skill.

## Shared Constraints

- **Determinism contract preserved.** `lib/directions.ts` remains side-effect-free. `signals` is computed entirely from the same inputs that produced `reason` today — no new wall-clock reads, no new randomness.
- **Backwards-compat window: one minor cycle.** The `reason` field is kept on `Direction` but marked `@deprecated` in JSDoc. It must continue to be derived from `signals` (so any holdout caller still gets a sentence). Removed in 2.7.0, mirroring the `hello_directions` deprecation pattern.
- **Both tools (`hello_directions` and `next_actions`) emit identical `Direction` shapes.** Both already route through `makeRunDirections` / `rankDirections`, so no fork is introduced — the new shape comes "for free" to both.
- **Headless orchestrators (`hero`, `team`) are unaffected.** They dispatch on `recommended: true` and ignore prose. Acceptance: no changes required to `skills/hero/SKILL.md` or any agent definition.
- **No ranking changes.** `score`, kind precedence, tree-continue promotion, blocked filtering, PR-vs-issue tiebreaks all unchanged. Only the *output shape* changes.
- **Picker label rule lives in the skill, not the tool.** The MCP tool returns structured fields; the skill composes the label string `"Plan #566 · Skill audit phase 2"` (≤30-char title fragment + ellipsis suffix).
- **No verbatim rendering of `reason` in the skill.** Per acceptance criterion: the LLM must synthesize per-direction prose from `signals + direction.issue.title + memory context`. The `reason` field exists only as a fallback for non-skill callers during the deprecation window.
- **Build/test commands** (from `plugin/ralph-hero/mcp-server/package.json`):
  - `npm run build` (tsc)
  - `npm test` (vitest run)
  - Single test: `npx vitest run src/__tests__/directions.test.ts`

## Current State Analysis

The bug has three independent failure modes that share one root cause: the ranker emits prose where it should emit structure.

**Root cause**: `lib/directions.ts:437-499` (`buildReason`) renders templates like `"Sitting in ${phase} for ${days} ${dayLabel} — small unblock if you have a moment"`. The skill at `skills/hello/SKILL.md:81` then renders `direction.reason` verbatim as the picker description. The LLM is a passthrough.

**Symptoms** (from issue body, 2026-05-03 14:25 UTC smoke test):
1. Three different P2 directions (#566 XL, #809 S, #813 S) all rendered the **same template** because they shared (priority=P2, tags=["stale"]) — only the day count varied.
2. The XL item (#566) got `"small unblock if you have a moment"` — the template directly contradicts the size field.
3. Picker label `"Plan #566"` carries no signal about *what* #566 is.
4. Tied scores (-28 across all three) mean rank-1 wins by implicit tiebreak (issue number); the user sees no transparency into why.

**What's already structured** in the response and just needs surfacing:
- `priority`, `estimate`, `workflowState`, `title` — already on `direction.issue`
- `tags` — already on `direction` (e.g., `["stale", "high-priority"]`)
- `score` — already on `direction`
- `kind` — already on `direction`

**What's computed but discarded** (only embedded in prose):
- `staleDays` — computed at `buildReason:475-476` (`Math.floor(hours / 24)`) but only used inside the sentence.
- `staleThresholdDays` — implicit in `config.stuckThresholdHours / 24` but never surfaced.
- `estimateWeight` — `audiencePenalty()` returns this number internally (`scoreIssue:320`) but it's folded into `score` and lost.
- `tiedAtScore` — never computed today; rank-1 wins ties silently via `merged.sort()` secondary keys.
- `parentChainNote` — `detectTreeContinue` knows the parent and sibling state but only emits the canned `"#NNN is part of an active tree — keep it moving before starting something new"`.

## Desired End State

### Verification

- [ ] `next_actions(limit=3)` returns three directions whose `signals` objects differ meaningfully even when `score`, `priority`, and `tags` are identical (e.g., the `staleDays` field differentiates them).
- [ ] `Direction.reason` is annotated `@deprecated` in source; runtime continues to populate it (derived from `signals`) for one minor cycle.
- [ ] When two directions tie at top score, all three top entries' `signals.tiedAtScore` field reflects the tie count (e.g., `tiedAtScore: 3`).
- [ ] `signals.estimateWeight` is non-zero only when `audience === "agent"` and the item has a non-XS/S estimate.
- [ ] `/hello` skill briefing for an XL item never contains the phrase `"small unblock"` — the LLM synthesizes from `estimate: "XL"` directly.
- [ ] Picker label for issue/PR kinds includes a title fragment: `"Plan #566 · Skill audit phase 2"`. Title truncated to ≤30 chars with `…` suffix when longer.
- [ ] All existing tests in `directions.test.ts` and `directions-tools.test.ts` continue to pass after the shape change (the `reason` regressions assert sentence shape, not structure — they remain valid).

## What We're NOT Doing

- **Memory-aware ranker boost.** Still deferred per the original spec. Memory only feeds the LLM's synthesis step in Phase 2; it does not influence `score` or `recommended`.
- **Score weighting changes.** This issue is about prose, not ranking. `score` numbers are unchanged.
- **Cross-repo or multi-project nuances in `signals`.** Single-project case ships first. `signals` shape leaves room (e.g., a future `repository?` field) but adds nothing now.
- **Removing `reason` field.** Stays through 2.6.x as `@deprecated`, derived. Removed in 2.7.0.
- **Removing `tags` field at the top level.** Even though `signals.tags` mirrors it, top-level `tags` stays for one cycle — it's used by existing tests and any holdout direct consumers. Marked `@deprecated` alongside `reason`.
- **Schema changes to the MCP tool inputs.** No new args on `next_actions` / `hello_directions`. The shape change is output-only.
- **Touching `pick_actionable_issue`.** Already deprecated; will be removed in 2.7.0 per existing plan.
- **Headless orchestrator changes.** `hero` and `team` skills don't read `reason` or render prose; no edits required.

## Implementation Approach

The phases mirror the natural data-flow seam:

**Phase 1** is purely lib-level (TypeScript types + scoring helpers). It introduces the `signals` object on `Direction`, derives `reason` from `signals` (so the field stays alive but moves from "source of truth" to "derived for compat"), and updates the two MCP tool registrations only insofar as their JSDoc references the new shape. Build + existing tests must pass before moving on.

**Phase 2** is purely skill-level (Markdown). It rewrites `skills/hello/SKILL.md` to (a) drop the verbatim `reason` rendering, (b) introduce an LLM synthesis step that consumes `signals + direction.issue.title + memory`, and (c) extend the picker label rule to include a title fragment. No source code touched.

**Phase 3** adds tests. New cases in `directions.test.ts` assert the `signals` shape per ranker branch (issue / lock-stale / tree-continue / pr) and a tied-at-score scenario. New case in `directions-tools.test.ts` asserts `signals` is on the wire. A new fixture-driven smoke test for `/hello` (placed under `plugin/ralph-hero/skills/hello/__tests__/` if a pattern exists, otherwise documented as a manual smoke checklist) confirms the synthesized prose mentions the title and varies between similarly-scored directions.

---

## Phase 1: Restructure `Direction` shape — add `signals`, deprecate `reason`/`tags`
- **depends_on**: null

### Overview

Introduce `signals: DirectionSignals` on `Direction`. Compute the structured fields where the prose templates currently compute them. Keep `reason` and top-level `tags` as `@deprecated` derived fields for one minor cycle. No ranking math changes.

### Tasks

#### Task 1.1: Add `DirectionSignals` interface and extend `Direction`
- **files**: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (modify)
- **tdd**: false (type-only change, but consumed by Task 1.2)
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New exported `interface DirectionSignals` at the top of the public types section (near `Direction`) with these fields:
    ```ts
    export interface DirectionSignals {
      tags: string[];                      // mirrors top-level tags during deprecation
      staleDays?: number;                  // for kind="issue" with stale tag, or kind="lock-stale"
      staleThresholdDays?: number;         // config.stuckThresholdHours / 24 (or lockStaleHours/24 for lock-stale)
      tiedAtScore?: number;                // count of directions sharing the top score (only set when > 1)
      estimateWeight?: number;             // audiencePenalty contribution; omitted when 0
      parentChainNote?: string;            // for kind="tree-continue": "sibling #NNN closed 2 days ago" or "candidate moved 1 day ago, N open siblings"
      prAgeDays?: number;                  // for kind="pr"
      prReviewDecision?: string | null;    // for kind="pr"; mirrors direction.pr.reviewDecision
      linkedIssueNumber?: number;          // for kind="pr" when parsed from headRef
    }
    ```
  - [ ] `Direction` interface gets a new `signals: DirectionSignals` field (required, always present).
  - [ ] `Direction.reason` annotated with `/** @deprecated Derived from signals. Removed in 2.7.0. Skills should synthesize prose from signals + title + memory. */`.
  - [ ] `Direction.tags` annotated with `/** @deprecated Use signals.tags. Removed in 2.7.0. */`.
  - [ ] `npm run build` passes with no TypeScript errors.

#### Task 1.2: Compute `signals` in `scoreIssue` / `scorePR` and thread through `rankDirections`
- **files**: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `scoreIssue` returns `{ score, kind, tags, signals }` instead of `{ score, kind, tags }`. The new `signals` carries: `tags` (mirror), `staleDays` (when stale tag present, computed via `Math.max(1, Math.floor(ageHours(item.updatedAt, config.now) / 24))`), `staleThresholdDays` (`config.stuckThresholdHours / 24` for non-lock; `config.lockStaleHours / 24` for lock-stale), `estimateWeight` (the `audiencePenalty(item, config.audience)` value, omitted when 0), `parentChainNote` (for `kind === "tree-continue"`: a structured short note like `"sibling #${closedSiblingNumber} closed ${days} days ago"` if rule (a) fired, else `"candidate moved ${days} days ago; ${openCount} open siblings"`).
  - [ ] `scorePR` returns a `signals` object on the `PRScored` type carrying: `tags`, `prAgeDays` (`Math.max(1, Math.floor(pr.ageHours / 24))`), `prReviewDecision`, `linkedIssueNumber` (when present).
  - [ ] `rankDirections` computes `tiedAtScore` after the merged-sort step: count entries sharing `merged[0].score`. Set `signals.tiedAtScore = N` on each of the tied entries when `N > 1`; omit otherwise.
  - [ ] Existing `score` math is byte-identical (assert via the determinism test on line 537-562 of `directions.test.ts`).

#### Task 1.3: Derive `reason` from `signals` (compat shim)
- **files**: `plugin/ralph-hero/mcp-server/src/lib/directions.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `buildReason` signature changes: it now accepts `signals: DirectionSignals` plus the existing `kind`, `issue`, `pr`, `linkedIssueNumber`, `config` args (drops the standalone `tags` arg — uses `signals.tags`).
  - [ ] `buildReason` produces byte-identical output to the pre-change implementation for every input combination tested in the existing `buildReason` test block at `directions.test.ts:694-726`.
  - [ ] All call sites in `rankDirections` (lines 640, 654) pass `signals` instead of `tags`.
  - [ ] The function-level JSDoc above `buildReason` is updated to note: `@deprecated Reason strings are derived from signals for back-compat. Skills should synthesize prose from signals directly.`

#### Task 1.4: Update tool registration JSDoc + response schema description
- **files**: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [ ] The `ralph_hero__next_actions` tool description string (line 281) mentions: `"Each direction includes a structured signals object (staleDays, staleThresholdDays, tiedAtScore, estimateWeight, parentChainNote) for skills to synthesize prose. The legacy 'reason' string is @deprecated and removed in 2.7.0."`
  - [ ] The `ralph_hero__hello_directions` tool description (line 215) carries the same note (it's already `@deprecated` itself, so the change is informational only).
  - [ ] No changes to the tool's input schema.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` (in `plugin/ralph-hero/mcp-server/`) — no errors
- [ ] `npm test` — all existing tests pass (the determinism test, buildReason smoke checks, and integration tests must remain green)
- [ ] `npx vitest run src/__tests__/directions.test.ts` — focused run, all passing

#### Manual Verification:
- [ ] `git diff plugin/ralph-hero/mcp-server/src/lib/directions.ts` shows: new `DirectionSignals` interface, extended `Direction`, `signals` computed in `scoreIssue`/`scorePR`, `tiedAtScore` post-sort pass, `buildReason` reading from `signals`. No changes to scoring constants (STALE_BOOST, LOCK_STALE_BOOST, etc.) or to the merged-sort ordering rules.

**Creates for next phase**: `Direction.signals` field on the wire, populated for every kind. Phase 2 reads from this in the skill prompt.

---

## Phase 2: Rewrite `/hello` SKILL.md to synthesize prose from signals + title + memory
- **depends_on**: [phase-1]

### Overview

Replace verbatim `direction.reason` rendering with an LLM synthesis step that consumes `signals + direction.issue.title (or direction.pr.title) + MEMORY.md context`. Extend the picker label rule to include a ≤30-char title fragment with ellipsis suffix.

### Tasks

#### Task 2.1: Rewrite Step 3 (Render briefing) to synthesize prose from signals
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false (skill prose; verified by Phase 3 fixture smoke test)
- **complexity**: medium
- **depends_on**: null (within phase)
- **acceptance**:
  - [ ] The "Step 3: Render briefing" section is rewritten to instruct the LLM to compose per-direction prose from `direction.signals + direction.issue.title (or direction.pr.title) + memory context (catch-up output and MEMORY.md)`. The instructions explicitly forbid quoting `direction.reason` verbatim.
  - [ ] Per-kind synthesis guidance is included as a table or bullet list. Minimum coverage:
    - `kind: "issue"` + `signals.staleDays` set: prose mentions days stale AND the title (e.g., "skill audit phase 2 has been sitting in Ready for Plan for 7 days").
    - `kind: "issue"` + `signals.estimateWeight` indicates a large estimate (item's `estimate` is `M`/`L`/`XL`): prose reflects size honestly ("a large block of work" / "non-trivial"). Never say "small unblock" for an XL.
    - `kind: "issue"` + `signals.tiedAtScore > 1`: prose surfaces tiebreak transparency, e.g., "tied with N others at the top score; rank-1 by issue number".
    - `kind: "lock-stale"`: prose describes the lock state and `staleDays`, references the title.
    - `kind: "tree-continue"`: prose incorporates `signals.parentChainNote` plus the title.
    - `kind: "pr"`: prose mentions `pr.title`, `signals.prAgeDays`, and `signals.linkedIssueNumber` if set.
  - [ ] The "Right now the recommended direction is …" sentence (currently line 53-54) is rewritten to use the synthesized prose, NOT the rephrased `reason`.

#### Task 2.2: Extend picker label rule with title fragment
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The "Per-option label rules" block (currently lines 73-79) is replaced by rules that produce labels of the form `"<verb> #<NNN> · <title fragment>"` where the title fragment is `direction.issue.title` (or `direction.pr.title`) truncated to ≤30 characters with `…` suffix when truncation occurred. Update each row:
    - `kind: "issue"` + `workflowState: "Plan in Review"` → `"Review plan #NNN · <fragment>"`
    - `kind: "issue"` + `workflowState: "Ready for Plan"` → `"Plan #NNN · <fragment>"`
    - `kind: "issue"` + `workflowState: "Research Needed"` → `"Research #NNN · <fragment>"`
    - `kind: "issue"` + `workflowState: "In Review"` → `"Review #NNN · <fragment>"`
    - `kind: "pr"` → `"Merge PR #NNN · <fragment>"`
    - `kind: "tree-continue"` → `"Continue tree #NNN · <fragment>"`
    - `kind: "lock-stale"` → `"Unstick #NNN · <fragment>"`
  - [ ] The truncation rule explicitly states: ≤30 chars, drop trailing whitespace before adding `…`, do not break mid-word if a clean word boundary is available within the last 5 chars.
  - [ ] The "Description" line (currently line 81) is changed from `"direction.reason verbatim"` to `"the synthesized prose from Step 3 for this direction"`.

#### Task 2.3: Update Constraints / dispatch table for clarity
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1, 2.2]
- **acceptance**:
  - [ ] The "Constraints" section (lines 109-116) gains one new bullet: `"Never render direction.reason verbatim — it exists only for back-compat and is @deprecated. Always synthesize prose from signals + title + memory."`
  - [ ] No other behavioral changes to the dispatch table (Step 5) — kind/state mapping is unchanged.

### Phase Success Criteria

#### Automated Verification:
- [ ] No code changes in this phase, so build/test stays green from Phase 1's run. Confirm by re-running `npm test` in `plugin/ralph-hero/mcp-server/` — all green.

#### Manual Verification:
- [ ] Read `skills/hello/SKILL.md` end-to-end. Confirm the LLM is given enough structured input (signals fields by kind) to write differentiated prose without guessing.
- [ ] Confirm picker labels would render as `"Plan #566 · Skill audit phase 2"` for the live-smoke-test issue (title `"Skill audit phase 2 — deep individual audits for remaining skills"` truncates to `"Skill audit phase 2 — deep…"` at 30 chars).
- [ ] Confirm there is no remaining mention of `direction.reason` as a *render source* anywhere in the skill — only as a back-compat note.

**Creates for next phase**: A skill that consumes `signals` and is testable via fixture. Phase 3 supplies the fixture.

---

## Phase 3: Test coverage — signal shape, tied-at-score, fixture-driven prose smoke
- **depends_on**: [phase-1, phase-2]

### Overview

Add unit tests asserting the new `signals` shape per ranker branch, a tied-at-score scenario, and a fixture-driven smoke test for the skill's synthesis behavior.

### Tasks

#### Task 3.1: Extend `directions.test.ts` with signals shape assertions per ranker branch
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null (within phase)
- **acceptance**:
  - [ ] New `describe("Direction signals shape", ...)` block with at least these tests:
    1. `kind: "issue"` with stale tag → `signals.staleDays` is a positive integer; `signals.staleThresholdDays === 2` (48h / 24); `signals.tags` mirrors top-level `tags`.
    2. `kind: "issue"` non-stale → `signals.staleDays` is `undefined`; `signals.staleThresholdDays` is still set (informational).
    3. `kind: "lock-stale"` → `signals.staleDays` is set; `signals.staleThresholdDays === 1` (24h / 24).
    4. `kind: "tree-continue"` (sibling-closed branch) → `signals.parentChainNote` matches `/sibling #\d+ closed \d+ days? ago/`.
    5. `kind: "tree-continue"` (candidate-moved branch) → `signals.parentChainNote` matches `/candidate moved.*\d+ open sibling/`.
    6. `kind: "pr"` REVIEW_REQUIRED with `headRefName: "feature/GH-42"` → `signals.prAgeDays`, `signals.prReviewDecision === "REVIEW_REQUIRED"`, `signals.linkedIssueNumber === 42`.
    7. `audience: "agent"` with an XL item → `signals.estimateWeight === 60`.
    8. `audience: "human"` with an XL item → `signals.estimateWeight` is `undefined` (or not present in serialized JSON).
  - [ ] All new tests use the existing `makeConfig` / `makeItem` / `makePR` factories.

#### Task 3.2: Add tied-at-score test
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts` (modify)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] New test in a `describe("rankDirections — tied-at-score", ...)` block:
    - Construct three issues that produce identical scores (e.g., three P2 stale Ready-for-Plan items with the same `updatedAt`).
    - Assert: `result[0].signals.tiedAtScore === 3`, `result[1].signals.tiedAtScore === 3`, `result[2].signals.tiedAtScore === 3`.
    - Assert: ranks 1, 2, 3 are stable by issue number (matching the existing secondary sort).
  - [ ] A counter-test: when no two top entries share a score, `signals.tiedAtScore` is `undefined` on rank-1.

#### Task 3.3: Update integration tests for `signals` on the wire
- **files**: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts` (modify)
- **tdd**: true
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] The end-to-end happy-path test (currently lines 286-374) gains one new assertion block: for each direction in the response, `expect(typeof dir.signals).toBe("object")` and `expect(Array.isArray(dir.signals.tags)).toBe(true)`.
  - [ ] One new test verifies the `next_actions` response retains the `reason` field (back-compat) AND populates `signals` simultaneously: `expect(typeof dir.reason).toBe("string"); expect(typeof dir.signals).toBe("object");`.

#### Task 3.4: Fixture-driven smoke test for `/hello` synthesis (or manual checklist if no harness exists)
- **files**: `plugin/ralph-hero/skills/hello/__tests__/synthesis.smoke.md` (create) OR a deferred-decision note in the plan if no harness fits
- **tdd**: false (smoke check, not unit)
- **complexity**: low
- **depends_on**: [3.1, 3.2]
- **acceptance**:
  - [ ] If a behavioral-fixture harness for skills exists (search `plugin/ralph-hero/skills/*/__tests__/`): add a fixture file under `skills/hello/__tests__/` containing two synthetic `next_actions` responses — (A) two similarly-scored stale P2 directions with different titles and `staleDays`; (B) one XL stale P2 direction. Document expected synthesis behavior: (A) prose mentions both titles AND varies meaningfully; (B) prose never contains the substring `"small unblock"` and reflects the XL size.
  - [ ] If no harness exists: create `skills/hello/__tests__/synthesis.smoke.md` as a manual smoke checklist documenting the same two fixtures and expected behaviors. Include the JSON of both fixtures inline so a reviewer can paste them into a `claude -p "/hello"` test. Note in the file header: "Manual smoke check until skill-test harness lands; convert to fixture when available."

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm test` (in `plugin/ralph-hero/mcp-server/`) — all tests pass, including the 8+ new `signals` shape assertions, the tied-at-score test, and the integration `signals` check.
- [ ] `npx vitest run src/__tests__/directions.test.ts -t "signals"` — focused run on new tests, all green.
- [ ] `npx vitest run src/__tests__/directions-tools.test.ts -t "signals"` — focused integration run, green.

#### Manual Verification:
- [ ] Run the smoke fixture (or the documented manual checklist) for `/hello` — confirm synthesized prose mentions the title for at least 2 of the 3 directions and varies meaningfully across the two similarly-scored items.
- [ ] Confirm an XL item's prose never contains the literal `"small unblock"` substring.

---

## Integration Testing

- [ ] **Live `next_actions` smoke** (manual, post-merge): On a daily-driver project, run `/hello` and confirm: picker labels include title fragments; prose for any stale items differs across directions even when score and tags match; XL items get size-appropriate language.
- [ ] **Determinism regression**: The existing test at `directions.test.ts:537-562` continues to pass — two calls with the same input produce byte-identical output (now including `signals`).
- [ ] **Back-compat for `hello_directions` callers**: The deprecated tool still returns `reason` (derived) and `tags` (top-level mirror) so any non-skill caller in the wild keeps working through 2.6.x.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/975
- Spec (design philosophy): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-05-02-hello-composable-rewrite.md
- Predecessor plan (GH-918 group, shipped 2026-04-30): https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-30-group-GH-0921-hello-directions-implementation.md
- Predecessor issues: #938 (next_actions tool), #941 (/hello rewrite), parent epic #936
- Source files:
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/lib/directions.ts
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hello/SKILL.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/directions.test.ts
  - https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts
