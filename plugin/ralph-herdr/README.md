# ralph-herdr

A [herdr](https://herdr.dev/) plugin — **not** a Claude Code plugin — that gives the
ralph board a cockpit: spawn lane sessions into persistent panes, watch the queues,
and get notified the moment a session blocks or finishes instead of at timeout.

It is an **attention surface, not a write surface**. The board remains the sole source
of truth and `board.ts` + `state-guard.yml` remain the only enforcement. These scripts
read the board through the repo's own `ralph/scripts/board` CLI and orchestrate herdr
(worktrees, agents, notifications); the only board mutations happen *inside* the
spawned `/ralph:work` / `/ralph:deliver` / `/ralph:tend` sessions, through the same
typed CLI every session uses. `work-next` does not claim the issue — the session it
spawns does.

## Requirements

- herdr >= 0.8.0 with a running server (`herdr`), plus `jq`
- a ralph-configured repo: a reachable board CLI, board scope configured
  (`.ralph.json` or the tracked `.claude/settings.json` env block — board.ts reads
  both from the repo tree, so panes need no scope env), `gh` authed with
  `repo,project` scopes. The board CLI is discovered in order (GH-1761):
  `RALPH_HERDR_BOARD` override → `ralph/scripts/board` in the repo tree (the
  vendored-checkout layout, i.e. ralph-hero itself) → the newest installed ralph
  Claude Code plugin copy (`~/.claude/plugins/cache/*/ralph/*/scripts/board`), so
  host repos that install ralph as a plugin work with no configuration. The
  scripts die loudly when none of the three exists.
- optional but recommended: `herdr integration install claude` (session-identity
  restore after server restart; it does not change how `blocked` is detected)

If ralph is installed as a Claude Code plugin, `/ralph:help herdr` checks all of
the above (`ralph/scripts/herdr-setup.sh check`) and can wire the automatable
steps with your permission; `board doctor` carries the same verdict as its
advisory `herdr-cockpit` line.

## Install

Development (local checkout):

```bash
herdr plugin link /path/to/ralph-hero/plugin/ralph-herdr
```

From GitHub:

```bash
herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr
```

Invoke actions from a workspace whose cwd is the ralph-configured repo (herdr's action
menu, or `herdr plugin action invoke <id> --plugin ralph-herdr`).

## The nesting model

herdr's shapes map onto ralph's without translation:

- **workspace = project.** The repo workspace is where you invoke actions; its cwd
  is the board's scope.
- **grouped worktree workspaces = issues.** Each `gh-N` session lives in its own
  worktree workspace, and herdr groups those under the repo workspace — exactly as
  children group under an epic on the board. When an issue has a board parent, the
  worktree carries a `--label "GH-N via GH-parent"` so the grouping reads the same
  in herdr as it does on the board.
- **tabs = lanes.** A lane pass (`ralph-deliver` / `ralph-tend`) gets a tab of its
  own; one live pass per lane, by name.
- **panes = sessions.** One agent per pane; the pane outliving the session is the
  point (transcript stays for review).

## The actions

| Action | Pane | What it does |
|---|---|---|
| `work-next` | split (down) | `board next` → if empty, says so and exits. Otherwise: fetch, `herdr worktree create --branch feature/GH-N --base origin/main` (`--base` only applies to brand-new branches — an existing `feature/GH-N` branch is silently resumed as-is, possibly behind origin/main, and the session rebases; `worktree open` is the fallback when the *checkout* already exists), start agent `gh-N` in the new workspace's pane, prompt `/ralph:work N`, then the cockpit pane becomes the notification watcher. An already-live `gh-N` is a skip, not an error: it prints "SKIP gh-N already live" and exits 0 with no worktree touched (wrapper authors: exit 0 does not always mean a session was spawned) |
| `work-fleet` | split (down) | reads the frontier once (`board frontier --json` when the verb exists, else the ranked `board next` queue — already dependency-aware) and spawns up to `RALPH_HERDR_FLEET` (default 2, hard cap 4) work sessions — same spawn path as `work-next`, per issue, plus a C3 FleetBrief per spawn under the run's `briefs/` dir. Already-live agents are skipped, one failed spawn doesn't strand the rest; the pane then watches all spawned agents. With `--refill` / `RALPH_HERDR_REFILL=1` it also ARMS the run for watcher refill — see [Fleet refill](#fleet-refill-experimental-until-the-claim-ttl-probe) |
| `work-issue-fleet` | split (down) | **shared-claim sibling fleet**: `RALPH_HERDR_SIBLINGS` (default 2, cap 4) sessions on ONE issue, one worktree, one branch. Sibling 1 is a normal `work-next`-style spawn; siblings 2..K are pane splits in the same workspace (names `w<N>-<slug>--2`…), each prompted `/ralph:work N` and briefed with the shared branch. The claim join runs AFTER the spawns: `board claim join` is for In Progress items only, so the script waits (bounded, `RALPH_HERDR_JOIN_WAIT_SEC`) for sibling 1's session to claim, then joins each sibling via `board claim join N --holder <name>` — a timeout or refusal warns and prints the manual join, never blocks the spawn. The pane prompts for the issue number (or set `RALPH_HERDR_ISSUE`) |
| `attend` | none | no pane, no loop: finds the highest-priority `blocked` ralph agent (issue sessions — `gh-N` / w-lane — before every other lane; within a group, oldest blocked-since first from the ledger's state-record timestamps, agent-list order when the ledger can't say), `herdr agent focus` jumps you to it, and the notification **carries the question**: the pane's last non-empty tail lines (`agent read --source recent-unwrapped`), flattened to one ≤240-char line, with `#N` in the title when the name resolves to an issue. Nothing blocked → "herd calm". Safe to bind to a key |
| `answer` | popup | walk Human Needed and answer ONE item, **comment-first**: `board list --state "Human Needed" --json` → pick → the issue's latest comments (bounded `gh issue view --comments` tail) → type the answer mail(1)-style (end with a lone `.` line) → `board answer N -m` posts the **Answer** issue comment BEFORE the Human Needed → In Progress move (board.ts owns that ordering — if the pane or herdr vanishes mid-answer, the decision is already on the record). Only then, if a live session owns N, a `herdr agent prompt … --wait` nudge — delivery reported honestly, never assumed. A board CLI predating the verb falls back to `gh issue comment` + `board move`, same ordering |
| `link-open` | none* | the `[[link_handlers]]` target — click a `github.com/<owner>/<repo>/issues\|pull/N` URL in any pane: in-scope URL with a live session for N → `agent focus`; in-scope with no session → the `link-offer` popup (board state + `[s]` spawn via the same sanctioned `spawn_work_session` path / `[o]` browser / `[q]` close); out-of-scope or unresolvable scope → OS browser. The manifest pattern is generic on purpose; the script owns the scope judgment. *Also listed as a plain action; invoked without a clicked URL it says so in the plugin log and exits |
| `deliver-pass` | split (down) | `board deliver-queue` → empty means spawn nothing (the lane contract). Otherwise a new tab hosts agent `ralph-deliver` running `/ralph:deliver`; cockpit pane watches |
| `tend-pass` | split (down) | same shape over `board tend-queue` → agent `ralph-tend` running `/ralph:tend` |
| `doctor` | popup | runs `board doctor` once, holds the popup open until Enter |
| `dashboard` | split (right) | read-only watch loop: board `next` (number/title/estimate + queue depth), deliver-queue, tend-queue, Human Needed count. No doctor call in the loop — doctor is its own action |

The watcher (`scripts/notify-watch.sh`) tracks one or many agents. Single target:
`herdr agent wait` (its default until-states are exactly blocked/done/idle — never
repeated as flags) — level-triggered, no timeout, hangs on purpose — then fires
`herdr notification show` naming the agent, its state, and the repo; it re-arms
while the session keeps blocking and exits once the session is done or idle.
Multiple targets (the fleet case): a portable poll loop (`agent get` every
`RALPH_HERDR_WATCH_POLL`s) notifies on each agent's first block and once on
done/idle/gone, dropping it from the watch list; exits when the list is empty.

Agent names are fixed: `gh-N` for work sessions, `ralph-deliver` / `ralph-tend` for
lane passes — one live pass per lane. If a name is taken the script dies loudly
("a pass is already live"); it never improvises suffixes, never kills the live agent.

## Knobs

All knobs are plain env vars with defaults (`${VAR:-default}`), documented at the top
of each script:

| Var | Default | Meaning |
|---|---|---|
| `RALPH_HERDR_BOARD` | auto-discovered | board CLI override — authoritative when set: only that path is validated, and a broken value dies loudly with no fallback. Unset, the scripts try `<repo>/ralph/scripts/board`, then the newest installed ralph plugin copy under `~/.claude/plugins/cache`. Honest caveat: herdr panes inherit the herdr **server's** environment, not your shell's — an export only reaches panes if the server itself was started with it |
| `RALPH_HERDR_DASH_INTERVAL` | `120` | dashboard refresh interval, seconds |
| `RALPH_HERDR_DRY_RUN` | unset | set to `true` and every spawn script (`work-next`, `work-fleet`, lane passes) prints its exact plan — issues, branches, agent names, the herdr commands it would run — and exits 0 before any herdr mutation. Dashboard/attend are reads and ignore it |
| `RALPH_HERDR_FLEET` | `2` | how many work sessions `work-fleet` spawns from the top of the frontier; positive integer, hard cap 4 (it dies above — this is an attended tool, not a farm). Also the refill loop's concurrency target `k` |
| `RALPH_HERDR_REFILL` | unset | `1` → `work-fleet` arms watcher refill for the run (same as `--refill`); **experimental until the claim-TTL probe** |
| `RALPH_HERDR_REFILL_TTL_MIN` | `120` | refill arming TTL, minutes — checked at read time, a lapsed arming reads as disarmed |
| `RALPH_HERDR_REFILL_BUDGET` | `8` | max total spawns per armed run (attempts count, initial spawns included) |
| `RALPH_HERDR_SIBLINGS` | `2` | `work-issue-fleet` fleet size K; 1..4 |
| `RALPH_HERDR_ISSUE` | unset | issue number for `work-issue-fleet` (skips the pane's interactive prompt) |
| `RALPH_HERDR_JOIN_WAIT_SEC` | `180` | how long `work-issue-fleet` waits for the issue to reach In Progress (sibling 1's session claiming it) before joining siblings to the shared claim; `0` = one immediate check. A timeout warns with the manual `board claim join` commands |
| `RALPH_HERDR_REPLY_TO` | `s0-watch` | FleetBrief `reply_to` agent name — the watcher is the one durable herdr-agent surface (cockpit panes are not agents) |
| `RALPH_HERDR_START_TRIES` | `15` | retries (1s apart) for `agent start` on a just-created pane still sourcing rc files (`agent_pane_busy` only, just-created panes only) |
| `RALPH_HERDR_REPO` | `$PWD` | repo the scripts operate on; the default (the pane's cwd) is almost always right |
| `HERDR_BIN_PATH` | `herdr` | path to the herdr binary |
| `RALPH_HERDR_WATCH_POLL` | `15` | poll interval, seconds, for the multi-target watcher loop (single-target watch stays event-driven) |
| `RALPH_HERDR_ANSWER_TAIL` | `40` | lines of `gh issue view --comments` the answer pane shows before the answer prompt |
| `RALPH_HERDR_ANSWER_NUDGE_MS` | `15000` | `--wait` timeout for the post-answer `agent prompt` nudge; expiry reports "sent but not confirmed", never "delivered" |
| `RALPH_ALLOW_API_BILLING` | unset | billing guard override, same contract as `tick.sh`: if `ANTHROPIC_API_KEY` is set, spawning is refused (it would bill API credits, not the subscription) unless this is exactly `true` |

Board scope (`RALPH_GH_OWNER` / `RALPH_GH_REPO` / `RALPH_GH_PROJECT_NUMBER`,
`.ralph.json`) belongs to `board.ts`, not this plugin — the scripts inherit whatever
the repo is configured with. The repo is always the pane's working directory (the
workspace the action was invoked from).

## Herding

`work-fleet` is **attended-only** parallelism: a human clicks it, watches the herd,
and answers what blocks. The mutual-exclusion backstop is not this plugin — it is
the per-issue claim protocol in `board.ts` (each spawned session claims its own
issue; a race is read back, refused, and visible). The design doc's §3.5 deferral
covers *unattended* parallelism only; a fleet you are sitting in front of is the
already-sanctioned case, capped at 4 so it stays one.

`attend` is the other half: when a notification says something blocked, one
keypress finds the first blocked agent and focuses its pane — and since v0.4.0
the notification carries the pane's last lines, so the question reaches you
even before the focus does. It never prompts, never answers, never kills — it
moves your eyes, nothing else. Answering is `answer`'s job.

## The card substrate (Phase 4)

Four surfaces make board items clickable, answerable, and orderable from the
cockpit — all decoration over the same sanctioned verbs, none of them a new
write path:

- **Link handlers.** The `[[link_handlers]]` manifest section (herdr manifest
  schema: `id`/`title`/`pattern`/`action`; the pattern is a Rust regex over
  the clicked URL) routes clicks on `github.com/*/*/issues|pull/N` URLs to the
  `link-open` action, with the URL in `HERDR_PLUGIN_CLICKED_URL` (and as
  `.clicked_url` + `.link_handler_id` in the context JSON). The pattern
  matches ANY owner/repo deliberately: the manifest cannot know the board
  scope, so `link-open.sh` reads the workspace's scope (`.ralph.json` /
  settings env — the same files board.ts reads) and judges: in-scope → focus
  the live session or offer to spawn one; out-of-scope → OS browser. GHE
  URLs never match (github.com only).
- **Answer pane.** The Human Needed exit, comment-first end to end — see the
  `answer` row above. The board verb (`board answer N -m`) owns the ordering;
  this pane only drives it and then nudges the paused session, reporting the
  nudge honestly.
- **Attend with the question attached.** See the `attend` row above; the
  blocked-since ordering reads the ledger's state records and degrades to
  agent-list order — ordering is chrome over a read, never a gate.
- **Agent view (stubbed, honestly).** `scripts/cockpit-view.sh` would pin a
  `ralph` sidebar view — filter to agents carrying the C8 `role` token, sort
  blocked-first via the `state` token. The herdr **socket** schema (protocol
  19) has `agent.view.set`/`agent.view.clear` with exactly that expressive
  power (token filters + token sorts), but the herdr **0.8.0 CLI exposes no
  invocation surface** for them — no `herdr agent view` subcommand, no
  generic `herdr api` request sender. So the script is a documented no-op
  (tokens.sh pattern: one log line, exit 0) that probes on every run and
  names the moment a CLI form appears; the intended view is pinned in its
  header. `reconcile.sh` calls it after the token re-push so the view
  re-arms on server restart the day it becomes real.

## Fleet refill (EXPERIMENTAL until the claim-TTL probe)

**The board is the wait state** — nothing idles in a pane waiting for work.
With `work-fleet --refill` (or `RALPH_HERDR_REFILL=1`), the run is ARMED:
whenever a w-lane session **exits or finishes**, the watcher tops the fleet
back up to `k` from the dependency-aware frontier. **Never on blocked** —
blocked is attention, not capacity, and only ever produces a notification.

This is *experimental until the claim-TTL probe* (design doc §3.1/§5 — a pane
that outlives its claim can double-work against a fresh claimant; the probe
has not been run yet). Until then refill is bounded three ways, all recorded
in the run's `fleet.json` at arm time and enforced at read time — no timers,
no daemons, no arming survives them:

- **opt-in per run** — the flag arms exactly one run; the default click is
  today's one-shot fleet, unchanged;
- **a TTL** (`RALPH_HERDR_REFILL_TTL_MIN`, default 120 min) — expiry is
  checked every time the state is read; a lapsed arming reads as disarmed;
- **a max-total-spawns budget** (`RALPH_HERDR_REFILL_BUDGET`, default 8),
  counting every spawn *attempt* this run, initial spawns included — a
  failed attempt spends a unit rather than risking a retry loop, and a
  refill never re-picks an issue the run already spawned (a crashed sibling
  is attention, not capacity).

Refill fails CLOSED on uncertainty: an unreadable agent list skips the pass
(armed and untouched — an unknown herd is never spawned into), and spawns
still in flight (picked but not yet visible to `agent list`) count toward
`k` via the run's `inflight` set, so a burst of triggers never overshoots
the fleet. The frontier and agent-list reads happen outside the scope's
ledger mutex — only the fleet.json decide-and-consume is serialized.

When the frontier empties or the budget runs out, the run disarms itself and
one notification says `fleet run <id> complete`. Every refill spawn appends a
`refill_spawn` event to the ledger next to its C7 spawn record, with
`invoked_by: scheduler` in the lineage — machine-initiated spawns are labeled
honestly.

### Per-run state

```text
~/.ralph/<owner>/<repo>/runs/<run_id>/     # run_id = UTC timestamp + 4 hex
  fleet.json           arming state: {run_id, armed, k, refill, budget_left,
                       expires_at, repo, spawned: [...], inflight: [...]}
                       (armed is written as refill==1 — a refill=0 arm is a
                       disarmed audit record no watcher ever refills)
  briefs/<agent_ref>.json   C3 FleetBrief per spawn (validated via
                       `board contract validate ralph.fleet_brief` when the
                       board CLI is reachable — warn-not-die otherwise)
  reports/             reserved for C2 CompletionReports — briefs carry a
                       stable report_path from day one; the skills learn to
                       write reports in Phase 6, and nothing reads this yet
```

## Sibling fleets (shared claims)

`work-issue-fleet` puts several sessions on ONE issue — Claim v2 holds up to
8 holders, and this action is the cockpit's explicit-join surface (capped at
4 siblings; attended, same bar as `work-fleet`). One worktree, one shared
`feature/GH-N` branch: sibling 1 spawns normally and claims inside its
session; siblings 2..K split panes in the same workspace and get `--2`…`--K`
generation names. The claim join is DEFERRED to the moment it can succeed:
`board claim join` accepts In Progress items only (no `--force` anywhere),
and a fresh fleet's issue stays Backlog until sibling 1's session boots and
claims it — so the script waits (bounded, `RALPH_HERDR_JOIN_WAIT_SEC`,
default 180 s) for In Progress, then joins each sibling via `board claim
join N --holder <name>`. A timeout or refusal warns and prints the manual
join command per sibling — it never blocks the spawn, and the sessions keep
working meanwhile (they share the machine's claim-holder identity).

In the ledger, siblings are **peers, not children**: `parent` stays empty and
depth stays 0 (the depth cap exists for runaway trees, and a flat fleet is
not one); `root` points at the first sibling's ref so sidebar views that
group by root show the fleet as one cluster. Coordinating siblings on one
branch is the sessions' problem, honestly: the skills have not yet learned
sibling semantics, so expect to attend these fleets closely.

## Honest limits

- **`blocked` is screen-detected and hint-only.** Claude Code has no lifecycle
  authority in herdr; the chip comes from screen-manifest matching. It sharpens
  attention, it never gates anything. Likewise `working` measures liveness, not
  progress — a session parked in a CI wait reads `working` for as long as it polls.
- **Notifications are advisory.** Missing one changes nothing about board state; the
  board comment trail is the record.
- **The board is the sole source of truth.** No script here writes Workflow State,
  uses `--force`, or kills an agent process. Read the queues, spawn a session, watch,
  notify — that is the whole surface.
- **The watcher observes; it never enforces.** The `[[events]]` hooks
  (`watch-event.sh`) fire only while the herdr server runs — server down means no
  events, and nothing replays them. The `[[startup]]` reconcile pass heals the gap
  after the fact (exit `reason=lost` for vanished agents, `discover` for unledgered
  live ones), so the ledger is *eventually* honest, never real-time: its freshness is
  bounded by server uptime plus the last reconcile. A blocked agent whose event was
  missed is caught by the next status change or reconcile, not guaranteed at the
  moment it blocked.
- **The ledger (`~/.ralph/<owner>/<repo>/ledger.jsonl`) is an append-only
  observation log, not an authority.** Nothing gates on it; readers are pure jq
  reductions and duplicate events are tolerated by design. The watcher is its sole
  appender with one documented carve-out: `lib.sh`'s spawn path appends the spawn
  record itself (the C7 lineage), because spawn completes before any event hook can
  fire. It lives outside every repo on purpose — worktree-per-job would make an
  in-repo ledger a merge hazard.
- **Pane tokens are chrome.** Pushed best-effort via `herdr pane report-metadata`;
  a push failure is a one-time warning, never an aborted verb, and a server restart
  drops them until reconcile re-pushes. The state token only claims what maps
  honestly (`working`/`blocked`); `idle`/`done` update the ledger, not the chip.
- **The orphan pass records, it does not reap.** A dead parent's children are
  adopted by a live grandparent or marked `orphaned` (token + ledger + one
  notification) — their claims and panes are left alone. The Phase-3 fleet
  controller REFILLS capacity; it still never reaps, kills, or releases anything.
- **Refill is experimental until the claim-TTL probe, and bounded like it.** The
  probe (a pane that outlives its claim can double-work against a fresh claimant —
  design doc §3.1/§5) has not been run yet, so nothing here arms itself: refill is
  opt-in per run, TTL-capped, budget-capped, and disarms itself at frontier-empty
  or budget-exhausted (see [Fleet refill](#fleet-refill-experimental-until-the-claim-ttl-probe)).
  Every OTHER action in this plugin remains human-clicked one-shots;
  scheduler-owned herdr ticks stay in `ralph/examples/tick-herdr.sh`, which bounds its
  wait at the TTL, wraps up rather than kills, and requires its own typed
  `herdr_autopilot=true` opt-in key on top of tick.sh's `autopilot=true` — an existing
  tick.sh arming never silently extends to pane-persistence ticks.
- **Fleet briefs and per-run state are observations.** `fleet.json`, `briefs/`,
  `reports/` decorate and bound the cockpit's own behavior; the board stays
  authoritative for what is claimed and what is done, and nothing on the board
  gates on a run file.
- **Link handlers need a herdr that ships them.** The installed herdr 0.8.0
  demonstrably does (its API schema carries `PluginManifestLinkHandler`, its
  binary exports `HERDR_PLUGIN_CLICKED_URL`/`HERDR_PLUGIN_LINK_HANDLER_ID` —
  both probed read-only); an older herdr may ignore or reject the
  `[[link_handlers]]` section, and `min_herdr_version = "0.8.0"` encodes only
  what was verified here. The manifest is validated as TOML with cross-checked
  action references (`python3 -c 'import tomllib; …'`) — deliberately **not**
  by `herdr plugin link` against a scratch copy, because linking registers a
  live plugin (actions, event hooks and all) and a validation step must not
  touch the plugin registry. Re-linking your real checkout after editing is
  the honest end-to-end check.
- **The answer nudge is best-effort and says so.** The durable half is the
  **Answer** issue comment; the `agent prompt --wait` afterwards can time out
  with the prompt delivered (a working session just didn't change status in
  time) — the pane reports "sent but not confirmed", prints the manual prompt
  command, and the board record is complete either way.
- **The `ralph` agent view does not exist yet.** `agent.view.set` lives on the
  socket, not in the 0.8.0 CLI — cockpit-view.sh is a probing no-op until a
  CLI form ships (see [The card substrate](#the-card-substrate-phase-4)).
- **A herdr plugin is unsandboxed local code** with your permissions. This one stays
  read-mostly by construction, but read the scripts before linking — they are short
  on purpose.

## Pointers

- **Getting started at the terminal**: [CHEATSHEET.md](CHEATSHEET.md) — from-zero
  quick start (ralph `board setup`/`readiness` + herdr install) through the
  actions, herd inspection, hand-driving, and debugging.

- Design record (normative): `thoughts/shared/research/2026-08-09-herdr-runtime-ralph-addon.md`
- Scheduler-owned herdr tick recipe: `ralph/examples/tick-herdr.sh` (copy and own —
  scripts are examples, contracts are doctrine: `ralph/examples/README.md`)
