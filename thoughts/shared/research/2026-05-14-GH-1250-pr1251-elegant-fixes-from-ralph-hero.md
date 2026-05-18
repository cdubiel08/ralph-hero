---
date: 2026-05-14
github_issue: 1250
github_url: https://github.com/cdubiel08/ralph-hero/issues/1250
github_pr: 1251
github_pr_url: https://github.com/cdubiel08/ralph-hero/pull/1251
topic: "Inspiration from ralph-hero itself for handling the three score-75 review findings on PR #1251 (GH-1250) more elegantly"
tags: [research, code-review, hooks, verdicts, postconditions, env-vars, model-tier]
status: complete
type: research
git_commit: cf65b1c3ee1e8038b96186ee5c5f32d460570ad4
branch: main
---

# Research: Elegant in-repo handling of the three score-75 PR #1251 findings

## Prior Work

- builds_on:: [[2026-05-13-GH-1250-model-tier-optimization-hero]] (plan — describes intent for the PR being reviewed)
- builds_on:: [[2026-05-14-GH-1250-critique-v2]] (review — plan critique that approved Phase 3 transcript-grep mechanism)
- tensions:: none surfaced

## Research Question

Can any of the three score-75 review findings on PR #1251 be handled more elegantly by reusing patterns already present in ralph-hero?

The three findings:

1. **BLOCKED verdict prefix mismatch** — `hero/SKILL.md` checks `IMPL BLOCKED needs=opus`, but `ralph-impl/SKILL.md` instructs the agent to emit `IMPL BLOCKED model=<x> needs=opus reason=<short>`. Substring match will fail; LLM-prose interpretation may still work.
2. **CLAUDE.md env var docs gap** — `RALPH_IMPL_MODEL` and `RALPH_SPLIT_MODEL` are introduced but absent from the canonical Environment Variables table in `CLAUDE.md`.
3. **Missing `stop_hook_active` guard** — new Stop-hook logic in `impl-postcondition.sh` and `plan-postcondition.sh` claims to mirror `val-postcondition.sh:28-37` but omits the `stop_hook_active` short-circuit at `val-postcondition.sh:19-22`.

## Summary

ralph-hero already contains two canonical patterns that, if applied, dissolve findings #1 and #3 entirely. Finding #2 has no automation precedent — the most elegant available move is to keep the existing CLAUDE.md table as the single source of truth and add the two new rows. Detail:

- **Finding #1** is best addressed by adopting the **env-var verdict pattern** used by `triage-postcondition.sh` and `split-postcondition.sh` (skill exports `RALPH_*` → postcondition reads via bash `case` / numeric check). The existing transcript-grep approach in `val-postcondition.sh` is the second-best precedent and is the one the PR partially mirrored. Either pattern is more robust than embedding a literal substring (`IMPL BLOCKED needs=opus`) in two separate LLM-prose documents that must stay in lockstep.
- **Finding #3** is best addressed by promoting the four-line `stop_hook_active` short-circuit from `val-postcondition.sh:19-22` into a shared helper in `hook-utils.sh` (alongside `block`, `warn`, `allow`). Every Stop-hook script then becomes a single function call. This is the same pattern `hook-utils.sh` already uses for exit handling.
- **Finding #2** has no in-repo automation pattern to borrow. The CLAUDE.md table at lines 262-272 is the canonical RALPH_* env var registry. The fix is just to add two rows.

## Detailed Findings

### Pattern 1 — Env-var verdict signaling (applies to Finding #1)

ralph-hero has two distinct verdict-signaling patterns in production:

**Pattern 1a — Transcript-grep markers (used by val)**

- File: `plugin/ralph-hero/hooks/scripts/val-postcondition.sh:30`
- Quote: `grep -qE 'VALIDATION PASS|VALIDATION FIX|VALIDATION FAIL|Queue empty' "$TRANSCRIPT_PATH"`
- The hook accepts a single unified regex covering all four terminal verdicts. The skill's authoring guidance (per the codebase-locator findings) explicitly warns: *"Do NOT substitute other status words... Use the literal 'VALIDATION PASS|FIX|FAIL' prefix verbatim."*
- This pattern keeps emit-format and detect-format in a single regex character class, so a documentation drift cannot create a partial mismatch.

**Pattern 1b — Env-var signaling (used by triage, split, unblock)**

- File: `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh:32-50`
- Quote: `triage_action="${RALPH_TRIAGE_ACTION:-}"` … `case "$triage_action" in RESEARCH|SPLIT|CLOSE|KEEP|HUMAN|CANCEL|RE-ESTIMATE) echo "Triage postcondition passed"`
- File: `plugin/ralph-hero/hooks/scripts/split-postcondition.sh:32-37`
- Quote: `split_count="${RALPH_SPLIT_COUNT:-0}"` … `if [[ "$split_count" -gt 0 ]]; then echo "Split postcondition passed"`
- Skills export an env var (`RALPH_TRIAGE_ACTION`, `RALPH_SPLIT_COUNT`); the postcondition reads it via bash `case` or numeric comparison. No text parsing, no transcript walk.
- All three env-var hooks share a `RALPH_FORCE_STOP=true` escape hatch (`triage-postcondition.sh:22-24`, `split-postcondition.sh:22-24`, `unblock-request-postcondition.sh:29-31`) for audited bypass.

**How this applies to Finding #1:**

The PR's current design tries to thread BLOCKED detection through two surfaces simultaneously:

- `impl-postcondition.sh` uses transcript-grep (`grep -qE 'IMPL BLOCKED '`, unanchored — works correctly)
- `hero/SKILL.md` uses LLM-prose substring instruction (`If it begins with 'IMPL BLOCKED needs=opus'` — partial drift from emitted format)

There are at least three more-elegant in-repo precedents:

a. **Promote BLOCKED to the env-var pattern.** Have `ralph-impl` export `RALPH_IMPL_NEEDS_ESCALATION=opus` (and optionally `RALPH_IMPL_BLOCKED_REASON=<short>`) on the BLOCKED branch. `impl-postcondition.sh` reads it via `case`; hero checks the same env var post-dispatch. One source of truth, no string-prefix drift possible. Mirrors `triage-postcondition.sh` exactly.

b. **Reuse the existing `Status: BLOCKED` marker.** The canonical implementer report format at `plugin/ralph-hero/skills/ralph-impl/implementer-prompt.md:72` already specifies `Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`. The new `IMPL BLOCKED model=X needs=opus reason=Y` is a parallel marker that duplicates the existing one. Hero could parse `Status: BLOCKED` (already emitted) and read a separate one-liner `Escalation: needs=opus reason=<short>` field.

c. **Unify under one regex.** Adopt val's pattern verbatim: have hero's prose say *"If the transcript matches `IMPL BLOCKED `, escalate to opus"* (unanchored — same regex `impl-postcondition.sh` already uses). This is the smallest possible change; it deletes the `needs=opus` substring requirement entirely and treats every BLOCKED as an escalation candidate (with reason parsed downstream if needed).

### Pattern 2 — Shared hook helpers in `hook-utils.sh` (applies to Finding #3)

`plugin/ralph-hero/hooks/scripts/hook-utils.sh` already centralizes common postcondition logic as named functions:

- `read_input()` (lines 11-16) — caches stdin to `$RALPH_HOOK_INPUT`
- `get_field()` (lines 19-22) — extracts JSON field via jq
- `get_tool_name()`, `get_tool_input()`, `get_agent_type()` (lines 24-40)
- `block()` (lines 48-58), `warn()` (lines 60-65), `allow()` (lines 67-70) — exit handlers with consistent stderr framing
- `check_branch()` (lines 72-90), `get_ticket_id()` (lines 92-111), `validate_state()` (lines 113-127)
- `ticket_id_alt_form()` (lines 133-142), `find_existing_artifact()` (lines 147-167)
- `allow_with_context()` (lines 169-182), `is_semantic_intent()` (lines 184-195), `get_valid_output_states()` (lines 197-202)

**Notably absent**: `check_stop_hook_active()`. The four-line guard from `val-postcondition.sh:19-22` lives only in that one script:

```bash
INPUT=$(cat)
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi
```

**Stop-hook coverage today** (from codebase-locator):

| Script | Has `stop_hook_active` guard |
|---|---|
| `val-postcondition.sh` | yes (lines 19-22) |
| `research-postcondition.sh` | no |
| `plan-postcondition.sh` | no |
| `impl-postcondition.sh` | no |
| `split-postcondition.sh` | no |
| `triage-postcondition.sh` | no |
| `review-postcondition.sh` | no |
| `unblock-request-postcondition.sh` | no |

**How this applies to Finding #3:**

The elegant fix is the same as how `block`/`warn`/`allow` already work: promote the guard into `hook-utils.sh` and have every Stop hook call it after `read_input`. Sketch:

```bash
# In hook-utils.sh — add alongside block/warn/allow:
check_stop_hook_active() {
  local stop_active
  stop_active=$(get_field '.stop_hook_active')
  if [[ "$stop_active" == "true" ]]; then
    exit 0
  fi
}
```

Each postcondition's preamble then collapses to:

```bash
source "$(dirname "$0")/hook-utils.sh"
read_input > /dev/null
check_stop_hook_active
```

This is bit-identical in behavior to the val-postcondition guard, mirrors the existing helper-function aesthetic of `hook-utils.sh`, and removes the per-script copy-paste hazard that the PR review flagged. It is a strict superset of what PR #1251 adds to `impl-postcondition.sh` and `plan-postcondition.sh`, and it backfills coverage for the five other postconditions that have silently lacked the guard.

The `triage`/`split`/`unblock` postconditions also accept a `RALPH_FORCE_STOP=true` audited bypass (`triage-postcondition.sh:22-24`). If `check_stop_hook_active` is added, a sibling `check_force_stop` helper could replace the three copies of that bypass block as well — but that is out of scope for the immediate review fix.

### Pattern 3 — Env var registry (applies to Finding #2)

No automation exists. The canonical surfaces:

- `/Users/dubiel/projects/ralph-hero/CLAUDE.md:262-272` — table with columns `Variable | Required | Description`, currently 9 RALPH_* vars (token, owner, project number, repo, project numbers, repo token, project token, project owner, debug). This is the single source of truth.
- `plugin/ralph-hero/README.md:213-227` — partial table with 5 vars (different subset). Already drifted from CLAUDE.md.
- `plugin/ralph-hero/skills/hero/SKILL.md:515-520` — frontmatter documents per-skill env vars (`RALPH_REVIEW_*`, `RALPH_COMMAND`, `RALPH_GH_*`).
- The new `RALPH_IMPL_MODEL` / `RALPH_SPLIT_MODEL` are mentioned only in `thoughts/shared/plans/2026-05-13-GH-1250-model-tier-optimization-hero.md` (7 occurrences) and `plugin/ralph-hero/docs/model-tier-policy.md`.

**No checker exists** in `.github/workflows/`, `plugin/ralph-hero/scripts/`, or `plugin/ralph-hero/hooks/scripts/` that scans for undocumented `RALPH_*` references. The "single source of truth" is enforced socially, not mechanically.

**How this applies to Finding #2:**

There is no in-repo elegance to borrow. The minimal action is to add two rows to the CLAUDE.md table:

| Variable | Required | Description |
|---|---|---|
| `RALPH_IMPL_MODEL` | No | Override impl-agent model (sonnet/opus). Used by the BLOCKED-escalation path to re-dispatch on opus. See `plugin/ralph-hero/docs/model-tier-policy.md`. |
| `RALPH_SPLIT_MODEL` | No | Override split-agent model (sonnet/opus). |

If a more ambitious move is wanted later, a `scripts/lint-env-vars.sh` that greps `plugin/ralph-hero/` for `RALPH_[A-Z_]+` and diffs against the CLAUDE.md table would be the canonical place to add the check — it would live alongside the existing `scripts/activity/logrotate.sh`-style operational scripts. Not necessary for the current PR.

## Code References

- `plugin/ralph-hero/hooks/scripts/val-postcondition.sh:19-22` — canonical `stop_hook_active` guard
- `plugin/ralph-hero/hooks/scripts/val-postcondition.sh:30` — canonical unified-regex verdict detection
- `plugin/ralph-hero/hooks/scripts/triage-postcondition.sh:32-50` — env-var verdict pattern (case-based)
- `plugin/ralph-hero/hooks/scripts/split-postcondition.sh:32-37` — env-var verdict pattern (numeric)
- `plugin/ralph-hero/hooks/scripts/unblock-request-postcondition.sh:29-31` — RALPH_FORCE_STOP escape hatch
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh:48-70` — existing `block`/`warn`/`allow` helper trio (where `check_stop_hook_active` would naturally live)
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh:11-22` — `read_input` / `get_field` helpers that a new `check_stop_hook_active` would compose on top of
- `plugin/ralph-hero/skills/ralph-impl/implementer-prompt.md:72` — canonical `Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED` report format already in production
- `CLAUDE.md:262-272` — canonical RALPH_* env var table

## Architecture Documentation

Two distinct postcondition-verdict architectures coexist in ralph-hero today:

- **Transcript-grep family** — single script: `val-postcondition.sh`. Verdict lives in the agent's terminal output, picked up by `grep -qE 'PATTERN'` on the transcript JSONL file. Strength: no skill→hook coupling beyond the literal marker string. Weakness: literal marker drift across documents (the exact failure mode flagged in PR #1251 finding #1).
- **Env-var family** — `triage-postcondition.sh`, `split-postcondition.sh`, `unblock-request-postcondition.sh`. Skill exports `RALPH_*` env var before stopping; hook reads it via `${VAR:-default}` and `case`/numeric branch. Strength: typed enum surface, no string-prefix matching, audited `RALPH_FORCE_STOP` escape hatch. Weakness: requires the skill to actually export the var before its final tool call (contract is more procedural than a marker string).

`hook-utils.sh` is the canonical place for shared postcondition logic; both families source it. Adding `check_stop_hook_active()` and (later) `check_force_stop()` there would unify Stop-hook safety guards across both families.

## Historical Context (from thoughts/)

- `thoughts/shared/plans/2026-05-13-GH-1250-model-tier-optimization-hero.md` — Phase 3 originally specified `grep -qE '^IMPL BLOCKED '` with caret anchor. The plan critique (`thoughts/shared/reviews/2026-05-14-GH-1250-critique.md` v1) flagged transcript-discovery as hand-wavy; v2 approved after the pattern was specified. Implementation deviation note in the plan documents the caret-anchor removal (the marker appears inside a JSON `"text":"..."` field in the JSONL stream, never at column 0). The deviation was applied to the hook but not propagated to the `ralph-impl/SKILL.md` prose at line ~324 — a related (but score-50) finding.

## Related Research

None — the PR is the first implementation against this plan.

## Open Questions

- Should the BLOCKED escalation use Pattern 1a (transcript-grep, smallest diff) or Pattern 1b (env-var, most elegant)? Pattern 1b requires `ralph-impl` to export `RALPH_IMPL_NEEDS_ESCALATION` before stopping, which is feasible but a bigger change than the PR currently makes. Pattern 1a's "smallest possible change" route is to drop `needs=opus` from hero's instruction and just match `IMPL BLOCKED `.
- Worth confirming whether the five Stop hooks currently missing the `stop_hook_active` guard have ever caused a duplicate-Stop loop in production (`~/.ralph-hero/activity/` may have evidence). If they have not, this is a latent gap; if they have, the hook-utils promotion becomes higher priority.
- A `check_force_stop()` helper alongside `check_stop_hook_active()` would deduplicate the `RALPH_FORCE_STOP=true` block in three postconditions — but this is a separate refactor and not on the critical path for the PR review.
