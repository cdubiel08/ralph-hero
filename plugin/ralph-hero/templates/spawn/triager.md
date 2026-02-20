Triage GH-{ISSUE_NUMBER}: {TITLE}.
Estimate: {ESTIMATE}.

Invoke: Skill(skill="ralph-hero:ralph-triage", args="{ISSUE_NUMBER}")

Report via TaskUpdate: "TRIAGE COMPLETE: #{ISSUE_NUMBER}\nAction: [CLOSE/SPLIT/RESEARCH/KEEP]\n[If SPLIT]: Sub-tickets: #AAA, #BBB\nEstimates: #AAA (XS), #BBB (S)"
Then check TaskList for more triage tasks.
