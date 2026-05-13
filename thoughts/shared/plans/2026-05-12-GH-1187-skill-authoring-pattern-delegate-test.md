---
date: 2026-05-12
status: draft
type: plan
github_issue: 1187
github_issues: [1187]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1187
primary_issue: 1187
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, skill-authoring, reference-skill, delegate-test, documentation, bash-delegation]
---

# F3 — Skill Authoring Pattern + Reference `delegate-test` Skill

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: [[2026-05-12-GH-1185-ralph-delegate-sh-foundation]]
- builds_on:: [[2026-05-12-GH-1186-openai-compat-shell-adapter]]
- references:: `plugin/ralph-hero/scripts/ralph-delegate.sh` — F1 wrapper (the public delegation surface)
- references:: `plugin/ralph-hero/scripts/lib/openai-compat.sh` — F2 sourceable adapter (skills do NOT call this directly)
- references:: `plugin/ralph-hero/README.md:249-297` — existing "Delegation (optional)" section (env vars + exit codes + audit log shape)
- references:: `plugin/ralph-hero/skills/STYLE.md` — output style guide (results, not internal narration)
- references:: `plugin/ralph-hero/skills/status/SKILL.md` — small read-only skill template (frontmatter shape)
- references:: `plugin/ralph-hero/skills/record-demo/SKILL.md` — small Bash-using skill template

## Overview

[N=1] single-issue plan for the LLM delegation epic's skill-authoring feature:

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1187 | F3 — Skill authoring pattern + reference delegate-test skill | S |

The deliverable is (a) a minimal user-invocable `delegate-test` skill that demonstrates the canonical delegation+fallback pattern end-to-end, (b) a new authoring guide that any future skill author can copy-paste from, and (c) a convention document that draws the line between delegate-eligible and delegate-ineligible sub-tasks. The reference skill doubles as the first end-to-end smoke test for `ralph-delegate.sh` from a real skill (the F1 bats `Task 1.4` smoke test stand-in is explicitly retired by this feature).

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`) and F1/F2 plans:

1. **Opt-in only.** All new behavior is gated on `RALPH_DELEGATE_ENABLED=true`. The default (unset) MUST produce zero behavioral change. The reference skill MUST exit cleanly (with a "native (fallback)" message and no error) when delegation is off — that's the canonical no-op proof.
2. **Reuse existing env vars.** `RALPH_LLM_URL` / `RALPH_LLM_MODEL` are honored as-is by `ralph-delegate.sh`. The reference skill does NOT introduce new env vars.
3. **Reuse existing tooling.** `$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh` is the single delegation surface. The reference skill does NOT call `openai-compat.sh` directly — that's reserved for adapter-level operator smoke tests; skills always go through the wrapper so they get the opt-in gate, env resolution, and audit log for free.
4. **Fail-open with audit trail.** Every delegate call's success or failure is the wrapper's responsibility. Skills must obey the 5-value exit-code contract (0/1/124/126/127) and never crash on a non-zero exit.
5. **Caller is responsible for fallback.** The wrapper does not provide a "native fallback" mode. The skill author's pattern MUST include a fallback branch for non-zero exits. F3's worked example IS that pattern.
6. **No GitHub mutations.** The reference skill is read-only and side-effect-free apart from the audit-log line written by the wrapper. No `save_issue`, no `create_comment`, no MCP tool that mutates project state.
7. **No-regression invariant.** With `RALPH_DELEGATE_ENABLED` unset, the reference skill must do its work natively (calling no HTTP, writing no audit-log line) and exit 0. F1's bats suite (including the smoke test at Task 1.4) MUST continue to pass; F2's `openai-compat.bats` MUST continue to pass.

Feature-specific extensions:

8. **The convention doc and the authoring guide live in net-new locations.** The issue's research notes flag that `plugin/ralph-hero/skills/shared/conventions.md` does NOT exist and `plugin/ralph-hero/CLAUDE.md` does NOT exist either. Verified by `ls plugin/ralph-hero/` (only `agents/`, `docs/`, `hooks/`, `mcp-server/`, `scripts/`, `skills/`, `justfile`, `LICENSE`, `README.md`) and `ls plugin/ralph-hero/skills/shared/` (only `fragments/`, `artifact-comment-protocol.md`, `integration-test-scenarios.md`, `quality-standards.md`). The plan creates both files explicitly: `plugin/ralph-hero/docs/delegation-authoring.md` for the worked guide and `plugin/ralph-hero/skills/shared/delegation-conventions.md` for the eligible/ineligible matrix. Placement under `docs/` and `skills/shared/` matches existing structural neighbors (`docs/cli.md`, `skills/shared/quality-standards.md`).
9. **The reference skill MUST be minimal.** Total `SKILL.md` ~50-100 lines, single allowed-tool (`Bash`), single inline workflow, no MCP calls beyond what the wrapper writes to its log. The skill exists as a literal copy-paste template — the Workflow section IS the worked authoring example.
10. **Hermetic bats coverage at the skill layer is out of scope.** The reference skill's end-to-end correctness is verified by (a) the worked-example bash snippet being a 1:1 copy of what runs in the skill, and (b) two operator smoke checks: enabled+up (returns "delegated"), enabled+down or disabled (returns "native (fallback)"). The skill itself doesn't ship its own bats file — F1/F2's existing 16 bats tests already pin the wrapper+adapter behavior; the skill is the missing integration proof, not new logic.
11. **Convention doc must be specific.** "Eligible" and "ineligible" lists MUST be concrete (named sub-tasks, named anti-patterns) — not abstract principles. The reviewer should be able to look up "is X delegate-eligible?" without re-reading the epic plan.

## Current State Analysis

**What F1 + F2 shipped (verified by reading source):**

- `plugin/ralph-hero/scripts/ralph-delegate.sh` (308 lines) — the public wrapper. Owns: `RALPH_DELEGATE_ENABLED` opt-in gate, env resolution via `ralph_resolve_env`, per-task overrides (`RALPH_DELEGATE_<TASK_UPPER>_URL` / `_MODEL`), audit-log writing to `~/.ralph-hero/delegate.log`, `--health-check`, `--dry-run`, `--task`, exit-code translation (0/1/124/126/127). Sources `lib/openai-compat.sh` for the HTTP call. `--task default` is the implicit task name when `--task` is omitted; the audit-log line records `task=default` in that case.
- `plugin/ralph-hero/scripts/lib/openai-compat.sh` (275 lines) — the sourceable adapter. Owns: HTTP+JSON request, `portable_timeout` wrapping, `jq` response parse, `--validate-json-output` flag, 4-value exit contract (0/1/124/127 — no 126). Skill code does NOT touch this file.
- `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats` (8 tests, all green) — covers the wrapper end-to-end via a hermetic Python stub. Test 8 (the "Task 1.4 smoke test") sets `RALPH_HOOK_INPUT='{"tool_input":{"caller_skill":"smoke-test"}}'` and asserts `--dry-run` returns 0 + a JSONL line with `caller=smoke-test`. F3 does NOT modify this file.
- `plugin/ralph-hero/scripts/__tests__/openai-compat.bats` (8 tests, all green) — covers the adapter directly. F3 does NOT modify this file.
- `plugin/ralph-hero/README.md:249-297` — "Delegation (optional)" section already exists from F1: env-var table, exit-code table, quick-check example, audit-log JSONL shape, `--health-check` semantics. F3 extends — does NOT duplicate — this section.
- `plugin/ralph-hero/skills/STYLE.md` — output style guide. Mandates: results, not internal reasoning narration. The reference skill's output prints `delegated` or `native (fallback)` cleanly (per the issue acceptance criteria) — NOT a play-by-play.
- `.github/workflows/ci.yml:124-129` — bats glob auto-pickup. No new bats file is added by F3, so no CI change is required.

**What does NOT exist (verified by file listings):**

- `plugin/ralph-hero/skills/delegate-test/` — net-new directory.
- `plugin/ralph-hero/CLAUDE.md` — does NOT exist. The issue's research notes were partially wrong on this point (they said it does exist "at the repo root"; the repo root has `ralph-hero/CLAUDE.md` which is the project-instructions file shown to Claude, but `plugin/ralph-hero/CLAUDE.md` does NOT). F3 does NOT create a plugin-scoped `CLAUDE.md` — that would shadow the project-level one and confuse the host-context loading. Instead, the authoring guide lives at `plugin/ralph-hero/docs/delegation-authoring.md` (alongside `docs/cli.md`) and the existing `plugin/ralph-hero/README.md` "Delegation (optional)" section gets a one-sentence "See `docs/delegation-authoring.md` for skill-author worked examples" pointer.
- `plugin/ralph-hero/skills/shared/conventions.md` — does NOT exist. F3 creates `plugin/ralph-hero/skills/shared/delegation-conventions.md` (named for the topic, not generic — matches the neighbors `quality-standards.md`, `artifact-comment-protocol.md`, `integration-test-scenarios.md`).
- `plugin/ralph-hero/docs/delegation-authoring.md` — does NOT exist. F3 creates it.
- No skill currently calls `ralph-delegate.sh`. F4a/b/c will be the first real integrations. F3 is the proof-of-concept reference.

**Tooling assumptions on the target machine (true per F1 plan, re-verified):**

- `bash` (4.x or 5.x), `curl`, `jq`, `mktemp`, `wc` — standard on macOS and the CI Ubuntu runner. The reference skill uses only these.
- Skills can invoke arbitrary scripts via the `Bash` tool. `$CLAUDE_PLUGIN_ROOT` is set when a skill runs inside the plugin host. Existing uses verified at `plugin/ralph-hero/skills/ralph-unblock/SKILL.md:11,16,20,224` and `plugin/ralph-hero/skills/ralph-impl/SKILL.md:11,16,18,22,26,28`.

## Desired End State

After F3 merges:

1. `plugin/ralph-hero/skills/delegate-test/SKILL.md` exists and is invocable as `/ralph-hero:delegate-test "<input>"`. Given any short input string, the skill:
   - Asks `ralph-delegate.sh --task classify --prompt-file <tempfile>` for a fixed-shape classification (sentiment: positive | negative | neutral).
   - On exit 0 (delegated), prints `delegated: <classification>` and a one-line audit-log echo.
   - On exit 126 (disabled), prints `native (delegation disabled): <classification>` after doing the classification natively (i.e., the LLM running the skill itself decides the sentiment by pattern-matching the input — no further tool calls).
   - On exit 124/127/1 (fallback), prints `native (fallback, rc=<code>): <classification>` after doing the same native classification.
   - Cleans up its tempfile on exit (success and failure paths).
2. `plugin/ralph-hero/docs/delegation-authoring.md` exists and contains:
   - A one-paragraph overview of when delegation makes sense (links to `skills/shared/delegation-conventions.md` for the eligible/ineligible matrix).
   - The complete worked bash snippet (copy-paste-ready) — the same shape the reference skill uses.
   - A four-row exit-code crib sheet (0/126/127|124|1) calling out which exits should trigger a user-visible "delegation: …" line.
   - A "Common mistakes" section (e.g., calling the adapter directly, not cleaning up the tempfile, treating 126 as an error).
   - A pointer to the reference skill (`plugin/ralph-hero/skills/delegate-test/SKILL.md`) as the live example.
3. `plugin/ralph-hero/skills/shared/delegation-conventions.md` exists and contains:
   - A two-column table: "Delegate-eligible sub-tasks" (summarize, classify, rerank, candidate-filter, JSON extraction from prose) vs "Delegate-ineligible sub-tasks" (multi-step reasoning, code generation, decision-making about pipeline state, anything that triggers a tool-call mutation).
   - One-paragraph rationale for each category (why eligible / why not).
   - The fallback requirement: every delegate site MUST have a native fallback path. Anti-pattern: hard-crash on non-zero exit.
   - A pointer to `docs/delegation-authoring.md` for the worked example.
4. `plugin/ralph-hero/README.md` gets a 2-line addition under the existing "Delegation (optional)" section: "Authoring a skill that delegates? See `docs/delegation-authoring.md` for the worked pattern and `skills/shared/delegation-conventions.md` for what's delegate-eligible."
5. Reference skill works end-to-end against `gemma-up` (the operator's local Gemma server on `localhost:8000`). Teardown leaves no temp files behind.
6. No regression in any existing bats suite. No new bats file added (the skill itself is exercised via operator smoke checks, documented in the plan).
7. The four issue-defined acceptance criteria are satisfied verbatim (see Verification below).

### Verification

- [ ] `bash -n plugin/ralph-hero/skills/delegate-test/SKILL.md` (extract the workflow bash block and syntax-check it) succeeds. (Manual: copy the bash block out of SKILL.md and run `bash -n` on it.)
- [ ] With `gemma-up` running + `RALPH_DELEGATE_ENABLED=true`: invoking the reference skill on `"I love this feature"` prints `delegated: positive` and appends a `status=ok` JSONL line to `~/.ralph-hero/delegate.log`.
- [ ] With `gemma-up` killed + `RALPH_DELEGATE_ENABLED=true`: invoking the skill prints `native (fallback, rc=127): <classification>` and appends a `status=unreachable` JSONL line.
- [ ] With `RALPH_DELEGATE_ENABLED` unset: invoking the skill prints `native (delegation disabled): <classification>` and the audit log is byte-identical before and after the call.
- [ ] After three back-to-back invocations, `find /tmp -name 'delegate-test-*' 2>/dev/null` returns zero results (teardown leaves no temp files).
- [ ] `bats plugin/ralph-hero/scripts/__tests__` — all 16 existing tests (8 ralph-delegate + 8 openai-compat) still green.
- [ ] `npm run build` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched, but matrix runs).
- [ ] CI `test-cli` and `test-hooks` jobs — green on the PR.

## What We're NOT Doing

- **NOT** integrating delegation into any real skill (locator, pr-agent, val-agent). That's F4a/b/c (#1188-#1190).
- **NOT** adding telemetry or `ralph status --delegation`. That's F5 (#1191).
- **NOT** adding setup-skill onboarding for delegation. That's F6 (#1192).
- **NOT** modifying `ralph-delegate.sh` or `openai-compat.sh`. F3 is documentation + a reference skill — no script changes.
- **NOT** creating `plugin/ralph-hero/CLAUDE.md`. The issue's research notes flagged this file as "does exist" but verification shows it does NOT exist at the plugin scope (only at repo root). Creating it would shadow the project-instructions file. The authoring guide lives at `plugin/ralph-hero/docs/delegation-authoring.md` instead.
- **NOT** creating `plugin/ralph-hero/skills/shared/conventions.md` as a generic file. F3 creates a topic-specific `delegation-conventions.md` so the document scope matches its content — and future "X-conventions.md" siblings can be added the same way without a naming collision.
- **NOT** adding a new bats file for the reference skill. F1's smoke test (`ralph-delegate.bats` Task 1.4) covers the in-process script-from-`Bash` invariant; the reference skill's actual end-to-end behavior is verified by operator smoke checks (see Manual Verification below).
- **NOT** removing or modifying F1's bats Task 1.4 smoke test, even though F3 supersedes it conceptually. Keeping it provides a hermetic regression guard; the reference skill provides the live integration proof.
- **NOT** adding a new MCP tool, a new agent, or a new hook. The reference skill uses only `Bash`.
- **NOT** delegating any sub-task that mutates GitHub state. Reference skill is read-only.
- **NOT** writing the audit-log line from the skill — the wrapper owns that. Skill output may *echo* a one-line summary of the most recent log entry, but does not write to the log directly.

## Implementation Approach

The whole feature is one phase (S estimate, single issue). Implementation proceeds in four task groups inside that phase:

1. **Authoring guide first.** Write `docs/delegation-authoring.md`. This is the document that the reference skill is supposed to demonstrate — so authoring it first forces the pattern to be precise before any skill code is written.
2. **Convention doc.** Write `skills/shared/delegation-conventions.md`. The eligible/ineligible matrix is independent of the worked example and is reusable across F4a/b/c (each of those features will cite this doc when justifying its delegation site).
3. **Reference skill.** Author `skills/delegate-test/SKILL.md`. The Workflow section's bash block is a 1:1 copy of the worked example in `docs/delegation-authoring.md` — verified by visual diff. The skill is exercised against `gemma-up` to prove the end-to-end path.
4. **README pointer + smoke.** Add the 2-line "See …" pointer to the README's Delegation section. Run the four operator smoke checks listed in Verification.

There is exactly one Phase. No `depends_on` between phases is needed.

---

## Phase 1: GH-1187 — Skill authoring pattern + reference `delegate-test` skill
- **depends_on**: null

### Overview

Document the canonical delegation+fallback pattern, ship a minimal reference skill that demonstrates it, and pin the eligible/ineligible matrix so future feature plans (F4a/b/c) can cite an authoritative source. Operator smoke tests against `gemma-up` prove the live end-to-end path.

### Tasks

#### Task 1.1: Write the authoring guide
- **files**: `plugin/ralph-hero/docs/delegation-authoring.md` (create), `plugin/ralph-hero/scripts/ralph-delegate.sh` (read), `plugin/ralph-hero/README.md` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/docs/delegation-authoring.md`, opens with H1 `# Delegating sub-tasks via Bash to a local/cheaper LLM` to match the section name promised in the issue body.
  - [ ] Opens with a 2-3-sentence overview: ralph-hero ships an opt-in delegation wrapper at `plugin/ralph-hero/scripts/ralph-delegate.sh`; skills that have a narrow text-in / text-out sub-task can use it to offload work to a local Gemma or a cheaper OpenRouter model; the operator opts in via env vars and the skill author writes a fallback path so off-by-default and endpoint-down both Just Work.
  - [ ] Includes a "When to delegate" sub-section that links to `skills/shared/delegation-conventions.md` for the eligible/ineligible matrix (the matrix itself lives in the convention doc, not duplicated here).
  - [ ] Includes a "Worked example" sub-section containing the complete bash snippet from the issue body — verbatim, no edits:
    ```bash
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
  - [ ] Includes a 4-row "Exit code crib sheet" table mapping each non-zero exit (1, 124, 126, 127) to recommended caller behavior and what (if anything) to surface in skill output. Matches the existing 5-row table in `README.md:269-275` but framed for skill authors (e.g., "When you see 126, **do not print anything** — the operator chose silence").
  - [ ] Includes a "Common mistakes" sub-section with at least 4 named anti-patterns:
    1. **Calling `openai-compat.sh` directly from a skill.** (Use the wrapper — you lose the opt-in gate, env resolution, and audit log otherwise.)
    2. **Treating exit 126 as an error.** (It's the "off by default" state — silently fall through to the native path.)
    3. **Forgetting `rm -f` on the tempfile.** (Each delegation leaves a `/tmp/tmp.XXXXXX` if cleanup is skipped — accumulates under long-running loops.)
    4. **Hard-crashing on `set -e` when the wrapper exits non-zero.** (Wrap the call in `set +e` or use the `if OUTPUT=$(...)` pattern shown.)
  - [ ] Closes with a "See it live" sub-section pointing to `plugin/ralph-hero/skills/delegate-test/SKILL.md` as the reference implementation that any skill author can copy.
  - [ ] No more than ~120 lines total; the document is a quick-reference, not an essay.

#### Task 1.2: Write the convention doc
- **files**: `plugin/ralph-hero/skills/shared/delegation-conventions.md` (create), `plugin/ralph-hero/skills/shared/quality-standards.md` (read for style template)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/shared/delegation-conventions.md`, opens with H1 `# Delegation conventions`.
  - [ ] Opens with a 1-paragraph statement of intent: this document is the authoritative source for what sub-tasks ralph-hero skills are allowed to delegate. It is cited by feature plans (F4a/b/c) when justifying a delegation site.
  - [ ] Contains a clear two-column matrix labeled "Delegate-eligible" vs "Delegate-ineligible". At minimum, **eligible** lists: summarize, classify, rerank, candidate-filter, JSON extraction from prose. At minimum, **ineligible** lists: multi-step reasoning, code generation, decision-making that affects pipeline workflow state (e.g., advancing an issue), anything that triggers a tool-call mutation (`save_issue`, `create_comment`, PR merge, gh CLI writes), free-form composition where output goes directly to the user.
  - [ ] Each row has a one-sentence rationale (why eligible / why not). Example rationale for `code generation`: "Code-gen output goes to disk and gets executed; quality regressions from a smaller model cause real bugs. Stay native."
  - [ ] Includes a "Fallback requirement" sub-section stating: every delegate site MUST have a native fallback path. Hard-crashing on non-zero wrapper exit is an anti-pattern (`set -e` without `set +e` around the call is the typical bug).
  - [ ] Includes a "Audit log expectation" sub-section: every delegation attempt (except disabled-126) appends one JSONL line to `~/.ralph-hero/delegate.log` — the skill author does NOT need to log themselves. Skills MAY echo a one-line summary of the most recent log entry to user output, but MUST NOT duplicate or rewrite the log.
  - [ ] Closes with a "See also" pointing to `plugin/ralph-hero/docs/delegation-authoring.md` for the worked code example and `plugin/ralph-hero/README.md` (Delegation section) for env vars and exit codes.
  - [ ] No more than ~80 lines total.

#### Task 1.3: Build the reference `delegate-test` skill
- **files**: `plugin/ralph-hero/skills/delegate-test/SKILL.md` (create), `plugin/ralph-hero/docs/delegation-authoring.md` (read — must mirror the worked example bit-for-bit), `plugin/ralph-hero/skills/status/SKILL.md` (read — frontmatter template), `plugin/ralph-hero/skills/STYLE.md` (read — output style guide)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/delegate-test/SKILL.md`.
  - [ ] Frontmatter:
    ```yaml
    ---
    description: Minimal reference skill demonstrating the canonical ralph-delegate.sh pattern. Takes a short input string, classifies its sentiment via the local LLM if delegation is enabled, falls back to native classification otherwise. Prints which path was taken. Doubles as an integration smoke test for the delegation wrapper.
    user-invocable: true
    argument-hint: "<short input string to classify>"
    context: inline
    model: haiku
    allowed-tools:
      - Bash
    ---
    ```
    (Frontmatter shape matches `status/SKILL.md` for the small read-only-skill template. `model: haiku` because the work is trivial. `context: inline` because there's no fork needed.)
  - [ ] Skill body has these sections in order: `# Delegate-Test` (H1), `## Purpose`, `## Workflow`, `## Output`. No other top-level sections.
  - [ ] `## Purpose` is one paragraph: this is the reference implementation for the delegation pattern documented in `docs/delegation-authoring.md`. Skill authors copy this skill as a starting point. Operators run it to prove the delegation toolchain is working end-to-end.
  - [ ] `## Workflow` contains exactly one fenced bash block. The block:
    1. Reads the user's argument into `INPUT` (or echoes a fixed default like `"hello world"` if no argument provided).
    2. Creates a tempfile with `mktemp -t delegate-test-XXXXXX` (the `delegate-test-` prefix makes leftover files trivially identifiable in the cleanup smoke check; macOS `mktemp -t` honors the prefix even without `$TMPDIR`).
    3. Writes a short instruction prompt to the tempfile: `Classify the sentiment of the following text as exactly one word — positive, negative, or neutral — and reply with only that word. Text: ${INPUT}`.
    4. Calls `"$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" --task classify --prompt-file "$PROMPT_FILE" --max-tokens 8 --temperature 0.0 2>/dev/null` inside an `if OUTPUT=$(...)` guard — matching the worked example in `docs/delegation-authoring.md` exactly.
    5. On exit 0: prints `delegated: $OUTPUT` (and trims `$OUTPUT` of surrounding whitespace via `OUTPUT=$(printf '%s' "$OUTPUT" | tr -d '[:space:]')` so the user sees `positive` not `positive\n\n  `).
    6. On exit 126: prints `native (delegation disabled): $NATIVE_CLASS` where `$NATIVE_CLASS` is computed by a 5-line bash heuristic (lowercase keyword match on "love"/"good"/"great" → positive, "hate"/"bad"/"awful" → negative, else neutral). The heuristic is intentionally crude — this is a reference skill, not a real classifier. A comment in the block notes that real skills replace this with a Claude in-context reasoning step.
    7. On exit 127, 124, or 1: prints `native (fallback, rc=$rc): $NATIVE_CLASS` using the same heuristic.
    8. `rm -f "$PROMPT_FILE"` runs unconditionally at the end (place it after the `if/else/fi`).
  - [ ] The bash block uses `set +e` around the wrapper call so non-zero exits don't kill the skill. The `if OUTPUT=$(...)` pattern handles the success path; the explicit `rc=$?` captures the failure exit code. Matches the worked example structure.
  - [ ] The bash block obeys `plugin/ralph-hero/skills/STYLE.md`: no internal narration ("Looking at your input...", "Filtering..."). The only user-visible output is the result line (`delegated:` / `native (delegation disabled):` / `native (fallback, rc=...):`).
  - [ ] `## Output` is one paragraph: documents the three possible output shapes and the meaning of each (one line per line in the output, predictable for an operator).
  - [ ] Total file length: 50-100 lines. (If it grows past 100, the design is too elaborate — simplify the heuristic or the prompt.)
  - [ ] Visual diff check: the bash block's structure (set +e, if OUTPUT=$(...), case "$rc" in 126|127|124|1, rm -f) matches the worked example in `docs/delegation-authoring.md` line-for-line in terms of the control flow. Body of each branch may differ to do the sentiment-classification work, but the control structure is identical. A reviewer can drop the worked example into the skill and the skill into the worked example without rewriting the framing.

#### Task 1.4: Wire pointer from README + run operator smoke checks
- **files**: `plugin/ralph-hero/README.md` (modify), `plugin/ralph-hero/skills/delegate-test/SKILL.md` (read), `plugin/ralph-hero/docs/delegation-authoring.md` (read), `plugin/ralph-hero/skills/shared/delegation-conventions.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] `README.md`'s "Delegation (optional)" section (currently ends at line ~297 with the audit-log JSONL example) gets a new final sub-section `### Authoring a delegating skill` (one paragraph + 2 bullet links):
    - One paragraph: "Skills can call `ralph-delegate.sh` from a `Bash` tool block to offload narrow sub-tasks. The pattern is documented end-to-end in [`docs/delegation-authoring.md`](docs/delegation-authoring.md), with the eligible/ineligible matrix in [`skills/shared/delegation-conventions.md`](skills/shared/delegation-conventions.md). The reference implementation is [`skills/delegate-test/SKILL.md`](skills/delegate-test/SKILL.md) — invoke it as `/ralph-hero:delegate-test "<input>"` to confirm the delegation toolchain is working."
    - Two bullets: one linking to the authoring guide, one linking to the conventions doc.
  - [ ] No existing README content is removed or reordered. The new sub-section appends to the end of "Delegation (optional)" before "## Architecture".
  - [ ] Operator smoke check 1 (delegated path): with `gemma-up` running and `RALPH_DELEGATE_ENABLED=true`, invoking the skill as `/ralph-hero:delegate-test "I love this feature"` prints exactly one line, beginning with `delegated:`, containing a sentiment word. `~/.ralph-hero/delegate.log` gains one JSONL line with `task=classify`, `status=ok`.
  - [ ] Operator smoke check 2 (unreachable path): with `gemma-down` (or any way to take the endpoint down) and `RALPH_DELEGATE_ENABLED=true`, invoking the skill prints `native (fallback, rc=127): <word>`. Log gains one JSONL line with `status=unreachable`.
  - [ ] Operator smoke check 3 (disabled path): with `RALPH_DELEGATE_ENABLED` unset, invoking the skill prints `native (delegation disabled): <word>`. Log file is byte-identical before/after (no line written, per the 126-no-log invariant).
  - [ ] Operator smoke check 4 (teardown): after running smoke 1+2+3 once each, `find /tmp -name 'delegate-test-*' 2>/dev/null` returns zero results. No leftover tempfiles.
  - [ ] All 16 existing bats tests (8 in `ralph-delegate.bats` + 8 in `openai-compat.bats`) still pass: `bats plugin/ralph-hero/scripts/__tests__` is green.

### Phase Success Criteria

#### Automated Verification:

- [x] `bats plugin/ralph-hero/scripts/__tests__` — all 16 tests pass (no regression in F1's `ralph-delegate.bats` or F2's `openai-compat.bats`).
- [x] `npm run build` in `plugin/ralph-hero/mcp-server/` — green (TS unchanged but the matrix runs).
- [x] `npm test` in `plugin/ralph-hero/mcp-server/` — green (no TS source touched).
- [ ] CI `test-cli` job — green on the PR.
- [ ] CI `test-hooks` job — green on the PR.
- [ ] CI matrix builds (Node 18, 20, 22) — green.
- [x] `find plugin/ralph-hero/skills/delegate-test -name SKILL.md | wc -l` returns `1` (the file exists in the expected location).
- [x] `grep -c 'ralph-delegate.sh' plugin/ralph-hero/skills/delegate-test/SKILL.md` returns `1` (skill calls the wrapper exactly once — no accidental loops or recursive invocations).
- [x] `grep -c 'openai-compat.sh' plugin/ralph-hero/skills/delegate-test/SKILL.md` returns `0` (skill does NOT call the adapter directly — must go through the wrapper).

#### Manual Verification:

- [ ] **Smoke 1 (delegated path)**: `gemma-up && export RALPH_DELEGATE_ENABLED=true` then `/ralph-hero:delegate-test "I love this feature"` → output is one line starting with `delegated:`; one new JSONL line with `status=ok` and `task=classify` is appended to `~/.ralph-hero/delegate.log`.
- [ ] **Smoke 2 (unreachable path)**: kill the Gemma server (`gemma-down` or `pkill -f mlx-openai-server`), keep `RALPH_DELEGATE_ENABLED=true`, run the same skill invocation → output starts with `native (fallback, rc=127):`; log line has `status=unreachable`.
- [ ] **Smoke 3 (disabled path)**: `unset RALPH_DELEGATE_ENABLED` then run the skill → output starts with `native (delegation disabled):`; log file is byte-identical before/after (verified with `wc -c ~/.ralph-hero/delegate.log` before and after).
- [ ] **Smoke 4 (teardown)**: after running smokes 1-3, `find /tmp -name 'delegate-test-*' 2>/dev/null` returns zero results.
- [ ] **Document readthrough**: read `docs/delegation-authoring.md` cover-to-cover — does it tell a skill author everything they need to add delegation to a new skill? Yes.
- [ ] **Convention doc readthrough**: read `skills/shared/delegation-conventions.md` — can a reviewer look up "is X delegate-eligible?" and find an authoritative answer in under 30 seconds? Yes.
- [ ] **Worked-example fidelity**: open `docs/delegation-authoring.md` and `skills/delegate-test/SKILL.md` side-by-side — the wrapper-call control flow is identical (set +e + if OUTPUT=$(...) + case "$rc" + rm -f). Yes.

**Creates for next phase**: The authoring pattern (`docs/delegation-authoring.md`), the eligible/ineligible matrix (`skills/shared/delegation-conventions.md`), and a copy-paste-ready reference skill (`skills/delegate-test/SKILL.md`). F4a (`codebase-locator` candidate ranking), F4b (`pr-agent` PR description), and F4c (`val-agent` pass/fail classification) all cite the conventions doc when justifying their delegation site and copy the bash control flow from the reference skill. F5 telemetry consumes the same JSONL log the reference skill exercises. F6 setup-skill onboarding can use `/ralph-hero:delegate-test` as its post-setup smoke verification.

---

## Integration Testing

- [ ] **End-to-end with real endpoint** (manual, smoke 1): `gemma-up && export RALPH_DELEGATE_ENABLED=true && /ralph-hero:delegate-test "I love this feature"` round-trips through the wrapper, the adapter, and Gemma 4 26B — returns `delegated: positive` (or another sentiment word) and writes a `status=ok` JSONL line.
- [ ] **End-to-end with endpoint down** (manual, smoke 2): with delegation enabled but gemma killed, the skill prints `native (fallback, rc=127): <word>` and the JSONL log records `status=unreachable`. Proves the fail-open semantic at the skill layer.
- [ ] **End-to-end with delegation disabled** (manual, smoke 3): with `RALPH_DELEGATE_ENABLED` unset, the skill prints `native (delegation disabled): <word>` and the audit log is unchanged. Proves the 126-no-log invariant at the skill layer.
- [ ] **No-regression invariant** (automated, via CI): with `RALPH_DELEGATE_ENABLED` unset (the CI default), F1+F2 bats suites continue to pass — verified by `test-cli` job staying green on the PR.
- [ ] **Teardown cleanliness** (manual, smoke 4): after multiple skill invocations, no `/tmp/delegate-test-*` files remain.
- [ ] **Worked-example fidelity** (manual): the bash control flow in `docs/delegation-authoring.md` and `skills/delegate-test/SKILL.md` is structurally identical — proven by visual side-by-side comparison.

## References

- Issue: https://github.com/cdubiel08/ralph-hero/issues/1187
- Parent epic: https://github.com/cdubiel08/ralph-hero/issues/965
- Parent plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 plan (foundation, merged): [thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md)
- F2 plan (adapter extraction, merged): [thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-05-12-GH-1186-openai-compat-shell-adapter.md)
- F1 wrapper (public delegation surface): `plugin/ralph-hero/scripts/ralph-delegate.sh`
- F2 adapter (NOT called directly by skills): `plugin/ralph-hero/scripts/lib/openai-compat.sh`
- F1 wrapper test suite: `plugin/ralph-hero/scripts/__tests__/ralph-delegate.bats`
- F2 adapter test suite: `plugin/ralph-hero/scripts/__tests__/openai-compat.bats`
- README Delegation section (will get pointer addition): `plugin/ralph-hero/README.md:249-297`
- Skill output style guide: `plugin/ralph-hero/skills/STYLE.md`
- Skill frontmatter template (small read-only skill): `plugin/ralph-hero/skills/status/SKILL.md`
- Skill frontmatter template (small Bash-using skill): `plugin/ralph-hero/skills/record-demo/SKILL.md`
- Existing convention-doc neighbors: `plugin/ralph-hero/skills/shared/quality-standards.md`, `plugin/ralph-hero/skills/shared/artifact-comment-protocol.md`, `plugin/ralph-hero/skills/shared/integration-test-scenarios.md`
- Existing docs neighbor: `plugin/ralph-hero/docs/cli.md`
- CI bats integration: `.github/workflows/ci.yml:124-129`
