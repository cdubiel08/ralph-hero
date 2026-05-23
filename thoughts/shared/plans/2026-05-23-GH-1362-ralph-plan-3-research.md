---
date: 2026-05-23
status: draft
type: plan
tags: [ralph, plugin-restructure, research, prove-claim, migration, plan-of-plans]
github_issue: 1362
github_issues: [1362]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1362
primary_issue: 1362
---

# Plan 3: `/ralph:research` — Research Verb Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-ralph-slim-plugin-restructure]]
- builds_on:: [[2026-05-23-GH-1357-ralph-plan-1-catch-up]] — validated the scaffold + flat-sibling references + cross-plugin MCP pattern.
- builds_on:: [[2026-05-23-GH-1359-ralph-plan-2-form.md]] — validated the multi-surface fold (6 surfaces in one verb at 186 lines) and confirmed the "4 references is the upper end" heuristic. Plan 3 has 5 references; first plan to exceed that bar.
- builds_on:: PR #1361 (Plan 2 form implementation, branch `feature/GH-1359-form`)

## Overview

Fold three existing `ralph-hero` skills (`research`, `ralph-research`, `prove-claim`) into one user-facing slash command `/ralph:research` in the new `ralph/` plugin. The default surface is the interactive research flow (today's `/ralph-hero:research` — ask for question or issue, dispatch parallel sub-agents, surface findings to the user for review, write doc, optional artifact comment + next-steps picker). `--mode auto` is today's autonomous `/ralph-hero:ralph-research` flow (pick XS/S issue from "Research Needed", lock, research, write findings, advance to "Ready for Plan", no questions). `--mode prove "<claim>"` is today's `/ralph-hero:prove-claim` (5-step structured claim investigation over the knowledge graph, produces a verdict + confidence + evidence-chain report).

This is the third lifecycle migration plan (after catch-up and form). It is the first verb that exercises:

- **Per-skill hooks in SKILL.md frontmatter** (the autonomous flow needs `research-state-gate.sh`, `research-postcondition.sh`, `doc-structure-validator.sh`, `branch-gate.sh`, `lock-release-on-failure.sh`). The interactive and prove modes do not invoke these — hooks are scoped to `--mode auto`.
- **Five reference siblings** (Plan 2's friction log flagged four as the comfort upper-bound). The fifth is `prove-claim.md`, which is a structurally distinct sub-flow with its own evidence-weighting, confidence-calibration, and anti-patterns content.
- **Conditional Playwright baseline integration** (used by default + auto flows when ralph-playwright is installed and the work is frontend-relevant).

The plan-of-plans positions Plan 3 as "medium risk — first lifecycle verb with well-defined I/O; exercises subagent dispatch via `Skill()`/`Agent()`."

## Current State Analysis

Three source skills total **1,089 lines** of SKILL.md prose:

| Source | Lines | Shape | Side effects | Model |
|---|---|---|---|---|
| `plugin/ralph-hero/skills/research/SKILL.md` | 406 | Interactive: question/issue intake → parallel Agent dispatch → human review picker → write doc → optional artifact comment → next-steps picker | Writes research doc; optional issue comment | opus |
| `plugin/ralph-hero/skills/ralph-research/SKILL.md` | 506 | Autonomous: pick XS/S Research-Needed issue → lock → registry lookup → knowledge-graph prior-art → parallel Agent dispatch → write findings → advance to Ready for Plan | Writes research doc; **writes** to project board (lock + advance) | sonnet |
| `plugin/ralph-hero/skills/prove-claim/SKILL.md` | 177 | 5-step: decompose claim → find entity docs → trace graph paths → read evidence → produce verdict + confidence + evidence chains | Read-only over knowledge graph | opus |

The autonomous flow (`ralph-research`) has five hook scripts under `plugin/ralph-hero/hooks/scripts/` (total 292 lines):

| Hook | Trigger | Job |
|---|---|---|
| `research-state-gate.sh` | PostToolUse on `ralph_hero__get_issue` | Validate the fetched issue is in a state allowed for research-lock (default: "Research Needed") |
| `research-postcondition.sh` | Stop | Verify a research doc with the locked ticket ID was written in the last 30 min |
| `doc-structure-validator.sh` | Stop | Validate required sections in the generated doc — frontmatter, Prior Work, Files Affected |
| `branch-gate.sh` | PreToolUse on Bash | Refuse non-allowlisted git commands while the autonomous flow is on a non-main branch |
| `lock-release-on-failure.sh` | Stop | Release the workflow lock if research failed mid-flow (returns issue to "Research Needed") |

Each script gates on `RALPH_COMMAND` and/or `RALPH_TICKET_ID` env vars (set by the SessionStart hook), so they no-op when the autonomous flow is not active. That's exactly the property we need to scope them to `--mode auto`.

Plan 2's `ralph/` plugin state at start of Plan 3:

- `ralph/skills/{catch-up,form}/` shipped (Plan 1 + Plan 2).
- `ralph/hooks/hooks.json` declares one plugin-wide SessionStart (`set-skill-env.sh`) and one plugin-wide PostToolUse (`cursor-advance-catch-up.sh` on recent_activity).
- `ralph/hooks/scripts/{set-skill-env.sh, cursor-advance-catch-up.sh, hook-utils.sh}` ported from the source plugin.
- No per-skill SKILL.md `hooks:` frontmatter used yet. Plan 3 introduces this pattern (skills CAN declare hooks; only agents are restricted per `ralph-hero/CLAUDE.md`).

### Key Discoveries

- **The three modes are structurally separable.** Interactive flow asks for input + uses AskUserQuestion for finding review. Autonomous flow picks an issue, locks, never asks. Prove-claim accepts a single claim string + does no codebase research. Sharing the workflow body is wasteful; a `--mode` dispatcher with distinct sub-flows is cleaner.
- **The interactive Step 6 (AskUserQuestion findings review) and Step 10 (next-steps picker) are the load-bearing UX in `research`.** They survive verbatim into the default-mode body.
- **`ralph-research` Step 3c-3d (knowledge-graph prior art + domain expert primer)** is structurally identical to `research` Step 2.5. Both should consult the same `research-shapes.md` reference for the knowledge-graph dispatch shape, with the distinction (autonomous never asks, interactive may surface to user) carried in the workflow body, not the reference.
- **`prove-claim`'s 5-step workflow is its own animal.** It does NOT invoke codebase-locator/analyzer agents — it lives entirely in the knowledge graph. Evidence weighting, confidence calibration, and anti-patterns are stable content that move verbatim into `prove-claim.md`.
- **`research-postcondition.sh` and `doc-structure-validator.sh` both fire on Stop.** They depend on `RALPH_TICKET_ID` (set by the autonomous flow's lock step) and `RALPH_COMMAND=research`. Interactive flow never sets these env vars; prove-mode doesn't either. So porting the hooks to fire on Stop is safe even though Stop fires for every mode — the hooks themselves are guarded.
- **`branch-gate.sh` only fires when `RALPH_REQUIRED_BRANCH` is set.** Same gating pattern.
- **Playwright baseline (Step 6.5 in interactive / Step 7.5 in autonomous) is shared.** Move into `playwright-baseline.md` — both modes consult the same reference for dev-server lifecycle + journey-trace synthesis + tooling detection.
- **No shared code between research and form/catch-up.** The cross-plugin MCP tools used (`get_issue`, `save_issue`, `list_issues`, `create_comment`) are also used by form's intake, so the cross-plugin pattern is established. No new MCP tools needed.
- **Cross-repo registry lookup** (autonomous Step 3a, `.ralph-repos.yml`) is a real production feature. Port into `research-shapes.md` as an optional section consulted only when the issue may span multiple repos.
- **Outcome recording (`knowledge_record_outcome`) is autonomous-only.** The interactive flow does not advance state or record outcomes — the human owns those transitions. Keeps the autonomous-mode body distinct.
- **The `## Files Affected` section is autonomous-flow-validated** (by `doc-structure-validator.sh`). Interactive flow does not require it. So findings-format.md must call out which sections are required by which mode.

## Desired End State

After Plan 3 merges:

1. `/ralph:research` is discoverable in any fresh Claude Code session under the ralph plugin.
2. `/ralph:research` with no args prompts the user for a research question or issue number, mirroring today's `/ralph-hero:research` interactive flow.
3. `/ralph:research "<question>"` runs the interactive flow on the question.
4. `/ralph:research #NNN` (or `NNN`) fetches the issue and uses its title/body as the research question; supports linking back via artifact comment in Step 9.
5. `/ralph:research --no-playwright` (or `--playwright`) overrides the Playwright baseline detection.
6. `/ralph:research --mode auto [#NNN]` runs the autonomous flow: picks an XS/S issue in "Research Needed" (or uses the explicit issue), locks it, researches, writes findings, advances to "Ready for Plan". No human questions. The five autonomous hooks gate the flow.
7. `/ralph:research --mode prove "<claim>"` runs the 5-step claim investigation: produces a verdict (supported / contradicted / partially supported / insufficient evidence), confidence score, and evidence chains with verbatim quotes. No codebase research, knowledge-graph only.
8. `/ralph:research --help` / `-h` prints the mode table.
9. Old `ralph-hero:*` skills (`research`, `ralph-research`, `prove-claim`) remain functional and untouched. Sunset is Plan 10.
10. `ralph/skills/research/SKILL.md` is ≤ 200 lines (target ~170 — the multi-mode dispatcher carries more workflow than catch-up/form).
11. Opinion content lives in five flat-sibling reference files: `intake-routing.md`, `research-shapes.md`, `findings-format.md`, `prove-claim.md`, `playwright-baseline.md`.
12. SKILL.md `hooks:` frontmatter declares five hooks scoped to `--mode auto` only (state gate, postcondition, doc validator, branch gate, lock release).
13. `ralph/README.md` migration table shows Plan 3 as "shipped".
14. Friction-log entry appended to the spec doc.

### Verification

- `/plugin marketplace update ralph-hero && /reload-plugins` discovers `/ralph:research` without errors.
- Three real interactive `/ralph:research` invocations: one with a free-form question, one with an issue number, one mid-flow correction via the Step 6 picker.
- One `/ralph:research --mode auto` invocation against a real XS issue in "Research Needed" — verify lock, doc, advance to "Ready for Plan", outcome recording.
- One `/ralph:research --mode prove "<claim>"` invocation — verify verdict shape, confidence calibration, evidence chains.
- `wc -l ralph/skills/research/SKILL.md` reports ≤ 200.
- Five reference siblings present, each non-stub.
- Old `/ralph-hero:research`, `/ralph-hero:ralph-research`, `/ralph-hero:prove-claim` still work unchanged.
- `ralph/hooks/scripts/{research-state-gate,research-postcondition,doc-structure-validator,branch-gate,lock-release-on-failure}.sh` present and executable.

## What We're NOT Doing

- **Not** porting `remember-turn.sh` (the source ralph-research Stop hook). It's a memory-tier writer that depends on host-process memory paths; that's substrate concern, not verb concern. Plan 3 leaves memory writes to the catch-up cursor model and the dream-loop pipeline.
- **Not** consolidating the knowledge-graph step body across interactive and autonomous modes into a shared step block. The two modes legitimately differ (interactive may skip, autonomous always runs). Keep them in separate workflow sections; share only the reference.
- **Not** introducing a `--mode interactive` flag. Default is interactive; `--mode auto` / `--mode prove` are the explicit non-defaults. Mirrors `/ralph:form`'s `--mode draft` shape (default + one alternative).
- **Not** changing the doc filename convention (`YYYY-MM-DD-GH-NNNN-description.md`). Keeps Plan 10 sunset trivial.
- **Not** porting cross-repo dependency detection (autonomous Step 3b) into a top-level reference. It's mode-specific (auto only) and infrequent; lives as a section in `research-shapes.md` consulted conditionally.
- **Not** adding a hook to validate prove-mode verdicts. The verdict format is opinion-content (in `prove-claim.md`); enforcing it in a hook would be P5 violation (references are content, not control flow).
- **Not** absorbing `idea-hunt`. Per spec, `idea-hunt` is excluded from the new plugin.
- **Not** sunsetting source skills. They remain functional alongside the new verb until Plan 10 batches sunsets after each new counterpart has handled the surfaces it replaces.

## Implementation Approach

Six XS-sized phases, each owning a tightly-scoped file set:

1. **Scaffold + dispatch skeleton** owns: `ralph/skills/research/SKILL.md` (stub with frontmatter + mode-dispatch table + Step 0 arg parse), five empty reference stubs, `ralph/hooks/scripts/{research-state-gate,research-postcondition,doc-structure-validator,branch-gate,lock-release-on-failure}.sh` ports.
2. **Default flow — intake + parallel research** owns: `ralph/skills/research/SKILL.md` (default-mode Steps 1-4: intake → knowledge graph → parallel sub-agent dispatch → wait), `ralph/skills/research/intake-routing.md` (issue vs question vs no-args fallback), `ralph/skills/research/research-shapes.md` (sub-agent palette + dispatch patterns + cross-repo addendum).
3. **Default flow — review, doc, handoff** owns: `ralph/skills/research/SKILL.md` (default-mode Steps 5-10: AskUserQuestion findings review → doc generation → optional artifact comment → next-steps picker), `ralph/skills/research/findings-format.md` (doc shape, frontmatter, Prior Work, Files Affected, Cross-Repo Scope, Pipeline History — including a per-mode required-sections matrix), `ralph/skills/research/playwright-baseline.md` (dev-server lifecycle + explorer-agent dispatch + journey-trace synthesis).
4. **`--mode auto`** owns: `ralph/skills/research/SKILL.md` (auto-mode body: pick issue → lock → research → write → advance + outcome record), SKILL.md frontmatter `hooks:` block scoped to auto-mode triggers.
5. **`--mode prove`** owns: `ralph/skills/research/SKILL.md` (prove-mode body: 5-step claim investigation), `ralph/skills/research/prove-claim.md` (evidence weighting + 5-step workflow + confidence calibration + anti-patterns + graceful degradation).
6. **Parity validation + dogfooding** owns: `ralph/README.md`, `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (append-only friction-log entry).

Only `ralph/skills/research/SKILL.md` is touched in multiple phases — each appends a discrete section. The reference files are single-owner.

## Phase 1: Scaffold + dispatch skeleton

### Overview

Stand up the directory structure with the skill stub + five reference siblings + five autonomous-flow hook scripts. The stub carries frontmatter (including the `hooks:` block scoped to `--mode auto`), the mode-dispatch table, and arg-parse skeleton.

### Changes Required

#### 1. Skill scaffold

**File**: `ralph/skills/research/SKILL.md`

Stub carries:

- Description (covers all three modes + trigger phrasing for natural-language invocation).
- `argument-hint: "[--mode auto|prove] [<question|#NNN|claim>] [--playwright|--no-playwright]"`
- `context: inline`
- `model: opus` (matches source for interactive + prove; auto-mode runs at the same model — opus → sonnet downgrade for autonomous is a separate model-tier-policy decision, not load-bearing for the fold).
- `allowed-tools` union: `Read, Write, Edit, Glob, Grep, Bash, Task, Agent, AskUserQuestion, WebSearch, WebFetch`, plus the cross-plugin MCP tools (`get_issue`, `list_issues`, `save_issue`, `create_comment`, `add_dependency`, `remove_dependency`) and knowledge-graph tools (`knowledge_search`, `knowledge_recall`, `knowledge_traverse`, `knowledge_query_outcomes`, `knowledge_record_outcome`, `knowledge_expert`, `knowledge_communities`, `knowledge_central`, `knowledge_bridges`, `knowledge_paths`, `knowledge_common`).
- `hooks:` block (declared in skill frontmatter):
  - SessionStart → `set-skill-env.sh RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main` (only when `--mode auto` is the invocation; if `set-skill-env.sh` already handles the no-args path as a no-op, the hook can fire unconditionally and the script self-gates).
  - PreToolUse on Bash → `branch-gate.sh`
  - PostToolUse on `ralph_hero__get_issue` → `research-state-gate.sh`
  - Stop → `research-postcondition.sh`, `doc-structure-validator.sh`, `lock-release-on-failure.sh`
- Body: mode-dispatch table + Step 0 (arg parse) + section placeholders for the three modes.

The mode-dispatch table:

```markdown
| Mode | Behavior | Equivalent to |
|---|---|---|
| (default) | Interactive: question/issue intake → parallel sub-agents → findings review → write doc → optional artifact comment | `/ralph-hero:research` |
| `--mode auto [#NNN]` | Autonomous: pick / lock XS/S Research-Needed issue → research → write findings → advance to Ready for Plan | `/ralph-hero:ralph-research` |
| `--mode prove "<claim>"` | Knowledge-graph claim investigation: 5-step evidence reasoning → verdict + confidence + evidence chains | `/ralph-hero:prove-claim` |
| `--help` / `-h` | Print this table and exit | — |
```

Step 0 (arg parse) sets `MODE` ∈ `{default, auto, prove}`, captures `ARG` (question / issue number / claim), and the `--playwright` / `--no-playwright` flags. Default to `MODE=default` if no flag given.

#### 2. Reference siblings (empty stubs)

- `ralph/skills/research/intake-routing.md` — `# Intake routing\n\n_Filled by Phase 2._`
- `ralph/skills/research/research-shapes.md` — `# Research shapes\n\n_Filled by Phase 2._`
- `ralph/skills/research/findings-format.md` — `# Findings format\n\n_Filled by Phase 3._`
- `ralph/skills/research/playwright-baseline.md` — `# Playwright baseline\n\n_Filled by Phase 3._`
- `ralph/skills/research/prove-claim.md` — `# Prove-claim investigation\n\n_Filled by Phase 5._`

#### 3. Hook script ports

Copy from `plugin/ralph-hero/hooks/scripts/` into `ralph/hooks/scripts/`:

- `research-state-gate.sh`
- `research-postcondition.sh`
- `doc-structure-validator.sh`
- `branch-gate.sh`
- `lock-release-on-failure.sh`

The scripts source `hook-utils.sh` (already present in `ralph/hooks/scripts/`). Verify each script sources via `$(dirname "$0")/hook-utils.sh` so the ported path works.

#### 4. No changes to `ralph/hooks/hooks.json`

The plugin-root hooks file stays scoped to plugin-wide concerns (SessionStart `set-skill-env.sh` + PostToolUse `cursor-advance-catch-up.sh`). Per-skill hooks live in `ralph/skills/research/SKILL.md` frontmatter.

### Success Criteria

#### Automated Verification

- [ ] `test -f ralph/skills/research/SKILL.md`
- [ ] `[ "$(wc -l < ralph/skills/research/SKILL.md)" -le 200 ]`
- [ ] All five references present: `for f in intake-routing research-shapes findings-format playwright-baseline prove-claim; do test -f "ralph/skills/research/$f.md" || exit 1; done`
- [ ] All five hooks present and executable: `for h in research-state-gate research-postcondition doc-structure-validator branch-gate lock-release-on-failure; do test -x "ralph/hooks/scripts/$h.sh" || exit 1; done`
- [ ] SKILL.md frontmatter references the hooks: `grep -q 'research-state-gate.sh' ralph/skills/research/SKILL.md && grep -q 'research-postcondition.sh' ralph/skills/research/SKILL.md`

#### Manual Verification

- [ ] After `/reload-plugins`, `/ralph:research --help` returns the mode table.

#### Per-phase audit (spec criterion #6)

- [ ] Dispatch `/review` (PR or branch diff) and `/skill-creator:skill-creator` (against the partial bundle under `ralph/skills/research/`) in parallel via two `Agent()` calls in a single message. Apply recommended fixes — or record why not in the friction log — before proceeding to Phase 2.

---

## Phase 2: Default flow — intake + parallel research

### Overview

Wire the default (interactive) flow's first half: intake routing, knowledge-graph prior-art (when ralph-knowledge is available), and parallel sub-agent dispatch.

### Changes Required

#### 1. Default-flow Steps 1-4 body in SKILL.md

**File**: `ralph/skills/research/SKILL.md`

Sections to add (~40 lines):

- **Step 1: Intake** — if `ARG` is `#NNN` or `NNN`, fetch via `get_issue`, set `LINKED_ISSUE=NNN`, use title/body as the question. If `ARG` is a free-form string, treat as the question. If no `ARG`, prompt the user (mirrors source Step 1 fallback). Read mentioned files (`Read`, no offset/limit) before any sub-agent dispatch — keeps full context in the main session. Consult `intake-routing.md` for full detection rules.
- **Step 2: Knowledge-graph prior art (optional)** — if `knowledge_recall` / `knowledge_search` / `knowledge_query_outcomes` are available, run the brief-first prior-art dispatch per `research-shapes.md`. Skip silently if unavailable.
- **Step 3: Parallel sub-agent dispatch** — consult `research-shapes.md` for the sub-agent palette (codebase-locator, codebase-analyzer, codebase-pattern-finder, thoughts-locator, thoughts-analyzer, web-search-researcher when explicitly requested). Spawn in parallel via multiple `Agent()` calls in a single message. Pass cross-repo paths in the prompt when the registry lookup flags multi-repo scope (consult `research-shapes.md` § Cross-repo addendum).
- **Step 4: Wait + synthesize** — wait for ALL sub-agents to complete. Synthesize findings, prioritizing live codebase findings over thoughts-derived historical context. Hold synthesis in the main session for Step 5 review.

#### 2. `intake-routing.md` — replace stub

Port the source-`research`-Steps-1-2 detection rules + Step 1 source's no-args prompt. Sections:

- **Issue-number detection**: `#NNN`, `NNN`, or `GH-NNNN` arg → `get_issue`, set `LINKED_ISSUE`.
- **Free-form question detection**: anything else not starting with `--` → treat as the question.
- **No-args fallback**: prompt with the source's "I'm ready to research…" message and wait for input.
- **File reading rule**: when the user mentions specific files by path, read them FULLY (no offset/limit) before any sub-agent dispatch. This is load-bearing — sub-agents lack the main session's context.

Target ~50 lines.

#### 3. `research-shapes.md` — replace stub

Port the source's sub-agent palette + parallel-dispatch guidance + cross-repo addendum + knowledge-graph dispatch shape. Sections:

- **Sub-agent palette**: codebase-locator (WHERE), codebase-analyzer (HOW), codebase-pattern-finder (similar implementations), thoughts-locator (existing docs), thoughts-analyzer (extract key findings), web-search-researcher (external — explicit request only).
- **Parallel dispatch rule**: dispatch all relevant agents in a single message via multiple `Agent()` calls. Wait for ALL before synthesizing. Do NOT pass `team_name` to sub-agent calls (team-isolation per ADR).
- **Documentarian-not-critic constraint**: sub-agents document what IS, not what SHOULD BE. Restate this constraint when delegating in cases the agent might drift.
- **Knowledge-graph dispatch shape** (used by Step 2 in default, Step 3c-3d in auto): brief-first `knowledge_recall` per role / type, `knowledge_query_outcomes` when a component area is identifiable, `knowledge_expert` when a domain can be extracted.
- **Cross-repo addendum**: when `.ralph-repos.yml` exists, read it (via `Read`, not `decompose_feature`), detect multi-repo signals, pass additional repo dirs to sub-agent prompts. Repo-qualified file paths (`ralph-hero:src/...`) required for cross-repo Files Affected entries.

Target ~80 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/research/SKILL.md)" -le 200 ]`
- [ ] `intake-routing.md` non-stub: `[ "$(wc -l < ralph/skills/research/intake-routing.md)" -ge 30 ]`
- [ ] `research-shapes.md` non-stub: `[ "$(wc -l < ralph/skills/research/research-shapes.md)" -ge 50 ]`
- [ ] SKILL.md references both: `grep -q 'intake-routing.md' ralph/skills/research/SKILL.md && grep -q 'research-shapes.md' ralph/skills/research/SKILL.md`

#### Manual Verification

- [ ] `/ralph:research "how does the catch-up cursor work?"` triggers parallel sub-agent dispatch; agents complete; synthesis is held in the main session for review.
- [ ] `/ralph:research #1357` fetches the issue and uses it as the question.
- [ ] `/ralph:research` with no args prompts for input.

#### Per-phase audit (spec criterion #6)

- [ ] Dispatch `/review` and `/skill-creator:skill-creator` in parallel against the partial bundle. Apply fixes — or record why not — before proceeding to Phase 3.

---

## Phase 3: Default flow — review, doc, handoff + Playwright baseline

### Overview

Wire the default flow's back half: AskUserQuestion findings review, doc generation, optional Playwright UI baseline, optional artifact comment, next-steps picker.

### Changes Required

#### 1. Default-flow Steps 5-10 body in SKILL.md

**File**: `ralph/skills/research/SKILL.md`

Sections to add (~50 lines):

- **Step 5: Present findings for review** — `AskUserQuestion` with 3 options (Looks good, write it / Go deeper on a topic / Correct something). Route: write proceeds to Step 6; deeper or correction loops back to additional sub-agent dispatch then re-presents.
- **Step 6: Gather metadata + write doc** — `git rev-parse HEAD`, `date +%Y-%m-%d`, `git branch --show-current`. Write to `thoughts/shared/research/YYYY-MM-DD-[GH-NNNN-]description.md` per `findings-format.md`.
- **Step 6.5: Playwright UI baseline (conditional)** — consult `playwright-baseline.md`. Skip if `--no-playwright`. If `--playwright` or frontend-relevant findings + ralph-playwright installed: detect, prompt user, capture, append `## UI Baseline` section.
- **Step 7: GitHub permalinks** — if on main/pushed, convert local file references to permalinks per `findings-format.md`.
- **Step 8: Optional artifact comment** — if `LINKED_ISSUE` set or user asks to link: rename file to include `GH-NNNN`, update frontmatter, post `## Research Document` comment on the issue.
- **Step 9: Next-steps picker** — `AskUserQuestion` with 3 options (Create issue from findings → `/ralph:form <path>` / Ask follow-up questions / Done). Loop on follow-ups via Step 10.
- **Step 10: Follow-up handling** — append to the same doc, update `last_updated` frontmatter, spawn targeted sub-agents.

#### 2. `findings-format.md` — replace stub

Port the source's doc structure + frontmatter + Prior Work + Files Affected + Cross-Repo Scope sections. Sections:

- **Frontmatter shape**: `date`, `github_issue` (optional), `github_url` (optional), `topic`, `tags`, `status: complete`, `type: research`.
- **Filename convention**: `YYYY-MM-DD-[GH-NNNN-]description.md`; rename rules when linking post-write.
- **Section order**: Title → Prior Work → Research Question → Summary → Detailed Findings → Code References → Architecture Documentation → Historical Context → Related Research → Open Questions.
- **Prior Work section**: `builds_on::` / `tensions::` wikilinks, evidence-weighting qualifiers (research / review / plan / idea — primary / secondary / weak / weakest).
- **Files Affected section** (required by autonomous flow; recommended for interactive): `### Will Modify` and `### Will Read (Dependencies)` subsections, backtick-wrapped paths, cross-repo prefixing rule.
- **Pipeline History section** (optional, autonomous-only): populated from `knowledge_query_outcomes` results.
- **Cross-Repo Scope section** (optional): repos involved, dependency relationship.
- **Per-mode required-sections matrix**: which sections are required vs optional per mode. The `doc-structure-validator.sh` hook enforces this for `--mode auto` only.

Target ~90 lines.

#### 3. `playwright-baseline.md` — replace stub

Port the source's Step 6.5 / Step 7.5 baseline-capture flow (identical content in both source skills). Sections:

- **Detection**: read `~/.claude/plugins/installed_plugins.json`, check for a key containing `ralph-playwright`.
- **Frontend-relevance heuristic**: affected file types (`.tsx`/`.jsx`/`.css`/`.html`/`.vue`/`.svelte`), component directories, route/page modifications, UI/UX/visual/accessibility concerns. `--playwright` overrides; `--no-playwright` skips.
- **Dev-server lifecycle**: resolve via `RALPH_PLAYWRIGHT_DEV_CMD` env → memory → `package.json` autodetect. Start via `Bash(command, run_in_background=true)`; poll via curl every 2s, timeout 30s. Teardown via `RALPH_PLAYWRIGHT_DEV_TEARDOWN_CMD` or kill PID.
- **Explorer-agent dispatch**: `Agent(subagent_type="ralph-playwright:explorer-agent", prompt="Explore http://localhost:<port> with goal: capture accessibility baseline and key user flows. Session: <date>-baseline-GH-NNN", description="UI baseline GH-NNN")`.
- **Tooling detection** (in parallel): `playwright-stories/` count, storybook addon presence, visual-regression tool presence.
- **Journey-trace synthesis**: read `.playwright-cli/<session>/journey-trace.yaml`, append `## UI Baseline` section to the research doc with accessibility / flow state / tooling subsections.

Target ~70 lines.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/research/SKILL.md)" -le 200 ]`
- [ ] `findings-format.md` non-stub: `[ "$(wc -l < ralph/skills/research/findings-format.md)" -ge 60 ]`
- [ ] `playwright-baseline.md` non-stub: `[ "$(wc -l < ralph/skills/research/playwright-baseline.md)" -ge 40 ]`
- [ ] `findings-format.md` carries Files Affected template: `grep -q 'Will Modify' ralph/skills/research/findings-format.md && grep -q 'Will Read' ralph/skills/research/findings-format.md`
- [ ] SKILL.md references both: `grep -q 'findings-format.md' ralph/skills/research/SKILL.md && grep -q 'playwright-baseline.md' ralph/skills/research/SKILL.md`

#### Manual Verification

- [ ] `/ralph:research "<some question>"` runs end-to-end through the default flow: synth → AskUserQuestion review → doc write → next-steps picker.
- [ ] `/ralph:research #1357` produces a doc with proper `GH-1357` filename, frontmatter linking, and posts the artifact comment when the user agrees.
- [ ] `/ralph:research --no-playwright "<frontend topic>"` skips the baseline section even when frontend-relevant.

#### Per-phase audit (spec criterion #6)

- [ ] Dispatch `/review` and `/skill-creator:skill-creator` in parallel. Apply fixes — or record why not — before proceeding to Phase 4.

---

## Phase 4: `--mode auto` (autonomous flow)

### Overview

Wire the autonomous-mode body. Mirrors today's `/ralph-hero:ralph-research` — no questions, picks an issue, locks, researches, writes, advances, records outcome.

### Changes Required

#### 1. Auto-mode body in SKILL.md

**File**: `ralph/skills/research/SKILL.md`

Sections to add (~40 lines):

- **Auto Step 1: Branch check** — verify `git branch --show-current == main`. If not, STOP. (Also enforced by `branch-gate.sh`, but the workflow body documents the precondition.)
- **Auto Step 2: Select issue** — if `ARG` is `#NNN`, fetch it. Else `list_issues` with `profile: "analyst-research"`, filter to XS/Small, filter unblocked (consult `intake-routing.md` § Blocker semantics), pick highest priority. If none eligible, exit cleanly.
- **Auto Step 3: Lock + registry + knowledge-graph** — `save_issue(number, workflowState: "__LOCK__", command: "ralph_research")`. Then registry lookup per `research-shapes.md` § Cross-repo addendum; then knowledge-graph prior art per `research-shapes.md` § Knowledge-graph dispatch shape.
- **Auto Step 4: Parallel sub-agent research** — same dispatch shape as default Step 3, but no AskUserQuestion review. Sub-agents complete → synthesize → write.
- **Auto Step 5: Write doc** — per `findings-format.md` (including required Files Affected + optional Pipeline History + optional Cross-Repo Scope).
- **Auto Step 5.5: Playwright baseline (conditional)** — same conditional logic as default Step 6.5. Commit the updated doc if baseline is appended.
- **Auto Step 6: Commit + push** — `git add thoughts/shared/research/...` → `git commit -m "docs(research): GH-NNN research findings"` → `git push origin main`.
- **Auto Step 7: Post artifact comment + advance + record outcome** — `create_comment` with `## Research Document` linking the pushed doc → `save_issue(number, workflowState: "__COMPLETE__", command: "ralph_research")` (moves to Ready for Plan) → `knowledge_record_outcome(event_type: "research_completed", issue_number: NNN, component_area: "<area>", verdict: "complete", model: "<model>", agent_type: "analyst", query_id: "<from-step-3-if-set>")` if available.
- **Auto Step 8: Report** — terse single-block summary (no AskUserQuestion).

#### 2. SKILL.md frontmatter `hooks:` block (added in Phase 1, validated here)

Verify Phase 1's hook block fires correctly under `--mode auto`:

- The five hook scripts are present (Phase 1 verification).
- Each script gates on `RALPH_COMMAND` / `RALPH_TICKET_ID` / `RALPH_REQUIRED_BRANCH` so they no-op when invoked outside auto-mode.
- `set-skill-env.sh` is called via SessionStart with `RALPH_COMMAND=research RALPH_REQUIRED_BRANCH=main` args; need to verify the slim plugin's `set-skill-env.sh` correctly parses those.

If `set-skill-env.sh` requires modification to handle the args robustly (Phase 1 left it as-is), patch in this phase. Verify by running the auto flow against a real issue and confirming the env vars are exported.

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/research/SKILL.md)" -le 200 ]`
- [ ] SKILL.md auto-mode body present: `awk '/^## --mode auto/,/^## --mode prove/' ralph/skills/research/SKILL.md | grep -q 'workflowState' && grep -q '__LOCK__'`
- [ ] Frontmatter hooks block carries all five hooks: `grep -c 'hooks/scripts/' ralph/skills/research/SKILL.md | xargs -I {} test {} -ge 5`

#### Manual Verification

- [ ] `/ralph:research --mode auto` against a real XS issue in "Research Needed":
  - Issue locks (workflowState moves to "Research in Progress").
  - Sub-agents dispatch in parallel.
  - Doc is written with required sections (frontmatter, Prior Work, Files Affected, Detailed Findings).
  - `doc-structure-validator.sh` passes (Stop exit 0).
  - Doc is committed + pushed to main.
  - `## Research Document` artifact comment posted on the issue.
  - Issue advances to "Ready for Plan".
  - `knowledge_record_outcome` records the event (when the tool is available).
- [ ] `/ralph:research --mode auto` from a non-main branch fails fast with the branch-gate message.
- [ ] If the auto flow fails mid-way, `lock-release-on-failure.sh` releases the issue back to "Research Needed".

#### Per-phase audit (spec criterion #6)

- [ ] Dispatch `/review` and `/skill-creator:skill-creator` in parallel. Apply fixes — or record why not — before proceeding to Phase 5.

---

## Phase 5: `--mode prove` (claim investigation)

### Overview

Wire the prove-claim mode. No codebase research — pure knowledge-graph reasoning.

### Changes Required

#### 1. Prove-mode body in SKILL.md

**File**: `ralph/skills/research/SKILL.md`

Sections to add (~15 lines):

- **Prove Step 1: Decompose claim** — accept `ARG` as the claim string. Decompose into 2-5 entities + a relationship per `prove-claim.md` § Decomposition.
- **Prove Step 2: Find entity documents** — `knowledge_search` per entity (brief mode); record top 3 doc IDs per entity. Skip codebase-locator/analyzer entirely.
- **Prove Step 3: Find connections** — `knowledge_paths`, `knowledge_traverse`, `knowledge_common` to trace paths between entity documents. Degradation per `prove-claim.md` § Graceful degradation.
- **Prove Step 4: Read evidence** — `Read` top 3-5 docs by path. Extract verbatim quotes. Note doc type / date / status.
- **Prove Step 5: Report** — produce verdict per `prove-claim.md` § Report template. No file write; output the verdict block inline.

The body is thin — most content lives in `prove-claim.md`.

#### 2. `prove-claim.md` — replace stub

Port the source `prove-claim/SKILL.md` workflow + evidence-weighting + confidence-calibration + anti-patterns + graceful-degradation sections. Sections:

- **Evidence weighting**: research (primary) / review (secondary) / plan (weak) / idea (weakest) — verbatim from source lines 25-35.
- **Decomposition rules**: how to break a claim into entities + relationship.
- **Step-by-step workflow detail**: what each of the 5 steps does, what tools to use, what to record.
- **Confidence calibration**: 0.8-1.0 / 0.5-0.7 / 0.2-0.4 / 0.0-0.1 table with typical evidence profiles.
- **Anti-patterns**: community co-membership / hub-node paths / plan documents as proof / path existence / paraphrase-as-evidence.
- **Graceful degradation**: graph algorithm unavailable → fall back to traversal; brief mode unsupported → limit results; entity search zero results → broaden / report "not found"; paths exist but irrelevant intermediaries → structurally weak.
- **Report template**: `## Claim Investigation Report` with Claim / Verdict / Confidence / Evidence Chains / Document Type Qualifications / Graph Connection Summary / Caveats / What Would Change This Verdict.

Target ~120 lines (matches source content closely; this is the densest reference).

### Success Criteria

#### Automated Verification

- [ ] SKILL.md line count: `[ "$(wc -l < ralph/skills/research/SKILL.md)" -le 200 ]`
- [ ] `prove-claim.md` non-stub: `[ "$(wc -l < ralph/skills/research/prove-claim.md)" -ge 80 ]`
- [ ] `prove-claim.md` carries the evidence-weighting table: `grep -q 'Primary' ralph/skills/research/prove-claim.md && grep -q 'Weakest' ralph/skills/research/prove-claim.md`
- [ ] `prove-claim.md` carries the report template: `grep -q 'Claim Investigation Report' ralph/skills/research/prove-claim.md && grep -q 'What Would Change This Verdict' ralph/skills/research/prove-claim.md`
- [ ] SKILL.md prove-mode references `prove-claim.md`: `awk '/^## --mode prove/,/^## References/' ralph/skills/research/SKILL.md | grep -q 'prove-claim.md'`

#### Manual Verification

- [ ] `/ralph:research --mode prove "<a claim>"` produces:
  - 2-5 entity decomposition.
  - knowledge_search dispatch (skips codebase-locator/analyzer).
  - Verdict block with verdict + confidence + ≥1 evidence chain with verbatim quote.
  - Anti-patterns avoided (no community co-membership, no path-existence-as-proof).
- [ ] `/ralph:research --mode prove "<claim against missing entities>"` reports "insufficient evidence" rather than inventing.

#### Per-phase audit (spec criterion #6)

- [ ] Dispatch `/review` and `/skill-creator:skill-creator` in parallel. Apply fixes — or record why not — before proceeding to Phase 6.

---

## Phase 6: Parity validation + dogfooding setup

### Overview

Final parity validation across real sessions, README update, friction-log entry.

### Changes Required

#### 1. README migration table

**File**: `ralph/README.md`
**Changes**:

```diff
-| 3 | `/ralph:research` | pending |
+| 3 | `/ralph:research` | shipped |
```

Update the `## Status` paragraph to "Plan 3 of 11 (research shipped). This plugin currently exposes three user-facing skills (`/ralph:catch-up`, `/ralph:form`, `/ralph:research`)."

#### 2. Friction-log entry on the spec

**File**: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`
**Changes**: Append a `### Plan 3: /ralph:research (shipped YYYY-MM-DD)` subsection under `## Friction Log`. Capture final-shape stats, design calls (5-reference threshold, SKILL.md `hooks:` frontmatter pattern), TODO checkboxes for active-use observations.

#### 3. Parity validation runs

No file changes. Execute five real `/ralph:research` invocations:

1. `/ralph:research "<some question>"` → default flow, no linked issue, no Playwright.
2. `/ralph:research #<some-issue>` → default flow, linked-issue path, artifact comment.
3. `/ralph:research "<frontend-relevant question>"` → default flow, Playwright baseline captured.
4. `/ralph:research --mode auto` → autonomous flow against a real Research-Needed XS issue. Verify lock + advance + outcome record.
5. `/ralph:research --mode prove "<claim>"` → verdict report.

Record observations in the friction-log entry.

### Success Criteria

#### Automated Verification

- [ ] `grep -q '| 3 | \`/ralph:research\` | shipped |' ralph/README.md`
- [ ] `grep -q 'Plan 3 of 11' ralph/README.md`
- [ ] Plan 3 friction-log subsection exists: `grep -q '### Plan 3:' thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md`

#### Manual Verification

- [ ] Five real `/ralph:research` invocations completed (one per mode + parameter shape).
- [ ] Each session produces equivalent output to the corresponding old skill.
- [ ] No regressions in `/ralph-hero:research`, `/ralph-hero:ralph-research`, `/ralph-hero:prove-claim`.

#### Per-phase audit (spec criterion #6)

- [ ] Final audit against the complete bundle before opening the PR. Dispatch `/review` (full PR) and `/skill-creator:skill-creator` (full `ralph/skills/research/` bundle) in parallel. Apply fixes — or record why not.

---

## Testing Strategy

### Unit Tests

None. Skill is markdown workflow; MCP tools it consumes are covered by the ralph-hero MCP server's existing test suite.

### Integration Tests

The "5 real sessions" parity check in Phase 6 is the integration test. The autonomous-mode session exercises the five hooks end-to-end (state gate on lock, postcondition on doc, doc-structure-validator on Stop, branch-gate on bash, lock-release on a forced failure).

### Manual Testing Steps

Per Phase 6's verification list, plus:

1. Verify the autonomous flow's lock-release-on-failure path: simulate a mid-flow failure (e.g., raise a non-zero exit inside the skill body) and confirm the issue returns to "Research Needed".
2. Verify the doc-structure-validator catches a missing `## Files Affected` section in auto-mode (write a doc without it; confirm Stop exits 2).
3. Verify the branch-gate refuses to run from a non-main branch.
4. Verify the knowledge-graph degradation paths: temporarily disable the ralph-knowledge MCP server; confirm the default + auto flows complete via `thoughts-locator` only, with the "Knowledge graph unavailable" footnote in Prior Work; confirm prove-mode falls back to traversal + combined-term searches.

## Performance Considerations

- Default flow: 4-6 parallel sub-agent dispatches + 1-2 AskUserQuestion calls + 1 Write + optional Playwright explorer-agent. Mirrors today's `/ralph-hero:research`. No new latency.
- Auto flow: same dispatch profile + 2 `save_issue` mutations + 1 `create_comment` + optional `knowledge_record_outcome`. Mirrors today's `/ralph-hero:ralph-research`. Constrained to 15 minutes per source convention.
- Prove flow: 2-5 `knowledge_search` calls + 1-3 `knowledge_paths/traverse/common` calls + 1-5 `Read` calls. Fastest path; no codebase research. No new latency.

## Migration Notes

- Source skills (`research`, `ralph-research`, `prove-claim`) remain functional and unmodified alongside the new verb. Plan 10 batches sunsets once each new counterpart has handled the surfaces it replaces.
- The auto-flow hooks (research-state-gate, research-postcondition, doc-structure-validator, branch-gate, lock-release-on-failure) are duplicated across the source and slim plugins during the migration window. Both ports gate on identical env vars, so duplicate firing is idempotent (each checks its own preconditions independently). Plan 10 deletes the source copies.
- Plan 4 (`/ralph:plan`) and Plan 5 (`/ralph:impl`) will reuse the SKILL.md `hooks:` frontmatter pattern introduced here. Plan 3's friction log should record whether the pattern worked cleanly or hit harness quirks.
- The Step 10 follow-up flow in default mode updates the SAME doc with `last_updated` frontmatter — this is the "append-only follow-up research" pattern from source. The Plan 2 `/ralph:form` handoff lands users at Plan 3's interactive flow, so the doc lifecycle here is shared with form.

## References

- Spec: `thoughts/shared/research/2026-05-22-ralph-slim-plugin-restructure.md` (plan-of-plans row 3 at line 335).
- Plan 1: `thoughts/shared/plans/2026-05-23-GH-1357-ralph-plan-1-catch-up.md` (validated scaffold + flat-sibling + cross-plugin MCP). PR #1358.
- Plan 2: `thoughts/shared/plans/2026-05-23-GH-1359-ralph-plan-2-form.md` (validated multi-surface fold at 186 lines + 3 references). PR #1361.
- Source skill bodies:
  - `plugin/ralph-hero/skills/research/SKILL.md` (406 lines)
  - `plugin/ralph-hero/skills/ralph-research/SKILL.md` (506 lines)
  - `plugin/ralph-hero/skills/prove-claim/SKILL.md` (177 lines)
- Source hook scripts:
  - `plugin/ralph-hero/hooks/scripts/research-state-gate.sh` (41 lines)
  - `plugin/ralph-hero/hooks/scripts/research-postcondition.sh` (62 lines)
  - `plugin/ralph-hero/hooks/scripts/doc-structure-validator.sh` (76 lines)
  - `plugin/ralph-hero/hooks/scripts/branch-gate.sh` (31 lines)
  - `plugin/ralph-hero/hooks/scripts/lock-release-on-failure.sh` (82 lines)
- ralph plugin scaffold + Plan 2 state: `ralph/.claude-plugin/plugin.json`, `ralph/hooks/hooks.json`, `ralph/skills/{catch-up,form}/`.
