Review plan for GH-{ISSUE_NUMBER}: {TITLE}.
{GROUP_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-review", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "VALIDATION VERDICT\nTicket: #{ISSUE_NUMBER}\nPlan: [path]\nVERDICT: [APPROVED/NEEDS_ITERATION]\n[findings]"
Then check TaskList for more review tasks. If none, hand off per shared/conventions.md.
