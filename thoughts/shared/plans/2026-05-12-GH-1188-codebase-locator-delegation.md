---
date: 2026-05-12
status: draft
type: plan
github_issue: 1188
github_issues: [1188]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1188
primary_issue: 1188
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, codebase-locator, candidate-ranking, agent-delegation, bash-delegation, wave-3]
---

# F4a — `codebase-locator`: Candidate Ranking via Delegation

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: [[2026-05-12-GH-1185-ralph-delegate-sh-foundation]]
- builds_on:: [[2026-05-12-GH-1186-openai-compat-shell-adapter]]
- builds_on:: [[2026-05-12-GH-1187-skill-authoring-pattern-delegate-test]]
- references:: `plugin/ralph-hero/agents/codebase-locator.md` — the agent body F4a wires delegation into
- references:: `plugin/ralph-hero/scripts/ralph-delegate.sh` — F1 wrapper (the single delegation surface)
- references:: `plugin/ralph-hero/skills/delegate-test/SKILL.md` — F3 reference skill (control-flow template)
- references:: `plugin/ralph-hero/docs/delegation-authoring.md` — F3 authoring guide (worked example)
- references:: `plugin/ralph-hero/skills/shared/delegation-conventions.md` — F3 conventions doc ("rerank" / "candidate-filter" are on the eligible list)
- references:: `plugin/ralph-hero/skills/ralph-research/SKILL.md:180` and `plugin/ralph-hero/skills/research/SKILL.md:105` — call sites that dispatch `codebase-locator` via `Agent()`
- references:: `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — bats stub pattern (Python HTTPServer)

## Overview

[N=1] single-issue plan for the LLM delegation epic's first real Wave-3 production integration:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1188 | F4a — codebase-locator: candidate ranking via delegation | S |

Wire the `codebase-locator` agent's candidate-ranking step to optionally delegate to `ralph-delegate.sh` (task name `locator`). The agent already runs `Grep`/`Glob`/`Bash` to gather a wide candidate set; today it ranks/filters those candidates by reading filenames in context and judging relevance. After this feature, when `RALPH_DELEGATE_ENABLED=true` is set, the candidate list + the user's locate goal are sent to a local LLM (gemma-lab) which returns a relevance-ranked top-K JSON. Native Claude still synthesizes the final structured output (the "## File Locations for …" section). The locator's text-out shape is unchanged in both paths.

This is the first Wave-3 pilot — it proves the F3 pattern works in a production agent (not just a smoke-test skill) and establishes the precedent F4b (`pr-agent`) and F4c (`val-agent`) will copy. The siblings are not blockers; they're parallel siblings owned by separate plans.

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`) and F1/F2/F3 plans:

1. **Opt-in only.** All new behavior is gated on `RALPH_DELEGATE_ENABLED=true`. With the variable unset (default), `codebase-locator` MUST behave bit-identically to today — same tool calls, same output shape, same files inspected, no audit-log writes.
2. **Reuse the wrapper, not the adapter.** The agent MUST call `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task locator` (NOT `lib/openai-compat.sh` directly). Per the conventions doc, the adapter is internal; skills/agents always go through the wrapper for the opt-in gate, env resolution, and audit log.
3. **Fail-open with audit trail.** The agent obeys the 5-value exit-code contract (0/1/124/126/127). Non-zero exits MUST trigger native ranking — never crash, never block the agent's output.
4. **No GitHub mutations.** `codebase-locator` is read-only by design (its tools are `Grep, Glob, Bash`); F4a adds no `save_issue`, no `create_comment`, no MCP calls. The only side effect is the JSONL line `ralph-delegate.sh` writes to `~/.ralph-hero/delegate.log` when delegation runs.
5. **No-regression invariant.** Pre-existing usage of `codebase-locator` (called from `ralph-research:SKILL.md:180` and `research:SKILL.md:105`) MUST produce byte-identical output structure when delegation is off. F1's 8 bats tests and F2's 8 bats tests MUST continue to pass. Existing `npm test` and CI matrix MUST stay green.
6. **Caller is responsible for fallback.** The wrapper does not provide a "native fallback" mode. The agent body's bash pattern MUST include the fallback branch verbatim from F3 (`if OUTPUT=$(...); then ... else rc=$?; case "$rc" in 126) ... ;; 127|124|1) ... ;; esac fi`).

Feature-specific extensions:

7. **Delegation is for *ranking only*, not for substituting the agent.** The conventions doc puts `rerank` and `candidate-filter` on the eligible list precisely because the caller (Claude inside the agent) re-validates the LLM's output. F4a delegates the *score-and-rank* step. Native Claude still: (a) chooses which `grep`/`glob` patterns to run, (b) decides whether the delegate's top-K is sensible, (c) composes the final "## File Locations for …" structured output. The delegate is never asked to write the output text the user sees.
8. **Structured JSON-only output from the delegate.** The delegate's prompt MUST instruct the model to emit a single fenced JSON block of the shape `{"ranked": [{"path": "...", "score": 0..1, "category": "implementation|test|config|docs|types|examples"}, ...], "top_k": N}`. The wrapper's `--validate-json-output` flag (F2 feature, exposed via `openai-compat.sh`) is **not** plumbed through the wrapper today — the agent validates the JSON shape itself with `jq -e` in a guard around the wrapper call. If parse fails, the agent treats it as a fallback exit (matches "Common mistakes" item 1 in the authoring guide for *callers*, not authors).
9. **The candidate set is bounded before delegation.** The delegate is only invoked when the agent has produced at least 5 candidate file paths (a meaningful rerank requires multiple inputs). Below the threshold, the agent skips delegation entirely — there is no useful rerank for ≤4 files, and the audit-log noise would be wasted. Threshold is hard-coded at 5 in v1; configurable later if Wave-3 telemetry shows the wrong number.
10. **Top-K is bounded by request.** The delegate is asked for at most `min(20, len(candidates))` ranked entries. The agent reorders its own candidate list using the ranking and emits the locator's structured output as it does today; if the delegate omits candidates the native list contained, the agent falls back to native order for those.
11. **Per-task env overrides honored.** Operators may pin a different model for this task via `RALPH_DELEGATE_LOCATOR_URL` / `RALPH_DELEGATE_LOCATOR_MODEL`. F1 already resolves these without code changes here — the only requirement is that the agent passes `--task locator` consistently. Verified by smoke check.
12. **Caller field in audit log is `codebase-locator`.** The wrapper resolves `caller` from `RALPH_HOOK_INPUT.tool_input.caller_skill`. F4a does NOT set `RALPH_HOOK_INPUT` itself — it relies on the hook context that the Agent runtime already provides (verified by F1 bats test 8 and F3 operator smoke 1, which both showed `caller` resolved from the live hook payload). If the field arrives as `unknown` in the audit log, this is a hook-context limitation outside F4a's scope; documented in the acceptance criteria as "best effort".
13. **Quality compared, not enforced.** The 5-query eval scenarios document the comparison protocol but do NOT block the merge on a quality bar. Wave-3 establishes the integration; Wave-4 (F5 telemetry) is where ongoing quality monitoring lives.

## Current State Analysis

**What F1+F2+F3 shipped (verified by reading source and git log):**

- `plugin/ralph-hero/scripts/ralph-delegate.sh` (308 lines, merged): the public wrapper. Owns: `RALPH_DELEGATE_ENABLED` opt-in gate, env resolution via `ralph_resolve_env`, per-task overrides (`RALPH_DELEGATE_<TASK_UPPER>_URL`/`_MODEL`), audit-log writes to `~/.ralph-hero/delegate.log`, `--health-check`, `--dry-run`, `--task`, `--max-tokens`, `--temperature`, `--prompt-file`, `--system-file`, exit-code translation (0/1/124/126/127). Sources F2's `lib/openai-compat.sh`.
- `plugin/ralph-hero/scripts/lib/openai-compat.sh` (275 lines, merged): the sourceable adapter. Owns the HTTP+JSON request, `portable_timeout` wrapping, `jq` response parse. Skill/agent code does NOT touch this file directly — wrapper-only.
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (8 tests, green): hermetic Python HTTPServer stub pattern, used as the template for F4a's locator-specific tests.
- `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` (8 tests, green): F2's adapter tests; F4a does NOT modify.
- `plugin/ralph-hero/README.md:249-297` (merged): operator-facing "Delegation (optional)" section with env vars + exit codes + audit-log JSONL shape. F4a does NOT modify this — the README pointer added by F3 already covers the authoring pointer.
- F3 (in flight on `feature/GH-1187`, not yet merged to main as of plan authoring): `plugin/ralph-hero/docs/delegation-authoring.md`, `plugin/ralph-hero/skills/shared/delegation-conventions.md`, `plugin/ralph-hero/skills/delegate-test/SKILL.md`. F4a treats these as soft-prerequisites — its plan cites them, and its acceptance criteria will not be runnable until F3 lands. If F3 merges before F4a starts impl, no change needed. If F4a is dispatched before F3 lands, the impl phase blocks on F3's merge (no `depends_on` shown because both issues are in the same epic's Wave-3 sequencing, but the impl agent will note F3 in `blockedBy` at dispatch time).

**What the `codebase-locator` agent does today (verified by reading `agents/codebase-locator.md`):**

- **File:** `plugin/ralph-hero/agents/codebase-locator.md` (124 lines).
- **Frontmatter:** `name: codebase-locator`, `description: "Locates files, directories, and components relevant to a feature or task..."`, `tools: Grep, Glob, Bash`, `model: haiku`, `color: orange`.
- **Body sections:** "CRITICAL: YOUR ONLY JOB IS TO DOCUMENT...", "Core Responsibilities" (find files / categorize / return structured), "Search Strategy" (Initial Broad Search / Refine by Language / Common Patterns), "Output Format" (the structured "## File Locations for [Feature/Topic]" section with subsections), "Important Guidelines", "What NOT to Do", "REMEMBER: You are a documentarian".
- **Search workflow today:**
  1. Run `Grep` and/or `Glob` for keywords + globs deduced from the user's prompt.
  2. Optionally `Bash` `ls` to explore directories.
  3. Implicitly rank/filter the resulting paths in-context (Haiku reads filenames, decides relevance based on the user's locate goal).
  4. Emit a structured Markdown "## File Locations for [Feature/Topic]" with subsections grouping by purpose (Implementation Files / Test Files / Configuration / Type Definitions / Related Directories / Entry Points).
- **Caller pattern:** Dispatched as `Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find all files related to [topic]")` from two places — `skills/ralph-research/SKILL.md:180` and `skills/research/SKILL.md:105`. Both invocations use natural-language prompts; the agent body interprets and acts on them.

**What does NOT exist (verified by file listings):**

- No agent currently calls `ralph-delegate.sh`. F4a is the first.
- No `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` — F4a creates it.
- No `eval-scenarios.md` for the codebase-locator agent (agents do not currently use the eval-scenarios.md convention; that lives at the skill layer). F4a introduces a single-file eval-set document at `plugin/ralph-hero/agents/codebase-locator-eval.md` for the 5-query comparison.
- No JSON schema document for the delegate's expected output (the wrapper is text-in/text-out; F4a inlines the schema-by-example in the prompt and validates with `jq -e`).

**Tooling assumptions on the target machine:**

- `bash` (4.x or 5.x), `curl`, `jq`, `mktemp`, `wc`, `python3` (for the bats stub) — same as F1/F2/F3.
- The Agent runtime makes `$CLAUDE_PLUGIN_ROOT` available inside `Bash` tool calls from agents (verified by `plugin/ralph-hero/agents/*` already using `$CLAUDE_PLUGIN_ROOT/scripts/...` in their bodies — search confirms multiple agents reference plugin scripts this way).
- The Agent runtime allows `Bash` to invoke arbitrary scripts on the operator's machine (no hook intercepts `ralph-delegate.sh` per F1's acceptance criterion 7).

## Desired End State

After F4a merges:

1. `plugin/ralph-hero/agents/codebase-locator.md` is updated to include an explicit "Candidate Ranking" subsection in its "Search Strategy" section. The subsection documents the delegated ranking path, the native fallback path, and the agent's responsibility to compose the final output regardless of which path ran. The wording is operational, not hand-wavy — a Haiku-tier model reading the body MUST be able to execute the ranking step correctly in both paths.
2. The agent body includes a copy-paste-ready bash block in the new "Candidate Ranking" subsection that wraps the wrapper call in the canonical F3 control flow. The block:
   - Builds a tempfile prompt containing the locate goal + the candidate file list.
   - Calls `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task locator --prompt-file <tempfile> --max-tokens 512 --temperature 0.0` inside `if OUTPUT=$(...)`.
   - On exit 0: `jq -e '.ranked'` validates the JSON shape. Pass → agent uses the ranking. Fail → treats as native fallback (logs nothing additional; the wrapper already wrote `status=ok` but the agent privately discards the un-usable output).
   - On exit 126: silently uses native ranking.
   - On exit 127/124/1: surfaces a one-line `delegation: fell back to native (rc=$rc)` note above the structured output, uses native ranking.
   - Cleans up the tempfile unconditionally.
3. `plugin/ralph-hero/agents/codebase-locator-eval.md` exists. It defines 5 fixed queries, the expected high-relevance file paths for each (the "gold set"), and a comparison protocol (overlap % at top-5 between delegated vs native rankings; manual eyeball acceptable in v1). Re-runnable by an operator following the documented steps.
4. `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` exists. It contains a small bats suite that exercises the agent's bash block in isolation (extracted from the agent body, or replicated 1:1) against the F1 Python HTTPServer stub pattern. Covers: delegation enabled + ok stub returning JSON, delegation enabled + malformed stub returning non-JSON (jq guard trips, falls back), delegation enabled + slow stub (timeout 124), delegation disabled (126 path), endpoint unreachable (127 path). 5 tests total.
5. The agent's existing tool list (`Grep, Glob, Bash`) is unchanged — `Bash` already covers the wrapper invocation.
6. The agent's structured output shape ("## File Locations for [Feature/Topic]" with subsections) is unchanged regardless of delegation path. The ranking changes the *order* of files within each subsection; it does not change the section headers or category buckets.
7. With `RALPH_DELEGATE_ENABLED` unset (the default), `codebase-locator` does not invoke `ralph-delegate.sh` at all — no audit-log line, no tempfile churn, no behavioral drift. Verified by the bats test for 126 path + by an operator smoke check.
8. With `RALPH_DELEGATE_ENABLED=true` and `gemma-up` running, invoking `codebase-locator` (via `Agent()` or via the `/ralph-hero:research` skill) appends one `task=locator, status=ok` JSONL line per agent run to `~/.ralph-hero/delegate.log`.
9. With `RALPH_DELEGATE_ENABLED=true` and `gemma-down`, invoking the agent prints the `delegation: fell back to native (rc=127)` line in the agent's output and appends one `task=locator, status=unreachable` JSONL line.
10. The 5 issue-defined acceptance criteria are satisfied (see Verification below).

### Verification

- [ ] **End-to-end with real endpoint** (manual): `gemma-up && export RALPH_DELEGATE_ENABLED=true`, then dispatch `codebase-locator` for a known query (e.g., "Find files related to delegation in plugin/ralph-hero"). Output is the standard structured "## File Locations for …" markdown. The audit log gains one `task=locator, status=ok` JSONL line. The ranking demonstrably differs from a parallel native run (i.e., the file order inside Implementation Files differs at least once across the 5 eval queries).
- [ ] **End-to-end with endpoint down** (manual): with delegation enabled but gemma killed, dispatch the same query. Output contains a `delegation: fell back to native (rc=127)` line above the structured output. The audit log gains one `status=unreachable` JSONL line.
- [ ] **End-to-end with delegation disabled** (manual): with `RALPH_DELEGATE_ENABLED` unset, dispatch the same query. Output is byte-identical to today's output (no delegation note, same structure, ranked by native Haiku in-context judgment). Audit log file is byte-identical before and after.
- [ ] **JSON-shape guard** (manual): point the agent at a stub that returns a chat-completion with content `"not really json"`. The agent's `jq -e` guard trips, the agent falls back to native ranking with a `delegation: fell back to native (rc=0 + bad-json)` note. Audit log records `status=ok` (the wrapper succeeded at the HTTP layer; the parse failure is the agent's concern, not the wrapper's).
- [ ] **5-query eval comparison** (manual): run the 5 queries from `agents/codebase-locator-eval.md` once with delegation on and once with delegation off. Capture the top-5 file paths from each Implementation Files section. Compute overlap % (intersection / union × 100). Document the per-query overlap in a comment on issue #1188; minimum acceptable: 60% mean overlap across the 5 queries. (60% is a starting baseline, not a hard SLA — wave-3 calibrates it.)
- [ ] **No-regression**: `bats plugin/ralph-hero/scripts/__tests__` runs all existing tests + the new `codebase-locator-delegation.bats` (5 new tests) — all green.
- [ ] **TypeScript builds**: `npm run build` and `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched but the matrix runs).
- [ ] **CI green**: `test-cli`, `test-hooks`, `test-matrix` jobs all green on the PR.

## What We're NOT Doing

- **NOT** delegating the agent's *entire* job. Native Claude still composes the structured "## File Locations for [Feature/Topic]" markdown output. Only the in-context candidate-ranking decision is delegated.
- **NOT** delegating the candidate *gathering* step. `Grep` and `Glob` still run in-process (those aren't delegate-eligible tasks per the conventions doc — they're tool calls, not text-generation sub-tasks).
- **NOT** plumbing `--validate-json-output` through `ralph-delegate.sh`. The wrapper doesn't expose this flag today (F2 has it on `openai-compat.sh`); F4a validates the JSON shape inside the agent body with `jq -e`. If a future feature wants to plumb the flag, that's a wrapper change tracked separately.
- **NOT** introducing telemetry. F5 (`#1191`) owns `ralph status --delegation` and per-task aggregations.
- **NOT** touching the sibling F4 integrations. F4b (`pr-agent`, #1189) and F4c (`val-agent`, #1190) are independent plans owned by their own issues.
- **NOT** modifying `ralph-delegate.sh`, `openai-compat.sh`, F1's bats suite, or F2's bats suite.
- **NOT** modifying the agent's tool list (`Grep, Glob, Bash`) — `Bash` already covers the wrapper invocation, no new tool needed.
- **NOT** modifying the callers (`ralph-research` skill, `research` skill). Both invoke the agent via natural-language `Agent()` calls; the wire-level change is invisible to them.
- **NOT** changing the agent's structured output format ("## File Locations for [Feature/Topic]" with subsections). Reorders within subsections happen; subsection categories do not change.
- **NOT** building a Python or Node helper for prompt construction. The agent body's bash block uses `cat > $PROMPT_FILE` to compose the prompt — same pattern as F3's reference skill.
- **NOT** introducing an MCP tool for delegation. Per the conventions doc, agent/skill code calls the wrapper via `Bash`, period.
- **NOT** changing the agent's model tier (haiku). The wrapper handles the heavier-model delegation when enabled; Haiku's role is unchanged in the native path.
- **NOT** providing a fallback for the case where the `jq` binary is missing. `jq` is a hard dep for the wrapper itself (F1/F2 already require it); if `jq` is missing, the wrapper fails first with exit 1 before the agent ever sees the JSON.
- **NOT** adding eval automation. The `codebase-locator-eval.md` document is operator-runnable; automation lives in a future feature if the operator wants nightly drift detection.

## Implementation Approach

Implementation proceeds in three task groups inside a single phase. Tasks 1.1 and 1.2 can be done in either order; Task 1.3 depends on 1.1 + 1.2 because the bats tests exercise the bash block that 1.1 introduces.

1. **Agent body update.** Edit `plugin/ralph-hero/agents/codebase-locator.md` to insert a "Candidate Ranking" subsection in "Search Strategy". The subsection includes the worked bash block (copy-paste from F3's `delegate-test` skill, swap classify → locator, swap sentiment → ranking JSON). The agent body MUST remain coherent: existing "CRITICAL: YOUR ONLY JOB IS TO DOCUMENT..." preamble still applies, existing "Output Format" still applies.
2. **Eval-set document.** Author `plugin/ralph-hero/agents/codebase-locator-eval.md` with 5 fixed queries against the ralph-hero repo, the expected high-relevance file paths for each, and the operator-runnable comparison protocol. The 5 queries are chosen to cover the agent's typical use cases: (a) locate by feature (e.g., "delegation"), (b) locate by component type (e.g., "skills that mutate GitHub state"), (c) locate by file extension/glob (e.g., "all *.bats files and what they test"), (d) locate by recency (e.g., "code merged in the last 10 commits"), (e) locate cross-cutting concern (e.g., "every place RALPH_LLM_URL is consumed").
3. **Bats coverage.** Create `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats`. 5 tests, each replicating the agent's bash block in isolation (or extracting it via `sed` if a clean extraction script exists in F1's patterns — verified: it does not, so replicate). Stubs reuse the F1 Python HTTPServer pattern. Test cases: (1) delegated path returns valid JSON → ranking applied; (2) delegated path returns malformed JSON → `jq -e` guard trips, falls back; (3) delegated path times out → 124, falls back; (4) delegation disabled → 126, no log line, falls back silently; (5) endpoint unreachable → 127, falls back with note.

There is exactly one Phase. No `depends_on` between phases is needed; the task-level `depends_on` field captures intra-phase order.

---

## Phase 1: GH-1188 — `codebase-locator` candidate ranking via delegation
- **depends_on**: null

### Overview

Wire the `codebase-locator` agent's candidate-ranking step to optionally delegate to `ralph-delegate.sh --task locator`. Native Claude still composes the structured "## File Locations for …" output; the delegate only contributes a relevance-ranked top-K JSON when enabled. Includes a 5-query eval document for ongoing quality comparison and a bats test suite exercising the agent's bash control flow against a hermetic HTTPServer stub.

### Tasks

#### Task 1.1: Update `codebase-locator.md` to embed the delegation pattern
- **files**: `plugin/ralph-hero/agents/codebase-locator.md` (modify), `plugin/ralph-hero/skills/delegate-test/SKILL.md` (read — control-flow template), `plugin/ralph-hero/docs/delegation-authoring.md` (read — worked example), `plugin/ralph-hero/skills/shared/delegation-conventions.md` (read — eligibility justification), `plugin/ralph-hero/scripts/ralph-delegate.sh` (read — CLI surface)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The agent's frontmatter is unchanged (`name`, `description`, `tools: Grep, Glob, Bash`, `model: haiku`, `color: orange` — all identical).
  - [ ] A new H2 subsection `## Candidate Ranking (optional delegation)` is inserted in the agent body **between** the existing "Search Strategy" H2 and the existing "Output Format" H2. The placement reflects the agent's operational order: gather (Search Strategy) → rank (new section) → format (Output Format).
  - [ ] The new section opens with a 2-3-sentence overview: after the broad search produces ≥5 candidates, the agent MAY delegate the relevance-ranking step to a local LLM via `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh`. Delegation is opt-in (operator sets `RALPH_DELEGATE_ENABLED=true`); when off, the agent ranks natively as today. Below the 5-candidate threshold, the agent skips delegation entirely.
  - [ ] The section contains a fenced bash block that is structurally identical to the F3 reference skill's `## Workflow` block (set +e, `if OUTPUT=$(...)` guard, case "$rc" handling, unconditional `rm -f`). The block:
    - Composes a prompt of the shape:
      ```
      You are ranking files for relevance to a locate goal.
      Locate goal: ${GOAL}
      Candidates (one per line):
      ${CANDIDATES}

      Return a JSON object with this exact shape — no prose before or after:
      {"ranked": [{"path": "<path>", "score": 0.0..1.0, "category": "implementation|test|config|docs|types|examples"}, ...], "top_k": N}
      Sort by score descending. Limit ranked to min(20, len(candidates)).
      ```
    - Calls `"$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" --task locator --prompt-file "$PROMPT_FILE" --max-tokens 512 --temperature 0.0 2>/dev/null` inside an `if OUTPUT=$(...)` guard.
    - Validates the response with `RANKED_JSON=$(printf '%s' "$OUTPUT" | jq -e .ranked 2>/dev/null)`; on `jq -e` failure, treats it as a fallback path and surfaces `delegation: fell back to native (rc=0, bad-json)`.
    - On exit 0 + valid JSON: applies the ranking by reordering candidate paths within each output subsection.
    - On exit 126: silently ranks natively (no note printed, per the 126-no-log invariant in `docs/delegation-authoring.md`).
    - On exit 127/124/1: prints `delegation: fell back to native (rc=$rc)` ABOVE the structured output, then ranks natively.
    - `rm -f "$PROMPT_FILE"` runs unconditionally at the end (outside the `if/else/fi`).
  - [ ] The section explicitly notes: "Delegation is for **ranking only**. You (the agent) still compose the structured `## File Locations for [Feature/Topic]` output below. Never let the delegate's output reach the user directly." This matches conventions doc rationale for `rerank` being eligible.
  - [ ] The section mentions the per-task override env vars (`RALPH_DELEGATE_LOCATOR_URL`, `RALPH_DELEGATE_LOCATOR_MODEL`) in a one-liner — not as documentation, but as a hint that operators may pin a different model for this task.
  - [ ] The agent's existing "CRITICAL: YOUR ONLY JOB IS TO DOCUMENT..." preamble, "Core Responsibilities", "Output Format" structured example, "Important Guidelines", "What NOT to Do", and "REMEMBER" closing are all unchanged in wording. Only the new H2 section is added.
  - [ ] The total file size grows by 40-80 lines (roughly the size of the new section). If it grows past 100 added lines, the section is too verbose — trim the bash block comments or the rationale paragraphs.
  - [ ] `bash -n` syntax-checks cleanly against the bash block (extract with `sed -n '/^```bash$/,/^```$/p' plugin/ralph-hero/agents/codebase-locator.md | sed '1d;$d' | bash -n -`).
  - [ ] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/agents/codebase-locator.md` returns `1` (single wrapper call, no accidental loop).
  - [ ] `grep -c 'openai-compat.sh' plugin/ralph-hero/agents/codebase-locator.md` returns `0` (agent does NOT call the adapter directly — must go through wrapper).
  - [ ] `grep -c '\-\-task locator' plugin/ralph-hero/agents/codebase-locator.md` returns `1` (task name is hardcoded once for stable audit-log lookup).

#### Task 1.2: Author `codebase-locator-eval.md` with 5 fixed queries
- **files**: `plugin/ralph-hero/agents/codebase-locator-eval.md` (create), `plugin/ralph-hero/skills/ralph-split/eval-scenarios.md` (read — style template), `plugin/ralph-hero/agents/codebase-locator.md` (read — agent's expected output format)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/agents/codebase-locator-eval.md`, opens with frontmatter matching the `eval-scenarios.md` style template:
    ```yaml
    ---
    type: eval-scenarios
    agent: codebase-locator
    date: 2026-05-12
    status: defined
    ---
    ```
  - [ ] File body opens with H1 `# Codebase-Locator Delegation Eval`.
  - [ ] Opens with a 1-paragraph "Execution note": these are operator-runnable comparison scenarios for the codebase-locator agent's delegated vs native ranking. Re-runnable as quality drifts. Not automated in v1.
  - [ ] Defines exactly 5 queries against the **ralph-hero** repo (not arbitrary external repos — the agent runs in this repo's context):
    1. **Q1 — feature search**: "Find all files related to LLM delegation in plugin/ralph-hero." Gold set: `scripts/ralph-delegate.sh`, `scripts/lib/openai-compat.sh`, `scripts/__tests__/ralph-delegate.bats`, `scripts/__tests__/openai-compat.bats`, `README.md` (Delegation section), `docs/delegation-authoring.md`, `skills/shared/delegation-conventions.md`, `skills/delegate-test/SKILL.md`, `agents/codebase-locator.md` (after F4a).
    2. **Q2 — component-type search**: "Find all skills that mutate GitHub state (call save_issue, create_comment, advance_issue, or batch_update)." Gold set: a subset of `plugin/ralph-hero/skills/ralph-*` that have those tool calls in their `allowed-tools` and bodies. (Operator validates by inspecting each candidate.)
    3. **Q3 — file-extension search**: "Find all bats test files in plugin/ralph-hero/scripts/__tests__/ and list which source script each covers." Gold set: 6 bats files (`cli-dispatch.bats`, `doctor.bats`, `openai-compat.bats`, `ralph-cli.bats`, `ralph-delegate.bats`, `resolve-env.bats`) + their corresponding `../*.sh` files.
    4. **Q4 — recency search**: "Find all files modified in the last 10 commits on main." Gold set: the file list from `git log --name-only --pretty=format: HEAD~10..HEAD | sort -u`. (Re-computed at run time.)
    5. **Q5 — cross-cutting concern**: "Find every place RALPH_LLM_URL is consumed or referenced." Gold set: `plugin/ralph-knowledge/src/llm-client.ts`, `scripts/dream/reflect.py`, `plugin/ralph-hero/scripts/ralph-delegate.sh`, `plugin/ralph-hero/scripts/lib/openai-compat.sh`, `plugin/ralph-hero/README.md`, `plugin/ralph-hero/CLAUDE.md` (if it references the var), and any test files that set it.
  - [ ] For each query, the document lists:
    - The exact query string (one-liner, copy-paste-ready).
    - The gold set of file paths (5-15 paths).
    - One sentence on what the query exercises (feature search / type search / extension search / recency / cross-cutting).
  - [ ] Includes a "Comparison protocol" section documenting how to run the eval:
    1. With `RALPH_DELEGATE_ENABLED=true && gemma-up`, dispatch the agent with each query. Capture the agent's top-5 paths from the Implementation Files subsection.
    2. With `unset RALPH_DELEGATE_ENABLED`, repeat. Capture top-5 again.
    3. For each query, compute `overlap_pct = (delegated_top5 ∩ native_top5) / (delegated_top5 ∪ native_top5) * 100`.
    4. Compute mean overlap across the 5 queries. Document the result in a comment on issue #1188.
    5. Acceptable baseline: 60% mean overlap. Below 60% triggers a quality review (probably model swap or prompt refinement); not a merge blocker — calibration metric.
  - [ ] Includes a brief "What this does NOT measure" section: this eval compares ranking agreement, not absolute correctness. The gold set is approximate; both delegated and native paths may legitimately disagree with it.
  - [ ] No more than ~140 lines total. The eval is operator documentation, not a benchmark report.

#### Task 1.3: Write `codebase-locator-delegation.bats` covering the agent's bash block
- **files**: `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (create), `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (read — stub pattern), `plugin/ralph-hero/agents/codebase-locator.md` (read — the bash block under test)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats`. Shebang `#!/usr/bin/env bats`. File-level comment explains: exercises the ranking-step bash block from `agents/codebase-locator.md` against a hermetic Python HTTPServer stub; mirrors F1's bats pattern.
  - [ ] `setup()` and `teardown()` are byte-identical to `ralph-delegate.bats:9-30` — `TEST_TMPDIR=$(mktemp -d)`, exports `RALPH_DELEGATE_LOG_PATH`, unsets caller env vars including the per-task overrides (`RALPH_DELEGATE_LOCATOR_URL`, `RALPH_DELEGATE_LOCATOR_MODEL`), starts/stops STUB_PID/STUB_PORT.
  - [ ] A helper function `start_locator_stub_endpoint <mode>` is defined. Modes: `valid_json` (returns chat-completion content `'{"ranked":[{"path":"a","score":0.9,"category":"implementation"},{"path":"b","score":0.5,"category":"test"}],"top_k":2}'`), `malformed_content` (returns chat-completion content `"not really json"`), `slow` (sleeps 3s), `ok_default` (returns a generic ok chat-completion). Copy the Python HTTPServer stub from `ralph-delegate.bats:41-119` adapted for these modes.
  - [ ] An extracted-or-replicated bash function `run_locator_rank()` represents the agent's bash block under test. It accepts a goal string + a candidates string (newline-joined), composes the prompt, invokes the wrapper, validates JSON via `jq -e`, and prints either the ranking JSON (success) or a fallback marker line (`FALLBACK rc=$rc`). The test asserts on the function's output. Document in a comment at the top of the bats file: "The function under test mirrors the bash block in `agents/codebase-locator.md` section 'Candidate Ranking'. Update both in lockstep."
  - [ ] **Test 1 — happy path (delegated, valid JSON)**: starts `valid_json` stub, sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:$STUB_PORT`. Runs `run_locator_rank "find delegation" "a\nb\nc"`. Asserts function output contains `"ranked":[{"path":"a"`. Asserts one JSONL line in `$RALPH_DELEGATE_LOG_PATH` with `"task":"locator"` and `"status":"ok"`.
  - [ ] **Test 2 — bad JSON from delegate**: starts `malformed_content` stub. Runs the function. Asserts function output starts with `FALLBACK rc=0` (the wrapper succeeded, but the agent's `jq -e` guard tripped). Asserts the JSONL line records `"status":"ok"` — the wrapper succeeded at the HTTP layer; the parse failure is the agent's concern.
  - [ ] **Test 3 — timeout**: starts `slow` stub. Sets `RALPH_DELEGATE_TIMEOUT_SECONDS=1` (the wrapper enforces this via `portable_timeout`). Runs the function. Asserts function output starts with `FALLBACK rc=124`. Asserts the JSONL line records `"status":"timeout"`.
  - [ ] **Test 4 — disabled**: does NOT set `RALPH_DELEGATE_ENABLED`. Does NOT start a stub. Runs the function. Asserts function output is exactly `FALLBACK rc=126`. Asserts the audit log file is BYTE-IDENTICAL before and after (capture `wc -c` pre/post; no log line on 126).
  - [ ] **Test 5 — unreachable**: sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:1` (or a port nothing's listening on). Does NOT start a stub. Runs the function. Asserts function output starts with `FALLBACK rc=127`. Asserts the JSONL line records `"status":"unreachable"`.
  - [ ] Each test is hermetic: no global state leaks between tests, teardown cleans up STUB_PID and TEST_TMPDIR.
  - [ ] `bats plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` passes locally and in CI (the existing `.github/workflows/ci.yml:124-129` bats glob auto-picks it up — no CI YAML change required).
  - [ ] `grep -c 'task=locator\|"task":"locator"' plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` returns ≥3 (multiple tests reference the task name for audit-log assertions).
  - [ ] No regression: `bats plugin/ralph-hero/scripts/__tests__` (the whole directory) — all 21 tests (16 pre-existing + 5 new) pass.

### Phase Success Criteria

#### Automated Verification:

- [ ] `bats plugin/ralph-hero/scripts/__tests__` — all 21 tests pass (no regression in F1's 8 ralph-delegate tests or F2's 8 openai-compat tests; 5 new codebase-locator-delegation tests green).
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` — green (TS source unchanged but matrix runs).
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched).
- [ ] CI `test-cli` job — green on the PR.
- [ ] CI `test-hooks` job — green on the PR.
- [ ] CI matrix builds (Node 18, 20, 22) — green.
- [ ] `find plugin/ralph-hero/agents -name 'codebase-locator-eval.md' | wc -l` returns `1` (eval file exists).
- [ ] `find plugin/ralph-hero/scripts/__tests__ -name 'codebase-locator-delegation.bats' | wc -l` returns `1` (bats file exists).
- [ ] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/agents/codebase-locator.md` returns `1` (single wrapper invocation in agent body).
- [ ] `grep -c 'openai-compat.sh' plugin/ralph-hero/agents/codebase-locator.md` returns `0` (no direct adapter call from the agent).
- [ ] `grep -c '## Candidate Ranking' plugin/ralph-hero/agents/codebase-locator.md` returns `1` (new section is present and headed correctly).

#### Manual Verification:

- [ ] **Smoke 1 (delegated path)**: `gemma-up && export RALPH_DELEGATE_ENABLED=true`, then dispatch the agent for Q1 ("Find all files related to LLM delegation in plugin/ralph-hero"). The agent's output has the standard `## File Locations for …` shape with at least the Implementation Files subsection. The audit log gains one JSONL line with `task=locator, status=ok`.
- [ ] **Smoke 2 (unreachable path)**: kill gemma-lab (`gemma-down` or `pkill -f mlx-openai-server`), keep `RALPH_DELEGATE_ENABLED=true`, run the same query. Output contains a `delegation: fell back to native (rc=127)` line above the structured output. The audit log gains one `status=unreachable` line.
- [ ] **Smoke 3 (disabled path)**: `unset RALPH_DELEGATE_ENABLED` and run the same query. Output has the structured shape, no delegation note above it. The audit log file size is unchanged.
- [ ] **Smoke 4 (per-task override)**: `RALPH_DELEGATE_LOCATOR_MODEL=mlx-community/qwen-3.5-27b-it RALPH_DELEGATE_ENABLED=true gemma-up` then run the agent. The audit log line records `model=mlx-community/qwen-3.5-27b-it` (override honored). The structured output is otherwise unchanged.
- [ ] **5-query eval comparison**: run the 5 queries from `agents/codebase-locator-eval.md` once with delegation on and once with delegation off. Compute mean overlap %. Document in a comment on issue #1188. Mean overlap is reported as a number (not a verdict — calibration metric).
- [ ] **No leftover tempfiles**: after running smokes 1-3 once each, `find /tmp -name '*.locator*' -o -name 'tmp.*' -mmin -5 2>/dev/null | wc -l` returns 0. (The agent's bash block uses `mktemp` without a prefix today, matching F3's reference skill; the assertion is loose because `mktemp`'s naming is platform-specific.)
- [ ] **Document readthrough**: read `agents/codebase-locator-eval.md` cover-to-cover — can an operator re-run the 5-query eval in under 5 minutes following only this document? Yes.
- [ ] **Worked-example fidelity**: open `agents/codebase-locator.md` (new section), `skills/delegate-test/SKILL.md`, and `docs/delegation-authoring.md` side-by-side — the wrapper-call control flow (set +e + if OUTPUT=$(...) + case "$rc" + unconditional rm -f) is structurally identical in all three. The agent's bash block has an extra `jq -e` guard for the structured-JSON output; that is the only intentional deviation.

**Creates for next phase**: Production precedent for delegation in a real agent (vs the F3 reference skill, which is a smoke-test). The bash-block-in-an-agent-body pattern is the template F4b (pr-agent, #1189) and F4c (val-agent, #1190) copy. The JSONL audit log gains its first non-smoke-test `task=locator` lines, which Wave-4 telemetry (F5, #1191) will aggregate. The eval-set document is the template for F4b/F4c's own eval files when they ship.

---

## Integration Testing

- [ ] **End-to-end with real endpoint** (manual, smoke 1): `gemma-up && export RALPH_DELEGATE_ENABLED=true && Agent(subagent_type="ralph-hero:codebase-locator", prompt="Find all files related to LLM delegation in plugin/ralph-hero")` produces a structured "## File Locations for …" output. Audit log has one `task=locator, status=ok` line.
- [ ] **End-to-end with endpoint down** (manual, smoke 2): with delegation enabled but gemma killed, the same agent dispatch prints a `delegation: fell back to native (rc=127)` line above the structured output; audit log records `status=unreachable`.
- [ ] **End-to-end with delegation disabled** (manual, smoke 3): with `RALPH_DELEGATE_ENABLED` unset, the agent's output is byte-identical to today's (no delegation note, same structure). Audit log unchanged.
- [ ] **Caller field in audit log** (manual): inspect the JSONL line written during smoke 1 — `caller` field is `codebase-locator` (best-effort, resolved from the live hook payload). If `caller=unknown`, this is a hook-context limitation outside F4a's scope.
- [ ] **Per-task override honored** (manual, smoke 4): setting `RALPH_DELEGATE_LOCATOR_MODEL` overrides the default model; audit log records the override.
- [ ] **No-regression** (automated): with delegation disabled (CI default), F1+F2 bats suites and `npm test` all stay green on the PR.
- [ ] **5-query overlap baseline** (manual): mean overlap % from `agents/codebase-locator-eval.md` is documented in a comment on issue #1188. Calibration metric, not a hard gate.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1188
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 plan (foundation, merged): [thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md)
- F2 plan (adapter extraction, merged): [thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md)
- F3 plan (skill authoring pattern, in flight): [thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md)
- Sibling F4b plan (not yet written, pr-agent integration): https://github.com/cdubiel08/ralph-hero/issues/1189
- Sibling F4c plan (not yet written, val-agent integration): https://github.com/cdubiel08/ralph-hero/issues/1190
- Agent under modification: `plugin/ralph-hero/agents/codebase-locator.md`
- Wrapper (the delegation surface): `plugin/ralph-hero/scripts/ralph-delegate.sh`
- F2 adapter (NOT called directly by agent): `plugin/ralph-hero/scripts/lib/openai-compat.sh`
- F3 reference skill (control-flow template): `plugin/ralph-hero/skills/delegate-test/SKILL.md` (in flight on `feature/GH-1187`)
- F3 authoring guide: `plugin/ralph-hero/docs/delegation-authoring.md` (in flight on `feature/GH-1187`)
- F3 conventions doc: `plugin/ralph-hero/skills/shared/delegation-conventions.md` (in flight on `feature/GH-1187`)
- F1 wrapper bats suite (stub pattern template): `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- Caller invocation sites: `plugin/ralph-hero/skills/ralph-research/SKILL.md:180`, `plugin/ralph-hero/skills/research/SKILL.md:105`
- Eval-scenarios style template: `plugin/ralph-hero/skills/ralph-split/eval-scenarios.md`
- README Delegation section: `plugin/ralph-hero/README.md:249-297`
- CI bats integration: `.github/workflows/ci.yml:124-129`
