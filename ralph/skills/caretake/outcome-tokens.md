# Caretake terminal tokens

Each mode body emits exactly one terminal token on its final line. The harness extractor reads these from the transcript verbatim — do not paraphrase or wrap in prose. Postcondition hooks under `ralph/hooks/scripts/*-postcondition.sh` grep the transcript for the tokens listed here.

Sections are filled across Plans 7 phases 3-8. Trends mode is read-only and emits no token.

## Triage terminal tokens

The **9 structured verdicts** (#1417 + #1472) each emit a verbatim `TRIAGED <verdict>` token — the verdict name appears after `TRIAGED `, case-preserving. These are the tokens new triage runs emit:

- `TRIAGED CLOSE-done` — closed as done/implemented/duplicate; references a `## Duplicate Of` comment when a duplicate.
- `TRIAGED CLOSE-canceled` — closed not-planned (tech changed, product direction shifted, etc.).
- `TRIAGED SPLIT` — children created; issue stays in Backlog with the `ralph-triage` label so `--mode split` / the picker doesn't re-select it.
- `TRIAGED PROMOTE-research` — routed to Research Needed for investigation.
- `TRIAGED PROMOTE-plan` — issue well-specified; routed to Ready for Plan (research skipped).
- `TRIAGED WAIT-pr=NNN` — parked in **Backlog** with `blocked:pr-NNN` + `ralph-triage`; the `=NNN` PR number is part of the token. Phase 3 (#1406) watch-pr strips the label when the PR merges.
- `TRIAGED WAIT-upstream` — parked in **Backlog** with `blocked:upstream` + `ralph-triage`; the upstream URL is recorded in the `## Triage Decision` comment, not the token (URLs are unwieldy in a terminal token). Phase 3 (#1407) watch-upstream resolves it.
- `TRIAGED WAIT-issue=NNN` — moved to **Human Needed** with `## Escalation` naming #NNN + `add_dependency` edge written + `ralph-triage` applied; the `=NNN` issue number is part of the token. **NOT parked in Backlog** — the picker's Backlog-fallback would re-surface it on every autopilot tick (no watcher owns OPEN-issue blockers until Gap C `watch-blockers` ships). Once Gap A (#1470) and Gap C ship, this target relaxes to Backlog+edge. The `WAIT-issue` family member distinguishes OPEN-issue blockers from PR/upstream blockers: WAIT-pr and WAIT-upstream stay Backlog (watched); WAIT-issue goes Human Needed (unwatched until Gap C).
- `TRIAGED WAIT-decision` — escalated to Human Needed with a `## Escalation` comment naming the decision required; `ralph-triage` applied.
- `Queue empty.` — no untriaged Backlog issues remain.

**Legacy tokens (still accepted by the postcondition for back-compat; new runs should not emit them):** Phase 6 (#1410) **removed** the legacy `RALPH_TRIAGE_ACTION=KEEP` path — the plugin hook now exits 2 on bare `KEEP`. These terminal *tokens* stay valid so older transcripts and the parallel plugin surface don't regress (none of them is `KEEP`, which was never a terminal token).

- `TRIAGED routed → Research Needed` / `→ Ready for Plan` / `→ In Progress` — superseded by `PROMOTE-research` / `PROMOTE-plan` (the direct-to-In-Progress route is folded into `PROMOTE-plan`).
- `TRIAGED duplicate` — superseded by `CLOSE-done`.
- `TRIAGED canceled` — superseded by `CLOSE-canceled`.
- `TRIAGED needs-split` — superseded by `SPLIT`.
- `TRIAGED escalated` — superseded by `WAIT-decision`.
- `TRIAGED re-estimated` — emitted by the orthogonal `RE-ESTIMATE` action; issue stays in Backlog with `ralph-triage`.
- `TRIAGED skipped — branch <name> is not main` — §Step 1 short-circuit; triage refuses to run on a feature branch.

`triage-postcondition.sh` (Stop hook) greps the transcript for one of these tokens (9 verdict tokens + legacy set + `Queue empty.`). The `RALPH_TRIAGE_ACTION` allowlist (checked by the legacy plugin hook's §Step 5; the slim hook ignores the env var) is: `CLOSE-done | CLOSE-canceled | SPLIT | PROMOTE-research | PROMOTE-plan | WAIT-pr | WAIT-upstream | WAIT-issue | WAIT-decision` plus legacy `ROUTE_TO_RESEARCH | ROUTE_TO_PLAN | ROUTE_TO_IMPL | CLOSE | HUMAN | CANCEL | RE-ESTIMATE` (bare `KEEP` is rejected as of Phase 6 / #1410).
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

## Watch-PR terminal tokens

- `WATCH-PR ADVANCED <N>` — `<N>` items **resolved this sweep**: merged-PR items promoted (default `PROMOTE-plan` → Ready for Plan) PLUS closed-unmerged items escalated (`WAIT-decision` → Human Needed). Open/still-waiting items are NOT counted.
- `WATCH-PR IDLE` — scan ran cleanly; no Backlog items carry a `blocked:pr-*` label.
- `WATCH-PR SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit; watch-pr refuses to mutate state from a feature branch (parity with `TRIAGED skipped …`).

watch-pr has no `Stop` postcondition hook (parity with hygiene/trends) — it mutates only the `blocked:pr-*`-parked items it owns. The token is reported for harness/loop consumption; no automated verification is performed against it.

## Watch-Upstream terminal tokens

- `WATCH-UPSTREAM ADVANCED <N>` — `<N>` items **resolved this sweep**: condition-met items promoted (default `PROMOTE-plan` → Ready for Plan) PLUS dead-URL/unparseable items escalated (`WAIT-decision` → Human Needed). Still-blocked / can't-confirm items are NOT counted (conservative — never false-advance).
- `WATCH-UPSTREAM IDLE` — scan ran cleanly; no Backlog items carry a `blocked:upstream` label.
- `WATCH-UPSTREAM SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit (parity with `TRIAGED skipped …`).

watch-upstream has no `Stop` postcondition hook (parity with watch-pr/hygiene/trends) — it mutates only the `blocked:upstream`-parked items it owns. The token is reported for harness/loop consumption; no automated verification is performed against it.

## Watch-Blockers terminal tokens

- `WATCH-BLOCKERS <n> advanced, <m> still blocked` — `<n>` items **resolved this sweep** (all blockers CLOSED → dependency edge removed + advanced to the embedded/default target); `<m>` items left with ≥1 open blocker. Items with no blocker signal are not counted in either.
- `WATCH-BLOCKERS IDLE` — scan ran cleanly; no dependency-parked items found.
- `WATCH-BLOCKERS SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit (parity with `TRIAGED skipped …`).

watch-blockers has no `Stop` postcondition hook (parity with watch-pr/watch-upstream/hygiene/trends) — it mutates only the dependency-parked items it owns. The token is reported for harness/loop consumption; no automated verification is performed against it.

## Loop continuation

When a caretake mode is wrapped via `--loop` (see `ralph/skills/shared/loop-wrapper.md` for the canonical continuation-rules manifest), the `/loop` runtime reads each invocation's terminal token to decide whether to re-fire or stop.

**Drain modes** (triage, unblock, debug, split, caretake:default-event): `Queue empty.` is the sole termination signal. Every other terminal token (including progress tokens and `BLOCKED` variants) causes `/loop` to schedule the next tick at the appropriate delay bucket and re-fire.

**Heartbeat modes** (hygiene, trends, all): these modes have no `Queue empty.` termination signal. `/loop` re-fires on a clock regardless of the token emitted — even when the invocation did nothing. The user cancels by deleting the pending wakeup via `/tasks`. The watch modes (watch-pr, watch-upstream, watch-blockers) run as serial children of `--mode all` (not independently looped) and emit their tokens into the consolidated heartbeat report.

**Non-loop invocations** are unaffected: all token semantics above apply to standalone caretake calls; the loop-continuation layer only activates when `--loop` was passed to the outermost invocation.
