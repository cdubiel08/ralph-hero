# herdr-api — running inside the ralph-herdr cockpit

Reference for a session hosted in a herdr pane (the ralph-herdr plugin,
`plugin/ralph-herdr/` in cdubiel08/ralph-hero). Load it only when
`HERDR_ENV=1`. Nothing here changes the work contract: the board stays
authoritative, `board` stays the sole mutation path, and every herdr surface
below is chrome or orchestration — losing one loses chrome, never verbs.

Inside a herdr-managed pane the `herdr` CLI talks to the current server, and
herdr injects your identity: `$HERDR_PANE_ID` (also `$HERDR_TAB_ID`,
`$HERDR_WORKSPACE_ID`). IDs are opaque server-local tokens — read them from
env or JSON responses, never predict or carry them across servers.

## Naming (grammar B)

Every cockpit agent name is `<lane><issue>-<slug>[--<gen>]`, ≤32 chars:

| Lane | Meaning |
|---|---|
| `w` | work (`/ralph:work` sessions — `w1743-fix-claim-race`) |
| `r` | review |
| `o` | orchestrator |
| `d` | disposable |
| `s` | watcher (issue 0 reserved for infra: `s0-watch`) |
| `x` | relay (`x0-relay`) |

Parse-back is guaranteed: lane = char 1, issue = leading digits, slug = the
rest before any `--N`; `--` appears ONLY in the collision suffix (`--2`..`--9`).
The harness (claude/codex/pi) is a metadata token, never part of the name.
Legacy `gh-N` / `ralph-deliver` / `ralph-tend` names stay parseable through
the transition.

The durable identity is the ref `name#epoch` (epoch = 4-8 lowercase hex,
minted at spawn) — a pane_id names a live pane on one server and dies with
it; it is NEVER a durable key.

Source of truth: `ralph/scripts/contracts.ts` (`slugify` / `formatAgentName`
/ `parseAgentName` / `formatRef`) with the bash mirror
`plugin/ralph-herdr/scripts/naming.sh` (`ralph_agent_name` /
`ralph_agent_parse` / `ralph_agent_ref`); the shared golden table
`ralph/contracts/examples/naming-golden.tsv` pins both.

## Self-reporting (tokens + lifecycle)

Two surfaces, both per-pane, both best-effort decoration — nothing may ever
gate on them; the board comment trail is the record.

**Tokens** (`herdr pane report-metadata`) carry the C8 vocabulary from
contracts.ts `TOKENS`: `role issue slug parent root depth state branch claim
pr spawn_epoch harness inner fresh` (names ≤32 chars of `[A-Za-z0-9_-]`,
values ≤80, no newlines). The `state` token takes the C8 lifecycle enum:
`spawned briefed working blocked reporting orphaned adopted`. Real syntax
(probed against herdr 0.8.0 — the pane id must come FIRST; space-separated
option values, never `--opt=value`; see
`plugin/ralph-herdr/scripts/tokens.sh` for the full discovery note):

```bash
herdr pane report-metadata "$HERDR_PANE_ID" --source ralph-herdr --token state=working
```

Tokens merge per-name on the server (last write wins, other names survive).
Natural checkpoints for a hosted session: `state=working` when you start,
`state=blocked` when you escalate, `state=reporting` at close-out. A refused
push (server down, pane gone) costs the sidebar chrome only — warn once and
keep working; never retry-loop it.

**Lifecycle** (`herdr pane report-agent <PANE_ID> --source <ID> --agent
<LABEL> --state <idle|working|blocked|unknown>`) is herdr's native surface:
the reporting source takes the pane's lifecycle authority over screen
detection (`herdr pane release-agent` gives it back). Ordinarily you don't
need it — the cockpit's `blocked`/`working` chips ride herdr's own detection,
and the watcher records status changes in the ledger. Prefer the `state`
token; reach for `report-agent` only when screen detection is demonstrably
wrong about you.

## Spawning (the sanctioned path)

The one sanctioned spawn path is `spawn_work_session` in
`plugin/ralph-herdr/scripts/lib.sh` — it is what `work-next`, `work-fleet`,
the cockpit's `s` key, and the link-offer popup all run. Its contract, which
any hand-driven spawn must also honor:

- **Billing guard first.** Spawning with `ANTHROPIC_API_KEY` set is refused
  (it would bill API credits, not the subscription) unless
  `RALPH_ALLOW_API_BILLING=true` — tick.sh parity.
- **IDs from JSON.** `herdr worktree create --cwd <repo> --branch
  feature/GH-N --base origin/main --no-focus` (always `--base origin/main`;
  fetch first), then read `pane_id` out of the response — never predicted.
- **`--no-focus` throughout.** Only a human-clicked action may steal focus.
- **Skip, don't collide.** A live agent already owning issue N (any `w<N>-*`
  or legacy `gh-N`) is a skip, never a `--N` sibling — two `/ralph:work`
  sessions on one issue is what the claim protocol refuses. The `--N`
  generation suffix belongs to deliberate sibling fleets only.
- **Depth cap.** herdr-plane spawn depth is capped at 3 levels (depths 0-2,
  `ralph_depth_guard`); inner-plane subagents (`Agent(...)`) are free and
  never counted. Prefer inner subagents — herdr-plane children are for work
  that must outlive your session.
- **No board writes.** The spawn claims nothing; the spawned session claims
  its own issue via `board claim`.

A dry-run preview of any spawn is free: `RALPH_HERDR_DRY_RUN=true` prints the
exact plan (branch, agent name, herdr commands, the ledger record) and exits
before any mutation.

## Plugin actions — what to suggest, when

All invoked by the human (`herdr plugin action invoke <id> --plugin
ralph-herdr`, or herdr's action menu). A session never invokes these itself;
it *suggests* one when the moment fits — in a board comment or close-out,
naming the action:

| Action | Suggest when |
|---|---|
| `work-next` | the queue has an actionable head and no session on it |
| `work-fleet` | several independent frontier items are ready in parallel |
| `deliver-pass` / `tend-pass` | the deliver/tend queue is non-empty and quiescent |
| `attend` | something is blocked and the human should look now |
| `answer` | Human Needed items are waiting on decisions |
| `cockpit` / `dashboard` | the human wants the standing board view (TUI / read-only) |
| `doctor` | board invariants look off (stale claims, garbled fields) |
| `link-open` | (automatic — the `[[link_handlers]]` target for clicked issue/PR URLs) |
| `reconcile` | the ledger looks stale after a server restart (also runs at `[[startup]]`) |

## The ledger (read-only for you)

`~/.ralph/<owner>/<repo>/ledger.jsonl` — append-only observation log of
spawns, state changes, adoptions, exits (`plugin/ralph-herdr/scripts/ledger.sh`).
The watcher (`watch-event.sh` + `reconcile.sh`) is its sole appender, with one
documented carve-out: the spawn path appends its own C7 spawn record. **Agents
never write it.** Read it freely (pure jq reductions; duplicates tolerated),
but nothing gates on it — it is eventually-honest, bounded by server uptime
plus the last reconcile. L10 lineage closure is checked read-only by
`plugin/ralph-herdr/scripts/doctor-lineage.sh`.

## Fleets (shared claims)

ClaimV2 holds up to 8 holders on one shared timestamp — wire
`h1+h2+...|iso8601`, single-holder byte-identical to the v1 claim. The verbs:

```bash
board claim show NNN            # holders, shared since, age vs TTL
board claim join NNN --holder w1743-fix-thing   # In Progress items only
board claim leave NNN --holder w1743-fix-thing  # last one out clears the field
```

`claim join`/`leave` never transition state — board moves stay the skills'
job. Any member's heartbeat refreshes the ONE shared since.

Nothing creates shared claims any more. The `work-issue-fleet` action that put
sibling sessions on one issue was removed in GH-1774: siblings shared a git
worktree, and so raced on the index, the branch, and each other's uncommitted
files — the claim coordinated the *issue* while the damage happened to the
*tree*. `claim join`/`leave` remain for reading and cleaning claims already
written. To parallelize one issue, decompose it into separate issues with
dependency edges and let `work-fleet` give each its own worktree.

Refill (`work-fleet --refill`) is watcher-owned and gated: opt-in per run,
TTL-capped, budget-capped, refills only on *exit/finish* (never on blocked —
blocked is attention, not capacity), and disarms itself at frontier-empty or
budget-exhausted. It **stays opt-in**: the 2026-08-11 claim-TTL probe returned
NO-GO for default arming (a server restart restores pane topology but kills
every pane's process, stalling claims at TTL scale), so a session neither arms
nor extends it. The frontier itself is `board frontier [--json]` — every
issue eligible to start now, a re-projection of `board next`'s ranking.

## Contracts and payload checks

The typed shapes (C1-C9) live in `ralph/scripts/contracts.ts`; validate and
lint through the board CLI:

```bash
board contract validate ralph.escalation payload.json   # producer (strict) schema
board contract lint ralph.completion_report - --live    # lints L1-L13
```

Escalations you post to the board should satisfy C9's bar even as prose: a
single-line body ≤240 chars, ≥2 enumerated options with exactly one
recommended — the notification channel truncates around 240 chars, so the
first line must be answerable from a phone.

## Self-discovery

- `herdr --skill` — herdr's own agent skill file (the authority on CLI
  syntax, ID rules, lifecycle states).
- `herdr <group>` bare (`herdr agent`, `herdr pane`, …) prints the group's
  subcommands; never run bare `herdr` for discovery (it attaches the TUI).
- `herdr api schema` — the socket API schema (event vocabulary, manifest
  shapes); `herdr api snapshot` — live session state.
- Cockpit docs: `plugin/ralph-herdr/README.md` (actions, knobs, honest
  limits) and `plugin/ralph-herdr/CHEATSHEET.md` (terminal quick start).
