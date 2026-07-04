---
date: 2026-07-04
type: research
status: complete
topic: ralph hooks system inventory + simplification
---

# Ralph hooks system — full inventory and 2026-07-04 simplification

## Research Question

Two concurrent-session incidents (doc-structure-validator blocking a Stop on a *different* session's in-progress research doc; review-plan-gate blocking *every* AskUserQuestion under `RALPH_REVIEW_PLAN=auto`) prompted a full inventory of `ralph/hooks/scripts/`: what exists, where each hook is registered, what state it shares, and what could be simplified for maintainability and per-tool-call speed.

## Summary

Before this change the system was 44 lifecycle hooks + `hook-utils.sh` + `finish-review-verdict.sh` (CLI helper) + `ralph-state-machine.json`, registered across `hooks.json` (2 global) and 7 skill frontmatters. Three scripts were orphans; ~35 had no test coverage; ten near-identical state gates duplicated `ralph-state-machine.json`'s `valid_output_states` as drifting bash literals while the JSON went unread (the one reader helper referenced an unset `$SCRIPT_DIR`).

The 2026-07-04 simplification (this session) landed three phases:

**Phase A — session-scoped artifact tracking (race fixes).**
- New `artifact-write-tracker.sh` (PostToolUse `Write|Edit` in research/plan/impl/review) records `thoughts/shared/{research,plans,reviews}` writes to `${TMPDIR}/ralph-session-<session_id>/artifacts.list` (helpers: `ralph_session_dir` / `session_artifacts` / `find_fresh_artifact` in `hook-utils.sh`).
- `doc-structure-validator.sh` now validates ONLY session-written today-dated docs — never the global freshest-by-mtime scan that raced concurrent sessions.
- `review-plan-gate.sh` now blocks only the plan-review verdict picker (header "Plan Review" or Approve + Request-changes option labels), not every AskUserQuestion.
- `plan-postcondition.sh` absorbed `review-postcondition.sh` (deleted): the two-script "path mutex" became an if/else; the absorbed script's FAILED/exit-2 scaffold was dead code (nothing ever appended).
- `research-postcondition.sh` + `plan-postcondition.sh` discover docs session-first with `find -mmin -30` as fallback only — fixing the >30-minute-session false-block.

**Phase B — state-gate consolidation.**
- New `state-gate.sh <scope>[:<subcommand>] <command-key>...` replaces research/plan/impl/pr/merge/triage/hero/pr-drain/review state gates (9 scripts deleted). Allowlists = union of the keys' `valid_output_states` + `lock_state` from `ralph-state-machine.json`, making the JSON the single source of truth. Registrations: `research research`, `plan plan plan_epic review`, `impl impl pr`, `review merge code_review`, `caretake:triage triage`, `hero hero`, `hero:pr-drain pr_drain`.
- Universal semantic-intent passthrough + `targetState` fallback (previously inconsistent across the family). `unblock-state-gate.sh` stays separate (variant-branched deny-all semantics).
- JSON updates (behavior-preserving vs the old bash defaults): `ralph_hero` widened to the 9-state orchestration list, `ralph_triage` gained `Backlog`, new `ralph_pr_drain` command.
- Fixed a latent mis-registration: the research gate was registered on `get_issue` (whose input never carries `workflowState` — a permanent no-op); it now correctly gates `save_issue`.
- Removed `RALPH_VALID_OUTPUT_STATES` env-override plumbing (review's SessionStart no longer sets it; nothing reads it). The env var could bleed across skills in a hero session because `CLAUDE_ENV_FILE` is append-only.

**Phase C — dead code + speed.**
- Deleted orphans: `val-postcondition.sh` (never registered; its logic lives in `closeout-postcondition.sh`), `review-state-gate.sh`, `split-verify-sub-issue.sh` (warn-only, no enforcement).
- Deleted the `/tmp/ralph-artifact-markers/` and `/tmp/ralph-plan-sync-*` checks from research/plan postconditions: **no writer for either marker exists anywhere** (not in `mcp-server/src`, not in skills) — the warnings fired on every ticketed Stop. If `sync_plan_graph` enforcement is wanted, the tool must first actually write a marker (open gap).
- `merge-review-decision-gate.sh` batches its PR reads into one `gh pr view --json reviewDecision,comments,reviewThreads,closingIssuesReferences,author` call (worst path 8 → 5 API calls; XS carve-out path 4 → 2). Fail-closed semantics preserved.
- Fixed `plan-tier-validator.sh`'s Edit-compose path: the python helper read stdin twice (second read always empty → the Edit branch silently never composed), and interpolated `$file_path` into python source. Now env-var + argv passing.
- Dead helper `get_valid_output_states` (unset `$SCRIPT_DIR`) removed from `hook-utils.sh`; stale comments referencing deleted `record-activity.sh` / `val-postcondition.sh` line numbers refreshed.

Net: 47 scripts → 37, three new test suites (`state-gate.test.sh` 25 cases, `doc-structure-validator.test.sh` 9, `artifact-write-tracker.test.sh` 7, `review-plan-gate.test.sh` 6), zero ShellCheck errors, doc rosters + skill-frontmatter contract green.

## Detailed Findings

### Registration map (post-change)

Global (`hooks.json`): `set-skill-env.sh` (SessionStart), `cursor-advance-catch-up.sh` (PostToolUse `recent_activity`). Skills catch-up/form/hero-fable/setup have no or SessionStart-only hooks.

| Skill | PreToolUse | PostToolUse | Stop |
|---|---|---|---|
| research | save_issue → state-gate | Write\|Edit → artifact-write-tracker | research-postcondition, doc-structure-validator, remember-turn, lock-release-on-failure |
| plan | Write → plan-research-required, review-no-dup, plan-tier-validator; Edit → plan-tier-validator; AskUserQuestion → review-plan-gate; save_issue → state-gate | Write → review-verify-doc; Write\|Edit → artifact-write-tracker | plan-postcondition, doc-structure-validator, lock-release-on-failure, remember-turn |
| impl | Write\|Edit → impl-plan-required, impl-worktree-gate; save_issue → state-gate; Bash → impl-staging-gate, impl-branch-gate | Write\|Edit → drift-tracker, artifact-write-tracker; Bash → impl-verify-commit | impl-postcondition, lock-release-on-failure, doc-structure-validator, remember-turn |
| review | save_issue\|advance_issue → state-gate; Bash → closeout-scout-gate, merge-review-decision-gate | Write\|Edit → artifact-write-tracker | closeout-postcondition, lock-release-on-failure, doc-structure-validator |
| caretake | Bash → branch-gate; get_issue → split-estimate-gate; create_issue → split-size-gate; Skill → triage-no-skill-dispatch | get_issue → split-estimate-gate; save_issue → state-gate (caretake:triage), unblock-state-gate | triage-postcondition, unblock-request-postcondition, split-postcondition, postmortem-completeness, lock-release-on-failure |
| hero | Bash → branch-gate; Skill → autopilot-enable-gate; ScheduleWakeup → autopilot-wakeup-clear; save_issue → state-gate ×2 (hero, hero:pr-drain); advance_issue → state-gate | Skill → hero-dispatch-log, autopilot-director-postcheck | autopilot-stop-gate, lock-release-on-failure |

### Session-scoped state (the race-fix mechanism)

`${TMPDIR:-/tmp}/ralph-session-<session_id>/artifacts.list`, keyed by the harness-provided `.session_id` from hook input (PPID fallback). Written by `artifact-write-tracker.sh`; read via `session_artifacts <dir-filter> [ticket]`. PostToolUse hooks fire for sub-agent tool calls too, so agent-written docs are captured. Postconditions keep `find_fresh_artifact` (find `-mmin -30` + GH-NNN/GH-0NNN padding tolerance) as fallback for docs written where the tracker isn't registered; `doc-structure-validator.sh` deliberately has NO fallback (no session-written doc → allow; postconditions own "artifact missing").

### Shared out-of-repo state (post-change)

| Path | Key | Writers / readers |
|---|---|---|
| `$CLAUDE_ENV_FILE` | session | set-skill-env (append) — linchpin for `RALPH_COMMAND` scope guards |
| `${TMPDIR}/ralph-session-<sid>/artifacts.list` | session | artifact-write-tracker (append); doc-structure-validator, plan/research postconditions (read) |
| `${TMPDIR}/ralph-hero-{autoloop,pending-wakeup}-<sid>` | session | autopilot trio |
| `~/.ralph-hero/cursors/catch-up.json` | global | cursor-advance-catch-up |
| `~/.ralph-hero/activity/…` | per-day | hero-dispatch-log (append) |
| `~/projects/thoughts/dream-memories/agent/…` | content-hash | remember-turn |

### Known gaps / follow-ups

1. **`sync_plan_graph` enforcement** — the postcondition marker check was fiction; if wanted, the MCP tool must write a marker (session-keyed) and the hook re-check it.
2. **Test coverage** — the impl gate family (impl-plan-required / worktree / staging / branch / verify-commit / postcondition), closeout pair, lock-release, remember-turn, split gates, unblock gates remain untested (~24 scripts). The consolidated `state-gate.sh` closed the largest gap.
3. **`RALPH_SUBCOMMAND` propagation** — subcommand-scoped gates (`caretake:triage`, `hero:pr-drain`, unblock) still depend on the skill body exporting `RALPH_SUBCOMMAND` via `CLAUDE_ENV_FILE`-equivalent mechanisms; when unset they fail open by design.
4. **Transcript greps on Stop** — closeout/impl/triage postconditions and remember-turn read the whole transcript per Stop; fine today, revisit if transcripts grow.
5. **`finish-review-verdict.sh`** — CLI helper living in `hooks/scripts/`; relates to the open plan `thoughts/shared/plans/2026-05-19-GH-1323-finish-review-verdict-gate-stub.md`.

## Files Affected

### Will Modify
(landed in this change)
- `ralph/hooks/scripts/hook-utils.sh` — session helpers added; dead `get_valid_output_states` removed
- `ralph/hooks/scripts/artifact-write-tracker.sh` — NEW
- `ralph/hooks/scripts/state-gate.sh` — NEW (replaces 9 per-verb gates)
- `ralph/hooks/scripts/doc-structure-validator.sh`, `plan-postcondition.sh`, `research-postcondition.sh`, `review-plan-gate.sh`, `plan-tier-validator.sh`, `merge-review-decision-gate.sh` — rewritten/updated
- `ralph/hooks/scripts/ralph-state-machine.json` — hero/triage lists aligned; `ralph_pr_drain` added
- Deleted: `review-postcondition.sh`, `val-postcondition.sh`, `review-state-gate.sh`, `split-verify-sub-issue.sh`, `research-state-gate.sh`, `plan-state-gate.sh`, `impl-state-gate.sh`, `pr-state-gate.sh`, `merge-state-gate.sh`, `triage-state-gate.sh`, `hero-state-gate.sh`, `pr-drain-state-gate.sh`
- Skill frontmatters: `ralph/skills/{research,plan,impl,review,caretake,hero}/SKILL.md`
- Prose: `ralph/skills/plan/plan-review.md`, `ralph/skills/caretake/modes/{triage,split,watch-pr,watch-upstream,watch-blockers}.md`, `ralph/skills/caretake/split-decomposition.md`, `ralph/skills/impl/plan-compliance.md`

### Will Read (Dependencies)
- `ralph/hooks/hooks.json` — global registrations (unchanged)
- `mcp-server/src/lib/state-resolution.ts` — server-side semantic-intent resolution the gates defer to
