# Do herdr panes forward terminal focus events? (GH-1876)

Date: 2026-08-14 · herdr 0.8.0, macOS arm64 · answer: **yes**

## Why it was asked

GH-1805 shipped the event-coupled adaptive board cadence and deliberately left
terminal focus out: focus reporting is DECSET 1004, a mode the *host* must
support and the multiplexer must *forward*, and herdr is not tmux (no
`focus-events` option to read — `tmux` is not even installed here). Unprobed,
the feature would have been a guess.

## Probe

A pane running a raw-mode Python reader that enables `\e[?1004h` and logs every
byte it receives, driven entirely from the CLI:

```
herdr pane split --pane w19:p1 --direction down --no-focus   # probe lands unfocused
herdr pane send-text w19:p2 'python3 focusprobe.py\n'
herdr pane focus --pane w19:p1 --direction down              # focus → probe
herdr pane focus --pane w19:p2 --direction up                # focus → away
```

Log:

```
IN b'\x1b[I'   # FocusIn  — pane gained focus
IN b'\x1b[O'   # FocusOut — pane lost focus
```

Both arrive, paired, on pane switches within one tab. So the transport carries
it and `tea.WithReportFocus()` / `tea.FocusMsg` / `tea.BlurMsg` are live inside
a herdr pane.

## What was wired

`main.go` adds `tea.WithReportFocus()`; `update.go` handles `tea.FocusMsg`
(snap to floor, same evidence a keypress carries) and `tea.BlurMsg`
(`blurToCeiling()` — one step to the staleness bound, not the ×1.5 ramp).

## The failure mode named in the issue

A terminal that sends `BlurMsg` and never `FocusMsg` cannot strand the cadence:

- the ceiling (`RALPH_COCKPIT_INTERVAL_MAX`) *is* the stated staleness bound, so
  blur can only reach a state unchanged polling reaches anyway;
- an unset ceiling collapses to the floor, so "backoff off" means "blur backoff
  off" too;
- a keypress snaps back, and a pane you are not focused on is a pane you cannot
  type into.

A host that does not support 1004 at all simply never sends the events, and the
cadence is exactly what GH-1805 shipped.

## Not probed

Whether the *outer* terminal emulator hosting herdr forwards focus when the OS
window itself loses focus. Untested and not load-bearing: if it does, the
cockpit backs off more; if it does not, behaviour is the pane-switch case above.
