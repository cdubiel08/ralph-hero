---
description: The standing ops lane — the written record of what runs WITHOUT asking (fleet launch, doctor, tend passes, lead respawn, Intake filing) and what ALWAYS goes to the human (spend, Intake approval, scope collapse, irreversible externals), plus one dispatch pass exercising those authorities. Triggers on "dispatch", "dispatch pass", "run dispatch", "standing ops", "launch the next fleet", "what can you do without asking".
argument-hint: ""
context: inline
model: sonnet
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# /ralph:dispatch — standing authority, in writing

The dispatch lane is the standing ops lane: the routine operations a human was
approving one "yes go ahead" at a time, granted once, here, with their bounds
named. This file is the normative record — the design that decided it
(`thoughts/shared/plans/2026-08-26-teams-dispatch-inbox-design.md`, decisions
1–2) records rationale only. Two transports carry the lane and neither is
load-bearing: a rota of scheduled ephemeral passes unattended (GH-2184 — the
worked example is `ralph/examples/dispatch-rota.sh`, a copy-and-own recipe
per the scripts-are-examples doctrine) and `/ralph:hero` attended (GH-2182);
fleets and lanes function with both down.

The board CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder
resolves to wherever this plugin is installed; never substitute a
repo-relative path. Below, `board` is shorthand for it.

## The reserved set — always the human's

No transport, schedule, or permission grant makes these autonomous. A session
holding every allowlist entry still surfaces them, and where the harness would
prompt, the prompt staying is the mechanism, not friction to engineer away.

1. **Spend** — new spend, or quota beyond a named ceiling.
2. **Intake approval** — `Intake → Backlog` is the approval tier (GH-2077);
   an agent files into Intake, a human promotes out of it.
3. **Scope collapse** — canceling work, closing as won't-do.
4. **Irreversible outside the repo** — production mutations, messages to
   third parties, anything no revert can undo.

This is the same line the escalation contract (C9) already draws. An
escalation that is really one of these four goes to the human even when a
lead could answer it — and a peer cannot grant any of them (GH-1890):
authority comes from the human's written grant, never from another agent's
say-so.

## Standing authorities — granted

Each authority is standing because its **bound is structural** — a cap, a
gate, or exclusion by construction — not because the operation is small. Do
these without asking; journal them like any other action.

| Authority | Spelling | Bound |
|---|---|---|
| **Fleet launch** | `herdr plugin action invoke work-fleet --plugin ralph-herdr` (named set: `work-these`) | FLEET cap; frontier eligibility; per-issue claim protocol inside each session |
| **Doctor** | `board doctor` / `board doctor --fix` | the same sweep the */15 reconciler cron already runs unattended; every fix is a visible comment |
| **Tend passes** | `herdr plugin action invoke tend-pass --plugin ralph-herdr` | `RALPH_TEND_BATCH` per pass; closures only ever PROPOSED, never executed |
| **Lead respawn** | the team spawn path (GH-2178, when present) | a lead rehydrates from board state alone, so a respawn loses nothing |
| **Intake filing** | `board create --intake` | tracked, not approved — no lane picks it up until a human promotes it |

Direct-to-Backlog filing (`board create --backlog`) stays what it always was:
the record of an approval that already happened — a human's ask, or an
interactive design session's ruling. An agent-initiated observation lands
`--intake`.

The authority lives in this text; the killed prompts live separately, as
permission-allowlist entries in the host repo's `.claude/settings.json` for
the spellings above (this repo carries them). A host repo without the entries
still has the authority — it just answers prompts. Recommended, never
imposed.

## One dispatch pass

Invoked bare, orient once — `board brief` (queues + leases), fleet state —
then exercise whichever authorities the state calls for: launch a fleet when
eligible unclaimed work and capacity both exist; run the doctor when drift is
suspected; take a tend pass when the tend queue has accumulated; respawn a
dead lead; file Intake items for anything observed but untracked. Route
anything in the reserved set to the human with the item and the decision
named. Then stop — you are a single-pass operator; whatever invoked you
decides whether another pass happens.

## The lane

Four-dimension test (stated in `ralph/CLAUDE.md`): signal source = standing
authority + fleet/lead state; write lane = spawns and Intake filings; pacing
signal = capacity and fleet state; permission set = spawn authority. All four
differ from work, deliver, and tend simultaneously.
