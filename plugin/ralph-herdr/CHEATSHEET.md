# ralph-herdr cheat sheet

Terminal commands to drive the cockpit, in the order you'll actually need them.
Distilled from live sessions and the shipped scripts — every command here has
been run for real or read straight out of the source it invokes.

## 0. Quick start from zero (one-time)

Skip whatever you already have. Ralph first, herdr second — the cockpit is a
window onto the board, so the board has to exist before the window is useful.

**Prerequisites** — the cockpit shells out to both of these:

```bash
command -v gh && command -v jq || brew install gh jq
```

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

## 2. The actions

Invoke from a shell whose workspace cwd is the ralph-configured repo (or use
herdr's action menu with that workspace focused).

```bash
herdr plugin action invoke cockpit      --plugin ralph-herdr   # THE board pane: TUI → fzf → dashboard
herdr plugin action invoke dashboard    --plugin ralph-herdr   # read-only watch loop
herdr plugin action invoke work-next    --plugin ralph-herdr   # 1 work session, board-next
herdr plugin action invoke work-fleet   --plugin ralph-herdr   # up to N frontier issues in parallel
herdr plugin action invoke work-these   --plugin ralph-herdr   # same fleet, on issues you name (prompts)
herdr plugin action invoke answer       --plugin ralph-herdr   # answer a Human Needed item, comment-first
herdr plugin action invoke attend       --plugin ralph-herdr   # focus whatever is blocked (carries the question)
herdr plugin action invoke deliver-pass --plugin ralph-herdr   # shepherd In Review PRs
herdr plugin action invoke tend-pass    --plugin ralph-herdr   # hygiene pass
herdr plugin action invoke doctor       --plugin ralph-herdr   # invariant sweep, popup
herdr plugin action invoke reconcile    --plugin ralph-herdr   # heal the watcher ledger (also runs at server start)
```

Clicking a `github.com/<owner>/<repo>/issues|pull/N` URL in any pane routes
through the plugin's link handler: in-scope with a live session → focus; no
session → an offer to spawn one; out-of-scope → your browser.

Notes that save confusion:

- The dashboard's first frame takes ~a minute of board reads; Ctrl-C closes it.
- After a spawn, the invoking pane **hangs on purpose** — it became the
  notification watcher. You get a toast the moment the session blocks or ends.
- Preview any spawn for free: `RALPH_HERDR_DRY_RUN=true` prints the exact plan
  (branch, agent name, herdr commands, even the ledger record) and exits before
  any mutation.
- All knobs (`RALPH_HERDR_FLEET`, `RALPH_HERDR_DASH_INTERVAL`, …) are in the
  README's Knobs table.

## 3. The cockpit pane, and its keys

`Ralph: cockpit` opens the best surface the host can serve — the pane's first
line names the rung it took: the Go TUI when built, the fzf fallback when not,
the read-only dashboard when neither. Every rung keeps the verbs.

TUI: three columns — In Progress / In Review / Human Needed (board states
verbatim; Human Needed cards show the blocking question).

| Key | Verb |
|---|---|
| `h`/`l`, `←`/`→` · `j`/`k`, `↑`/`↓` | move between columns · cards |
| `Enter` | observe — `herdr agent focus` on the card's live session |
| `Space`, `o` | peek — pane-tail overlay, no focus steal |
| `r` | reply — `herdr agent prompt`; checkmark only after herdr confirms |
| `a` | answer — comment-first via `board answer` (see §5) |
| `s` | spawn — a `/ralph:work` session for the card |
| `v` | DAG view — `board frontier` as a text tree |
| `d` / `g` / `q` | PR diff popup / open in browser / quit |
| mouse | click selects, double-click observes |

## 4. Names (grammar B)

Sessions the cockpit spawns are named `<lane><issue>-<slug>[--<gen>]`, ≤32
chars: `w1743-fix-claim-race` is a work session on #1743. Lanes: `w`=work,
`r`=review, `o`=orchestrator, `d`=disposable, `s`=watcher, `x`=relay (issue 0
is infra: `s0-watch`). `--2`..`--9` are sibling generations — issue fleets
only, never improvised on a collision. The durable handle in the ledger is
`name#epoch` (4-8 hex); pane ids are server-scoped and die with it. Legacy
`gh-N` / `ralph-deliver` / `ralph-tend` names still parse everywhere. Names
are derived from the issue title (`scripts/naming.sh`, mirroring
`ralph/scripts/contracts.ts` — a shared golden table pins both); read them
back from `herdr agent list`, never guess a slug.

## 5. Answer a blocked item

The durable half is a GitHub comment, and it lands first:

```bash
board answer NNN -m "Option B — ship it behind the flag"
```

`board answer` posts the **Answer** issue comment BEFORE the Human Needed →
In Progress move, so a pane that dies mid-answer still leaves the decision on
the record. The `answer` action (and the TUI's `a`) drive the same verb, then
nudge any live session owning NNN — delivery reported honestly ("sent but not
confirmed" when `--wait` expires), never assumed. `--comment-only` posts
without the move; `--any-state` comments on an item outside Human Needed.

## 6. Fleets and shared claims

```bash
board frontier                                   # every issue eligible to start NOW (+ who's blocked on what)
board claim show NNN                             # holders, shared since, age vs TTL
board claim leave NNN --holder w1743-fix-thing   # last one out clears the field
```

`work-fleet` spawns from the top of the frontier (`RALPH_HERDR_FLEET`,
default 2, hard cap 4) — one worker per issue, each in its own worktree.

Ranking is the DEFAULT policy, not the only one: name issues and it spawns
exactly those, in the order given (same cap, same guards). Each name is still
validated against the frontier, and one that is blocked or ineligible is
skipped **with the reason** while the rest spawn.

```bash
bash plugin/ralph-herdr/scripts/work-fleet.sh 1778 1774   # exactly these two
bash plugin/ralph-herdr/scripts/work-fleet.sh --help      # the whole surface
herdr plugin action invoke work-these --plugin ralph-herdr  # the same, prompted, in a pane
```

`--refill` is frontier policy and is refused with an explicit list — a named
list is a closed set, so there is nothing to top it back up from.

The shared-claim `work-issue-fleet` (several sessions on ONE issue, one
worktree) was removed in GH-1774: siblings raced on the index, the branch, and
each other's uncommitted files, and no amount of claim bookkeeping made that
tree safe. `claim show` / `claim leave` remain on the board CLI for reading and
cleaning claims already written; nothing creates shared claims now — `claim
join`, the last path that grew a holder set, was removed in GH-1869. To
parallelize one issue, decompose it into separate issues.

Refill (`work-fleet --refill`, or `RALPH_HERDR_REFILL=1`) is opt-in per run,
TTL-capped (120 min) and budget-capped (8 spawns), tops up only when a w-lane
session **exits or finishes** — never on blocked — and disarms itself.
**Stays opt-in — the 2026-08-11 claim-TTL probe returned NO-GO for default
arming** (a server restart restores pane topology but kills the process in
every pane); the default click stays a one-shot fleet.

## 7. Inspect the herd from any shell

Get real agent names from `herdr agent list` first — `<agent>` below is a name
(or pane ID) copied from that response, never typed from memory:

```bash
herdr agent list                                            # everyone + state
herdr agent read <agent> --lines 60                         # transcript, no focus steal
herdr agent get <agent> | jq -r '.result.agent.agent_status'  # just the state
herdr agent wait <agent> --until blocked && herdr notification show "<agent> needs you"
```

Agent commands are JSON-native (no `--json` flag). `wait` with no timeout hangs
on purpose and returns instantly if the state already matches.

## 8. Drive an agent by hand

```bash
# The branch name is derived, never typed: <kind>/N-<slug>, where <kind>
# comes from the issue's labels (GH-1807). Ask the board CLI for it.
BRANCH=$(board name NNNN --json | jq -r .branch)
herdr worktree create --cwd <repo> --branch "$BRANCH" --base origin/main --no-focus
```

**Always `--base origin/main`** — left alone, herdr branches from the parent
checkout's HEAD, which is whatever branch that checkout happens to be sitting
on. Read the `pane_id` out of the JSON response, then:

```bash
herdr agent start w1743-fix-claim-race --kind claude --pane <pane-from-response>
herdr agent prompt w1743-fix-claim-race "/ralph:work 1743"
```

Any herdr-legal name works, but the cockpit's cards, attend ordering, and
tokens key off grammar B (§4) — name hand-driven work sessions `w<N>-<slug>`
so they join the herd instead of haunting it. `agent start` needs the pane
sitting at its shell prompt; a fresh pane takes a few seconds to get there
(the cockpit retries this for you — by hand, just retry).

## 9. Probe before you trust

```bash
RALPH_HERDR_DRY_RUN=true bash plugin/ralph-herdr/scripts/work-fleet.sh
                                             # the exact spawn plan, zero mutations — run the
                                             # script directly from the repo: an env var on
                                             # `plugin action invoke` never reaches the pane
                                             # (panes inherit the SERVER's env; Knobs table)
bash plugin/ralph-herdr/scripts/doctor-lineage.sh
                                             # L10: live agents ↔ open ledger records, read-only
                                             # (0 closed / 1 findings / 2 not evaluable);
                                             # /ralph:help herdr relays the same verdict
board contract validate ralph.fleet_brief \
  ~/.ralph/<owner>/<repo>/runs/<run_id>/briefs/<ref>.json   # typed payloads C1-C9
board contract lint ralph.completion_report report.json --live  # lints L1-L13
```

The ledger itself is plain JSONL: `jq . ~/.ralph/<owner>/<repo>/ledger.jsonl`.
It's an observation log — nothing gates on it, and agents never write it.

## 10. When something's weird

```bash
herdr agent explain <agent> --json          # WHY herdr believes the state — every
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
   screen-detected; pane tokens are chrome. The board — claims, comments,
   state — is the truth.
3. **Reads are free; spawns cost tokens.** cockpit / dashboard / attend /
   doctor / `agent read` cost nothing; only `work-*` and `*-pass` start Claude
   sessions, and `RALPH_HERDR_DRY_RUN=true` previews any of them for free.

Sessions running *inside* a cockpit pane have their own reference — naming,
self-report tokens, the sanctioned spawn path, fleet claims:
`ralph/skills/work/references/herdr-api.md` (ships inside the ralph Claude
Code plugin).
