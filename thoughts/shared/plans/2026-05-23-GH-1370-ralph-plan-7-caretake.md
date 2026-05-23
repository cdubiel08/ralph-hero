---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, caretake, triage, hygiene, postmortem, retro, trends, unblock, debug, split, migration, plan-of-plans]
github_issue: 1370
github_issues: [1370]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1370
primary_issue: 1370
---

# Plan 7: `/ralph:caretake` — Caretaker Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: [[2026-05-23-GH-1357-ralph-plan-1-catch-up]] — scaffold + flat-sibling pattern
- builds_on:: [[2026-05-23-GH-1359-ralph-plan-2-form]] — multi-surface fold heuristics
- builds_on:: [[2026-05-23-GH-1362-ralph-plan-3-research]] — SKILL.md frontmatter `hooks:` pattern + slim-plugin hook scope fixes
- builds_on:: [[2026-05-23-GH-1364-ralph-plan-4-plan]] — multi-mode fold + path-discrimination hook pattern + no-mid-flow-env-mutation lesson
- builds_on:: [[2026-05-23-GH-1366-ralph-plan-5-impl]] — 9-hook ceiling + tool-input-shape mode-discrimination
- builds_on:: [[2026-05-23-GH-1368-ralph-plan-6-review]] — `closeout-` hook prefix convention + `__CLOSE__` (not `__DONE__`) + RALPH_COMMAND scope guard + `|| true` under pipefail

## Overview

The widest fold yet. Ten `ralph-hero` skills collapse into one `/ralph:caretake` verb with eight named modes plus a default event-driven dispatcher. This is the only verb in the migration that warrants a `modes/` subfolder layout — spec §Skill Layout line 148.

| Mode | Source | Role |
|---|---|---|
| (default) | `caretake` | Event-driven dispatcher: read `--issue NNN` labels, fan out via `Skill()` |
| `--mode triage [#NNN]` | `ralph-triage` | Pick oldest untriaged Backlog issue, assess validity, close duplicates, route |
| `--mode hygiene` | `ralph-hygiene` | Scan project for archive candidates, stale items, WIP violations, field gaps |
| `--mode unblock [#NNN]` | `unblock` + `ralph-unblock` | Interactive answer-and-route OR autonomous `## Unblock Request` post |
| `--mode postmortem` | `ralph-postmortem` | Generate structured post-mortem at end of team session — TaskList-driven |
| `--mode retro` | `retro` | Capture intra-session friction into research doc |
| `--mode trends [--since 30d]` | `trends` | Capture snapshot + render markdown trend report |
| `--mode debug [--since 24h]` | `ralph-debug-collate` | Collate Langfuse errors → file `debug-auto` issues |
| `--mode split [#NNN]` | `ralph-split` non-epic side | Split M/L/XL issues into XS/S atomic sub-issues |

The eight modes split into three execution shapes:

- **Board-scan modes** (`triage`, `hygiene`, `unblock`, `split`): mutate GitHub state; require hook gates for state transitions and side-effect verification.
- **Reflection modes** (`postmortem`, `retro`, `trends`): produce artifacts (markdown docs, snapshots, reports); mostly read-only against GitHub; minimal hook surface.
- **Diagnostic mode** (`debug`): wraps `ralph_hero__collate_debug` MCP tool; interactive confirm gate before mutating.

The reference shape diverges from prior plans: instead of flat siblings, the verb uses a `modes/` subfolder (one body per mode) plus a small set of cross-mode flat siblings for shared opinion content (terminal-verdict tokens, label-routing table).

## Current State Analysis

Ten source skills total **2,258 lines** of SKILL.md prose:

| Source | Lines | Shape |
|---|---|---|
| `plugin/ralph-hero/skills/caretake/SKILL.md` | 188 | Orchestrator: `--issue NNN` label-routed dispatch OR `--mode hygiene\|report\|trends` heartbeat OR no-args fan-out smoke check |
| `plugin/ralph-hero/skills/ralph-triage/SKILL.md` | 326 | Autonomous: pick oldest untriaged Backlog → assess (valid? duplicate? too large?) → close duplicates, decompose, or route to research |
| `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` | 142 | `project_hygiene` MCP call → optional `archive_items` when count > threshold; WIP violation detection via `RALPH_HYGIENE_WIP_LIMITS` JSON |
| `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` | 207 | `TaskList` + `TaskGet` for session data → classify blockers → write Obsidian-ready doc → patch plan with `post_mortem::` edges → auto-create blocker issues |
| `plugin/ralph-hero/skills/retro/SKILL.md` | 338 | Scan conversation context for friction signals → optional codebase cross-reference via sub-agents → write `/form`-ingestible research doc |
| `plugin/ralph-hero/skills/trends/SKILL.md` | 55 | `capture_snapshot` → `metrics_trends(format=markdown)` → print to stdout; read-only |
| `plugin/ralph-hero/skills/unblock/SKILL.md` | 195 | Interactive: read `## Unblock Request` → `AskUserQuestion` → post `## Unblock Resolution` → route issue back into pipeline |
| `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` | 254 | Autonomous: pick oldest Human Needed → compose `## Unblock Request` with 1-5 specific questions → STOP (does not transition state) |
| `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` | 202 | Wrap `ralph_hero__collate_debug` MCP tool: preflight → dry-run → confirm → file → summarize |
| `plugin/ralph-hero/skills/ralph-split/SKILL.md` | 351 | Pick M/L/XL parent → decompose via `decompose_feature` → create XS/S children → add sub-issue links → STOP |

Hooks to consider porting (under `plugin/ralph-hero/hooks/scripts/`):

| Hook | Trigger | Job | Port |
|---|---|---|---|
| `triage-state-gate.sh` | PostToolUse on `save_issue` | Validate triage workflow state transitions | yes |
| `triage-postcondition.sh` | Stop | Verify triage terminal verdict | yes |
| `unblock-state-gate.sh` | PostToolUse on `save_issue` | Validate interactive-unblock state transitions | yes |
| `unblock-request-postcondition.sh` | Stop | Verify autonomous-unblock posted a `## Unblock Request` comment | yes |
| `split-estimate-gate.sh` | PreToolUse + PostToolUse on `get_issue` | Block split on already-atomic (XS/S) issues — PostToolUse inspects estimate from response | yes |
| `split-postcondition.sh` | Stop | Verify split created ≥2 sub-issues | yes |
| `split-size-gate.sh` | PreToolUse on `create_issue` | Block sub-issue creation with non-XS/non-S estimate | yes |
| `split-verify-sub-issue.sh` | PostToolUse on `add_sub_issue` | Verify the linkage took effect on GitHub side | yes |
| `team-postmortem-completeness.sh` | Stop | Verify post-mortem doc has required sections | yes (rename to `postmortem-completeness.sh` — no team-skill semantics in slim plugin) |
| `branch-gate.sh` | PreToolUse on Bash | Block destructive git ops on non-main | already ported in Plan 3 |
| `merge-state-gate.sh` | PreToolUse on `save_issue` | Validate semantic-intent state mutations | already ported in Plan 6; reused by triage close-mode + unblock route-back paths per Plan 6 friction note |
| `lock-release-on-failure.sh` | Stop | Release workflow lock on failure | already ported in Plan 3 |

**Nine new hook ports + three reuses.** At the 9-hook ceiling Plan 5 established, but each hook is mode-scoped via `RALPH_SUBCOMMAND` (or skips when unset). The 9 ports include both `triage-` (2) and `split-` (4) groups that already use prefix-isolated scopes.

### Key Discoveries

- **`modes/` subfolder is justified by mode count alone.** Eight mode bodies × ~80-120 lines each ≈ 700-1000 lines of mode-specific content. Inlining into the SKILL.md body would push it past 800 lines; flat siblings without the subfolder would clutter the directory listing. Spec line 148-157 explicitly preauthorizes the layout for this verb.

- **The default mode is a thin dispatcher.** `caretake` source SKILL.md is 188 lines but ~140 of those are the label-routing table + heartbeat dispatch + result-line emission. The default-mode body collapses to ~40 lines in slim SKILL.md, with the routing table extracted into a flat sibling (`label-routing.md`) so future mode additions (or label changes) don't require a SKILL.md edit.

- **`unblock` and `ralph-unblock` follow Plan 5's interactive+autonomous pattern.** Both source skills operate on the same artifact (`## Unblock Request` comments on a Human Needed issue). One is human-facing (`AskUserQuestion`, posts `## Unblock Resolution`, transitions state); the other is autonomous (reads `## Escalation`, posts `## Unblock Request` with specific questions, STOPS without state transition). Fold both into `--mode unblock` with sub-mode discrimination via `--question` (autonomous) vs default (interactive) — mirrors Plan 5's `--mode auto` vs default split inside `/ralph:impl`.

- **`ralph-split` is the non-epic side already after Plan 4.** Plan 4 (`/ralph:plan --mode epic`) absorbed the epic-decomposition surface. The remaining surface is atomic-issue splitting (M/L/XL → multiple XS/S). The four `split-*` hooks all gate on `RALPH_COMMAND=split`; in slim plugin we keep that contract and additionally scope on `RALPH_SUBCOMMAND=split` so the SKILL.md frontmatter can declare all nine hooks at once and let each one self-no-op for non-matching modes.

- **`team-postmortem-completeness.sh` carries `team` semantics that no longer apply.** The source skill is `ralph-postmortem` (no team prefix), and the slim plugin has no team concept. Rename on port to `postmortem-completeness.sh` and drop the `team-` semantic-search references in the script body.

- **`trends` has no hooks in source.** It's read-only by design (capture snapshot + render report → stdout). The slim port preserves that: no `Stop` hook needed because no state transition happens.

- **`retro` produces a research doc, not a GitHub issue.** It writes `thoughts/shared/research/<date>-retro-<slug>.md` and stops. The doc is `/form`-ingestible so the user can later run `/ralph:form <path>` to convert promising friction items into issues. The retro mode does NOT call any state-mutating MCP tools — it's an artifact-writer.

- **`debug-collate` requires an interactive confirm gate.** The source skill body's Step 3 is "present grouped error signatures and prompt user before mutating." `--auto-confirm` is supported but defaults to off. Preserve verbatim in `modes/debug.md`.

- **Heartbeat fan-out (no-args caretake) collapses to a `--mode all` invocation.** Source caretake with no args fans out to `hygiene`, `report` (legacy), `trends`. In slim plugin, `report` is part of `/ralph:catch-up --mode report` (shipped in Plan 1). The fan-out becomes: `Skill("ralph:caretake --mode hygiene")` + `Skill("ralph:catch-up --mode report")` + `Skill("ralph:caretake --mode trends")`. Express the fan-out as `--mode all` (more discoverable than no-arg behavior) but keep no-arg as the same behavior for muscle-memory.

- **Label-routing table in default mode is the only place modes are coupled.** When `--issue NNN` is passed and the issue has `trigger:caretake` (full fanout) or `stale` / `status-update-needed` / `trends-check` / `needs-triage` / `human-needed` labels, the dispatcher picks the right mode. Extract this table into `label-routing.md` so the SKILL.md body stays ~20 lines and the routing rules are reusable by future iOS/cloud routines that classify events the same way.

- **Outcome tokens vary by mode.** Each mode emits a distinct terminal-verdict token for the harness extractor:
  - triage: `TRIAGED <verdict>` or `Queue empty.`
  - hygiene: `HYGIENE COMPLETE <N archived>` or `HYGIENE BLOCKED <reason>`
  - unblock (autonomous): `UNBLOCK REQUEST POSTED` or `Queue empty.`
  - unblock (interactive): `UNBLOCK RESOLVED` or `UNBLOCK ESCALATED`
  - postmortem: `POSTMORTEM <path>` or `POSTMORTEM SKIPPED <reason>`
  - retro: `RETRO <path>` or `RETRO SKIPPED <reason>`
  - trends: (read-only — no terminal token)
  - debug: `DEBUG FILED <N issues>` or `DEBUG SKIPPED <reason>`
  - split: `SPLIT <N children>` or `SPLIT SKIPPED <reason>`
  Extract into `outcome-tokens.md` so postcondition hooks have one source of truth.

## Desired End State

After Plan 7 merges:

1. `/ralph:caretake` is discoverable. With no args → fan-out smoke check (hygiene + catch-up report + trends).
2. `/ralph:caretake --issue NNN` → event-driven dispatch via label routing.
3. `/ralph:caretake --mode <name>` → single-mode invocation for each of the 8 modes.
4. Old `/ralph-hero:caretake`, `/ralph-hero:ralph-triage`, `/ralph-hero:ralph-hygiene`, `/ralph-hero:ralph-postmortem`, `/ralph-hero:retro`, `/ralph-hero:trends`, `/ralph-hero:unblock`, `/ralph-hero:ralph-unblock`, `/ralph-hero:ralph-debug-collate`, `/ralph-hero:ralph-split` remain functional. Sunset is Plan 10.
5. `ralph/skills/caretake/SKILL.md` ≤ 200 lines (top-level dispatcher only).
6. `ralph/skills/caretake/modes/` subfolder with 8 mode bodies.
7. Three flat-sibling references: `label-routing.md`, `outcome-tokens.md`, plus one mode-shared opinion file per natural cluster (TBD as phases land — likely `split-decomposition.md` since split is the heaviest hook-wise).
8. SKILL.md frontmatter `hooks:` block declares 9 mode-specific hooks scoped via `RALPH_COMMAND=caretake` (set once at SessionStart) and `RALPH_SUBCOMMAND=<mode>` (set at body entry per mode).
9. `ralph/README.md` migration table → Plan 7 shipped.
10. Friction-log entry appended to spec.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:caretake`.
- Eight real invocations: one per mode (`triage`, `hygiene`, `unblock` × 2 sub-modes, `postmortem`, `retro`, `trends`, `debug`, `split`).
- `wc -l ralph/skills/caretake/SKILL.md` ≤ 200.
- `ls ralph/skills/caretake/modes/` shows 8 files.
- Old `/ralph-hero:*` caretaker-family skills still work.

## What We're NOT Doing

- **Not** absorbing the epic-decomposition side of `ralph-split` — already in Plan 4 (`/ralph:plan --mode epic`).
- **Not** absorbing `report` (`/ralph-hero:report`) — already in Plan 1 (`/ralph:catch-up --mode report`).
- **Not** changing the `## Unblock Request` / `## Unblock Resolution` comment shapes. Plan 10 sunset relies on prose stability.
- **Not** changing the post-mortem doc structure (frontmatter + Section headings). Obsidian links + `post_mortem::` edges stay.
- **Not** changing `ralph_hero__collate_debug` MCP tool surface. The mode body wraps it as-is.
- **Not** changing the `decompose_feature` MCP tool surface used by split. The mode body calls it verbatim.
- **Not** changing the `RALPH_HYGIENE_*` env var contract (`THRESHOLD`, `DRY_RUN`, `WIP_LIMITS`).
- **Not** wiring `/ralph:caretake` → `/ralph:hero` orchestration. Orchestrator concern (Plan 8).
- **Not** sunsetting source skills.

## Implementation Approach

Nine XS-sized phases, mirroring Plan 6's phase shape (one phase per mode body + scaffold/hook + parity):

1. **Scaffold + hook ports** owns: `ralph/skills/caretake/SKILL.md` stub (frontmatter + mode-dispatch table + Step 0 arg parse), `ralph/skills/caretake/modes/` subfolder with eight empty mode-body stubs, three flat-sibling references (`label-routing.md`, `outcome-tokens.md`, `split-decomposition.md`), hook ports under `ralph/hooks/scripts/` for the nine new scripts.
2. **Default mode + label-routing.md** owns: SKILL.md default-mode body (label-routed dispatch + heartbeat fan-out), `label-routing.md` (full routing table extracted from source caretake).
3. **`--mode triage`** owns: `modes/triage.md` (full triage workflow), `outcome-tokens.md` triage section.
4. **`--mode hygiene`** owns: `modes/hygiene.md`, `outcome-tokens.md` hygiene section.
5. **`--mode unblock`** owns: `modes/unblock.md` (interactive + autonomous sub-modes), `outcome-tokens.md` unblock section.
6. **`--mode postmortem` + `--mode retro` + `--mode trends`** owns: `modes/postmortem.md`, `modes/retro.md`, `modes/trends.md`, `outcome-tokens.md` postmortem/retro sections (trends has no terminal token).
7. **`--mode debug`** owns: `modes/debug.md`, `outcome-tokens.md` debug section.
8. **`--mode split` + `split-decomposition.md`** owns: `modes/split.md`, full `split-decomposition.md` reference (size-gate + sub-issue verification + decomposition strategy).
9. **Parity validation + dogfooding** owns: `ralph/README.md`, spec friction-log entry, picker wiring (if any prior plan's picker references `ralph-hero:caretake` etc., retarget).

Each mode body is a single-owner phase. SKILL.md is touched in Phase 1 (scaffold) and Phase 2 (default-mode body fill); reference files split between Phases 2-8.

## Phase 1: Scaffold + hook ports

### Overview

Stand up directory + frontmatter + reference stubs + nine hook ports.

### Changes Required

#### 1. Skill scaffold

`ralph/skills/caretake/SKILL.md`:

- Description (covers all 8 modes + default-event dispatcher + natural-language trigger phrases — triage, hygiene cleanup, status check, post-mortem, retro, trends, unblock, debug errors, split issue).
- `argument-hint: "[--issue NNN | --mode <triage|hygiene|unblock|postmortem|retro|trends|debug|split|all>] [#NNN] [--since <window>] [--auto-confirm]"`
- `context: inline`, `model: opus`
- `allowed-tools` union covering all 8 modes (Read, Write, Edit, Glob, Grep, Bash, Skill, Agent, Task, TaskList, TaskGet, AskUserQuestion, PushNotification, plus the MCP tools used in any mode — `get_issue`, `list_issues`, `save_issue`, `create_issue`, `create_comment`, `add_sub_issue`, `add_dependency`, `list_sub_issues`, `pipeline_dashboard`, `project_hygiene`, `archive_items`, `capture_snapshot`, `metrics_trends`, `collate_debug`, `knowledge_record_outcome`, `knowledge_search`, `knowledge_recall`).
- `hooks:` block:
  - SessionStart → `set-skill-env.sh RALPH_COMMAND=caretake` (subcommand env var is set inside SKILL.md body per mode entry).
  - PreToolUse on Bash → `branch-gate.sh`
  - PreToolUse on `get_issue` → `split-estimate-gate.sh`
  - PreToolUse on `create_issue` → `split-size-gate.sh`
  - PostToolUse on `get_issue` → `split-estimate-gate.sh` (same script, PostToolUse path)
  - PostToolUse on `add_sub_issue` → `split-verify-sub-issue.sh`
  - PostToolUse on `save_issue` → `triage-state-gate.sh`, `unblock-state-gate.sh`, `merge-state-gate.sh`
  - Stop → `triage-postcondition.sh`, `unblock-request-postcondition.sh`, `split-postcondition.sh`, `postmortem-completeness.sh`, `lock-release-on-failure.sh`
- Body: mode-dispatch table + Step 0 (arg parse + `RALPH_SUBCOMMAND` set).

#### 2. Mode body stubs

`ralph/skills/caretake/modes/triage.md`, `hygiene.md`, `unblock.md`, `postmortem.md`, `retro.md`, `trends.md`, `debug.md`, `split.md` — each `_Filled by Phase N._`

#### 3. Reference stubs

- `label-routing.md`, `outcome-tokens.md`, `split-decomposition.md` — `_Filled by Phase N._`

#### 4. Hook ports

Copy from `plugin/ralph-hero/hooks/scripts/`:
- `triage-state-gate.sh`, `triage-postcondition.sh`
- `unblock-state-gate.sh`, `unblock-request-postcondition.sh`
- `split-estimate-gate.sh`, `split-postcondition.sh`, `split-size-gate.sh`, `split-verify-sub-issue.sh`
- `team-postmortem-completeness.sh` → rename to `postmortem-completeness.sh` (drop `team-` semantics in port)

Apply Plan 6's hook hardening checklist to each port:
1. RALPH_COMMAND scope guard (no-op when `RALPH_COMMAND != caretake` AND `RALPH_COMMAND` doesn't match the legacy command name like `triage`/`split` — accept both during parallel period).
2. RALPH_SUBCOMMAND scope check inside the script (e.g., `triage-state-gate.sh` no-ops unless `RALPH_SUBCOMMAND=triage` OR legacy `RALPH_COMMAND=triage`).
3. `is_semantic_intent` passthrough on every state-gate script (mirror `ralph/hooks/scripts/impl-state-gate.sh`).
4. Pipeline-heavy intermediates (any `grep | sed | awk` chain) append `|| true` under `set -euo pipefail`.
5. PreToolUse vs PostToolUse discrimination via `.hook_event_name` (`split-estimate-gate.sh` already does this in source; preserve).

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/caretake/SKILL.md`
- [ ] `[ "$(wc -l < ralph/skills/caretake/SKILL.md)" -le 200 ]`
- [ ] All 8 mode-body stubs present under `ralph/skills/caretake/modes/`.
- [ ] All 3 flat-sibling reference stubs present.
- [ ] All 9 new hooks present + executable.
- [ ] Each hook script contains a `RALPH_COMMAND` scope guard (grep for `RALPH_COMMAND` in each ported `.sh`).
- [ ] Each state-gate hook contains `is_semantic_intent` (grep `is_semantic_intent` returns 4 matches: triage-state-gate, unblock-state-gate, plus the two already present in impl-state-gate / merge-state-gate).

#### Manual Verification

- [ ] `/reload-plugins` discovers `/ralph:caretake --help` (or argument-hint).

---

## Phase 2: Default mode + `label-routing.md`

### Overview

Default-mode body (label-routed dispatch + heartbeat fan-out) + full `label-routing.md` reference.

### Changes Required

#### 1. SKILL.md default-mode body

Compact list (≤25 lines):

1. **Parse `$ARGUMENTS`** — if `--issue NNN`, set `RALPH_SUBCOMMAND=default-event`; if `--mode <name>`, set `RALPH_SUBCOMMAND=<name>` and dispatch to `modes/<name>.md`; if no args, set `RALPH_SUBCOMMAND=all` and fan out.
2. **Event-driven dispatch** — `get_issue(NNN)`, inspect labels, dispatch per `label-routing.md` table.
3. **Heartbeat fan-out (`--mode all` or no args)** — invoke three skills serially: `Skill("ralph:caretake", args="--mode hygiene")`, `Skill("ralph:catch-up", args="--mode report")`, `Skill("ralph:caretake", args="--mode trends")`. Report consolidated outcome.
4. **Post-dispatch comment** — for `--issue NNN`, post `## Caretaker Action` comment on the issue (mode + dispatched skill + outcome line).
5. **Emit result line** — `result: <outcome>` for harness extraction.

#### 2. `label-routing.md`

Extract from source caretake's Step 1 dispatch table. Single table:

```
| Label present | Dispatch |
|---------------|----------|
| `trigger:caretake` | Full fan-out (all 8 modes serially) |
| `stale` | `Skill("ralph:caretake", args="--mode hygiene")` |
| `status-update-needed` | `Skill("ralph:catch-up", args="--mode report")` |
| `trends-check` | `Skill("ralph:caretake", args="--mode trends")` |
| `needs-triage` | `Skill("ralph:caretake", args="--mode triage #NNN")` |
| `human-needed` | `Skill("ralph:caretake", args="--mode unblock --question #NNN")` |
| `process-improvement` | `Skill("ralph:caretake", args="--mode retro")` (dispatches manual retro flow with the issue as scope hint) |
| `debug-auto` | `Skill("ralph:caretake", args="--mode debug")` |
| (none / default) | `Skill("ralph:caretake", args="--mode triage #NNN")` |
```

Plus prose on label consumption (remove `trigger:caretake` after dispatch via `save_issue(labels: [...remaining])`).

### Success Criteria

#### Automated Verification

- [ ] `[ "$(wc -l < ralph/skills/caretake/SKILL.md)" -le 200 ]`
- [ ] `label-routing.md` non-stub: `[ "$(wc -l < ralph/skills/caretake/label-routing.md)" -ge 40 ]`

#### Manual Verification

- [ ] `/ralph:caretake --issue NNN` against a `human-needed`-labeled issue → dispatches to `--mode unblock`.
- [ ] `/ralph:caretake` (no args) → fans out to hygiene + catch-up report + trends.

---

## Phase 3: `--mode triage`

### Overview

Triage mode body — port `ralph-triage` Steps 1-7 verbatim into `modes/triage.md`.

### Changes Required

#### 1. `modes/triage.md`

Source: `plugin/ralph-hero/skills/ralph-triage/SKILL.md` Steps 1-7. Port verbatim with two adjustments:

- Replace any `Skill("ralph-hero:research")` / `Skill("ralph-hero:plan")` etc. with `Skill("ralph:research")` / `Skill("ralph:plan")`.
- Insert `RALPH_SUBCOMMAND=triage` set as the first line of the mode body (Bash export) — picked up by `triage-state-gate.sh` for scope discrimination.

Preserve verbatim:
- Step 1: pick oldest untriaged Backlog (no `triaged` label).
- Step 2: assess validity (clear ask? actionable? scoped?).
- Step 3: duplicate detection via `list_issues` + `knowledge_search`.
- Step 4: size check (XS/S → route to research; M/L/XL → split candidate).
- Step 5: route to next state via `save_issue(workflowState=...)`.
- Step 6: emit `TRIAGED <verdict>` or `Queue empty.` terminal token.

#### 2. `outcome-tokens.md` — triage section

```
## Triage terminal tokens

- `TRIAGED valid` — issue moved to `Research Needed` or `Ready for Plan`.
- `TRIAGED duplicate` — closed as duplicate; references `## Duplicate Of` comment.
- `TRIAGED canceled` — closed `not_planned`.
- `TRIAGED needs-split` — moved to `Backlog` with `needs-split` label; `--mode split` queue picks it up.
- `Queue empty.` — no untriaged Backlog issues.
```

`triage-postcondition.sh` greps the transcript for these tokens.

### Success Criteria

#### Automated Verification

- [ ] `modes/triage.md` ≥ 80 lines.
- [ ] First non-comment line of `modes/triage.md` body sets `RALPH_SUBCOMMAND=triage`.
- [ ] `outcome-tokens.md` references `TRIAGED` token.

#### Manual Verification

- [ ] `/ralph:caretake --mode triage` against a real Backlog with at least one untriaged issue → emits `TRIAGED <verdict>` or routes to research.

---

## Phase 4: `--mode hygiene`

### Overview

Hygiene mode body — port `ralph-hygiene` verbatim.

### Changes Required

#### 1. `modes/hygiene.md`

Source: `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md`. Port verbatim. Hygiene has no source hooks beyond `set-skill-env.sh`; the mode body only calls `project_hygiene` and optionally `archive_items`. No state transitions.

Insert `RALPH_SUBCOMMAND=hygiene` at body entry (consistency with other modes; no hook depends on it but the convention is set).

Preserve verbatim:
- Config resolution (threshold, dry-run, WIP limits).
- Step 1: `project_hygiene(format=markdown)`.
- Step 2: parse output; if archive candidates > threshold, optionally `archive_items` (gated by `dry_run` env var).
- Step 3: emit `HYGIENE COMPLETE <N archived>` or `HYGIENE BLOCKED <reason>`.

#### 2. `outcome-tokens.md` — hygiene section

Append:

```
## Hygiene terminal tokens

- `HYGIENE COMPLETE <N archived>` — scan ran; N items archived (0 if dry-run or no candidates).
- `HYGIENE BLOCKED <reason>` — scan failed (project not found, MCP error, etc.).
```

### Success Criteria

#### Automated Verification

- [ ] `modes/hygiene.md` ≥ 60 lines.
- [ ] `outcome-tokens.md` references `HYGIENE COMPLETE` and `HYGIENE BLOCKED`.

#### Manual Verification

- [ ] `/ralph:caretake --mode hygiene` against a real project → emits `HYGIENE COMPLETE N`.

---

## Phase 5: `--mode unblock` (interactive + autonomous)

### Overview

Unblock mode body — fold both source skills via sub-mode discrimination.

### Changes Required

#### 1. `modes/unblock.md`

Two execution paths inside one mode body:

- **Default (interactive)** — port `unblock/SKILL.md`. Read `## Unblock Request` comment, present questions via `AskUserQuestion`, post `## Unblock Resolution`, transition issue back into pipeline. Emit `UNBLOCK RESOLVED` or `UNBLOCK ESCALATED`.
- **`--question` (autonomous request)** — port `ralph-unblock/SKILL.md`. Pick oldest Human Needed issue, compose 1-5 specific blocking questions, post `## Unblock Request` comment, STOP (no state transition). Emit `UNBLOCK REQUEST POSTED` or `Queue empty.`.

Sub-mode discrimination in body entry:

```bash
if echo "$ARGUMENTS" | grep -q -- '--question'; then
  export RALPH_SUBCOMMAND_VARIANT=autonomous
else
  export RALPH_SUBCOMMAND_VARIANT=interactive
fi
```

`unblock-state-gate.sh` only fires on the interactive path (state transitions happen there). `unblock-request-postcondition.sh` only fires on the autonomous path (verifies the `## Unblock Request` comment was posted). Each hook gates on `RALPH_SUBCOMMAND_VARIANT`.

#### 2. `outcome-tokens.md` — unblock section

```
## Unblock terminal tokens

- `UNBLOCK RESOLVED` — interactive answer flow completed; issue routed back to pipeline.
- `UNBLOCK ESCALATED` — interactive flow failed; issue stays Human Needed.
- `UNBLOCK REQUEST POSTED` — autonomous request flow completed; `## Unblock Request` comment posted.
- `Queue empty.` — no Human Needed issues (autonomous path only).
```

### Success Criteria

#### Automated Verification

- [ ] `modes/unblock.md` ≥ 100 lines.
- [ ] Mode body references both `--question` (autonomous) and default (interactive) sub-modes.
- [ ] `outcome-tokens.md` references all four unblock tokens.

#### Manual Verification

- [ ] `/ralph:caretake --mode unblock #NNN` against an issue with an open `## Unblock Request` → interactive AskUserQuestion → posts `## Unblock Resolution` → issue moves out of Human Needed.
- [ ] `/ralph:caretake --mode unblock --question` against a board with a Human Needed issue → posts `## Unblock Request` with 1-5 questions; issue stays Human Needed.

---

## Phase 6: `--mode postmortem` + `--mode retro` + `--mode trends`

### Overview

Three reflection-mode bodies in one phase (they share no opinion content but are each short).

### Changes Required

#### 1. `modes/postmortem.md`

Source: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`. Port verbatim. Set `RALPH_SUBCOMMAND=postmortem` at entry — `postmortem-completeness.sh` gates on it.

Preserve verbatim:
- Step 1: `TaskList` + `TaskGet` for session data.
- Step 2: classify blockers and impediments.
- Step 3: write Obsidian-ready doc to `thoughts/shared/research/postmortems/<date>-<slug>.md`.
- Step 4: patch plan document with `post_mortem::` edges (if `--plan-doc <path>` provided).
- Step 5: auto-create GitHub issues for blockers (`process-improvement` label).
- Step 6: emit `POSTMORTEM <path>` or `POSTMORTEM SKIPPED <reason>`.

#### 2. `modes/retro.md`

Source: `plugin/ralph-hero/skills/retro/SKILL.md`. Port verbatim. No hooks gate retro mode — it's an artifact-writer with no state mutations.

Preserve verbatim:
- Step 1: scan conversation context for friction signals.
- Step 2: optional sub-agent cross-reference (`Agent` dispatch).
- Step 3: synthesize into `/form`-ingestible research doc.
- Step 4: write to `thoughts/shared/research/<date>-retro-<slug>.md`.
- Step 5: emit `RETRO <path>` or `RETRO SKIPPED <reason>`.

#### 3. `modes/trends.md`

Source: `plugin/ralph-hero/skills/trends/SKILL.md`. Port verbatim. Read-only — no terminal token.

Preserve verbatim:
- Step 1: parse `--since` flag (default `@today-7d`).
- Step 2: `capture_snapshot` (no args).
- Step 3: `metrics_trends(format=markdown, since=<value>)`.
- Step 4: print markdown to stdout.

#### 4. `outcome-tokens.md` — postmortem + retro sections

```
## Postmortem terminal tokens

- `POSTMORTEM <path>` — doc written, path absolute.
- `POSTMORTEM SKIPPED <reason>` — no session data or insufficient signal.

## Retro terminal tokens

- `RETRO <path>` — doc written, path absolute.
- `RETRO SKIPPED <reason>` — no friction signals or scope unclear.

## Trends

Read-only — no terminal token (output is the markdown report itself).
```

### Success Criteria

#### Automated Verification

- [ ] `modes/postmortem.md` ≥ 80 lines.
- [ ] `modes/retro.md` ≥ 100 lines.
- [ ] `modes/trends.md` ≥ 30 lines.
- [ ] `outcome-tokens.md` references `POSTMORTEM`, `RETRO`, and explicit `Trends` no-token note.

#### Manual Verification

- [ ] `/ralph:caretake --mode postmortem` at end of a session with TaskList data → writes post-mortem doc, emits `POSTMORTEM <path>`.
- [ ] `/ralph:caretake --mode retro` after a session with friction signals → writes retro doc, emits `RETRO <path>`.
- [ ] `/ralph:caretake --mode trends --since 30d` → prints markdown trend report to stdout.

---

## Phase 7: `--mode debug`

### Overview

Debug mode body — wrap `ralph_hero__collate_debug` MCP tool.

### Changes Required

#### 1. `modes/debug.md`

Source: `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md`. Port verbatim. Interactive confirm gate is load-bearing — `--auto-confirm` is opt-in.

Preserve verbatim:
- Step 1: preflight (verify Langfuse OTEL env vars set, MCP server reachable).
- Step 2: dry-run (`collate_debug(dry_run=true)`).
- Step 3: present grouped error signatures + occurrence counts.
- Step 4: `AskUserQuestion` confirm (unless `--auto-confirm`).
- Step 5: on confirm, `collate_debug(dry_run=false)` — files `debug-auto` issues OR comments on existing ones.
- Step 6: summarize: `DEBUG FILED <N issues>` or `DEBUG SKIPPED <reason>`.

#### 2. `outcome-tokens.md` — debug section

```
## Debug terminal tokens

- `DEBUG FILED <N issues>` — N issues filed or commented on.
- `DEBUG SKIPPED <reason>` — preflight failed, user declined, or no errors above threshold.
```

### Success Criteria

#### Automated Verification

- [ ] `modes/debug.md` ≥ 80 lines.
- [ ] Mode body references `--auto-confirm`, `dry_run`, `AskUserQuestion`.
- [ ] `outcome-tokens.md` references `DEBUG FILED` and `DEBUG SKIPPED`.

#### Manual Verification

- [ ] `/ralph:caretake --mode debug --since 24h` against a local Langfuse with errors → dry-runs, prompts confirm, files issues on confirm, emits `DEBUG FILED N`.

---

## Phase 8: `--mode split` + `split-decomposition.md`

### Overview

Split mode body + full decomposition reference. Heaviest hook surface (4 split-* hooks) of any mode.

### Changes Required

#### 1. `modes/split.md`

Source: `plugin/ralph-hero/skills/ralph-split/SKILL.md`. Port verbatim with two adjustments:

- Remove epic-decomposition surface (already in Plan 4 `/ralph:plan --mode epic`). The non-epic side is atomic M/L/XL → multiple XS/S sub-issues.
- Set `RALPH_SUBCOMMAND=split` at entry — all 4 `split-*` hooks gate on it (in addition to the legacy `RALPH_COMMAND=split` env var ported from source).

Preserve verbatim:
- Step 1: pick target issue (`#NNN` or oldest `needs-split`-labeled).
- Step 2: estimate gate — `split-estimate-gate.sh` blocks if XS/S (PreToolUse on `get_issue` surfaces reminder; PostToolUse on `get_issue` parses response and blocks with exit 2 if estimate is too small).
- Step 3: read body + acceptance criteria.
- Step 4: decompose via `decompose_feature` MCP tool OR manual breakdown per `split-decomposition.md` strategy.
- Step 5: create XS/S children via `create_issue` (size-gate hook enforces estimate).
- Step 6: link via `add_sub_issue` (verify-sub-issue hook checks linkage took).
- Step 7: optional `add_dependency` between children for sequencing.
- Step 8: transition parent to `Backlog` (post-decomposition state).
- Step 9: emit `SPLIT <N children>` or `SPLIT SKIPPED <reason>`.

#### 2. `split-decomposition.md`

Full decomposition strategy reference. Sections:

- §When to split: M/L/XL estimate + clear sub-deliverables.
- §Decomposition heuristics: by file ownership, by acceptance criterion, by execution phase.
- §Sub-issue sizing: XS = 1-2 files, S = 3-5 files.
- §Dependency wiring: linear chain for execution order; fan-out for parallel-safe.
- §Hook contracts: estimate-gate (XS/S only), size-gate (sub-issue creation), verify-sub-issue (linkage), postcondition (≥2 children).

#### 3. `outcome-tokens.md` — split section

```
## Split terminal tokens

- `SPLIT <N children>` — N (≥2) XS/S sub-issues created and linked.
- `SPLIT SKIPPED <reason>` — parent too small (XS/S), already split, or decomposition failed.
```

### Success Criteria

#### Automated Verification

- [ ] `modes/split.md` ≥ 100 lines.
- [ ] `split-decomposition.md` ≥ 80 lines.
- [ ] Mode body references all 4 split hooks.
- [ ] `outcome-tokens.md` references `SPLIT` and `SPLIT SKIPPED`.

#### Manual Verification

- [ ] `/ralph:caretake --mode split #NNN` against a real M-estimated issue → creates ≥2 XS/S children, emits `SPLIT N`.
- [ ] `/ralph:caretake --mode split #NNN` against an XS issue → blocked by estimate-gate hook with exit 2; mode body never reaches `create_issue`.

---

## Phase 9: Parity validation + dogfooding setup

### Overview

README + friction-log + 8-session parity validation.

### Changes Required

#### 1. README

`ralph/README.md`:

- `| 7 | \`/ralph:caretake\` | shipped |`
- `## Status` paragraph updated.

#### 2. Friction-log on the spec

Append `### Plan 7: /ralph:caretake (shipped YYYY-MM-DD)` subsection to `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`. Capture:

- Hot-path stats (10 sources, 8 modes + default, 9+3 hooks, modes/ subfolder).
- Design calls: modes/ subfolder layout justification, RALPH_SUBCOMMAND scope pattern, sub-mode discrimination inside `--mode unblock`, hook prefix conventions (`triage-` / `unblock-` / `split-` / `postmortem-` / `caretake-`).
- Active-use checkboxes for each of the 8 modes.

#### 3. Picker wiring

Search prior shipped slim-plugin skills for any picker that dispatches `Skill("ralph-hero:caretake")` / `ralph-triage` / `ralph-hygiene` etc., and retarget to `Skill("ralph:caretake")` with the right `--mode`. Likely candidates (sweep, don't pre-declare): `ralph/skills/catch-up/SKILL.md` (next-action picker), `ralph/skills/form/SKILL.md` (Step 6 picker), `ralph/skills/plan/SKILL.md` (Step 6 picker), `ralph/skills/research/SKILL.md` (post-research picker).

### Success Criteria

#### Automated Verification

- [ ] README shows Plan 7 shipped.
- [ ] Friction-log section exists.
- [ ] No remaining references to `ralph-hero:caretake` / `ralph-hero:ralph-triage` / `ralph-hero:ralph-hygiene` etc. in `ralph/skills/*/SKILL.md` (allow references in prose marked as "until Plan 10 sunset").

#### Manual Verification

- [ ] Eight sessions completed successfully (one per mode).
- [ ] Default-mode label-routing dispatch works against a real `--issue NNN` with one of the recognized labels.
- [ ] No regressions in any `ralph-hero:*` caretaker-family skill.

---

## Testing Strategy

### Unit Tests

None — markdown workflow. MCP tools covered by ralph-hero MCP server's existing tests. Hooks are bash scripts; coverage continues via the existing hook-gate snapshot tests (Plan 3 pattern).

### Integration Tests

The 8 parity sessions in Phase 9 are the integration test. The autonomous-unblock + split modes exercise the heaviest hook surface; the postmortem mode exercises TaskList integration; the debug mode exercises Langfuse MCP integration.

### Manual Testing Steps

Per Phase 9's list, plus per-hook smoke tests:

1. Verify `triage-state-gate.sh` blocks invalid state transitions (e.g., direct Backlog → Done).
2. Verify `triage-postcondition.sh` accepts all five terminal tokens.
3. Verify `unblock-state-gate.sh` blocks autonomous path from transitioning state (it MUST stay Human Needed).
4. Verify `unblock-request-postcondition.sh` accepts `## Unblock Request` posted via `create_comment`.
5. Verify `split-estimate-gate.sh` (PreToolUse) surfaces an M/L/XL reminder for already-XS/S parents.
6. Verify `split-estimate-gate.sh` (PostToolUse) blocks with exit 2 after `get_issue` returns XS estimate.
7. Verify `split-size-gate.sh` blocks `create_issue` with estimate=M (sub-issues must be XS/S).
8. Verify `split-verify-sub-issue.sh` accepts a successful `add_sub_issue` linkage; flags missing parent link.
9. Verify `split-postcondition.sh` fails Stop when fewer than 2 children created.
10. Verify `postmortem-completeness.sh` accepts a doc with all required frontmatter + section headings; flags missing sections.
11. Verify default-mode label-routing for each of the 9 routing entries (8 labels + default).
12. Verify heartbeat fan-out (`--mode all` or no-arg) executes all three child skills serially and reports outcomes.

## Performance Considerations

- Default mode: 1 issue fetch + 1 label-inspect + 1 child skill dispatch + 1 `create_comment`. Fast path.
- Heartbeat fan-out: 3 serial child-skill dispatches. Slowest mode — bounded by trends + hygiene + report individual budgets.
- triage: 1 list_issues + 1 get_issue + 0-N knowledge_search + 1 save_issue. Sub-1-second when no duplicates.
- hygiene: 1 project_hygiene + optional N archive_items. ~10 seconds for typical project.
- unblock (interactive): 1 get_issue + 1 AskUserQuestion + 1 create_comment + 1 save_issue. User-paced.
- unblock (autonomous): 1 list_issues + 1 get_issue + 1 create_comment. Sub-2-second.
- postmortem: TaskList + N × TaskGet + 1 Write + 1 Edit (plan patch) + N × create_issue. Scales with task count.
- retro: 1 Read (conversation) + N Agent dispatches + 1 Write. ~30-60 seconds.
- trends: 1 capture_snapshot + 1 metrics_trends. Sub-2-second.
- debug: 1 dry-run collate_debug + AskUserQuestion + 1 collate_debug. User-paced.
- split: 1 get_issue + 1 decompose_feature (or Agent) + N create_issue + N add_sub_issue. Scales with child count.

## Migration Notes

- Source skills remain functional alongside the new verb until Plan 10 batches sunsets.
- Plan 8 (`/ralph:hero`) is the orchestrator that auto-dispatches `/ralph:caretake --mode <name>` based on Director event class. Plan 7 preserves the `--issue NNN` and `--mode <name>` arg surface so the orchestrator's existing dispatch pattern keeps working.
- `process-improvement` issues (auto-created by `--mode postmortem`) continue to feed Director's autopilot loop — same label, same routing.
- `debug-auto` issues (auto-created by `--mode debug`) continue to feed Director's watcher event class — same label, same routing.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 7 at line ~339, `modes/` subfolder layout at line 148).
- Plan 6: `thoughts/shared/plans/2026-05-23-GH-1368-ralph-plan-6-review.md` (`closeout-` hook prefix convention, `__CLOSE__` token, hook hardening checklist).
- Plan 5: `thoughts/shared/plans/2026-05-23-GH-1366-ralph-plan-5-impl.md` (9-hook ceiling, interactive+autonomous fold pattern for `unblock`).
- Plan 4: `thoughts/shared/plans/2026-05-23-GH-1364-ralph-plan-4-plan.md` (multi-mode fold, no-mid-flow-env-mutation lesson).
- Source skills:
  - `plugin/ralph-hero/skills/caretake/SKILL.md` (188)
  - `plugin/ralph-hero/skills/ralph-triage/SKILL.md` (326)
  - `plugin/ralph-hero/skills/ralph-hygiene/SKILL.md` (142)
  - `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` (207)
  - `plugin/ralph-hero/skills/retro/SKILL.md` (338)
  - `plugin/ralph-hero/skills/trends/SKILL.md` (55)
  - `plugin/ralph-hero/skills/unblock/SKILL.md` (195)
  - `plugin/ralph-hero/skills/ralph-unblock/SKILL.md` (254)
  - `plugin/ralph-hero/skills/ralph-debug-collate/SKILL.md` (202)
  - `plugin/ralph-hero/skills/ralph-split/SKILL.md` (351)
- Source hook scripts under `plugin/ralph-hero/hooks/scripts/`: `triage-state-gate.sh`, `triage-postcondition.sh`, `unblock-state-gate.sh`, `unblock-request-postcondition.sh`, `split-estimate-gate.sh`, `split-postcondition.sh`, `split-size-gate.sh`, `split-verify-sub-issue.sh`, `team-postmortem-completeness.sh` (renamed on port).
- ralph plugin state at Plan 7 start: `ralph/skills/{catch-up,form,research,plan,impl,review}/` (6 verbs shipped through Plan 6).
