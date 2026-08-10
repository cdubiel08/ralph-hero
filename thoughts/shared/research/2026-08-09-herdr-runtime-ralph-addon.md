# herdr as a ralph transport — research + addon-plugin design

- **Date**: 2026-08-09
- **Status**: research / design proposal (nothing built yet)
- **Question**: what is herdr, and what would a ralph-hero ⇄ herdr addon plugin buy us?

## 1. What herdr is

[herdr](https://herdr.dev/) ([herdrdev/herdr](https://github.com/herdrdev/herdr), Apache 2.0, one Rust binary) is a background terminal server billed as "the runtime your coding agents live on." It is a tmux-class multiplexer redesigned around agents:

- **Persistence**: terminals live inside an always-running server. Close the lid, drop the network, restart the machine — the agent processes keep running and the layout/sessions come back (`/docs/session-state/`).
- **Agent-aware status**: every pane carries a semantic `agent_status` — `idle | working | blocked | done | unknown`. Detection is deliberately strict: `blocked` only when the live screen snapshot matches known approval/question/permission UI, upgraded to authoritative when a per-agent lifecycle integration is installed (`herdr integration install <agent>`; Claude Code is one of ~19 agents detected out of the box).
- **Agent-native API**: the CLI and a newline-delimited-JSON Unix-socket API are the same surface (`herdr api schema` introspects it). Agents inside panes drive it too — split panes, `agent.start`, `agent.prompt` (with an atomic `wait: {until, timeout_ms}`), `agent.wait` (server-owned, event-driven, pins the pane occupant so a replacement can't satisfy the wait), `pane.read`, `events.subscribe` (e.g. `pane.agent_status_changed`, `worktree.*`).
- **Native git-worktree workspaces**: `herdr worktree create [--branch NAME]` / `open` / `remove` register a checkout as a first-class workspace.
- **Plugins**: shareable executable workflow packages in any language. A `herdr-plugin.toml` manifest declares `[[actions]]` (user-invocable, context-scoped), `[[panes]]` (split/tab/popup/overlay TUI entrypoints), `[[events]]` (react to herdr events), `[[startup]]` hooks, and `[[build]]` steps. Commands run with the plugin dir as cwd and get `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_PLUGIN_{ID,ROOT,CONFIG_DIR,STATE_DIR}`, and `HERDR_PLUGIN_CONTEXT_JSON` (workspace/tab/worktree/agent context) injected. No sandbox — a plugin is ordinary code with your permissions. Marketplace indexing is just the `herdr-plugin` GitHub topic (~531 community plugins as of today); `herdr plugin install owner/repo[/subdir]`, `herdr plugin link /local/path` for development.
- **In-pane detection**: `HERDR_ENV=1` means you are already inside a pane; nested launches are blocked by design. herdr ships its own Claude skill ([skills/herdr/SKILL.md](https://raw.githubusercontent.com/herdrdev/herdr/master/skills/herdr/SKILL.md)) teaching agents to drive it from inside.

The ecosystem is young but active (herdr-plus, herdr-browser, herdr-navigator, herdr-worktrunk, herdr-remote, herdr-reviewr — all pushed within days of this writing). herdr-worktrunk's manifest is a good concrete reference for the action→pane pattern: an action extracts `workspace_cwd` from `$HERDR_PLUGIN_CONTEXT_JSON` with `jq`, then `exec "$HERDR_BIN_PATH" plugin pane open --plugin ... --entrypoint ... --placement split --cwd "$cwd"`.

## 2. Why this maps onto ralph unusually well

ralph v2's loop transport is deliberately pluggable (`RALPH_TICK_RUNNER`) and its current default — `tick.sh` spawning headless `claude -p` under a hard timeout, worktree-per-job, scheduler-owned cadence — has exactly the weaknesses herdr exists to fix:

| ralph pain today | herdr affordance |
|---|---|
| Headless `claude -p` dies with the laptop lid / network / logout; the tick's timeout kill loses the session and leaves the claim to release-or-TTL | Server-owned panes survive sleep, disconnect, restart; sessions resume |
| Work is invisible while running — one log file per issue, `tail -f` to observe | One pane per issue, status chip (`working/blocked/done`), `herdr pane read` for live transcript without attaching |
| A permission prompt in an unattended session silently burns the whole tick until timeout | `blocked` is a first-class detected state; `agent.wait --until blocked` and `pane.agent_status_changed` events fire the moment it happens |
| `tick.sh` hand-rolls worktree add/remove | `herdr worktree create/open/remove` — worktrees as workspaces, with `worktree.*` events |
| One tick per machine (flock) because concurrency is scary in shared terminals | Panes isolate; the board's per-issue claim protocol is already the real mutual-exclusion backstop, so distinct-issue / distinct-lane concurrency becomes practical |
| Human runs three lanes by typing `/ralph:work`, `/ralph:deliver`, `/ralph:tend` into ad-hoc terminals | Plugin actions + panes give the lanes a stable cockpit |

Framing that keeps us honest with the v2 design record: **herdr is a transport, not a lane.** It changes none of the four lane dimensions (signal source, write lane, pacing signal, permission set) — it changes where the runner process lives and what we can see of it. So everything below ships as *examples + an optional herdr plugin*, never as doctrine, and never as an enforcement layer (`board.ts` + `state-guard.yml` remain the only enforcement; funnel hooks remain courtesy).

## 3. Proposed addon: `ralph-herdr`

A herdr plugin (not a Claude Code plugin) living at `plugin/ralph-herdr/` beside ralph-knowledge/ralph-playwright, installable with `herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr` and developed via `herdr plugin link`. Five pieces, ordered by value:

### 3.1 Herdr-native tick (`tick-herdr.sh`) — the headline

A sibling recipe to `tick.sh` (same contract: scheduler-owned cadence, one iteration, board state is the truth) that replaces "spawn headless with timeout" with:

```bash
NEXT=$(board next --json | jq -r '.next.number // empty'); [ -z "$NEXT" ] && exit 0
herdr worktree create --cwd "$REPO_ROOT" --branch "feature/GH-$NEXT" --base origin/main   # workspace per issue (§6 finding 3: never branch from the parent checkout's HEAD)
herdr agent start "gh-$NEXT" --kind claude --pane "$PANE_ID"
herdr agent prompt "gh-$NEXT" "/ralph:work $NEXT" --wait --until done --timeout "$((TTL_MIN*60*1000))"
```

Everything after the spawn in today's `tick.sh` carries over unchanged: release-if-still-held on failure, the no-op detector (exit 0 + issue still Backlog), `ticks.log`. What changes is that a timeout no longer kills a half-done session — the pane stays alive and visible; the tick merely stops waiting, releases the claim if the board says to, and the human (or the next pass) finds a `working`/`blocked` pane instead of a corpse.

**The one genuinely new hazard**: persistence outlives the claim TTL (`RALPH_LOCK_TTL_MIN`, 120 min). A pane that keeps working after its claim expires can double-work against a fresh claimant — today that's impossible because the timeout kills the process. Countermeasure, in order of preference: (a) bound the wait at TTL and, on expiry, `herdr agent prompt` the pane with a wrap-up instruction rather than killing it; (b) an `[[events]]` hook that watches long-running ralph panes and re-verifies claim ownership via `board get N --json`, notifying on divergence. Never auto-kill on TTL — the board comment trail plus a notification is the honest move; killing is the scheduler's job only when it owns the process.

### 3.2 Lane cockpit — actions + a board pane

```toml
[[actions]]
id = "work-next"      # claim board-next into a new worktree workspace + agent pane
id = "deliver-pass"   # /ralph:deliver in a split pane
id = "tend-pass"      # /ralph:tend in a split pane
id = "doctor"         # board doctor in a popup
id = "dashboard"      # open the board pane below

[[panes]]
id = "board-dashboard"  # watch-style TUI: board next / deliver-queue / tend-queue
                        # + doctor smells, refreshed on a poll; read-only by construction
```

Actions resolve the repo cwd from `HERDR_PLUGIN_CONTEXT_JSON` (the worktrunk pattern) and refuse outside a ralph-configured repo (`.ralph.json` / `RALPH_GH_*` present) — the scope gate stays board.ts's, but the cockpit shouldn't even offer itself elsewhere.

### 3.3 Blocked ⇄ Human Needed bridge — and acting when text is enough

An `[[events]]` subscription on `pane.agent_status_changed` for ralph-labelled panes:

- pane → `blocked` (transport-level: permission prompt, tool approval) → `herdr notification show "GH-N blocked" --body "<last screen line>"`. This is *not* board Human Needed — a permission prompt is the transport asking, not the work being stuck — and the answer is a keypress in the pane.
- Board → Human Needed (dashboard poll detects new items) → notification the other way.

Two distinct signals, both surfaced *now* instead of at timeout. But surfacing is only half the ergonomics — the other half is **letting the human act from the surface when text is enough**, and *leading them somewhere richer when it isn't*:

- **The board is the write surface; herdr panes are keyboards pointed at it.** Every action the cockpit offers resolves to the same sanctioned call a human would type — `board transition/release`, `gh issue comment` — so herdr never grows a write lane of its own, yet a one-line answer never forces a context switch to the browser.
- **Text-is-enough actions**: answer a crisply-posed Human Needed question, release a stale claim, requeue, approve the prompt. The cockpit's "answer GH-N" action collects one line, posts it where truth lives (the issue comment trail), and makes the legal transition. Worth proposing a `board answer N -m "..."` convenience verb in board.ts — comment + Human Needed exit in one typed call — because every text-first surface (pane, menu bar, phone via herdr-remote/Telegram) then inherits it for free.
- **When text isn't enough, each surface hands off to the next richer one**: notification → focus the pane (chip + last lines) → `pane read` / zoom (full transcript) → `herdr agent attach` (converse with the live session — the agent itself is the best ergonomics for "let me explain what I actually want") → link-handler to the issue/PR page (full context). No surface is a dead end.
- **Escalation quality starts at escalation-writing time.** The shape of the question decides which surface can answer it: a session that escalates with "pick A or B, default A" is phone-answerable; "thoughts?" forces the browser. That's guidance for how agents write Human Needed comments (a note in the board/work skill someday), not plugin code.

### 3.4 Lifecycle reporting from inside `/ralph:work`

When `HERDR_ENV=1`, the working session can make its status chip semantic with `herdr pane report-agent "$HERDR_PANE_ID" --state working --message "GH-N: gates running"`. Right place for this: a short optional note in the work skill (detect-if-present, degrade gracefully — the recommend-never-impose rule), **not** a hook. Screen-scrape detection already works without it; this only sharpens messages.

### 3.5 Bounded parallelism (later, explicitly not phase 1)

With panes isolating sessions and worktree-per-issue isolating HEADs, the flock could relax to N concurrent work panes with the claim protocol as the backstop — plus concurrent deliver/tend panes, which have disjoint write lanes by design (GH-1712). Real prerequisites before touching this: the TTL hazard in 3.1 solved, and evidence from weeks of single-pane herdr ticks. Kept out of scope for the first cut.

## 3.6 Conventions: adopt herdr's, contribute two names

Checked against the herdr docs source (`docs/next/website/src/content/docs/{concepts,agent-automation,cli-reference}.mdx`) so we don't invent conventions herdr users already have:

- **Worktrees are herdr's, wholesale.** `herdr worktree create --cwd <repo> --branch feature/GH-N` makes the checkout under `<worktrees.directory>/<repo>/<branch-slug>`, opens it as a workspace, and auto-groups it with the parent repo workspace. `worktree remove` runs `git worktree remove`, **never deletes the branch**, and refuses a dirty checkout without `--force` — which is exactly tick.sh's "clean → remove, dirty → stays for the human" semantics for free. tick-herdr drops the hand-rolled worktree block; the board never cared where checkouts live, only that branches are named `feature/GH-N`.
- **IDs are herdr's.** Pane IDs like `w1:p2` come back in JSON responses; the docs' own rule is "capture IDs from the response instead of predicting them." No ID scheme of ours.
- **Agent names are the one thing we choose.** `agent start` requires a name matching `[a-z][a-z0-9_-]{0,31}`, unique among live agents, auto-cleared when the agent exits. Ralph's convention: `gh-<number>` for work-lane sessions, `deliver`/`tend` for lane passes (one live pass per lane at a time, so uniqueness holds; pane-ID addressing is the fallback regardless).
- **Pane vs agent primitive split is herdr's.** The board dashboard is a `pane run` watch loop (a raw terminal, no agent semantics); claude sessions are agents. Tabs are user habit (`agents`/`logs`/`review` per the concepts doc) — the plugin doesn't manage them.
- **Wait semantics are herdr's.** `agent prompt --wait --until` with explicit timeouts, `agent_prompt_stalled` on a dead submit, `agent attach [--takeover]` for the converse-with-the-session rung of the escalation ladder.

One structural note: herdr's worktree model means each work-lane issue is its own (grouped) workspace, while deliver/tend/dashboard panes live in the parent repo workspace — the sidebar rollup still gives one glanceable dot per project.

So the plugin's entire naming/layout surface is: **branch = `feature/GH-N` (already ralph's), agent name = `gh-N` (new, one line)**. Everything else defers to herdr, on purpose — its users' muscle memory is the convention.

## 4. Honest limits

- herdr's `blocked` for Claude Code is **always screen-detected** — the claude integration is *session identity* tier (native session refs for restore after server restart), not *lifecycle authority* tier (only Pi, OMP, OpenCode, Kimi, Kilo, MastraCode author their own states via hooks). Mitigation observed live (§6): the detection manifest is remotely maintained and auto-updating, with five Claude-specific `blocked` rules. Still a hint, never a gate input.
- Notifications are advisory; the board remains the sole source of truth and `board.ts`/`state-guard.yml` the only enforcement. The plugin never writes Workflow State through any path of its own — human actions it hosts (3.3) are the sanctioned CLI verbs, human-initiated, one at a time.
- A herdr plugin is unsandboxed local code; ours stays read-mostly (board reads + herdr orchestration + notifications), and its only mutations are the same sanctioned CLI calls a human would type, triggered by a human.
- Dependency risk: herdr is days-old-ecosystem young. Everything ships as examples + an optional plugin behind the existing `RALPH_TICK_RUNNER` seam, so ralph without herdr keeps working byte-identically.
- `agent.prompt --wait` semantics under server restart need verification during a spike — docs say sessions resume, but whether an in-flight wait survives a restart is untested by us.

## 5. Suggested next step

A half-day spike, in order: install herdr + the claude-code integration; drive one real board issue through the 3.1 recipe by hand (no plugin yet); verify claim/TTL behavior across a lid-close; then scaffold `plugin/ralph-herdr/` with the manifest above and `herdr plugin link` it. Only after the spike decides the TTL countermeasure does this become a board issue.

**Status 2026-08-09 (same day)**: spike steps 0–1 ran live — GH-1670 driven end-to-end through a herdr pane (worktree → `agent start` → `agent prompt` → PR #1741 → In Review). Findings in §6. The step-2 lid-close/TTL probe has **not** run yet; accordingly the shipped `tick-herdr.sh` example bounds its wait at the claim TTL (countermeasure (a), wrap-up-not-kill) and unattended arming stays off until that probe happens.

## 6. Spike findings (2026-08-09, live run: GH-1670 → PR #1741)

1. **Detection is better-founded than assumed, differently than assumed.** `agent explain --json` mid-run showed the winning rule was `osc_title_working` at priority 1100 — Claude Code publishes a spinner via the terminal-title OSC channel, so `working` doesn't even need screen text. The manifest is fetched remotely (`~/.local/state/herdr/agent-detection/remote/claude.toml`, version 2026.08.04.1, auto-updated) and carries five Claude-specific `blocked` rules including `bash_permission_prompt` matching "do you want to proceed?". Upstream maintains UI drift; we don't.
2. **`working` measures liveness, not progress.** The session read `working` for 13+ minutes while parked inside a background CI-wait doing nothing. The chip can never distinguish thinking from polling from stuck; the transcript and the board can. (This is also why `blocked` never fired this run: the session came up in auto mode from saved project defaults — flags passed at launch don't guarantee prompt behavior, so blocked-detection tests must be deliberate, not incidental.)
3. **`worktree create` branches from the parent checkout's HEAD, not origin/main.** It was benign only because the main checkout happened to sit on up-to-date main. Every scripted create must fetch then pass `--base origin/main` — tick.sh parity.
4. **IDs are opaque, server-local tokens.** A second machine produced workspace `wA` — the "w3 = third workspace" reading was a young-server coincidence. Never predict, sort, pattern-match, or carry IDs across servers; every ID comes from a response.
5. **`agent start`'s preconditions are guardrails in practice.** Distinct error codes did real work during the spike: `agent_pane_not_found` (empty variable → missing arg), `agent_pane_busy` (refused to trample the running gh-1670 pane; also fires when targeting the pane you're typing in, since the CLI itself owns its foreground). A fat-fingered pane ID cannot destroy a session.
6. **The courtesy-hook layer met herdr and behaved.** `hint-pr-linkage.sh` (GH-1717) fired on the real `gh pr create` inside the pane; the driver adjudicated it as a false alarm (keyword was in the body; the hook reads the command line) and moved on. Observation-grade, never blocking — as designed.
7. **The composed-verb gap is real and felt.** Hand-driving exposed that herdr deliberately ships no "start an agent somewhere sensible and show me" verb — primitives refuse to create layout. That's the plugin layer's job, which is §3.2's cockpit `work-next` action verbatim. The friction is the addon's user story.
8. **Env hygiene check is a one-liner and worth it**: the server env was verified key-free before first launch; panes inherit it for the server's lifetime.

## Sources

- https://herdr.dev/ · https://herdr.dev/docs/ (plugins, socket-api, agents, cli-reference)
- https://herdr.dev/agent-guide.md · herdr's own SKILL.md (herdrdev/herdr)
- Manifest reference: devashish2203/herdr-worktrunk `herdr-plugin.toml`
- Local grounding: `ralph/scripts/tick.sh`, `ralph/CLAUDE.md` (lane test, examples-not-doctrine), `ralph/examples/README.md`
