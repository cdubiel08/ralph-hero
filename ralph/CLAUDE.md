# Working in ralph/

## What this is

ralph v2 (GH-1662): five skills, one agent, one board CLI, courtesy hooks, and lane selectors. Design record (normative): `../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`; lanes spec (GH-1712): `../thoughts/shared/specs/2026-08-07-loop-agent-lanes-spec.md`.

```text
ralph/
├── skills/work/        # the execution verb — outcome, boundaries, contract
├── skills/deliver/     # follow-through lane: In Review PRs → merged (GH-1712)
├── skills/tend/        # hygiene lane: Backlog shape + Done audit (GH-1712)
├── skills/board/       # human surface — orientation, intake, answers, doctor
├── skills/help/        # topic-routed setup help (herdr cockpit wiring, GH-1759)
├── skills/using-html/  # vendored utility (byte-identical upstream; do not edit)
├── agents/investigator.md  # read-only fan-out worker (hard tools: allowlist)
├── scripts/board(.ts)  # THE board mutation path — typed 6-state machine,
│                       #   claims with TTL, scope gate, doctor, and the lane
│                       #   selectors (next / deliver-queue / tend-queue)
├── scripts/herdr-setup.sh  # herdr-cockpit wiring truth: /ralph:help herdr drives
│                       #   it; doctor relays its `check --oneline` verdict
├── scripts/tick.sh     # ONE scheduler-transport example of driving the work
│                       #   lane (+ install-loop.sh) — a recipe, not THE loop
├── examples/README.md  # transport recipes: /loop, routines, scheduler — copy and own
├── hooks/funnel-*.sh   # courtesy redirects to board.ts / merge-pr.sh (merge
│                       #   redirect only when the host repo ships the gate) —
│                       #   NOT enforcement; board.ts + state-guard.yml are
└── .claude-plugin/     # manifest
```

## Lanes (GH-1712)

A lane is a **typed selector + a judgment skill + a goal** — cadence is derived per pass from what the queue is blocked on, never configured. Three exist: **work** (`board next` → `/ralph:work`), **deliver** (`board deliver-queue` → `/ralph:deliver` — quiescent In Review items, marker-gated per PR, gate truth from `merge-pr.sh --dry-run`), **tend** (`board tend-queue` → `/ralph:tend` — Backlog hygiene + Done audit, metadata-only, closures only ever proposed via a marker comment the selector reads back). Skills are single-pass operators; pacing vocabulary lives only in `examples/README.md`.

**The four-dimension lane test** (gates every future lane proposal; stated once, here): a new lane is justified only when **signal source, write lane, pacing signal, and permission set all four differ simultaneously** from every existing lane. The pacing signal is the observable a lane derives its next wake from (work: queue depth; deliver: check conclusions, review deltas, retry/settle windows; tend: accumulation age) — a proposal that differs only in derived cadence numbers fails the test.

## Conventions

- **Enforcement is code.** An invariant worth having goes in `board.ts` (with a test) or `state-guard.yml` — never in skill prose, never in a bash validator. Prose states intent once; if you're writing "make sure to X" in a SKILL.md, you're in the wrong file.
- **Three write lanes on the state field**, all in board.ts: `transition` (agent intent, MACHINE-guarded), `reconcile` (issue reality wins), `parent-check` (rollup). Nothing else writes it. There is no `--force`; a stale claim TTL is the only override path.
- **No prescribed phases.** The work skill grants judgment; research/plan depth is sized to the unit by the driver. Don't add per-phase skills, verdict-token vocabularies, or step recipes.
- **Every board.ts change ships with tests** (`npm run test:board` at repo root) and must keep the parity invariant: `get` reads exactly the fields `move`/`claim` write.

## Verify locally what CI verifies (repo root)

```bash
npx vitest run ralph/scripts/ && npx tsc --noEmit
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

## Install model

Claude Code installs `ralph` from the marketplace clone as an immutable versioned copy; edits here reach a running session after merge → `release-ralph.yml` bumps + tags → plugin update. `board.ts` ships inside the plugin (no npm, no version pin — the repo copy is the version).

The herdr half of the cockpit does **not** auto-update (herdr has no `plugin update`), so `scripts/herdr-plugin-version` stamps the `ralph-herdr` version this ralph release expects; `herdr-setup.sh check` compares it against herdr's registered version and names the reinstall command on drift. Bump the stamp with `plugin/ralph-herdr/herdr-plugin.toml` — `scripts/__tests__/herdr-setup.test.sh` fails if they diverge.
