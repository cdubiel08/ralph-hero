---
date: 2026-07-26
type: plan-of-plans
github_issue: 1592
parent_epic: 1588
status: draft
tags: [portable-enforcement, mcp-server, state-machine, 4cs]
---

# GH-1592 Plan of Plans — Server-side invariants: state machine + contracts into `save_issue`

## Strategic Context

Epic #1588's central finding is an inversion: ralph deterministically
enforces process *shape* through 27 hard-gate hooks, while taking process
*truth* on faith — and 38 of 40 hooks parse Claude Code's stdin JSON, so
any other harness runs with no deterministic backstop. Feature 1 (#1589,
merged) fixed the merge half by moving evidence verification into
`scripts/merge-pr.sh` + CI + a ruleset. This feature fixes the state half
by moving transition, lock, and tree invariants into the MCP server.

The server is already the state authority in practice — `save_issue` owns
`WORKFLOW_STATE_TO_STATUS` sync, the parent auto-advance helper, and the
lock-state definitions in `workflow-states.ts`. What it lacks is
enforcement. `state-gate.sh` holds that today and fails *open*: an unknown
command key or an unreadable state-machine JSON silently disables the
state machine for a mistyped verb.

## Shared Constraints

- **Fail closed.** Every invariant moved server-side must reject on
  malformed input rather than pass through. That is the specific defect
  being fixed, not an incidental design preference.
- **Recovery must survive.** `save_issue`'s `force` param exists for the
  crashed-agent case. Hardening the default path must not remove the
  repair path — it must make it explicit and logged.
- **Don't enforce on tools that are about to move.** #1592 is ordered
  after #1591 (tool wave 2) precisely so invariants land on the
  consolidated tool set; the first child is board-blocked on #1614.
- **Hooks come out only after the server proves the invariant.** Demotion
  is the last child, not a parallel one.
- **Merge path.** `main` is ruleset-protected — PR + `scripts/attest-pr.sh`
  + `scripts/merge-pr.sh`. `mcp-server/src/**` changes trigger `release.yml`.

## Feature Decomposition

### Feature 1 — #1615: Enforce workflow-state transitions server-side in `save_issue` / `advance_issue`

The transition-legality predicate goes into `workflow-states.ts` and is
called by both mutating tools, refusing illegal transitions with an error
that names the legal next states. Semantic intents (`__LOCK__`,
`__COMPLETE__`, `__ESCALATE__`) resolve *before* validation so they cannot
be used as a bypass. Board-blocked on #1614 (end of the tool wave).

Acceptance: illegal transitions refused with actionable errors, validation
fails closed, `force` explicit and logged, refusal classes covered by tests.

### Feature 2 — #1616: Promote `lock-guard.ts` from advisory check to hard server-side refusal

Lock states are exclusive claims but the conflict check is advisory today.
The guard becomes a hard refusal naming the holder and the reclaim path,
with the `force` recovery route preserved and logged.

Acceptance: conflicting claims refused server-side, force recovery works
and is loud, no harness-side gate required for correctness.

### Feature 3 — #1617: Deterministic stale-lock reclamation to replace advisory `lock-release-on-failure.sh`

The advisory hook only fires inside a session that reaches its Stop event —
exactly what a crash prevents. Replacement is either a server-side TTL
surfaced through `next_actions` (the ranker already has a lock-stale
concept) or a scheduled workflow, chosen on research evidence.

Acceptance: stale locks reclaimed or surfaced without the crashed session's
participation, configurable documented threshold, no false positives.

### Feature 4 — #1618: Enforce tree contracts inside `create_sub_issues` (estimate ceiling, dependency-edge sanity)

The split-size and split-estimate guarantees move into the composed tool:
oversized child estimates rejected before any issue is created, and
dependency edges validated for range, self-edges, cycles, and
resolvability. The tool description's "policy gating lives in hooks" line
is reversed in the same change.

Acceptance: contract violations rejected up front rather than surfacing as
per-child partial failures; every rejection path tested.

### Feature 5 — #1619: Demote the superseded hooks and prove the invariants with a zero-hook hero-fable lifecycle

`state-gate.sh`, `split-size-gate.sh`, `split-estimate-gate.sh`, and
`lock-release-on-failure.sh` come out once their server equivalents are
proven, and a hero-fable lifecycle run with no hooks loaded produces the
transcript evidence. This discharges epic AC-6 for the state half (#1589
discharged the merge half).

Acceptance: hooks removed or explicitly demoted, hook tests green, CLAUDE.md
hook documentation given a surviving canonical PostToolUse example,
documented zero-hook lifecycle evidence attached to the PR.

## Integration Strategy

Children 1–4 are `mcp-server/src/**` changes with mcp-server test coverage;
child 5 is a hooks + docs change that depends on all of them. They share
one revert scope and ship as ONE PR (GH-1538 group planning). Because the
diff lands under `mcp-server/src/**`, merging triggers the auto-release —
version bump, npm publish with OIDC provenance, and the `ralph/.mcp.json`
pin — so the server enforcement reaches consumers as a published version,
not just a repo state.

Verification per phase: `npm test` in `mcp-server/` (refusal-path coverage
is the substance of this feature, not an afterthought), hook tests after
demotion, ShellCheck, doc rosters, and the zero-hook lifecycle transcript.

## Feature Sequencing

```
#1614 ─> #1615 ──┬─> #1616 ──> #1617 ──┬─> #1619
                 └─> #1618 ────────────┘   (#1619 also blocked by #1605)
```

- #1615 first and board-blocked on #1614 so invariants land on the
  consolidated tool set.
- #1616 and #1618 are parallel-safe after #1615 (lock path vs tree path).
- #1617 after #1616 — reclamation builds on the hardened lock guard.
- #1619 last — hooks come out only after every server invariant is proven,
  and it rebases onto #1605 (which also rewrites the split-* hook story).

## What We're NOT Doing

- Rewriting the workflow state machine itself. The states, ordering, and
  categories in `workflow-states.ts` stay as they are; only enforcement
  moves.
- Removing the `force` escape hatch. Human repair stays possible.
- Enforcing evidence claims (tests ran, CI green) — that is #1589's layer,
  already landed.
- Capability-tier model config — #1593, the epic's last feature.
