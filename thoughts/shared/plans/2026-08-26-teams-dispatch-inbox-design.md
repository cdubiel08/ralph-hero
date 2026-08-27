# Teams, the dispatch lane, and the human inbox — design plan

**Date:** 2026-08-26
**Status:** decided — interactive design session (grilling), all decisions user-confirmed
**Method:** frontier-question rounds over three parallel investigations (fleet surface, human-input surfaces, prior art) + peer-sessions and herdr capability research
**Filed:** epic + units directly to Backlog per the session's own ruling (interactive design IS the approval; Intake is for yeets and quick jots)

---

## 1. The pain (motivating incident, user's words)

Continuous micro-management of in-the-loop work: "yeah create an issue for that", "yes
launch the next fleet", "yes run the doctor", "yeah go ahead and do it", "launch a tender
→ yes this set makes sense". The human is the scheduler and the approval gate for
operations that are already well-defined.

**Finding that reframed it:** much of the machinery for making this go away already
exists and is deliberately unused. Issue-filing needs no approval since Intake (GH-2077);
doctor is already a */15 cron; tend proposals already batch behind `board resolve`;
unattended deliver/tend lanes are shipped; `work-fleet.sh` is attended-only by its own
stated choice. A real fraction of the pain is **standing authority never granted in
writing, and attended defaults never flipped** — plus two genuinely missing pieces: a
group-of-work layer above one-worker-per-issue, and a single surface for the human's
attention.

## 2. Decisions

| # | Decision |
|---|---|
| 1 | **Reserved set** — decisions that stay the human's: (i) spend/quota beyond a named ceiling, (ii) Intake approval, (iii) scope collapse (canceling work), (iv) anything irreversible outside the repo. Everything else is standing authority. Matches the line C9 already draws. |
| 2 | **Ways-of-working is not a document, and not a hook.** Hooks can only refuse; the pain is the inverse (do X without asking). It decomposes onto the existing enforcement stack: standing authorities + reserved set as **skill text**; capability bounds as **agent definitions** (`tools:` + role edge guard); the literal "yes go ahead" prompts killed by **settings.json permission allowlist** entries for the named scripts; knobs in env/config. This plan records rationale only; nothing normative lives only in prose. |
| 3 | **Team** = a standing space scoped to **one epic** — fleets and workers come and go inside it, the lead stands for its duration, the space dissolves when the epic ships. "Standing" is relative to fleets, not eternal. No persistent cross-epic teams (a context-accumulation surface with no owner; a second assignment plane competing with the board). |
| 4 | **Lead** = the team's orchestrator. A standing `o`-lane pane spawned with the fleet, living the epic's lifetime. Read-only by role (roles.sh already defines `orchestrator`: may spawn driver/investigator/tender, never writes a tree). **Respawnable from board state alone** — everything it knows lives on the board/ledger; a dead lead is respawned by a dispatch pass and loses nothing. |
| 5 | **Lead is an arbiter** (user overruled the flat-path recommendation): workers escalate to their lead, who answers what's knowable, re-steers what's mis-aimed, and promotes to the inbox only what genuinely needs the human. Escalations stay **board-resident** (C9 comment on the item) — the lead adjudicates a board item, never a private message that dies with a pane. **Bound:** an escalation the lead hasn't dispositioned within a TTL auto-promotes to the inbox (default `RALPH_LOCK_TTL_MIN`, 120 min). A stalled or dead lead costs latency, never a stranded worker. |
| 6 | **Dispatch** = the standing ops lane. One lane, two transports (lanes are transport-neutral per the 2026-08-08 amendment): a **rota** of scheduled ephemeral passes unattended (launch fleets per standing authority, brief leads, respawn dead leads, curate the inbox), and **`/ralph:hero`** as the attended face — one touch brings up a session that rehydrates from `board brief` + leases + inbox and stays up as the human's single point of contact for the sitting. **Never load-bearing:** fleets and lanes function with hero down; killing the pane loses nothing. |
| 7 | **Inbox** = a single place for a human's attention, **board as the only store**. Two tiers: **Tier 1 — decisions** (interrupt-worthy): Human Needed, Intake approvals, tend proposals, stalled/blocked deliver rows — C9-shaped, GitHub-native phone push, each disposable by an existing verb (answer/approve/resolve). **Tier 2 — digest** (never interrupts): completions, interesting signals, suggested actions — batched, at most one push a day, readable on demand. **Invariant: nothing enters either tier without a disposition verb or an expiry.** Suggested actions arrive as accept/reject proposals, never prose. No third FYI-forever tier. |
| 8 | **GH-1890 stands untouched.** Peer edges inside a fleet stay knowledge-only; state and assignment are never sent peer-to-peer; no peer inbox. This design lives strictly above it: the lead↔worker and hero↔lead edges are **hub lanes** (a spawner briefing sessions whose lifecycle it owns), which the existing rules already sanction. |
| 9 | **Messaging:** herdr owns spawn/lifecycle/panes (its only primitive, `agent prompt`, is one-way injection — no inbox exists in herdr). Cross-session `SendMessage` (the peer-sessions transport) carries the brief→reply loops on hub edges. peer-sessions' conventions are adopted — brief carries reply address, responses arrive as prompts, liveness checked before send, `sent ≠ read` — **shipped as wrapper scripts** so no agent re-derives the protocol (the `fleet-send.sh` pattern, applied to the SendMessage side). Its spawn half (cmux) is not adopted. |
| 10 | **Topics/subscriptions: cut** (scope explosion). CI failures on a team's own PRs are the lead's data plane; backlog health is tend; product feedback has no intake path yet and waits. Reopen on a real observed miss, not in the abstract. Any future mechanism is lead-polls-named-sources + dispatch-routes-cross-cutting-signals — never a pub-sub bus. |
| 11 | **Design-session output convention** (meta, now standing): longform interactive design sessions produce `thoughts/shared/plans/` docs and file epic + units **directly to Backlog** with Priority and Estimate. Intake is for yeets and quick jots. |

## 3. Constraints from prior art (what this design must not re-break)

- **v1's team machinery is the specific thing v2 deleted** (GH-1662): TeamCreate, lead+worker
  roster, message-based assignment — measured failure: 30+ messages and 2–4 nudges per task,
  idle-notification spam, phantom teammates. What is different this time: the board now exists
  as the data plane (v1's teams predated it), the lead is **read-only by hard enforcement**
  (it structurally cannot become a nudging task-master), and assignment stays claimed from the
  board, never pushed (GH-1890 §5.4, untouched).
- **GH-1890 / flat-agent-messaging spec**: inbox and standing subscriptions between peers
  rejected with a falsifiable reopening condition this design does not claim to meet — it
  builds *above* the peer layer, not inside it. Its rules (sent ≠ delivered, no read receipts,
  a peer grants nothing) carry into the wrapper scripts verbatim.
- **GH-1550 is the inbox's prior art and its warning**: v1 built exactly this (human-queue
  enumeration, `catch-up --mode brief`, scheduled morning push) and it died with `mcp-server/`
  in the v2 cutover. Its design principle survives as Tier 1's admission rule: **only genuine
  decisions may interrupt** — findings and FYIs polluting the decision queue is the named
  degradation.
- **C9 is convention, not enforcement, at the transition**: `--why` is only checked non-empty.
  With leads as sole Tier-1 arbiters, escalation quality matters more; the arbitration unit
  should decide whether the lead's promotion path validates C9 shape (`board contract validate
  ralph.escalation`) before an item reaches the inbox.
- **Half-built surfaces to complete rather than duplicate**: `orchestrator` role + spawn edge
  guard exist in roles.sh with no spawn path; `$RALPH_HERDR_LEAD` exists (anti-deadlock only);
  C8 tokens `parent`/`root`/`depth` are pushed by every pane and read by nothing; the cockpit's
  `D`-toggle is the template for a fourth view; `work-these` is the template for a new herdr
  action (TOML + script, no build step).

## 4. Units (filed to Backlog 2026-08-26: epic #2176)

| Unit | Scope | Est | Pri |
|---|---|---|---|
| **A — #2177 Standing authorities** | Dispatch skill text carrying reserved set + standing authorities; settings.json allowlist entries for the named scripts (work-fleet, doctor, tend passes, lead respawn). Kills the routine "yes go ahead" prompts. | S | P1 |
| **B — #2178 Lead spawn path** | `work-fleet.sh` (or sibling) gains the team form: spawn an `o`-lane lead pane with the fleet for an epic, reusing roles.sh `orchestrator`; lead rehydrates from board state; dispatch pass detects and respawns a dead lead. Sets `$RALPH_HERDR_LEAD`. | M | P1 |
| **C — #2179 Lead arbitration + TTL** | Worker escalations addressed to the lead (board-resident, C9); lead answers/re-steers/promotes; unadjudicated escalation auto-promotes to inbox at `RALPH_LOCK_TTL_MIN`. Work-skill escalation reference amended (addressing only; the two-strike trigger rule is untouched). | M | P1 |
| **D — #2180 Inbox store + walk verb** | `board inbox`: one walk over the four queues (Human Needed, tend proposals, Intake approvals, blocked deliver rows), Tier 1/Tier 2 split, disposability invariant (every entry names its verb or its expiry). Digest as Tier 2 batch (GH-1553/1555 restored on v2 primitives). | M | P1 |
| **E — #2181 Cockpit inbox view** | Fourth view on the `D`-toggle precedent rendering `board inbox` Tier 1; blocked on D. | S | P2 |
| **F — #2182 `/ralph:hero`** | Herdr action + pane script (work-these template) + skill: rehydrate from `board brief` + leases + inbox; attended face of dispatch. Never load-bearing. | M | P2 |
| **G — #2183 Messaging wrappers** | SendMessage wrapper family (brief / reply / liveness-check) encoding peer-sessions discipline + GH-1890 rules (reply-to-from, enumerate-never-construct, sent ≠ read). | S | P2 |
| **H — #2184 Dispatch rota** | Example scheduled passes (scripts-are-examples doctrine): fleet feed per standing authority, lead health, inbox curation/digest push. | S | P3 |

Ordering edges: #2181 blocked-by #2180 (wired). All else independently mergeable; A first is the
highest-leverage single unit against the Q1 pain.

## 5. Vocabulary (this plan's terms; CONTEXT.md untouched unless a record goes normative)

- **team** — a standing space scoped to one epic: fleets spawn in it, a lead leads it, it
  dissolves when the epic ships.
- **lead** — the orchestrator for a team. Read-only, standing for the epic, respawnable
  from board state, arbiter of its workers' escalations.
- **dispatch** — the standing ops lane (rota unattended, `/ralph:hero` attended).
- **inbox** — the single place for a human's attention; board-stored, two-tier,
  disposability-invariant.

## 6. Sources

- `thoughts/shared/specs/2026-08-14-flat-agent-messaging-spec.md` (GH-1890 — stands)
- `thoughts/shared/specs/2026-08-07-loop-agent-lanes-spec.md` (transport-neutral lanes; four-axis lane test — dispatch clears it: signal = standing authority + fleet state, write lane = spawns + inbox, pacing = capacity, permissions = spawn authority)
- `thoughts/shared/ideas/2026-08-14-ralph-roles-and-skills-design.md` (roles; the session↔issue↔shell triple)
- `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md` (v1 inbox prior art)
- v1 failure record: GH-0353 communication discipline, GH-0466 idle-notification spam, GH-1662 cutover
- `plugin/ralph-herdr/scripts/{roles.sh,fleet-send.sh,work-fleet.sh,lib.sh}`, `plugin/ralph-herdr/herdr-plugin.toml`, `plugin/ralph-herdr/cockpit/model.go` (extension seams)
- `ralph/scripts/contracts.ts` C8 tokens (1069–1089), C9 escalation (1129–1152), L11
- https://github.com/ray-amjad/peer-sessions (messaging discipline adopted; spawn half not)
