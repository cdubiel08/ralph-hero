# Caretake terminal tokens

Each mode body emits its terminal token(s) at the end of the run, verbatim — the harness extractor reads them from the transcript, so do not paraphrase or wrap them in prose.

**Cardinality is one token per mode body, not one per invocation.** Most modes run one body and so emit exactly one token. Two do not, and both are documented in their own sections below:

- `--mode watch` bare runs three kind-bodies serially → three tokens, plus one informational summary line (prose, not a token).
- `--mode all` fans out to several child modes → one token per child, consolidated into the heartbeat report.

Postcondition hooks under `ralph/hooks/scripts/*-postcondition.sh` grep the transcript for the tokens listed here.

Sections are filled across Plans 7 phases 3-8.

## Triage terminal tokens

The **9 structured verdicts** (#1417 + #1472) each emit a verbatim `TRIAGED <verdict>` token — the verdict name appears after `TRIAGED `, case-preserving. These are the tokens new triage runs emit:

- `TRIAGED CLOSE-done` — closed as done/implemented/duplicate; references a `## Duplicate Of` comment when a duplicate.
- `TRIAGED CLOSE-canceled` — closed not-planned (tech changed, product direction shifted, etc.).
- `TRIAGED SPLIT` — children created; issue stays in Backlog with the `ralph-triage` label so `/ralph:plan --mode epic` / the picker doesn't re-select it.
- `TRIAGED PROMOTE-research` — routed to Research Needed for investigation.
- `TRIAGED PROMOTE-plan` — issue well-specified; routed to Ready for Plan (research skipped).
- `TRIAGED WAIT-pr=NNN` — parked in **Backlog** with `blocked:pr-NNN` + `ralph-triage`; the `=NNN` PR number is part of the token. `caretake --mode watch --kind pr` (#1406) strips the label when the PR merges.
- `TRIAGED WAIT-upstream` — parked in **Backlog** with `blocked:upstream` + `ralph-triage`; the upstream URL is recorded in the `## Triage Decision` comment, not the token (URLs are unwieldy in a terminal token). `caretake --mode watch --kind upstream` (#1407) resolves it.
- `TRIAGED WAIT-issue=NNN` — moved to **Human Needed** with `## Escalation` naming #NNN + `add_dependency` edge written + `ralph-triage` applied; the `=NNN` issue number is part of the token. **NOT parked in Backlog** — the picker's Backlog-fallback would re-surface it on every autopilot tick. `caretake --mode watch --kind issue` (GH-1604) owns this family: it sweeps Human Needed for `WAIT-issue` parks, resolves the blocker from the dependency edge or the `## Escalation` text, and advances the issue once every blocker closes. Remaining caveat is Gap A (#1470) only — once it ships, this target may relax to Backlog+edge, which the `issue` watcher already sweeps forward-compatibly.
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
## Reflect terminal tokens

- `REFLECT <path>` — doc written, `<path>` absolute (`thoughts/shared/research/YYYY-MM-DD-reflect-<slug>.md`).
- `REFLECT SKIPPED no-friction-signals` — scan returned zero pain points.
- `REFLECT SKIPPED <reason>` — other graceful skips (user aborted the findings-review loop, scope hint pointed to an empty slice, etc.).

Reflect has no Stop postcondition hook — the mode is an artifact-writer and does not mutate GitHub state. Tokens are reported for parity.

> **Decomposition terminal tokens moved (GH-1605).** `SPLIT <N>` / `SPLIT SKIPPED <reason>` are now documented in [`ralph/skills/plan/decomposition.md`](../plan/decomposition.md) § Terminal tokens — `/ralph:plan --mode epic` emits them on its M/L/XL-to-XS/S decomposition path; caretake no longer has that mode. The token family itself is unchanged.

## Watch terminal tokens

One token per kind processed (`KIND` ∈ `PR` / `UPSTREAM` / `ISSUE`) — one line for `--kind <x>`, three lines in `pr`/`upstream`/`issue` order for a bare invocation. A bare invocation additionally emits **one informational summary line** after the three tokens (`watch.md` §Step 2); it is prose, not a terminal token, and harnesses must not grep it as one:

- `WATCH-PR ADVANCED <N>` — `<N>` items **resolved this sweep**: merged-PR items promoted (default `PROMOTE-plan` → Ready for Plan) PLUS closed-unmerged items escalated (`WAIT-decision` → Human Needed). Open/still-waiting items are NOT counted.
- `WATCH-PR IDLE` — scan ran cleanly; no Backlog items carry a `blocked:pr-*` label.
- `WATCH-UPSTREAM ADVANCED <N>` — `<N>` items **resolved this sweep**: condition-met items promoted (default `PROMOTE-plan` → Ready for Plan) PLUS dead-URL/unparseable items escalated (`WAIT-decision` → Human Needed). Still-blocked / can't-confirm items are NOT counted (conservative — never false-advance).
- `WATCH-UPSTREAM IDLE` — scan ran cleanly; no Backlog items carry a `blocked:upstream` label.
- `WATCH-ISSUE ADVANCED <N>` — `<N>` items **resolved this sweep** (all blockers CLOSED → dependency edge removed + advanced to the embedded/default target). Informational prose `, <m> still blocked` (count of items left with ≥1 open blocker) may follow the token but is not part of the grepped match. Items with no blocker signal are not counted in either number.
- `WATCH-ISSUE IDLE` — scan ran cleanly; no dependency-parked items found.
- `WATCH-<KIND> SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit; watch refuses to mutate state from a feature branch (parity with `TRIAGED skipped …`).

watch has no `Stop` postcondition hook (parity with hygiene) — it mutates only the items it owns per kind. The token(s) are reported for harness/loop consumption; no automated verification is performed against them.

## Enrich terminal tokens

- `ENRICHED <N>` — `<N>` `status: draft` idea files enriched this pass (`## Enrichment` appended, `status: forming`, `enriched` stamped) and committed + pushed to `main`. A remainder beyond the 5-file per-pass cap is noted in the surrounding summary line, not in the token.
- `Queue empty.` — no `status: draft` idea files found.
- `ENRICH SKIPPED — branch <name> is not main` — §Step 1 branch-gate short-circuit (parity with `TRIAGED skipped …`).
- `ENRICH SKIPPED push-rejected` — §Step 4 non-fast-forward push failed even after one `git pull --rebase origin main` retry; the commit stays local.

enrich has no `Stop` postcondition hook (parity with watch/hygiene) — it mutates only the `status: draft` idea files it enriches, never board/workflow state. The token is reported for harness/loop consumption; no automated verification is performed against it.

## Loop continuation

How each token drives `/loop` — drain vs heartbeat semantics, terminal sentinels, and delay buckets — is single-sourced in [`../shared/loop-wrapper.md`](../shared/loop-wrapper.md) § Continuation-rules manifest (GH-1607). Read the row for the `caretake:<mode>` you are running; this file defines *which tokens exist*, the manifest defines *what they mean to the loop*.

Two caretake-specific facts that are not loop semantics and so live here:

- **Watch and enrich run as serial children of `--mode all`**, not as independently looped modes in that path; they emit their tokens into the consolidated heartbeat report. Enrich drains its `status: draft` queue across successive heartbeat ticks (5-file cap per pass), emitting `Queue empty.` once no drafts remain.
- **Non-loop invocations are unaffected** — every token semantic above applies to standalone caretake calls; the loop-continuation layer only activates when `--loop` was passed to the outermost invocation.

