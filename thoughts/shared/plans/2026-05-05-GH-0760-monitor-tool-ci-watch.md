---
date: 2026-05-05
status: draft
type: plan
github_issue: 760
github_issues: [760]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/760
primary_issue: 760
tags: [monitor-tool, ci-watch, finish-skill, polling, async-notifications]
---

# Adopt Monitor Tool for CI Watch in Finish Skill - Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-04-12-monitor-tool-codebase-compositions]]
- builds_on:: [[2026-03-01-GH-0466-idle-notification-spam]]
- builds_on:: [[2026-03-25-GH-0224-ci-feedback-loop-post-push]]

## Overview

Single-issue plan replacing the sleep-based CI polling loop in the finish skill with a single `Monitor` tool invocation that streams CI run status as conversation notifications.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-760 | Adopt Monitor tool for CI watch in finish skill | S |

## Shared Constraints

- **Primary scope only**: Modify the `finish` skill's CI watch (Step 6). Defer dev-server-readiness polling in research skills (research doc explicitly recommends "implement only if CI watch proves the pattern").
- **Allowlist enforcement**: The `finish-agent.md` `tools:` field is the runtime enforcement boundary. `Monitor` MUST be added to both `skills/finish/SKILL.md` `allowed-tools` and `agents/finish-agent.md` `tools` for the agent dispatch path to work. Plugin agents cannot declare `hooks`, `mcpServers`, or `permissionMode` in frontmatter — only `tools`, `skills`, etc.
- **Behavior preservation**: The four CI verdicts (PASS / FAIL / PENDING / SKIPPED) in Step 7's `FINISHED` report MUST be preserved verbatim. Existing callers (e.g., hero orchestrator, ralph-team) parse this report.
- **No buffering**: The Monitor poll script MUST use `grep --line-buffered` or explicit `printf` per stdout line — `gh run list` JSON output piped through `jq` can buffer if invoked naively.
- **Idempotent state transitions**: Only emit a notification line when the run summary differs from the previous iteration (per research doc lines 73-79). Notification spam was a prior concern (GH-0466).
- **Terminal exit**: The Monitor script MUST exit on terminal state (all success, any failure, or 10-min timeout). Monitor's `timeout_ms=600000` is the safety net but the script's own exit is the canonical terminal signal.
- **Stderr discipline**: `gh` and `jq` errors go to stderr and do NOT trigger notifications. `|| true` MUST guard transient failures so the loop continues across the rare API hiccup.
- **No new dependencies**: The current finish skill uses `gh`, `jq`, and Bash — no new dependencies. The Monitor script must work with these.
- **Single fix cycle preserved**: Step 4a's "max 1 fix cycle" semantics for code review fixes are unrelated to CI watch and MUST remain unchanged.

## Current State Analysis

The `finish` skill (`plugin/ralph-hero/skills/finish/SKILL.md:247-267`) and its companion agent (`agents/finish-agent.md`) implement Step 6 as a polling loop:

1. `MERGE_SHA=$(gh pr view PR_NUMBER --json mergeCommit --jq '.mergeCommit.oid')` — obtain the merge SHA after Step 5 reports `MERGED`.
2. `gh run list --commit "$MERGE_SHA" --json status,conclusion,name,url --limit 10` — fetch CI runs.
3. The agent-runtime executes this Bash call, then sleeps 30s, then re-issues the call. Each cycle burns one Bash tool turn. The cycle continues until: all runs `conclusion=success` (PASS), any `conclusion=failure` (FAIL), or 10 minutes elapse (PENDING).

**Three problems** identified by research:

1. **Tool-turn burn**: Each 30s poll consumes a Bash tool call. 10-minute max → up to 20 tool-call turns wasted on identical polling.
2. **Agent blocking**: The finish-agent cannot do other work while polling — every turn is a poll cycle.
3. **No state-transition notifications**: The current pattern returns full output every poll, not deltas. Visual noise in transcripts.

**The Monitor tool** (per research doc, section "The Monitor Tool" lines 32-58) is purpose-built for the streaming case: a background script whose every stdout line becomes a single conversation notification, with auto-batching of lines within 200ms, auto-kill on excessive events, and a 1-hour max timeout (10 min easily fits). The research doc lines 71-91 already provides a working Monitor poll script.

**Allowlist gap**: Neither `finish/SKILL.md` `allowed-tools` (lines 16-30) nor `finish-agent.md` `tools` (line 5) currently includes `Monitor`. This must be added in this phase.

## Desired End State

After this plan:

- `skills/finish/SKILL.md` Step 6 invokes `Monitor(...)` once with a CI poll script and a `timeout_ms` of 600000.
- The poll script emits a one-line summary only when the run summary changes (state transitions only — not every 30s).
- The poll script terminates with a clearly-parseable `CI PASSED:`, `CI FAILED:`, or `CI SKIPPED:` line.
- Step 6's "no runs found" / "10 min timeout" branches map to `CI SKIPPED:` (no runs) or `CI PENDING:` (timeout) terminal lines.
- Step 7's `FINISHED` report parses these terminal lines and produces the same `PASS / FAIL / PENDING / SKIPPED` outputs as today.
- `Monitor` is added to the `allowed-tools` of `finish/SKILL.md` and the `tools` of `finish-agent.md`.

### Verification

- [x] Step 6 of `skills/finish/SKILL.md` no longer contains the language "Poll every 30 seconds for up to 10 minutes" or any `sleep 30` instruction. (Note: the embedded Monitor poll script contains an internal `sleep 30` between iterations — this is the script's loop pacing, not an agent-blocking poll. The skill prose at the agent level is sleep-free.)
- [x] `Monitor(` literal appears exactly once in Step 6.
- [x] `Monitor` literal appears in the YAML frontmatter `allowed-tools` of `skills/finish/SKILL.md`.
- [x] `Monitor` literal appears in the YAML frontmatter `tools` of `agents/finish-agent.md`.
- [x] Step 7 verdict parsing handles all four terminal lines (`CI PASSED:`, `CI FAILED:`, `CI PENDING:`, `CI SKIPPED:`).
- [x] Existing skill output formatting (`FINISHED`, `Issue: #NNN`, etc.) is byte-for-byte preserved.
- [x] The plan's research doc reference (`thoughts/shared/research/2026-04-12-monitor-tool-codebase-compositions.md`) is reachable.

## What We're NOT Doing

- **NOT touching** dev-server polling in `ralph-research/SKILL.md` or `research/SKILL.md` (research doc explicitly: "implement only if CI watch proves the pattern" — defer to a follow-up issue).
- **NOT touching** the `ralph-loop.sh` `sleep 5` inter-iteration gap — it operates outside Claude Code (research doc lines 137-139).
- **NOT touching** the rate-limiter or retry-after `setTimeout` calls in `mcp-server/src/lib/rate-limiter.ts` and `github-client.ts` — they operate at a different abstraction layer (research doc lines 154-161).
- **NOT touching** `cli-dispatch.sh`'s `awk fflush()` filter — it's a bash script, not a skill (research doc lines 121-125).
- **NOT changing** the Step 4/4a code review gate, Step 3 validation flow, or Step 5 merge dispatch.
- **NOT introducing** a Monitor wrapper helper or a new shared fragment — too small to abstract; one inline Monitor call suffices.
- **NOT making** the Monitor script `persistent: true` — CI watch has a defined terminal state; persistent mode is for session-lifetime watches.
- **NOT version-bumping** the plugin manifest — markdown-only skill changes do not require an MCP server release (CI auto-release only triggers on `mcp-server` source changes per `release.yml`).

## Implementation Approach

Single phase. Both the skill file and the agent frontmatter are edited together because they form a unit (skill body + allowlist constraint). Splitting them would leave the skill unable to dispatch to the agent.

The implementation follows the research doc's ready-to-use Monitor script (lines 71-91), refined to:
- Add a `CI SKIPPED:` branch when `gh run list` returns an empty array on the merge SHA (no CI configured).
- Add a `CI PENDING:` line emitted just before the script exits non-zero on `timeout_ms`. Since Monitor sends SIGTERM on timeout, the script itself cannot reliably emit a final line — instead, the Step 6 logic in the skill MUST treat absence of a `CI PASSED:` / `CI FAILED:` / `CI SKIPPED:` line within the timeout window as `CI PENDING:`.
- Use `--line-buffered` semantics by writing each summary line via `printf '%s\n'` (not `echo`) and avoiding shell pipelines that would buffer.

---

## Phase 1: Replace CI watch polling loop with Monitor tool

- **depends_on**: null

### Overview

Update Step 6 of the finish skill to invoke `Monitor(...)` with a state-transition-emitting poll script. Add `Monitor` to the allowlist of both the skill and the agent. Adjust Step 7 verdict parsing to recognize the four terminal lines emitted by the script. Preserve the existing `FINISHED` report format.

### Tasks

#### Task 1.1: Add Monitor to finish skill allowed-tools
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] The YAML frontmatter `allowed-tools:` list at lines 16-30 of `skills/finish/SKILL.md` includes `Monitor` as a new entry.
  - [x] No other entries in the allowlist are removed or reordered.
  - [x] The YAML remains valid (parses with no errors).

#### Task 1.2: Add Monitor to finish-agent tools allowlist
- **files**: `plugin/ralph-hero/agents/finish-agent.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [x] The `tools:` line in the frontmatter of `agents/finish-agent.md` includes `Monitor` (added to the existing comma-separated list).
  - [x] All existing tools (`Read`, `Glob`, `Grep`, `Bash`, `Skill`, `AskUserQuestion`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__*`) remain present and unchanged.
  - [x] The frontmatter parses as valid YAML.

#### Task 1.3: Replace polling loop in Step 6 with Monitor invocation
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.1]
- **acceptance**:
  - [x] Step 6 ("CI Watch") in `skills/finish/SKILL.md` no longer contains the literal text "Poll every 30 seconds for up to 10 minutes".
  - [x] Step 6 contains exactly one `Monitor(` literal call.
  - [x] The Monitor invocation passes `timeout_ms=600000` (10 minutes in ms).
  - [x] The Monitor invocation includes a `description` field (required parameter).
  - [x] The embedded poll script does the following in this order: (a) initialize `last_status=""`, (b) loop forever, (c) call `gh run list --commit "$MERGE_SHA" --json status,conclusion,name --limit 10 2>/dev/null || echo "[]"`, (d) compute a one-line summary via `jq -r`, (e) print the summary via `printf` only when it differs from `last_status`, (f) check terminal state via `jq -e 'length > 0 and all(.conclusion != null)'`, (g) on terminal: print `CI PASSED:` (all success), `CI FAILED:` (any non-success), or `CI SKIPPED:` (length == 0), and exit 0, (h) `sleep 30` between iterations.
  - [x] The script handles the empty-array case (no CI runs configured): prints `CI SKIPPED: no runs found for $MERGE_SHA` and exits 0 immediately rather than looping forever.
  - [x] The script uses `printf '%s\n'` (not `echo`) for its summary lines so newlines are deterministic.
  - [x] All `gh` and `jq` invocations have `2>/dev/null` and `|| true` (or equivalent fallback like `|| echo "[]"`) to keep the loop alive across transient API failures.
  - [x] The terminal verdict line is the LAST line the script emits before `exit 0`.

#### Task 1.4: Adapt Step 7 verdict parsing for Monitor terminal lines
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [1.3]
- **acceptance**:
  - [x] Step 7 includes instructions for the agent to parse the LAST notification received from the Monitor as the CI verdict.
  - [x] Step 7 explicitly enumerates the four verdict states with their source signals: `PASS` (Monitor's last line begins with `CI PASSED:`), `FAIL` (begins with `CI FAILED:`), `SKIPPED` (begins with `CI SKIPPED:`), `PENDING` (Monitor reached `timeout_ms` without emitting any of the three terminal prefixes).
  - [x] The `FINISHED` report block at the top of Step 7 still produces the four verdict labels (`PASS / FAIL / PENDING (timeout) / SKIPPED (no runs)`) byte-for-byte unchanged.
  - [x] Step 7 retains the existing instruction "If CI FAIL: links to failed runs" — the Monitor script's `CI FAILED:` line MUST include the failed run names (per Task 1.3), and Step 7 instructs the agent to surface those names.

#### Task 1.5: Update Step 6 prose to describe Monitor semantics
- **files**: `plugin/ralph-hero/skills/finish/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.3]
- **acceptance**:
  - [x] Step 6's introductory prose explains that CI watch uses Monitor (a streaming-notification tool) rather than 30-second polling.
  - [x] Step 6 mentions that notifications arrive only on state transitions (not every poll cycle).
  - [x] Step 6 mentions the 10-minute `timeout_ms` safety net.
  - [x] No reference to "every 30 seconds" or "burning a tool call" remains in Step 6 prose (these are implementation details now hidden inside the Monitor script).

### Phase Success Criteria

#### Automated Verification:
- [x] `python3 -c "import yaml,sys; yaml.safe_load(open('plugin/ralph-hero/skills/finish/SKILL.md').read().split('---')[1])"` — frontmatter parses with no error. (Run via `uv run --with pyyaml python3 -c '...'` since system python3 lacks PyYAML; semantically equivalent.)
- [x] `python3 -c "import yaml,sys; yaml.safe_load(open('plugin/ralph-hero/agents/finish-agent.md').read().split('---')[1])"` — frontmatter parses with no error.
- [x] `grep -q "^  - Monitor$" plugin/ralph-hero/skills/finish/SKILL.md` — Monitor present in skill allowlist.
- [x] `grep -q "Monitor" plugin/ralph-hero/agents/finish-agent.md` — Monitor present in agent tools.
- [x] `grep -c "Monitor(" plugin/ralph-hero/skills/finish/SKILL.md` returns `1` — exactly one Monitor invocation in skill body.
- [x] `! grep -q "Poll every 30 seconds for up to 10 minutes" plugin/ralph-hero/skills/finish/SKILL.md` — old polling language removed.
- [x] `grep -q "CI PASSED:" plugin/ralph-hero/skills/finish/SKILL.md && grep -q "CI FAILED:" plugin/ralph-hero/skills/finish/SKILL.md && grep -q "CI SKIPPED:" plugin/ralph-hero/skills/finish/SKILL.md` — all three terminal verdicts present.
- [x] `grep -q "timeout_ms=600000\|timeout_ms: 600000\|timeout_ms = 600000" plugin/ralph-hero/skills/finish/SKILL.md` — 10-minute timeout configured.

#### Manual Verification:
- [x] Read the modified Step 6 end-to-end and confirm the Monitor script logic matches the research doc lines 71-91 with the documented refinements (empty-array `CI SKIPPED`, `printf` over `echo`, transient-failure guards).
- [x] Confirm Step 7's verdict-parsing prose is unambiguous about which Monitor line maps to which verdict.
- [x] Confirm the `FINISHED` report template at the top of Step 7 is byte-for-byte identical to the current version.
- [x] Manually trace the path: finish-agent → finish skill Step 6 → Monitor → Step 7 → `FINISHED` report. No tool that the agent needs is missing from its allowlist.

**Creates for next phase**: N/A (single-phase plan).

---

## Integration Testing

- [ ] In a sandbox, run `claude` with the finish skill loaded and verify the Monitor invocation parses (the runtime should not reject the tool call as malformed).
- [ ] Mock-test the script offline by exporting a fake `MERGE_SHA` (e.g., the SHA of a recent commit on `main`) and running the embedded Bash script directly: `bash -c 'MERGE_SHA=<sha>; <embedded script>'`. Confirm it emits a state-transition line and exits with `CI PASSED:` or `CI SKIPPED:`.
- [ ] Run a real finish flow on a small PR in the `ralph-hero` repo (e.g., a typo fix). Verify: (a) Step 6 logs only state-transition notifications, not every-30s identical lines; (b) Step 7's `FINISHED` report shows the correct verdict; (c) the finish-agent allowlist permits the Monitor call without runtime denial.

## References

- Research: https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-04-12-monitor-tool-codebase-compositions.md
- Issue: https://github.com/cdubiel08/ralph-hero/issues/760
- Related (deferred): dev server polling in `ralph-research/SKILL.md` and `research/SKILL.md` — research doc Composition 2.
- Related historical research:
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-01-GH-0466-idle-notification-spam.md
  - https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/research/2026-03-25-GH-0224-ci-feedback-loop-post-push.md
