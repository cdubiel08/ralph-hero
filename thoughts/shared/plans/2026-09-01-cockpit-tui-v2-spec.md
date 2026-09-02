# Cockpit TUI v2 — locked spec

Date: 2026-09-01
Status: approved (operator, 2026-09-01, after three mock rounds)
Scope: `plugin/ralph-herdr/cockpit/` — `view.go`, `signals.go`, `model.go`, `update.go`. Rendering and one new overlay; no new board reads except the epic popover's `board get`.
Mock renderer: `2026-09-01-cockpit-tui-v2-mocks.py` beside this file. Run it in a pane to see every state:

```
python3 2026-09-01-cockpit-tui-v2-mocks.py --glyphs nerd --width $(tput cols) --height $(tput lines) \
  | LESSUTFCHARDEF='E000-F8FF:p,F0000-FFFFD:p' less -R
```

(`less` classes the Nerd private-use range as binary and prints `<U+XXXX>` without that variable; the same trap bit the Pi setup.)

## Invariants carried over unchanged

- `cardRows` stays 4 and every card is uniform in every state; selection changes ink only. `hitTest` is untouched.
- The legend never exceeds `maxLegendRows`; the body shrinks as the legend grows.
- Every "could not read" renders distinguishably from "nothing there" (`±?`, `⇅ ?`, `$—`, `stale Nm`).
- Branch/meta ink (240), epic ink (60 italic), gutter (237), rule (236) are **not** changed. Only the age and `[est]` inks move (244/240 → 246).

## 1. Glyph tiers

Three tiers, the pi-kit shape: `nerd`, `unicode`, `ascii`. Selected by `RALPH_COCKPIT_GLYPHS`; anything not exactly `nerd` or `ascii` is `unicode`. **Decision to confirm:** `unicode` becomes the default (today it is ascii-with-dots). Every unicode glyph is single-cell BMP, so the grid cannot shear.

Herdr **state** glyphs are Unicode dots and circles in **every** tier, including nerd. Nerd glyphs are used only for the chips below. Every nerd codepoint verified present in JetBrainsMono Nerd Font (cmap check, 2026-09-01):

| chip | nerd | unicode | ascii |
|---|---|---|---|
| branch | U+E725 | ⎇ | (none) |
| fleet count | U+F0C0 | × | x |
| PR | U+F407 | ⇅ | pr |
| merge (closing PR) | U+F419 | ⌥ | M |
| epic caret | ❯ | ❯ | > |
| dollars | U+F155 | $ | $ |
| tokens (coin) | U+EDE8 | ¤ | tok |
| context | U+F50C | ⛶ | ctx |
| P0 bang | U+F12A | ! | ! |
| status ok / err | U+F00C / U+F00D | ✓ / ✗ | ok / !! |
| stalled | U+F071 | ◍ | x |
| live spinner | braille ⠋… | same | \| |

The clock glyph before the age is dropped in all tiers: right-justified `1h 12m` on line 3 has meant "age" since GH-2061.

**Implementation note:** write the nerd tier as `\uXXXX` escapes in Go source. The raw PUA characters were silently dropped by one editor write during this design and the tier became a set of empty strings; escapes cannot be lost that way.

## 2. State vocabulary (the gutter dot)

| state | glyph | ink | means |
|---|---|---|---|
| starting | ◌ | 246 | pane exists, no self-report yet (spawned/briefed) |
| working | ● | 11 yellow | live motion |
| reporting | ◕ | 75 blue | the session's close-out: PR opened, evidence posted, handing back |
| blocked | ● | 203 red | escalated; a human or the lead holds the answer |
| idle | ○ | 114 green | alive, waiting for input |
| done | ● | 114 green | herdr `done` / the GH-2348 `finished` exit |
| none | · | 237 | no live agent for this card |

`joinAgentState` change: herdr `done` maps to a new `stateDone`, no longer collapsed into idle. Rank: blocked 0, reporting 1, working 2, starting 3, idle 4, done 5, unknown 6. Done and working are both filled and differ by colour only — deliberate. A Done-column card always draws the done dot.

## 3. Line 3 lead: priority and estimate

- P0: the bang glyph, red 203, bold, padded to 2 cells so the row aligns.
- P1: `P1` orange 208. P2: `P2` yellow 220. P3: `P3` white 15. Unset: `P?` red (unchanged rule).
- `[est]` in 246.

## 4. Epic chip

`❯ #2346 worker token economics 2/7` — caret purple 141, number and title italic 60 (unchanged), tally 141. **The title is all-or-nothing**: it is drawn only when the whole title fits the budget, otherwise `❯ #2346 2/7`. Never a trimmed `worke…`, which reads as a different issue.

## 5. Cost and context

Source: herdr's `agent_session.value` is the worker's Claude session id; `~/.claude/projects/<cwd-slug>/<id>.jsonl` carries a `usage` block per call (dedupe by `message.id`). Priced at list rates with the 1-hour cache multiplier. Machine-local, zero API calls. The GH-2347 ledger `usage` fact is the durable record for units whose transcript is gone. Dollars are rate-limit weight, not a bill.

- **Card chip**: `$2.41` — `$` glyph + amount, colour **65, italic**. Line 3 right slot, left of the age, on In Progress / In Review / Human Needed cards; right of `closed N ago` on Done cards.
- Unread (session known, transcript unreadable): `$—` in 242. No session: no chip.
- **Column header**: the column's total in the same ink, left of the count.
- **Context alert**: `⛶151k` between cost and age, shown **only** when the last call's input+cache tokens ≥ 120k. Amber 214 to 160k, red 203 beyond. Below 120k nothing is drawn; a healthy context is not a fact the operator acts on. Unread context is not distinguishable from healthy by design; the `$—` beside it carries the unread fact.

## 6. Frame header

`ralph cockpit — <repo>  ⠋` then, right-justified: fleet by state (`● 4  ◕ 1  ● 1  ◌ 1  ○ 1`, each in its state ink), `$40.48 today` (65 italic), ` 3.1M` tokens (180), `$6.20/h` burn rate (65 italic), `gql 3,812`. Width cuts from the right.

- The `polled HH:MM:SS · every Ns` text is removed.
- **Liveness**: the spinner after the title advances on every poll that lands on cadence. When a poll is overdue or fails it stops and becomes amber `◍ stale 4m` (age of the last successful poll). This replaces the cadence text as the "is it alive" signal.
- No event ticker. The banner row keeps its error-only role.

## 7. Selection

The white bold `▌` bar and bold ink as today, **plus a wash of `#111629`** (the Tokyo Night Clear background `#0b1020` lifted +6 per channel) painted under the three content rows, never the rule. True-colour only; when the terminal does not advertise it (`COLORTERM` not `truecolor`/`24bit`), draw no wash rather than a 256-colour grey, which reads as a slab on navy.

## 8. Done column cards

- Gutter: done dot (● green).
- Line 1 right slot: purple 141 merge glyph + `#PR` for the PR in `closedByPullRequestsReferences` — the field the Done gate and tend audit read. No chip when there is none, which is exactly the no-closing-keyword population the audit exists for.
- Line 3: `closed 3h 12m ago` (meta ink) + cost right-justified when a transcript exists.

## 9. Legend, pinned to the bottom

The footer is the last rows of the pane: row 1 card verbs, row 2 navigation and views (dim), row 3 the status line. The body is padded so these never float.

Row 1 is **derived from the selected card**, the same way each verb's own refusal is, so the legend cannot disagree with `verb*`. Unavailable verbs are **hidden** (option A); a refused press still names the reason on the status line. The first verb is the primary and is bold.

| selection | row 1 |
|---|---|
| In Progress, one live agent, parented | ⏎ observe · ␣ peek · r reply · f fork · d diff · e epic · g browser |
| In Progress, one live agent | ⏎ observe · ␣ peek · r reply · f fork · d diff · g browser |
| In Progress, no live agent | s spawn · d diff · g browser |
| In Progress, fleet ≥ 2 | ⏎ observe w-lane · ␣ peek · r reply · d diff · (e epic) · g browser |
| In Review, no live agent | d diff · s spawn · g browser |
| Human Needed, blocked agent up | a answer · r reply · ⏎ observe · ␣ peek · (e epic) · g browser |
| Human Needed, no session | a answer · g browser |
| Done | g browser · d diff · D back to Human Needed |
| Inbox decision | a answer · g browser |
| Inbox proposal / approval / deliver-blocked | g browser |
| no card | (no card — views only) |
| no herdr | g browser · d diff |

`e epic` appears only when the card has a parent. Row 2, constant: `h/l j/k move · v dag · T topology · i inbox · D done · I inbox-col · q quit`. Overlay legends: peek `esc close · r reply · ⏎ observe · j/k scroll`; epic `esc close · j/k child · ⏎ observe · ␣ peek · g browser`. (`r`/`⏎` from peek and the epic overlay's verbs are new behaviour, not just rendering.)

## 10. Status line

A leading glyph types the message before it is read: spinner (yellow) in flight; ✓ green success; ✗ red refusal with the reason verbatim; ● amber for a nudge (`no live agent for #2372 — s spawns one`); `·` dim for a view change. A transient board failure names the retry and the reset time.

Column headers carry their own in-flight state left of the count: a spinner while that column's read is out; `stale Nm` amber when the last read failed and the cards shown are the last good ones.

## 11. The `e` epic popover (new)

A bordered overlay (rounded, like peek) over the body. Title row: `epic #2346 — worker token economics  2/7 done  $14.84  2 live · 1 blocked · 4 backlog · 2 done`. Body: every child as a **board card** in two columns, board order (In Progress, Backlog, Human Needed, Done), the same dot vocabulary and card lines as the board, with the child's **board state in line 1's right slot** (in place of the diff/PR chip, since no column carries it inside the overlay). Backlog children draw no branch and no age. Done children carry the merge glyph and closing PR. Selection uses the same bar + wash. `j/k` moves between children; `⏎`, `␣`, `g` act on the selected child; `esc` closes. Data: one `board get <epic> --json` (children ride the issue fetch) plus the transcript join for the totals.

## Shown and not selected (out of scope)

Mocked in the renderer's "more options" section, explicitly not adopted: age past the claim TTL in amber, a whose-turn word on In Review cards, a stale-lease lock glyph, the escalation audience chip on Human Needed, a `/` filter, `1`–`9` card jump, the event ticker, legend option B (struck-through unavailable verbs), and every ink change other than age and `[est]`.

## Suggested units

1. Glyph tiers + state vocabulary + priority + epic chip + Done merge chip (view/signals/model; pure rendering, no new reads). S.
2. Cost + context chips and header stats via the transcript join (new machine-local reader in `signals.go`, joined on `agent_session.value`). S. Blocked by nothing; the GH-2347 ledger fact extends it to closed units later.
3. Header spinner/stalled, typed status line, in-flight column headers, footer pinned to the bottom, contextual legend. S.
4. Selection wash with the truecolor gate. XS.
5. `e` epic popover, including its overlay verbs. M.
