Split GH-{ISSUE_NUMBER}: {TITLE}.
Too large for direct implementation (estimate: {ESTIMATE}).

Invoke: Skill(skill="ralph-hero:ralph-split", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "SPLIT COMPLETE: #{ISSUE_NUMBER}\nSub-tickets: #AAA, #BBB, #CCC\nEstimates: #AAA (XS), #BBB (S), #CCC (XS)"
Then check TaskList for more split tasks.
