Plan GH-{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-plan", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "PLAN COMPLETE: [ticket/group]\nPlan: [path]\nPhases: [N]\nFile ownership: [groups]\nReady for review."
Then check TaskList for more plan tasks. If none, hand off per shared/conventions.md.
