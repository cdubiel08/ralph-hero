# Ralph-Hero Model-Tier Policy

Adapted from superpowers/subagent-driven-development/SKILL.md:89-102.

## The rule

Complexity drives tier, not role.

| Signal                                                  | Tier      | Model  |
| ------------------------------------------------------- | --------- | ------ |
| 1-2 files, fully-specified spec, mechanical             | cheap     | haiku  |
| Multi-file, integration, pattern matching, debugging    | standard  | sonnet |
| Architecture, design judgment, broad-codebase review    | capable   | opus   |

Escalate on BLOCKED, never preemptively.

## Default tier by agent

(see CLAUDE.md table for the live mapping)

## Per-session overrides

Set `RALPH_<AGENT_UPPER>_MODEL=opus|sonnet|haiku` to override frontmatter
at dispatch time. Hero respects this for agents it dispatches; skills passing
`model=` to Agent() should read the same env var.

Examples:

```bash
RALPH_IMPL_MODEL=opus            # force impl-agent back to opus
RALPH_PLAN_MODEL=sonnet          # rare: cheaper plan-agent runs
RALPH_SPLIT_MODEL=opus           # rare: complex decompositions
```

## Escalation contract

Agents that may exhaust their tier should emit a verdict-prefix line:

```text
IMPL BLOCKED needs=opus
```

The dispatcher (hero) re-dispatches once with `model="opus"`. A second
BLOCKED escalates to Human Needed via `save_issue(workflowState="__ESCALATE__")`.

## Why not preemptive Opus?

Two reasons from the landcrawler-ai 30-day audit:

1. Most impl phases are mechanical when the plan is detailed - sonnet handles
   them. Opus default wastes tokens on the common case.
2. Failure cases that need Opus are detectable (BLOCKED status). One retry
   with the higher tier costs less than always paying for it.

## Context Window and Inline Skill Calls

**The problem**: When a skill is loaded inline via `Skill("ralph-hero:some-skill")`, it runs in the parent session's context window. If the skill's frontmatter declares `model: haiku`, the haiku 200k context cap applies to the **parent** session — not just the skill. In a parent session already holding 200k+ tokens (common in long Opus 4.7 / Sonnet 4.6 / 1M pipeline runs), this triggers context compaction: the runtime silently discards accumulated context to fit under 200k. The user did not change models; their pipeline history is still lost.

**Why it matters at the merge step**: The merge phase is the last step of a long pipeline. By the time `finish` dispatches ralph-merge, the parent session typically holds research docs, plan content, code-review output, and implementation history. Compacting at that point is maximally lossy.

**The fix**: Always dispatch haiku-tier skills from large parent contexts via `Agent()`. `Agent()` forks the skill into an isolated 200k sub-context; the parent retains its full 1M window. This is how `impl-agent`, `pr-agent`, and `val-agent` already work.

**Rule**: Any skill with `model: haiku` that may be called from a parent session carrying > 200k tokens MUST be dispatched via `Agent()`, not loaded inline via `Skill()`. Inline `Skill()` calls are safe only when the parent context is guaranteed to be small (e.g., analyst phases at the start of a pipeline).

**Canonical example**: [GH-1265](https://github.com/cdubiel08/ralph-hero/issues/1265) — `finish/SKILL.md` was calling `Skill("ralph-hero:ralph-merge")` inline. Because `merge-agent.md` declares `model: haiku`, the haiku 200k cap applied to the parent session in 1M runs, triggering compaction at the last pipeline step. Fixed by converting to `Agent(subagent_type="ralph-hero:merge-agent", ...)`.
