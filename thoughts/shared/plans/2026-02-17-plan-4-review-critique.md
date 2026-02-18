---
date: 2026-02-17
status: needs-iteration
type: critique
plan_document: thoughts/shared/plans/2026-02-17-plan-4-memory-layer-state-coherence.md
---

# Plan 4: Memory Layer & State Coherence — Review Critique

## Verdict: NEEDS ITERATION

The plan correctly identifies a real problem (context passing fragility) and proposes a sensible solution (GitHub comments as primary context channel). However, several factual inaccuracies about the current state, a critical hook registration gap, edge cases around group issues, and a comment-limit risk undermine implementation confidence. These are fixable without rethinking the architecture.

---

## Issue 1: Research Skill Does NOT Post `## Research Document` Header (CRITICAL)

**Plan claim (lines 48-49)**: "Research skill posts `## Research Document\n[link]` as a comment"

**Actual state**: The research skill (`ralph-research/SKILL.md`) Step 5 says:
> 1. **Add research document link** as comment with GitHub URL to the committed file
> 2. **Add summary comment** with key findings...

It does NOT specify the `## Research Document` header format. The instructions just say "add research document link as comment" — the exact format is left to agent interpretation. Meanwhile, the *consumer* (ralph-plan SKILL.md Step 2) already looks for `## Research Document` in comments, creating a fragile implicit contract.

**Impact**: The plan's "What Works Well" section overstates current reliability. Phase 3 Step 4 ("Verify research skill posts standardized comment") is the right fix, but the plan should acknowledge this is a *new requirement* to add, not a verification of existing behavior.

**Fix**: In "Current State Analysis > What Works Well", change to: "The plan skill posts `## Implementation Plan` comments. The research skill posts a research link comment but does NOT use the standardized `## Research Document` header — this must be added."

---

## Issue 2: Hook Registration Missing for `artifact-discovery.sh` (CRITICAL)

**Plan Phase 2** creates `artifact-discovery.sh` and says "Register in skill frontmatter" but then only shows adding `env` variables (`RALPH_REQUIRES_RESEARCH`, `RALPH_REQUIRES_PLAN`). The hook itself is **never registered** in either:
- Skill frontmatter `hooks:` blocks, or
- Plugin-level `hooks.json`

Without registration, the script will never execute. The `env` variables alone do nothing — no hook is wired to read them and run the script.

**Fix**: Phase 2 must add hook registrations to skill frontmatter. Example for ralph-plan:
```yaml
hooks:
  PreToolUse:
    - matcher: "ralph_hero__update_workflow_state"
      hooks:
        - type: command
          command: "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/artifact-discovery.sh"
```

---

## Issue 3: `comments(last: 10)` Limit Risks Missing Artifact Comments (HIGH)

The `get_issue` MCP tool fetches `comments(last: 10)` — only the most recent 10 comments. For active issues with many status updates, plan comments, review comments, and implementation comments, the research document comment (posted earliest in the pipeline) could be pushed out of the 10-comment window.

**Example scenario**: An issue with research comment (#1), plan comment (#2), plan phase summary (#3), plan review (#4), approval comment (#5), implementation status comments (#6-10+), and implementation complete comment — the research comment is comment #1 and may not appear in the last 10.

**Plan does not address this**. The "Performance Considerations" section (line 558) says "GitHub API calls for issue fetch include comments — no additional API calls needed" which is optimistic given the 10-comment cap.

**Fix options**:
1. Increase `comments(last: N)` in the MCP tool to 25 or 50
2. Document the limit and have the fallback handle it (already covered by glob fallback, but the plan should acknowledge this as a known limitation)
3. Add a pagination parameter to `get_issue` for comments

---

## Issue 4: Review Comment Header Mismatch (MEDIUM)

**Plan protocol (line 111)**: Defines `## Plan Review` as the review section header.

**Actual review skill**: Posts `## Plan Approved` or `## Plan Needs Iteration` — two different headers depending on outcome.

These are semantically different from `## Plan Review`. A consumer searching for `## Plan Review` would find nothing. The plan must either:
1. Change the protocol to match reality (`## Plan Approved` / `## Plan Needs Iteration`), or
2. Update the review skill to post `## Plan Review` with an `APPROVED` / `NEEDS_ITERATION` status line

Option 1 is simpler but means consumers need to search for two headers. Option 2 is cleaner for the protocol.

---

## Issue 5: Group Issue Glob Fallback Fails for Non-Primary Issues (MEDIUM)

For a group plan covering issues #42, #43, #44, the plan filename is `2026-02-17-group-GH-0042-auth-suite.md` (uses primary issue number #42). If ralph-impl is invoked with issue #43, the glob fallback `thoughts/shared/plans/*GH-{43}*` will NOT find this file because the filename contains `GH-0042`, not `GH-0043`.

The plan mentions this naming convention (line 168: `thoughts/shared/plans/YYYY-MM-DD-group-GH-NNNN-description.md`) but doesn't address how non-primary issues discover the group plan via glob.

**Fix**: The glob fallback for group members should:
1. First try `*GH-{number}*`
2. If not found, check issue comments/body for the primary issue number
3. Try `*group*GH-{primary}*`

Or: add a comment to ALL group issues with the plan link (which the plan skill already does in Step 5 — so the comment path works, but the glob fallback is broken for groups).

---

## Issue 6: Zero-Padding Inconsistency in Issue Numbers (MEDIUM)

Existing artifacts use zero-padded 4-digit numbers: `GH-0030`, `GH-0019`, `GH-0042`. The plan's protocol shows `GH-NNNN` notation (suggesting zero-padding), and examples show `GH-0042`.

But the glob fallback patterns use `*GH-{number}*` where `{number}` comes from the tool response (plain integer, not zero-padded). Searching `*GH-42*` won't match a file named `*GH-0042*`.

The existing hooks (`plan-research-required.sh`, `impl-plan-required.sh`) use `grep -oE 'GH-[0-9]+'` which matches either format in *filenames*, but the `find_existing_artifact()` function searches `*${ticket_id}*` — if ticket_id is `GH-42`, it won't match `GH-0042`.

**Fix**: The protocol must either:
1. Standardize on zero-padded numbers and ensure glob patterns zero-pad, or
2. Standardize on non-padded numbers and rename existing artifacts, or
3. Make the glob pattern try both: `*GH-{number}*` and `*GH-{padded_number}*`

---

## Issue 7: Phase 4 Partially Duplicates Phase 3 (LOW)

Phase 3, Step 2 (ralph-impl update) already includes self-healing at substep 6:
> **If fallback found, self-heal**: Post the missing comment to the issue

Phase 4 then lists ralph-impl again as a skill to add self-healing to. This is redundant — Phase 4 only adds self-healing for ralph-plan and ralph-review that wasn't already in Phase 3.

**Fix**: Phase 4 should explicitly state: "ralph-impl self-healing was already added in Phase 3 Step 2. This phase adds self-healing to ralph-plan and ralph-review only."

---

## Issue 8: Multiple Comments with Same Header — No Disambiguation (LOW)

If research is run twice (e.g., after plan rejection forces re-research), the issue may have two `## Research Document` comments. The protocol says "search comments for the section header" but doesn't specify which match to use.

**Fix**: Add to protocol: "If multiple comments match the same section header, use the **most recent** (last) match."

---

## Issue 9: Test Script Limitations (LOW)

The `test-memory-layer.sh` script (Phase 5) only checks the local filesystem. It doesn't verify GitHub comments exist, which is the entire point of the memory layer. It tells the user to manually run `gh issue view` instead.

The script could easily check comments via:
```bash
gh api "repos/$OWNER/$REPO/issues/$ISSUE_NUMBER/comments" --jq '.[].body' | grep -q "## Research Document"
```

Additionally, the script uses `ls` with glob patterns which is fragile for filenames with spaces (though unlikely here).

**Fix**: Add automated GitHub comment verification to the script. This is the core validation this plan needs.

---

## Issue 10: `RALPH_REQUIRES_PLAN` Already Exists in ralph-impl (INFORMATIONAL)

Phase 2 proposes adding `RALPH_REQUIRES_PLAN: "true"` to ralph-impl's env. This is already present (line 36 of ralph-impl SKILL.md). The plan's Phase 2 Step 2 is a no-op for this specific change.

Not a bug — just worth noting that the existing `RALPH_REQUIRES_PLAN` drives `impl-plan-required.sh` (filesystem-based check), not the proposed `artifact-discovery.sh` (comment-based check). Both would coexist.

---

## Summary of Required Changes

| # | Severity | Issue | Action |
|---|----------|-------|--------|
| 1 | CRITICAL | Research skill doesn't post `## Research Document` | Acknowledge as new requirement, not verification |
| 2 | CRITICAL | Hook not registered | Add hook registration to skill frontmatter |
| 3 | HIGH | 10-comment limit | Increase limit or document as known limitation |
| 4 | MEDIUM | Review header mismatch | Align protocol with actual headers |
| 5 | MEDIUM | Group glob fallback broken | Document limitation or add primary-issue lookup |
| 6 | MEDIUM | Zero-padding mismatch | Standardize padding or make glob try both |
| 7 | LOW | Phase 4 duplicates Phase 3 for impl | Clarify scope |
| 8 | LOW | Multiple same-header comments | Add "use most recent" rule |
| 9 | LOW | Test script filesystem-only | Add GitHub comment checks |
| 10 | INFO | RALPH_REQUIRES_PLAN already exists | Note coexistence |

**Recommendation**: Fix issues 1-6 before implementation. Issues 7-10 can be addressed during implementation.

---

## What the Plan Gets Right

- **Core architecture is sound**: GitHub comments as the primary context channel is the right call. It survives session crashes, is queryable, and doesn't require custom infrastructure.
- **Fallback strategy is good**: Comment-first with glob fallback is pragmatic and handles the 80% case.
- **Self-healing is valuable**: Auto-posting missing comments reduces manual intervention.
- **Warn-not-block for hooks is correct**: The hook can't make API calls, so blocking would cause false negatives. Warning is the right design.
- **Incremental rollout**: Phased approach (protocol → hooks → skill updates → self-heal → verify) is well-ordered.
- **No over-engineering**: Reuses existing infrastructure (MCP tools, comment format, glob patterns) rather than building new systems.
