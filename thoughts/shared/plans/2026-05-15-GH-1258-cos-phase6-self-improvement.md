---
date: 2026-05-15
status: draft
type: plan
github_issue: 1258
github_issues: [1258]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1258
primary_issue: 1258
tags: [cos-mode, self-improvement, launchd, pi-coding-agent, quarantined-feature, rubric-grading]
---

# cos mode Phase 6 — nightly self-improvement loop (quarantined behind env flag)

## Prior Work

- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]] (Phase 1 — `cos.sh` CLI surface, `model-roles.sh` sourced helper, JSONL run-log convention; `slow` role resolves to `qwen3.5-27b` by default)
- builds_on:: [[2026-05-15-GH-1254-cos-phase2-skill-scaffold]] (Phase 2 — `plugin/ralph-hero/skills/cos/SKILL.md` + `system-prompt.md` that this phase grades and rewrites)
- builds_on:: [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]] (Phase 3 — froze the brief filename convention `thoughts/shared/research/YYYY-MM-DD-cos-morning-brief.md` and the `launchd/com.ralph.cos-morning-brief.plist.template` shape that this phase mirrors)
- builds_on:: [[2026-05-15-GH-1256-cos-phase4-oh-my-pi-conventions]] (Phase 4 — `cos-loop.sh` batch-grading harness reference and the `model-roles.sh` --role plumbing)
- builds_on:: [[2026-05-15-GH-1257-cos-phase5-streamlit-desktop]] (Phase 5 — established the "single S-sized phase = single PR" cadence and the README addition pattern for new modes)

## Overview

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1258 | cos mode Phase 6 — nightly self-improvement loop (quarantined behind env flag) | S |

Single-issue plan (one phase, one PR). Phase 6 ships the **nightly self-improvement loop** — a launchd job that fires at 02:30 daily, grades the last seven `cos-morning-brief.md` files against a 5-dimension rubric, and, when the mean score is below 3.5, drafts a revised `system-prompt.md` and opens a PR labeled `cos-self-improvement` for human review. The entire loop is hard-gated behind `RALPH_COS_SELF_IMPROVE=1`; when unset, the script exits 0 immediately with a "quarantined" log line.

Ships:

1. `plugin/ralph-hero/skills/cos/rubric.md` — the 5-dimension, 1-5 scoring rubric (specificity, actionability, signal-vs-noise, novelty, brevity).
2. `plugin/ralph-hero/scripts/cos/self-improve.sh` — the end-to-end script (env-gate → glob briefs → grade → compute mean → branch + commit + `gh pr create` if mean < 3.5).
3. `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` — fires at 02:30 daily.
4. `plugin/ralph-hero/scripts/cos/self-improve-smoke.sh` — manual end-to-end smoke test with a tmpdir of synthetic briefs.
5. A new `## Self-improvement loop (Phase 6)` section in `plugin/ralph-hero/scripts/cos/README.md` documenting the env-flag gate, the two-manual-verification policy, label conventions, and the launchd install workflow.
6. A two-line addition to `plugin/ralph-hero/skills/cos/system-prompt.md` cross-referencing `rubric.md` so the brief-writer is aware of how it will be graded.

## Shared Constraints

Inherited from the parent plan-of-plans (`#1252` umbrella issue body — the parent plan-of-plans markdown file is not on disk; constraints are inlined here just as Phases 1–5 did):

- **No fork of pi.** All grading must route through `cos.sh --role slow` → `pi` → local `mlx-openai-server`. The script does NOT call the Anthropic SDK, the OpenAI SDK against any remote endpoint, or the `claude` CLI.
- **No replacement for `ralph-knowledge`.** No new memory tiers, no new embeddings pipelines.
- **No TTSR (Time Traveling Streamed Rules) in v1.**
- **No Raspberry Pi hardware.**
- **All cos state lives under `~/.ralph-hero/cos/`.** Phase 6 ADDS `~/.ralph-hero/cos/self-improve/` for transient grading artifacts (per-brief score tables, draft system prompts before they become a PR) — the writes are confined to this single subdirectory.
- **Model is Qwen 3.5 27B** by default (per Phase 1 `model-roles.sh`). Phase 6 uses `--role slow` per the issue body — `slow` resolves to `qwen3.5-27b` today, identical to `default`, but the role is semantically "deliberate/deep reasoning" and is the contract Phase 6 must honor.
- **MCP write tools are off by default.** Phase 6 does NOT need any MCP tools — it operates on local markdown files and shells out to `gh` and `git` directly. No `mcp.json` allowlist changes.

Phase 6-specific constraints:

- **Hard env-flag gate is the FIRST executable line of `self-improve.sh`** (after `set -euo pipefail`). If `RALPH_COS_SELF_IMPROVE` is not exactly `1`, the script exits 0 with the single stderr line `[self-improve] quarantined; set RALPH_COS_SELF_IMPROVE=1 to enable`. No file globbing, no PR creation, no git mutations — pure no-op. This gate is the explicit safety boundary from the parent issue body and MUST be the first thing the script does.
- **Even when the gate is open, the script only OPENS a PR; it NEVER auto-merges.** The human is the verification gate for the first two runs and forever after. Phase 6 does NOT add any auto-merge tooling, does NOT label the PR `auto-merge`, and does NOT run `gh pr merge`. The README documents that a future auto-merge integration (if ever introduced) would key off the `cos-self-improvement` label.
- **Mean-score threshold is `< 3.5`.** `>= 3.5` is the no-PR path — exit 0 with a log line. Equal-to-3.5 deliberately does NOT trigger a PR (the issue's acceptance criterion is "When mean < 3.5"). Use bc or awk for float comparison (bash arithmetic is integer-only).
- **Exactly 7 briefs are graded per run.** The script globs `thoughts/shared/research/*-cos-morning-brief.md`, sorts lexicographically (which equals chronological because the prefix is `YYYY-MM-DD-`), and takes the LAST 7 (most recent). If fewer than 7 briefs exist, the script logs `[self-improve] insufficient briefs (have N, need 7); skipping run` and exits 0 — this is NOT an error condition (the cos morning-brief loop only ships briefs Mon-Fri, so an early-life install might not have 7 yet).
- **Rubric grading is one cos.sh invocation per brief.** The script pipes the brief content + the rubric text + a strict output contract ("emit 5 integers, one per line, in this order: specificity actionability signal-vs-noise novelty brevity") to `cos.sh --role slow`. It parses 5 integers per response. If parsing fails for a given brief (wrong line count, non-integer, value outside 1-5), that brief is logged as `parse_failed` and excluded from the mean calculation. If 3+ briefs fail parsing, the script exits 1 with `[self-improve] too many parse failures (N of 7); aborting before PR`. This prevents a flaky grader from triggering spurious PRs.
- **Per-brief scores table is emitted to stdout.** The table is a markdown table with one row per brief (date | filename | 5 scores | mean). Acceptance criterion is "produces a score-per-brief table in stdout" — this is the canonical output format.
- **Branch naming is deterministic.** `cos-self-improvement/YYYY-MM-DD` (UTC date of the run). If the branch already exists (re-run on the same day), the script logs `[self-improve] branch already exists; aborting to avoid clobbering existing PR` and exits 0. Idempotency over noise.
- **Commit message is conventional.** `docs(cos): self-improvement revision YYYY-MM-DD (mean=X.XX)` to match the project's existing conventional-commit style (Phase 5 used `feat(cos):`, Phase 3 used `feat(cos):`, Phase 4 used `docs(cos):`).
- **PR creation uses `gh pr create --label cos-self-improvement`.** The label must exist before the PR is created — Phase 6 ships an idempotent label-creation step in the script (`gh label create cos-self-improvement --description '...' --color 'fbca04' || true`). The script does NOT depend on a pre-existing label; the launchd job is fully self-contained.
- **PR body includes the per-brief score table, the mean, the list of brief filenames, and a "How to verify" checklist.** The diff itself is the revised `system-prompt.md`. No additional file mutations in the PR.
- **The drafted revised system prompt is itself produced by `cos.sh --role slow`.** The script feeds the current `system-prompt.md` + the rubric + the per-brief scores + a contract ("emit ONLY the revised system-prompt.md content, no preamble, no fenced code block") to cos.sh and captures stdout into a tmpfile. If the output is empty or substantially identical to the input (>= 95% character overlap), the script aborts with `[self-improve] revised prompt indistinguishable from current; no PR`. This prevents trivially-changed PRs from accumulating noise.
- **launchd plist template mirrors `com.ralph.cos-morning-brief.plist.template` shape.** Same `Label` / `ProgramArguments` / `EnvironmentVariables` keys; differences are: (a) `StartCalendarInterval` is a single dict (Hour=2, Minute=30, no Weekday — fires every day, not just Mon-Fri); (b) `EnvironmentVariables` includes `RALPH_COS_SELF_IMPROVE` with a default-empty `<string></string>` value and a comment explaining the manual-verification policy; (c) stdout/stderr paths are `/tmp/ralph-cos-self-improve.out` and `.err`.
- **README documents the two-manual-verification policy.** The README addition explicitly states: "Do NOT set `RALPH_COS_SELF_IMPROVE=1` in the plist's EnvironmentVariables until you have manually invoked `self-improve.sh` twice with the env var set in your shell and confirmed both PRs are sensible." This is the operator-facing version of the safety boundary.
- **No grading of EOD digests or week reviews.** Phase 6 only grades morning briefs (matches the `*-cos-morning-brief.md` glob). EOD digests and week reviews are deferred per the issue's "Out of Scope" section.

## Pre-flight verification (completed during planning)

- **`cos.sh --role slow` works today.** Verified `cos.sh:60` documents `slow      qwen3.5-27b` and `model-roles.sh:34` has the `slow)` case in the role-resolution `case` statement. Phase 6 does NOT need to extend the role surface.
- **Brief filename convention frozen by Phase 3.** Verified `morning-brief.sh:115` writes to `${THOUGHTS_DIR}/shared/research/${DATE}-cos-morning-brief.md`. The glob `*-cos-morning-brief.md` in `self-improve.sh` is the consumer side of that producer contract.
- **launchd template pattern established by Phase 3.** Verified `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` has the exact structural shape Phase 6 mirrors: `<Label>`, `<ProgramArguments>` invoking `/bin/bash -lc 'cd .../cos && ./script.sh'`, `<StartCalendarInterval>` with `<Weekday>`/`<Hour>`/`<Minute>`, `<StandardOutPath>` / `<StandardErrorPath>` in `/tmp/`, `<EnvironmentVariables>` with `PATH` set to `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, and `<RunAtLoad>false</RunAtLoad>`.
- **bash 3.2 compatibility on `self-improve.sh`.** macOS ships bash 3.2 by default. The script must avoid bash-4+ features (`EPOCHREALTIME`, associative arrays, `mapfile`/`readarray`). Use `IFS=$'\n' read -d '' -r -a array < <(...)` or `while read; do array+=(...); done` patterns instead of `mapfile`.
- **Float comparison via `awk`.** `awk -v m="$MEAN" 'BEGIN { exit !(m < 3.5) }'` is the standard portable approach. Avoid `bc` to minimize dependencies (bc IS installed on macOS by default, but awk is everywhere and faster for one-shot comparisons).
- **gh CLI label creation is idempotent via `|| true`.** Verified by `gh label create --help`: re-creating an existing label returns exit code 1 with `label already exists`. Wrapping in `|| true` is the standard pattern (used elsewhere in the codebase).
- **Existing `gh pr create` patterns confirmed.** `plugin/ralph-hero/skills/impl/SKILL.md:180` shows the heredoc-body pattern Phase 6 follows. Phase 6 uses `gh pr create --title "..." --body "$(cat <<'EOF' ... EOF)" --label cos-self-improvement` — the heredoc avoids escaping issues with the score table's pipes.
- **No `cos-self-improvement` GitHub label exists today.** Verified via `gh label list --repo cdubiel08/ralph-hero | grep cos-self`. The script creates it idempotently on first run.
- **No `~/.ralph-hero/cos/self-improve/` directory exists today.** Phase 6 creates it via `mkdir -p` on first run.
- **The `## Self-improvement loop` section is NOT yet in the README.** The existing README has Phase 1-5 sections; Phase 6 appends a Phase 6 section after the Phase 5 section (Phase 5 section anchor: `## Desk mode (Streamlit dashboard)`).
- **Auto-release workflow at `.github/workflows/release.yml`** does NOT trigger on `docs(cos):` commits to skill markdown only — verified by the workflow's path filter targeting `mcp-server/**`. Phase 6's commits touch `plugin/ralph-hero/scripts/cos/**` and `plugin/ralph-hero/skills/cos/**` but NOT `mcp-server/**`, so no version bump fires. No CI changes required.

## Current State Analysis

After Phases 1–5 ship (all five CLOSED on GitHub), the foundation Phase 6 builds on:

- **`plugin/ralph-hero/scripts/cos/`** contains: `README.md`, `PREFLIGHT.md`, `model-roles.sh`, `cos.sh`, `cos-loop.sh`, `cos-loop-smoke.sh`, `cos-unattended.sh`, `cos-desk.sh`, `cos-remote.sh`, `morning-brief.sh`, `mcp.json.example`, `install-mcp-config.sh`, `smoke.sh`, `extensions/`, `launchd/com.ralph.cos-morning-brief.plist.template`, and (after Phase 5) `desk/`. Phase 6 ADDS `self-improve.sh`, `self-improve-smoke.sh`, and `launchd/com.ralph.cos-self-improve.plist.template`.
- **`plugin/ralph-hero/skills/cos/`** contains: `SKILL.md`, `system-prompt.md`, `prompts/`. Phase 6 ADDS `rubric.md` and APPENDS two lines to `system-prompt.md` cross-referencing the rubric.
- **`thoughts/shared/research/*-cos-morning-brief.md`** is the producer-side artifact written by `morning-brief.sh` (Phase 3). Phase 6 is the first consumer of that artifact corpus.
- **`~/.ralph-hero/cos/runs/YYYY-MM-DD.jsonl`** is the per-invocation log from `cos.sh`. Phase 6's grading runs append to this log naturally (each `cos.sh --role slow` call writes one row); the script does NOT bypass the log.

### Key Discoveries

- The "grade against rubric" step is N+1 cos.sh invocations: N for grading (one per brief, 7 total) + 1 for drafting the revised prompt. Each invocation appends a row to today's JSONL run-log — this is the audit trail that lets the human verify on the next day "the self-improve job ran at 02:30 and made 8 cos.sh calls."
- The PR's diff is exactly one file: `plugin/ralph-hero/skills/cos/system-prompt.md`. The script does NOT touch any other file in the commit. This makes the PR easy to review (the human can diff the old vs new prompt directly in the GitHub PR UI).
- The "quarantined; set RALPH_COS_SELF_IMPROVE=1 to enable" log line is the exit signal the launchd job logs to `/tmp/ralph-cos-self-improve.err` (or `.out`). When the human installs the plist with the env var UNSET, the launchd job fires at 02:30 daily but does nothing — the log line is the only artifact. This is the intended steady-state for the first two weeks.
- The "two manual verification runs" criterion is enforced socially via the README, not technically by the script. A future Phase 7 could add a counter file (`~/.ralph-hero/cos/self-improve/verification-count`) that gates auto-PR until the human has manually `touch`ed it twice, but that's out of scope for v1 — the env var alone IS the gate.
- The script is the FIRST cos-mode artifact that performs git mutations. Phase 1-5 are read-only or write-only to `thoughts/` or `~/.ralph-hero/`. Phase 6 runs `git checkout -b`, `git add`, `git commit`, `git push`, `gh pr create`. The README must clearly call out that the launchd job (even when env-gated open) makes commits and pushes branches — this is a behavioral change from prior phases.

## Desired End State

After Phase 6 ships and is merged to main:

- `RALPH_COS_SELF_IMPROVE=1 self-improve.sh` runs end-to-end on a directory with ≥7 briefs and produces a score-per-brief table in stdout.
- When mean < 3.5, the script opens a real PR labeled `cos-self-improvement` with the per-brief score breakdown in the body and the revised `system-prompt.md` as the diff.
- When mean >= 3.5, no PR is opened; the script exits 0 with `[self-improve] mean X.XX >= 3.5; no revision needed`.
- Without `RALPH_COS_SELF_IMPROVE=1`, the script exits 0 immediately with the "quarantined" log line.
- `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` exists and fires at 02:30 daily when installed.
- `plugin/ralph-hero/skills/cos/rubric.md` exists with 5 scored dimensions, is referenced from `system-prompt.md`, and is referenced from `self-improve.sh`.
- README documents the two-manual-verification policy explicitly.

### Verification

- [ ] `RALPH_COS_SELF_IMPROVE=1 self-improve.sh` on a tmpdir of ≥7 synthetic briefs prints a 7-row score table to stdout, computes a mean, and prints `[self-improve] mean X.XX (< 3.5 or >= 3.5)` to stderr.
- [ ] When mean < 3.5, the script creates branch `cos-self-improvement/$(date -u +%F)`, commits one file (`plugin/ralph-hero/skills/cos/system-prompt.md`), pushes, and runs `gh pr create --label cos-self-improvement` successfully.
- [ ] When mean >= 3.5, the script exits 0 with no git mutations.
- [ ] `unset RALPH_COS_SELF_IMPROVE; self-improve.sh` exits 0 immediately with the "quarantined" log line on stderr.
- [ ] launchd plist template loads successfully (`plutil -lint` passes) and `launchctl load` accepts it without error.
- [ ] `grep -F "rubric.md" plugin/ralph-hero/skills/cos/system-prompt.md` matches; `grep -F "rubric.md" plugin/ralph-hero/scripts/cos/self-improve.sh` matches.
- [ ] `shellcheck plugin/ralph-hero/scripts/cos/self-improve.sh` passes with no warnings.
- [ ] README's new Phase 6 section explicitly contains the two-manual-verification policy sentence.

## What We're NOT Doing

- **No auto-merging of `cos-self-improvement`-labeled PRs.** Forever human-gated in v1.
- **No grading of EOD digests or week reviews.** Phase 6 only grades morning briefs. The `*-cos-morning-brief.md` glob is the strict filter.
- **No TTSR pattern-triggered rule injection.** Deferred to a hypothetical Phase 7.
- **No counter-based "two verifications" gate in code.** Enforced socially via README. The env var is THE gate.
- **No new MCP tools.** Phase 6 operates on local markdown and shells out to git / gh — no MCP server mutations or allowlist changes.
- **No mlx-openai-server health check inside `self-improve.sh`.** If pi can't reach the server, `cos.sh` already exits non-zero and that propagates up — the script does NOT re-implement health checking.
- **No retry-on-parse-failure for the grading step.** If a brief grades to a parse-failed response, it's excluded from the mean (up to 2 failures tolerated); >= 3 failures aborts the run. This avoids flaky-grader-induced PR noise.
- **No diff-based "smart" detection of which briefs are new since last grading run.** Every nightly run grades the most recent 7 briefs, even if 6 of those 7 were graded the previous night. The corpus is small enough that 7 grading calls per night is acceptable cost.
- **No CI workflow changes.** The auto-release workflow does NOT trigger on these paths. No `.github/workflows/*.yml` mutations.

## Implementation Approach

The work is a single phase (1 of 1) because the issue is S-sized and all artifacts are tightly coupled (the script references the rubric file which references the system prompt; the launchd template references the script; the README documents all three). Splitting would create cross-cutting commits that don't ship independently.

The phase produces 5 new files (`rubric.md`, `self-improve.sh`, `self-improve-smoke.sh`, the plist template, the README section addition) and 1 modified file (`system-prompt.md` gets two appended lines). All changes ship in one PR.

The order within the phase is bottom-up: rubric first (no deps), then script (depends on rubric + cos.sh contract), then smoke test (depends on script), then plist template (depends on script's CLI surface), then README + system-prompt cross-references (depend on all of the above existing).

---

## Phase 1: Nightly self-improvement loop — GH-1258

- **depends_on**: null

### Overview

Ship the env-flag-gated nightly grading + auto-PR loop in a single PR. The work is tightly coupled — the rubric, the script, the smoke test, the launchd template, and the README all reference each other — so all five artifacts land together.

### Tasks

#### Task 1.1: Author the 5-dimension rubric

- **files**: `plugin/ralph-hero/skills/cos/rubric.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/cos/rubric.md`
  - [ ] Contains exactly 5 dimensions: specificity, actionability, signal-vs-noise, novelty, brevity
  - [ ] Each dimension has a clear 1-point and 5-point anchor (e.g., "1 = no concrete file paths or issue numbers; 5 = every claim grounded in a path or #NNN")
  - [ ] Includes an "Output contract" section that specifies the grading script will request exactly 5 integers on 5 lines, in the listed order, with no other text
  - [ ] File begins with `# Cos Morning Brief Grading Rubric` H1

#### Task 1.2: Author `self-improve.sh` script

- **files**: `plugin/ralph-hero/scripts/cos/self-improve.sh` (create), `plugin/ralph-hero/scripts/cos/cos.sh` (read), `plugin/ralph-hero/scripts/cos/morning-brief.sh` (read), `plugin/ralph-hero/skills/cos/rubric.md` (read), `plugin/ralph-hero/skills/cos/system-prompt.md` (read)
- **tdd**: false (shell script — manual smoke test is in Task 1.3)
- **complexity**: high
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] Script starts with `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] First executable line after `set` checks `[[ "${RALPH_COS_SELF_IMPROVE:-}" == "1" ]]` and exits 0 with the "quarantined" log line otherwise
  - [ ] `chmod +x` is set on the file
  - [ ] Globs `${THOUGHTS_DIR}/shared/research/*-cos-morning-brief.md` (where `THOUGHTS_DIR` is resolved the same way `morning-brief.sh:104-108` resolves it — repo root → `../thoughts`, overridable via `RALPH_COS_THOUGHTS_DIR`)
  - [ ] Takes the LAST 7 lexicographically sorted briefs (most recent by date prefix)
  - [ ] Exits 0 with `[self-improve] insufficient briefs (have N, need 7); skipping run` if fewer than 7 briefs found
  - [ ] For each of the 7 briefs: invokes `cos.sh --role slow` with a prompt that includes the brief content + the rubric text + the strict 5-line-integer output contract; parses 5 integers; validates each is in `[1,5]`
  - [ ] Counts parse failures; aborts with exit 1 if >= 3 of 7 briefs fail parsing
  - [ ] Computes mean across all successful score datapoints (between 25 and 35 integers depending on parse-failure count)
  - [ ] Emits a markdown table to stdout: header row `| Date | Brief | Specificity | Actionability | S/N | Novelty | Brevity | Mean |`, one row per brief, final row `| | **Overall mean** | | | | | | **X.XX** |`
  - [ ] Uses awk for the `mean < 3.5` comparison
  - [ ] If mean >= 3.5: exits 0 with `[self-improve] mean X.XX >= 3.5; no revision needed` on stderr
  - [ ] If mean < 3.5: checks `git rev-parse --verify cos-self-improvement/$(date -u +%F)` and aborts with `[self-improve] branch already exists; aborting` if it does
  - [ ] Otherwise: creates branch `cos-self-improvement/$(date -u +%F)`, invokes `cos.sh --role slow` again with the current `system-prompt.md` + rubric + per-brief scores + the "emit ONLY revised system-prompt.md content" contract, captures stdout to a tmpfile under `~/.ralph-hero/cos/self-improve/`
  - [ ] Validates the drafted prompt is non-empty AND differs from the current `system-prompt.md` by at least 5% character count (`abs(new_len - old_len) > 0.05 * old_len OR sha256(new) != sha256(old)`); aborts with `[self-improve] revised prompt indistinguishable from current; no PR` otherwise
  - [ ] Overwrites `plugin/ralph-hero/skills/cos/system-prompt.md` with the drafted content, `git add`s it, commits with message `docs(cos): self-improvement revision $(date -u +%F) (mean=X.XX)`, pushes the branch to origin
  - [ ] Runs `gh label create cos-self-improvement --description 'Drafted by the nightly cos self-improvement loop' --color 'fbca04' || true` (idempotent)
  - [ ] Runs `gh pr create --title "cos: self-improvement revision $(date -u +%F)" --body "$(heredoc with score table + filenames + 'How to verify' checklist)" --label cos-self-improvement` and captures the URL to stdout
  - [ ] Has a `--help` / `-h` flag that prints usage and exits 0
  - [ ] Has a clear comment block at the top documenting env vars (`RALPH_COS_SELF_IMPROVE`, `RALPH_COS_THOUGHTS_DIR`, `RALPH_COS_DEBUG`) and exit codes
  - [ ] `shellcheck` passes with no warnings

#### Task 1.3: Author `self-improve-smoke.sh` manual smoke test

- **files**: `plugin/ralph-hero/scripts/cos/self-improve-smoke.sh` (create), `plugin/ralph-hero/scripts/cos/self-improve.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] Script starts with `#!/usr/bin/env bash` and `set -euo pipefail`
  - [ ] `chmod +x` is set
  - [ ] Creates a tmpdir via `mktemp -d`; sets `RALPH_COS_THOUGHTS_DIR` to point at it
  - [ ] Writes 7 synthetic `YYYY-MM-DD-cos-morning-brief.md` files (e.g., dates from 7 consecutive days ending today) into `$TMPDIR/shared/research/`, each with realistic-but-grade-low content (e.g., vague summaries with no `#NNN` refs, no file paths)
  - [ ] Sets `RALPH_COS_SELF_IMPROVE=1` and runs `self-improve.sh`, capturing stdout + stderr to log files in the tmpdir
  - [ ] Asserts the stdout contains a markdown table header `| Date | Brief |`
  - [ ] Asserts the stderr contains either `mean X.XX >= 3.5` OR `mean X.XX < 3.5`
  - [ ] If mean < 3.5 path fires: asserts the branch was created (then deletes it locally with `git branch -D cos-self-improvement/$(date -u +%F)` to leave a clean state) and prints "Smoke test passed: low-quality briefs triggered draft prompt (branch cleaned up)"
  - [ ] If mean >= 3.5 path fires (unlikely with synthetic low-quality content but possible): prints "Smoke test passed: graded briefs but threshold not crossed (mean=X.XX)"
  - [ ] Cleans up tmpdir on exit via `trap`
  - [ ] Does NOT push to origin and does NOT call `gh pr create` (the smoke test is local-only; insert an env var like `RALPH_COS_SELF_IMPROVE_DRY_RUN=1` that `self-improve.sh` honors to skip the push + PR steps — and add this dry-run flag to Task 1.2's script as well)
  - [ ] Exits 0 on pass, non-zero on any assertion failure

**Note**: Task 1.3 introduces `RALPH_COS_SELF_IMPROVE_DRY_RUN=1` — a second env var that `self-improve.sh` honors. When set, the script does everything up to (and including) the commit, but skips `git push` and `gh pr create`. This is the test-isolation lever. Add this requirement to Task 1.2's acceptance criteria implicitly via this note: Task 1.2 acceptance must also include "Honors `RALPH_COS_SELF_IMPROVE_DRY_RUN=1` by skipping push + PR creation but still creating the branch + commit for inspection."

#### Task 1.4: Author the launchd plist template

- **files**: `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` (create), `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template` (read for pattern)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] File is a valid plist (verifiable via `plutil -lint`)
  - [ ] `<Label>` is `com.ralph.cos-self-improve`
  - [ ] `<ProgramArguments>` invokes `/bin/bash -lc 'cd /Users/dubiel/projects/ralph-hero/plugin/ralph-hero/scripts/cos && ./self-improve.sh'`
  - [ ] `<StartCalendarInterval>` is a single dict with `<Hour>2</Hour>` and `<Minute>30</Minute>` (no `<Weekday>` key — fires every day)
  - [ ] `<StandardOutPath>` is `/tmp/ralph-cos-self-improve.out`
  - [ ] `<StandardErrorPath>` is `/tmp/ralph-cos-self-improve.err`
  - [ ] `<EnvironmentVariables>` includes `PATH` set to `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`
  - [ ] `<EnvironmentVariables>` includes `RALPH_COS_SELF_IMPROVE` with empty `<string></string>` value AND an XML comment above it explicitly stating: "Set to 1 to enable. Do NOT set until you have manually verified the script twice — see plugin/ralph-hero/scripts/cos/README.md § Self-improvement loop."
  - [ ] `<RunAtLoad>false</RunAtLoad>` (do not fire on launchctl load)
  - [ ] Top-of-file comment block documents the install workflow (cp template → hand-edit paths → launchctl load) matching the style of `com.ralph.cos-morning-brief.plist.template`

#### Task 1.5: Append rubric cross-reference to system-prompt.md

- **files**: `plugin/ralph-hero/skills/cos/system-prompt.md` (modify), `plugin/ralph-hero/skills/cos/rubric.md` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] A new `## Grading rubric` section is appended to `system-prompt.md` (after the existing `## Example Output` section)
  - [ ] The section is 2-3 sentences max; states that morning briefs are graded nightly against the rubric at `plugin/ralph-hero/skills/cos/rubric.md` along 5 dimensions, and that consistently low scores trigger a self-improvement PR
  - [ ] Contains the literal string `rubric.md` so the verification grep matches
  - [ ] Does NOT alter any existing section (verifiable via `git diff --stat` showing one file changed and the existing sections unchanged)

#### Task 1.6: Append Phase 6 section to scripts/cos/README.md

- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify), `plugin/ralph-hero/scripts/cos/self-improve.sh` (read), `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.2, 1.4]
- **acceptance**:
  - [ ] A new `## Self-improvement loop (Phase 6)` section is added after the existing Phase 5 section (which Phase 5's PR added — if Phase 5 has not yet merged README changes, append after the Phase 3 `## Unattended morning brief (Phase 3)` section instead)
  - [ ] Section documents: what the loop does (one-paragraph summary); the `RALPH_COS_SELF_IMPROVE=1` env-flag gate; the `RALPH_COS_SELF_IMPROVE_DRY_RUN=1` test flag; the launchd install workflow (cp template → hand-edit → launchctl load); the two-manual-verification policy (explicit sentence: "Do NOT set `RALPH_COS_SELF_IMPROVE=1` in the plist's EnvironmentVariables until you have manually invoked `self-improve.sh` twice with the env var set in your shell and confirmed both PRs are sensible."); the `cos-self-improvement` label convention; the smoke-test path (`self-improve-smoke.sh`); and the directory layout addition (`launchd/com.ralph.cos-self-improve.plist.template`, `self-improve.sh`, `self-improve-smoke.sh`)
  - [ ] Updates the "Directory layout" section's tree to include the new files
  - [ ] Updates the "Downstream phases" table's Phase 6 row to remove the "(planned)" caveat if present (Phase 6 is now SHIPPED in this PR)
  - [ ] The two-manual-verification policy sentence is present verbatim in the README

#### Task 1.7: Update cos SKILL.md mode table (if applicable)

- **files**: `plugin/ralph-hero/skills/cos/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.2]
- **acceptance**:
  - [ ] If `SKILL.md` has a "mode table" or phase-status table that references Phase 6, the Phase 6 row is updated to mark it Active / Shipped (mirroring how Phase 5's plan handled the equivalent Phase 5 row update)
  - [ ] If no such table exists, this task is a no-op and explicitly skipped (note in the PR body: "Task 1.7 skipped — SKILL.md has no phase-status table")
  - [ ] Implementer must `grep -n "Phase 6\|self-improve" plugin/ralph-hero/skills/cos/SKILL.md` to determine whether the file needs editing before opening

### Phase Success Criteria

#### Automated Verification:

- [x] `shellcheck plugin/ralph-hero/scripts/cos/self-improve.sh` — no warnings
- [x] `shellcheck plugin/ralph-hero/scripts/cos/self-improve-smoke.sh` — no warnings
- [x] `plutil -lint plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-self-improve.plist.template` — `OK`
- [x] `grep -F "rubric.md" plugin/ralph-hero/skills/cos/system-prompt.md` — exit 0
- [x] `grep -F "rubric.md" plugin/ralph-hero/scripts/cos/self-improve.sh` — exit 0
- [x] `grep -F "two manual verification" plugin/ralph-hero/scripts/cos/README.md` — exit 0 (case-insensitive: `grep -iF`)
- [x] `grep -F "RALPH_COS_SELF_IMPROVE" plugin/ralph-hero/scripts/cos/self-improve.sh` — exit 0
- [x] `cd plugin/ralph-hero/mcp-server && npm run build` — no errors (regression check — this phase touches no TS but the gate must stay green)
- [x] `unset RALPH_COS_SELF_IMPROVE && plugin/ralph-hero/scripts/cos/self-improve.sh; echo $?` — prints `0` (env-gate fast-exit)
- [x] `unset RALPH_COS_SELF_IMPROVE && plugin/ralph-hero/scripts/cos/self-improve.sh 2>&1 >/dev/null | grep -F "quarantined"` — exit 0

#### Manual Verification:

- [ ] Run `plugin/ralph-hero/scripts/cos/self-improve-smoke.sh` with `mlx-openai-server` running on `:8000`; observe the markdown score table on stdout, the mean log line on stderr, and (if branch was created) confirm the branch was deleted by the smoke test's cleanup step
- [ ] Inspect a dry-run-created branch's `system-prompt.md` diff: confirm the revised prompt is non-trivial (not just whitespace changes) and remains a reasonable system prompt for a chief-of-staff role
- [ ] Load the launchd plist template (after copying to `~/Library/LaunchAgents/` and hand-editing the path): `launchctl load ~/Library/LaunchAgents/com.ralph.cos-self-improve.plist`; verify `launchctl list | grep cos-self-improve` shows the job; verify nothing fires immediately (`RunAtLoad=false`); unload to clean up
- [ ] Read the README's new Phase 6 section: confirm the two-manual-verification policy reads as an unambiguous operator instruction, not a vague suggestion
- [ ] Confirm the PR's title and body match the conventional-commit + heredoc patterns established by Phases 3-5 (visual inspection of the opened PR on GitHub)

**Creates for next phase**: N/A — Phase 6 is the final phase of the cos-mode parent epic (#1252). After Phase 6 merges, the cos-mode shipping is complete; any further work is a new parent issue (e.g., a hypothetical "cos-mode-v2" with TTSR, EOD digests, week reviews, and auto-merge for the self-improvement loop).

---

## Integration Testing

- [ ] **End-to-end dry-run on real briefs**: with `RALPH_COS_SELF_IMPROVE=1 RALPH_COS_SELF_IMPROVE_DRY_RUN=1`, run `self-improve.sh` against the actual `thoughts/shared/research/` directory (assumes ≥7 morning briefs have shipped by the time Phase 6 lands). Confirm the score table is sensible and the branch is created locally without pushing.
- [ ] **launchd dry-fire**: install the plist with `RALPH_COS_SELF_IMPROVE` UNSET in `<EnvironmentVariables>`. Manually fire via `launchctl start com.ralph.cos-self-improve`. Confirm `/tmp/ralph-cos-self-improve.err` contains the "quarantined" log line and the job exits 0 with no git mutations.
- [ ] **Idempotent label creation**: run `self-improve.sh` (with env gate open and dry-run) twice on the same day. Confirm the second run does NOT error on `gh label create` (the `|| true` swallows the "already exists" failure).
- [ ] **Same-day re-run guard**: with `RALPH_COS_SELF_IMPROVE=1` and a pre-existing `cos-self-improvement/$(date -u +%F)` branch, run `self-improve.sh`. Confirm it aborts with `branch already exists` and does NOT clobber.

## References

- Parent issue: https://github.com/cdubiel08/ralph-hero/issues/1252
- This issue: https://github.com/cdubiel08/ralph-hero/issues/1258
- Phase 1 plan: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]]
- Phase 3 plan (launchd template precedent): [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]]
- Phase 5 plan (single-issue plan style precedent): [[2026-05-15-GH-1257-cos-phase5-streamlit-desktop]]
- Existing PR-automation pattern: `plugin/ralph-hero/skills/impl/SKILL.md:180` (heredoc-body `gh pr create`)
- Existing launchd template: `plugin/ralph-hero/scripts/cos/launchd/com.ralph.cos-morning-brief.plist.template`
- Existing cos.sh CLI contract: `plugin/ralph-hero/scripts/cos/cos.sh:33-228`
- Existing system prompt: `plugin/ralph-hero/skills/cos/system-prompt.md`
