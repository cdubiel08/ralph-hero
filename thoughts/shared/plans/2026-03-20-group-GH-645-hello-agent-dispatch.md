---
date: 2026-03-20
status: draft
type: plan
github_issue: 645
github_issues: [645, 646, 647]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/645
  - https://github.com/cdubiel08/ralph-hero/issues/646
  - https://github.com/cdubiel08/ralph-hero/issues/647
primary_issue: 645
tags: [hero, skills, agent-dispatch, context-isolation, orchestration, documentation]
---

# Hello Skill Agent Dispatch Fix — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-GH-0637-hero-dispatch-model]]

## Overview

3 related issues for atomic implementation in a single PR:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-646 | Write skill inventory audit | XS |
| 2 | GH-647 | Document Skill() vs Agent() dispatch convention | XS |
| 3 | GH-645 | Fix hello skill to dispatch via Agent() | S |

**Why grouped**: These three issues form a logical unit under parent #630. GH-646 (audit) provides the canonical inventory that informs both GH-647 (convention doc) and GH-645 (hello fix). GH-647 is independent of GH-645 but shares context. All changes are documentation and skill authoring artifacts with no build step required.

**Phase order**: GH-646 first (produces audit inventory), then GH-647 and GH-645 can proceed (GH-647 is logically independent but benefits from the audit for completeness; GH-645 uses the audit to confirm the full skill list).

## Shared Constraints

- Files are Markdown only — no TypeScript, no build step needed
- The research doc at `thoughts/shared/research/2026-03-19-GH-0637-hero-dispatch-model.md` is the authoritative source for the dispatch mapping — do not contradict it
- `context: fork` + `user-invocable: false` together are the definitive signal for "autonomous" classification
- The `ralph-review` edge case must be preserved: it has `AskUserQuestion` in INTERACTIVE mode but NOT in AUTO mode (hero's usage). The audit and convention doc must capture this nuance
- Skill() is still valid for lightweight inline helpers that share caller context — the fix is not "never use Skill()" but "don't use Skill() for autonomous skills"
- The convention fragment should live at `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` (per issue #647 scope)
- The audit document should live at `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` (per issue #646 scope)
- No changes to hero.md (already converted in GH-637) or ralph-plan-epic.md (out of scope for this group)

## Current State Analysis

### hello/SKILL.md Step 5 Routing Table (Current)

```
| Direction Type | Skill to Invoke |
|---|---|
| Issue in Research/Plan phase needing attention | `/ralph-hero:ralph-triage` with issue number |
| Plan waiting review | `/ralph-hero:ralph-review` with issue number |
| PR waiting merge or review | `/ralph-hero:ralph-merge` with PR number |
| Issue ready for research | `/ralph-hero:ralph-research` with issue number |
| Issue ready for planning | `/ralph-hero:ralph-plan` with issue number |
| Board healthy, user wants to pick work | `/ralph-hero:ralph-triage` to pick from backlog |

Invoke the skill using the Skill tool with the appropriate arguments.
```

Step 5 uses `Skill()` for all dispatch. Six autonomous skills are called inline: ralph-triage, ralph-review, ralph-merge, ralph-research, ralph-plan, and ralph-hygiene (implied by "pick work" routing). Each should run in its own forked context.

### hello/SKILL.md allowed-tools (Current)

```yaml
allowed-tools:
  - Read
  - Bash
  - Skill
  - AskUserQuestion
  - ralph_hero__pipeline_dashboard
```

After the fix, `Skill` may be removable if no other inline `Skill()` calls remain. A quick audit shows Step 5 is the only location using `Skill` in hello's markdown — it can be removed from `allowed-tools`.

### Skill Inventory — Full Classification

Derived from research doc + direct frontmatter inspection:

**Autonomous** (`context: fork` + `user-invocable: false`):
- ralph-triage, ralph-research, ralph-plan, ralph-plan-epic, ralph-impl, ralph-split, ralph-review, ralph-merge, ralph-hygiene, ralph-val, ralph-pr

**Interactive** (designed for human collaboration):
- hello (`context: inline`, uses `AskUserQuestion`)
- hero (`context: inline`, uses `AskUserQuestion`)
- research (no explicit context, interactive by description)
- plan (no explicit context, interactive by description)
- impl (no explicit context, interactive by description)
- iterate (no explicit context, human-in-the-loop)
- draft (no explicit context, captures ideas interactively)
- form (no explicit context, creates issues interactively)
- team (`context: inline` implied, orchestrator)

**Lightweight/read-only** (fine either way):
- status (`context: fork`, but quick read-only)
- report (`context: fork`, but quick read-only)
- bridge-artifact (`context: fork`, `user-invocable: true`)
- design-system-audit (no explicit context, single-run analysis)
- idea-hunt (`user-invocable: false`, spawns agents, not a pipeline skill)
- record-demo (`context: inline`, uses AskUserQuestion, recording orchestrator)
- setup (`context: fork`, but interactive via AskUserQuestion)
- setup-cli (`context: fork`)
- setup-repos (`context: fork`, uses AskUserQuestion)

**ralph-review edge case**: Has AskUserQuestion only in INTERACTIVE mode. AUTO mode (hero's default, hello's usage) is fully autonomous and safe for Agent() dispatch.

### Dispatch Mapping for hello Step 5

| Direction | Current | Proposed | subagent_type |
|-----------|---------|----------|---------------|
| ralph-triage (triage/pick) | `Skill("ralph-hero:ralph-triage")` | `Agent(subagent_type="ralph-hero:ralph-analyst", ...)` | ralph-analyst |
| ralph-research | `Skill("ralph-hero:ralph-research", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", ...)` | ralph-analyst |
| ralph-plan | `Skill("ralph-hero:ralph-plan", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-analyst", ...)` | ralph-analyst |
| ralph-review | `Skill("ralph-hero:ralph-review", "NNN --plan-doc ...")` | `Agent(subagent_type="ralph-hero:ralph-builder", ...)` | ralph-builder |
| ralph-merge | `Skill("ralph-hero:ralph-merge", "NNN")` | `Agent(subagent_type="ralph-hero:ralph-builder", ...)` | ralph-builder |

## Desired End State

### Verification
- [ ] `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` exists with all 20+ skills classified
- [ ] `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` exists with decision rule, mapping table, and examples
- [ ] `plugin/ralph-hero/skills/hello/SKILL.md` Step 5 uses `Agent()` for all 5 autonomous skill routes
- [ ] hello's `allowed-tools` no longer lists `Skill`
- [ ] The ralph-review edge case (INTERACTIVE vs AUTO) is documented in both the audit and the convention fragment

## What We're NOT Doing

- Changing hero.md (already converted in GH-637)
- Changing ralph-plan-epic.md internal calls (out of scope)
- Converting any lightweight/read-only skills to Agent() — only the hello routing table
- Adding `Agent` to hello's `allowed-tools` (hello delegates — the agent is spawned from hello's context which already has Agent available via the plugin's base allowed-tools; but if needed, audit will confirm)
- Modifying any TypeScript MCP server code

---

## Phase 1: GH-646 — Write Skill Inventory Audit

### Overview

Create the canonical reference document classifying all ralph-hero skills by dispatch mode. This is a pure documentation task — read frontmatters, synthesize, write.

### Tasks

#### Task 1.1: Read all skill frontmatters and classify
- **files**: `plugin/ralph-hero/skills/*/SKILL.md` (read), `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] All 20+ skills covered: bridge-artifact, design-system-audit, draft, form, hello, hero, idea-hunt, impl, iterate, plan, ralph-hygiene, ralph-impl, ralph-merge, ralph-plan, ralph-plan-epic, ralph-pr, ralph-research, ralph-review, ralph-split, ralph-triage, ralph-val, record-demo, report, research, setup, setup-cli, setup-repos, status, team
  - [ ] Each entry includes: skill name, `context` frontmatter value (or "not set"), `user-invocable` value (or "not set"), `AskUserQuestion` usage (yes/no/conditional), recommended dispatch mode, rationale
  - [ ] Classification is one of: Autonomous, Interactive, Lightweight/read-only
  - [ ] ralph-review edge case documented: "Autonomous in AUTO mode; Interactive in INTERACTIVE mode — hero and hello only invoke AUTO mode"
  - [ ] Summary table at top of document for quick reference

#### Task 1.2: Write the audit document
- **files**: `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Frontmatter includes: `date: 2026-03-20`, `type: research`, `github_issue: 646`, `tags: [hero, skills, agent-dispatch, orchestration]`
  - [ ] `## Prior Work` section references `2026-03-19-GH-0637-hero-dispatch-model`
  - [ ] Summary table appears before the per-skill detail section
  - [ ] Document cross-references GH-637 research and GH-630 parent context
  - [ ] File saved at exactly `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md`

### Phase Success Criteria

#### Automated Verification:
- [ ] File exists: `ls thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md`
- [ ] All 20+ skills appear: `grep -c "ralph-" thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` returns >= 11

#### Manual Verification:
- [ ] Open the document and verify the classification for ralph-review correctly captures the AUTO/INTERACTIVE edge case
- [ ] Summary table is scannable and accurate

**Creates for next phase**: `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` — referenced by Phase 2 and Phase 3 as the authoritative skill list

---

## Phase 2: GH-647 — Document Skill() vs Agent() Dispatch Convention

### Overview

Create a concise shared fragment that codifies the Skill() vs Agent() decision rule for skill authors. This is the "law of the land" document that future skill authors reference.

### Tasks

#### Task 2.1: Write the convention fragment
- **files**: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` (create), `thoughts/shared/research/2026-03-20-skill-dispatch-inventory.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`
  - [ ] Decision rule is stated in 1-2 sentences at the top: "Use `Agent()` when the sub-skill has `context: fork` or `user-invocable: false`. Use `Skill()` when the sub-skill needs to share the caller's context or interact with the user."
  - [ ] Subagent_type mapping table included: ralph-analyst (triage/split/research/plan), ralph-builder (review/impl/merge)
  - [ ] Anti-pattern example shown (calling autonomous skill via Skill())
  - [ ] Correct pattern example shown (calling same skill via Agent())
  - [ ] ralph-review edge case noted: "ralph-review is autonomous in AUTO mode — safe to call via Agent(); INTERACTIVE mode requires Skill()"
  - [ ] `!cat` include directive added to at least one relevant skill (e.g., hero/SKILL.md or a new SKILL-AUTHORING.md) OR a note added saying "Include in skill authoring docs"

### Phase Success Criteria

#### Automated Verification:
- [ ] File exists: `ls plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`
- [ ] Contains Agent() example: `grep "Agent(" plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md`

#### Manual Verification:
- [ ] Decision rule is clear and actionable in under 30 seconds of reading
- [ ] A new skill author could determine the correct dispatch mode by reading only this fragment

**Creates for next phase**: `plugin/ralph-hero/skills/shared/fragments/skill-vs-agent-dispatch.md` — provides the canonical mapping table that Phase 3 implements

---

## Phase 3: GH-645 — Fix hello Skill Step 5 Routing

### Overview

Update `hello/SKILL.md` Step 5 to replace all `Skill()` dispatch calls with `Agent()` calls using the correct subagent_type. Remove `Skill` from hello's `allowed-tools` since it will no longer be used.

### Tasks

#### Task 3.1: Rewrite Step 5 routing table and invocation instructions
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] The routing table in Step 5 is preserved with the same 6 direction types
  - [ ] The instruction "Invoke the skill using the Skill tool" is replaced with Agent() dispatch instructions
  - [ ] Each route uses the correct subagent_type:
    - ralph-triage (triage/pick) → `ralph-hero:ralph-analyst`
    - ralph-review → `ralph-hero:ralph-builder`
    - ralph-merge → `ralph-hero:ralph-builder`
    - ralph-research → `ralph-hero:ralph-analyst`
    - ralph-plan → `ralph-hero:ralph-analyst`
  - [ ] Agent() call pattern follows the research doc template: `Agent(subagent_type="ralph-hero:ralph-analyst", prompt="Run /ralph-hero:ralph-triage NNN", description="[action] GH-NNN")`
  - [ ] "Work through these in order" instruction updated to use sequential Agent() calls
  - [ ] No `Skill()` calls remain in the Step 5 section

#### Task 3.2: Remove Skill from allowed-tools and add Agent
- **files**: `plugin/ralph-hero/skills/hello/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] `Skill` removed from the `allowed-tools` YAML frontmatter list
  - [ ] `Agent` added to the `allowed-tools` YAML frontmatter list (if not already present — verify first)
  - [ ] No other `Skill(` calls remain anywhere else in hello/SKILL.md (verify with grep)
  - [ ] `AskUserQuestion` remains in `allowed-tools` (still used in Step 4)
  - [ ] All other existing allowed-tools preserved: Read, Bash, ralph_hero__pipeline_dashboard

### Phase Success Criteria

#### Automated Verification:
- [ ] No Skill( calls remain: `grep -c "Skill(" plugin/ralph-hero/skills/hello/SKILL.md` returns 0
- [ ] Agent( calls present: `grep -c "Agent(" plugin/ralph-hero/skills/hello/SKILL.md` returns >= 5
- [ ] Skill not in allowed-tools: `grep "Skill" plugin/ralph-hero/skills/hello/SKILL.md | grep "allowed-tools" | wc -l` returns 0

#### Manual Verification:
- [ ] Read Step 5 end-to-end — each route's Agent() call is syntactically correct and uses the right subagent_type
- [ ] The "Work through these in order" sequential case is handled correctly

---

## Integration Testing

- [ ] Run hello skill after changes and select a "ready for research" issue — verify an Agent() is dispatched (not inline Skill())
- [ ] Confirm hello's context window is not inflated by sub-skill execution (observable: hello completes promptly rather than waiting for full research cycle)
- [ ] Verify skill inventory document covers all skills in `plugin/ralph-hero/skills/` (count directories: `ls plugin/ralph-hero/skills/ | wc -l`)

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-19-GH-0637-hero-dispatch-model.md
- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/630
- GH-645: https://github.com/cdubiel08/ralph-hero/issues/645
- GH-646: https://github.com/cdubiel08/ralph-hero/issues/646
- GH-647: https://github.com/cdubiel08/ralph-hero/issues/647
- hello/SKILL.md: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/hello/SKILL.md
- Shared fragments dir: https://github.com/cdubiel08/ralph-hero/blob/main/plugin/ralph-hero/skills/shared/fragments/
