# Caretake terminal tokens

Each mode body emits exactly one terminal token on its final line. The harness extractor reads these from the transcript verbatim — do not paraphrase or wrap in prose. Postcondition hooks under `ralph/hooks/scripts/*-postcondition.sh` grep the transcript for the tokens listed here.

Sections are filled across Plans 7 phases 3-8. Trends mode is read-only and emits no token.

<!-- Phase 3 fills: ## Triage terminal tokens -->
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
