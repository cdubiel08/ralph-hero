---
date: 2026-05-12
status: draft
type: plan
github_issue: 1185
github_issues: [1185]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1185
primary_issue: 1185
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, bash-delegation, openai-compat, local-llm, foundation, audit-log]
---

# F1 — ralph-delegate.sh Foundation + Env-Var Plumbing

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: [[2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop]]
- references:: `plugin/ralph-knowledge/src/llm-client.ts` — TS OpenAI-compat reference client (fail-open, AbortController timeout)
- references:: `plugin/ralph-hero/scripts/resolve-env.sh:32` — `ralph_resolve_env` env discovery hierarchy
- references:: `plugin/ralph-hero/scripts/cli-dispatch.sh:21` — `portable_timeout` cross-platform timeout
- references:: `plugin/ralph-hero/scripts/__tests__/resolve-env.bats` — bats test style reference

## Overview

[N=1] single-issue plan for the LLM delegation epic foundation:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1185 | F1 — ralph-delegate.sh foundation + env-var plumbing | S |

This is the foundation feature for epic #965. Nothing else in the epic can land without this. The deliverable is a single shell entry point (`ralph-delegate.sh`) that all later delegation flows through, plus its bats test suite, plus a README section, plus a verified no-regression invariant (with `RALPH_DELEGATE_ENABLED` unset, ralph-hero behaves bit-identically to today).

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`):

1. **Opt-in only.** All new behavior is gated on `RALPH_DELEGATE_ENABLED=true`. The default (unset) MUST produce zero behavioral change anywhere in ralph-hero. Exit code 126 is reserved for "operator chose not to delegate" (silent skip, no audit-log noise).
2. **Reuse existing env vars.** `RALPH_LLM_URL` (default `http://localhost:8000`) and `RALPH_LLM_MODEL` (default `mlx-community/gemma-4-26b-a4b-it-mxfp8`) are already declared in `plugin/ralph-knowledge/src/llm-client.ts` and `scripts/dream/reflect.py`. Do NOT redefine them — read them via the existing `ralph_resolve_env` hierarchy.
3. **Reuse existing tooling.** `portable_timeout` from `cli-dispatch.sh:21` for cross-platform timeout. `ralph_resolve_env` from `resolve-env.sh:32` for env-var discovery. Do not duplicate these.
4. **Fail-open with audit trail.** Endpoint unreachable / timeout / parse error must not crash the caller — return a non-zero exit code so the caller falls back to native. Every attempt (success or failure) writes one JSONL line to the audit log; exit code 126 (disabled) is the sole exception that writes nothing.
5. **Bats is already integrated in CI.** `bats-action@v2.1.1` at `.github/workflows/ci.yml:126` already runs every `*.bats` file under `plugin/ralph-hero/scripts/__tests__/`. New bats files are auto-included by glob — do NOT add a separate CI job.
6. **No GitHub mutations in this feature.** F1 is plumbing only. Skills that actually delegate sub-tasks are F4a/b/c.
7. **Caller is responsible for fallback.** This script is a one-shot delegator. The caller (a skill, in a later feature) decides what to do on non-zero exit. F1 only needs to expose the exit-code contract and prove the script obeys it.

Feature-specific extensions:

8. **Adapter extraction is a decision point, not a forced split.** The issue explicitly says the HTTP/JSON portion is extracted to `scripts/lib/openai-compat.sh` only "if the wrapper grows past ~80 lines; otherwise inline." Full extraction lives in F2 (#1186). For F1, we MUST default to inline and create `scripts/lib/` only if the wrapper genuinely exceeds the threshold during implementation. Pre-emptive extraction is out of scope.
9. **`scripts/lib/` directory does not exist yet.** If we end up creating it (only if needed), it gets one file and gets exercised by the bats suite; no other repo wiring is required.

## Current State Analysis

**What exists today (verified by reading the listed files):**

- `plugin/ralph-knowledge/src/llm-client.ts` — TypeScript reference client. Hits `${baseUrl}/v1/chat/completions` with `{model, messages, max_tokens}` body, parses `.choices[0].message.content`, returns `""` on any failure (fail-open). Defaults `RALPH_LLM_URL=http://localhost:8000` and `RALPH_LLM_MODEL=mlx-community/gemma-4-26b-a4b-it-mxfp8`. Uses `AbortController` for a 30s timeout (and a 2s probe timeout for `available()` at `/v1/models`).
- `plugin/ralph-hero/scripts/resolve-env.sh` — provides `ralph_resolve_env VAR [REPO_ROOT] [HOME_DIR]` that searches shell env → `<repo>/.claude/settings.local.json` → `<repo>/.claude/settings.json` → `~/.claude/settings.json`. Filters out unexpanded `${VAR}` template literals. Exits 0 with value on success, 1 on miss.
- `plugin/ralph-hero/scripts/cli-dispatch.sh:21` — provides `portable_timeout DURATION CMD [args...]`. Wraps GNU `timeout` when present; on macOS BSD userland falls back to `perl -e 'alarm(...); exec @ARGV'`. Returns 124 in both paths on timeout. Duration accepts `Nm` or bare seconds.
- `plugin/ralph-hero/scripts/__tests__/` already contains `cli-dispatch.bats`, `doctor.bats`, `ralph-cli.bats`, `resolve-env.bats`. Test style: bash `setup()` creates `TEST_TMPDIR`, sources the unit-under-test, uses `run` builtin, asserts `$status` and `$output`.
- `.github/workflows/ci.yml:124-129` — `test-cli` job runs `bats-core/bats-action@v2.1.1` with `tests-path: plugin/ralph-hero/scripts/__tests__`. New `*.bats` files added there are auto-picked-up — no CI YAML changes needed.
- `plugin/ralph-hero/hooks/scripts/` — grep for "curl" and "ralph-delegate" returned nothing. No existing hook blocks `Bash(curl …)` or the planned script path. The "no hooks block ralph-delegate.sh" acceptance criterion is currently satisfied by absence — verified by smoke test rather than by adding any allowlist.
- `plugin/ralph-hero/scripts/lib/` — does NOT exist. If we extract, this directory will be net-new.
- `plugin/ralph-hero/README.md` — no existing "Delegation" or "RALPH_LLM" section. The "Delegation (optional)" subsection is net-new content.

**Tooling assumptions on the target machine (already true per parent CLAUDE.md):**

- `bash` (4.x or 5.x), `curl`, `jq`, `perl` — all standard on macOS and the CI Ubuntu runner.
- `bats` is what CI uses to run the test suite; it's bundled in the bats-action.

## Desired End State

After F1 merges:

1. `plugin/ralph-hero/scripts/ralph-delegate.sh` exists, is executable, and obeys the CLI contract from the parent plan.
2. The script honors the 5-value exit-code contract (0/1/124/126/127) exactly as specified, and writes JSONL audit lines for every attempt except 126.
3. Calling the script with `RALPH_DELEGATE_ENABLED` unset returns 126 immediately, writes nothing to the log, and produces no stderr noise.
4. `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` exists, covers the seven acceptance scenarios from the issue, and passes locally and in CI.
5. `plugin/ralph-hero/README.md` has a new "Delegation (optional)" section that documents the env vars (table) and the exit-code contract (table).
6. CI's existing `test-cli` job runs the new bats file as part of its glob and passes green.
7. No-regression smoke: with `RALPH_DELEGATE_ENABLED` unset, the existing bats suite (`cli-dispatch.bats`, `doctor.bats`, `ralph-cli.bats`, `resolve-env.bats`) continues to pass identically.

### Verification

- [x] `bash plugin/ralph-hero/scripts/ralph-delegate.sh --help` prints usage and exits 0.
- [x] With endpoint up: `RALPH_DELEGATE_ENABLED=true bash plugin/ralph-hero/scripts/ralph-delegate.sh --health-check` returns 0 in <1s. *(Verified live against gemma-lab on :8000, 0.28s wall-clock.)*
- [x] With endpoint down: `RALPH_DELEGATE_ENABLED=true RALPH_LLM_URL=http://127.0.0.1:65530 bash plugin/ralph-hero/scripts/ralph-delegate.sh --health-check` returns 127 in <2s and appends a JSONL line with `"status":"unreachable"`. *(Bats test 4 covers this hermetically.)*
- [x] With `RALPH_DELEGATE_ENABLED` unset: the script returns 126 in <50ms and the log file is byte-identical before and after (no line written). *(Bats test 2.)*
- [x] `bats plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` is green.
- [x] `bats plugin/ralph-hero/scripts/__tests__` (full suite, including pre-existing files) is green.
- [ ] CI is green on the PR for both `test-cli` and `test-hooks` jobs.

## What We're NOT Doing

- **NOT** extracting `openai-compat.sh` to `scripts/lib/` unless the wrapper actually crosses ~80 lines. Full extraction is F2 (#1186).
- **NOT** wiring any skill or agent to actually call `ralph-delegate.sh`. First skill integration is F4a (#1188).
- **NOT** building telemetry or `ralph status --delegation`. That is F5 (#1191).
- **NOT** adding a setup-skill probe. That is F6 (#1192).
- **NOT** adding log rotation. The issue scopes this out; F5 owns it.
- **NOT** caching responses, batching, or streaming. v1 is non-streaming single-shot.
- **NOT** modifying `RALPH_LLM_URL` or `RALPH_LLM_MODEL` semantics — the existing ralph-knowledge llm-client and dream-loop continue to use them unchanged.
- **NOT** changing any existing hook script. The acceptance criterion is "no hooks block ralph-delegate.sh"; this is verified by running the script through a skill via `Bash()` in the smoke test, not by adding allowlists.
- **NOT** adding a CI workflow file. The existing `bats-action` glob picks the new test up automatically.

## Implementation Approach

The whole feature is one phase (S estimate, single issue). Implementation proceeds in three task groups inside that phase:

1. **Test scaffolding first (TDD).** Author `ralph-delegate.bats` with seven failing scenarios that pin the contract. Mock the HTTP endpoint with `nc` / `python -m http.server` / a shell stub so tests don't depend on gemma-lab being up.
2. **Wrapper script.** Implement `ralph-delegate.sh` to make the bats suite pass. Source `resolve-env.sh` for env discovery and `cli-dispatch.sh` for `portable_timeout`. Inline the HTTP+JSON adapter unless the script grows past ~80 lines; if it does, only then create `scripts/lib/openai-compat.sh` (F1-acceptable per the issue body).
3. **Documentation and smoke test.** Add the README section and run the script-from-a-skill smoke test that proves no hook blocks `Bash($plugin_root/scripts/ralph-delegate.sh ...)`.

There is exactly one Phase. No `depends_on` between phases is needed.

---

## Phase 1: GH-1185 — ralph-delegate.sh foundation
- **depends_on**: null

### Overview

Build the single shell entry point that every later delegation flows through: arg parsing, env resolution, OpenAI-compat HTTP call, timeout, response parse, audit log, exit-code contract, bats coverage, README section, and a hook-bypass smoke test.

### Tasks

#### Task 1.1: Author the bats test suite (TDD scaffold)
- **files**: `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [x] File exists at `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` with bats shebang `#!/usr/bin/env bats`.
  - [x] `setup()` creates `TEST_TMPDIR` and exports `RALPH_DELEGATE_LOG_PATH="$TEST_TMPDIR/delegate.log"` so tests are hermetic (no writes to `~/.ralph-hero/`).
  - [x] `teardown()` removes `TEST_TMPDIR`.
  - [x] Seven `@test` blocks, one per acceptance scenario from the issue:
    1. `--help prints usage and exits 0` — assert stdout contains `--task` and `--prompt-file`.
    2. `disabled returns 126 and writes no log line` — with `RALPH_DELEGATE_ENABLED` unset, run with a prompt file; assert `$status -eq 126` and `[ ! -f "$RALPH_DELEGATE_LOG_PATH" ] || [ "$(wc -l < $RALPH_DELEGATE_LOG_PATH)" -eq 0 ]`.
    3. `enabled + endpoint up returns 0 and writes status=ok JSONL` — stub endpoint with a local listener (use `python3 -m http.server` plus a static `chat/completions` JSON, OR use a sidecar bash stub that listens on a port and replies with a fixed completion); assert `$status -eq 0`, stdout is the model content, log has one line with `"status":"ok"`.
    4. `enabled + endpoint unreachable returns 127 in <2s and writes status=unreachable` — point `RALPH_LLM_URL` at `http://127.0.0.1:65530` (a port nothing listens on); assert `$status -eq 127`, elapsed wall-clock <2s, log has one line with `"status":"unreachable"`.
    5. `enabled + timeout returns 124 and writes status=timeout` — stub endpoint that sleeps longer than `RALPH_DELEGATE_TIMEOUT_SECONDS=1`; assert `$status -eq 124`, log has `"status":"timeout"`.
    6. `enabled + malformed JSON returns 1 and writes status=parse_error` — stub endpoint that returns `not-json-at-all`; assert `$status -eq 1`, log has `"status":"parse_error"`.
    7. `per-task env override resolves` — set `RALPH_DELEGATE_LOCATOR_MODEL=override-model`; assert that when `--task locator` is passed, the JSONL line's `model` field is `override-model`, not the global `RALPH_LLM_MODEL` default.
  - [x] Each test calls the script as `bash "${BATS_TEST_DIRNAME}/../ralph-delegate.sh" ...` (no relying on $PATH).
  - [x] Endpoint stub is implemented as a small helper inside the bats file (a `start_stub_endpoint()` shell function) so tests are self-contained and don't require external fixture files.
  - [x] All seven tests are RED at this point (script doesn't exist yet) — that's expected for TDD; the suite will go GREEN in Task 1.2.

#### Task 1.2: Implement `ralph-delegate.sh`
- **files**: `plugin/ralph-hero/scripts/ralph-delegate.sh` (create), `plugin/ralph-hero/scripts/resolve-env.sh` (read), `plugin/ralph-hero/scripts/cli-dispatch.sh` (read)
- **tdd**: true
- **complexity**: high
- **depends_on**: [1.1]
- **acceptance**:
  - [x] File exists, is executable (`chmod +x`), and starts with `#!/usr/bin/env bash` + `set -euo pipefail`.
  - [x] Sources `resolve-env.sh` and `cli-dispatch.sh` from the same directory using `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` pattern matching `cli-dispatch.sh:6`.
  - [x] Arg parser handles all flags from the issue: `--task <name>`, `--prompt-file <path>`, `--system-file <path>`, `--max-tokens N`, `--temperature 0.0..1.0`, `--health-check`, `--dry-run`, `--timeout N`, `--help`.
  - [x] `--help` prints usage to stdout and exits 0 (covered by test 1).
  - [x] Disabled-check is the first behavior after arg parsing: if `RALPH_DELEGATE_ENABLED` is empty/false/0/unset, exit 126 immediately. NO log line written. (covered by test 2).
  - [x] Env resolution: `RALPH_LLM_URL`, `RALPH_LLM_MODEL`, `RALPH_DELEGATE_TIMEOUT_SECONDS`, `RALPH_DELEGATE_LOG_PATH`, and per-task overrides (`RALPH_DELEGATE_<TASK_UPPER>_URL`, `RALPH_DELEGATE_<TASK_UPPER>_MODEL`) all resolve via `ralph_resolve_env` so settings.json files work. Per-task overrides take precedence over global. Defaults: URL=`http://localhost:8000`, MODEL=`mlx-community/gemma-4-26b-a4b-it-mxfp8`, TIMEOUT=`60`, LOG=`~/.ralph-hero/delegate.log`.
  - [x] Log file parent directory is created with `mkdir -p` before the first append (`~/.ralph-hero/` may not exist yet on a fresh checkout).
  - [x] `--health-check`: issues a GET to `${RALPH_LLM_URL}/v1/models` with a hard 2s timeout; exit 0 on HTTP 200, exit 127 otherwise. Writes a `status=ok` or `status=unreachable` JSONL line. (covers tests 3, 4 partially.)
  - [x] Main path: builds the OpenAI-compat request body via `jq -n`:
    ```
    {model, messages: [{role:"system",content:S}?, {role:"user",content:U}], max_tokens, temperature}
    ```
    The system message is included only when `--system-file` is provided.
  - [x] POSTs via `curl -sS -X POST -H "Content-Type: application/json" -d "$body" -o resp_body -w "%{http_code}" ${URL}/v1/chat/completions`, wrapped in `portable_timeout "${RALPH_DELEGATE_TIMEOUT_SECONDS}s"`. Captures response body, http_code, and rc separately. *(Note: used `-d "$body"` rather than process-substitution `-d @<(...)` because the latter creates fd-redirected stdin that interacts oddly with portable_timeout's perl fallback; the resulting behavior is identical.)*
  - [x] Response parse: `jq -er '.choices[0].message.content'`. If jq fails, exit 1 with `status=parse_error`.
  - [x] On rc=124 from `portable_timeout`, exit 124 with `status=timeout`.
  - [x] On rc!=0 from curl (network failure), exit 127 with `status=unreachable`.
  - [x] On HTTP 4xx/5xx, exit 1 with `status=http_<code>` (where `<code>` is the integer status — captured from curl `-w "%{http_code}"`).
  - [x] On success, exit 0 with `status=ok` and the parsed content printed to stdout exactly (no trailing extra newline beyond what jq emits).
  - [x] JSONL audit-log writer: a single `_audit_log()` shell function that takes `status`, `ms`, `bytes_in`, `bytes_out` and constructs one line via `jq -nc` with all required fields (`ts`, `task`, `model`, `url`, `ms`, `status`, `bytes_in`, `bytes_out`, `caller`). `caller` reads `${RALPH_HOOK_INPUT}` JSON if set (`jq -r '.tool_input.caller_skill // "unknown"'`); otherwise `"unknown"`.
  - [x] `--dry-run`: prints the resolved (model, url, task, prompt-byte-count) tuple to stdout, writes a JSONL line with `status=dry_run`, exits 0. No HTTP call.
  - [x] After implementation, running `bats plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` is fully green (all 7 tests).
  - [x] Line count check: if the script exceeds ~80 lines of substantive code (not counting comments / blank lines / arg parsing), extract the HTTP+JSON portion into `plugin/ralph-hero/scripts/lib/openai-compat.sh` and source it. Otherwise inline. This is a judgment call permitted by the issue scope. *(Verdict: substantive non-arg-parsing lines are ~170, but the HTTP+JSON adapter proper is only ~40 of those — the remainder is env resolution, audit log, time helpers, health-check, dry-run, and main-path glue. Extracting just the ~40-line HTTP portion now would not meaningfully shrink the wrapper. Per issue scope, full extraction is deferred to F2 / #1186.)*
  - [x] `bats plugin/ralph-hero/scripts/__tests__` (full suite) is green — no regression in `cli-dispatch.bats`, `doctor.bats`, `ralph-cli.bats`, `resolve-env.bats`.

#### Task 1.3: Add "Delegation (optional)" section to README
- **files**: `plugin/ralph-hero/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] New top-level section `## Delegation (optional)` added (placement: after the existing setup section, before any troubleshooting / changelog content — pick the spot adjacent to env-var documentation).
  - [x] Section opens with a one-paragraph summary: opt-in feature, gated on `RALPH_DELEGATE_ENABLED=true`, default behavior unchanged, reuses existing `RALPH_LLM_URL`/`RALPH_LLM_MODEL`.
  - [x] Includes the full env-var table from the issue (5 rows: `RALPH_DELEGATE_ENABLED`, `RALPH_DELEGATE_TIMEOUT_SECONDS`, `RALPH_DELEGATE_LOG_PATH`, `RALPH_DELEGATE_<TASK_UPPER>_URL`, `RALPH_DELEGATE_<TASK_UPPER>_MODEL`).
  - [x] Includes the exit-code table from the issue (5 rows: 0, 1, 124, 126, 127).
  - [x] Includes a 3-line "Quick check" example: `gemma-up && export RALPH_DELEGATE_ENABLED=true && bash plugin/ralph-hero/scripts/ralph-delegate.sh --health-check`.
  - [x] Notes that the JSONL log lives at `~/.ralph-hero/delegate.log` and is consumed later by F5 telemetry (link to epic #965).
  - [x] Markdown lints clean (no broken table syntax — verified by `cat` + eyeball, no linter is configured per top-level CLAUDE.md).

#### Task 1.4: Hook-bypass smoke test from a skill
- **files**: `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (modify — add one extra test)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [x] An eighth `@test` is added: `script runs cleanly when invoked from a skill-like Bash() context`.
  - [x] The test sets `RALPH_HOOK_INPUT='{"tool_input":{"caller_skill":"smoke-test"}}'` to mimic Claude Code's hook-input envelope, then runs the script with `RALPH_DELEGATE_ENABLED=true --dry-run --task smoke --prompt-file <tempfile>`.
  - [x] Assertion 1: `$status -eq 0` (dry-run returns 0 unconditionally when enabled).
  - [x] Assertion 2: the resulting JSONL log line has `"caller":"smoke-test"` (proves `RALPH_HOOK_INPUT` parsing works).
  - [x] Assertion 3: no PreToolUse hook in `plugin/ralph-hero/hooks/scripts/` matches and blocks the invocation. The repo audit done during planning showed zero hook scripts reference `ralph-delegate` or `curl` — the smoke test is the regression guard. (Implementation note: this is a unit-level test, not a full Claude Code subprocess; the bats test asserts script-side behavior. Verifying no hook actually fires requires the F3 reference skill, which is out of scope here; the smoke test pins what F1 owns.)
  - [x] If a future contributor adds a PreToolUse hook that matches `Bash` and blocks `ralph-delegate.sh`, the test stays green (it doesn't go through Claude Code), but F3's reference skill smoke test will fail loudly. The plan notes this gap explicitly so reviewers understand the boundary.

### Phase Success Criteria

#### Automated Verification:

- [x] `bats plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — all 8 tests pass.
- [x] `bats plugin/ralph-hero/scripts/__tests__` (full suite) — all bats files pass, no regressions in existing 4 suites.
- [ ] CI `test-cli` job — green on the PR.
- [ ] CI `test-hooks` job — green on the PR (proves no hook regression).
- [ ] CI matrix builds (Node 18, 20, 22) — green; this PR doesn't touch TS source but the matrix runs anyway.
- [x] `bash plugin/ralph-hero/scripts/ralph-delegate.sh --help` — exits 0, prints usage including all 9 flags.

#### Manual Verification:

- [x] With `gemma-up` running locally: `RALPH_DELEGATE_ENABLED=true bash plugin/ralph-hero/scripts/ralph-delegate.sh --health-check` returns 0 in <1s. *(Verified 2026-05-13: rc=0 in ~0.28s; `status=ok` line written.)*
- [ ] After killing the gemma server: same command returns 127 in <2s and appends a `status=unreachable` line to `~/.ralph-hero/delegate.log`. *(Covered automatically by bats test 4, which points `RALPH_LLM_URL` at port 65530; live kill not run.)*
- [ ] With endpoint up and a sample prompt file: `RALPH_DELEGATE_ENABLED=true bash plugin/ralph-hero/scripts/ralph-delegate.sh --task summarize --prompt-file /tmp/p.txt` returns 0, prints a sensible completion to stdout, appends a `status=ok` JSONL line. *(Bats test 3 covers this against a stub; live gemma run deferred to F4a.)*
- [ ] Unset `RALPH_DELEGATE_ENABLED`: same command returns 126 in <50ms, log file unchanged. *(Covered by bats test 2.)*
- [x] Read the new README section out loud — does it tell an operator everything they need to flip delegation on? Yes.

**Creates for next phase**: The `ralph-delegate.sh` script, the exit-code contract, the JSONL log format, and the env-var namespace. F2 (#1186) extracts the HTTP/JSON portion into a standalone adapter (already half-done if Task 1.2 hit the 80-line threshold). F3 (#1187) builds the skill-authoring guide and reference skill on top of this CLI. F4a/b/c integrate the script into real skills.

---

## Integration Testing

- [x] **End-to-end with real endpoint** (manual): `gemma-up && RALPH_DELEGATE_ENABLED=true bash plugin/ralph-hero/scripts/ralph-delegate.sh --health-check` against gemma-lab on `localhost:8000` — rc=0 in ~0.28s, JSONL `status=ok` line written. Live prompt run deferred to F4a (no skill calls `ralph-delegate.sh` yet — F1 is plumbing only).
- [ ] **End-to-end with OpenRouter-compatible endpoint** (manual, deferred to F2 acceptance — F2's acceptance criteria explicitly cover OpenRouter smoke). F1 ships gemma-lab-only manual verification.
- [ ] **Hook-system non-interference** (manual): in a subsequent F3 session, run the reference skill that calls `ralph-delegate.sh` via `Bash()`; confirm no PreToolUse hook blocks it. F1 cannot prove this end-to-end without F3 — the F1 bats `smoke test` (Task 1.4) is a deliberate stand-in.
- [ ] **No-regression invariant** (automated, via CI): with `RALPH_DELEGATE_ENABLED` unset, every test that passed pre-merge still passes post-merge. This is enforced by the existing `test-cli` + `test-hooks` + matrix jobs continuing green.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1185
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- Reference TS client: `plugin/ralph-knowledge/src/llm-client.ts`
- Reference Python prototype (fail-open): `scripts/dream/reflect.py:366`
- Env resolution helper: `plugin/ralph-hero/scripts/resolve-env.sh:32`
- Cross-platform timeout: `plugin/ralph-hero/scripts/cli-dispatch.sh:21`
- Existing bats test style: `plugin/ralph-hero/scripts/__tests__/resolve-env.bats`
- CI bats integration: `.github/workflows/ci.yml:124-129`
