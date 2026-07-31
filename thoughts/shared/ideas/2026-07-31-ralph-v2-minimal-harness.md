---
date: 2026-07-31
topic: ralph v2 — minimal harness rewrite (no MCP server)
type: design
status: proposed
supersedes: the 9-verb slim plugin + ralph-hero-mcp-server architecture
provenance: 6-reader research workflow + 3-designer/3-judge design workflow, 2026-07-31
---

# ralph v2 — one CLI, one contract, one loop

The current harness is ~33,700 lines (9,682 skill prose, 3,326 hook bash, 20,715 MCP-server TS) defending a mutation vocabulary of five verbs: move, claim, release, escalate, close. v2 does it in ~2,300 lines. The board stays the source of truth; the driving model gets its judgment back.

## Why (evidence, one paragraph each)

**Prose doesn't converge under review; typed code does.** CodeRabbit era: 81% of actionable flags target the architecture (cross-file prose drift 47%, bash fragility 26%). The docs-only PR #1638 drew 21 flags / 32 review submissions; the 13k-line TS PR #1624 converged in one round. PR #1620 (91-file prose diff) died at 12 rounds / 114 findings — 98 on markdown/bash, 0 on TypeScript. Design axiom: one source of truth per contract, machine-checked or absent; prose never restates enforcement.

**Bash hooks fail open; the funnel is the only hook pattern that held.** Of 40 hook scripts, one enforces the state machine from its source of truth, ~5 enforce real safety. The rest: transcript greps that self-satisfy (the token vocabulary appears in the hook's own block message), self-attestation via agent-exported env vars (`RALPH_SPLIT_COUNT`), scope guards on env vars that don't propagate to hook subprocesses (documented in-repo, fails open silently), `RALPH_FORCE_STOP` bypass advertised in the block messages themselves. The exception: `merge-review-decision-gate.sh` — 30 lines forcing all merges through `scripts/merge-pr.sh`, which holds the real typed gates.

**Only 6 of 11 states carry information.** Research Needed / Ready for Plan / Research in Progress / Plan in Progress / Plan in Review encode phase — and phase is artifact-derivable (research doc? plan? PR?). The three lock states exist so `__LOCK__` could be phase-specific; one claim + holder + age subsumes them. hero-fable (64 lines) already runs on the reduced set and became the zero-hook proof vehicle for the server-side invariants.

**The loop's ceremony exists only because it lives inside a chat session.** The 20-row sentinel manifest, ScheduleWakeup discipline, and all four autopilot hooks defend three control tokens. An external scheduler running one process per tick deletes the entire class, including the recorded silent-loop-death failure.

## The design

Anchor: typed-funnel (single TS CLI as sole mutation path, Projects V2 kept). Grafts, per the judge panel: zero-infra's server-side corrective wall + watchdog; contract-first's no-force rule, mutation echo, intake rule, and Workflow quartet. Vetoed: typed-funnel's plan-skill-first routing (re-prescribes the choreography this rewrite deletes); contract-first's frontier-driver-on-every-tick (violates the tiering evidence in the expensive direction).

### 1. State machine — six states, defined once in `board.ts`

```
Backlog ──claim──▶ In Progress ──▶ In Review ──▶ Done
   ▲                  │  ▲             │
   │◀── release ──────┤  └── rework ───┤
   │                  ▼                ▼
   └────────◀── Human Needed ◀─────────┘
Any non-terminal ──cancel──▶ Canceled     Done/Canceled ──reopen──▶ Backlog
```

| Transition | Command | Guard |
|---|---|---|
| Backlog → In Progress | `board claim NNN` | scope check; no live foreign claim |
| In Progress → In Review | `board move NNN in-review` | holder-or-stale |
| In Progress → Backlog | `board release NNN -m "…"` | holder-or-stale; parking comment mandatory; clears Claim |
| In Progress / In Review → Human Needed | `board move NNN human-needed --why "…"` | `--why` mandatory → posted as comment (the exact decision needed) |
| In Review → Done | `board move NNN done` | merged-check is merge-pr.sh's job |
| In Review → In Progress | `board move NNN in-progress` | rework; re-acquires claim |
| Human Needed → Backlog / In Progress | `board move` | human answered on the issue |
| any non-terminal → Canceled | `board cancel NNN -m "…"` | explicit verb; reason comment mandatory |
| Done / Canceled → Backlog | `board reopen NNN` | explicit verb only |

- **Phase is derived, never stored.** `board get` reports it from artifacts. No phase states, no `semantic_states` intent layer, no Status-sync indirection beyond a best-effort Todo/In Progress/Done map.
- **Lock** = In Progress + Projects V2 text field `Claim` = `{holder}|{iso8601}`. Holder and age live in the value — no `updatedAt` archaeology, no clear-then-set quirk dependence. TTL default 120 min. Stale reclaim only via `claim --steal`, which posts a comment naming the evicted holder. **No `--force` flag exists anywhere in the CLI; stale-TTL is the only side door** (stated as a typed absence, not a guard).
- **Ticket graph**: native sub-issues + dependency edges via `board link / dep / tree`. `board next` excludes items with open blockers and *flags* them blocked — known blockers stay visible, no null-status parking.
- **Parent gate**: one implementation, `board parent-check NNN` (typed port of PR #1624's logic, ~40 ln), invoked by `move` on child transitions *and* by state-guard.yml for mutations that bypass the CLI (UI edits). One owner, two invocation paths — never two implementations.

### 2. Mutation layer — `ralph/scripts/board.ts` (sole funnel)

Single-file TypeScript CLI, ~900 lines + ~400 vitest, run via `bun` (tsx fallback). Lives in the plugin dir so an install carries it. **No npm publish, no version pin, no `.mcp.json`, no MCP server.** Transport = shells out to `gh api graphql`; auth = gh keychain; all logic above the transport is pure and injected-exec, tested without network.

Subcommands: `get / list / next / tree` (reads; `next` is the ~80-line queue ranker: Backlog, deps clear, no live claim, oldest-first, children before new epics) · `create / claim / release / move / cancel / reopen / link / dep / comment` (mutations) · `parent-check` · `doctor [--fix]` · `setup` (field bootstrap) · `migrate` (one-shot 11→6 collapse, **deleted after cutover**).

By-construction properties (each mapped to a recorded failure):

- **Scope check** before any mutation: resolved owner/repo must match `git remote get-url origin` + checked-in config — grounded in the repo, not env vars, so the propagation pathology can't recur. Wrong repo = hard error. (wrong-repo mutation, GH-1405 class)
- **Transition legality from live state** read in the same invocation; refusals name the legal next states. (PR #1624 pattern, kept)
- **Every mutation echoes its resulting state** — per-write proof-of-fire.
- **`get` reads exactly the fields `move`/`claim` write** — parity as a named vitest invariant. (the blockedBy read/write asymmetry class)
- **Option-ID / item-ID plumbing** in one disk cache (`~/.ralph/cache/`), auto-refreshed on miss, doctor-validated. The entire Projects V2 tax, paid once.
- **`doctor`**: parity re-reads, cache-vs-live-schema check, token scopes, state-guard/Action recency (`gh run list`), heartbeat age, stale claims, double-state anomalies.

Why keep Projects V2: board UI, native single-select exclusivity (two states can never coexist), claim metadata field, cross-repo boards. Labels delete the plumbing but lose all four. (Note: Projects V2 emits **no usable Actions trigger** — `projects_v2_item` is a webhook event for org webhooks/GitHub Apps only, and this repo's dead `sync-project-state.yml` repository_dispatch listener proves nothing sends it. Field-level enforcement is therefore a reconciler, not event-driven — see §3.)

### 3. Enforcement — typed funnel + server-side wall; hooks are courtesy rails

Three layers, honestly labeled:

1. **`board.ts`** — the real gates, synchronous, typed, at the path all sanctioned traffic uses.
2. **`state-guard.yml`** (~100 ln) — the wall for bypass traffic, in two lanes because Projects V2 emits no Actions trigger:
   - **Event lane** (`issues: opened/closed/reopened`, `pull_request: closed`): opened → ensure Backlog (kills null-status parking at the source; subsumes route-issues.yml) · closed as completed → Done, closed as not_planned → Canceled, reopened → Backlog (subsumes sync-issue-state.yml) · PR merged with `Closes #NNN` → issue's board state to Done (subsumes sync-pr-merge.yml — **`Closes` alone closes only the issue; the custom board field needs this mapping**) · child closed → `board parent-check` (subsumes advance-parent.yml).
   - **Reconciler lane** (`schedule:` every 15 min): `board doctor --fix` sweeps field-level drift no event reports — illegal state values, claim-less In Progress, expired claims, double-state anomalies — reverts + comments. Correction latency is minutes, not seconds; between an illegal field write and the sweep, the board can lie. Accepted: the synchronous guarantee lives in board.ts (sanctioned traffic) and merge-pr.sh (the only irreversible boundary).

   Every correction posts a comment — enforcement is visible. Board writes from Actions require a classic PAT (`ROUTING_PAT` — GITHUB_TOKEN and fine-grained PATs cannot write a personal-account Projects V2 board); `doctor` checks the guard's recent run **conclusions** (not just recency) and PAT validity, so an expired PAT is loud, not a silent fire-and-fail (this repo has lived that once). Sync-Action count drops 5 → 2 (state-guard + validate-attestation; sync-project-state.yml was already dead — its repository_dispatch has no sender).
3. **Two client hooks**, both the proven ~30-line funnel shape, registered once in the plugin manifest (no per-skill hook state → no cross-session cross-fire): `funnel-board.sh` (raw board mutations → "use board.ts") and `funnel-merge.sh` (bare `gh pr merge` → merge-pr.sh). These are **courtesy rails and are never counted as enforcement** — they fail open by nature; layers 1–2 are the guarantees.

Kept verbatim: `scripts/merge-pr.sh`, `scripts/attest-pr.sh`, `validate-attestation.yml`, the main ruleset. The GH-1589 evidence gate stays the merge boundary; agents ATTEMPT it and trust its exit code, never pre-judge.

On the original framing "state machine enforced by hooks": the repo's own history says client hooks can't hold that wall (fail-open, env-propagation, self-attestation). v2 keeps hooks as redirects and puts the machine where enforcement held — typed code at the funnel plus GitHub's own event stream.

### 4. Loop — structural continuation, no sentinels

`ralph/scripts/tick.sh` (~70 ln), run by launchd/cron every N minutes:

```
flock (one tick per machine) → heartbeat file → board next --json
  (empty → exit 0 before spawning anything — cheap idle)
→ git worktree add .claude/worktrees/GH-NNN origin/main   # worktree-per-job, never shared HEAD
→ $RALPH_TICK_RUNNER "/ralph:work NNN", hard timeout   # driver is always sonnet; frontier enters via in-session bookend dispatches (§6)
→ per-issue log ~/.ralph/logs/gh-NNN.log + one line in ticks.log
→ timeout/failure → board release NNN -m "tick timeout" (self-healing; no stranded claims)
```

- **The tick is transport-agnostic.** The scheduler contract is only "invoke one work session per tick." `RALPH_TICK_RUNNER` defaults to `claude -p --model sonnet` but is not load-bearing: an interactive session running `/ralph:work` and a bridge-env scheduled routine (verified to run local plugins) are equally first-class drives — tick.sh is a convenience, not the architecture. **Billing guard**: before spawning, tick.sh refuses if `ANTHROPIC_API_KEY` is present in its environment (unless `RALPH_ALLOW_API_BILLING=true`) — a launchd/cron env with a stray key would silently bill API credits instead of the subscription; `board doctor` also reports which auth mode the last tick used.
- The scheduler owns cadence; process exit is the continuation signal. Silent loop death is structurally impossible; a dead scheduler = stale heartbeat, which `board doctor` flags — and **doctor runs weekly on a CI cron** as the watcher-of-the-watcher (this repo has observed silent Actions non-fire; the watchdog is not optional).
- Autopilot opt-in is typed and fail-closed: tick.sh refuses unless the machine-local config says `autopilot=true`. Not a hook, not an env guard in prose.
- The human loop needs no machinery: blocked work sits in Human Needed with the decision needed as a comment; the human replies on the issue; an empty-intake driver folds Human Needed replies before picking new work.
- Interactive use is unchanged: `/ralph:work NNN` in a session, no scheduler involved.

Deleted: the sentinel vocabulary, loop-wrapper.md, auto-alias.md, all four autopilot hooks, `--mode watch`, ScheduleWakeup choreography, the `## Unblock Request`/`## Decision Request` comment protocol.

### 5. Skill surface — two skills, one agent, four optional workflows (~400 prose lines)

| File | ~Lines | Content |
|---|---|---|
| `ralph/skills/work/SKILL.md` | 140 | The execution verb, hero-fable shape: intake → boundaries → tiering (10 ln) → contract (§7) → close-out. **No prescribed phase order** — research and planning are the driver's judgment, sized to the unit. Must accept a bare issue body; no artifact-input preconditions exist anywhere (the GH-1416 deadlock class is absent, not avoided). |
| `ralph/skills/board/SKILL.md` | 60 | Human surface: orientation (`board list/next/tree`), intake ("form this" → `board create`), answering Human Needed, `board doctor`. The Projects V2 UI is the dashboard. |
| `ralph/agents/investigator.md` | 35 | The one agent file: read-only `tools:` allowlist (hard runtime enforcement) for parallel codebase/thoughts fan-out at sonnet/haiku. Everything else is inline `Agent(model=…)`. |
| `.claude/workflows/{research-panel, plan-critique, tree-impl, adversarial-review}.md` | 165 | Optional fan-out equipment, loaded only when invoked: parallel investigators; adversarial frontier plan critique; worktree-per-child tree implementation; independent pre-merge review. Capability scaffolding, never choreography — granted in boundaries, prescribed nowhere. |

### 6. Model tiering (the whole policy, stated once in work/SKILL.md)

- **sonnet** default for every operational session and worker; **haiku** for mechanical fan-out.
- **Escalate-never-preempt**: one re-dispatch of a blocked step at opus; second block → Human Needed.
- **Frontier bookends only** (fable → opus fallback): plan authorship/critique and group review verdicts, on feature/epic units — dispatched in-session as `Agent(model="fable")` forks (or the plan-critique / adversarial-review workflows) by the sonnet driver. The driver session itself is never frontier; XS/S singles never touch frontier at all. No plan-first skill, no scheduler-side model routing.
- `CLAUDE_CODE_SUBAGENT_MODEL=opus` stays the documented escape hatch for non-Fable accounts (harness-native; flattens every subagent tier — one sentence, no machinery).

### 7. Artifact contract (draft — inline in work/SKILL.md, ~40 lines)

```markdown
## Contract — what must be true when you stop
The board is the only memory the next session has. Write to it, not to me.

1. CLAIM BEFORE WORK. Nothing mutates before `board claim NNN` succeeds.
   No issue yet? `board create` first. Foreign live claim → pick other work.
2. BOARD TRUTHFUL AT ALL TIMES. In Progress while working; Human Needed the
   moment you hit an ungranted decision — `--why` carries the exact decision
   needed, your recommendation, and what you deferred; In Review when the PR
   is up. Done means merged.
3. EXIT ONLY AT SURFACED STATES. Deliver a mergeable increment (→ In Review),
   escalate, or `board release -m` with a parking note saying where you
   stopped and what's next. Never exit holding a claim.
4. FINDINGS OUTLIVE THE TRANSCRIPT. A bug, constraint, or stale doc you
   noticed → thoughts/shared/research/ note or a linked issue. Deferred work →
   a new issue with `board create`, never a TODO comment.
5. DECISIONS ARE JOURNALED. Each judgment call that shaped the work — decision,
   rationale, rejected alternative — one comment at the moment you make it.
   The close-out comment links every artifact produced.
6. PROVENANCE. Branch feature/GH-NNN; commits and PR reference GH-NNN; one
   worktree per unit, never a shared HEAD.
7. GATES ARE RUN, NOT PREDICTED. attest-pr.sh, then merge-pr.sh; exit codes
   are the verdict. Never simulate, summarize, or pre-judge them.
8. SCOPE IS THE CLAIMED ISSUE. Work for another repo, project, or outcome —
   even obviously good work — is an escalation, not a detour.

Last line of output, exactly one (advisory, for the log — nothing parses it):
  ralph: GH-NNN <done|review|escalated|released> — <one clause>
```

### 8. Inventory

**New (~2,355 lines):** board.ts 900 · board.test.ts 400 · tick.sh 70 · install-loop.sh 40 · state-guard.yml 100 · funnel-board.sh 40 · funnel-merge.sh 30 (derived from merge-review-decision-gate.sh, the one old hook worth keeping) · work/SKILL.md 140 · board/SKILL.md 60 · investigator.md 35 · workflows/ 165 · plugin.json 30 · ci.yml rewrite 60 · root package.json/tsconfig (vitest dev-dep, private) 35 · CLAUDE.md rewrite ~250.

**Kept verbatim:** merge-pr.sh, attest-pr.sh, validate-attestation.yml, main ruleset, thoughts/, plugin/ralph-knowledge (with its release-knowledge.yml — separate plugin, separate release, untouched), plugin/ralph-playwright, plugin/ralph-demo. `release-ralph.yml` survives as the ralph plugin's one release automation (version-bump + tag on `ralph/**`; no npm).

**Deleted (~31,400 lines):** `mcp-server/` entirely (26 tools, caches, telemetry, dashboards, trends, hygiene, directions ranker, routing, SRE tools, npm treadmill: release.yml + `.mcp.json` pinning) · all 40 hooks incl. every postcondition/validator and the autopilot quartet (funnel-merge.sh carries forward merge-review-decision-gate's job in new form) · `ralph-state-machine.json` (the machine lives only in board.ts) · 9 of 10 skills, all modes, outcome-tokens.md, loop-wrapper.md, auto-alias.md · 15 of 16 agents · 4 phase states + Plan in Review pseudo-hold · route-issues.yml, advance-parent.yml, sync-issue-state.yml, sync-pr-merge.yml (state-guard subsumes all four) and the already-dead sync-project-state.yml · doc-roster + tool-consumer CI checks and the roster tables they guarded.

### 9. Migration — four revertible PRs, one declared outage window

1. **board.ts + tests.** `board doctor` against the live board; read-parity spot check vs current MCP tools. Old system untouched.
2. **The cutover PR** (state collapse + new surface + old-surface deletion, fused — they cannot land separately, because the old autonomous surface *selects work by* the phase states the collapse removes, and the old skills keep *producing* those states until deleted; splitting them leaves two systems fighting over one board): `board migrate` maps 11→6 live ({Research Needed, Ready for Plan} → Backlog · {R/P in Progress} → In Progress after stale check · Plan in Review → Human Needed if open `#### Decision:` blocks else Backlog) · state-guard.yml lands, four sync Actions retire · new skills/contract/hooks/manifest land, 10 old skill dirs + 16 agents + 40 hooks deleted. **Autonomy is down from this merge until step 4 — declared, not denied.** Run one real XS issue end-to-end interactively before proceeding.
3. **tick.sh + scheduler.** One day of supervised drain; verify ticks.log, heartbeat, doctor, state-guard run conclusions.
4. **Delete mcp-server/ + release.yml + roster checks; rewrite ci.yml + CLAUDE.md.** npm-deprecate `ralph-hero-mcp-server`.

Every PR merges through the existing gate; steps 1, 3, 4 revert independently. Step 2 is the one-way door (board state collapse) — misplacements are hand-fixable in the board UI, which this design kept. History says half-migrations stall (slim restructure, PR-B): the deletions ride the cutover PR, not a follow-up epic.

### 10. Weakest points (named, accepted)

1. **Funnel hooks fail open** — a confused session composing unanticipated GraphQL walks past them. Accepted: the carrot (board.ts is genuinely the easiest path) plus state-guard's async correction bound the damage; the synchronous guarantee is only at merge. Between an illegal write and its revert, the board can lie to a concurrent tick.
2. **state-guard rides on Actions + a classic PAT**, and this repo has observed both silent push-event non-fire and an expired automation PAT. Field-level correction is a 15-minute reconciler, not an event — drift can persist for minutes. Mitigation is the watchdog stack (heartbeat + doctor checking run *conclusions* and PAT validity + weekly doctor cron), which converts silent to loud but not to impossible.
3. **No CAS anywhere in GitHub** — two machines draining one board can double-claim in the race window. flock serializes one machine; the Claim field makes collisions visible and doctor flags them; not preventable.
4. **board.ts growth risk** — the MCP server was small once. The funnel test: a proposed addition that is not a state mutation, an invariant, or doctor belongs to the model's judgment. (That defense is prose; the 900-line budget in CI is the backstop — add a line-count check if it trends up.)
