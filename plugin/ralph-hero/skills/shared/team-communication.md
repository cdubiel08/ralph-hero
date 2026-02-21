# Team Communication

Communication discipline for ralph-hero team agents. Referenced by both the team lead skill and agent definitions.

## Idle is Normal

Teammates go idle after every turn. This is expected behavior, not an error. The lead should avoid reacting to every idle notification. The Stop hook blocks premature shutdown when matching tasks exist in TaskList.

## TaskUpdate is the Primary Channel

Structured results go in task descriptions via `TaskUpdate(description=...)`. The lead reads results via `TaskGet`. This is more reliable than SendMessage because it persists and doesn't require the worker to be awake.

## When to Use SendMessage

- **Escalation**: You discovered something blocking that the lead should know about
- **Handoff**: You finished your task and a specific peer should know (the Stop hook handles this for standard pipeline flow)
- **Question**: You genuinely need information that isn't in your task description or skill context

## When to Avoid SendMessage

- Acknowledging receipt of a task (just start working)
- Reporting progress mid-task (update task description instead)
- Confirming you're still working (idle notifications handle this)
- Responding to idle notifications (they're informational)

## Lead Communication Principles

- **Prefer tasks over messages**: Creating and assigning tasks is the primary way to communicate work to teammates
- **Don't nudge after assigning**: After creating and assigning a task, let the worker discover it. Avoid sending a follow-up message "just to make sure." The task assignment itself is the communication. If the worker is idle, the Stop hook will prevent premature shutdown and surface the task.
- **Patience with idle workers**: Avoid nudging workers who have been idle for less than 2 minutes. Idle is the normal state between task completions.
- **Check convergence before messaging**: When a worker completes a task, check pipeline convergence first. Don't message unless there's a decision to communicate.
- **Update tasks, not messages**: If a worker needs redirection, update their task description with the new context rather than sending a multi-paragraph message.

## Context Passing: Good vs Bad Examples

**Good task creation** (context in description):
```
TaskCreate(
  subject="Research GH-42",
  description="Research GH-42: Add caching support.\nIssue: https://github.com/owner/repo/issues/42\nState: Research Needed | Estimate: S",
  metadata={"issue_number": "42", "issue_url": "...", "command": "research", "phase": "research", "estimate": "S"}
)
```

**Bad pattern** (context via message after spawn):
```
# Don't do this:
Task(prompt=..., name="analyst")  # spawn
SendMessage(recipient="analyst", content="Hey, make sure to check the auth module...")  # unnecessary nudge
SendMessage(recipient="analyst", content="The issue is about caching...")  # context belongs in task description
```

**Good handoff** (let the system handle it):
```
TaskUpdate(taskId="3", status="completed", description="RESEARCH COMPLETE: #42 - Add caching\nDocument: thoughts/shared/research/...\n...")
# Stop hook fires -> worker checks TaskList -> claims next task or goes idle
# Lead gets TaskCompleted hook -> checks convergence -> creates next-bough tasks
```

**Bad handoff** (excessive messaging):
```
# Don't do this:
TaskUpdate(taskId="3", status="completed", description="...")
SendMessage(recipient="team-lead", content="I finished research!")  # redundant - TaskCompleted hook tells the lead
SendMessage(recipient="builder", content="Research is done, you can start planning!")  # redundant - lead handles bough advancement
```
