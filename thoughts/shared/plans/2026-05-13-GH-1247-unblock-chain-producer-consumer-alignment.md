---
date: 2026-05-13
status: draft
type: plan
tags: [skills, escalation, unblock, human-needed, contract]
github_issue: 1247
github_issues: [1247]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1247
primary_issue: 1247
---

# Unblock Chain Producer-Consumer Alignment

## Prior Work

- builds_on:: [[2026-05-08-GH-1142-ralph-hero-unblock-skill]]
- Related research: thoughts/shared/research/2026-04-22-agent-bus-design.md

## Overview

The Human Needed unblock chain — autonomous `ralph-hero:ralph-unblock`, interactive `/ralph-hero:unblock`, and the MCP `human-needed-unblock` direction signal — is correctly wired on the consumer side. All three consumers discover escalation context by matching comments whose body starts with the `## Escalation` markdown header. The producer side has drifted: the shared `escalation-steps.md` fragment used by seven skills tells producers to post non-headered `"@user Escalation: ..."` plain text, and `ralph-code-review` posts its escalation context under a different header (`## Code Review`). The net effect: no escalation produced by current skills is discoverable by the unblock chain, so `/ralph-hero:unblock` has never had real input to work with.

This plan brings producers in line with the documented contract, makes the contract explicit in `artifact-comment-protocol.md`, and adds a CI lint so future drift is caught before merge.

## Current State Analysis

**Consumers (all require `body.startsWith("## Escalation")`):**

- `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:82,104,170` — finds escalation comment to drive question synthesis, idempotency guard, and outcome payload.
- `plugin/ralph-hero/skills/unblock/SKILL.md:65,75` — extracts `originating_command` and reason text to drive the return-state heuristic.
- `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:122,148` — emits the `human-needed-unblock` direction surfaced by `/hello`.
- Test fixtures in `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts:374,411` already encode the `## Escalation\n\n…` body shape.

**Producers (current state):**

- `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md:29-32` — included via `!cat` by `ralph-research`, `ralph-impl`, `ralph-plan`, `ralph-split`, `ralph-triage`, `ralph-review`, and `hero`. **Fixed in worktree branch `worktree-fix-escalation-header` (commit `2f7ad1a4`).** Not yet merged. The new Step 2 requires the `## Escalation` markdown header, keeps `Escalation: <reason>` for reason extraction, and adds `Originating command: ralph_<cmd>` for the consumer's heuristic.
- `plugin/ralph-hero/skills/ralph-code-review/SKILL.md:249` — escalates after 3 review rounds with a `## Code Review` summary comment, **not** `## Escalation`. The unblock chain cannot extract context from these escalations.
- `plugin/ralph-hero/skills/ralph-plan-epic/SKILL.md:337` — explicitly references `` `## Escalation` `` in its escalation row. Self-conforming; no change needed.
- `plugin/ralph-hero/skills/ralph-review/SKILL.md:344` — defers to "per the Escalation Protocol below" which `!cat`s the shared fragment. Picks up the fragment fix transitively.

**Protocol documentation:**

- `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md` lists `## Unblock Request` and references "extracted from `## Escalation`" but does **not** list `## Escalation` as its own row in the comment-headers table. The convention is implicit, which is how it drifted.

### Key Discoveries

- `extractUnblockSignal` in `directions-tools.ts:148` requires `body.startsWith("## Escalation")` — there is no fallback parser for plain-text "Escalation:" lines.
- The autonomous skill's idempotency rule (`ralph-unblock` Step 2: "skip if `## Unblock Request` exists AND its createdAt is newer than the most recent `## Escalation`") silently degenerates when no Escalation comment is discoverable — the rule becomes "if any Unblock Request exists, skip", so re-escalations on the same issue never trigger a new Unblock Request.
- Both unblock skills' `eval-scenarios.md` already document the canonical `## Escalation` format; they were authored against the intended contract, not the deployed implementation.

## Desired End State

- Every skill that transitions an issue to "Human Needed" also posts a `## Escalation` comment whose body starts with the `## Escalation` markdown header and contains both `Escalation: <reason>` and `Originating command: ralph_<cmd>` lines.
- `/ralph-hero:unblock` reliably identifies `originating_command` and applies the right return-state default (Research Needed / Ready for Plan / In Progress / Backlog).
- End-to-end flow works: an escalation lands → `ralph-unblock` posts `## Unblock Request` → human runs `/ralph-hero:unblock` → answers questions → issue routes back into the pipeline → hero loop continues.
- `artifact-comment-protocol.md` lists `## Escalation` explicitly so future skills can't accidentally diverge from the contract.
- A CI lint fails if a skill is added that transitions to Human Needed without producing a `## Escalation` comment.

### Verification

- **Manual end-to-end test**: create a synthetic Human Needed issue with a canonical `## Escalation` comment; run `ralph-hero:ralph-unblock`; verify it posts a `## Unblock Request`; re-run to confirm idempotency; run `/ralph-hero:unblock`; verify originating_command extraction, Q&A walk, `## Unblock Resolution` posting, and state transition.
- **Automated**: existing `directions-tools.test.ts` continues to pass (the producer fix aligns with the fixtures already there). New CI lint catches future drift.

## What We're NOT Doing

- **Not modifying the consumer parsers** — they're correct as-is.
- **Not changing the state machine or `human-needed-outbound-block.sh`** — `ralph_unblock` already has the necessary wiring (validated by `unblock-state-gate.sh`).
- **Not adding new escalation channels** (Slack, PagerDuty, etc.) — out of scope.
- **Not unifying all artifact comment headers** — scope is the `## Escalation` divergence only.
- **Not releasing/publishing a new plugin version** — `release.yml` handles that when MCP server source changes; skill-only changes ship via the plugin cache update path the user already operates.
- **Not retroactively rewriting historical escalation comments** — closed issues stay as-is.

## Implementation Approach

Three small, sequential phases. Phase 1 lands the existing worktree commit. Phase 2 fixes the one remaining non-conforming producer. Phase 3 documents the contract and adds CI enforcement so this can't drift again.

---

## Phase 1: Land the shared-fragment fix

### Overview

Push the existing `worktree-fix-escalation-header` branch, open a PR, and merge it.

### Changes Required:

#### 1. Fragment fix (already committed in worktree)

**File**: `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md`
**Changes**: Step 2 rewritten to require the `## Escalation` markdown header, preserve the @mention, retain `Escalation: <reason>` for reason extraction, and add `Originating command: ralph_<cmd>` for the consumer's return-state heuristic. The diff is +20/-2 (commit `2f7ad1a4`).

#### 2. PR creation

**Branch**: `worktree-fix-escalation-header` → `main`
**Title**: `fix(skills): post escalations with ## Escalation header so unblock chain works`
**Body**: Summarize the producer-consumer mismatch, name the 7 skills that include the fragment, and link to this plan.

### Success Criteria:

#### Automated Verification:
- [ ] CI passes on the PR
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` passes (especially `directions-tools.test.ts`)

#### Manual Verification:
- [ ] PR is merged into `main`
- [ ] Plugin cache refreshes locally; new escalations posted by any of the 7 skills produce a `## Escalation`-headered comment

---

## Phase 2: Align ralph-code-review escalation with the contract

### Overview

When `ralph-code-review` hits 3 exhausted review rounds and escalates, it must produce a comment discoverable by the unblock chain. Currently it posts only a `## Code Review` summary; this phase keeps that summary (it has its own audit-trail value) and adds a separate `## Escalation` comment.

### Changes Required:

#### 1. Add `## Escalation` comment to the round-exhausted escalation step

**File**: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md`
**Changes**: At the existing `__ESCALATE__` step (currently the 3-rounds-exhausted path around line 200 and the Escalation Protocol row at line 249), add a second `create_comment` call that posts the canonical `## Escalation` body. Keep the existing `## Code Review` summary comment unchanged — it remains the round-by-round audit trail.

Canonical body to post:

```markdown
## Escalation

@$RALPH_GH_OWNER

Escalation: Code review loop exhausted after 3 rounds without converging. See ## Code Review comment for round-by-round details.

Originating command: ralph_code_review
```

#### 2. Update the Escalation Protocol table entry

**File**: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md:249`
**Changes**: Update the table row from `"Escalate via __ESCALATE__ → 'Human Needed', post ## Code Review summary comment"` to `"Escalate via __ESCALATE__ → 'Human Needed', post BOTH ## Code Review summary comment AND ## Escalation comment for unblock chain discovery"`.

### Success Criteria:

#### Automated Verification:
- [ ] `npm test` passes
- [ ] No existing tests reference the old single-comment escalation pattern

#### Manual Verification:
- [ ] Force a 3-round-exhausted code review on a test PR (e.g., a sacrificial branch with intentional persistent issues); confirm both `## Code Review` and `## Escalation` comments are posted on the issue
- [ ] Run `ralph-hero:ralph-unblock` against the resulting Human Needed issue; confirm it parses the `## Escalation` comment and posts a useful `## Unblock Request`

---

## Phase 3: Document the contract and add CI enforcement

### Overview

Make the `## Escalation` header a first-class entry in `artifact-comment-protocol.md` and add a CI lint that fails when any skill transitions to Human Needed without producing a `## Escalation` comment.

### Changes Required:

#### 1. Add `## Escalation` row to artifact-comment-protocol

**File**: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`
**Changes**: Add a row to the "Existing Headers" table immediately above the `## Implementation Plan` row:

```markdown
| `## Escalation` | Issue (Human Needed) | `Escalation: <reason>` + `Originating command: ralph_<cmd>` (consumed by `ralph-unblock`, `/ralph-hero:unblock`, and the `human-needed-unblock` direction signal) | Any skill that escalates to Human Needed (via the shared `escalation-steps.md` fragment) |
```

#### 2. Add the lint script

**File**: `plugin/ralph-hero/scripts/lint-escalation-contract.sh` (new)
**Behavior**:
- For each `plugin/ralph-hero/skills/*/SKILL.md` file
- Check if the file contains either `__ESCALATE__` or `workflowState.*Human Needed`
- If yes, verify the file also contains either `!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/escalation-steps.md` (the fragment include) OR `## Escalation` inline
- Exit non-zero with a clear message listing any offending skill files

Stub:
```bash
#!/usr/bin/env bash
set -euo pipefail
fail=0
for skill in plugin/ralph-hero/skills/*/SKILL.md; do
  # Skip the consumer skills themselves (ralph-unblock, unblock) and skills that don't escalate
  if grep -qE '__ESCALATE__|workflowState.*Human Needed' "$skill"; then
    # Already consumes the contract (ralph-unblock, unblock)
    if grep -qE '## Unblock (Request|Resolution)' "$skill"; then
      continue
    fi
    # Produces a ## Escalation comment (inline or via shared fragment)
    if grep -qE 'escalation-steps\.md|## Escalation' "$skill"; then
      continue
    fi
    echo "FAIL: $skill transitions to Human Needed but does not produce a ## Escalation comment" >&2
    fail=1
  fi
done
exit "$fail"
```

#### 3. Wire the lint into CI

**File**: `.github/workflows/ci.yml`
**Changes**: Add a job step (in the existing build matrix or a new `lint` job) that runs `bash plugin/ralph-hero/scripts/lint-escalation-contract.sh` from the repo root.

### Success Criteria:

#### Automated Verification:
- [ ] `bash plugin/ralph-hero/scripts/lint-escalation-contract.sh` exits 0 against `main` after Phases 1 and 2 are merged
- [ ] Reverting Phase 1's fragment fix locally causes the lint to fail (proves it catches drift)
- [ ] CI job for the new step passes on the PR

#### Manual Verification:
- [ ] `artifact-comment-protocol.md` table now lists `## Escalation` explicitly
- [ ] The lint script is readable and its failure messages clearly point at the offending file

---

## Testing Strategy

### Unit Tests

Existing `directions-tools.test.ts` tests already cover the consumer parser with `## Escalation`-headered fixtures (lines 374, 411). No new unit tests needed — the producer fix aligns with what those tests already assume.

### Integration Test (Manual, post-Phase-1)

1. Create a synthetic Human Needed test issue:
   - Title: `[test] unblock chain end-to-end`
   - Use `save_issue(workflowState="__ESCALATE__", command="ralph_impl")` to land it in Human Needed.
   - Post a `## Escalation` comment via `create_comment` with the canonical body (header, `Escalation:` line, `Originating command: ralph_impl` line).
2. Run `ralph-hero:ralph-unblock`. Verify it posts a `## Unblock Request` with 1–5 questions grounded in the escalation reason.
3. Re-run `ralph-hero:ralph-unblock`. Verify idempotency — it skips the issue (Unblock Request is newer than Escalation).
4. Run `/ralph-hero:unblock`. Walk through the questions, confirm the heuristic default is `In Progress` (because originating_command = `ralph_impl`), accept it.
5. Verify the issue is now in `In Progress`, the `## Unblock Resolution` comment is posted with question/answer pairs, and the issue is back in the hero loop.

### CI Lint

After Phase 3 lands, `plugin/ralph-hero/scripts/lint-escalation-contract.sh` runs in CI and catches any future skill that adds `__ESCALATE__` without producing a `## Escalation` comment.

## Performance Considerations

None. All changes are documentation, markdown skill content, and a small shell lint script.

## Migration Notes

Existing closed Human Needed issues with the old plain-text format will not retroactively get a `## Escalation` header. They're closed; no data migration required. New escalations after Phase 1 lands use the canonical format. Issues currently open in Human Needed (none on this board as of 2026-05-13) would need a manual `## Escalation` comment added to be discoverable by the unblock chain — flag this in the PR description.

## References

- Worktree branch: `worktree-fix-escalation-header` at commit `2f7ad1a4`
- Original unblock plan: `thoughts/shared/plans/2026-05-08-GH-1142-ralph-hero-unblock-skill.md`
- Producer (fixed): `plugin/ralph-hero/skills/shared/fragments/escalation-steps.md`
- Producer needing alignment: `plugin/ralph-hero/skills/ralph-code-review/SKILL.md:249`
- Consumer parsers:
  - `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:82`
  - `plugin/ralph-hero/skills/unblock/SKILL.md:65`
  - `plugin/ralph-hero/mcp-server/src/tools/directions-tools.ts:148`
- Consumer fixtures (already canonical): `plugin/ralph-hero/mcp-server/src/__tests__/directions-tools.test.ts:374,411`
- Protocol doc: `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`
