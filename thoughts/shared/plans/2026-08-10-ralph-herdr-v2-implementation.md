# ralph-herdr v2 — implementation plan (decisions locked 2026-08-10)

Decision record: `thoughts/shared/html-out/2026-08-10-ralph-herdr-v2-microworld.html` (user selections pasted 2026-08-10).
Research trail: `thoughts/shared/html-out/2026-08-10-herdr-plugin-api-deep-dive.html`.

## Locked decisions

D1 naming Grammar B `<lane><issue>-<slug>` · D2 roles extended-5 (+relay, +watcher) with **shared claims** (one issue, many siblings) · D3 lineage hybrid (tokens live, watcher = sole ledger appender, startup reconcile) · D4 fleet = dependency-aware work-stealing frontier (board is the wait state — nothing idles in a pane; the watcher spawns when blockers merge) · D5 contracts Zod-in-board.ts → generated JSON Schema artifacts, CI drift-checked · D6 tests hybrid (replay per-PR, nightly live, incident→transcript rule) · D6b cucumber-js on the socket · D7 cards A+B (substrate now, bubbletea cockpit next; **space = peek**; audit herdr keybinding interception before binding keys) · D8 herdr-native-first. All 13 lints. J1–J4 all v1.

Note incorporations: `harness` (claude|codex|pi) is a required metadata token, never in the name. Claim v2 is multi-holder.

## Fixed constraints

Name = identity + scan key; tokens = attributes. Durable refs `name#spawn-epoch`; pane_id never durable. Board authoritative, herdr decorative — enforced in code. Answer path comment-first. Escalations phone-answerable (enumerated options + recommended default in the issue comment). Append-only events ledger feeds all viz; reports never read the socket. Card metadata additive-only with schema_version. Dependency edges are structured board data (tend owns hygiene). Depth ≤3 herdr plane; inner subagents free (`inner=N` token). Degradation loses chrome, never verbs. Unattended arming gated on the claim-TTL probe (design §5).

## Phases

### Phase 1 — contracts + naming + shared claims (THIS PASS)
- **`ralph/scripts/contracts.ts`** (new): Zod source of truth — naming grammar (lane registry w/r/o/d/s/x, format/parse/truncate/collision, `name#epoch` refs), ClaimV2 multi-holder (`h1+h2|iso`, back-compatible: 1 holder = today's wire format), C1 SpawnRequest, C2 CompletionReport (outcome-conditional refinements), C3 FleetBrief, C4 FleetReply, C6 BoardQueue, C7 LineageRecord, C8 TokenVocabulary (role, issue, slug, parent, root, depth, state, branch, claim, pr, spawn_epoch, harness, inner, fresh), C9 EscalationPayload (enumerated options + recommended + resume path). All carry `contract` + `contract_version: 1`.
- **`ralph/scripts/board.ts`**: Claim parse/format → ClaimV2 via contracts.ts (membership check, any-member heartbeat, remove-holder release, last-out clears); new `board contract <validate|emit|lint>` subcommand; L1–L13 static-checkable lints in `lint` (live-side lints L3/L5/L7/L10 land with the watcher in Phase 2 — `lint --live` reserved).
- **`ralph/contracts/examples/`** (new): ≥1 good + ≥1 bad instance per contract.
- **`ralph/contracts/generated/*.schema.json`** (generated): via `board contract emit`; `npm run contracts:check` drift-fails CI.
- **`plugin/ralph-herdr/scripts/naming.sh`** (new, bash 3.2): `ralph_agent_name <lane> <issue> <title>` (slugify + truncate), `ralph_agent_parse <name>`, collision suffix; **`lib.sh`** spawn path emits `w<issue>-<slug>` instead of `gh-N`; `ralph_agents_json` regex accepts both grammars during transition.
- **Tests**: `ralph/scripts/contracts.test.ts` (round-trips, bad examples, naming tables, claim v2); `plugin/ralph-herdr/tests/naming.test.sh` (standalone sh, wired as `npm run test:naming`); board.test.ts additions for ClaimV2.

### Phase 2 — watcher + lineage + events ledger
`plugin/ralph-herdr/scripts/watcher.sh` (or small TS) holding one `events.subscribe`; sole appender of `~/.ralph/<repo>/ledger.jsonl` (C7 records + state/adopt/exit events); startup reconciliation (discover / exit:lost / adoption policy); metadata tokens pushed at spawn (incl. `harness`); heartbeat token w/ TTL; escalation path (notification + phone-answerable issue comment); manifest gains `[[events]]` + `[[startup]]`; live lints wired.

### Phase 3 — fleet frontier + shared-claim fleets
`board frontier --json` (Ready ∧ blockers-merged, streamed); fleet controller refill loop replacing NN×NN spawn; shared-claim join/leave for multi-sibling issues; per-run state `~/.ralph/runs/<id>/` (briefs, reports, inbox).

### Phase 4 — card substrate
`[[link_handlers]]` for issue/PR URLs → focus-or-spawn; blocked-first `agent.view`; `board answer N -m` verb (comment-first); attend upgraded to read the blocking question tail.

### Phase 5 — `ralph cockpit` TUI
bubbletea card board (columns = board states; Enter observe, **space/o peek**, r reply, a answer, s spawn, v DAG, d diff); 5-rung degradation (events → poll → fzf → dashboard.sh → board/gh); keybinding audit vs herdr config.toml interception documented before defaults are locked; `[[build]]` in manifest.
### Phase 6 — BDD + nightly live + skills/docs
cucumber-js features/ + socket step defs reusing contracts; nightly `herdr --session ralph-test` job; replay transcripts per-PR; skills ship herdr reference doc + HERDR_ENV hook; escalation-writing guidance in work/board skills. Claim-TTL probe executed before any unattended arming.

## Phase 1 verification
`npx vitest run ralph/scripts/` green · `npm run contracts:check` green · `bash plugin/ralph-herdr/tests/naming.test.sh` green · `shellcheck` clean on new/changed bash · every good example validates, every bad example fails with the expected error.
