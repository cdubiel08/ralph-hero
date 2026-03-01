## Team Result Reporting

When running as a team worker, report results via TaskUpdate — not SendMessage.

**TaskUpdate is the primary channel**: metadata for machines, description for humans.

```
TaskUpdate(
  status="completed",
  metadata={ ...skill-specific keys... },
  description="[Human-readable summary of what happened]"
)
```

Each skill defines its own required metadata keys (set by the lead at TaskCreate; workers add result keys on completion).

**After completion**: Check TaskList for more work matching your role before stopping.

**When to avoid SendMessage**:
- Acknowledging receipt of a task (just start working)
- Reporting progress mid-task (update task description instead)
- Confirming completion (TaskUpdate handles this)
- Responding to idle notifications (they're informational)
