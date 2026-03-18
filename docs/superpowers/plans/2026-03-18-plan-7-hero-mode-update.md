# Hero Mode Update — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the hero orchestrator to invoke skills inline via `Skill()` tool instead of dispatching them as `Agent()` subagents, enabling `ralph-impl`'s subagent dispatch pattern to work within hero mode.

**Architecture:** The hero skill currently dispatches pipeline skills as ephemeral agents via `Agent(subagent_type="general-purpose", prompt="Use Skill(...)")`. This creates a nesting problem: if `ralph-impl` needs to dispatch its own implementer/reviewer subagents, they'd be 2 levels deep (hero → agent → impl's agent), which Claude Code doesn't support. The fix: hero invokes skills inline via `Skill()`, so `ralph-impl`'s subagents dispatch from hero's context — one level deep.

**Tech Stack:** Markdown (SKILL.md)

**Spec:** `docs/superpowers/specs/2026-03-15-superpowers-ralph-hero-quality-integration-design.md` Section 4 (Dispatch Constraints)

---

## Chunk 1: Update Hero Skill

### Task 1: Read current hero skill to understand dispatch pattern

**Files:**
- Read: `plugin/ralph-hero/skills/hero/SKILL.md`

- [ ] **Step 1: Read the current hero skill**

Run: `grep -n "Agent(" plugin/ralph-hero/skills/hero/SKILL.md | head -20`
Expected: Lines where hero dispatches Agent() calls for pipeline skills

- [ ] **Step 2: Identify all Agent() dispatch points that need conversion to Skill()**

Document each dispatch point:
- Research dispatch: `Agent(... "Use Skill(ralph-hero:ralph-research ...)")`
- Plan dispatch: `Agent(... "Use Skill(ralph-hero:ralph-plan ...)")`
- Review dispatch: `Agent(... "Use Skill(ralph-hero:ralph-review ...)")`
- Impl dispatch: `Agent(... "Use Skill(ralph-hero:ralph-impl ...)")`
- Split dispatch: `Agent(... "Use Skill(ralph-hero:ralph-split ...)")`

---

### Task 2: Convert Agent() dispatches to inline Skill() calls

**Files:**
- Modify: `plugin/ralph-hero/skills/hero/SKILL.md`

- [ ] **Step 1: Replace each Agent() dispatch with Skill() invocation**

For each pipeline skill dispatch in the hero skill, replace:

```markdown
# BEFORE:
Agent(
  subagent_type="general-purpose",
  prompt="Use Skill('ralph-hero:ralph-research', 'GH-NNN'). ...",
  description="Research GH-NNN"
)

# AFTER:
Skill("ralph-hero:ralph-research", "GH-NNN")
```

Apply this pattern to all pipeline skill dispatches:
- `ralph-research`
- `ralph-plan` (and `ralph-plan-epic` for L/XL issues)
- `ralph-review`
- `ralph-split`
- `ralph-impl`
- `ralph-val`
- `ralph-pr`
- `ralph-merge`

- [ ] **Step 2: Add tier-aware planning dispatch**

In the planning phase, replace the single plan dispatch with tier-aware routing:

```markdown
### Planning Phase

Determine planning approach from issue estimate:
- L/XL estimate → `Skill("ralph-hero:ralph-plan-epic", "GH-NNN")`
- M/S/XS estimate → `Skill("ralph-hero:ralph-plan", "GH-NNN")`

Note: ralph-plan-epic handles its own wave orchestration and feature planning.
The hero orchestrator does not need to manage waves — it just invokes the epic planner and waits for it to complete.
```

- [ ] **Step 3: Add RALPH_COMMAND passthrough documentation**

Add a section explaining how inline skill invocation handles hooks:

```markdown
### Inline Skill Invocation

Skills are invoked inline via `Skill()` — they run in hero's context, not as separate agents.

**Hook handling**: When a skill is invoked inline:
- The skill's `SessionStart` hook runs, setting `RALPH_COMMAND` for that skill
- Subsequent PreToolUse/PostToolUse hooks see the skill's `RALPH_COMMAND` value
- After the skill completes, hero's `RALPH_COMMAND` is restored

**Subagent dispatch**: Skills invoked inline CAN dispatch their own subagents via `Agent()`:
- `ralph-impl` dispatches implementer, task-reviewer, phase-reviewer subagents
- These are one level deep from hero's context — valid
- `Skill()` nesting is fine (hero → Skill(ralph-plan-epic) → Skill(ralph-plan)) — all same context

**Context tradeoff**: Hero loses context isolation between skills but gains subagent dispatch capability. This is the intended tradeoff.
```

- [ ] **Step 4: Commit**

```bash
git add plugin/ralph-hero/skills/hero/SKILL.md
git commit -m "feat(hero): convert Agent dispatches to inline Skill invocations"
```

---

### Task 3: Expand hero's allowed-tools

**Files:**
- Modify: `plugin/ralph-hero/skills/hero/SKILL.md` (frontmatter)

- [ ] **Step 1: Expand allowed-tools to superset**

Since hero now invokes skills inline, it needs all tools that any inlined skill might use. Update the `allowed-tools` in frontmatter to include:

```yaml
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - Skill
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_sub_issue
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__list_sub_issues
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__add_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__remove_dependency
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__decompose_feature
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pipeline_dashboard
  - mcp__plugin_ralph-hero_ralph-github__ralph_hero__pick_actionable_issue
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_search
  - mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_traverse
```

This is the union of all tools used by any pipeline skill that hero might invoke inline.

- [ ] **Step 2: Commit**

```bash
git add plugin/ralph-hero/skills/hero/SKILL.md
git commit -m "feat(hero): expand allowed-tools for inline skill invocation"
```

---

## Final Verification

- [ ] **Verify hero SKILL.md has no remaining Agent() dispatches for pipeline skills**

```bash
grep -n "Agent(" plugin/ralph-hero/skills/hero/SKILL.md | grep -v "codebase-\|thoughts-\|web-search"
```
Expected: No matches (only research subagents like codebase-analyzer should remain as Agent() calls)

- [ ] **Verify allowed-tools is complete**

```bash
head -60 plugin/ralph-hero/skills/hero/SKILL.md
```
Expected: Expanded allowed-tools list

- [ ] **Run MCP server tests**

Run: `cd plugin/ralph-hero/mcp-server && npm test`
Expected: ALL PASS

---

## Summary of Changes

| File | What Changed |
|------|-------------|
| `skills/hero/SKILL.md` | Replaced Agent() pipeline dispatches with inline Skill() calls, added tier-aware planning routing, expanded allowed-tools to superset, documented RALPH_COMMAND passthrough and context tradeoff |
