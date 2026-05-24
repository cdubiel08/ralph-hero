---
date: 2026-05-24
status: draft
type: plan
tags: [ralph-slim, loop, autopilot, skill-uniformity, dispatch-surface]
github_issue: 1402
github_url: https://github.com/cdubiel08/ralph-hero/issues/1402
primary_issue: 1402
git_commit: 3ae0d803e93f8f93370b0ca22589e2a936c4ba73
git_branch: main
---

# Add `--loop` flag to every loop-suitable ralph slim plugin skill

## Prior Work

- builds_on:: [[2026-05-21-autopilot-loop-handoff]] (research — traces the autopilot → `/loop` → `ScheduleWakeup` handoff chain; primary evidence that `Skill("loop", args=...)` with prose continuation rules is the canonical wrapping pattern in this codebase, and that the model's per-turn `ScheduleWakeup` call is the only thing keeping the loop alive)
- builds_on:: `ralph/skills/hero/SKILL.md` lines 143-162 (`--mode auto` — concrete worked example of the wrap-in-loop pattern, including continuation rules, delay buckets, and the cache-window anti-pattern at 300s)
- builds_on:: `ralph/CLAUDE.md` (sets the slim-plugin constraints this plan must honor: SKILL.md ≤ ~150 lines, opinion in flat siblings, enforcement in hooks)
- tensions:: none observed — the proposal extends an existing precedent rather than replacing one

## Overview

The ralph slim plugin already has one skill (`hero --mode auto`) that wraps itself in `/loop` via `Skill("loop", args="...")` to drain the backlog. Several other skills are structurally identical to that pattern — they pick the oldest XS/S issue in some queue, do one unit of work, emit a terminal `result:` or `Queue empty.` sentinel, and stop. They are designed to be looped, but today the user has to remember to type `/loop /ralph:<skill> --mode auto` themselves, and most users don't know that's an option.

This plan adds a uniform `--loop [interval]` flag to every skill+mode combination where looping is meaningful. When present, the flag causes the skill body to short-circuit Step 0 with a `Skill("loop", ...)` invocation that re-enters the same skill (with `--loop` stripped from the args) inside `/loop`'s runtime. Interval-less invocations use `/loop` dynamic mode (model self-paces via `ScheduleWakeup`); interval-bearing invocations pass the interval verbatim. Per-skill continuation rules — load-bearing prose that tells the wrapping `/loop` session when to terminate vs. re-fire — live in a shared sibling fragment and are composed into the prompt at wrap time.

Skills where looping is meaningless (interactive intake, single-target one-shots, single-artifact composers) explicitly do **not** get the flag; attempts to pass it print a one-line refusal and exit cleanly. The list of suitable vs. unsuitable mode-pairs is determined up-front in Phase 1 and locked.

## Current State Analysis

### Today's loop surface in `ralph/`

Exactly one skill body invokes `/loop`:

- `ralph/skills/hero/SKILL.md` lines 143-162 — `--mode auto`. The body is a single `Skill("loop", args="<multi-line prompt with continuation rules>")` call. The continuation rules instruct the model to call `ScheduleWakeup` between iterations and to terminate on `result: Queue empty`. Two hooks guard the dispatch: `autopilot-enable-gate.sh` (opt-in via `RALPH_AUTOPILOT_ENABLE=true`) and `autopilot-wakeup-clear.sh` (delay-bucket validator). Neither is loop-mechanic-specific; both could be reused or generalized.

### Where the latent loop surface already exists

The autonomous modes below all share the same shape — pick from a queue, do one unit, emit `Queue empty.` or a progress sentinel, stop. They are loop-ready but not wrapped:

| Skill / Mode | Terminal sentinel today | Loop semantics if wrapped |
|---|---|---|
| `research --mode auto` | `Research complete for #NNN: …` or exits cleanly when none eligible | Dynamic: drain Research-Needed queue |
| `plan --mode auto` | `Plan complete for #NNN: …` or exits cleanly | Dynamic: drain Ready-for-Plan queue |
| `plan --mode review` | `Plan reviewed for #NNN: …` | Dynamic: drain Plan-in-Review queue |
| `impl --mode auto` | `Phase N/M complete.` / `Implementation complete for #NNN: …` / `IMPL BLOCKED …` | Dynamic: drain unlocked phases |
| `impl --mode pr` | `PR CREATED / …` or literal `Queue empty.` | Dynamic: drain ready-for-PR queue |
| `review` default | `FINISHED / …` or `FINISH BLOCKED — …` | Dynamic: drain In-Review queue |
| `review --mode val` | `VALIDATION PASS / FIX / FAIL` or `Queue empty.` | Dynamic: drain validation queue |
| `review --mode code` | `CODE REVIEW PASSED / ESCALATED` or `Queue empty.` | Dynamic: drain code-review queue |
| `review --mode merge` | `MERGED / …` or `Queue empty.` | Dynamic: drain mergeable queue |
| `caretake --mode triage` | `TRIAGED <verdict>` or `Queue empty.` | Dynamic: drain Backlog |
| `caretake --mode hygiene` | `HYGIENE COMPLETE <N>` or `HYGIENE BLOCKED <reason>` | Interval (default 1h): periodic scan |
| `caretake --mode unblock` (autonomous, no `--question`) | `UNBLOCK REQUEST POSTED` or `Queue empty.` | Dynamic: drain Human Needed |
| `caretake --mode trends` | none (markdown stdout is the deliverable) | Interval (default 6h): periodic snapshot |
| `caretake --mode debug` | `DEBUG FILED <N>` or `DEBUG SKIPPED <reason>` | Dynamic: drain Langfuse errors |
| `caretake --mode split` | `SPLIT <N>` or `SPLIT SKIPPED <reason>` | Dynamic: drain M/L/XL queue |
| `caretake --mode all` | (fan-out, no aggregated sentinel) | Interval (default 1h): heartbeat |
| `caretake` default (`--issue NNN`) | per dispatched mode | Dynamic: drain `trigger:*` labels |
| `catch-up --mode report` | `Status update posted successfully.` | Interval (default 1d): periodic post |
| `hero` default (`NNN`) | `result: Hero complete — …` or `result: Hero paused at …` | Dynamic: drain top-ranked issues |
| `hero --mode watch` heartbeat | `result: Watch complete — …` | Interval (default 15m): polling |
| `hero --mode classify` | `result: Queue empty.` or `result: Dispatched …` | Already covered by `hero --mode auto`; do NOT add `--loop` (redundant) |

### Where looping is meaningless (no `--loop` flag)

| Skill / Mode | Why not |
|---|---|
| `form` default | Interactive picker with 3-5 `AskUserQuestion` calls |
| `form --mode draft` | Quick-capture conversation |
| `plan` default | Interactive structure-development picker |
| `plan --mode iterate` | Single-plan surgical edit with `AskUserQuestion` |
| `plan --mode epic` | Single-epic decomposition; multiple epics → user invokes per-epic |
| `impl` default | Pauses between phases for human verification |
| `impl --mode address` | Single PR's feedback cycle |
| `research` default | Interactive question intake + findings review picker |
| `research --mode prove` | Single-claim investigation; multiple claims → user invokes per-claim |
| `catch-up` default / `narrative` / `dashboard` | Interactive picker / pure stdout |
| `setup` all modes | One-shot bootstrap |
| `hero --mode auto` | Already wrapped in `/loop` from the body |
| `hero --mode pr-drain` | Single-PR action; loop would re-process the same PR |
| `caretake --mode postmortem` | Single artifact per session |
| `caretake --mode retro` | Single artifact per session |
| `caretake --mode unblock --question` | Interactive answer collection |

### Key Discoveries

- **The autopilot precedent is fully evidenced.** `thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md` documents the exact `Skill("loop", args=...)` shape, the role of prose continuation rules, the `ScheduleWakeup` cadence buckets (60-270s warm-cache, 1200-1800s idle, 300s rejected as cache-anti-pattern), and the fact that no hook enforces the wakeup call — it lives only as prose. This plan rides that contract; it does not redesign it.
- **Most loop-suitable modes already emit the right sentinels.** `Queue empty.` is the canonical idle-terminator across `impl --mode pr`, `review --mode val`, `review --mode code`, `review --mode merge`, and all four loop-suitable caretake modes (`outcome-tokens.md` documents the literal strings). Progress sentinels (`Plan complete`, `Phase N/M complete`, `MERGED`, etc.) are also already standardized. The `--loop` wrapper does not need to invent new sentinels; it needs to forward the existing ones to `/loop`'s continuation logic.
- **The 150-line SKILL.md cap matters.** Per `ralph/CLAUDE.md`, opinion content goes in flat sibling .md files. The per-skill `--loop` wiring in each SKILL.md must be a 3-5 line Step-0 stanza that references a shared fragment; the prose continuation rules and the sentinel manifest live in `ralph/skills/shared/loop-wrapper.md`.
- **The hero `--mode auto` body is the implementation reference.** Lines 143-162 show exactly the shape every other `--loop`-wrapped invocation needs to emit: a `Skill("loop", args=...)` call with a multi-line continuation prompt that names (a) the inner command, (b) the terminal sentinels, (c) the delay buckets, and (d) the cache-window anti-pattern guard. Copy the structure verbatim; vary only the inner command and the sentinel list.
- **The `autopilot-enable-gate.sh` hook is opt-in-scoped to `RALPH_COMMAND=autopilot`.** It discriminates by `RALPH_COMMAND` and will not fire on the new `--loop` Skill calls from other skills (they tag `RALPH_COMMAND=<skill>`). No generalization needed; the gate stays autopilot-specific.
- **`/loop` is built into Claude Code, not a file on disk.** Confirmed via `find ~/.claude -path "*loop*" -name "SKILL.md"` returning empty. The skill description at the top of every session declares it: `/loop [interval] /cmd` for fixed intervals, `/loop /cmd` for dynamic mode. The wrapper does not need to know /loop's internals — only its invocation shape.

## Desired End State

After this plan merges:

1. Every loop-suitable skill+mode in the table above accepts `--loop` (no interval → dynamic mode) and `--loop <duration>` (e.g., `--loop 5m`, `--loop 15m`, `--loop 1h`) as a wrapping flag.
2. When `--loop` is present, Step 0 of the skill body short-circuits: it strips `--loop [duration]` from the args, computes the per-mode continuation prompt from `ralph/skills/shared/loop-wrapper.md`, invokes `Skill("loop", args="<interval-prefix-if-any> /ralph:<skill> <stripped-args>\n\n<continuation-rules>")`, and returns. The skill body's normal flow does not run in the wrapping turn.
3. The wrapped child invocation (running inside `/loop`'s turn) sees the stripped args, takes the `--mode auto` (or whichever mode the user picked) path normally, emits its terminal sentinel, and returns. `/loop` reads the sentinel against the continuation rules and decides to re-fire or stop.
4. Skills where looping is meaningless either (a) do not accept `--loop` (arg parser refuses with a 1-line message) or (b) accept it and emit a one-line refusal explaining why looping is meaningless for the chosen mode. Default behavior is (a) — silently unhandled flag is worse than an explicit refusal.
5. `ralph/CLAUDE.md` documents the convention: which modes accept `--loop`, default cadences for interval-style heartbeats, and the canonical refusal message for unsuitable modes.
6. `hero --mode auto`'s existing body, which today inlines its continuation prose, is refactored to consume the same `loop-wrapper.md` fragment so there is exactly one source of truth for the wrap pattern. The autopilot-specific `RALPH_AUTOPILOT_ENABLE` opt-in stays — that gate is about the autopilot mode being a footgun for autonomous fanout, not about `--loop` in general. Other `--loop` wraps are not opt-in-gated.

### Verification

Automated:
- `grep -nE -- '--loop\b' ralph/skills/**/SKILL.md` returns exactly the loop-suitable mode list from the Current-State table.
- `grep -nE -- '--loop\b' ralph/skills/{form,setup,catch-up}/SKILL.md` returns no matches in unsuitable surfaces.
- `bash ralph/skills/shared/loop-wrapper.md` is a no-op when sourced (it is a markdown fragment, but the SKILL.md bodies reference it via `!cat ${CLAUDE_PLUGIN_ROOT}/...` resolution); the file exists and is non-empty.
- All ralph slim plugin tests pass: `cd plugin/ralph-hero/mcp-server && npm test` (no MCP-server source changes, but a regression sweep is cheap).
- A new test file `ralph/skills/shared/__tests__/loop-wrapper.test.sh` (or equivalent) exercises arg stripping for `--loop`, `--loop 5m`, `--loop dynamic`, and `--loop` mid-string positions.

Manual:
- Invoking `/ralph:impl --mode auto --loop` in a fresh session results in a `Skill("loop", args=...)` call with `Queue empty.` listed as a terminal sentinel in the continuation prompt; the inner invocation runs `--mode auto` normally.
- Invoking `/ralph:form --loop` (unsuitable surface) prints a one-line refusal and exits without running form's normal flow.
- Invoking `/ralph:hero --mode auto --loop 5m` is functionally equivalent to today's `/ralph:hero --mode auto` (which uses dynamic mode); the explicit interval overrides dynamic.

## What We're NOT Doing

- **Not adding `--loop` to interactive modes** even when technically possible. `plan` default could theoretically loop ("plan one issue, then the next") but the `AskUserQuestion` checkpoints inside each iteration make this a bad UX. Users who want to drain a queue should use `--mode auto --loop`.
- **Not introducing new sentinel strings.** All terminal-detection in continuation rules uses existing `Queue empty.` / progress-line / `BLOCKED` strings. Skills whose terminal markers are inconsistent today (e.g., `caretake --mode hygiene` emits `HYGIENE COMPLETE` / `HYGIENE BLOCKED` rather than `Queue empty.`) get their existing tokens forwarded verbatim, not rewritten.
- **Not generalizing `autopilot-enable-gate.sh`** to gate other `--loop` wraps. Autopilot is a footgun (it drives the entire pipeline end-to-end across all teams) and earns its opt-in; `/ralph:impl --mode auto --loop` is a narrow per-skill drain that does not.
- **Not adding `ScheduleWakeup` enforcement hooks.** The autopilot research explicitly notes that no hook enforces the wakeup call today — it lives only as prose. This plan does not fix that gap (Phase 4 of `2026-05-21-autopilot-loop-handoff.md`'s recommendations is a separate concern). The risk is: a model running inside `/loop` narrates rescheduling without invoking the tool, and the loop drops silently. Accepting this risk for the same reasons autopilot does today.
- **Not changing the `/loop` skill itself.** This plan composes with `/loop`'s existing interface (`/loop [interval] /cmd` or `/loop /cmd`); no /loop changes are required.
- **Not removing `--mode auto` in favor of `--loop`.** The two are orthogonal: `--mode auto` is "run one unit of work autonomously, no questions"; `--loop` is "wrap whatever I'm running in /loop". The composition `--mode auto --loop` is the common case but neither flag implies the other.
- **Not adding `--loop` to `hero --mode classify`.** It's redundant with `hero --mode auto`, which is the canonical event-loop drainer.

## Implementation Approach

Five phases, executed in order. Phase 1 lays the shared substrate; Phases 2-3 wire the flag into skill bodies (auto/drain skills first, heartbeat-style skills second); Phase 4 updates docs; Phase 5 adds tests + a refactor of the hero `--mode auto` body to consume the shared substrate.

Each phase owns a tightly-scoped file set per the slim plugin's file-ownership convention. Phase 2 modifies the `--mode auto` family; Phase 3 modifies heartbeat-style entries; they do not stomp on each other. Phase 5's refactor of `hero/SKILL.md` is the only file touched in two phases (Phase 1 ships the substrate; Phase 5 retrofits the hero body); the touch points are non-overlapping (Phase 1 adds a new file, Phase 5 modifies an existing one).

Implementation tier: S — single-concern wiring, no schema changes, ~10 files touched, no MCP-server changes. Does not need `--mode epic`.

## Phase 1: Shared `--loop` wrapper substrate

depends_on: null

### Overview

Create `ralph/skills/shared/loop-wrapper.md` — the canonical reference fragment that holds the arg-parsing snippet, the per-skill continuation-rules manifest, and the refusal message for unsuitable modes. SKILL.md bodies will reference this fragment by path; no SKILL.md duplicates the prose.

### Changes Required

#### 1. New shared directory

**File**: `ralph/skills/shared/` (new directory)
**Changes**: `mkdir -p ralph/skills/shared`. Today the slim plugin has no `shared/` dir — `ls ralph/skills/shared/ 2>/dev/null` returns nothing. This phase establishes it.

#### 2. The wrapper fragment

**File**: `ralph/skills/shared/loop-wrapper.md` (create)
**Changes**: A markdown fragment containing four sections:

1. **`## Arg-parsing snippet`** — a 5-line bash block SKILL.md bodies copy into their Step 0. The snippet detects `--loop [optional duration]` in `$ARGUMENTS`, captures `LOOP_INTERVAL` (empty for dynamic), and strips `--loop`-related tokens into `STRIPPED_ARGS`. Skills then check `[[ -n "${LOOP_RAW:-}" ]]` and short-circuit to the Skill call if true. The snippet is copy-paste rather than sourced so each SKILL.md remains self-contained (`!cat` resolution at load time would couple every SKILL.md to this file's existence at read time, which complicates the migration window).

2. **`## Continuation-rules manifest`** — a table mapping every loop-suitable `<skill>:<mode>` to its terminal sentinels and delay buckets. Example row:

   ```
   | impl:auto | Phase N/M complete. / Implementation complete for #NNN: … | IMPL BLOCKED … / Queue empty. | 60-270s on progress; 1200s on no-op |
   ```

3. **`## Continuation-prompt template`** — the prose body that gets stitched into the `Skill("loop", args=...)` call. It has placeholders `{INNER_COMMAND}`, `{PROGRESS_SENTINELS}`, `{TERMINAL_SENTINELS}`, `{DELAY_BUCKETS}`. Each SKILL.md's Step 0 fills these from the manifest. The prose mirrors `hero/SKILL.md` lines 148-159's structure — same delay-bucket guidance, same cache-window anti-pattern guard, same "Trust the inner command's decisions" framing.

4. **`## Refusal message`** — a one-line `printf` block SKILL.md bodies copy into unsuitable-mode branches (e.g., `form --loop`). The text: `--loop is not supported for this mode. Looping is meaningful only for autonomous queue-drainers; this surface is interactive. See ralph/CLAUDE.md § Loop suitability.`

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/shared/loop-wrapper.md && wc -l ralph/skills/shared/loop-wrapper.md` shows ≥40 lines and ≤200 lines (fragment is substantive but not bloated).
- [ ] `grep -c '^| ' ralph/skills/shared/loop-wrapper.md` returns ≥18 (one row per loop-suitable skill+mode plus the header / separator).
- [ ] `grep -nE 'Skill\("loop"' ralph/skills/shared/loop-wrapper.md` returns at least one match (the template embeds the canonical call shape).
- [ ] `bash -n` (syntax check) passes on the bash snippet when extracted into a temp file. Add a one-line check to `ralph/scripts/lint-loop-snippet.sh` (new).

#### Manual Verification

- [ ] The continuation-rules manifest covers every entry in the Current-State loop-suitable table; cross-checked by eye.
- [ ] The refusal message reads as one sentence on a terminal width of 100 cols.

## Phase 2: Wire `--loop` into autonomous drain modes

depends_on: [phase-1]

### Overview

Each `--mode auto`-style skill gets a 3-5 line Step-0 stanza that detects `--loop`, strips it, and emits the wrapping `Skill("loop", ...)` call. No body logic changes downstream of Step 0; the wrapped child re-enters the same skill with `--loop` stripped and runs normally.

### Changes Required

#### 1. `ralph/skills/research/SKILL.md`

**File**: `ralph/skills/research/SKILL.md`
**Changes**: In Step 0 (`## Step 0: Parse args`), after the existing MODE / ARG capture, add:

```
- If `--loop` appears in $ARGUMENTS: extract optional duration, strip from args.
  When stripped MODE != `auto`: emit refusal from shared/loop-wrapper.md and STOP.
  Otherwise emit `Skill("loop", args="${LOOP_INTERVAL} /ralph:research --mode auto ${STRIPPED_ARGS}\n\n${CONTINUATION_PROMPT}")` and STOP.
```

The refusal triggers for `--mode prove --loop` and default-mode `--loop` (both interactive) but allows `--mode auto --loop`.

#### 2. `ralph/skills/plan/SKILL.md`

**File**: `ralph/skills/plan/SKILL.md`
**Changes**: Same Step-0 stanza pattern. Allowed mode-pairs: `auto`, `review`. Refusal for `default` / `iterate` / `epic`.

#### 3. `ralph/skills/impl/SKILL.md`

**File**: `ralph/skills/impl/SKILL.md`
**Changes**: Same pattern. Allowed mode-pairs: `auto`, `pr`. Refusal for `default` / `address`.

#### 4. `ralph/skills/review/SKILL.md`

**File**: `ralph/skills/review/SKILL.md`
**Changes**: Same pattern. Allowed: `default`, `val`, `code`, `merge`. (All review modes are queue-drainers.)

#### 5. `ralph/skills/caretake/SKILL.md`

**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: Same pattern. Allowed: default-event (`--issue NNN`) is borderline — listed as suitable in Current-State (drains `trigger:*` labels) but only if invoked without a specific `--issue` argument. Wire it to accept `--loop` when no `--issue` is present, refuse when one is. Allowed modes: `triage`, `hygiene`, `unblock` (autonomous, not `--question`), `debug`, `split`. Refusal for `postmortem`, `retro`, and `unblock --question`. Note: `--mode all`, `--mode trends` go in Phase 3 (heartbeat-style).

### Success Criteria

#### Automated Verification

- [ ] `grep -nE '\-\-loop' ralph/skills/{research,plan,impl,review,caretake}/SKILL.md` returns at least one hit per file.
- [ ] `grep -nE 'Skill\("loop"' ralph/skills/{research,plan,impl,review,caretake}/SKILL.md` returns at least one hit per file.
- [ ] Each modified SKILL.md still parses as YAML frontmatter + markdown body (no syntax breakage): `awk '/^---$/{c++}END{exit c==2?0:1}' <file>` passes.
- [ ] Each SKILL.md stays ≤ 165 lines (5-line cushion above the 150-line slim plugin guideline): `wc -l ralph/skills/*/SKILL.md` shows all under 165.
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` passes (no MCP-server changes, regression check only).

#### Manual Verification

- [ ] In a fresh session, `/ralph:impl --mode auto --loop` produces a `Skill("loop", args=...)` call as the first action, not normal `--mode auto` flow.
- [ ] `/ralph:impl --loop` (no `--mode`) prints the refusal and exits — default mode is interactive.
- [ ] `/ralph:caretake --mode hygiene` (no `--loop`) runs hygiene once and exits normally; the flag is opt-in, not auto-applied.

## Phase 3: Wire `--loop [interval]` into heartbeat-style modes

depends_on: [phase-1]

### Overview

These modes are designed for periodic polling rather than queue-draining. They get `--loop` with a sensible default interval (the SKILL.md body fills in the default if the user invokes `--loop` with no duration), but they also accept dynamic mode if the user passes `--loop` with no interval AND the model judges dynamic appropriate.

Heartbeat modes vs. drain modes differ in continuation semantics: heartbeats re-fire on a clock even when their last invocation did "nothing"; drains stop when `Queue empty.` is observed.

### Changes Required

#### 1. `ralph/skills/hero/SKILL.md` — `--mode watch`

**File**: `ralph/skills/hero/SKILL.md`
**Changes**: In the `--mode watch` section (lines 164-177), add a Step-0-equivalent stanza near the start that detects `--loop [interval]`. Default interval for watch is `15m` (per `RALPH_WATCH_HEARTBEAT_MIN` precedent in `ralph-hero/CLAUDE.md`). Continuation rule for heartbeat: never terminate on `result: …` alone — always re-fire unless `RALPH_WATCH_DISABLE=true` or the user explicitly cancels via `/tasks`. Manifest entry in `loop-wrapper.md` documents the heartbeat continuation pattern.

#### 2. `ralph/skills/caretake/SKILL.md` — `--mode all` and `--mode trends`

**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: Extend the Phase-2 Step-0 stanza to also handle these two heartbeat modes. Default intervals: `--mode all` → `1h`, `--mode trends` → `6h`. Continuation: heartbeat (no `Queue empty.` termination).

#### 3. `ralph/skills/catch-up/SKILL.md` — `--mode report`

**File**: `ralph/skills/catch-up/SKILL.md`
**Changes**: Add a Step-0 stanza (this skill currently has no `## Step 0` heading — add one). Allowed mode-pair: `--mode report --loop`. Default interval: `1d`. Other modes (`default`, `narrative`, `dashboard`) refuse.

### Success Criteria

#### Automated Verification

- [ ] `grep -nE 'default interval' ralph/skills/shared/loop-wrapper.md` returns at least three hits (one per heartbeat mode-pair).
- [ ] `grep -nE '\-\-loop' ralph/skills/{hero,caretake,catch-up}/SKILL.md` returns at least one hit per file (Phase 2 already added hits in caretake; Phase 3 adds heartbeat-specific entries).
- [ ] `ralph/skills/catch-up/SKILL.md` now has a `## Step 0` section: `grep -c '^## Step 0' ralph/skills/catch-up/SKILL.md` returns ≥1.

#### Manual Verification

- [ ] `/ralph:hero --mode watch --loop` re-fires every 15m (observed via `/tasks` showing a scheduled wakeup with delay ≈ 900s).
- [ ] `/ralph:hero --mode watch --loop 30m` re-fires every 30m.
- [ ] `/ralph:catch-up --mode report --loop 12h` posts a status update, then schedules a wakeup for ~12h later.

## Phase 4: Documentation

depends_on: [phase-2, phase-3]

### Overview

Update `ralph/CLAUDE.md` with a Loop-suitability table, default-interval matrix, and the refusal-message contract. Add a brief help-text update to each modified SKILL.md's argument-hint frontmatter to surface `--loop` in tab-completion / `--help` output.

### Changes Required

#### 1. `ralph/CLAUDE.md` — Loop-suitability table

**File**: `ralph/CLAUDE.md`
**Changes**: Add a new top-level section (`## Loop-suitability matrix`) summarizing the Current-State table from this plan. Keep it dense — one row per skill+mode, columns: Suitable? / Default interval / Terminal sentinels / Notes. Link to `ralph/skills/shared/loop-wrapper.md` as the source of truth.

#### 2. SKILL.md `argument-hint` updates

**Files**: `ralph/skills/{research,plan,impl,review,caretake,hero,catch-up}/SKILL.md`
**Changes**: In each frontmatter, extend the `argument-hint` string to include `[--loop [duration]]` where applicable. Example for impl: `"[--mode auto|address|pr] [<issue-number|plan-path>] [--plan-doc <path>] [--push-drive|--no-push-drive] [--loop [duration]]"`.

#### 3. Outcome-tokens fragment update

**File**: `ralph/skills/caretake/outcome-tokens.md`
**Changes**: Add a `## Loop continuation` section documenting that `Queue empty.` terminates `/loop` and every other terminal token re-fires until the user cancels (consistent with the autopilot prose contract). No changes to the existing token table.

### Success Criteria

#### Automated Verification

- [ ] `grep -nE '## Loop-suitability matrix' ralph/CLAUDE.md` returns one hit.
- [ ] `grep -nE 'argument-hint:.*--loop' ralph/skills/*/SKILL.md` returns ≥7 hits (one per loop-bearing skill).
- [ ] `grep -nE '## Loop continuation' ralph/skills/caretake/outcome-tokens.md` returns one hit.

#### Manual Verification

- [ ] The Loop-suitability matrix in CLAUDE.md matches the Current-State table in this plan row-for-row.
- [ ] Tab-completion (zsh, when `ralph-completions.zsh` is sourced) suggests `--loop` after `/ralph:impl --mode auto`.

## Phase 5: Refactor `hero --mode auto` + tests

depends_on: [phase-1, phase-4]

### Overview

The existing `hero --mode auto` body inlines its continuation prose (lines 143-162). Phase 1 established `loop-wrapper.md` as the canonical source for that prose. Phase 5 refactors the hero body to consume the shared template — no behavioral change, just deduplication. Then adds tests covering arg-stripping correctness, refusal-message firing for unsuitable modes, and the heartbeat-vs-drain continuation distinction.

### Changes Required

#### 1. Refactor hero `--mode auto`

**File**: `ralph/skills/hero/SKILL.md`
**Changes**: Replace the inlined continuation prose at lines 147-159 with a reference to `loop-wrapper.md`'s continuation-prompt template. The body shrinks from ~17 lines to ~5 lines for this section. Keep the `autopilot-enable-gate.sh` gate intact — that gate is about autopilot's footgun-ness, not about the loop substrate. The `RALPH_AUTOPILOT_ENABLE` opt-in remains the only gated `--loop` wrap.

#### 2. Arg-stripping test

**File**: `ralph/skills/shared/__tests__/loop-arg-strip.test.sh` (new)
**Changes**: A bash test runner that exercises the Phase-1 arg-parsing snippet against ten fixtures: `--loop`, `--loop 5m`, `--loop dynamic`, `--mode auto --loop`, `--mode auto --loop 1h`, `--loop --mode auto`, `--mode auto --loop 5m #1234`, `--loop --pr 99`, `not-a-loop-flag --loop something`, and the no-`--loop` baseline. Asserts the snippet sets `LOOP_RAW`, `LOOP_INTERVAL`, and `STRIPPED_ARGS` to the expected values for each fixture.

#### 3. Refusal-firing test

**File**: `ralph/skills/shared/__tests__/loop-refusal.test.sh` (new)
**Changes**: Validates that the refusal-message template renders as a single line on each of the unsuitable surfaces (form / plan-default / impl-default / research-default / catch-up-default-narrative-dashboard / setup / hero-pr-drain / caretake-postmortem-retro / caretake-unblock-question). The test does not invoke the skills — it parses the `loop-wrapper.md` manifest and verifies the unsuitable-mode list matches the Current-State table in this plan.

#### 4. Continuation-distinction test

**File**: `ralph/skills/shared/__tests__/loop-continuation.test.sh` (new)
**Changes**: For each entry in the continuation-rules manifest, asserts that heartbeat-mode entries do NOT list `Queue empty.` as a terminal sentinel and that drain-mode entries DO. Catches drift if someone wires a new skill into the manifest with the wrong continuation shape.

### Success Criteria

#### Automated Verification

- [ ] `bash ralph/skills/shared/__tests__/loop-arg-strip.test.sh` passes all ten fixtures.
- [ ] `bash ralph/skills/shared/__tests__/loop-refusal.test.sh` passes.
- [ ] `bash ralph/skills/shared/__tests__/loop-continuation.test.sh` passes.
- [ ] `cd plugin/ralph-hero/mcp-server && npm test` still passes (MCP-server regression check).
- [ ] `diff <(grep -A2 'Skill("loop"' ralph/skills/hero/SKILL.md) <(grep -A2 'Skill("loop"' ralph/skills/shared/loop-wrapper.md)` shows the hero body now references the shared template rather than inlining the prose.
- [ ] `wc -l ralph/skills/hero/SKILL.md` is at least 10 lines shorter than the pre-refactor count (deduplication actually happened).

#### Manual Verification

- [ ] `/ralph:hero --mode auto` (no `--loop`) behaves identically to today (opt-in via `RALPH_AUTOPILOT_ENABLE=true`, dispatches Director in `/loop` dynamic mode).
- [ ] `/ralph:hero --mode auto --loop 5m` is honored — observed via `/tasks` showing a 300s wakeup interval (note: 300s is the cache-window anti-pattern; the user is explicitly opting in, which the wrapper allows but `loop-wrapper.md` warns about in prose).
- [ ] After Phase 5 merges, no SKILL.md inlines `Skill("loop", args=...)` with continuation prose — every wrapped invocation references the shared template.

## Testing Strategy

### Unit Tests

- Phase 5's three bash test files cover arg parsing, refusal-message wiring, and heartbeat-vs-drain manifest consistency. Run them via `bash ralph/skills/shared/__tests__/*.test.sh` in CI.
- The MCP-server vitest suite is unchanged but should be re-run in CI to catch any inadvertent regression (no changes are expected there).

### Integration Tests

- The /loop skill itself is built into Claude Code; we cannot run it in CI. Integration verification is manual (see per-phase Manual Verification checklists).
- Add a smoke-test invocation to `ralph/scripts/smoke-test.sh` (if it exists; otherwise skip) that runs `/ralph:impl --mode auto --loop` against a known-empty queue and asserts the wrapping fires + the inner invocation returns `Queue empty.` cleanly. The smoke test does not need the loop to re-fire — observing the first wrap-and-return cycle is sufficient.

### Manual Testing Steps

1. **Wrap-and-return smoke**: in a fresh session with an empty queue, invoke `/ralph:impl --mode auto --loop`. Verify the first model turn calls `Skill("loop", args=...)`, the inner turn observes `Queue empty.`, and the wrapping `/loop` session ends without scheduling a wakeup.
2. **Wrap-and-progress smoke**: in a session with one Ready-for-Plan XS issue, invoke `/ralph:plan --mode auto --loop`. Verify the inner invocation completes the plan, emits `Plan complete for #NNN`, and `/loop` re-fires (observable via `/tasks` showing a queued wakeup in the 60-270s bucket).
3. **Refusal smoke**: invoke `/ralph:form --loop`. Verify the one-line refusal prints and form's normal flow does not run.
4. **Heartbeat smoke**: invoke `/ralph:hero --mode watch --loop 5m`. Verify a 5-minute wakeup is queued even though watch did "nothing" (no alerts to triage).
5. **Backward compat**: invoke `/ralph:hero --mode auto` (no `--loop`). Verify identical behavior to pre-refactor (opt-in gate, dispatches in /loop, etc.).

## Performance Considerations

The wrapping pattern adds one model turn per `--loop` invocation (the Step-0 short-circuit that emits the Skill("loop") call). This is the same cost autopilot pays today. No measurable perf regression.

The shared `loop-wrapper.md` fragment is read by each loop-suitable SKILL.md's body when that skill is invoked. Reads are local-FS and one-shot per invocation; negligible cost.

The continuation prompts increase the size of the args passed to `Skill("loop", ...)`. For a typical case (~500 chars of continuation prose), this adds ~150 tokens to the wrapping turn's input. Negligible.

## Migration Notes

- **Backward compatibility**: every skill+mode that exists today continues to work without `--loop`. The flag is purely additive. Users who type `/ralph:impl --mode auto` get the same one-phase-and-stop behavior as before.
- **Old `/ralph-hero:*` family**: per `ralph/CLAUDE.md`, the old plugin keeps working until each verb has a counterpart in `ralph/` that's been dogfooded. No equivalent `--loop` wiring is added to the old plugin — users who want loop semantics on the old plugin invoke `/loop /ralph-hero:<skill>` manually, same as today.
- **`hero --mode auto` opt-in stays**: `RALPH_AUTOPILOT_ENABLE=true` continues to gate the autopilot wrap. The new `--loop` flags on other skills are not opt-in-gated. This asymmetry is intentional: autopilot drives the whole pipeline across all teams; per-skill `--loop` flags drain one queue. The blast radius differs.
- **No state-machine changes**: the wrapping pattern does not touch the workflow state machine. Locking, advancement, postcondition checks all happen inside the wrapped child turn, identical to today's `--mode auto` invocations.
- **Sentinel literal-text dependency**: the continuation prompts in `loop-wrapper.md` reference terminal-sentinel strings verbatim (`Queue empty.`, `Phase N/M complete.`, etc.). If a skill changes its terminal-sentinel wording in the future, the corresponding manifest row must update. The Phase-5 continuation test catches drift between the manifest and the actual skill bodies as long as the test grep-patterns are kept in sync; a stronger test (parsing each SKILL.md for its `result:` / `Queue empty.` emissions) is a possible follow-up but out of scope here.

## Files Affected

- `ralph/skills/shared/loop-wrapper.md` (new) — Phase 1
- `ralph/skills/shared/__tests__/loop-arg-strip.test.sh` (new) — Phase 5
- `ralph/skills/shared/__tests__/loop-refusal.test.sh` (new) — Phase 5
- `ralph/skills/shared/__tests__/loop-continuation.test.sh` (new) — Phase 5
- `ralph/scripts/lint-loop-snippet.sh` (new) — Phase 1
- `ralph/skills/research/SKILL.md` — Phase 2
- `ralph/skills/plan/SKILL.md` — Phase 2
- `ralph/skills/impl/SKILL.md` — Phase 2
- `ralph/skills/review/SKILL.md` — Phase 2
- `ralph/skills/caretake/SKILL.md` — Phases 2 + 3
- `ralph/skills/hero/SKILL.md` — Phases 3 + 5
- `ralph/skills/catch-up/SKILL.md` — Phase 3
- `ralph/skills/caretake/outcome-tokens.md` — Phase 4
- `ralph/CLAUDE.md` — Phase 4

Total: 5 new files, 9 modified files. No MCP-server source changes; no hook script changes; no schema changes.

## References

- `ralph/skills/hero/SKILL.md` lines 143-162 — the canonical wrap-in-loop precedent that this plan generalizes
- `thoughts/shared/research/2026-05-21-autopilot-loop-handoff.md` — primary research on the autopilot → /loop → ScheduleWakeup handoff
- `ralph/CLAUDE.md` — slim-plugin constraints (SKILL.md ≤ 150 lines, opinion in siblings, enforcement in hooks)
- `ralph/skills/caretake/outcome-tokens.md` — terminal-sentinel reference for loop-suitable caretake modes
- Built-in `/loop` skill description (top of every session prompt) — interface contract for the wrapper
- `ScheduleWakeup` tool docs (top of every session prompt) — cache-window guidance honored by the continuation prompts
