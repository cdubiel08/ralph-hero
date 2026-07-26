---
date: 2026-07-25
status: formed
captured: 2026-07-25T00:00:00Z
type: idea
author: user
tags: [4cs, surface-reduction, enforcement, attestation, harness-agnostic, model-tiers]
github_issue: 1588
---

# Align ralph to the 4 Cs: surface reduction + portable enforcement

## The Idea

Take a hard look at ralph-hero through the lens of Heitor Lessa's agent-SDLC
workflow (Beyond Coding, youtube SXg08HPpKr8): greatly reduce the skill and
tool surface, move enforcement down the stack to harness-portable layers
(scripts, CI, MCP server), and make the spec-driven process observable to
product and codeowners on the board. Product alignment target: the 4 Cs —
**Cost, Context, Control, Choice**.

## Why This Matters

- **The inversion**: ralph deterministically enforces process *shape* (docs
  exist, tokens emitted, states valid — 27 hard-gate hooks) while taking
  process *truth* (tests ran, CI green, review independent) entirely on
  faith. Heitor's model is lighter on ceremony, harder on evidence.
- **Portability cliff**: 38 of 40 hooks parse Claude Code's stdin JSON;
  `scripts/merge-pr.sh` does zero verification itself. Any non-Claude-Code
  harness (hero-fable today; a metaharness like Databricks Omnigent
  tomorrow) runs with no deterministic backstop.
- **Surface debt**: 10,053 lines of skill prose across 47 mode surfaces;
  only ~45% is domain knowledge. The ceremony is now contradicting itself
  (out-of-sync taxonomies, phantom skill dispatches, a mode that exists to
  evade another skill's hook).

## Audit evidence (2026-07-25 session, three parallel audits)

**Skills** (47 modes, 10,053 lines): delete candidates — caretake
debug/postmortem/trends, hero classify, catch-up narrative/dashboard; merge
candidates — 3 watch modes→1, split+plan-epic+form-6b→one decomposition
surface, postmortem+retro→reflect, label-routing+event-classes→one taxonomy,
3 copies of loop/auto substrate→1; `research --mode prove` is an orphan;
`triage-agent` duplicates an inline mode and is never dispatched.

**Tools** (33 registered, post-GH-1566 prune): 6 tools carry ~60% of
references; 12 have exactly one consumer; `sre__*` have zero;
`detect_stream_positions` has no call site; `sync_plan_graph` is
prose-referenced + hook-warned but in no allowed-tools roster. Merge
targets: pipeline_status_summary→pipeline_dashboard,
capture_snapshot→metrics_trends, archive_items→batch_update,
get_project→health_check; cut create_status_update; gate sre__* behind env
flag.

**Enforcement** (40 hooks, ~27 hard gates): "tests pass" is 100% prose — no
hook/script/CI greps test output; merge gate fetches reviewDecision but
never statusCheckRollup; `finish-review-verdict.sh` self-review laundering
(agent greps its own "No issues found" comment on self-authored PRs); Stop
postconditions are transcript-token greps; several postconditions trust env
vars the model itself set; state-gate.sh fails open on misconfiguration.

## Rough Shape (5 features, ordered)

1. **Portable merge gate + attestation** — verification into merge-pr.sh
   (reviewDecision + gh pr checks), CI-validated attestation of test/review
   evidence on PRs. Kills the forged-evidence class. First: truth before
   beauty.
2. **Skill surface reduction, wave 2** — 47 modes → ~20 within the 9 verbs
   (wave 1 was epic #1430, 52 skills → 9 verbs).
3. **Tool surface reduction, wave 2** — 33 → ~18 (wave 1 was
   GH-1563/1565/1566, PR #1570).
4. **Server-side invariants** — state machine into save_issue, lock/tree
   contracts server-side; any harness inherits them. After 3.
5. **Capability-tier config for Choice** — judgment/standard/cheap tiers
   resolved per-harness via config, generalizing RALPH_IMPL_MODEL. Last.

## Open Questions

- How far to take harness adapters — is a thin non-Claude-Code adapter
  (droid/opencode) in scope for this epic or a follow-on?
- Attestation shape: PR comment vs check-run vs artifact file — what can CI
  re-validate cheapest?
- Does catch-up shrink into caretake, or stay as the human-facing
  orientation verb?

## Related

- Video: https://www.youtube.com/watch?v=SXg08HPpKr8 (transcript in session
  scratchpad)
- Prior art: epic #1430 (slim restructure, done), GH-1563/1565/1566 (tool
  prune wave 1, done), GH-1544 (decision-gated plan approval, done),
  GH-1322 (finish-review-verdict gate — superseded in part by feature 1)
- `thoughts/shared/ideas/2026-06-10-fable-native-ralph-artifact-contracts.md`
  (hero-fable artifact contracts — the rail-free consumer of features 1+4)
- `docs/model-tier-policy.md` (Cost baseline; feature 5 generalizes it)
- Separate wiring-defects fix task (session chip, not part of this epic):
  missing roster grants, phantom gcp-incident-triage dispatch, In-Review
  misroute, stale model prose
