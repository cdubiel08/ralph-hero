---
date: 2026-07-22
status: draft
type: plan
tags: [form, capture, enrichment, caretake, ideas, ways-of-working]
github_issue: 1559
github_issues: [1559, 1560]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/1559
  - https://github.com/cdubiel08/ralph-hero/issues/1560
primary_issue: 1559
estimate: S
---

# Capture custody chain — polymorphic brain-dump capture + background enrichment (group: GH-1559 + GH-1560)

## Prior Work

- builds_on:: [[2026-07-19-GH-1550-ways-of-working-action-surfaces]] — the J1 research: `/ralph:form --mode draft` captures well but one-invocation-one-idea, and drafts never promote themselves; GH-706 settled "extract first, confirm after."
- builds_on:: [[2026-07-19-GH-1550-epic-ways-of-working-surfaces]] — epic Feature D constraints: capture never starts work; enrichment is cheap and non-committal; no new verb; no new scheduler; the frontmatter contract is the entire D→C interface.
- builds_on:: [[2026-07-19-GH-1554-plan-of-plans]] — the split record: #1559 (capture) ships first, #1560 (enrichment) depends on the frontmatter contract capture defines; both batch-plan as ONE group plan and ship as ONE PR (GH-1538).

## Overview

Two S-sized skill-surface changes forming the J1 custody chain **capture → enrich** (the "remind" leg is Feature C, out of scope). Phase 1 (GH-1559) extends `/ralph:form --mode draft` to accept thoughts at any maturity, split a multi-thought dump into N idea files (extraction first, confirmation after), and stamp the shared frontmatter contract (`status: draft`, `captured`). Phase 2 (GH-1560) adds an `enrich` step to the `caretake --mode all` heartbeat fan-out: for each `status: draft` idea file, three bounded lookups (locator sweep, `knowledge_search` prior art, related issues), appended under `## Enrichment`, flipping `status: draft → forming` with an `enriched` timestamp.

This is markdown-surface work (skill bodies + one new mode body); the only executable-code touchpoint is none — verification is grep/structure-based plus the CI doc-roster check.

## Current State Analysis

- `/ralph:form --mode draft` (`ralph/skills/form/SKILL.md` § "--mode draft"): 5 steps — capture intent → 2-3 clarifying questions → optional light grounding (one locator + optional `knowledge_search` dedup) → write ONE file from the draft template → report + suggest next verbs. One invocation produces exactly one idea file; there is no multi-thought path.
- Draft template (`ralph/skills/form/intake-shapes.md` § "Draft template"): frontmatter is `date / status: draft / type: idea / author / tags / github_issue: null`. **No `captured` timestamp field exists** — `date` is day-granular only. Nothing documents an idea-file lifecycle contract.
- `caretake --mode all` fan-out (`ralph/skills/caretake/SKILL.md` § "Step 1", "No args or --mode all" branch): serial 6-step list — hygiene → watch-pr → watch-upstream → watch-blockers → catch-up report → trends, with "Report consolidated outcome (one line per child — 6 total)". Mode bodies live in `ralph/skills/caretake/modes/<name>.md`, each setting `RALPH_SUBCOMMAND=<name>` and ending with a terminal token registered in `ralph/skills/caretake/outcome-tokens.md` (quick-reference table also in SKILL.md § "Per-mode terminal tokens").
- Watch modes in the fan-out no-op `IDLE` on an empty board and `SKIPPED` when the heartbeat fires off `main` — the pattern a new enrichment step must follow (idea files are tracked in git on main; enrichment edits must not land on a stray feature branch).

### Key Discoveries

- The draft template's `status: draft` already exists — the contract addition is `captured` (ISO timestamp) at capture time, and `enriched` + `status: forming` at enrichment time. Feature C will read exactly these three fields plus `## Enrichment`.
- GH-706's "extract first, confirm after" maps cleanly onto draft Step 2: for a multi-thought dump, extraction replaces interrogation — the confirmation is a single lightweight restatement of the N extracted titles, not per-thought clarifying questions.
- The fan-out's consolidated-outcome contract ("one line per child — N total") and the outcome-tokens quick-reference are the two synchronization points that must be updated together with the step list, or the caretaker's report contract drifts.

## Desired End State

1. `/ralph:form --mode draft` accepts a one-line thought and a multi-paragraph multi-thought dump equally; a dump containing N distinct thoughts yields N idea files in `thoughts/shared/ideas/`, each independently scannable.
2. Every draft-mode idea file carries `status: draft` and `captured: <ISO-8601 UTC timestamp>` in frontmatter (the shared D→C contract, documented in `intake-shapes.md`).
3. Capture performs zero board/project mutations; the form DEFAULT flow's completion may offer an optional "kick off?" (interactive only, declining is free) — draft mode itself never offers it.
4. `caretake --mode all` runs a new `enrich` step (inserted before `catch-up report`, making 7 fan-out children) — each heartbeat enriches every `status: draft` idea file: `## Enrichment` section (locator findings, prior art, related issues), `status: forming`, `enriched: <timestamp>`; already-`forming`-or-later files are skipped.
5. Enrichment is bounded to the three lookups — never a full research doc, never a sub-agent fan-out beyond the single locator.
6. The consolidated heartbeat outcome reports one line per child (now 7), and `ENRICHED <N>` / `Queue empty.` / `ENRICH SKIPPED <reason>` are registered terminal tokens.

### Verification

- `grep`-based structure checks listed per phase (template fields, section presence, fan-out list, token registration).
- `bash scripts/check-doc-rosters.sh` passes (CI doc-roster consistency — skill inventory unchanged, but run it to prove no roster drift).
- Manual: one real draft-mode dump producing 2 files; one `caretake --mode enrich` pass over a fixture draft.

## What We're NOT Doing

- No new verb, no new plugin surface — mode extension on `/ralph:form` + a step inside `caretake --mode all` (plus an individually-invocable `--mode enrich` body, consistent with every other fan-out member).
- No auto-advancement of captured thoughts into the pipeline; no board mutation anywhere in either child.
- No full `/ralph:research` doc per thought — enrichment is three bounded lookups.
- No new scheduler — enrichment rides the existing heartbeat.
- No Feature C consumption logic (the brief reads the contract later; this plan only defines and writes it).
- No changes to the form DEFAULT flow's dedup/research machinery beyond the completion-offer sentence.

## Design Decisions & Open Ambiguities

- **Multi-thought confirmation shape** — options: per-thought clarifying questions (draft Step 2 today); single post-extraction confirmation listing N titles; no confirmation at all. **Decided: single post-extraction confirmation.** GH-706's "extract first, confirm after" is the settled principle: the model extracts N candidate thoughts, presents the list once ("Captured as N ideas: … — merge any, drop any, or good as-is?"), and a "good"/no-answer default proceeds. Per-thought interrogation is the design-session-at-capture-time failure GH-706 forbids; zero confirmation risks silent mis-splits.
- **Where the "kick off?" offer lives** — options: draft-mode completion; default-flow completion only. **Decided: default-flow completion only** (per the epic's resolved decision and #1559's acceptance criteria — draft mode stays mutation-free and prompt-light; the offer appears where GitHub integration already exists).
- **Enrich as fan-out-only vs named mode** — options: inline step inside the `--mode all` branch; a real `modes/enrich.md` invoked by the fan-out. **Decided: real named mode.** Every other fan-out member is a named mode with its own body and terminal token; an inline step would be the only unnamed member, untestable in isolation and invisible to `--mode enrich` manual runs.
- **Enrichment commit behavior** — options: leave idea-file edits uncommitted; commit + push to main per pass. **Decided: commit + push** (`chore(ideas): enrich N idea file(s)`) — the heartbeat runs from main (SKIPPED otherwise, matching the watch modes' branch guard), and uncommitted enrichment would be invisible to other machines/sessions and lost to worktree cleanup.
- **`captured` vs reusing `date`** — options: reuse day-granular `date`; add ISO timestamp `captured`. **Decided: add `captured`.** The issue body names it explicitly; day granularity cannot order multiple same-day dumps for the brief's "incubating since" display.

None — no open design decisions.

## Implementation Approach

Two phases mapping 1:1 to the group members (GH-1538: one worktree `GH-1559`, one branch `feature/GH-1559`, ONE PR closing both). Phase 2 depends on Phase 1 because the enrichment body references the contract section Phase 1 authors in `intake-shapes.md`. All files are ralph-plugin markdown; a merge triggers `release-ralph.yml`.

## Phase 1: GH-1559 — polymorphic brain-dump capture

depends_on: null

### Overview

Extend the `--mode draft` body for any-maturity, multi-thought capture and author the idea-file frontmatter contract in `intake-shapes.md`.

### Changes Required

#### 1. Draft-mode body
**File**: `ralph/skills/form/SKILL.md`
**Changes**: In § "--mode draft": (a) Step 1 accepts any-maturity input explicitly (one-liners are valid; never demand structure); (b) Step 2 becomes maturity-aware — single thought: keep today's 2-3 questions with the existing "just capture it" escape; multi-thought dump: SKIP clarifying questions, extract N distinct thoughts, present ONE confirmation listing the N titles (merge/drop/proceed; proceed is the default); (c) Step 4 writes one file PER extracted thought using the draft template, each with `status: draft` + `captured` (current UTC ISO-8601) frontmatter; (d) Step 5 reports all N paths; (e) add an explicit "Capture never mutates board/project state" constraint line to the mode intro. In the DEFAULT flow's completion (after GitHub integration), add the optional interactive-only "kick off?" offer sentence: offer `/ralph:hero NNN` dispatch for the just-created issue; declining is free; NEVER offered in auto/headless contexts.

#### 2. Draft template + contract section
**File**: `ralph/skills/form/intake-shapes.md`
**Changes**: (a) Add `captured: YYYY-MM-DDTHH:MM:SSZ` to the draft template frontmatter (below `status: draft`); (b) new § "Idea-file lifecycle contract" documenting the shared D→C interface: `status: draft` (capture) → `forming` → `refined` (form "keep as refined idea" path, pre-existing); `captured` written at capture; `enriched` + `## Enrichment` section written by the enrichment pass (`caretake --mode enrich`); the daily brief (#1553) is the downstream reader. IMPORTANT — `forming` has TWO writers and the contract must reconcile both: form Step 6c's hand-off path already sets `status: forming` today, and enrichment also flips `draft → forming`. The section must state explicitly that (i) hand-off `forming` files are intentionally skipped by enrichment (selection keys on `status: draft` only), and (ii) the presence of `enriched` frontmatter / a `## Enrichment` section — NOT `status: forming` alone — is what signals an enrichment pass ran; the brief distinguishes "enriched" from "handed off" by those markers. Note that multi-thought dumps yield N files, each carrying its own `captured`.

### Success Criteria

#### Automated Verification
- [ ] `grep -n "captured:" ralph/skills/form/intake-shapes.md` shows the field in the draft template
- [ ] `grep -n "Idea-file lifecycle contract" ralph/skills/form/intake-shapes.md` finds the new section
- [ ] `grep -n "kick off" ralph/skills/form/SKILL.md` shows the offer in the DEFAULT flow completion (not in the draft-mode body)
- [ ] `grep -c "extract" ralph/skills/form/SKILL.md` ≥ 1 in the draft-mode section (multi-thought extraction documented)
- [ ] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] Run `/ralph:form --mode draft` with a 3-thought dump; confirm 3 files in `thoughts/shared/ideas/`, each with `status: draft` + `captured`, and exactly one confirmation prompt
- [ ] Confirm no `save_issue`/`create_issue` call occurs during draft capture

## Phase 2: GH-1560 — background enrichment pass

depends_on: [phase-1]

### Overview

Add `modes/enrich.md` to caretake, wire it into the `--mode all` fan-out before `catch-up report`, and register its terminal tokens.

### Changes Required

#### 1. New mode body
**File**: `ralph/skills/caretake/modes/enrich.md` (new)
**Changes**: Mode body: `export RALPH_SUBCOMMAND=enrich`. Branch guard first (`git branch --show-current` must be `main`, else emit `ENRICH SKIPPED — branch <name> is not main`, matching the watch-mode pattern). Glob `thoughts/shared/ideas/*.md`; select files with frontmatter `status: draft` (skip `forming`/`refined`/anything else — idempotency). Empty selection → `Queue empty.` **Per-pass cap**: process at most the 5 OLDEST (by `captured`) `status: draft` files per invocation; report any remainder in the summary line so a backlog drains across heartbeats instead of straining one tick. Per selected file (bounded, serial): one `Agent(subagent_type="ralph:codebase-locator", ...)` sweep on the idea's topic; one `knowledge_search` prior-art query (skip silently if unavailable); one related-issues lookup (`list_issues` keyword search, limit 5). Append a `## Enrichment` section (three subsections: Codebase, Prior art, Related issues — one-line entries, no prose expansion); update frontmatter `status: forming` + `enriched: <UTC ISO-8601>`. Explicit bound: NEVER dispatch research agents beyond the single locator; NEVER create issues or mutate board state. After the pass: `git add thoughts/shared/ideas && git commit -m "chore(ideas): enrich <N> idea file(s)" && git push origin main` (skip commit when N=0). **Push-failure rule**: on non-fast-forward reject, `git pull --rebase origin main` and retry once; on second failure emit `ENRICH SKIPPED push-rejected` (commit stays local). Commit-to-main precedent: `modes/postmortem.md` already commits + pushes from a caretake mode. Terminal token: `ENRICHED <N>`.

#### 2. Fan-out wiring + token registration
**File**: `ralph/skills/caretake/SKILL.md`
**Changes**: Insert `Skill("ralph:caretake", args="--mode enrich")` as the step before `Skill("ralph:catch-up", args="--mode report")` in the `--mode all` branch (enrichment before report, so the brief/report sees post-enrichment state); update "one line per child — 6 total" → "7 total"; add `modes/enrich.md` to the Mode bodies list; add `enrich: ENRICHED <N> | Queue empty. | ENRICH SKIPPED <reason>` to the Per-mode terminal tokens quick reference; add an `enrich` row to the mode table AND add enrich to the `all` row's fan-out summary text; add enrich to the frontmatter `description` mode list and the `argument-hint` mode enum; fix the mode-count prose to **"Twelve named modes"** (the current "Ten" is already stale — 11 mode bodies exist on disk before this change; enrich makes 12).
**File**: `ralph/skills/caretake/outcome-tokens.md`
**Changes**: Register the three enrich tokens mirroring the existing per-mode bullet-list shape (the file uses bullet lists with prose, not tables). Add one line to § Loop continuation noting enrich is a fan-out child (drains via the heartbeat, `Queue empty.` when no drafts).

### Success Criteria

#### Automated Verification
- [ ] `test -f ralph/skills/caretake/modes/enrich.md`
- [ ] `grep -n "mode enrich" ralph/skills/caretake/SKILL.md` shows the fan-out step ordered before the catch-up report step
- [ ] `grep -n "ENRICHED" ralph/skills/caretake/outcome-tokens.md ralph/skills/caretake/SKILL.md` shows token registration in both files
- [ ] `grep -c "7 total" ralph/skills/caretake/SKILL.md` = 1 (consolidated-outcome count updated)
- [ ] `bash scripts/check-doc-rosters.sh` passes

#### Manual Verification
- [ ] Create a fixture `status: draft` idea file; run `/ralph:caretake --mode enrich`; confirm `## Enrichment` appended, `status: forming`, `enriched` stamped, and the change committed to main
- [ ] Re-run the mode; confirm the file is skipped (`Queue empty.`)

## Testing Strategy

### Unit Tests
None — markdown-surface change; no executable code touched.

### Integration Tests
CI's doc-roster consistency check (`scripts/check-doc-rosters.sh`) and ShellCheck (no hook scripts touched — should be trivially green).

### Manual Testing Steps
1. Draft-mode multi-thought dump → N files with contract frontmatter (Phase 1 manual check).
2. `/ralph:caretake --mode enrich` over a fixture draft → enriched + committed (Phase 2 manual check).
3. Full `/ralph:caretake --mode all` heartbeat → 7-line consolidated outcome including the enrich line.

## Migration Notes

Purely additive skill-surface change; merged via one PR closing both #1559 and #1560 (parent #1554 advances server-side). `release-ralph.yml` bumps the plugin version on merge. Existing idea files without `captured` remain valid (`draft` selection keys on `status` only; the brief treats a missing `captured` as unknown-age). Rollback = revert the PR; no data migration (already-enriched files simply stop being re-processed, which is the idempotent behavior anyway).

## References

- Issues: https://github.com/cdubiel08/ralph-hero/issues/1559, https://github.com/cdubiel08/ralph-hero/issues/1560 (parent #1554, epic #1550)
- Split record: `thoughts/shared/plans/2026-07-19-GH-1554-plan-of-plans.md`
- Epic: `thoughts/shared/plans/2026-07-19-GH-1550-epic-ways-of-working-surfaces.md` (Feature D)
- Research: `thoughts/shared/research/2026-07-19-GH-1550-ways-of-working-action-surfaces.md` (J1 findings; GH-706 principle)
- Surfaces: `ralph/skills/form/SKILL.md`, `ralph/skills/form/intake-shapes.md`, `ralph/skills/caretake/SKILL.md`, `ralph/skills/caretake/modes/`, `ralph/skills/caretake/outcome-tokens.md`
