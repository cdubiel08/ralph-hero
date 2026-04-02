## Skill() vs Agent() Dispatch Convention

Use `Agent()` when the sub-skill has `context: fork` or `user-invocable: false` -- these are autonomous skills designed to run in isolation. Use `Skill()` when the sub-skill needs to share the caller's context or interact with the user.

### Per-Phase Agent Mapping

Each autonomous skill has a dedicated agent that preloads it via the `skills:` field:

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

### Anti-Pattern: Autonomous Skill via Skill()

```
# WRONG -- autonomous skill runs inline, bloating caller's context
Skill("ralph-hero:ralph-research", "42")
```

This forces the entire research execution (file reads, MCP calls, output) into the caller's context window. The skill declares `context: fork` precisely because it should not share context.

### Correct Pattern: Per-Phase Agent via Agent()

```
# RIGHT -- per-phase agent runs in isolated fork with preloaded skill
Agent(
  subagent_type="ralph-hero:research-agent",
  prompt="Research issue #42",
  description="Research GH-42"
)
```

The agent spawns with its own context window and the skill instructions already loaded. Artifact paths are passed as natural language in the prompt (e.g., "Plan doc: thoughts/shared/plans/...") and results flow back via task metadata, not inline return values.

### When Skill() Is Still Correct

- **Interactive skills** (`AskUserQuestion` in the call path) -- must run inline to relay user prompts
- **Lightweight read-only skills** (status, report) -- context cost is negligible
- **Skills that need caller state** -- e.g., a helper that reads variables from the caller's scope

### Edge Case: ralph-review

ralph-review is autonomous in AUTO mode (no `AskUserQuestion`) -- safe to dispatch via `Agent()`. INTERACTIVE mode uses `AskUserQuestion` in Step 4A and requires `Skill()`. Hero and hello only invoke AUTO mode, so `Agent()` is correct for both.

### Include Directive

Skill authors can include this fragment in their skill definitions:

```
!cat ${CLAUDE_PLUGIN_ROOT}/skills/shared/fragments/skill-vs-agent-dispatch.md
```
