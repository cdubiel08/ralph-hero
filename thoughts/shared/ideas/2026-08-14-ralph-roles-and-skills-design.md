# Roles and skills — design record

**Date:** 2026-08-14. **Status:** decisions + named experiments. Scope was
deliberately reduced mid-session: this covers **roles and skills only**. Tiers,
typed handoffs, and envelope schemas were explicitly cut — many harnesses already
provide those primitives, and inventing ralph versions would be duplication.

Input: `2026-08-14-investigation-curation-loop-brief.md`. That brief asked whether
an investigation/curation loop should be a skill. The answer turned out to be that
the question was mis-scoped — investigation is one instance of a general thing, and
the general thing is **agents and skills**.

## Decided

| | |
|---|---|
| **Roles** | 4: relay (human-facing, owes escalations), orchestrator (composes + spawns), worker (one unit, claims), investigator (read-only) |
| **A role IS an agent definition** | system prompt + `tools:` + context. The harness composes it; `tools:` is hard runtime enforcement, everything else is prose |
| **Both spawn shapes work** | `claude --agent <role>` for a pane session, `Agent(subagent_type: <role>)` for a subagent |
| **Skills are capabilities** | invoked inside any role. **No gating layer** — roles and skills are many:many and the harness already composes them |
| **Agent identity** | an attribute of the request envelope, never a dimension of a grant |
| **Scope** | declared statically at spawn; never rediscovered at runtime |
| **Envelope** | transport-neutral, materialized as herdr tokens |
| **Claim** | stays first-class — the only object providing concurrency safety, race prevention, and waste prevention |
| **Liveness** | queried on demand, not heartbeated. TTL becomes a timeout on *unqueryable* state, not a wall-clock deadline |
| **Peer messaging** | name is the address; the return address travels in the message body. No new primitive |
| **Third edge** | shell↔issue observed via slug resolution, advisory only |

## The reasoning worth keeping

**The triple is the unit.** session ↔ board-issue ↔ shell. Every failure observed
on 2026-08-14 was **an edge breaking while the other two nodes kept running** —
zombie panes (deleted worktree), a 30-hour orphaned cockpit (pane gone, process
alive), #1775 (claim expired under a working session), w1848 (prompt swallowed, issue
never bound). Four incidents, one shape. The nodes are fine; the **edges** are where
the hard problems live, and only two of three have an observer today.

**The claim is a lease, and specifically a k8s `Lease` missing two fields** —
`renewTime` and `leaseTransitions`. Those absences are exactly the two observed
failures. But the fix is *not* a heartbeat: herdr can be queried, so liveness should
be **pulled at the moment expiry is evaluated** rather than pushed on a schedule.
Level-triggered, per the k8s controller lesson. No renewal traffic, no field to keep
fresh, no stale-renewal bug.

**Lease expiry does not stop the holder** (Kleppmann on Redlock). #1775 is the
textbook case: expired, released by `doctor --fix`, session kept working.

**Agents hold no credential of their own.** Every write is the human's `gh` token;
the claim holder is a *machine* (`dubiel@Chads-MacBook-Pro-2.local`), so four
concurrent workers already share one identity. Modeling role-as-grant would encode a
fiction the substrate cannot enforce. This is the decisive argument for identity as
envelope metadata.

**Runtime discovery is what broke the zombie panes.** `scope.sh` rediscovers repo
scope from worktree provenance on disk; delete the worktree and the agent goes
invisible *precisely when it is broken*. A declared scope cannot go unresolvable.

**Reconciliation, not prevention.** ralph's existing instinct — `reconcile.sh`,
`doctor --fix`, the 15-min cron — is the k8s controller pattern and is correct.
Keep it.

## Open — needs experiment, not decision

1. **Where role is declared: argv vs envelope.** `--agent` is Claude Code's
   primitive; ralph claims transport-neutrality (`RALPH_TICK_RUNNER` is pluggable,
   herdr supports ~20 agent kinds). *Recommendation, unconfirmed:* the token is the
   neutral declaration and `--agent` is Claude Code's materialization of it — the
   same pattern already chosen for the envelope, one layer down. **Experiment:**
   check whether one non-Claude harness herdr supports (codex, pi) has an equivalent
   composition mechanism. If not, argv cannot be the source of truth.
2. **Per-role tool boundaries.** Deferred deliberately. Only `investigator` is
   meaningfully constrained today; a worker needs near-arbitrary Bash to build and
   test, so a "boundary" for it would look real without being real. Tighten from
   incidents, not from theory.
3. **What the SessionStart hook injects.** The requirement is only that an agent
   *knows it can message colleagues and how*. Nothing should be forced beyond that.
   The concrete shape is unknown until roles are running.

## Deferred to their own sessions

- **Attenuation / the ocap invariant** (a spawn may only attenuate, never amplify).
  Real and probably durable, but it deserves its own session — and it is currently
  unenforceable anyway, since there is one principal and one token.
- **Typed handoffs.** `contracts.ts` already types escalation and attestation.
  Extending to Finding / DispatchPlan was judged premature while roles are moving.

## Honest limits

- The 4-role list is grounded in one day of observation on one repo. It may not
  generalize to a repo whose product is not the board tooling.
- "A role is an agent definition" is clean but untested for the **relay** role,
  which is usually a human-attended top-level session rather than a spawned one.
- Nothing here has been built. Every claim about cost or behaviour above was
  measured on 2026-08-14; every claim about the design is a prediction.
