# Agent readiness: recommendations, never gates

Date: 2026-08-01
Status: shipped alongside this note (board `setup` fix, portable funnel-merge, `board readiness`)
Extends: 2026-07-31-ralph-v2-minimal-harness.md (design record)

## The field report

First install of ralph v2 into a fresh host repo (a different org, different CI/CD
conventions). What worked: the board — project creation, states, claims — "worked
innately." What cracked:

1. **`board setup` under-provisioned.** It created Workflow State + Claim but not
   Estimate/Priority, even though the CLI itself reads both (`get`), writes Estimate
   (`create --estimate`), and ranks by Priority (`next`). A fresh board silently lacked
   fields the tool's own surface advertises.
2. **The merge gate traveled as a demand.** `work/SKILL.md` rule 7 and `funnel-merge.sh`
   hard-coded `scripts/merge-pr.sh` + `scripts/attest-pr.sh` — ralph-hero's own repo
   assets ("kept verbatim" in the v2 cutover, which was written from inside this repo).
   In a host repo without them, the driver reported the scripts missing, and the funnel
   blocked bare `gh pr merge` while pointing at a script that doesn't exist. That is an
   imposition on another repo's CI/CD ladder.

## The principle (droid-inspired)

Factory's Agent Readiness model (docs.factory.ai/web/agent-readiness) frames it well:
"the agent is not broken, the environment is" — so *measure* the environment against
levels (Functional → Documented → Standardized → Optimized → Autonomous), report gaps
as prioritized recommendations, and make remediation opt-in. Nothing blocks.

Ralph's version of that principle: **the plugin adapts to the repo; the repo is never
required to adapt to the plugin.** Ralph-hero's conventions (merge gate, state-guard,
attestation) are *one instantiation* of good agent hygiene — reference implementations,
not requirements. Everything above Level 1 is a recommendation keyed to how much
autonomy the humans actually want to grant.

## What shipped

- **`board setup`** now provisions every field the CLI uses: Workflow State, Claim,
  Estimate (XS–XL), Priority (P0–P3). Host conventions win: an existing field is never
  edited (different option scheme → respected silently; different dataType → noted,
  left untouched). `doctor` warns — never fails, even `--strict` — on missing advisory
  fields, because sizing/ranking degrade gracefully.
- **`funnel-merge.sh`** redirects to the merge gate only when the host repo actually
  ships `scripts/merge-pr.sh`. No gate → no redirect → the repo's own merge flow, and
  recommending a gate is `board readiness`'s job, not a hook's.
- **`work/SKILL.md` rule 7** degrades the same way: run the repo's gate if present,
  else the repo's normal flow; never demand conventions the repo hasn't adopted.
- **`board readiness`** — the guide itself. Three ralph-native levels instead of
  Factory's five (ralph is one tool, not an org platform):
  - **Level 1 — drive interactively**: gh auth, board fields. `board setup` covers it;
    this is the "worked innately" tier and must stay zero-config.
  - **Level 2 — unattended sessions**: agent docs (CLAUDE.md/AGENTS.md), a test
    signal, CI workflows, PR-required default branch.
  - **Level 3 — autonomous loop**: a scripted merge gate, a state-guard/reconciler
    lane, (informational) the scheduler heartbeat.
  Every miss carries a one-line recommendation; unverifiable checks read `info`, not
  `miss` (a check we can't run must not manufacture a gap); exit code is always 0.
  Surfaced through `/ralph:board readiness`, which may offer to file recommendations
  as backlog items — adoption stays a human decision.

## Deliberately not done

- No auto-remediation (droid's `/readiness-fix` equivalent). Ralph's remediation path
  is the board: file an issue per recommendation the humans accept, then `/ralph:work`
  it. Same capability, human-gated, no new surface.
- No shipped templates for merge-pr.sh/state-guard.yml (yet). The readiness report
  describes the *properties* a gate needs (real exit codes; CI/review/attestation
  checks); copying ralph-hero's scripts wholesale would re-impose specifics. If demand
  shows up, templates belong behind an explicit "help me adopt this" ask.
- Readiness stays out of `tick.sh`/skills as a precondition. It is a report humans ask
  for, not a gate agents pass.
