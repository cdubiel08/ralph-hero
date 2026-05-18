---
date: 2026-05-03
status: draft
type: plan
tags: [llm-delegation, epic, plan-of-plans, local-llm, cost-optimization, openai-compat, gemma-lab, bash-delegation]
github_issue: 965
github_issues: [965]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/965
primary_issue: 965
---

# Epic Plan: Optional LLM Delegation via Bash() — Local & Cheaper Endpoints

## Prior Work

- builds_on:: [[2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory]]
- builds_on:: [[2026-03-19-plan-of-plans-model-switching]]
- builds_on:: [[2026-03-23-GH-0195-cli-default-haiku-model]]
- builds_on:: [[2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop]]
- references:: [[2026-02-25-idea-hunt-synthesis]] — "use cheaper models for routine orchestration"
- references:: `plugin/ralph-knowledge/src/llm-client.ts` — existing OpenAI-compat client (TS)
- references:: `scripts/dream/reflect.py:366` — existing fail-open delegation pattern (Python)

## Overview

Allow ralph-hero skill/agent runs to **optionally delegate** routine sub-tasks (summarization, classification, reranking, candidate filtering) to a user-configured LLM endpoint reached over OpenAI-compatible HTTP via the `Bash()` tool. The operator opts in by setting env vars; Claude (running inside a skill) detects opt-in and routes specific sub-tasks to a small wrapper script that hits the configured endpoint and returns a structured result.

The mechanism is intentionally **opt-in, scoped, and observable**: no skill delegates anything by default; every delegation logs an audit line; failures fall back to native Claude with the audit line marking the fallback so cost/quality regressions are visible.

This is a **plan of plans** — the epic decomposes into independent feature plans that can each be planned, reviewed, and shipped on their own. Only the Foundation (F1) is fully specified here; downstream features get acceptance criteria and scope-fences in this document, with file-level details deferred to their own sub-plans when picked up.

## Current State Analysis

**Local LLM is already wired into ralph-hero, but only outside the Claude turn:**

- `plugin/ralph-knowledge/src/llm-client.ts` — minimal OpenAI-compat HTTP client used during `reindex.ts` for contextual retrieval (chunk contextualization). Defaults: `RALPH_LLM_URL=http://localhost:8000`, `RALPH_LLM_MODEL=mlx-community/gemma-4-26b-a4b-it-mxfp8`.
- `scripts/dream/reflect.py:366` — `synthesize_reflection()` sends memory clusters to the same endpoint via `httpx`, with fail-open semantics, structured response parse, and a test seam (`http_post` injectable param).
- Both pipelines run *outside* Claude's turn (reindex is a one-shot script; reflect runs nightly via launchd).

**Cost-control patterns inside skills already exist, but only for picking among Claude models:**

- `RALPH_PLAYWRIGHT_REFLECT_MODEL` (e.g., `claude-sonnet-4-6` to drop from Opus) — see `plugin/ralph-playwright/skills/reflect/SKILL.md`.
- `RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL` (pinned to opus by default) — see `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md`.
- Agent frontmatter pins each agent to a model tier (haiku/sonnet/opus) — see `plugin/ralph-hero/agents/*.md`.

**Token-budget infrastructure exists:**

- `RALPH_BUDGET` env var and `--max-budget-usd` flag flow through `ralph-loop.sh:98` (`run_claude()`).

**What does NOT exist:**

- Any in-turn delegation mechanism — no skill currently runs `Bash(curl …)` to offload work to a non-Claude LLM during its own execution.
- Any tier-based or skill-based opt-in for cheaper Anthropic models (only the two playwright env vars).
- Any delegation audit log or telemetry on what the local LLM saved.
- Any reference pattern documented for skill authors who want to add delegation to their skill.

### Key Discoveries

- The operator's machine reliably has gemma-lab on `http://localhost:8000` (the parent CLAUDE.md documents `gemma-up`/`gemma-down` shortcuts and the `dream-now` integration). Reusing this endpoint for skill-level delegation is essentially free infrastructure.
- `RALPH_LLM_URL` and `RALPH_LLM_MODEL` are already in use; we should reuse them as the default endpoint (don't fork the namespace).
- `scripts/dream/reflect.py:366` is the canonical Python prototype. The shell equivalent (Bash + `curl`/`jq`) is small and parallel to the existing `cli-dispatch.sh:run_quick()` precedent (which uses `mcp call` to do work without Claude).
- `plugin/ralph-hero/scripts/resolve-env.sh:32` (`ralph_resolve_env`) provides the established env-discovery pattern — shell → repo `.local.json` → repo `.json` → `~/.claude/settings.json` — and we reuse it.
- Fail-open is the established pattern in this repo (ralph-knowledge llm-client doesn't crash if endpoint is down). However, the saved feedback memory cautions against silent fallback that masks bad config — we resolve the tension with an **audit trail**: fall back to native, but always log to `~/.ralph-hero/delegate.log` and emit a one-line note in the skill's user-visible output.

## Desired End State

After this epic completes (all sub-plans landed):

1. An operator can set `RALPH_DELEGATE_ENABLED=true` plus existing `RALPH_LLM_URL`/`RALPH_LLM_MODEL` (or per-skill overrides) and have ralph-hero skills automatically delegate eligible sub-tasks to the configured endpoint.
2. A shared helper, `ralph-delegate.sh`, is the single delegation surface. Skills call it from `Bash()` with a task descriptor and prompt file. The script handles env resolution, OpenAI-compat HTTP call, timeout, parse, and audit log.
3. At least three skills (the Wave-3 integrations) actually delegate at least one sub-task end-to-end, with a recorded quality comparison vs native.
4. A skill-author guide explains the delegation pattern with a worked example.
5. Telemetry surfaces delegation counts and fallback rates in `ralph status` and the pipeline dashboard.
6. **No-regression invariant:** with `RALPH_DELEGATE_ENABLED` unset (the default), ralph-hero behaves bit-identically to today.

### Verification

- A single-skill smoke test (`delegate-test`, introduced in F3) round-trips through the delegate when enabled, and falls back cleanly when the endpoint is killed.
- `ralph status --delegation` (F5) shows non-zero counts after Wave-3 integrations run.
- The audit log at `~/.ralph-hero/delegate.log` is JSONL-parseable and has one line per delegation attempt.

## What We're NOT Doing

- **Not replacing Claude** as the primary reasoning engine. Delegation handles narrow, structured sub-tasks (summarize, classify, rerank, candidate-filter) — never multi-step planning, code-gen, chain-of-thought, or any decision that affects PR/issue mutations.
- **Not** building an Anthropic-native API adapter in this epic. OpenAI-compat covers gemma-lab and OpenRouter (which routes to Haiku and other cheap models); a native Anthropic adapter is a possible follow-up epic, not in scope here.
- **Not** auto-routing. Every delegation site is explicit code in the skill — Claude does not decide to delegate ad-hoc; the skill author marks specific sub-tasks as "delegate-eligible" and the operator opts in.
- **Not** supporting streaming responses in v1. All delegate calls are non-streaming, single-shot, with a fixed timeout (default 60s).
- **Not** changing the existing `plugin/ralph-knowledge/src/llm-client.ts` or `scripts/dream/reflect.py` — they keep working as-is and continue to consume `RALPH_LLM_URL`/`RALPH_LLM_MODEL`.
- **Not** building a per-task model router (e.g., "long context → big model") in v1. One endpoint, one model, per skill or per tier.
- **Not** addressing prompt-caching or cache-friendly batching across delegate calls in v1.
- **Not** delegating any skill that mutates GitHub state (pr-agent's `gh pr create` step, merge-agent's merge step, save_issue calls). Only the *generation* step inside a skill that produces text-for-Claude-to-use is delegate-eligible. The skill itself remains in Claude's turn and remains responsible for the tool call.

## Implementation Approach

The epic decomposes into six features. Wave 1 ships the foundation (the wrapper script + env-var plumbing); Wave 2 ships the provider adapter and authoring pattern in parallel; Wave 3 lands three pilot skill integrations in parallel; Wave 4 (optional) adds telemetry and finalizes docs.

Each feature is its own implementation plan with its own GitHub sub-issue. This epic plan defines scope, dependencies, and acceptance criteria for each — sub-plans flesh out file-level details when they're picked up. The Foundation (F1) gets full file-level detail in this document because nothing else can land without it.

## Decomposition: Features

### Feature 1 — Foundation: `ralph-delegate.sh` wrapper + env-var plumbing

**Estimate:** S
**Owner area:** `plugin/ralph-hero/scripts/`
**Depends on:** none

**What it does**

A single shell entry point that all delegation flows through. Reads env vars, hits an OpenAI-compat endpoint, applies a timeout, parses the response, writes an audit log line, and prints the model's completion to stdout. Supports a `--health-check` mode (no HTTP body, low timeout) and a `--dry-run` mode (logs intent, does not call).

**Files introduced**

- `plugin/ralph-hero/scripts/ralph-delegate.sh` — main wrapper (executable, sourced by skills via `Bash()`).
- `plugin/ralph-hero/scripts/lib/openai-compat.sh` — sourceable adapter: builds the `messages` array, posts via `curl`, parses `.choices[0].message.content` via `jq`. Extracted from the wrapper if it grows past ~80 lines; otherwise inline.
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — bats test suite. CI runs it via `bats ./scripts/__tests__`.

**Env vars introduced**

| Var | Default | Purpose |
|-----|---------|---------|
| `RALPH_DELEGATE_ENABLED` | `false` (unset) | Master opt-in toggle |
| `RALPH_DELEGATE_TIMEOUT_SECONDS` | `60` | Per-call timeout |
| `RALPH_DELEGATE_LOG_PATH` | `~/.ralph-hero/delegate.log` | JSONL audit log path |
| `RALPH_DELEGATE_<TASK_UPPER>_URL` | (falls back to `RALPH_LLM_URL`) | Per-task endpoint override |
| `RALPH_DELEGATE_<TASK_UPPER>_MODEL` | (falls back to `RALPH_LLM_MODEL`) | Per-task model override |

`RALPH_LLM_URL` (default `http://localhost:8000`) and `RALPH_LLM_MODEL` (default `mlx-community/gemma-4-26b-a4b-it-mxfp8`) are reused as-is, not redefined.

**CLI surface**

```
ralph-delegate.sh \
  --task <name> \
  --prompt-file <path> \
  [--system-file <path>] \
  [--max-tokens N] \
  [--temperature 0.0..1.0] \
  [--health-check] \
  [--dry-run] \
  [--timeout N]
```

**Exit codes**

| Code | Meaning | Caller behavior |
|------|---------|-----------------|
| 0 | Success | Use stdout as the model's completion |
| 1 | Hard error (bad args, parse failure) | Caller falls back to native, logs the parse error |
| 124 | Timeout (matches GNU timeout convention) | Caller falls back to native |
| 126 | Delegation disabled (`RALPH_DELEGATE_ENABLED` unset/false) | Caller does work natively, no audit-log noise |
| 127 | Endpoint unreachable | Caller falls back to native, audit log records `unreachable` |

The 126 vs 127 distinction matters: 126 means "operator chose not to delegate" (silent skip); 127 means "operator opted in but endpoint is down" (visible degradation).

**Audit log line format**

JSONL, one line per attempt:

```json
{"ts":"2026-05-03T12:34:56Z","task":"locator","model":"mlx-community/gemma-4-26b-a4b-it-mxfp8","url":"http://localhost:8000","ms":284,"status":"ok","bytes_in":1340,"bytes_out":612,"caller":"<skill-or-agent-name>"}
```

Fields: `ts`, `task`, `model`, `url`, `ms`, `status` (`ok`|`timeout`|`unreachable`|`parse_error`|`http_<code>`), `bytes_in`, `bytes_out`, `caller` (set from `RALPH_HOOK_INPUT.tool_input.caller_skill` if present, otherwise `unknown`).

**Acceptance criteria — F1**

- [ ] `bash plugin/ralph-hero/scripts/ralph-delegate.sh --help` prints usage.
- [ ] `--health-check` returns 0 in <1s when endpoint is up; returns 127 in <2s when endpoint is unreachable.
- [ ] Successful delegation appends one well-formed JSONL record to `RALPH_DELEGATE_LOG_PATH`.
- [ ] Bats suite covers: enabled+up, enabled+down, disabled (returns 126, no log line), timeout (returns 124, log line with `status=timeout`), malformed JSON response (returns 1, log line with `status=parse_error`), per-task override resolution.
- [ ] Documented in `plugin/ralph-hero/README.md` under a new "Delegation (optional)" section.
- [ ] CI workflow (`ci.yml`) runs the bats suite alongside the existing build/test matrix.
- [ ] No hooks block `ralph-delegate.sh` invocations — verify by running it from a skill via `Bash()` in a smoke test.

---

### Feature 2 — Provider adapter: OpenAI-compat client (shell)

**Estimate:** XS
**Owner area:** `plugin/ralph-hero/scripts/lib/`
**Depends on:** F1 (lives inside `ralph-delegate.sh` or is extracted to `scripts/lib/openai-compat.sh`)

**What it does**

The actual HTTP+JSON adapter that turns a `(model, prompt, system_prompt?)` tuple into a parsed completion. Mirrors `plugin/ralph-knowledge/src/llm-client.ts` and `scripts/dream/reflect.py:_build_prompt + synthesize_reflection`, but in shell.

**Why a separate feature**

If F1 grows past ~80 lines of shell, the HTTP/JSON portion lives on its own and gets its own tests. F1 imports it. This is a refactor-friendly boundary so the implementation can later be replaced with a Node helper (`scripts/lib/openai-compat.mjs`) without touching skill code.

**Acceptance criteria — F2**

- [ ] Adapter is callable independently for testing (`bash scripts/lib/openai-compat.sh --model X --prompt-file Y`).
- [ ] Smoke test against gemma-lab on `localhost:8000` returns sensible output for a fixed prompt.
- [ ] Smoke test against an OpenRouter-compatible endpoint with a Haiku model also works (same code path; only env vars change).
- [ ] Standardized request shape: `{model, messages: [{role:"system",content:S}?,{role:"user",content:U}], max_tokens, temperature}`.
- [ ] Standardized response extraction: `.choices[0].message.content` via jq.
- [ ] Optional `--validate-json-output` flag for callers that expect JSON-formatted completions; runs `jq -e .` over the extracted content and returns 1 on parse failure.

---

### Feature 3 — Skill authoring pattern + reference skill

**Estimate:** S
**Owner area:** `plugin/ralph-hero/skills/` and `plugin/ralph-hero/CLAUDE.md`
**Depends on:** F1, F2

**What it does**

Documents the canonical delegation pattern for skill authors and ships one tiny reference skill that demonstrates the full path end-to-end. The reference skill doubles as an integration smoke test.

**Files introduced or modified**

- New: `plugin/ralph-hero/skills/delegate-test/SKILL.md` — minimal skill that takes an input string, delegates a fixed-prompt classification, falls back if disabled/down, prints the result and the path taken (`delegated`/`native`).
- New section in `plugin/ralph-hero/CLAUDE.md`: "Delegating sub-tasks via Bash to a local/cheaper LLM" with a worked example.
- Update: `plugin/ralph-hero/skills/shared/conventions.md` adds a "Delegation pattern" subsection — when to delegate, how to call from Bash, exit-code handling, audit-line emission to skill output.

**Authoring-pattern essentials (excerpt for the guide)**

```bash
# In a skill, when about to do a delegate-eligible sub-task:
PROMPT_FILE=$(mktemp)
echo "$PROMPT_TEXT" > "$PROMPT_FILE"
if OUTPUT=$("$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" \
              --task summarize \
              --prompt-file "$PROMPT_FILE" 2>/dev/null); then
  echo "delegation: yes (gemma-26b)"
  USE="$OUTPUT"
else
  rc=$?
  case "$rc" in
    126) ;; # disabled — skill does work natively, no note printed
    127|124|1) echo "delegation: fell back to native (rc=$rc)" ;;
  esac
  USE=""  # caller does work natively below
fi
rm -f "$PROMPT_FILE"
```

**Acceptance criteria — F3**

- [ ] `delegate-test` skill prints `delegated` or `native (fallback)` cleanly in both states.
- [ ] Authoring guide includes the complete worked bash snippet; any skill can copy and adapt it.
- [ ] Convention doc covers eligible sub-tasks (summarize, classify, rerank, candidate-filter) and ineligible ones (multi-step reasoning, code-gen, decision-making, anything that triggers a tool call mutation).
- [ ] Reference skill works end-to-end against gemma-lab; teardown leaves no temp files behind.

---

### Feature 4 — Wave-3 pilot integrations (3 sub-plans, parallel)

**Estimate:** M (3 × S sub-issues)
**Owner areas:** various agents
**Depends on:** F1, F2, F3

Three pilot integrations, one sub-plan each. Each picks a delegation site that is structured (input is a prompt, output is text-for-Claude), low-blast-radius (no GitHub mutations), and easy to evaluate (output can be diffed against a native baseline).

#### F4a — `codebase-locator`: candidate ranking
- **Today:** agent runs grep, then judges relevance and ranks candidates in-context.
- **After:** the candidate file list and the user's locate goal are sent to the delegate; the local LLM returns a relevance-ranked top-K JSON. Native Claude is still used to synthesize the final answer/output.
- **Acceptance:** locator runs end-to-end with delegation enabled, fallback path verified by killing endpoint mid-run; quality compared against native on a 5-query eval set.

#### F4b — `pr-agent`: PR description from diff
- **Today:** pr-agent reads the diff, writes the PR body itself.
- **After:** pr-agent emits the diff to the delegate with a fixed prompt template, gets back a draft description, edits if needed, then proceeds with the (unchanged) `gh pr create` call.
- **Acceptance:** generated PR descriptions are qualitatively comparable to native (manual eyeball on 3 real PRs); fallback to native is invisible to the merge flow.

#### F4c — `val-agent`: pass/fail classification
- **Today:** val-agent reads the implementation against the plan and writes a structured pass/fail.
- **After:** the classification step delegates a (plan-summary, impl-summary) → `{pass|fail|needs-review}` decision. Native Claude still composes the verdict comment and decides whether to advance the issue.
- **Acceptance:** delegated classification matches native on a 10-issue eval set within an agreed agreement threshold; fallback path tested.

Each F4* gets its own GitHub sub-issue and its own implementation plan when picked up.

---

### Feature 5 — Telemetry & cost tracking (optional, can defer)

**Estimate:** S
**Owner area:** `plugin/ralph-hero/mcp-server/`
**Depends on:** F1 (specifically, the `delegate.log` JSONL format)

**What it does**

Surfaces delegation activity in `ralph status` and the pipeline dashboard. Reads the JSONL log, aggregates by task and outcome, exposes counts via a new MCP tool and a CLI subcommand.

**Scope**

- New MCP tool: `ralph_hero__delegation_stats` (reads `RALPH_DELEGATE_LOG_PATH`, returns counts by task/outcome and p50/p99 latency).
- `ralph status --delegation` CLI flag (reuses `cli-dispatch.sh:run_quick`).
- Optional: include "Delegation: N calls / M fallbacks" in pipeline_dashboard text output.

**Acceptance criteria — F5**

- [ ] New MCP tool returns counts; output is stable JSON.
- [ ] CLI subcommand prints a small dashboard.
- [ ] Stats include: per-task call count, per-task fallback count, per-task p50/p99 latency, total tokens (if endpoint returns usage in `.usage`).

---

### Feature 6 — Documentation, setup-skill integration, migration

**Estimate:** XS
**Owner areas:** `plugin/ralph-hero/skills/setup/` and top-level `README.md`/`CLAUDE.md`
**Depends on:** F1 (env vars stable)

**What it does**

Adds delegation onboarding to the `ralph-hero:setup` skill so a fresh install can detect gemma-lab and offer to enable delegation. Updates top-level README and CLAUDE.md.

**Scope**

- `setup` skill: probe `http://localhost:8000` and offer to write `RALPH_DELEGATE_ENABLED=true` plus sensible defaults to `~/.claude/settings.json` if probe succeeds.
- README: new "Delegation" section with the env-var summary table.
- `plugin/ralph-hero/CLAUDE.md`: short "When to delegate" subsection linking to the F3 authoring guide.

**Acceptance criteria — F6**

- [ ] Setup skill detects the endpoint and offers (does not force) opt-in.
- [ ] README has the env-var table.

---

## Dependency Graph

```
        F1 (Foundation)
       /      |         \
      F2      F3          F6 (Docs/Setup)
       \    /
        F4a F4b F4c
                |
               F5 (Telemetry — optional)
```

- F1 must land before anything else.
- F2 and F3 can be planned in parallel after F1 (F3 references F2's adapter but only as a black-box CLI).
- F4a/b/c are siblings, parallel after F2+F3.
- F5 is optional and can land any time after F1 (consumes the JSONL log).
- F6 is parallel with F1 after F1's env vars are stable.

## Phasing Waves

| Wave | Feature(s) | Estimate | Goal |
|------|-----------|----------|------|
| 1 | F1 | S | Foundation: wrapper script + env vars + audit log + CI |
| 2 | F2, F3 | XS + S | Provider adapter (extracted); skill authoring pattern; reference skill |
| 3 | F4a, F4b, F4c | 3 × S | Three pilot integrations, run in parallel |
| 4 | F5, F6 | S + XS | Telemetry; setup-skill integration; docs polish |

## Success Criteria (epic-level)

#### Automated Verification:
- [ ] `npm test` passes for all touched plugins after every wave.
- [ ] `bats plugin/ralph-hero/scripts/__tests__` passes for the F1 suite.
- [ ] CI green for the ralph-hero plugin build at every wave merge.
- [ ] Smoke test: with `RALPH_DELEGATE_ENABLED=false` (default), every test that passed before this epic still passes — bit-identical no-regression.

#### Manual Verification:
- [ ] Operator runs `gemma-up && export RALPH_DELEGATE_ENABLED=true` and observes delegation logging in `~/.ralph-hero/delegate.log` after running any of the integrated skills.
- [ ] Operator kills gemma-lab and observes graceful fallback in skill output and the audit log (`status=unreachable` JSONL line).
- [ ] Operator overrides per-skill: `RALPH_DELEGATE_LOCATOR_MODEL=mlx-community/qwen-3.5-27b-it` overrides the default model only for the locator integration; audit log reflects the override.
- [ ] Unset `RALPH_DELEGATE_ENABLED` results in zero behavioral change anywhere in ralph-hero (the no-regression invariant).
- [ ] `ralph status --delegation` (after F5) shows non-zero call counts and a sensible p50.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Local LLM quality is too poor for delegated tasks → silent quality degradation | Audit log + telemetry (F5) make every delegation visible; F4* acceptance includes a manual quality check vs native baseline; fallback-with-audit-trail surfaces the choice in skill output |
| Bash + curl + jq is brittle compared to a proper SDK | F2 isolates HTTP/JSON code into a single sourceable adapter so it can be replaced with a Node/Python helper later without touching skill code |
| Per-skill env-var sprawl | Default to global `RALPH_LLM_URL`/`RALPH_LLM_MODEL`; per-skill overrides are optional escape hatches and documented as such |
| Operators forget delegation is on and blame model behavior on it | `ralph status --delegation` (F5) and the per-call note in skill output ("delegation: yes (gemma-26b)") make state discoverable |
| Conflict with existing `RALPH_LLM_URL` semantics in ralph-knowledge / dream-loop | Both consumers already use the same endpoint and same model; reuse is intentional, not accidental. Documented in F1 acceptance under "no-regression invariant". |
| Hooks block `Bash(curl …)` calls in agent contexts | F1 acceptance includes a hook-system check; if existing hooks block, add a narrow allowlist for `ralph-delegate.sh` invocations only |
| Skill author forgets to fall back and the skill hard-errors when endpoint dies | F3 authoring guide and reference skill make the fallback pattern copy-paste; bats suite in F1 demonstrates fallback exit codes; convention doc lists fallback as required |
| Audit log grows unbounded | F5 introduces log rotation (or recommend logrotate stanza in the README) — out of scope for F1 to keep it small |
| Endpoint returns prompt-leakage / sensitive content | All inputs to the delegate are already inside Claude's turn (i.e., already trusted). No additional risk vs the native path. Documented in convention doc. |

## Migration Notes

- No data migration required.
- Existing `RALPH_LLM_URL`/`RALPH_LLM_MODEL` consumers (ralph-knowledge llm-client, dream-loop reflect.py) are unaffected — `RALPH_DELEGATE_ENABLED` gates the new in-turn behavior independently. Both env vars keep their current defaults and current consumers.
- After F6, the `ralph-hero:setup` skill prompts to enable delegation if it detects gemma-lab; existing operators can opt in by setting one env var (no settings file rewrite required).
- If the operator changes `RALPH_LLM_URL` for ralph-knowledge or dream-loop, the change automatically propagates to delegation — they share the default. Per-task `RALPH_DELEGATE_<TASK>_URL` overrides exist for cases where the operator wants different endpoints for different consumers.

## References

### Existing code patterns
- `plugin/ralph-knowledge/src/llm-client.ts` — existing OpenAI-compat client (TS)
- `scripts/dream/reflect.py:366` — existing fail-open delegation pattern (Python, with test seam)
- `plugin/ralph-hero/scripts/resolve-env.sh:32` — env discovery pattern (`ralph_resolve_env`)
- `plugin/ralph-hero/scripts/cli-dispatch.sh:207` — `run_quick()` non-AI Bash wrapper precedent
- `plugin/ralph-hero/scripts/cli-dispatch.sh:21` — `portable_timeout` for cross-platform timeout
- `plugin/ralph-hero/hooks/scripts/hook-utils.sh` — shared shell utilities pattern (`read_input`, `get_field`, `block`, `warn`)
- `plugin/ralph-playwright/skills/reflect/SKILL.md` — model-override env-var pattern (`RALPH_PLAYWRIGHT_REFLECT_MODEL`)
- `plugin/ralph-playwright/skills/browser/references/vision-fallback-sequence.md` — pinned-model env var (`RALPH_PLAYWRIGHT_VISION_LOCATOR_MODEL`)

### Prior research
- `thoughts/shared/research/2026-04-16-local-llm-delivery-truth-personal-dreams-team-memory.md` — local-LLM thesis (Gemma 4 26B via MLX)
- `thoughts/shared/research/2026-03-19-plan-of-plans-model-switching.md` — task-complexity tiers (haiku/sonnet/opus)
- `thoughts/shared/research/2026-03-23-GH-0195-cli-default-haiku-model.md` — default CLI to Haiku
- `thoughts/shared/research/2026-04-26-GH-0901-local-cross-encoder-reranker-m5-pro.md` — local cross-encoder benchmarks on Apple Silicon
- `thoughts/shared/research/2026-04-06-haiku-skill-to-agent-dispatch.md` — Haiku Skill→Agent dispatch
- `thoughts/shared/research/2026-03-22-ralph-engine-vs-ralph-hero-pillar-parity.md` — multi-tier routing in ralph-impl

### Prior plans
- `thoughts/shared/plans/2026-04-19-group-GH-762-ralph-knowledge-chunked-embeddings-dream-loop.md` — declares `RALPH_LLM_URL`
- `thoughts/shared/plans/2026-02-22-group-GH-0305-budget-loop-scripts.md` — `RALPH_BUDGET` plumbing
- `thoughts/shared/plans/2026-03-18-GH-0599-ralph-plan-epic.md` — example epic-plan format

### Ideas
- `thoughts/shared/ideas/2026-02-25-idea-hunt-synthesis.md` — "use cheaper models for routine orchestration"
