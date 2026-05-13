---
date: 2026-05-12
status: draft
type: plan
github_issue: 1191
github_issues: [1191]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1191
primary_issue: 1191
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, telemetry, mcp-tool, cli, jsonl, log-rotation]
---

# F5 — Delegation Telemetry & Cost Tracking — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: F1 audit log producer at `plugin/ralph-hero/scripts/ralph-delegate.sh` (issue #1185, merged)
- builds_on:: [[2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop]] — `RALPH_LLM_URL` precedent
- references:: `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` — schema-versioned JSONL reader pattern
- references:: `plugin/ralph-hero/mcp-server/src/lib/activity.ts` — pure JSONL reader with shape validation
- references:: `plugin/ralph-hero/scripts/activity/logrotate.sh` — log-rotation precedent (date-partitioned)

## Overview

Single-issue plan with one implementation phase (F5 from the epic). Adds a delegation-stats MCP tool, a CLI `delegation` subcommand, and minimal size-based rotation for `~/.ralph-hero/delegate.log`. Reads the JSONL audit log produced by F1 (`ralph-delegate.sh`), aggregates by task and outcome, and exposes stable JSON via a new MCP tool + a small dashboard via the quick-mode CLI.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1191 | F5 — Delegation telemetry & cost tracking | S |

## Shared Constraints

Inherited from parent plan-of-plans `2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`:

- **No-regression invariant**: with `RALPH_DELEGATE_ENABLED` unset (the default), ralph-hero must behave bit-identically to today. F5 reads the log; it never writes it. Missing/empty/absent log file MUST resolve to zeros without error.
- **Reuse `RALPH_DELEGATE_LOG_PATH`** env var (default `~/.ralph-hero/delegate.log`) — do not fork the namespace.
- **Reuse existing patterns**: `register*Tools()` for MCP tools, `cli-dispatch.sh:run_quick` for the CLI subcommand, schema-versioned JSONL reader (model after `snapshots.ts` / `activity.ts`).
- **Skip lines without recognized schema** with a `console.warn` (per issue acceptance + `snapshots.ts` precedent).
- **Pure read library**: filesystem reads only, no cursor state in the MCP server (per `activity.ts` precedent).

Feature-specific additions:

- **Log rotation choice**: F5 implements minimal size-based rotation (rotate to `delegate.log.1` when size exceeds threshold, keep N rotated files). The epic plan called for either a logrotate-stanza-in-README OR minimal rotation; we pick minimal rotation since the activity log already established a rotation-script convention, and operators expect a single-binary "it just works" surface. The audit log is single-file (not date-partitioned), so we cannot reuse `scripts/activity/logrotate.sh` verbatim — but we mirror its structure (env-driven threshold, dry-run flag, optional launchd template).
- **`schemaVersion` field**: The current `delegate.log` lines (written by F1) do NOT include a `schemaVersion` field — F1's JSONL line shape is `{ts, task, model, url, ms, status, bytes_in, bytes_out, caller}`. F5 treats this implicit shape as **version 1**: lines that parse to JSON AND contain all of `{ts, task, status, ms}` are accepted as v1. A future explicit `schemaVersion` field (>=2) MAY be added by a follow-up issue; until then the reader uses presence-of-required-fields as the schema check. This is documented in the library and called out as a TODO comment.

## Current State Analysis

**F1 (#1185, merged)** wired `plugin/ralph-hero/scripts/ralph-delegate.sh` to emit one JSONL line per delegation attempt at `RALPH_DELEGATE_LOG_PATH` (default `~/.ralph-hero/delegate.log`). Line shape (from `_audit_log` in `ralph-delegate.sh:109-128`):

```json
{"ts":"2026-05-03T12:34:56Z","task":"locator","model":"mlx-community/gemma-4-26b-a4b-it-mxfp8","url":"http://localhost:8000","ms":284,"status":"ok","bytes_in":1340,"bytes_out":612,"caller":"<skill>"}
```

`status` is one of: `ok`, `timeout`, `unreachable`, `parse_error`, `http_<code>`, `dry_run`.

**No reader exists today.** No MCP tool, no CLI subcommand, no rotation. The log will grow unbounded until F5 lands.

**Existing patterns to mirror:**

- `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` — schema-versioned JSONL reader with `__set<Module>Root` test hook, `safeReadFile`/per-line `console.warn` on parse failure, shape-validation function.
- `plugin/ralph-hero/mcp-server/src/lib/activity.ts` — pure read library; no cursor state in server; reads via fs.readFileSync; returns events + `skipped_lines`.
- `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` — minimal `register*Tools()` wrapper; resolves default root via env var with `os.homedir()` fallback.
- `plugin/ralph-hero/scripts/activity/logrotate.sh` — bash rotate script with `--dry-run`, env vars (`RALPH_<X>_RETENTION_DAYS`), portable macOS+GNU date math.
- `plugin/ralph-hero/justfile:208-216` (`status` recipe) — `dispatch` with `DEFAULT_MODE=quick QUICK_TOOL=<tool> QUICK_PARAMS=<json>`. Args pass through so we can extend `ralph status` with `--delegation`.

**MCP server registration**: `plugin/ralph-hero/mcp-server/src/index.ts:540-543` shows the wiring pattern — `registerActivityTools(server)` and `registerTrendsTools(server, client, fieldCache)`. Our new tool only needs the `server` parameter (no GitHub client).

**No-op when delegation disabled**: When the log file does not exist (most users until they opt in), the reader must return zero-counts without throwing. F1 already writes nothing when `RALPH_DELEGATE_ENABLED` is unset (exit 126, no audit line) — so absent-file is the steady state for non-opted-in users.

## Desired End State

After this phase lands:

1. New MCP tool `ralph_hero__delegation_stats` returns stable JSON: per-task call counts, per-task fallback counts, per-task p50/p99 latency, total tokens (when `usage` is present in adjacent lines — see "Tokens" decision below), total `skipped_lines`, and a top-level `logPath` echo.
2. New CLI surface: `ralph status --delegation` runs the tool via `run_quick` and prints a small dashboard. Existing `ralph status` (no flag) behavior is unchanged.
3. Missing log file → tool returns all zeros + empty `byTask` map + `logPath`, no error.
4. Lines that fail the shape check are counted in `skipped_lines` and logged via `console.warn` (consistent with `snapshots.ts`).
5. New bash script `plugin/ralph-hero/scripts/delegate/logrotate.sh` rotates `delegate.log` when size > threshold, retains N rotated files. Optional launchd template under `scripts/delegate/launchd/`.
6. Vitest suite covers the library and the tool — using `__setDelegateLogPath()` test hook to point at a tmpfile.
7. Bats suite covers the rotation script — present + absent log, rotation triggered + not, dry-run.

### Verification

- [ ] `npm test` passes in `plugin/ralph-hero/mcp-server/` (vitest + coverage).
- [ ] `npm run build` succeeds (tsc).
- [ ] `bats plugin/ralph-hero/scripts/__tests__` passes (bats suite remains green).
- [ ] Manual: `ralph status --delegation` prints a zero-state dashboard on a fresh machine (no log file).
- [ ] Manual: After seeding a fixture log, `ralph status --delegation` shows non-zero counts and a sensible p50.

### Tokens decision

The issue text mentions "total tokens (if endpoint returns `.usage` in response)" but F1's audit-log shape (per `ralph-delegate.sh:109-128`) does NOT capture `usage.prompt_tokens`/`completion_tokens`. F1's `_audit_log` writes `bytes_in`/`bytes_out` only.

**Decision**: F5 reports `bytes_in` / `bytes_out` aggregates (per-task sums and totals) under field names `bytesIn` / `bytesOut`. The `tokens` field is reported as `null` per task with a top-level note `"tokensReason": "F1 audit-log does not capture token usage; bytes used as a proxy"`. A follow-up issue can extend F1 to capture `.usage` from the OpenAI-compat response; F5's reader will detect that field when present (forward-compatible).

This avoids fabricating token counts from `bytes_*` while keeping the field surface stable for forward compatibility.

## What We're NOT Doing

- Not delegating from F5 itself. F5 is a reader-only feature; it does not call `ralph-delegate.sh` from any of its code paths.
- Not changing F1's JSONL line shape. Backward-compat is preserved; we read what F1 already writes.
- Not adding a per-skill telemetry UI (per issue's Out-of-Scope section).
- Not computing dollar-cost estimates (per issue's Out-of-Scope section). `bytes_*` aggregates only; `tokens` and `costUsd` are reserved fields, reported `null`.
- Not embedding delegation stats inside `ralph_hero__pipeline_dashboard`. The issue text says "optional" for that integration — we defer it to a follow-up if it proves valuable, to keep this phase scoped.
- Not adding a daemon/launchd by default. Rotation runs on operator invocation; the launchd template is provided but not auto-installed.
- Not introducing `RALPH_DELEGATE_LOG_RETENTION_BYTES` settings file flow — the env var alone is enough (operators who want it can `export` it before invoking the rotation script).
- Not migrating existing log lines to add `schemaVersion`. The reader treats absence-of-`schemaVersion` as v1 implicitly.

## Implementation Approach

Single phase (Phase 1) because the issue itself is atomic-S — library + tool + CLI wiring + rotation script in one PR. The internal task ordering is sequential because each task builds on the previous one (library first, then tool that imports it, then CLI that calls the tool, then rotation script which is independent but related).

A separate phase boundary would split a single coherent surface (delegation telemetry) across PRs for no benefit. The dispatchability checklist below confirms each task can be individually dispatched to a sub-agent.

**Phase dependency annotations**:

- Phase 1: `depends_on: null` — F1 audit-log producer (#1185) is already merged.

---

## Phase 1: F5 — Delegation telemetry & cost tracking (GH-1191)

- **depends_on**: null

### Overview

Adds the delegation-stats MCP tool, the `ralph status --delegation` CLI surface, and the size-based log-rotation script. Self-contained: reads `delegate.log`, writes nothing except the rotated archive when rotation is invoked.

### Tasks

#### Task 1.1: Create the pure JSONL reader library

- **files**: `plugin/ralph-hero/mcp-server/src/lib/delegation-log.ts` (create), `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` (read), `plugin/ralph-hero/mcp-server/src/lib/activity.ts` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Exports `readDelegationLog(config: DelegationReadConfig): DelegationReadResult` — pure function, no cursor state, mirrors `activity.ts`'s shape.
  - [ ] Exports `aggregateDelegationStats(events: DelegationEvent[]): DelegationStats` — pure aggregation: groups by `task`, computes per-task `calls`, `fallbacks` (count of non-`ok` and non-`dry_run` statuses), `p50Ms` / `p99Ms` from successful calls only, `bytesIn` / `bytesOut` sums.
  - [ ] Exports `__setDelegateLogPath(path: string | null): void` test hook (mirrors `__setSnapshotRoot`).
  - [ ] Exports `defaultDelegationLogPath(): string` resolving `RALPH_DELEGATE_LOG_PATH` env var with `~/.ralph-hero/delegate.log` fallback. Expands leading `~/` (mirrors `ralph-delegate.sh:208-211`).
  - [ ] Returns `{events: [], skippedLines: 0, logPath, fileExists: false}` when the file does not exist (no throw).
  - [ ] Skips lines that fail JSON.parse, increments `skippedLines`, emits `console.warn` with truncated line prefix (≤80 chars) — matches `snapshots.ts:152` style.
  - [ ] Skips lines that pass JSON.parse but lack one of `{ts, task, status, ms}` — increments `skippedLines`, emits `console.warn`.
  - [ ] Implements percentile via sorted-ms-array, nearest-rank method: `p50 = sorted[ceil(0.50*n)-1]`, `p99 = sorted[ceil(0.99*n)-1]`. Returns `null` when n=0.
  - [ ] Uses `node:fs/promises` (mirrors `snapshots.ts`) NOT sync `fs` — we are on async boundaries already in the MCP tool.
  - [ ] Test file `plugin/ralph-hero/mcp-server/src/__tests__/delegation-log.test.ts` covers: empty file, missing file, single line, mixed statuses, malformed JSON, missing required field, p50/p99 with 1/2/3/100 samples, byte aggregation.

#### Task 1.2: Register the `ralph_hero__delegation_stats` MCP tool

- **files**: `plugin/ralph-hero/mcp-server/src/tools/delegation-tools.ts` (create), `plugin/ralph-hero/mcp-server/src/index.ts` (modify), `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` (read)
- **tdd**: true
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Exports `registerDelegationTools(server: McpServer): void` — no GitHub client argument needed (mirrors `registerActivityTools`).
  - [ ] Registers tool name `ralph_hero__delegation_stats`.
  - [ ] Zod schema: `{ logPath?: string }` — optional override; defaults to `defaultDelegationLogPath()`.
  - [ ] Returns `toolSuccess({logPath, fileExists, totals: {calls, fallbacks, bytesIn, bytesOut, skippedLines}, byTask: {[task]: {calls, fallbacks, p50Ms, p99Ms, bytesIn, bytesOut, tokens: null}}, tokensReason: "F1 audit-log does not capture token usage; bytes used as a proxy"})`.
  - [ ] Returns `toolSuccess` with all-zero structure when file missing (no error path for absent file).
  - [ ] Wired in `src/index.ts` next to `registerActivityTools(server)` — single line addition.
  - [ ] Test file `plugin/ralph-hero/mcp-server/src/__tests__/delegation-tools.test.ts` covers: missing file, populated file (fixture), schema-versioned skip path.
  - [ ] Tool description string makes clear it reads `RALPH_DELEGATE_LOG_PATH` and is read-only.

#### Task 1.3: Wire `ralph status --delegation` CLI subcommand

- **files**: `plugin/ralph-hero/justfile` (modify), `plugin/ralph-hero/scripts/cli-dispatch.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `justfile` `status` recipe (currently lines 207-216) is extended: when args contain `--delegation`, switch `QUICK_TOOL` to `ralph_hero__delegation_stats` and `QUICK_PARAMS` to `{}`. When args do not contain `--delegation`, behavior is unchanged (still `pipeline_dashboard`).
  - [ ] Implementation uses pure bash conditional inside the recipe — no Justfile-language tricks. Read args via the existing `_args={{quote(args)}}; set -- $_args` pattern.
  - [ ] Help mentions `ralph status --delegation` (update `ralph-cli.sh:53` line: `status              Pipeline dashboard (use --delegation for telemetry)`).
  - [ ] No new env vars needed — `RALPH_DELEGATE_LOG_PATH` flows through `ralph_bridge_env` already (it's a `RALPH_*` var).
  - [ ] Existing `ralph status` continues to work bit-identically (verify with vitest fixture invocation if possible, otherwise document manual test).

#### Task 1.4: Add the size-based log-rotation script

- **files**: `plugin/ralph-hero/scripts/delegate/logrotate.sh` (create), `plugin/ralph-hero/scripts/delegate/__tests__/logrotate.test.sh` (create), `plugin/ralph-hero/scripts/activity/logrotate.sh` (read)
- **tdd**: true (bats)
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Reads env vars: `RALPH_DELEGATE_LOG_PATH` (default `~/.ralph-hero/delegate.log`), `RALPH_DELEGATE_LOG_ROTATE_BYTES` (default `5242880` — 5 MB), `RALPH_DELEGATE_LOG_KEEP` (default `3`).
  - [ ] When `delegate.log` size <= threshold or file absent → no-op, exit 0, prints `"logrotate: no rotation needed"`.
  - [ ] When `delegate.log` size > threshold → renames `delegate.log` → `delegate.log.1` (shifting `.1`→`.2`, `.2`→`.3`, etc., dropping the oldest). Touches a fresh empty `delegate.log`.
  - [ ] Supports `--dry-run` flag (prints `"DRY-RUN would rotate ..."` and exits 0).
  - [ ] Supports `--help` flag.
  - [ ] Portable across macOS BSD and GNU userland (use `wc -c < file | tr -d ' '` for size; `mv -f` for rename — both POSIX). Use `printf '%s' "$LOG_PATH"` tilde-expansion guard same as `ralph-delegate.sh:208-211`.
  - [ ] Bats test covers: absent file (no-op), under-threshold (no-op), over-threshold (rotates, `.1` exists, fresh empty `delegate.log`), three rotations in a row (`.1`, `.2`, `.3` exist, oldest dropped on 4th), `--dry-run`.

#### Task 1.5: Wire test runner + optional launchd template

- **files**: `plugin/ralph-hero/scripts/__tests__/run-all.sh` (read; check if exists), `plugin/ralph-hero/scripts/delegate/launchd/com.ralph.delegate-rotate.plist.template` (create), `plugin/ralph-hero/scripts/activity/launchd/` (read precedent)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.4]
- **acceptance**:
  - [ ] launchd plist template under `scripts/delegate/launchd/com.ralph.delegate-rotate.plist.template` — daily rotation. Copy structure from `scripts/activity/launchd/com.ralph.activity-rotate.plist.template` if present; else write a minimal `StartCalendarInterval` plist that invokes `logrotate.sh`. Path is `/Users/$USER/...` template placeholders (operator hand-edits before `cp`).
  - [ ] If a bats test runner exists at `plugin/ralph-hero/scripts/__tests__/run-all.sh` or equivalent, ensure the new `scripts/delegate/__tests__/logrotate.test.sh` is picked up by it (either via glob or explicit listing). If no top-level runner exists, the file is run by `bats scripts/delegate/__tests__/`.
  - [ ] README touch (`plugin/ralph-hero/README.md`): one new sub-bullet under the "Delegation (optional)" section pointing operators at `ralph status --delegation` and the rotation script. Two-line addition, do NOT rewrite the section.

### Phase Success Criteria

#### Automated Verification:
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` — no TypeScript errors
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` — all vitest passing, new files covered
- [ ] `bats plugin/ralph-hero/scripts/delegate/__tests__` — rotation suite green
- [ ] `bats plugin/ralph-hero/scripts/__tests__` — existing F1 suite still green (no regression)

#### Manual Verification:
- [ ] On a machine with no `delegate.log`: `ralph status --delegation` prints zero-state dashboard, no error.
- [ ] On a machine with a populated `delegate.log` (seed with 5 fixture lines covering `ok`/`timeout`/`unreachable`): output shows non-zero per-task counts, p50 latency, byte sums.
- [ ] On a 6 MB `delegate.log`: `bash scripts/delegate/logrotate.sh` produces `delegate.log.1`, fresh empty `delegate.log`. Re-run is no-op.
- [ ] `ralph status` (no flag) still prints the existing pipeline dashboard — no regression.

**Creates for next phase**: nothing — this is the only phase. Downstream consumers (a future `pipeline_dashboard` integration mentioned in the issue as optional) can read the same MCP tool.

---

## Integration Testing

- [ ] End-to-end: seed `~/.ralph-hero/delegate.log` with a 30-line synthetic fixture (mix of tasks and statuses), invoke `ralph status --delegation`, verify the rendered numbers match expected aggregates computed independently (e.g., by `jq` one-liner).
- [ ] Schema-compat: after F5 lands, future F4 / F6 changes that add fields to F1's audit-log line MUST keep `{ts, task, status, ms}` so F5's reader continues to accept them as v1 (or bump explicit `schemaVersion`).

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1191
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 producer (merged): `plugin/ralph-hero/scripts/ralph-delegate.sh` (issue #1185)
- Reader precedents:
  - `plugin/ralph-hero/mcp-server/src/lib/snapshots.ts` — schema-versioned JSONL with `console.warn` skip
  - `plugin/ralph-hero/mcp-server/src/lib/activity.ts` — pure read library, no cursor state in server
  - `plugin/ralph-hero/mcp-server/src/tools/activity-tools.ts` — minimal `register*Tools()` shape
- CLI precedent: `plugin/ralph-hero/justfile:208-216` (`status` recipe), `plugin/ralph-hero/scripts/cli-dispatch.sh:207-235` (`run_quick`)
- Rotation precedent: `plugin/ralph-hero/scripts/activity/logrotate.sh` + `scripts/activity/__tests__/logrotate.test.sh`
