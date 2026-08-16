# Demo narration — GH-1883 / PR #2014, `board prune` relationship gating

Rung: **slides + captions**. `board prune` is a CLI surface with no web UI, so
there is no browser session to capture; per the ladder in
`plugin/ralph-demo/skills/demo/SKILL.md` that is an honest artifact, not a
degraded one. The terminal panel is real output from a live `board prune` run on
this board on 2026-08-16, pasted verbatim — not a mockup.

Video: 1920x1080, h264, 59.05s, 1770 frames @ 30fps.
Composition: `plugin/ralph-demo/remotion/src/Demo.tsx` (bespoke; slides,
terminal, table, caption band).

## Captions, timestamped

| t | caption |
|---|---|
| 0:00 | GH-1883 closed the last two ungated relationship edges in board prune. |
| 0:05 | Pruning removes the board item, not the issue — Workflow State and Claim go with it. |
| 0:09 | That is one-way, so the predicate has to fail closed on anything another reader still needs. |
| 0:14 | sibling-edge: a closed item is held while it shares an own-repo parent with an open one. |
| 0:18 | Exactly one hop — a sibling's siblings are not walked. |
| 0:23 | blocks-edge: GitHub has no inverse blocks connection to read. |
| 0:28 | The inverse falls out of the forward edge, so nothing new is queried and the cost is unchanged. |
| 0:33 | Run live against this board: 818 closed items, none prunable today. |
| 0:40 | 17 held by sibling-edge and 3 by blocks-edge — reasons that did not exist before this change. |
| 0:46 | Measured with RALPH_GQL_COST=1: the GraphQL document is byte-identical. 16 pages, 48 points, before and after. |
| 0:54 | And the retention tally now prints on every path, not only when there is nothing to prune. |

## Grounding

Every claim above is checkable against the shipped change:

- `sibling-edge` / `blocks-edge` as retention reasons — `ralph/scripts/board.ts:6125-6126`.
- Both gates sit **before** the age check — `board.ts:6234-6242`.
- `blockersUnknown` taints every candidate (fail closed) — `board.ts:6241`.
- Retention tally printed on every path — `board.ts:8221`.
- Cost 16 pages / 48 pts before and after — PR #2014's own `RALPH_GQL_COST=1` measurement.
- Terminal panel — verbatim stdout of `board prune` (dry run; no `--apply`), 2026-08-16.
