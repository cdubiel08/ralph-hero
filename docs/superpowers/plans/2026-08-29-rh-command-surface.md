# Ralph Hero `rh` Command Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a portable, collision-safe `rh` command that preserves the board CLI exactly, adds read-only home/inbox surfaces, composes Herdr dispatch/day operations, and never creates a new team from naked `rh day`.

**Architecture:** `ralph/scripts/rh` is a Bash 3.2 façade. Focused libraries own executable discovery, rendering, and ordered day composition; board operations always delegate to the existing board CLI. A narrow Ralph-Herdr resume script interprets only scoped durable team evidence and delegates actual starts to `work-team.sh`; the existing fake-board/fake-Herdr Cucumber world proves the operator contract without network, GitHub writes, agents, or billing.

**Tech Stack:** Bash 3.2, TypeScript/Vitest, Cucumber/tsx, `jq`, Git, existing Ralph board CLI, existing Ralph-Herdr scripts and protocol-valid fakes.

**Spec:** `docs/superpowers/specs/2026-08-29-rh-command-surface-design.md`

## Global Constraints

- `rh board ...` must preserve delegated argv, stdin, stdout, stderr, signals, JSON, and exit code exactly; once `board` is parsed, `rh` parses no remaining token.
- Existing `board ...` remains supported indefinitely and is never replaced or wrapped by a new board engine.
- Naked `rh`, `rh dispatch`, `rh fleet`, `rh inbox`, and `rh doctor` are read-only.
- `rh dispatch up` ensures only a healthy Herdr server plus the existing dispatch seat; it does not open the cockpit, walk the inbox, or launch/resume teams.
- `rh day` and `rh dispatch day` are the same operation; with no `--team` they never create a team lacking durable prior intent.
- New team intent is accepted only from `rh team EPIC` or repeatable `rh day --team EPIC` flags.
- Resume candidates come only from current-repository/current-session Ralph-Herdr ledger evidence or Herdr's own persisted restoration; board items alone never become candidates.
- Any unreadable, truncated, cross-scoped, or contradictory resume evidence launches nothing and produces a visible nonzero result.
- Human color uses green/amber/red/cyan/dim semantics, never color alone; `--color=auto|always|never` is supported and non-empty `NO_COLOR` wins.
- Board pass-through, delegated JSON, pipes, and redirected output are never recolored or reshaped.
- Runtime shell code must work on macOS system Bash 3.2 and current Linux/WSL Bash; no associative arrays, GNU-only flags, user-specific absolute paths, `eval`, or required `just`/`mise` dependency.
- Installation targets `${XDG_BIN_HOME:-$HOME/.local/bin}/rh`, updates only a recognized Ralph Hero shim, and never overwrites an unrelated executable.
- Ordinary replay and unit tests use no network, real GitHub mutation, real Herdr server, coding agent, or billable model call.
- Never run `npm run test:bdd:live` without a fresh explicit user request for the live integration run and a configured Herdr environment.

---

## File Map

### Create

- `ralph/scripts/rh` — public router; parses global flags, performs exact `board` exec, and dispatches public verbs.
- `ralph/scripts/rh-lib/resolve.sh` — repository, board, Herdr binary, and installed Ralph-Herdr script discovery.
- `ralph/scripts/rh-lib/render.sh` — color policy, status rows, read-only home/dispatch/inbox/fleet/doctor surfaces, and the one-shot TTY prompt.
- `ralph/scripts/rh-lib/day.sh` — headless-server ensure, dispatch/team/cockpit actions, ordered day composition, and phase summary.
- `ralph/scripts/install-rh.sh` — collision-safe stable shim installer.
- `ralph/scripts/rh.test.ts` — router, pass-through, read-only, color, action composition, and installer contract tests.
- `plugin/ralph-herdr/scripts/resume-teams.sh` — scoped ledger-to-`work-team.sh` resume adapter.
- `plugin/ralph-herdr/tests/resume-teams.test.sh` — direct Bash tests for candidate selection and fail-closed behavior.
- `plugin/ralph-herdr/features/rh-command-surface.feature` — hermetic operator scenarios.
- `plugin/ralph-herdr/features/steps/rh.steps.ts` — `rh`-specific replay step definitions.
- `docs/reference/rh-wsl-smoke.md` — honest WSL checklist, separate from Linux CI claims.

### Modify

- `plugin/ralph-herdr/tests/fake-herdr.sh` — add deterministic `status server` and `server` lifecycle fixtures/state.
- `plugin/ralph-herdr/tests/fake-board.sh` — add read-only `brief`, `inbox`, and `doctor` surfaces used by `rh` replay.
- `plugin/ralph-herdr/features/steps/world.ts` — expose the real `rh` entrypoint and isolate its board, scripts, server state, HOME/state, and PATH.
- `plugin/ralph-herdr/features/live-smoke.feature` — add a named-session, plain-shell-only `rh` smoke scenario.
- `plugin/ralph-herdr/features/steps/live.steps.ts` — add safe stubs and assertions for the opt-in `rh` live scenario.
- `package.json` — add a focused `test:rh` script and include extensionless/nested `rh` Bash files in `lint:sh`.
- `ralph/README.md` — install and public command table.
- `plugin/ralph-herdr/CHEATSHEET.md` — operator distinction between dispatch status, up, and day.

---

### Task 1: Core Router, Resolution, and Exact Board Pass-through

**Files:**

- Create: `ralph/scripts/rh`
- Create: `ralph/scripts/rh-lib/resolve.sh`
- Create: `ralph/scripts/rh-lib/render.sh`
- Create: `ralph/scripts/rh.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `ralph/scripts/resolve-board.sh`; optional `RALPH_BOARD` override already published by `resolve-board-context.sh`.
- Produces: `rh_resolve_board() -> executable path`, `rh_repo_root([path]) -> canonical Git root`, `rh_resolve_herdr_scripts() -> scripts directory`, `rh_resolve_herdr_bin() -> executable path`, `rh_version()`, `rh_render_help([topic])`, and the stable router grammar used by all later tasks.

- [ ] **Step 1: Write failing pass-through and routing tests**

Add a `runRh()` helper that invokes `/bin/bash ralph/scripts/rh` with a scrubbed environment and a temporary executable `RALPH_BOARD`. Pin these cases:

```ts
it('executes the resolved board with byte-identical argv, stdin, streams, and rc', () => {
  const fake = executable(`#!/bin/bash
printf 'argc=%s\\n' "$#"
for arg in "$@"; do printf '<%s>\\n' "$arg"; done
IFS= read -r line || true
printf 'stdin=<%s>\\n' "$line"
printf 'board-stderr\\n' >&2
exit 23
`);
  const r = runRh(['board', 'get', '22', '--title', 'two words'], {
    RALPH_BOARD: fake,
    stdin: 'payload with spaces\n',
  });
  expect(r.status).toBe(23);
  expect(r.stdout).toBe('argc=4\n<get>\n<22>\n<--title>\n<two words>\nstdin=<payload with spaces>\n');
  expect(r.stderr).toBe('board-stderr\n');
});

it('stops parsing global options after board', () => {
  const log = join(tmp, 'argv.log');
  const fake = executable(`#!/bin/bash\nprintf '%s\\n' "$@" >"${log}"\n`);
  const r = runRh(['board', '--color=always', 'list'], { RALPH_BOARD: fake });
  expect(r.status).toBe(0);
  expect(readFileSync(log, 'utf8')).toBe('--color=always\nlist\n');
});

it('preserves a delegated board signal', () => {
  const fake = executable('#!/bin/bash\nkill -TERM $$\n');
  const r = runRh(['board', 'list'], { RALPH_BOARD: fake });
  expect(r.status).toBeNull();
  expect(r.signal).toBe('SIGTERM');
});

it('help and version work outside a git repository', () => {
  expect(runRh(['help'], { cwd: tmp }).status).toBe(0);
  expect(runRh(['version'], { cwd: tmp }).stdout).toMatch(/^rh /);
});

it('unknown commands fail as usage without invoking board', () => {
  const r = runRh(['dipsatch'], { cwd: tmp });
  expect(r.status).toBe(64);
  expect(r.stderr).toContain("unknown command 'dipsatch'");
  expect(r.stderr).toContain('rh dispatch');
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `npx vitest run ralph/scripts/rh.test.ts`

Expected: FAIL because `ralph/scripts/rh` does not exist.

- [ ] **Step 3: Implement resolver functions and the minimal router**

Use existing Ralph names and fail closed on an explicitly broken override:

```bash
rh_resolve_board() {
  local board
  if [ -n "${RALPH_BOARD:-}" ]; then
    [ -x "$RALPH_BOARD" ] || {
      echo "rh: RALPH_BOARD=$RALPH_BOARD is not executable" >&2
      return 69
    }
    printf '%s\n' "$RALPH_BOARD"
    return 0
  fi
  board=$(bash "$RH_SCRIPT_DIR/resolve-board.sh") || return 69
  [ -n "$board" ] && [ -x "$board" ] || {
    echo "rh: board CLI is unavailable; run 'rh doctor'" >&2
    return 69
  }
  printf '%s\n' "$board"
}

rh_repo_root() {
  local start="${1:-$PWD}" root
  root=$(git -C "$start" rev-parse --show-toplevel 2>/dev/null) || {
    echo "rh: $start is not inside a Git repository" >&2
    return 69
  }
  printf '%s\n' "$root"
}

rh_resolve_herdr_bin() {
  local herdr="${HERDR_BIN_PATH:-herdr}"
  command -v "$herdr" >/dev/null 2>&1 || {
    echo "rh: Herdr is unavailable (looked for '$herdr'); run 'rh doctor'" >&2
    return 69
  }
  command -v "$herdr"
}

rh_resolve_herdr_scripts() {
  local repo="${1:-$PWD}" registry root candidate
  if [ -n "${RALPH_HERDR_SCRIPTS_DIR:-}" ]; then
    [ -f "$RALPH_HERDR_SCRIPTS_DIR/dispatch-up.sh" ] || {
      echo "rh: RALPH_HERDR_SCRIPTS_DIR=$RALPH_HERDR_SCRIPTS_DIR is not a Ralph-Herdr scripts directory" >&2
      return 69
    }
    printf '%s\n' "$RALPH_HERDR_SCRIPTS_DIR"
    return 0
  fi
  registry="${RALPH_HERDR_PLUGINS_JSON:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins.json}"
  if [ -r "$registry" ] && command -v jq >/dev/null 2>&1; then
    root=$(jq -r 'map(select(.plugin_id == "ralph-herdr")) | .[0].plugin_root // empty' "$registry" 2>/dev/null) || root=""
    [ -n "$root" ] && [ -f "$root/scripts/dispatch-up.sh" ] && { printf '%s\n' "$root/scripts"; return 0; }
  fi
  for candidate in "$repo/plugin/ralph-herdr/scripts" "$RH_SCRIPT_DIR/../../plugin/ralph-herdr/scripts"; do
    [ -f "$candidate/dispatch-up.sh" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  echo "rh: Ralph-Herdr scripts not found; run 'rh doctor' or install/link the ralph-herdr plugin" >&2
  return 69
}

rh_version() {
  local manifest="$RH_SCRIPT_DIR/../.claude-plugin/plugin.json" version=""
  [ -n "${RALPH_RH_VERSION:-}" ] && { printf '%s\n' "$RALPH_RH_VERSION"; return 0; }
  [ -r "$manifest" ] && command -v jq >/dev/null 2>&1 &&
    version=$(jq -r '.version // empty' "$manifest" 2>/dev/null) || version=""
  printf '%s\n' "${version:-dev}"
}
```

The router must use `exec` for board:

```bash
case "$command" in
  board)
    shift
    board=$(rh_resolve_board) || exit $?
    exec "$board" "$@"
    ;;
  help|-h|--help)
    shift
    rh_render_help "${1-}"
    ;;
  version|--version)
    printf 'rh %s\n' "$(rh_version)"
    ;;
esac
```

Parse `--color=auto|always|never` only while it precedes the command. Store it in `RH_COLOR_MODE`; reject every other leading option with rc 64.

Mark the public entrypoint executable with `chmod +x ralph/scripts/rh`.

- [ ] **Step 4: Add the focused package scripts**

Add:

```json
"test:rh": "vitest run ralph/scripts/rh.test.ts",
"lint:sh": "shellcheck -S error ralph/hooks/*.sh ralph/scripts/*.sh ralph/scripts/rh ralph/scripts/rh-lib/*.sh ralph/scripts/kit-src/*.sh"
```

- [ ] **Step 5: Run tests and shell validation**

Run: `npm run test:rh`

Expected: PASS.

Run: `shellcheck -S error ralph/scripts/rh ralph/scripts/rh-lib/*.sh`

Expected: no findings.

Run: `/bin/bash --version | head -1`

Expected on macOS: GNU bash 3.2.x; record the actual version in the task notes.

- [ ] **Step 6: Commit**

```bash
git add package.json ralph/scripts/rh ralph/scripts/rh-lib/resolve.sh ralph/scripts/rh-lib/render.sh ralph/scripts/rh.test.ts
git commit -m "feat: add rh router and board pass-through"
```

---

### Task 2: Read-only Home, Dispatch Status, Inbox, Fleet, Doctor, and Color

**Files:**

- Modify: `ralph/scripts/rh`
- Modify: `ralph/scripts/rh-lib/render.sh`
- Modify: `ralph/scripts/rh.test.ts`

**Interfaces:**

- Consumes: `rh_resolve_board`, `rh_repo_root`, `rh_resolve_herdr_scripts`, `rh_resolve_herdr_bin` from Task 1; board reads `brief`, `inbox`, `who dispatch`, `roster`, and `doctor`; Herdr `fleet-status.sh`.
- Produces: `rh_color_init`, `rh_status STATE LABEL VALUE DETAIL`, `rh_home`, `rh_dispatch_status`, `rh_inbox`, `rh_fleet`, `rh_doctor`, and `rh_home_prompt`.

- [ ] **Step 1: Write failing read-only and color tests**

Pin these observable contracts:

```ts
it.each([[], ['dispatch'], ['inbox'], ['fleet'], ['doctor']])(
  '%j never invokes a mutating board verb or Herdr action',
  (args) => {
    const r = runSurface(args);
    expect(r.status).not.toBe(64);
    expect(readLines(boardLog).every((l) => /^(brief|inbox|who dispatch|roster|doctor)/.test(l))).toBe(true);
    expect(readLines(herdrLog).some((l) => /^(server|workspace|plugin pane|agent start|agent prompt)/.test(l))).toBe(false);
  },
);

it('inbox accepts read flags and refuses the local digest mutation', () => {
  expect(runSurface(['inbox', '--json']).status).toBe(0);
  const r = runSurface(['inbox', '--digest', '--mark']);
  expect(r.status).toBe(64);
  expect(r.stderr).toContain("use 'rh board inbox --digest --mark'");
});

it('NO_COLOR wins over --color=always', () => {
  const r = runSurface(['--color=always'], { NO_COLOR: '1' });
  expect(r.stdout).not.toContain('\u001b[');
});

it('--color=always adds restrained ANSI only to rh-owned rows', () => {
  const r = runSurface(['--color=always']);
  expect(r.stdout).toContain('\u001b[');
  expect(r.stdout).toContain('herdr');
});

it('a C locale uses the ASCII state vocabulary', () => {
  const r = runSurface([], { LC_ALL: 'C', NO_COLOR: '1' });
  expect(r.stdout).toMatch(/\b(OK|WARN|FAIL)\b/);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm run test:rh`

Expected: FAIL because these commands still have only router help behavior.

- [ ] **Step 3: Implement semantic rendering**

`NO_COLOR` must win before mode evaluation:

```bash
rh_color_init() {
  RH_GREEN="" RH_AMBER="" RH_RED="" RH_CYAN="" RH_DIM="" RH_RESET=""
  [ -n "${NO_COLOR:-}" ] && return 0
  case "${RH_COLOR_MODE:-auto}" in
    never) return 0 ;;
    auto) [ -t 1 ] || return 0 ;;
    always) ;;
    *) echo "rh: invalid color mode '${RH_COLOR_MODE:-}'" >&2; return 64 ;;
  esac
  RH_GREEN=$(printf '\033[32m')
  RH_AMBER=$(printf '\033[33m')
  RH_RED=$(printf '\033[31m')
  RH_CYAN=$(printf '\033[36m')
  RH_DIM=$(printf '\033[2m')
  RH_RESET=$(printf '\033[0m')
}
```

`rh_status` maps `healthy|attention|failed|action|metadata` to the approved colors and maps UTF-8 terminals to `●|▲|■|◆|·`; otherwise it prints `OK|WARN|FAIL|DO|INFO`. Always print the state word (`running`, `ready`, `degraded`, `blocked`) beside the glyph.

- [ ] **Step 4: Implement bounded read-only commands**

Use the existing board surface rather than reproducing queue logic:

```bash
rh_inbox() {
  local board arg
  board=$(rh_resolve_board) || return $?
  for arg in "$@"; do
    case "$arg" in
      --json|--digest) ;;
      --mark)
        echo "rh inbox is read-only; use 'rh board inbox --digest --mark' for the explicit stamp" >&2
        return 64
        ;;
      *) echo "rh inbox: unknown argument '$arg' (accepts --json, --digest)" >&2; return 64 ;;
    esac
  done
  "$board" inbox "$@"
}

rh_fleet() {
  local scripts repo
  repo=$(rh_repo_root) || return $?
  scripts=$(rh_resolve_herdr_scripts "$repo") || return $?
  (cd "$repo" && RALPH_HERDR_REPO="$repo" bash "$scripts/fleet-status.sh" "$@")
}

rh_doctor() {
  local board repo rc=0
  repo=$(rh_repo_root) || return $?
  board=$(rh_resolve_board) || return $?
  "$board" doctor || rc=1
  RALPH_HERDR_REPO="$repo" RALPH_HERDR_BOARD="$board" bash "$RH_SCRIPT_DIR/herdr-setup.sh" check || rc=1
  return "$rc"
}
```

`rh_home` renders one Herdr status row, then delegates `board brief` and `board inbox` as separate labeled sections. `rh_dispatch_status` uses `herdr status server --json`, `board who dispatch`, and `board roster`; failures render `not evaluated`, never an empty/healthy answer.

- [ ] **Step 5: Add the one-shot TTY action prompt**

`rh_home_prompt` reads exactly one choice and dispatches only public functions:

```bash
rh_home_prompt() {
  local choice
  printf '\n[d] start day   [c] cockpit   [i] inbox   [f] fleet   [q] quit\n> '
  IFS= read -r choice || return 0
  case "$choice" in
    d) rh_day ;;
    c) rh_cockpit ;;
    i) rh_inbox ;;
    f) rh_fleet ;;
    q|'') return 0 ;;
    *) echo "unknown action '$choice'" >&2; return 64 ;;
  esac
}
```

`rh_home` calls it only when both stdin and stdout are TTYs. Non-TTY use prints once and exits.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:rh`

Expected: PASS.

Run: `shellcheck -S error ralph/scripts/rh ralph/scripts/rh-lib/*.sh`

Expected: no findings.

```bash
git add ralph/scripts/rh ralph/scripts/rh-lib/render.sh ralph/scripts/rh.test.ts
git commit -m "feat: add read-only rh operator home"
```

---

### Task 3: Herdr Server Ensure and Explicit Mutating Commands

**Files:**

- Create: `ralph/scripts/rh-lib/day.sh`
- Modify: `ralph/scripts/rh`
- Modify: `ralph/scripts/rh.test.ts`

**Interfaces:**

- Consumes: `rh_resolve_herdr_bin` and `rh_resolve_herdr_scripts` from Task 1; existing `dispatch-up.sh`, `cockpit-open.sh`, and `work-team.sh`.
- Produces: `rh_server_ready`, `rh_ensure_server`, `rh_run_herdr_script SCRIPT [ARGS]`, `rh_dispatch_up`, `rh_cockpit`, and `rh_team EPIC`.

- [ ] **Step 1: Write failing action-boundary tests**

Use a fake Herdr executable backed by a state file and fake Herdr scripts backed by an invocation log:

```ts
it('dispatch up starts a missing server and invokes only dispatch-up once', () => {
  const r = runSurface(['dispatch', 'up'], fixtureEnv({ server: 'down' }));
  expect(r.status).toBe(0);
  expect(readLines(herdrLog)).toEqual([
    'status server --json',
    'server',
    'status server --json',
    'status server --json',
  ]);
  expect(readLines(scriptLog)).toEqual(['dispatch-up']);
});

it('dispatch up reuses a healthy server', () => {
  const r = runSurface(['dispatch', 'up'], fixtureEnv({ server: 'running' }));
  expect(r.status).toBe(0);
  expect(readLines(herdrLog).filter((l) => l === 'server')).toHaveLength(0);
  expect(readLines(scriptLog)).toEqual(['dispatch-up']);
});

it('cockpit refuses a down server without starting it', () => {
  const r = runSurface(['cockpit'], fixtureEnv({ server: 'down' }));
  expect(r.status).not.toBe(0);
  expect(readLines(herdrLog)).not.toContain('server');
  expect(readLines(scriptLog)).not.toContain('cockpit-open');
});

it('team is explicit and ensures dispatch before exactly one epic', () => {
  const r = runSurface(['team', '2208'], fixtureEnv({ server: 'running' }));
  expect(r.status).toBe(0);
  expect(readLines(scriptLog)).toEqual(['dispatch-up', 'work-team 2208']);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npm run test:rh`

Expected: FAIL because mutating commands are not implemented.

- [ ] **Step 3: Implement bounded headless-server ensure**

Use Herdr's exit status as readiness truth and the existing Ralph home for logs:

```bash
rh_server_ready() {
  local herdr
  herdr=$(rh_resolve_herdr_bin) || return $?
  "$herdr" status server --json >/dev/null 2>&1
}

rh_ensure_server() {
  local herdr state_dir log attempts poll i
  herdr=$(rh_resolve_herdr_bin) || return $?
  rh_server_ready && return 0
  state_dir="${RALPH_HOME:-$HOME/.ralph}/logs"
  mkdir -p "$state_dir" || return 1
  log="$state_dir/herdr-server.log"
  nohup "$herdr" server >>"$log" 2>&1 </dev/null &
  attempts="${RALPH_RH_SERVER_ATTEMPTS:-20}"
  poll="${RALPH_RH_SERVER_POLL_SEC:-1}"
  i=0
  while [ "$i" -lt "$attempts" ]; do
    rh_server_ready && return 0
    sleep "$poll"
    i=$((i + 1))
  done
  echo "rh: Herdr server did not become ready; see $log" >&2
  return 1
}
```

- [ ] **Step 4: Implement exact action composition**

`rh_run_herdr_script` sets only established scope/path variables and preserves the delegated exit code. `rh_dispatch_up` calls `rh_ensure_server`, calls `dispatch-up.sh`, then requires one final successful `rh_server_ready` re-read. `rh_cockpit` requires `rh_server_ready` then calls `cockpit-open.sh`. `rh_team` validates exactly one positive integer, calls `rh_dispatch_up`, then delegates it to `work-team.sh`.

“No team resume” means no explicit `resume-teams.sh` or `work-team.sh` call. Starting Herdr may perform Herdr's configured native session restoration; this command surface does not disable that native behavior.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:rh`

Expected: PASS.

Run: `shellcheck -S error ralph/scripts/rh ralph/scripts/rh-lib/*.sh`

Expected: no findings.

```bash
git add ralph/scripts/rh ralph/scripts/rh-lib/day.sh ralph/scripts/rh.test.ts
git commit -m "feat: add explicit rh dispatch actions"
```

---

### Task 4: Evidence-backed Team Resume Adapter

**Files:**

- Create: `plugin/ralph-herdr/scripts/resume-teams.sh`
- Create: `plugin/ralph-herdr/tests/resume-teams.test.sh`

**Interfaces:**

- Consumes: `lib.sh` functions `ralph_agents_json`, `ralph_ledger_path`, `ralph_session_key`; current ledger event vocabulary; `RALPH_HERDR_WORK_TEAM` test override already used by `heal.sh`; `work-team.sh EPIC --lead-only`.
- Produces: `resume-teams.sh` with no positional arguments; rc 0 for no candidates/all already live/clean-complete, rc 1 for ambiguous or failed candidates, rc 3 for an unreadable herd. Output contains one `resume team GH-N:` line per candidate.

- [ ] **Step 1: Write the failing Bash test suite**

Use a temporary real Git repository with `.ralph.json`, a scoped ledger, `herd-fixture.sh`, and a fake work-team logger. Cover these assertions:

```bash
# no durable lead record: no call
run_resume
is "empty ledger exits 0" "0" "$RC"
is "empty ledger launches nothing" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"

# two epochs for one prior team, one checkout: exactly one resume call
seed_lead 'o900-team#aaaa1111' "$REPO_DIR"
seed_lead 'o900-team#bbbb2222' "$REPO_DIR"
run_resume
is "one epic is deduplicated" "1" "$(grep -c '^900 --lead-only$' "$TEAM_LOG")"

# live lead: no delegated restart
herd_fixture '[{"name":"o900-team","agent_status":"working","pane_id":"p9"}]' "$REPO_DIR"
run_resume
is "live lead is not delegated" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"

# contradictory checkout evidence: visible nonzero, no call
seed_lead 'o901-team#cccc3333' "$REPO_DIR"
seed_lead 'o901-team#dddd4444' "$OTHER_REPO"
run_resume
is "ambiguous checkout exits 1" "1" "$RC"
line_has "ambiguity is visible" "$OUT" "resume team GH-901: skipped — contradictory checkout evidence"
is "ambiguous team launches nothing" "0" "$(grep -c '^901 ' "$TEAM_LOG" || true)"

# unreadable snapshot: seed a candidate, then fail closed before every resume
seed_lead 'o902-team#eeee5555' "$REPO_DIR"
HERDR_BIN_PATH=/usr/bin/false run_resume
is "unreadable herd exits 3" "3" "$RC"
is "unreadable herd launches nothing" "0" "$(wc -l <"$TEAM_LOG" | tr -d ' ')"
```

Also assert the fake board log contains no `frontier`, `next`, `list`, or open-epic enumeration.

- [ ] **Step 2: Run the new suite and verify red**

Run: `bash plugin/ralph-herdr/tests/resume-teams.test.sh`

Expected: FAIL because `resume-teams.sh` does not exist.

- [ ] **Step 3: Implement closed, scoped candidate extraction**

Read the current ledger once and emit one JSON object per epic. Require the current `session`, grammar-B `o`-lane ref, a nonempty checkout on every contributing record, and exactly one unique checkout:

```bash
candidates=$(jq -cs --arg session "$session" '
  [ .[]
    | select(.session == $session)
    | select(.ev == "spawn" or .ev == "discover")
    | select((.lineage.role // .tokens.role // "") == "orchestrator")
    | (.agent_ref // "") as $ref
    | ($ref | capture("^o(?<epic>[0-9]+)-[a-z0-9-]+#[0-9a-f]+$")?) as $m
    | select($m != null)
    | {epic: $m.epic, checkout: (.checkout // "")}
  ]
  | group_by(.epic)
  | map({
      epic: .[0].epic,
      checkouts: ([.[].checkout | select(length > 0)] | unique),
      missingCheckout: any(.[]; .checkout == "")
    })
  | .[]' "$ledger") || {
    echo "resume-teams: ledger is unreadable — launching nothing" >&2
    exit 1
  }
```

If the ledger is absent, empty, or produces no candidates, print `resume teams: none recorded` and exit 0 before reading the herd. Mark `resume-teams.sh` executable.

For each JSON line:

1. Refuse when `missingCheckout` is true or `checkouts | length != 1`.
2. Resolve both checkout and `$REPO` with `git rev-parse --show-toplevel`; require byte equality.
3. Use the one fresh `ralph_agents_json` result to skip `o<EPIC>-*` already live.
4. Invoke `RALPH_HERDR_INVOKED_BY=scheduler bash "$team_sh" "$epic" --lead-only` from the recorded checkout.
5. Treat rc 4 as clean completion; aggregate every other nonzero as rc 1 without stopping later independent candidates.

- [ ] **Step 4: Verify existing and new team contracts**

Run: `bash plugin/ralph-herdr/tests/resume-teams.test.sh`

Expected: all assertions pass.

Run: `bash plugin/ralph-herdr/tests/work-team.test.sh`

Expected: 62/62 baseline assertions remain green or the current higher count passes.

Run: `shellcheck -S error plugin/ralph-herdr/scripts/resume-teams.sh plugin/ralph-herdr/tests/resume-teams.test.sh`

Expected: no findings.

- [ ] **Step 5: Commit**

```bash
git add plugin/ralph-herdr/scripts/resume-teams.sh plugin/ralph-herdr/tests/resume-teams.test.sh
git commit -m "feat: resume only ledgered rh teams"
```

---

### Task 5: Full Day Composition and Partial-failure Summary

**Files:**

- Modify: `ralph/scripts/rh`
- Modify: `ralph/scripts/rh-lib/day.sh`
- Modify: `ralph/scripts/rh-lib/render.sh`
- Modify: `ralph/scripts/rh.test.ts`

**Interfaces:**

- Consumes: `rh_dispatch_up`, `rh_run_herdr_script`, `resume-teams.sh`, `work-team.sh`, `cockpit-open.sh`, and read-only `rh_inbox`.
- Produces: `rh_day [--team EPIC]...`; `rh dispatch day` calls the same function; `rh_phase NAME STATE DETAIL` and final nonzero aggregation.

- [ ] **Step 1: Write failing day-contract tests**

```ts
it('naked day never invokes work-team when no durable team exists', () => {
  const r = runSurface(['day'], fixtureEnv({ server: 'running' }));
  expect(r.status).toBe(0);
  expect(readLines(scriptLog)).toEqual([
    'dispatch-up',
    'reconcile',
    'resume-teams',
    'cockpit-open',
  ]);
  expect(readLines(scriptLog).some((l) => l.startsWith('work-team '))).toBe(false);
});

it('repeatable team flags are validated and deduplicated before mutation', () => {
  const r = runSurface(['day', '--team', '2208', '--team', '2208', '--team', '2176']);
  expect(r.status).toBe(0);
  expect(readLines(scriptLog).filter((l) => l.startsWith('work-team '))).toEqual([
    'work-team 2208',
    'work-team 2176',
  ]);
});

it('dispatch failure prevents every dependent phase', () => {
  const r = runSurface(['day'], fixtureEnv({ dispatchRc: 1 }));
  expect(r.status).not.toBe(0);
  expect(readLines(scriptLog)).toEqual(['dispatch-up']);
  expect(r.stdout).toContain('dispatch');
  expect(r.stdout).toContain('failed');
});

it('resume ambiguity continues to cockpit and inbox but returns nonzero', () => {
  const r = runSurface(['day'], fixtureEnv({ resumeRc: 1 }));
  expect(r.status).not.toBe(0);
  expect(readLines(scriptLog)).toContain('cockpit-open');
  expect(readLines(boardLog)).toContain('inbox');
  expect(r.stdout).toContain('teams');
  expect(r.stdout).toContain('attention');
});

it('dispatch day and day invoke the same ordered phases', () => {
  const direct = runSurface(['day'], fixtureEnv({ isolatedLog: 'direct' }));
  const nested = runSurface(['dispatch', 'day'], fixtureEnv({ isolatedLog: 'nested' }));
  expect(direct.status).toBe(nested.status);
  expect(readLines(logFor('direct'))).toEqual(readLines(logFor('nested')));
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm run test:rh`

Expected: FAIL because day composition is incomplete.

- [ ] **Step 3: Implement parse-before-mutate and ordered phases**

Parse repeatable flags into a Bash 3.2 indexed array and reject all bad input before preflight:

```bash
teams=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --team)
      shift
      [ "$#" -gt 0 ] || { echo "rh day: --team needs an epic number" >&2; return 64; }
      case "$1" in ''|*[!0-9]*) echo "rh day: invalid epic '$1'" >&2; return 64 ;; esac
      case " ${teams[*]-} " in *" $1 "*) ;; *) teams+=("$1") ;; esac
      ;;
    *) echo "rh day: unknown argument '$1'" >&2; return 64 ;;
  esac
  shift
done
```

When iterating the possibly empty array under `set -u`, use the Bash 3.2-safe expansion `${teams[@]+"${teams[@]}"}`.

Preflight resolves repository, board, Herdr, scripts, and `jq` before calling `rh_dispatch_up`. After dispatch succeeds, run:

```text
reconcile.sh
resume-teams.sh
work-team.sh <each explicit team>
cockpit-open.sh
board inbox
```

Continue after reconcile/resume/one explicit-team failure, but never after dispatch failure. Track the aggregate rc and print each phase once as `ready`, `unchanged`, `resumed`, `started`, `skipped`, `attention`, or `failed`.

- [ ] **Step 4: Verify idempotence and exact command differences**

Run: `npm run test:rh`

Expected: PASS, including a test that invokes the same `day` fixture twice and sees zero additional server starts and no duplicate explicit team start from the idempotent fake.

Run: `bash plugin/ralph-herdr/tests/dispatch-up.test.sh`

Expected: 44/44 baseline assertions remain green or the current higher count passes.

- [ ] **Step 5: Commit**

```bash
git add ralph/scripts/rh ralph/scripts/rh-lib/day.sh ralph/scripts/rh-lib/render.sh ralph/scripts/rh.test.ts
git commit -m "feat: compose safe rh start of day"
```

---

### Task 6: Collision-safe PATH Installer

**Files:**

- Create: `ralph/scripts/install-rh.sh`
- Modify: `ralph/scripts/rh.test.ts`

**Interfaces:**

- Consumes: Ralph plugin registry shape already used by `resolve-board.sh`; optional `RALPH_RH_ENTRYPOINT` development override.
- Produces: `${XDG_BIN_HOME:-$HOME/.local/bin}/rh`, marked `# ralph-hero-rh-shim:v1`; installer accepts `--bin-dir DIR` only.

- [ ] **Step 1: Write failing installer tests**

```ts
it('installs an executable shim into XDG_BIN_HOME and resolves the registered Ralph plugin at call time', () => {
  const env = installEnv();
  expect(runInstall([], env).status).toBe(0);
  const shim = join(env.XDG_BIN_HOME, 'rh');
  expect(statSync(shim).mode & 0o111).not.toBe(0);
  expect(readFileSync(shim, 'utf8')).toContain('# ralph-hero-rh-shim:v1');
  const r = spawnSync(shim, ['version'], { cwd: tmp, encoding: 'utf8', env });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^rh /);
});

it('updates a recognized shim idempotently', () => {
  const env = installEnv();
  expect(runInstall([], env).status).toBe(0);
  expect(runInstall([], env).status).toBe(0);
  expect(readFileSync(join(env.XDG_BIN_HOME, 'rh'), 'utf8').match(/ralph-hero-rh-shim:v1/g)).toHaveLength(1);
});

it('refuses to replace a foreign rh executable', () => {
  const env = installEnv();
  mkdirSync(env.XDG_BIN_HOME, { recursive: true });
  writeFileSync(join(env.XDG_BIN_HOME, 'rh'), '#!/bin/sh\necho foreign\n', { mode: 0o755 });
  const r = runInstall([], env);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('refusing to replace unrelated executable');
  expect(readFileSync(join(env.XDG_BIN_HOME, 'rh'), 'utf8')).toContain('echo foreign');
});

it('contains no source-checkout or user-specific absolute path', () => {
  const env = installEnv();
  expect(runInstall([], env).status).toBe(0);
  const shim = readFileSync(join(env.XDG_BIN_HOME, 'rh'), 'utf8');
  expect(shim).not.toContain(REPO_ROOT);
  expect(shim).not.toContain(env.HOME);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `npm run test:rh`

Expected: FAIL because the installer does not exist.

- [ ] **Step 3: Implement the stable resolving shim**

The generated shim must:

1. Use `RALPH_RH_ENTRYPOINT` when explicitly set and executable; refuse a broken value.
2. Use `./ralph/scripts/rh` when the current Git root contains this checkout layout.
3. Read `${RALPH_INSTALLED_PLUGINS_FILE:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/installed_plugins.json}` with `jq`, choose the highest registered `ralph` version, and exec `<installPath>/scripts/rh`.
4. Fall back to the newest cache path, label that fallback on stderr as a guess, and fail 69 with a setup remedy when no executable is found.

Write the shim through `mktemp` inside the destination, `chmod +x`, then atomic `mv`. Before replacement:

```bash
if [ -e "$target" ] && ! grep -q '^# ralph-hero-rh-shim:v1$' "$target" 2>/dev/null; then
  echo "install-rh: refusing to replace unrelated executable $target" >&2
  echo "install-rh: choose another directory: bash $0 --bin-dir <directory>" >&2
  exit 1
fi
```

After installation, print the installed path and a literal PATH export only when the destination is not already present as a complete PATH component.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:rh`

Expected: PASS.

Run: `shellcheck -S error ralph/scripts/install-rh.sh`

Expected: no findings.

```bash
git add ralph/scripts/install-rh.sh ralph/scripts/rh.test.ts
git commit -m "feat: install collision-safe rh shim"
```

---

### Task 7: Hermetic Cucumber Operator Replay

**Files:**

- Create: `plugin/ralph-herdr/features/rh-command-surface.feature`
- Create: `plugin/ralph-herdr/features/steps/rh.steps.ts`
- Modify: `plugin/ralph-herdr/features/steps/world.ts`
- Modify: `plugin/ralph-herdr/tests/fake-herdr.sh`
- Modify: `plugin/ralph-herdr/tests/fake-board.sh`

**Interfaces:**

- Consumes: the real `ralph/scripts/rh`, real `dispatch-up.sh`, `reconcile.sh`, `resume-teams.sh`, `work-team.sh`, and `cockpit-open.sh` through the existing isolated world.
- Produces: replay scenarios that assert mutations through fake invocation logs and scoped ledger files.

- [ ] **Step 1: Add the failing feature**

Create this feature contract:

```gherkin
Feature: Ralph Hero command surface
  Background:
    Given a replay world with a board-scoped repo
    And the rh server is initially down

  Scenario: Home and dispatch status are read-only
    When the operator runs naked rh
    Then rh succeeds
    And no mutating board or Herdr command ran
    When the operator runs rh dispatch
    Then rh succeeds
    And no mutating board or Herdr command ran

  Scenario: Dispatch up ensures only dispatch prerequisites
    When the operator runs rh dispatch up
    Then rh succeeds
    And the Herdr server was started once
    And dispatch was ensured once
    And no team or cockpit command ran

  Scenario: Naked day creates no never-before-existing team
    When the operator runs naked rh day
    Then rh succeeds
    And no work-team command ran
    And cockpit and inbox followed healthy dispatch

  Scenario: A ledger-proven dead team resumes exactly once
    Given team 2208 has one scoped historical lead record and no live lead
    When the operator runs naked rh day
    And resumed lead for 2208 becomes live
    And the operator runs naked rh day again
    Then team 2208 was resumed exactly once
    And no other team was attempted

  Scenario: A live team is never doubled
    Given team 2208 has one scoped historical lead record and a live lead
    When the operator runs naked rh day
    Then no agent start for team 2208 ran

  Scenario: Ambiguous resume evidence launches nothing
    Given team 2208 has contradictory checkout evidence
    When the operator runs naked rh day
    Then rh reports attention
    And no agent start for team 2208 ran

  Scenario: Explicit teams are exact and repeatable flags deduplicate
    When the operator runs rh day with teams 2208, 2208, and 2176
    Then only teams 2208 and 2176 were attempted once

  Scenario: Dispatch failure prevents dependent phases
    Given dispatch up will fail
    When the operator runs naked rh day
    Then rh fails
    And reconcile, teams, cockpit, and inbox did not run
```

- [ ] **Step 2: Run replay and verify undefined/red steps**

Run: `npm run test:bdd -- --name "Ralph Hero command surface"`

Expected: FAIL with undefined `rh` steps.

- [ ] **Step 3: Extend the fake lifecycle surfaces**

In `fake-herdr.sh`, add documented fixtures/state:

- `status server --json` logs as usual; when `FAKE_HERDR_SERVER_STATE` exists and contains `running`, return success JSON; otherwise emit an unavailable error and rc 1.
- bare `server` writes `running\n` atomically to `FAKE_HERDR_SERVER_STATE` and exits 0.

In `fake-board.sh`, add:

```bash
"brief"*) emit_fixture brief || printf 'next: none\nqueues: 0 eligible, 0 blocked\n' ; key="brief" ;;
"inbox"*) emit_fixture inbox || printf 'inbox: empty — no decisions waiting\n' ; key="inbox" ;;
"doctor"*) emit_fixture doctor || printf 'ok — fake board healthy\n' ; key="doctor" ;;
```

Preserve fixture rc files for all three.

- [ ] **Step 4: Extend `RalphWorld` isolation**

Export:

```ts
export const RH_SCRIPT = path.join(REPO_ROOT, 'ralph', 'scripts', 'rh');
```

Add `herdrServerState` and `rhLogFile` paths during `build()`. In `env()` add:

```ts
RALPH_BOARD: path.join(this.bin, 'board'),
RALPH_HERDR_SCRIPTS_DIR: SCRIPTS_DIR,
RALPH_HOME: path.join(this.tmp, 'ralph-home'),
FAKE_HERDR_SERVER_STATE: this.herdrServerState,
RALPH_RH_SERVER_ATTEMPTS: '3',
RALPH_RH_SERVER_POLL_SEC: '0',
```

Keep the existing prefix scrub before these values are restored.

- [ ] **Step 5: Implement dedicated `rh` steps**

The runner uses the real script and world environment:

```ts
function runRh(world: RalphWorld, args: string[]): void {
  const r = spawnSync('bash', [RH_SCRIPT, ...args], {
    cwd: world.repoDir,
    env: world.env(),
    encoding: 'utf8',
    input: '',
    timeout: 90_000,
  });
  world.last = {
    rc: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}
```

Steps seed `o`-lane spawn records with the current `WORLD_SESSION_KEY`, a valid checkout, `lineage.role: orchestrator`, `tokens.role: orchestrator`, and the epic number. For every resumed or explicit epic, write `get.<EPIC>.json` as a live open epic, `name.<EPIC>.json` as a canned `o`-lane name, and `name.dispatch.json` for the dispatch lane. The “becomes live” step rewrites the fake herd snapshot before the second run. Assertions count exact `server`, `workspace create`, `plugin pane open`, and `agent start o<EPIC>-` log lines and reject `board frontier`/`board next` as resume evidence.

- [ ] **Step 6: Run replay and direct shell regressions**

Run: `npm run test:bdd -- --name "Ralph Hero command surface"`

Expected: all new scenarios pass.

Run: `npm run test:bdd`

Expected: all replay features pass.

Run: `bash plugin/ralph-herdr/tests/dispatch-up.test.sh`

Expected: pass.

Run: `bash plugin/ralph-herdr/tests/work-team.test.sh`

Expected: pass.

Run: `bash plugin/ralph-herdr/tests/resume-teams.test.sh`

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add plugin/ralph-herdr/features/rh-command-surface.feature plugin/ralph-herdr/features/steps/rh.steps.ts plugin/ralph-herdr/features/steps/world.ts plugin/ralph-herdr/tests/fake-herdr.sh plugin/ralph-herdr/tests/fake-board.sh
git commit -m "test: replay the rh operator surface"
```

---

### Task 8: Safe Live Scenario, Documentation, WSL Checklist, and Full Verification

**Files:**

- Modify: `plugin/ralph-herdr/features/live-smoke.feature`
- Modify: `plugin/ralph-herdr/features/steps/live.steps.ts`
- Create: `docs/reference/rh-wsl-smoke.md`
- Modify: `ralph/README.md`
- Modify: `plugin/ralph-herdr/CHEATSHEET.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: named Herdr session `ralph-bdd`, the public `rh` command, and plain shell workspace/pane operations only.
- Produces: an opt-in live proof that cannot touch the default session, start a coding agent, reach GitHub, or bill; user-facing installation/command documentation; reproducible WSL claims.

- [ ] **Step 1: Add the opt-in live scenario without running it**

Add:

```gherkin
Scenario: rh observes and composes a named test session without coding agents
  Given an absent live herdr test session named "ralph-bdd"
  And safe rh live stubs for board, dispatch, resume, and cockpit
  When rh day starts the named test session
  Then rh reports a healthy dispatch and inbox
  And the named test session has no coding agents
  When rh day runs again in the named test session
  Then no second server or dispatch seat is created
```

The safe stubs are created under `liveTmp` and supplied through `RALPH_BOARD` and `RALPH_HERDR_SCRIPTS_DIR`. A separate `liveTmp/herdr-ralph-bdd` wrapper is supplied through `HERDR_BIN_PATH`; it logs calls and `exec`s the resolved real Herdr binary with `--session ralph-bdd`, so even the server probe/start cannot reach the default session. Initialize a disposable Git repository at `liveTmp/repo`, write its `.ralph.json`, and run both `rh day` calls from that repository. The dispatch stub first lists workspaces and creates its uniquely labeled plain-shell workspace only when absent; the cockpit stub first lists panes and focuses its uniquely labeled pane, creating it only when absent. Reconcile/resume scripts log and exit 0. No stub invokes `agent start`, `claude`, `codex`, `gh`, or the real board CLI.

- [ ] **Step 2: Implement live safety assertions**

Before and after each `rh day`, call `herdr --session ralph-bdd agent list` and assert `.result.agents // []` is empty. Count workspaces/panes by the unique `ralph-bdd-rh-*` labels. Keep the existing `RALPH_BDD_LIVE=1` gate, `ALLOWED_SESSIONS` allowlist, environment prefix scrub, and After-hook stop/delete cleanup.

Do not run `npm run test:bdd:live` in this task. Record it as pending explicit user authorization under the final verification report.

- [ ] **Step 3: Document installation and command semantics**

Add this concise command table to `ralph/README.md` and `plugin/ralph-herdr/CHEATSHEET.md`:

```text
rh                 read-only operator home
rh dispatch        read-only dispatch status
rh dispatch up     ensure Herdr + dispatch only
rh day             ensure dispatch, resume proven teams, open cockpit + inbox
rh day --team N    same, plus explicit new team N
rh board ...       exact existing board CLI
rh inbox           read-only human inbox
rh fleet           read-only scoped fleet status
rh doctor          read-only setup and board diagnosis
```

Document `bash ralph/scripts/install-rh.sh`, the default PATH target, collision refusal, `--color`, `NO_COLOR`, and that existing `board` remains permanent.

- [ ] **Step 4: Write the WSL smoke checklist**

The checklist must contain exact commands and expected outcomes for:

1. Install under `~/.local/bin` and verify `command -v rh`.
2. Run from a repository on the Linux filesystem.
3. Run from a repository under `/mnt/c/...` and confirm Git-root discovery.
4. Run `NO_COLOR=1 rh` and verify no ANSI escapes with `sed -n l`.
5. Run `rh dispatch`, then `rh dispatch up`, and distinguish read-only from ensure behavior.
6. Run `rh day` twice with no team flags and confirm the second run is unchanged and neither run creates a never-before-existing team.
7. Run `rh day --team N` only against a disposable configured test epic.

State plainly that Linux CI is not WSL proof and require date, WSL version, distro, filesystem location, and result to be recorded when the checklist is executed.

- [ ] **Step 5: Run full non-live validation**

Run: `npx tsc --noEmit`

Expected: PASS.

Run: `npx vitest run ralph/scripts/`

Expected: PASS.

Run: `npm run contracts:check`

Expected: PASS with no generated contract diff.

Run: `npm run test:bdd`

Expected: PASS; this is replay only.

Run: `bash plugin/ralph-herdr/tests/dispatch-up.test.sh`

Expected: PASS.

Run: `bash plugin/ralph-herdr/tests/work-team.test.sh`

Expected: PASS.

Run: `bash plugin/ralph-herdr/tests/resume-teams.test.sh`

Expected: PASS.

Run: `shellcheck -S error ralph/scripts/rh ralph/scripts/install-rh.sh ralph/scripts/rh-lib/*.sh plugin/ralph-herdr/scripts/resume-teams.sh plugin/ralph-herdr/tests/resume-teams.test.sh plugin/ralph-herdr/tests/fake-herdr.sh plugin/ralph-herdr/tests/fake-board.sh`

Expected: no findings.

- [ ] **Step 6: Perform a bounded manual macOS shell smoke**

From the repository, run only read-only/local install checks:

```bash
/bin/bash ralph/scripts/rh help
NO_COLOR=1 /bin/bash ralph/scripts/rh dispatch
tmp_bin=$(mktemp -d)
/bin/bash ralph/scripts/install-rh.sh --bin-dir "$tmp_bin"
"$tmp_bin/rh" version
```

Expected: help/version succeed, dispatch does not start Herdr, no ANSI appears under `NO_COLOR`, and the temporary shim resolves the in-tree command without modifying the user's real PATH.

- [ ] **Step 7: Commit documentation and non-live verification support**

```bash
git add package.json ralph/README.md plugin/ralph-herdr/CHEATSHEET.md docs/reference/rh-wsl-smoke.md plugin/ralph-herdr/features/live-smoke.feature plugin/ralph-herdr/features/steps/live.steps.ts
git commit -m "docs: finish rh operator launch surface"
```

- [ ] **Step 8: Stop at the live-test gate**

Report the non-live validation results and state that `npm run test:bdd:live` remains intentionally unexecuted. Run it only if the user explicitly requests the live integration run after reviewing its named-session/no-agent safety contract.

---

## Completion Evidence

Before claiming the command surface complete, the implementation handoff must include:

- The installed or in-tree command used for the smoke.
- Exact pass counts for `rh.test.ts`, `dispatch-up.test.sh`, `work-team.test.sh`, `resume-teams.test.sh`, and Cucumber replay.
- `npx tsc --noEmit`, contracts, ShellCheck, and root Vitest results.
- One replay log proving naked `rh day` invoked no `work-team.sh` without durable evidence.
- One replay log proving a scoped dead team resumed exactly once and an ambiguous team launched nothing.
- Confirmation that existing untracked user files were not staged or modified.
- Live BDD explicitly labeled either `PASS (user-authorized)` or `NOT RUN (awaiting explicit authorization)`.
