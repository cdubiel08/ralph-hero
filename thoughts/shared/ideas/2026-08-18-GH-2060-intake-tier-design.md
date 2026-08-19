# Intake tier — design record (GH-2060)

- **Date**: 2026-08-18
- **Unit**: GH-2060 — Board has no intake tier: unapproved work is immediately eligible for autonomous pickup
- **Provenance**: interactive design session, human + driving agent, 2026-08-18. The unit's own body gated implementation on exactly this session; this record is the first-pass deliverable. Normative for the implementation units filed from it.
- **Status**: decided (implementation pending; see "Implementation units")

## The gap being closed

v2 has no way to put an item on the board that is tracked but not yet approved for
work. `next`'s pool is every unclaimed Backlog item (`ralph/scripts/board.ts:373`),
so filing an issue *is* approving it for autonomous pickup. Every workaround is
dishonest (fake blocker, fake claim, P3-and-hope, or keeping intake off the board
entirely — the option actually in use, which makes pending intake invisible to
`tend`, `doctor`, and anyone accountable for it). An empty `board next` is
ambiguous the same way GH-2048 showed for PRs: "no work" and "work that was never
filable" render identically.

## Decision 1 — Mechanism: a seventh Workflow State, `Intake`

A new option on the existing Workflow State field, and a new row in the MACHINE
table. Not a separate field, not a label.

The deciding property is **fail-closed by construction**: every eligibility read
in the ranking lanes filters `state === "Backlog"` (board.ts:373), so an Intake
item is excluded from `next` and `frontier` with *zero predicate change* — there
is no reader to forget. Promotion is a `transition`, so approval inherits the
gated, auditable, comment-trailed lane every other state change uses. And a state
renders as a board column in the Projects UI for free.

Rejected alternatives:

- **Separate approval field** (e.g. `Approval: Pending/Approved`, created by
  `setup` via API). Avoids the manual UI step, but eligibility becomes a
  two-field join, every reader must remember it, and the back-compat reading of
  an unset field (= approved) fails **open** on any forgotten reader. Two fields
  answering one question ("is this workable?") is the drift shape GH-1843 exists
  to warn about.
- **Label**. Foreclosed twice over by existing design: "Eligibility is a function
  of dependency edges and field values — never of labels" (board.ts:361), and the
  ranking lanes deliberately skip the `labels` connection for cost (GH-1803).

Accepted costs, named honestly:

- **One manual UI step per board.** The Projects V2 API cannot edit an existing
  field's option set, so the `Intake` option is added in the board UI. `setup` is
  already the surface that prints exactly which steps are manual; it gains this
  one. Until the option exists, `--intake` filings and Intake transitions fail
  with the setup hint — fail-closed, not silent.
- `BOARD_STATES` in `contracts.ts` widens (the C2/C6 schemas share the tuple, so
  the machine and the contracts move together by construction).
- `STATUS_SYNC` gains `Intake: "Todo"`; `parseStateArg` gains `intake`.

## Decision 2 — Edges: `Intake → Backlog | Canceled`, strictly one-way

```text
Intake       → Backlog | Canceled
Backlog      → In Progress | Done | Canceled        (unchanged)
```

- **Approval is the `Intake → Backlog` transition.** It refuses unless Priority
  and Size are set, with the same plain-English hints as `create --backlog`
  (Decision 3): Backlog means approved-and-ready, and an approval that lands an
  unrankable item recreates the null-priority sink.
- **`Backlog → Intake` is not legal.** Same argument `Backlog → Human Needed`
  already lost: a demotion edge is a way to hide work from the queue. Scope that
  collapses under review is Canceled plus a fresh Intake item. The edge can be
  added later if a real need shows; it cannot be cheaply removed once scripts
  lean on it.
- **`Intake → In Progress` is not legal**, which means `board claim` on an
  Intake item refuses *via the machine* — no special code. Approval cannot be
  skipped by claiming.
- Rejection is `Intake → Canceled` (or closing the issue; reconcile folds a
  closed Intake issue to Done/Canceled exactly as it does today).

## Decision 3 — `create` has no invisible default landing state

*User correction during the session; this supersedes the earlier `--intake`
opt-in framing.* A bare `board create` no longer silently lands anywhere: the
caller must pick a lane, and the two lanes have different evidentiary bars.

- **`--intake`** — minimal detail. Title and body suffice; Priority and Size are
  optional. This is the "track it before it is formed" lane.
- **`--backlog`** — approved-and-ready. **Priority and Size are required**, and a
  missing one fails loudly with a plain-English hint naming exactly what to add
  (e.g. `Backlog items must be ranked: add --priority P0..P3 (P1 = default lane
  for real work) — or file with --intake if this is not yet approved`).
- **Neither flag** — refusal, with a hint naming both lanes and when each fits.

This is a deliberate breaking change for every existing caller. The alternative
defaults were both rejected: Intake-by-default silently piles up the autonomous
loop's own follow-up filings awaiting approval; Backlog-by-default is the status
quo this issue exists to end. A config-driven default was rejected because two
repos would disagree about what a bare `create` means.

Interaction with the twin-adoption guard (GH-1973) is unchanged — the dedupe
search keys on title/author/window, not on landing state.

## Decision 4 — Surfaces

| Surface | Behaviour |
|---|---|
| `next` / `frontier` | Exclude Intake **by construction** (state filter). A test pins this. |
| `list` | Shows Intake by default, as its own state section. `list` is the human truth-telling surface; hiding a tier from it recreates the invisibility this issue fixes. |
| `tend-queue` | Sees Intake. Aging intake is tend's business (unformed-intake category already exists; Intake items join it with their age). |
| `doctor` | New advisory `intake-stale` state smell: Intake items older than `RALPH_SMELL_INTAKE_DAYS` (default 14) surface as an `i` line. Advisory rules apply in full: `--strict` never escalates it, `--fix` never acts on it. |
| `deliver-queue` | Unaffected (In Review only). |
| `prune` / `board-volume` | Prune is untouched **by construction**: its subjects are long-closed terminal items and Intake items are open. `board-volume` measures the walk, so Intake items are counted honestly without a code change. |

## Decision 5 — What deliberately does not change

- **State-guard adoption still lands Backlog.** An auto-adopted issue (e.g. a
  release-failure filing, GH-1952) must reach a driver unattended; routing
  adoption through approval would break exactly that flow. Revisitable if
  hand-filed off-board issues start abusing the lane.
- **`reopen` still lands Backlog.** Re-approval-on-reopen was considered and
  rejected: the unevidenced-close reopen flow expects work to resume, and the
  board does not track whether an item was ever approved.
- The claim protocol, TTLs, and every non-ranking read are untouched.

## Adjacent machine tightenings (user-directed, same session, separate unit)

Reviewing the full transition table, the human directed three changes to
*existing* edges. They are recorded here because this session decided them, and
implemented as their own unit because they are not the intake tier:

1. **`In Progress → Backlog` requires a machine-enforced `--why`** (posted as a
   comment). Backward moves are exceptional, not routine.
2. **`In Review → In Progress` requires `--why`** likewise — this is the
   demotion lane GH-1816 already showed being over-used; the reason becomes
   auditable instead of implicit.
3. **`Human Needed → Backlog` is removed.** An answered item resumes
   (`→ In Progress`) or dies (`→ Canceled`). Open note, deferred and not
   decided: whether "answered: not now, park it" should become
   `Human Needed → Intake` — it would send parked work back through the
   approval gate rather than straight to the eligible pool.

## The meta-gap, closed by its own subject

GH-2060's body opens with an unenforceable demand — "this unit requires a design
session before implementation" — and names the unenforceability as an instance of
the gap. Intake is the mechanism that demand was missing: a unit whose body is a
design ask sits in Intake, invisible to autonomous pickup, until a human approves
the post-design implementation into Backlog.

## Implementation units

Filed as follow-ups from this record (this unit delivers the record only):

1. **Intake tier implementation** — contracts tuple, MACHINE row, `create`
   lanes with loud hints, approval gate (Priority+Size), setup's manual-step
   print, `list`/`tend`/`doctor` surfacing, tests pinning the by-construction
   exclusion and both loud-failure paths, CLAUDE.md board section.
2. **Backward-edge tightening** — mandatory `--why` on the two backward edges,
   removal of `Human Needed → Backlog`, migration note for any script using it.

## Evidence

- `ralph/scripts/board.ts:373-375` — eligibility predicate (the by-construction argument)
- `ralph/scripts/board.ts:361-363` — the no-labels rule
- `ralph/scripts/board.ts:86-93` — MACHINE table; `contracts.ts:554` — `BOARD_STATES`
- CLAUDE.md gotcha: the API cannot edit an existing field's option set (the manual-step cost)
- GH-2048 — unseeable populations render as empty (the ambiguity being fixed)
- GH-1952 — why adoption must keep landing in Backlog
