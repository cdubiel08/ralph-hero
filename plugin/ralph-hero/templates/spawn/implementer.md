Implement GH-{ISSUE_NUMBER}: {TITLE}.
{WORKTREE_CONTEXT}

Invoke: Skill(skill="ralph-hero:ralph-impl", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "IMPLEMENTATION COMPLETE\nTicket: #{ISSUE_NUMBER}\nFiles: [list]\nTests: [PASSING/FAILING]\nCommit: [hash]\nWorktree: [path]"
DO NOT push to remote. The integrator handles pushing and PR creation.
Then check TaskList for more implementation tasks. If none, notify team-lead.
