---
date: 2026-05-30
issue: 1473
title: "caretake: new watch-blockers mode to auto-advance dependency-unblocked items"
estimate: M
priority: P2
status: ready-for-review
researcher: plan-agent (auto)
git_commit: 11e63284
branch: main
repository: ralph-hero
research: thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md
tags: [plan, caretake, watch-blockers, dependencies, autonomy, gap-c]
---

# GH-1473 — caretake `--mode watch-blockers`: auto-advance dependency-unblocked items

## Overview

Close **Gap C** from `thoughts/shared/research/2026-05-30-ralph-triage-autonomy-gaps.md`: when a
parked item's `blockedBy` (`add_dependency`) edges all close, nothing advances it — a human must
notice (observed: landcrawler-ai #512/#515 sat in Human Needed after blocker #904 closed; advanced
by hand 2026-05-30). `advance_issue` is dependency-blind (it walks only sub-issue trees), and the
two existing watchers (`watch-pr`, `watch-upstream`) key off `blocked:*` labels, never dependency
edges or Human Needed.

This plan adds a third watcher — `caretake --mode watch-blockers` — built to **mirror the existing
`watch-upstream` mode shape** (branch-gate → find parked items → check blocker condition → act →
emit terminal token → constraints). It is the downstream resolver that makes triage's
`WAIT-issue=NNN` verdict (shipped by #1472) non-dead-ending: triage parks an item in Human Needed
with an `add_dependency` edge + a `## Escalation` comment naming the blocker; watch-blockers
re-activates it once every blocker closes.

### Dependencies (both SHIPPED on main this session — do not re-plan them)

- **#1470 (Gap A — CLOSED):** `next_actions` / dashboard now reads the real `blockedBy` dependency
  connection (not just `trackedIssues`), so dependency-blocked Backlog items are filtered from the
  picker. This is the read side; watch-blockers is the resolve side.
- **#1472 (Gap D — CLOSED):** `triage.md` now emits the `WAIT-issue=NNN` verdict — moves the item to
  **Human Needed**, writes an `add_dependency` edge (`blockedByNumber: NNN`), posts a `## Escalation`
  comment with the machine-readable advance line `Blocked by #NNN ([title]). Move to Ready for Plan
  once #NNN closes.`, and applies `ralph-triage`. watch-blockers MUST read exactly this format.

The triage `WAIT-issue=NNN` parking contract is the producer; this mode is the consumer. The two
interlock exactly as `WAIT-pr`→watch-pr and `WAIT-upstream`→watch-upstream do.

### Doc-only vs MCP-server scope (verified)

**Doc-only + tests.** The two sibling watchers (`watch-pr.md`, `watch-upstream.md`) are pure skill
docs with **no** mcp-server code and **no** `Stop` postcondition hook (verified: `watch-pr.md:11`,
`watch-upstream.md:11`, `outcome-tokens.md:99,107` — "watch-* has no Stop postcondition hook, parity
with hygiene/trends; token emitted by convention"). watch-blockers follows the same shape. All tools
it needs already exist in `mcp-server/src/tools/relationship-tools.ts` (verified):

- `ralph_hero__list_dependencies` (registered `relationship-tools.ts:514`) — reads `blockedBy`/`blocking` edges + each edge's `state`.
- `ralph_hero__remove_dependency` (registered `relationship-tools.ts:428`) — strips the resolved edge.
- `ralph_hero__add_dependency` (registered `relationship-tools.ts:335`) — the edge triage writes (read-only here).
- `get_issue`, `save_issue`, `list_issues`, `create_comment` — already in caretake `allowed-tools` (`SKILL.md:69-74`).

No new MCP tool is needed. No `mcp-server/` change is in scope.

## Files Affected

| # | File | Change |
|---|------|--------|
| 1 | `ralph/skills/caretake/modes/watch-blockers.md` | **NEW** — the mode body, mirroring `watch-upstream.md` |
| 2 | `ralph/skills/caretake/outcome-tokens.md` | Add "Watch-Blockers terminal tokens" section + loop/fan-out note |
| 3 | `ralph/skills/caretake/SKILL.md` | Register mode: frontmatter hints, mode table, dispatch heartbeat fan-out (5→6 children), mode-bodies list, per-mode token quick-ref |
| 4 | `ralph/skills/caretake/modes/triage.md` | One-line cross-ref: name watch-blockers as the now-live consumer of `WAIT-issue=NNN` (it currently says "Gap C `watch-blockers`" as a future) |
| 5 | `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` | **NEW** — doc-structure assertions (mode exists + mirrors shape + token + heartbeat wiring) |

No `mcp-server/` files. No new Stop hook (parity with the other two watchers).

---

## Phase 1 — New mode body `watch-blockers.md`

**File:** `ralph/skills/caretake/modes/watch-blockers.md` (NEW)

Mirror `watch-upstream.md` section-for-section. Concrete content:

- **Title + intro** — `# \`--mode watch-blockers\``. One-paragraph summary: resolve items parked by
  the `WAIT-issue=NNN` triage verdict. Scan OPEN items in **Human Needed** (and Backlog, for
  forward-compat with the Gap-A relaxation noted in triage.md:95/116) carrying a `blockedBy`
  dependency edge OR a `## Escalation` body naming a blocker issue; for each, check whether **all**
  blockers are CLOSED; advance if so, leave if any is OPEN. Autonomous — no human prompts. Emits one
  terminal token (cross-link `../outcome-tokens.md`).
- **`export RALPH_SUBCOMMAND=watch-blockers`** fenced block (parity with `watch-upstream.md:5-7`).
- **No-Stop-hook note** — copy `watch-upstream.md:11` verbatim-style: "No `Stop` hook gates this
  mode (parity with watch-pr/watch-upstream/hygiene/trends) — it mutates only the dependency-parked
  items it owns. The terminal token is emitted by convention, not hook-enforced."
- **§Step 1: Verify branch** — `git branch --show-current`; if not `main`, STOP and emit
  `WATCH-BLOCKERS SKIPPED — branch <name> is not main` (mirror `watch-upstream.md:13-25`).
- **§Step 2: Find parked items** — two complementary sweeps, union the results (dedup by number):
  1. `list_issues(profile: "analyst-triage", workflowState: "Human Needed", limit: 250)` — the
     canonical `WAIT-issue=NNN` parking state.
  2. `list_issues(profile: "analyst-triage", workflowState: "Backlog", limit: 250)` — forward-compat
     for the Gap-A relaxation (a future `WAIT-issue` may park Backlog+edge per triage.md:95/116).
  For each candidate, identify its blocker(s) from **either** signal:
  - **Edge:** `list_dependencies(number: NNN)` → the `blockedBy` connection (each node carries
    `number` + `state`).
  - **`## Escalation` body convention (#1472):** read the issue's `## Escalation` comment; parse the
    blocker number from the `Blocked by #NNN` line and the advance target from `Move to <state> once
    #NNN closes` (default `Ready for Plan` when the line names no explicit target). Honor an explicit
    `advance:` hint if present.
  Prefer the edge when both exist; fall back to the `## Escalation` text when no edge is present
  (e.g. a hand-written escalation). If neither signal yields a blocker number, **skip** the item
  (it is not dependency-parked). If the union is empty, emit `WATCH-BLOCKERS IDLE` and STOP.
- **§Step 3: Check blocker state** — for each parked item, `get_issue(blocker)` for **every** blocker
  number found. Branch table (mirror `watch-upstream.md:48-56` structure):

  | Blocker set | Meaning | Action |
  |---|---|---|
  | ALL blockers `state=CLOSED` (Done or Canceled) | unblocked | **advance** (§Step 4) |
  | ANY blocker `state=OPEN` | still blocked | **leave untouched** (no mutation, not counted) |
  | blocker number unresolvable (get_issue errors) | can't confirm | **leave untouched**, note in summary — never guess |

  Conservative: only an all-CLOSED set advances; anything uncertain leaves the item parked
  (mirror watch-upstream's "never false-advance" posture, §Constraints).
- **§Step 4: Act (advance).** For an all-CLOSED item:
  1. Determine the **advance target**: the embedded condition from the `## Escalation` line
     (`Move to <state> once #NNN closes`), else the `advance:` hint, else **default Ready for Plan**
     (matches the `WAIT-issue=NNN` triage contract, triage.md:161 / outcome-tokens.md:18).
  2. Strip the block: `remove_dependency(number: NNN, blockedByNumber: <blocker>)` for each edge,
     and read current labels then `save_issue(number: NNN, workflowState: <target>,
     command: "ralph_triage", labels: <current minus any blocked:* / ralph-triage so the item is
     re-pickable in its new state>)`. The explicit `labels` array is **required** (save_issue
     replaces the full set; omitting it leaves stale labels and the next sweep re-finds it —
     mirror `watch-upstream.md:71`'s rationale). Note: `command: "ralph_triage"` is for parity;
     `triage-state-gate.sh` scopes to `RALPH_SUBCOMMAND=triage`, not `watch-blockers`, so this
     mode's transitions are unguarded — pass only valid target states.
  3. Post a `## Unblocked` comment: "Blocker(s) #NNN closed → dependency edge removed, advanced to
     `<target>`." (Parity with watch-pr's `## Watch-PR Resolution` / watch-upstream's
     `## Watch-Upstream Resolution`; the issue spec names it `## Unblocked`.)
- **§Step 4 (leave).** Any OPEN blocker → no mutation; item keeps its state + edge + labels; waits
  for the next sweep.
- **§Step 5: Emit terminal token** — exactly one:
  - `WATCH-BLOCKERS <n> advanced, <m> still blocked` — the primary summary token from the spec
    (`<n>` = items advanced this sweep; `<m>` = items left with ≥1 open blocker).
  - `WATCH-BLOCKERS IDLE` — no dependency-parked items found (§Step 2).
  - `WATCH-BLOCKERS SKIPPED — branch <name> is not main` — §Step 1 short-circuit.
- **§Constraints** — mirror `watch-upstream.md:82-88`: one sweep per invocation; conservative advance
  (never false-advance); mutates only dependency-parked items it owns; never creates/closes issues;
  no code changes; heartbeat fan-out wired in Phase 3.

### Verification (Phase 1)

- `test -f ralph/skills/caretake/modes/watch-blockers.md`.
- `grep -q 'export RALPH_SUBCOMMAND=watch-blockers' ralph/skills/caretake/modes/watch-blockers.md`.
- `grep -q 'WATCH-BLOCKERS' ...` finds all three tokens (summary, IDLE, SKIPPED).
- `grep -q 'list_dependencies' && grep -q 'remove_dependency' && grep -q '## Unblocked' && grep -q '## Escalation' && grep -q 'git branch --show-current'` all pass.
- Manual read confirms the §Step 1–§Step 5 + §Constraints headings parallel `watch-upstream.md`.

---

## Phase 2 — Token registry `outcome-tokens.md`

**File:** `ralph/skills/caretake/outcome-tokens.md`

1. After the "## Watch-Upstream terminal tokens" section (ends `outcome-tokens.md:107`), add a new
   **"## Watch-Blockers terminal tokens"** section listing the three tokens with the same prose
   pattern as Watch-Upstream (lines 101-107), including the "no Stop postcondition hook (parity with
   watch-pr/watch-upstream/hygiene/trends)" sentence:
   - `WATCH-BLOCKERS <n> advanced, <m> still blocked` — `<n>` items resolved this sweep (all
     blockers closed → advanced to the embedded/default target); `<m>` items left with ≥1 open
     blocker. Skipped no-blocker items are not counted in either.
   - `WATCH-BLOCKERS IDLE` — scan ran cleanly; no dependency-parked items found.
   - `WATCH-BLOCKERS SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit.
2. In the "## Loop continuation" block (`outcome-tokens.md:109-117`), watch-blockers runs as a
   **heartbeat fan-out child** of `--mode all` (not independently looped), so no new drain/heartbeat
   row is required there — but add watch-blockers to the same parenthetical company as watch-pr /
   watch-upstream wherever the fan-out children are enumerated, for consistency.

### Verification (Phase 2)

- `grep -q '## Watch-Blockers terminal tokens' ralph/skills/caretake/outcome-tokens.md`.
- `grep -c 'WATCH-BLOCKERS' ralph/skills/caretake/outcome-tokens.md` ≥ 3.
- `grep -q 'no .Stop. postcondition hook' ...` near the new section (parity sentence present).

---

## Phase 3 — Register + wire into SKILL.md heartbeat

**File:** `ralph/skills/caretake/SKILL.md`

Mirror every place `watch-upstream` is registered:

1. **Frontmatter `description`** (`SKILL.md:2`) and **`argument-hint`** (`SKILL.md:3`) — add
   `watch-blockers` to the pipe-delimited `--mode <...>` enumerations.
2. **Mode table** (`SKILL.md:91-104`) — add a row after the `watch-upstream` row (line 104):
   `| **watch-blockers** | \`/ralph:caretake --mode watch-blockers\` | Auto-advance items whose
   \`blockedBy\` dependency edges have all closed (resolves the \`WAIT-issue=NNN\` triage verdict);
   leave items with any open blocker |`.
3. **Heartbeat "all" mode summary** (`SKILL.md:94`) — extend the fan-out list:
   "hygiene + watch-pr + watch-upstream + **watch-blockers** + catch-up report + trends".
4. **Step 1 Dispatch — heartbeat fan-out** (`SKILL.md:143-149`) — insert a new serial child after
   step 3 (watch-upstream) and renumber: add
   `3. \`Skill("ralph:caretake", args="--mode watch-blockers")\``, push catch-up report → 5 and
   trends → 6. Update the trailing sentence "Report consolidated outcome (one line per child — **6
   total**)" (was 5) and keep "The watch modes run before report/trends …".
5. **Mode bodies list** (`SKILL.md:157-166`) — add
   `- [modes/watch-blockers.md](modes/watch-blockers.md) — resolve dependency-parked items on blocker close`.
6. **Per-mode terminal tokens quick-ref** (`SKILL.md:170-182`) — add after the watch-upstream line
   (line 182): `- watch-blockers: \`WATCH-BLOCKERS <n> advanced, <m> still blocked\` |
   \`WATCH-BLOCKERS IDLE\` | \`WATCH-BLOCKERS SKIPPED — branch <name> is not main\``.

No `--loop` mode-routing change is required in §Step 0: watch-blockers participates only via the
`--mode all` heartbeat (already loop-wrapped), not as a standalone drain — same as watch-pr /
watch-upstream, which have no dedicated `--loop` routing rows either.

### Verification (Phase 3)

- `grep -c 'watch-blockers' ralph/skills/caretake/SKILL.md` ≥ 5 (frontmatter ×2, table, fan-out, mode-bodies list, token ref).
- `grep -q '6 total' ralph/skills/caretake/SKILL.md` (heartbeat child count updated).
- `grep -q 'modes/watch-blockers.md' ralph/skills/caretake/SKILL.md`.
- `grep -q 'Skill("ralph:caretake", args="--mode watch-blockers")' ralph/skills/caretake/SKILL.md`.

---

## Phase 4 — Cross-ref triage.md + doc-structure test

**File A:** `ralph/skills/caretake/modes/triage.md`

Update the forward references that currently describe watch-blockers as a future ("will be owned by
Gap C `watch-blockers`", `triage.md:110,116,166,200,260`) to note it is now **live**: e.g. change
"auto-advances when #NNN closes, via Gap C `watch-blockers`" → "auto-advanced when #NNN closes by
`caretake --mode watch-blockers`". Do NOT change the parking target (stays Human Needed until Gap A
relaxation; that is a separate, already-documented decision at `triage.md:95/116`). This is a
documentation-coherence edit only — one-to-five line touch.

**File B (NEW):** `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh`

A POSIX/bash doc-structure test in the style of
`ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh` (self-contained, asserts via
`grep`, prints PASS/FAIL, exits non-zero on any failure). Assertions:

1. **Mode exists** — `watch-blockers.md` is present and non-empty.
2. **Mirrors watch-upstream shape** — file contains `§Step 1: Verify branch`, `§Step 2`, `§Step 5`,
   `## §Constraints` (or the matching headings used), and the `export RALPH_SUBCOMMAND=watch-blockers`
   line.
3. **Advance behavior documented** — contains `remove_dependency`, `## Unblocked`, and the default
   `Ready for Plan` target; contains the OPEN-blocker "leave untouched" branch.
4. **Reads the #1472 convention** — contains both `list_dependencies` (edge) and `## Escalation`
   (body) signals, and the `Blocked by #` / `closes` advance-line phrasing.
5. **Token present** — `watch-blockers.md` AND `outcome-tokens.md` AND `SKILL.md` each contain
   `WATCH-BLOCKERS`.
6. **Heartbeat wired** — `SKILL.md` contains `--mode watch-blockers` in the fan-out and `6 total`.
7. **Token registry** — `outcome-tokens.md` contains the `## Watch-Blockers terminal tokens` heading.

This is the "unit/hook coverage for advance + token" acceptance item. Because watch-blockers (like
the other two watchers) has no runtime Stop hook, the coverage is doc-structure assertions over the
skill surface — the same coverage model the repo already uses for the triage palette
(`triage-postcondition-palette.test.sh`) and the CI doc-consistency check added in #1458.

### Verification (Phase 4)

- `bash ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` exits 0 (all assertions pass).
- `grep -q 'caretake --mode watch-blockers' ralph/skills/caretake/modes/triage.md` (cross-ref live).
- Confirm the new test is discovered by the same CI step that runs the other
  `ralph/hooks/scripts/__tests__/*.test.sh` files (CI runs hook tests per `ci.yml`).

---

## Testing (whole-plan)

- `bash ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` → exit 0.
- Re-run the existing caretake hook tests to confirm no regression:
  `bash ralph/hooks/scripts/__tests__/triage-postcondition-palette.test.sh`.
- `grep -rn 'watch-blockers' ralph/skills/caretake/` shows the mode wired in SKILL.md (×≥5),
  outcome-tokens.md (token section), triage.md (cross-ref), and the mode body itself.
- Manual smoke (optional, on main): `/ralph:caretake --mode watch-blockers` on a board with a
  Human-Needed item whose single `blockedBy` blocker is CLOSED → item advances to Ready for Plan, a
  `## Unblocked` comment is posted, and `WATCH-BLOCKERS 1 advanced, 0 still blocked` is emitted;
  an item with an OPEN blocker is untouched; an empty board emits `WATCH-BLOCKERS IDLE`.

## Acceptance criteria mapping (from issue #1473)

| Acceptance item | Phase |
|---|---|
| Mode exists + mirrors watch-pr/watch-upstream structure | Phase 1 |
| Finds blocked-by-issue items (edge AND/OR `## Escalation` convention) | Phase 1 §Step 2 |
| CLOSED blocker → advance + `## Unblocked` comment; OPEN → no-op | Phase 1 §Step 3-4 |
| Emits `WATCH-BLOCKERS <n> advanced, <m> still blocked` token | Phase 1 §Step 5 + Phase 2 |
| Wired into heartbeat (alongside watch-pr/watch-upstream) | Phase 3 |
| Unit/hook coverage for advance + token | Phase 4 |

## Notes for the implementer

- watch-blockers is **doc + test only** — no `mcp-server/` change. Every tool already exists
  (`list_dependencies`, `remove_dependency`, `add_dependency`, `get_issue`, `save_issue`,
  `list_issues`, `create_comment` — all in caretake `allowed-tools`).
- Do **not** add a Stop postcondition hook — the other two watchers deliberately have none
  (`watch-pr.md:11`, `watch-upstream.md:11`); the terminal token is emitted by convention.
- The producer side (`WAIT-issue=NNN` parking) is already shipped by #1472 — read its exact
  `## Escalation` body format (`triage.md:159-162`); do not invent a new marker.
- Keep the parking-target default = **Ready for Plan** to match the triage `WAIT-issue=NNN` contract
  (`outcome-tokens.md:18`, `triage.md:161`).
