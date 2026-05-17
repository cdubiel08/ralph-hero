---
date: 2026-05-16
status: draft
iteration: 2
type: plan
github_issue: 1275
github_issues: [1275]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1275
primary_issue: 1275
parent_plan: thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md
tags: [ios-remote, cos, ntfy, gdrive-push, director, integration]
---

# Feature H: iOS Remote-Control Integration — Atomic Implementation Plan

## Iteration Notes

**Iteration 2 (2026-05-16)** — Addresses four FAIL-rated findings from `thoughts/shared/reviews/2026-05-16-GH-1275-critique.md`:

- **Issue 1 (HIGH) — `RALPH_IOS_MODE=1` cross-plan-contract gap**: Verified that the merged Director skill (`plugin/ralph-hero/skills/director/SKILL.md`) and its `event-classes.md` do NOT set `RALPH_IOS_MODE`. Picked critique option B: drop the env-var dependency entirely. The `--push-drive` default is now keyed off Director's own dispatch path — Director writes a sentinel file `${TMPDIR:-/tmp}/ralph-ios-mode` when consuming a `trigger:*` label or a `RemoteTrigger` tool input, and producers test for that file. This Feature H ships the sentinel-writing code (one-line addition to Director's Step 5 + a small docs edit to `event-classes.md`), eliminating any forward dependency on Feature B in-flight work. The flag-and-env-var fallback (`--push-drive` / `--no-push-drive` CLI flag, and the legacy `RALPH_IOS_MODE` env var still respected as a manual operator opt-in) remain.
- **Issue 2 (HIGH) — `team:<team>` labels fabricated**: Verified via grep across `plugin/ralph-hero/skills/` and all sibling plans — `team:watch`/`team:scout`/`team:caretake` etc. exist nowhere. Phase 1 now uses the actual label families Director recognizes: `watcher-auto` for Watchers, `scout-auto` for Scouts, `process-improvement` for Caretakers. Builders are detected via workflow-state membership (`In Progress` / `In Review` etc.) — no team-attribution label exists for builders today, but the workflow_state taxonomy in `event-classes.md` is the authoritative mapping. Memorykeepers has no producer yet; cos rollup shows a "not yet shipping" placeholder per critique option B's guidance.
- **Issue 3 (MEDIUM) — `list_issues` signature**: Verified at `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:104` that the parameter is `label: string` (singular). Task 1.1 acceptance updated to issue one call per team via `{ label: "<label>" }` with the correct singular parameter name. For builders, `workflowState` filter is used instead of a label.
- **Issue 4 (MEDIUM) — Task 3.4 scout-producer path**: Read `thoughts/shared/plans/2026-05-16-GH-1273-scout-scheduling.md`. The concrete producer is `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (GH-1273 Task 4.1). The nightly script invokes `/ralph-playwright:test-e2e --label scout-auto`. Task 3.4 now points at this exact path. If GH-1273 has not yet merged at impl time, the task includes a forward-compat fallback (apply the `--push-drive` flag to whichever shape lands).

Issues 5 and 6 from the critique are LOW-severity polish that the iterator also addressed pre-emptively (decision-logic reorder in Task 3.1; clarification of caller responsibilities).

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]]
- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]]
- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]]

## Overview

Single GH-1275 issue (estimate S) implemented as five phases in one PR. This feature is the iOS-cockpit polish on top of the unified agent system. It depends on Director (GH-1269, MERGED), Watcher (GH-1270), Scouts (GH-1273), and Caretakers (GH-1274) existing — Feature B is shipped; the others are stubbed-or-real on disk before this plan starts. Feature H's job is to write the iOS-mode sentinel inside Director's dispatch path, roll up all five teams in `cos`, wire ntfy push on team-session completion, integrate `gdrive-push` on PR/postmortem/scout-report producers, and ship the user-facing IOS-REMOTE.md doc.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 0 | GH-1275 | Director iOS-mode sentinel write | (phase of S) |
| 1 | GH-1275 | cos five-team rollup | (phase of S) |
| 2 | GH-1275 | ntfy completion hooks on team sessions | (phase of S) |
| 3 | GH-1275 | gdrive-push --push-drive wiring on producers | (phase of S) |
| 4 | GH-1275 | IOS-REMOTE.md user doc | (phase of S) |

**Why phased as one PR**: All five phases share the same user-facing surface (the iOS workflow). They are individually atomic but lose meaning in isolation — the doc references rollups, ntfy, and Drive links that don't exist until phases 0–3 land. Shipping as one PR keeps the documentation accurate at merge time.

## Shared Constraints

Inherited verbatim from `thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md`:

1. **No new runtime layers.** GitHub Projects V2 stays the only event bus; ralph-knowledge SQLite stays the only durable memory store. No new daemons, brokers, or databases. ntfy is the existing phone-push channel (see Phase 3 cos plan); `gdrive-push` is the existing artifact-pushing skill. This feature *consumes* both — it does not introduce new infrastructure.
2. **Skill / agent surface conventions.** New orchestrator code lives under `plugin/ralph-hero/skills/<skill-name>/`. The `cos` extension stays under `plugin/ralph-hero/skills/cos/`. The IOS-REMOTE.md user doc lives at `plugin/ralph-hero/skills/director/IOS-REMOTE.md` (Director skill dir, per the epic's directive).
3. **SOUL files use a fixed schema.** Not directly relevant to this feature (no new SOUL added; Director's SOUL.md from Feature B is the only SOUL touched, and only via the new IOS-REMOTE.md doc that lives alongside it).
4. **Style inheritance.** `plugin/ralph-hero/skills/STYLE.md` applies; IOS-REMOTE.md follows user-facing README conventions (terse, copy-pasteable steps), not the internal SKILL.md technical-spec voice.
5. **iOS-friendly artifacts.** This feature is the iOS-friendly-artifact enforcement layer. `cos` output must read well on a phone (already true; verified by Phase 5 cos plan). PRs / postmortems / scout reports must accept `--push-drive` so iOS users open Drive links without VPN. ntfy is the canonical "session done" channel.
6. **Remote-trigger contract.** Director (Feature B) owns the trigger-label dispatch path. This feature does not modify that path — it just adds the ntfy-on-completion side of the round trip so iOS sees "Director dispatched X, X finished, here's the link."
7. **Outcome recording is automatic.** Terminal handlers already call `knowledge_record_outcome` per Feature E. This feature does not change outcome-recording — ntfy push fires *after* outcome-recording in the terminal-handler exit path.
8. **Verification tooling.** `npm run lint`, `npm run typecheck`, `npm test` from `plugin/ralph-hero/mcp-server/` for any TypeScript touched (this feature touches no MCP server source — all changes are shell scripts + markdown). For shell: `bash -n <script>` for syntax, `shellcheck` if available, smoke patterns per `plugin/ralph-hero/scripts/cos/smoke.sh`.
9. **Atomicity.** Estimate S issue; four phases of XS-equivalent scope each. No phase touches >3 files.
10. **No OpenClaw runtime.** Repeated for emphasis.

Feature-H-specific constraints:

- **`--push-drive` defaults are direction-sensitive.** Default OFF for direct CLI invocations from a desk session (no Drive surprises). Default ON when invoked through Director's iOS-trigger path. The signal is a **sentinel file** at `${TMPDIR:-/tmp}/ralph-ios-mode` — Director writes the sentinel (touch-only, ignored content) immediately before its `Skill()` dispatch when the dispatch source is a `trigger:*` label or a `RemoteTrigger` tool input (Director's `DISPATCH_REASON` field already captures this; see `event-classes.md`). The sentinel survives across the dispatched skill's lifetime and is cleaned up at session end. Producers check `[[ -f "${TMPDIR:-/tmp}/ralph-ios-mode" ]]` to decide the default. The `--push-drive` / `--no-push-drive` CLI flag always overrides the sentinel. **Legacy fallback:** the env var `RALPH_IOS_MODE=1` is still respected as a manual operator opt-in (e.g., for desk-mode forced pushes during testing) — if either the sentinel OR `RALPH_IOS_MODE=1` is set, default is ON.
- **ntfy topic is private to the operator.** Reuse the existing `RALPH_COS_NTFY_TOPIC` env var from cos Phase 3 (`thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md`). No new topic env var. The completion hook reads this env var at exit time; if unset, push skips with a stderr warning. No new ntfy infrastructure.
- **Graceful degradation everywhere.** If `gws` (Google Workspace CLI) is unauthenticated, `gdrive-push` already errors out cleanly — producers must treat a non-zero `gdrive-push` exit as a warning, not a fatal error (the underlying artifact still landed). Same for ntfy: missing `ntfy` binary or unset topic → warn-and-continue.
- **The cos five-team rollup is read-only.** No new MCP write tools added to the cos allowlist (per the cos Phase 1 PREFLIGHT.md rule). The rollup composes existing `list_issues` / `pipeline_dashboard` / `get_issue` calls filtered by team labels.
- **Reuse the ntfy patterns from cos Phase 3.** Specifically: the topic env var name (`RALPH_COS_NTFY_TOPIC`), the graceful-degradation pattern (missing `ntfy` binary → warn-and-continue), and the single-line message convention (`ntfy publish "$TOPIC" "$SUMMARY ($URL)"`). Reuse, do not re-invent.

## Sibling Context (inherited from invocation)

- **Feature B Director (GH-1269) — MERGED**: Ships `plugin/ralph-hero/skills/director/SKILL.md`, `plugin/ralph-hero/skills/director/event-classes.md`, the `RemoteTrigger` + `trigger:<team>` label dispatch contract. **Verified**: Director sets no `RALPH_IOS_MODE` env var. The dispatch path's reliable signal is the `DISPATCH_REASON` string (`trigger:<label>` for label-driven dispatch, `RemoteTrigger` for tool-input dispatch, `workflow_state:*` for fallback). This Feature H ships a tiny one-line addition to Director's Step 5 to write a sentinel file `${TMPDIR:-/tmp}/ralph-ios-mode` whenever `DISPATCH_REASON` starts with `trigger:` or equals `RemoteTrigger` — Phase 0 below. Producers consume the sentinel.
- **Feature C Watcher (GH-1270) — PLANNED**: Produces `plugin/ralph-hero/skills/watch/SKILL.md`, `plugin/ralph-hero/skills/watch/SOUL.md`, `log-reader` + `sre-fixit` subagents, `/schedule` heartbeat. Watcher issues carry the `watcher-auto` label (per `event-classes.md`'s Priority 2 row). The cos five-team rollup queries by `label: "watcher-auto"` for the Watchers section.
- **Feature F Scouts (GH-1273) — PLANNED**: Produces `plugin/ralph-hero/skills/scouts/SOUL.md`, `pr-agent /scout` trigger comment, `merge-agent` gate, nightly `/schedule` routine creating `scout-auto` issues. The nightly sweep script (`plugin/ralph-hero/scripts/schedule/scout-nightly.sh`) is the scout-report producer; it shells out to `/ralph-playwright:test-e2e --label scout-auto`. Phase 3 of this plan wires `gdrive-push` into that script.
- **Feature G Caretakers (GH-1274) — PLANNED**: Produces `plugin/ralph-hero/skills/caretake/SKILL.md`, `plugin/ralph-hero/skills/caretake/SOUL.md`, hourly hygiene / daily report / weekly trends schedules. Caretaker-produced issues carry the `process-improvement` label (per `event-classes.md`'s Priority 2 row). The cos five-team rollup queries by `label: "process-improvement"` for the Caretakers section.

**Interface contract for this feature**:
- `cos` extension: roll up state from all five teams (builders, watchers, scouts, memorykeepers, caretakers), not just builders. Team attribution uses the **actual** label families Director recognizes (per `event-classes.md`): `watcher-auto`, `scout-auto`, `process-improvement`. Builders have no automation label — the cos prompt queries by workflow_state instead (any of `Research Needed`, `Research in Progress`, `Ready for Plan`, `Plan in Progress`, `Plan in Review`, `In Progress`, `In Review`). Memorykeepers has no producer yet — the section renders a "not yet shipping (Feature B taxonomy reserved)" placeholder.
- ntfy hooks: fire on team-session completion (terminal handlers' last step) following the `2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md` pattern. Single source of completion-push convention.
- `gdrive-push --push-drive` wired into `ralph-pr` (PR artifact = the plan + diff summary), `ralph-postmortem` (postmortem .md), and the scout-nightly producer (`scripts/schedule/scout-nightly.sh`). Default ON when the sentinel `${TMPDIR:-/tmp}/ralph-ios-mode` exists OR `RALPH_IOS_MODE=1` is set; default OFF otherwise; CLI flag always wins.
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md` covers: (a) trigger via labels, (b) read `cos` summaries, (c) receive ntfy pushes, (d) open Drive artifacts.

## Current State Analysis

After Features A–G land (sibling waves), the following are on disk:

- **cos skill** (`plugin/ralph-hero/skills/cos/SKILL.md`) — currently covers builders only via a single section. The `system-prompt.md`, three handler scripts (`cos-desk.sh`, `cos-remote.sh`, `cos-unattended.sh`), and the morning-brief Phase 3 (`morning-brief.sh` + `prompts/morning-brief.md`) are in place. Verified via `ls plugin/ralph-hero/skills/cos/` and `ls plugin/ralph-hero/scripts/cos/`.
- **ntfy convention** — Phase 3 cos plan established: `RALPH_COS_NTFY_TOPIC` env var, `ntfy publish "$TOPIC" "$MSG"`, graceful degradation when `ntfy` is not installed or topic is unset. The morning-brief script extracts a `SUMMARY:` prefixed line from the agent output as the push body. This is the canonical pattern; ntfy completion hooks in Phase 2 of this plan copy that shape.
- **gdrive-push skill** (`plugin/ralph-hero/skills/gdrive-push/SKILL.md`) — accepts `<file-or-directory> [description]`, requires `gws auth` (Google Workspace CLI). Pushes flat with path-encoded names; maintains a manifest. Returns Drive URLs in its stdout that producers can parse and link in issue comments.
- **ralph-pr skill** (`plugin/ralph-hero/skills/ralph-pr/SKILL.md`) — terminal handler that pushes a branch, creates the PR via `gh`, and transitions the issue to "In Review". Currently has no Drive push step. Phase 3 of this plan adds the `--push-drive` flag and the gdrive-push call in the success exit path.
- **ralph-postmortem skill** (`plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`) — generates a structured postmortem from `TaskList` data, writes to disk, calls `knowledge_record_outcome`. Currently has no Drive push step. Phase 3 adds it after the postmortem .md is written.
- **scout report producer** — the nightly sweep registered by Feature F (GH-1273) creates a `scout-auto` issue per finding. The "scout report" artifact is either the issue body itself (small finding) or an attached report file (large finding). Feature F's plan defines which; Phase 3 of this plan wires `gdrive-push` into whichever shape Feature F lands. If the producer is a skill, add the flag to its frontmatter; if it's a script, add a `--push-drive` CLI arg.
- **Director skill** (`plugin/ralph-hero/skills/director/SKILL.md` from Feature B, MERGED) — dispatches teams; **does not set any env var** today. Phase 0 of this plan adds a one-line sentinel-file write (`touch "${TMPDIR:-/tmp}/ralph-ios-mode"`) to Director's Step 5 when `DISPATCH_REASON` starts with `trigger:` or equals `RemoteTrigger`. Phase 4 adds `IOS-REMOTE.md` next to Director's SKILL.md.
- **Label families actually used by Director** (verified at `plugin/ralph-hero/skills/director/event-classes.md`): Priority 1 trigger labels (`trigger:builders`, `trigger:watch`, `trigger:scouts`, `trigger:caretake`, `trigger:memorykeepers`) — manual overrides, consumed at dispatch edge; Priority 2 automation labels (`watcher-auto`, `scout-auto`, `process-improvement`) — applied by automated producers, NOT consumed by Director; Priority 3 fallback by workflow_state. **No `team:<name>` labels exist anywhere in the codebase or sibling plans.** The cos five-team rollup in Phase 1 keys off the Priority 2 automation labels for Watchers / Scouts / Caretakers, and off workflow_state for Builders. Memorykeepers has no producer; cos shows a placeholder.

### Key Discoveries

- **The morning-brief ntfy pattern is the right template.** It writes the artifact, extracts a one-line summary, calls `ntfy publish "$TOPIC" "$SUMMARY ($PATH)"`, and gracefully degrades. Phase 2 of this plan copies this shape into terminal handlers (`ralph-merge`, optionally `ralph-pr` and `ralph-postmortem`). Per Feature H acceptance criteria, picking `ralph-merge` is the smoke target — the others are optional follow-ups that ride on the same hook helper.
- **The `--push-drive` flag is the right contract.** Default OFF for desk invocations, default ON for iOS-mode (detected via the sentinel file `${TMPDIR:-/tmp}/ralph-ios-mode` written by Director in Phase 0; legacy `RALPH_IOS_MODE=1` env var also honored). The flag is parsed centrally in the `push-artifact.sh` helper (per Task 3.1); callers forward it unparsed. CLI flag always wins (rule 1 of Task 3.1's decision logic).
- **cos extension is purely additive.** The existing cos `system-prompt.md` already has section conventions; adding four new sections (Watch, Scouts, Memorykeepers, Caretakers) below the existing Builders section is mechanical. The `pipeline_dashboard` and `list_issues` MCP calls already filter by label — no new MCP tool needed.
- **IOS-REMOTE.md is user-facing.** Its tone differs from internal SKILL.md files: copy-pasteable commands, screenshots-or-equivalent prose, no internal jargon (no "skill", "hook", "MCP"; use "Claude Code automation", "trigger label", "Google Drive folder"). The cos README at `plugin/ralph-hero/scripts/cos/README.md` is a closer voice-match than any SKILL.md file in the repo.

## Desired End State

After this plan merges:

0. **Director sentinel write**: Director writes `${TMPDIR:-/tmp}/ralph-ios-mode` immediately before its `Skill()` dispatch when `DISPATCH_REASON` starts with `trigger:` or equals `RemoteTrigger`. One-line addition to Director's Step 5, documented in `event-classes.md`.
1. **`cos` extended**: Running `ralph cos remote` or `ralph cos desk` shows five clearly-labeled sections: Builders, Watchers, Scouts, Memorykeepers, Caretakers. Each section queries by its actual taxonomy entry (`watcher-auto` / `scout-auto` / `process-improvement` labels; workflow_state for Builders; placeholder for Memorykeepers). Phone-readable (no horizontal scroll, no >80-char lines).
2. **ntfy completion hooks**: `ralph-merge` (and any other terminal handler that opts in via the shared hook helper) fires an ntfy push on successful merge when the iOS-mode sentinel exists (or `RALPH_IOS_MODE=1` is set as a manual override). Push body: `"Merged: <PR title> (<PR URL>)"`. Gracefully degrades on missing ntfy / unset topic.
3. **`gdrive-push --push-drive` wired**: `ralph-pr`, `ralph-postmortem`, and `scripts/schedule/scout-nightly.sh` accept a `--push-drive` flag. Default ON when iOS-mode sentinel exists OR `RALPH_IOS_MODE=1` set, default OFF otherwise; CLI flag always overrides. On push, the Drive URL is appended to the issue comment that the producer was going to post anyway (no new comment header).
4. **`IOS-REMOTE.md` user doc**: Covers the four iOS workflows with copy-pasteable steps. Lives at `plugin/ralph-hero/skills/director/IOS-REMOTE.md`. Referenced from Director SKILL.md "See also" section and from `plugin/ralph-hero/skills/cos/README.md`.

### Verification

- [x] `grep -q 'ralph-ios-mode' plugin/ralph-hero/skills/director/SKILL.md` (Director writes the sentinel)
- [ ] `ralph cos remote` output contains the strings "Builders", "Watchers", "Scouts", "Memorykeepers", "Caretakers" as section headers
- [ ] On a merge with the sentinel file present + `RALPH_COS_NTFY_TOPIC` set + `ntfy` installed, an ntfy push fires within 30s of merge completion
- [ ] `ralph-pr --push-drive <issue>` results in a Drive link being posted in the PR's `## Implementation Complete` comment (works with or without the sentinel)
- [ ] `IOS-REMOTE.md` exists at `plugin/ralph-hero/skills/director/IOS-REMOTE.md` and contains four H2 sections matching the four workflows
- [ ] End-to-end smoke (manual): add `trigger:watch` label from iOS → Director writes sentinel + dispatches Watch → Watch finishes and pushes its report to Drive via the Phase 3 path → ntfy push lands on phone → tap link opens Drive

## What We're NOT Doing

- **No new ntfy infrastructure.** No new topic env var, no daemon, no retry logic. Reuse `RALPH_COS_NTFY_TOPIC` from cos Phase 3; reuse the single-shot `ntfy publish` pattern.
- **No new Drive folder convention.** `gdrive-push` already uses a `claude-shared` folder; producers reuse that. No per-team subfolders in this plan.
- **No iOS app changes.** This is all server-side wiring. The iOS Claude Code app + GitHub mobile app + Drive app on iOS are the cockpit.
- **No new cos modes.** The `desk` / `remote` / `unattended` modes from Phase 2 remain. The five-team rollup is content inside those modes, not a new mode.
- **No automatic retries on push failure.** If ntfy push fails or Drive push fails, the operation still succeeded (the merge happened, the artifact landed). Log a warning and move on.
- **No fan-out push to multiple devices.** ntfy topic is one topic; one phone subscribes. Multi-device is a Phase-2 concern, not this feature.
- **No "session done" markers beyond ntfy.** The harness already emits `result:` / `needs input:` markers per the epic plan §Shared Constraints rule 5; this plan does not add to that vocabulary.
- **No iOS-mode-on-by-default.** The iOS-mode sentinel file is written by Director only when its dispatch is triggered by a `trigger:*` label or `RemoteTrigger` tool input (this PR adds that write). Desk-mode invocations leave the sentinel absent, which means `--push-drive` defaults OFF — no surprise Drive uploads from desk sessions. The legacy `RALPH_IOS_MODE=1` env var remains a manual override for testing.
- **No editing of producer skill bodies beyond the new flag.** This plan does not refactor `ralph-pr`, `ralph-postmortem`, or the scout producer. It only adds the `--push-drive` flag-handling block and the gdrive-push call.
- **No tests for the IOS-REMOTE.md doc beyond "the file exists and has the four sections."** Markdown linting is out of scope.

## Implementation Approach

Phases in order; each is one PR-able unit, but all five ship in a single PR for documentation coherence. Phases 0, 1, and 4 are independent; Phases 2 and 3 share a `scripts/lib/` directory but their helpers (`push-on-completion.sh`, `push-artifact.sh`) are otherwise independent.

0. **Phase 0: Director sentinel write** — Add a one-line `touch` to Director's Step 5 to write `${TMPDIR:-/tmp}/ralph-ios-mode` when `DISPATCH_REASON` matches `trigger:*` or `RemoteTrigger`. Update `event-classes.md` to document the sentinel contract. Two file edits, both trivial.
1. **Phase 1: cos five-team rollup** — Extend `system-prompt.md` and the relevant cos handler scripts to surface all five teams using the **actual** label families Director recognizes (`watcher-auto`, `scout-auto`, `process-improvement`) plus workflow_state for Builders. Pure additive content + label-based MCP filter logic.
2. **Phase 2: ntfy completion hooks** — Author a small shared shell helper (`plugin/ralph-hero/scripts/lib/push-on-completion.sh`) and wire it into `ralph-merge`'s exit path. Pick `ralph-merge` as the smoke target per the issue body's acceptance criteria.
3. **Phase 3: gdrive-push --push-drive wiring** — Add `--push-drive` flag parsing and a gdrive-push call to `ralph-pr`, `ralph-postmortem`, and the scout report producer (`plugin/ralph-hero/scripts/schedule/scout-nightly.sh` from GH-1273). All three consume a shared helper `plugin/ralph-hero/scripts/lib/push-artifact.sh` for the gdrive-push invocation + Drive-URL extraction.
4. **Phase 4: IOS-REMOTE.md user doc** — Author the user-facing doc at `plugin/ralph-hero/skills/director/IOS-REMOTE.md`. Cross-reference from Director SKILL.md "See also" and from cos README.

Phases can land in any internal order; Phase 4 should be last so it can cite the exact behavior shipped in Phases 0–3. Phase 0 should land before Phase 2 / Phase 3 so the sentinel is testable.

---

## Phase 0: Director iOS-mode sentinel write

- **depends_on**: null

### Overview

Director (Feature B, MERGED) does not currently signal iOS-mode to downstream skills. This phase adds a one-line `touch` of `${TMPDIR:-/tmp}/ralph-ios-mode` to Director's Step 5 (just before `Skill()` dispatch) when `DISPATCH_REASON` starts with `trigger:` or equals `RemoteTrigger`. Phase 2 and Phase 3 producers read the sentinel to flip `--push-drive` and ntfy defaults.

### Tasks

#### Task 0.1: Add sentinel write to Director Step 5
- **files**: `plugin/ralph-hero/skills/director/SKILL.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Director's Step 4 (Dispatch) or Step 5 (Consume trigger label) prose adds: "Before the `Skill()` call (Step 4), if `DISPATCH_REASON` starts with `trigger:` OR equals `RemoteTrigger`, write the iOS-mode sentinel: `touch \"${TMPDIR:-/tmp}/ralph-ios-mode\"`. This signals downstream producers (Feature H) that the current dispatch is iOS-initiated."
  - [ ] The new instruction is a single bash line in the skill body; Director's allowlist already includes `Bash`, so no allowlist change
  - [ ] Workflow_state-driven dispatches (Priority 3) do NOT write the sentinel — only Priority 1 (`trigger:*`) and `RemoteTrigger` paths do
  - [ ] The bullet near the end of Step 5 also documents: "After successful dispatch, the sentinel may persist until session end; that is intentional — producers running inside the dispatched session see it. No explicit cleanup."

#### Task 0.2: Document the sentinel contract in event-classes.md
- **files**: `plugin/ralph-hero/skills/director/event-classes.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: [0.1]
- **acceptance**:
  - [ ] Append a new section after "Classification algorithm" titled `## iOS-mode sentinel (Feature H contract)`
  - [ ] Section explains: "Director writes the sentinel file `${TMPDIR:-/tmp}/ralph-ios-mode` immediately before `Skill()` dispatch when `DISPATCH_REASON` matches `trigger:*` or `RemoteTrigger`. Downstream producers (ralph-pr, ralph-postmortem, scout-nightly, ralph-merge) test for this file to decide whether `--push-drive` and ntfy completion hooks default ON. The legacy `RALPH_IOS_MODE=1` env var is also honored as a manual operator override."
  - [ ] Section is ≤15 lines and consistent in voice with the rest of `event-classes.md`

### Phase Success Criteria

#### Automated Verification:
- [x] `grep -q 'ralph-ios-mode' plugin/ralph-hero/skills/director/SKILL.md`
- [x] `grep -q 'ralph-ios-mode' plugin/ralph-hero/skills/director/event-classes.md`
- [x] `grep -q 'iOS-mode sentinel' plugin/ralph-hero/skills/director/event-classes.md`

#### Manual Verification:
- [ ] Run Director with `--issue NNN` on an issue carrying `trigger:builders`; verify the sentinel file appears at `${TMPDIR:-/tmp}/ralph-ios-mode`
- [ ] Run Director with `--issue NNN` on an issue with no trigger label (workflow_state path); verify the sentinel file is NOT created

**Creates for next phase**: A reliable iOS-mode signal that Phases 2 and 3 read.

---

## Phase 1: cos five-team rollup

- **depends_on**: null

### Overview

Extend the `cos` skill's system prompt + handler scripts to surface state from all five teams (Builders, Watchers, Scouts, Memorykeepers, Caretakers) — currently `cos` covers Builders only. Pure additive change: new sections in the prompt, label-based filtering on existing MCP read tools.

### Tasks

#### Task 1.1: Extend cos system prompt with five-team section conventions
- **files**: `plugin/ralph-hero/skills/cos/system-prompt.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Existing builders section preserved verbatim
  - [ ] Four new H2 sections appended in order: `## Watchers`, `## Scouts`, `## Memorykeepers`, `## Caretakers`
  - [ ] Each new section instructs the agent to call `ralph_hero__list_issues` with the **actual** Director-recognized taxonomy (`label` is **singular** per `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:104` — `label: z.string().optional()`):
    - Watchers: `ralph_hero__list_issues({ label: "watcher-auto", limit: 5 })` (per `event-classes.md` Priority 2)
    - Scouts: `ralph_hero__list_issues({ label: "scout-auto", limit: 5 })` (per `event-classes.md` Priority 2)
    - Caretakers: `ralph_hero__list_issues({ label: "process-improvement", limit: 5 })` (per `event-classes.md` Priority 2)
    - Memorykeepers: render the literal string "Memorykeepers: not yet shipping (no producer; reserved in event-classes.md)" — do NOT issue a list_issues call
  - [ ] The existing Builders section (already in `system-prompt.md`) is preserved verbatim — it uses workflow_state filtering (`In Progress`, `In Review`, etc.) rather than a label because Builders has no automation label in the Director taxonomy
  - [ ] Each non-placeholder section surfaces: (a) count of open issues matching the label, (b) titles of the top 3 by priority, (c) most recent status update from `recent_activity` (no team-label filter — `recent_activity` is a project-wide log)
  - [ ] Each section ends with a one-line WIP-status sentence (e.g., "Watchers WIP: 2 issues open with label `watcher-auto`.")
  - [ ] Overall prompt size remains under 4 KB (phone-readable output budget; existing prompt is ~2 KB)
  - [ ] No new MCP tool additions — composed from existing read-only allowlist

#### Task 1.2: Update cos README to document the five-team rollup
- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify), `plugin/ralph-hero/skills/cos/SKILL.md` (modify — update the "Modes" intro paragraph only, not the table)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] cos README has a new `## Five-team rollup` section explaining that cos output covers all five teams since Feature H landed
  - [ ] Documents that team attribution comes from the Director event-classes taxonomy (`watcher-auto` / `scout-auto` / `process-improvement` labels for Wave 2 teams; workflow_state for Builders; placeholder for Memorykeepers) — references `plugin/ralph-hero/skills/director/event-classes.md` as the canonical source
  - [ ] References `IOS-REMOTE.md` (Phase 4 deliverable, link will resolve after Phase 4 lands in the same PR)
  - [ ] `plugin/ralph-hero/skills/cos/SKILL.md` introduction paragraph updated from "project status" to "agent organization status across all five teams" (one-line edit)

#### Task 1.3: Smoke test the rollup output shape
- **files**: `plugin/ralph-hero/scripts/cos/smoke.sh` (modify — append one new assertion block), `plugin/ralph-hero/scripts/cos/cos-remote.sh` (read)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] New smoke assertion in `smoke.sh`: after running `cos.sh --role smol "Output a five-team status rollup."`, the captured stdout contains all five section headers (`Builders`, `Watchers`, `Scouts`, `Memorykeepers`, `Caretakers`). Use `grep -q` for each; exit 1 if any is missing.
  - [ ] Smoke is gated on `pi` + `mlx-openai-server` being available; if either is missing, the smoke block exits 0 with a warning (matches existing smoke.sh skip-when-no-pi pattern)
  - [ ] `bash -n plugin/ralph-hero/scripts/cos/smoke.sh` exits 0 (no syntax errors)

### Phase Success Criteria

#### Automated Verification:
- [x] `bash -n plugin/ralph-hero/scripts/cos/smoke.sh` — no syntax errors
- [x] `grep -q '## Watchers' plugin/ralph-hero/skills/cos/system-prompt.md`
- [x] `grep -q '## Scouts' plugin/ralph-hero/skills/cos/system-prompt.md`
- [x] `grep -q '## Memorykeepers' plugin/ralph-hero/skills/cos/system-prompt.md`
- [x] `grep -q '## Caretakers' plugin/ralph-hero/skills/cos/system-prompt.md`
- [x] `wc -c plugin/ralph-hero/skills/cos/system-prompt.md` returns < 4096

#### Manual Verification:
- [ ] On a machine with `pi` + `mlx-openai-server` running, `ralph cos remote` produces output with all five section headers, no horizontal scroll on a phone-width terminal (80 cols)

**Creates for next phase**: A documented mapping from cos sections to the Director event-classes taxonomy. Phase 3's scout-nightly producer continues to file its issues with the `scout-auto` label (per GH-1273), which the Scouts section of cos now reads.

---

## Phase 2: ntfy completion hooks

- **depends_on**: null

### Overview

Author a small shared helper (`push-on-completion.sh`) that wraps the cos-Phase-3 ntfy pattern, then wire it into `ralph-merge`'s success exit path. Picks `ralph-merge` as the smoke target per the issue body acceptance criteria. Other terminal handlers can opt in later by sourcing the same helper.

### Tasks

#### Task 2.1: Author shared ntfy completion helper
- **files**: `plugin/ralph-hero/scripts/lib/push-on-completion.sh` (create), `plugin/ralph-hero/scripts/cos/morning-brief.sh` (read for pattern reference only)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists, marked executable (`chmod +x`)
  - [ ] Has `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] Designed to be sourced OR exec'd; primary interface is one function `push_on_completion(message, url)` exposed when sourced, and a CLI form `push-on-completion.sh "message" "url"` when called directly
  - [ ] Reads `RALPH_COS_NTFY_TOPIC` env var; if unset, prints `[push-on-completion] ntfy push skipped — RALPH_COS_NTFY_TOPIC not set` to stderr and exits 0
  - [ ] If `command -v ntfy` is empty, prints `[push-on-completion] ntfy not installed — push skipped` to stderr and exits 0
  - [ ] Constructs the push body as `"$message ($url)"`, truncating to 117 chars + `...` if needed (matches morning-brief.sh convention)
  - [ ] Invokes `ntfy publish "$RALPH_COS_NTFY_TOPIC" "$body"` and captures exit code
  - [ ] Prints `[push-on-completion] ntfy push: ok` (or `failed: <exit-code>`) to stderr
  - [ ] Exits 0 even on ntfy push failure (best-effort; the underlying operation already succeeded)
  - [ ] When `RALPH_COS_DEBUG=1`, prints the resolved topic, body, and ntfy exit code to stderr

#### Task 2.2: Wire push-on-completion into ralph-merge exit path
- **files**: `plugin/ralph-hero/skills/ralph-merge/SKILL.md` (modify), `plugin/ralph-hero/scripts/lib/push-on-completion.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [2.1, 0.1]
- **acceptance**:
  - [ ] After ralph-merge's existing success path (issue transitioned to Done, worktree cleaned up), add a step that invokes `push-on-completion.sh` with message `"Merged: <PR title>"` and url `<PR URL>` when iOS-mode is active. The iOS-mode predicate is: `[[ -f "${TMPDIR:-/tmp}/ralph-ios-mode" ]] || [[ -n "${RALPH_IOS_MODE:-}" ]]` (sentinel from Phase 0 OR legacy env var override).
  - [ ] When neither the sentinel nor `RALPH_IOS_MODE` is set, the merge skill behavior is bit-identical to today (no ntfy call)
  - [ ] Failure of `push-on-completion.sh` does NOT fail the merge skill (best-effort; the merge already succeeded)
  - [ ] The new step is documented in ralph-merge's body with a one-line comment pointing at this plan's filename
  - [ ] `Bash` is already in ralph-merge's `allowed-tools`; no allowlist change needed

#### Task 2.3: Author smoke for push-on-completion helper
- **files**: `plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] Smoke script invokes `push-on-completion.sh "test message" "https://example.com"` with `RALPH_COS_NTFY_TOPIC` unset; asserts exit 0 and stderr contains "skipped"
  - [ ] Smoke invokes with `RALPH_COS_NTFY_TOPIC=fake-topic` and `PATH=/usr/bin:/bin` (forcing ntfy off PATH); asserts exit 0 and stderr contains "not installed"
  - [ ] `bash -n plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh` exits 0
  - [ ] Marked executable (`chmod +x`)
  - [ ] Header comment links back to this plan

### Phase Success Criteria

#### Automated Verification:
- [x] `bash -n plugin/ralph-hero/scripts/lib/push-on-completion.sh` — no syntax errors
- [x] `bash -n plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh` — no syntax errors
- [x] `bash plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh` exits 0 (smoke covers the graceful-degradation paths without needing a real ntfy topic)
- [x] `[ -x plugin/ralph-hero/scripts/lib/push-on-completion.sh ]` (executable bit set)
- [x] `grep -q push-on-completion.sh plugin/ralph-hero/skills/ralph-merge/SKILL.md` (helper is invoked)

#### Manual Verification:
- [ ] On a machine with `ntfy` installed, `RALPH_COS_NTFY_TOPIC` set, AND the iOS-mode sentinel present (`touch "${TMPDIR:-/tmp}/ralph-ios-mode"` — or rely on Director from Phase 0), complete a real ralph-merge run and confirm the push lands on the subscribed phone within 30s
- [ ] Run ralph-merge with neither the sentinel nor `RALPH_IOS_MODE` set; confirm no ntfy call is made (verify with `tail -f` on the ntfy server logs or absence of stderr `ntfy push: ok` line)

**Creates for next phase**: A shared `scripts/lib/` directory pattern that Phase 3's `push-artifact.sh` helper follows.

---

## Phase 3: gdrive-push --push-drive wiring on producers

- **depends_on**: [phase-0, phase-2]

### Overview

Add `--push-drive` flag handling and a gdrive-push invocation to `ralph-pr`, `ralph-postmortem`, and the scout-nightly producer (`plugin/ralph-hero/scripts/schedule/scout-nightly.sh` from GH-1273). All three share a thin helper (`push-artifact.sh`) that wraps the gdrive-push skill invocation and extracts the resulting Drive URL for posting to the issue. Default ON when iOS-mode is active (sentinel from Phase 0 OR legacy `RALPH_IOS_MODE=1` env var); default OFF otherwise; CLI flag always wins.

`depends_on` includes phase-0 (sentinel must exist before the producers can read it) and phase-2 (both phases author files under `plugin/ralph-hero/scripts/lib/` — sequencing avoids merge conflicts). Functionally, Phase 3 does not consume Phase 2's helper but does consume Phase 0's sentinel contract.

### Tasks

#### Task 3.1: Author shared push-artifact helper
- **files**: `plugin/ralph-hero/scripts/lib/push-artifact.sh` (create), `plugin/ralph-hero/skills/gdrive-push/SKILL.md` (read for invocation pattern reference only)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists, marked executable
  - [ ] Has `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] CLI signature: `push-artifact.sh <path> [description] [--push-drive | --no-push-drive]`
  - [ ] The helper parses `--push-drive` / `--no-push-drive` from its own `$@` (centralized parsing — callers do not pre-strip flags; addresses critique Issue 6)
  - [ ] Returns the Drive URL on stdout (one line) when successful; returns empty stdout on failure or skip
  - [ ] Decision logic for whether to push (evaluated in this exact order — explicit overrides win first; addresses critique Issue 5):
    1. If `--no-push-drive` was passed: SKIP (explicit operator opt-out always wins)
    2. Else if `--push-drive` was passed: PUSH (explicit operator opt-in always wins)
    3. Else if `[[ -f "${TMPDIR:-/tmp}/ralph-ios-mode" ]]`: PUSH (Phase 0 sentinel; iOS-mode default ON)
    4. Else if `[[ -n "${RALPH_IOS_MODE:-}" ]]`: PUSH (legacy env var manual override)
    5. Else: SKIP (desk-mode default OFF)
  - [ ] On PUSH: invokes the gdrive-push skill by running `claude -p '/gdrive-push <path> "<description>"' 2>&1` and parses stdout for the Drive URL (gdrive-push emits URLs like `https://drive.google.com/file/d/...`)
  - [ ] If `gws` is not authenticated (gdrive-push exits non-zero), prints `[push-artifact] gdrive-push failed — artifact still landed locally at <path>` to stderr and exits 0 with empty stdout
  - [ ] If the operator did not opt in (SKIP path), prints nothing to stderr (no warning needed for the expected default-OFF case) and exits 0 with empty stdout
  - [ ] When `RALPH_COS_DEBUG=1`, prints the resolved decision (PUSH / SKIP) and the matched rule number (1–5) to stderr

#### Task 3.2: Wire push-artifact into ralph-pr
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify), `plugin/ralph-hero/scripts/lib/push-artifact.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] `ralph-pr` accepts a new `--push-drive` / `--no-push-drive` flag in its argument-hint and forwards it (unparsed) to `push-artifact.sh` — ralph-pr does NOT parse the flag itself; the helper does (per Task 3.1's centralized parsing)
  - [ ] After the PR is created and the `## Implementation Complete` comment body is composed, the skill writes the comment body to a temp .md file under `/tmp/ralph-pr-NNN-body.md`
  - [ ] Calls `push-artifact.sh /tmp/ralph-pr-NNN-body.md "PR for GH-NNN" <forwarded-flag-if-present>` — bash word-splitting is fine since the helper handles missing/present flags uniformly
  - [ ] If the helper returns a non-empty Drive URL on stdout, appends a `Drive: <URL>` line to the `## Implementation Complete` comment body BEFORE posting the comment via `create_comment`
  - [ ] If the helper returns empty stdout (skip or failure), the comment is posted unchanged — bit-identical to today's behavior
  - [ ] No new MCP tool added to ralph-pr's allowlist (Bash is already there for shell-outs)
  - [ ] The argument-hint string is updated to: `<issue-number> [--worktree path] [--push-drive | --no-push-drive]`

#### Task 3.3: Wire push-artifact into ralph-postmortem
- **files**: `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md` (modify), `plugin/ralph-hero/scripts/lib/push-artifact.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] After ralph-postmortem writes its report to disk (existing behavior), invoke `push-artifact.sh <report-path> "Postmortem: <session-summary>"`
  - [ ] If the helper returns a non-empty Drive URL, include the URL in the `## Postmortem` comment body that ralph-postmortem already posts on blocker issues (per its existing flow), as a `Drive: <URL>` line
  - [ ] If helper returns empty, comment is posted unchanged
  - [ ] No new MCP tool / shell allowlist change (Bash already in `allowed-tools`)
  - [ ] Argument-hint (if present) updated to surface `--push-drive` / `--no-push-drive`. If ralph-postmortem has no CLI args today (it is invoked inline by team), the iOS-mode sentinel from Phase 0 (or the legacy `RALPH_IOS_MODE=1` env var) is the only opt-in path — document that in the skill body

#### Task 3.4: Wire push-artifact into the scout-nightly producer
- **files**: `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (modify — created by GH-1273 Task 4.1)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] **Concrete producer path verified from `thoughts/shared/plans/2026-05-16-GH-1273-scout-scheduling.md` Task 4.1**: the scout-nightly producer is `plugin/ralph-hero/scripts/schedule/scout-nightly.sh`. It invokes `/ralph-playwright:test-e2e --label scout-auto` against the latest deployed build URL; findings are filed as GitHub issues with the `scout-auto` label.
  - [ ] **Forward-compat fallback**: If `scout-nightly.sh` is not yet on disk at this PR's impl time (GH-1273 has not merged), this task is gated — the impl-agent should: (1) confirm the GH-1273 plan path is still as documented above, (2) author this task's changes as a follow-up commit instructions block in the PR description, (3) note in the PR body that the scout-nightly wire-up lands in a follow-up PR after GH-1273 merges. Do NOT create the file from scratch in this PR — GH-1273 owns it.
  - [ ] When `scout-nightly.sh` exists: add `--push-drive` / `--no-push-drive` flag parsing to its argument-handling block (forwarded directly to `push-artifact.sh` — same pattern as ralph-pr per Task 3.2)
  - [ ] After test-e2e exits and any `scout-auto` issues have been filed, invoke `push-artifact.sh <test-results-dir> "Scout report: $(date +%Y-%m-%d)"` once per nightly run (one helper call per run, not per issue)
  - [ ] If the helper returns a Drive URL, append a `Drive: <URL>` line to a `## Scout Nightly Summary` comment posted to the most-recently-filed `scout-auto` issue (or to a single tracker issue if GH-1273 introduces one — defer to GH-1273's existing comment convention)
  - [ ] Bit-identical behavior to today when neither `--push-drive` nor the iOS-mode sentinel/env-var is set

### Phase Success Criteria

#### Automated Verification:
- [x] `bash -n plugin/ralph-hero/scripts/lib/push-artifact.sh` — no syntax errors
- [x] `[ -x plugin/ralph-hero/scripts/lib/push-artifact.sh ]` (executable bit)
- [x] `grep -q push-artifact.sh plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- [x] `grep -q push-artifact.sh plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`
- [x] `grep -q '--push-drive' plugin/ralph-hero/skills/ralph-pr/SKILL.md` (flag documented in skill body)

#### Manual Verification:
- [ ] On a machine with `gws` authenticated and the iOS-mode sentinel present (`touch "${TMPDIR:-/tmp}/ralph-ios-mode"`), run ralph-pr against a test issue and verify the `## Implementation Complete` comment contains a `Drive:` line with a working Drive URL
- [ ] Remove the sentinel and unset `RALPH_IOS_MODE`; run ralph-pr without `--push-drive`; verify the comment has no `Drive:` line (regression check)
- [ ] Run ralph-pr with `--no-push-drive` AND the sentinel present (sentinel says PUSH, flag says SKIP); verify the CLI flag wins (no Drive line) — exercises rule 1 of Task 3.1's decision logic
- [ ] Run ralph-pr with `--push-drive` and no sentinel; verify Drive URL appears — exercises rule 2
- [ ] Repeat the smoke for ralph-postmortem on a fake blocker issue (or use a test run with `RALPH_DEBUG=1`)

**Creates for next phase**: A documented `--push-drive` / sentinel / `RALPH_IOS_MODE` precedence contract that Phase 4's IOS-REMOTE.md describes for the user.

---

## Phase 4: IOS-REMOTE.md user doc

- **depends_on**: [phase-0, phase-1, phase-2, phase-3]

### Overview

Author the user-facing iOS workflow doc at `plugin/ralph-hero/skills/director/IOS-REMOTE.md`. Cross-reference from Director SKILL.md and the cos README so users discover it organically.

### Tasks

#### Task 4.1: Author IOS-REMOTE.md
- **files**: `plugin/ralph-hero/skills/director/IOS-REMOTE.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] File exists at `plugin/ralph-hero/skills/director/IOS-REMOTE.md`
  - [ ] Voice matches `plugin/ralph-hero/scripts/cos/README.md` — terse, copy-pasteable, no internal jargon ("Claude Code automation" not "skill"; "trigger label" not "Director dispatch")
  - [ ] Has a one-paragraph intro explaining what the iOS workflow buys you (supervise the agent organization from your phone)
  - [ ] Four H2 sections in this order:
    - `## 1. Trigger a team from iOS` — explains adding `trigger:watch` / `trigger:scout` / `trigger:caretake` labels via the GitHub mobile app; what happens next; how to know it worked
    - `## 2. Read a status summary` — explains `ralph cos remote` from a Termius/SSH session on the phone; what each of the five sections means
    - `## 3. Receive completion pushes` — explains setting up ntfy on the phone (subscribe to topic), configuring `RALPH_COS_NTFY_TOPIC` on the Mac, what kinds of events push (merges, postmortems, scout reports); links to the cos Phase 3 plan for the underlying convention
    - `## 4. Open Drive artifacts` — explains the `claude-shared` Drive folder, how Drive links appear in issue comments when Director's iOS-mode sentinel is active (i.e., when the dispatch came from a `trigger:*` label or `RemoteTrigger`), how to open them on iOS, and how the operator can manually set `RALPH_IOS_MODE=1` for forced pushes during testing
  - [ ] Each section includes at least one copy-pasteable command or step
  - [ ] Includes a final `## Troubleshooting` section with at least three common issues: (a) no ntfy push fired, (b) Drive link missing from comment, (c) trigger label not consumed
  - [ ] Includes a `## See also` section linking to: Director SKILL.md, cos README, cos Phase 3 plan, this plan
  - [ ] Length target: 200–400 lines (one page in a phone browser)
  - [ ] No more than one screenshot reference (this is a text-first doc; screenshots can land later)

#### Task 4.2: Cross-reference IOS-REMOTE.md from Director and cos
- **files**: `plugin/ralph-hero/skills/director/SKILL.md` (modify — add "See also" section if not present), `plugin/ralph-hero/scripts/cos/README.md` (modify — append a link to IOS-REMOTE.md in the existing "Five-team rollup" section from Task 1.2)
- **tdd**: false
- **complexity**: low
- **depends_on**: [4.1, 1.2]
- **acceptance**:
  - [ ] Director SKILL.md has a `## See also` section (or equivalent existing anchor) that includes a relative link to `IOS-REMOTE.md`
  - [ ] cos README's "Five-team rollup" section ends with a link to `../skills/director/IOS-REMOTE.md`
  - [ ] Both links use relative paths so they resolve on GitHub and on disk

### Phase Success Criteria

#### Automated Verification:
- [x] `[ -f plugin/ralph-hero/skills/director/IOS-REMOTE.md ]`
- [ ] `grep -cE '^## ' plugin/ralph-hero/skills/director/IOS-REMOTE.md` returns at least 5 (four workflow sections + troubleshooting; "See also" makes 6)
- [x] `grep -q 'trigger:watch' plugin/ralph-hero/skills/director/IOS-REMOTE.md`
- [x] `grep -q 'RALPH_COS_NTFY_TOPIC' plugin/ralph-hero/skills/director/IOS-REMOTE.md`
- [x] `grep -q 'claude-shared' plugin/ralph-hero/skills/director/IOS-REMOTE.md`
- [x] `grep -q 'IOS-REMOTE' plugin/ralph-hero/skills/director/SKILL.md`
- [x] `grep -q 'IOS-REMOTE' plugin/ralph-hero/scripts/cos/README.md`
- [x] Word count: `wc -w plugin/ralph-hero/skills/director/IOS-REMOTE.md` returns between 500 and 2500

#### Manual Verification:
- [ ] Read IOS-REMOTE.md on an iPhone-width browser (or 375px viewport). All commands are copy-pasteable. No horizontal scroll on a phone.
- [ ] Walk through each of the four workflows on a real iPhone with the Mac running; each section gets the user to the documented end state without external reference

**Creates for next phase**: Nothing — this is the integration finale.

---

## Integration Testing

End-to-end smoke from the epic plan's "Integration tests" section (epic §Integration Strategy):

1. From the iOS GitHub app, add label `trigger:watch` to an arbitrary issue.
2. Wait for Director's next `/schedule` tick (or trigger manually via `ralph director` on the Mac for the smoke).
3. Confirm Director writes the iOS-mode sentinel (`${TMPDIR:-/tmp}/ralph-ios-mode`) and removes the `trigger:watch` label, then dispatches Watch.
4. Watch runs its mission, emits a `result:` line, calls `outcome-recorder`, and pushes its report to Drive via the `--push-drive` path landed in Phase 3 (Watch is one of the producers if/when Feature C/F decide to wire it; otherwise the smoke uses a `ralph-pr` or scout-nightly producer).
5. ntfy fires a push to the iOS device (Phase 2 hook reads the same sentinel).
6. iOS opens the Drive link from the push body or the issue comment.

Additional cross-phase checks:

- [ ] `ralph cos remote` after Watch finishes shows the Watchers section reflecting the completed run (count of issues carrying the `watcher-auto` label that Watch moved on the board)
- [ ] `IOS-REMOTE.md`'s Troubleshooting section's "no ntfy push fired" entry correctly diagnoses an unset `RALPH_COS_NTFY_TOPIC` (matches Phase 2 behavior)
- [ ] All three producers (ralph-pr, ralph-postmortem, scout-nightly) respect the `--no-push-drive` override when set, even with the iOS-mode sentinel present (CLI wins — rule 1 of Task 3.1's decision logic)
- [ ] No regression on desk-mode flows: running ralph-pr / ralph-postmortem with neither flag nor sentinel/env-var produces bit-identical comments to pre-feature behavior

## Performance Considerations

- **ntfy push latency**: ~200ms per push over WiFi. Single-shot, no retry. Negligible.
- **Drive push latency**: `gdrive-push` for a typical postmortem (<50 KB) takes ~2–4s including auth check. Acceptable for terminal-handler exit paths; the merge already happened, the user has the artifact locally.
- **cos rollup query cost**: Four new `list_issues` calls per cos invocation. Each cached for 30 min on the existing cos cache (`~/.ralph-hero/cos/cache/remote-status.json`). Cold-cache cos run goes from ~2 GitHub API calls to ~6; well within rate limit (5000/hr).
- **Helper script overhead**: `push-on-completion.sh` and `push-artifact.sh` are <100 LOC each, bash-only, no subshells beyond `command -v ntfy` and the `ntfy publish` / `claude -p` calls. Sourced helpers add <10ms.

## Migration Notes

Purely additive feature. No env var renames or removals.

New state:
- **iOS-mode sentinel file** at `${TMPDIR:-/tmp}/ralph-ios-mode` — written by Director's Step 5 (Phase 0) when dispatch source is `trigger:*` or `RemoteTrigger`. Cleaned up implicitly on `$TMPDIR` rotation. No persistent state on disk outside `/tmp`.

New (manual override) env vars:
- `RALPH_IOS_MODE` (manual operator override; honored by all Phase 2/3 producers as a fallback to the sentinel). Not set by any harness code in this PR — purely for desk-mode testing or scripted scenarios.

Reused env vars (no changes):
- `RALPH_COS_NTFY_TOPIC` (already documented in cos Phase 3 README; same role here — completion push body topic)
- `RALPH_COS_DEBUG` (already documented; this feature respects it in both new helpers)

No new persistent state directories. No new MCP tools. No new daemons. No changes to existing skill allowlists beyond what's described per task.

## References

- Issue: [GH-1275](https://github.com/cdubiel08/ralph-hero/issues/1275)
- Parent epic: [GH-1267](https://github.com/cdubiel08/ralph-hero/issues/1267)
- Plan-of-plans: `thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md` (Feature H section, lines 140–148)
- Critique addressed by iteration 2: `thoughts/shared/reviews/2026-05-16-GH-1275-critique.md`
- Sibling Feature B (Director): GH-1269 (MERGED) — provides `plugin/ralph-hero/skills/director/SKILL.md` + `event-classes.md`; this PR adds the iOS-mode sentinel write in Phase 0
- Sibling Feature C (Watcher): GH-1270 — produces issues with the `watcher-auto` label (per `event-classes.md` Priority 2); consumed by cos Watchers section
- Sibling Feature F (Scouts): GH-1273 — produces `plugin/ralph-hero/scripts/schedule/scout-nightly.sh` (concrete producer path for Phase 3 Task 3.4) and files issues with `scout-auto` label
- Sibling Feature G (Caretakers): GH-1274 — produces issues with the `process-improvement` label (per `event-classes.md` Priority 2); consumed by cos Caretakers section
- Prior plan: `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md` — canonical ntfy invocation pattern reused in Phase 2's `push-on-completion.sh` helper
- Existing skill: `plugin/ralph-hero/skills/cos/SKILL.md` and `plugin/ralph-hero/skills/cos/system-prompt.md`
- Existing skill: `plugin/ralph-hero/skills/gdrive-push/SKILL.md` — invoked by Phase 3's `push-artifact.sh` helper
- Existing skill: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`, `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`, `plugin/ralph-hero/skills/ralph-merge/SKILL.md` — producers modified in Phases 2 and 3
- MCP tool signature reference: `plugin/ralph-hero/mcp-server/src/tools/issue-tools.ts:104` — `list_issues` accepts `label: string` (singular), consumed by Phase 1 Task 1.1
