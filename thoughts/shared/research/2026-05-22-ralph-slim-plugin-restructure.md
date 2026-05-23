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

This document specifies a parallel-plugin restructure: a new plugin **`ralph`** (no `-hero` suffix) sitting at `ralph-hero/ralph/`, with **9 fat skills**, opinion content moved to flat reference siblings, and enforcement moved to hooks + MCP. Migration ships across **11 independent plans** with no period where the system is broken — the old plugin keeps working alongside the new one, and each verb is sunset only when the new counterpart has handled the workflows it replaces.

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

1. **Switch to the new verb immediately** for the workflows it covers. `/ralph:research` replaces `/ralph-hero:research` etc. starting the next session.
2. **Use it, find what breaks, fix it.** Active dogfooding produces signal; passive waiting does not.
3. **Sunset the old skill when the new counterpart has handled each surface it replaces** (not on a calendar). One real-session pass through each mode / branch of the new verb is enough.

The forcing function is active use, not elapsed time. The risk of "build new plugin in parallel" is that the new plugin becomes a museum piece; the mitigation is using it, not waiting.

### Acceptance criteria (consistent across all 9 verb plans)

1. **Functional parity:** the new verb does what the folded-in skills did, on at least 3 real issues.
2. **Token budget:** new `SKILL.md` is ≤ 200 lines (target ~150). Opinion content lives in references.
3. **Hook coverage:** no enforcement logic in skill prose — all moved to hooks or MCP validation.
4. **Local dev works:** edit `SKILL.md`, save, next invocation picks it up without `claude plugins` commands.
5. **Old skill stays functional** until its new counterpart has been actively used through each surface it covers. Sunset is a follow-up PR — Plan 10 batches the remaining ones.
6. **Per-phase audit applied:** after each phase passes its automated + manual verification, dispatch `/review` (against the open PR or branch diff) and `/skill-creator:skill-creator` (against the partial skill bundle) in parallel. Apply recommended fixes — or document why not — before proceeding to the next phase. Catches P2 leakage, missing tools, picker ambiguity, and trigger gaps while they're still cheap to fix; established by Plan 1's post-impl audit and made standard in Plan 2.

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
| New plugin becomes a museum piece you don't adopt | Switch to the new verb immediately on ship; sunset only after the new counterpart has been actively exercised on every surface it replaces |
| Folded skill turns out to be load-bearing in a way I missed | Old skills remain functional alongside the new ones until sunset (Plan 10); a regression caught during active dogfooding is a fix on the new verb, not a rollback |
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
2. Every `/ralph-hero:*` slash command being sunset has a `/ralph:*` counterpart that has handled at least one real-session instance of each surface it replaces.
3. `plugin/ralph-hero/skills/` is empty or removed.
4. The MCP server is reachable from `ralph` (either still in `plugin/ralph-hero/mcp/` or relocated to `ralph/mcp/`).
5. README documents the new plugin as the canonical entry point.

Expected end-state surface: 9 user-facing slash commands, ~1,500 lines of SKILL.md total (down from ~14k), opinion content in flat reference siblings, enforcement in hooks, durable state in MCP.

## Friction Log

The dogfooding rhythm depends on capturing lessons from each shipped verb to feed the next plan's design. Populate per-plan entries by *using* the verb — not by waiting for a calendar window. When you find something broken or awkward, fix it (small follow-up PR) and record what you fixed and why.

### Plan 1: `/ralph:catch-up` (shipped 2026-05-23, branch `feature/GH-1357-catch-up`)

Final shape:

- `ralph/skills/catch-up/SKILL.md`: 137 lines (target ~150, max 200).
- Four flat-sibling references: `narrative-synthesis.md` (63), `next-action-ranking.md` (103), `dashboard-render.md` (78), `report-composition.md` (124). Total 368 lines of opinion content.
- Combined: 505 lines (vs 580 + 65-line cos system-prompt in source). LOC reduction is modest; structural compliance with P2 is the bigger win.
- Hook port: `cursor-advance-catch-up.sh` ported verbatim. Both plugins now fire it on the same `recent_activity` PostToolUse matcher; cursor writes are idempotent (last write wins), so the duplicate firing is benign during the migration window.
- cos's `desk`/`remote`/`unattended` modes deliberately stayed as `ralph cos {...}` CLI subcommands. Their zero-Claude-Code-on-the-call-chain property would have inverted if absorbed into the slash skill.

Friction notes (populated by active use):

- [ ] _(Add entries as you use it. Examples to watch for: edge cases in narrative synthesis, picker label truncation, dashboard JSON-mode quirks, --mode report posting permissions, cursor advance timing under multi-plugin firing.)_

Inputs to feed into Plan 2 (`/ralph:form`):

- _(Populated by active use, not by waiting.)_
- Pattern validator note: the flat-sibling reference layout (no `references/` subfolder, no nested `Skill()` dispatch) worked cleanly for a 5-skill fold. Plan 2 should follow the same shape unless friction emerges.

Open follow-ups (separate plans):

- Plan 7 will introduce `/ralph:caretake`. At that point, `dashboard-render.md` should retarget its "remediation belongs to" line away from `/ralph-hero:hygiene/triage/hello` to the new verb.
- Plan 10 owns sunset of the source skills (`hello`, `catch-up`, `status`, `report`, `cos` skill body). cos's scripts under `plugin/ralph-hero/scripts/cos/` are not part of the slash-command migration and have their own kill-or-extract decision.

### Plan 2: `/ralph:form` (shipped 2026-05-23, branch `feature/GH-1359-form`)

Final shape:

- `ralph/skills/form/SKILL.md`: 186 lines (target ~150, max 200). Heavier than catch-up (137) because the default flow has a 5-option picker that branches into 4 distinct output paths (single issue / ticket tree / handoff / refined draft) plus the `--mode draft` quick-capture flow — six surfaces in one verb.
- Three flat-sibling references: `intake-shapes.md` (103), `duplicate-detection.md` (52), `issue-template.md` (112). Total 267 lines of opinion content.
- Combined: 453 lines (vs 510 in source draft + form). Reduction is modest; structural P2 compliance is the bigger win.
- No hooks ported. Source draft and form had no enforcement to move; `ralph/hooks/hooks.json` unchanged from Plan 1.
- Step 5 picker defaults change with `LINKED_ISSUE`: when intake routing detects a research doc with an existing `github_issue` in its frontmatter, the picker biases toward "Implementation plan" rather than "GitHub issue" (avoids duplicate issue creation against linked research).
- Handoffs in Step 6c point at `/ralph:plan` and `/ralph:research` with `/ralph-hero:plan` and `/ralph-hero:research` as fallbacks. The new-verb names get unblocked when Plans 3 (research) and 4 (plan) ship — the fallbacks come out then.

Friction notes (populated by active use):

- [ ] _(Add entries as you use it. Examples to watch for: research-doc auto-detection edge cases (`type: research` vs path glob), inline-description routing for very short inputs, ticket-tree estimate-default appropriateness, knowledge-search dedup false positives, frontmatter-update collisions when the source file is open in an editor.)_

Inputs to feed into Plan 3 (`/ralph:research`):

- _(Populated by active use, not by waiting.)_
- Pattern validator note: the flat-sibling reference layout worked again for a 2-skill fold with three references. Three references felt about right; four (the catch-up shape) is the upper end. If Plan 3 needs five+, that's a signal to revisit the convention.

Open follow-ups (separate plans):

- When Plan 3 ships, update SKILL.md Step 6c to drop the `/ralph-hero:research` fallback. Same for Plan 4 and `/ralph-hero:plan`.
- Plan 7 (`/ralph:caretake`) doesn't directly affect this verb.
- Plan 10 owns sunset of source `draft` + `form` skills.

### Plan 3: `/ralph:research` (shipped 2026-05-23, branch `feature/GH-1362-research`)

Final shape:

- `ralph/skills/research/SKILL.md`: 183 lines (target ~170, max 200). Heavier than catch-up (137) and form (186) because the verb folds three structurally distinct sub-flows (interactive 10 steps + autonomous 9 steps + prove 5 steps) plus the `hooks:` frontmatter block declaring 5 auto-mode hooks.
- Five flat-sibling references: `intake-routing.md` (46), `research-shapes.md` (78), `findings-format.md` (187), `playwright-baseline.md` (113), `prove-claim.md` (130). Total 554 lines of opinion content.
- Combined: 737 lines (vs 1,089 in source research + ralph-research + prove-claim). ~32% LOC reduction; the larger structural win is collapsing 3 user-facing verbs into 1 with `--mode` dispatch.
- Hook ports: five scripts ported verbatim from the source plugin (`research-state-gate.sh`, `research-postcondition.sh`, `doc-structure-validator.sh`, `branch-gate.sh`, `lock-release-on-failure.sh`) plus `ralph-state-machine.json` (required by lock-release). All gate on `RALPH_COMMAND` / `RALPH_TICKET_ID` env vars set by `set-skill-env.sh` on SessionStart, so they no-op outside `--mode auto`.
- **First plan to introduce SKILL.md frontmatter `hooks:` block in the slim plugin.** Catch-up and form had no enforcement to port; research is the first verb where Hooks Own Enforcement (P6) is exercised end-to-end. The slim-plugin pattern: plugin-root `hooks.json` for cross-skill concerns (cursor advance, env setup); per-skill `hooks:` frontmatter for skill-specific enforcement (state gates, postconditions, doc validators, branch gates, lock releases). This pattern will be re-used by Plans 4 (`/ralph:plan`) and 5 (`/ralph:impl`).
- **First plan to ship 5 reference siblings** — above Plan 2's "four is the upper end" comfort heuristic. The fifth (`prove-claim.md`) is justified by prove-mode's structural distinctness from codebase research (no Agent dispatch, knowledge-graph only, evidence-weighting opinion content with no analog in the other modes).
- Playwright baseline content centralized: both default Step 6.5 and autonomous Step 5.5 consult the same `playwright-baseline.md`. The two source skills duplicated this block verbatim — the fold deduplicates it.
- The autonomous-mode commit step lives in `playwright-baseline.md` rather than the SKILL.md auto-mode list because it's specific to the baseline-append path. Keeps SKILL.md auto-mode tight (one-liners per step).

Friction notes (populated by active use):

- [ ] _(Add entries as you use it. Examples to watch for: hooks correctly no-op in interactive/prove modes; auto-mode state-gate behavior on out-of-band issue moves; prove-mode degradation when knowledge tools are partial; cross-repo registry lookup with newly-added repos; AskUserQuestion findings-review loop iterations.)_

Inputs to feed into Plan 4 (`/ralph:plan`):

- _(Populated by active use, not by waiting.)_
- Pattern validator note: SKILL.md frontmatter `hooks:` worked for scoping enforcement to a single mode within a multi-mode verb. Plan 4 will reuse for `/ralph:plan` (plan-state-gate + plan-postcondition).
- Reference-count note: 5 references felt structurally justified by prove-mode's distinctness. For verbs without a structurally-distinct sub-mode, 4 stays the comfortable upper end. Plan 4 should aim for 4 references unless a comparable sub-mode emerges.

Open follow-ups (separate plans):

- When Plan 4 ships, drop the `/ralph-hero:plan` fallback in `/ralph:form` Step 6c (already a documented Plan 2 follow-up). `/ralph:research` Step 9 "Create issue from findings" already points at `/ralph:form` (no fallback needed since Plan 2 shipped).
- Plan 7 (`/ralph:caretake`) doesn't directly affect this verb.
- Plan 10 owns sunset of source `research`, `ralph-research`, `prove-claim` skills.

### Plan 4: `/ralph:plan` (shipped 2026-05-23, branch `feature/GH-1364-plan`)

Final shape:

- `ralph/skills/plan/SKILL.md`: 176 lines (under the 200 budget). Holds 5 mode bodies (default, --mode auto, --mode epic, --mode iterate, --mode review) — heaviest verb yet by mode count.
- Six flat-sibling references: `intake-routing.md` (59), `plan-shapes.md` (150), `decomposition.md` (107), `iteration.md` (87), `plan-review.md` (131), `ui-validation-phase.md` (76). Total 610 lines of opinion content.
- Combined: 786 lines (vs 2,777 in source plan + ralph-plan + ralph-plan-epic + iterate + ralph-review + ralph-split epic-side). ~72% LOC reduction — largest absolute reduction across plans 1-4. Each surface remains addressable; the fold is structural, not feature-cutting.
- Hook ports: 9 new (plan-tier-validator, plan-state-gate, plan-postcondition, plan-research-required, review-state-gate, review-no-dup, review-plan-gate, review-postcondition, review-verify-doc) + reuses Plan 3's branch-gate / doc-structure-validator / lock-release-on-failure. doc-structure-validator's plan branch updated to match the slim plan-shapes section style (`#### Automated Verification` / `#### Manual Verification` instead of source's `- [ ] Automated:` flat checkbox format).
- **First plan to ship 6 references.** Plan 3 shipped 5; the comfort-upper-bound was originally 4. Plan 4's 6 is justified by `--mode epic` and `--mode review` each having structurally distinct content with no overlap with the other modes (decomposition graphs / verdict-shape critique). The pattern: one reference per mode-with-distinct-opinion-content, plus shared opinion (plan-shapes, intake-routing, ui-validation-phase).
- **Hook discrimination by tool-input path**, not env var. Initial design tried `Bash export RALPH_COMMAND=review` at `--mode review` entry; final-bundle audit caught that Bash-tool exports don't propagate to hook subprocesses. Re-designed to use path-based discrimination:
  - `doc-structure-validator.sh` scans all 3 artifact dirs (plans, reviews, research) for today-prefixed docs modified in the last 15 min and picks the branch by the dir containing the freshest doc.
  - `review-no-dup.sh` and `review-verify-doc.sh` already no-op when `tool_input.file_path` isn't under `thoughts/shared/reviews/` — no change needed.
  - `plan-state-gate.sh` broadened to accept the union of legitimate transitions across all 5 modes (`Plan in Progress, Plan in Review, In Progress, Ready for Plan, Human Needed`).
  - `review-state-gate.sh` + `review-postcondition.sh` dropped from SKILL.md frontmatter entirely — the union-broadened plan-state-gate + path-discriminated doc-validator + write-path-discriminated review-no-dup/verify cover the surface without env-mode-flipping.
- **Lesson for Plan 5+**: do NOT rely on env-var flipping across hook invocations. Either set env via SessionStart (one-shot) OR discriminate inside the hook by tool-input shape (file path, target state). Bash-tool exports are session-scoped and do NOT propagate to hook subprocesses.

Friction notes (populated by active use):

- [ ] _(Examples to watch for: review-mode env switching reliability across Bash subprocesses; epic-mode dependency-graph cycle detection in re-decomposition; iterate-mode phase-renumbering edge cases when a plan is in-flight; auto-mode escalation-to-Human-Needed when research is missing; default-mode picker loop UX when user picks Iterate repeatedly.)_

Inputs to feed into Plan 5 (`/ralph:impl`):

- _(Populated by active use, not by waiting.)_
- Pattern validator note: 6 references worked. Plan 5 should hold at ≤4-5 unless a mode is structurally distinct enough to warrant its own (worktree + plan-compliance feel like the load-bearing references; PR creation might live in a third).
- Hooks-in-frontmatter pattern continues to scale. Plan 5 will be the heaviest hook-wise (impl carries worktree-isolation + plan-compliance gates).
- Per-mode env switching (review-mode resetting `RALPH_COMMAND`) needs operational verification — if Bash exports do not persist across hook subprocesses, the review-mode hooks won't activate. Plan 5 should also test this pattern if it adopts a multi-RALPH_COMMAND shape.

Open follow-ups (separate plans):

- Plan 5 consumes plan docs produced here. Schema stability: this plan preserves the existing plan-doc shape verbatim (Phase / Success Criteria with `#### Automated/Manual Verification` subsections).
- Plan 6 (`/ralph:review`) absorbs `ralph-code-review`, `ralph-val`, `ralph-merge`, `finish` — the code-and-merge review surface, distinct from Plan 4's `--mode review` which is plan-doc review.
- Plan 7 (`/ralph:caretake --mode split`) absorbs the atomic-splitting side of `ralph-split`.
- Plan 10 owns sunset of source `plan`, `ralph-plan`, `ralph-plan-epic`, `iterate`, `ralph-review` skills (`ralph-split` straddles plans 4 and 7 — both sides need to be re-homed before sunset).

### Plan 5: `/ralph:impl` (shipped 2026-05-23, branch `worktree-GH-1366-ralph-plan-5-impl`)

Final shape:

- `ralph/skills/impl/SKILL.md`: 199 lines (right at the 200 budget). Holds 4 mode bodies (default, --mode auto, --mode address, --mode pr). Heaviest verb yet by raw mode body count but shortest reference list since address + pr each only needed one reference apiece.
- Five flat-sibling references: `worktree-setup.md` (141), `plan-compliance.md` (90), `phase-execution.md` (85), `address-mode.md` (53), `pr-creation.md` (127). Total 496 lines of opinion content.
- Combined: 695 lines (vs 1,210 in source impl + ralph-impl + ralph-pr). ~43% LOC reduction — smaller than Plan 4's 72% because the source impl/pr skills already had less duplication than the plan-family.
- Hook ports: 9 new (impl-plan-required, impl-worktree-gate, impl-state-gate, impl-staging-gate, impl-branch-gate, drift-tracker, impl-verify-commit, impl-postcondition, pr-state-gate) + reuses Plan 3's doc-structure-validator and lock-release-on-failure. **Largest hook surface of any plan so far** — confirms Plan 4's prediction.
- **All 9 hooks scoped via `RALPH_COMMAND=impl`** at SessionStart (one-shot, no mid-flow env mutation). Three hooks (`impl-plan-required.sh`, `impl-state-gate.sh`, `impl-verify-commit.sh`) needed the gate added; one (`pr-state-gate.sh`) additionally self-limits on `tool_input.workflowState == "In Review"` to avoid double-firing with `impl-state-gate.sh`. This honors Plan 4's lesson: per-mode behavior comes from tool-input shape, not env-var flipping.
- **`Queue empty.` literal preserved verbatim** in pr-mode body so the loop-runner sentinel keeps working unchanged.
- **`IMPL BLOCKED model=<current> needs=opus reason=<short>` token contract preserved verbatim**. `impl-postcondition.sh` greps the JSONL transcript for unanchored `IMPL BLOCKED ` and accepts it as a non-error terminal state — the hook is unchanged from the source plugin.
- **Reference count back at 5**, consistent with Plan 3's pattern. Plan 4 went to 6 because epic + review modes were structurally distinct; Plan 5's modes share substrate (worktree + plan-compliance + phase-execution) which gets pulled into common references, with address + pr each owning a single distinctive reference.
- **Default mode's Step 6 picker dispatches `Skill("ralph-hero:finish", args="NNN")`** until Plan 6 ships `/ralph:review`. Single-line edit follow-up.

Friction notes (populated by active use):

- [ ] _(Examples to watch for: auto-mode worktree-gate firing on legitimate Write in cross-repo case; IMPL BLOCKED tier escalation re-dispatch cadence at opus; staging-gate false positives on lockfile updates; scout-trigger false positives on backend-only PRs; pr-mode queue-pick picking the wrong issue when multiple are in In Progress with worktrees.)_

Inputs to feed into Plan 6 (`/ralph:review`):

- _(Populated by active use, not by waiting.)_
- Pattern validator note: 9 hooks is the new ceiling. Plan 6 should stay at or below; its surface (review + val + merge + finish) probably folds into 3-4 mode-specific hooks since most of the gate logic is already in impl-state-gate / pr-state-gate.
- Default-mode Step 6 picker → `Skill("ralph:review")` edit is owed by Plan 6.
- The `## Scout Trigger` advisory is wired in pr-mode — Plan 6 (`/ralph:review`) merge-gate should observe `## Scout Report` verdicts as a pre-merge condition. Spec the contract in Plan 6.

Open follow-ups (separate plans):

- Plan 6 owns the `Skill("ralph:review")` redirect from default-mode Step 6 picker.
- Plan 6 (`/ralph:review`) absorbs `ralph-code-review`, `ralph-val`, `ralph-merge`, `finish` — code+merge review, distinct from Plan 4's plan-doc review.
- Plan 8 (`/ralph:hero`) is the orchestrator that auto-dispatches `/ralph:impl --mode auto`. Plan 5 preserves the `--plan-doc` flag for orchestrator compatibility.
- Plan 10 owns sunset of source `impl`, `ralph-impl`, `ralph-pr` skills.

### Plan 6: `/ralph:review` (shipped 2026-05-23, branch `worktree-ralph-plan-6-review`)

Final shape:

- `ralph/skills/review/SKILL.md`: 127 lines (well under the 200 budget). Holds 4 mode bodies (default, --mode val, --mode code, --mode merge). The 4-leaf orchestrator pattern compresses cleanly: each leaf is 7-9 numbered steps, and the default-mode body is a 7-step thread through the leaves' verdict tokens.
- Four flat-sibling references: `plan-vs-impl-rubric.md` (149), `code-review-prompt.md` (117), `merge-gate.md` (182 — largest, owns CI watch + cross-repo + Scout Report gate + parent-advancement boundary), `auto-vs-interactive.md` (122). Total 570 lines of opinion content.
- Combined: 697 lines (vs 1,585 in source ralph-val + ralph-code-review + ralph-merge + finish). **~56% LOC reduction** — between Plan 3's ~50% and Plan 4's 72%; the 4-source fold compresses well because three of the four sources (val, code, merge) are leaf verbs with similar verdict-token shapes that consolidate into a single Stop-hook contract.
- **5 hooks, under the 9 ceiling**: `merge-state-gate.sh` (port from plugin/ralph-hero, registered on PreToolUse save_issue|advance_issue), `closeout-postcondition.sh` (new ~80 lines, Stop, covers all 4 modes' terminal verdicts via tool-input-shape discrimination per Plan 4's lesson), `closeout-scout-gate.sh` (new ~80 lines, PreToolUse Bash on merge command, Scout Report consumer), plus reused Plan 3 ports (`lock-release-on-failure.sh`, `doc-structure-validator.sh`). `val-postcondition.sh` ported for future reuse but NOT registered — `closeout-postcondition.sh` owns the union of all 4 mode verdicts and double-registration would block non-val terminals.
- **Hook rename — `closeout-*` not `review-*`** — Plan 4 left orphan `review-postcondition.sh` and `review-state-gate.sh` in `ralph/hooks/scripts/` (unwired, but file-system present). Plan 6's new hooks use `closeout-` prefix to avoid name collision. The plan doc carries the rename rationale.
- **Default-mode preserves the depth-0 fan-out for `code-review:code-review`** by invoking it inline via `Skill("code-review:code-review", "PR_NUMBER")`, NOT via `Agent()`. The runtime forbids depth-2 `Agent` dispatch, so a wrapping Agent context would silently break the parallel-reviewer + parallel-scorer fan-out. SKILL.md frontmatter declares `model: opus` for the same reason — the depth-0 leaf must be top-tier.
- **Code-review fix-cycle bound differs by mode**: default-mode runs ONE cycle then escalates (`FINISH BLOCKED`); `--mode code` runs UP TO 3 rounds then posts the `## Code Review` summary + canonical `## Escalation` comments and transitions via `__ESCALATE__`. Boundary preserved: orchestrator does not own the multi-round loop.
- **`## Scout Report` consumer wired** — `closeout-scout-gate.sh` parses `verdict: PASS|WARN|FAIL` from a `## Scout Report` comment when a `## Scout Trigger` is present on the PR. Closes the producer-consumer loop opened by Plan 5's `/ralph:impl --mode pr`.
- **Pre-merge gates ALWAYS run** — even when called from default-mode. The review-decision and mergeable-status checks live in `--mode merge`'s body as a safety net for standalone callers (`just merge NNN`) that skip default-mode. Refuses unreviewed PRs even when the caller skipped validation.
- **CI watch uses `Monitor` with literal `MERGE_SHA` substitution** — Monitor runs the command in its own subshell and does NOT inherit `$MERGE_SHA` from prior Bash calls. The substitution warning is load-bearing in `merge-gate.md` §CI Watch.

Friction notes (populated by active use):

- [ ] _(Examples to watch for: default-mode `code-review:code-review` invocation at depth 0 with parallel-reviewer fan-out visible in transcript; closeout-scout-gate.sh blocking on FAIL verdict; closeout-scout-gate.sh false-passing on missing report (advisory-by-design); finish-review-verdict.sh returning ERROR transiently and retry behavior; impl picker dispatching `Skill("ralph:review")` cleanly after Phase 6 wiring; cross-repo merge unblocking sibling repos correctly via `.ralph-repos.yml`.)_

Post-implementation code review surfaced three merge-related bugs in the as-shipped Phase 1-6 work (fixed before merge of PR #1369); full root-cause writeup lives in [`2026-05-23-GH-1368-ralph-plan-6-review.md` §Post-implementation Code Review Findings](../plans/2026-05-23-GH-1368-ralph-plan-6-review.md). Headlines:

- **`__DONE__` is not a registered semantic intent** — source `ralph-merge` prose was stale. The valid intents are `__LOCK__`, `__COMPLETE__`, `__ESCALATE__`, `__CLOSE__`, `__CANCEL__`. Use `__CLOSE__` to transition to Done.
- **`merge-state-gate.sh` blocked `__ESCALATE__` and `__CLOSE__`** because it pure-string-compared against `RALPH_VALID_OUTPUT_STATES`. Source `finish` masked this by dispatching merge as an Agent (separate hook scope); Plan 6's body calls `save_issue(__*__)` directly. Fix: mirror `impl-state-gate.sh`'s shape — RALPH_COMMAND scope guard + `is_semantic_intent` passthrough before `validate_state`.
- **`closeout-scout-gate.sh` died under `pipefail`** when a `## Scout Report` had no `verdict:` line (the grep stage exits 1, pipefail propagates, set -e kills the script before the conservative `*) exit 0` arm). Fix: append `|| true` to the verdict-extraction pipeline.

Patterns to encode in future fold plans:

- **Pre-flight: verify semantic-intent tokens against `state-resolution.ts`** before adopting prose from source skills. Source prose may have rot from a prior rename.
- **Hook reuse-as-is must audit the same substrate gaps the new hooks address** (RALPH_COMMAND scope guard + semantic-intent passthrough). If new hooks have these, ported hooks must too.
- **Smoke-test pipeline-heavy hooks under `set -euo pipefail` with the no-match path**, not just the happy path. Add a "malformed report" / "empty intermediate" test case to manual verification for any hook with `grep | sed | awk` chains.

Inputs to feed into Plan 7 (`/ralph:caretake`):

- _(Populated by active use, not by waiting.)_
- 5 hooks is comfortable below the 9 ceiling — Plan 7 has more headroom.
- The `closeout-` prefix convention is now established for non-review-but-review-adjacent hooks. Future plans should pick clear-scope prefixes early to avoid collision with the existing orphan `review-*.sh` scripts.
- **Use `__CLOSE__` (not `__DONE__`) to transition issues to Done.** Source-plugin prose may still say `__DONE__`; do not propagate.
- **Any new state gate hook must include both the RALPH_COMMAND scope guard and the `is_semantic_intent` passthrough.** The reference shape is `ralph/hooks/scripts/impl-state-gate.sh`.
- **Any pipeline-heavy hook under `set -euo pipefail` must append `|| true`** (or wrap the assignment in `set +e`/`set -e`) on intermediate `grep`-style stages that may legitimately match nothing.

Open follow-ups (separate plans):

- Plan 7 (`/ralph:caretake`) folds the caretaker modes (triage, hygiene, postmortem, retro, trends, unblock, split). May reuse `merge-state-gate.sh` for the merge-adjacent caretaker actions.
- Plan 8 (`/ralph:hero`) is the orchestrator that dispatches `/ralph:impl --mode auto` then `/ralph:review` (default) per issue. Plan 6's verdict-token contracts (`FINISHED`, `FINISH BLOCKED — <reason>`) are the boundary the hero parses to decide next action.
- Plan 10 owns sunset of source `ralph-val`, `ralph-code-review`, `ralph-merge`, `finish` skills.
