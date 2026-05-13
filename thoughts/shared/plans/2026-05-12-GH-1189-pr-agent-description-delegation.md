---
date: 2026-05-12
status: draft
type: plan
github_issue: 1189
github_issues: [1189]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1189
primary_issue: 1189
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, pr-agent, pr-description, summarize, agent-delegation, bash-delegation, wave-3]
---

# F4b — `pr-agent`: PR Description from Diff via Delegation

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: [[2026-05-12-GH-1185-ralph-delegate-sh-foundation]]
- builds_on:: [[2026-05-12-GH-1186-openai-compat-shell-adapter]]
- builds_on:: [[2026-05-12-GH-1187-skill-authoring-pattern-delegate-test]]
- builds_on:: [[2026-05-12-GH-1188-codebase-locator-delegation]]
- references:: `plugin/ralph-hero/agents/pr-agent.md` — the agent body F4b wires delegation into (currently a 10-line skill preloader)
- references:: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` — the actual workflow body, where Step 5's PR-body composition is the delegate-eligible site
- references:: `plugin/ralph-hero/scripts/ralph-delegate.sh` — F1 wrapper (the single delegation surface)
- references:: `plugin/ralph-hero/scripts/lib/openai-compat.sh` — F2 adapter (NOT called directly)
- references:: `plugin/ralph-hero/skills/delegate-test/SKILL.md` — F3 reference skill (control-flow template)
- references:: `plugin/ralph-hero/docs/delegation-authoring.md` — F3 authoring guide (worked example + exit-code crib sheet)
- references:: `plugin/ralph-hero/skills/shared/delegation-conventions.md` — F3 conventions doc (`summarize` is on the eligible list with explicit "compress a diff" rationale)
- references:: `plugin/ralph-hero/agents/codebase-locator.md` (F4a, merged on `feature/GH-1188`) — sibling production-agent integration; closest structural template
- references:: `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (F4a) — bats stub pattern the new bats file mirrors 1:1
- references:: `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` — original bats stub pattern (Python HTTPServer)
- references:: `plugin/ralph-hero/skills/ralph-pr/eval-scenarios.md` — existing 3-scenario PR-skill eval doc (parallel style template for the new eval document)

## Overview

[N=1] single-issue plan for the LLM delegation epic's second real Wave-3 production integration:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1189 | F4b — pr-agent: PR description from diff via delegation | S |

Wire the `ralph-pr` skill's PR-body composition step (Step 5 of `skills/ralph-pr/SKILL.md`) to optionally delegate the **`## Summary` section text generation** to `ralph-delegate.sh` (task name `pr_description`). The skill already reads the implementation plan, gathers the diff via `git diff`, and composes a PR body template; today it writes the `## Summary` prose itself by reading the diff and plan in-context. After this feature, when `RALPH_DELEGATE_ENABLED=true` is set, the diff stat (`git diff --stat`) plus a short context blurb (plan-of-record + issue title) are sent to a local LLM (gemma-lab) which returns a 1-3-sentence summary. The skill substitutes that text into the `## Summary` block of the PR body template; everything else (`## Plan`, `## Test plan`, `Closes #NNN`) is composed natively. The actual `gh pr create` call is **never** delegated — only the prose generation step. The PR template shape is unchanged in both paths.

This is the second Wave-3 pilot — it copies F4a's wrapper-only, JSON-shape-guarded, threshold-gated delegation pattern but applies it to `summarize` (compress diff to 1-3 sentences) rather than `rerank` (sort candidate list). F4a (`codebase-locator`, #1188) is the closest structural template; F4c (`val-agent`, #1190) is the third sibling and not a dependency. The mutation step (`gh pr create`) is preserved exactly as-is in Step 5; the delegate-eligible work is exclusively the prose composition that feeds the `--body` argument.

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`) and F1/F2/F3/F4a plans:

1. **Opt-in only.** All new behavior is gated on `RALPH_DELEGATE_ENABLED=true`. With the variable unset (default), `ralph-pr` MUST behave bit-identically to today — same tool calls, same PR body shape, same files inspected, no audit-log writes. (F4a's Shared Constraint #1; same semantics.)
2. **Reuse the wrapper, not the adapter.** The skill MUST call `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task pr_description` (NOT `lib/openai-compat.sh` directly). Per the conventions doc, the adapter is internal; skills always go through the wrapper for the opt-in gate, env resolution, and audit log.
3. **Fail-open with audit trail.** The skill obeys the 5-value exit-code contract (0/1/124/126/127). Non-zero exits MUST trigger native summary composition — never crash, never block the agent's PR-creation flow. Specifically, `gh pr create` MUST still run with a non-empty `## Summary` section regardless of which path produced it.
4. **No GitHub mutations from the delegate.** The wrapper returns text. That text becomes the `## Summary` block in the PR body. The `gh pr create` call (the only GitHub-state mutation) is composed natively after the delegate returns and is run in Claude's turn. Per the conventions doc ineligibility row "tool-call mutations: ... [skills] must not turn that text into a mutation without a native review step" — the native review step here is Claude reading the delegated text before pasting it into the heredoc.
5. **No-regression invariant.** Pre-existing usage of `ralph-pr` (called from hero, autopilot, the loop runner, and manually) MUST produce byte-identical PR-body output structure when delegation is off. F1's 8 bats tests, F2's 8 bats tests, and F4a's 5 bats tests MUST continue to pass. Existing `npm test`, CI matrix, and the existing 3-scenario eval at `skills/ralph-pr/eval-scenarios.md` MUST stay green.
6. **Caller is responsible for fallback.** The wrapper does not provide a "native fallback" mode. The skill body's bash pattern MUST include the fallback branch verbatim from F3 / F4a (`set +e; if OUTPUT=$(...); then ... else rc=$?; case "$rc" in 126) ... ;; 127|124|1) ... ;; esac fi; set -e`).

Feature-specific extensions:

7. **Delegation is for *summarization only*, not for substituting the agent.** The conventions doc puts `summarize` on the eligible list with the explicit phrasing "compress a diff, comment thread, or long prose into 1-3 sentences. Output is bounded, lossy by design, and the caller reads it before any further action. A smaller model's coarser summary is acceptable." F4b delegates the *diff-to-1-3-sentence* compression step ONLY. Native Claude still: (a) chooses which diff slice to send (the stat + a bounded `git diff` excerpt), (b) decides whether the delegate's summary is sensible (and if not, falls back), (c) composes every other section of the PR body (`## Plan`, `## Test plan` checklist, `Closes #NNN` lines), (d) issues the `gh pr create` call. The delegate is never asked to produce the `gh` arguments or any text the user sees outside the `## Summary` block.
8. **Structured-text output from the delegate; no JSON envelope.** Unlike F4a (which expects a structured `{"ranked": [...]}` JSON envelope), F4b's task is free-text summarization. The delegate's prompt MUST instruct the model to emit exactly 1-3 sentences as plain prose, no Markdown headings, no bullet lists, no code fences. The skill validates the response shape with two lightweight `bash` guards: (a) byte length is `> 0` and `< 1024` (a 1-3-sentence summary fits comfortably below the limit; longer indicates the model went off the rails), (b) does NOT start with a Markdown heading character `#` (the delegate must not nest a `## Summary` inside the section the skill is going to wrap). If either guard fails, the skill treats it as a fallback path. This is the F4b analog of F4a's `jq -e .ranked` guard — same purpose (caller validates shape because the wrapper is text-in/text-out and does not understand task-specific schemas), different mechanism (no JSON, so plain-bash byte checks instead of `jq -e`).
9. **The diff is bounded before delegation.** Sending a multi-thousand-line diff to a local LLM is wasteful and produces worse summaries than sending the stat-line view. The skill MUST send: (a) `git diff --stat` (one line per changed file, ~50-200 bytes typical), (b) the issue title and the plan's `## Overview` first paragraph (if the plan exists at the path the artifact-comment-protocol resolves), (c) the first 60 lines of `git log` between merge-base and HEAD (the human-authored commit messages). This is roughly the F4a analog of "the candidate set is bounded before delegation" — same idea (cap inputs to keep the delegate cheap and on-task), different content (a stat + context blurb for summarize, a candidate list for rerank). The total prompt size MUST stay below 8 KB; if the inputs would exceed that, the skill truncates the commit-log section first (least informative for summarization), then falls back to native if still over the cap. Cap chosen so a typical gemma-26b 8k-context window does not need to truncate from the back, which would drop the assistant instructions.
10. **The threshold gate is "is there a meaningful diff at all".** Delegation fires only when `git diff --stat origin/main..HEAD` shows at least 2 files changed or at least 20 lines (insertions + deletions). Below this, the diff is too trivial for a model summary to add value vs the native one-liner Claude would produce from the issue title alone. Threshold is hard-coded at "2 files OR 20 lines" in v1; configurable later if Wave-3 telemetry shows the wrong cut. (F4a's analog: ≥5 candidates.)
11. **The substitution is text-only and bounded.** When the delegate returns a valid 1-3-sentence summary, the skill substitutes that text in place of the `[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview.]` placeholder in the Step 5 heredoc template. The skill does NOT modify any other part of the heredoc (`## Plan`, `## Test plan`, `Closes #NNN`, multi-repo cross-reference block). The substitution is a `sed`-style replacement inside the skill's bash, not a free-form rewrite. (F4a's analog: reorder candidate paths within subsections; same idea — narrow surgical edit, not free-form composition.)
12. **Per-task env overrides honored.** Operators may pin a different model for this task via `RALPH_DELEGATE_PR_DESCRIPTION_URL` / `RALPH_DELEGATE_PR_DESCRIPTION_MODEL`. F1 already resolves these without code changes here — the only requirement is that the skill passes `--task pr_description` consistently. (F1's per-task override key derives `RALPH_DELEGATE_<TASK_UPPER>_<SUFFIX>` from the task name; `pr_description` upper-cases to `PR_DESCRIPTION` with the underscore preserved — F1's `_resolve_task_var` uses `tr '[:lower:]-' '[:upper:]_'` which preserves underscores.) Verified by smoke check.
13. **Caller field in audit log is `ralph-pr` (or `pr-agent` if the hook context attributes by agent name).** The wrapper resolves `caller` from `RALPH_HOOK_INPUT.tool_input.caller_skill`. F4b does NOT set `RALPH_HOOK_INPUT` itself — it relies on the hook context that the Skill runtime already provides. If the field arrives as `unknown` in the audit log, this is a hook-context limitation outside F4b's scope (matches F4a's Shared Constraint #12 caveat); documented as "best effort".
14. **The `gh pr create` call is never delegated.** Verified by reading the modified skill file — `grep -c 'ralph-delegate.sh' skills/ralph-pr/SKILL.md` returns exactly `1` (the wrapper is invoked exactly once, in Step 5's pre-composition bash block). The `gh pr create` invocation remains in Step 5's heredoc, unchanged. (Issue acceptance criterion #5 explicitly demands this be verifiable by reading the modified file.)
15. **Quality compared, not enforced.** The new 3-PR eval document (`agents/pr-agent-eval.md`) documents an eyeball-comparison protocol on three real PRs (issue's acceptance criterion #1) but does NOT block the merge on a quality bar. Wave-3 establishes the integration; Wave-4 (F5 telemetry) is where ongoing quality monitoring lives.

## Current State Analysis

**What F1+F2+F3+F4a shipped (verified by reading source and git log):**

- `plugin/ralph-hero/scripts/ralph-delegate.sh` (308 lines, merged): the public wrapper. Owns: `RALPH_DELEGATE_ENABLED` opt-in gate, env resolution via `ralph_resolve_env`, per-task overrides (`RALPH_DELEGATE_<TASK_UPPER>_URL`/`_MODEL`), audit-log writes to `~/.ralph-hero/delegate.log`, `--health-check`, `--dry-run`, `--task`, `--max-tokens`, `--temperature`, `--prompt-file`, `--system-file`, exit-code translation (0/1/124/126/127). Sources F2's `lib/openai-compat.sh`. CLI surface includes `--max-tokens` and `--temperature` which F4b will use.
- `plugin/ralph-hero/scripts/lib/openai-compat.sh` (275 lines, merged): the sourceable adapter. Owns the HTTP+JSON request, `portable_timeout` wrapping, `jq` response parse. Skill/agent code does NOT touch this file directly — wrapper-only.
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (8 tests, green): hermetic Python HTTPServer stub pattern. Used as the template for F4a's bats file (`codebase-locator-delegation.bats`) and now for F4b's bats file.
- `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` (8 tests, green): F2's adapter tests; F4b does NOT modify.
- `plugin/ralph-hero/skills/delegate-test/SKILL.md` (60 lines, merged on PR #1230): F3 reference skill with the canonical `set +e; if OUTPUT=$(...); then ...; else rc=$?; case "$rc" in ...; esac fi; set -e; rm -f` control flow. F4b's bash block copies this 1:1 with two task-specific deviations (different prompt template, different output-shape guards).
- `plugin/ralph-hero/docs/delegation-authoring.md` (66 lines, merged): worked bash example, exit-code crib sheet (0/126/127/124/1), common-mistakes list. F4b cites this in the skill body's new section as the canonical authoring reference.
- `plugin/ralph-hero/skills/shared/delegation-conventions.md` (39 lines, merged): the eligibility matrix. Row 1 (eligible): `summarize` — "compress a diff, comment thread, or long prose into 1-3 sentences. Output is bounded, lossy by design, and the caller reads it before any further action. A smaller model's coarser summary is acceptable." This is the explicit justification for F4b's task; the row reads as if it were written for this feature.
- `plugin/ralph-hero/agents/codebase-locator.md` (F4a on `feature/GH-1188`, not yet merged to main as of plan authoring): added a `## Candidate Ranking (optional delegation)` H2 between Search Strategy and Output Format with the F3 control flow + `jq -e .ranked` guard + `mktemp -t locator-XXXXXX` prefix. The structural template for F4b's edit. F4a's commit message documents the three acceptance guards (`grep -c 'ralph-delegate.sh' == 1`, `grep -c 'openai-compat.sh' == 0`, `grep -c '## Candidate Ranking' == 1`) that F4b mirrors with task-specific strings.
- `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (F4a on `feature/GH-1188`): 5 tests (278 lines) mirroring `ralph-delegate.bats` setup/teardown + a `run_locator_rank()` helper that replicates the agent's bash block. F4b's bats file copies this 1:1 with task-specific stubs (`valid_summary`/`malformed_summary`/`oversized_summary`/`slow`) and a `run_pr_description_summarize()` helper.
- `.github/workflows/ci.yml:126-129` (merged): the `test-cli` job runs `bats-core/bats-action` over `plugin/ralph-hero/scripts/__tests__`. The directory glob auto-picks up new `*.bats` files — no CI YAML change required for F4b.

**What `pr-agent` / `ralph-pr` do today (verified by reading source):**

- **Agent file:** `plugin/ralph-hero/agents/pr-agent.md` (10 lines). Frontmatter: `name: pr-agent`, `description`, `model: haiku`, `tools: Read, Glob, Grep, Bash, mcp__plugin_ralph-hero_ralph-github__ralph_hero__{get,list,save,create_comment,advance}_issue`, `skills: [ralph-hero:ralph-pr]`. Body is a 1-line preloader (`You are a PR agent. Follow the preloaded ralph-pr instructions...`). The skill `ralph-hero:ralph-pr` is where the actual workflow lives — the agent just dispatches to it.
- **Skill file:** `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (218 lines). 8 steps:
  1. Parse args (`--worktree` flag, queue-pick fallback).
  2. Fetch issue.
  3. Determine worktree and branch.
  3a. Multi-repo PR detection.
  4. Push branch.
  5. **Create Pull Request** — the delegate-eligible composition site. Today this builds a `gh pr create --body "$(cat <<'PREOF' ...PREOF)"` heredoc where the `## Summary` section is a `[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview.]` placeholder that Claude fills in by reading the issue, the plan doc, and the diff in-context. After F4b, this placeholder is filled by the delegate when enabled (with the bounded-input prompt described in Shared Constraint #9), and natively otherwise.
  6. Move Issues to In Review.
  7. Post Comment with the PR URL.
  8. Report Result.
- **The composition step today (Step 5):**
  - Implicitly reads `git diff` (or `git log`) to understand what changed.
  - Reads the plan doc (Step 2 issue comments include a `## Implementation Plan` link).
  - Composes the `## Summary` block in Claude's in-context reasoning, types it directly into the heredoc.
  - Composes `## Plan`, `## Test plan` checklist, `Closes #NNN` natively (these are not in scope for F4b).
- **The mutation step today (Step 5, second half):** runs `gh pr create --title ... --body "$(cat <<'PREOF' ... PREOF)" --head feature/GH-NNN --base main`. The `--body` argument is the heredoc with all sections filled in. After F4b, only the `## Summary` placeholder substitution differs between delegated and native paths; the heredoc structure, the `gh pr create` invocation, and the rest of the body are identical.
- **Hooks wired to the skill:** `PreToolUse(ralph_hero__save_issue)` → `pr-state-gate.sh`; `SessionStart` → `set-skill-env.sh RALPH_COMMAND=pr RALPH_VALID_OUTPUT_STATES='In Review,Human Needed'`. Neither hook intercepts `Bash(...)` calls — the wrapper invocation is hook-free.
- **Existing eval:** `plugin/ralph-hero/skills/ralph-pr/eval-scenarios.md` (3 scenarios: standalone, group, cross-repo). F4b does NOT modify this file. F4b adds a new file at `plugin/ralph-hero/agents/pr-agent-eval.md` for the 3-PR delegated-vs-native eyeball comparison (matching the F4a precedent of putting the delegation-specific eval next to the agent).

**What does NOT exist (verified by file listings):**

- No `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` — F4b creates it.
- No `plugin/ralph-hero/agents/pr-agent-eval.md` — F4b creates it.
- No delegation site in `skills/ralph-pr/SKILL.md` today.

**Tooling assumptions on the target machine:**

- `bash` (4.x or 5.x), `curl`, `jq`, `mktemp`, `wc`, `python3` (for the bats stub), `git`, `gh` — same as F1/F2/F3/F4a plus `git diff --stat` and `gh pr create` which are already pr-agent prerequisites today.
- The Skill runtime makes `$CLAUDE_PLUGIN_ROOT` available inside `Bash` tool calls from skill bodies (verified by `delegate-test/SKILL.md` already using `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh` and the runtime making the var resolve correctly at execution time).
- The Skill runtime allows `Bash` to invoke arbitrary scripts on the operator's machine (no hook intercepts `ralph-delegate.sh` per F1's acceptance criterion 7 and F4a's verified smoke check).

## Desired End State

After F4b merges:

1. `plugin/ralph-hero/skills/ralph-pr/SKILL.md` is updated to insert a "Step 5.0: Compose `## Summary` (optional delegation)" sub-section **before** the existing Step 5 heredoc that runs `gh pr create`. The sub-section documents the delegated summary path, the native fallback path, and the skill's responsibility to substitute the result into the heredoc placeholder regardless of which path ran. The wording is operational, not hand-wavy — a Haiku-tier model reading the section MUST be able to execute the composition step correctly in both paths.
2. The skill body includes a copy-paste-ready bash block in the new "Step 5.0" sub-section that wraps the wrapper call in the canonical F3/F4a control flow. The block:
   - Computes `DIFF_STAT=$(git diff --stat origin/main..HEAD)` and the threshold gate (≥2 files OR ≥20 lines).
   - Below threshold: assigns `SUMMARY_TEXT` natively (one-line from the issue title), skips delegation entirely, prints nothing about delegation.
   - At/above threshold: builds a tempfile prompt containing the stat + issue title + plan overview snippet + recent commit messages (capped at 8 KB total per Shared Constraint #9).
   - Calls `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task pr_description --prompt-file <tempfile> --max-tokens 256 --temperature 0.2` inside `set +e; if OUTPUT=$(...); ...; fi; set -e`. `--max-tokens 256` is chosen because 1-3 sentences fit comfortably (typical 30-100 tokens) with headroom for the model's chain-of-thought it sometimes leaks before the actual summary; `--temperature 0.2` matches the wrapper default and produces deterministic-enough summaries for the eyeball-comparison eval.
   - On exit 0: applies the two shape guards (byte length `> 0` and `< 1024`; does NOT start with `#`). Pass → `SUMMARY_TEXT=$OUTPUT` and the substitution happens later in Step 5 (the heredoc's placeholder is replaced via `sed`-style or by inlining `$SUMMARY_TEXT` directly in the heredoc). Fail → treats as a fallback exit (logs nothing additional; the wrapper already wrote `status=ok` but the skill privately discards the un-usable output and prints `delegation: fell back to native (rc=0, bad-shape)`).
   - On exit 126: silently composes natively (no note printed, per the 126-no-log invariant).
   - On exit 127/124/1: prints `delegation: fell back to native (rc=$rc)` (the operator-visible signal that delegation was on but failed), then composes natively.
   - Cleans up the tempfile unconditionally.
3. Step 5's existing `gh pr create` heredoc is modified ONLY to substitute the placeholder line with `$SUMMARY_TEXT`. The `gh pr create` invocation itself, the heredoc structure (`## Summary` / `## Plan` / `## Test plan` / `Closes #NNN`), the `--title`, `--head`, `--base` arguments are byte-identical to today. Verified by reading the modified file.
4. `plugin/ralph-hero/agents/pr-agent-eval.md` exists. It defines a 3-PR comparison protocol (matching issue acceptance criterion #1's "manual eyeball on 3 real PRs"), the comparison procedure (delegated body vs native body, side-by-side, per the 4 criteria in the doc), and the re-run instructions. Operator-runnable, ~100 lines, not automated in v1. The doc lives in `agents/` rather than `skills/ralph-pr/` to mirror F4a's `agents/codebase-locator-eval.md` placement (delegation-specific evals live next to the agent, not next to the existing skill eval).
5. `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` exists. It contains a small bats suite that exercises the skill's bash block in isolation (replicated 1:1 as `run_pr_description_summarize()` helper) against the F1/F4a Python HTTPServer stub pattern. Covers: delegation enabled + ok stub returning short prose summary, delegation enabled + stub returning oversized prose (length guard trips, falls back), delegation enabled + stub returning prose starting with `#` heading (shape guard trips, falls back), delegation enabled + slow stub (timeout 124), delegation disabled (126 path, byte-identical log), endpoint unreachable (127 path), threshold-gate triggered (below threshold → no wrapper call, no audit-log line). 7 tests total.
6. The skill's existing `allowed-tools` list (Read, Glob, Bash, MCP tools) is unchanged — `Bash` already covers the wrapper invocation.
7. The skill's hook wiring (`PreToolUse(ralph_hero__save_issue)` → `pr-state-gate.sh`, `SessionStart` → `set-skill-env.sh`) is unchanged. Neither hook intercepts `Bash(ralph-delegate.sh ...)`.
8. The skill's frontmatter (`description`, `user-invocable`, `argument-hint`, `context`, `model`, `allowed-tools`) is unchanged. Only the body adds new content.
9. With `RALPH_DELEGATE_ENABLED` unset (the default), `ralph-pr` does not invoke `ralph-delegate.sh` at all — no audit-log line, no tempfile churn, no behavioral drift. Verified by the bats test for the 126 path + by an operator smoke check.
10. With `RALPH_DELEGATE_ENABLED=true` and `gemma-up` running, invoking `ralph-pr` (via `Skill()`, `Agent()`, or the loop runner) on a real worktree appends one `task=pr_description, status=ok` JSONL line per PR-creation run to `~/.ralph-hero/delegate.log`.
11. With `RALPH_DELEGATE_ENABLED=true` and `gemma-down`, invoking the skill prints the `delegation: fell back to native (rc=127)` line in the skill's stdout and appends one `task=pr_description, status=unreachable` JSONL line.
12. With a trivial diff (1 file, 5 lines), the skill does NOT call the wrapper at all (threshold gate trips). Verified by the bats test for the threshold path + by the byte-equality assertion on `wc -c` of the audit log file before and after the small-diff scenario.
13. All 5 issue-defined acceptance criteria are satisfied (see Verification below).

### Verification

- [ ] **End-to-end with real endpoint** (manual): `gemma-up && export RALPH_DELEGATE_ENABLED=true`, then in a real worktree with a non-trivial diff (≥2 files OR ≥20 lines), invoke `ralph-pr <issue-number>`. Output is the standard `PR CREATED` block. The `gh pr view` output's body has a `## Summary` block populated with 1-3 sentences. The audit log gains one `task=pr_description, status=ok` JSONL line. The PR descriptions on the resulting PR are qualitatively comparable to native (manual eyeball; gate of issue acceptance criterion #1).
- [ ] **End-to-end with endpoint down** (manual): with delegation enabled but gemma killed, invoke the skill against the same worktree. Skill output contains a `delegation: fell back to native (rc=127)` line. The `gh pr view` body still has a populated `## Summary` block (native composition succeeded). The audit log gains one `status=unreachable` JSONL line.
- [ ] **End-to-end with delegation disabled** (manual): with `RALPH_DELEGATE_ENABLED` unset, invoke the skill. Output is byte-identical to today's (no delegation note, same PR body structure, summary composed by native Haiku in-context judgment). Audit log file is byte-identical before and after.
- [ ] **Shape-guard trip on bad delegate output** (manual): point the skill at a stub that returns a 2 KB chat-completion content (oversized). The skill's length guard trips, falls back to native composition with a `delegation: fell back to native (rc=0, bad-shape)` note. Audit log records `status=ok` (the wrapper succeeded at the HTTP layer; the shape failure is the skill's concern, not the wrapper's). Same path for a delegate output starting with `# `.
- [ ] **Threshold gate trips on trivial diff** (manual): in a worktree with a 1-file, 5-line diff, invoke the skill with delegation enabled. The skill does NOT invoke the wrapper (no tempfile created, no audit-log line written). The PR body's `## Summary` is composed natively as if delegation were off. Operator verifies by `wc -l ~/.ralph-hero/delegate.log` pre/post.
- [ ] **3-PR eyeball eval** (manual): pick 3 recent merged PRs (real ralph-hero PRs from the current session: #1224, #1228, #1230 are candidates per recent git log). For each, simulate both paths (delegated by re-running locally, native by reading the original body). Compare per the 4 criteria in `agents/pr-agent-eval.md` (clarity, fidelity, length, no-hallucination). Document per-PR judgment in a comment on issue #1189. (Issue acceptance criterion #1: "qualitatively comparable to native".)
- [ ] **Mutation-step audit** (manual, issue acceptance criterion #5): read the modified `skills/ralph-pr/SKILL.md`. Confirm `grep -c 'gh pr create' SKILL.md` returns ≥1 (the `gh pr create` heredoc is preserved). Confirm `grep -c 'ralph-delegate.sh' SKILL.md` returns exactly `1` (the wrapper is invoked exactly once). Confirm the bash block calling the wrapper appears BEFORE the `gh pr create` heredoc, never after, and that `gh pr create` is never invoked from within an `if OUTPUT=$(...)` guard.
- [ ] **No-regression**: `bats plugin/ralph-hero/scripts/__tests__` runs all existing tests + the new `pr-agent-delegation.bats` (7 new tests) — all green. F4a's `codebase-locator-delegation.bats` (if F4a merged first) continues to pass without changes.
- [ ] **TypeScript builds**: `npm run build` and `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched but the matrix runs).
- [ ] **CI green**: `test-cli`, `test-hooks`, `test-matrix` jobs all green on the PR.

## What We're NOT Doing

- **NOT** delegating the `gh pr create` call. The mutation step stays native, period. Verifiable by reading the modified skill file (Shared Constraint #14; issue acceptance criterion #5).
- **NOT** delegating any other step in the skill (push branch, issue fetch, plan-link comment, workflow-state transition). Only Step 5.0's `## Summary` composition is touched.
- **NOT** delegating the `## Plan`, `## Test plan`, or `Closes #NNN` sections of the PR body. The delegate emits the summary text only; the rest of the heredoc is composed natively in the same step.
- **NOT** delegating the full PR title generation. The `--title "GH-NNN: [issue title]"` argument is derived from the fetched issue and never sent to the delegate.
- **NOT** delegating in the multi-repo PR-creation flow (Step 3a). When multiple worktrees are detected, the skill creates one PR per repo; for v1 the delegation site applies only to the single-repo default path (Step 5). Multi-repo delegation is a follow-up if Wave-3 telemetry shows demand.
- **NOT** plumbing `--validate-json-output` through `ralph-delegate.sh`. F4b's output is plain prose, not JSON; the shape guards are byte-length and leading-character checks, not JSON parsing.
- **NOT** introducing telemetry. F5 (`#1191`) owns `ralph status --delegation` and per-task aggregations.
- **NOT** touching the sibling F4 integrations. F4a (`codebase-locator`, #1188) and F4c (`val-agent`, #1190) are independent plans owned by their own issues.
- **NOT** modifying `ralph-delegate.sh`, `openai-compat.sh`, F1's bats suite, F2's bats suite, or F4a's bats suite.
- **NOT** modifying the skill's `allowed-tools` list, hook wiring, frontmatter, or any step other than Step 5.
- **NOT** modifying the `pr-agent.md` agent file. The agent is a 10-line skill preloader; all of the workflow lives in the skill, which is where the delegation site is added. (Issue scope explicitly allows both files in the modification surface; we choose the skill alone for minimum blast radius.)
- **NOT** changing the existing `skills/ralph-pr/eval-scenarios.md` (3 scenarios: standalone/group/cross-repo). F4b adds a separate `agents/pr-agent-eval.md` for the delegation comparison; the original eval continues to validate the skill's primary PR-creation paths.
- **NOT** changing the PR body shape (`## Summary` / `## Plan` / `## Test plan` / `Closes #NNN`). The placeholder text inside the `## Summary` section is what changes; the surrounding headers and template do not.
- **NOT** building a Python or Node helper for prompt construction. The skill body's bash block uses `cat > $PROMPT_FILE <<EOF ... EOF` — same pattern as F3 / F4a.
- **NOT** introducing an MCP tool for delegation. Per the conventions doc, skill code calls the wrapper via `Bash`, period.
- **NOT** changing the skill's or agent's model tier (haiku). The wrapper handles the heavier-model delegation when enabled; Haiku's role is unchanged in the native path.
- **NOT** providing a fallback for the case where the `jq` or `git` binary is missing. Both are hard deps of the skill today; if they're missing, the skill fails first with a different error before the delegation block runs.
- **NOT** adding eval automation. The `pr-agent-eval.md` document is operator-runnable; automation lives in a future feature if the operator wants nightly drift detection.

## Implementation Approach

Implementation proceeds in three task groups inside a single phase. Tasks 1.1 and 1.2 can be done in either order (1.2 depends on 1.1 only for the prose-block reference, not the eval logic); Task 1.3 depends on 1.1 because the bats tests exercise the bash block that 1.1 introduces.

1. **Skill body update.** Edit `plugin/ralph-hero/skills/ralph-pr/SKILL.md` to insert a new sub-step "Step 5.0: Compose `## Summary` (optional delegation)" between the existing Step 5 heading and the existing `gh pr create` heredoc. The sub-step includes the worked bash block (copy-paste from F4a's `## Candidate Ranking` section, swap `--task locator` → `--task pr_description`, swap `jq -e .ranked` JSON guard → byte-length + leading-character bash guards, swap candidate-list prompt → diff-stat + issue-title + plan-overview prompt). The skill body MUST remain coherent: existing Step 4 (Push Branch), Step 5 heredoc, Step 6 (Move Issues), Step 7 (Post Comment), Step 8 (Report Result) all unchanged.
2. **Eval document.** Author `plugin/ralph-hero/agents/pr-agent-eval.md` with the 3-PR comparison protocol (matching issue acceptance criterion #1). The doc defines: (a) how to select the 3 PRs (criteria: ≥2-file diff, ≥20-line diff, recent enough to fetch via `gh pr view`), (b) the 4 comparison criteria (clarity, fidelity to diff, length 1-3 sentences, no hallucination), (c) the re-run procedure (manual; not automated in v1), (d) what to record in the issue-1189 comment.
3. **Bats coverage.** Create `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats`. 7 tests, each replicating the skill's bash block in isolation as `run_pr_description_summarize()`. Stubs reuse the F1/F4a Python HTTPServer pattern with new modes (`valid_summary`, `oversized_summary`, `heading_prefix`, `slow`, `ok_default`). Test cases: (1) happy path (≥-threshold diff, delegate returns short prose, summary applied); (2) oversized prose (≥1024 bytes, length guard trips, falls back); (3) prose starts with `#` (shape guard trips, falls back); (4) timeout (rc=124, falls back with note); (5) disabled (rc=126, no log line, byte-identical audit log); (6) unreachable (rc=127, falls back with note); (7) threshold gate (<2 files AND <20 lines → no wrapper call, no audit-log line, no tempfile).

There is exactly one Phase. No `depends_on` between phases is needed; the task-level `depends_on` field captures intra-phase order.

---

## Phase 1: GH-1189 — `ralph-pr` PR description from diff via delegation
- **depends_on**: null

### Overview

Wire the `ralph-pr` skill's Step 5 `## Summary`-composition step to optionally delegate to `ralph-delegate.sh --task pr_description`. Native Claude still composes the rest of the PR body (`## Plan`, `## Test plan`, `Closes #NNN`) and issues the `gh pr create` call unchanged; the delegate only contributes the 1-3-sentence summary text when enabled and the diff is non-trivial. Includes a 3-PR eyeball eval document for ongoing quality comparison and a bats test suite exercising the skill's bash control flow against a hermetic HTTPServer stub.

### Tasks

#### Task 1.1: Update `skills/ralph-pr/SKILL.md` to embed the delegation pattern
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify), `plugin/ralph-hero/agents/codebase-locator.md` (read — F4a structural template), `plugin/ralph-hero/skills/delegate-test/SKILL.md` (read — control-flow template), `plugin/ralph-hero/docs/delegation-authoring.md` (read — worked example), `plugin/ralph-hero/skills/shared/delegation-conventions.md` (read — `summarize` eligibility), `plugin/ralph-hero/scripts/ralph-delegate.sh` (read — CLI surface), `plugin/ralph-hero/agents/pr-agent.md` (read — confirm no agent-body change needed)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] The skill's frontmatter is unchanged (`description`, `user-invocable: false`, `argument-hint`, `context: fork`, `model: haiku`, `hooks` block, `allowed-tools` list — all byte-identical to today).
  - [ ] The skill body's existing Step 1 (Parse Arguments), Step 2 (Fetch Issue), Step 3 (Determine Worktree), Step 3a (Multi-Repo Detection), Step 4 (Push Branch), Step 6 (Move Issues), Step 7 (Post Comment), Step 8 (Report Result) are unchanged in wording.
  - [ ] A new H3 sub-step `### Step 5.0: Compose `## Summary` (optional delegation)` is inserted in the skill body **between** the existing `## Step 5: Create Pull Request` H2 heading + its intro paragraph AND the `gh pr create \` bash block. The placement reflects the skill's operational order: gather (Steps 1-4) → compose summary (new Step 5.0) → invoke `gh pr create` (existing Step 5 heredoc).
  - [ ] The new sub-step opens with a 2-3-sentence overview: when delegation is enabled (`RALPH_DELEGATE_ENABLED=true`), the diff's stat-line view + the issue title + the plan's `## Overview` snippet are sent to a local LLM via `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh --task pr_description`, which returns a 1-3-sentence summary. The skill substitutes the result into the `## Summary` section of the PR body heredoc below; everything else (`## Plan`, `## Test plan`, `Closes #NNN`, the `gh pr create` call) is composed natively. Delegation is opt-in (operator sets the env var); when off, the skill composes the summary natively as today.
  - [ ] The sub-step contains a fenced bash block that is structurally identical to F4a's `## Candidate Ranking` block (set +e, `if OUTPUT=$(...)` guard, case "$rc" handling, unconditional `rm -f`, `mktemp -t pr-description-XXXXXX`). The block:
    - Computes the threshold gate:
      ```bash
      DIFF_STAT=$(git diff --stat origin/main..HEAD 2>/dev/null || echo "")
      FILES_CHANGED=$(printf '%s\n' "$DIFF_STAT" | grep -cE '^ [^|]+ \|' || echo 0)
      LINES_CHANGED=$(printf '%s\n' "$DIFF_STAT" | grep -oE '[0-9]+ insertion|[0-9]+ deletion' | grep -oE '^[0-9]+' | awk '{s+=$1} END {print s+0}')
      if [ "$FILES_CHANGED" -lt 2 ] && [ "$LINES_CHANGED" -lt 20 ]; then
          # Below threshold — compose natively, skip delegation entirely
          SUMMARY_TEXT="<native one-line summary from issue title>"
      else
          # ... threshold met, proceed to delegation gate below
      fi
      ```
    - Composes a prompt of the shape (only when above threshold):
      ```
      Summarize the following changes into 1-3 plain prose sentences.
      No Markdown headings. No bullet lists. No code fences.

      Issue: ${ISSUE_TITLE}
      Plan overview: ${PLAN_OVERVIEW_SNIPPET}
      Diff stat:
      ${DIFF_STAT}

      Recent commits:
      ${RECENT_COMMITS}
      ```
    - Caps the prompt file at 8 KB total; if `wc -c < $PROMPT_FILE` is over 8192, truncates the `Recent commits:` block first by `head -c 4096`, re-checks, and falls back to native if still over. (Matches Shared Constraint #9.)
    - Calls `"$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" --task pr_description --prompt-file "$PROMPT_FILE" --max-tokens 256 --temperature 0.2 2>/dev/null` inside an `if OUTPUT=$(...)` guard.
    - Validates the response with two bash guards: `bytes=$(printf '%s' "$OUTPUT" | wc -c | tr -d ' '); first=$(printf '%s' "$OUTPUT" | head -c 1)`. If `bytes -gt 0 && bytes -lt 1024 && first != "#"`, sets `SUMMARY_TEXT=$OUTPUT` and applies the substitution. Otherwise, prints `delegation: fell back to native (rc=0, bad-shape)` and composes natively.
    - On exit 0 + valid shape: `SUMMARY_TEXT` holds the delegate's output. Later in Step 5's heredoc, the placeholder is substituted by inlining `${SUMMARY_TEXT}` directly (the heredoc uses unquoted `EOF` or `PREOF` so shell variables expand; the existing skill uses `<<'PREOF'` with quoted PREOF which does NOT expand variables — the skill body will be updated to use unquoted heredoc OR to use a `sed -i` substitution on a temp body file before passing to `gh pr create --body-file`).
    - On exit 126: silently composes natively (no note printed, per the 126-no-log invariant in `docs/delegation-authoring.md`).
    - On exit 127/124/1: prints `delegation: fell back to native (rc=$rc)` ABOVE the structured output, then composes natively.
    - `rm -f "$PROMPT_FILE"` runs unconditionally at the end (outside the `if/else/fi`).
  - [ ] The sub-step explicitly notes: "Delegation is for **summary text only**. The `gh pr create` call below is composed and invoked natively in all cases — the delegate's output is text-in for the `## Summary` block and nothing else. Never let delegated text reach the `gh pr create` arguments outside the body heredoc." This matches conventions doc rationale for the `summarize` row and the no-mutation rule (#14).
  - [ ] The sub-step mentions the per-task override env vars (`RALPH_DELEGATE_PR_DESCRIPTION_URL`, `RALPH_DELEGATE_PR_DESCRIPTION_MODEL`) in a one-liner — not as documentation, but as a hint that operators may pin a different model for this task.
  - [ ] The existing Step 5 heredoc is modified to substitute `${SUMMARY_TEXT}` for the placeholder line `[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview.]`. The cleanest way (preserving the `<<'PREOF'` quoted heredoc behavior) is to write the heredoc to a tempfile first, run `sed -i "s|\[1-3 sentences describing what this PR does, sourced from the issue body or plan Overview\.\]|${SUMMARY_TEXT}|"` on it, then pass `--body-file <tempfile>` to `gh pr create`. The skill body documents this substitution mechanism inline so a Haiku reading it can execute correctly. The `gh pr create` invocation's `--title`, `--head`, `--base`, and the body shape (header/footer of the heredoc) are byte-identical to today.
  - [ ] The skill's existing Step 5 intro paragraph ("Build the PR body using the enriched template below...") is unchanged in wording.
  - [ ] The total file size grows by 60-120 lines (roughly the size of the new sub-step). If it grows past 150 added lines, the section is too verbose — trim the bash block comments or the rationale paragraphs.
  - [ ] `bash -n` syntax-checks cleanly against the bash block (extract with `sed -n '/^```bash$/,/^```$/p' plugin/ralph-hero/skills/ralph-pr/SKILL.md | sed '1d;$d' | bash -n -`).
  - [ ] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `1` (single wrapper call, no accidental loop, no nested invocation).
  - [ ] `grep -c 'openai-compat.sh' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `0` (skill does NOT call the adapter directly — must go through wrapper).
  - [ ] `grep -c '\-\-task pr_description' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `1` (task name is hardcoded once for stable audit-log lookup).
  - [ ] `grep -c 'gh pr create' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥1 (the mutation step is preserved). Note: the existing skill has 2 `gh pr create` occurrences (Step 3a multi-repo + Step 5 single-repo); the modified file should have the same count (Step 3a is not in scope for delegation in v1).
  - [ ] `grep -c '## Step 5.0' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `1` OR `grep -c 'Step 5.0' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `1` (the new sub-step is present and headed correctly; the level — H2 vs H3 — is the impl agent's choice based on which renders better in the skill body).
  - [ ] `plugin/ralph-hero/agents/pr-agent.md` is NOT modified. `git diff plugin/ralph-hero/agents/pr-agent.md` is empty after this task. (The agent is a 10-line skill preloader; all work lives in the skill.)

#### Task 1.2: Author `agents/pr-agent-eval.md` with 3-PR comparison protocol
- **files**: `plugin/ralph-hero/agents/pr-agent-eval.md` (create), `plugin/ralph-hero/agents/codebase-locator-eval.md` (read — F4a style template, if on a branch you can resolve; otherwise use `skills/ralph-pr/eval-scenarios.md` and `skills/ralph-split/eval-scenarios.md` as style templates), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (read — skill's expected PR-body format)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/agents/pr-agent-eval.md`, opens with frontmatter matching the F4a / `eval-scenarios.md` style:
    ```yaml
    ---
    type: eval-scenarios
    agent: pr-agent
    date: 2026-05-12
    status: defined
    ---
    ```
  - [ ] File body opens with H1 `# PR-Agent Delegation Eval`.
  - [ ] Opens with a 1-paragraph "Execution note": these are operator-runnable comparison scenarios for the ralph-pr skill's delegated vs native `## Summary` composition. Re-runnable as quality drifts. Not automated in v1. Mirrors the framing in F4a's eval doc.
  - [ ] Defines a "PR selection criteria" section listing what to pick:
    - Pick 3 real PRs from the ralph-hero repo with `diff --stat`-line counts ≥2 files OR ≥20 lines (threshold gate met).
    - Spread across different change kinds: (a) one TypeScript-heavy PR (MCP server change), (b) one bash-heavy PR (scripts/hooks change), (c) one docs-or-Markdown-heavy PR (plan/research/skill body change).
    - Use recent merged PRs so the diffs are fetchable via `gh pr view <N> --json files,additions,deletions`. Three plausible candidates (current session merges): PR #1224 (F1), PR #1228 (F2), PR #1230 (F3). The operator picks the actual 3 at run time — these are starting suggestions.
  - [ ] Defines the 4 comparison criteria (each as a bullet point with a one-sentence guideline):
    1. **Clarity** — Can a reviewer understand what changed in 5 seconds from reading the summary?
    2. **Fidelity to diff** — Does the summary mention the right files / subsystems? Any hallucinations (e.g., claiming a feature was added when the diff is docs-only)?
    3. **Length** — Is the summary 1-3 sentences (not 1 word, not 5 sentences)?
    4. **No hallucination** — Does the summary stick to what's actually in the diff, or invent details?
  - [ ] Defines a "Comparison protocol" section:
    1. With `RALPH_DELEGATE_ENABLED=true && gemma-up`, in the worktree of each selected PR (check out the PR's branch via `gh pr checkout <N>`), invoke `ralph-pr <issue-number>` to a draft destination (or `--dry-run`-style equivalent — manual via `gh pr create --draft` is acceptable v1). Capture the resulting `## Summary` block. Discard the draft PR.
    2. With `unset RALPH_DELEGATE_ENABLED`, repeat. Capture the second `## Summary` block.
    3. For each PR, score the delegated and native summaries against the 4 criteria, with one short comment per criterion. Result is a 2-column-by-4-row scoring table per PR (delegated / native, one row per criterion).
    4. Compute an aggregate judgment: across 12 cells (3 PRs × 4 criteria), does delegated match or beat native on at least 8 cells? If yes, "qualitatively comparable" (issue acceptance criterion #1) is satisfied.
    5. Document the per-PR table and the aggregate judgment in a comment on issue #1189.
    6. Acceptable baseline: 8 of 12 cells "match or beat". Below threshold triggers a prompt-refinement review (probably tweak the system prompt to emphasize fidelity); not a merge blocker — calibration metric, per Shared Constraint #15.
  - [ ] Includes a brief "What this does NOT measure" section: this eval compares the prose summary block in isolation. It does NOT measure: (a) absolute correctness (the "gold" body is also LLM-authored), (b) the rest of the PR body (`## Plan`, `## Test plan`, `Closes #NNN`), (c) whether `gh pr create` succeeds (covered by the existing `skills/ralph-pr/eval-scenarios.md`).
  - [ ] Includes a "Re-run cadence" subsection: re-run the 3-PR eval after model swaps (`RALPH_DELEGATE_PR_DESCRIPTION_MODEL` change), after wrapper changes (F5/F6), or quarterly during Wave-4 telemetry review. Document drift in a follow-up comment on the issue.
  - [ ] No more than ~140 lines total. The eval is operator documentation, not a benchmark report. (Matches F4a's eval-file length budget.)

#### Task 1.3: Write `pr-agent-delegation.bats` covering the skill's bash block
- **files**: `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` (create), `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (read — F4a's 1:1 template), `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (read — original stub pattern), `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (read — the bash block under test)
- **tdd**: true
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats`. Shebang `#!/usr/bin/env bats`. File-level comment explains: exercises the `## Summary`-composition bash block from `skills/ralph-pr/SKILL.md` against a hermetic Python HTTPServer stub; mirrors F4a's `codebase-locator-delegation.bats` 1:1 in stub/setup/teardown structure, with task-specific stub modes and a `run_pr_description_summarize()` helper.
  - [ ] `setup()` and `teardown()` are byte-identical to `codebase-locator-delegation.bats:13-32` modulo the env-var names: `TEST_TMPDIR=$(mktemp -d)`, exports `RALPH_DELEGATE_LOG_PATH`, unsets caller env vars including the per-task overrides (`RALPH_DELEGATE_PR_DESCRIPTION_URL`, `RALPH_DELEGATE_PR_DESCRIPTION_MODEL`), starts/stops `STUB_PID`/`STUB_PORT`.
  - [ ] A helper function `start_pr_description_stub_endpoint <mode>` is defined. Modes:
    - `valid_summary` — returns chat-completion content `"This PR wires the ralph-pr skill to optionally delegate its summary composition via ralph-delegate.sh. The mutation step is preserved. Threshold gate fires below 2 files or 20 lines."` (3 sentences, well under 1024 bytes, no leading `#`).
    - `oversized_summary` — returns chat-completion content `printf 'x%.0s' {1..2048}` (2048 bytes of `x` characters, well over the 1024-byte length guard).
    - `heading_prefix` — returns chat-completion content `"# Pull Request\n\nThis change does foo."` (starts with `#`, length-guard pass but first-char guard fails).
    - `slow` — sleeps 3s (for timeout test; matches F4a's `slow` mode).
    - `ok_default` — returns a generic `"summary stub"` ok chat-completion (unused in tests but kept for parity with F4a stub).
    - Copy the Python HTTPServer stub from `codebase-locator-delegation.bats:52-118` adapted for these modes.
  - [ ] An extracted-or-replicated bash function `run_pr_description_summarize()` represents the skill's bash block under test. It accepts a `diff_stat` string + an `issue_title` string + a `commits` string (newline-joined), composes the prompt, invokes the wrapper, validates the response via the two bash guards (`bytes > 0 && bytes < 1024 && first_char != "#"`), and prints either the summary text (success) or a fallback marker line (`FALLBACK rc=$rc` or `FALLBACK rc=0,bad-shape`). The helper does NOT execute `git diff --stat` or `gh pr create` — only the delegate-call portion of the skill's bash. Document in a comment at the top of the bats file: "The function under test mirrors the bash block in `skills/ralph-pr/SKILL.md` Step 5.0. Update both in lockstep."
  - [ ] A second helper `run_pr_description_with_threshold(<files>, <lines>)` represents the threshold-gate portion. It returns `BELOW_THRESHOLD` if `files < 2 && lines < 20`, else calls `run_pr_description_summarize()` and returns its output. Used only by Test 7.
  - [ ] **Test 1 — happy path (delegated, valid summary)**: starts `valid_summary` stub, sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:$STUB_PORT`. Runs `run_pr_description_summarize " src/foo.ts | 10 +++++ src/bar.ts | 5 ---" "Add foo to bar" "commit1\ncommit2"`. Asserts function output contains `"wires the ralph-pr skill"` (matches the stub's response prefix). Asserts one JSONL line in `$RALPH_DELEGATE_LOG_PATH` with `"task":"pr_description"` and `"status":"ok"`.
  - [ ] **Test 2 — oversized summary trips length guard**: starts `oversized_summary` stub. Runs the function with the same inputs as Test 1. Asserts function output is exactly `FALLBACK rc=0,bad-shape` (the wrapper succeeded; the skill's length guard tripped). Asserts the JSONL line records `"status":"ok"` — the wrapper succeeded at the HTTP layer; the shape failure is the skill's concern.
  - [ ] **Test 3 — heading-prefix trips first-char guard**: starts `heading_prefix` stub. Runs the function. Asserts function output is `FALLBACK rc=0,bad-shape`. Asserts the JSONL line records `"status":"ok"`. (Two near-identical tests for the two bash guards; documents both branches of the shape-validation logic in the bats file.)
  - [ ] **Test 4 — timeout**: starts `slow` stub. Sets `RALPH_DELEGATE_TIMEOUT_SECONDS=1`. Runs the function. Asserts function output starts with `FALLBACK rc=124`. Asserts the JSONL line records `"status":"timeout"`.
  - [ ] **Test 5 — disabled**: does NOT set `RALPH_DELEGATE_ENABLED`. Does NOT start a stub. Runs the function. Asserts function output is exactly `FALLBACK rc=126`. Asserts the audit log file is BYTE-IDENTICAL before and after (capture `wc -c` pre/post; no log line on 126). Matches F4a's Test 4 invariant.
  - [ ] **Test 6 — unreachable**: sets `RALPH_DELEGATE_ENABLED=true && RALPH_LLM_URL=http://127.0.0.1:1` (a port nothing's listening on). Does NOT start a stub. Runs the function. Asserts function output starts with `FALLBACK rc=127`. Asserts the JSONL line records `"status":"unreachable"`.
  - [ ] **Test 7 — threshold gate trips on trivial diff**: sets `RALPH_DELEGATE_ENABLED=true`. Runs `run_pr_description_with_threshold 1 5` (1 file changed, 5 lines). Asserts function output is exactly `BELOW_THRESHOLD`. Asserts the audit log file is BYTE-IDENTICAL before and after the call (no wrapper invocation → no log line). This is the F4b-specific guarantee that the threshold gate is enforced in the skill's bash, not just documented in the prose. (F4a has no analog because its threshold gate is documented but not unit-tested in F4a's bats; F4b improves on this by testing the threshold explicitly per Shared Constraint #10.)
  - [ ] Each test is hermetic: no global state leaks between tests, teardown cleans up STUB_PID and TEST_TMPDIR.
  - [ ] `bats plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` passes locally and in CI (the existing `.github/workflows/ci.yml:126-129` bats glob auto-picks it up — no CI YAML change required).
  - [ ] `grep -c 'task=pr_description\|"task":"pr_description"' plugin/ralph-hero/scripts/__tests__/pr-agent-delegation.bats` returns ≥3 (multiple tests reference the task name for audit-log assertions).
  - [ ] No regression: `bats plugin/ralph-hero/scripts/__tests__` (the whole directory) — all 28 tests pass (16 pre-F4a + 5 from F4a's `codebase-locator-delegation.bats` if F4a merged + 7 new). If F4a is NOT yet merged when F4b runs `bats` locally, only the 23 pre-existing + 7 new = 23 tests are expected; this is a side effect of the parallel-sibling planning, not a regression.

### Phase Success Criteria

#### Automated Verification:

- [ ] `bats plugin/ralph-hero/scripts/__tests__` — all tests pass (16 pre-F4a baseline + 5 F4a if merged + 7 new F4b = 28 total; or 23 if F4a not yet merged). No regression in F1's 8 ralph-delegate tests, F2's 8 openai-compat tests, or F4a's 5 codebase-locator tests.
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` — green (TS source unchanged but matrix runs).
- [ ] `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched).
- [ ] CI `test-cli` job — green on the PR.
- [ ] CI `test-hooks` job — green on the PR.
- [ ] CI matrix builds (Node 18, 20, 22) — green.
- [ ] `find plugin/ralph-hero/agents -name 'pr-agent-eval.md' | wc -l` returns `1` (eval file exists).
- [ ] `find plugin/ralph-hero/scripts/__tests__ -name 'pr-agent-delegation.bats' | wc -l` returns `1` (bats file exists).
- [ ] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `1` (single wrapper invocation in skill body).
- [ ] `grep -c 'openai-compat.sh' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `0` (no direct adapter call from the skill).
- [ ] `grep -c '\-\-task pr_description' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns `1` (task name hardcoded once for audit log).
- [ ] `grep -c 'gh pr create' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥2 (Step 3a multi-repo + Step 5 single-repo; both mutations preserved; F4b does NOT remove either).
- [ ] `grep -cE 'Step 5\.0|## Compose .Summary' plugin/ralph-hero/skills/ralph-pr/SKILL.md` returns ≥1 (the new sub-step is present and headed correctly).
- [ ] `git diff plugin/ralph-hero/agents/pr-agent.md` is empty (agent file unchanged; all delegation lives in the skill).
- [ ] `wc -l plugin/ralph-hero/skills/ralph-pr/SKILL.md` shows total ≤ `218 + 150` (the skill grew by no more than 150 lines; if it grew more, the new sub-step is too verbose and needs trimming).

#### Manual Verification:

- [ ] **Smoke 1 (delegated path)**: `gemma-up && export RALPH_DELEGATE_ENABLED=true`, then in a real worktree with a non-trivial diff (≥2 files OR ≥20 lines, e.g., the F4b feature branch itself once Task 1.1 + 1.3 are committed), invoke the skill. The PR description's `## Summary` block has 1-3 sentences. The audit log gains one JSONL line with `task=pr_description, status=ok`.
- [ ] **Smoke 2 (unreachable path)**: kill gemma-lab (`gemma-down` or `pkill -f mlx-openai-server`), keep `RALPH_DELEGATE_ENABLED=true`, run the same skill against a fresh draft PR. Output contains a `delegation: fell back to native (rc=127)` line. The PR's `## Summary` is still populated (native composition succeeded). The audit log gains one `status=unreachable` line.
- [ ] **Smoke 3 (disabled path)**: `unset RALPH_DELEGATE_ENABLED` and run the skill against a fresh draft PR. The PR's `## Summary` has the structured shape, no delegation note in the skill's stdout. The audit log file size is unchanged.
- [ ] **Smoke 4 (per-task override)**: `RALPH_DELEGATE_PR_DESCRIPTION_MODEL=mlx-community/qwen-3.5-27b-it RALPH_DELEGATE_ENABLED=true gemma-up` then run the skill. The audit log line records `model=mlx-community/qwen-3.5-27b-it` (override honored). The `## Summary` text is otherwise produced through the same shape guards.
- [ ] **Smoke 5 (threshold gate)**: in a worktree with a 1-file, 5-line diff (synthetic — make a tiny commit and rebase the worktree), invoke the skill with delegation enabled. Confirm no audit-log line is appended (`wc -c` pre/post). The skill's stdout does NOT print any delegation note. The `## Summary` block is composed natively.
- [ ] **Smoke 6 (mutation never delegated)**: read `skills/ralph-pr/SKILL.md` cover-to-cover. Confirm there is exactly one `ralph-delegate.sh` invocation and it appears strictly BEFORE the `gh pr create` heredoc. Confirm no other step in the skill invokes the wrapper. This is the manual audit version of the grep guards above and the literal answer to issue acceptance criterion #5.
- [ ] **3-PR eyeball eval**: run the protocol from `agents/pr-agent-eval.md`. Score 3 PRs × 4 criteria each. Document the 12-cell scoring table and aggregate judgment ("≥8 cells match or beat") in a comment on issue #1189. Per issue acceptance criterion #1 ("qualitatively comparable on 3 real PRs"). Calibration metric — does not gate merge.
- [ ] **No leftover tempfiles**: after running smokes 1-3 once each, `find /tmp -name 'pr-description*' -mmin -5 2>/dev/null | wc -l` returns 0. (The skill's bash block uses `mktemp -t pr-description-XXXXXX`; the unconditional `rm -f` should leave no orphans.)
- [ ] **Document readthrough**: read `agents/pr-agent-eval.md` cover-to-cover — can an operator re-run the 3-PR eval in under 15 minutes following only this document? Yes.
- [ ] **Worked-example fidelity**: open `skills/ralph-pr/SKILL.md` (new Step 5.0 sub-step), `agents/codebase-locator.md` (F4a's `## Candidate Ranking`), `skills/delegate-test/SKILL.md`, and `docs/delegation-authoring.md` side-by-side — the wrapper-call control flow (set +e + if OUTPUT=$(...) + case "$rc" + unconditional rm -f) is structurally identical in all four. The skill's bash block has task-specific deviations: (a) the threshold-gate prelude before the wrapper call, (b) byte-length + first-char shape guards instead of `jq -e .ranked`, (c) `--max-tokens 256 --temperature 0.2` instead of `--max-tokens 512 --temperature 0.0`. Those are the only intentional deviations.

**Creates for next phase**: A second production-precedent for delegation in a real skill (F4a in an agent, F4b in a skill). The bash-block-in-a-skill-body pattern is the template F4c (val-agent, #1190) copies for its classification step. The JSONL audit log gains its first `task=pr_description` lines, which Wave-4 telemetry (F5, #1191) will aggregate. The eval-set document is the template for F4c's own eval file when it ships. The `summarize` task name is now in production use alongside F4a's `locator`; F4c's `classify` will complete the trio of canonical task names from the conventions doc.

---

## Integration Testing

- [ ] **End-to-end with real endpoint** (manual, smoke 1): `gemma-up && export RALPH_DELEGATE_ENABLED=true && Skill("ralph-hero:ralph-pr", "<issue-number>")` produces a `PR CREATED` block with a populated `## Summary`. Audit log has one `task=pr_description, status=ok` line.
- [ ] **End-to-end with endpoint down** (manual, smoke 2): with delegation enabled but gemma killed, the same skill dispatch prints a `delegation: fell back to native (rc=127)` line; PR's `## Summary` is still populated; audit log records `status=unreachable`.
- [ ] **End-to-end with delegation disabled** (manual, smoke 3): with `RALPH_DELEGATE_ENABLED` unset, the skill's output is byte-identical to today's (no delegation note, same PR body structure). Audit log unchanged.
- [ ] **Threshold gate** (manual, smoke 5): a 1-file, 5-line diff with delegation enabled produces no audit-log line and no `delegation:` stdout note. Confirms the threshold gate is enforced in the skill, not just in the bats helper.
- [ ] **Caller field in audit log** (manual): inspect the JSONL line written during smoke 1 — `caller` field is `ralph-pr` or `pr-agent` (best-effort, resolved from the live hook payload). If `caller=unknown`, this is a hook-context limitation outside F4b's scope.
- [ ] **Per-task override honored** (manual, smoke 4): setting `RALPH_DELEGATE_PR_DESCRIPTION_MODEL` overrides the default model; audit log records the override.
- [ ] **Mutation step preserved** (manual + automated): the `gh pr create` invocation in Step 5 (and the multi-repo Step 3a invocation) are byte-identical to main except for the `--body` argument's `## Summary` placeholder substitution. `grep -c 'gh pr create' skills/ralph-pr/SKILL.md` ≥ 2 (Step 3a + Step 5). Issue acceptance criterion #5.
- [ ] **No-regression** (automated): with delegation disabled (CI default), F1+F2+F4a bats suites and `npm test` all stay green on the PR.
- [ ] **3-PR eyeball judgment** (manual): the 12-cell scoring table and aggregate judgment from `agents/pr-agent-eval.md` are documented in a comment on issue #1189. Calibration metric, not a hard gate. Issue acceptance criterion #1.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1189
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 plan (foundation, merged): [thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md)
- F2 plan (adapter extraction, merged): [thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md)
- F3 plan (skill authoring pattern, merged): [thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md)
- F4a plan (codebase-locator delegation, merged on feature branch): [thoughts/shared/plans/2026-05-12-GH-1188-codebase-locator-delegation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1188-codebase-locator-delegation.md)
- F4a review: [thoughts/shared/reviews/2026-05-13-GH-1188-critique.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/reviews/2026-05-13-GH-1188-critique.md)
- Sibling F4c plan (not yet written, val-agent integration): https://github.com/cdubiel08/ralph-hero/issues/1190
- Skill under modification: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- Agent (NOT modified, 10-line preloader): `plugin/ralph-hero/agents/pr-agent.md`
- Wrapper (the delegation surface): `plugin/ralph-hero/scripts/ralph-delegate.sh`
- F2 adapter (NOT called directly by skill): `plugin/ralph-hero/scripts/lib/openai-compat.sh`
- F3 reference skill (control-flow template): `plugin/ralph-hero/skills/delegate-test/SKILL.md`
- F4a sibling pattern (control-flow + shape-guard template): `plugin/ralph-hero/agents/codebase-locator.md` (on `feature/GH-1188`)
- F3 authoring guide: `plugin/ralph-hero/docs/delegation-authoring.md`
- F3 conventions doc: `plugin/ralph-hero/skills/shared/delegation-conventions.md` (the `summarize` row line 11 is the explicit eligibility for F4b)
- F1 wrapper bats suite (stub pattern template): `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- F4a sibling bats (1:1 helper-function template): `plugin/ralph-hero/scripts/__tests__/codebase-locator-delegation.bats` (on `feature/GH-1188`)
- Existing skill eval (non-delegation, NOT modified): `plugin/ralph-hero/skills/ralph-pr/eval-scenarios.md`
- Eval-scenarios style template: `plugin/ralph-hero/skills/ralph-split/eval-scenarios.md`
- README Delegation section: `plugin/ralph-hero/README.md:249-297`
- CI bats integration: `.github/workflows/ci.yml:126-129`
