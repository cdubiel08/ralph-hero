---
date: 2026-05-12
status: draft
type: plan
github_issue: 1186
github_issues: [1186]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1186
primary_issue: 1186
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, openai-compat, bash-delegation, refactor, adapter-extraction]
---

# F2 — OpenAI-Compat Shell Adapter (Extracted)

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: [[2026-05-12-GH-1185-ralph-delegate-sh-foundation]]
- references:: `plugin/ralph-knowledge/src/llm-client.ts` — TS reference client (request shape + response extraction)
- references:: `plugin/ralph-hero/scripts/ralph-delegate.sh` — F1 wrapper to be refactored
- references:: `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — existing F1 test suite (must stay green)

## Overview

[N=1] single-issue plan for the OpenAI-compat shell adapter extraction:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1186 | F2 — OpenAI-compat shell adapter (extracted) | XS |

Extracts the HTTP+JSON portion of `ralph-delegate.sh` (F1) into a standalone, sourceable shell adapter at `plugin/ralph-hero/scripts/lib/openai-compat.sh`. The adapter is independently callable (its own CLI surface) so its behavior can be tested in isolation, and the wrapper sources it so all real traffic still flows through one entry point. The extraction creates a refactor-friendly boundary so the implementation can later be swapped for a Node helper (`openai-compat.mjs`) without touching skill code.

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`) and F1 plan:

1. **Opt-in only.** `RALPH_DELEGATE_ENABLED` gating lives in `ralph-delegate.sh`, not in the adapter. The adapter itself is unconditional — it always does an HTTP call when invoked. If a caller wants the opt-in gate, they go through the wrapper.
2. **Reuse existing env vars.** `RALPH_LLM_URL` and `RALPH_LLM_MODEL` keep their current defaults (`http://localhost:8000`, `mlx-community/gemma-4-26b-a4b-it-mxfp8`). The adapter does NOT redefine them; resolution is the wrapper's job. The adapter takes `--model` and `--url` as explicit CLI args (or honors them via env when called standalone).
3. **Standardized request shape:** `{model, messages: [{role:"system",content:S}?, {role:"user",content:U}], max_tokens, temperature}` — exactly what F1 emits today, exactly what `llm-client.ts` and `reflect.py` emit.
4. **Standardized response extraction:** `.choices[0].message.content` via jq.
5. **Reuse `portable_timeout`.** `cli-dispatch.sh:21` already provides cross-platform timeout. Both the wrapper and the adapter call it.
6. **Bats glob auto-pickup.** `.github/workflows/ci.yml` runs `bats-core/bats-action@v2.1.1` against `plugin/ralph-hero/scripts/__tests__/` globally. New `*.bats` files are auto-included; no CI YAML changes needed.
7. **No-regression invariant.** F1's `ralph-delegate.bats` (8 tests) must remain green after refactor. The wrapper's external behavior (CLI surface, exit codes, JSONL audit-log format) is unchanged.
8. **Fail-open semantics live in the wrapper.** The adapter exits with a structured non-zero code on failure; the wrapper translates that into the F1 contract (124/127/1) and writes the audit-log line. The adapter itself does NOT write the audit log.

Feature-specific extensions:

9. **The adapter's CLI is a strict subset of the wrapper's CLI.** It accepts `--model`, `--prompt-file`, optional `--system-file`, `--max-tokens`, `--temperature`, `--url`, `--timeout`, plus the F2-new `--validate-json-output` flag. It does NOT accept `--task`, `--health-check`, `--dry-run`, or `--help` flags reserved for the wrapper's higher-level concerns. (`--help` IS supported for usability.)
10. **Refactor-friendly boundary.** The adapter is a pure HTTP+JSON function in shell. No env discovery, no audit log, no opt-in check. This is the contract that lets F4+ later swap to a Node implementation without touching wrapper or skill code.
11. **Smoke tests against real endpoints are manual, not CI.** Bats covers the contract hermetically (stub endpoints). The acceptance criteria "smoke test against gemma-lab" and "smoke test against OpenRouter" are operator-run manual checks, recorded in the plan's Manual Verification section. CI doesn't have network access to gemma-lab or OpenRouter.

## Current State Analysis

**What F1 shipped (verified from `ralph-delegate.sh` and `ralph-delegate.bats`):**

- `plugin/ralph-hero/scripts/ralph-delegate.sh` is 325 lines (substantive code ~170 lines), including: arg parsing, env resolution via `ralph_resolve_env`, per-task overrides, audit log writer, health-check mode, dry-run mode, and the main OpenAI-compat POST path.
- The HTTP+JSON adapter portion is currently inline at lines ~243-325: build request body via `jq -n`, POST via `curl` wrapped in `portable_timeout`, capture stdout/http_code/rc, branch on rc and http_code, parse `.choices[0].message.content` via `jq -er`, emit content to stdout.
- The F1 plan (Task 1.2 acceptance) explicitly notes: "*the HTTP+JSON adapter proper is only ~40 of those — the remainder is env resolution, audit log, time helpers, health-check, dry-run, and main-path glue. Extracting just the ~40-line HTTP portion now would not meaningfully shrink the wrapper. Per issue scope, full extraction is deferred to F2 / #1186.*"
- `plugin/ralph-hero/scripts/lib/` does NOT exist yet — F2 creates it as a net-new directory.
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (229 lines, 8 tests) is fully green today. It exercises the wrapper end-to-end against a Python stub endpoint started inside the bats process. All HTTP behavior (ok/timeout/unreachable/malformed/per-task-override) is verified through the wrapper.
- F1 uses `--task` as the discriminator for audit log + per-task overrides. The adapter does NOT need `--task` because it has no env-resolution concerns.

**What does NOT exist:**

- No standalone OpenAI-compat shell helper. The only existing OpenAI-compat code is the inline portion of `ralph-delegate.sh` and the TS `llm-client.ts`.
- No `--validate-json-output` flag anywhere. This is net-new in F2.
- No adapter-only test suite. F1's bats file tests the wrapper; F2 adds `openai-compat.bats` for adapter-level contracts.

**Tooling assumptions on the target machine (true per F1 CLAUDE.md):**

- `bash` (4.x or 5.x), `curl`, `jq`, `perl`, `python3` — all standard on macOS and the CI Ubuntu runner.
- `bats` is what CI uses to run the test suite.

## Desired End State

After F2 merges:

1. `plugin/ralph-hero/scripts/lib/openai-compat.sh` exists, is sourceable (defines functions, no top-level side effects), and is also directly invokable as a CLI script.
2. `ralph-delegate.sh` no longer contains inline HTTP+JSON code — it sources the adapter and calls one well-named function to do the POST and parse.
3. The wrapper's external CLI behavior is bit-identical to F1: same flags, same exit codes (0/1/124/126/127), same audit-log JSONL format.
4. `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` exists, exercises the adapter directly (without going through the wrapper), and is green.
5. F1's `ralph-delegate.bats` (8 tests) is unchanged and still green — proves no regression.
6. The adapter supports an optional `--validate-json-output` flag that runs `jq -e .` over the extracted content and returns 1 on parse failure.
7. CI's `test-cli` job is green on the PR; matrix builds are green; the new `openai-compat.bats` is auto-picked up by the bats glob.

### Verification

- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --help` prints usage and exits 0.
- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model X --prompt-file Y --url http://127.0.0.1:STUB_PORT` returns 0 + completion when stub is up.
- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model X --prompt-file Y --url http://127.0.0.1:65530` returns 127 in <2s when no listener.
- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model X --prompt-file Y --url <slow-stub> --timeout 1` returns 124.
- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model X --prompt-file Y --url <malformed-stub>` returns 1.
- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model X --prompt-file Y --url <ok-stub> --validate-json-output` returns 0 when content is valid JSON; returns 1 when content is not.
- [ ] `bats plugin/ralph-hero/scripts/__tests__/openai-compat.bats` — green.
- [ ] `bats plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — still green (8 tests).
- [ ] `bats plugin/ralph-hero/scripts/__tests__` (full suite) — green.

## What We're NOT Doing

- **NOT** changing the wrapper's CLI surface, exit codes, env-var contract, or audit-log format. External behavior is bit-identical.
- **NOT** replacing the bash adapter with a Node helper. The boundary is set up so that could happen later, but not in F2.
- **NOT** adding streaming support. Single-shot only.
- **NOT** adding native Anthropic API support. OpenAI-compat covers gemma-lab and OpenRouter (which proxies to Haiku).
- **NOT** introducing a CI workflow change. The bats-action glob picks up the new test file automatically.
- **NOT** wiring any skill to call the adapter directly. Skills always go through `ralph-delegate.sh` (the opt-in gate lives there). Direct adapter use is for testing and future Node-replacement scenarios only.
- **NOT** moving the audit log writer into the adapter. The audit log lives in the wrapper because that's where env resolution, caller resolution, and the opt-in gate live.
- **NOT** changing `--task`, `--health-check`, or `--dry-run` semantics. Those flags belong to the wrapper.
- **NOT** running smoke tests in CI. Live endpoint smoke tests (gemma-lab, OpenRouter) are operator-run manual checks documented in this plan's Manual Verification section.

## Implementation Approach

The whole feature is one phase (XS estimate, single issue). Implementation proceeds in three task groups:

1. **Test scaffolding first (TDD).** Author `openai-compat.bats` with adapter-only scenarios (ok, timeout, unreachable, malformed, JSON-output validation pass/fail, system-message support, custom temperature/max-tokens). Mock the HTTP endpoint with the same Python stub pattern as `ralph-delegate.bats` so tests are self-contained. Initial state: RED (script doesn't exist).
2. **Adapter script.** Implement `plugin/ralph-hero/scripts/lib/openai-compat.sh` to make the bats suite pass. Define a `openai_compat_post()` function (sourceable). Also support direct invocation as a CLI (bottom of file dispatches based on `${BASH_SOURCE[0]}` vs `$0`).
3. **Wrapper refactor + integration.** Source the adapter in `ralph-delegate.sh`; replace the inline HTTP+JSON block with a call to `openai_compat_post()`. Translate the adapter's exit codes into the wrapper's contract. Re-run F1's bats suite — must stay green.

There is exactly one Phase. No `depends_on` between phases is needed.

---

## Phase 1: GH-1186 — OpenAI-compat shell adapter (extracted)
- **depends_on**: null

### Overview

Extract the HTTP+JSON adapter from `ralph-delegate.sh` into a standalone sourceable shell file at `scripts/lib/openai-compat.sh`. Cover it with its own bats suite, add a `--validate-json-output` flag, and refactor the wrapper to source the adapter. Prove no regression by keeping F1's `ralph-delegate.bats` green.

### Tasks

#### Task 1.1: Author `openai-compat.bats` (TDD scaffold)
- **files**: `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` (create)
- **tdd**: true
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` with bats shebang `#!/usr/bin/env bats`.
  - [ ] `setup()` creates `TEST_TMPDIR`; `teardown()` cleans it up. Stub-endpoint helper mirrors the pattern from `ralph-delegate.bats` (Python `http.server` in a subprocess, `STUB_PID`/`STUB_PORT` exported, wait-for-port loop).
  - [ ] Stub helper supports four modes: `ok` (200 + valid completion), `ok-json-content` (200 + completion content that is itself valid JSON, e.g. `'{"answer":"yes"}'`), `ok-nonjson-content` (200 + completion content that is plain prose), `slow` (sleep before responding), `malformed` (200 + non-JSON body).
  - [ ] At least 8 `@test` blocks covering the adapter contract:
    1. `--help prints usage and exits 0` — assert stdout contains `--model` and `--prompt-file`.
    2. `endpoint up returns 0 and prints completion to stdout` — point `--url` at the `ok` stub; assert `$status -eq 0` and stdout contains the stubbed completion content. NO audit log file is written by the adapter (verify `$TEST_TMPDIR/delegate.log` does not exist or is empty — the adapter is logging-agnostic).
    3. `endpoint unreachable returns 127 in <2s` — point `--url` at `http://127.0.0.1:65530`; assert `$status -eq 127`, wall-clock <3s.
    4. `endpoint slow + --timeout 1 returns 124` — use the `slow` stub; assert `$status -eq 124`.
    5. `endpoint returns malformed JSON returns 1` — use the `malformed` stub; assert `$status -eq 1`.
    6. `system-file is included in request body when provided` — write a system prompt file, run a `python3 -c` decoder against the stub's logged request body (the stub captures and writes the incoming POST body to `$TEST_TMPDIR/last-request.json`); assert `messages` array has exactly 2 entries (`system` and `user`) and the `system` content matches.
    7. `--validate-json-output passes when content is valid JSON` — use `ok-json-content` stub; run with `--validate-json-output`; assert `$status -eq 0` and stdout is the JSON content.
    8. `--validate-json-output fails when content is not JSON` — use `ok-nonjson-content` stub; run with `--validate-json-output`; assert `$status -eq 1`.
  - [ ] Each test invokes the adapter as `bash "${BATS_TEST_DIRNAME}/../lib/openai-compat.sh" ...` (no $PATH dependency).
  - [ ] All 8 tests are RED at this point (adapter doesn't exist) — that's expected for TDD; they go GREEN in Task 1.2.

#### Task 1.2: Implement `openai-compat.sh` adapter
- **files**: `plugin/ralph-hero/scripts/lib/openai-compat.sh` (create), `plugin/ralph-hero/scripts/cli-dispatch.sh` (read), `plugin/ralph-hero/scripts/ralph-delegate.sh` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/lib/openai-compat.sh`, executable (`chmod +x`), starts with `#!/usr/bin/env bash` + `set -euo pipefail`.
  - [ ] File is structured as a library: defines functions (e.g. `openai_compat_post`) at the top, and dispatches to a CLI entrypoint only when invoked directly. Use the standard guard: `if [ "${BASH_SOURCE[0]}" = "$0" ]; then _cli_main "$@"; fi` at the bottom.
  - [ ] Sources `cli-dispatch.sh` from `$(dirname "${BASH_SOURCE[0]}")/../cli-dispatch.sh` to get `portable_timeout`. Use the same `SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` pattern as `ralph-delegate.sh` lines 39-45.
  - [ ] CLI args: `--model <name>`, `--prompt-file <path>`, optional `--system-file <path>`, `--url <url>` (required when invoked standalone — no env fallback in the adapter), `--max-tokens N` (default 1024), `--temperature F` (default 0.2), `--timeout N` (default 60), `--validate-json-output` (default off), `--help`/`-h`.
  - [ ] `--help` prints usage to stdout and exits 0.
  - [ ] Function signature for the public API (sourceable contract):
    ```
    openai_compat_post <url> <model> <prompt_file> [<system_file>] <max_tokens> <temperature> <timeout_seconds> <validate_json_flag>
    ```
    Returns one of: `0` (success — content on stdout), `1` (parse error or HTTP 4xx/5xx or `--validate-json-output` failure), `124` (timeout), `127` (network unreachable). NO audit log writes — this is the wrapper's job.
  - [ ] Body construction via `jq -n` matches F1 exactly:
    - With system file: `{model, messages:[{role:"system",content:S},{role:"user",content:U}], max_tokens, temperature}`
    - Without: `{model, messages:[{role:"user",content:U}], max_tokens, temperature}`
  - [ ] POST via `curl -sS -X POST -H "Content-Type: application/json" -d "$body" -o resp_body -w "%{http_code}" ${URL}/v1/chat/completions`, wrapped in `portable_timeout "${TIMEOUT_SECONDS}s"`. Captures response body, http_code, and rc separately (identical to F1's pattern at lines 276-291).
  - [ ] Exit code mapping (matches F1's wrapper semantics exactly):
    - rc=124 from portable_timeout → return 124
    - rc!=0 from curl (network failure) → return 127
    - HTTP 4xx/5xx → return 1 (parse error category)
    - jq parse of `.choices[0].message.content` fails → return 1
    - `--validate-json-output` set AND `jq -e .` on extracted content fails → return 1
    - Success → print content to stdout, return 0
  - [ ] No top-level side effects when sourced — only function definitions and a final `BASH_SOURCE` guard.
  - [ ] After implementation, running `bats plugin/ralph-hero/scripts/__tests__/openai-compat.bats` is green (all 8 tests).
  - [ ] Line count: total file ~120-180 lines (the standalone adapter + CLI wrapper). If it exceeds 250 lines, audit for accidental duplication of wrapper concerns.

#### Task 1.3: Refactor `ralph-delegate.sh` to source the adapter
- **files**: `plugin/ralph-hero/scripts/ralph-delegate.sh` (modify), `plugin/ralph-hero/scripts/lib/openai-compat.sh` (read)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] `ralph-delegate.sh` sources `openai-compat.sh` near the top: `source "$SCRIPT_DIR/lib/openai-compat.sh"` (next to the existing `source "$SCRIPT_DIR/resolve-env.sh"` and `source "$SCRIPT_DIR/cli-dispatch.sh"` at lines 41/45).
  - [ ] The inline HTTP+JSON block (currently lines ~243-325 of `ralph-delegate.sh`) is replaced with a single call to `openai_compat_post`, e.g.:
    ```bash
    set +e
    content=$(openai_compat_post "$URL" "$MODEL" "$PROMPT_FILE" "${SYSTEM_FILE:-}" "$MAX_TOKENS" "$TEMPERATURE" "$TIMEOUT_SECONDS" "false" 2>/dev/null)
    rc=$?
    set -e
    ```
    Wrapper then translates `rc` to the F1 exit-code contract and writes the audit-log line. The structure mirrors F1's existing rc/http_code branching.
  - [ ] `bytes_out` for the audit log: since the adapter prints content (not raw response body) on success, `bytes_out` for `status=ok` is `wc -c` of the captured content. For non-ok cases, the wrapper does not have raw response bytes — log `bytes_out: 0` for these (this is a small fidelity loss vs F1; document it in a code comment so reviewers know it's deliberate). *(Note: if reviewers reject this loss, the alternative is to have the adapter emit a 2-line stdout — line 1 is the content, line 2 is the response byte count — and have the wrapper parse it. We prefer the simpler `bytes_out: 0` for non-ok cases to keep the adapter contract clean.)*
  - [ ] Wrapper's behavior for `--health-check` is unchanged (it doesn't go through the adapter — it's a simple GET to `/v1/models`).
  - [ ] Wrapper's behavior for `--dry-run` is unchanged (no HTTP call at all).
  - [ ] Wrapper script line count drops by ~60-80 lines after the inline HTTP block is removed.
  - [ ] `bats plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — all 8 F1 tests are still green. This is the key no-regression check.
  - [ ] `bats plugin/ralph-hero/scripts/__tests__` (full suite) — green, no regressions in `cli-dispatch.bats`, `doctor.bats`, `ralph-cli.bats`, `resolve-env.bats`, `openai-compat.bats`.

### Phase Success Criteria

#### Automated Verification:

- [ ] `bats plugin/ralph-hero/scripts/__tests__/openai-compat.bats` — all 8 adapter tests pass.
- [ ] `bats plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — all 8 F1 tests still pass after refactor.
- [ ] `bats plugin/ralph-hero/scripts/__tests__` (full suite) — all bats files pass.
- [ ] CI `test-cli` job — green on the PR.
- [ ] CI `test-hooks` job — green on the PR.
- [ ] CI matrix builds (Node 18, 20, 22) — green; this PR doesn't touch TS source but the matrix runs anyway.
- [ ] `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --help` — exits 0, prints usage.
- [ ] `bash plugin/ralph-hero/scripts/ralph-delegate.sh --help` — exits 0, prints usage (unchanged from F1).

#### Manual Verification:

- [ ] **Live smoke test against gemma-lab** (operator): `gemma-up && export RALPH_DELEGATE_ENABLED=true && echo 'summarize: cats are nice' > /tmp/p.txt && bash plugin/ralph-hero/scripts/ralph-delegate.sh --task summarize --prompt-file /tmp/p.txt` — returns 0, prints a sensible completion, appends `status=ok` JSONL line to `~/.ralph-hero/delegate.log`. This verifies the refactor didn't break the live path.
- [ ] **Adapter-direct live smoke test** (operator): `gemma-up && bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model mlx-community/gemma-4-26b-a4b-it-mxfp8 --url http://localhost:8000 --prompt-file /tmp/p.txt` — returns 0 with a completion, no audit-log line written by the adapter (the wrapper is bypassed).
- [ ] **OpenRouter smoke test** (operator, optional): with an `OPENROUTER_API_KEY` set and the adapter pointed at `https://openrouter.ai/api`, a Haiku model call returns sensible output via the same code path. *(Optional — gates not used in CI; documents that the adapter is genuinely provider-agnostic.)*
- [ ] **JSON-output validation flag** (operator): with a prompt that asks the LLM to reply with JSON, `--validate-json-output` returns 0 when the reply parses; with a prompt that asks for prose, it returns 1.
- [ ] **Read the refactored `ralph-delegate.sh`**: confirm the inline HTTP block is gone and replaced with one call to `openai_compat_post`; confirm the wrapper still owns env resolution, opt-in gate, audit log, `--health-check`, `--dry-run`, and `--task`.

**Creates for next phase**: A standalone, sourceable, replaceable HTTP+JSON adapter. F3 (#1187) builds the skill-authoring guide on top of `ralph-delegate.sh` (the wrapper, not the adapter directly). F4a/b/c (#1188-#1190) integrate the wrapper into skills. F5 (#1191) consumes the JSONL log written by the wrapper. None of F3-F6 sees the adapter directly — that's the point of the boundary.

---

## Integration Testing

- [ ] **End-to-end via wrapper** (manual, real endpoint): Operator runs `gemma-up && RALPH_DELEGATE_ENABLED=true bash plugin/ralph-hero/scripts/ralph-delegate.sh --task summarize --prompt-file <real prompt>` and confirms the wrapper's CLI contract still holds: 0 + completion on stdout, JSONL `status=ok` line in `~/.ralph-hero/delegate.log`.
- [ ] **End-to-end direct adapter** (manual): Operator runs `bash plugin/ralph-hero/scripts/lib/openai-compat.sh --model X --url Y --prompt-file Z` and confirms 0 + completion, no log line (proves the audit log is wrapper-owned, not adapter-owned).
- [ ] **No-regression invariant** (automated, via CI): F1's `ralph-delegate.bats` (8 tests) is unchanged by F2 and continues to pass. This is the strongest signal that the refactor is behavior-preserving.
- [ ] **OpenRouter smoke** (manual, optional): If operator has an OpenRouter key, point the adapter at `https://openrouter.ai/api` with a Haiku model and verify the same code path works. Acceptance: F2 issue scope explicitly mentions OpenRouter as a smoke target; CI cannot run it (no secret), so this is a manual checkbox.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1186
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 plan: [thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md)
- F1 wrapper to refactor: `plugin/ralph-hero/scripts/ralph-delegate.sh`
- F1 bats suite (must stay green): `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- Reference TS client (request shape + response extraction): `plugin/ralph-knowledge/src/llm-client.ts`
- Cross-platform timeout helper: `plugin/ralph-hero/scripts/cli-dispatch.sh:21`
- CI bats integration: `.github/workflows/ci.yml`
