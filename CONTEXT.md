# Vocabulary

The terms the board's work is described in. This file is a verbatim projection
of §2 of the work-shape design record, which stays normative — a future edit
lands in the record first. CLAUDE.md points to both.

- **unit** — one issue whose completion is one PR that is independently
  mergeable. The atom of board work.
- **independently mergeable** — no other PR must land before this one can. A
  property of the decomposition, decided when the work is cut.
- **fresh** — the branch's merge-base is the current head of the default
  branch. A property of a moment; it decays on every merge to main.
- **verified-as-landed** — the tree that actually lands was tested in the
  state it will land in. A property of verification.
- **epic** — a board item with open board-resident descendants (children,
  transitively — a closed intermediate item passes through). Derived from the
  parent edges, never declared.
- **frontier** — the set of mutually unblocked, eligible units the ranker
  offers for concurrent pickup.
- **blocked-by** — the ordering edge (`board dep`): this unit's diff cannot be
  written or verified until the blocking unit has merged.
- **parent** — the rollup edge (`board link`): drives priority inheritance and
  parent-check. Asserts nothing about ordering.
- **estimate** — the unit's agent context budget (XS–XL): how much of one
  session's context window the unit consumes, not how long a human would take.
- **apply unit** — a unit whose completion is a deploy, not a merge; closes on
  evidence, never on a closing keyword.
- **feature** — prose about a user-visible outcome. Not a board concept; no
  rule keys on it.
