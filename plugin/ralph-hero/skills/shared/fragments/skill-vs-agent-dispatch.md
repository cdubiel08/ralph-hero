## Skill() vs Agent() Dispatch Convention

Use `Agent()` when the sub-skill has `context: fork` or `user-invocable: false` -- these are autonomous skills designed to run in isolation. Use `Skill()` when the sub-skill needs to share the caller's context or interact with the user.

### Subagent Type Mapping

| subagent_type | Skills routed through it |
|---------------|-------------------------|
| `ralph-hero:ralph-analyst` | ralph-triage, ralph-split, ralph-research, ralph-plan, ralph-plan-epic |
| `ralph-hero:ralph-builder` | ralph-review, ralph-impl, ralph-merge |
| `ralph-hero:ralph-integrator` | ralph-val, ralph-pr |

### Anti-Pattern: Autonomous Skill via Skill()

```
# WRONG -- autonomous skill runs inline, bloating caller's context
Skill("ralph-hero:ralph-research", "42")
```

This forces the entire research execution (file reads, MCP calls, output) into the caller's context window. The skill declares `context: fork` precisely because it should not share context.

### Correct Pattern: Autonomous Skill via Agent()

```
# RIGHT -- autonomous skill runs in isolated fork
Agent(
  subagent_type="ralph-hero:ralph-analyst",
  prompt="Run /ralph-hero:ralph-research 42",
  description="Research GH-42"
)
```

The agent spawns with its own context window. Artifact paths are passed through the prompt string (e.g., `--research-doc`, `--plan-doc` flags) and results flow back via task metadata, not inline return values.

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
