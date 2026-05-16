---
date: 2026-05-16
status: draft
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

## Prior Work

- builds_on:: [[2026-05-16-GH-1267-unified-agent-system-epic]]
- builds_on:: [[2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy]]
- builds_on:: [[2026-05-14-GH-1252-ralph-hero-cos-mode]]
- builds_on:: [[2026-05-15-GH-1253-cos-phase1-pi-foundation]]

## Overview

Single GH-1275 issue (estimate S) implemented as four phases in one PR. This feature is the iOS-cockpit polish on top of the unified agent system. It depends on Director (GH-1269), Watcher (GH-1270), Scouts (GH-1273), and Caretakers (GH-1274) existing — but those features' deliverables are stubbed-or-real on disk before this plan starts. Feature H's job is to roll up all five teams in `cos`, wire ntfy push on team-session completion, integrate `gdrive-push` on PR/postmortem/scout-report producers, and ship the user-facing IOS-REMOTE.md doc.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1275 | cos five-team rollup | (phase of S) |
| 2 | GH-1275 | ntfy completion hooks on team sessions | (phase of S) |
| 3 | GH-1275 | gdrive-push --push-drive wiring on producers | (phase of S) |
| 4 | GH-1275 | IOS-REMOTE.md user doc | (phase of S) |

**Why phased as one PR**: All four phases share the same user-facing surface (the iOS workflow). They are individually atomic but lose meaning in isolation — the doc references rollups, ntfy, and Drive links that don't exist until phases 1–3 land. Shipping as one PR keeps the documentation accurate at merge time.

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

- **`--push-drive` defaults are direction-sensitive.** Default OFF for direct CLI invocations from a desk session (no Drive surprises). Default ON when invoked through Director's iOS-trigger path. The signal is the `RALPH_IOS_MODE=1` env var, which Director's dispatcher sets when consuming a `trigger:<team>` label (per Feature B). Producers read this env var to decide the default; the `--push-drive` / `--no-push-drive` CLI flag always overrides the env var.
- **ntfy topic is private to the operator.** Reuse the existing `RALPH_COS_NTFY_TOPIC` env var from cos Phase 3 (`thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md`). No new topic env var. The completion hook reads this env var at exit time; if unset, push skips with a stderr warning. No new ntfy infrastructure.
- **Graceful degradation everywhere.** If `gws` (Google Workspace CLI) is unauthenticated, `gdrive-push` already errors out cleanly — producers must treat a non-zero `gdrive-push` exit as a warning, not a fatal error (the underlying artifact still landed). Same for ntfy: missing `ntfy` binary or unset topic → warn-and-continue.
- **The cos five-team rollup is read-only.** No new MCP write tools added to the cos allowlist (per the cos Phase 1 PREFLIGHT.md rule). The rollup composes existing `list_issues` / `pipeline_dashboard` / `get_issue` calls filtered by team labels.
- **Reuse the ntfy patterns from cos Phase 3.** Specifically: the topic env var name (`RALPH_COS_NTFY_TOPIC`), the graceful-degradation pattern (missing `ntfy` binary → warn-and-continue), and the single-line message convention (`ntfy publish "$TOPIC" "$SUMMARY ($URL)"`). Reuse, do not re-invent.

## Sibling Context (inherited from invocation)

- **Feature B Director (GH-1269) — PLANNED**: Produces `plugin/ralph-hero/skills/director/SKILL.md`, `plugin/ralph-hero/skills/director/event-classes.md`, the `RemoteTrigger` + `trigger:<team>` label dispatch contract. Director's dispatcher sets `RALPH_IOS_MODE=1` when consuming a trigger label — this feature consumes that env var to flip `--push-drive` defaults.
- **Feature C Watcher (GH-1270) — PLANNED**: Produces `plugin/ralph-hero/skills/watch/SKILL.md`, `plugin/ralph-hero/skills/watch/SOUL.md`, `log-reader` + `sre-fixit` subagents, `/schedule` heartbeat. The cos five-team rollup expects a `team:watch` label or workflow-state filter on Watcher-produced issues — verify the convention in the Watcher plan at implementation time and follow it.
- **Feature F Scouts (GH-1273) — PLANNED**: Produces `plugin/ralph-hero/skills/scouts/SOUL.md`, `pr-agent /scout` trigger comment, `merge-agent` gate, nightly `/schedule` routine creating `scout-auto` issues. The scout report producer (nightly sweep) is the third producer this feature wires for `gdrive-push`.
- **Feature G Caretakers (GH-1274) — PLANNED**: Produces `plugin/ralph-hero/skills/caretake/SKILL.md`, `plugin/ralph-hero/skills/caretake/SOUL.md`, hourly hygiene / daily report / weekly trends schedules. The cos five-team rollup includes a Caretakers section that reads from the caretake state surface (probably `team:caretake` label on caretake-touched issues).

**Interface contract for this feature**:
- `cos` extension: roll up state from all five teams (builders, watchers, scouts, memorykeepers, caretakers), not just builders. Team membership is determined by `team:<team>` label on issues OR by which orchestrator skill ran (recorded in the team-session log).
- ntfy hooks: fire on team-session completion (terminal handlers' last step) following the `2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md` pattern. Single source of completion-push convention.
- `gdrive-push --push-drive` wired into `ralph-pr` (PR artifact = the plan + diff summary), `ralph-postmortem` (postmortem .md), and the scout report producer (nightly sweep's `scout-auto` issue body or attached report). Default ON when `RALPH_IOS_MODE=1`; default OFF otherwise; CLI flag always wins.
- `plugin/ralph-hero/skills/director/IOS-REMOTE.md` covers: (a) trigger via labels, (b) read `cos` summaries, (c) receive ntfy pushes, (d) open Drive artifacts.

## Current State Analysis

After Features A–G land (sibling waves), the following are on disk:

- **cos skill** (`plugin/ralph-hero/skills/cos/SKILL.md`) — currently covers builders only via a single section. The `system-prompt.md`, three handler scripts (`cos-desk.sh`, `cos-remote.sh`, `cos-unattended.sh`), and the morning-brief Phase 3 (`morning-brief.sh` + `prompts/morning-brief.md`) are in place. Verified via `ls plugin/ralph-hero/skills/cos/` and `ls plugin/ralph-hero/scripts/cos/`.
- **ntfy convention** — Phase 3 cos plan established: `RALPH_COS_NTFY_TOPIC` env var, `ntfy publish "$TOPIC" "$MSG"`, graceful degradation when `ntfy` is not installed or topic is unset. The morning-brief script extracts a `SUMMARY:` prefixed line from the agent output as the push body. This is the canonical pattern; ntfy completion hooks in Phase 2 of this plan copy that shape.
- **gdrive-push skill** (`plugin/ralph-hero/skills/gdrive-push/SKILL.md`) — accepts `<file-or-directory> [description]`, requires `gws auth` (Google Workspace CLI). Pushes flat with path-encoded names; maintains a manifest. Returns Drive URLs in its stdout that producers can parse and link in issue comments.
- **ralph-pr skill** (`plugin/ralph-hero/skills/ralph-pr/SKILL.md`) — terminal handler that pushes a branch, creates the PR via `gh`, and transitions the issue to "In Review". Currently has no Drive push step. Phase 3 of this plan adds the `--push-drive` flag and the gdrive-push call in the success exit path.
- **ralph-postmortem skill** (`plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`) — generates a structured postmortem from `TaskList` data, writes to disk, calls `knowledge_record_outcome`. Currently has no Drive push step. Phase 3 adds it after the postmortem .md is written.
- **scout report producer** — the nightly sweep registered by Feature F (GH-1273) creates a `scout-auto` issue per finding. The "scout report" artifact is either the issue body itself (small finding) or an attached report file (large finding). Feature F's plan defines which; Phase 3 of this plan wires `gdrive-push` into whichever shape Feature F lands. If the producer is a skill, add the flag to its frontmatter; if it's a script, add a `--push-drive` CLI arg.
- **Director skill** (`plugin/ralph-hero/skills/director/SKILL.md` from Feature B) — dispatches teams; sets `RALPH_IOS_MODE=1` when consuming a `trigger:<team>` label. Phase 4 of this plan adds `IOS-REMOTE.md` next to it.
- **`team:<team>` label convention** — Features C, F, G are expected to apply `team:watch`, `team:scout`, `team:caretake` labels to issues their orchestrators touch (per the epic plan's "team-orchestrator contract" in §Integration Strategy). The cos five-team rollup in Phase 1 of this plan filters by these labels.

### Key Discoveries

- **The morning-brief ntfy pattern is the right template.** It writes the artifact, extracts a one-line summary, calls `ntfy publish "$TOPIC" "$SUMMARY ($PATH)"`, and gracefully degrades. Phase 2 of this plan copies this shape into terminal handlers (`ralph-merge`, optionally `ralph-pr` and `ralph-postmortem`). Per Feature H acceptance criteria, picking `ralph-merge` is the smoke target — the others are optional follow-ups that ride on the same hook helper.
- **The `--push-drive` flag is the right contract.** Default OFF for desk invocations, default ON for iOS-mode (detected via `RALPH_IOS_MODE=1` env var set by Director). The flag is parsed in each producer's args; the env var sets the default. CLI flag always wins.
- **cos extension is purely additive.** The existing cos `system-prompt.md` already has section conventions; adding four new sections (Watch, Scouts, Memorykeepers, Caretakers) below the existing Builders section is mechanical. The `pipeline_dashboard` and `list_issues` MCP calls already filter by label — no new MCP tool needed.
- **IOS-REMOTE.md is user-facing.** Its tone differs from internal SKILL.md files: copy-pasteable commands, screenshots-or-equivalent prose, no internal jargon (no "skill", "hook", "MCP"; use "Claude Code automation", "trigger label", "Google Drive folder"). The cos README at `plugin/ralph-hero/scripts/cos/README.md` is a closer voice-match than any SKILL.md file in the repo.

## Desired End State

After this plan merges:

1. **`cos` extended**: Running `ralph cos remote` or `ralph cos desk` shows five clearly-labeled sections: Builders, Watchers, Scouts, Memorykeepers, Caretakers. Each section lists active issues + WIP count for that team. Phone-readable (no horizontal scroll, no >80-char lines).
2. **ntfy completion hooks**: `ralph-merge` (and any other terminal handler that opts in via the shared hook helper) fires an ntfy push on successful merge when `RALPH_IOS_MODE=1` is set. Push body: `"Merged: <PR title> (<PR URL>)"`. Gracefully degrades on missing ntfy / unset topic.
3. **`gdrive-push --push-drive` wired**: `ralph-pr`, `ralph-postmortem`, and the scout report producer accept a `--push-drive` flag. Default ON when `RALPH_IOS_MODE=1`, default OFF otherwise; CLI flag always overrides. On push, the Drive URL is appended to the issue comment that the producer was going to post anyway (no new comment header).
4. **`IOS-REMOTE.md` user doc**: Covers the four iOS workflows with copy-pasteable steps. Lives at `plugin/ralph-hero/skills/director/IOS-REMOTE.md`. Referenced from Director SKILL.md "See also" section and from `plugin/ralph-hero/skills/cos/README.md`.

### Verification

- [ ] `ralph cos remote` output contains the strings "Builders", "Watchers", "Scouts", "Memorykeepers", "Caretakers" as section headers
- [ ] On a merge with `RALPH_IOS_MODE=1` set + `RALPH_COS_NTFY_TOPIC` set + `ntfy` installed, an ntfy push fires within 30s of merge completion
- [ ] `ralph-pr --push-drive <issue>` (or `RALPH_IOS_MODE=1 ralph-pr <issue>`) results in a Drive link being posted in the PR's `## Implementation Complete` comment
- [ ] `IOS-REMOTE.md` exists at `plugin/ralph-hero/skills/director/IOS-REMOTE.md` and contains four H2 sections matching the four workflows
- [ ] End-to-end smoke (manual): add `trigger:watch` label from iOS → Director dispatches Watch → Watch finishes and posts a Drive link → ntfy push lands on phone → tap link opens Drive

## What We're NOT Doing

- **No new ntfy infrastructure.** No new topic env var, no daemon, no retry logic. Reuse `RALPH_COS_NTFY_TOPIC` from cos Phase 3; reuse the single-shot `ntfy publish` pattern.
- **No new Drive folder convention.** `gdrive-push` already uses a `claude-shared` folder; producers reuse that. No per-team subfolders in this plan.
- **No iOS app changes.** This is all server-side wiring. The iOS Claude Code app + GitHub mobile app + Drive app on iOS are the cockpit.
- **No new cos modes.** The `desk` / `remote` / `unattended` modes from Phase 2 remain. The five-team rollup is content inside those modes, not a new mode.
- **No automatic retries on push failure.** If ntfy push fails or Drive push fails, the operation still succeeded (the merge happened, the artifact landed). Log a warning and move on.
- **No fan-out push to multiple devices.** ntfy topic is one topic; one phone subscribes. Multi-device is a Phase-2 concern, not this feature.
- **No "session done" markers beyond ntfy.** The harness already emits `result:` / `needs input:` markers per the epic plan §Shared Constraints rule 5; this plan does not add to that vocabulary.
- **No iOS-mode-on-by-default.** `RALPH_IOS_MODE=1` is set by Director when consuming a trigger label (per Feature B). All other invocation paths leave it unset, which means `--push-drive` defaults OFF — no surprise Drive uploads from desk sessions.
- **No editing of producer skill bodies beyond the new flag.** This plan does not refactor `ralph-pr`, `ralph-postmortem`, or the scout producer. It only adds the `--push-drive` flag-handling block and the gdrive-push call.
- **No tests for the IOS-REMOTE.md doc beyond "the file exists and has the four sections."** Markdown linting is out of scope.

## Implementation Approach

Phases in order; each is one PR-able unit, but all four ship in a single PR for documentation coherence. Phases 1 and 4 are independent; Phases 2 and 3 share a tiny shell helper (`push-on-completion.sh`) but are otherwise independent.

1. **Phase 1: cos five-team rollup** — Extend `system-prompt.md` and the relevant cos handler scripts to surface all five teams. Pure additive content + minor MCP filter logic.
2. **Phase 2: ntfy completion hooks** — Author a small shared shell helper (`plugin/ralph-hero/scripts/lib/push-on-completion.sh`) and wire it into `ralph-merge`'s exit path. Pick `ralph-merge` as the smoke target per the issue body's acceptance criteria.
3. **Phase 3: gdrive-push --push-drive wiring** — Add `--push-drive` flag parsing and a gdrive-push call to `ralph-pr`, `ralph-postmortem`, and the scout report producer. All three consume a shared helper `plugin/ralph-hero/scripts/lib/push-artifact.sh` for the gdrive-push invocation + Drive-URL extraction.
4. **Phase 4: IOS-REMOTE.md user doc** — Author the user-facing doc at `plugin/ralph-hero/skills/director/IOS-REMOTE.md`. Cross-reference from Director SKILL.md "See also" and from cos README.

Phases can land in any internal order; Phase 4 should be last so it can cite the exact behavior shipped in Phases 1–3.

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
  - [ ] Each new section instructs the agent to call `ralph_hero__list_issues({ labels: ["team:<team>"], limit: 5 })` and surface (a) count of open issues, (b) titles of the top 3 by priority, (c) most recent status update from `recent_activity` filtered to that team
  - [ ] Each section ends with a one-line WIP-status sentence (e.g., "Watchers WIP: 2 issues in progress, 1 needs input.")
  - [ ] Overall prompt size remains under 4 KB (phone-readable output budget; existing prompt is ~2 KB)
  - [ ] No new MCP tool additions — composed from existing read-only allowlist

#### Task 1.2: Update cos README to document the five-team rollup
- **files**: `plugin/ralph-hero/scripts/cos/README.md` (modify), `plugin/ralph-hero/skills/cos/SKILL.md` (modify — update the "Modes" intro paragraph only, not the table)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] cos README has a new `## Five-team rollup` section explaining that cos output covers all five teams since Feature H landed
  - [ ] Documents that team membership is determined by `team:<team>` labels (set by each team's orchestrator per the epic plan's team-orchestrator contract)
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
- [ ] `bash -n plugin/ralph-hero/scripts/cos/smoke.sh` — no syntax errors
- [ ] `grep -q '## Watchers' plugin/ralph-hero/skills/cos/system-prompt.md`
- [ ] `grep -q '## Scouts' plugin/ralph-hero/skills/cos/system-prompt.md`
- [ ] `grep -q '## Memorykeepers' plugin/ralph-hero/skills/cos/system-prompt.md`
- [ ] `grep -q '## Caretakers' plugin/ralph-hero/skills/cos/system-prompt.md`
- [ ] `wc -c plugin/ralph-hero/skills/cos/system-prompt.md` returns < 4096

#### Manual Verification:
- [ ] On a machine with `pi` + `mlx-openai-server` running, `ralph cos remote` produces output with all five section headers, no horizontal scroll on a phone-width terminal (80 cols)

**Creates for next phase**: A documented `team:<team>` label convention that Phase 3's scout-report producer relies on for cos visibility of scout-auto issues.

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
- **depends_on**: [2.1]
- **acceptance**:
  - [ ] After ralph-merge's existing success path (issue transitioned to Done, worktree cleaned up), add a step that invokes `push-on-completion.sh` with message `"Merged: <PR title>"` and url `<PR URL>` when `[[ -n "${RALPH_IOS_MODE:-}" ]]`
  - [ ] When `RALPH_IOS_MODE` is unset, the merge skill behavior is bit-identical to today (no ntfy call)
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
- [ ] `bash -n plugin/ralph-hero/scripts/lib/push-on-completion.sh` — no syntax errors
- [ ] `bash -n plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh` — no syntax errors
- [ ] `bash plugin/ralph-hero/scripts/lib/smoke-push-on-completion.sh` exits 0 (smoke covers the graceful-degradation paths without needing a real ntfy topic)
- [ ] `[ -x plugin/ralph-hero/scripts/lib/push-on-completion.sh ]` (executable bit set)
- [ ] `grep -q push-on-completion.sh plugin/ralph-hero/skills/ralph-merge/SKILL.md` (helper is invoked)

#### Manual Verification:
- [ ] On a machine with `ntfy` installed and `RALPH_COS_NTFY_TOPIC` + `RALPH_IOS_MODE=1` set, complete a real ralph-merge run and confirm the push lands on the subscribed phone within 30s
- [ ] Run ralph-merge without `RALPH_IOS_MODE` set; confirm no ntfy call is made (verify with `tail -f` on the ntfy server logs or absence of stderr `ntfy push: ok` line)

**Creates for next phase**: A shared `scripts/lib/` directory pattern that Phase 3's `push-artifact.sh` helper follows.

---

## Phase 3: gdrive-push --push-drive wiring on producers

- **depends_on**: [phase-2]

### Overview

Add `--push-drive` flag handling and a gdrive-push invocation to `ralph-pr`, `ralph-postmortem`, and the scout report producer. All three share a thin helper (`push-artifact.sh`) that wraps the gdrive-push skill invocation and extracts the resulting Drive URL for posting to the issue. Default ON when `RALPH_IOS_MODE=1`; default OFF otherwise; CLI flag always wins.

`depends_on` is set to phase-2 only because both phases author files under `plugin/ralph-hero/scripts/lib/` — sequencing them avoids merge conflicts in the lib directory's README/index if one exists. Functionally, Phase 3 does not consume Phase 2's helper.

### Tasks

#### Task 3.1: Author shared push-artifact helper
- **files**: `plugin/ralph-hero/scripts/lib/push-artifact.sh` (create), `plugin/ralph-hero/skills/gdrive-push/SKILL.md` (read for invocation pattern reference only)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] File exists, marked executable
  - [ ] Has `#!/usr/bin/env bash` shebang and `set -euo pipefail`
  - [ ] CLI signature: `push-artifact.sh <path> [description]`
  - [ ] Returns the Drive URL on stdout (one line) when successful; returns empty stdout on failure or skip
  - [ ] Decision logic for whether to push:
    - If `--push-drive` flag was passed by the caller (caller is responsible for stripping the flag from args before calling this helper): push
    - Else if `[[ -n "${RALPH_IOS_MODE:-}" ]]`: push (iOS-mode default ON)
    - Else if `--no-push-drive` flag was passed: skip (caller is responsible for stripping)
    - Else: skip (desk-mode default OFF)
  - [ ] On push: invokes the gdrive-push skill by running `claude -p '/gdrive-push <path> "<description>"' 2>&1` and parses stdout for the Drive URL (gdrive-push emits URLs like `https://drive.google.com/file/d/...`)
  - [ ] If `gws` is not authenticated (gdrive-push exits non-zero), prints `[push-artifact] gdrive-push failed — artifact still landed locally at <path>` to stderr and exits 0 with empty stdout
  - [ ] If the operator did not opt in (skip path), prints nothing to stderr (no warning needed for the expected default-OFF case) and exits 0 with empty stdout
  - [ ] When `RALPH_COS_DEBUG=1`, prints the resolved decision (PUSH / SKIP) and reason to stderr

#### Task 3.2: Wire push-artifact into ralph-pr
- **files**: `plugin/ralph-hero/skills/ralph-pr/SKILL.md` (modify), `plugin/ralph-hero/scripts/lib/push-artifact.sh` (read)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] `ralph-pr` accepts a new `--push-drive` / `--no-push-drive` flag in its argument-hint and parses it from `ARGUMENTS`
  - [ ] After the PR is created and the `## Implementation Complete` comment body is composed, the skill writes the comment body to a temp .md file under `/tmp/ralph-pr-NNN-body.md`
  - [ ] Calls `push-artifact.sh /tmp/ralph-pr-NNN-body.md "PR for GH-NNN"` (with the `--push-drive` flag forwarded as appropriate)
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
  - [ ] Argument-hint (if present) updated to surface `--push-drive` / `--no-push-drive`. If ralph-postmortem has no CLI args today (it is invoked inline by team), the env var `RALPH_IOS_MODE=1` is the only opt-in path — document that in the skill body

#### Task 3.4: Wire push-artifact into the scout report producer
- **files**: TBD at implementation time — read Feature F plan first to identify the producer file. Likely `plugin/ralph-hero/skills/scouts/SKILL.md` or `plugin/ralph-hero/scripts/scouts/nightly-sweep.sh` (read Feature F plan when present)
- **tdd**: false
- **complexity**: medium
- **depends_on**: [3.1]
- **acceptance**:
  - [ ] Locate the scout report producer by reading the Feature F (GH-1273) plan document at `thoughts/shared/plans/*GH-1273*.md`. If the file is not yet on disk at implementation time, STOP and escalate — Phase 3 cannot proceed without knowing the producer interface.
  - [ ] Add `--push-drive` / `--no-push-drive` flag parsing to the producer
  - [ ] After the scout report is written (issue body or attached file — whichever shape Feature F lands), invoke `push-artifact.sh <report-path> "Scout report: <date>"`
  - [ ] If the helper returns a Drive URL, include it in the scout-auto issue body or comment that the producer posts (matching the producer's existing comment convention)
  - [ ] Bit-identical behavior to today when neither `--push-drive` nor `RALPH_IOS_MODE=1` is set

### Phase Success Criteria

#### Automated Verification:
- [ ] `bash -n plugin/ralph-hero/scripts/lib/push-artifact.sh` — no syntax errors
- [ ] `[ -x plugin/ralph-hero/scripts/lib/push-artifact.sh ]` (executable bit)
- [ ] `grep -q push-artifact.sh plugin/ralph-hero/skills/ralph-pr/SKILL.md`
- [ ] `grep -q push-artifact.sh plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`
- [ ] `grep -q '\-\-push-drive' plugin/ralph-hero/skills/ralph-pr/SKILL.md` (flag documented in skill body)

#### Manual Verification:
- [ ] On a machine with `gws` authenticated, `RALPH_IOS_MODE=1` set, run ralph-pr against a test issue and verify the `## Implementation Complete` comment contains a `Drive:` line with a working Drive URL
- [ ] Run ralph-pr without `RALPH_IOS_MODE` and without `--push-drive`; verify the comment has no `Drive:` line (regression check)
- [ ] Run ralph-pr with `--no-push-drive` and `RALPH_IOS_MODE=1` set; verify the CLI flag wins (no Drive line)
- [ ] Repeat the smoke for ralph-postmortem on a fake blocker issue (or use a test run with `RALPH_DEBUG=1`)

**Creates for next phase**: A documented `--push-drive` / `RALPH_IOS_MODE` contract that Phase 4's IOS-REMOTE.md describes for the user.

---

## Phase 4: IOS-REMOTE.md user doc

- **depends_on**: [phase-1, phase-2, phase-3]

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
    - `## 4. Open Drive artifacts` — explains the `claude-shared` Drive folder, how Drive links appear in issue comments when `RALPH_IOS_MODE=1`, how to open them on iOS
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
- [ ] `[ -f plugin/ralph-hero/skills/director/IOS-REMOTE.md ]`
- [ ] `grep -cE '^## ' plugin/ralph-hero/skills/director/IOS-REMOTE.md` returns at least 5 (four workflow sections + troubleshooting; "See also" makes 6)
- [ ] `grep -q 'trigger:watch' plugin/ralph-hero/skills/director/IOS-REMOTE.md`
- [ ] `grep -q 'RALPH_COS_NTFY_TOPIC' plugin/ralph-hero/skills/director/IOS-REMOTE.md`
- [ ] `grep -q 'claude-shared' plugin/ralph-hero/skills/director/IOS-REMOTE.md`
- [ ] `grep -q 'IOS-REMOTE' plugin/ralph-hero/skills/director/SKILL.md`
- [ ] `grep -q 'IOS-REMOTE' plugin/ralph-hero/scripts/cos/README.md`
- [ ] Word count: `wc -w plugin/ralph-hero/skills/director/IOS-REMOTE.md` returns between 500 and 2500

#### Manual Verification:
- [ ] Read IOS-REMOTE.md on an iPhone-width browser (or 375px viewport). All commands are copy-pasteable. No horizontal scroll on a phone.
- [ ] Walk through each of the four workflows on a real iPhone with the Mac running; each section gets the user to the documented end state without external reference

**Creates for next phase**: Nothing — this is the integration finale.

---

## Integration Testing

End-to-end smoke from the epic plan's "Integration tests" section (epic §Integration Strategy):

1. From the iOS GitHub app, add label `trigger:watch` to an arbitrary issue.
2. Wait for Director's next `/schedule` tick (or trigger manually via `ralph director` on the Mac for the smoke).
3. Confirm Director removes the `trigger:watch` label and dispatches Watch.
4. Watch runs its mission, emits a `result:` line, calls `outcome-recorder`, and pushes its report to Drive via the `--push-drive` path landed in Phase 3 (Watch is one of the producers if/when Feature C/F decide to wire it; otherwise the smoke uses a `ralph-pr` or scout-auto producer).
5. ntfy fires a push to the iOS device (Phase 2 hook).
6. iOS opens the Drive link from the push body or the issue comment.

Additional cross-phase checks:

- [ ] `ralph cos remote` after Watch finishes shows the Watchers section reflecting the completed run (count of Watch-touched issues moved on the board)
- [ ] `IOS-REMOTE.md`'s Troubleshooting section's "no ntfy push fired" entry correctly diagnoses an unset `RALPH_COS_NTFY_TOPIC` (matches Phase 2 behavior)
- [ ] All three producers (ralph-pr, ralph-postmortem, scout sweep) respect the `--no-push-drive` override when set, even with `RALPH_IOS_MODE=1` (CLI wins)
- [ ] No regression on desk-mode flows: running ralph-pr / ralph-postmortem with neither flag nor env var produces bit-identical comments to pre-feature behavior

## Performance Considerations

- **ntfy push latency**: ~200ms per push over WiFi. Single-shot, no retry. Negligible.
- **Drive push latency**: `gdrive-push` for a typical postmortem (<50 KB) takes ~2–4s including auth check. Acceptable for terminal-handler exit paths; the merge already happened, the user has the artifact locally.
- **cos rollup query cost**: Four new `list_issues` calls per cos invocation. Each cached for 30 min on the existing cos cache (`~/.ralph-hero/cos/cache/remote-status.json`). Cold-cache cos run goes from ~2 GitHub API calls to ~6; well within rate limit (5000/hr).
- **Helper script overhead**: `push-on-completion.sh` and `push-artifact.sh` are <100 LOC each, bash-only, no subshells beyond `command -v ntfy` and the `ntfy publish` / `claude -p` calls. Sourced helpers add <10ms.

## Migration Notes

Purely additive feature. No env var renames or removals. New env vars:

- `RALPH_IOS_MODE` (set by Director when consuming a trigger label per Feature B; consumed by this feature's producers to flip `--push-drive` defaults)

Reused env vars (no changes):

- `RALPH_COS_NTFY_TOPIC` (already documented in cos Phase 3 README; same role here — completion push body topic)
- `RALPH_COS_DEBUG` (already documented; this feature respects it in both new helpers)

No new state directories. No new MCP tools. No new daemons. No changes to existing skill allowlists beyond what's described per task.

## References

- Issue: [GH-1275](https://github.com/cdubiel08/ralph-hero/issues/1275)
- Parent epic: [GH-1267](https://github.com/cdubiel08/ralph-hero/issues/1267)
- Plan-of-plans: `thoughts/shared/plans/2026-05-16-GH-1267-unified-agent-system-epic.md` (Feature H section, lines 140–148)
- Sibling Feature B (Director): GH-1269 — provides `RALPH_IOS_MODE=1` env var setting on trigger-label dispatch
- Sibling Feature C (Watcher): GH-1270 — provides `team:watch` label convention consumed by cos rollup
- Sibling Feature F (Scouts): GH-1273 — provides scout-auto producer and scout SOUL.md
- Sibling Feature G (Caretakers): GH-1274 — provides `team:caretake` label convention consumed by cos rollup
- Prior plan: `thoughts/shared/plans/2026-05-15-GH-1255-cos-phase3-morning-brief-ntfy.md` — canonical ntfy invocation pattern reused in Phase 2's `push-on-completion.sh` helper
- Existing skill: `plugin/ralph-hero/skills/cos/SKILL.md` and `plugin/ralph-hero/skills/cos/system-prompt.md`
- Existing skill: `plugin/ralph-hero/skills/gdrive-push/SKILL.md` — invoked by Phase 3's `push-artifact.sh` helper
- Existing skill: `plugin/ralph-hero/skills/ralph-pr/SKILL.md`, `plugin/ralph-hero/skills/ralph-postmortem/SKILL.md`, `plugin/ralph-hero/skills/ralph-merge/SKILL.md` — producers modified in Phases 2 and 3
