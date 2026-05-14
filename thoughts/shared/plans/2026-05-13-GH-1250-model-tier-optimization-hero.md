---
date: 2026-05-13
status: draft
type: plan
tags: [hero, model-tiering, token-efficiency, plan-dedup, impl-agent]
github_issue: 1250
github_issues: [1250]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1250
primary_issue: 1250
---

# Hero Workflow Model-Tier Optimization Plan

## Overview

The `ralph-hero:hero` pipeline currently spends Opus on 5 hot-path agents (split, plan, plan-epic, review, impl) regardless of task complexity. The landcrawler-ai corpus (last 30 days) shows two structural sources of token churn beyond model choice: (1) atomic children of a plan-of-plans each get their own full plan file restating parent constraints, and (2) every impl-agent dispatch is Opus even for mechanical phases with fully-specified plans. This plan introduces a complexity-driven tier policy modeled on superpowers' SDD philosophy, downgrades the safe agents, adds a BLOCKED → escalate-to-Opus path so we never silently underperform, and short-circuits the plan-creation step for atomic children whose parent plan already covers the phase.

## Current State Analysis

### Hero pipeline today (model assignments)

```
Phase            Agent                  Model    Sub-agents (model)
─────────────────────────────────────────────────────────────────────
SPLIT            split-agent            opus     —
RESEARCH         research-agent         sonnet   locator(haiku), analyzer(sonnet),
                                                 pattern-finder(haiku), thoughts-locator(haiku),
                                                 thoughts-analyzer(sonnet), web-search(sonnet)
PLAN (M/S/XS)    plan-agent             opus     —
PLAN (L/XL)      plan-epic-agent        opus     —
PLAN REVIEW      review-agent           opus     —
IMPLEMENT        impl-agent             opus     (internal: low→haiku, med→sonnet, high→opus
                                                  already implemented in ralph-impl/SKILL.md:298)
PR               pr-agent               haiku    —
FINISH           finish-agent           sonnet   val-agent (haiku), code-review fan-out,
                                                 impl-agent address mode (opus), merge-agent (haiku)
```

### Verified mechanics (file:line)

- **Runtime model override works today**: `Agent(subagent_type=..., model="sonnet", prompt=...)` is already used at `plugin/ralph-hero/skills/ralph-impl/SKILL.md:298,311,324`. No SDK or hook plumbing required to add it elsewhere.
- **`## Plan Reference` consumption is fully wired end-to-end**:
  - Impl-side reader at `plugin/ralph-hero/skills/ralph-impl/SKILL.md:112-125` extracts phase anchor, reads parent plan section, sets `RALPH_PLAN_REFERENCE`.
  - Hook gate at `plugin/ralph-hero/hooks/scripts/impl-plan-required.sh:59-67` already accepts `RALPH_PLAN_REFERENCE` as a valid plan source.
  - The full child-without-own-plan-file path is operational today — what's missing is hero/plan ever choosing to take it.
- **Pipeline-detection is state-count-based, parent-plan-blind**: `plugin/ralph-hero/mcp-server/src/lib/pipeline-detection.ts:228` returns PLAN whenever any group issue is in "Ready for Plan"; no awareness of parent plan existence. The cheapest place to add the skip is in `ralph-plan` itself (Option C from the verification pass).
- **`--parent-plan` flag exists but only inherits constraints**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md:152-159` reads the parent and inherits shared constraints, but still writes a new child plan file. It does not short-circuit when the parent's phase content is sufficient.
- **No structured BLOCKED verdict from impl-agent to hero**: `agents/impl-agent.md` is a 10-line shim with no verdict protocol. Internal sub-agent BLOCKED handling exists at `ralph-impl/SKILL.md:306` but doesn't surface upward. val-agent's `VALIDATION PASS/FIX/FAIL` prefix protocol (`skills/ralph-val/SKILL.md:442-452`) is the canonical template.

### Token-churn evidence (landcrawler-ai, 30 days)

- 351 plan files, ~176k lines, avg 502, max 3385 (`2025-12-31-map-system-redesign.md`)
- 245 research docs ÷ ~107 unique issue prefixes ≈ 2.3 research docs per issue
- 62 iteration/critique/address commits → ~1 review cycle per 5–6 commits
- Concrete duplication: GH-764 mypy plan-of-plans + GH-765/766/767/768 each with own plan; GH-547 parent + GH-598 child monitoring plan ~27KB restating parent scope
- 22 `worktree-agent-*` branches + 13 separate per-worktree conversation dirs (~17MB) on top of 206MB main project log

### Superpowers' policy (the template)

From `superpowers/skills/subagent-driven-development/SKILL.md:89-102`:
- 1–2 files + complete spec → cheap (Haiku tier)
- Multi-file integration / pattern matching / debugging → standard (Sonnet tier)
- Architecture / design / review → most capable (Opus tier)
- Escalation on BLOCKED, not preemptive
- Complexity drives tier, not role

## Desired End State

After this plan:

1. **Model-tier policy is documented** at `plugin/ralph-hero/docs/model-tier-policy.md` and referenced from `CLAUDE.md`, codifying the SDD-derived rules and the per-agent env-var override pattern (`RALPH_<AGENT>_MODEL`).
2. **Safe-default downgrades land**: `split-agent` → sonnet, `impl-agent` → sonnet (default). `plan-agent`, `plan-epic-agent`, `review-agent` stay on opus (design-judgment work).
3. **Hero dispatches impl-agent with explicit `model=` and reads `${RALPH_IMPL_MODEL:-sonnet}`**, so a single env var flips the tier per session without editing frontmatter.
4. **BLOCKED escalation path exists end-to-end**: ralph-impl emits `IMPL BLOCKED needs=opus` on internal exhaustion (post sub-agent retry budget), hero parses that prefix and re-dispatches with `model="opus"` once. A second BLOCKED escalates to Human Needed.
5. **Atomic children of a plan-of-plans skip the plan step**: ralph-plan detects the `--parent-plan` flag plus a phase-detail check, posts a `## Plan Reference` comment, and advances state Ready for Plan → In Progress directly. No child plan file is written.
6. **README + ASCII diagram are in place** at `plugin/ralph-hero/README.md` showing the full pipeline and current model assignments.
7. **Measurable outcome**: on a representative 4-child plan-of-plans (the GH-764 mypy shape), token usage drops by skipping 4 plan files (~25KB each) AND running 4 impl-agent dispatches on sonnet instead of opus.

### Key Discoveries

- `Agent(model=...)` already an accepted parameter — see `ralph-impl/SKILL.md:298,311,324`.
- Plan Reference + impl-plan-required.sh path is already production-ready; only the "skip plan" entry point is missing.
- val-agent verdict-prefix protocol (`ralph-val/SKILL.md:442-452`) is the precedent for impl-agent BLOCKED.
- `RALPH_DELEGATE_<TASK>_MODEL` env pattern at `scripts/ralph-delegate.sh` is the precedent for the new `RALPH_<AGENT>_MODEL` env pattern.

## What We're NOT Doing

- **No telemetry / JSONL token-usage log this round** — explicitly out of scope per user direction. Measurement is by-eye on landcrawler-ai's next plan-of-plans cycle.
- **No changes to research sub-agents** — current haiku/sonnet split (locator=haiku, analyzer=sonnet) already follows the policy.
- **No automatic re-planning at lower tier on NEEDS_ITERATION** — that's a future plan-iteration efficiency phase the user descoped.
- **No new MCP tool or pipeline-detection changes** — the entire dedup is contained inside `ralph-plan/SKILL.md` (Option C from verification).
- **No changes to plan-epic-agent or review-agent tiers** — design work stays on Opus.
- **No retrofit of existing landcrawler-ai child plans** — applies to new runs only.

## Implementation Approach

Five phases, ordered so each is independently testable and reversible:

1. **Policy + env-var contract** — write the docs and the env-var override convention before touching any agent files. Lets later phases reference a single source of truth.
2. **Safe agent frontmatter downgrades** — split-agent and impl-agent flip to sonnet. Drop-in change; existing dispatches inherit the new default.
3. **Hero dispatch wiring + BLOCKED escalation** — hero passes `model=` and parses the new verdict prefix. ralph-impl emits the prefix.
4. **Plan dedup for atomic children** — ralph-plan detects the parent-plan-covers-this case and short-circuits.
5. **Docs + ASCII diagram** — README update, CLAUDE.md table refresh, cross-references.

---

## Phase 1: Model-Tier Policy + Env-Var Contract

### Overview
Establish the single source of truth that all subsequent phases reference. No behavioral change.

### Changes Required

#### 1. New policy doc
**File**: `plugin/ralph-hero/docs/model-tier-policy.md` (NEW)
**Changes**: Codify the SDD-derived rules and per-agent override convention.

```markdown
# Ralph-Hero Model-Tier Policy

Adapted from superpowers/subagent-driven-development/SKILL.md:89-102.

## The rule
Complexity drives tier, not role.

| Signal                                                  | Tier      | Model  |
| ------------------------------------------------------- | --------- | ------ |
| 1-2 files, fully-specified spec, mechanical             | cheap     | haiku  |
| Multi-file, integration, pattern matching, debugging    | standard  | sonnet |
| Architecture, design judgment, broad-codebase review    | capable   | opus   |

Escalate on BLOCKED, never preemptively.

## Default tier by agent
(see CLAUDE.md table for the live mapping)

## Per-session overrides
Set `RALPH_<AGENT_UPPER>_MODEL=opus|sonnet|haiku` to override frontmatter
at dispatch time. Hero respects this for agents it dispatches; skills passing
`model=` to Agent() should read the same env var.

Examples:
  RALPH_IMPL_MODEL=opus            # force impl-agent back to opus
  RALPH_PLAN_MODEL=sonnet          # rare: cheaper plan-agent runs
  RALPH_SPLIT_MODEL=opus           # rare: complex decompositions

## Escalation contract
Agents that may exhaust their tier should emit a verdict-prefix line:
  "IMPL BLOCKED needs=opus"
The dispatcher (hero) re-dispatches once with `model="opus"`. A second
BLOCKED escalates to Human Needed via `save_issue(workflowState="__ESCALATE__")`.

## Why not preemptive Opus?
Two reasons from the landcrawler-ai 30-day audit:
1. Most impl phases are mechanical when the plan is detailed — sonnet handles
   them. Opus default wastes tokens on the common case.
2. Failure cases that need Opus are detectable (BLOCKED status). One retry
   with the higher tier costs less than always paying for it.
```

#### 2. Cross-reference in CLAUDE.md
**File**: `CLAUDE.md`
**Changes**: Add a one-line pointer to the new policy doc near the existing per-phase agents table; leave the table untouched until Phase 2.

```markdown
> **Model tier policy**: see `plugin/ralph-hero/docs/model-tier-policy.md` for
> the complexity-driven tier rules and `RALPH_<AGENT>_MODEL` override pattern.
```

### Success Criteria

#### Automated Verification:
- [ ] Policy doc exists: `test -f plugin/ralph-hero/docs/model-tier-policy.md`
- [ ] CLAUDE.md references it: `grep -q "model-tier-policy" CLAUDE.md`
- [ ] Markdown lints: `npx markdownlint plugin/ralph-hero/docs/model-tier-policy.md`

#### Manual Verification:
- [ ] Read the policy doc end-to-end; the env-var pattern + escalation contract is unambiguous.
- [ ] Confirm the table maps cleanly to the next phase's frontmatter changes.

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the policy doc reads correctly before proceeding.

---

## Phase 2: Safe Agent Frontmatter Downgrades

### Overview
Flip the two unambiguous downgrades: `split-agent` (mechanical decomposition with MCP tools) and `impl-agent` (default sonnet; hero passes `model=` to override per-dispatch). Plan/plan-epic/review stay on Opus.

### Changes Required

#### 1. split-agent → sonnet
**File**: `plugin/ralph-hero/agents/split-agent.md`
**Changes**: Single-line frontmatter edit.

```yaml
# before
model: opus
# after
model: sonnet
```

Rationale: split-agent runs `ralph-split` which is gated by hooks (`split-estimate-gate.sh`, `split-size-gate.sh`) enforcing valid input/output. Decomposition follows the parent description deterministically — no design judgment.

#### 2. impl-agent → sonnet (default)
**File**: `plugin/ralph-hero/agents/impl-agent.md`
**Changes**: Frontmatter `model: opus` → `model: sonnet`. Add a brief frontmatter comment line in description so the override path is discoverable.

```yaml
# before
model: opus
# after
model: sonnet
# Default sonnet per docs/model-tier-policy.md. Hero dispatches with
# explicit model= (RALPH_IMPL_MODEL or "sonnet"), escalating to opus
# on BLOCKED. See ralph-impl/SKILL.md verdict-prefix contract.
```

Rationale: ralph-impl already does internal tiered sub-agent dispatch (low→haiku, med→sonnet, high→opus at `ralph-impl/SKILL.md:298`), so the outer impl-agent is mostly an orchestrator over those sub-agents. Sonnet is sufficient for that orchestration.

#### 3. Leave alone
- `plan-agent.md` (opus) — phased planning for M-sized issues retains design judgment.
- `plan-epic-agent.md` (opus) — strategic decomposition is the highest-judgment role.
- `review-agent.md` (opus) — plan critique is design review per the policy.

### Success Criteria

#### Automated Verification:
- [ ] `grep -m1 '^model:' plugin/ralph-hero/agents/split-agent.md` → `model: sonnet`
- [ ] `grep -m1 '^model:' plugin/ralph-hero/agents/impl-agent.md` → `model: sonnet`
- [ ] `grep -m1 '^model:' plugin/ralph-hero/agents/plan-agent.md` → `model: opus` (unchanged)
- [ ] `grep -m1 '^model:' plugin/ralph-hero/agents/review-agent.md` → `model: opus` (unchanged)
- [ ] Plugin loads without error: `node plugin/ralph-hero/mcp-server/dist/index.js --selfcheck` (or whatever existing smoke-check exists)

#### Manual Verification:
- [ ] Dispatch `/ralph-hero:hello` and confirm no model-load errors in transcript.
- [ ] Run a small ralph-split smoke test on an M-sized issue; confirm the decomposition quality matches prior runs.

**Implementation Note**: After this phase, pause for the human to spot-check split quality on a real M-sized issue before proceeding.

---

## Phase 3: Hero Dispatch Wiring + BLOCKED Escalation

### Overview
Hero dispatches impl-agent with an explicit `model=` derived from `RALPH_IMPL_MODEL` (or sonnet default), reads impl-agent's terminal output for a `IMPL BLOCKED needs=opus` prefix, and re-dispatches once with `model="opus"` on that signal. ralph-impl emits the prefix when its internal retry budget is exhausted by complexity (not by hook failures).

### Changes Required

#### 1. Hero impl-agent dispatch carries explicit model
**File**: `plugin/ralph-hero/skills/hero/SKILL.md` (around lines 413-419 and 458-462)
**Changes**: Update both impl-agent dispatch sites to read env var and pass `model=`.

```python
# before (line 414)
Agent(subagent_type="ralph-hero:impl-agent",
      prompt="Implement GH-NNN. Plan doc: thoughts/shared/plans/...")

# after
impl_model = os.environ.get("RALPH_IMPL_MODEL", "sonnet")
Agent(subagent_type="ralph-hero:impl-agent",
      model=impl_model,
      prompt="Implement GH-NNN. Plan doc: thoughts/shared/plans/...",
      description=f"Implement GH-NNN ({impl_model})")
```

(Hero's SKILL.md is markdown prose with Python-style examples; this is a documentation update, not real code. The "code" is the model behavior that hero performs.)

Also update the parallel-dispatch section (around line 263-265) to apply the same model env-var lookup.

#### 2. ralph-impl emits BLOCKED verdict prefix
**File**: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (Step 7c BLOCKED handler around line 306)
**Changes**: Before the "after 3 retries escalate to Human Needed" branch, add:

```markdown
**Tier-escalation path:**
If the BLOCKED reason is "weak model" (sub-agent retried at higher tier already
exhausted within ralph-impl), AND the dispatching session's model is not opus,
emit a structured terminal line BEFORE stopping:

    IMPL BLOCKED model=<current> needs=opus reason=<short-reason>

Do NOT call `save_issue(workflowState="__ESCALATE__")` in this path — leave the
issue in "In Progress" so hero can re-dispatch with `model="opus"`.

If the current model IS already opus, fall through to the existing escalate-to-
Human-Needed path.
```

Also update `impl-postcondition.sh` (hook) so a BLOCKED-prefix stop is not treated as failure. The existing hook (verified) only blocks when the worktree directory is missing — it does NOT inspect the transcript. We add transcript inspection at the top, mirroring `val-postcondition.sh`'s proven pattern (`val-postcondition.sh:28-37`: read `transcript_path` from stdin JSON, `grep -qE` for the marker, exit 0 if found).

**File**: `plugin/ralph-hero/hooks/scripts/impl-postcondition.sh`
**Changes**: Insert a transcript-inspection block at the top of the Stop logic, immediately after the `source "$(dirname "$0")/hook-utils.sh"` line and BEFORE the existing `read_input > /dev/null` line. Replace `read_input > /dev/null` with `INPUT=$(read_input)` so the input is captured rather than discarded.

```bash
# Accept IMPL BLOCKED as a non-error terminal state (hero re-dispatches with higher tier).
# Mirrors val-postcondition.sh:28-37 — read transcript_path from stdin JSON, grep the
# raw transcript for the marker. Runs BEFORE the worktree check so a BLOCKED early-exit
# (which may happen before worktree creation) does not trip the missing-worktree block.
INPUT=$(read_input)
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  if grep -qE '^IMPL BLOCKED ' "$TRANSCRIPT_PATH"; then
    echo "impl-postcondition: IMPL BLOCKED terminal accepted (hero will retry with higher tier)"
    exit 0
  fi
fi
```

Note: `read_input` is provided by `hook-utils.sh` (used by both val and impl postconditions today). The val hook uses `INPUT=$(cat)` directly because it does not source any helper; the impl hook already sources `hook-utils.sh`, so `read_input` is the idiomatic call. Both forms produce the same JSON-on-stdin behavior.

#### 3. Hero parses BLOCKED and re-dispatches once
**File**: `plugin/ralph-hero/skills/hero/SKILL.md` (after each impl-agent dispatch site)
**Changes**: Add the re-dispatch logic in the prose narrative.

```markdown
After impl-agent returns, inspect its final message. If it begins with
`IMPL BLOCKED needs=opus`:
  - If this dispatch's model was NOT opus: re-dispatch the SAME issue with
    Agent(subagent_type="ralph-hero:impl-agent", model="opus", prompt=...,
          description="Retry GH-NNN with opus after BLOCKED")
    Increment a per-issue retry counter (in TaskList metadata).
  - If this dispatch's model WAS opus, OR the retry counter is already 1:
    escalate via save_issue(workflowState="__ESCALATE__") to Human Needed.
    Stop the hero loop.
```

#### 4. Cross-agent escalation pattern (optional, narrow)
Apply the same pattern to `split-agent` and `pr-agent`? **No** — split is hook-gated and pr is mechanical; their failure modes are not model-tier issues. The escalation path is impl-agent-only for this round.

### Success Criteria

#### Automated Verification:
- [ ] Hero SKILL.md references RALPH_IMPL_MODEL: `grep -q 'RALPH_IMPL_MODEL' plugin/ralph-hero/skills/hero/SKILL.md`
- [ ] ralph-impl SKILL.md documents the BLOCKED prefix: `grep -q '^IMPL BLOCKED ' plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- [ ] impl-postcondition.sh accepts the prefix: `grep -q 'IMPL BLOCKED' plugin/ralph-hero/hooks/scripts/impl-postcondition.sh`
- [ ] Markdown lints: `npx markdownlint plugin/ralph-hero/skills/hero/SKILL.md plugin/ralph-hero/skills/ralph-impl/SKILL.md`
- [ ] Hook syntax valid: `bash -n plugin/ralph-hero/hooks/scripts/impl-postcondition.sh`

#### Manual Verification:
- [ ] On a real moderately-complex issue, dispatch hero. Confirm impl-agent runs on sonnet (check the dispatch description includes "(sonnet)").
- [ ] Synthetic BLOCKED test: temporarily edit ralph-impl to emit the BLOCKED prefix unconditionally on first dispatch; confirm hero re-dispatches with opus; confirm second BLOCKED escalates to Human Needed.
- [ ] Revert the synthetic edit.

**Implementation Note**: This phase is the riskiest. After completing it, pause and run the synthetic BLOCKED test before proceeding to Phase 4. If the escalation loop misbehaves (infinite retry, missed escalate), do not proceed.

---

## Phase 4: Plan Dedup for Atomic Children

### Overview
When `ralph-plan` is invoked with `--parent-plan` AND the parent plan contains a sufficiently-detailed phase that maps to this child issue, skip writing a new plan file. Instead, post a `## Plan Reference` comment on the child issue (already a documented protocol) and advance state directly to "In Progress", bypassing Plan in Review. The downstream impl-agent path is already wired to consume `## Plan Reference` (`ralph-impl/SKILL.md:112-125` + `impl-plan-required.sh:59-67`).

### Changes Required

#### 1. ralph-plan: add reuse-detection step
**File**: `plugin/ralph-hero/skills/ralph-plan/SKILL.md` (insert after the existing `--parent-plan` handling at lines 152-159)
**Changes**: New Step "3.5 — Parent plan reuse check".

```markdown
### Step 3.5 — Parent Plan Reuse Check

If `--parent-plan PATH` was provided:

1. Read the parent plan. Search for a phase heading whose name maps to this
   child issue. Mapping rules (in priority order):

   1.1. Frontmatter `child_plans:` mapping if present.
   1.2. Phase heading containing `GH-NNN` (the child issue number).
   1.3. Phase heading whose title closely matches the child issue title
        (>=70% token overlap, case-insensitive).

2. If a matching phase is found AND the phase block contains:

   2.1. At least one `**File**: <path>` line, AND
   2.2. A `### Success Criteria:` subsection with at least one
        `Automated Verification` item.

   Then the parent plan covers this child. Take the SHORT path:

   2.3. Post a `## Plan Reference` artifact comment on the child issue using
        the protocol from `skills/shared/artifact-comment-protocol.md`. The
        comment body MUST include a fragment anchor matching the phase heading
        slug (e.g. `#phase-2-impl-agent-emits-blocked-verdict-prefix`) so
        impl-agent's reader (ralph-impl/SKILL.md:125) can extract it.
   2.4. Advance the child issue workflow state directly to "In Progress" via
        `save_issue(issueNumber=NNN, workflowState="In Progress")`. Skip
        "Plan in Review" entirely.
   2.5. Do NOT write a new plan file.
   2.6. Emit a terminal line:
          PLAN REUSED parent=<path> phase=<heading> child=GH-NNN
   2.7. Stop. The phase task is complete.

3. If the parent plan does NOT cover this child (heading not found, or phase
   block too thin), fall through to normal plan generation per Step 4.
```

#### 2. plan-postcondition.sh: accept PLAN REUSED prefix
**File**: `plugin/ralph-hero/hooks/scripts/plan-postcondition.sh` (or whatever the corresponding hook is named)
**Changes**: Accept `PLAN REUSED ` as a non-error terminal state alongside the existing "plan file written" path.

```bash
if grep -q '^PLAN REUSED ' "$transcript_last_line_file" 2>/dev/null; then
  echo "plan-postcondition: REUSED terminal accepted (no new plan file)"
  exit 0
fi
```

#### 3. plan-epic-agent passes child issue numbers and titles to ralph-plan
**File**: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (around lines 234-270 where it dispatches `Skill("ralph-hero:ralph-plan", "GH-{n} --parent-plan {path} --sibling-context ...")`)
**Changes**: No structural change — the existing dispatch already passes `--parent-plan`. Verify that the prompt passes the child issue NUMBER (so Step 3.5's mapping rule 1.2 can find `GH-NNN` in headings). Add an explicit assertion in this skill's Automated Verification (Phase 4 below) that `grep -E 'GH-\{[a-z_]+\}' ralph-plan-epic/SKILL.md` matches the dispatch site — proves the dispatcher templates the child number into the prompt.

#### 4. plan-of-plans authoring: encourage child-issue headings
**File**: `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (plan-of-plans template section)
**Changes**: Add a note that phase headings SHOULD include `GH-NNN` when the child issue is already known, to enable Step 3.5 reuse detection. This is a guideline, not a hard requirement — the title-token-overlap fallback (mapping rule 1.3) still works without it.

```markdown
**Tip**: When child issues are already created, name phases like
`## Phase 2 — Token-Usage Telemetry (GH-0833)` so that `ralph-plan` can detect
parent-plan reuse and skip child plan generation.
```

#### 5. CLAUDE.md table: note the dedup behavior
**File**: `CLAUDE.md`
**Changes**: Under the existing Per-Phase Agents table, add a footnote:

```markdown
> `ralph-plan` skips writing a child plan file when invoked with `--parent-plan`
> and the parent plan contains a phase matching the child by issue number or
> title. The child receives a `## Plan Reference` comment and advances to
> "In Progress" directly. See `docs/model-tier-policy.md` for the rationale.
```

### Success Criteria

#### Automated Verification:
- [ ] ralph-plan SKILL.md has Step 3.5: `grep -q 'Parent Plan Reuse Check' plugin/ralph-hero/skills/ralph-plan/SKILL.md`
- [ ] plan-postcondition accepts the prefix: `grep -q 'PLAN REUSED' plugin/ralph-hero/hooks/scripts/plan-postcondition.sh`
- [ ] plan-epic-agent dispatch templates the child issue number into the prompt: `grep -E 'GH-\{[a-z_]+\}' plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md` (ensures mapping rule 1.2 will find a match in parent plan headings)
- [ ] Markdown lints: `npx markdownlint plugin/ralph-hero/skills/ralph-plan/SKILL.md plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md CLAUDE.md`
- [ ] Hook syntax valid: `bash -n plugin/ralph-hero/hooks/scripts/plan-postcondition.sh`

#### Manual Verification:
- [ ] On a synthetic plan-of-plans with 2 child issues whose numbers appear in phase headings: invoke ralph-plan-epic, confirm each child gets a `## Plan Reference` comment, confirm no new child plan files are written, confirm both children land in "In Progress".
- [ ] Negative test: a child whose title does NOT appear in the parent plan should fall through and generate its own plan file normally.
- [ ] On the resulting children, dispatch impl-agent; confirm it reads the parent plan via the `## Plan Reference` path (look for `RALPH_PLAN_REFERENCE` in the agent transcript) and completes successfully.

**Implementation Note**: This is the biggest token saver. After this phase, pause for a real end-to-end dry run on a small 2-child plan-of-plans before considering the change validated.

---

## Phase 5: README + ASCII Diagram + Cross-References

### Overview
Documentation-only phase. Captures the diagram from the planning session and cross-links the new policy doc and dedup behavior.

### Changes Required

#### 1. README ASCII diagram + tier section
**File**: `plugin/ralph-hero/README.md`
**Changes**: Add (or update) a `## Pipeline Overview` section containing the ASCII diagram and a `## Model Tier Policy` subsection pointing to `docs/model-tier-policy.md`.

The ASCII diagram to include:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ /ralph-hero:hero NNN  →  get_issue(includePipeline=true) → phase = ?           │
└────────────────────────────────────────────────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
   ┌──────────┐                ┌────────────┐                  ┌────────────┐
   │  SPLIT   │  Skill         │  RESEARCH  │  Skill           │  COMPLETE  │
   │  (M+L+XL)│  sonnet*       │  (per leaf)│  sonnet          │  no-op     │
   └────┬─────┘                └──────┬─────┘                  └────────────┘
                                      │  parallel sub-agents (haiku/sonnet)
        ▼                             ▼
                                  ┌─────────────────┐
                                  │  PLAN           │
                                  │  L/XL: epic     │  opus  → plan-of-plans
                                  │  M/S/XS: plan   │  opus  → phased plan
                                  │  (atomic w/parent│       → SKIPPED, posts
                                  │   plan: REUSED)  │         Plan Reference
                                  └────────┬────────┘
                                           ▼
                                  ┌─────────────────┐
                                  │  PLAN REVIEW    │  opus
                                  │  ralph-review   │
                                  └────────┬────────┘
                                           ▼
                                  ┌─────────────────┐
                                  │  IMPLEMENT      │
                                  │  impl-agent     │  sonnet*
                                  │  (BLOCKED →     │  → opus retry once
                                  │   re-dispatch)  │
                                  └────────┬────────┘
                                           ▼
                                  ┌─────────────────┐
                                  │  PR             │  haiku
                                  └────────┬────────┘
                                           ▼
                      ┌─────────── FINISH (sonnet) ───────────┐
                      │ val(haiku) → code-review(sonnet)      │
                      │   → impl-agent address mode (sonnet*) │
                      │   → ralph-merge(haiku) → CI watch     │
                      └───────────────────────────────────────┘

* = downgraded from opus in 2026-05-13 model-tier optimization.
  Override per-session with RALPH_<AGENT>_MODEL env var.
  See docs/model-tier-policy.md.
```

#### 2. CLAUDE.md per-phase agents table
**File**: `CLAUDE.md`
**Changes**: Update the existing table's `split-agent` and `impl-agent` rows from `opus` to `sonnet`. Add a "Notes" column entry for impl-agent noting the BLOCKED-escalation path.

### Success Criteria

#### Automated Verification:
- [ ] README contains the diagram: `grep -q 'PLAN REVIEW' plugin/ralph-hero/README.md` (or whichever unique token from the diagram)
- [ ] README references the policy doc: `grep -q 'model-tier-policy' plugin/ralph-hero/README.md`
- [ ] CLAUDE.md table updated: `awk '/split-agent/{print}/impl-agent/{print}' CLAUDE.md | grep -q sonnet`
- [ ] Markdown lints across all touched docs.

#### Manual Verification:
- [ ] Render the README in a markdown viewer; the ASCII diagram displays correctly in monospace.
- [ ] A reader unfamiliar with the codebase can determine, from README + policy doc alone, which model runs which phase and how to override.

**Implementation Note**: Documentation-only phase. Once the diagram renders and the table is correct, this phase is done.

---

## Testing Strategy

### Unit / static checks (per phase)
- Markdown lint on all touched `.md` files
- `bash -n` on all touched hook scripts
- Frontmatter `model:` grep checks (see per-phase Automated Verification)

### Integration tests (end-to-end)

**Test A — Sonnet impl-agent on a real issue**
Pick a small open issue with an existing detailed plan in `ralph-hero/thoughts/shared/plans/`. Dispatch hero. Confirm:
- impl-agent dispatch description shows "(sonnet)"
- Phase completes without BLOCKED
- Output quality matches prior Opus runs (manual diff review)

**Test B — Synthetic BLOCKED escalation**
Temporarily patch ralph-impl/SKILL.md to emit `IMPL BLOCKED needs=opus reason=test` unconditionally on first dispatch. Run hero on a small issue. Confirm:
- Hero re-dispatches with model=opus
- Second dispatch (with patched skill unpatched halfway) completes normally
- A double-BLOCKED case escalates to Human Needed

**Test C — Plan dedup on a 2-child plan-of-plans**
Create a synthetic epic issue with 2 atomic children. Use a hand-written parent plan with phases named `## Phase 1 — Foo (GH-AAA)` and `## Phase 2 — Bar (GH-BBB)`. Invoke ralph-plan-epic. Confirm:
- No `2026-05-13-GH-AAA-*.md` plan file is created
- No `2026-05-13-GH-BBB-*.md` plan file is created
- Each child has a `## Plan Reference` comment with `#phase-N` anchor
- Each child is in "In Progress" state
- Dispatching impl-agent on each child succeeds (reads parent plan via RALPH_PLAN_REFERENCE)

**Test D — Negative case for plan dedup**
Same setup as Test C but with a third child whose title doesn't appear in any parent plan phase. Confirm that child falls through and gets its own plan file normally.

### Manual review

- Read the updated docs (policy + README + CLAUDE.md) start-to-finish; confirm internal consistency.
- Spot-check that ralph-plan's Step 3.5 mapping rules cover the GH-764 mypy plan-of-plans shape — phase headings include child issue numbers, so reuse detection would trigger correctly.

---

## Performance Considerations

### Expected token savings (back-of-envelope, landcrawler-ai shape)

For a 4-child plan-of-plans (e.g. GH-764 mypy → GH-765/766/767/768):

| Item                                     | Before        | After         | Delta            |
| ---------------------------------------- | ------------- | ------------- | ---------------- |
| Child plan files written                 | 4             | 0             | -4 plan files    |
| Child plan-agent dispatches              | 4× opus       | 0             | -4 opus dispatches |
| Child plan-review dispatches             | 4× opus       | 0             | -4 opus dispatches |
| impl-agent dispatches per child          | 1× opus       | 1× sonnet     | sonnet vs opus   |
| Total opus dispatches in plan/impl path  | 12            | 4             | -8 opus → sonnet/skipped |

The dominant savings are from skipping plan generation entirely (no plan-agent + no review-agent for each child), not just from the impl-agent downgrade.

### Risks

- **Sonnet impl-agent on genuinely-complex work**: mitigated by the BLOCKED escalation path. If sonnet stalls, hero retries with opus. Worst case is one wasted sonnet dispatch before an opus run.
- **Plan-reuse false positives**: a poorly-written parent plan phase could match a child by title-overlap heuristic but not actually cover the work. Mitigated by the mapping rule requiring at least one `**File**:` line AND an Automated Verification subsection — sparse phases fall through.
- **Hook acceptance of new terminal prefixes**: `IMPL BLOCKED` and `PLAN REUSED` are new terminal strings. The corresponding postcondition hooks need explicit accept-paths. Phase 3 and Phase 4 each handle their own hook update.

## Migration Notes

- Existing plans in `thoughts/shared/plans/` are not retroactively deduped. Only NEW plan-of-plans runs benefit from Phase 4.
- Existing in-flight issues mid-pipeline are not affected — the changes are dispatch-time, so the next hero invocation picks up new behavior.
- Rollback: revert frontmatter changes (Phase 2) and remove `RALPH_IMPL_MODEL` from any env files. The dispatch wiring (Phase 3) and dedup (Phase 4) are additive and inert without their trigger conditions.

## References

- Superpowers SDD model policy: `superpowers/skills/subagent-driven-development/SKILL.md:89-102`
- Existing `Agent(model=)` precedent: `plugin/ralph-hero/skills/ralph-impl/SKILL.md:298,311,324`
- Plan Reference reader: `plugin/ralph-hero/skills/ralph-impl/SKILL.md:112-125`
- Plan Reference hook gate: `plugin/ralph-hero/hooks/scripts/impl-plan-required.sh:59-67`
- val-agent verdict-prefix protocol (BLOCKED template): `plugin/ralph-hero/skills/ralph-val/SKILL.md:442-452`
- `--parent-plan` flag (already exists, only partially used): `plugin/ralph-hero/skills/ralph-plan/SKILL.md:152-159`
- Delegation env-var pattern (template for `RALPH_<AGENT>_MODEL`): `plugin/ralph-hero/scripts/ralph-delegate.sh`
- Landcrawler-ai churn audit: this session's research (see "Token-churn evidence" in Current State Analysis)
