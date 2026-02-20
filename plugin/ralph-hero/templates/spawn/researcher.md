Research GH-{ISSUE_NUMBER}: {TITLE}.

Invoke: Skill(skill="ralph-hero:ralph-research", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "RESEARCH COMPLETE: #{ISSUE_NUMBER} - {TITLE}\nDocument: [path]\nKey findings: [summary]\nTicket moved to: Ready for Plan"
Then check TaskList for more research tasks. If none, hand off per shared/conventions.md.
