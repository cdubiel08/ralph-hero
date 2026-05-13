---
date: 2026-05-12
status: draft
type: plan
github_issue: 1190
github_issues: [1190]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1190
primary_issue: 1190
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, val-agent, ralph-val, classification, pass-fail, agent-delegation, bash-delegation, wave-3]
---

# F4c — `val-agent`: Pass/Fail Classification via Delegation

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: [[2026-05-12-GH-1185-ralph-delegate-sh-foundation]]
- builds_on:: [[2026-05-12-GH-1186-openai-compat-shell-adapter]]
- builds_on:: [[2026-05-12-GH-1187-skill-authoring-pattern-delegate-test]]
- builds_on:: [[2026-05-12-GH-1188-codebase-locator-delegation]]
- builds_on:: [[2026-05-12-GH-1189-pr-agent-description-delegation]]
- references:: `plugin/ralph-hero/skills/ralph-val/SKILL.md` — the skill body F4c wires delegation into (the actual workflow; the agent file is a 1-line preloader)
- references:: `plugin/ralph-hero/agents/val-agent.md` — 11-line skill preloader (NOT modified by F4c; structural sibling of F4b's choice to leave `agents/pr-agent.md` untouched)
- references:: `plugin/ralph-hero/scripts/ralph-delegate.sh` — F1 wrapper (the single delegation surface)
- references:: `plugin/ralph-hero/scripts/lib/openai-compat.sh` — F2 adapter (NOT called directly)
- references:: `plugin/ralph-hero/skills/delegate-test/SKILL.md` — F3 reference skill (control-flow template)
- references:: `plugin/ralph-hero/docs/delegation-authoring.md` — F3 authoring guide (worked example + exit-code crib sheet)
- references:: `plugin/ralph-hero/skills/shared/delegation-conventions.md` — F3 conventions doc (`classify` is on the eligible list with explicit "closed enum, 3-5 tokens" rationale)
- references:: `plugin/ralph-hero/agents/codebase-locator.md` (F4a, merged) — sibling production-agent integration; structural template for the bash control flow + JSON-shape guard pattern
- references:: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (F4b, merged) — sibling production-skill integration; closest structural template (skill body, not agent body)
- references:: `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (F4a) — bats stub pattern (Python HTTPServer)
- references:: `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` (F4b) — bats stub pattern with threshold-gate test (closest sibling)
- references:: `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md` — existing 3-scenario val-skill eval doc (parallel style template for the new eval document)

## Overview

[N=1] single-issue plan for the LLM delegation epic's third and final Wave-3 production integration:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1190 | F4c — val-agent: pass/fail classification via delegation | S |

Wire the `ralph-val` skill's verdict-classification step (Step 7 of `skills/ralph-val/SKILL.md`) to optionally delegate the **pass/fix/fail classification decision** to `ralph-delegate.sh` (task name `val_classify`). The skill already runs automated checks (Step 6), gathers drift logs (Step 6.5), and runs cross-phase integration (Step 6.6); today it classifies the aggregate result (PASS/FIX/FAIL) by reading the check outputs and failure types in-context. After this feature, when `RALPH_DELEGATE_ENABLED=true` is set, a compact (plan-summary, impl-summary, automated-check-results) blob is sent to a local LLM (gemma-lab) which returns a strict 3-value enum decision (`pass`|`fail`|`needs-review`). Native Claude still: (a) decides whether the delegate's classification is sensible, (b) composes the full verdict comment with the `VALIDATION PASS|FIX|FAIL` prefix and all detail sections, (c) posts the `## Validation` GitHub comment. The `create_comment` MCP call is **never** delegated.

This is the third Wave-3 pilot — it copies F4b's wrapper-only, JSON-shape-guarded, threshold-gated delegation pattern but applies it to `classify` (map a multi-signal validation result to a 3-value enum) rather than `summarize` (compress diff to 1-3 sentences) or `rerank` (sort candidate list). F4a (`codebase-locator`, #1188) and F4b (`pr-agent`, #1189) are the closest structural templates. The mutation step (`create_comment` writing the `## Validation` comment) is preserved exactly as-is in Step 8; the delegate-eligible work is exclusively the classification sub-decision that feeds the verdict-prefix selection in Step 7.

Important boundary: the F4c task name in the audit log is `val_classify` (per the issue acceptance criteria), not `classify`. This is intentional — the conventions doc's eligible list says "classify" as a generic task type, but the operator-facing audit log uses task names scoped to the skill (`locator`, `pr_description`, `val_classify`) so per-task overrides and per-task telemetry stay unambiguous.

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`) and F1/F2/F3/F4a/F4b plans:

1. **Opt-in only.** All new behavior is gated on `RALPH_DELEGATE_ENABLED=true`. With the variable unset (default), `ralph-val` MUST behave bit-identically to today — same tool calls, same verdict text, same `## Validation` comment body, no audit-log writes, no extra stdout. (F4a/F4b Shared Constraint #1; same semantics.)
2. **Reuse the wrapper, not the adapter.** The skill MUST call `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task val_classify` (NOT `lib/openai-compat.sh` directly). Per the conventions doc, the adapter is internal; skills always go through the wrapper for the opt-in gate, env resolution, and audit log.
3. **Fail-open with audit trail.** The skill obeys the 5-value exit-code contract (0/1/124/126/127). Non-zero exits MUST trigger native classification — never crash, never block the verdict-output flow. Specifically, the skill MUST still produce a `VALIDATION PASS|FIX|FAIL` verdict line (the `val-postcondition.sh` Stop hook requires it) regardless of which path produced it.
4. **No GitHub mutations from the delegate.** The wrapper returns text (a 3-value enum). That enum is one input to Claude's native verdict composition. The `create_comment` call (the only GitHub-state mutation in Step 8) is composed natively after the delegate returns and uses Claude's full reasoning — including the delegate's classification, the per-check results, drift analysis, and cross-phase integration findings. Per the conventions doc ineligibility row "tool-call mutations: ... [skills] must not turn that text into a mutation without a native review step" — the native review step here is Claude reading the delegated classification *plus* the underlying check details before composing the comment body. F4c specifically does NOT replace the verdict; it provides a classification opinion that the skill cross-checks against the automated-check results.
5. **No-regression invariant.** Pre-existing usage of `ralph-val` (called from hero, autopilot, the loop runner, and manually) MUST produce byte-identical `## Validation` comment output structure when delegation is off. F1's 8 bats tests, F2's 8 bats tests, F4a's 5 bats tests, and F4b's 7 bats tests MUST continue to pass. Existing `npm test`, CI matrix, and the existing 3-scenario eval at `skills/ralph-val/eval-scenarios.md` MUST stay green.
6. **Caller is responsible for fallback.** The wrapper does not provide a "native fallback" mode. The skill body's bash pattern MUST include the fallback branch verbatim from F3 / F4a / F4b (`set +e; if OUTPUT=$(...); then ... else rc=$?; case "$rc" in 126) ... ;; 127|124|1) ... ;; esac fi; set -e`).

Feature-specific extensions:

7. **Delegation is for *classification only*, not for substituting the verdict.** The conventions doc puts `classify` on the eligible list with the explicit phrasing "map text to one of a fixed enum (sentiment, severity, file-type, intent). Output space is closed and tiny (often 3-5 tokens). Cheap models hit acceptable accuracy on closed-label classification." F4c delegates the *pass/fail-classification-from-results* compression step ONLY. Native Claude still: (a) chooses which check results to send (the per-check PASS/FAIL summary + the drift log + the cross-phase integration result + the staleness note), (b) decides whether the delegate's classification is sensible against those same inputs (the delegate produces an *opinion*, not the verdict — see Constraint #9 for the cross-check rule), (c) composes every section of the verdict comment (`VALIDATION PASS|FIX|FAIL` prefix line, `### Automated Checks` list, `### Drift Analysis`, `### Cross-Phase Integration`, the `Verdict:` line, mechanical-fix command list when FIX, substantive-failure detail list when FAIL), (d) issues the `create_comment` call in Step 8. The delegate is never asked to produce any text the user sees outside the classification enum.
8. **Strict 3-value enum output from the delegate; JSON envelope for shape verification.** The delegate's prompt MUST instruct the model to emit a single fenced JSON block of the shape `{"classification": "pass"|"fail"|"needs-review", "rationale": "<one-sentence>"}`. The skill validates the response shape with `jq -e` in two stages: (a) `jq -e .classification` extracts the enum value; (b) a bash `case` statement restricts the value to exactly the three accepted tokens (`pass`, `fail`, `needs-review`). If either stage fails, the skill treats it as a fallback path. The wrapper's `--validate-json-output` flag (F2 feature, exposed via `openai-compat.sh`) is **not** plumbed through the wrapper today — the skill validates the JSON shape inline with `jq -e`, matching F4a's pattern. The `rationale` field is captured and surfaced in the audit-log entry (via the wrapper's standard pass-through) but is NOT used by the skill to compose the verdict text — it exists for telemetry-side debugging only. This is the F4c analog of F4a's `jq -e .ranked` and F4b's byte-length + leading-character guards — same purpose (caller validates shape because the wrapper is text-in/text-out and does not understand task-specific schemas), different mechanism (strict 3-value enum check instead of generic JSON-array or length-bounded prose).
9. **Cross-check: delegate is advisory, not authoritative.** The skill MUST cross-check the delegate's `classification` against the automated-check results before letting it influence the verdict prefix. Specifically: if the delegate returns `pass` but Step 6 recorded any FAIL on a substantive check (test failure, missing required file), the skill treats this as a `needs-review` outcome and falls back to native classification with a note (`delegation: cross-check failed (delegate=pass, substantive_failures=N) — falling back to native`). Symmetrically, if the delegate returns `fail` but every automated check passed, the skill also falls back to native with a similar note. The skill trusts the delegate only when its classification is consistent with the underlying check data — this is what "delegated classification matches native" means in the issue's acceptance criterion #1. (F4a/F4b have no analog because their tasks — ranking and summarization — don't have an authoritative ground truth the skill can verify in-process; F4c's automated-check results ARE the ground truth, so a cross-check is required.)
10. **Threshold gate: only delegate when classification is non-trivial.** Delegation fires only when at least 2 automated checks ran AND at least 1 of those checks failed (i.e., the verdict is plausibly `FIX` or `FAIL`, not trivially `PASS`). When every check passes, the verdict is `PASS` deterministically and no model judgment is needed; the skill skips delegation entirely. When zero checks ran (no `Automated Verification` section in the plan), the skill records the PASS-with-warning per existing Step 5 rules and skips delegation. Threshold is hard-coded at "≥2 checks AND ≥1 failure" in v1; configurable later if Wave-3 telemetry shows the wrong cut. (F4a's analog: ≥5 candidates; F4b's analog: ≥2 files OR ≥20 lines.)
11. **Bounded prompt: send check summary, not raw outputs.** The delegate prompt MUST send: (a) the plan's `## Desired End State` section (capped at 1024 bytes; the user-visible verification criteria), (b) a compact per-check summary in the form `- <check_name>: PASS|FAIL [<one-line failure reason>]` (one line per check, max 30 lines so the prompt stays bounded), (c) the drift analysis summary (one line per phase from Step 6.5, max 10 lines), (d) the cross-phase integration result (one line, present/absent). Raw command outputs (stderr blobs, npm test trace) are NOT sent — they bloat the prompt and the delegate doesn't need them to make a closed-enum decision. Total prompt size MUST stay below 8 KB (matches F4b's cap); if the inputs exceed that, the skill truncates the per-check summary block first (the longest typically) then falls back to native if still over.
12. **The substitution is verdict-prefix-only.** When the delegate returns a valid enum and the cross-check passes (Constraint #9), the skill uses the enum to inform the verdict-prefix selection: `pass` → `VALIDATION PASS`, `fail` → `VALIDATION FAIL`, `needs-review` → falls back to native classification (delegate is uncertain; let Claude decide). The skill does NOT modify any other part of the verdict body (`### Automated Checks` list, `### Drift Analysis`, `### Cross-Phase Integration`, the `Verdict:` line, the failure-detail sections). The substitution is a single variable in the bash (e.g., `VERDICT_PREFIX="VALIDATION PASS"`), not a free-form rewrite. (F4a's analog: reorder candidate paths; F4b's analog: substitute `## Summary` text; same idea — narrow surgical edit, not free-form composition.)
13. **FIX classification stays native.** The 3-value enum sent to the delegate is `pass|fail|needs-review`, NOT `pass|fix|fail`. The FIX classification (`VALIDATION FIX`) requires distinguishing mechanical from substantive failures (Step 7 in the current skill body), which involves judgment about specific failure types (`prettier --check` is mechanical; `npm test` failure is substantive). This distinction is too subtle for a closed-enum delegate task — the delegate would either over-classify everything as FIX or under-classify. So the skill always handles FIX natively: when the delegate returns `fail` but the failures are all mechanical (Step 7's existing classification logic), the skill produces `VALIDATION FIX` natively. The delegate only contributes the gross pass-vs-fail signal; mechanical-vs-substantive routing stays in-skill. (This is the F4c-specific refinement that follows from the conventions doc's "closed enum, 3-5 tokens" rationale — a 4-value enum with FIX in it would not be a closed-enum classification in the cheap-model sense.)
14. **Per-task env overrides honored.** Operators may pin a different model for this task via `RALPH_DELEGATE_VAL_CLASSIFY_URL` / `RALPH_DELEGATE_VAL_CLASSIFY_MODEL`. F1 already resolves these without code changes here — the only requirement is that the skill passes `--task val_classify` consistently. (F1's `_resolve_task_var` at `ralph-delegate.sh:147-162` uses `tr '[:lower:]-' '[:upper:]_'`; `val_classify` upper-cases to `VAL_CLASSIFY` with the underscore preserved.) Verified by smoke check.
15. **Caller field in audit log is `ralph-val` (or `val-agent` if the hook context attributes by agent name).** The wrapper resolves `caller` from `RALPH_HOOK_INPUT.tool_input.caller_skill`. F4c does NOT set `RALPH_HOOK_INPUT` itself — it relies on the hook context that the Skill runtime already provides. If the field arrives as `unknown` in the audit log, this is a hook-context limitation outside F4c's scope (matches F4a's Constraint #12 and F4b's Constraint #13 caveat); documented as "best effort".
16. **The `create_comment` call is never delegated.** Verified by reading the modified skill file — `grep -c 'ralph-delegate.sh' skills/ralph-val/SKILL.md` returns exactly `1` (the wrapper is invoked exactly once, in Step 7's pre-classification bash block). The `create_comment` MCP invocation remains in Step 8, unchanged. (Issue acceptance criterion #5 explicitly demands this be verifiable by reading the modified file: "The decision to advance the issue (i.e., the `save_issue` / `advance_issue` call) is **never** delegated — verified by reading the modified skill/agent file." Note that `ralph-val` is read-only and does not invoke `save_issue`/`advance_issue` at all — Step 7 of the existing skill body says "Do NOT change workflow state — integrator handles that based on verdict." F4c preserves this invariant: `grep -c 'save_issue\|advance_issue' skills/ralph-val/SKILL.md` returns the same count as today, which is 0 in the mutating sense.)
17. **Quality compared, not enforced.** The new 10-issue eval document (`agents/val-agent-eval.md`) documents the comparison protocol — pick 10 historic In Progress/In Review issues with known verdicts, run val with delegation on and off, compute agreement rate. Acceptable baseline: 80% agreement (matches the issue's acceptance criterion #1 target). Below 80% triggers a quality review (probably prompt refinement or threshold tuning); not a merge blocker — calibration metric, per the parent epic's Wave-3 quality stance.

## Current State Analysis

**What F1+F2+F3+F4a+F4b shipped (verified by reading source and git log):**

- `plugin/ralph-hero/scripts/ralph-delegate.sh` (308 lines, merged): the public wrapper. Owns: `RALPH_DELEGATE_ENABLED` opt-in gate, env resolution via `ralph_resolve_env`, per-task overrides (`RALPH_DELEGATE_<TASK_UPPER>_URL`/`_MODEL`), audit-log writes to `~/.ralph-hero/delegate.log`, `--health-check`, `--dry-run`, `--task`, `--max-tokens`, `--temperature`, `--prompt-file`, `--system-file`, exit-code translation (0/1/124/126/127). Sources F2's `lib/openai-compat.sh`. CLI surface includes `--max-tokens` and `--temperature` which F4c will use.
- `plugin/ralph-hero/scripts/lib/openai-compat.sh` (275 lines, merged): the sourceable adapter. Owns the HTTP+JSON request, `portable_timeout` wrapping, `jq` response parse. Skill/agent code does NOT touch this file directly — wrapper-only.
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (8 tests, green): hermetic Python HTTPServer stub pattern. Original template.
- `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` (8 tests, green): F2's adapter tests; F4c does NOT modify.
- `plugin/ralph-hero/skills/delegate-test/SKILL.md` (60 lines, merged): F3 reference skill with the canonical `set +e; if OUTPUT=$(...); then ...; else rc=$?; case "$rc" in ...; esac fi; set -e; rm -f` control flow.
- `plugin/ralph-hero/docs/delegation-authoring.md` (66 lines, merged): worked bash example, exit-code crib sheet (0/126/127/124/1), common-mistakes list.
- `plugin/ralph-hero/skills/shared/delegation-conventions.md` (39 lines, merged): the eligibility matrix. Row 2 (eligible): `classify` — "map text to one of a fixed enum (sentiment, severity, file-type, intent). Output space is closed and tiny (often 3-5 tokens). Cheap models hit acceptable accuracy on closed-label classification." This is the explicit justification for F4c's task.
- `plugin/ralph-hero/agents/codebase-locator.md` (F4a, merged on main as of plan authoring): added a `## Candidate Ranking (optional delegation)` H2 between Search Strategy and Output Format with the F3 control flow + `jq -e .ranked` JSON-shape guard + `mktemp -t locator-XXXXXX` prefix. Structural template for the bash-block-in-an-agent-body pattern (although F4c follows F4b's skill-body placement instead).
- `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (F4a, merged): 5 tests (278 lines) mirroring `ralph-delegate.bats` setup/teardown + a `run_locator_rank()` helper that replicates the agent's bash block. Closest structural template for F4c's bats helper (the bash block under test is in a skill, but the helper-function-mirrors-skill-bash pattern is identical).
- `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (F4b, merged on main): added a `### Step 5.0: Compose ## Summary (optional delegation)` H3 between the existing Step 5 H2 heading + intro paragraph and the new `### Step 5.1: Invoke gh pr create` bash block. The structure F4c copies: skill-body insertion of a new step that produces a substitution value (`SUMMARY_TEXT` for F4b; `VERDICT_PREFIX` for F4c) before the existing mutation step.
- `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` (F4b, merged): 7 tests with the threshold-gate pattern (Test 7: `run_pr_description_with_threshold(1, 5)` asserts `BELOW_THRESHOLD` + byte-identical audit-log file). Closest sibling for F4c's bats file (which copies the 7-test structure with task-specific stub modes).
- `plugin/ralph-hero/agents/pr-agent.md` (10-line preloader, NOT modified by F4b): the agent file is a skill dispatcher; all workflow lives in the skill. F4c follows this pattern: `agents/val-agent.md` (11 lines) is NOT modified; all delegation lives in `skills/ralph-val/SKILL.md`.
- `plugin/ralph-hero/agents/pr-agent-eval.md` (F4b, merged): 137-line eval document with 3-PR comparison protocol. Style template for F4c's `agents/val-agent-eval.md` (which uses a 10-issue comparison protocol per the issue's acceptance criterion #1 target).
- `.github/workflows/ci.yml:126-129` (merged): the `test-cli` job runs `bats-core/bats-action` over `plugin/ralph-hero/scripts/__tests__`. The directory glob auto-picks up new `*.bats` files — no CI YAML change required for F4c.

**What `val-agent` / `ralph-val` do today (verified by reading source):**

- **Agent file:** `plugin/ralph-hero/agents/val-agent.md` (11 lines). Frontmatter: `name: val-agent`, `description: Validate implementations — checks that worktree implementation satisfies plan requirements`, `model: haiku`, `tools: Read, Glob, Grep, Bash, mcp__plugin_ralph-hero_ralph-github__ralph_hero__{get_issue,list_issues,save_issue,create_comment,list_sub_issues}`, `skills: [ralph-hero:ralph-val]`. Body is a 1-line preloader (`You are a val agent. Follow the preloaded ralph-val instructions...`). The skill `ralph-hero:ralph-val` is where the actual workflow lives — the agent just dispatches to it. (Note: the agent's `tools:` list includes `save_issue` but the skill body explicitly forbids using it. Step 7 says "Do NOT change workflow state — integrator handles that based on verdict.")
- **Skill file:** `plugin/ralph-hero/skills/ralph-val/SKILL.md` (324 lines). 8 steps:
  1. Parse args (`--plan-doc` flag, queue-pick fallback).
  2. Fetch issue.
  3. Find plan document (Artifact Comment Protocol).
  4. Find worktree (HARD STOP if not at `worktrees/GH-NNN`).
  5. Extract verification criteria from `## Desired End State` + `### Success Criteria > Automated Verification`.
  6. Run automated checks (file existence, command execution, content checks) with the Citation Gate enforced.
  6.5. Drift Log verification (Step 6.5).
  6.6. Cross-Phase Integration check (multi-phase plans only).
  7. **Produce Verdict** — the delegate-eligible classification site. Today this classifies each failure (mechanical vs substantive) and chooses one of three verdict prefixes (`VALIDATION PASS`, `VALIDATION FIX`, `VALIDATION FAIL`). The choice is driven by hard rules (all checks pass → PASS, only mechanical failures → FIX, any substantive failure → FAIL). After F4c, the gross pass-vs-fail decision is optionally delegated; the mechanical-vs-substantive routing (which determines FIX vs FAIL) stays native per Constraint #13.
  8. Post the GitHub comment (`## Validation` header, via `create_comment` MCP call) — the mutation step, preserved exactly by F4c.
- **The classification step today (Step 7):**
  - Implicitly reads the recorded check results from Step 6's output.
  - Applies the three-rule decision (all PASS → PASS; only mechanical FAIL → FIX; any substantive FAIL → FAIL).
  - Emits the verdict prefix as the first line of the output (`VALIDATION PASS|FIX|FAIL`).
  - Composes the per-check breakdown, drift summary, cross-phase integration block, and (when FIX) the fix-command list or (when FAIL) the substantive-failure detail list.
  - The verdict-prefix line is what `val-postcondition.sh` (the Stop hook at `hooks/scripts/val-postcondition.sh`) greps for to determine whether the skill terminated correctly.
- **The mutation step today (Step 8):** the skill posts the verdict comment via `create_comment` on the issue. After F4c, this step is unchanged — the delegate's classification contributes only to which prefix the verdict line starts with; the comment body (header `## Validation` + the verdict block) is composed natively in Step 7 and posted in Step 8 without any text from the delegate.
- **Hooks wired to the skill:** `SessionStart` → `set-skill-env.sh RALPH_COMMAND=val RALPH_REQUIRES_PLAN=true`; `Stop` → `val-postcondition.sh` (asserts the output contains a valid verdict line). Neither hook intercepts `Bash(...)` calls — the wrapper invocation is hook-free, matching F4a/F4b precedent.
- **Existing eval:** `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md` (3 scenarios: PASS, FIX, FAIL). F4c does NOT modify this file. F4c adds a new file at `plugin/ralph-hero/agents/val-agent-eval.md` for the 10-issue delegated-vs-native agreement evaluation (matching the F4a/F4b precedent of putting the delegation-specific eval next to the agent).

**What does NOT exist (verified by file listings):**

- No `plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats` — F4c creates it.
- No `plugin/ralph-hero/agents/val-agent-eval.md` — F4c creates it.
- No delegation site in `skills/ralph-val/SKILL.md` today.

**Tooling assumptions on the target machine:**

- `bash` (4.x or 5.x), `curl`, `jq`, `mktemp`, `wc`, `python3` (for the bats stub), `git`, `gh` — same as F1/F2/F3/F4a/F4b plus the `jq -e` JSON guard (already a hard dep of the wrapper).
- The Skill runtime makes `$CLAUDE_PLUGIN_ROOT` available inside `Bash` tool calls from skill bodies (verified by F4b's merged skill body and the runtime making the var resolve correctly at execution time).
- The Skill runtime allows `Bash` to invoke arbitrary scripts on the operator's machine (no hook intercepts `ralph-delegate.sh` per F1's acceptance criterion 7 and F4a/F4b's verified smoke checks).

## Desired End State

After F4c merges:

1. `plugin/ralph-hero/skills/ralph-val/SKILL.md` is updated to insert a "Step 7.0: Classify verdict (optional delegation)" sub-section **before** the existing Step 7 verdict-prefix selection logic. The sub-section documents the delegated classification path, the cross-check rule, the native fallback path, and the skill's responsibility to compose the verdict body regardless of which path produced the prefix. The wording is operational, not hand-wavy — a Haiku-tier model reading the section MUST be able to execute the classification step correctly in both paths.
2. The skill body includes a copy-paste-ready bash block in the new "Step 7.0" sub-section that wraps the wrapper call in the canonical F3/F4a/F4b control flow. The block:
   - Computes the threshold gate from the Step 6 check results: counts `total_checks` and `failed_checks`. If `total_checks < 2 || failed_checks == 0`, sets `VERDICT_PREFIX` natively (all-pass → `VALIDATION PASS`) and skips delegation entirely. (Constraint #10.)
   - At/above threshold: builds a tempfile prompt containing the plan's `## Desired End State` snippet + the per-check summary + the drift analysis + the cross-phase integration result (capped at 8 KB total per Constraint #11).
   - Calls `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task val_classify --prompt-file <tempfile> --max-tokens 128 --temperature 0.0` inside `set +e; if OUTPUT=$(...); ...; fi; set -e`. `--max-tokens 128` is chosen because the response is a small JSON object (`{"classification": "pass"|"fail"|"needs-review", "rationale": "..."}`) typically under 50 tokens; the budget includes headroom for the rationale field. `--temperature 0.0` is chosen because closed-enum classification benefits from deterministic output — same value as F4a's locator (also a closed-enum-ish task, ranking with categories).
   - On exit 0: validates the JSON shape with two `jq -e` calls: `CLASSIFICATION=$(printf '%s' "$OUTPUT" | jq -er .classification 2>/dev/null)`. If `jq -e` succeeds AND `$CLASSIFICATION` is in `{pass, fail, needs-review}`, proceeds to the cross-check (Constraint #9). Else prints `delegation: fell back to native (rc=0, bad-shape)` and composes natively.
   - Cross-check (Constraint #9): if `CLASSIFICATION == "pass"` but `substantive_failures > 0`, prints `delegation: cross-check failed (delegate=pass, substantive_failures=N) — falling back to native` and falls back. If `CLASSIFICATION == "fail"` but `failed_checks == 0`, prints the symmetric note and falls back. If `CLASSIFICATION == "needs-review"`, falls back to native (the delegate explicitly admitted uncertainty).
   - If cross-check passes: sets `VERDICT_PREFIX` based on the delegate enum + the native mechanical/substantive routing (Constraint #13): `CLASSIFICATION=pass` → `VALIDATION PASS`. `CLASSIFICATION=fail` AND all failures are mechanical → `VALIDATION FIX`. `CLASSIFICATION=fail` AND any failure is substantive → `VALIDATION FAIL`.
   - On exit 126: silently composes natively (no note printed, per the 126-no-log invariant).
   - On exit 127/124/1: prints `delegation: fell back to native (rc=$rc)`, then composes natively.
   - Cleans up the tempfile unconditionally.
3. The existing Step 7 (Produce Verdict) is updated only to read `${VERDICT_PREFIX}` for the first line of the output; everything else (the `### Automated Checks`, `### Drift Analysis`, `### Cross-Phase Integration`, `Verdict:`, mechanical-fix command list, substantive-failure detail list) is composed natively as today. The skill's existing "Verdict format (strict)" admonition (`VALIDATION PASS|FIX|FAIL` literal, no emoji, no bold) is preserved and explicitly cross-referenced by the new Step 7.0.
4. `plugin/ralph-hero/agents/val-agent-eval.md` exists. It defines a 10-issue comparison protocol (matching issue acceptance criterion #1's "10-issue eval set within an agreed agreement threshold; target ≥80% agreement"), the comparison procedure (delegated verdict vs native verdict, per-issue), and the re-run instructions. Operator-runnable, ~140 lines, not automated in v1. The doc lives in `agents/` rather than `skills/ralph-val/` to mirror F4a/F4b's eval-file placement (delegation-specific evals live next to the agent, not next to the existing skill eval).
5. `plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats` exists. It contains a bats suite that exercises the skill's bash block in isolation (replicated 1:1 as `run_val_classify()` helper) against the F1/F4a/F4b Python HTTPServer stub pattern. Covers: delegation enabled + ok stub returning valid JSON enum with `pass` classification, delegation enabled + ok stub returning `fail` classification (cross-check passes), delegation enabled + ok stub returning `pass` but cross-check fails (substantive failures present → fallback), delegation enabled + stub returning malformed JSON (jq guard trips, falls back), delegation enabled + stub returning invalid enum value (e.g., `"classification": "maybe"` — case guard trips, falls back), delegation enabled + slow stub (timeout 124), delegation disabled (126 path, byte-identical log), endpoint unreachable (127 path), threshold-gate triggered (all checks pass → no wrapper call, no audit-log line). 9 tests total.
6. The skill's existing `allowed-tools` list (Read, Glob, Grep, Bash, MCP tools) is unchanged — `Bash` already covers the wrapper invocation.
7. The skill's hook wiring (`SessionStart` → `set-skill-env.sh`, `Stop` → `val-postcondition.sh`) is unchanged. Neither hook intercepts `Bash(ralph-delegate.sh ...)`.
8. The skill's frontmatter (`description`, `user-invocable: false`, `argument-hint`, `context: fork`, `model: sonnet`, `hooks` block, `allowed-tools` list) is unchanged. Only the body adds new content.
9. The agent file `plugin/ralph-hero/agents/val-agent.md` is NOT modified (matches F4b's choice for `agents/pr-agent.md`).
10. With `RALPH_DELEGATE_ENABLED` unset (the default), `ralph-val` does not invoke `ralph-delegate.sh` at all — no audit-log line, no tempfile churn, no behavioral drift. Verified by the bats test for the 126 path + by an operator smoke check.
11. With `RALPH_DELEGATE_ENABLED=true` and `gemma-up` running, invoking `ralph-val` (via `Skill()`, `Agent()`, or the loop runner) on a real worktree with at least 1 failed automated check appends one `task=val_classify, status=ok` JSONL line per validation run to `~/.ralph-hero/delegate.log`.
12. With `RALPH_DELEGATE_ENABLED=true` and `gemma-down`, invoking the skill prints the `delegation: fell back to native (rc=127)` line in the skill's stdout and appends one `task=val_classify, status=unreachable` JSONL line.
13. With every check passing (the trivial-PASS case), the skill does NOT call the wrapper at all (threshold gate trips). Verified by the bats test for the threshold path + by the byte-equality assertion on `wc -c` of the audit log file before and after the all-pass scenario.
14. All 5 issue-defined acceptance criteria are satisfied (see Verification below).

### Verification

- [ ] **End-to-end with real endpoint, FAIL scenario** (manual): `gemma-up && export RALPH_DELEGATE_ENABLED=true`, then in a worktree with a real Phase failing a test, invoke `ralph-val <issue-number>`. Output is the standard `VALIDATION FAIL` verdict block. The `## Validation` comment on the issue has the standard structure. The audit log gains one `task=val_classify, status=ok` JSONL line. The delegated classification matches the native classification (both produce FAIL).
- [ ] **End-to-end with real endpoint, PASS scenario** (manual): with delegation enabled and a worktree where all checks pass, invoke the skill. Verdict is `VALIDATION PASS`. Threshold gate trips (all-pass → no wrapper call); audit log is byte-identical before and after the call.
- [ ] **End-to-end with endpoint down** (manual): with delegation enabled but gemma killed, invoke the skill against a worktree with at least 1 failing check. Skill output contains a `delegation: fell back to native (rc=127)` line. The verdict block still has a valid `VALIDATION PASS|FIX|FAIL` prefix (native composition succeeded). The audit log gains one `status=unreachable` JSONL line.
- [ ] **End-to-end with delegation disabled** (manual): with `RALPH_DELEGATE_ENABLED` unset, invoke the skill. Output is byte-identical to today's (no delegation note, same verdict structure, verdict composed by native Sonnet/Haiku in-context judgment). Audit log file is byte-identical before and after.
- [ ] **JSON-shape guard trip on bad delegate output** (manual): point the skill at a stub that returns a chat-completion with content `"not really json"` or `{"classification": "maybe"}`. The skill's `jq -e` guard (or case-statement enum guard) trips, falls back to native classification with a `delegation: fell back to native (rc=0, bad-shape)` note. Audit log records `status=ok` (the wrapper succeeded at the HTTP layer; the parse failure is the skill's concern, not the wrapper's).
- [ ] **Cross-check guard trip** (manual): point the skill at a stub that returns `{"classification": "pass"}` but configure the worktree to have a substantive test failure. The skill's cross-check rule (Constraint #9) detects the inconsistency, prints `delegation: cross-check failed (delegate=pass, substantive_failures=N) — falling back to native`, and produces a `VALIDATION FAIL` verdict natively. Issue acceptance criterion #1 (delegated matches native) is exercised through this cross-check, not by trusting the delegate blindly.
- [ ] **Threshold gate trips on all-pass** (manual): in a worktree where every automated check passes, invoke the skill with delegation enabled. The skill does NOT invoke the wrapper (no tempfile created, no audit-log line written). The verdict is `VALIDATION PASS` composed natively. Operator verifies by `wc -l ~/.ralph-hero/delegate.log` pre/post.
- [ ] **10-issue agreement eval** (manual): pick 10 historic In Progress/In Review issues from the ralph-hero repo with known verdicts (canonical examples: recent F-series issues that have been validated; the operator selects 10 at run time). For each, run val with delegation on and off in side-by-side worktrees. Record agreement / disagreement on the verdict prefix. Document per-issue agreement in a comment on issue #1190; target: ≥80% agreement (8 of 10). Below 80% triggers a prompt-refinement review; not a merge blocker — calibration metric.
- [ ] **Mutation-step audit** (manual, issue acceptance criterion #5): read the modified `skills/ralph-val/SKILL.md`. Confirm `grep -c 'create_comment' SKILL.md` returns ≥1 (the create_comment call in Step 8 is preserved). Confirm `grep -c 'ralph-delegate.sh' SKILL.md` returns exactly `1` (the wrapper is invoked exactly once). Confirm the bash block calling the wrapper appears strictly BEFORE the Step 8 `create_comment` invocation, never after, and `create_comment` is never invoked from within an `if OUTPUT=$(...)` guard. Confirm the read-only nature of val is preserved: `grep -c 'save_issue\|advance_issue' SKILL.md` returns the same count as on main today (which is 0 in the mutating sense).
- [ ] **No-regression**: `bats plugin/ralph-hero/scripts/__tests__` runs all existing tests + the new `val-agent-delegation.bats` (9 new tests) — all green. F4a's `codebase-locator-delegation.bats` (5 tests) and F4b's `pr-agent-delegation.bats` (7 tests) continue to pass without changes.
- [ ] **TypeScript builds**: `npm run build` and `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched but the matrix runs).
- [ ] **CI green**: `test-cli`, `test-hooks`, `test-matrix` jobs all green on the PR.

## What We're NOT Doing

- **NOT** delegating the `create_comment` MCP call. The mutation step stays native, period. Verifiable by reading the modified skill file (Constraint #16; issue acceptance criterion #5).
- **NOT** delegating any other step in the skill (issue fetch, plan-doc discovery, worktree freshness check, automated checks, drift verification, cross-phase integration). Only Step 7.0's pass/fail classification sub-decision is touched.
- **NOT** delegating the `### Automated Checks` per-check breakdown, the `### Drift Analysis` section, the `### Cross-Phase Integration` section, the `Verdict:` line, the mechanical-fix command list (FIX case), or the substantive-failure detail list (FAIL case). The delegate emits a 3-value enum only; the verdict body is composed natively.
- **NOT** delegating the mechanical-vs-substantive failure classification (Constraint #13). The delegate's enum is `pass|fail|needs-review`, not `pass|fix|fail`. FIX routing stays native.
- **NOT** trusting the delegate when it disagrees with the automated checks (Constraint #9). If the delegate says `pass` but a substantive check failed, the skill falls back to native. The delegate is advisory, not authoritative.
- **NOT** delegating the verdict-postcondition Stop hook (`val-postcondition.sh`). The hook still greps the skill's stdout for the `VALIDATION PASS|FIX|FAIL` prefix; F4c does not modify the hook.
- **NOT** plumbing `--validate-json-output` through `ralph-delegate.sh`. The wrapper doesn't expose this flag today (F2 has it on `openai-compat.sh`); F4c validates the JSON shape inside the skill body with `jq -e` and a case-statement enum guard. If a future feature wants to plumb the flag, that's a wrapper change tracked separately.
- **NOT** introducing telemetry. F5 (`#1191`) owns `ralph status --delegation` and per-task aggregations.
- **NOT** touching the sibling F4 integrations. F4a (`codebase-locator`, #1188) and F4b (`pr-agent`, #1189) are independent plans owned by their own issues; both are merged on main.
- **NOT** modifying `ralph-delegate.sh`, `openai-compat.sh`, F1's bats suite, F2's bats suite, F4a's bats suite, or F4b's bats suite.
- **NOT** modifying the skill's `allowed-tools` list, hook wiring, frontmatter, or any step other than Step 7.
- **NOT** modifying the `val-agent.md` agent file. The agent is an 11-line skill preloader; all of the workflow lives in the skill, which is where the delegation site is added. (Issue scope explicitly allows both files in the modification surface; we choose the skill alone for minimum blast radius, matching F4b's precedent.)
- **NOT** changing the existing `skills/ralph-val/eval-scenarios.md` (3 scenarios: PASS/FIX/FAIL). F4c adds a separate `agents/val-agent-eval.md` for the 10-issue delegation comparison; the original eval continues to validate the skill's primary verdict-classification paths.
- **NOT** changing the verdict format (`VALIDATION PASS|FIX|FAIL` strict prefix). The skill's existing admonition (line 263 of SKILL.md) is preserved and explicitly cross-referenced from the new Step 7.0 bash block.
- **NOT** changing the Stop-hook contract. `val-postcondition.sh` (in `hooks/scripts/`) still accepts the same verdict tokens; F4c's bash block's `VERDICT_PREFIX` variable resolves to one of those same tokens.
- **NOT** building a Python or Node helper for prompt construction. The skill body's bash block uses `cat > $PROMPT_FILE <<EOF ... EOF` — same pattern as F3 / F4a / F4b.
- **NOT** introducing an MCP tool for delegation. Per the conventions doc, skill code calls the wrapper via `Bash`, period.
- **NOT** changing the skill's or agent's model tier (`model: sonnet` for the skill, `model: haiku` for the agent — both unchanged). The wrapper handles the heavier-model delegation when enabled; Sonnet/Haiku's role is unchanged in the native path.
- **NOT** providing a fallback for the case where the `jq` or `git` binary is missing. Both are hard deps of the skill today (Citation Gate uses `cat`; `jq` is a hard dep of the wrapper); if they're missing, the skill fails first with a different error before the delegation block runs.
- **NOT** adding eval automation. The `val-agent-eval.md` document is operator-runnable; automation lives in a future feature if the operator wants nightly drift detection.
- **NOT** delegating in the queue-pick branch (when `args == ""` and the skill picks an issue from the In Progress queue). The classification happens after Step 6's check execution, so the queue-pick branch reaches Step 7 the same way as the argument-provided branch. F4c does not special-case it.

## Implementation Approach

Implementation proceeds in three task groups inside a single phase. Tasks 1.1 and 1.2 can be done in either order (1.2 depends on 1.1 only for the prose-block reference, not the eval logic); Task 1.3 depends on 1.1 because the bats tests exercise the bash block that 1.1 introduces.

1. **Skill body update.** Edit `plugin/ralph-hero/skills/ralph-val/SKILL.md` to insert a new sub-step "Step 7.0: Classify verdict (optional delegation)" between the existing Step 6.6 (Cross-Phase Integration) and the existing Step 7 (Produce Verdict). The sub-step includes the worked bash block (copy-paste from F4b's `### Step 5.0` bash block, swap `--task pr_description` → `--task val_classify`, swap byte-length + leading-char prose guards → `jq -e .classification` JSON guard + case-statement enum guard, swap "compute git diff stat" threshold → "count total + failed checks" threshold, swap "compose summary from diff" prompt → "classify verdict from checks" prompt, add the cross-check rule per Constraint #9). The skill body MUST remain coherent: existing Steps 1-6.6 and Step 8 are unchanged in wording.
2. **Eval document.** Author `plugin/ralph-hero/agents/val-agent-eval.md` with the 10-issue comparison protocol (matching issue acceptance criterion #1). The doc defines: (a) how to select the 10 issues (criteria: historic In Progress or In Review issues with known verdicts; spread across PASS/FIX/FAIL outcomes; spread across small/medium-complexity issues), (b) the agreement criterion (per-issue: delegated verdict prefix === native verdict prefix), (c) the re-run procedure (manual; not automated in v1), (d) what to record in the issue-1190 comment.
3. **Bats coverage.** Create `plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats`. 9 tests, each replicating the skill's bash block in isolation as `run_val_classify()`. Stubs reuse the F1/F4a/F4b Python HTTPServer pattern with new modes (`valid_pass`, `valid_fail`, `cross_check_inconsistent_pass`, `malformed_content`, `invalid_enum`, `needs_review`, `slow`, `ok_default`). Test cases: (1) happy path PASS (delegate returns valid pass, cross-check passes); (2) happy path FAIL (delegate returns valid fail, cross-check passes, FIX routing native); (3) cross-check trip pass-with-substantive-failure (delegate returns pass, skill detects inconsistency, falls back); (4) malformed JSON content (jq guard trips, falls back); (5) invalid enum value (case guard trips, falls back); (6) needs-review classification (delegate explicitly uncertain, falls back); (7) timeout (rc=124, falls back with note); (8) disabled (rc=126, no log line, byte-identical audit log); (9) threshold gate triggered (all checks pass → no wrapper call, no audit-log line).

There is exactly one Phase. No `depends_on` between phases is needed; the task-level `depends_on` field captures intra-phase order.

---

## Phase 1: GH-1190 — `ralph-val` pass/fail classification via delegation
- **depends_on**: null

### Overview

Wire the `ralph-val` skill's Step 7 verdict-classification step to optionally delegate to `ralph-delegate.sh --task val_classify`. Native Claude still composes the verdict body (`### Automated Checks`, `### Drift Analysis`, `### Cross-Phase Integration`, `Verdict:` line, fix-command list, substantive-failure detail list) and issues the `create_comment` call unchanged; the delegate only contributes a closed 3-value enum (`pass|fail|needs-review`) that informs the verdict-prefix selection, with a mandatory cross-check against the automated-check results to ensure the delegate's classification is consistent with the underlying data. Includes a 10-issue agreement-eval document for ongoing quality comparison and a bats test suite exercising the skill's bash control flow against a hermetic HTTPServer stub.

### Tasks

#### Task 1.1: Update `skills/ralph-val/SKILL.md` to embed the delegation pattern
- **files**: `plugin/ralph-hero/skills/ralph-val/SKILL.md` (modify), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (read — F4b structural template, closest sibling), `plugin/ralph-hero/agents/codebase-locator.md` (read — F4a structural template, JSON-shape-guard reference), `plugin/ralph-hero/skills/delegate-test/SKILL.md` (read — control-flow template), `plugin/ralph-hero/docs/delegation-authoring.md` (read — worked example), `plugin/ralph-hero/skills/shared/delegation-conventions.md` (read — `classify` eligibility), `plugin/ralph-hero/scripts/ralph-delegate.sh` (read — CLI surface), `plugin/ralph-hero/agents/val-agent.md` (read — confirm no agent-body change needed), `plugin/ralph-hero/hooks/scripts/val-postcondition.sh` (read — confirm verdict tokens unchanged)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The skill's frontmatter is unchanged (`description`, `user-invocable: false`, `argument-hint`, `context: fork`, `model: sonnet`, `hooks` block, `allowed-tools` list — all byte-identical to today).
  - [ ] The skill body's existing Step 1 (Parse Arguments), Step 2 (Fetch Issue), Step 3 (Find Plan Document), Step 4 (Find Worktree), Step 5 (Extract Verification Criteria), Step 6 (Run Automated Checks), Step 6.5 (Drift Log Verification), Step 6.6 (Cross-Phase Integration Check), Step 8 (Post GitHub Comment), and Notes section are unchanged in wording. The existing Step 7 (Produce Verdict) is unchanged except for the addition of a reference to `${VERDICT_PREFIX}` (set by the new Step 7.0) as the source of the verdict-line prefix.
  - [ ] A new H2 sub-step `## Step 7.0: Classify Verdict (optional delegation)` is inserted in the skill body **between** the existing `## Step 6.6: Cross-Phase Integration Check` H2 and the existing `## Step 7: Produce Verdict` H2. The placement reflects the skill's operational order: gather (Steps 1-6.6) → classify (new Step 7.0) → compose verdict body (existing Step 7) → post comment (existing Step 8).
  - [ ] The new sub-step opens with a 2-3-sentence overview: when delegation is enabled (`RALPH_DELEGATE_ENABLED=true`), the plan's `## Desired End State` + the per-check summary + the drift summary + the cross-phase integration result are sent to a local LLM via `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task val_classify`, which returns a strict 3-value enum (`pass`|`fail`|`needs-review`). The skill cross-checks the enum against the automated-check results (delegate is advisory, not authoritative) and uses the result to inform the verdict-prefix selection in Step 7 below; everything else (the `### Automated Checks` per-check list, the `### Drift Analysis`, the `### Cross-Phase Integration`, the `Verdict:` line, the failure-detail sections, the `create_comment` MCP call) is composed and invoked natively. Delegation is opt-in (operator sets the env var); when off, the skill classifies natively as today.
  - [ ] The sub-step contains a fenced bash block that is structurally identical to F4b's `### Step 5.0` block (set +e, `if OUTPUT=$(...)` guard, case "$rc" handling, unconditional `rm -f`, `mktemp -t val-classify-XXXXXX`). The block:
    - Computes the threshold gate from the Step 6 check results:
      ```bash
      # total_checks and failed_checks are populated by Step 6's loop;
      # substantive_failures is populated by Step 7's mechanical/substantive
      # classification (which runs in-context regardless of delegation).
      TOTAL_CHECKS=${total_checks:-0}
      FAILED_CHECKS=${failed_checks:-0}
      SUBSTANTIVE_FAILURES=${substantive_failures:-0}

      if [ "$TOTAL_CHECKS" -lt 2 ] || [ "$FAILED_CHECKS" -eq 0 ]; then
          # Below threshold — compose natively, skip delegation. All-pass case
          # is deterministic: VALIDATION PASS. Single-check case is too narrow
          # for model judgment to add value.
          VERDICT_PREFIX="VALIDATION PASS"
      else
          # ... threshold met, proceed to delegation gate below
      fi
      ```
    - Composes a prompt of the shape (only when above threshold):
      ```
      You are classifying the outcome of an automated validation run.

      Desired end state (from the plan):
      ${DESIRED_END_STATE_SNIPPET}

      Per-check results (PASS|FAIL [reason]):
      ${PER_CHECK_SUMMARY}

      Drift analysis summary:
      ${DRIFT_SUMMARY}

      Cross-phase integration:
      ${CROSS_PHASE_RESULT}

      Return a JSON object with this exact shape — no prose before or after:
      {"classification": "pass" | "fail" | "needs-review", "rationale": "<one-sentence>"}

      Rules:
      - "pass" when every check is PASS and the desired end state is satisfied.
      - "fail" when at least one check FAILed.
      - "needs-review" only if the result is genuinely ambiguous (e.g., a check
        could not run or the desired end state is unclear).
      ```
    - Caps the prompt file at 8 KB total per Constraint #11. If `wc -c < $PROMPT_FILE` is over 8192, truncates the per-check summary block first by `head -c 4096`, re-checks, and falls back to native if still over.
    - Calls `"$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" --task val_classify --prompt-file "$PROMPT_FILE" --max-tokens 128 --temperature 0.0 2>/dev/null` inside an `if OUTPUT=$(...)` guard.
    - Validates the response with two `jq -e` stages: `CLASSIFICATION=$(printf '%s' "$OUTPUT" | jq -er .classification 2>/dev/null)`; on `jq -e` failure (no `.classification` field), treats it as a fallback and surfaces `delegation: fell back to native (rc=0, bad-shape)`. Then a `case "$CLASSIFICATION"` statement restricts the value to `pass`, `fail`, or `needs-review`; any other value triggers the same fallback marker.
    - Cross-check (Constraint #9): if `CLASSIFICATION == "pass"` AND `SUBSTANTIVE_FAILURES -gt 0`, prints `delegation: cross-check failed (delegate=pass, substantive_failures=$SUBSTANTIVE_FAILURES) — falling back to native` and falls back. If `CLASSIFICATION == "fail"` AND `FAILED_CHECKS -eq 0`, prints the symmetric note (`delegation: cross-check failed (delegate=fail, failed_checks=0) — falling back to native`) and falls back. If `CLASSIFICATION == "needs-review"`, prints `delegation: needs-review — falling back to native` and falls back.
    - If cross-check passes: maps `CLASSIFICATION` to `VERDICT_PREFIX` per Constraint #13: `pass` → `VERDICT_PREFIX="VALIDATION PASS"`. `fail` + all failures mechanical → `VERDICT_PREFIX="VALIDATION FIX"`. `fail` + any failure substantive → `VERDICT_PREFIX="VALIDATION FAIL"`. (The mechanical-vs-substantive distinction is read from the existing Step 7 logic, which runs in-context regardless of delegation; only the gross pass-vs-fail decision is delegated.)
    - On exit 126: silently composes natively (no note printed, per the 126-no-log invariant in `docs/delegation-authoring.md`).
    - On exit 127/124/1: prints `delegation: fell back to native (rc=$rc)` ABOVE the verdict block, then composes natively.
    - `rm -f "$PROMPT_FILE"` runs unconditionally at the end (outside the `if/else/fi`).
  - [ ] The sub-step explicitly notes: "Delegation is for **classification only**. The verdict body (per-check list, drift analysis, cross-phase integration, fix-command list, substantive-failure detail list) is composed natively in Step 7. The `create_comment` MCP call in Step 8 is invoked natively in all cases — the delegate's output is text-in for the verdict-prefix selection and nothing else. Never let delegated text reach the comment body or any GitHub mutation." This matches conventions doc rationale for the `classify` row and the no-mutation rule (Constraint #16).
  - [ ] The sub-step mentions the per-task override env vars (`RALPH_DELEGATE_VAL_CLASSIFY_URL`, `RALPH_DELEGATE_VAL_CLASSIFY_MODEL`) in a one-liner — not as documentation, but as a hint that operators may pin a different model for this task. Resolution: F1's `_resolve_task_var` uses `tr '[:lower:]-' '[:upper:]_'`; `val_classify` → `VAL_CLASSIFY` (underscore preserved, letters upper-cased).
  - [ ] The sub-step explicitly cross-references the verdict-format admonition in Step 7: "The `VERDICT_PREFIX` set here MUST be exactly one of `VALIDATION PASS`, `VALIDATION FIX`, or `VALIDATION FAIL` (the literal tokens the `val-postcondition.sh` Stop hook accepts). The skill MUST NOT substitute alternate vocabulary — see Step 7's 'Verdict format (strict)' section." This guards against the delegate's `rationale` field leaking into the verdict prefix.
  - [ ] The existing Step 7 (Produce Verdict) is updated only in the verdict-line composition: the verdict line MUST use `${VERDICT_PREFIX}` (set by Step 7.0) instead of computing the prefix in-context. The "Verdict format (strict)" admonition, the per-check breakdown template, the drift analysis template, the cross-phase integration template, the `Verdict:` line template, the FIX fix-command-list section, and the FAIL substantive-failure-detail section are unchanged in wording. The "Negative example — DO NOT emit verdicts like this" admonition is unchanged.
  - [ ] The total file size grows by 80-140 lines (roughly the size of the new sub-step plus the small wording change in Step 7). If it grows past 160 added lines, the section is too verbose — trim the bash block comments or the rationale paragraphs.
  - [ ] `bash -n` syntax-checks cleanly against the bash block (extract with `sed -n '/^```bash$/,/^```$/p' plugin/ralph-hero/skills/ralph-val/SKILL.md | sed '1d;$d' | bash -n -`).
  - [ ] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `1` (single wrapper call, no accidental loop, no nested invocation).
  - [ ] `grep -c 'openai-compat.sh' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `0` (skill does NOT call the adapter directly — must go through wrapper).
  - [ ] `grep -c '\-\-task val_classify' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `1` (task name is hardcoded once for stable audit-log lookup).
  - [ ] `grep -c 'create_comment' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns the same count as today (≥1) — the Step 8 mutation step is preserved. F4c does NOT remove or modify the Step 8 `create_comment` invocation.
  - [ ] `grep -c 'save_issue\|advance_issue' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `0` in the mutating sense (the existing skill body mentions "Do NOT change workflow state" in Notes; F4c preserves this read-only invariant). Note: the existing skill body may mention these tokens in negative contexts (e.g., "Do NOT call save_issue"); the grep count for those negative-context mentions should be unchanged by F4c.
  - [ ] `grep -cE 'Step 7\.0|Classify Verdict' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥1 (the new sub-step is present and headed correctly; the level — H2 vs H3 — is the impl agent's choice based on which renders better in the skill body).
  - [ ] `grep -c 'VERDICT_PREFIX' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥2 (the variable is set in Step 7.0 and referenced in Step 7).
  - [ ] `plugin/ralph-hero/agents/val-agent.md` is NOT modified. `git diff plugin/ralph-hero/agents/val-agent.md` is empty after this task. (The agent is an 11-line skill preloader; all work lives in the skill.)
  - [ ] `plugin/ralph-hero/hooks/scripts/val-postcondition.sh` is NOT modified. The Stop hook's verdict-token expectations (`VALIDATION PASS|FIX|FAIL`, `Queue empty`) are unchanged.
  - [ ] `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md` is NOT modified. The existing 3-scenario eval continues to validate the skill's primary verdict-classification paths.

#### Task 1.2: Author `agents/val-agent-eval.md` with 10-issue comparison protocol
- **files**: `plugin/ralph-hero/agents/val-agent-eval.md` (create), `plugin/ralph-hero/agents/pr-agent-eval.md` (read — F4b style template), `plugin/ralph-hero/agents/codebase-locator-eval.md` (read — F4a style template), `plugin/ralph-hero/skills/ralph-val/SKILL.md` (read — skill's expected verdict format), `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md` (read — existing 3-scenario eval style)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/agents/val-agent-eval.md`, opens with frontmatter matching the F4a/F4b/`eval-scenarios.md` style:
    ```yaml
    ---
    type: eval-scenarios
    agent: val-agent
    date: 2026-05-12
    status: defined
    ---
    ```
  - [ ] File body opens with H1 `# Val-Agent Delegation Eval`.
  - [ ] Opens with a 1-paragraph "Execution note": these are operator-runnable comparison scenarios for the ralph-val skill's delegated vs native verdict classification. Re-runnable as quality drifts. Not automated in v1. Mirrors the framing in F4a/F4b's eval docs.
  - [ ] Defines an "Issue selection criteria" section listing what to pick:
    - Pick 10 historic issues from the ralph-hero repo (or any repo where val has been run) with known verdicts that can be re-run against a reachable worktree.
    - Spread across verdict outcomes: aim for 4-5 PASS, 3-4 FAIL, 1-2 FIX. (FIX is rare in the historical corpus; a 1-2 representation is realistic.)
    - Spread across implementation complexity: small (XS/S issues with 1-2 phases), medium (S/M issues with 3-5 phases). Skip large epics — the per-check count would dominate the prompt budget.
    - Skip issues whose plan has no `## Desired End State` or no `Automated Verification` section — those are PASS-with-warning cases that bypass Step 7.0 entirely.
    - Three plausible candidate ranges from recent ralph-hero PRs (current epic): F1 (#1185, PASS — bats passed), F4a (#1188, PASS), F4b (#1189, PASS), older Phase 4 review-skill issues (mixed verdicts). The operator picks 10 actual issues at run time — these are starting suggestions.
  - [ ] Defines the agreement criterion as a single bullet: per issue, the delegated verdict prefix (`VALIDATION PASS|FIX|FAIL`) equals the native verdict prefix. The `### Automated Checks`, `### Drift Analysis`, and `### Cross-Phase Integration` blocks are NOT scored — only the gross verdict label.
  - [ ] Defines a "Comparison protocol" section:
    1. With `RALPH_DELEGATE_ENABLED=true && gemma-up`, for each selected issue, in the worktree of that issue (re-create via `git worktree add worktrees/GH-NNN feature/GH-NNN` if missing), invoke `Skill("ralph-hero:ralph-val", "<issue-number>")`. Capture the verdict prefix from the resulting `## Validation` comment (or the skill's stdout). Discard the comment (or post and immediately edit/delete if the issue is already closed; eval is read-only in intent — operator's choice).
    2. With `unset RALPH_DELEGATE_ENABLED`, repeat. Capture the native verdict prefix.
    3. For each issue, record agreement (`MATCH`) or disagreement (`DELEGATED=<x> NATIVE=<y>`) in a 10-row table.
    4. Compute agreement rate: `(MATCH_count / 10) * 100`. Target: ≥80% agreement (matches issue acceptance criterion #1).
    5. Document the 10-row table and the aggregate agreement rate in a comment on issue #1190.
    6. Acceptable baseline: 80% agreement (8 of 10). Below 80% triggers a prompt-refinement review (probably tweak the system prompt or the threshold gate); not a merge blocker — calibration metric, per Constraint #17.
  - [ ] Includes a "What this does NOT measure" section: this eval compares verdict prefixes in isolation. It does NOT measure: (a) absolute correctness (the "gold" verdict is itself the native verdict, so this is a self-consistency check, not a ground-truth check), (b) the verdict body sections (per-check list, drift analysis, cross-phase integration), (c) whether `create_comment` succeeds (covered by the existing `skills/ralph-val/eval-scenarios.md`), (d) the cross-check rule's effectiveness (the cross-check is a Constraint #9 invariant exercised by the bats suite, not the eval).
  - [ ] Includes a "Re-run cadence" subsection: re-run the 10-issue eval after model swaps (`RALPH_DELEGATE_VAL_CLASSIFY_MODEL` change), after wrapper changes (F5/F6), or quarterly during Wave-4 telemetry review. Document drift in a follow-up comment on the issue.
  - [ ] Includes a "Special cases" subsection documenting how to handle:
    - Issues whose worktree has been pruned (skip and select a replacement).
    - Issues whose plan no longer exists at the path referenced in the `## Implementation Plan` comment (skip and select a replacement).
    - Issues that produce a `Queue empty` verdict (skip; not a real classification).
    - Issues where the threshold gate trips (all-pass): MATCH is automatic because both paths produce `VALIDATION PASS` deterministically; count as MATCH.
  - [ ] No more than ~160 lines total. The eval is operator documentation, not a benchmark report.

#### Task 1.3: Write `val-agent-delegation.bats` covering the skill's bash block
- **files**: `plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats` (create), `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` (read — F4b's 1:1 template, closest sibling), `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (read — F4a's stub-mode pattern), `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (read — original stub pattern), `plugin/ralph-hero/skills/ralph-val/SKILL.md` (read — the bash block under test)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats`. Shebang `#!/usr/bin/env bats`. File-level comment explains: exercises the verdict-classification bash block from `skills/ralph-val/SKILL.md` Step 7.0 against a hermetic Python HTTPServer stub; mirrors F4b's `pr-agent-delegation.bats` 1:1 in stub/setup/teardown structure, with task-specific stub modes (`valid_pass`, `valid_fail`, `invalid_enum`, `malformed_content`, `needs_review`, `slow`, `ok_default`) and a `run_val_classify()` helper.
  - [ ] `setup()` and `teardown()` are byte-identical to `pr-agent-delegation.bats` modulo the env-var names: `TEST_TMPDIR=$(mktemp -d)`, exports `RALPH_DELEGATE_LOG_PATH`, unsets caller env vars including the per-task overrides (`RALPH_DELEGATE_VAL_CLASSIFY_URL`, `RALPH_DELEGATE_VAL_CLASSIFY_MODEL`), starts/stops `STUB_PID`/`STUB_PORT`.
  - [ ] A helper function `start_val_classify_stub_endpoint <mode>` is defined. Modes:
    - `valid_pass` — returns chat-completion content `'{"classification": "pass", "rationale": "All four automated checks succeeded and the desired end state appears satisfied."}'` (valid JSON, valid enum value).
    - `valid_fail` — returns chat-completion content `'{"classification": "fail", "rationale": "Two unit tests failed in the npm test run."}'` (valid JSON, valid enum value).
    - `needs_review` — returns chat-completion content `'{"classification": "needs-review", "rationale": "One check could not be executed because the script was missing executable permissions."}'` (valid JSON, valid but uncertain enum value).
    - `invalid_enum` — returns chat-completion content `'{"classification": "maybe", "rationale": "Looks fine."}'` (valid JSON, INVALID enum value — case-statement guard should trip).
    - `malformed_content` — returns chat-completion content `"not really json"` (the wrapper succeeds at HTTP, but the skill's `jq -e .classification` guard trips).
    - `slow` — sleeps 3s (for timeout test; matches F4a/F4b's `slow` mode).
    - `ok_default` — returns a generic `"ok"` chat-completion (unused in tests but kept for parity with F4a/F4b stubs).
    - Copy the Python HTTPServer stub from `pr-agent-delegation.bats` adapted for these modes.
  - [ ] An extracted-or-replicated bash function `run_val_classify()` represents the skill's bash block under test. It accepts `total_checks`, `failed_checks`, `substantive_failures` (integers; default 5, 2, 1 for the happy-path test), and the per-check summary string + plan snippet string. The function composes the prompt, invokes the wrapper, validates the response via `jq -er .classification` + case-statement enum guard, runs the cross-check (Constraint #9) against the input counts, and prints one of:
    - `<verdict_prefix>` — `VALIDATION PASS`, `VALIDATION FIX`, or `VALIDATION FAIL` (happy path, classification + cross-check + mechanical/substantive routing succeeded)
    - `FALLBACK rc=0,bad-shape` — wrapper succeeded but JSON shape or enum value invalid
    - `FALLBACK rc=0,cross-check-pass` — delegate said pass but substantive failures present
    - `FALLBACK rc=0,cross-check-fail` — delegate said fail but no failed checks
    - `FALLBACK rc=0,needs-review` — delegate explicitly uncertain
    - `FALLBACK rc=126` — delegation disabled (silent fallback; cross-check skipped)
    - `FALLBACK rc=127` — endpoint unreachable
    - `FALLBACK rc=124` — wrapper timed out
    - `FALLBACK rc=1` — wrapper hard error
    - `BELOW_THRESHOLD` — `total_checks < 2 || failed_checks == 0` (threshold gate trips before delegation)
    
    The helper does NOT execute Step 6's automated checks (it accepts the counts as inputs) and does NOT execute Step 8's `create_comment` (it only emits the verdict-prefix marker). Document in a comment at the top of the bats file: "The function under test mirrors the bash block in `skills/ralph-val/SKILL.md` Step 7.0. Update both in lockstep."
  - [ ] **Test 1 — happy path PASS (delegated, valid enum, cross-check passes)**: starts `valid_pass` stub, sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:$STUB_PORT`. Runs `run_val_classify 5 0 0 "..." "..."` (5 checks, 0 failed; cross-check should pass since delegate=pass + 0 failures is consistent — but threshold gate also trips because `failed_checks == 0`, so this case actually returns `BELOW_THRESHOLD`). Adjust: use `run_val_classify 5 2 0` instead (5 checks, 2 failed (mechanical only), 0 substantive). With delegate=pass and substantive=0, cross-check now wants delegate=pass with `failed_checks > 0` — that's inconsistent (pass + 2 mechanical failures should be FIX not PASS), so this hits the cross-check fallback. Use `run_val_classify 5 0 0 ...` with override: bypass the threshold gate for this test by adjusting the helper to accept a `--force-delegate` flag for testing, OR use `run_val_classify 5 1 0 ...` (where the 1 failure is mechanical and delegate=pass is also inconsistent). The clean canonical Test 1 is: `valid_pass` stub + `5 0 0` inputs + assert `BELOW_THRESHOLD` (threshold trips correctly when all pass). Rename Test 1 to "happy path PASS via threshold gate" and Test 2 (below) to "happy path FAIL via delegate". Asserts function output is exactly `BELOW_THRESHOLD`. Asserts the audit log is byte-identical pre/post (no wrapper invocation on the threshold path).
  - [ ] **Test 2 — happy path FAIL (delegated, valid enum, cross-check passes)**: starts `valid_fail` stub, sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:$STUB_PORT`. Runs `run_val_classify 5 2 2 "..." "..."` (5 checks, 2 failed, 2 substantive). Delegate=fail + substantive_failures=2 + failed_checks=2 → cross-check passes; mapping=substantive → VERDICT_PREFIX=`VALIDATION FAIL`. Asserts function output is exactly `VALIDATION FAIL`. Asserts one JSONL line in `$RALPH_DELEGATE_LOG_PATH` with `"task":"val_classify"` and `"status":"ok"`.
  - [ ] **Test 3 — happy path FIX (delegated FAIL + mechanical-only failures)**: starts `valid_fail` stub. Runs `run_val_classify 5 2 0 "..." "..."` (5 checks, 2 failed, 0 substantive — i.e., the 2 failures are mechanical). Delegate=fail + substantive_failures=0 + failed_checks=2 → cross-check passes (delegate=fail + failed_checks>0 is consistent); mapping=mechanical → VERDICT_PREFIX=`VALIDATION FIX`. Asserts function output is exactly `VALIDATION FIX`. Asserts JSONL line has `"task":"val_classify"` and `"status":"ok"`.
  - [ ] **Test 4 — cross-check trip: delegate=pass + substantive failures present**: starts `valid_pass` stub. Runs `run_val_classify 5 3 2 "..." "..."` (5 checks, 3 failed, 2 substantive). Delegate=pass + substantive_failures=2 → cross-check trips. Asserts function output is exactly `FALLBACK rc=0,cross-check-pass`. Asserts JSONL line records `"status":"ok"` (wrapper succeeded; the cross-check failure is the skill's concern).
  - [ ] **Test 5 — cross-check trip: delegate=fail + no failures**: starts `valid_fail` stub. Runs `run_val_classify 5 0 0 "..." "..."`. Wait — this trips the threshold gate first (`failed_checks == 0`). Refine: the cross-check-fail symmetric branch is only reachable if `failed_checks == 0` AND `total_checks >= 2`. But that contradicts the threshold gate, which also requires `failed_checks > 0`. So this test case is unreachable in practice. SKIP this test (the cross-check-fail symmetric branch is documented in the skill but not exercised by the bats suite; document this gap in the test file's header comment).
  - [ ] **Test 5 — needs-review classification**: starts `needs_review` stub. Runs `run_val_classify 5 2 2 "..." "..."`. Delegate=needs-review → falls back. Asserts function output is exactly `FALLBACK rc=0,needs-review`. Asserts JSONL line records `"status":"ok"`.
  - [ ] **Test 6 — malformed JSON content**: starts `malformed_content` stub. Runs `run_val_classify 5 2 2 "..." "..."`. Asserts function output is exactly `FALLBACK rc=0,bad-shape`. Asserts JSONL line records `"status":"ok"`.
  - [ ] **Test 7 — invalid enum value**: starts `invalid_enum` stub. Runs `run_val_classify 5 2 2 "..." "..."`. Asserts function output is exactly `FALLBACK rc=0,bad-shape`. (The skill's case-statement enum guard treats any value not in `{pass, fail, needs-review}` as bad-shape, indistinguishable from missing-field case in the marker.) Asserts JSONL line records `"status":"ok"`.
  - [ ] **Test 8 — timeout**: starts `slow` stub. Sets `RALPH_DELEGATE_TIMEOUT_SECONDS=1`. Runs `run_val_classify 5 2 2 "..." "..."`. Asserts function output starts with `FALLBACK rc=124`. Asserts JSONL line records `"status":"timeout"`.
  - [ ] **Test 9 — disabled**: does NOT set `RALPH_DELEGATE_ENABLED`. Does NOT start a stub. Runs `run_val_classify 5 2 2 "..." "..."`. Asserts function output is exactly `FALLBACK rc=126`. Asserts the audit log file is BYTE-IDENTICAL before and after (capture `wc -c` pre/post; no log line on 126). Matches F4a's Test 4 and F4b's Test 5 invariant.
  - [ ] **Test 10 (optional, may be deferred) — unreachable**: sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:1` (a port nothing's listening on). Does NOT start a stub. Runs `run_val_classify 5 2 2 "..." "..."`. Asserts function output starts with `FALLBACK rc=127`. Asserts JSONL line records `"status":"unreachable"`. If keeping the suite at exactly 9 tests, fold this into the implementation but skip the bats assertion — or include it as a tenth test if the impl agent prefers.
  - [ ] Each test is hermetic: no global state leaks between tests, teardown cleans up STUB_PID and TEST_TMPDIR.
  - [ ] `bats plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats` passes locally and in CI (the existing `.github/workflows/ci.yml:126-129` bats glob auto-picks it up — no CI YAML change required).
  - [ ] `grep -c 'task=val_classify\|"task":"val_classify"' plugin/ralph-hero/scripts/__tests__/val-agent-delegation.bats` returns ≥3 (multiple tests reference the task name for audit-log assertions).
  - [ ] No regression: `bats plugin/ralph-hero/scripts/__tests__` (the whole directory) — F1's 8, F2's 8, F4a's 5, F4b's 7, and the 9 (or 10) new F4c tests all pass. Pre-existing `ralph-cli.bats:8` failure (unrelated to F4c; missing `/usr/bin/rm` on local macOS test box) is acceptable.

### Phase Success Criteria

#### Automated Verification:

- [ ] `bats plugin/ralph-hero/scripts/__tests__` — all tests pass (8 F1 + 8 F2 + 5 F4a + 7 F4b + 9 new F4c = 37 total, or 38 if Test 10 is included). No regression in F1, F2, F4a, F4b suites.
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` — green (TS source unchanged but matrix runs).
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched).
- [ ] CI `test-cli` job — green on the PR.
- [ ] CI `test-hooks` job — green on the PR.
- [ ] CI matrix builds (Node 18, 20, 22) — green.
- [ ] `find plugin/ralph-hero/agents -name 'val-agent-eval.md' | wc -l` returns `1` (eval file exists).
- [ ] `find plugin/ralph-hero/scripts/__tests__ -name 'val-agent-delegation.bats' | wc -l` returns `1` (bats file exists).
- [ ] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `1` (single wrapper invocation in skill body).
- [ ] `grep -c 'openai-compat.sh' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `0` (no direct adapter call from the skill).
- [ ] `grep -c '\-\-task val_classify' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns `1` (task name hardcoded once for audit log).
- [ ] `grep -c 'create_comment' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥1 (the Step 8 mutation step is preserved).
- [ ] `grep -cE 'Step 7\.0|Classify Verdict' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥1 (the new sub-step is present and headed correctly).
- [ ] `grep -c 'VERDICT_PREFIX' plugin/ralph-hero/skills/ralph-val/SKILL.md` returns ≥2 (variable set in Step 7.0, referenced in Step 7).
- [ ] `git diff plugin/ralph-hero/agents/val-agent.md` is empty (agent file unchanged; all delegation lives in the skill).
- [ ] `git diff plugin/ralph-hero/hooks/scripts/val-postcondition.sh` is empty (Stop hook unchanged; verdict tokens preserved).
- [ ] `git diff plugin/ralph-hero/skills/ralph-val/eval-scenarios.md` is empty (existing skill eval unchanged; F4c adds a new delegation-specific eval file).
- [ ] `wc -l plugin/ralph-hero/skills/ralph-val/SKILL.md` shows total ≤ `324 + 160` (the skill grew by no more than 160 lines; if it grew more, the new sub-step is too verbose and needs trimming).

#### Manual Verification:

- [ ] **Smoke 1 (delegated FAIL path)**: `gemma-up && export RALPH_DELEGATE_ENABLED=true`, then in a real worktree with ≥1 failing automated check (e.g., synthetically break a unit test in the F4c feature branch itself), invoke the skill. The verdict block starts with `VALIDATION FAIL` (or `VALIDATION FIX` if the failures are mechanical). The audit log gains one JSONL line with `task=val_classify, status=ok`. The `## Validation` comment posts on the issue with the standard verdict body.
- [ ] **Smoke 2 (delegated PASS via threshold gate)**: with delegation enabled and a worktree where all checks pass, invoke the skill. The verdict block starts with `VALIDATION PASS`. The audit log is byte-identical before and after (threshold gate trips; no wrapper call).
- [ ] **Smoke 3 (unreachable path)**: kill gemma-lab (`gemma-down` or `pkill -f mlx-openai-server`), keep `RALPH_DELEGATE_ENABLED=true`, run the skill against a worktree with ≥1 failing check. The skill's stdout contains a `delegation: fell back to native (rc=127)` line. The verdict block still starts with `VALIDATION FAIL` or `VALIDATION FIX` (native composition succeeded). The audit log gains one `status=unreachable` line.
- [ ] **Smoke 4 (disabled path)**: `unset RALPH_DELEGATE_ENABLED` and run the skill against a worktree with ≥1 failing check. The skill's stdout has no delegation note. The verdict block is composed natively. The audit log file is byte-identical before and after.
- [ ] **Smoke 5 (per-task override)**: `RALPH_DELEGATE_VAL_CLASSIFY_MODEL=mlx-community/qwen-3.5-27b-it RALPH_DELEGATE_ENABLED=true gemma-up` then run the skill. The audit log line records `model=mlx-community/qwen-3.5-27b-it` (override honored). The verdict is otherwise produced through the same cross-check + routing logic.
- [ ] **Smoke 6 (cross-check trip)**: configure a stub-or-real endpoint to return `{"classification": "pass"}` against a worktree with a substantive test failure (synthetically break a unit test). The skill's stdout contains a `delegation: cross-check failed (delegate=pass, substantive_failures=N) — falling back to native` line. The verdict block starts with `VALIDATION FAIL` (native composition correctly detected the substantive failure).
- [ ] **Smoke 7 (mutation never delegated)**: read `skills/ralph-val/SKILL.md` cover-to-cover. Confirm there is exactly one `ralph-delegate.sh` invocation and it appears strictly BEFORE the Step 8 `create_comment` invocation. Confirm no other step in the skill invokes the wrapper. Confirm `save_issue` and `advance_issue` are not invoked (the skill remains read-only). This is the manual audit version of the grep guards above and the literal answer to issue acceptance criterion #5.
- [ ] **10-issue agreement eval**: run the protocol from `agents/val-agent-eval.md`. Score 10 issues × verdict-prefix agreement. Document the 10-row agreement table and aggregate rate (target ≥80%) in a comment on issue #1190. Per issue acceptance criterion #1. Calibration metric — does not gate merge.
- [ ] **No leftover tempfiles**: after running smokes 1-4 once each, `find /tmp -name 'val-classify*' -mmin -5 2>/dev/null | wc -l` returns 0. (The skill's bash block uses `mktemp -t val-classify-XXXXXX`; the unconditional `rm -f` should leave no orphans.)
- [ ] **Document readthrough**: read `agents/val-agent-eval.md` cover-to-cover — can an operator re-run the 10-issue eval in under 30 minutes following only this document? Yes.
- [ ] **Worked-example fidelity**: open `skills/ralph-val/SKILL.md` (new Step 7.0 sub-step), `skills/ralph-pr/SKILL.md` (F4b's Step 5.0), `agents/codebase-locator.md` (F4a's Candidate Ranking), `skills/delegate-test/SKILL.md`, and `docs/delegation-authoring.md` side-by-side — the wrapper-call control flow (set +e + if OUTPUT=$(...) + case "$rc" + unconditional rm -f) is structurally identical in all five. The skill's bash block has task-specific deviations: (a) threshold-gate counts checks instead of files/lines, (b) JSON shape guard validates enum classification instead of `ranked` array or byte-length prose, (c) cross-check rule (Constraint #9, unique to F4c — no analog in F4a/F4b), (d) `--max-tokens 128 --temperature 0.0` (smaller budget for the enum response). Those are the only intentional deviations.

**Creates for next phase**: A third production-precedent for delegation in a real skill. The bash-block-in-a-skill-body pattern (with strict-enum JSON guard + cross-check) is the template the broader Wave-4 telemetry (F5, #1191) will aggregate counts against. The JSONL audit log gains its first `task=val_classify` lines. The eval-set document completes the trio of delegation-specific evals (locator/pr/val). The `classify` task name is now in production use alongside F4a's `locator` and F4b's `pr_description`; together the three exercise the conventions doc's eligible-list rows for `rerank`, `summarize`, and `classify` respectively — meaning Wave-3's three pilots prove the pattern works for the three most common closed-task primitives.

---

## Integration Testing

- [ ] **End-to-end with real endpoint, FAIL path** (manual, smoke 1): `gemma-up && export RALPH_DELEGATE_ENABLED=true && Skill("ralph-hero:ralph-val", "<issue-number>")` against a worktree with ≥1 failing check produces a `VALIDATION FAIL` (or `VALIDATION FIX`) verdict. Audit log has one `task=val_classify, status=ok` line.
- [ ] **End-to-end with real endpoint, PASS via threshold** (manual, smoke 2): worktree with all checks passing produces `VALIDATION PASS`; no audit-log line (threshold gate trips).
- [ ] **End-to-end with endpoint down** (manual, smoke 3): with delegation enabled but gemma killed, the skill prints `delegation: fell back to native (rc=127)`; verdict block is still populated natively; audit log records `status=unreachable`.
- [ ] **End-to-end with delegation disabled** (manual, smoke 4): with `RALPH_DELEGATE_ENABLED` unset, the skill's output is byte-identical to today's (no delegation note, same verdict structure). Audit log unchanged.
- [ ] **Cross-check guard fires** (manual, smoke 6): a delegate=pass with substantive_failures>0 triggers the cross-check fallback note; verdict block starts with `VALIDATION FAIL` (native correctness preserved).
- [ ] **Caller field in audit log** (manual): inspect the JSONL line written during smoke 1 — `caller` field is `ralph-val` or `val-agent` (best-effort, resolved from the live hook payload). If `caller=unknown`, this is a hook-context limitation outside F4c's scope.
- [ ] **Per-task override honored** (manual, smoke 5): setting `RALPH_DELEGATE_VAL_CLASSIFY_MODEL` overrides the default model; audit log records the override.
- [ ] **Mutation step preserved** (manual + automated): the `create_comment` invocation in Step 8 is byte-identical to main. `grep -c 'create_comment' skills/ralph-val/SKILL.md` ≥ 1. The skill remains read-only with respect to issue workflow state (`grep -c 'save_issue\|advance_issue'` returns the same value as today). Issue acceptance criterion #5.
- [ ] **No-regression** (automated): with delegation disabled (CI default), F1+F2+F4a+F4b bats suites and `npm test` all stay green on the PR.
- [ ] **10-issue agreement** (manual): the 10-row agreement table and aggregate rate from `agents/val-agent-eval.md` are documented in a comment on issue #1190. Calibration metric (target ≥80%), not a hard gate. Issue acceptance criterion #1.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1190
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 plan (foundation, merged): [thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md)
- F2 plan (adapter extraction, merged): [thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md)
- F3 plan (skill authoring pattern, merged): [thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md)
- F4a plan (codebase-locator delegation, merged): [thoughts/shared/plans/2026-05-12-GH-1188-codebase-locator-delegation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1188-codebase-locator-delegation.md)
- F4a review: [thoughts/shared/reviews/2026-05-13-GH-1188-critique.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-05-13-GH-1188-critique.md)
- F4b plan (pr-agent description delegation, merged): [thoughts/shared/plans/2026-05-12-GH-1189-pr-agent-description-delegation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1189-pr-agent-description-delegation.md)
- F4b review: [thoughts/shared/reviews/2026-05-13-GH-1189-critique.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-05-13-GH-1189-critique.md)
- Skill under modification: `plugin/ralph-hero/skills/ralph-val/SKILL.md`
- Agent (NOT modified, 11-line preloader): `plugin/ralph-hero/agents/val-agent.md`
- Stop hook (NOT modified, verdict-token contract preserved): `plugin/ralph-hero/hooks/scripts/val-postcondition.sh`
- Wrapper (the delegation surface): `plugin/ralph-hero/scripts/ralph-delegate.sh`
- F2 adapter (NOT called directly by skill): `plugin/ralph-hero/scripts/lib/openai-compat.sh`
- F3 reference skill (control-flow template): `plugin/ralph-hero/skills/delegate-test/SKILL.md`
- F4a sibling pattern (agent-body insertion + JSON-shape-guard template): `plugin/ralph-hero/agents/codebase-locator.md`
- F4b sibling pattern (skill-body insertion + threshold-gate + closest sibling for the bats helper): `plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- F3 authoring guide: `plugin/ralph-hero/docs/delegation-authoring.md`
- F3 conventions doc: `plugin/ralph-hero/skills/shared/delegation-conventions.md` (the `classify` row line 10 is the explicit eligibility for F4c)
- F1 wrapper bats suite (stub pattern template): `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- F4a sibling bats (helper-function template): `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats`
- F4b sibling bats (1:1 helper-function template + threshold-gate test): `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats`
- Existing skill eval (non-delegation, NOT modified): `plugin/ralph-hero/skills/ralph-val/eval-scenarios.md`
- Eval-scenarios style templates: `plugin/ralph-hero/agents/codebase-locator-eval.md`, `plugin/ralph-hero/agents/pr-agent-eval.md`
- README Delegation section: `plugin/ralph-hero/README.md:249-297`
- CI bats integration: `.github/workflows/ci.yml:126-129`
