# Caretake terminal tokens

Each mode body emits exactly one terminal token on its final line. The harness extractor reads these from the transcript verbatim — do not paraphrase or wrap in prose. Postcondition hooks under `ralph/hooks/scripts/*-postcondition.sh` grep the transcript for the tokens listed here.

Sections are filled across Plans 7 phases 3-8. Trends mode is read-only and emits no token.

## Triage terminal tokens

- `TRIAGED valid` — issue moved to `Research Needed` or `Ready for Plan` (the agent decided the issue is actionable).
- `TRIAGED duplicate` — closed as duplicate; references a `## Duplicate Of` comment naming the surviving issue.
- `TRIAGED canceled` — closed not-planned (tech changed, product direction shifted, etc.).
- `TRIAGED needs-split` — left in Backlog with the `needs-split` label so `--mode split` picks it up on the next sweep.
- `TRIAGED skipped — branch <name> is not main` — §Step 1 short-circuit; triage refuses to run on a feature branch.
- `Queue empty.` — no untriaged Backlog issues remain.

`triage-postcondition.sh` (Stop hook) greps the transcript for one of these tokens. The hook also verifies `RALPH_TRIAGE_ACTION` is set to one of `RESEARCH | SPLIT | CLOSE | KEEP | HUMAN | CANCEL | RE-ESTIMATE`.
<!-- Phase 4 fills: ## Hygiene terminal tokens -->
<!-- Phase 5 fills: ## Unblock terminal tokens -->
<!-- Phase 6 fills: ## Postmortem / Retro / Trends sections -->

## Debug terminal tokens

- `DEBUG FILED <N>` — `N = issuesCreated + issuesUpdated`; emitted on the final line of §Step 6 after the tool returns `dryRun: false`.
- `DEBUG SKIPPED preflight: RALPH_DEBUG not active` — §Step 1 short-circuit; user must restart Claude Code with `RALPH_DEBUG=true`.
- `DEBUG SKIPPED preflight: Langfuse unreachable` — §Step 1 short-circuit; user must start the local Langfuse stack.
- `DEBUG SKIPPED no-errors-in-window` — §Step 4; dry-run returned `errorGroups === 0`.
- `DEBUG SKIPPED user-declined` — §Step 5; user picked `Skip` on the `AskUserQuestion` confirm prompt.

<!-- Phase 8 fills: ## Split terminal tokens -->
