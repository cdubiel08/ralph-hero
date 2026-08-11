// cucumber.js — cucumber-js profiles for the ralph-herdr BDD layer (Phase 6).
//
// Two worlds, one feature set (plugin/ralph-herdr/features/):
//
//   replay (default) — every scenario NOT tagged @live. Steps drive the REAL
//       bash scripts (lib.sh spawn path, watch-event.sh, reconcile.sh,
//       ralph-answer.sh, work-fleet.sh) with tests/fake-herdr.sh and
//       tests/fake-board.sh as PATH shims and a per-scenario temp ledger —
//       the same harness the *.test.sh suites use. No server, no GitHub,
//       no writes outside the scenario's temp dir. Runs per-PR (CI).
//   live — scenarios tagged @live. They need a REAL herdr server in the
//       named test session `ralph-bdd` (never the default session), spawn
//       only plain shell panes (`herdr pane run` — no claude/codex agents,
//       no billing), and assert through herdr CLI JSON. Gated twice: the
//       `test:bdd:live` npm script refuses without RALPH_BDD_LIVE=1, and
//       the live steps re-check the same env. Runs nightly
//       (scripts/nightly-live.sh), never in CI.
//   chaos — the failure-injection rows (@chaos, replay world): the rows
//       scripts/nightly-live.sh re-runs beside the live suite.
//
// Step definitions are TypeScript, loaded through tsx. tsx refuses the
// loader-hook path cucumber's `loader` option uses ("must be loaded with
// --import instead of --loader"), so the npm scripts set
// NODE_OPTIONS="--import tsx" instead — keep the scripts and this file in
// sync.
const common = {
  paths: ['plugin/ralph-herdr/features/**/*.feature'],
  import: ['plugin/ralph-herdr/features/steps/**/*.ts'],
  format: ['progress'],
  strict: true,
};

export default { ...common, tags: 'not @live' };
export const replay = { ...common, tags: 'not @live' };
export const live = { ...common, tags: '@live' };
export const chaos = { ...common, tags: '@chaos and (not @live)' };
