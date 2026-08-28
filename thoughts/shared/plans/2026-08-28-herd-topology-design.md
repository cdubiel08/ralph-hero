# Herd Topology — ops-layer address space & network (design record)

Date: 2026-08-28. Source: the operator's 23/23 decision record exported from the
interactive microwork (`thoughts/shared/html-out/2026-08-27-herd-topology-microwork.html`),
grounded in `2026-08-26-teams-dispatch-inbox-design.md` (epic #2176, shipped).
This record is normative for the epic filed beside it. Five decisions deviate
from the workbook's recommendations — each deviation is the operator's call and
is recorded with its rationale.

## 1. The shape in one paragraph

Every agent in the ops layer gets a **derived, semantic, machine-wide-unique
address** — `<repo>/t<epic>-<slug>/<role><issue>-<slug>` — computed by `board
name`, never registered. The topology (dispatch → teams → leads → workers) is a
**derived view**, never a store, healed **event-driven** on `pane.exited`
(no scheduled rota — the operator rejected batch cadence outright). One command
(`dispatch up`) opens the named dispatch space with the hero pane; one command
(`team launch <epic>`) spawns a **lead, which itself staffs and owns its
workers**. Communication rides one role-agnostic wrapper family
(enumerate-filter-refuse addressing, board-comment fallback); leads promote
**directly to the inbox** (dispatch is reachable, never a mandatory rung).
Teams **self-dissolve** when the epic ships, with sweep as the guaranteed
backstop.

## 2. Decisions (operator-settled; ✱ = deviation from the workbook default)

| # | Decision | Notes folded in |
|---|---|---|
| D0.1 | Address grammar is **derived** (`board name` extension), zero new state | Must be scriptable: a "phone book" read and `$WHO_LEAD` / `$WHO_DISPATCH`-style helpers fall out of the grammar |
| D0.2 | **Machine-wide unique, refuse on collision** (worktree lock already enforces underneath) | |
| D0.3 | **Workspace labels canonical, derived from board** | **No bare GH numbers as names.** The spelling is `t2176-teams-dispatch` — number + semantic slug, "almost never typed but almost always read" (D7.1 note). Applies to every segment: teams `t<epic>-<slug>`, workers `w<issue>-<slug>` (already so), dispatch `<repo>/dispatch` |
| D0.4 | **Spawner mints** via the one grammar, stamps name + C8 tokens | |
| D1.1 | Graph is a **derived view** (board + ledger + herdr labels joined at read time; nothing written) | Surface: `board roster` |
| D1.2 ✱ | **Event-driven healing** via `watch-event.sh` `pane.exited` — not a scheduled pass | Must carry GH-1863's pane-proved-ownership discipline; the zombie-pane class is the known hazard of acting on events |
| D1.3 | **Per-repo graphs, machine-wide roster read** (lease semantics, extended) | |
| D2.1 | **One wrapper family, role-agnostic** (to-address + kind) | Simple now, richer later: the `kind` field is versioned so a dispatch-specific protocol can be added without a second family |
| D2.2 | **Enumerate, filter by grammar, refuse on zero-or-many** (GH-1890 carried) | |
| D2.3 | **Board comment fallback** on failed liveness; escalation TTL already bounds the wait | |
| D3.1 ✱ | `dispatch up <repo>` = **named space + hero pane only**. No rota, no scheduling — "too prescribed and batch instead of being event driven" | Idempotent re-run heals (reopen space/pane). The unattended half of dispatch is the event lane (D1.2), not a schedule |
| D3.2 ✱ | `team launch <epic>` spawns the **lead only; the lead staffs and owns its workers** — "dispatch shouldn't spawn the things lead should own; the lead intrinsically knows the workers it created" | roles.sh `orchestrator` already permits spawning driver/investigator/tender; staffing rides the existing fleet guards (deps, cap, billing) run BY the lead |
| D3.3 ✱ | **Lead self-dissolves** on epic Done — "very guaranteed but also fast and efficient" | Primary: self-dissolve as the lead's final act. Backstop (the guarantee): the event healer flags, sweep removes — a lead that dies mid-dissolve costs one sweep, never an orphan forever |
| D4.1 | **Briefs carry addresses; skills carry protocol; tokens carry lineage** — C8 `parent`/`root`/`depth` finally get readers | |
| D4.2 | **Chain of command only** at spawn (own address, lead-or-dispatch, reply-to); peers by enumeration | |
| D5.1 | Dispatch's **durable address is the board**; live binding when a hero session is up under `<repo>/dispatch` | |
| D5.2 ✱ | **Leads write the inbox directly** — "dispatch can be reached but inbox should be written to by default" | Dispatch is a reachable peer, not a rung; #2179's promotion path is amended accordingly |
| D6.1 | Cockpit **roster tree view** — on a **different letter than D** (operator note); `T` proposed | dispatch → teams → leads → workers, addresses in mono, liveness dots, escalation counts |
| D6.2 | **Address is the title, everywhere** (panes, labels, cards, ledger) | Truncate middle on narrow panes, keep repo + tail |
| D6.3 | Hero opens **inbox-first, roster second**, every row names its one-key verb | |
| D7.1 | **Same logical address across respawns; `spawn_epoch` distinguishes incarnations** | The `tNNNN-semantic` spelling is reaffirmed here |
| D7.2 | **Doctor line + heartbeat file** watches dispatch | With no rota, the heartbeat writers are the event hooks and hero sittings; staleness advisory names `dispatch up` as remedy |
| D7.3 | **Machine-local like leases; board arbitrates**; no cross-machine election | |

## 3. Coherence notes (what the deviations change together)

- **The rota dies; the event lane replaces it.** D1.2 + D3.1 remove every
  scheduled pass from this design. `watch-event.sh` (pane.exited /
  agent_status_changed) is the unattended half: respawn dead leads, flag
  orphans, write the heartbeat. dispatch-rota.sh (#2184) remains
  scripts-are-examples inventory for repos that want batch; nothing here
  depends on it. GH-1863's lesson is the standing constraint: every
  event-driven repair must prove pane ownership before acting.
- **Lead as spawner completes the hub-lane story.** GH-1890 sanctions
  spawner↔spawned edges; when the lead spawns its workers, lead↔worker is a
  hub lane *by construction* rather than by convention, and the address book
  (D4.2) is knowledge the lead already holds.
- **Inbox-direct promotion keeps one arbitration hop.** Worker → lead (C9 +
  TTL, #2179) → inbox. Dispatch reads the inbox like the human does and is
  messageable (D5.1) but adjudicates nothing by default.

## 4. Units (filed to Backlog beside this record; epic root links them)

| Unit | Scope | Est | Pri | Deps |
|---|---|---|---|---|
| A — address grammar | `board name` extension: team/role segments, `t<epic>-<slug>` spelling, full address string; C8 stamped; collision refusal text | M | P1 | — |
| B — labels + titles | Canonical workspace labels from the grammar; address-as-title on panes/cards/ledger | S | P1 | A |
| C — roster + phone book | `board roster [--json]`: derived join (claims, tokens, labels, live agents); `who lead` / `who dispatch` helpers exported into briefs | M | P1 | A |
| D — event healing | watch-event.sh: pane.exited → pane-proved respawn/flag; heartbeat write; doctor advisory | M | P1 | — |
| E — `dispatch up` | Named space + hero pane, idempotent; prints roster; no scheduling | S | P2 | A |
| F — `team launch` | Lead-only spawn; lead staffs workers from the epic frontier under its own fleet guards; brief carries chain of command | M | P1 | A |
| G — self-dissolve | Lead's epic-Done close-out removes its own space; healer+sweep backstop | S | P2 | F |
| H — wrappers v2 | Role-agnostic to-address + versioned kind; enumerate-filter-refuse; board fallback | S | P2 | A |
| I — briefs + lineage readers | who-is-who block in C3 briefs; roster/cockpit read C8 parent/root/depth | S | P2 | A, C |
| J — inbox-direct promotion | Amend #2179 path: lead promotes straight to Tier 1; dispatch reachable, not a rung | S | P2 | — |
| K — cockpit roster view | New toggle letter (`T`), tree render, liveness + escalation counts | M | P2 | C |
| L — `/ralph:w` + `/ralph:d` | Whisper shortcut (send to named agent, `--lead`/`--dispatch` flags) and dispatch shortcut | S | P3 | H |

## 5. Sources

- Operator decision record, 2026-08-28 (verbatim in the epic root body)
- `thoughts/shared/plans/2026-08-26-teams-dispatch-inbox-design.md` (#2176)
- GH-1890 flat-agent-messaging spec; GH-1662 v1 post-mortem; GH-1863
  pane-proved reconcile; GH-1956 worktree lock; #2179 arbitration; #2183 wrappers
