---
description: Backlog shape and Done audit — one bounded hygiene pass. Dedups and dependency-wires issues, detects stale bodies against the live tree, forms observations into tracked issues with provenance, audits recent closes. Metadata-only; every closure is a proposal via Human Needed, never executed. Triggers on "tend", "tend the backlog", "groom the board", "backlog hygiene", "audit the done column".
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

## One pass

`board tend-queue --json` classifies; you judge. Work the queue in order, at most **`RALPH_TEND_BATCH` (default 5) items per pass**, then exit — a hygiene lane that runs long stops being hygiene. The lane's goal state is a **clean sweep**: a pass with `checked>0, acted=0` and no new observations pulled (an empty queue is the degenerate case — `checked=0`, nothing accumulated; both end the loop). You are a single-pass operator: whatever invoked you decides whether another pass happens — never arrange one yourself.

Inherited from /ralph:work, verbatim: board truthful at all times; findings outlive the transcript; decisions journaled via `board comment`; scope is the selected item.

Per category:

- **stale-body** — *grep the live tree before trusting any issue body* (this repo's documented failure mode: deliverables already landed, or the target architecture was deleted by a cutover). Body still accurate → freshen a line, note the check in a comment. Deliverables landed or superseded → that is a **closure proposal**, below.
- **deps-cleared** — every blocker closed: either the wait is genuinely over (comment that it is now actionable) or the edge was stale (`board dep NNN --on MMM --rm`, with a comment naming why).
- **deps-truncated** — the board cannot see its own edges; prune or restructure the blocker list so it fits, journaling what moved.
- **unformed** — likely raw intake: give it an outcome-shaped body, an estimate, and parent/dep wiring where it obviously belongs (`board link`, `board dep`). If it duplicates existing work: comment on both, wire the survivor, and propose the duplicate's closure.
- **done-audit** — verify the close is real (merged PR, evidence comment, artifacts named). Sound → post the audit marker (below). Not sound → closure-proposal machinery in reverse: propose reopening via Human Needed with the evidence gap named.
- **Observations** (the `observationSlot`) — your judgment whether to pull surfaced observations (dream-loop reflections, doctor smells, your own findings while grepping) into tracked issues this pass: `board create` with a **provenance comment** — what was observed, where, when. Counting toward the batch budget.

## Closures are proposals — the contract rule

Close-as-stale / cancel-as-superseded / reopen-as-unevidenced are **never executed by this lane**. Post the evidence (what you grepped, what landed where, what supersedes it) and `board move NNN human-needed --why "<proposed action + evidence + your recommendation>"`. The human's answer is the execution path. This is the trust ratchet's deliberate starting position — promoting tend to direct closure is a future loosening someone must choose, not a default you drift into.

## Exit — every pass, even a clean sweep

1. On each Done item you audited: post the marker comment — `<!-- ralph-tend:v1 audited -->` followed by fenced JSON `{"at": "<iso8601>", "artifacts_checked": <n>}`. The marker is the cursor; a deleted one costs one redundant audit, never a wrong mutation.
2. `mkdir -p "$RALPH_HOME"` (default `~/.ralph`) first, then append `<iso8601> tend GH-<n> rc=<code> checked=<N> acted=<M>` to `$RALPH_HOME/tend.outcomes.log` and touch `$RALPH_HOME/tend.heartbeat` — surface a write failure rather than swallowing it. An empty pass writes `GH-none` in the subject slot; the line still lands.
3. Report, as your final output, the uniform pass report every lane shares: `checked`/`acted`, the blocked-reason set (tend's selector blocks nothing — an empty set, said explicitly), the earliest window expiry (tend has no time-bounded windows — `none`), what you proposed vs applied, and whether this was a clean sweep — the goal state; re-entry is by accumulation, and that is the transport's business, not yours.
