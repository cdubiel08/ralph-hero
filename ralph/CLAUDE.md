# Working in ralph/

## What this is

ralph v2 (GH-1662): two skills, one agent, one board CLI, two courtesy hooks. Design record (normative): `../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`.

```
ralph/
├── skills/work/        # the execution verb — outcome, boundaries, contract
├── skills/board/       # human surface — orientation, intake, answers, doctor
├── skills/using-html/  # vendored utility (byte-identical upstream; do not edit)
├── agents/investigator.md  # read-only fan-out worker (hard tools: allowlist)
├── scripts/board(.ts)  # THE board mutation path — typed 6-state machine,
│                       #   claims with TTL, scope gate, doctor; vitest-covered
├── scripts/tick.sh     # one autonomous iteration (Phase 3); scheduler owns cadence
├── hooks/funnel-*.sh   # courtesy redirects to board.ts / merge-pr.sh —
│                       #   NOT enforcement; board.ts + state-guard.yml are
└── .claude-plugin/     # manifest
```

## Conventions

- **Enforcement is code.** An invariant worth having goes in `board.ts` (with a test) or `state-guard.yml` — never in skill prose, never in a bash validator. Prose states intent once; if you're writing "make sure to X" in a SKILL.md, you're in the wrong file.
- **Three write lanes on the state field**, all in board.ts: `transition` (agent intent, MACHINE-guarded), `reconcile` (issue reality wins), `parent-check` (rollup). Nothing else writes it. There is no `--force`; a stale claim TTL is the only override path.
- **No prescribed phases.** The work skill grants judgment; research/plan depth is sized to the unit by the driver. Don't add per-phase skills, verdict-token vocabularies, or step recipes.
- **Every board.ts change ships with tests** (`npm run test:board` at repo root) and must keep the parity invariant: `get` reads exactly the fields `move`/`claim` write.

## Verify locally what CI verifies (repo root)

```bash
npx vitest run ralph/scripts/board.test.ts && npx tsc --noEmit
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
bash scripts/check-doc-rosters.sh
cd mcp-server && npx vitest run src/__tests__/skill-frontmatter.test.ts
```

## Install model

Claude Code installs `ralph` from the marketplace clone as an immutable versioned copy; edits here reach a running session after merge → `release-ralph.yml` bumps + tags → plugin update. `board.ts` ships inside the plugin (no npm, no version pin — the repo copy is the version).
