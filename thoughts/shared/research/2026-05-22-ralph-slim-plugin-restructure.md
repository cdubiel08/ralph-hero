---
date: 2026-05-22
github_issue: TBD
status: design-approved
type: research
tags: [ralph, plugin-restructure, skills, references, migration, plan-of-plans]
---

# Ralph Slim Plugin Restructure: From 52 Skills to 9 Verbs

## Executive Summary

`ralph-hero` has grown to **52 skills, ~28k lines of plugin markdown, 18 active worktrees**, three overlapping orchestrators (`hero`, `team`, `autopilot`/`director`), and a documented dead code path (`RemoteTrigger` producer). Each skill invocation re-tokenizes a large prelude. The chain-prompting pattern that made sense early now duplicates work the harness (Claude Code, MCP server, hooks) already does.

This document specifies a parallel-plugin restructure: a new plugin **`ralph`** (no `-hero` suffix) sitting at `ralph-hero/ralph/`, with **9 fat skills**, opinion content moved to flat reference siblings, and enforcement moved to hooks + MCP. Migration ships across **11 independent plans** over ~2-3 months with no period where the system is broken — the old plugin keeps working until each verb has been dogfooded for two weeks.

Expected outcomes: ~80% reduction in user-visible skill surface, ~3-4k lines of enforcement prose absorbed into hooks, dramatically lower per-invocation token cost, and a fast-track ladder for trivial fixes (typos, doc changes, repro-ready bugs) that skips the full research→plan→review→impl pipeline.

## Motivation

Three converging pressures:

1. **Token cost is mostly self-inflicted.** Each phase agent re-loads massive context. SessionStart hooks fire per-invocation. Subagents receive raw artifacts instead of digests. The orchestrator-then-team-then-skill chain loads two full contexts before any work happens.
2. **Most issues don't need the full pipeline.** Triage→research→plan→review→impl→review is correct for novel/complex work and overkill for typos. The fast-track gap is the user's chief operational complaint.
3. **Claude Code has matured.** Skills, hooks, MCP, worktrees, subagents — the harness now provides what custom orchestrator skills used to need to simulate. Continuing to write orchestration in markdown is paying tax twice.

The substrate (GitHub Projects V2 + ralph-knowledge + memory tiers) is the actual differentiator. The engineering pipeline is one consumer of the substrate, not the headline. Design choices that strengthen the substrate beat choices that polish the pipeline.

## Guiding Principles

**P1. Claude Code is the harness.** Don't reimplement what Claude Code, MCP, or hooks already give you. Orchestration belongs to hooks and scheduled triggers — not to a dispatcher skill written in markdown.

**P2. `SKILL.md` = workflow + gates. Reference siblings = opinions + situational guidance.** A skill body should be readable in ~150 lines. If it's longer, the depth belongs in a reference. The skill says *what to do and in what order*; references say *how to do the hard cases*.

**P3. One verb per user-facing intent.** Verbs are what the human types. Internal `Skill()` calls are not user surface and don't get slash commands. (Today: 52 commands; most are infrastructure, not intent.)

**P4. Determinism by labels, intelligence at the edges.** Triage labels carry static intent. Runtime classification is the fallback when a label is missing. Make state visible in the issue — don't recompute it on every dispatch.

**P5. References are content, not control flow.** A reference is a markdown doc the skill *consults*. No nested `Skill()` dispatch into references. No "reference invokes another reference." Flat content, one level.

**P6. Hooks own enforcement.** State transitions, file-ownership rules, worktree isolation, plan-compliance checks live in `hooks/`. Skills assume the hook is correct. If a rule is being enforced in skill prose, move it to a hook.

**P7. MCP tools are the artifact surface.** Issues, plans, research docs, status all live in GitHub Projects via MCP. Skills don't shadow that state on the filesystem. (The `thoughts/` corpus is fine — that's knowledge, not project artifacts.)

**P8. Delete on sight.** Unused skill → delete. Dead code path (`RemoteTrigger` producer) → delete. Stale code shipping in a plugin implies a feature that doesn't work, which is worse than a missing feature.

**P9. YAGNI on phase distinctions.** A trivial fix doesn't need research→plan→review→impl→review. The ladder is data (a table in a reference), not architecture.

**P10. The substrate is the product.** Memory tiers, ralph-knowledge graph, Projects-as-source-of-truth — these are the differentiator. Engineering-pipeline polish does not.

## Skill Taxonomy

New plugin: **`ralph`** (no `-hero` suffix), at `ralph-hero/ralph/`. **9 user-facing verbs.**

### Lifecycle verbs (5)

| Verb | Absorbs | Role |
|---|---|---|
| `/ralph:hero` | hero, team, autopilot, director, pr-drain, watch | Autonomous orchestrator. Reads `next_actions`, applies the hybrid label/classify ladder, dispatches via `Skill()`. The only autonomous entrypoint. |
| `/ralph:research` | research, ralph-research, prove-claim | Investigate an issue or claim. `--auto` flag for non-interactive. `prove-claim` becomes `--mode prove`. |
| `/ralph:plan` | plan, ralph-plan, ralph-plan-epic, iterate, ralph-review, epic side of ralph-split | Create / iterate / critique plans. Epic decomposition is a reference-driven mode. `--auto` flag. |
| `/ralph:impl` | impl, ralph-impl, ralph-pr | Execute phases in a worktree, ending with PR creation. `--auto` flag. |
| `/ralph:review` | ralph-code-review, ralph-val, ralph-merge, finish | Validate against plan, run code review, gate the merge. Today's `finish` flow. |

### Horizontal verbs (4)

| Verb | Absorbs | Role |
|---|---|---|
| `/ralph:caretake` | caretake, ralph-triage, ralph-hygiene, ralph-postmortem, retro, trends, unblock, ralph-unblock, ralph-debug-collate, non-epic side of ralph-split | All board maintenance + grooming + reflection. `--mode {hygiene,triage,postmortem,retro,trends,unblock,split}`. |
| `/ralph:catch-up` | hello, catch-up, status, report, cos | Orientation. "What's going on, what changed, what's next." |
| `/ralph:form` | draft, form | Idea/research → structured issue. |
| `/ralph:setup` | setup, setup-cli, setup-repos | One-time bootstrap. |

### Internal-only (Skill()-callable, not user-facing slash commands)

- `bridge-artifact` (superpowers integration glue — stays internal)
- Any helper that the verbs invoke via `Skill()` but the human shouldn't type directly

### Deleted outright

- `team` (already deprecated in current plugin)
- `delegate-test` (smoke test → becomes a bash script in `scripts/`, not a skill)
- `RemoteTrigger` producer wire + `scripts/monitoring-bridge/subscribe.py` (empirically inert as of 2026-05-22)
- All `ralph-X` / `X` duplicate pairs (collapsed by `--auto` flag on each verb)
- `idea-hunt` (removed from `ralph`; whether to revive as its own plugin is a separate decision)

### Stays in sibling plugins (unchanged during this migration)

- `ralph-playwright` (scouts, a11y, story-runner) — already its own plugin
- `ralph-knowledge` — already its own plugin
- `ralph-demo`, `record-demo` — separate plugin
- `design-system-audit`, `gdrive-{push,pull}` — usage-audit decision, separate from this migration

### Math

- Before: 52 skills in `plugin/ralph-hero/`
- After: 9 verbs + small internal-only helper set in `ralph/`
- Reduction: ~80% surface, with no loss of capability (capabilities move into references)

### Open naming question (deferred to Plan 8)

`/ralph:hero` inside a plugin called `ralph` is redundant. Options: `/ralph:run`, `/ralph:go`, `/ralph:auto`, `/ralph:next`, or keep `:hero` for the tagline ("the naive hero picks tickets…"). Not load-bearing.

## Fast-Track Ladder

The decision the user identified as the core operational pain. Hybrid gate:

```
if issue has kind:* label:
    ladder = lookup(label)        # set by /ralph:caretake --mode triage
else:
    ladder = classify_at_dispatch(issue)
```

The `kind:*` labels carry the static intent:

| Label | Pipeline |
|---|---|
| `kind:trivial` (typo, <50 LOC, no new deps) | impl → review → merge |
| `kind:doc` (docs/README/comments only) | impl → review → merge (same as trivial; review may be a fast linter-only pass) |
| `kind:repro-ready` (bug with repro in body) | impl → review → merge |
| `kind:standard` | research → plan → review → impl → review → merge |
| `kind:epic` | split (caretake) → re-queue children |

The ladder table lives in `skills/hero/ladders.md` and is consulted by `/ralph:hero`'s workflow.

## References Layout

The principle: **`SKILL.md` is the workflow; sibling `.md` files are the opinion library.** When the workflow hits a decision point ("what's the right plan shape for an M-sized issue?"), the skill body says: *consult `planning-by-size.md`*. No sub-skill dispatch — just a `Read`.

### Per-verb shapes

Default pattern: flat siblings (matches superpowers/skill-creator/document-skills convention):

```
skills/plan/
├── SKILL.md                       (~150 lines: workflow + gates)
├── planning-by-size.md            (XS/S/M/L/XL plan shapes)
├── epic-decomposition.md          (sub-issues + dependency graph)
├── file-ownership.md              (parallel-safe phase splitting)
├── iteration.md                   (refining an existing plan)
└── plan-review-checklist.md       (the "good enough to implement" gate)
```

Subfolder only when content has natural categorization that would clutter the flat list — the only verb that meets this bar is `caretake`:

```
skills/caretake/
├── SKILL.md
└── modes/
    ├── hygiene.md
    ├── triage.md
    ├── postmortem.md
    ├── retro.md
    ├── trends.md
    ├── unblock.md
    └── split.md
```

(Pattern matches `document-skills/claude-api/{python,csharp,…}/` — direct children, not nested under `references/`.)

### Cross-cutting content

No plugin-root shared folder. There is no precedent for that in Anthropic-official plugins. For small shared content (label taxonomy, state machine, ladders), **inline-duplicate into each skill that needs it.** If drift becomes a real bug, promote later. Acceptable per P9.

### Sibling reference roster (per verb)

```
skills/hero/
├── SKILL.md
├── event-classes.md, ladders.md, classification.md, dispatch.md

skills/research/
├── SKILL.md
├── when-to-research.md, research-shapes.md, parallel-subagents.md, findings-format.md

skills/plan/
├── SKILL.md
├── planning-by-size.md, epic-decomposition.md, file-ownership.md, iteration.md, plan-review-checklist.md

skills/impl/
├── SKILL.md
├── phase-execution.md, worktree-hygiene.md, address-review-feedback.md, pr-creation.md, escalation.md

skills/review/
├── SKILL.md
├── plan-vs-impl-rubric.md, code-review-prompt.md, merge-gate.md, auto-vs-interactive.md

skills/caretake/
├── SKILL.md
└── modes/{hygiene,triage,postmortem,retro,trends,unblock,split}.md

skills/catch-up/
├── SKILL.md
├── activity-log.md, synthesis.md, next-action-ranking.md

skills/form/
├── SKILL.md
├── intake-shapes.md, duplicate-detection.md, issue-template.md

skills/setup/
├── SKILL.md
├── github-projects-v2.md, mcp-config.md, hooks-config.md, env-vars.md
```

## Repo Layout

```
ralph-hero/                              (existing repo)
├── plugin/                              (existing plugins, untouched during migration)
│   ├── ralph-hero/                      (kept until Plan 10 sunset)
│   ├── ralph-knowledge/                 (separate concern, unchanged)
│   ├── ralph-playwright/                (separate concern, unchanged)
│   └── ralph-demo/                      (separate concern, unchanged)
└── ralph/                               (NEW slim plugin)
    ├── .claude-plugin/
    │   └── plugin.json
    ├── skills/                          (9 verbs, flat-siblings pattern)
    │   ├── hero/
    │   ├── plan/
    │   ├── impl/
    │   ├── research/
    │   ├── review/
    │   ├── caretake/
    │   ├── catch-up/
    │   ├── form/
    │   └── setup/
    ├── hooks/
    │   └── scripts/                     (copies of working ralph-hero hooks, pruned)
    ├── scripts/                         (CLI utilities)
    ├── mcp/                             (deferred — MCP server stays in plugin/ralph-hero/mcp/ during migration)
    ├── CLAUDE.md                        (plugin-specific guidance)
    ├── README.md
    └── LICENSE
```

### Local development workflow

```bash
ln -s /Users/dubiel/projects/ralph-hero/ralph ~/.claude/plugins/cache/ralph/HEAD
```

Edit `skills/foo/SKILL.md` → save → next `/ralph:foo` invocation picks it up. No `claude plugins add` cycle, no marketplace pull, no version bump. Hooks may need a Claude Code reload to re-register (depends on lifecycle).

### Sub-folder caveat

No Anthropic-official plugin lives as a sub-folder inside a larger repo — they each have their own top-level repo (superpowers, skill-creator) or are direct children of a marketplace root (document-skills/*). Putting `ralph/` inside `ralph-hero/` works for local dev but should be extracted to its own repo before any external distribution. Not a blocker for the migration; flag for eventual publishing.

## Harness Boundary

Four layers, with strict ownership:

```
User types /ralph:plan 123
    ↓
Claude Code  →  skill loading, hook lifecycle, Skill() dispatch,
                Agent spawning, EnterWorktree, tool permissions,
                TaskCreate / Bash / Read / Edit / Write
    ↓
   Hooks                MCP server (ralph-github)        SKILL.md
   enforce              durable artifact state           workflow + Read(ref)
                                                              ↓
                                                         opinion siblings
```

### MCP server ownership

| Owned by MCP | Not owned by MCP |
|---|---|
| Issue CRUD (`get_issue`, `save_issue`, `list_issues`) | Filesystem state |
| Workflow transitions (`advance_issue`) | Worktree state |
| Project queries (`next_actions`, `pipeline_dashboard`, `list_dependencies`) | Skill body content |
| Validation (state machine, label rules) | The "what to do next" decision (that's the skill) |

The MCP server keeps a single source of truth and exposes typed tools for it. Skills are consumers, not shadowers, of MCP state.

The current MCP server (`ralph-github`) is reused as-is during migration. Rename / relocate is deferred to Plan 10 or after.

### Hook roster

| Hook | Trigger | Job |
|---|---|---|
| `set-skill-env.sh` | SessionStart | Set `RALPH_COMMAND`, resolve env vars |
| `plan-compliance.sh` | PreToolUse on Edit/Write | Block file edits outside the current phase's owned files |
| `worktree-gate.sh` | PreToolUse on Bash | Block destructive ops outside the worktree |
| `state-transition.sh` | PostToolUse on `save_issue` | Validate the state transition was legal |
| `dispatch-log.sh` | PostToolUse on Skill | Log `/ralph:hero` → `/ralph:plan` dispatches for observability |

Hooks fail closed. Skills assume the hook is correct.

### SKILL.md shape

```markdown
---
description: ...
allowed-tools: [Read, Write, Edit, Bash, Skill, mcp__ralph__*]
---

# Workflow
1. Fetch issue via mcp__ralph__get_issue
2. Decide ladder: if kind:* label present → read ladders.md; else classify
3. Dispatch via Skill()
4. ...

# Decision points
- "What plan shape for size M?" → Read(planning-by-size.md)
- "How to split this epic?" → Read(epic-decomposition.md)
```

~150 lines max. No SOUL.md tax, no inlined opinion content, no enforcement prose.

### Dropped from the current harness

| Drop | Why |
|---|---|
| `SOUL.md` files + `load-team-soul.sh` hook | P10: substrate is the product, not the personality |
| `RemoteTrigger` producer wire + `monitoring-bridge/subscribe.py` | Empirically inert as of 2026-05-22 |
| `hero-dispatch-gate.sh` (current form) | Subsumed by unified state-transition hook |
| `delegate-test` smoke skill | Becomes `scripts/smoke-llm-delegation.sh`, not a skill |
| Per-call preamble loader hooks | Resolve config once in SessionStart |

### Estimated prose absorption

Approximately **3-4k lines of enforcement prose** disappear from skill bodies across the 9 new skills because hooks own enforcement. This is separate from the duplicate-skill-merge savings.

## Migration Plan (The Plan of Plans)

**11 independently mergeable plans, ordered by risk and dependency.** Old `ralph-hero` skills keep working until each is replaced; dogfooding gates the sunset.

| # | Plan | Folds in | Risk | Why this position |
|---|---|---|---|---|
| 0 | Scaffold `ralph-hero/ralph/` | (just the shell) | Low | Mandatory prereq. `plugin.json`, empty `skills/`, hook copies pruned, local-dev symlink verified. Acceptance: `claude plugins list` shows `ralph`, zero skills, no errors. |
| 1 | `/ralph:catch-up` | hello, catch-up, status, report, cos | Low | Read-only, high daily-use, validates the full pattern end-to-end. |
| 2 | `/ralph:form` | draft, form | Low | Intake, doesn't depend on lifecycle. Second pattern validator. |
| 3 | `/ralph:research` | research, ralph-research, prove-claim | Medium | First lifecycle verb. Well-defined I/O. Exercises subagent dispatch via `Skill()`. |
| 4 | `/ralph:plan` | plan, ralph-plan, iterate, ralph-plan-epic, ralph-review, epic side of ralph-split | Medium-high | Largest fold (6 → 1). Epic decomposition is its own reference. |
| 5 | `/ralph:impl` | impl, ralph-impl, ralph-pr | High | The hot path. Exercises worktree isolation + plan-compliance hook + PR creation. Migrate only after `/ralph:plan` is solid. |
| 6 | `/ralph:review` | ralph-code-review, ralph-val, ralph-merge, finish | High | The closing gate. Pairs with `/ralph:impl`. |
| 7 | `/ralph:caretake` | caretake, ralph-triage, ralph-hygiene, ralph-postmortem, retro, trends, unblock, ralph-unblock, ralph-debug-collate, non-epic side of ralph-split | Medium | One plan, multiple modes. |
| 8 | `/ralph:hero` | hero, team, autopilot, director, pr-drain, watch | High | The orchestrator. **Cannot ship before plans 1-7** — depends on every other verb existing. |
| 9 | `/ralph:setup` | setup, setup-cli, setup-repos | Low | Lowest-frequency invocation. Parked at end because least-urgent. |
| 10 | Sunset `plugin/ralph-hero/` | (deletion) | High | Audit: every workflow you actually run has a `/ralph:*` counterpart in use. Delete old skills, update README, possibly relocate MCP server into `ralph-hero/ralph/mcp/`. |

### Dogfooding rhythm

After each plan merges:

1. Switch one real workflow to the new verb (e.g., after Plan 3 ships, do all your next research with `/ralph:research`).
2. Friction log in the spec for the next plan — lessons from using the new verb feed the next design.
3. Don't sunset the old skill until **two consecutive weeks without invoking it.**

This is load-bearing. The risk of "build new plugin in parallel" is that the new plugin becomes a museum piece. The forcing function is: ship one verb → use it for two weeks → ship the next.

### Acceptance criteria (consistent across all 9 verb plans)

1. **Functional parity:** the new verb does what the folded-in skills did, on at least 3 real issues.
2. **Token budget:** new `SKILL.md` is ≤ 200 lines (target ~150). Opinion content lives in references.
3. **Hook coverage:** no enforcement logic in skill prose — all moved to hooks or MCP validation.
4. **Local dev works:** edit `SKILL.md`, save, next invocation picks it up without `claude plugins` commands.
5. **Old skill stays functional** for two weeks post-merge. Sunset is its own follow-up PR.

### Estimated timeline (to validate)

- Plans 0-2 (scaffold + 2 low-risk verbs): ~1 week
- Plans 3-6 (four lifecycle verbs): ~3-5 weeks
- Plan 7 (caretake): ~1-2 weeks
- Plan 8 (orchestrator): ~1-2 weeks
- Plan 9 (setup): ~3 days
- Plan 10 (sunset): ~1 week (mostly safety windows)

Total elapsed: **2-3 months**, with no period of "ralph is broken." Worst case: abandon mid-way and you still have both old (working) and new (partial).

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| New plugin becomes a museum piece you don't adopt | Dogfooding rhythm: switch one workflow per plan, sunset only after 2 weeks of disuse on old |
| Folded skill turns out to be load-bearing in a way I missed | Old skills remain functional for the 2-week sunset window; Plan 10 is reversible |
| Local-dev symlink doesn't work cleanly with Claude Code's plugin cache | Plan 0 acceptance includes verifying the symlink mechanism. Fallback: local marketplace via `file://` URL |
| Scope creep during migration | Each plan's acceptance #1 is "functional parity on 3 real issues" — capability additions are separate plans, post-migration |
| Inlined shared content drifts | Accepted per P9. If drift causes a real bug, promote to top-level docs/, owned-by-one-skill, or extract |
| Cross-plugin MCP server reference | New `ralph` plugin needs to invoke `mcp__plugin_ralph-hero_ralph-github__*` tools. Plan 0 verifies; if not, MCP needs to be registered in both manifests during parallel period |
| `prove-claim` 5-step evidence flow gets lost | Absorbed as `/ralph:research --mode prove` with content moved to `skills/research/prove-claim.md` |
| `RALPH_COMMAND` env var compatibility | Plan 0 verifies `set-skill-env.sh` sets it correctly for new verb names so existing hooks/tools that branch on it continue to work |

## Decisions Punted

| Item | When |
|---|---|
| `/ralph:hero` verb naming (`hero`/`go`/`run`/`auto`/`next`) | Plan 8 |
| MCP server rename / relocate | Plan 10 or after |
| Sibling plugins (ralph-knowledge, ralph-playwright, ralph-demo) flat-root treatment | Separate initiative, after `ralph` proves the pattern |
| `gdrive-push/pull`, `record-demo`, `design-system-audit`, `idea-hunt` — kill or spin into own plugins | Per-skill usage audit, separate from this migration |

## Out of Scope

- Changes to `ralph-knowledge`, `ralph-playwright`, `ralph-demo` plugins
- MCP server refactor (audit dead tools, rename, relocate)
- Cross-platform manifests (`.codex-plugin/`, `.cursor-plugin/`)
- Memory pipeline (dream-loop) — already healthy
- `design-system-audit`, `gdrive-{push,pull}`, `record-demo` skills — usage-audit decision (whether to keep as standalone plugins, kill, or absorb later)

## What "Done" Looks Like

Migration is complete when:

1. All 9 verbs (`/ralph:hero`, `/ralph:research`, `/ralph:plan`, `/ralph:impl`, `/ralph:review`, `/ralph:caretake`, `/ralph:catch-up`, `/ralph:form`, `/ralph:setup`) exist and meet the 5 acceptance criteria.
2. No `/ralph-hero:*` slash command has been invoked for ≥ 2 weeks.
3. `plugin/ralph-hero/skills/` is empty or removed.
4. The MCP server is reachable from `ralph` (either still in `plugin/ralph-hero/mcp/` or relocated to `ralph/mcp/`).
5. README documents the new plugin as the canonical entry point.

Expected end-state surface: 9 user-facing slash commands, ~1,500 lines of SKILL.md total (down from ~14k), opinion content in flat reference siblings, enforcement in hooks, durable state in MCP.

## Friction Log

The dogfooding rhythm depends on capturing lessons-learned from each shipped verb to feed the next plan's design. Append per-plan entries here as the 2-week dogfooding window plays out.

### Plan 1: `/ralph:catch-up` (shipped 2026-05-23, branch `feature/GH-1357-catch-up`)

Final shape:

- `ralph/skills/catch-up/SKILL.md`: 137 lines (target ~150, max 200).
- Four flat-sibling references: `narrative-synthesis.md` (63), `next-action-ranking.md` (103), `dashboard-render.md` (78), `report-composition.md` (124). Total 368 lines of opinion content.
- Combined: 505 lines (vs 580 + 65-line cos system-prompt in source). LOC reduction is modest; structural compliance with P2 is the bigger win.
- Hook port: `cursor-advance-catch-up.sh` ported verbatim. Both plugins now fire it on the same `recent_activity` PostToolUse matcher; cursor writes are idempotent (last write wins), so the duplicate firing is benign during the migration window.
- cos's `desk`/`remote`/`unattended` modes deliberately stayed as `ralph cos {...}` CLI subcommands. Their zero-Claude-Code-on-the-call-chain property would have inverted if absorbed into the slash skill.

Real-session usage notes during the 2-week dogfooding window:

- [ ] _(Add entries as you use it. Examples to watch for: edge cases in narrative synthesis, picker label truncation, dashboard JSON-mode quirks, --mode report posting permissions, cursor advance timing under multi-plugin firing.)_

Inputs to feed into Plan 2 (`/ralph:form`):

- _(TBD after 2 weeks of usage.)_
- Pattern validator note: the flat-sibling reference layout (no `references/` subfolder, no nested `Skill()` dispatch) worked cleanly for a 5-skill fold. Plan 2 should follow the same shape unless friction emerges.

Open follow-ups (separate plans):

- Plan 7 will introduce `/ralph:caretake`. At that point, `dashboard-render.md` should retarget its "remediation belongs to" line away from `/ralph-hero:hygiene/triage/hello` to the new verb.
- Plan 10 owns sunset of the source skills (`hello`, `catch-up`, `status`, `report`, `cos` skill body). cos's scripts under `plugin/ralph-hero/scripts/cos/` are not part of the slash-command migration and have their own kill-or-extract decision.
