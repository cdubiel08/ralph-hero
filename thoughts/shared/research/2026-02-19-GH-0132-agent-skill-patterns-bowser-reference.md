---
date: 2026-02-19
github_issue: 132
github_url: https://github.com/cdubiel08/ralph-hero/issues/132
status: complete
type: research
---

# GH-132: Agent/Skill Invocation Patterns — Bowser Reference Architecture

## Problem Statement

Despite template integrity rules (#53, #89), there's concern that teammate agents may still bypass skill invocation. PR #57 attempted to fix this by removing MCP tools from agents, but that broke skill execution since `Skill()` runs inline and inherits the agent's tool restrictions. The question: are our patterns structurally sound, or do they need redesign?

## Reference Architecture: Bowser

[Bowser](https://github.com/disler/bowser/) is a Claude Code multi-agent browser automation framework by @disler. It uses a clean 4-layer architecture:

| Layer | Name | Role | Location |
|-------|------|------|----------|
| 4 | Just | Reusability — one terminal command | `justfile` |
| 3 | Command | Orchestration — discover work, fan out agents | `.claude/commands/` |
| 2 | Subagent | Scale — parallel execution, isolated sessions | `.claude/agents/` |
| 1 | Skill | Capability — raw tool execution | `.claude/skills/` |

### Key Bowser Patterns

1. **Agents are thin wrappers around a single skill**: Each agent's system prompt says "execute this skill and report results." Agent definitions are ~15 lines.

2. **Orchestrators are commands, not agents**: The `ui-review.md` command IS the team lead — it runs in the main Claude context and spawns agents downward via `TeamCreate`/`Task`/`TeamDelete`.

3. **`allowed_tools` in skill frontmatter**: Skills declare `allowed_tools: [Bash]`, restricting what Claude can do during skill execution. This is the closest thing to structural enforcement.

4. **Justfile as public API**: Every layer has a `just` recipe, making the framework fully accessible from the terminal.

5. **YAML user stories as data contracts**: Work items are structured YAML files, not freeform text.

6. **Machine-parseable result format**: `RESULT: {PASS|FAIL} | Steps: {passed}/{total}` — the orchestrator regex-scans for this line.

### Bowser's Enforcement: Also Documentation-Based

**Critical finding**: Bowser has **no structural enforcement** beyond documentation and `allowed_tools`. The `skills:` frontmatter key is declarative metadata only — it does not technically prevent an agent from taking other actions. The constraint is entirely behavioral (the system prompt says "use only this skill").

## Current Ralph-Hero Architecture

### What We Already Have Right

Our architecture already matches Bowser's proven patterns:

| Pattern | Bowser | Ralph-Hero | Status |
|---------|--------|------------|--------|
| Thin agent wrappers | ~15-line agent defs | 5-8 line spawn templates + ~35-line agent defs | Equivalent |
| Agents invoke one skill | `skills:` key + system prompt | `Invoke: Skill(...)` in template + task loop dispatch | Equivalent |
| Orchestrator fans out agents | `ui-review.md` command with Teams API | `ralph-team` skill with Teams API | Equivalent |
| Template substitution | `{PROMPT}`, `{MODE}`, `{VISION}` | `{ISSUE_NUMBER}`, `{TITLE}`, `{GROUP_CONTEXT}` | Equivalent |
| Result format contract | `RESULT: {PASS\|FAIL} \| Steps: {n}/{m}` | Structured `TaskUpdate` description strings | Equivalent |
| `context:fork` for isolation | Not used (agents ARE subprocesses) | Added to 6 worker skills | Ahead |
| Template integrity rules | Not documented | Line-count guardrail + anti-patterns | Ahead |
| Pull-based task claiming | Teammates claim from task list | Workers self-claim by subject keyword | Equivalent |

### What We're Missing

| Pattern | Bowser | Ralph-Hero | Gap |
|---------|--------|------------|-----|
| `allowed_tools` in skills | `allowed_tools: [Bash]` | Not used | Skills have unrestricted tool access |
| Justfile as CLI | Full justfile with per-layer recipes | Shell scripts (`ralph-loop.sh`, `ralph-team-loop.sh`) | Already researched in GH-0067 |
| Structured data contracts | YAML user stories | GitHub Issues (unstructured markdown) | Not applicable — GitHub IS our data store |
| Orchestrator = command | `.claude/commands/ui-review.md` | `.claude/skills/ralph-team/SKILL.md` | Minor — skill-as-orchestrator works fine |

### Why MCP Tool Removal Was Wrong

PR #57 attempted to remove `ralph_hero__*` MCP tools from builder and validator agents. This was wrong for two reasons:

1. **`Skill()` runs inline**: When a team agent calls `Skill()`, the skill executes in the agent's own context and inherits tool restrictions. Removing MCP tools from the agent breaks every skill that needs them.

2. **Bowser confirms agents need tools**: Bowser's agents have full tool access — the restriction is at the skill layer (`allowed_tools` in SKILL.md), not the agent layer. Agents must be able to do their work; the constraint is on WHERE the work happens (inside a skill), not WHAT tools are available.

PR #89 correctly restored MCP tools and added template integrity documentation instead.

## Recommendations

### 1. No Structural Redesign Needed

Our patterns are sound. Both Bowser and ralph-hero use documentation-based enforcement because that's the only mechanism available in Claude Code's plugin system. The architecture matches Bowser's proven 4-layer model.

### 2. Add `allowed_tools` to Skill Frontmatter (Optional Hardening)

Bowser uses `allowed_tools: [Bash]` in skill SKILL.md files to restrict tool access during skill execution. We could adopt this pattern for skills that don't need the full tool surface:

```yaml
# Example: ralph-research/SKILL.md frontmatter
allowed_tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Task
  - WebSearch
  - WebFetch
```

**Caveat**: This only constrains the skill when invoked via `/skill-name` or `Skill()`. It does not prevent an agent from ignoring the skill entirely and working directly. The primary benefit is defense-in-depth, not absolute enforcement.

**Assessment**: Low priority. The `context:fork` already provides isolation by running skills in subprocesses. Adding `allowed_tools` would be a second layer but the incremental value is small.

### 3. Adopt Justfile Pattern (Already Planned)

GH-0067 already researched Bowser's Justfile/CLI patterns. This is the highest-value Bowser adoption — it provides a clean terminal interface for every workflow layer. Should be implemented per that plan.

### 4. Strengthen Result Format Contracts

Bowser's `RESULT: {PASS|FAIL} | Steps: {n}/{m}` pattern is parseable by the orchestrator. Our `TaskUpdate` description strings are structured but not formally specified. Consider standardizing result formats per worker role (already partially done in agent definitions).

## Conclusion

The investigation confirms: **our agent/skill patterns are correct and match industry best practices**. The template integrity rules from #89 are the right approach — documentation + architectural patterns are the only enforcement mechanisms available in Claude Code's plugin system. Bowser, the leading reference implementation, uses the same approach.

The remaining high-value adoption is the Justfile CLI pattern (GH-0067), not architectural changes to agent/skill invocation.
