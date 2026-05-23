---
date: 2026-05-23
github_issue: 1397
github_issues: [1397, 1376, 1380, 1381, 1386, 1387, 1388, 1382, 1384, 1385]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1397
primary_issue: 1397
status: ready
type: plan
tags: [ralph, plugin-restructure, plan-11, wave-2, parity, audit]
spec_reference: thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md
---

# Plan 11: Wave 2 selective — targeted P2/P3 parity fixes + scope closures

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] — parent migration spec
- builds_on:: [[2026-05-23-GH-1395-ralph-plan-10-sunset]] — Wave 1 (P0/P1 fixes) shipped 2026-05-23

## Overview

Wave 2 of the spec called for "12 P2/P3 parity fixes shipped as individual PRs or small batches over the dogfooding window." After Wave 1 merged, the user triaged the 12 audit issues into three buckets: implement, close-with-rationale, defer. This plan executes the implement + close buckets in one PR — five small fixes, one doc-only confirmation, and three issue-closure comments — leaving three issues open for a later wave.

| Bucket | Count | Action |
|---|---|---|
| Implement | 5 | #1376, #1380, #1381, #1386, #1388 — close via this PR's commits |
| Doc-only / confirm | 1 | #1387 — friction-log note + intake-shapes.md cross-reference; close |
| Close with rationale | 3 | #1382, #1384, #1385 — close comments only, no code change |
| Defer | 3 | #1379, #1383, #1389 — stay open, label/title updated to make defer status visible |

Each implement-bucket fix is a single commit so a regression is revertable without rolling back the whole PR (same shape as Plan 10 Wave 1).

## Current State Analysis

The implement-bucket items split by concern:

### iOS de-scope cleanup (1)

- **#1376 (P2)** — `ralph/skills/review/SKILL.md:125` still says "PushNotification on `${RALPH_COS_NTFY_TOPIC}` (preserve ralph-merge Step 9c verbatim)." but `merge-gate.md` never carried the corresponding bash. iOS is not first-class in the slim plugin (per user; same rationale as #1385 closure below). The SKILL.md line is a broken promise pointing at an absent surface — remove it.

### Hook completeness (2)

- **#1381 (P2)** — `plugin/ralph-hero/hooks/scripts/remember-turn.sh` is a passive Stop-time capture that writes the last user+assistant turn into `~/projects/thoughts/dream-memories/agent/...` for the dream-loop's next reflection pass. It's wired on Stop in `ralph-plan/SKILL.md:43` and `ralph-impl/SKILL.md:45` in the source plugin. The slim plugin's `/ralph:plan` and `/ralph:impl` never picked it up — every plan/impl run skipped the raw-memory capture. Port verbatim + register Stop in both verbs.
- **#1380 (P3)** — `plan-tier-validator.sh` is registered in `/ralph:plan` but always no-ops because `RALPH_PLAN_TYPE` is never set. Source-plugin design used a separate `RALPH_COMMAND=plan_epic` SessionStart that set the env var; slim collapses to a single `RALPH_COMMAND=plan` with `--mode epic` as a body-level flag, breaking the env-driven validator. The robust fix is to self-discriminate from the plan-doc shape (look for `## Feature Decomposition` vs `## Phase N:` sections), not chase env-var propagation.

### Skill content restores (2)

- **#1386 (P2)** — `plugin/ralph-hero/skills/ralph-triage/SKILL.md:192-260+` Step 7 "Find and Link Related Issues" scans Backlog + Research Needed after triage, surfaces conceptually-related issues via title + knowledge-search heuristics, and posts `## Related` comments. Best-effort within time budget. Drop in slim `ralph/skills/caretake/modes/triage.md`.
- **#1388 (P3)** — `plugin/ralph-hero/skills/form/SKILL.md:59-73` shows a 4-option help block before the recent-ideas file list when no args provided. Slim's `intake-shapes.md` no-args fallback skips the help block and shows only the file list, so first-time `/ralph:form` users have no orientation. Restore the help block, pathified for the slim `/ralph:form` invocation form.

### Confirm + document (1)

- **#1387 (P2)** — `/ralph:form` research-input branch now dispatches `thoughts-analyzer` (where the source skill ran only `thoughts-locator`). Token cost increases; capability also increases (analyzer surfaces key decisions from related prior art, deepening duplicate detection). The user's question is "is this good?". Verdict: **yes** — research-input means the user is feeding a research doc INTO `/ralph:form`, so pulling decisions from related prior art makes the formed issue better-grounded. Token cost is bounded (analyzer runs on top-N locator hits, not the corpus). Document the intentional enrichment + close.

### Close-with-rationale (3)

- **#1382 (P3)** — `RALPH_IMPL_MODEL` IS documented in slim — but in `ralph/skills/hero/dispatch.md:32-35` + `SKILL.md:104,129` (the orchestrator that READS the env var and dispatches impl-agent). The audit issue claims it's undocumented "in the new verb" meaning `/ralph:impl` SKILL.md doesn't mention it. That's by design — impl-agent doesn't read `RALPH_IMPL_MODEL`; hero does. Close with cross-reference to hero/dispatch.md.
- **#1384 (P2)** — `install-schedules.sh` is one-time-per-machine cron-install tooling, not part of any verb surface. Per user, this is infra-setup concern, not migration. Close as out-of-scope.
- **#1385 (P2)** — Mode-specific terminal tokens (`TRIAGED`, `HYGIENE COMPLETE`, etc.) are intentional slim-plugin design — each mode emits a token its postcondition hook can match. The iOS harness assumed universal `result:`/`needs input:` markers; iOS is not first-class in the slim plugin. Close as won't-fix with the iOS de-scope rationale.

### Out of scope for this PR

- The deferred trio (#1379 picker narrowed, #1383 8KB cap, #1389 knowledge_expert heuristic) — left open for a future wave per user direction.
- Wave 3 (sunset of `plugin/ralph-hero/skills/`) — still blocked on real-session dogfooding.
- Any iOS-mode functionality (across the entire slim plugin).

## Desired End State

After this PR merges:

1. `ralph/skills/review/SKILL.md` no longer references iOS-mode push or `RALPH_COS_NTFY_TOPIC`.
2. `ralph/hooks/scripts/remember-turn.sh` exists + is registered on Stop in both `/ralph:plan` and `/ralph:impl`.
3. `plan-tier-validator.sh` self-discriminates from plan-doc shape; warns (informational) on mismatch rather than hard-block since the slim plugin has no `RALPH_COMMAND=plan_epic` distinction.
4. `ralph/skills/caretake/modes/triage.md` carries the "Find and Link Related Issues" Step 7 (best-effort, time-budgeted).
5. `ralph/skills/form/intake-shapes.md` no-args fallback prefixes the file list with the 4-option help block.
6. `intake-shapes.md` documents the intentional `thoughts-analyzer` enrichment on the research-input branch.
7. Issues #1376, #1380, #1381, #1386, #1387, #1388 closed via this PR's commits.
8. Issues #1382, #1384, #1385 closed via this PR with a single comment each explaining rationale.
9. Issues #1379, #1383, #1389 retitled with `[Wave 2 deferred]` prefix (or labeled `deferred`) so their status is visible on the board.
10. Spec friction-log gains a Plan 11 Wave 2 entry.

### Verification

- `grep -ci "ios\|RALPH_COS_NTFY_TOPIC" ralph/skills/review/SKILL.md` → 0.
- `test -x ralph/hooks/scripts/remember-turn.sh`.
- `grep -c "remember-turn.sh" ralph/skills/plan/SKILL.md ralph/skills/impl/SKILL.md` → ≥ 2.
- `grep -q "Feature Decomposition\|## Phase" ralph/hooks/scripts/plan-tier-validator.sh` (the validator now references shape sections).
- `grep -q "Find and Link Related" ralph/skills/caretake/modes/triage.md`.
- `grep -q "1\. A path to a draft idea" ralph/skills/form/intake-shapes.md` (the help-block first option).
- All target issues show CLOSED via `gh issue view <N> --json state,closedAt`.

## What We're NOT Doing

- Not implementing the deferred trio.
- Not changing the merge gate hook (Plan 10 Wave 1 territory; nothing to add).
- Not restoring iOS-mode push anywhere.
- Not adding `install-schedules.sh` to the slim plugin.
- Not changing terminal-token vocabulary in caretake modes.

## Implementation Approach

Seven phases, one per fix-or-batch, each its own commit. Estimated 90 min total — small fixes only.

| Phase | Owns | Closes |
|---|---|---|
| 1 | Remove iOS push reference from `/ralph:review` SKILL.md | #1376 |
| 2 | Self-discriminate `plan-tier-validator.sh` from plan-doc shape | #1380 |
| 3 | Port `remember-turn.sh` + register on Stop in `/ralph:plan` + `/ralph:impl` | #1381 |
| 4 | Restore Step 7 "Find and Link Related Issues" in `caretake/modes/triage.md` | #1386 |
| 5 | Restore 4-option help block in `form/intake-shapes.md` no-args fallback | #1388 |
| 6 | Document `thoughts-analyzer` enrichment in `form/intake-shapes.md` | #1387 |
| 7 | Close-with-rationale comments + retitle defer trio + friction-log entry | #1382, #1384, #1385 + #1379/#1383/#1389 labels + spec |

---

## Phase 1: De-scope iOS push reference (#1376)

### Overview

Remove the broken-promise line at `ralph/skills/review/SKILL.md:125`. iOS is not in scope for the slim plugin per #1385 closure; the merge-gate has no iOS implementation to "preserve verbatim."

### Changes Required

Edit `ralph/skills/review/SKILL.md` Step 8 to drop the `PushNotification` clause:

Before:
```
8. **Post artifact comment + record outcome** — `## Merged` comment with URL + SHA. `knowledge_record_outcome(event_type="pr_merged", ...)`. `PushNotification` on `${RALPH_COS_NTFY_TOPIC}` (preserve ralph-merge Step 9c verbatim).
```

After:
```
8. **Post artifact comment + record outcome** — `## Merged` comment with URL + SHA. `knowledge_record_outcome(event_type="pr_merged", ...)`.
```

### Success Criteria

- [ ] `grep -ci "ralph_cos_ntfy_topic\|push.*9c\|ios" ralph/skills/review/SKILL.md` → 0.

---

## Phase 2: Self-discriminating `plan-tier-validator.sh` (#1380)

### Overview

The validator silently no-ops because `RALPH_PLAN_TYPE` is never set in the slim plugin — source-plugin design used `RALPH_COMMAND=plan_epic` SessionStart to set it, but slim collapses to a single `RALPH_COMMAND=plan` with `--mode epic` as a body flag. Rewrite the hook to detect plan tier from the plan-doc shape itself (Feature Decomposition vs Phase N sections), making it self-contained and immune to the env-var propagation question that bedeviled Plan 10 Wave 1.

### Changes Required

Modify `ralph/hooks/scripts/plan-tier-validator.sh`:

1. Keep the `RALPH_COMMAND=plan` scope guard at the top.
2. Read `tool_input.file_path` from stdin JSON (when the gate fires on a Write tool — re-register the matcher accordingly).
3. If the file is under `thoughts/shared/plans/` and was modified recently:
   - Read the doc; check for `## Feature Decomposition` (epic shape) vs `## Phase 1:` (regular shape).
   - If neither shape is present, allow (doc may be mid-write).
   - If BOTH are present, warn — that's a corruption signal.
4. Compare against the doc's frontmatter `type:` field (`plan` / `epic` / `plan-of-plans`). If mismatch, emit a warning (not block) since the slim plugin has no command-level tier signal. Warn-only because the original source-plugin block was load-bearing only when `RALPH_COMMAND` distinguished tiers, which slim doesn't.

Register the hook on `PreToolUse:Write` (matcher: file paths under `thoughts/shared/plans/`) in `ralph/skills/plan/SKILL.md` frontmatter (it's currently registered on `save_issue`, which fires for ALL plan modes and can't see the doc).

### Success Criteria

- [ ] `grep -q "Feature Decomposition\|## Phase" ralph/hooks/scripts/plan-tier-validator.sh`
- [ ] Hook warns (exit 0) rather than blocks (exit 2) on tier mismatch.
- [ ] Smoke test: feed a Write tool input for a regular plan → exit 0 silently.

---

## Phase 3: Port `remember-turn.sh` + register Stop (#1381)

### Overview

Port the dream-loop raw-memory capture hook verbatim. The script is passive (exit 0 on any failure, no LLM calls, <500ms budget) so the registration cost is minimal and the upside is that `/ralph:plan` and `/ralph:impl` sessions now feed the next nightly dream-loop reflection pass.

### Changes Required

1. Copy `plugin/ralph-hero/hooks/scripts/remember-turn.sh` → `ralph/hooks/scripts/remember-turn.sh` verbatim. Mark executable.
2. If `remember-turn.sh` has tests (`test-hooks` CI job), also copy the relevant test fixtures (verify with `grep -r remember-turn plugin/ralph-hero/hooks/`).
3. Register on Stop in `ralph/skills/plan/SKILL.md` frontmatter (append to the existing Stop block).
4. Register on Stop in `ralph/skills/impl/SKILL.md` frontmatter (append to the existing Stop block).
5. Spot-check the hook reads `$CLAUDE_AGENT_TRANSCRIPT` env var; verify the slim plugin's SessionStart sets it (or the harness does automatically).

### Success Criteria

- [ ] `test -x ralph/hooks/scripts/remember-turn.sh`.
- [ ] `grep -c "remember-turn.sh" ralph/skills/plan/SKILL.md ralph/skills/impl/SKILL.md` → ≥ 2.
- [ ] `bash -n ralph/hooks/scripts/remember-turn.sh` passes.
- [ ] Smoke test: invoke the hook with a minimal stdin JSON + tiny transcript fixture → exit 0.

---

## Phase 4: Restore triage Step 7 (#1386)

### Overview

Port source `plugin/ralph-hero/skills/ralph-triage/SKILL.md:192-260+` Step 7 "Find and Link Related Issues" verbatim into `ralph/skills/caretake/modes/triage.md`. Preserve the "best-effort within time budget" caveat — Step 7 is optional when the 10-minute budget is tight.

### Changes Required

1. Read source ralph-triage SKILL.md Step 7 in full.
2. Insert as a new `## Step 7: Find and Link Related Issues` section in `ralph/skills/caretake/modes/triage.md`, preserving:
   - Best-effort time-budget caveat at the top.
   - Knowledge-search optional preface.
   - Query candidate issues (Backlog + Research Needed via profiles).
   - Relatedness analysis criteria.
   - `## Related` comment shape on linked issues.
3. Pathify any `/ralph-hero:` references to `/ralph:` (and verb-fold equivalents).

### Success Criteria

- [ ] `grep -q "Find and Link Related" ralph/skills/caretake/modes/triage.md`.
- [ ] `grep -q "best-effort\|time budget" ralph/skills/caretake/modes/triage.md`.
- [ ] No surviving `/ralph-hero:` references in the new section.

---

## Phase 5: Restore form no-args help block (#1388)

### Overview

The source form skill showed a 4-option help block when no args were provided. Slim's `intake-shapes.md` no-args fallback skips it and shows only the file list. Restore the help prefix.

### Changes Required

Edit `ralph/skills/form/intake-shapes.md` § No-args fallback to prepend a help block before the file list:

```
If no argument is provided (and not `--mode draft`), display the help block followed by the recent-ideas file list:

I'll help you crystallize an idea into something actionable.

Provide one of:
1. A path to a draft idea: `/ralph:form thoughts/shared/ideas/2026-02-21-feature.md`
2. A research document: `/ralph:form thoughts/shared/research/2026-03-14-topic.md`
3. A description of the idea: `/ralph:form we should add operator comparison charts`
4. Just run `/ralph:form` and pick from recent drafts below

Recent ideas:

1. <file> — [first sentence of "The Idea" section]
2. <file> — [first sentence]
...
```

Pathify to slim verb form (`/ralph:form`, not `/ralph-hero:form`).

### Success Criteria

- [ ] `grep -q "1\. A path to a draft idea" ralph/skills/form/intake-shapes.md`.
- [ ] `grep -c "/ralph-hero:form" ralph/skills/form/intake-shapes.md` → 0 (no source-plugin path leakage).

---

## Phase 6: Document `thoughts-analyzer` enrichment (#1387)

### Overview

Confirm the addition is intentional and document the rationale in `intake-shapes.md` (one sentence) so future audits don't re-flag it.

### Changes Required

Add a short note to `ralph/skills/form/intake-shapes.md` near the research-input branch, e.g.:

```
> **Intentional enrichment vs source skill**: the research-input branch dispatches `thoughts-analyzer` (in addition to the source-plugin's `thoughts-locator`-only set) because a user feeding a research doc into `/ralph:form` typically wants prior-art decisions surfaced too, not just adjacent documents. Token cost is bounded — analyzer runs on top-N locator hits, not the corpus.
```

### Success Criteria

- [ ] `grep -q "Intentional enrichment\|thoughts-analyzer.*intentional" ralph/skills/form/intake-shapes.md`.

---

## Phase 7: Close out-of-scope issues + retitle defer trio + friction-log

### Overview

Wrap up: post closing comments on #1382/#1384/#1385 with their rationale, retitle #1379/#1383/#1389 with `[Wave 2 deferred]` prefix to make their status visible on the board, append a Plan 11 friction-log entry to the spec.

### Changes Required

1. `gh issue close 1382` with comment cross-referencing `ralph/skills/hero/dispatch.md:32`.
2. `gh issue close 1384` with the "infra-setup, not migration" rationale.
3. `gh issue close 1385` with the "iOS not first-class; mode tokens are intentional design" rationale.
4. Edit titles of #1379, #1383, #1389 to prefix `[Wave 2 deferred] ` (or add a `deferred` label — pick what surfaces on the project board).
5. Append a Plan 11 entry to `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` documenting the wave-2-selective split (implement / confirm / close / defer) and what was learned.
6. Update `ralph/README.md` migration table — row 10 should reflect "Wave 1 + Wave 2 selective shipped; Wave 2 deferred trio + Wave 3 remaining".

### Success Criteria

- [ ] `for n in 1382 1384 1385; do gh issue view $n --json state --jq '.state'; done` → all `CLOSED`.
- [ ] `for n in 1379 1383 1389; do gh issue view $n --json title --jq '.title'; done` → all start with `[Wave 2 deferred]` (or all have a `deferred` label).
- [ ] `grep -q "Plan 11" thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`.
- [ ] `grep -q "Wave 2 selective" ralph/README.md`.

---

## Open follow-ups (Plan 12+)

- Deferred trio (#1379, #1383, #1389) — small/cosmetic; ship as a Wave 2.5 batch when convenient.
- Wave 3 sunset — still blocked on real-session dogfooding of each `/ralph:*` mode.
- Plan 8 (hero) + Plan 9 (setup) parity audit — separate completeness pass; any gaps → Plan 12+.
