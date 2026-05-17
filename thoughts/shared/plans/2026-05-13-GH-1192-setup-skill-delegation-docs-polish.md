---
date: 2026-05-13
status: draft
type: plan
github_issue: 1192
github_issues: [1192]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1192
primary_issue: 1192
parent_plan: thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md
tags: [llm-delegation, setup-skill, documentation, onboarding, gemma-lab]
---

# F6 — Setup-skill integration + delegation docs polish — Atomic Implementation Plan

## Prior Work

- builds_on:: [[2026-05-03-GH-0965-llm-delegation-via-bash-epic]]
- builds_on:: F1 wrapper at `plugin/ralph-hero/scripts/ralph-delegate.sh` (#1185, merged)
- builds_on:: F2 OpenAI-compat adapter at `plugin/ralph-hero/scripts/lib/openai-compat.sh` (#1186, merged)
- builds_on:: F3 authoring guide at `plugin/ralph-hero/docs/delegation-authoring.md` + conventions at `plugin/ralph-hero/skills/shared/delegation-conventions.md` + reference skill at `plugin/ralph-hero/skills/delegate-test/SKILL.md` (#1187, merged)
- builds_on:: F4a codebase-locator delegation (#1188, merged), F4b pr-agent description delegation (#1189, merged), F4c val-agent classification delegation (#1190, merged)
- builds_on:: F5 delegation telemetry: `ralph_hero__delegation_stats` MCP tool at `plugin/ralph-hero/mcp-server/src/tools/delegation-tools.ts`, `ralph status --delegation` CLI, `plugin/ralph-hero/scripts/delegate/logrotate.sh` (#1191, merged)
- references:: `plugin/ralph-hero/skills/setup/SKILL.md` — host skill receiving the new delegation-onboarding step
- references:: `plugin/ralph-hero/README.md` § Delegation (optional) — already populated; canonical env-var source
- references:: top-level `/Users/dubiel/projects/ralph-hero/README.md` — top-level repo README with no delegation section yet

## Overview

Final closeout phase of the GH-965 LLM delegation epic. F1-F5 ship the runtime (wrapper, adapter, authoring docs, three integration sites, telemetry); F6 makes the feature discoverable for fresh installs and tightens lingering "in-flight" references in F3 docs. One implementation phase, three small documentation/skill edits, no MCP-server code, no shell-runtime code, no test infrastructure changes.

| Phase | Issue | Title | Estimate |
|-------|-------|-------|----------|
| 1 | GH-1192 | F6 — Setup-skill integration + delegation docs polish | XS |

**Why single-phase**: F6 is XS. Three coordinated file edits (setup skill, top-level README, root CLAUDE.md, plus a one-word fix in the F3 conventions doc) that all need to ship together so a fresh-install operator can find the feature and a skill author sees current "merged" status rather than "upcoming."

## Shared Constraints

Inherited from parent plan-of-plans `2026-05-03-GH-0965-llm-delegation-via-bash-epic.md`:

- **No-regression invariant**: with `RALPH_DELEGATE_ENABLED` unset (the default), ralph-hero behaves bit-identically to today. F6 must never make the setup skill write `RALPH_DELEGATE_ENABLED=true` without explicit user confirmation. Endpoint probe failure (no gemma server) MUST be silent — no error noise, no failed-step output, no settings-file write.
- **Reuse existing env vars**: `RALPH_DELEGATE_ENABLED`, `RALPH_LLM_URL` (default `http://localhost:8000`), `RALPH_LLM_MODEL` (default `mlx-community/gemma-4-26b-a4b-it-mxfp8`). Do not introduce new variables.
- **Settings-file scope discrimination**: the setup skill already detects user-vs-project scope in Step 1b. The new delegation-onboarding step MUST inherit that decision — write delegation env vars to the same file Step 1b/Step 5 chose for the other env vars. Never split delegation across files.

Feature-specific constraints:

- **Probe ergonomics**: the setup-skill probe is a single `curl` to `${RALPH_LLM_URL:-http://localhost:8000}/v1/models` with a 2-second timeout. Use `ralph-delegate.sh --health-check` (already wired in F1, returns exit 0 on success / 127 on unreachable, with a hard 2s timeout) so the probe inherits the wrapper's URL-resolution logic — do NOT re-implement the probe in raw curl from the skill body.
- **Confirmation gate**: even if the probe succeeds, the skill MUST ask the user via `AskUserQuestion` before writing `RALPH_DELEGATE_ENABLED=true`. The wording follows the issue's acceptance criterion: "we detected a local LLM at `<URL>`. Enable opt-in delegation for ralph-hero skills?" → Yes/No. Default to No on any ambiguity.
- **No migration**: the epic plan's `## Migration plan` section is explicit — "No data migration required." F6 does not touch existing settings files for operators who already have a delegation config. The probe-and-offer flow only runs when `RALPH_DELEGATE_ENABLED` is unset.
- **Idempotency**: re-running `/ralph-hero:setup` after delegation is already enabled MUST detect the existing config and skip the probe-and-offer step (with a one-line "Delegation already enabled — skipping" note). Do not re-prompt.
- **F5 references must be present-tense**: the F3 docs reference "upcoming telemetry tooling (Feature F5)" in one spot; F5 is now merged. Update to present tense and link to the actual tool.

## Current State Analysis

**Setup skill** (`plugin/ralph-hero/skills/setup/SKILL.md`, 773 lines): well-structured 7-step workflow with scope detection (Step 1b), env-var write (Step 2/5), and optional routing (Step 6b). Has no delegation awareness today. The Step 6b "Routing & Sync (Optional)" sub-step is the closest analog — uses `AskUserQuestion` with explicit Yes/Skip options and records state for the final report. F6 follows that pattern.

**Plugin README** (`plugin/ralph-hero/README.md` lines 249-307): already has a complete "Delegation (optional)" section authored during F1/F5. Includes env-var table, exit-code crib, quick-check, audit-log spec, F5 telemetry surface (`ralph status --delegation` + rotation script + launchd template), and links to F3 authoring guide + conventions + reference skill. **No changes needed here.**

**Top-level repo README** (`/Users/dubiel/projects/ralph-hero/README.md` lines 236-249): bare-bones Configuration section. No mention of delegation. Operators landing on the repo's GitHub page won't discover the feature.

**Root CLAUDE.md** (`/Users/dubiel/projects/ralph-hero/CLAUDE.md`): no delegation section. Future Claude Code sessions in this repo have no in-context "When to delegate" cue. The issue body says "`plugin/ralph-hero/CLAUDE.md`" but that file does not exist — only the repo-root `CLAUDE.md` does. The plan treats the root CLAUDE.md as the target (this is the file Claude Code actually loads at session start in this repo).

**F3 authoring doc** (`plugin/ralph-hero/docs/delegation-authoring.md`): clean. References F5-related telemetry only in the README link, which is already live.

**F3 conventions doc** (`plugin/ralph-hero/skills/shared/delegation-conventions.md` line 33): one in-flight reference — "The single-writer invariant keeps the log analyzable by upcoming telemetry tooling (Feature F5 of [#965](https://github.com/cdubiel08/ralph-hero/issues/965))." F5 is merged; this should now read "by the delegation-stats MCP tool (Feature F5, merged)" with a direct link to the README's Audit-log subsection.

**F1 health-check wrapper** (`plugin/ralph-hero/scripts/ralph-delegate.sh:65-66`): `--health-check` flag exists, issues `GET ${RALPH_LLM_URL}/v1/models` with a 2-second timeout, returns 0 on success or 127 on unreachable. **Reused unchanged** by the new setup-skill step.

## Desired End State

After this phase lands:

1. A fresh-install operator running `/ralph-hero:setup` with a local Gemma server running on `:8000` is asked whether to enable delegation; on "Yes" the skill writes `RALPH_DELEGATE_ENABLED=true` to the scope-appropriate settings file (same file as the other env vars). On "No" or "Skip" nothing is written.
2. The same setup run with NO local LLM server (probe returns 127) silently skips the delegation-onboarding step — no error, no warning, no prompt. The final-report section records "Delegation: endpoint not detected — skipped."
3. The setup run with delegation already enabled (re-run) detects `RALPH_DELEGATE_ENABLED=true` in the resolved env and prints a one-line "Delegation already enabled — skipping onboarding" before continuing to Step 7.
4. The top-level repo README has a new "Delegation (optional)" section that mirrors the env-var summary from the plugin README and links to the plugin README's full section + the F3 authoring guide. Anyone landing on the repo's GitHub page can discover the feature in one click.
5. The root `CLAUDE.md` has a new "Delegation" subsection in the Architecture block (right after the Caching Strategy subsection) summarizing what delegation is, who uses it (locator, pr-agent, val-agent, delegate-test), and pointing future Claude Code sessions at the authoring guide.
6. The F3 conventions doc's "upcoming telemetry tooling (F5)" reference reads as merged-and-live, linking to `ralph status --delegation` and the README's telemetry sub-section.

### Verification

- [ ] `/ralph-hero:setup` with `gemma-up` running on `:8000` → AskUserQuestion appears with both options; "Yes" writes `RALPH_DELEGATE_ENABLED=true` to the correct settings file (user-scoped OR project-scoped, per Step 1b).
- [ ] `/ralph-hero:setup` with no local LLM server → no AskUserQuestion fires, no prompt, no settings-file write. Final report includes "Delegation: endpoint not detected — skipped" (single line).
- [ ] `/ralph-hero:setup` re-run with `RALPH_DELEGATE_ENABLED=true` already set → "Delegation already enabled — skipping onboarding" printed, no re-prompt.
- [ ] User answering "No" to the AskUserQuestion → no settings-file write, no `RALPH_DELEGATE_ENABLED` line added.
- [ ] Top-level `README.md` has a "Delegation" section with the env-var summary table from the plugin README's section.
- [ ] Root `CLAUDE.md` has a "Delegation" subsection in the Architecture block (between "Caching Strategy" and "Hook Patterns") with a "When to delegate" pointer to `plugin/ralph-hero/docs/delegation-authoring.md`.
- [ ] `plugin/ralph-hero/skills/shared/delegation-conventions.md` has zero occurrences of "upcoming" in F5-related sentences. F5 reference reads as merged-and-live.
- [ ] `grep -nri "F5.*upcoming\|upcoming.*F5\|upcoming telemetry" plugin/ralph-hero/` returns no matches.

## What We're NOT Doing

- **Settings-file migration**: existing operators who already have delegation env vars set keep them as-is. F6 does not rewrite, validate, or normalize their settings files. (Epic plan § Migration plan: "No data migration required.")
- **Auto-installing gemma-lab**: the setup skill does NOT install MLX, mlx-openai-server, or download a model. It probes an endpoint, nothing else. (Out of scope per epic.)
- **Auto-starting the LLM server**: the setup skill does NOT run `gemma-up` automatically. The probe assumes the operator started it themselves (e.g., from the `~/.zshrc` shortcut in the top-level `~/projects/CLAUDE.md`).
- **Per-task env-var prompts**: the setup skill does NOT prompt for `RALPH_DELEGATE_<TASK>_URL` / `RALPH_DELEGATE_<TASK>_MODEL` overrides. Those are advanced operator settings; the setup skill only writes the master toggle.
- **Modifying any existing skill that uses delegation**: locator (F4a), pr-agent (F4b), val-agent (F4c), and delegate-test (F3 reference) skills stay exactly as merged. F6 is documentation + onboarding only.
- **Touching `plugin/ralph-hero/README.md`**: the plugin README's delegation section was authored during F1/F5 and is canonical. F6 references it but does not modify it.
- **Adding a setup CLI subcommand**: the existing `ralph status --delegation` (F5) is the post-setup verification tool. No new CLI surface in F6.
- **Auto-writing per-task overrides if specific skills are detected**: the master toggle is the only env var the setup skill writes. Operators can add per-task overrides later by hand.
- **Touching ralph-knowledge / dream-loop**: those features have their own `RALPH_LLM_URL` consumer paths and are independent. F6 only affects ralph-hero.

## Implementation Approach

Single phase, four file edits, no code changes outside Markdown. The setup skill edit is the longest (~50 lines of inserted workflow content); the README and CLAUDE.md edits are short additions; the conventions-doc edit is a one-sentence rewrite.

The ordering inside the phase reflects dependency: the setup skill body references the top-level README's Delegation section (anchor link), which references the plugin README's full section. So the top-level README must exist before the setup skill body's link is meaningful. Tasks 1.2 and 1.3 are independent and can ship together; Task 1.1 (setup skill) and Task 1.4 (conventions doc fix) are also independent. All four land in one commit.

---

## Phase 1: F6 closeout — setup-skill integration + docs polish (GH-1192)
- **depends_on**: null

### Overview

Add a "Step 6c — Delegation Onboarding (Optional)" sub-step to the setup skill that probes the local LLM endpoint via `ralph-delegate.sh --health-check` and offers (does not force) opt-in. Add a new "Delegation" section to the top-level repo README mirroring the plugin README's env-var table. Add a "Delegation" subsection to the root CLAUDE.md Architecture block pointing future Claude Code sessions at the authoring guide. Fix the one "upcoming" F5 reference in the conventions doc.

### Tasks

#### Task 1.1: Add delegation-onboarding sub-step to setup skill
- **files**: `plugin/ralph-hero/skills/setup/SKILL.md` (modify)
- **tdd**: false
- **complexity**: medium
- **depends_on**: null
- **acceptance**:
  - [ ] New section "### Step 6c: Delegation Onboarding (Optional)" inserted after Step 6b (Routing & Sync) and before Step 7 (Final Report)
  - [ ] Section opens with a guard: "If `RALPH_DELEGATE_ENABLED` is already set to true in the resolved env, print 'Delegation already enabled — skipping onboarding' and skip the remaining sub-steps."
  - [ ] Probe block uses `bash "$CLAUDE_PLUGIN_ROOT/scripts/ralph-delegate.sh" --health-check` with `2>/dev/null` and captures `rc=$?`
  - [ ] Branch on `$rc`: if 0, continue to the AskUserQuestion; if 127 (unreachable) or anything else, silently skip onboarding and record `delegationProbed: false` (used by Final Report)
  - [ ] AskUserQuestion text: "A local LLM endpoint is reachable at `${RALPH_LLM_URL:-http://localhost:8000}`. Enable opt-in delegation for ralph-hero skills?" Options: "Yes, enable delegation (writes `RALPH_DELEGATE_ENABLED=true` to settings)" and "No, skip for now"
  - [ ] On "Yes": append `"RALPH_DELEGATE_ENABLED": "true"` to the existing `"env"` block in the scope-appropriate settings file (user-scoped: `~/.claude/settings.json`; project-scoped: `<project>/.claude/settings.local.json`, same file Step 1b chose). Use `jq` or careful Edit-on-existing-file (the skill already has a settings-write pattern in Step 5 — reuse it)
  - [ ] On "No": record `delegationEnabled: false`, no settings-file write, continue to Step 7
  - [ ] On "Yes": display a one-line confirmation: `Delegation enabled. Run 'gemma-up' to start the local server before invoking ralph-hero skills. See README.md § Delegation for details.`
  - [ ] Section ends with a record-state block: `delegationProbed: true|false`, `delegationEnabled: true|false`, both consumed by the Step 7 Final Report
  - [ ] Final Report's "Routing & Sync" sibling block extended with one new line: `Delegation: [Enabled (RALPH_DELEGATE_ENABLED=true written) / Skipped (operator declined) / Endpoint not detected — skipped]` based on `delegationProbed`/`delegationEnabled`
  - [ ] Next-steps list in Final Report (both simple-setup and split-owner variants) extended with one new conditional bullet: `[If delegationEnabled is true] Restart Claude Code, then run /ralph-hero:delegate-test "hello world" to confirm delegation is wired end-to-end.`

#### Task 1.2: Add Delegation section to top-level repo README
- **files**: `/Users/dubiel/projects/ralph-hero/README.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New `## Delegation (optional)` section inserted between `## Configuration` (current line 236) and `## Development` (current line 251)
  - [ ] Section opens with a one-sentence summary: "ralph-hero ships an opt-in delegation wrapper that lets skills offload narrow sub-tasks (locator ranking, PR-description drafting, pass/fail classification) to a local or cheaper OpenAI-compatible endpoint. Default: off (bit-identical to no-delegation behavior)."
  - [ ] Env-var summary table with 5 rows: `RALPH_DELEGATE_ENABLED`, `RALPH_DELEGATE_TIMEOUT_SECONDS`, `RALPH_DELEGATE_LOG_PATH`, `RALPH_DELEGATE_<TASK_UPPER>_URL`, `RALPH_DELEGATE_<TASK_UPPER>_MODEL` (mirrors the table at `plugin/ralph-hero/README.md` lines 257-263 verbatim)
  - [ ] Quick-start block: three bash lines — `gemma-up`, `export RALPH_DELEGATE_ENABLED=true`, `/ralph-hero:delegate-test "hello"` — with a one-line caption
  - [ ] Three links: full plugin README section (`plugin/ralph-hero/README.md#delegation-optional`), authoring guide (`plugin/ralph-hero/docs/delegation-authoring.md`), conventions matrix (`plugin/ralph-hero/skills/shared/delegation-conventions.md`)
  - [ ] One link to the F5 telemetry surface: `ralph status --delegation` (no separate doc; the plugin README's audit-log subsection covers it)
  - [ ] No env-var detail repeats beyond the table (depth lives in the plugin README — top-level is discoverability)

#### Task 1.3: Add Delegation subsection to root CLAUDE.md Architecture block
- **files**: `/Users/dubiel/projects/ralph-hero/CLAUDE.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] New `### Delegation` subsection added inside the `## Architecture` block, positioned between `### Caching Strategy` and `### Hook Patterns`
  - [ ] Opens with one sentence describing what delegation is: "Optional, off-by-default LLM delegation wrapper at `plugin/ralph-hero/scripts/ralph-delegate.sh`. Skills with narrow text-in/text-out sub-tasks (summarize, classify, rerank) can offload work to a local Gemma server or cheaper OpenRouter model via the `Bash` tool."
  - [ ] One sentence on the gate: "Master toggle is `RALPH_DELEGATE_ENABLED` — unset (the default) means exit 126 immediately and bit-identical no-op behavior."
  - [ ] Current-integration callout listing the four merged delegating skills/agents: "Currently wired: `codebase-locator` (F4a), `pr-agent` (F4b), `val-agent` (F4c), and the reference skill `delegate-test` (F3)."
  - [ ] Telemetry callout: "Telemetry: `ralph_hero__delegation_stats` MCP tool + `ralph status --delegation` CLI read the JSONL audit log at `~/.ralph-hero/delegate.log`. See `plugin/ralph-hero/README.md` § Delegation (optional)."
  - [ ] Authoring pointer: "When to add delegation to a new skill: read `plugin/ralph-hero/docs/delegation-authoring.md` and check the eligible/ineligible matrix in `plugin/ralph-hero/skills/shared/delegation-conventions.md` first."
  - [ ] Total subsection length: 5-8 lines (this is a quick-reference doc, not a tutorial)

#### Task 1.4: Update F3 conventions doc — promote F5 reference to "merged"
- **files**: `plugin/ralph-hero/skills/shared/delegation-conventions.md` (modify)
- **tdd**: false
- **complexity**: low
- **depends_on**: null
- **acceptance**:
  - [ ] Line 33 sentence rewritten from "...keeps the log analyzable by upcoming telemetry tooling (Feature F5 of [#965](https://github.com/cdubiel08/ralph-hero/issues/965))." to "...keeps the log analyzable by the delegation-stats telemetry surface (Feature F5 of [#965](https://github.com/cdubiel08/ralph-hero/issues/965), merged) — see [`README.md` § Audit log](../../README.md#audit-log)."
  - [ ] No other `upcoming` references in this file related to F5
  - [ ] No new content added beyond the one-sentence rewrite

### Phase Success Criteria

#### Automated Verification:
- [x] `npm run build` in `plugin/ralph-hero/mcp-server/` — no errors (no TS changes expected, but build must remain green for the merge)
- [x] `grep -nri "upcoming" plugin/ralph-hero/skills/shared/delegation-conventions.md` — zero matches
- [x] `grep -c "## Delegation" /Users/dubiel/projects/ralph-hero/README.md` — at least 1
- [x] `grep -c "### Delegation" /Users/dubiel/projects/ralph-hero/CLAUDE.md` — at least 1
- [x] `grep -c "Step 6c" plugin/ralph-hero/skills/setup/SKILL.md` — at least 1
- [x] `grep -c "ralph-delegate.sh --health-check" plugin/ralph-hero/skills/setup/SKILL.md` — at least 1 (the probe invocation)
- [x] `grep -c "RALPH_DELEGATE_ENABLED" plugin/ralph-hero/skills/setup/SKILL.md` — at least 1 (the env var the skill writes)

#### Manual Verification:
- [ ] Live test 1 (probe succeeds): run `gemma-up` on the dev machine, then `/ralph-hero:setup` (or read through the SKILL.md Step 6c flow mentally) — confirm the AskUserQuestion appears with both options
- [ ] Live test 2 (probe fails): with no LLM server running, repeat the setup flow — confirm no prompt fires, no settings-file write, and the Final Report shows "Delegation: endpoint not detected — skipped"
- [ ] Live test 3 (already enabled): set `RALPH_DELEGATE_ENABLED=true` in the shell env, re-run setup, confirm the skip-with-note path is taken
- [ ] Top-level README rendered in a Markdown previewer — section heading sits at a sensible point in the TOC, env-var table renders cleanly
- [ ] Root CLAUDE.md `### Delegation` subsection fits the surrounding Architecture-block density (5-8 lines, not a wall of text)

**Creates for next phase**: nothing — F6 is the epic's final issue. After this phase the parent epic GH-965 advances to Done. The Final Report next-steps in Task 1.1 point operators at `/ralph-hero:delegate-test` as the smoke-test entry point; no further follow-up work is queued.

---

## Integration Testing

- [ ] End-to-end fresh-install simulation: start from a clean settings file with no delegation env vars, run setup with `gemma-up` running, answer "Yes" — confirm `RALPH_DELEGATE_ENABLED=true` appears in the scope-appropriate settings file and `/ralph-hero:delegate-test "hello"` succeeds with delegation enabled
- [ ] No-LLM-server simulation: same clean settings, no `gemma-up`, run setup — confirm no prompt, no settings change, no error in setup output
- [ ] Skim of the four edited files for cross-references — every link from the top-level README and root CLAUDE.md resolves to an existing path; every reference from the setup skill's Step 6c to other steps (Step 1b for scope detection, Step 5 for settings-file write pattern, Step 7 for Final Report) is a valid in-document anchor

## References

- Epic: https://github.com/cdubiel08/ralph-hero/issues/965
- This issue: https://github.com/cdubiel08/ralph-hero/issues/1192
- Parent epic plan: [thoughts/shared/plans/2026-05-03-GH-0965-llm-delegation-via-bash-epic.md](2026-05-03-GH-0965-llm-delegation-via-bash-epic.md)
- F1 (foundation): [thoughts/shared/plans/2026-05-12-GH-1185-ralph-delegate-sh-foundation.md](2026-05-12-GH-1185-ralph-delegate-sh-foundation.md)
- F3 (authoring): [thoughts/shared/plans/2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md](2026-05-12-GH-1187-skill-authoring-pattern-delegate-test.md)
- F5 (telemetry): [thoughts/shared/plans/2026-05-12-GH-1191-delegation-telemetry.md](2026-05-12-GH-1191-delegation-telemetry.md)
- F1 wrapper: `plugin/ralph-hero/scripts/ralph-delegate.sh` (especially `--health-check` flag at lines 65-66)
- F3 docs: `plugin/ralph-hero/docs/delegation-authoring.md`, `plugin/ralph-hero/skills/shared/delegation-conventions.md`
- F5 tool: `plugin/ralph-hero/mcp-server/src/tools/delegation-tools.ts` (registers `ralph_hero__delegation_stats`)
- Plugin README delegation section (canonical reference): `plugin/ralph-hero/README.md` lines 249-307
- Setup skill (host of new Step 6c): `plugin/ralph-hero/skills/setup/SKILL.md`
