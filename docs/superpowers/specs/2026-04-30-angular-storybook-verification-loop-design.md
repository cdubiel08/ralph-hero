# Angular + Storybook Component Verification Loop

**Date:** 2026-04-30
**Status:** Draft

## Problem

An Angular 21 dev has Storybook installed but is still doing significant manual click-through testing for every component change. Storybook gives them isolated rendering — call it the first 50% — but the remaining 50% requires a human eye for: experimenting with inputs (rebuild + reload to swap props), verifying interactions (clicking and typing through stories), catching visual regressions, and surfacing accessibility/edge-case issues. The dev's workflow muscle memory falls back on `ng serve` + browser, which is slow and error-prone.

The dev is a downstream user of the asker, not the asker themselves, so the workflow needs to be adoptable — clear handoff, low cognitive overhead — not just feasible. ralph-playwright is available to install in the dev's repo.

## Goals & Success Criteria

After this design lands, the dev's component-change loop should hit all four:

1. **Fast, unattended inner-loop verification** — change a component, run one focused command on its affected stories, get a pass/fail report in under a minute. Full-suite runs (CI) may take longer; that's acceptable. The dev never has to click through stories by hand to confirm their change.
2. **No-rebuild input experimentation** — try different prop combinations via Storybook Controls, never via "edit story file → reload".
3. **Visual regressions caught pre-merge** — pixel drift surfaces in CI on PRs touching components, not by a teammate noticing post-merge.
4. **Accessibility regressions caught automatically** — axe-core runs against every story without the dev having to remember.

## Constraints

- **Angular 21**, **Storybook installed** — exact version + addon set verified during day-zero audit. Storybook **≥6.4** is acceptable (`play` functions land in 6.4); **7+ preferred** for ergonomics (`@storybook/test` unified package). Anything <6.4 forces a Phase 0 Storybook upgrade. Angular 21 + an old Storybook is implausible since Angular 21's preset requires Storybook 8/9, but the audit checks anyway.
- **Separate repo** from the ralph-hero workspace; ralph-playwright can be installed there
- **Chromatic available** — paid/access-granted; usable as the canonical visual regression backend (resolves the "where do baselines live" decision)
- Solution should produce visible value early; the dev shouldn't do weeks of prep before seeing gains
- Adoption is the binding constraint — design assumes a human champion (the asker) handing off, not just docs

## Solution Overview

Two parallel tracks that converge on a canonical pipeline split across **two loops** — fast local inner loop (ralph-playwright) and canonical CI loop (Chromatic + ralph-playwright a11y).

```
                                       ┌──────────────────────────────┐
TRACK A: Storybook quality             │  TERMINAL STATE (Phase 3)    │
(closes "rebuild to test inputs"       │                              │
 and "click stories to check states")  │  Local inner loop:           │
                                       │    npm run verify  →         │
  A1. Hygiene                          │   • ralph-playwright         │
  - args/argTypes on every story  ────►│     storybook-test (play)    │
  - Controls usable in Storybook UI    │   • ralph-playwright         │
  - input experimentation: no rebuild  │     a11y-scan (axe)          │
                                       │                              │
  A2. Interaction tests                │  CI per-PR canonical:        │
  - play functions on high-value ────► │   • Chromatic (visual        │
    stories using @storybook/test      │     regression + cross-      │
  - automated assertions for clicks,   │     browser snapshots,       │
    typing, conditional renders        │     web UI for approval)     │
                                       │   • ralph-playwright         │
                                       │     storybook-test + a11y    │
                                       │                              │
                                       │  Report: pass/fail per       │
                                       │  story + Chromatic UI link.  │
                                       └──────────────────────────────┘
                                                       ▲
                                                       │
TRACK C: Co-pilot reviewer                            converges
(immediate value, no story-side prep)                  │
                                                       │
  C1. Wire ralph-playwright explorer/  ───────────────►┘
      story-runner-agent against
      Storybook URLs as a "second
      pair of eyes"
  - Autonomous navigation, screenshots,
    a11y snapshots, console errors
  - Drift vs last-known-good (local cache)
  - Works on stories with OR without
    play functions
```

**Division of labor (Phase 3 terminal state):**

| Loop | Tool | Frequency | What it catches |
|---|---|---|---|
| Inner loop (dev's editor) | ralph-playwright `explorer-agent` (C1) | Every component change, on demand | Console errors, a11y obvious-fails, visual surprise — fast feedback |
| Pre-push local | ralph-playwright `storybook-test` + `a11y-scan` (A3 local) | Before pushing | Interaction regressions, axe failures |
| CI per-PR canonical | **Chromatic** + ralph-playwright `storybook-test` + `a11y-scan` (A3 CI) | Every PR | Visual regressions (cross-browser), interaction regressions, a11y |

**Why two tracks:** Track A is the durable solution (scripted assertions, repeatable, CI-ready). Track C delivers value on day one without requiring story-side test code, and uses the same Playwright + Storybook substrate that Track A's local inner loop uses — so investment in C isn't thrown away. As play functions land in Track A, the C-track agent's run upgrades from "exploration" to "scripted run". Same machine, gradually getting smarter.

**Why Chromatic for CI:** purpose-built for Storybook visual regression, made by the Storybook team. Cloud-hosted baselines (no `.png` artifacts in the repo, no artifact-server decision to make), web UI for approving diffs (much better than reviewing PNGs in PR comments), cross-browser snapshots come free, and an off-the-shelf GitHub Action. The canonical CI uses the Chromatic GitHub Action directly (declarative, runs on every PR). The existing `visual-diff` skill (which wraps `npx chromatic`) remains useful for **ad-hoc local Chromatic invocations** — e.g., "let me preview the diff before I push" — but isn't part of the canonical CI pipeline.

**Convergence at Phase 3:** the C/A distinction dissolves. `storybook-test` runs play functions where they exist; `explorer-agent` is still available for ad-hoc reviews of components that don't yet have stories. Same substrate, different invocation modes.

## ralph-playwright Surface Used

From `plugin/ralph-playwright/`:

| Skill / Agent | Status | Used in | Role |
|---|---|---|---|
| `setup` skill | exists | Day-zero (called by `storybook-onboard`) | Installs Playwright config, points it at the dev's Storybook URL |
| `explorer-agent` | exists | Phase 1 (C1), ongoing (called by `storybook-review`) | Freeform navigation of stories, captures screenshots/console/a11y |
| `story-gen` skill | exists | Phase 2 (A2) | Proposes `play` functions for components — dev reviews/edits |
| `storybook-test` skill | exists | Phase 3 (A3) | Executes `play` functions across all stories with assertions (local + CI) |
| `a11y-scan` skill | exists | Phase 3 (A3) | axe-core against every story (local + CI) |
| `story-runner-agent` | exists | Phase 3 (A3) | Executes deterministic scripted runs (vs. explorer's freeform) |
| **`storybook-onboard` skill** | **to be authored** | Day-zero (user entry point) | One-shot setup: audits Storybook, confirms Chromatic, runs `setup`, fires smoke run |
| **`storybook-review` skill** | **to be authored** | Phase 1 inner loop (user entry point) | Daily verification: dispatches `explorer-agent` against a story-id or component path, returns sub-minute report |
| `visual-diff` skill | exists | Phase 3 (A3) optional local | Wraps `npx chromatic` for ad-hoc local visual diffs; the canonical CI uses the Chromatic GitHub Action directly, but the skill is useful for "preview the diff before I push" |

**External tooling:**

| Tool | Used in | Role |
|---|---|---|
| **Chromatic** | Phase 3 (A3) CI | Cloud-hosted visual regression baselines + cross-browser snapshots + web UI for diff approval |
| **`@storybook/test`** | Phase 2 (A2) | Storybook's built-in interaction testing utilities for `play` functions |
| **`@storybook/test-runner`** | Phase 3 (A3) | Underlying runner for `play` functions (used by ralph-playwright `storybook-test` skill and Chromatic alike) |

## Entry Point / User Invocation

The dev's surface is **two new ralph-playwright skills** plus existing skills they reuse. Authoring the two new skills is a Phase 0 prerequisite of this design.

### `/ralph-playwright:storybook-onboard` — one-time Day-Zero setup

The dev runs this once when adopting the verification loop. The skill executes the Day-Zero Kickoff deterministically:

1. Audits Storybook version (≥6.4 acceptable; flag <6.4 as upgrade-required), addon set, args usage rate, presence of any existing `play` functions, Angular preset compatibility
2. Confirms Chromatic access — project token resolvable from env, Chromatic GitHub App installed on the repo, dev has approval rights
3. Calls existing `setup` skill to wire ralph-playwright against the dev's Storybook URL
4. Fires a smoke `explorer-agent` run against one representative story to validate end-to-end
5. Returns a structured report: green/yellow/red per check, plus a "next step" sentence

**Idempotency:** safe to re-run. Re-runs detect existing setup and skip already-completed steps.

**Output example:**
```
✓ Storybook 9.0.4 detected — addons: controls, interactions, a11y
✓ Chromatic token present (CHROMATIC_PROJECT_TOKEN)
⚠ Chromatic GitHub App not installed on this repo — install at https://github.com/apps/chromatic
✓ ralph-playwright setup complete (config: ./.playwright-cli/storybook.yaml)
✓ Smoke run: ButtonComponent/Default — 0 console errors, 0 a11y violations
Next: install Chromatic GitHub App, then run /ralph-playwright:storybook-review on your next component change.
```

### `/ralph-playwright:storybook-review <story-id-or-component>` — daily inner-loop

The dev runs this after every component change. The skill dispatches `explorer-agent` against the specified story-id (or all stories matching a component path) and produces a sub-minute report: screenshots, console errors, a11y snapshot, drift vs. local cached baseline.

**Argument forms:**
- `storybook-review button-component--default` — single story
- `storybook-review button-component--*` — all stories for a component
- `storybook-review --changed` — auto-detect stories affected by current git diff

**Output:** pass/fail per story + screenshot diffs as artifacts referenced in the report.

### Why two skills, not one

`storybook-onboard` is a **one-time, idempotent setup** operation; `storybook-review` is a **many-times-per-day verification** operation. Different cognitive footprint, different mental model. Folding them into one skill with mode flags would muddy adoption — the dev needs to mentally distinguish "set up" from "run a check" regardless, so the skill names should reflect that.

### Surface summary for the dev

| Phase | What the dev runs | Frequency |
|---|---|---|
| One-time bootstrap | `/ralph-playwright:storybook-onboard` | Once per project |
| Inner loop (every change) | `/ralph-playwright:storybook-review <story-id>` | Many times per day |
| Writing play functions | `/ralph-playwright:story-gen <component>` (existing) | When adding/changing a component |
| Pre-push / local canonical | `npm run verify` (shell script wired to `storybook-test` + `a11y-scan` skills) | Before pushing |
| CI per-PR | Automated — no dev action needed | Every PR |

### Discovery

Skills are discoverable via Claude Code's `/ralph-playwright` autocomplete. The asker's 15-min handoff covers exactly two commands: `storybook-onboard` once, `storybook-review` thereafter.

## Phases

### Phase 1 — Foundation (~1–3 days, depends on existing story count)

**A1: Storybook hygiene**
- Audit existing stories; categorize as "uses `args`" vs "hardcoded inputs / template-only"
- Migrate hardcoded stories to `args` + `argTypes` so Storybook Controls is a real surface for input experimentation
- Convention doc for new stories: every story uses `args`; every prop has an `argType` with control type set
- Install (if missing): `@storybook/addon-controls` (default in Storybook 7+), `@storybook/addon-interactions`, `@storybook/addon-a11y`

**C1: Co-pilot reviewer wired up**
- ralph-playwright installed in the dev's repo; `setup` skill run against the Storybook URL
- Single command (Claude slash-command or shell wrapper) that invokes `explorer-agent` against a story-id or set of story-ids and produces a report: screenshots, console errors, a11y snapshot, observed visual diff vs. last-run baseline
- C1 baselines are **local cache only** (in `.gitignore`) — they support the dev's <60s "did anything obviously change" inner loop. Chromatic owns the canonical baselines (Phase 3); the C1 cache is throwaway state, not a source of truth.

**Phase 1 done = the dev no longer rebuilds to swap inputs (A1) AND has a one-command co-pilot review they can invoke any time (C1).** The "50% gap" is materially closed for the first time, with no story-side test code yet.

### Phase 2 — Scripted assertions where they earn it (incremental, ongoing)

**A2: Play functions on high-value stories**
- Heuristic for "high-value": complex interactions (forms, async loading), components with prior regressions, frequently-changed components, anything with conditional rendering paths
- Use `@storybook/test` (Storybook's built-in, no extra dep) to write `play` functions: scripted clicks, typing, assertions on rendered output
- `story-gen` skill proposes play functions for newly-touched components — dev reviews/edits rather than writes from scratch
- Trivial display components stay simple — no `play` function required

**Track C continues**
- Explorer-agent reviews stay valuable for stories that don't yet have play functions
- When a story *does* have a play function, the C-track agent can execute it (graduating from exploration to scripted run) — same agent, smarter substrate

**Phase 2 done = scripted regression catches for components that matter most; C-track backstop covers everything else.**

### Phase 3 — Canonical pipeline (~1–2 days)

**A3: Two-loop verification — local fast loop + CI canonical loop.**

**Local: `npm run verify`** (name dev's choice)
- ralph-playwright `storybook-test` skill: executes play functions across changed stories with assertions
- ralph-playwright `a11y-scan` skill: axe-core against changed stories
- Optimized for the inner loop — under a minute on a focused subset; full-suite on demand
- Does **not** run Chromatic locally (Chromatic uploads to cloud and waits — better suited to CI)

**CI per-PR canonical pipeline**
- **Chromatic** runs via the `chromatic-com/github-action`: builds Storybook, captures snapshots across configured browsers, uploads to Chromatic, surfaces visual diffs in the Chromatic web UI; PR check passes/fails based on whether all changed snapshots are approved
- ralph-playwright `storybook-test` runs as a separate CI job: executes all play functions, fails the check on assertion errors
- ralph-playwright `a11y-scan` runs as a third CI job: axe-core across all stories
- All three jobs run in parallel; PR is greenlit only when all pass

**Visual baseline approval flow (Chromatic)**
- Diffs surface in the Chromatic web UI per PR
- Dev or reviewer approves changes there (not via committing PNGs)
- Approval is durable — once approved, that snapshot becomes the new baseline
- No "baseline drift" via git noise; no merge conflicts on `.png` files

**Track C role at terminal state**
- `explorer-agent` still available for ad-hoc "go explore this new component I haven't written stories for yet" — useful during development before a story lands in the suite
- The C/A distinction dissolves: same Playwright+Storybook substrate, the agent picks the right mode based on whether play functions exist

**Phase 3 done = all four success criteria from §Goals are met.** Cross-browser regression catches come free as a bonus from Chromatic.

## Day-Zero Kickoff (before Phase 1 starts)

**Phase 0 prerequisite:** the two new skills (`storybook-onboard`, `storybook-review`) must be authored in `plugin/ralph-playwright/skills/` before Day-Zero runs against any dev's repo. See §Entry Point / User Invocation for skill specs.

Once Phase 0 ships, Day-Zero is a single dev action plus a pairing session:

1. **Dev runs `/ralph-playwright:storybook-onboard`** in their repo. The skill performs all five mechanical steps (Storybook audit, Chromatic check, ralph-playwright setup, smoke run, status report) and returns a structured pass/fail with next-step guidance.
2. **Resolve any reds from the report** — typically Chromatic GitHub App install, Storybook upgrade if <6.4, or missing addon installs. The skill is idempotent; re-running picks up where it left off.
3. **15-min pairing handoff** — the asker walks the dev through one full loop: change a component → run `/ralph-playwright:storybook-review <story-id>` → read the report. Adoption depends on the dev internalizing the loop, not on docs.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Dev does hygiene migration but never writes play functions; gets stuck at Phase 1 | Phase 1 alone closes a real chunk of pain. Frame Phase 2 as opt-in per high-value story, not a backlog burden. |
| Visual baselines drift constantly, nobody trusts them | Chromatic owns baselines via its web UI — explicit human approval per change, no auto-update, no PNG-in-git noise. Establish baselines *after* hygiene migration completes, not before. |
| Chromatic costs balloon — too many snapshots per PR | Configure `--only-changed` mode in the Chromatic action so only stories affected by the diff get re-snapshotted. Restrict cross-browser to the browsers that actually matter. Day-zero confirms project's snapshot quota. |
| Chromatic outage blocks PRs | Chromatic check can be marked as non-blocking in branch protection if SLA matters more than visual gates. Local `verify` (ralph-playwright) is independent of Chromatic and keeps working. |
| C-track explorer-agent runs slow / token-heavy; dev stops invoking it | Scope agent to a *single story or small story-id set per invocation*, not the whole Storybook. Cache snapshots between runs. |
| Storybook version <6.4 (no `play` function support) | Day-zero audit catches this. Storybook upgrade becomes a Phase 0 prerequisite if needed. Implausible with Angular 21 but worth confirming. |
| Angular 21 + Storybook preset compatibility lag (Angular 21 is brand new — late-2025 release) | Day-zero audit catches this. If Storybook's Angular preset lags, design adapts (use Component Story Format directly, drop reliance on framework-specific helpers). |
| CI cost balloons with `verify` on every PR | Run `storybook-test` + `a11y-scan` always (cheap, local-runner); Chromatic uses `--only-changed` mode to limit snapshots; full a11y suite on a schedule if per-PR proves expensive. |
| Dev ignores the new workflow | Asker controls adoption via the day-zero pairing session; design assumes a human champion, not just docs. If pairing doesn't take, escalate before continuing investment. |

## Open Items (resolved during day-zero)

- Storybook version + addon set (only ascertainable by reading the dev's repo)
- CI flavor (GitHub Actions vs. other) — Chromatic ships first-class GitHub Actions support; other CI systems work via the `chromatic` CLI but need more glue
- Chromatic project setup state — token availability, Chromatic GitHub App installed, snapshot quota
- Existing test runner config (Jest / Karma / Web Test Runner) — affects whether `verify` coexists with or replaces existing test commands
- Whether the dev's repo has an existing CI pipeline at all
- Cross-browser scope — which browsers actually matter for this dev's user base (affects Chromatic snapshot cost)

## Non-Goals

- **Replacing Angular spec tests** (Jasmine/Karma/Jest) — this design augments visual/interaction coverage; existing spec tests stay as-is
- **End-to-end testing of the deployed app** — `test-e2e` skill exists in ralph-playwright but is out of scope for this design; the focus is component-level
- **Hand-rolling a cross-browser matrix in Playwright** — Chromatic delivers cross-browser snapshots at Phase 3 as a free win; we don't need to author per-browser Playwright runs separately
- **Migrating away from Storybook** — Storybook is the substrate; this design fortifies it, doesn't replace it

## References

- ralph-playwright skills: `plugin/ralph-playwright/skills/`
- ralph-playwright agents: `plugin/ralph-playwright/agents/`
- User story YAML schema: `plugin/ralph-playwright/schemas/`
- `@storybook/test` (Storybook's built-in interaction testing): https://storybook.js.org/docs/writing-tests/component-testing
- `@storybook/test-runner`: https://github.com/storybookjs/test-runner
- `@storybook/addon-a11y`: https://storybook.js.org/addons/@storybook/addon-a11y
- Chromatic visual regression: https://www.chromatic.com/docs/
- Chromatic GitHub Action: https://github.com/chromaui/action
- Chromatic `--only-changed` mode (TurboSnap): https://www.chromatic.com/docs/turbosnap/
