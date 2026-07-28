---
date: 2026-07-26
github_issue: 1590
github_url: https://github.com/cdubiel08/ralph-hero/issues/1590
topic: "Skill surface reduction wave 2 — reference sweep for the six children #1603-#1608"
tags: [research, skills, surface-reduction, hooks, caretake, hero]
status: complete
type: research
---

# Research: GH-1590 skill surface reduction sweep (feature bookend for #1603–#1608)

## Prior Work

- builds_on:: [[2026-07-26-GH-1590-plan-of-plans]] (plan — describes intent, may not reflect outcome)
- builds_on:: [[2026-07-25-ralph-4cs-surface-reduction]] (idea — unvetted, condensed audit; several claims corrected below)
- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]] (research — primary evidence for the wave-1 design this wave prunes)

## Research Question

Produce a file:line-grounded reference sweep for each of the six children of #1590 (skill surface reduction wave 2, 47 modes → ≤22), sufficient for the downstream group plan to delete/merge surfaces without breaking the plugin. Flag every place the issue bodies' claims have drifted from main.

## Summary

All six children are viable, but **five of the six issue bodies contain claims that are wrong or drifted** on the evidence (§ Corrections). The most consequential:

1. **`--mode prove` is not an orphan** — `ralph/skills/hero/dispatch.md:10` dispatches `NNN --mode prove` for claim-checks, and it inherits **4** Stop hooks, not 5.
2. **`triage-agent` is not never-dispatched** — `ralph/skills/catch-up/next-action-ranking.md:102-103` has two live `Agent(subagent_type="ralph:triage-agent")` dispatch rows (`tree-continue`, `lock-stale`).
3. **`--mode debug` is not fully dead** — `ralph/skills/hero/watch-dispatch.md:26,51` dispatches it from `hero --mode watch` (gated on `RALPH_DEBUG=true`); deletion must edit hero files not listed in #1603's scope.
4. **`narrative-synthesis.md` and `dashboard-render.md` cannot be deleted wholesale** — the default catch-up flow and `--mode brief` consume them; only the `--mode narrative`/`--mode dashboard` dispatch branches are deletable.
5. **The "3 copies of the loop/auto substrate" claim is stale** — no SKILL.md inlines the snippet anymore; the three copies today are `shared/loop-wrapper.md`+`auto-alias.md` (canonical), the `ralph/CLAUDE.md` suitability matrix (duplicates the refusal strings verbatim), and `ralph/skills/shared/__tests__/loop-arg-strip.test.sh` (a deliberate test copy).
6. **The mode count is 45, not 47**, under the explicit counting rule stated in § Mode tally.
7. The plan-of-plans' "parallel-safe after #1603 (disjoint mode bodies)" claim is **false for #1604 vs #1606**: both rewrite `ralph/skills/hero/SKILL.md:156-157` (classify steps 3–4, the `DISPATCH_ARG` lines).

## Detailed Findings

### #1603 — Delete dead caretake + catch-up modes

#### `caretake --mode debug` (`ralph/skills/caretake/modes/debug.md`, 194 lines)

Audit evidence verified, with one correction:

- **Tool unrostered**: `collate_debug` is absent from caretake's `allowed-tools` (`ralph/skills/caretake/SKILL.md:51-84` — list ends at `knowledge_recall`; no `collate_debug` entry). Confirmed.
- **Tool gated off by default**: `debug.md:15` — "The `ralph_hero__collate_debug` tool is only registered when this env var is `\"true\"`" (`mcp-server/src/tools/debug-tools.ts:402-405`, registered from `index.ts` only under `RALPH_DEBUG=true`). Confirmed.
- **Hardcoded machine path**: `debug.md:22` hardcodes `http://localhost:3100/...` and `debug.md:40` hardcodes `cd ~/projects/langfuse && ./scripts/up.sh`. Partially overridable (`debug.md:193` allows `LANGFUSE_HOST` env), but the startup instruction is one machine's path. Confirmed with nuance.
- **CORRECTION — not "dead" in the dispatch graph**: `ralph/skills/hero/watch-dispatch.md:26` (`langfuse-trace:` URL → `Skill("ralph:caretake", "--mode debug --issue NNN")`) and `watch-dispatch.md:51` (heartbeat step: `--mode debug --auto-confirm --since 24h --min-occurrences 3` when `RALPH_DEBUG=true`). It is dead *by default environment*, not unreachable.

Full reference sweep for `--mode debug`:

| File:line | What it is |
|---|---|
| `ralph/skills/caretake/modes/debug.md` | mode body — DELETE |
| `ralph/skills/caretake/SKILL.md:2,3` | description + argument-hint mode enumerations |
| `ralph/skills/caretake/SKILL.md:100` | mode table row |
| `ralph/skills/caretake/SKILL.md:122` | `--loop` routing (`caretake:debug` row) |
| `ralph/skills/caretake/SKILL.md:166` | mode-bodies link list |
| `ralph/skills/caretake/SKILL.md:184` | terminal-token quick-ref line |
| `ralph/skills/caretake/outcome-tokens.md:76-82` | `## Debug terminal tokens` section |
| `ralph/skills/caretake/outcome-tokens.md:130` | drain-modes list includes debug |
| `ralph/skills/caretake/label-routing.md:18` | `debug-auto` → `--mode debug` route row |
| `ralph/skills/caretake/label-routing.md:30` | `trigger:caretake` fan-out item 5 |
| `ralph/skills/hero/watch-dispatch.md:26,51` | **hero-side dispatch call sites** |
| `ralph/skills/hero/event-classes.md:37,93` | `debug-auto` producer/consumer rows naming `--mode debug` |
| `ralph/skills/hero/SKILL.md:92` | hero mode table names "debug-collate" in `--mode watch` role |
| `ralph/skills/shared/loop-wrapper.md:49` | `caretake:debug` manifest row |
| `ralph/CLAUDE.md:74` | loop suitability matrix row |
| `README.md:78` | caretake one-liner mentions "debug" |

No hook script keys on `RALPH_SUBCOMMAND=debug` (debug.md:194: "No hook gates this mode"). What breaks if deleted without edits: `label-routing.md:18/30` and `watch-dispatch.md:26/51` become phantom dispatches (Skill call into a nonexistent mode body → undefined behavior at runtime); `loop-wrapper.md` manifest row orphans; the loop matrix and README drift (not CI-checked — modes are not rostered by `check-doc-rosters.sh`, see § CI surface).

#### `caretake --mode postmortem` → fold into `reflect` (`modes/postmortem.md`, 175 lines; `modes/retro.md`, 294 lines)

- **CORRECTION — "reads worker infra deleted in GH-1438" is imprecise.** Postmortem reads `TaskList`/`TaskGet` (`postmortem.md:13`), which still exist and are still rostered (`caretake/SKILL.md` allowed-tools). Hero's default mode still creates tasks (`ralph/skills/hero/task-graph.md:3,89` — `TaskCreate` shapes; `hero/SKILL.md:57`). What IS gone is the team/worker session concept: `postmortem-completeness.sh:5-9` documents its own port ("the slim plugin has no `team` concept"), and postmortem's semantics (worker assignments, team-lead `SendMessage`, `ralph-team-{team-name}` report path, `postmortem.md:39,58`) describe the deleted Director/team path. Nothing in the slim plugin produces the worker/owner task metadata §Step 1 extracts. The mode degenerates to `POSTMORTEM SKIPPED no-session-data` (`postmortem.md:19`) in practice — dead in effect, but cite it precisely.
- Hook: `postmortem-completeness.sh` (Stop) scopes on `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=postmortem` (`postmortem-completeness.sh:27-32`), reads `RALPH_POSTMORTEM_PATH`, validates frontmatter fields + 5 section headings. Registration: `caretake/SKILL.md:48`. **Both the script and the registration line must be deleted (or retargeted at `reflect`) in the same change.** No dedicated test file exists for it (`ralph/hooks/scripts/__tests__/` has no postmortem test), so deletion is test-silent.
- Retro↔postmortem coupling to unwind when renaming retro→reflect: `retro.md:11,29,39,42,50` (team-session dedup prompt offering `--mode postmortem`), `outcome-tokens.md:66` (`RETRO SKIPPED team-session-redirect`), `outcome-tokens.md:55-70` (both token sections), `label-routing.md:17` (`process-improvement` → retro) and `:31-32` (fan-out items 6–7), `SKILL.md:2,3,97-98,124,163-164,181-182`, `ralph/CLAUDE.md:81-82`.

#### `caretake --mode trends` (`modes/trends.md`, 49 lines)

Audit claim confirmed: two MCP calls (`capture_snapshot` at `trends.md:21`, `metrics_trends` at `trends.md:27`) + stdout print; no hook, no terminal token (`trends.md:9`). References: `SKILL.md:2,3,93,99,126,151,165,183`, `outcome-tokens.md:5,72-74,132` (+ "parity with hygiene/trends" prose at `:99,107,115,124`), `label-routing.md:14` (`trends-check` row), `loop-wrapper.md:48` (`caretake:trends` manifest row), `ralph/CLAUDE.md:73`, `README.md:78`, `watch-pr.md:11` (parity mention).

**`--mode all` fan-out**: `SKILL.md:144-152` — 7 serial children, item 7 is trends; the consolidated-report wording "one line per child — 7 total" is at `SKILL.md:152`. **Deleting trends → 6 children, and `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh:124` hard-greps the literal `"7 total"`** — that test must be edited in the same PR or `test-hooks` CI fails. Note there is a SECOND, different fan-out list (`label-routing.md:22-35`, the 8-item `trigger:caretake` fan-out: hygiene, triage, split, unblock, debug, postmortem, retro, report — no trends, no watch-*, no enrich). #1603 touches both lists differently: `--mode all` loses trends; the trigger fan-out loses debug (item 5), postmortem (item 6), and retargets retro (item 7) to reflect.

#### `catch-up --mode narrative` + `--mode dashboard`

- `--mode narrative` body is `catch-up/SKILL.md:113-117` — genuinely a ~5-line duplicate of default Step 1 (`SKILL.md:69-81`, same `Agent(subagent_type="ralph:catch-up-agent")` dispatch). Confirmed.
- **CORRECTION — `narrative-synthesis.md` (63 lines) must NOT be deleted.** It is consumed by the default flow (`SKILL.md:65,77` — the agent prompt points at it) and by "a programmatic invoker like `cos`" (`narrative-synthesis.md:63`). Only the `--mode narrative` branch + mode-table row (`SKILL.md:55`) + argument-hint/description mentions (`SKILL.md:9,10`) + refusal-list mention (`SKILL.md:48`) + sibling-list entry (`SKILL.md:165`) go.
- **`catch-up-agent` survives** (issue's Research Note already leaned this way — confirmed): it backs default Step 1 (`SKILL.md:65,75`), is rostered at `CLAUDE.md:85`, and `check-doc-rosters.sh` would fail if the file were deleted without a roster edit.
- **CORRECTION — `dashboard-render.md` (78 lines) is consumed by `--mode brief`**: `catch-up/brief-composition.md:51` inherits its never-editorialize list by reference. Deleting the file breaks brief's negative-constraint inheritance; either keep the file or move the constraint list into `brief-composition.md` in the same change. The `--mode dashboard` branch itself is `SKILL.md:119-130` + row `:56` + `ralph/CLAUDE.md:86-87` + `README.md:79`.
- catch-up has **no skill-frontmatter hooks at all** (frontmatter is `SKILL.md:1-29`: description, argument-hint, context, allowed-tools only). The only hook touching catch-up is plugin-level `ralph/hooks/hooks.json:14-22` (`cursor-advance-catch-up.sh` PostToolUse on `recent_activity`) — unaffected by mode deletion since default Step 1 still calls `recent_activity` via the agent.

#### What must be edited in the same change (#1603 complete list)

`ralph/skills/caretake/SKILL.md` (description, argument-hint, mode table, loop routing, fan-out + "7 total", mode-bodies list, token quick-ref); `modes/debug.md`, `modes/postmortem.md`, `modes/trends.md` deleted; `modes/retro.md` → `modes/reflect.md`; `outcome-tokens.md` (debug/postmortem/retro/trends sections + loop-continuation + parity prose); `label-routing.md` (rows 14, 17, 18; fan-out items 5–7); `ralph/skills/catch-up/SKILL.md` (rows + branches); `ralph/skills/hero/watch-dispatch.md:26,51`; `ralph/skills/hero/event-classes.md:37,93`; `ralph/skills/hero/SKILL.md:92` (watch-mode role text); `ralph/skills/shared/loop-wrapper.md:48-49` (manifest rows); `ralph/hooks/scripts/postmortem-completeness.sh` + registration `caretake/SKILL.md:48`; `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh:124` ("7 total"); `ralph/CLAUDE.md:73-74,81-82,86-87` (matrix rows); `README.md:78-79`; root `CLAUDE.md:71,78` verb-table one-liners ("Caretaking: triage, hygiene, unblock, trends, split, debug, report" and the catch-up row). No mcp-server test references these mode names (grep clean); `scripts/dream/tests/` clean for these modes.

### #1604 — Merge watch-pr / watch-upstream / watch-blockers → `--mode watch --kind {pr,upstream,issue}`

Bodies: `modes/watch-pr.md` (86 lines), `modes/watch-upstream.md` (88), `modes/watch-blockers.md` (91).

**What differs** (the parameterizable surface):

| Axis | watch-pr | watch-upstream | watch-blockers |
|---|---|---|---|
| Predicate matched | Backlog + client-side regex `^blocked:pr-([0-9]+)$` (`watch-pr.md:29`) | Backlog + server-side `label: "blocked:upstream"` (`watch-upstream.md:29`) | Human Needed + Backlog sweeps; signal = `blockedBy` edge or `## Escalation` body "Blocked by #NNN" (`watch-blockers.md:29-39`) — no label |
| Resolution predicate | `gh pr view --json state,mergedAt` → `MERGED` (`watch-pr.md:44-51`) | per-URL-type check (issue/PR closed, registry version, HTTP signal), conservative (`watch-upstream.md:48-56`) | ALL blockers `CLOSED` via `get_issue` per blocker (`watch-blockers.md:51-59`) |
| Action on resolution | strip label, apply deferred verdict (full 4-verdict map), `## Watch-PR Resolution` comment (`watch-pr.md:59-65`) | strip label, promote family only (`CLOSE-*`/`WAIT-*` → escalate), `## Watch-Upstream Resolution` (`watch-upstream.md:60-66`) | `remove_dependency`, advance to embedded/default target, strip `blocked:*`+`ralph-triage`, `## Unblocked` (`watch-blockers.md:63-70`) |
| Escalation path | PR closed-unmerged → Human Needed (`watch-pr.md:53,66-71`) | dead URL (404/410) or unparseable → Human Needed; 5xx/timeout = transient, leave (`watch-upstream.md:56,69-72`) | none — open blocker → leave and count in `<m>` (`watch-blockers.md:56,72-74`) |
| Terminal token | `WATCH-PR ADVANCED <N>` (`watch-pr.md:77`) | `WATCH-UPSTREAM ADVANCED <N>` (`watch-upstream.md:78`) | **two-number shape** `WATCH-BLOCKERS <n> advanced, <m> still blocked` (`watch-blockers.md:80`) |

**What is identical**: §Step 1 branch guard (`git branch --show-current`; off-main → `WATCH-<MODE> SKIPPED — branch <name> is not main`, `watch-{pr,upstream,blockers}.md:13-23`); the SKIPPED-vs-IDLE explanatory sentence (`:25` in each); the IDLE path (`WATCH-<MODE> IDLE` on empty find, `watch-pr.md:31-37`, `watch-upstream.md:31-37`, `watch-blockers.md:41-47`); the no-Stop-hook preamble (`:11` in each); the `export RALPH_SUBCOMMAND=watch-<mode>` fence (`:5-7`); the `command: "ralph_triage"` unguarded-transition note (`watch-pr.md:63`, `watch-upstream.md:64`, `watch-blockers.md:69`); the explicit-labels-array warning (`watch-pr.md:70`, `watch-upstream.md:71`, `watch-blockers.md:69`); the step skeleton and §Constraints closer.

**Every dispatch/reference call site**:

- `ralph/skills/caretake/SKILL.md:2,3` (enumerations), `:93` (all-row), `:102-104` (mode table rows), `:146-148` (`--mode all` fan-out items 2–4), `:168-170` (mode-body links), `:186-188` (token quick-ref).
- **Outside caretake**: `ralph/skills/hero/SKILL.md:156` (classify step 3 — `DISPATCH_ARG="--mode watch-pr"` / `"--mode watch-upstream"`), `:157` (classify step 4 — `Skill("ralph:caretake", args=DISPATCH_ARG)`, board-wide); `ralph/skills/hero/event-classes.md:27-28` (`blocked:pr-*` / `blocked:upstream` tier rows), `:79` (prose restatement).
- `ralph/skills/caretake/modes/triage.md:92-93,109-111,115-117,167,201,259-261` — the producer-side (`WAIT-pr`/`WAIT-upstream`/`WAIT-issue`) prose naming each consumer mode.
- `ralph/skills/caretake/outcome-tokens.md:16-18` (triage tokens naming watchers), `:93-115` (three token sections), `:124,132`.
- `ralph/CLAUDE.md:76-78` (matrix rows).
- `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` — **a doc-structure grep test, not a hook test** (`:2-9`). It hard-codes: `export RALPH_SUBCOMMAND=watch-blockers` (`:78`), all three token shapes incl. `WATCH-BLOCKERS ... advanced ... still blocked` regex (`:111-118`), `'mode watch-blockers'` + `"7 total"` + `modes/watch-blockers.md` + a ≥5-occurrence count of `watch-blockers` in SKILL.md (`:123-127`), `## Watch-Blockers terminal tokens` heading + ≥3 occurrences in outcome-tokens.md (`:132-135`), and `caretake --mode watch-blockers` in triage.md (`:140-147`). **Essentially every assertion breaks on the merge; rewrite it as `caretake-watch.test.sh` in the same PR.**

**CORRECTIONS to #1604's body**: (1) "`label-routing.md` rows for `blocked:pr-*`, `blocked:upstream`" — **no such rows exist**; `label-routing.md` has zero watch-mode or `blocked:*` references (verified full-file grep). The `blocked:*` tier lives only in `event-classes.md:26-28` — that asymmetry is itself #1607 evidence. (2) hero dispatches only 2 of the 3 kinds — there is no `watch-blockers` dispatch anywhere in `hero/SKILL.md` or `event-classes.md` (watch-blockers runs only via the `--mode all` fan-out). (3) No hook script anywhere greps `WATCH-*` tokens (`grep -n "watch" ralph/hooks/scripts/*.sh` hits only autopilot comments about `hero --mode watch`), so the token merge is hook-safe; the only executable coupling is the doc-structure test.

**Proposed token family** preserving the branch-guard variant: `WATCH <kind> ADVANCED <N>` (pr/upstream) and `WATCH issue <n> advanced, <m> still blocked` risk keeping the asymmetry; simplest uniform family is `WATCH-<KIND> ADVANCED <N>` / `WATCH-<KIND> IDLE` / `WATCH-<KIND> SKIPPED — branch <name> is not main` with `KIND ∈ {PR, UPSTREAM, ISSUE}`, folding watch-blockers' `<m> still blocked` into the summary prose (it is informational; nothing greps it except the doc-structure test being rewritten anyway). Whatever family is chosen, `outcome-tokens.md` and the SKILL.md quick-ref must change together (see #1607's drift list).

### #1605 — One decomposition surface + `plan-research-required.sh` scoping

**How the hook decides to block** (`ralph/hooks/scripts/plan-research-required.sh`, 103 lines; registered ONLY in `plan/SKILL.md:22-30`, `PreToolUse` matcher `Write`, first of three):

1. `file_path` not containing `/plans/` → allow (`:39-41`).
2. `RALPH_REQUIRES_RESEARCH != true` → allow (`:43-45`).
3. No `GH-[0-9]+` token in the path → allow (`:47-50`).
4. Research doc matching the ticket exists under `<root>/thoughts/shared/research` (via `resolve_root_from_path` + `find_existing_artifact`) → allow (`:52-57`).
5. Frontmatter `research_waived:` present in `.tool_input.content` → allow with context (`:63-74`).
6. `estimate:` below `RALPH_RESEARCH_REQUIRED_MIN_ESTIMATE` (default M → XS/S waived) → allow (`:77-88`).
7. Else → block, exit 2 (`:90-102`).

**There is NO plan-of-plans carve-out** — no branch inspects `type: plan-of-plans` or `## Feature Decomposition`; `plan-research-required.test.sh` has no such case either (confirming absence). The hook-evasion is real and stated twice: `modes/split.md:140` and `split-decomposition.md:85` ("split runs in **caretake** context, where the plan skill's `plan-research-required.sh` Write gate is not armed... The plan skill itself cannot (its own gate blocks the write)").

**Scoping change that lets a decomposition write pass on its own merit without opening a hole**: add a discrimination branch between steps 3 and 4 that mirrors `doc-structure-validator.sh:60-69`'s existing fence-stripped discriminator — parse `.tool_input.content`, and if (fence-stripped) it matches `^type:[[:space:]]*plan-of-plans` OR `^## Feature Decomposition`, allow-with-context. The hole this could open (labeling any plan `type: plan-of-plans` to skip research) is bounded because the plan skill's Stop-side `doc-structure-validator.sh` then enforces the plan-of-plans shape (`## Feature Decomposition` + `## Feature Sequencing` + `## Design Decisions` block, `doc-structure-validator.sh:68-93`) — a mislabeled implementation plan fails the Stop gate. For symmetry the merged surface should run in plan context so BOTH gates arm (see the validator gap below).

**Two more corrections/discrepancies the plan must handle**:

- `split-decomposition.md:79` and `modes/split.md:140` claim the split-written doc "passes `doc-structure-validator.sh`" — but that Stop hook is registered **only** in `plan/SKILL.md:67-72`, not in caretake's Stop list (`caretake/SKILL.md:39-50`). In caretake context the validator never runs; the plan-of-plans shape is currently enforced by nothing during split. Moving decomposition into plan context *adds* enforcement.
- `split-decomposition.md:98` describes `split-postcondition.sh` as grepping the transcript for `SPLIT <N>` — **it does not**. The script reads `RALPH_TICKET_ID` and `RALPH_SPLIT_COUNT` env vars (`split-postcondition.sh:33-44`; no ticket → allow, count ≥2 → allow, else block). The ≥2-children guarantee is env-var-trust, not transcript inspection.

**The split hooks (3 scripts, 4 registrations)** and the guarantees to preserve:

| Hook | Event/matcher (`caretake/SKILL.md`) | Scope guard | Guarantee |
|---|---|---|---|
| `split-estimate-gate.sh` | PreToolUse `get_issue` (`:16-19`) + PostToolUse `get_issue` (`:31-34`) | `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=split` (`:28,31`) | Pre = context reminder only; Post = block unless parent estimate ∈ M/L/XL (`:56-97`) |
| `split-size-gate.sh` | PreToolUse `create_issue\|create_sub_issues` (`:20-23`) | same pair (`:24-29`) | every child estimate ∈ XS/S (batch `:35-59`, scalar `:63-78`) |
| `split-postcondition.sh` | Stop (`:46`) | same pair (`:19-24`) | ≥2 children via `RALPH_SPLIT_COUNT` (`:40-44`) |

All three scope on `RALPH_COMMAND=caretake` + `RALPH_SUBCOMMAND=split`, so the merged surface must either re-key them (e.g. `RALPH_COMMAND=plan` + `RALPH_SUBCOMMAND=epic|split`) or re-register them in the surviving skill's frontmatter — re-registration alone is insufficient because the env guard would still no-op them.

**The three surfaces today**:

- `caretake --mode split` (`modes/split.md`, 235 lines): pick M+ issue → analyze → `create_sub_issues` batch → dependencies → §7.5 plan-of-plans write (`:130-140`, ≥2 children only) → `## Issue Split` comment → child states via `batch_update` → `SPLIT <N>`.
- `plan --mode epic` (`plan/SKILL.md:167-179` + `plan/decomposition.md`): lock epic → write plan-of-plans → ONE `create_sub_issues` call with inline `dependsOn` (`:174`) → update doc with child numbers → commit/push → `## Plan of Plans` comment + Plan in Review. Does **not** call `decompose_feature` (rostered at `plan/SKILL.md:100` but invoked by no step).
- `form` Step 6b (`form/SKILL.md:138-146`): parent `create_issue` (estimate L) + children via one `create_sub_issues` (children hard-coded `estimate: "XS"` in the example shape). Form registers **no hooks at all** (frontmatter `:11-29` has no `hooks:` block) — no size gate arms in form context today.

**Hero-side SPLIT dispatch call sites to update**: `hero/dispatch.md:9` (SPLIT row), `:26` (Skill-vs-Agent table), `:96` (split-failure row); `hero/state-machine.md:18,76,88`; `hero/task-graph.md:11,14-15,97`; `label-routing.md:19` (`needs-split` row), `:28` (fan-out item 3), `:48`. Also `outcome-tokens.md:84-91` (split token section) and `caretake/SKILL.md` split rows (`:96` area, `:122,185`), `ralph/CLAUDE.md:75` (split matrix row), `README.md:78`.

**Tests**: `split-size-gate.test.sh` (86 lines — scope-guard + scalar + batch cases) and `plan-research-required.test.sh` (118 lines — the SBX/REPO/NOGIT harness that `ralph/CLAUDE.md` § hooks tells new hook tests to copy). The scoping change adds cases to the latter; re-keying the split gates requires updating the former's env fixtures.

### #1606 — Remove `hero --mode classify`; fold into `--mode auto`

**The coupling map** (all verified in source):

- **Mode plumbing**: `hero/SKILL.md:2,3` (description/argument-hint), `:91` (mode table row), `:120` (`RALPH_SUBCOMMAND=classify` case), `:127` (loop-gate note), `:150-160` (the `## --mode classify` section), `:143` (default-mode Step 1 cross-ref explaining the human-vs-agent audience split), `:195` (pr-drain intro), `:174` (hero:auto vs hero:default result-line callout).
- **`--mode auto` wrapper**: `hero/SKILL.md:165` emits `Skill("loop", args="Run /ralph:hero --mode classify …\n\n<continuation …hero:auto manifest row>")`; `{INNER_COMMAND}` = "Run /ralph:hero --mode classify on the next-most-important event…"; `{PROGRESS_SENTINELS}` = `result: Dispatched #NNN to <team> via <entrypoint>`; no terminal sentinels.
- **`/loop` continuation contract result-line greps**: `result: Dispatched #NNN …` → 60–270s wakeup; `result: Queue empty.` → 3600s idle, NOT terminal (`hero/SKILL.md:167-170`; `loop-wrapper.md:54` hero:auto row: "`--mode auto` wraps `--mode classify`; BOTH its result lines re-fire the loop").
- **`next_actions({audience:"agent"})` requirement**: `hero/SKILL.md:155` — MUST be `agent` (XS/S `audiencePenalty` in `directions.ts` + agent-only `scored.length === 0` Backlog-triage fallback); the default mode's bare `next_actions({})` at `:143` is intentionally human.

**Per-hook behavior if `--mode classify` disappears**:

| Hook | Keys on | Effect of the fold |
|---|---|---|
| `autopilot-enable-gate.sh` (PreToolUse Skill) | `RALPH_COMMAND=hero` + `RALPH_SUBCOMMAND=auto` env only (`:26-27`) — never inspects the dispatch string | **Unaffected** |
| `autopilot-director-postcheck.sh` (PostToolUse Skill) | literal `grep -q -- '--mode classify'` on `Skill("loop", …)` args (`:47-59`) — deliberately NOT `RALPH_SUBCOMMAND` (plain export doesn't propagate to hook subprocesses, comment `:22-24`) | **Silent fail-open**: watcher never armed (`$autoloop` never touched); the arming grep MUST be updated to the new inner-command string in the same change |
| `autopilot-wakeup-clear.sh` (PreToolUse ScheduleWakeup) | `RALPH_COMMAND=hero` only (`:24`); rejects `delaySeconds=300` (`:26-44`) | **Unaffected** |
| `autopilot-stop-gate.sh` (Stop) | sentinel files written by postcheck (`:31,48,52`) | **Silently never blocks** once postcheck stops arming — the never-terminate contract evaporates without any error |

**CORRECTION to #1606's body**: "Hooks scoping on `RALPH_SUBCOMMAND=classify`" — **no hook keys on `RALPH_SUBCOMMAND=classify`**. The only classify coupling in hook code is the literal `'--mode classify'` string grep in `autopilot-director-postcheck.sh:56`. The `RALPH_SUBCOMMAND=classify` export (`hero/SKILL.md:120`) is consumed by nothing.

**Tests that break**:

- `hero-classify-audience.test.sh` — anchors an awk extractor on the literal heading `/^## --mode classify[[:space:]]*$/` (`:55-61`); asserts `next_actions({ audience: "agent" })` appears inside that block (`:82-88`) and that the block does NOT contain bare `next_actions({})` (`:92-100`). Folding classify into auto removes the heading → the extractor returns empty → assertion 3 fails. Re-anchor to the new section housing the agent-audience queue read.
- `autopilot-auto-watcher.test.sh:53-58` — the arming test feeds `tool_input:{"skill":"loop","args":"Run /ralph:hero --mode classify on the queue"}`; must track the new arming string. Other cases (`:68-79` result-line marks, `:82-120` wakeup/stop-gate) are string-dependent on `Dispatched #`/`Queue empty`, which survive if the result-line contract is preserved.
- Cosmetic: `scripts/dream/tests/test_ingest.py:539` embeds `"/loop Run /ralph:hero --mode classify on the next event "` as an ingest fixture — it tests dream ingest, not hero; it will not fail, but is a dangling reference to sweep.

**Docs**: `ralph/CLAUDE.md:91` (matrix row: "redundant with `hero --mode auto`" — the audit's warrant), `:103` (ScheduleWakeup rules prose naming the arming string); root `CLAUDE.md:76` (hero roster one-liner "auto … + watch + classify + pr-drain"); `hero/dispatch.md:3,20` (classify-path notes); `plan/plan-review.md:134` and `plan/SKILL.md:200` ("classify tick" idiom — retitle to "auto tick"); design record `docs/superpowers/specs/2026-05-25-autopilot-never-terminate-adaptive-watcher-design.md` (historical; no edit needed).

### #1607 — Single-source taxonomy + loop/auto substrate + token table

**Taxonomy divergence — `caretake/label-routing.md` (79 lines) vs `hero/event-classes.md`** (this is the reconciliation input, not a concatenation):

Rows only in `label-routing.md` (`:9-20`): `stale` (→hygiene), `status-update-needed` (→catch-up report), `trends-check` (→trends), `needs-triage` (→triage #NNN), `human-needed` as a *label* (→unblock --question), `needs-split` (→split #NNN), and the no-label default (→triage #NNN).

Rows only in `event-classes.md`: `trigger:builders`/`trigger:watch`/`trigger:scouts`/`trigger:memorykeepers` (`:15-19`), `blocked:pr-*`/`blocked:upstream` (`:27-28`), `watcher-auto`/`scout-auto` (`:36,38`), and the entire Priority-4 workflow_state fallback tier (`:46-57`).

Rows in BOTH that **disagree**:

1. `trigger:caretake` — `label-routing.md:11` + `:24-33`: full 8-mode serial fan-out, label consumed after dispatch. `event-classes.md:18` (+ shared rule `:11`): generic "dispatch the caretakers team", no fan-out mentioned.
2. `debug-auto` — `label-routing.md:18`: an **input** label routing to `--mode debug`. `event-classes.md:37,93`: an **output** label *written by* `--mode debug`, owned by watchers. Direction of causality and ownership both disagree.
3. `process-improvement` — `label-routing.md:17`: routes to `--mode retro` specifically. `event-classes.md:39` (+ team map `:69`): routes to generic `ralph:caretake`.

The "keep in sync" instruction is **one-directional**: `label-routing.md:79` ("same trigger-label conventions; keep both in sync"); `event-classes.md` never mentions `label-routing.md`. It is the only keep-in-sync instruction in `ralph/skills/**` (repo-wide grep; the `merge-gate.md:132` hit is unrelated prose).

**Loop/auto substrate — the three copies, located** (CORRECTION: the issue implies three inlined copies across SKILL.md bodies; that is stale):

1. Canonical pair: `shared/loop-wrapper.md` (114 lines: arg-parsing snippet `:7-27`, 20-row continuation manifest `:34-55`, continuation-prompt template `:61-102`, refusal message `:106-113`) + `shared/auto-alias.md` (66 lines: alias table `:12-19`, refusal targets `:23-29`, refusal string `:34`).
2. `ralph/CLAUDE.md:48-99` — the 40-row suitability matrix. Self-declared summary (`:50` "when there is any conflict, the source files win") but it duplicates the refusal-message strings **verbatim** (`ralph/CLAUDE.md:97,99` = `loop-wrapper.md:112` + `auto-alias.md:34`) and re-derives every manifest/alias row.
3. `shared/__tests__/loop-arg-strip.test.sh:23-35` — a self-declared "identical copy" of the arg-parsing snippet (header `:6-9`), already drifted by one token (`printf '%s'` at `:31` vs `echo` at `loop-wrapper.md:19`).

No verb SKILL.md inlines the snippet — all seven consumers reference by pointer (`caretake/SKILL.md:121`, `catch-up/SKILL.md:43`, `research/SKILL.md:100`, `impl/SKILL.md:99`, `plan/SKILL.md:132`, `review/SKILL.md:73`, `hero/SKILL.md:180`; `--auto` equivalents at `caretake:117-119`, `research:96-98`, `impl:95-97`, `plan:128-130`, `review:69-71`, `hero:113-115`). Note both shared files still say "SKILL.md bodies copy the snippets below; they do not source this file" (`loop-wrapper.md:3`, `auto-alias.md:3`) — that framing is itself stale and should be updated to match reality.

**Terminal-token duplication**: `caretake/outcome-tokens.md` (134 lines, full table) vs the self-declared quick reference at `caretake/SKILL.md:173-190`. Four drift points found: hygiene placeholder (`<N archived>` vs `<N>`, `outcome-tokens.md:35` vs `SKILL.md:178`); `UNBLOCK ESCALATED <reason>` loses its placeholder (`:46` vs `:179`); `UNBLOCK REQUEST SKIPPED — branch <name> is not main` missing entirely from the quick ref (`:51` vs `:180`); split's `Queue empty.` terminal missing from the quick ref (`:89` vs `:185`). No other SKILL.md carries a structured token table (grep verified — the other verbs only mention the `Queue empty.` sentinel inline).

### #1608 — Rehome `--mode prove`, delete `triage-agent`, verify mode count

**`--mode prove`** (`research/SKILL.md:188-196` + `prove-claim.md`, 132 lines):

- **CORRECTION — "nothing dispatches it" is false**: `hero/dispatch.md:10` — RESEARCH row: `/ralph:research --auto`, args "`NNN` (or `NNN --mode prove` for claim-checks)". This is the only dispatch site (repo-wide grep), and no board state or event class defines what a "claim-check" is — no `event-classes.md` row, no `next_actions` kind produces it — so it is *effectively* operator-judgment-only, but the rehoming must edit `dispatch.md:10` or the claim-check option dangles.
- **CORRECTION — "inherits 5 Stop hooks" is false: it inherits 4** (`research/SKILL.md:35-44`): `research-postcondition.sh`, `doc-structure-validator.sh`, `remember-turn.sh`, `lock-release-on-failure.sh`. How each no-ops for prove: `research-postcondition.sh:14-17` allows when `RALPH_TICKET_ID` is empty (prove treats the arg verbatim as a claim, never sets a ticket — `intake-routing.md:7`); `doc-structure-validator.sh` keys off tracked artifact writes and prove writes no doc (`findings-format.md:189`); `remember-turn.sh` and `lock-release-on-failure.sh` run harmlessly. The orphan-cost argument survives but must cite 4, and note `branch-gate.sh` is deliberately NOT registered partly because of prove (`research/SKILL.md:17-20` frontmatter comment).
- Other prove references to sweep on rehoming: `research/SKILL.md:9 (description), :11 (argument-hint), :78-80, :87 (mode table), :188-196 (body), :204 (sibling list)`; `intake-routing.md:7`; `research-shapes.md:3`; `findings-format.md:177-189` (per-mode matrix); `ralph/CLAUDE.md:55` (matrix row); `shared/__tests__/auto-alias.test.sh:121-127` (`--auto --mode prove` conflict case — keep or retarget).

**`triage-agent`** (`ralph/agents/triage-agent.md` — thin shell, sonnet, 8 MCP tools):

- **CORRECTION — "never dispatched" is false**: `catch-up/next-action-ranking.md:102` (`tree-continue` row) and `:103` (`lock-stale` row) both dispatch `Agent(subagent_type="ralph:triage-agent", …follow ${CLAUDE_PLUGIN_ROOT}/skills/caretake/modes/triage.md + label-routing.md…)`. These are live rows in the catch-up default-flow dispatch table. Deleting the agent requires rewriting both rows (e.g. to `Skill("ralph:caretake", args="--mode triage #NNN")`) in the same change. The claim holds only for *hero* — no hero file dispatches triage-agent.
- Rosters naming it: root `CLAUDE.md:85` (the 8-per-phase-agents bullet); `docs/superpowers/plans/2026-05-02-hello-composable-rewrite.md:1849-1850` (historical plan, no edit needed). It is NOT in `mcp-server/src/__tests__/skill-frontmatter.test.ts`'s `AGENTS` list (`:28-34` covers impl/plan/research/review/merge only) — deletion is vitest-silent.
- **`check-doc-rosters.sh` coupling**: the agents check awk-anchors on the literal heading `### ralph Plugin — 16 Agents` (`check-doc-rosters.sh:54`). Deleting an agent means the CLAUDE.md heading becomes "15 Agents" — **and the script's hardcoded regex must be updated in the same PR**, else `doc_agents` extracts empty and every source agent is flagged undocumented. The bullet-line regex `^\*\*[0-9]+ (per-phase agents|investigators)\*\*` (`:55`) tolerates the count change; only the heading anchor is brittle.

**Mode tally (BEFORE)** — counting rule, stated explicitly: **one mode = one row of the verb's SKILL.md mode-dispatch table**, counting `default` as one mode per verb, counting `--help` rows as zero, counting sub-flag variants (`unblock --question`, dashboard formats, `--dry-run`) as zero, and counting `setup` default/`--mode project` (one table row, `setup/SKILL.md:33`) as one:

| Verb | Modes (rows) | Count |
|---|---|---|
| catch-up | default, narrative, dashboard, report, brief (`catch-up/SKILL.md:52-58`) | 5 |
| form | default, draft (`form/SKILL.md:44`) | 2 |
| research | default, auto, prove (`research/SKILL.md:85-87`) | 3 |
| plan | default, auto, epic, iterate, review (`plan/SKILL.md:116-121`) | 5 |
| impl | default, auto, address, pr (`impl/SKILL.md:86-89`) | 4 |
| review | default, val, code, merge (`review/SKILL.md:60-63`) | 4 |
| caretake | default, all, triage, hygiene, unblock, postmortem, retro, trends, debug, split, watch-pr, watch-upstream, watch-blockers, enrich (`caretake/SKILL.md:90-105`) | 14 |
| hero | default, auto, classify, watch, pr-drain (`hero/SKILL.md:87-95`) | 5 |
| setup | project(default), cli, repos (`setup/SKILL.md:33-35`) | 3 |
| **Total (9 verbs)** | | **45** |

`hero-fable` is one additional surface outside the 9-verb set (not counted; #1590's plan-of-plans explicitly excludes it). **CORRECTION: the audit's "47" does not reproduce under any single obvious rule.** Plausible reconciliations: counting `unblock` interactive/autonomous as two (+1, they have separate token families and separate gating hooks per `outcome-tokens.md:54`) and `setup` default vs `--mode project` as two (+1) yields exactly 47; counting hero-fable and `--help` variants gives other paths to 46–48. #1608's AFTER tally should be stated against **45 under the rule above** so the comparison is stable. Projected AFTER under the same rule, if all siblings land as scoped: catch-up 3 (−narrative, −dashboard), caretake 9 (−postmortem, −trends, −debug, retro→reflect, watch-×3→watch) or 10 if decomposition stays a caretake mode, plan 4 or 5 (epic merge), hero 4 (−classify), research 3 or 2 (prove rehomed) → **~34–36, NOT ≤22**. Reaching ≤22 requires cuts beyond the six children's explicit scope (e.g. folding `--mode all` into default, merging review modes, dropping `form --mode draft`) — the group plan should either widen scope or restate the acceptance number. This is the single biggest gap between #1590's acceptance criteria and the evidence.

## Risks and ordering constraints

- **#1604 vs #1606 are NOT disjoint** (plan-of-plans "parallel-safe after #1603 (disjoint mode bodies)" is wrong for this pair): both rewrite `hero/SKILL.md:156-157` — #1604 renames the `DISPATCH_ARG` values, #1606 relocates the whole classify section those lines live in. They also both touch `hero/event-classes.md` (`:27-28,79` for #1604; consumer framing for #1606). Sequence them (#1606 → #1604, or vice versa with an explicit rebase), or land them as one phase. #1604's own body anticipates this ("if #1590's classify-removal child lands first, only `event-classes.md` remains") — the plan-of-plans graph contradicts its own child.
- **#1603 touches #1604's test file**: deleting trends changes the `--mode all` fan-out to 6 children, breaking `caretake-watch-blockers.test.sh:124`'s literal `"7 total"` grep. Fine under the current #1603-first sequencing, but the plan must assign the test edit to #1603, and #1604's rewrite of the same test must be based on #1603's result.
- **#1605 vs #1606 overlap is trivial but real**: both edit `hero/dispatch.md` (SPLIT row `:9` vs classify notes `:3,20`) — different lines, safe in parallel.
- **#1607 after #1603/#1604/#1606 is correct** (taxonomy rows for debug/retro/trends, watch-*, and classify all churn first). Note #1607's token-table merge also has to absorb whatever token family #1604 chooses — sequencing after #1604 is load-bearing, as the plan-of-plans says.
- **#1608 last is correct**, and it must also carry the `check-doc-rosters.sh:54` heading-regex edit alongside the CLAUDE.md roster change (they fail CI independently if split across PRs — but per the plan-of-plans integration strategy this all ships as one PR, so the risk is phase-internal only).
- **Single-PR strategy caveat**: `release-ralph.yml` fires on any `ralph/**` merge; since all six children ship as one PR, only one plugin version bump results — no mid-stack broken versions. If the plan changes to multiple PRs, every intermediate state must keep `caretake-watch-blockers.test.sh`, `hero-classify-audience.test.sh`, and `autopilot-auto-watcher.test.sh` green — those three tests are the sharpest inter-child tripwires.

## CI surface

| Check (`ci.yml`) | What it would catch here |
|---|---|
| `check-doc-rosters` (`ci.yml:288-295` → `scripts/check-doc-rosters.sh`) | Agent deletion without CLAUDE.md roster edit (bidirectional, `:53-80`); **also fails if the `### ralph Plugin — 16 Agents` heading count changes without editing the script's own anchor regex (`:54`)**. Skills check (`:87-116`) is verb-directory-based — mode deletions are invisible to it. Tools check (`:126-169`) is documented⊆source — untouched by this work unless README tool prose changes. |
| `test-hooks` (`ci.yml:111-127`) | Globs `*.test.sh` + `test-*.sh` under **both** `ralph/hooks/scripts/__tests__` and `scripts/__tests__`. Catches: `caretake-watch-blockers.test.sh` (fan-out count, watch tokens, mode-name greps), `hero-classify-audience.test.sh` (classify heading + agent-audience), `autopilot-auto-watcher.test.sh` (arming string), `split-size-gate.test.sh` / `plan-research-required.test.sh` (hook re-scoping), `auto-alias`/`loop-*` tests under `ralph/skills/shared/__tests__` are **NOT in the CI glob path** (only `ralph/hooks/scripts/__tests__` + `scripts/__tests__`) — verify locally; drift there is CI-silent. |
| `scripts/__tests__` (same job) | `merge-pr-gates.test.sh`, `attest-pr.test.sh`, `validate-attestation.test.sh`, `pr-file-classes.test.sh` — untouched by this work but must stay green since everything lands via `merge-pr.sh` (GH-1589). |
| ShellCheck (`ci.yml:264-286`) | `scandir: ralph/hooks` + `scandir: scripts`, severity=error — any edited/renamed hook (e.g. `postmortem-completeness.sh` deletion is safe; a new `reflect` postcondition or re-scoped `plan-research-required.sh` must pass). |
| actionlint + zizmor (`ci.yml:213-249`) | Only if workflows change — none of the six children touch `.github/workflows/`. |
| MCP pin verification (`ci.yml:136-149`) | Only if `.mcp.json` changes — not in scope. |
| mcp-server vitest (`ci.yml:14-38`) | `skill-frontmatter.test.ts` asserts frontmatter contract for impl/plan/research/review/caretake skills + 5 agents (not triage-agent, not catch-up-agent) — caretake/research frontmatter edits must keep description/argument-hint/allowed-tools shape parseable. |

Also non-CI but load-bearing: the plugin ships only after `release-ralph.yml` fires post-merge (verify `gh run list --commit <merge-sha>` per root CLAUDE.md).

## Corrections to issue-body claims (consolidated)

1. **#1603**: `--mode debug` is dispatched from `hero --mode watch` (`watch-dispatch.md:26,51`) — "dead" holds only under default env; scope must add `watch-dispatch.md` + `event-classes.md:37,93`. `narrative-synthesis.md` must survive (default Step 1 + external `cos` invoker); `dashboard-render.md` is inherited by `--mode brief` (`brief-composition.md:51`). Postmortem's "reads worker infra deleted in GH-1438" → precisely: TaskList/TaskGet still exist and hero still creates tasks, but the team/worker semantics postmortem parses have no producer; the completeness hook was already ported to slim.
2. **#1604**: `label-routing.md` has NO `blocked:pr-*`/`blocked:upstream` rows (that absence is #1607 divergence evidence, not a call site). Hero dispatches only watch-pr and watch-upstream — watch-blockers has no dispatch site outside the `--mode all` fan-out. `caretake-watch-blockers.test.sh` (unmentioned in the issue) must be rewritten. Token family note: watch-blockers' token is a two-number shape, unlike its siblings.
3. **#1605**: `plan-research-required.sh` has no plan-of-plans carve-out (confirmed) — but two of the issue's supporting docs overstate current enforcement: `doc-structure-validator.sh` does NOT run in caretake context (so split's plan-of-plans shape is currently enforced by nothing), and `split-postcondition.sh` verifies via `RALPH_SPLIT_COUNT` env var, not transcript grep. "Four split-* hooks" = 3 scripts / 4 registrations (estimate-gate is Pre+Post).
4. **#1606**: No hook keys on `RALPH_SUBCOMMAND=classify`; the coupling is the literal `'--mode classify'` grep in `autopilot-director-postcheck.sh:56`, whose failure mode is silent fail-open of the stop-gate. `hero-classify-audience.test.sh` anchors on the `## --mode classify` heading itself.
5. **#1607**: "3 copies of loop/auto substrate" — no SKILL.md inlines the snippet today; the three copies are the canonical pair, the `ralph/CLAUDE.md` matrix (verbatim refusal strings), and `loop-arg-strip.test.sh` (intentional test copy, already 1-token drifted). The "keep both in sync" instruction exists only in `label-routing.md:79` (one-directional).
6. **#1608**: prove IS dispatched (`hero/dispatch.md:10`); Stop hooks inherited = **4**, not 5; `triage-agent` IS dispatched (`next-action-ranking.md:102-103`); baseline mode count is **45** under the stated rule, not 47 — and the six children as scoped land at ~34–36, not ≤22; the ≤22 acceptance criterion needs either wider scope or a restated target.

## Code References

- `ralph/skills/caretake/SKILL.md:90-105` — caretake mode table (14 rows)
- `ralph/skills/caretake/SKILL.md:144-152` — `--mode all` fan-out (7 children, "7 total" at `:152`)
- `ralph/skills/caretake/label-routing.md:22-35` — `trigger:caretake` 8-item fan-out (the second, divergent fan-out list)
- `ralph/skills/caretake/outcome-tokens.md:93-115` — three watch-mode token sections
- `ralph/skills/hero/SKILL.md:150-174` — classify section + auto wrapper + continuation contract
- `ralph/hooks/scripts/autopilot-director-postcheck.sh:47-59` — the `'--mode classify'` arming grep
- `ralph/hooks/scripts/plan-research-required.sh:36-102` — full block-decision chain (no plan-of-plans carve-out)
- `ralph/skills/caretake/split-decomposition.md:85` + `modes/split.md:140` — the hook-evasion statements
- `ralph/hooks/scripts/doc-structure-validator.sh:60-93` — fence-stripped plan-of-plans discriminator (the precedent for the hook fix)
- `ralph/skills/hero/dispatch.md:10` — the `--mode prove` dispatch site
- `ralph/skills/catch-up/next-action-ranking.md:102-103` — the triage-agent dispatch rows
- `scripts/check-doc-rosters.sh:54-55` — the hardcoded "16 Agents" heading anchor
- `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh:111-147` — token/mode-name/count greps
- `ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh:55-100` — classify-heading-anchored assertions
- `.github/workflows/ci.yml:111-127,264-295` — test-hooks glob, ShellCheck scandirs, roster job

## Architecture Documentation

- Modes are dispatched by string match inside SKILL.md bodies; only `check-doc-rosters.sh` (verb dirs + agent files) and the hook tests bind docs to source. **Mode names themselves have no CI-checked roster** — dangling `--mode` references fail only at runtime or via the two doc-structure test files.
- Hook scoping is two-layer: `RALPH_COMMAND` via SessionStart `set-skill-env.sh` (propagates to hook subprocesses through `CLAUDE_ENV_FILE`), `RALPH_SUBCOMMAND` via plain `export` in mode bodies (does NOT propagate to hook subprocesses — which is exactly why `autopilot-director-postcheck.sh` greps the Skill payload instead).
- Terminal tokens are convention, not enforcement, for hygiene/trends/watch-*/enrich (no Stop postconditions); enforcement exists only for triage/unblock/split/postmortem (env-var- or transcript-based) — relevant when deciding which guarantees must survive each merge.

## Historical Context (from thoughts/)

- `thoughts/shared/ideas/2026-07-25-ralph-4cs-surface-reduction.md` — the condensed audit this feature executes; its skill-audit paragraph is the source of the drifted claims corrected above.
- `thoughts/shared/plans/2026-07-26-GH-1590-plan-of-plans.md` — sequencing + single-PR integration strategy; its "parallel-safe (disjoint mode bodies)" claim for #1604/#1606 is contradicted by `hero/SKILL.md:156-157`.
- `docs/superpowers/specs/2026-05-25-autopilot-never-terminate-adaptive-watcher-design.md` — original design for the classify-string arming pattern (`--mode classify` "uniquely identifies the auto watcher"), explaining why the fold must pick a new unique arming string.

## Related Research

- `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` — wave-1 design (52 skills → 9 verbs) that created these mode surfaces.
- `thoughts/shared/research/2026-04-26-dreaming-research-trail-and-self-containment.md` — dream-loop context for the `process-improvement` label producer referenced in the taxonomy divergence.

## Open Questions

1. **The ≤22 target**: the six children as scoped reach ~34–36 modes under the stated counting rule. Does #1590 widen scope (fold `--mode all` into caretake default, merge review val/code/merge, drop form draft, etc.) or restate the target? Must be resolved at group-plan time — it is #1590's first acceptance criterion.
2. **Where does the merged decomposition surface live** — plan (gains `doc-structure-validator.sh` + `plan-research-required.sh` enforcement automatically, needs the split-* hooks re-keyed) or caretake (keeps split-* hooks as-is, needs the validator + research gates added)? Evidence favors plan context (both Stop/Write gates already armed there), but hero's SPLIT phase dispatch (`state-machine.md:76`) and the `caretake --auto`→triage`SPLIT` verdict flow both assume caretake.
3. **watch `--kind issue` dispatch**: hero classifies only `blocked:pr-*`/`blocked:upstream`; should the merge add a `blocked:*`-tier row for dependency-parked items, or is fan-out-only coverage for `--kind issue` acceptable? (Currently `WAIT-issue` items go to Human Needed precisely because no watcher owned them at design time — `outcome-tokens.md:18`.)
4. **`--mode prove` rehoming shape**: fold into research default intake (a claim is just a research question with a verdict-shaped answer, `intake-routing.md` already discriminates) vs. own surface. Nothing on the board produces claims; `hero/dispatch.md:10`'s claim-check option has no defined trigger — deleting that option outright is the evidence-consistent move.

## Files Affected

### Will Modify

- `ralph/skills/caretake/SKILL.md` — mode table, fan-out, loop routing, token quick-ref (#1603, #1604, #1605, #1607)
- `ralph/skills/caretake/modes/debug.md` — delete (#1603)
- `ralph/skills/caretake/modes/postmortem.md` — delete (#1603)
- `ralph/skills/caretake/modes/trends.md` — delete (#1603)
- `ralph/skills/caretake/modes/retro.md` — rename to `modes/reflect.md` (#1603)
- `ralph/skills/caretake/modes/watch-pr.md` — merge into `modes/watch.md` (#1604)
- `ralph/skills/caretake/modes/watch-upstream.md` — merge (#1604)
- `ralph/skills/caretake/modes/watch-blockers.md` — merge (#1604)
- `ralph/skills/caretake/modes/split.md` — consolidate (#1605)
- `ralph/skills/caretake/split-decomposition.md` — consolidate (#1605)
- `ralph/skills/caretake/outcome-tokens.md` — token sections (#1603, #1604, #1607)
- `ralph/skills/caretake/label-routing.md` — rows + fan-out; merge into shared taxonomy (#1603, #1607)
- `ralph/skills/caretake/modes/triage.md` — watcher-consumer prose (#1604)
- `ralph/skills/catch-up/SKILL.md` — mode rows + branches (#1603)
- `ralph/skills/catch-up/brief-composition.md` — inherit constraint list if dashboard-render.md is deleted (#1603)
- `ralph/skills/hero/SKILL.md` — classify fold + DISPATCH_ARG rows + watch-mode role text (#1604, #1606)
- `ralph/skills/hero/event-classes.md` — blocked:* rows, debug-auto rows; merge into shared taxonomy (#1603, #1604, #1607)
- `ralph/skills/hero/dispatch.md` — SPLIT row, classify notes, prove option (#1605, #1606, #1608)
- `ralph/skills/hero/state-machine.md` — SPLIT phase (#1605)
- `ralph/skills/hero/task-graph.md` — SPLIT tasks (#1605)
- `ralph/skills/hero/watch-dispatch.md` — debug dispatch rows (#1603)
- `ralph/skills/plan/SKILL.md` — epic mode consolidation (#1605)
- `ralph/skills/plan/decomposition.md` — merged decomposition shape (#1605)
- `ralph/skills/plan/plan-review.md` — "classify tick" idiom (#1606)
- `ralph/skills/form/SKILL.md` — Step 6b forwarding (#1605)
- `ralph/skills/research/SKILL.md` — prove rehoming (#1608)
- `ralph/skills/research/intake-routing.md` — prove rule (#1608)
- `ralph/skills/research/findings-format.md` — per-mode matrix (#1608)
- `ralph/skills/research/research-shapes.md` — prove reference (#1608)
- `ralph/skills/shared/loop-wrapper.md` — manifest rows + stale copy-framing (#1603, #1606, #1607)
- `ralph/skills/shared/auto-alias.md` — stale copy-framing (#1607)
- `ralph/hooks/scripts/plan-research-required.sh` — plan-of-plans carve-out (#1605)
- `ralph/hooks/scripts/postmortem-completeness.sh` — delete or retarget at reflect (#1603)
- `ralph/hooks/scripts/split-estimate-gate.sh` / `split-size-gate.sh` / `split-postcondition.sh` — re-key scope guards (#1605)
- `ralph/hooks/scripts/autopilot-director-postcheck.sh` — arming grep string (#1606)
- `ralph/hooks/scripts/__tests__/caretake-watch-blockers.test.sh` — "7 total" (#1603), full rewrite (#1604)
- `ralph/hooks/scripts/__tests__/hero-classify-audience.test.sh` — re-anchor (#1606)
- `ralph/hooks/scripts/__tests__/autopilot-auto-watcher.test.sh` — arming fixture (#1606)
- `ralph/hooks/scripts/__tests__/plan-research-required.test.sh` — carve-out cases (#1605)
- `ralph/hooks/scripts/__tests__/split-size-gate.test.sh` — env re-key fixtures (#1605)
- `ralph/agents/triage-agent.md` — delete (#1608)
- `ralph/skills/catch-up/next-action-ranking.md` — triage-agent dispatch rows (#1608)
- `ralph/CLAUDE.md` — loop/auto suitability matrix rows (all children)
- `CLAUDE.md` — agent roster + heading count, verb one-liners (#1603, #1606, #1608)
- `README.md` — verb one-liners (#1603)
- `scripts/check-doc-rosters.sh` — "16 Agents" heading anchor (#1608)

### Will Read (Dependencies)

- `ralph/hooks/scripts/hook-utils.sh` — shared allow/block/scope helpers all edited hooks source
- `ralph/hooks/scripts/doc-structure-validator.sh` — plan-of-plans discriminator precedent (#1605)
- `ralph/hooks/scripts/set-skill-env.sh` — RALPH_COMMAND propagation mechanics (#1605, #1606)
- `ralph/hooks/hooks.json` — plugin-level hooks (unchanged; verifies catch-up deletions are hook-free)
- `mcp-server/src/__tests__/skill-frontmatter.test.ts` — frontmatter contract the edited SKILL.md files must keep
- `mcp-server/src/lib/directions.ts` — `audiencePenalty` behavior the auto fold must preserve (#1606)
- `.github/workflows/ci.yml` — gate inventory
- `docs/superpowers/specs/2026-05-25-autopilot-never-terminate-adaptive-watcher-design.md` — arming-string design rationale (#1606)
