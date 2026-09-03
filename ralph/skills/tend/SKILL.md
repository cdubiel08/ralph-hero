---
description: Backlog shape and Done audit — one bounded hygiene pass. Dedups and dependency-wires issues, detects stale bodies against the live tree, forms observations into tracked issues with provenance, audits recent closes. Metadata-only; every closure is PROPOSED via a tracked marker comment, never executed. Triggers on "tend", "tend the backlog", "groom the board", "backlog hygiene", "audit the done column".
argument-hint: "[<issue-number> | (empty = take the tend queue in order)]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
---

# /ralph:tend — the board's gardener, not its judge

One bounded pass over the tend lane: Backlog shape (dedup, dependency wiring, stale-body detection, intake formation) and the Done audit. This lane closes the observation→tracked-work edge. It writes **metadata only** — issue bodies, titles, comments, `board dep`/`link` edges, Priority/Estimate fields, `board create` — never code, branches, PRs, claims, or state transitions on In Progress / In Review items (comments there at most).

The board CLI is `${CLAUDE_PLUGIN_ROOT}/scripts/board` — that placeholder resolves to wherever this plugin is installed; never substitute a repo-relative path. Below, `board` is shorthand for it.

## Judgment boundary (Sonnet-may / lead-decides, GH-2353)

**Yours alone, no escalation** — everything a clean sweep needs: dep-edge
judgment against the blocked-by test (a real edge → wire it, no edge →
dismiss with a reason; both are recorded, reversible moves, not scope
changes), freshening a body you verified against the live tree, forming an
unformed item (estimate, priority, parent/dep wiring per
[../work/references/work-shape.md](../work/references/work-shape.md)), pulling
a surfaced observation into a tracked `--intake` issue with provenance, and
every marker this lane writes (`proposed`, `audited`). None of these commit
the board to anything irreversible — a wired dep can be re-judged, an intake
item still needs approval before anyone works it.

**The lead's (or, solo, the human's) call, never tend's** — unchanged from the
rest of this file, restated once: whether a proposed closure is real
(`board resolve --accept|--reject`), and whether a done-audit gap means
reopening. This lane's proposals are deliberately **not** a C9 escalation —
`Backlog → Human Needed` is illegal, and a proposal is asynchronous, not a
paused unit (see
[../work/references/escalation.md](../work/references/escalation.md)) — so
there is no lead-address to route through the way `/ralph:work` and
`/ralph:deliver` route Human Needed (GH-2179); the marker just sits in
`board tend-queue`'s `proposed` category until whoever is adjudicating the
backlog — lead or human — answers it. Never read a pending proposal's silence
as consent, and never re-propose the same closure without new evidence.

## One pass

`board tend-queue --json` classifies; you judge. Work the queue in order, at most **`RALPH_TEND_BATCH` (default 5) items per pass**, then exit — a hygiene lane that runs long stops being hygiene. The lane's goal state is a **clean sweep**: a pass with `checked>0, acted=0` and no new observations pulled (an empty queue is the degenerate case — `checked=0`, nothing accumulated; both end the loop). You are a single-pass operator: whatever invoked you decides whether another pass happens — never arrange one yourself.

Inherited from /ralph:work, verbatim: board truthful at all times; findings outlive the transcript; decisions journaled via `board comment`; scope is the selected item.

Per category:

- **proposed** — a closure proposal is on file and still **pending** (marker below), awaiting a human. It may be an open item's `close-as-delivered` or a closed one's `reopen-as-unevidenced` — either way, do not re-propose. Re-state it only if you found *new* evidence that changes the recommendation, and say what changed.
- **stale-body** — *grep the live tree before trusting any issue body* (this repo's documented failure mode: deliverables already landed, or the target architecture was deleted by a cutover). Body still accurate → freshen a line, note the check in a comment. Deliverables landed or superseded → that is a **closure proposal**, below.
- **deps-cleared** — every blocker closed: either the wait is genuinely over (comment that it is now actionable) or the edge was stale (`board dep NNN --on MMM --rm`, with a comment naming why).
- **deps-truncated** — the board cannot see its own edges; prune or restructure the blocker list so it fits, journaling what moved.
- **deps-unwired** — the row carries its scored candidates inline (`candidates`: number, overlap, shared terms — no second read needed). Candidates are NOT dependencies: term overlap, recall-biased (GH-2135). Judge each with the blocked-by test from [../work/references/work-shape.md](../work/references/work-shape.md): a real edge → `board dep NNN --on MMM`; no edge → `board dep NNN --on MMM --dismiss -m "why"` — the dismissal is the durable answer that stops the pair re-surfacing, and one judgment clears both endpoints' rows. Never leave a candidate unjudged-but-looked-at: an unrecorded "probably fine" re-surfaces every pass.
- **unformed** — likely raw intake, missing an estimate or a priority (a null priority ranks behind every P3 in `board next`, so an unprioritized item is not deprioritized, it is unreachable — GH-1796): give it an outcome-shaped body, an estimate, a priority (`board priority NNN P2`), and parent/dep wiring per [../work/references/work-shape.md](../work/references/work-shape.md) — the unit definition, Estimate as agent context budget, and the blocked-by test (`board dep` only where the diff cannot be written or verified until the blocker merges; `board link` for rollup — and moving a child to a different parent is `board link NEWPARENT CHILD --replace`, one atomic mutation; `board link PARENT CHILD --rm` detaches it). If it duplicates existing work: comment on both, wire the survivor, and propose the duplicate's closure.
- **done-audit** — verify the close is real (merged PR, evidence comment, artifacts named). Sound → post the audit marker (below). Not sound → the same proposal marker with `"action": "reopen-as-unevidenced"` and the evidence gap named; the item then surfaces as **proposed**, not done-audit, until a human answers it. An item whose proposal was already answered arrives here for its audit — audit it, don't re-litigate the disposition. **These rows are the exceptions, not the close rate (GH-2151):** a close carrying the gated Done lane's own evidence — a merged closing PR in GitHub's linkage, or shape-valid `ralph-decision-evidence:v1` / `ralph-apply-evidence:v1` evidence, judged by the close gate's own validators — self-audits at read time and arrives here only as the selector's `evidenced` count. What DOES surface is the no-closing-keyword population the audit exists for, and it is *expected*, not suspicious: epic-root rollup closes (GH-2198 — all children closed, no PR and no comment of its own), `--why` closes, branch-linkage-only closes (GH-1996 — a merged PR on the issue's branch without a closing keyword, invisible to the linkage read), and closes whose PR merged outside GitHub's linkage entirely. Cancellations (NOT_PLANNED) never enter the audit — a cancellation claims nothing to verify.
- **Observations** (the `observationSlot`) — your judgment whether to pull surfaced observations (dream-loop reflections, doctor smells, your own findings while grepping) into tracked issues this pass: `board create --intake` with a **provenance comment** — an observation you formed is tracked, not approved; a human promotes it with `board move NNN backlog` — what was observed, where, when. Counting toward the batch budget.

## Closures are proposals — the contract rule

Close-as-stale / cancel-as-superseded / reopen-as-unevidenced are **never executed by this lane**. This is the trust ratchet's deliberate starting position — promoting tend to direct closure is a future loosening someone must choose, not a default you drift into.

A proposal **files as a marker comment, not as a state move** (GH-1777). Post the evidence (what you grepped, what landed where, what supersedes it) plus your recommendation, and stamp it. The marker is not a C9 escalation — nothing is stopped, so it carries no `options`/`resume` — but its prose is composed the same way, per [../work/references/escalation.md](../work/references/escalation.md): the smallest true decision, the look-alikes that are *not* decisions named and set aside, what does not change across the dispositions, and the literal `board resolve`/`move`/`cancel` line for each. A proposal whose recommendation is **contingent** on an in-flight unit says so and wires the `board dep` edge, rather than asking a question that cannot be answered yet.

````text
<!-- ralph-tend:v1 proposed -->
```json
{"action": "close-as-delivered", "at": "<iso8601>", "recommendation": "<one line>"}
```
````

The marker is the cursor in both directions: `board tend-queue` re-surfaces the item under the **proposed** category while the proposal is *pending*, and that is why you must not re-propose the same closure next pass. `board doctor` names proposals left unanswered past `RALPH_SMELL_PROPOSAL_DAYS` (7) as an advisory `i` line.

Do **not** use `board move NNN human-needed` for this. Human Needed is a pause on in-flight work — `answer` resumes it into In Progress — and `Backlog → Human Needed` is illegal by design.

### Pending until answered — the other half of the marker

A proposal you cannot answer is a proposal the lane re-surfaces forever, and the clean sweep (`acted=0`) never arrives. So *pending* is computed, not assumed:

- A **`<!-- ralph-tend:v1 resolved -->`** marker answers the newest proposal above it. `board resolve NNN --accept|--reject -m "why"` writes it; `board reopen NNN` writes one itself, because reopening **is** the acceptance of `reopen-as-unevidenced`.
- On a **closed** item, a proposal filed at or before the close was answered *by the close* — that is what accepting `close-as-delivered` looks like — and the item flows on to the Done audit. Only a proposal filed after the close is still pending.

Both are the human's business, not yours: this lane files proposals and reads their disposition, it never writes a resolution marker. A rejected proposal returns the item to its ordinary category — treat that as a decision, not an invitation. Re-propose only with **new** evidence, and say what changed. (An `unformed` item whose duplicate-closure proposal was rejected still wants forming; form it.)


## Exit — every pass, even a clean sweep

1. On each Done item you audited: post the marker comment — `<!-- ralph-tend:v1 audited -->` followed by fenced JSON `{"at": "<iso8601>", "artifacts_checked": <n>}`. The marker is the cursor; a deleted one costs one redundant audit, never a wrong mutation.
2. `mkdir -p "$RALPH_HOME"` (default `~/.ralph`) first, then append `<iso8601> tend GH-<n> rc=<code> checked=<N> acted=<M>` to `$RALPH_HOME/tend.outcomes.log` and touch `$RALPH_HOME/tend.heartbeat` — surface a write failure rather than swallowing it. An empty pass writes `GH-none` in the subject slot; the line still lands.
3. Report, as your final output, the uniform pass report every lane shares: `checked`/`acted`, the blocked-reason set (tend's selector blocks nothing — an empty set, said explicitly), the earliest window expiry (tend has no time-bounded windows — `none`), what you proposed vs applied, and whether this was a clean sweep — the goal state; re-entry is by accumulation, and that is the transport's business, not yours.
