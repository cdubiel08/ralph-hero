# Caretake terminal tokens

Each mode body emits exactly one terminal token on its final line. The harness extractor reads these from the transcript verbatim — do not paraphrase or wrap in prose. Postcondition hooks under `ralph/hooks/scripts/*-postcondition.sh` grep the transcript for the tokens listed here.

Sections are filled across Plans 7 phases 3-8. Trends mode is read-only and emits no token.

## Triage terminal tokens

Routing convention: the state name appears verbatim after the `→` token, case-preserving (e.g., `TRIAGED routed → Research Needed` not `research needed`). `triage-postcondition.sh` uses `^TRIAGED routed → .+` to match the full routing family.

- `TRIAGED routed → Research Needed` — issue routed to Research Needed for investigation.
- `TRIAGED routed → Ready for Plan` — issue well-specified; routed directly to Ready for Plan (research skipped).
- `TRIAGED routed → In Progress` — trivial fix; routed directly to In Progress.
- `TRIAGED duplicate` — closed as duplicate; references a `## Duplicate Of` comment naming the surviving issue.
- `TRIAGED canceled` — closed not-planned (tech changed, product direction shifted, etc.).
- `TRIAGED needs-split` — left in Backlog with the `needs-split` label so `--mode split` picks it up on the next sweep. `ralph-triage` label applied.
- `TRIAGED escalated` — escalated to Human Needed; `ralph-triage` label applied so the issue is not re-picked.
- `TRIAGED re-estimated` — estimate updated; issue stays in Backlog with the `ralph-triage` label applied (prevents re-pick under `--loop`).
- `TRIAGED skipped — branch <name> is not main` — §Step 1 short-circuit; triage refuses to run on a feature branch.
- `Queue empty.` — no untriaged Backlog issues remain.

`triage-postcondition.sh` (Stop hook) greps the transcript for one of these tokens. The `RALPH_TRIAGE_ACTION` allowlist (checked by the skill body's §Step 5) is: `ROUTE_TO_RESEARCH | ROUTE_TO_PLAN | ROUTE_TO_IMPL | SPLIT | CLOSE | HUMAN | CANCEL | RE-ESTIMATE`.
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
## Postmortem terminal tokens

- `POSTMORTEM <path>` — doc written, `<path>` absolute (e.g., `/Users/dubiel/projects/ralph-hero/thoughts/shared/reports/2026-05-23-ralph-team-foo.md`). Plan documents patched with `post_mortem::` edges; `process-improvement` issues filed for blockers.
- `POSTMORTEM SKIPPED no-session-data` — §Step 1 short-circuit; `TaskList` unavailable or returned empty.
- `POSTMORTEM SKIPPED <reason>` — other graceful skips (missing primary issue, MCP failures during outcome recording, etc.).

`postmortem-completeness.sh` (Stop hook) greps the transcript for one of these tokens and additionally validates the doc carries the required frontmatter + section headings.

## Retro terminal tokens

- `RETRO <path>` — doc written, `<path>` absolute (`thoughts/shared/research/YYYY-MM-DD-retro-<slug>.md`).
- `RETRO SKIPPED team-session-redirect` — `TaskList` non-empty and user chose `--mode postmortem` from the dedup prompt.
- `RETRO SKIPPED no-friction-signals` — scan returned zero pain points.
- `RETRO SKIPPED <reason>` — other graceful skips (user aborted the findings-review loop, scope hint pointed to an empty slice, etc.).

Retro has no Stop postcondition hook — the mode is an artifact-writer and does not mutate GitHub state. Tokens are reported for parity.

## Trends

Trends is read-only — the markdown report printed to stdout is the deliverable. **No terminal token is emitted** and no postcondition hook gates this mode. The harness extractor treats the entire stdout markdown payload as the result.

## Debug terminal tokens

- `DEBUG FILED <N>` — `N = issuesCreated + issuesUpdated`; emitted on the final line of §Step 6 after the tool returns `dryRun: false`.
- `DEBUG SKIPPED preflight: RALPH_DEBUG not active` — §Step 1 short-circuit; user must restart Claude Code with `RALPH_DEBUG=true`.
- `DEBUG SKIPPED preflight: Langfuse unreachable` — §Step 1 short-circuit; user must start the local Langfuse stack.
- `DEBUG SKIPPED no-errors-in-window` — §Step 4; dry-run returned `errorGroups === 0`.
- `DEBUG SKIPPED user-declined` — §Step 5; user picked `Skip` on the `AskUserQuestion` confirm prompt.

## Split terminal tokens

- `SPLIT <N>` — `N ≥ 2` XS/S sub-issues created and linked. `split-postcondition.sh` requires N ≥ 2.
- `SPLIT SKIPPED already-atomic` — `split-estimate-gate.sh` blocked the parent because its estimate was already XS or S.
- `SPLIT SKIPPED <reason>` — other graceful skips (no natural decomposition boundary found, parent already fully split, decompose_feature returned no children, etc.).
- `Queue empty.` — no M/L/XL issues exist in Backlog or Research Needed.

`split-postcondition.sh` (Stop hook) greps the transcript for one of these tokens AND verifies via `list_sub_issues` that the parent has ≥ 2 children when `SPLIT <N>` is emitted.

## Loop continuation

When a caretake mode is wrapped via `--loop` (see `ralph/skills/shared/loop-wrapper.md` for the canonical continuation-rules manifest), the `/loop` runtime reads each invocation's terminal token to decide whether to re-fire or stop.

**Drain modes** (triage, unblock, debug, split, caretake:default-event): `Queue empty.` is the sole termination signal. Every other terminal token (including progress tokens and `BLOCKED` variants) causes `/loop` to schedule the next tick at the appropriate delay bucket and re-fire.

**Heartbeat modes** (hygiene, trends, all): these modes have no `Queue empty.` termination signal. `/loop` re-fires on a clock regardless of the token emitted — even when the invocation did nothing. The user cancels by deleting the pending wakeup via `/tasks`.

**Non-loop invocations** are unaffected: all token semantics above apply to standalone caretake calls; the loop-continuation layer only activates when `--loop` was passed to the outermost invocation.
