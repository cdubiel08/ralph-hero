# ralph

Board-driven autonomous development over a GitHub Projects V2 board.

## Status

**ralph v2 (GH-1662).** Two skills, one read-only agent, one typed board CLI, two courtesy hooks, and a scheduler-owned loop. The driving model sequences its own research/plan/build/verify; enforcement is code, not prose. v1 (9 verb skills, hooks-enforced state, MCP-driven artifacts) was replaced in GH-1662.

## Surfaces

| Surface | Purpose |
|---|---|
| `/ralph:work` | The execution verb: claim → work at driver-judged depth → PR → gates → close-out |
| `/ralph:board` | Human surface: orientation, intake, answering Human Needed, doctor |
| `agents/investigator.md` | Read-only fan-out worker (Read/Grep/Glob only, hard allowlist) |
| `scripts/board` (`board.ts`) | The sole board mutation path: typed 6-state machine, TTL claims, scope gate, doctor |
| `hooks/funnel-{board,merge}.sh` | Courtesy redirects to the board CLI / merge gate — never counted as enforcement |
| `scripts/tick.sh` + `scripts/install-loop.sh` | The scheduler-owned loop: one iteration per tick, worktree-per-job |
| `skills/using-html` | Vendored utility (byte-identical upstream; do not edit) |

## Design

Design record (normative): [`../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md`](../thoughts/shared/ideas/2026-07-31-ralph-v2-minimal-harness.md).

## Configuration

Board scope comes from `.claude/settings.json` env (`RALPH_GH_OWNER`, `RALPH_GH_REPO`, `RALPH_GH_PROJECT_NUMBER`, optional `RALPH_GH_HOST`) or a repo-root `.ralph.json`, which takes precedence. Auth is gh keychain (`gh auth login -s repo,project`).

Machine-local knobs: `RALPH_LOCK_TTL_MIN`, `RALPH_CLAIM_HOLDER`, `RALPH_TICK_RUNNER`, `RALPH_TICK_TIMEOUT_MIN`, `RALPH_ALLOW_API_BILLING`; autopilot opt-in is `autopilot=true` in `~/.ralph/config`.

## Verify

From the repo root:

```bash
npx vitest run ralph/scripts/board.test.ts && npx tsc --noEmit
shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh
```

## Install model

Claude Code installs `ralph` from the marketplace clone as an immutable versioned copy; edits here reach a running session after merge → `release-ralph.yml` bumps + tags → plugin update. `board.ts` ships inside the plugin (no npm — the repo copy is the version).

## License

MIT.
