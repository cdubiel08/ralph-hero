# Changelog — ralph-herdr

Version history for the `ralph-herdr` herdr plugin (`plugin/ralph-herdr/herdr-plugin.toml`).
Prior to GH-2491 this history lived as a running changelog appended to the
manifest's `description` field, one line per PR — every plugin-touching PR
collided on it. GH-2491 moved it here and made the stamp itself a
release-time concern (`scripts/herdr-plugin-release-bump.sh`, run from
`release-ralph.yml`) instead of a per-PR requirement.

## v1

Cockpit for the ralph board on herdr — spawn lane sessions into panes, watch queues, get notified when a session blocks or finishes.

## v2

Watcher keeps an append-only agent ledger and decorates panes with lifecycle tokens

## v3

Adds opt-in fleet refill from the board frontier and shared-claim sibling fleets

## v4

Adds the card substrate: issue/PR link handlers (click → focus-or-offer), a comment-first Human Needed answer pane, and attend carrying the blocking question

## v5

Adds the cockpit pane: a three-column board TUI (Go) over a degradation ladder — fzf fallback, then the dashboard — that loses chrome, never verbs

## v6

Adds fork right/down/tab — open a pane already holding a running session's context, via `claude --resume <id> --fork-session`

## v7

(2026-08-19 audit) adds worktree provisioning at spawn, provisional ledger rows + spawn-delivery verification with a modal probe, the lock-aware spawn pre-check, fleet-status/fleet-send, herdr-plugin-sync (content-hash freshness), and the cockpit's write-stamp watch + liveness heartbeat

## v8

Makes the cockpit action focus-or-open (GH-2074) so invoking it twice focuses the live cockpit instead of stacking a second

## v9

Adds the team form (GH-2178): work-team spawns a standing read-only o-lane lead per epic beside the fleet, respawnable from board state alone

## v10

Adds hero (GH-2182): the attended face of the dispatch lane — one pane holding an interactive /ralph:hero session that rehydrates from board brief + leases + inbox and stands as the human's single point of contact for the sitting, never load-bearing

## v11

Adds event-driven healing (GH-2212): a dead lead's pane.exited respawns it via work-team --lead-only (pane-proved, GH-1863), flags the orphaned team space for sweep, and stamps the per-repo dispatch heartbeat that doctor's advisory reads

## v12

Makes team launch lead-only (GH-2214, D3.2): work-team spawns the lead and stops, and the lead staffs its own workers via work-fleet --epic under the fleet's guards (spawn-edge included), with worker spawn records carrying the lead's ref as C8 parent/root lineage

## v13

Adds dispatch up (GH-2213, D3.1): one idempotent command that stands up the named <repo>/dispatch workspace with the hero pane and prints the roster — re-run heals (reopen space/pane), and it arms nothing scheduled (the unattended half of dispatch stays the event lane)

## v14

Adds the cockpit topology view (GH-2219, D6.1): T renders the roster tree — dispatch → teams → leads → workers — from board roster --json, liveness dots joining agent_status with C8 state tokens, escalation counts per rung from board escalations (best-effort: a failed count renders NOT COUNTED, never zero)

## v15

Seats dispatch in the repo's main workspace (GH-2246): dispatch-up resolves the main workspace by cwd match on the source checkout instead of creating a `<repo>/dispatch` sibling — the address stays the board's to mint, only placement changed; legacy dispatch spaces are noted with their manual close, never closed, and a live legacy sitting is left alone

## v16

Fixes fleet-status's dead-before-start (GH-2274): the verdict no longer trusts the pane's self-report token alone — a candidate row (idle/done, token never advanced) is checked against the unit's board state (one batched `board list --json`) and, only when still open, its branch's commits ahead of merge-base, so a merged feature or a zero-commit apply unit closed on evidence reads `finished` rather than earning the runnable respawn footer, and an unreadable board/branch reads `unverified` rather than either false answer

## v17

Adds tool binding on the spawn path (GH-2265): a generic `ralph_tool_binding_args` reads contracts.ts's `toolBinding` field per role instead of restating which roles are read-only at each call site — work-team.sh's orchestrator and tend-pass.sh's tender now carry a registry-driven `--disallowedTools Edit,Write,NotebookEdit`, hard-denied with the same 'No such tool available' failure the investigator's own allowlist already produced; Bash and every other builtin tool stay available, since process containment is the separate GH-2266 mechanism

## v18

Adds evidence-backed `rh day` team resume: only current-session, current-repository ledger-proven orchestrator leads are delegated through `work-team.sh --lead-only`, while unreadable or contradictory evidence launches nothing

## v19

Adds invoke.sh (GH-2291): a CLI entry point that opens a plugin pane in a NAMED repo's workspace, resolved by matching the repo path against `herdr workspace list`'s own worktree records rather than by which workspace has UI focus — the gap GH-2269 made visible but left open, since `herdr plugin action invoke` has no repo override and always resolves from `HERDR_PLUGIN_CONTEXT_JSON`. Refuses, naming candidates, when a repo is open in more than one worktree and `--workspace` does not disambiguate; the `[[panes]]` entrypoints themselves are unchanged

## v20

Makes `rh day` terminal-aware: an interactive shell focuses the current repo's dispatch hero, ensures a non-focusing cockpit split in the hero's tab, renders the inbox, and enters the full Herdr client; `--no-attach` and non-TTY automation remain background-only

## v21

Adds the ledger SQLite path, phase A (GH-2305): ledger-convert.sh is an idempotent, crash-safe JSONL→SQLite converter (schema v1, payload verbatim, --export regenerates the JSONL byte-identical — the disaster-recovery lane for every later phase), and doctor-parity.sh is the ledger-parity advisory herdr-setup relays NOTE-level: count + last-phash agreement, behind-with-intact-overlap is a note, true divergence a GAP, absent sqlite just 'not converted yet'

## v22

Dual-writes the ledger (GH-2306, phase B): ralph_ledger_append mirrors every event into the sibling ledger.sqlite when it exists — JSONL stays the truth (a sqlite failure warns and never blocks a lifecycle record, and any gap self-heals at the next convert), while an absent DB skips silently, keeping the converter the adoption path

## v23

Flips the truth (GH-2311, phase D): ralph_ledger_append writes ONLY the sqlite tape (WAL + busy_timeout; seq allocated atomically in the INSERT; the 4096-byte JSONL-atomicity ceiling is lifted; an absent DB is auto-created — adopting a legacy JSONL first, so no reader ever loses history), readers serve a present tape full stop (an unreadable present DB is a stamped error surfaced by doctor-parity, never a reason to serve the frozen JSONL; a machine with no tape keeps the legacy JSONL read behind a one-line deprecation until 1.0.0), ledger enumeration recognizes sqlite-only ledgers everywhere (watch-event, reconcile, doctor-*), the cockpit's spawn-history reader prefers the tape, and doctor-parity's line changes meaning and says so: jsonl frozen at N facts (export-only since 0.33.0), with ledger-convert.sh --export the one sanctioned JSONL surface

## v24

Adds the cockpit inbox view (GH-2318): `i` flips the body to the queue-level surface over the same `board inbox` Tier 1 read the `I` column uses — rows at full width with the decision text wrapped in full, j/k scroll, a/⏎ answering the selected decision through the comment-first `board answer` path and returning to the view, `withheld:` and `with leads:` footers counting what the reader held back — and fixes `a` on an `I`-column decision card, which the state-only test had refused.

## v25

Gives every lane action ONE tab (GH-2317): deliver/tend open via lane-open.sh in the action process, which places the launcher pane as a tab in the repo's MAIN workspace (the GH-2246 resolution, shared in lib.sh) and the launcher splits the agent pane beside itself — script-log pane on top, agent below, the tab named from the lane (`deliver`/`tend`, the same word the skill spells); a bare-shell run keeps the old lane-tab shape, and an unresolvable main workspace falls back to the invoking workspace with a note, never a refusal.

## v26

Makes a wrong-workspace launch VISIBLE (GH-2269): every workspace-context action now resolves and asserts its target through scripts/resolve-workspace.sh, which prints the resolved repo scope before anything runs and refuses (naming the resolved path) when the FOCUSED workspace herdr resolved has no board config, rather than opening a pane against the wrong repo (or one with none at all) — herdr's own resolution is unchanged and out of scope; only its result is now loud.

## v27

Adds process containment on the spawn path (GH-2266): a registry-driven `ralph_process_containment_args` hands every contained role (tender, orchestrator; the investigator records `inapplicable` — no Bash to contain) a jq-built, read-back-validated `--settings` sandbox profile — checkout realpath in denyWrite, `~/.ralph` the one allowWrite, GitHub via allowedDomains (the host read in loadConfig's own order), gh's TLS via allowMachLookup com.apple.trustd.agent, the herdr socket via network.allowUnixSockets, failIfUnavailable:true, allowUnsandboxedCommands:false, excludedCommands EMPTY (an excluded `gh … > file` writes the tree — measured, so refused) — and, because this mechanism fails OPEN and SILENTLY, the spawn runs a positive in-pane self-test (`spawn_containment_probe`: one `touch inside outside`, verdict read off the filesystem, never the model) and REFUSES on anything but an observed kernel denial, closing the pane before its prompt; macOS/Seatbelt only, `not_available` elsewhere; the achieved-value vocabulary (applied|not_applied|not_available|inapplicable|unverified) lands in contracts.ts for the ledger unit (#2267)

## v28

Announces plugin staleness at spawn (GH-2260): ralph_plugin_freshness_notice runs beside billing_guard at every spawn entry point and states, advisorily and never as a gate, when the INSTALLED tree differs from the checkout — herdr has no auto-update and the lanes that execute the installed copy are exactly the ones that would run stale code unannounced

## v29

Closes the notice's own gaps (GH-2340): the three spawn paths it missed — refill, the link-offer card, and the cockpit's `s` (whose spawn discards stderr on success, so the cockpit now lifts the verdict off it and appends `plugin STALE` / `freshness NOT CHECKED` to the spawn status) — announce too, and the notice runs its OWN sibling herdr-plugin-sync.sh with the checkout handed over as a `--source` tree to hash, rather than executing whatever sync script the worktree it was pointed at happened to carry.

## v30

Adds team stand-down (GH-2357): `work-team.sh EPIC --stand-down` (and the team-stand-down action) parks a LIVE lead deliberately — it appends the durable {ev: exit, reason: stood-down} fact for the lead's ledger ref under the ledger mutex and only THEN closes the team workspace, so the event healer finds the ref already closed and respawns nothing (before this, an operator's /exit in a parked epic's lead pane read as a crash and was respawned within seconds, forever); heal.sh carries a second guard on the same fact, and `rh day`'s resume-teams.sh treats stood-down as closed — a human re-arms the team by running work-team.sh EPIC again

## v31

Fixes ralph_driver_guard (GH-2356): the one-writer-per-tree check read the JSONL locator with a bare jq call and went blind on the SQLite tape (the truth since phase D/GH-2311) — a frozen ledger.jsonl or a fully-converted machine's absent JSONL both silently stood the guard down. It now reads through ralph_ledger_open_rows, the shared tape/JSONL-fallback reducer every other consumer already uses.

## v32

Is the cockpit QA pass on the v2 delivery (GH-2405): the glyph tier is read from ~/.ralph/config (`cockpit_glyphs=`) when the pane's env carries no RALPH_COCKPIT_GLYPHS — a font is a machine property and a herdr pane does not inherit the operator's shell exports; the context alert is 60%/80% of the LAST call's model window instead of a fixed 120k/160k (the fleet runs 1M-window models); Done cards carry Priority/Estimate via `board closed --fields` (opt-in, +10 pts/page measured) and render line 3 like every other column; the header's `today` prices every ledger session that spawned or reported since midnight rather than the sessions on screen; and the footer is two right-aligned rows with the status line overwriting the navigation row, cleared on the next key or after 30 s.

## v33

Adds model-ab-report.sh (GH-2352): reads the ledger's spawn/usage/finish facts and groups driver units by the GH-2350 spawn-time model_requested (falling back to the usage fact's billed model for the pre-knob population), reporting $/closed issue over measured closed issues, calls/unit, an unmeasured count (a unit with no usage fact is never priced at zero), the finish.via split, and the issues whose units span more than one model bucket — the tool behind the driver Fable 5.1 vs Opus 5 A/B protocol.

## v34

Gives doctor-lineage.sh a first reader for GH-2267's containment fields (GH-2361): the live-side single-record pass now checks a live agent's latest tool_binding/process_containment against its role's registry requirement (accepted tool_binding for every non-driver role; process_containment applied, or inapplicable when the role's harness grants no Bash) and names the row as a GAP when they diverge — a record with no role or no recorded words is skipped, never flagged.

## v36

Widens ralph_lane_model's per-lane model shape check (GH-2375): the argv-safety check moves from an allowlist ([A-Za-z0-9._:\[\]-]{0,79}) to a denylist — refuse whitespace, shell metacharacters, and a leading '-', with no length ceiling — so Vertex AI ids (@) and Bedrock application inference-profile ARNs (/, :, >80 chars) reach `claude --model` instead of being refused before the harness (which owns model validity) ever sees them; tick.sh's mirrored driver-model check moves the same way; both refuse control bytes (ESC, CR, ...) too, and every shape refusal prints the value via %q rather than raw — the refused value is refused BECAUSE it can carry a control byte, so echoing it unescaped to stderr would forge the same terminal output the refusal exists to prevent (Codex + Greptile review, PR #2422); GH-2429 (PR #2430, landed separately) converts these same messages from echo to printf repo-wide for the identical xpg_echo reason

## v37

Fixes the manifest itself (GH-2431): the v36 description text embedded a regex literal (\[A-Za-z0-9._:\[\]-\]) as unescaped backslashes, which is not a legal TOML basic-string escape — every install from 0.51.4 through 0.51.7 failed a TOML parse before the cockpit ever ran, so no release since GH-2375 landed installed anywhere; check-herdr-version-bump.sh now parses this manifest with tomllib at HEAD, independent of the bump check, so an unparseable file fails CI rather than merging silently

## v38

Adds a fourth watcher subscription (GH-2434): worktree.removed closes the ledger-staleness gap GH-2365 documented — herdr's own worktree.remove handler races its pane-death detector (workspace/pane bookkeeping is torn down BEFORE the pane's death is observed), so pane.exited/pane.closed never fire on this path (100% reproduction) and a worker torn down via worktree removal stayed ledger-open until the next [[startup]] reconcile (observed up to 40 min); worktree.removed's payload carries the removed checkout's absolute path independent of pane/workspace bookkeeping, so watch-event.sh's new ralph_ledger_open_for_checkout correlates the exit through the ledger's own latest recorded checkout instead of a pane_id, running the same exit-append / usage-append / orphan-pass / refill / heal sequence handle_gone already runs for pane.exited/pane.closed, reason `worktree_removed`; min_herdr_version moves to 0.8.2, the version this was verified against via herdr api schema --json.

## v39

Moves team staffing out of the lead's contained pane (GH-2461): D3.2 had the lead run work-fleet.sh --epic EPIC from its own pane, but GH-2266's process containment denies that pane write access to the checkout it sits in, so spawn_work_session's git fetch could never succeed there — work-team.sh now spawns the lead AND the epic-scoped initial fleet itself, uncontained, then arms refill (work-fleet.sh --epic EPIC --refill, its scope carried in fleet.json's new epic field) so the watcher keeps the team staffed from the epic's frontier as workers exit; a lead's pane that still tries to spawn now refuses naming the containment cause instead of surfacing git's bare error
