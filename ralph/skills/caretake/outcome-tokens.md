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
## Hygiene terminal tokens

- `HYGIENE COMPLETE <N archived>` — scan ran cleanly; `N` is the archive count (0 if dry-run or threshold not exceeded).
- `HYGIENE BLOCKED <reason>` — scan failed (project not found, MCP error, archive call failed, etc.).

Hygiene has no `Stop` postcondition hook because it does not mutate semantic workflow state. The terminal token is reported for parity with other modes; no automated verification is performed against it.
## Unblock terminal tokens

Unblock has two sub-modes selected by the `--question` flag; each emits its own tokens.

### Interactive path (default — consumer)

- `UNBLOCK RESOLVED` — interactive Q&A flow completed; `## Unblock Resolution` posted and issue routed back to the pipeline.
- `UNBLOCK ESCALATED <reason>` — flow failed before resolution (wrong-state arg, missing `## Unblock Request`, user abort, etc.). Issue stays in Human Needed.

### Autonomous path (`--question` — producer)

- `UNBLOCK REQUEST POSTED` — `## Unblock Request` comment posted via `create_comment`; `RALPH_UNBLOCK_REQUEST_POSTED=1` exported.
- `UNBLOCK REQUEST SKIPPED — branch <name> is not main` — §Step 1 short-circuit.
- `Queue empty.` — no eligible Human Needed issues (none exist OR all carry a fresh `## Unblock Request`).

`unblock-state-gate.sh` (interactive only) and `unblock-request-postcondition.sh` (autonomous only) each gate on `RALPH_SUBCOMMAND_VARIANT` to discriminate which path is active.
<!-- Phase 6 fills: ## Postmortem / Retro / Trends sections -->

## Debug terminal tokens

- `DEBUG FILED <N>` — `N = issuesCreated + issuesUpdated`; emitted on the final line of §Step 6 after the tool returns `dryRun: false`.
- `DEBUG SKIPPED preflight: RALPH_DEBUG not active` — §Step 1 short-circuit; user must restart Claude Code with `RALPH_DEBUG=true`.
- `DEBUG SKIPPED preflight: Langfuse unreachable` — §Step 1 short-circuit; user must start the local Langfuse stack.
- `DEBUG SKIPPED no-errors-in-window` — §Step 4; dry-run returned `errorGroups === 0`.
- `DEBUG SKIPPED user-declined` — §Step 5; user picked `Skip` on the `AskUserQuestion` confirm prompt.

<!-- Phase 8 fills: ## Split terminal tokens -->
