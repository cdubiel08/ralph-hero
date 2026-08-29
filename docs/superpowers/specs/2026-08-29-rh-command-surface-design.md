# Ralph Hero `rh` Command Surface Design

**Date:** 2026-08-29

**Status:** Approved in conversation; pending document review

**Scope:** One portable `rh` shell command that exposes Ralph board operations and Ralph-Herdr operator workflows without merging their internal engines.

## Decision

Ralph Hero will ship `rh` as its canonical human-facing shell command.

`rh` is a thin façade over two existing authorities:

- The Ralph board CLI remains the sole sanctioned board mutation path.
- The Ralph-Herdr scripts remain the authority for Herdr topology, dispatch, teams, fleet state, cockpit, and reconciliation.

The façade provides one discoverable grammar, a start-of-day composition, a compact operator home, portable installation, and consistent status rendering. It does not copy board rules into shell, invent a second state machine, or treat a task runner as the runtime product.

The compatibility command `board` remains supported indefinitely. `rh board ...` is an exact transparent pass-through to it.

## Why `rh`

`ralph` is crowded in the AI coding ecosystem and is already present locally as a stale legacy wrapper. `rh` is short, typeable, and reads naturally as Ralph Hero. It is not globally unique: RosettaHub, Reason Healthcare, Rawhide, and smaller tools also install an `rh` binary. That makes collision-safe installation mandatory, but does not make the name unusable for a developer-local tool.

The installer therefore owns only the `rh` shim it created. It updates a recognized Ralph Hero shim idempotently, refuses to overwrite an unrelated executable, and prints an alternate installation path when a collision exists.

## Goals

1. Make “start my Ralph Hero day” one explicit command from macOS, Linux, or WSL.
2. Give the operator a low-friction home and inbox without causing mutations on inspection.
3. Make the difference between status, minimum dispatch readiness, and full day composition obvious.
4. Preserve board safety and compatibility exactly.
5. Make repeated startup commands safe after partial failure, shell restart, or machine restart.
6. Prove the surface in the existing hermetic Ralph-Herdr world before claiming it works live.

## Non-goals

- Replacing the cockpit TUI.
- Rewriting the board CLI or exposing a second board mutation API.
- Making `just`, `mise`, tmux, or another task/session runner a required runtime dependency.
- Automatically selecting or launching a new team during `rh day`.
- Automatically repairing authentication, plugin versions, board configuration, or Herdr configuration.
- Adding an agentic test judge to the correctness gate. Model-backed operator evaluation can layer on later.
- Supporting native Windows shells in the first release. WSL is supported as Linux; PowerShell and `cmd.exe` are not.

## Command Grammar

```text
rh
rh board <existing-board-args...>

rh dispatch
rh dispatch up
rh dispatch day [--team EPIC]...
rh day [--team EPIC]...

rh cockpit
rh team EPIC
rh fleet
rh inbox
rh doctor

rh help [COMMAND]
rh version
```

### Behavioral summary

| Command | Meaning | Mutates or launches? |
|---|---|---:|
| `rh` | One-shot operator home; interactive command prompt only on a TTY | No, until the user explicitly selects an action |
| `rh board ...` | Exact pass-through to the current board CLI | Whatever the named board command does |
| `rh dispatch` | Dispatch-specific status/home | No |
| `rh dispatch up` | Ensure the Herdr server and dispatch hero seat are healthy | Yes, only missing dispatch prerequisites |
| `rh dispatch day` | Full start-of-day composition | Yes, bounded by the day contract |
| `rh day` | Alias for `rh dispatch day` | Yes, bounded by the day contract |
| `rh cockpit` | Open or focus the Ralph cockpit against a healthy server | Yes, cockpit presentation only |
| `rh team EPIC` | Explicitly ensure one named epic team | Yes, exactly the named team |
| `rh fleet` | Current fleet/roster status | No |
| `rh inbox` | Current items requiring operator attention | No |
| `rh doctor` | Dependency, configuration, version, and reachability diagnosis | No |

`rh help`, `rh version`, and exact board pass-through are stable scriptable surfaces. Unknown commands fail with a concise suggestion and do not fall through to a shell or task runner.

Global `rh` options are parsed only before the command name. Once the router sees `board`, every remaining token belongs to the board CLI; for example, `rh board --color=always ...` passes that option through instead of treating it as an `rh` option.

## The Three Dispatch Levels

The verbs intentionally separate orientation from readiness from composition.

### `rh dispatch`

This is a read-only answer to “is dispatch up, and what needs attention?” It reads Herdr status, the dispatch heartbeat/seat, Ralph roster state, and actionable failures. It never starts Herdr, creates panes, opens the cockpit, launches or resumes a team, or mutates the board.

### `rh dispatch up`

This is the minimum idempotent ensure operation:

1. Probe `herdr status server --json`.
2. If the server is absent, run `herdr server` as a detached, supervised local process and wait a bounded time for a healthy status response.
3. Run the existing `plugin/ralph-herdr/scripts/dispatch-up.sh` contract to ensure the dispatch hero seat and roster.
4. Re-read status and report what landed.

It does not open the cockpit, walk or answer the inbox, start a team, resume a team, or arm a fleet.

### `rh dispatch day` / `rh day`

This is the explicit start-of-day composition:

1. Run a read-only preflight.
2. Ensure Herdr and dispatch using the same operation as `rh dispatch up`.
3. Run the existing scoped Ralph-Herdr reconciliation path.
4. Resume only teams that durable Ralph-Herdr evidence proves already existed.
5. Ensure each team named by a repeatable `--team EPIC` flag.
6. Open or focus the cockpit.
7. Render the inbox/home summary in the invoking terminal.

The command is retryable. Each completed phase is re-observed rather than blindly repeated.

`rh team EPIC` is the focused explicit form: it first performs the same prerequisite ensure as `rh dispatch up`, then delegates exactly that epic to `work-team.sh`. It does not open the cockpit, render the inbox, or infer sibling teams.

`rh cockpit` opens or focuses the cockpit only when the Herdr server is already healthy. It does not silently start dispatch; when the prerequisite is absent it points to `rh dispatch up` or `rh day`.

## The No-Default-Team Invariant

The most important safety rule is:

> `rh day` with no `--team` arguments must never create a team that did not already exist.

This must be true even when the board contains obvious epics, one item is the highest priority, the fleet is empty, the cockpit cache is stale, or the user normally runs the same team every morning.

The no-argument day path never calls a frontier picker, never enumerates open epics as launch candidates, and never converts “open” into “desired.” New team intent is accepted only from an explicit command:

```text
rh team 2208
rh day --team 2208 --team 2176
```

Repeated `--team` values are deduplicated before execution. Each named epic still passes through `work-team.sh` and all of its board, liveness, billing, role, and duplicate-start guards.

### What counts as a resume

A resume may re-establish a previously standing team lead or previously armed fleet only when existing Ralph-Herdr state proves prior human intent. Accepted evidence is closed and scoped:

- A current-session, current-repository ledger record for a valid `o<EPIC>-<slug>#<epoch>` orchestrator/team lead, with the recorded checkout still resolving to the same board scope; or
- Herdr's own persisted session restoration for an already-known workspace, pane, or agent, followed by successful scoped reconciliation; or
- An existing unexpired fleet intent that the current reconciliation contract already recognizes as armed.

The board alone is never resume evidence. An open epic, a matching title, a worktree directory, a cockpit card, or an agent-like process name is insufficient by itself.

Before a dead lead is resumed, the resolver must prove all of the following:

1. The ledger and checkout belong to the current canonical repository and Herdr session.
2. The recorded reference parses as a team lead for exactly one epic.
3. A fresh Herdr snapshot proves that no live lead for that epic is already standing.
4. A fresh board read proves the epic is still live and non-terminal.
5. No contradictory record makes desired state or ownership ambiguous.

The implementation delegates the actual re-establishment to the existing idempotent `work-team.sh EPIC --lead-only` path. It does not reproduce that script's spawn logic.

If any evidence is missing, unreadable, truncated, cross-scoped, or contradictory, no resume occurs. The day continues to cockpit and inbox if dispatch itself is healthy, prints an amber attention result, and exits nonzero after the summary.

Herdr's configured native session restoration is not overridden. If `resume_agents_on_restore` is disabled, `rh day` does not silently enable it.

## Board Compatibility Contract

`rh board` is a true execution pass-through, not a renderer or compatibility approximation:

```bash
exec "$resolved_board" "$@"
```

The implementation may resolve the board executable first, but after resolution it must not:

- Parse or reorder arguments.
- Capture, decorate, truncate, or recolor stdout or stderr.
- Change stdin or TTY attachment.
- Translate JSON.
- Change exit status or signals.
- Retry writes.
- Bypass the board scope gate, state machine, fresh reads, or claim read-back verification.

The existing `board ...` command remains available indefinitely because Herdr scripts, hooks, tests, automation, and operators already depend on it. `rh board` is a new doorway to the same engine, not a migration that removes the old one.

## Operator Home and Inbox

Naked `rh` is safe to type for orientation.

On a TTY it renders one bounded snapshot, followed by a tiny command prompt. Displaying the home performs no mutation. Choosing an action is an explicit second act and invokes the corresponding public command; the home does not call hidden recipes.

In a pipe, redirected shell, CI, or other non-TTY context, `rh` prints the same textual snapshot without a prompt and exits.

The initial home favors scanability over density:

```text
ralph hero  ralph-hero

● herdr       running             default session
● dispatch    ready               heartbeat 2m ago
◆ teams       2 standing          GH-2208  GH-2176
▲ inbox       3 need attention    1 blocked · 2 in review

INBOX
  BLOCKED     GH-2274  fleet status needs a driver
  REVIEW      GH-2260  cockpit
  REVIEW      GH-2269  herdr plugin action

[d] start day   [c] cockpit   [i] inbox   [f] fleet   [q] quit
```

The visual language follows the existing cockpit reference: dark-terminal assumptions, compact monospaced rows, one strong focus color, restrained semantic accents, and dim metadata. The command must remain fully legible on a light terminal and with color disabled; it does not draw a full-screen alternate TUI.

The inbox is an attention projection, not a new queue or database. It composes existing board/cockpit reads into a stable order:

1. Blocked or awaiting human answer.
2. In Review items with concluded checks or review attention.
3. Dispatch or fleet health warnings.
4. Remaining informative activity.

`rh inbox` never answers, moves, claims, closes, or launches anything. Its output names the explicit follow-up command.

## Color and Output

Color is semantic and light:

- Green: healthy, ready, running, or successfully ensured.
- Amber: degraded, stale, uncertain, or requiring attention.
- Red: blocked, failed, unavailable, or unsafe to continue.
- Cyan: available user actions and focused navigation.
- Dim/default: metadata and secondary context.

Every color has a glyph or word equivalent. Color never carries state by itself.

The public color control is:

```text
--color=auto|always|never
```

`auto` colors only the `rh`-owned human renderer when stdout is a capable TTY. `NO_COLOR` disables color when present and non-empty. Board pass-through, JSON from delegated commands, redirected output, and pipes are never colored or rewritten by `rh`.

The renderer uses terminal capabilities conservatively and no Unicode glyph is required for comprehension. A plain ASCII fallback is tested.

## Architecture

### One façade, separate engines

```text
~/.local/bin/rh                    stable resolver shim
        |
        v
ralph/scripts/rh                  command router and operator renderer
        |
        +--> ralph/scripts/resolve-board.sh --> board CLI
        |
        +--> Ralph-Herdr adapter -----------> existing Herdr scripts
        |
        +--> day orchestrator --------------> ordered, observed composition
```

The implementation belongs to the core `ralph` plugin because board and the read-only home remain useful when Ralph-Herdr is absent. Herdr commands resolve the installed `ralph-herdr` plugin at runtime and fail with a direct setup remedy if it is unavailable.

The implementation is split by responsibility:

- `ralph/scripts/rh`: Bash 3.2-compatible entrypoint, global flag parsing, routing, and exact board `exec`.
- `ralph/scripts/rh-lib/resolve.sh`: repository, board, Herdr binary, and installed Herdr plugin discovery.
- `ralph/scripts/rh-lib/render.sh`: text home, semantic status tokens, TTY prompt, and color policy.
- `ralph/scripts/rh-lib/day.sh`: dispatch/day phase orchestration and result aggregation.
- `ralph/scripts/install-rh.sh`: collision-safe installation of the stable resolver shim.
- `plugin/ralph-herdr/scripts/resume-teams.sh`: a narrow ledger-to-`work-team.sh` resume adapter; it accepts no board-derived candidates and launches nothing when evidence is ambiguous.

The library split keeps exact pass-through isolated from rendering and keeps resume authority beside the Herdr ledger it interprets.

### Resolution

The stable shim does not hardcode a user name or a versioned plugin cache path. It locates, in order:

1. An explicit development override intended for tests.
2. A Ralph checkout containing the expected entrypoint when invoked in-tree.
3. The currently registered or newest installed Ralph plugin using the same cache/registry conventions as existing Ralph resolvers.

The real entrypoint resolves the current repository from the invoking working directory with `git rev-parse --show-toplevel`, then validates the normal Ralph scope configuration. Help and version work outside a repository. Repository-bound commands fail clearly outside one rather than silently using the Ralph source checkout.

Board resolution reuses `ralph/scripts/resolve-board.sh`. Herdr resolution respects `HERDR_BIN_PATH`, session/socket environment, and the installed plugin contract already used by Ralph-Herdr.

### Installation

The supported installation target is `${XDG_BIN_HOME:-$HOME/.local/bin}/rh`, with a clear reminder when that directory is not on `PATH`.

Installation is idempotent when the target is a recognized Ralph Hero shim. An unrelated existing target is never overwritten automatically. The installer supports macOS, Linux, and WSL paths and writes no shell-specific profile changes by default.

A repository `Justfile` may provide convenience recipes such as `just rh-install` or `just day`, but every recipe must delegate to `rh`. `just` is never required to use the installed command and never owns command semantics.

### Process and failure handling

`rh dispatch up` starts a missing headless server in a detached local process with logs in Ralph-Herdr's state/log directory, then polls `herdr status server --json` with a bounded deadline. The exact background mechanism is platform-adapted, but the health contract is the same on macOS and Linux/WSL.

Day phases have explicit prerequisites. A failed server or dispatch phase prevents reconcile, team, cockpit, and inbox launch phases that depend on it. After dispatch is healthy, independent explicit team operations may continue after one team fails so the final summary can say exactly what landed. Cockpit and inbox may still open after a resume ambiguity because they are useful for recovery, but the overall exit is nonzero.

The final summary reports each phase as `ready`, `unchanged`, `resumed`, `started`, `skipped`, or `failed`. A zero exit means every requested phase is healthy or already satisfied. Any requested or safety-relevant phase that failed or was ambiguous yields a nonzero exit. `rh board` always preserves the delegated board exit code instead.

No implementation path uses `eval`, interpolates untrusted board text into shell commands, or guesses at a missing executable. Arguments are kept as quoted Bash arrays using the Bash 3.2-safe empty-array expansion pattern already documented in this repository.

## Verification Design

The command surface is not considered complete merely because its happy path works on one developer machine.

### 1. Router contract tests

Shell tests run `rh` against fake executables and assert:

- `rh board` preserves arguments byte-for-byte, stdin, stdout, stderr, JSON, signals, and exit codes.
- Naked `rh` and `rh dispatch` never invoke mutating fakes.
- `dispatch`, `dispatch up`, and `day` route to distinct operations.
- Unknown commands, help, version, missing dependencies, and outside-repository use are actionable.
- `--color` and `NO_COLOR` obey TTY, pipe, and exact-pass-through rules.
- Repository and plugin resolution work without user-specific absolute paths.
- Installer updates only its own shim and refuses a foreign `rh` collision.

### 2. Hermetic operator replay

Adopt the useful substrate from the `testing/testing-harness` worktree, not its proposed model-backed evaluator as a correctness dependency:

- `plugin/ralph-herdr/features/steps/world.ts` for per-scenario temp repositories, local origins, fixtures, logs, environment isolation, and credential scrubbing.
- `plugin/ralph-herdr/tests/fake-herdr.sh` as the protocol-valid Herdr world.
- `plugin/ralph-herdr/tests/fake-board.sh` as the board boundary.
- The existing Cucumber replay/live profile split in `cucumber.js`.

Add a focused `rh-command-surface.feature` covering:

1. Naked `rh` and naked `rh dispatch` perform zero mutations.
2. `rh dispatch up` starts only missing server/dispatch prerequisites.
3. Naked `rh day` starts zero new teams when no prior team evidence exists.
4. A ledger-proven dead team is resumed exactly once.
5. A live team is never duplicated.
6. Unreadable or ambiguous resume evidence launches nothing and is visible in the result.
7. Repeatable `--team` flags launch exactly the named teams and no others.
8. Cockpit and inbox occur only after dispatch is healthy.
9. A partial failure summary accurately distinguishes landed, unchanged, skipped, and failed phases.
10. Re-running the same day command is idempotent.

The replay suite uses no network, real Herdr server, real GitHub mutation, agent process, or billable model call.

The inspected testing-harness worktree currently contains a specification, not implementation. Its existing baseline remains valuable: `dispatch-up.test.sh` passes 44/44 assertions and `work-team.test.sh` passes 62/62 assertions. The new surface must preserve those contracts.

### 3. Platform matrix

Run the shell contract and replay suites under:

- macOS system Bash 3.2.
- A current Linux Bash in CI.
- ShellCheck at error severity for every changed Bash file.

An Ubuntu runner is not proof of WSL. Keep a short, honest WSL smoke checklist for PATH installation, repository discovery on the Linux filesystem and `/mnt/<drive>`, headless server startup, cockpit attach, `NO_COLOR`, and an `rh day` rerun. Automate it later only when a real WSL runner is available.

### 4. Opt-in live proof

The live profile uses the existing named `ralph-bdd` session convention and a disposable fixture repository. It verifies server start/status, dispatch seat creation, cockpit open/focus, and idempotent rerun without starting coding agents or consuming model billing. It is opt-in and never part of ordinary local replay.

Before completion, run the repository-required validations for the files actually changed, including the relevant Ralph-Herdr shell suites, ShellCheck, root TypeScript/tests/contracts/BDD checks where the command integration touches them, and cockpit Go checks if cockpit code changes.

## Research Precedents

The design deliberately borrows recognizable semantics rather than inventing a private vocabulary:

- [Docker Compose](https://docs.docker.com/reference/cli/docker/compose/) uses an explicit `up` verb for create/start, project discovery from the current directory, automatic/plain color modes, and a dry-run model. This supports keeping `dispatch` observational and `dispatch up` mutating.
- [Zellij attach and session resurrection](https://zellij.dev/documentation/session-resurrection.html) distinguishes attaching/resuming from creating and puts restored commands behind an extra confirmation unless explicitly forced. This reinforces “resume known state; do not surprise-create work.”
- [Zellij's command reference](https://zellij.dev/documentation/commands.html) only creates on attach when `--create` is explicit, and ignores the creation command when attaching to an existing session. That is the idempotent ensure shape used here.
- [`just`](https://just.systems/man/en/) is intentionally a project-specific command runner whose recipes can be invoked from subdirectories. It is a good repository convenience layer, but requiring it for the product CLI would add avoidable installation and discovery coupling.
- [mise tasks](https://mise.jdx.dev/tasks/) similarly excels at project-root-aware development tasks and dependency graphs. It is useful infrastructure around `rh`, not a replacement for the stable public command.
- The [`NO_COLOR` convention](https://no-color.org/) provides the expected shell-wide opt-out for ANSI color.
- [Herdr's CLI reference](https://herdr.dev/docs/cli-reference/) confirms `herdr server` as the explicit headless server verb, `herdr status` as the reachability surface, and deterministic JSON for automation. [Herdr concepts](https://herdr.dev/docs/concepts/) establish that the server owns persistent pane/process state while clients attach and detach.

## Acceptance Criteria

The design is implemented only when all of the following are true:

1. A user can install `rh` on PATH without editing a user-specific hardcoded path.
2. `rh`, `rh dispatch`, `rh dispatch up`, and `rh day` have observably different, documented effects.
3. `rh day` with no team flags cannot create a never-before-existing team in any replayed state.
4. A proven existing team can resume exactly once, while ambiguous evidence starts nothing.
5. `rh board ...` is behaviorally indistinguishable from invoking the resolved `board ...` directly.
6. Existing `board ...` callers continue to work.
7. Home, inbox, and status remain useful without color and in non-TTY output.
8. The surface passes the hermetic replay matrix and macOS Bash 3.2/Linux shell matrix.
9. The opt-in live proof can start the server, ensure dispatch, open the cockpit, and rerun idempotently without launching agents.
