---
date: 2026-09-03
issue: GH-2365
topic: worktree.remove leaves the ledger open until the next reconcile — root cause and recommendation
status: shipped
---

# GH-2365 — `worktree.remove` never fires `pane.exited`/`pane.closed`: root cause and recommendation

## Question

Does herdr fire `pane.closed`/`pane.exited` to plugin event hooks when a pane
dies under `worktree.remove`? If not, is this a herdr-side gap, or should our
own scripts precede `worktree remove` with an explicit agent stop so the exit
lands with a real reason instead of `swept-unknown`?

## Finding: confirmed herdr-side ordering race, 100% reproduction

`~/.config/herdr/herdr-server.log` carries every `cli:worktree:remove`
invocation from 2026-09-02 through 2026-09-03. Every single one (24 checked,
0 exceptions) follows the identical sequence:

```
INFO api request received  request_id="cli:worktree:remove" method="worktree.remove"
INFO workspace closed      event="workspace.close" workspace_id="w6Z"
INFO workspace focused     event="workspace.focus" workspace_id="w6B"   (UI refocus)
INFO pane child exited     event="pane.exit" pane_id=32 status="ExitStatus { code: 1, .. }"
INFO pane session terminated  pane=32 pid=73788 signal=Kill
WARN PaneDied for unknown pane pane=32
INFO api request completed request_id="cli:worktree:remove" method="worktree.remove"
```

`workspace.close` (the workspace's own internal bookkeeping) runs
**synchronously inside the `worktree.remove` handler**, before the pane's OS
process has even been reaped. The pane's own death is detected
**asynchronously**, after the workspace/pane records are already gone from
app state — so the death-detector logs `WARN PaneDied for unknown pane`
instead of emitting a `pane.exited`/`pane.closed` event with a valid payload.
This is a genuine implementation race in `worktree.remove` itself, not a rare
flake or a caller misuse: the WARN appears on every occurrence in the log,
regardless of which of our scripts (interactive, `work-fleet.sh` cleanup, or
manual) issued the remove.

This confirms and sharpens the issue body's own observation (12 workers,
`01:20:32Z`–`01:53:18Z`, all swept `swept-unknown` 40 minutes later by the
next `[[startup]]` reconcile) — it is not specific to that batch or to any
timing edge case in our scripts. `ralph-herdr`'s `watch-event.sh` subscribes
only to `pane.agent_status_changed`, `pane.exited`, and `pane.closed`
(`herdr-plugin.toml` `[[events]]`, confirmed at HEAD); none of the three can
ever fire correctly for this path, so no change to our own event handling
logic closes the gap — the input event itself doesn't arrive with a usable
payload.

## A workaround does exist, independent of a herdr fix

`herdr api schema --json` (herdr 0.8.2, this machine) lists a fourth,
currently-unused subscribable event that *is* available and *is* payload-complete
for this exact case:

```
worktree.removed → { type: "worktree_removed", workspace_id, workspace?, worktree, forced }
```

`worktree` (`WorktreeInfo`, non-nullable, required) carries `.path` — the
absolute worktree checkout path — regardless of whether the pane/workspace
bookkeeping already forgot itself. Unlike `pane.exited`/`pane.closed`
(payload: `{pane_id, workspace_id}`, no agent correlation possible once the
pane is "unknown"), `worktree.removed` needs no pane lookup at all.

Our own ledger already records, per open `agent_ref`, its last-known
checkout path (`_ralph_ledger_latest_checkout`, `plugin/ralph-herdr/scripts/ledger.sh:1047`,
backing the `checkout` column documented at `ledger.sh:899`). **`checkout` is
not guaranteed on every open record, though** — `ledger.sh:1039-1043` notes
older discovery records predate the field, and `_ralph_spawn_record`
(`lib.sh:575`) omits it when the captured path is empty — so a
`worktree.removed` handler cannot assume every open ref is path-addressable;
the implementation needs a fallback (e.g. fall through to the existing
pane-id path when `checkout` is absent, or hydrate it once from the
worktree's own recorded cwd) rather than silently leaving a
checkout-less ref stale until the next reconcile, which reproduces the exact
gap this unit is closing. Left to GH-2434's implementation, not resolved
here (codex review, PR #2436).

That means a `worktree.removed` handler can resolve the dying agent(s) by
matching `event.worktree.path` against each open ref's latest recorded
checkout,
instead of `handle_gone`'s current pane-id correlation
(`ralph_ledger_open_for_pane`, `ledger.sh:855`) — no pane lookup, no race with
herdr's own internal teardown ordering.

## Recommendation

Two independent tracks, deliberately not built inside this investigation
unit (S-sized; a real fix touches `herdr-plugin.toml`'s `[[events]]`,
`watch-event.sh`, `ledger.sh`, and their test suites):

1. **herdr-side**: this machine has no in-repo herdr source and no
   documented upstream tracker reachable from this repo — reporting it is
   outside this repo's scope. The reproduction above (log lines, 100% hit
   rate) is written down here so whoever owns herdr next has it verbatim.
2. **ralph-herdr-side workaround** (filed as GH-2434, `--backlog`,
   Priority P3, Estimate M): subscribe `watch-event.sh` to `worktree.removed`
   and correlate the exit through the ledger's own `checkout` path instead of
   `pane_id`, closing the ledger-staleness window (currently 40 min, bounded
   only by the next server restart's `[[startup]]` reconcile) without
   depending on a herdr-side fix arriving at all.

Deliberately unchanged: the `[[startup]]` reconcile stays the backstop for
every gap this class of race can produce (server down entirely, a future
herdr regression, etc.) — the recommendation above is a narrower, faster
correction for the one path that is currently silent 100% of the time while
the server is running.
