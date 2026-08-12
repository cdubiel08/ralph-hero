# Ralph-Herdr Transport Hardening and Parallel Fleet Design

**Date:** 2026-08-11

**Status:** Approved in conversation; pending document review

**Issues:** GH-1774, GH-1775, GH-1776

**Base:** `feature/ralph-herdr-v2` at `d36dc5747db95399118fb2dfd5d382feef8e0fb3`

**Goal:** Make the Ralph-Herdr integration safe under multi-repository sessions and concurrent callbacks, then reduce reconciliation latency without weakening its fail-closed contracts.

## Requested Outcome

The requested work is an exhaustive, multi-axis hardening pass over the Ralph-Herdr feature. The result must:

1. Correct correctness, isolation, lifecycle, and race-condition defects before expanding concurrency.
2. Base transport behavior on the documented Herdr 0.8.0 contract rather than permissive test doubles or inferred behavior.
3. Remove unsafe or unnecessary complexity, especially shared-checkout issue fleets.
4. Make agent identity durable enough to survive delayed events, name reuse, and pane movement.
5. Bound remote calls and repeated computation so many workers can run without linear latency explosions.
6. Land as small, reviewable, rollback-friendly pull requests with explicit dependency edges.

The implementation should favor deletion, strict adapters, keyed joins, and idempotent reconciliation over more distributed state.

## Sources of Truth

This design reconciles the repository implementation with the installed `herdr 0.8.0` binary, protocol 19 / schema version 1, and these primary references:

- [Socket API](https://herdr.dev/docs/socket-api/)
- [CLI reference](https://herdr.dev/docs/cli-reference/)
- [Agent automation](https://herdr.dev/docs/agent-automation/)
- [Concepts](https://herdr.dev/docs/concepts/)
- [Agents](https://herdr.dev/docs/agents/)
- [Plugin contract](https://herdr.dev/docs/plugins/)
- [Herdr changelog](https://github.com/herdrdev/herdr/blob/master/CHANGELOG.md)

The installed API schema is the executable compatibility boundary. Documentation explains semantics; the installed schema decides the required fields and result discriminants accepted at runtime.

## Contract Findings That Change the Design

### Transport envelopes are discriminated and correlated

Herdr's local socket is an NDJSON protocol. Requests have `id`, `method`, and `params`. Successful responses correlate the same `id` and carry `result.type`; errors correlate the same `id` and carry `error.code` plus `error.message`. Events are separate `{event,data}` records.

A command exiting zero is therefore insufficient evidence of success. Missing IDs, mismatched IDs, error envelopes, wrong result types, missing required fields, trailing non-JSON output, and schema-incompatible payloads are transport failures. They must not be converted to empty lists or synthetic exits.

### Sessions are namespaces; agent lists are not repository-scoped

Socket selection is explicit `--session`, then `HERDR_SOCKET_PATH`, then `HERDR_SESSION`, then the default session. Named sessions are separate runtime namespaces. Within one session, `agent list` and `session.snapshot` include agents from all workspaces and repositories.

The integration must scope in two dimensions:

- **Session scope:** the resolved socket/session used for the operation.
- **Repository scope:** canonical GitHub host/owner/repository plus the matching snapshot workspace or worktree provenance.

Filtering only by issue number, agent name, current directory, or pane ID is not a containment boundary.

### Names and panes are transient

Agent names match `[a-z][a-z0-9_-]{0,31}` and are unique only among live agents in a session. A name becomes reusable after exit, release, or replacement. Pane IDs are opaque server-local identifiers and can change when a pane moves.

Names remain useful live aliases, but neither a name nor a pane ID is a durable primary key. Delayed events must not attach to a later worker that reused the same alias.

### Startup can race callbacks

`agent start` waits until Herdr detects the expected agent and it becomes ready. Status events may therefore arrive before the start command returns. Recording a worker only after `agent start` creates an event-before-ledger window.

The durable spawn intent and epoch must exist before any Herdr mutation. Responses then bind transport identifiers onto that reserved identity.

### Prompt waiting is lifecycle waiting

`agent prompt` atomically submits a prompt plus Enter, but `--wait` observes agent lifecycle rather than a uniquely identified turn. If an agent was already working, completion of the earlier turn can satisfy the wait. A settled `done` state is distinct from `unknown`; unknown is not successful completion.

The integration must serialize dispatch per worker, avoid treating `--wait` as a turn receipt, and reconcile the observed state after prompting.

### Events are hints, not a durable log

The plugin contract supplies event metadata, including `HERDR_PLUGIN_EVENT` and event JSON, but documents no durable ordering, replay cursor, deduplication key, exactly-once delivery, or transaction spanning snapshots and events. Status events also omit the durable custom identity required by Ralph.

Event hooks may mark a session or repository dirty and trigger reconciliation. They may not directly mutate durable lifecycle state from the event payload alone.

### Environment injection is topology-specific

`workspace create` and `pane split` support environment injection. `worktree create` and `agent start` do not. Claim identity cannot be fixed by adding an unsupported `--env` argument.

The existing shell pane must receive a tightly validated export command before startup. The new agent inherits those values when `agent start` launches it.

### Plugin commands do not inherit the caller repository implicitly

Plugin commands execute from the plugin directory. Action context can provide workspace and focused-pane metadata, but scripts must capture and validate explicit repository context once. `$PWD` inside a plugin script is not authoritative repository identity.

## Architectural Decisions

### 1. One strict transport adapter

All shell actions, hooks, reconciliation, and cockpit reads go through one adapter. The adapter owns:

- Session/socket resolution and a stable `session_key` derived from the resolved socket path.
- Invocation through the documented `HERDR_BIN_PATH` when supplied.
- Minimum Herdr version plus protocol/schema capability validation before dependent operations.
- Invocation with an explicit timeout and captured stdout, stderr, and exit status.
- Exactly-one-envelope JSON parsing.
- Request/response ID correlation where an API request ID is available.
- Error-envelope rejection.
- Method-specific `result.type` validation.
- Required field and array validation for the subset Ralph consumes.
- Additive compatibility: unknown fields are ignored after required known fields validate.
- Structured errors that retain operation and scope without reflecting unsanitized terminal content.

The adapter never maps malformed success output to `[]`, `{}`, `done`, or `exited`. A caller must choose an explicit unavailable/unknown branch and fail closed for mutations.

### 2. Snapshot-first scoped reconciliation

Each reconciliation cycle obtains one `session.snapshot`, then constructs indexed joins:

```text
agent.workspace_id
  -> workspace.id
  -> workspace.worktree.repo_root / workspace.worktree.checkout_path, when present
  -> agent.pane_id -> pane.cwd plus agent.cwd / agent.foreground_cwd, otherwise
  -> canonical repository scope
```

Agents outside the target repository scope are invisible to that repository's Ralph operations. Snapshot worktree provenance outranks runtime working directories. Protocol-19 `WorkspaceInfo` does not expose a general `cwd`, so root workspaces without worktree provenance are resolved through the matching pane/agent paths, anchored to the action's captured `workspace_id` and `workspace_cwd`, and verified by `git rev-parse --show-toplevel` against the already-resolved board repository root. A global event with no prior ledger binding and no unambiguous worktree or Git-root match is not adopted. Ambiguity fails closed.

Events only request a fresh reconciliation. A reconnect, stale cache, malformed event, or suspected pane movement also forces a snapshot refresh.

### 3. Durable identity plus replaceable live bindings

The ledger's durable identity is:

```text
(session_key, repo_scope, agent_ref)
```

Where:

- `session_key` hashes the normalized resolved socket path.
- `repo_scope` is canonical `host/owner/repository` from Ralph board configuration.
- `agent_ref` is a plugin-minted cryptographically strong random value of at least 128 bits.

Each epoch binds current live observations:

```text
issue_number
agent_name
workspace_id
pane_id
native_agent_session, when present
worktree_path
branch
spawn_state
```

The live name includes stable repository- and session-scope fragments while retaining the issue grammar, for example `w1774-r1a2b-s3c4d-fix`. This avoids cross-repository collisions inside one Herdr session and gives the globally visible board claim a session-distinct holder. It is still an alias, not the durable identity. The human slug is truncated before either scope fragment.

The epoch becomes observable through required Ralph-owned pane metadata. Immediately after a validated start response, the adapter reports `ralph_agent_ref=<agent-ref>` on the exact returned pane under the Ralph plugin source and reads it back through a fresh scoped snapshot. This identity token is a correctness binding, unlike existing best-effort decorative tokens; failure to write or observe it prevents activation and prompting. Sequence numbers prevent an older metadata write from replacing a newer binding.

During the start-before-token interval, callbacks may only observe the reserved epoch; they cannot complete, release, or rebind it. The validated start response's pane/workspace tuple binds that provisional interval. After activation, lifecycle mutation requires the snapshot's `ralph_agent_ref` to equal the ledger epoch. The board claim stores the scoped live name, while exact claim release additionally resolves that holder to the matching metadata epoch and checks the caller's `RALPH_HERDR_AGENT_REF`.

After pane movement, reconciliation may rebind a live epoch by the Ralph identity token, repository workspace, session-scoped unique name, and native agent session when available. A matching durable token is required for automatic rebinding; name alone is only a legacy diagnostic fallback. If observations conflict, Ralph records `unknown` and refuses mutation instead of guessing.

### 4. Reserve before external mutation

Spawn is a state machine:

1. Resolve action context, repository scope, session key, issue, worktree, name, and random agent reference.
2. Acquire the short-lived ledger lock.
3. Reject an existing reserved or active epoch for the same scoped issue.
4. Append and atomically persist `spawn_intent`.
5. Release the lock.
6. Claim the board issue as the generated scoped agent name and require the board command's normal read-back verification to confirm that exact holder. A claim conflict terminates the local intent before any Herdr topology is created.

   **Origin provenance is inherited, not re-implemented.** Resolving `repo_scope` and a Git root proves only that a directory *claims* an identity; it does not prove the checkout points at the configured remote. That proof already exists one layer down: `board.ts` runs a scope gate before **any** mutating command — `git remote get-url origin` compared against the configured `host/owner/repo` via `scopeMatches` (host, owner and repo all case-insensitively, with `.git` and trailing slashes normalised), and it refuses rather than warns. `doctor --fix` is explicitly inside that gate; only plain reads are carved out. Archived items are likewise rejected at every write path.

   The spawn step above claims *through that CLI*, so it inherits both guarantees by construction. The design therefore adds no second provenance check: a parallel implementation here would be a weaker copy that can drift from the one that actually guards the mutation, and the failure mode of a drifted guard is worse than having only one.

   The honest residual, which step 7 covers rather than this step: the scope gate proves the *invoking checkout's* origin matches the board. It does not prove the Herdr worktree the agent will run in is that same checkout. That binding is exactly what step 7's response-provenance validation establishes, which is why the order matters — claim first (cheap, reversible, and gated), create topology second (expensive), validate its provenance before anything is bound to it.
7. Create/open topology and strictly validate the response and repository provenance.
8. Append a provisional binding for workspace and pane.
9. Submit a shell export containing only generated, grammar-validated values:
   - `RALPH_CLAIM_HOLDER=<scoped-agent-name>`
   - `RALPH_HERDR_AGENT_REF=<agent-ref>`
   - repository/session scope values required for read-back validation
10. Start the agent and validate returned name, pane, workspace, and result type.
11. Publish the Ralph identity metadata token to that exact pane and verify it in a new scoped snapshot.
12. Reacquire the lock and compare the expected `agent_ref`, ledger revision, and provisional state before appending `active`.
13. Prompt the agent. A prompt failure records `dispatch_failed` but does not erase a live worker.
14. Every failure path appends a terminal or recoverable failure record; it never silently deletes the reservation. If failure occurred after the verified board claim but before a live worker exists, release the issue through the normal board transition with the same holder and a durable reason.

The export command never interpolates issue titles, paths, prompt text, or other untrusted values. Values use a strict alphanumeric/underscore/hyphen grammar and shell-safe quoting.

### 5. Reconciliation owns lifecycle truth

Callbacks do not advance ledger state directly. Reconciliation compares a fenced scoped snapshot to ledger epochs and applies idempotent transitions under a short lock. Repeating the same snapshot produces no new semantic transition.

Snapshot acquisition uses a ledger revision fence:

1. Under the lock, record the current monotonic ledger revision and the set of epochs eligible for observation.
2. Release the lock before requesting the external snapshot.
3. Reacquire the lock and reload the ledger.
4. Apply observations only to epochs at or before the captured revision. Intents or bindings appended after the fence are invisible to that snapshot.
5. Every transition compare-checks the same `agent_ref`, expected prior state, and record revision before append.
6. A reserved/starting epoch is never declared absent during its startup grace window. Destructive absence requires consecutive valid scoped snapshots across a bounded grace period, not one response.

This prevents a snapshot captured before a concurrent spawn from closing the new epoch and prevents a delayed start/prompt process from activating an epoch that was replaced or canceled.

Lifecycle rules include:

- Every listed status is a live occupant for duplicate/name-collision checks until the occupant exits or is released.
- `working` and `blocked` consume productive capacity and do not prove completion.
- `idle` consumes capacity while an epoch is reserved, starting, dispatched, or otherwise unsettled. It does not prove completion.
- `done` is a wake signal, not a Ralph completion receipt. It frees productive capacity only after a contract-valid completion/escalation record or authoritative board transition settles that exact epoch; otherwise it remains an unsettled capacity consumer.
- `unknown` is uncertainty, never success; it conservatively consumes capacity and prevents destructive cleanup until resolved or explicitly escalated.
- An absent agent is not immediately `exited` after malformed transport, reconnect, or an incomplete snapshot.
- Delayed events for a terminal epoch cannot mutate a newer epoch with the same name.
- Completion and claim release require exact epoch ownership.

| Herdr observation | Live occupant | Consumes capacity | Proves Ralph completion | Automatic cleanup |
|---|---:|---:|---:|---:|
| `working` | yes | yes | no | no |
| `blocked` | yes | yes | no | no |
| `idle` | yes | yes while unsettled | no | no |
| `done` | yes | yes until exact settlement; then no | no | only after exact settlement policy |
| `unknown` | yes/uncertain | yes | no | no |
| absent from fenced valid snapshots | no after grace | no after terminalization | no | only after exact epoch terminalization |

### 6. Coalesced event-driven recovery

Events set a dirty generation for the relevant session/repository and attempt to start a singleflight reconciler. They do not launch one unbounded snapshot per callback.

**Dirtiness is per repository; the snapshot is per session.** These are deliberately different keys, and an earlier draft conflated them — keying the singleflight by session/repository while the performance contract below demands one Herdr snapshot per *session* per refresh. Those cannot both hold: two repositories sharing a session would each acquire their own snapshot and the call-count test would fail exactly when containment matters most.

The resolution follows the shape of the data. A `session.snapshot` is a property of the **session** — one request returns every workspace, tab, pane and agent in it, including all repositories. So:

- **Snapshot acquisition is keyed by `session_key`.** At most one snapshot request is in flight per session. Repositories do not each ask.
- **The result fans out.** One acquired snapshot is handed to every repository whose dirty generation is set, and each applies its own scoped join (§2) to it. Scoping is a read over an already-fetched structure, not a reason to re-fetch.
- **Reconciliation remains keyed by session/repository.** Two repositories reconcile independently against the same snapshot, under their own ledger locks and their own revision fences. That independence is the point of §5 and is unaffected.

A repository marked dirty while a session snapshot is already in flight is served by that same request if it has not yet been captured, and otherwise earns the one follow-up pass described below — the same rule, applied at the session level.

- A short bounded debounce coalesces bursts.
- At most one reconciliation is in flight per session/repository scope, and at most one snapshot request per session.
- The runner clears only the dirty generation it observed. Events arriving during the request cause at most one immediate follow-up pass.
- A minimum refresh interval and bounded backoff protect a failing Herdr server; a maximum coalescing delay prevents starvation.
- Plugin startup, successful spawn/prompt mutations, periodic health checks, and an explicit manual reconcile recover state if an event is lost.
- Event-storm tests assert bounded snapshot calls; lost-event tests assert startup/periodic/manual recovery.

### 7. Owner-token local locking

The file lock becomes an atomic-directory owner-token lock:

- Acquisition creates a lock directory and writes owner PID, random token, and creation time.
- A contender never removes a lock whose owner is alive.
- A **proven-dead** lock is atomically renamed to a unique tombstone before cleanup, preventing two contenders from stealing the same lock.

**Expiry alone never breaks a lock.** An earlier draft said both "a contender never removes a live owner's lock" and "a dead *or expired* lock may be recovered", which contradict each other: age is not evidence of death. A paused, swapped-out or simply slow owner is still inside the critical section when its lock turns old, and recovering on age alone puts a second writer into the ledger beside it.

Breaking a lock therefore requires **positive evidence the owner is gone**, not the absence of evidence that it lives:

- The owner is a local PID, so liveness is directly observable: `kill -0` distinguishes a live process from a dead one, which is a stronger primitive than anything available for a distributed claim.
- PID reuse is the one hole in that check, and the stored creation time closes it: a live PID whose start time postdates the lock's creation is a *different* process that inherited the number, not our owner.
- Only when the owner is proven dead does the tombstone rename run. The rename is what makes the break itself atomic, so two contenders that both observe the same dead owner cannot both win.

**This is the claim protocol's reasoning, not a second protocol.** `board.ts` faces the same question for board claims and answers it the same way: a TTL makes staleness *visible*, but the only sanctioned side door is expiry plus read-back confirming who actually won — and there is deliberately no `--force` anywhere. The local lock differs in one respect only, and it differs in the safe direction: locally we can *prove* death with `kill -0`, where the board can only infer it from a TTL. So the local rule is strictly stricter than the distributed one it mirrors.

What remains honestly unsolved is the owner that is alive but wedged. Neither TTL nor liveness helps there; the lock is held and the pass does not progress. That is a surfacing problem, not a locking one — doctor reports a lock held far beyond its expected lifetime, and a human decides. Inventing an automatic break for that case would reintroduce exactly the theft this section forbids.

Tests must cover process suspension (`SIGSTOP` — old lock, live owner, must not break), a slow owner crossing the expiry boundary mid-section, PID reuse after death, and two contenders racing one genuinely dead owner.
- Unlock succeeds only when the stored token matches the caller's token.
- Lock acquisition has a bounded timeout and fails closed.
- Network calls, Herdr commands, board calls, sleeps, prompts, and notifications occur outside the critical section.
- Ledger replacement writes a complete file in the same directory and atomically renames it into place.
- A truncated final record is quarantined or explicitly diagnosed; it does not poison every subsequent read indefinitely.

The lock protects only local state. GitHub claim read-back remains the distributed conflict detector because Projects V2 has no compare-and-swap.

### 8. Delete shared-checkout issue fleets

Multiple agents operating in one worktree share branch, index, uncommitted files, and cleanup side effects. ClaimV2 does not make that filesystem safe. The `work-issue-fleet` action is removed or hard-disabled with a migration message.

New writes use one holder per issue. Multi-holder claim creation and leave/join orchestration are removed from the Ralph-Herdr path. Readers and doctor checks may temporarily recognize ClaimV2 only to report and clean already-written state. Parallelism comes from independent board issues and independent worktrees.

### 9. Sanitize every terminal-derived display value

Agent names, statuses, titles, foreground commands, errors, and terminal output are untrusted display data. Before logs or TUI rendering, control characters and terminal escape sequences are stripped or visibly escaped. Structured fields remain separate from human-readable messages.

## Performance Design

Correct scoping precedes optimization. Once the transport foundation is in place, a refresh cycle becomes:

1. Start one board-list request and one Herdr snapshot request concurrently because they are independent.
2. Partition the board response locally by state and issue number.
3. Index workspaces, agents, ledger epochs, claims, and issues once.
4. Join maps in linear time rather than repeatedly scanning arrays.
5. Fetch issue comments only for items requiring history, through a bounded worker pool.
6. Preserve deterministic output ordering after concurrent fetches.
7. Memoize dependency/ranking graphs for the immutable board snapshot.
8. Cache stable capability/schema checks per binary version and session, invalidating on version or socket change.

The performance contract is expressed through call-count tests, not only elapsed time:

- One board list per refresh.
- One Herdr snapshot per session per refresh.
- Zero per-agent Herdr list/get calls in the normal reconciliation path.
- Comment concurrency capped at a documented small constant.
- Remote call counts do not grow merely because the number of visible agents grows.

Timing tests use generous regression budgets and report measurements; deterministic call-count assertions are the hard gate.

## Contract Hardening

Protocol-valid fixtures must include response IDs, result discriminants, required arrays, and realistic workspace-to-agent joins. Fakes may not accept impossible combinations that the installed schema rejects.

Generated Ralph contract schemas and lints are strengthened for:

- Scoped agent identity and non-empty durable `agent_ref`.
- Explicit lifecycle state rather than overloaded optional fields.
- Claim holder equality to the bound live worker.
- TTL and timestamp bounds.
- Lineage depth and closure.
- Typed frontier and queue shapes.
- Repository/session scope presence on mutations.
- Runtime validation at producer and consumer boundaries.

Schema generation remains drift-checked in CI. Human-readable reference files are generated from or checked against the same source rather than maintained as a second behavioral contract.

## Pull Request Structure

The selected structure is a shared foundation with two sibling follow-ups:

```text
feature/ralph-herdr-v2
  -> feature/GH-1774  transport boundary + containment
       -> feature/GH-1776  identity + lifecycle + claims + locking
       -> feature/GH-1775  snapshots + performance + contracts
```

### PR 1 — GH-1774: Transport boundary and containment

Includes:

- Strict protocol-19 transport adapter.
- Explicit action/event context and session/repository scoping.
- Snapshot join primitives shared by later PRs.
- Event-as-hint behavior.
- Terminal sanitization.
- Removal or hard-disablement of shared-checkout issue fleets.
- Protocol-valid and adversarial transport fixtures.

This PR targets `feature/ralph-herdr-v2`.

### PR 2 — GH-1776: Identity, lifecycle, claims, and locking

Includes:

- Durable agent references and repository-scoped live names.
- Reserve-before-start spawn state machine.
- Fenced pre-start shell export for claim identity.
- Exact epoch claim/release and lifecycle reconciliation.
- Owner-token locks, atomic ledger writes, and corrupt-tail recovery.
- Refill arming/capacity fixes and deterministic concurrency tests.
- Live BDD session ownership correction.

This PR initially targets `feature/GH-1774`.

### PR 3 — GH-1775: Snapshots, performance, and contracts

Includes:

- One board snapshot and one scoped Herdr snapshot per cycle.
- Keyed joins, bounded comment concurrency, and ranking memoization.
- Capability caching with explicit invalidation.
- Contract schema/lint strengthening.
- Call-count, timing, race, and adversarial tests.

This PR initially targets `feature/GH-1774` and is independent of GH-1776. After GH-1774 merges, both sibling PRs are retargeted to `feature/ralph-herdr-v2`.

## Testing Strategy

Every behavioral change follows red-green-refactor. Tests include:

### Transport and containment

- Correct success and error envelopes.
- Exit-zero malformed JSON.
- Mismatched response ID.
- Wrong or missing `result.type`.
- Additive unknown fields.
- Missing required arrays or join fields.
- Multiple repositories in one Herdr session.
- Root workspaces with no `WorkspaceInfo.worktree`, resolved through pane/agent paths and verified Git roots.
- Null names and incomplete provenance.
- Moved pane and reused agent name.
- ANSI, OSC, C0, and newline injection in display data.

### Concurrency and lifecycle

- Two simultaneous spawn attempts for one scoped issue.
- Event arrival before `agent start` returns.
- Identity-token write/read-back failure and a reused name with a different token.
- Duplicate and out-of-order event hints.
- Snapshot captured before a concurrent ledger append.
- Start activation racing cancellation or epoch replacement.
- Event storms coalesced to one in-flight plus one follow-up snapshot.
- Lost events recovered by startup, periodic, and manual reconciliation.
- Process death while holding the lock.
- Old owner attempting to unlock a replacement lock.
- Failure between intent, topology, start, activation, and prompt.
- Concurrent refill callbacks.
- Truncated final ledger record.
- `idle`, `working`, `blocked`, `done`, `unknown`, and absent-worker capacity cases.

### Performance and contracts

- Fixed board/Herdr call counts at 1, 10, and 100 workers.
- Bounded comment concurrency and deterministic ordering.
- Linear keyed-join behavior.
- Contract artifact drift.
- Producer/consumer runtime rejection of malformed identity and lifecycle data.
- Repeated race-enabled Go tests and shell stress loops.

Verification includes the focused suites for each commit, the complete board, contract, shell, BDD/chaos, Go, race-detector, vet, TypeScript, shell-syntax, and diff-check suites before publishing.

Live BDD runs only against an explicitly owned disposable named Herdr session. Cleanup verifies the session identity and never stops a pre-existing/default session.

## Migration and Compatibility

- The manifest continues to require Herdr 0.8.0 or newer.
- The adapter tolerates additive fields while enforcing protocol 19 required fields and discriminants.
- Existing ledger records are read through a versioned migration layer; new records use the scoped identity version.
- Existing ClaimV2 values are diagnostic/migration inputs only. New shared claims are not created.
- A legacy worker that cannot prove repository/session scope is surfaced as unbound and is not mutated automatically.
- Removing `work-issue-fleet` is an intentional safety break. The replacement is issue decomposition plus one worktree per issue.

## Non-Goals

- No attempt to make multiple agents safely edit one Git worktree.
- No new remote coordinator, database, or event broker.
- No assumption of exactly-once or ordered Herdr callbacks.
- No broad rewrite of the Ralph board state machine.
- No automatic merge of the three PRs.
- No performance shortcut that converts unknown transport or identity state into success.

## Known Contract Limits

Herdr does not document a durable server-incarnation UUID, an event replay cursor, or an agent-start environment option. The design therefore combines the resolved socket path with a random agent epoch, uses snapshots for reconciliation, and injects environment through the pre-existing shell pane. If a future Herdr release adds stronger primitives, the adapter can adopt them without changing Ralph's durable ledger contract.

The public plugin documentation describes plugin installation/enabled state as user-global, but does not explicitly guarantee state-directory sharing semantics across named sessions. Cross-session locking remains conservative defense; no correctness claim depends on undocumented state sharing.

## Acceptance Criteria

The three-PR program is complete when:

1. No unscoped or malformed Herdr response can cause a board, claim, ledger, or worker mutation.
2. Two repositories sharing a Herdr session cannot observe or control each other's Ralph workers.
3. Concurrent spawn/refill/event schedules preserve one active epoch per scoped issue.
4. Agent claims resolve to an observable matching Ralph epoch token, and delayed events cannot attach to reused names.
5. Shared-checkout fleet execution is unavailable.
6. Refresh performs one board list and one Herdr snapshot per session, with bounded secondary I/O.
7. Protocol fixtures match the installed Herdr 0.8.0 schema and contract drift fails CI.
8. Full verification, including race/stress suites, passes on every PR at its intended base.
