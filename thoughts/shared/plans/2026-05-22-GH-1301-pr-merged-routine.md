---
date: 2026-05-22
status: draft
type: plan
github_issue: 1301
github_issues: [1301]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1301
primary_issue: 1301
parent_plan: thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md
tags: [routines, pr-merged, webhook, observability, idempotency, remote-trigger, launchd]
---

# GH-1301: P4 — Add a Routine for PR-merged webhook — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-22-GH-1301-pr-merged-routine-design]] (research doc — Recommended Approach A: cloud Routine + new lightweight `ralph-pr-merged` skill + launchd fallback)
- builds_on:: [[2026-05-17-claude-code-dispatch-incremental-adoption]] (parent plan-of-plans, Phase 4 spec)
- builds_on:: [[2026-05-22-pr-drain-routine-design]] (proof-of-concept: cloud Routine with native GitHub `pull_request` trigger is viable when plugin is installed via claude.ai/code UI)

## Overview

Single S-sized issue with one PR. Adds a lightweight `ralph-pr-merged` skill, a cloud Routine setup helper, a launchd polling fallback, and a `docs/routines.md` rollup so that PRs merged outside `ralph-merge` (GitHub UI, `gh pr merge`, teammate, Dependabot) still propagate the post-merge observability surfaces (`PushNotification`, `knowledge_record_outcome`, optional `save_issue` Done-transition).

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1301 | `ralph-pr-merged` skill (idempotent post-merge observability) | S |

## Shared Constraints

Inherited from parent plan-of-plans (`2026-05-17-claude-code-dispatch-incremental-adoption.md`):

- The GitHub Projects V2 board is the system-of-record for work. New trigger paths add new ways to *reach* the board, never new shadow queues.
- No phase reduces the safety of an existing path. The autopilot opt-in gate, hero's per-phase model tiers, Director's table-driven routing, and worktree-isolation gates all remain in force.
- New surfaces compose with the existing pipeline at well-defined seams (Director's RemoteTrigger contract, hooks at terminal markers, etc.).
- Cloud Routines that invoke ralph-hero skills require a one-time plugin install via the `claude.ai/code` UI when creating the Routine. `settings.json`-driven plugin auto-install does NOT work in headless cloud Routine sessions (project memory: `project_cloud_routines_plugin_install_gap`). The pr-drain Routine (GH-1348) is the live reference for this pattern.

Feature-specific constraints (this plan):

- **Idempotency is mandatory** when ralph-merge AND the Routine can both fire on the same merge. The skill MUST check issue state before calling `save_issue` and skip the transition when the issue was moved to Done within the last 60 seconds (ralph-merge already ran).
- **`knowledge_record_outcome` is append-only** — double-writes are correctness-safe but inflate counts. The skill records the outcome event even on idempotent skip paths because callers downstream (dream-loop reflect.py) care about the merge event signal, not unique counts.
- **`PushNotification` is best-effort** — failure does not fail the skill. This mirrors ralph-merge Step 9c.
- **PRs without linked issues are valid input** — the skill still fires `PushNotification` (with issue_number=0 sentinel in the outcome payload) and emits a result line. Skip only the `save_issue` call.

## Current State Analysis

- `ralph-merge` Step 7.5 records `knowledge_record_outcome("merge_completed")` and Step 9c fires `PushNotification`. Only ralph-merge sessions trigger these.
- The `pr-drain` Routine (GH-1348) is live and confirms the "cloud Routine + UI plugin install + native GitHub trigger" pattern works for ralph-hero skills.
- `plugin/ralph-hero/scripts/routines/` does not exist yet. `plugin/ralph-hero/docs/routines.md` does not exist yet. P3 deferred both to P4.
- `plugin/ralph-hero/scripts/monitoring-bridge/` has the launchd template pattern this plan reuses for the polling fallback (`StartInterval: 300`, `RunAtLoad: false`).
- The `outcome-collector.sh` hook does NOT match this new skill — it fires only on `ralph_hero__save_issue` with known `command:workflowState` pairs. Direct `knowledge_record_outcome` MCP calls write through the MCP server side (not the hook), so no hook update is required.
- The `outcome_events` SQL schema accepts `issue_number INTEGER NOT NULL`. The skill must always pass a non-null integer (use `0` for unlinked merges).

## Desired End State

A user can merge any PR to `main` via any path (ralph-merge, GitHub UI, `gh pr merge`, Dependabot auto-merge) and the post-merge observability surfaces fire exactly once (or twice idempotently for the ralph-merge case, with double-write only on append-only sinks).

### Verification

- [ ] Merging a PR via GitHub UI fires `PushNotification` and writes one `merge_completed` event to `outcome_events` (visible via `knowledge_query_outcomes`)
- [ ] Merging a PR via `ralph-merge` does NOT cause a double Done-transition (Routine sees Done within 60s, skips `save_issue`)
- [ ] Merging a PR without a linked issue still fires `PushNotification` and records the outcome with `issue_number=0`
- [ ] `bash plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` prints the Routine setup instructions and verification commands without errors
- [ ] `plugin/ralph-hero/docs/routines.md` lists all three Routines (`ralph-hero-pr-drain`, `ralph-hero-pr-merged`, `ralph-hero-critical-alert`) with one-time setup commands and payload shapes
- [ ] launchd template `com.ralph.pr-merged-poll.plist.template` loads without error when copied to `~/Library/LaunchAgents/` and edited per its inline comments

## What We're NOT Doing

- NOT auto-creating the Routine — the user runs `RemoteTrigger(...)` once via the `claude.ai/code` UI (same one-time setup as pr-drain). The setup script is documentation only.
- NOT modifying `ralph-merge` — the skill's Step 9c continues to fire independently. The Routine fires in parallel; idempotency is in the new skill.
- NOT extending `outcome-collector.sh` — the new skill calls `knowledge_record_outcome` directly via MCP, not via `save_issue` indirection.
- NOT adding `auto_continue` autopilot continuation. That is Phase 6 of the parent plan.
- NOT building the GitHub Actions → local relay alternative (Approach C in research). Rejected as over-engineered.
- NOT collapsing the ntfy bridge to `RALPH_NTFY_LEGACY=true` — that is Phase 2.5 of the parent plan.

## Implementation Approach

Single PR. One phase, four new files, no modifications to existing files. The order within the phase is:

1. Create the skill (the operator) so the Routine has something to invoke
2. Create the setup helper (documentation runner)
3. Create the launchd template (offline fallback)
4. Create `docs/routines.md` (rollup) cross-linking all three artifacts

The skill is the only file with logic; the other three are documentation / shell wrappers.

---

## Phase 1: Implement `ralph-pr-merged` skill + Routine setup + launchd fallback + docs rollup (GH-1301)

- **depends_on**: null

### Overview

Create a focused, ~100-line skill that resolves a PR to its issue, applies an idempotency guard, fires `PushNotification`, and records a `merge_completed` outcome event. Plus three supporting artifacts: a setup script that prints the cloud Routine creation instructions, a launchd plist template for offline polling, and a `docs/routines.md` page that enumerates all three ralph-hero Routines.

### Tasks

#### Task 1.1: Create `ralph-pr-merged` skill

- **files**: `plugin/ralph-hero/skills/ralph-pr-merged/SKILL.md` (create)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] Frontmatter includes `description`, `user-invocable: true`, `model: haiku`, `argument-hint: "--pr <PR-NUMBER>"`
  - [ ] `allowed-tools` includes: `Read`, `Bash`, `PushNotification`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__get_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__save_issue`, `mcp__plugin_ralph-hero_ralph-github__ralph_hero__create_comment`, `mcp__plugin_ralph-knowledge_ralph-knowledge__knowledge_record_outcome`
  - [ ] SessionStart hook sets `RALPH_COMMAND=pr-merged` via `${CLAUDE_PLUGIN_ROOT}/hooks/scripts/set-skill-env.sh`
  - [ ] Step 1 — argument parsing: extracts `--pr <N>` and emits `needs input:` if missing/non-numeric, then STOPs
  - [ ] Step 1 — idempotency: checks `gh pr view <N> --json labels` for the `pr-merged-handled` label and emits `result: PR #<N> already handled. Skipping.` then STOPs if present
  - [ ] Step 2 — PR fetch: `gh pr view <N> --json number,url,title,headRefName,body,state,mergedAt,mergeCommit,closingIssuesReferences` (emits `result:` and STOPs if non-zero exit, or if `state != MERGED`)
  - [ ] Step 3 — issue resolution: tries `closingIssuesReferences[0].number` first, then regex `feature/GH-(\d+)` against `headRefName`, then regex `(?:closes|fixes|resolves) #(\d+)` against `body`. Sets `ISSUE_NUMBER` to the resolved value or `0` if none.
  - [ ] Step 4 — idempotency guard: if `ISSUE_NUMBER > 0`, call `ralph_hero__get_issue(number=ISSUE_NUMBER)`. If `workflowState == "Done"` AND `closedAt` is within last 60 seconds (compare to current UTC time with Python 3 one-liner — portable across macOS/Linux, mirrors pr-drain Step 3 pattern), set `SKIP_TRANSITION=true`. Otherwise `SKIP_TRANSITION=false`.
  - [ ] Step 5 — Done transition (gated): if `ISSUE_NUMBER > 0` AND `SKIP_TRANSITION=false`, call `ralph_hero__save_issue(number=ISSUE_NUMBER, workflowState="__COMPLETE__", command="ralph_merge")`. If `SKIP_TRANSITION=true`, emit a log line `Skip save_issue: ralph-merge already transitioned #<N> within 60s window` to stderr.
  - [ ] Step 6 — `PushNotification` (best-effort, unconditional): fires `PushNotification(title="Merged #<ISSUE_NUMBER>", body="<PR title> (<PR URL>)")`. When `ISSUE_NUMBER == 0`, uses `Merged PR #<PR-NUMBER>` as title.
  - [ ] Step 7 — outcome recording (unconditional): calls `knowledge_record_outcome(event_type="merge_completed", issue_number=ISSUE_NUMBER, verdict="merged", payload={"pr_url": <PR URL>, "commit_sha": <mergeCommit.oid or null>, "repo": <RALPH_GH_REPO>, "skip_transition": SKIP_TRANSITION, "source": "ralph-pr-merged"})`. MCP failures log to stderr and do not fail the skill.
  - [ ] Step 8 — idempotency label: `gh pr edit <N> --add-label pr-merged-handled` (best-effort, `|| true`)
  - [ ] Step 9 — emit result marker: `result: Processed PR #<N> (issue: #<ISSUE_NUMBER>, skip_transition: <SKIP_TRANSITION>)`
  - [ ] Constraints block documents the idempotency contract, the unconditional outcome recording even on skip, the `issue_number=0` sentinel for unlinked PRs, and the best-effort PushNotification/labeling
  - [ ] "See also" block cross-links the research doc, `ralph-merge` Step 7.5/9c, the cloud Routine in `claude.ai/code/routines`, and `docs/routines.md`
  - [ ] Skill length is under 150 lines of body (excluding frontmatter)

#### Task 1.2: Create Routine setup helper script

- **files**: `plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` (create), `plugin/ralph-hero/scripts/routines/` (create dir)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Shebang `#!/usr/bin/env bash`, `set -euo pipefail`, executable permission (`chmod +x`)
  - [ ] When run with no args, prints to stdout:
    - A heading `# Setup: ralph-hero-pr-merged Cloud Routine`
    - One-time setup instructions (3 numbered steps): (1) open `claude.ai/code` → Routines → New Routine, (2) install the ralph-hero plugin in the Routine session (same as local setup), (3) configure the GitHub trigger with the exact RemoteTrigger payload shown below
    - The literal `RemoteTrigger(...)` block from the issue body (name `ralph-hero-pr-merged`, native github `pull_request` trigger with filter `action: closed, is_merged: true, base_branch: main`, prompt invokes `/ralph-hero:ralph-pr-merged --pr {{ pr.number }}`, model `haiku`, repo `cdubiel08/ralph-hero`)
    - Verification commands: (a) merge a PR via GitHub UI and `tail -f ~/.claude-code/routines/ralph-hero-pr-merged.log`, (b) `sqlite3 ~/.ralph-hero/knowledge.db "SELECT * FROM outcome_events WHERE event_type='merge_completed' ORDER BY timestamp DESC LIMIT 5"`, (c) `gh pr view <N> --json labels | jq -r '.labels[].name' | grep pr-merged-handled`
    - A pointer to the launchd fallback for offline use
  - [ ] Does NOT call `gh routine`, `claude`, or any external command — it is documentation only (Routine creation requires interactive `claude.ai/code` UI)
  - [ ] Exits 0

#### Task 1.3: Create launchd polling fallback template

- **files**: `plugin/ralph-hero/scripts/routines/poll-merged-prs.sh` (create), `plugin/ralph-hero/scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template` (create), `plugin/ralph-hero/scripts/routines/launchd/` (create dir)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1]
- **acceptance**:
  - [ ] `poll-merged-prs.sh` has shebang `#!/usr/bin/env bash`, `set -euo pipefail`, executable permission
  - [ ] `poll-merged-prs.sh` computes a 10-minute `SINCE` window using the macOS+Linux-portable pattern: `date -u -v-10M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "10 minutes ago" +%Y-%m-%dT%H:%M:%SZ`
  - [ ] `poll-merged-prs.sh` runs `gh pr list --state merged --json number,headRefName,mergedAt,labels --search "base:main merged:>=${SINCE}" --jq '.[] | select((.labels | map(.name) | contains(["pr-merged-handled"])) | not) | .number'` and pipes each PR number to `claude -p "/ralph-hero:ralph-pr-merged --pr $pr_num"`
  - [ ] Each `claude -p` invocation is wrapped with `|| true` so one failure does not stop processing the rest
  - [ ] Plist `com.ralph.pr-merged-poll.plist.template` mirrors the monitoring-bridge template structure (Label, ProgramArguments invoking poll script via `/bin/bash -lc`, `StartInterval: 300`, `RunAtLoad: false`, StandardOutPath `/tmp/ralph-pr-merged-poll.out`, StandardErrorPath `/tmp/ralph-pr-merged-poll.err`)
  - [ ] Plist `ProgramArguments` references the poll script via absolute path with `__INSTALL_PATH__` placeholder users replace during install (mirrors monitoring-bridge template which uses a hard-coded path; document the substitution requirement in `docs/routines.md`)
  - [ ] Plist passes `PATH=/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin` in `EnvironmentVariables`

#### Task 1.4: Create `docs/routines.md` rollup

- **files**: `plugin/ralph-hero/docs/routines.md` (create)
- **tdd**: false
- **complexity**: low
- **depends_on**: [1.1, 1.2, 1.3]
- **acceptance**:
  - [ ] Document opens with a one-paragraph summary explaining what cloud Routines are in the ralph-hero context (external producers that fire ralph-hero skills via `RemoteTrigger`) and the one-time UI plugin install requirement
  - [ ] Has three top-level `##` sections, one per Routine: `## ralph-hero-pr-drain`, `## ralph-hero-pr-merged`, `## ralph-hero-critical-alert`
  - [ ] Each Routine section includes: (1) trigger event/payload shape, (2) one-time setup command (the literal `RemoteTrigger(...)` invocation), (3) the skill it invokes, (4) verification commands
  - [ ] `ralph-hero-pr-merged` section additionally documents: the idempotency guard, the 60s window, the `pr-merged-handled` label, the `issue_number=0` sentinel for unlinked PRs
  - [ ] `## Offline fallback (launchd)` section documents `setup-pr-merged-routine.sh` vs the launchd plist trade-offs: cloud Routine is near-real-time and host-independent but requires plugin install in UI; launchd is up to 5-minute latency, requires the user's Mac to be on, but works offline and uses no subscription budget
  - [ ] `## See also` cross-links: the parent plan-of-plans, the research doc, `skills/director/IOS-REMOTE.md` § 5 (External producers), and `scripts/monitoring-bridge/README.md` § CRITICAL-alert RemoteTrigger

### Phase Success Criteria

#### Automated Verification:

- [ ] `npm run build` (from `plugin/ralph-hero/mcp-server/`) — no errors (sanity check; no TS files changed but ensures repo is buildable)
- [ ] `bash -n plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` — no syntax errors
- [ ] `bash -n plugin/ralph-hero/scripts/routines/poll-merged-prs.sh` — no syntax errors
- [ ] `bash plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh` — exits 0, prints the setup instructions including the literal `RemoteTrigger(...)` block and verification commands
- [ ] `xmllint --noout plugin/ralph-hero/scripts/routines/launchd/com.ralph.pr-merged-poll.plist.template` — valid XML (plist is XML; mirrors how monitoring-bridge plist is validated)
- [ ] `grep -E "^model: haiku$|user-invocable: true$" plugin/ralph-hero/skills/ralph-pr-merged/SKILL.md` — finds both lines
- [ ] `grep -E "knowledge_record_outcome|PushNotification|get_issue|save_issue|create_comment" plugin/ralph-hero/skills/ralph-pr-merged/SKILL.md` — finds at least 5 references documenting the tool calls

#### Manual Verification:

- [ ] One-time setup: run `bash plugin/ralph-hero/scripts/routines/setup-pr-merged-routine.sh`, follow the printed instructions to create the Routine in `claude.ai/code`
- [ ] Merge a test PR (e.g., a no-op `chore: test` PR) via the GitHub UI → Routine fires within ~30s, `PushNotification` arrives (if Remote Control paired), `outcome_events` row appears with `event_type=merge_completed`, PR gets `pr-merged-handled` label
- [ ] Merge a PR via `ralph-merge` → both ralph-merge Step 9c AND Routine fire; verify `outcome_events` has TWO `merge_completed` rows (the duplicate is expected; verify the Routine's row has `payload.skip_transition=true`)
- [ ] Merge a PR with no `feature/GH-NNNN` head and no `closes #NNN` in body (e.g., a Dependabot bump) → Routine fires, `outcome_events` row has `issue_number=0`, no `save_issue` call attempted, `PushNotification` still fires with PR-number-only title
- [ ] Copy the plist template to `~/Library/LaunchAgents/com.ralph.pr-merged-poll.plist`, replace `__INSTALL_PATH__` with the absolute path to `poll-merged-prs.sh`, run `launchctl load ~/Library/LaunchAgents/com.ralph.pr-merged-poll.plist`, verify it appears in `launchctl list | grep pr-merged-poll` and that `tail -f /tmp/ralph-pr-merged-poll.out` shows polling activity on the next tick
- [ ] Verify `docs/routines.md` renders cleanly in GitHub markdown preview and all internal links resolve

**Creates for next phase**: N/A (single-phase plan). The skill becomes an entry point usable both by the cloud Routine and by the launchd fallback. `docs/routines.md` becomes the canonical Routine catalog cross-linked from `CLAUDE.md` § Unified Agent System in a future docs sweep.

---

## Integration Testing

- [ ] End-to-end via cloud Routine: merge a test PR via GitHub UI; verify `PushNotification` + `outcome_events` row + PR label within 60s
- [ ] End-to-end via launchd fallback: with the cloud Routine disabled (delete in `claude.ai/code`), merge a test PR via GitHub UI; verify the launchd job picks it up within 5 minutes and produces the same surfaces
- [ ] Double-fire idempotency: merge a PR via `ralph-merge`; verify the Routine sees `workflowState=Done` within 60s and skips the transition (check stderr or session log for the skip line)
- [ ] Stale-Done case: merge a PR via `ralph-merge`, wait 2 minutes, then manually invoke `claude -p "/ralph-hero:ralph-pr-merged --pr <N>"` simulating a delayed Routine fire — verify the skill detects the >60s window and runs the `save_issue` call (which is a no-op because the issue is already Done, but the path executes)
- [ ] Idempotency label: invoke the skill twice on the same PR; second invocation hits the `pr-merged-handled` label check in Step 1 and stops with `result: PR #<N> already handled. Skipping.`

## References

- Research: [`thoughts/shared/research/2026-05-22-GH-1301-pr-merged-routine-design.md`](../research/2026-05-22-GH-1301-pr-merged-routine-design.md)
- Parent plan-of-plans: [`thoughts/shared/plans/2026-05-17-claude-code-dispatch-incremental-adoption.md`](2026-05-17-claude-code-dispatch-incremental-adoption.md) § Phase 4
- Related issue: [GH-1301](https://github.com/cdubiel08/ralph-hero/issues/1301)
- Parent epic: [GH-1297](https://github.com/cdubiel08/ralph-hero/issues/1297)
- Sibling reference (live proof-of-concept): [`plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md`](../../plugin/ralph-hero/skills/ralph-pr-drain/SKILL.md), GH-1348
- Reference for outcome event recording: [`plugin/ralph-hero/skills/ralph-merge/SKILL.md`](../../plugin/ralph-hero/skills/ralph-merge/SKILL.md) Step 7.5 and Step 9c
- Reference for launchd template pattern: [`plugin/ralph-hero/scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template`](../../plugin/ralph-hero/scripts/monitoring-bridge/launchd/com.ralph.monitoring-bridge.plist.template)
- Project memory: `project_cloud_routines_plugin_install_gap` (settings.json plugin install does not work in Routines; UI install does)
