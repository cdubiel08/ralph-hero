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
- **grouped worktree workspaces = issues.** Each work session (`w<N>-<slug>`,
  legacy `gh-N`) lives in its own worktree workspace, and herdr groups those under
  the repo workspace — exactly as children group under an epic on the board. When an issue has a board parent, the
  worktree carries a `--label "GH-N via GH-parent"` so the grouping reads the same
  in herdr as it does on the board.
- **tabs = lanes.** A lane pass (`ralph-deliver` / `ralph-tend`) gets a tab of its
  own; one live pass per lane, by name.
- **panes = sessions.** One agent per pane; the pane outliving the session is the
  point (transcript stays for review).

## The actions

| Action | Pane | What it does |
|---|---|---|
| `work-next` | split (down) | `board next` → if empty, says so and exits. Otherwise: fetch, `herdr worktree create --branch feature/GH-N --base origin/main` (`--base` only applies to brand-new branches — an existing `feature/GH-N` branch is silently resumed as-is, possibly behind origin/main, and the session rebases; `worktree open` is the fallback when the *checkout* already exists), start agent `w<N>-<slug>` (grammar B, slug from the issue title — see [Agent names](#agent-names-grammar-b)) in the new workspace's pane, prompt `/ralph:work N`, then the cockpit pane becomes the notification watcher. An issue already owned by a live session (any `w<N>-*`, or legacy `gh-N`) is a skip, not an error: it prints "SKIP <name> already live" and exits 0 with no worktree touched (wrapper authors: exit 0 does not always mean a session was spawned) |
| `work-fleet` | split (down) | reads the frontier once (`board frontier --json` when the verb exists, else the ranked `board next` queue — already dependency-aware) and spawns up to `RALPH_HERDR_FLEET` (default 2, hard cap 4) work sessions — same spawn path as `work-next`, per issue, plus a C3 FleetBrief per spawn under the run's `briefs/` dir. Already-live agents are skipped, one failed spawn doesn't strand the rest; the pane then watches all spawned agents. With `--refill` / `RALPH_HERDR_REFILL=1` it also ARMS the run for watcher refill — see [Fleet refill](#fleet-refill-opt-in-the-claim-ttl-probe-says-no-go-on-default-arming). **Naming issues** (`work-fleet.sh 1778 1774`, GH-1780) spawns exactly those instead, in the order given, under the same cap and guards — ranking is the default policy, not the only one. The frontier read then serves as the eligibility oracle: an issue it does not admit is skipped with the reason (`blocked by #7 #8`, or the board's own one-line `get` view for claimed/closed/off-board) and the rest still spawn. `--refill` is refused with a list — a named set is closed, so there is nothing to top it up from |
| `work-these` | split (down) | the same fleet, prompted: asks for a space-separated issue list and execs `work-fleet.sh` with it (empty input = the ranked frontier, so it is a superset of `work-fleet`). Exists because "run a fleet on THESE issues" is where the intent is actually expressed in the cockpit, and there is no argv to type into. Every guard lives downstream in `work-fleet.sh`; this pane duplicates none of them |
| `attend` | none | no pane, no loop: finds the highest-priority `blocked` ralph agent (issue sessions — `gh-N` / w-lane — before every other lane; within a group, oldest blocked-since first from the ledger's state-record timestamps, agent-list order when the ledger can't say), `herdr agent focus` jumps you to it, and the notification **carries the question**: the pane's last non-empty tail lines (`agent read --source recent-unwrapped`), flattened to one ≤240-char line, with `#N` in the title when the name resolves to an issue. Nothing blocked → "herd calm". Safe to bind to a key |
| `answer` | popup | walk Human Needed and answer ONE item, **comment-first**: `board list --state "Human Needed" --json` → pick → the issue's latest comments (bounded `gh issue view --comments` tail) → type the answer mail(1)-style (end with a lone `.` line) → `board answer N -m` posts the **Answer** issue comment BEFORE the Human Needed → In Progress move (board.ts owns that ordering — if the pane or herdr vanishes mid-answer, the decision is already on the record). Only then, if a live session owns N, a `herdr agent prompt … --wait` nudge — delivery reported honestly, never assumed. A board CLI predating the verb falls back to `gh issue comment` + `board move`, same ordering |
| `link-open` | none* | the `[[link_handlers]]` target — click a `github.com/<owner>/<repo>/issues\|pull/N` URL in any pane: in-scope URL with a live session for N → `agent focus`; in-scope with no session → the `link-offer` popup (board state + `[s]` spawn via the same sanctioned `spawn_work_session` path / `[o]` browser / `[q]` close); out-of-scope or unresolvable scope → OS browser. The manifest pattern is generic on purpose; the script owns the scope judgment. *Also listed as a plain action; invoked without a clicked URL it says so in the plugin log and exits |
| `deliver-pass` | split (down) | `board deliver-queue` → empty means spawn nothing (the lane contract). Otherwise a new tab hosts agent `ralph-deliver` running `/ralph:deliver`; cockpit pane watches |
| `tend-pass` | split (down) | same shape over `board tend-queue` → agent `ralph-tend` running `/ralph:tend` |
| `doctor` | popup | runs `board doctor` once, holds the popup open until Enter |
| `cockpit` | split (right) | the board cockpit through the degradation ladder (`scripts/cockpit-launch.sh`): the built Go TUI when present, the verb-complete fzf fallback when not, the read-only dashboard when neither — the pane's first line names the rung it took and why. See [The cockpit](#the-cockpit-phase-5-and-its-degradation-ladder) |
| `dashboard` | split (right) | read-only watch loop: board `next` (number/title/estimate + queue depth), deliver-queue, tend-queue, Human Needed count. No doctor call in the loop — doctor is its own action |

The watcher (`scripts/notify-watch.sh`) tracks one or many agents. Single target:
`herdr agent wait` (its default until-states are exactly blocked/done/idle — never
repeated as flags) — level-triggered, no timeout, hangs on purpose — then fires
`herdr notification show` naming the agent, its state, and the repo; it re-arms
while the session keeps blocking and exits once the session is done or idle.
Multiple targets (the fleet case): a portable poll loop (`agent get` every
`RALPH_HERDR_WATCH_POLL`s) notifies on each agent's first block and once on
done/idle/gone, dropping it from the watch list; exits when the list is empty.

### Agent names (grammar B)

Work sessions are named `<lane><issue>-<slug>[--<gen>]` (≤32 chars) —
`w1743-fix-claim-race` — with the slug derived from the issue title
(`scripts/naming.sh`, mirroring `ralph/scripts/contracts.ts`; a shared golden
table pins both). `--2`..`--9` generations belong to sibling issue fleets
only; the spawn path never improvises one on a collision — a live session
owning the issue is a skip. The durable identity is the ref `name#epoch` in
the ledger; pane ids are server-scoped and never durable. Lane passes keep
their fixed names `ralph-deliver` / `ralph-tend` — one live pass per lane; a
taken name dies loudly ("a pass is already live") and never kills the live
agent. Legacy `gh-N` names stay first-class through the transition. The full
agent-facing reference (lane table, tokens, self-report, fleet claims) is
`ralph/skills/work/references/herdr-api.md` in the ralph Claude Code plugin.

## Knobs

All knobs are plain env vars with defaults (`${VAR:-default}`), documented at the top
of each script:

| Var | Default | Meaning |
|---|---|---|
| `RALPH_HERDR_BOARD` | auto-discovered | board CLI override — authoritative when set: only that path is validated, and a broken value dies loudly with no fallback. Unset, the scripts try `<repo>/ralph/scripts/board`, then the newest installed ralph plugin copy under `~/.claude/plugins/cache`. Honest caveat: herdr panes inherit the herdr **server's** environment, not your shell's — an export only reaches panes if the server itself was started with it |
| `RALPH_COCKPIT_INTERVAL` | `30` | Go cockpit TUI board-poll cadence, seconds (min 10). The fzf rung ignores it — it re-reads the board on every interaction instead of on a timer |
| `RALPH_HERDR_PEEK_LINES` | `40` | fzf-rung peek/preview depth: pane-tail lines (`herdr agent read`) or latest-comment lines (`gh issue view --comments` tail) |
| `RALPH_HERDR_DASH_INTERVAL` | `120` | dashboard refresh interval, seconds |
| `RALPH_HERDR_DRY_RUN` | unset | set to `true` and every spawn script (`work-next`, `work-fleet`, lane passes) prints its exact plan — issues, branches, agent names, the herdr commands it would run — and exits 0 before any herdr mutation. Dashboard/attend are reads and ignore it |
| `RALPH_HERDR_FLEET` | `2` | how many work sessions `work-fleet` spawns from the top of the frontier; positive integer, hard cap 4 (it dies above — this is an attended tool, not a farm). Also the refill loop's concurrency target `k` |
| `RALPH_HERDR_REFILL` | unset | `1` → `work-fleet` arms watcher refill for the run (same as `--refill`); **stays opt-in — the 2026-08-11 claim-TTL probe returned NO-GO for default arming** |
| `RALPH_HERDR_REFILL_TTL_MIN` | `120` | refill arming TTL, minutes — checked at read time, a lapsed arming reads as disarmed |
| `RALPH_HERDR_REFILL_BUDGET` | `8` | max total spawns per armed run (attempts count, initial spawns included) |
| `RALPH_HERDR_TIMEOUT_SEC` | `30` | per-call wall-clock bound on every herdr invocation; a timeout is reported as "may or may not have been applied", never as a failure |
| `RALPH_HERDR_MIN_PROTOCOL` | `19` | minimum herdr protocol accepted before any dependent operation runs |
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

## The cockpit (Phase 5) and its degradation ladder

One action, five rungs. `Ralph: cockpit` opens a right-split pane running
`scripts/cockpit-launch.sh`, which probes the host and execs the best surface
it can — logging `cockpit: rung N (<reason>)` as its first line so a pane that
opened on the "wrong" surface says why. The doctrine is fixed: **every rung
loses chrome, never a verb.**

| Rung | Surface | Taken when | What it loses |
|---|---|---|---|
| 1 | `cockpit/ralph-cockpit` — the Go TUI | the binary is built and executable (`scripts/build-cockpit.sh`, run at install by the manifest `[[build]]` hook) | nothing — full chrome |
| 2 | the **same binary**, poll-only | always, today: poll-only IS the shipped mode (herdr `[[events]]` feed the watcher, not the TUI — events integration is Phase-6+ work). A documentation distinction, not a launcher branch | event-driven freshness — the board re-reads every `RALPH_COCKPIT_INTERVAL` seconds |
| 3 | `scripts/cockpit-fzf.sh` | no built TUI, `fzf` on PATH | side-by-side columns, mouse, live glyph refresh, timed refresh — **every verb kept** (observe / peek / reply / answer / spawn / diff / browser / quit, over the same `board` / `herdr` / `gh` calls) |
| 4 | `scripts/dashboard.sh` | no built TUI, no fzf | interactivity — a read-only glance; the verbs survive one command away (`board answer N -m …`, `herdr agent focus …`) |
| 5 | `board` + `gh` standalone | no herdr at all — not a launcher branch, just the floor the ladder stands on | all chrome. `board list --state "Human Needed"`, `board answer N -m`, `board frontier`, `gh pr diff N` are the cockpit's verbs with no cockpit |

### The TUI

Three columns — **In Progress / In Review / Human Needed**, board states
verbatim. A card's column derives ONLY from board data; the herdr agent
state (live/blocked glyphs) is a decoration overlay joined by parsing agent
names (`w<N>-*`, legacy `gh-N`) — a failed herdr read costs glyphs, never
cards. Human Needed cards show the blocking question **verbatim** (the
latest issue comment's first line): the column is meant to be answerable
from a phone-sized pane without opening anything.

| Key | Verb |
|---|---|
| `h` / `l`, `←` / `→` | move between columns |
| `j` / `k`, `↑` / `↓` | move between cards |
| `Enter` | **observe** — `herdr agent focus` on the card's live session |
| `Space`, `o` | **peek** — agent pane-tail overlay (`herdr agent read`), no focus steal |
| `r` | **reply** — input box → `herdr agent prompt`; the delivered checkmark appears ONLY after herdr confirms (rc 0) — never an optimistic ack; a failure preserves the typed text and shows the error |
| `a` | **answer** — Human Needed exit, comment-first: `board answer N -m` posts the durable **Answer** comment FIRST, then any live session gets the nudge |
| `s` | **spawn** — a `/ralph:work` session for the card, via the same `spawn_work_session` path as `work-next` |
| `v` | **DAG view** — text tree from `board frontier --json`: eligible items with their closed edges, blocked items with their open blocker lists |
| `d` | **PR diff** — `gh pr diff` in a popup pane (`herdr plugin pane open`) |
| `g` | open the issue in the browser |
| `q` | quit |
| mouse | click selects, double-click observes |

### Keybinding audit (herdr 0.8.0)

The one fact the key table stands on: **a focused herdr pane receives ALL
keys except the prefix.** herdr's prefix is `ctrl+b` — the only key the
multiplexer intercepts for a focused pane — and the TUI deliberately binds
nothing on `ctrl+b`. herdr's `[keys.indexed]` tab/workspace chords exist
only if the user enabled them in their own herdr config; everything else
reaches the TUI untouched. (fzf on rung 3 inherits the same guarantee.)

### The fzf rung, honestly

Rung 3 is verb-complete, chrome-minimal: a loop of one `board list --json`
partitioned locally into the three columns (stdout-only into the parse,
fail-closed on unparseable output — the ralph-answer.sh precedent: an empty
column and a failed query are different facts) → one fzf pick with a preview (live
agent's pane tail, else the issue's latest comments) → a second fzf menu of
the verbs. Reply and answer read one line (`read -r`); answer is
comment-first through `board answer`; delivered is claimed only on
`agent prompt --wait` rc 0 — a bare prompt merely submits, so wait expiry
reports "sent but not confirmed", never "delivered" (ralph-answer.sh
parity). The PR diff pages inline (`gh pr diff | less`) instead of a popup —
the popup needs herdr's plugin-pane surface, which rung 3 does not assume.
No poll timer: the board re-reads after every verb.

### Honest limits (cockpit)

- **Poll-only in this phase.** The TUI polls (`RALPH_COCKPIT_INTERVAL`,
  default 30 s); the herdr `[[events]]` hooks feed the watcher ledger, not
  the TUI. Wiring events into the cockpit is Phase-6+ — until then a state
  change shows up at the next poll, not the moment it happens.
- **The install never blocks on the TUI.** The manifest `[[build]]` hook is
  `scripts/build-cockpit.sh`, which exits 0 with a loud warning when Go is
  absent, `cockpit/` is missing, or the compile fails — a herdr build
  failure would abort the whole plugin install, and blocking every action
  because optional chrome didn't compile would invert the ladder. The
  warning (in `herdr plugin log`) names the reason and the manual build
  command; the launcher lands on rung 3/4 meanwhile. A failed REbuild also
  removes any previously built binary — a stale TUI never poses as rung 1.
- **Pane tails stay in the terminal.** peek/preview render agent tails into
  the pane only — allowed; the `SECRET_RE` gate guards notification
  channels (attend.sh), and the cockpit sends no notifications.
- **The popup diff needs herdr.** `d` opens a herdr plugin pane; on rung 3
  the same verb pages inline.
- **Glyphs are decoration.** `blocked`/`working` come from herdr's
  screen-detected agent status — attention hints joined onto board-truth
  cards, never a gate.

## Fleet refill (opt-in: the claim-TTL probe says NO-GO on default arming)

**The board is the wait state** — nothing idles in a pane waiting for work.
With `work-fleet --refill` (or `RALPH_HERDR_REFILL=1`), the run is ARMED:
whenever a w-lane session **exits or finishes**, the watcher tops the fleet
back up to `k` from the dependency-aware frontier. **Never on blocked** —
blocked is attention, not capacity, and only ever produces a notification.

This *stays opt-in*: the claim-TTL vs pane-persistence probe ran 2026-08-11
(`scripts/probe-claim-ttl.sh` →
`thoughts/shared/research/2026-08-11-claim-ttl-pane-persistence-probe.md`)
and returned **NO-GO for unattended arming**. A herdr server restart restores
workspace/pane topology in ~225ms with stable IDs — but **kills the process
inside every pane** (~100ms, verified with a heartbeat marker) and every
in-flight `pane wait-output` dies cleanly with `server_unavailable`, never
resuming. An armed-but-unattended run would therefore stall its claims for up
to the claim TTL (default 120m per issue) with a restored-but-idle pane
posing as a live session. (The originally feared inverse — a pane *outliving*
its claim and double-working, design doc §3.1/§5 — was NOT observed for plain
processes; agent-pane resume is still unverified, no billed agents in the
probe.) Until a restart-aware reconcile closes that stall window, refill is
bounded three ways, all recorded in the run's `fleet.json` at arm time and
enforced at read time — no timers, no daemons, no arming survives them:

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

## Sibling fleets (shared claims) — removed

`work-issue-fleet` put several `/ralph:work` sessions on ONE issue: one
worktree, one shared `feature/GH-N` branch, joined to a multi-holder Claim v2.
It was removed in GH-1774.

The claim protocol was never the problem. The worktree was. Siblings shared the
index, the checked-out branch, every uncommitted file, and each other's
cleanup — so they staged each other's half-finished edits into one commit,
checked out over each other's work, and produced branches none of them
intended. Claim bookkeeping coordinates access to the *issue*; the damage
happened to the *tree*.

There is no version of this that gets fixed, because making it safe means
giving each sibling its own checkout — and a sibling with its own checkout is
just a normal worker on a normal issue. So that is the replacement:

```bash
board create --title "…" --body "…"   # decompose into real issues
board dep NNN --needs MMM             # record the edges
# then work-fleet: one worker per issue, own worktree, own claim
```

That yields more real parallelism than the sibling fleet ever safely did, and
the board can see it.

`board claim join` / `claim leave` remain on the board CLI so existing shared
claims can be read and cleaned. Nothing creates them any more; a legacy shared
claim is surfaced by doctor, not extended.

## The Herdr boundary (GH-1774)

Every call into herdr goes through one validating adapter, and every read of
the herd is scoped to the repository it is for. Four files, sourced by the
cockpit scripts and by both event hooks:

| | |
|---|---|
| `scripts/transport.sh` | the strict protocol-19 adapter — one envelope, correlated `id`, the expected `result.type`, required fields present and array-shaped, error envelopes surfaced as a distinct code. Four return codes: `0` validated, `1` malformed, `2` herdr refused, `3` unreachable |
| `scripts/scope.sh` | session key + repository scope, joined to the snapshot through workspace worktree provenance. Decides which of a session's agents are *ours* |
| `scripts/sanitize.sh` | strips terminal control sequences from anything herdr reports before it is logged or rendered |
| `scripts/dirty.sh` | the "come look" marker events write instead of mutating durable state |

**A zero exit is not evidence of success.** A response can exit 0 and still be
an error envelope, a reply to a different request, the wrong result type, a
success missing the array about to be iterated, or trailing garbage after a
valid object. The adapter never turns any of those into `[]` — that conversion
is how a server hiccup becomes "no agents are running, safe to clean up".
Callers that can proceed without an answer must say so by checking the code.

**A Herdr session is a namespace, not a project.** `agent list` and
`session.snapshot` return every agent in the session, across every repository.
Two Ralph-equipped repos in one session both produce `w42-fix`, so filtering by
issue number or agent name is a containment *illusion*; filtering by `$PWD` is
no better, since plugin commands run from the plugin directory and a pane's cwd
is whatever the shell last `cd`'d to. The boundary is the join:

```text
agent.workspace_id → workspace.worktree.repo_root / .checkout_path   (authoritative)
agent.pane_id      → pane.cwd, agent.cwd, agent.foreground_cwd       (runtime, weakest)
```

Snapshot provenance outranks runtime working directories, and the runtime tier
is reachable *only* when a workspace carries no provenance at all — a workspace
whose provenance points elsewhere is a definite no, never a fall-through.
Agents whose provenance resolves to nothing are invisible: an unknown owner is
not this repository's to touch.

**Events are hints.** Herdr documents no ordering, no deduplication key, no
replay cursor and no exactly-once delivery for plugin events, and status events
carry no durable identity. So an event payload can describe a state the agent
has already left, an agent that has since exited, or a name a newer worker has
reused. Events therefore never mint an identity and never write a state taken
from the payload: they confirm the agent against a live snapshot, record *that*
status, and otherwise mark the scope dirty for reconcile.

The marker is a level, not a queue: ten events between two reconciles leave one
marker, because the reconciler re-reads everything either way. **What is not yet
implemented is the debounce/singleflight in front of the snapshot** — each
ralph-named event still takes its own `api snapshot` to confirm the agent, so a
fleet flipping working/blocked/idle costs one snapshot per transition. The
coalescing that bounds that is design §6 and lands with the reconciliation work,
not here.

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
  moment it blocked. Since GH-1774 an event's *own* reach is narrower still: it
  can record a snapshot-confirmed status against an identity the ledger already
  holds, and otherwise only mark the scope dirty.
- **Repository containment is only as good as the provenance herdr reports.** A
  workspace with no worktree provenance falls back to matching cwds, which a
  session can change under us; a checkout that resolves to no board config is
  invisible rather than adopted. Both are honest refusals, not guarantees — the
  boundary keeps repositories from *silently* seeing each other, it does not
  make a shared session a security boundary.
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
- **Refill stays opt-in: the claim-TTL probe ran and said NO-GO.** The 2026-08-11
  probe (`scripts/probe-claim-ttl.sh` →
  `thoughts/shared/research/2026-08-11-claim-ttl-pane-persistence-probe.md`) found
  a server restart kills every pane's process and in-flight wait while restoring
  the topology — an unattended armed run stalls its claims at TTL scale — so
  nothing here arms itself: refill is opt-in per run, TTL-capped, budget-capped,
  and disarms itself at frontier-empty or budget-exhausted (see
  [Fleet refill](#fleet-refill-opt-in-the-claim-ttl-probe-says-no-go-on-default-arming)).
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
- **The cockpit TUI is poll-only and optional.** Rung 2 IS the shipped mode,
  the install never fails over the TUI build, and every rung below it keeps
  the verbs — see [Honest limits (cockpit)](#honest-limits-cockpit).
- **A herdr plugin is unsandboxed local code** with your permissions. This one stays
  read-mostly by construction, but read the scripts before linking — they are short
  on purpose.

## Pointers

- **Getting started at the terminal**: [CHEATSHEET.md](CHEATSHEET.md) — from-zero
  quick start (ralph `board setup`/`readiness` + herdr install) through the
  actions, the cockpit keys, naming, answer/fleet verbs, and debugging.
- **For the sessions themselves**: `ralph/skills/work/references/herdr-api.md`
  (in the ralph Claude Code plugin) — what a `/ralph:work` session hosted in a
  cockpit pane needs: the naming grammar, the C8 token vocabulary and
  self-report syntax, the sanctioned spawn path, shared-claim fleets, and the
  ledger's read-only contract. The `/ralph:work` skill points cockpit-hosted
  sessions at it via a SessionStart hook (`ralph/hooks/herdr-context.sh`,
  active only when `HERDR_ENV=1`).

- Design record (normative): `thoughts/shared/research/2026-08-09-herdr-runtime-ralph-addon.md`
- Scheduler-owned herdr tick recipe: `ralph/examples/tick-herdr.sh` (copy and own —
  scripts are examples, contracts are doctrine: `ralph/examples/README.md`)
