---
date: 2026-09-02
issue: GH-2077 (implementation, following the GH-2060 design)
topic: Intake tier — implementation details not covered by the pre-implementation design record
status: shipped
---

# Intake tier — implementation record (GH-2077)

Supplements `thoughts/shared/ideas/2026-08-18-GH-2060-intake-tier-design.md` (the
normative pre-implementation decision record) with facts that only became true
once the tier shipped. `CLAUDE.md` states the rules; this file carries the
"why" behind each implementation choice.

## Edges are strictly one-way

`Intake → Backlog | Canceled`, nothing else.

- **`Backlog → Intake` does not exist.** It lost the argument `Backlog →
  Human Needed` already lost: a demotion edge is a way to hide work from the
  queue. Scope that collapses is Canceled plus a fresh Intake item, and the
  edge cannot be cheaply removed once scripts lean on it.
- **`Intake → In Progress` is absent**, which is what makes `board claim` on
  an unapproved item refuse via the MACHINE — no second predicate, no special
  code path.
- **Approval (`Intake → Backlog`) refuses without a Priority and an
  Estimate.** Backlog means approved *and* rankable: an approval landing a
  null-priority item hasn't approved it into the queue, it has lost it (`next`
  sorts null behind every real option and no lane names it).

## `create` has no default landing state

`--intake` (minimal detail, Priority/Estimate optional) or `--backlog` (both
REQUIRED, each missing one named in the refusal); neither flag → a refusal
naming both lanes. This is a deliberate breaking change:

- Intake-by-default would silently pile up the loop's own follow-up filings
  awaiting approval.
- Backlog-by-default is the status quo this issue closes.
- A config default would make a bare `create` mean different things in two
  repos.

The readiness bar itself lives in ONE helper, `backlogReadinessGaps`, called
by both the approval edge and the `create` lane — two spellings of "approved
and rankable" held apart by a comment is the GH-1843 drift shape. This
supersedes GH-1792's stderr nudge, which existed only because there was no
lane for "I do not know the priority yet"; that filing has `--intake` now, so
the bar is enforced instead of suggested.

## Surfaces

- `next`/`frontier` exclude Intake by construction, pinned by a test — the
  day someone rewrites the filter as `state !== "Done"`, nothing else would
  notice.
- **The epic in-flight probe was a second reader that had the same bug
  waiting to happen.** It was written as `state !== "Backlog"`, which would
  have read an unapproved *child* as work in progress — demoting its root out
  of the queue and reporting an in-flight epic whose holder cannot exist. It
  now excludes Intake explicitly, the same fix as the ranking lanes.
- `list` shows Intake by default — hiding a tier from the human
  truth-telling surface would recreate the invisibility the whole unit exists
  to remove.
- `tend-queue`'s existing `unformed` category takes Intake items with their
  age; no new category was needed.
- `doctor` gains an advisory `intake-stale` line (`RALPH_SMELL_INTAKE_DAYS`,
  default 14) under the info rules in full: never strict-escalated, never
  fixed by `--fix`, because the only remedies are a human's approval or
  rejection — a fixable "fix" here would be false.
- `deliver-queue`, `prune` and `board-volume` are untouched by construction:
  none of them read Workflow State in a way Intake changes.

## `board setup` adds the option itself (GH-2127)

`updateProjectV2Field` replaces the whole option set, so every existing
option is resubmitted *with its id* — the documented mechanism for
preserving item values — and the add is verified by **id survival**, never
by the API's ack (an ack says the call succeeded, not that ids survived).
An unreadable current option set refuses the mutation and prints the manual
step instead, because a blind resubmit is exactly the destructive write the
id mechanism exists to prevent.

Until the option exists — a board whose option set could not be read —
every Intake filing and move fails closed on `mutationCache`'s missing-option
refusal, which is the correct direction: better to refuse a write than
silently drop it into an option that doesn't exist yet.

## Deliberately unchanged

- **State-guard adoption still lands Backlog.** An auto-adopted
  release-failure filing (GH-1952) must reach a driver unattended; routing it
  through Intake would strand it awaiting an approval nobody is watching for.
- **`reopen` still lands Backlog.** Same reasoning — a reopened item is
  already-approved work resuming, not a new filing awaiting a decision.
