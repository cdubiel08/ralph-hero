# ralph-herdr cheat sheet

Terminal commands to drive the cockpit, in the order you'll actually need them.
Distilled from live sessions — every command here has been run for real.

## 0. Quick start from zero (one-time)

Skip whatever you already have. Ralph first, herdr second — the cockpit is a
window onto the board, so the board has to exist before the window is useful.

**Ralph** (full detail: `/ralph:board` and `board help`):

```bash
gh auth login -s repo,project
```

Board scope lives in `.ralph.json` (`{owner, repo, projectNumber, host?}`) at the
repo root, or the `RALPH_GH_OWNER` / `RALPH_GH_REPO` / `RALPH_GH_PROJECT_NUMBER`
env block. Then:

```bash
board setup        # create Workflow State / Claim / Estimate / Priority fields
                   # (idempotent; prints exactly which steps are manual)
board readiness    # advisory agent-readiness report — recommendations, never gates
```

(`board` = `ralph/scripts/board` in a vendored checkout; host repos that install
ralph as a Claude Code plugin have it inside the installed plugin — the cockpit's
`RALPH_HERDR_BOARD` knob points there.)

**Herdr**:

```bash
curl -fsSL https://herdr.dev/install.sh | sh   # or brew/mise; needs >= 0.8.0
herdr integration install claude               # session restore after server restart
herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --yes
```

Before the very first `herdr` launch, check the shell you start it from:

```bash
env | grep -c ANTHROPIC_API_KEY   # must print 0
```

Panes inherit the server's environment for its whole life — a stray key at
launch silently bills API credits in every pane, forever. (The spawn scripts
also guard this per-spawn.)

## 1. Start / attach

```bash
herdr            # launch or re-attach; layout and running agents come back
herdr status     # is the server up, what's attached
```

Detach with `ctrl+b q` — everything keeps running. Never launch a nested
`herdr` inside a pane (`HERDR_ENV=1` means you're already inside).

## 2. The cockpit

Invoke from a shell whose workspace cwd is the ralph-configured repo (or use
herdr's action menu with that workspace focused).

```bash
herdr plugin action invoke dashboard    --plugin ralph-herdr   # herd view, read-only
herdr plugin action invoke work-next    --plugin ralph-herdr   # 1 work session, board-next
herdr plugin action invoke work-fleet   --plugin ralph-herdr   # up to N ranked issues in parallel
herdr plugin action invoke deliver-pass --plugin ralph-herdr   # shepherd In Review PRs
herdr plugin action invoke tend-pass    --plugin ralph-herdr   # hygiene pass
herdr plugin action invoke attend       --plugin ralph-herdr   # focus whatever is blocked
herdr plugin action invoke doctor      --plugin ralph-herdr    # invariant sweep, popup
```

Notes that save confusion:

- The dashboard's first frame takes ~a minute of board reads; Ctrl-C closes it.
- After a spawn, the invoking pane **hangs on purpose** — it became the
  notification watcher. You get a toast the moment the session blocks or ends.
- Preview any spawn for free: `RALPH_HERDR_DRY_RUN=true` prints the exact plan
  and exits before any mutation.
- All knobs (`RALPH_HERDR_FLEET`, `RALPH_HERDR_DASH_INTERVAL`, …) are in the
  README's Knobs table.

## 3. Inspect the herd from any shell

```bash
herdr agent list                                            # everyone + state
herdr agent read gh-1518 --lines 60                         # transcript, no focus steal
herdr agent get gh-1518 | jq -r '.result.agent.agent_status'  # just the state
herdr agent wait gh-1518 --until blocked && herdr notification show "gh-1518 needs you"
```

Agent commands are JSON-native (no `--json` flag). `wait` with no timeout hangs
on purpose and returns instantly if the state already matches.

## 4. Drive an agent by hand

```bash
herdr worktree create --cwd <repo> --branch feature/GH-NNNN --base origin/main --no-focus
```

**Always `--base origin/main`** — left alone, herdr branches from the parent
checkout's HEAD, which is whatever branch that checkout happens to be sitting
on. Read the `pane_id` out of the JSON response, then:

```bash
herdr agent start gh-NNNN --kind claude --pane <pane-from-response>
herdr agent prompt gh-NNNN "/ralph:work NNNN"
```

`agent start` needs the pane sitting at its shell prompt; a fresh pane takes a
few seconds to get there (the cockpit retries this for you — by hand, just
retry).

## 5. When something's weird

```bash
herdr agent explain gh-NNNN --json          # WHY herdr believes the state — every
                                            # detection rule with evidence
herdr plugin log list --plugin ralph-herdr  # what the actions actually ran
herdr plugin install cdubiel08/ralph-hero/plugin/ralph-herdr --yes   # update (replaces pin)
```

Don't `plugin link` a dev checkout long-term: the link serves whatever branch
that checkout is on. GitHub installs are pinned and branch-proof.

## The three rules

1. **IDs come from JSON responses** — never typed from memory, never carried
   across machines or servers. (Applies to issue numbers in scripts, too.)
2. **The chip is a hint.** `working` means alive, not progressing; `blocked` is
   screen-detected. The board — claims, comments, state — is the truth.
3. **Reads are free; spawns cost tokens.** dashboard / attend / doctor /
   `agent read` cost nothing; only `work-*` and `*-pass` start Claude sessions,
   and `RALPH_HERDR_DRY_RUN=true` previews any of them for free.
