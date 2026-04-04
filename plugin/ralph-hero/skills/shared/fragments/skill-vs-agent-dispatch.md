## Skill() vs Agent() Dispatch Convention

The correct dispatch mechanism depends on the **session type**:

- **Single-session (hero orchestrator)**: Use `Skill()` — skills run inline and CAN dispatch sub-agents via `Agent()`. This is the default mode.
- **Team mode (dark factory)**: Use `Agent()` with per-phase agents — each agent is a full session with its own context window and CAN dispatch sub-agents.

The key constraint: Agent()-spawned sub-agents **cannot dispatch further sub-agents** (the Agent tool is unavailable at runtime in sub-agent contexts). This means sub-agent dispatch instructions inside autonomous skills (codebase-locator, thoughts-locator, etc.) are dead code when those skills are preloaded into agents via single-session dispatch. Skill() runs inline and preserves Agent() access, making those calls live.

### Per-Phase Agent Mapping

Each autonomous skill has a dedicated agent for team mode dispatch:

| subagent_type | Preloaded Skill | Model |
|---------------|-----------------|-------|
| `ralph-hero:research-agent` | ralph-research | sonnet |
| `ralph-hero:plan-agent` | ralph-plan | opus |
| `ralph-hero:plan-epic-agent` | ralph-plan-epic | opus |
| `ralph-hero:split-agent` | ralph-split | opus |
| `ralph-hero:triage-agent` | ralph-triage | sonnet |
| `ralph-hero:review-agent` | ralph-review | opus |
| `ralph-hero:impl-agent` | ralph-impl | opus |
| `ralph-hero:pr-agent` | ralph-pr | haiku |
| `ralph-hero:merge-agent` | ralph-merge | haiku |
| `ralph-hero:val-agent` | ralph-val | haiku |

### Single-Session: Skill() Dispatch

```
# Hero dispatches pipeline phases via Skill()
Skill("ralph-hero:ralph-research", args="#42")
```

The skill runs inline with `model:` honored from frontmatter, `hooks:` firing automatically (SessionStart sets `RALPH_COMMAND`), and full Agent() access for sub-agent dispatch. Context cost is ~14k tokens per skill (<2% of 1M window).

### Team Mode: Per-Phase Agent Dispatch

```
# Team spawns per-phase agents as teammates
Agent(
  subagent_type="ralph-hero:research-agent",
  prompt="Research issue #42",
  description="Research GH-42"
)
```

Each agent is a full Claude Code session with its own context window and the skill instructions already loaded. Artifact paths are passed as natural language in the prompt. Results flow back via task metadata.

### When Agent() Is Still Correct in Single-Session

- **General-purpose sub-agents** (cross-repo decompose, codebase-locator, thoughts-locator) — these are utility agents, not pipeline phase agents
- **Sub-agents dispatched from within skills** — skills running inline via Skill() CAN dispatch Agent() sub-agents

### Edge Case: ralph-review

ralph-review is autonomous in AUTO mode (no `AskUserQuestion`). INTERACTIVE mode uses `AskUserQuestion` in Step 4A and requires inline execution. Hero dispatches via `Skill()` which handles both modes. Hello dispatches via `Agent()` which works because hello runs inline (user-invocable).

### Include Directive

Skill authors can include this fragment in their skill definitions:

```
!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/skill-vs-agent-dispatch.md
```
