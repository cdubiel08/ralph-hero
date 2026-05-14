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
