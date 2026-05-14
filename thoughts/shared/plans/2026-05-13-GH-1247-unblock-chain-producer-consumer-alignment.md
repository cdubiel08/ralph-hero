---
date: 2026-05-13
status: draft
type: plan
tags: [skills, unblock, human-needed, contract]
github_issue: 1247
github_issues: [1247]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1247
primary_issue: 1247
---

# Unblock Chain — Producer-First Alignment

## Prior Work

- builds_on:: [[2026-05-08-GH-1142-ralph-hero-unblock-skill]]
- Related research: thoughts/shared/research/2026-04-22-agent-bus-design.md

## Overview

The unblock chain has two skills:

- **`ralph-hero:ralph-unblock` (autonomous, PRODUCER)** — picks a Human Needed issue and **creates** the `## Unblock Request` state (a comment containing 1–5 specific blocking questions). This is the only thing the autonomous skill produces.
- **`/ralph-hero:unblock` (interactive, CONSUMER)** — **finds** Human Needed issues that have a `## Unblock Request`, walks the human through the questions, posts `## Unblock Resolution`, and transitions the issue back into the pipeline.

The chain's job is: **ralph-unblock creates the state that /ralph-hero:unblock finds to unblock.**

The `## Escalation` comment is **optional** context that helps `ralph-unblock` synthesize better questions and helps `/ralph-hero:unblock` choose a default return state. Neither skill requires it — both have fallback paths. The previous draft of this plan over-emphasized fixing producers of `## Escalation` comments; that's now scoped as supporting work, not the critical path.

## Current State Analysis

**Producer side (`ralph-unblock`):**

- `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:78-97` — selects the oldest Human Needed issue without a fresh `## Unblock Request`.
- `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:99-110` — reads context: `## Escalation` if present, else falls back to issue body and linked `## Research Document` / `## Implementation Plan` comments. **The fallback path already exists.**
- `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:126-149` — posts the `## Unblock Request` comment. **This is the state-creation step. It runs regardless of whether `## Escalation` exists.**
- `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:83-84` — idempotency guard: "Skip if `## Unblock Request` is newer than the most recent `## Escalation`. If escalation is absent and a `## Unblock Request` already exists, skip too." Works correctly for one-shot but cannot detect re-escalations that don't produce a fresh `## Escalation` comment.

**Consumer side (`/ralph-hero:unblock`):**

- `plugin/ralph-hero/skills/unblock/SKILL.md:54-58` — filters Human Needed candidates to those with a `## Unblock Request` comment. Correct.
- `plugin/ralph-hero/skills/unblock/SKILL.md:65-75` — extracts `originating_command` from `## Escalation` for the return-state heuristic; defaults to `In Progress` when absent. Correct fallback.
- `plugin/ralph-hero/skills/unblock/SKILL.md:88-106` — confirms the inferred state via `AskUserQuestion` and transitions. Correct.

**Supporting (not critical):**

- `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md` was rewritten in worktree commit `2f7ad1a4` to require the `## Escalation` markdown header. This **improves** context quality when escalations happen but is **not** required for the unblock chain to function.
- `ralph-code-review` escalates with a `## Code Review` summary; this means its escalations don't enrich the `originating_command` heuristic but they still result in Human Needed issues that `ralph-unblock` will pick up and create `## Unblock Request` for.

### Key Discoveries

- The state-creation path (`ralph-unblock` → `## Unblock Request`) already works without `## Escalation`. The misframing in the previous plan draft (calling `ralph-unblock` a "consumer") obscured this.
- The actual hole in the producer flow: the idempotency guard cannot detect a stale `## Unblock Request` when the issue is re-escalated without a fresh `## Escalation` comment. In practice this is rare, but worth tightening.
- The MCP `extractUnblockSignal` (`directions-tools.ts:148`) correctly fires the `human-needed-unblock` direction whenever a `## Unblock Request` exists and no newer `## Escalation` is present — already aligned with the producer-first model.

## Desired End State

- The producer (`ralph-unblock`) is documented and framed as **the only thing that creates `## Unblock Request` state**. Its description, step ordering, and outcome payload all reflect this.
- The producer reliably creates `## Unblock Request` on **any** Human Needed issue, with or without a `## Escalation` comment, with no degraded behavior in the no-escalation case.
- The consumer (`/ralph-hero:unblock`) reliably finds those `## Unblock Request` comments and routes the issue back into the pipeline.
- A regression-safe acceptance scenario exists for the no-escalation flow (most common case in practice).

### Verification

- **Acceptance test (manual, post Phase 2)**: Create a synthetic Human Needed test issue with body context but **no** `## Escalation` comment. Run `ralph-hero:ralph-unblock` → assert a `## Unblock Request` comment with 1–5 numbered questions is posted, originating skill rendered as `(unknown)`. Run `/ralph-hero:unblock` → walk the Q&A → assert default return state is `In Progress`, `## Unblock Resolution` is posted, issue transitions. Hero loop picks it back up.
- **Re-run idempotency**: Running `ralph-unblock` again against the same issue (with the `## Unblock Request` already posted) skips it cleanly.

## What We're NOT Doing

- **Not requiring `## Escalation` for the chain to work.** The chain functions without it.
- **Not adding a new direction signal or hook.** The existing `human-needed-unblock` direction is already correct.
- **Not modifying the state machine or the `human-needed-outbound-block.sh` hook.**
- **Not retroactively rewriting historical comments.**
- **Not blocking on the supporting work** (Phases 3–4). The chain works without them.

## Implementation Approach

Two critical-path phases first (producer reframe + acceptance test). Two supporting phases follow (richer context when escalations happen + future-drift prevention).

---

## Phase 1: Producer reframe — make state-creation the leading concept (CRITICAL)

### Overview

Update `ralph-unblock/SKILL.md` so its description, step ordering, and outcome payload all lead with "this skill creates `## Unblock Request` state on any Human Needed issue." The escalation-reading is demoted from a primary step to optional context.

### Changes Required:

#### 1. Update the skill description

**File**: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` (frontmatter `description:` field, line 2)

**Current**:
> Autonomous async-loop unblock helper — picks oldest Human Needed issue, parses escalation context, posts specific blocking questions as ## Unblock Request comment. Does NOT transition state.

**New**:
> Autonomous async-loop unblock helper — picks the oldest Human Needed issue and CREATES the `## Unblock Request` state (1–5 specific blocking questions) that `/ralph-hero:unblock` consumes. Reads `## Escalation` context when present and falls back to issue body + linked research/plan artifacts otherwise. Does NOT transition state.

#### 2. Update the skill prologue and Step 3 framing

**File**: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` (prologue around lines 40–46 and Step 3 header around line 99)

**Changes**:
- Prologue paragraph: rewrite to emphasize "this is the PRODUCER of `## Unblock Request` state. The consumer `/ralph-hero:unblock` finds and processes that state."
- Step 3 header: rename from "Read Context" to "Read Context (escalation optional)" and reorder bullets so the issue body is read **first**, the `## Escalation` comment is read **next if present**, and linked research/plan artifacts are read **last**. Make the no-escalation path the default narrative, not a fallback.

#### 3. Tighten the idempotency guard

**File**: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` (Step 2, item 4, around line 84)

**Current rule**: "Skip if `## Unblock Request` is newer than `## Escalation`. If escalation is absent and a `## Unblock Request` already exists, skip too."

**Replace with**: "Skip the issue if a `## Unblock Request` exists AND one of: (a) a `## Escalation` comment exists with `createdAt` ≤ the Unblock Request's `createdAt`, OR (b) no `## Escalation` exists AND the issue's last transition into Human Needed (best-effort: the most recent state-change comment or the issue's `updatedAt`) is ≤ the Unblock Request's `createdAt`."

Rationale: this lets the human force a fresh `## Unblock Request` by re-transitioning the issue out of and back into Human Needed, even without writing a new `## Escalation` comment.

#### 4. Make the outcome payload escalation-agnostic

**File**: `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` (Step 6, around lines 160–174)

**Changes**: Keep `escalation_comment_present` as a boolean metadata field but add a `context_source` field with values `escalation | issue_body | linked_artifact | mixed` so downstream knowledge-graph consumers can see what `ralph-unblock` actually used.

### Success Criteria:

#### Automated Verification:
- [x] `npm test` in `plugin/ralph-hero/mcp-server/` passes (no consumer code changes; this is a SKILL.md doc edit)
- [x] Hook tests still pass: `plugin/ralph-hero/hooks/scripts/unblock-request-postcondition.sh` still allows exit on either `RALPH_UNBLOCK_REQUEST_POSTED=1` or `RALPH_UNBLOCK_QUEUE_EMPTY=1`

#### Manual Verification:
- [ ] Skill description now leads with state-creation, not escalation-parsing
- [ ] Re-reading the SKILL.md cold makes the producer role obvious

---

## Phase 2: End-to-end acceptance test (CRITICAL)

### Overview

Exercise the full chain against a synthetic Human Needed issue **without** a `## Escalation` comment. This is the most common real-world case and the one the prior plan draft did not explicitly verify.

### Changes Required:

#### 1. Add the no-escalation scenario to ralph-unblock eval-scenarios

**File**: `plugin/ralph-hero/skills/ralph-unblock/eval-scenarios.md`

**Changes**: Add (or expand) a scenario titled "Human Needed issue, no `## Escalation` comment" with:
- Setup: issue in Human Needed, body describes a decision needed, no `## Escalation`, no `## Unblock Request`
- Expected behavior: ralph-unblock picks it, reads the body, synthesizes 1–5 grounded questions, posts `## Unblock Request` with `Originating skill: (unknown)`
- Outcome event payload includes `escalation_comment_present: false` and `context_source: issue_body`

#### 2. Add the matching scenario to unblock eval-scenarios

**File**: `plugin/ralph-hero/skills/unblock/eval-scenarios.md`

**Changes**: Add a scenario titled "No `## Escalation` exists, only `## Unblock Request`" with:
- Setup: Human Needed issue with `## Unblock Request` posted by ralph-unblock, no `## Escalation`
- Expected behavior: skill finds the issue, extracts numbered questions, walks the human via `AskUserQuestion`, originating_command = null → default return state = In Progress, confirms via picker, posts `## Unblock Resolution`, transitions

#### 3. Run the end-to-end acceptance test manually

Use a sacrificial issue (not a real ticket) or a draft issue created for this purpose:

```
1. Create draft issue "[acceptance-test] no-escalation unblock flow" in the project
2. Move to Human Needed (save_issue workflowState="__ESCALATE__", command="ralph_impl")
3. Add a brief body describing a real-ish blocker
4. Run /ralph-hero:ralph-unblock → expect ## Unblock Request comment with 1-5 questions
5. Re-run /ralph-hero:ralph-unblock → expect "queue empty" (idempotency)
6. Run /ralph-hero:unblock → expect Q&A walk and transition to In Progress
7. Close the test issue
```

### Success Criteria:

#### Automated Verification:
- [x] Eval scenarios markdown lint clean (no broken cross-references)
- [x] `plugin/ralph-hero/skills/ralph-unblock/eval-scenarios.md` contains a `no-escalation-body-only` scenario with `context_source: "issue_body"` in the expected payload
- [x] `plugin/ralph-hero/skills/unblock/eval-scenarios.md` contains a `no-escalation-request-only` scenario asserting `In Progress` default + null `originating_command`
- [x] Manual acceptance runbook exists at `thoughts/shared/runbooks/2026-05-13-GH-1247-unblock-chain-no-escalation-acceptance.md`

#### Manual Verification:
- [ ] Acceptance test passes end-to-end on a real (sacrificial) issue (run the runbook)
- [ ] `## Unblock Request` is posted with grounded questions even without `## Escalation`
- [ ] `## Unblock Resolution` correctly captures Q&A pairs and routes to In Progress

---

## Phase 3: Supporting — better context when escalations DO happen

### Overview

When producers (ralph-impl, ralph-plan, etc.) escalate, they should post a properly-headered `## Escalation` comment so `ralph-unblock` has richer context for question synthesis and `/ralph-hero:unblock` has `originating_command` for the return-state heuristic. This is **supporting work**, not on the critical path.

### Changes Required:

#### 1. Land worktree commit `2f7ad1a4` (already exists)

**Branch**: `worktree-fix-escalation-header`
**Commit**: `2f7ad1a4` — rewrites `escalation-steps.md` Step 2 to require the `## Escalation` markdown header and include `Originating command: ralph_<cmd>`.

**Action**: Push the branch, open PR, merge.

#### 2. Align `ralph-code-review` escalation comment

**File**: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md` (around line 200 and the protocol row at line 249)

**Changes**: At the 3-rounds-exhausted escalation path, add a second `create_comment` call that posts a canonical `## Escalation` comment alongside the existing `## Code Review` summary. Keep the summary unchanged.

### Success Criteria:

#### Automated Verification:
- [x] `npm test` passes
- [x] No existing tests assume the old single-comment escalation pattern

#### Manual Verification:
- [ ] When ralph-impl or ralph-plan escalates an issue, the resulting Human Needed issue carries a `## Escalation` comment with the canonical body
- [ ] `ralph-unblock` running against that issue extracts originating_command correctly and includes it in the `## Unblock Request`

---

## Phase 4: Supporting — protocol documentation and CI lint

### Overview

Document the optional-but-recommended `## Escalation` header in `artifact-comment-protocol.md` and add a CI lint that catches drift if a new skill adds escalation logic without producing the canonical comment.

### Changes Required:

#### 1. Add `## Escalation` row to `artifact-comment-protocol.md`

**File**: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`

**Changes**: Add a row to the "Existing Headers" table:
```markdown
| `## Escalation` | Issue (Human Needed) | `Escalation: <reason>` + `Originating command: ralph_<cmd>`. **Optional context** consumed by `ralph-unblock` (richer questions) and `/ralph-hero:unblock` (return-state heuristic). | Any skill that escalates to Human Needed via the shared `escalation-steps.md` fragment |
```

Note the explicit **Optional context** wording so future authors don't read this as a hard requirement.

#### 2. Add a CI lint

**File**: `plugin/ralph-hero/scripts/lint-escalation-contract.sh` (new) + a step in `.github/workflows/ci.yml`

**Behavior**: For each skill that contains `__ESCALATE__` or `workflowState.*Human Needed`, verify it produces a `## Escalation` comment (either inline or via the shared fragment include). Exit non-zero with a clear message naming the offending skill.

This lint is advisory — failing it means the skill is escalating without canonical context, which is a hygiene issue, not a correctness issue. (Document this in the script header.)

### Success Criteria:

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/scripts/lint-escalation-contract.sh` exits 0 against main after Phase 3 lands
- [ ] CI step for the lint passes on the PR

#### Manual Verification:
- [ ] `artifact-comment-protocol.md` lists `## Escalation` with the **Optional context** annotation

---

## Testing Strategy

### Unit Tests

Existing `directions-tools.test.ts` already covers `## Unblock Request` discovery and the `## Escalation` newer-than check. No new unit tests needed for Phases 1–2.

### Manual Acceptance (Phase 2)

The synthetic-issue walkthrough described in Phase 2 is the load-bearing verification. Run it once after Phase 1 lands.

### CI Lint (Phase 4)

Catches future drift: if someone adds a new escalating skill without using the shared fragment, the lint fails and the PR can't merge until either (a) the fragment is included or (b) a `## Escalation` comment is posted inline.

## Performance Considerations

None. All changes are markdown and a small shell lint script.

## Migration Notes

- Phase 1 reframes documentation; no runtime behavior change for the consumer-facing flow.
- Phase 2's acceptance test issue can be closed as completed once verified.
- Phase 3 lands the existing worktree commit; new escalations after merge produce canonical `## Escalation` comments. Existing closed Human Needed issues are not retroactively rewritten.
- Phase 4's CI lint is additive; existing main passes once Phase 3 has landed.

## References

- Producer (state creator): `plugin/ralph-hero/skills/ralph-unblock/SKILL.md`
- Consumer (state finder): `plugin/ralph-hero/skills/unblock/SKILL.md`
- Direction signal: `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:148` (`extractUnblockSignal`)
- Existing test fixtures: `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts:374,411`
- Worktree (Phase 3 work-in-progress): branch `worktree-fix-escalation-header` at commit `2f7ad1a4`
- Original unblock plan: `thoughts/shared/plans/2026-05-08-GH-1142-ralph-hero-unblock-skill.md`
- Protocol doc: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`
