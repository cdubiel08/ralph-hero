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
  vendored-checkout layout, i.e. ralph-hero itself) → the installed ralph plugin
  copy Claude Code **records** in `installed_plugins.json` (`$CLAUDE_CONFIG_DIR`
  honoured) → as a last resort, the highest-versioned directory under
  `~/.claude/plugins/cache/*/ralph/*/scripts/board`. Host repos that install
  ralph as a plugin work with no configuration. The cache glob is a labelled
  guess, not a record (GH-1865): the cache accumulates every version ever
  installed, so it matches the running copy only while the newest install is
  also the newest directory — a downgrade, a second marketplace, or a
  project-scoped install breaks that. The scripts die loudly when none exists.
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
| `work-next` | split (down) | `board next` → if empty, says so and exits. Otherwise: fetch, `herdr worktree create --branch <kind>/N-<slug> --base origin/main` — the branch is read from `board name N --json`, never formatted here (GH-1807/GH-1858), because `<kind>` comes from the issue's labels; a unit that already has a legacy `feature/GH-N` branch and no semantic one is resumed on the legacy branch rather than split across two heads. (`--base` only applies to brand-new branches — an existing branch is silently resumed as-is, possibly behind origin/main, and the session rebases; `worktree open` is the fallback when the *checkout* already exists), start agent `w<N>-<slug>` (grammar B, slug from the issue title — see [Agent names](#agent-names-grammar-b)) in the new workspace's pane, prompt `/ralph:work N`, then the cockpit pane becomes the notification watcher. An issue already owned by a live session (any `w<N>-*`, or legacy `gh-N`) is a skip, not an error: it prints "SKIP <name> already live" and exits 0 with no worktree touched (wrapper authors: exit 0 does not always mean a session was spawned) |
| `work-fleet` | split (down) | reads the frontier once (`board frontier --json` when the verb exists, else the ranked `board next` queue — already dependency-aware) and spawns up to `RALPH_HERDR_FLEET` (default 2, hard cap 4) work sessions — same spawn path as `work-next`, per issue, plus a C3 FleetBrief per spawn under the run's `briefs/` dir. Already-live agents are skipped, one failed spawn doesn't strand the rest; the pane then watches all spawned agents. With `--refill` / `RALPH_HERDR_REFILL=1` it also ARMS the run for watcher refill — see [Fleet refill](#fleet-refill-opt-in-the-claim-ttl-probe-says-no-go-on-default-arming). **Naming issues** (`work-fleet.sh 1778 1774`, GH-1780) spawns exactly those instead, in the order given, under the same cap and guards — ranking is the default policy, not the only one. The frontier read then serves as the eligibility oracle: an issue it does not admit is skipped with the reason (`blocked by #7 #8`, or the board's own one-line `get` view for claimed/closed/off-board) and the rest still spawn. `--refill` is refused with a list — a named set is closed, so there is nothing to top it up from |
| `work-these` | split (down) | the same fleet, prompted: asks for a space-separated issue list and execs `work-fleet.sh` with it (empty input = the ranked frontier, so it is a superset of `work-fleet`). Exists because "run a fleet on THESE issues" is where the intent is actually expressed in the cockpit, and there is no argv to type into. Every guard lives downstream in `work-fleet.sh`; this pane duplicates none of them |
| `work-team` | split (down) | TEAM LAUNCH, lead-only (GH-2178, narrowed in GH-2214): prompts for the epic, then `work-team.sh EPIC` spawns or respawns the standing read-only o-lane LEAD (`o<EPIC>-<slug>`, role `orchestrator`) idempotently — a live `o<EPIC>-*` is never doubled — and STOPS. The lead staffs and owns its workers itself, running `work-fleet.sh --epic EPIC` from its own pane under the fleet's guards (D3.2: dispatch does not spawn what the lead owns); worker spawn records carry the lead's ref as C8 parent/root lineage. The lead rehydrates from board state alone, so a dead one is respawned by re-running the command (`--lead-only` is accepted for compatibility and names the same, only behavior) |
| `hero` | split (down) | the ATTENDED face of the dispatch lane (GH-2182): the pane execs an interactive `claude "/ralph:hero"` — a session that rehydrates from `board brief` + `board who` + `board inbox` and stands as the human's single point of contact for the sitting. Never load-bearing: not a herdr agent (no ledger row, no watcher, no tokens), so killing the pane loses nothing and the next invoke re-derives everything from the board. The authorities it exercises are `/ralph:dispatch`'s — the skill text is the normative record |
| `attend` | none | no pane, no loop: finds the highest-priority `blocked` ralph agent (issue sessions — `gh-N` / w-lane — before every other lane; within a group, oldest blocked-since first from the ledger's state-record timestamps, agent-list order when the ledger can't say), `herdr agent focus` jumps you to it, and the notification **carries the question**: the pane's last non-empty tail lines (`agent read --source recent-unwrapped`), flattened to one ≤240-char line, with `#N` in the title when the name resolves to an issue. Nothing blocked → "herd calm". Safe to bind to a key |
| `answer` | popup | walk Human Needed and answer ONE item, **comment-first**: `board list --state "Human Needed" --json` → pick → the issue's latest comments (bounded `gh issue view --comments` tail) → type the answer mail(1)-style (end with a lone `.` line) → `board answer N -m` posts the **Answer** issue comment; the item STAYS Human Needed and the resuming session takes the edge itself with `board claim N` (GH-2204 — the claim guards bind on the actual driver, and if the pane or herdr vanishes mid-answer, the decision is already on the record). Only then, if a live session owns N, a `herdr agent prompt … --wait` nudge telling it to claim-and-resume — delivery reported honestly, never assumed. A board CLI predating the verb falls back to `gh issue comment` + `board move`, the old comment-then-move ordering |
| `link-open` | none* | the `[[link_handlers]]` target — click a `github.com/<owner>/<repo>/issues\|pull/N` URL in any pane: in-scope URL with a live session for N → `agent focus`; in-scope with no session → the `link-offer` popup (board state + `[s]` spawn via the same sanctioned `spawn_work_session` path / `[o]` browser / `[q]` close); out-of-scope or unresolvable scope → OS browser. The manifest pattern is generic on purpose; the script owns the scope judgment. *Also listed as a plain action; invoked without a clicked URL it says so in the plugin log and exits |
| `fork-right` / `fork-down` / `fork-tab` | none* | **pane-context** actions (GH-1892): open a pane already holding the FOCUSED pane's session context. `herdr pane get` reports the live Claude session id, and the new pane starts `claude --resume <id> --fork-session` — a NEW session that begins knowing everything the source knew, rather than a second process appending to one transcript. Placement is the only difference between the three. The fork is named `d0-fork-<source slug>` — lane `d`, issue 0 — and carries `parent=<source>` / `depth=<source+1>` pane tokens. *No plugin pane: the fork's output IS a real pane. See [Forking a session](#forking-a-session-gh-1892) for what a fork is not |
| `deliver-pass` | split (down) | `board deliver-queue` → empty means spawn nothing (the lane contract). Otherwise a new tab hosts agent `ralph-deliver` running `/ralph:deliver`; cockpit pane watches |
| `tend-pass` | split (down) | same shape over `board tend-queue` → agent `ralph-tend` running `/ralph:tend` |
| `doctor` | popup | runs `board doctor` once, holds the popup open until Enter |
| `cockpit` | split (right) | **focus-or-open** (GH-2074): `scripts/cockpit-open.sh` focuses this board's live cockpit when there is one, else opens the pane. The pane runs the degradation ladder (`scripts/cockpit-launch.sh`): the built Go TUI when present, the verb-complete fzf fallback when not, the read-only dashboard when neither — the pane's first line names the rung it took and why. See [The cockpit](#the-cockpit-phase-5-and-its-degradation-ladder) |
| `dashboard` | split (right) | read-only watch loop: board `next` (number/title/estimate + queue depth), deliver-queue, tend-queue, Human Needed count. No doctor call in the loop — doctor is its own action |

The watcher (`scripts/notify-watch.sh`) tracks one or many agents. Single target:
`herdr agent wait` (its default until-states are exactly blocked/done/idle — never
repeated as flags) — level-triggered, no timeout, hangs on purpose — then fires
`herdr notification show` naming the agent, its state, and the repo; it re-arms
while the session keeps blocking and exits once the session is done or idle.
Multiple targets (the fleet case): a portable poll loop (`agent get` every
`RALPH_HERDR_WATCH_POLL`s) notifies on each agent's first block and once on
done/idle/gone, dropping it from the watch list; exits when the list is empty.
`idle` is the one ambiguous read — a session spawned but not yet producing
tokens looks exactly like one that finished — so both modes hold an `idle`
target that has never been observed working or blocked until it arms or
`RALPH_HERDR_WATCH_ARM_SEC` elapses (GH-1878).

`done` is ambiguous in the other direction, and `outcome.sh` answers it
(GH-1907). `done` is a **turn** boundary: an API outage that kills a session
mid-response ends its turn exactly as a delivery does. Observed 2026-08-14 —
two outage-killed fleet sessions read `done … spawned`, identical to finished
ones, over worktrees holding real uncommitted work; an orchestrator trusting
that reading would have retired both workspaces. So `pane.agent_status_changed`
now resolves a confirmed `done` to a **verdict** and writes it to the `state`
token instead of leaving the token at its last value:

| verdict | evidence | meaning |
|---|---|---|
| `finished` | the pane's `state` token already reads `reporting` | the session said so itself — the only positive completion claim, and the token is left alone rather than restated |
| `interrupted` | no close-out **and** the session's checkout is dirty | positive evidence of unfinished work |
| `indeterminate` | no close-out and nothing else separates them | the verdict is withheld: "finished but never reported" and "killed before it could report" both fit |

The invariant: **a workspace may never be retired on a signal a killed session
also produces**, so only `finished` licenses retirement. An unreadable checkout
counts as no evidence (`indeterminate`), never as clean, and an *unconfirmed*
`done` event writes no verdict at all — a verdict is a durable claim about a
session's fate, held to the same bar as refill. The two templates this copies
are already in the repo: `pr-gate-watch.sh` withholding a verdict it cannot
bind to one commit, and the GH-1878 latch resolving where it can and bounding
where it cannot. The verdict is written to the ledger as well as the pane —
tokens are chrome, and reconcile re-pushes them from the ledger after a server
restart, so a pane-only verdict would be replaced by the spawn record's
`spawned` on the next restart.
Both verbs — `agent get` and `agent wait` — go through the transport adapter,
so a read that cannot be answered is neither a state nor a departure: only
herdr's own `agent_not_found` ends a watch. Anything else keeps the target on
the watch list (multi-target) or backs off and re-arms (single-target), so the
two modes agree about what "unreachable" means (GH-1855, GH-1870).

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
| `RALPH_HERDR_BOARD` | auto-discovered | board CLI override — authoritative when set: only that path is validated, and a broken value dies loudly with no fallback. Unset, the scripts try `<repo>/ralph/scripts/board`, then the plugin copy recorded in `installed_plugins.json`, then a labelled guess from `~/.claude/plugins/cache`. Honest caveat: herdr panes inherit the herdr **server's** environment, not your shell's — an export only reaches panes if the server itself was started with it |
| `RALPH_COCKPIT_INTERVAL` | `30` | Go cockpit TUI tick + board-poll **floor**, seconds (min 10): the fastest the board is ever walked, and the fixed cadence of the (free, local) agent-overlay refresh. The fzf rung ignores it — it re-reads the board on every interaction instead of on a timer |
| `RALPH_COCKPIT_INTERVAL_MAX` | `300` | hard staleness bound on the cockpit's adaptive board cadence (GH-1805), seconds. On a quiet board the walk backs off ×1.5 per unchanged read up to this ceiling and no further; any evidence of a write — an agent appearing/blocking/leaving, the cockpit's own `a`/`s`, a keypress, the pane regaining focus — snaps it back to the floor in one step, and the pane *losing* focus jumps straight to this ceiling (GH-1876: herdr forwards focus events, probed). Set it **at or below** the floor to turn backoff off (a constant cadence — and with it, the blur backoff) |
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
| `RALPH_HERDR_WATCH_POLL` | `15` | poll interval, seconds, for the multi-target watcher loop, and the backoff after an unreadable read in either mode (the single-target watch is otherwise event-driven). A malformed value warns and falls back — the watcher is `exec`'d into after its agent is live, so dying on it would leave that agent unwatched |
| `RALPH_HERDR_WATCH_ARM_SEC` | `120` | how long a target that has never been observed working or blocked may read `idle` before `idle` counts as a finished session. Bounds the spawn window in which "not started yet" and "finished" are indistinguishable; `done` and `gone` are unambiguous and stay terminal on the first read. Same forgiving fallback as the poll knob |
| `RALPH_HERDR_WAIT_MAX_SEC` | `86400` | ceiling on one server-owned `agent wait`. The wait is unbounded by design; this exists only so a wedged server surfaces as an unreadable read rather than hanging the pane forever |
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
- **Answer pane.** Answering Human Needed items, comment-first end to end —
  see the `answer` row above. The board verb (`board answer N -m`) owns the
  semantics (the item stays Human Needed; the resuming session claims it);
  this pane only drives it and then nudges the paused session to
  claim-and-resume, reporting the nudge honestly.
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

One action, five rungs. `Ralph: cockpit` runs `scripts/cockpit-open.sh` in the
action process, which focuses this board's live cockpit when there is one and
otherwise opens a right-split pane running `scripts/cockpit-launch.sh` — the
probe that execs the best surface the host can serve, logging
`cockpit: rung N (<reason>)` as its first line so a pane that opened on the
"wrong" surface says why. The doctrine is fixed: **every rung loses chrome,
never a verb.**

**Focus-or-open (GH-2074).** The action used to open a pane unconditionally, so
invoking it twice stacked two cockpits over each other — measured on three live
agent panes, 2026-08-18. herdr exposes `plugin pane focus <pane_id>` but no way
to *list* a plugin's panes (snapshot pane objects carry no plugin or entrypoint
field), so the cockpit records its own pane: `cockpit-launch.sh` stamps
`~/.ralph/<owner>/<repo>/cockpit.pane.json` before exec'ing a rung — every rung,
not just the Go TUI, whose separate heartbeat answers "is a cockpit alive?" for
`herdr-setup.sh check` and carries no pane id. "Live" is checked as two
independent facts, because either alone lies: the pid is still running (a pane
outlives its process — herdr fires `pane.exited` and leaves the pane) *and* the
pane is still in a validated snapshot (a pid can be reused after its pane is
closed). Scoped per board rather than one global file, or a cockpit opened for
one repo would overwrite another's record and duplicate on its next open.
Every unreadable read **opens** — a duplicate pane costs a pane, a refusal costs
the cockpit, the same fail-open direction as the ladder itself — so this is an
idempotence convenience, never a guarantee. The `[[panes]]` entrypoint is
unchanged, so a deliberate second cockpit needs no flag: open it directly with
`herdr plugin pane open --plugin ralph-herdr --entrypoint cockpit`.

| Rung | Surface | Taken when | What it loses |
|---|---|---|---|
| 1 | `cockpit/ralph-cockpit` — the Go TUI | the binary is built and executable (`scripts/build-cockpit.sh`, run at install by the manifest `[[build]]` hook) | nothing — full chrome |
| 2 | the **same binary**, poll-only | always, today: poll-only IS the shipped mode (herdr `[[events]]` feed the watcher, not the TUI — events integration is Phase-6+ work). A documentation distinction, not a launcher branch | event-driven freshness — the board re-reads on an adaptive cadence between `RALPH_COCKPIT_INTERVAL` and `RALPH_COCKPIT_INTERVAL_MAX` |
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
| `T` | **topology view** (GH-2219, D6.1) — the roster tree from `board roster --json`: dispatch → teams → leads → workers, liveness dots joining `agent_status` with the C8 `state` token, escalation counts per rung from `board escalations` (best-effort: a failed count renders NOT COUNTED, never zero) |
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

- **Poll-only in this phase.** The TUI polls; the herdr `[[events]]` hooks
  feed the watcher ledger, not the TUI. Wiring events into the cockpit is
  Phase-6+ — until then a state change shows up at the next poll, not the
  moment it happens. The cadence is **adaptive and event-coupled** (GH-1805):
  the floor (`RALPH_COCKPIT_INTERVAL`, 30 s) while anything is happening,
  backing off ×1.5 per unchanged walk to a hard ceiling
  (`RALPH_COCKPIT_INTERVAL_MAX`, 5 min) on a quiet board — roughly 10× fewer
  walks when nobody is working and nobody is watching. A pane the operator
  cannot see skips the ramp entirely and sits at the ceiling until it regains
  focus (GH-1876). The header shows the
  live cadence beside the last-poll time, so a multi-minute gap reads as a
  quiet board rather than a hung cockpit. What it is NOT is a rate estimator:
  the writers here are *visible* (a ralph session shows up in the free local
  agent overlay before its board write lands, and `a`/`s` are our own
  writes), so the cadence keys on those events, not on a λ̂ fitted to poll
  outcomes.
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
processes.)

**GH-1809 closed the stall window, and the arming gate still stands.** The
`[[startup]]` reconcile now releases the claim of a worker whose pane proves it
is gone, so the worst case is one reconcile pass instead of 120 minutes; and
agent-pane resume was verified live
(`thoughts/shared/research/2026-08-13-agent-pane-resume-probe.md`) — restore
types `claude --resume <id>` into a fresh shell, so a restored pane is a
transcript at a prompt at best, never a worker mid-turn. What is left is that
**nothing re-arms**: the claims come back to Backlog and no one picks them up.
Unattended refill is now safe across a restart without being productive across
one, so it stays bounded three ways, all recorded in the run's `fleet.json` at
arm time and enforced at read time — no timers, no daemons, no arming survives
them:

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

## Event-driven healing (GH-2212)

There is no scheduled dispatch pass — the operator rejected batch cadence
outright (design record D1.2/D3.1: `thoughts/shared/plans/2026-08-28-herd-topology-design.md`).
The unattended half of the dispatch lane is `watch-event.sh` + `heal.sh`, on
the same pane-death events the orphan pass already handles:

- **A dead o-lane LEAD is respawned** by re-running `work-team.sh EPIC
  --lead-only` from the checkout its own spawn record names — the same
  idempotent re-run a human performs, so every guard (billing, spawn edge,
  fail-closed liveness, complete-epic refusal) runs unchanged. The #2178
  respawn authority lives here now, not in a dispatch pass. Pane-proved
  (GH-1863) by construction: the only refs healed are the ones whose open
  ledger record names the event's own pane, read under the ledger mutex — so
  the exited/closed race resolves to exactly one healing per death.
  `work-team.sh` exiting 4 (epic closed or complete) is the self-dissolve
  backstop working: logged, never notified. Any other failure notifies — a
  dead lead the healer could not replace is attention.
- **The dead lead's team workspace is flagged** in the ledger
  (`ev: "orphan_space"`, carrying the event's `workspace_id`) — never removed
  here; sweep is the guaranteed backstop.
- **The dispatch heartbeat is stamped**: `<ledger dir>/dispatch-heartbeat`,
  written by both event handlers for the scope they acted on and by `hero.sh`
  at each sitting. `board doctor`'s `dispatch-heartbeat` advisory reads its
  age (`RALPH_SMELL_DISPATCH_MIN`, 1440 min) and names `dispatch up` as the
  remedy — info-level always, never strict-escalated.

## The one-writer invariant

> Only one worker may write into a worktree at a time, through a claim.
> Everything else is orchestration, relay, and messaging.

This is the fleet's single safety property, and the test to apply to any change
here: **does this protect the invariant, or is it bookkeeping?** Bookkeeping may
be wrong without producing an unsafe state — it produces bad diagnostics.

It holds by construction, through three layers:

| Layer | Mechanism | Strength |
|---|---|---|
| Worktree topology | the branch derives from the issue number, so issue ↔ branch ↔ worktree is 1:1 | structural |
| Agent-name mutex | names are `w<N>-<slug>`; herdr refuses a duplicate name server-side | atomic — this is what wins a real race |
| Board claim | taken inside `/ralph:work`, read-back verified | the backstop |

The `w<N>-*` pre-check in `lib.sh` is advisory and fails open; it is not what
holds the line. The name collision at `agent start` is, and the lost race is
answered with `rc=2` — never an improvised `--N` sibling. The schedule that
pins this is `tests/spawn.test.sh`'s race block, which replays the interleaving
deterministically rather than hoping two real processes collide (GH-1776).

Everything else here — the ledger, agent refs, lineage records, reconcile — is
**observability**. If every one of them were wrong at once the result is an
unreadable diagnostic trail, never two writers in one tree. That is why refs are
joined on the full `name#epoch` and never on the name part: names are
deterministic and recycle on respawn, so a name-level join lets a dead
generation answer for the live one (an ABA), and the passes that act on those
answers — adoption, orphaning — write.

## Sibling fleets (shared claims) — removed

`work-issue-fleet` put several `/ralph:work` sessions on ONE issue: one
worktree, one shared branch, joined to a multi-holder Claim v2.
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
board create --backlog --title "…" --body "…" --priority P1 --estimate M   # decompose into real issues
board dep NNN --needs MMM             # record the edges
# then work-fleet: one worker per issue, own worktree, own claim
```

That yields more real parallelism than the sibling fleet ever safely did, and
the board can see it.

`board claim show` / `claim leave` remain on the board CLI so existing shared
claims can be read and cleaned. Nothing creates them any more: `claim join` was
the last path that grew a holder set and was removed in GH-1869. A legacy
shared claim is surfaced by doctor, not extended.

## The one-writer invariant, and the role model (GH-1808)

> **Only one agent may WRITE a worktree at a time.**

That is this plugin's single safety property. Every change here is tested
against it: does this protect the invariant, or is it bookkeeping? Bookkeeping
may be wrong without producing an unsafe state — it produces bad diagnostics.
The ledger, agent refs, lineage records and reconcile are all bookkeeping.

GH-1808 narrows GH-1774's finding above without weakening it. The hazard was
never several *agents* in one tree — it was several *writers*. So the ban moves
from "no shared checkouts" to "no second writer", and the difference is a
**role**, carried on every spawn.

| role | writes the tree | may spawn |
|---|---|---|
| orchestrator | no | driver, investigator, tender |
| **driver** | **yes** | investigator |
| investigator | no | — (leaf) |
| tender | no | — |
| relay | no | — |
| watcher | no | — |

A human may spawn an orchestrator or a driver. Three consequences:

- **`role` is the FLEET role, not the lane letter** it held before GH-1808.
  The lane is the agent name's first character and was therefore already
  derivable from `agent_ref`; the role is derivable from nothing, because it is
  a spawn-time decision about who may write. `LANE_ROLES` supplies a default
  for the *discover* path only, which has no spawn record to read.
- **One driver per worktree is structural, not a lock.** `ralph_driver_guard`
  reads the ledger for drivers spawned into a checkout, confirms liveness
  against `agent list`, and refuses a second one *naming the live driver*.
  Nothing is taken and nothing expires: a tree whose driver is gone is free
  again. It fails closed on an unreadable herd, and it deliberately ignores a
  driver on the *same* issue — that case belongs to the atomic, server-side
  agent-name mutex, which this eventually-honest ledger read must not preempt.
- **Read-only is a harness allowlist, not a promise.** An investigator's pane
  runs `claude` with `--tools` set from `ralph/agents/investigator.md`'s own
  `tools:` block (Read, Grep, Glob) plus the agent definition itself, built
  inline so it resolves whatever the install layout is. No definition readable
  = no investigator: an investigator that could not be restricted is a second
  writer wearing the wrong token.

`spawn_investigator_fleet ISSUE K <question>…` is the shape that lifts the ban:
one driver through the normal sanctioned path (so it takes the claim and cuts
the branch exactly as a lone worker does), plus K investigators as herdr-plane
children in the driver's checkout — each in a **tab**, never a second worktree.
Two *drivers* on one issue is still refused, and still a decomposition signal:
git itself agrees, since one branch cannot be checked out in two worktrees.

The vocabulary lives in `contracts.ts` (`ROLES`, `LANE_ROLES`, `HUMAN_SPAWNS`,
`spawnEdgeAllowed`); `scripts/roles.sh` mirrors it and `tests/roles.test.sh`
diffs the mirror against the registry, so a role added on one side fails rather
than drifting.

## Forking a session (GH-1892)

`fork-right` / `fork-down` / `fork-tab` open a pane that already holds a
running session's context. The mechanism is two facts meeting: herdr reports a
pane's live harness session (`pane get` → `agent_session.value`), and claude
takes `--resume <id> --fork-session` — resume the transcript, mint a *new*
session id for what happens next. So the fork starts knowing everything the
source knew, and the two panes never write to one session file.

**The cockpit rungs carry the same verb** (GH-1957): `f` in the TUI, `fork` in
the fzf menu, both shelling to `scripts/fork.sh` with the selected card's pane
id — the session read is never reimplemented. But a cockpit row is an *issue*,
not a pane, so it forks only where the source is unambiguous: an issue with two
live agents is a refusal naming both, since "beside this pane" is a question
only the three pane actions above can answer.

It works on any claude pane, not only ones this plugin spawned; a
hand-started `claude` simply gets its pane id in the fork's name instead of a
slug. Other harnesses are refused by name — `--resume`/`--fork-session` is
claude's grammar, and each harness needs its own.

**A fork is not a second driver.** It shares the source pane's *worktree*, and
that is the hazard [sibling fleets](#sibling-fleets-shared-claims--removed)
were removed over: two harnesses in one checkout race on the index, the branch,
and each other's uncommitted files. Neither of the two guards that look like
they cover it does: `--fork-session` mints a new session id, so ralph's
session→unit binding sees an *unbound* session, and the board claim holder
(`user@host`) is identical for both panes, so the claim reads as the same
holder rather than a foreign one.

What the fork path does instead is refuse to *look* like a worker. The name is
`d0-fork-<slug>`: lane `d` (disposable) keeps it out of every `^w[0-9]+-` join,
and issue `0` keeps it out of every issue join — refill's capacity count, the
spawn path's ownership skip, the cockpit's per-issue agent overlay. It writes
no ledger spawn record, because a C7 lineage record needs an issue number and
the source's would assert a second owner; `reconcile` still discovers the live
agent and files a pid-less `discover` record, which `claim-recover` reads as
`unknown` and acts on never. So a fork is visible everywhere and authoritative
nowhere.

**`board claim` from a fork is now refused** (GH-1956), and the rule lives in
`board.ts` rather than here. It is keyed on the **worktree**, not on
fork-ness: a fork is merely the cheapest way to reach two harnesses in one
checkout, and a second `claude` started by hand there is the same hazard — an
env marker set by `fork.sh` would miss that one and would vanish on a
`/clear` besides. So a claim is refused while another session's binding names
the same unit *and* the same worktree and is still fresh.

Fresh means within the claim TTL, on purpose: "the source is gone and this
fork is its continuation" already has exactly one definition on this board,
and it is the TTL that makes a claim stealable. One clock, not two — a longer
local clock would mean a fork could `--steal` on the board and still be
refused locally. `board claim NNN --steal` is the explicit form of the same
assertion and passes immediately, which is what a crashed session resumed in
its own worktree should use.

Use a fork to read, ask, and think from a running session's context — a second
angle on the same problem, a question you don't want to spend the driver's
context on.

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
- **A reconcile pass only sweeps records its own server owns (GH-1863, GH-1944).** herdr
  runs `[[startup]]` for *every* server that starts, so an isolated named session
  (`herdr --session probe server`) used to run this pass against the operator's
  real ledgers while answering about a herd it had never had — observed live on
  2026-08-13, five running workers marked `reason=lost` in one sweep. Ownership
  is now proven positively, in the same spirit as `claim-recover.sh`, by either
  of two facts: the server's snapshot holds a pane one of the ledger's open
  records names, **or** one of those open records carries this server's own
  session key (GH-1933). The absence-driven phases (exit-lost, the orphan pass)
  skip every other record and say so in the log.
- **That verdict is per RECORD, not per ledger (GH-1944).** One ledger path is
  shared by every server working the same repository, so a whole-ledger boolean
  let *one* matching record hand this server the right to sweep a sibling
  server's records — whose workers are live but absent from *this* server's
  snapshot, so the absence-driven phases read them as gone and exit them
  `lost`. That is the GH-1863 failure re-entered through the back door, and a
  `lost` worker cannot be re-discovered. Each record now answers on its own
  pane and its own writer, which keeps both proofs intact: a foreign server
  matches nothing, and a fully-quiesced own ledger is still swept whole
  because every record in it carries our key. The cost is honest and
  fail-closed: a legacy record with no session stamp is no longer swept on a
  live sibling's proof, and needs `--adopt`.
- **The second proof exists because the first is a liveness test (GH-1933).** A
  pane proves ownership only while it lives, so a fully-retired fleet made its
  own ledger permanently unsweepable: sweeping is *safe* only when no worker is
  live, and was *possible* only when at least one was. Observed 2026-08-14 — 13
  stale records growing with every retirement, whose named remedy was the
  command that declined to run. `ralph_ledger_append` now stamps every record
  with `ralph_session_key`, so the writer's identity outlives the last pane.
  What still fails closed: records written *before* the stamp existed, whose
  writer is unknowable from the ledger. Only an operator can assert those —
  `reconcile.sh --adopt PATH`, which logs that it overrode the verdict. It
  takes the path of the *one* ledger the operator inspected (GH-1944): a bare
  `--adopt` used to apply that single assertion to every unproven ledger the
  walk found, and now refuses rather than meaning more than was typed. And
  `--dry-run` performs every read and decision while withholding every write,
  so the sweep can be read before it happens.
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
  honestly (`working`/`blocked`); `idle` updates the ledger, not the chip.
- **A sweep that has stopped landing is silent; its backlog is not (GH-2023).** Measured
  2026-08-16 against the live ledgers: 36 of 39 open records would have swept `lost` in
  one pass — names spanning weeks. Nothing was wrong with reconcile; the number was the
  only evidence that the `[[startup]]` hook's sweep had not been landing (GH-1900 found
  its output routed nowhere). `doctor-lineage.sh` already flagged every one of those
  records and still failed to say it: the count lived in the *clean* pass line, so the
  one verdict where it was visible was the one where it was zero, and 36 findings arrived
  as 36 identical GAP lines that buried the live-side ones. The count now prints at every
  verdict (`note lineage-stale-open — N …`) and the per-record listing is capped
  (`RALPH_LINEAGE_STALE_MAX`, default 10) — **capped, not dropped**: a suppressed record
  still counts as a finding and the line names how many were withheld. The sweep itself
  stays deliberately unbounded, unlike `board prune`: it costs no remote call per record,
  writes only to a local append-only file, touches the board never, and — running on
  server restart — a limit would need one restart per batch to converge. The mass-sweep
  hazard a limit gestures at is answered by evidence instead: the fail-closed re-probe,
  per-record scoping, and phase A releasing no claim.

- **An advisory line survives only while its remedy is true (GH-2066).** The stale-record
  GAP named "run the reconcile action" for every record. Observed 2026-08-17: a pass ran,
  cleared 15 records, and left three exactly as they were — their ledger rows carry
  `session: null`, they predate the session key, so phase A can prove ownership of them
  by neither half of its positive test (a pane this server holds, or the key that wrote
  the record) and correctly skips them. Running the named action again changes nothing,
  forever. `doctor-lineage.sh` now asks reconcile's own question per record and splits the
  verdict: provable ownership keeps today's text, and a record with neither proof names
  `reconcile.sh --dry-run --adopt <ledger>` — the operator assertion built for exactly this
  population (GH-1944) — **with the path resolved**, because that flag refuses a bare
  invocation by design. The counts split with it: `3 lineage finding(s)` read as three
  actionable items when zero were actionable by the pass it named. A record whose session
  key belongs to some *other* server keeps the reconcile wording deliberately — "that pass
  has not run here" is a different claim from "no pass can", and the honest failure
  direction for a wording fix is toward the remedy that might work.
- **A process can outlive its pane, and until GH-1888 nothing looked (`doctor-orphans.sh`).**
  Both sides of `doctor-lineage.sh` are keyed on a ledger identity, so neither
  can see a process that was never a ledgered agent — a cockpit, a dev server, a
  shell loop. Observed 2026-08-14: a cockpit polled a dead PTY for 30 hours,
  invisible to every check; the first live run of this one found seven more,
  the oldest up two days. The signal is `HERDR_PANE_ID`, which herdr stamps into
  every pane's environment and which outlives the pane: a process whose pane id
  is in no snapshot pane is orphaned. Two deliberate asymmetries. It **does not
  scope by repository** — `scope.sh` fails closed because it decides *may I
  write here*, this writes nothing, and scope resolution runs through the very
  pane→workspace join an orphan no longer has, so a scoped version could never
  fire on the case it exists to catch. And a read it could not perform is **not
  evaluable, never clean**: no herdr, no snapshot, or a `ps` that shows no
  environments at all (procps reads `-E` as "every process" and prints a table
  with none in it — a silent all-clear on a machine never inspected).
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
