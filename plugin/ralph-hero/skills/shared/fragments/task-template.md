<!-- Used by: team/SKILL.md -->

Each task must satisfy `task-schema-validator.sh`. Use these templates:

| Phase | Subject Pattern | Owner | Command | activeForm |
|-------|----------------|-------|---------|------------|
| Triage | `Triage GH-NNN: {title}` | analyst | ralph_triage | Triaging GH-NNN |
| Research | `Research GH-NNN: {title}` | analyst | ralph_research | Researching GH-NNN |
| Plan | `Plan GH-NNN: {title}` | analyst | ralph_plan | Planning GH-NNN |
| Review | `Review plan for GH-NNN: {title}` | builder | ralph_review | Reviewing GH-NNN |
| Implement | `Implement GH-NNN: {title}` | builder | ralph_impl | Implementing GH-NNN |
| Validate | `Validate GH-NNN: {title}` | integrator | ralph_val | Validating GH-NNN |
| Create PR | `Create PR for GH-NNN: {title}` | integrator | ralph_pr | Creating PR for GH-NNN |
| Merge | `Merge PR for GH-NNN: {title}` | integrator | ralph_merge | Merging GH-NNN |

**Required metadata for every task**: `issue_number`, `issue_url`, `command`, `phase`, `estimate`. Add `group_primary` and `group_members` for group issues.
