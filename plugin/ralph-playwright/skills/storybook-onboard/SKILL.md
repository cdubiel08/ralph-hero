---
name: ralph-playwright:storybook-onboard
description: One-shot Day-Zero setup for the Angular + Storybook verification loop. Audits Storybook version + addons, confirms Chromatic access (project token, GitHub App, approval rights), delegates to the ralph-playwright setup skill, runs a smoke explorer-agent against one representative story, and emits a green/yellow/red status report. Idempotent — safe to re-run.
---

# Storybook Onboard — One-Shot Day-Zero Setup

This skill performs the Day-Zero kickoff for the Angular + Storybook component verification loop (see `docs/superpowers/specs/2026-04-30-angular-storybook-verification-loop-design.md`). Run it once when adopting the loop in a project. Re-running is safe — completed steps detect existing state and skip ahead.

## Step 1: Detect Storybook setup

Read the project's Storybook config to determine version, framework preset, and addon set.

```bash
# Storybook version (must be ≥6.4 for play functions; ≥7 preferred for @storybook/test ergonomics)
npx storybook --version

# Framework preset and addons
cat .storybook/main.js .storybook/main.ts .storybook/main.cjs 2>/dev/null | grep -E "framework|addons"

# Optional: any existing play functions present?
grep -r "play:" --include="*.stories.ts" --include="*.stories.tsx" --include="*.stories.js" -l . | head -10
```

**Decision matrix:**
- Version **≥7.0**: ✅ green — full design supported, `@storybook/test` available
- Version **6.4–6.x**: ⚠ yellow — design works but use `@storybook/jest` + `@storybook/testing-library` instead of unified `@storybook/test`. Note in the report.
- Version **<6.4**: ❌ red — `play` functions unsupported. Halt the onboard and direct the user to upgrade Storybook (`npx storybook@latest upgrade`) before re-running.

**Required addons** (install if missing):
```bash
# Check
cat package.json | grep -E "@storybook/addon-controls|@storybook/addon-interactions|@storybook/addon-a11y"

# Install whichever are absent
npm install --save-dev @storybook/addon-controls @storybook/addon-interactions @storybook/addon-a11y
```

After installing, the user must register the new addons in `.storybook/main.{js,ts,cjs}` (under `addons:`). The skill flags this as a manual follow-up if any were just installed.

## Step 2: Confirm Chromatic access

The canonical CI uses Chromatic. Verify three things are in place.

```bash
# 1. Project token resolvable
test -n "$CHROMATIC_PROJECT_TOKEN" && echo "token: present" || echo "token: MISSING"

# 2. chromatic CLI installed (will be needed at npm install --save-dev chromatic time if missing)
cat package.json | grep -q '"chromatic"' && echo "chromatic dep: present" || echo "chromatic dep: missing"
```

**3. GitHub App** — manual check (cannot be automated): visit the repo's GitHub Settings → Integrations → GitHub Apps and confirm "Chromatic" is installed. If absent, install at https://github.com/apps/chromatic. The skill flags this as a manual follow-up in the report.

**4. Approval rights** — manual check: confirm at https://www.chromatic.com that the user logged in as has reviewer/approval permission on this Chromatic project. The skill flags this as a manual follow-up in the report.

If `CHROMATIC_PROJECT_TOKEN` is missing, ask the user to obtain it from the Chromatic project page and either:
- Add to shell rc: `export CHROMATIC_PROJECT_TOKEN=...`
- Or set in CI secrets (for the GitHub Action — not blocking for Phase 1 inner loop)

The token only blocks Phase 3 (CI canonical pipeline). Phases 1–2 work without it.

## Step 3: Run ralph-playwright setup

Delegate to the existing setup skill to install `playwright-cli` and create the `playwright-stories/` directory.

If `playwright-cli --version` already prints a version AND `playwright-stories/` exists, skip this step (idempotency). Otherwise instruct the user:

```
Run: /ralph-playwright:setup
```

After the user runs setup, validate:
```bash
playwright-cli --version
test -d playwright-stories && echo "stories dir: ok"
```
Expected: a version string and `stories dir: ok`. If either fails, surface the failure in the final report and halt before the smoke run.

## Step 4: Smoke run

Pick one representative story and run `explorer-agent` against it to validate end-to-end reachability of Storybook, Playwright, and the agent harness.

**Story selection (in priority order):**
1. If `STORYBOOK_ONBOARD_SMOKE_STORY` env var is set → use its value as the story id
2. Else: pick the first story exported from any `*.stories.ts` file matching `Button`, `Card`, or `Input` in its title
3. Else: pick the first story alphabetically from any `*.stories.ts` in `src/`

Generate a session name: `<date>-storybook-onboard-smoke` (e.g., `2026-04-30-storybook-onboard-smoke`).

**Spawn `explorer-agent`** with:
- `url`: `http://localhost:6006/iframe.html?id=<story-id>` (or the project's Storybook URL with port substitution if non-default)
- `goal`: "Verify the story renders without console errors or unexpected a11y violations; capture one screenshot and one accessibility snapshot."
- `session`: the generated session name
- `mode`: `ref` (default — accessibility-snapshot navigation is sufficient for a smoke run)

**Prerequisite:** The user's Storybook dev server must be running (`npm run storybook` typically). If `curl -fsS http://localhost:6006 >/dev/null 2>&1` fails, ask the user to start Storybook in another terminal and re-run `/ralph-playwright:storybook-onboard`. The skill is idempotent — re-runs pick up at this step.

The agent writes a journey trace to `.playwright-cli/<session>/journey-trace.yaml` and per-step artifacts as `.playwright-cli/<session>/<index>_<slug>.png` (screenshot) and `.playwright-cli/<session>/<index>_<slug>.md` (accessibility snapshot). Read the journey trace to determine:
- Did the page load? (any step with `action: navigate` and `outcome: pass`)
- Were there console errors? (any step with `console_errors: [...]`)
- Were there a11y violations? Read the per-step `.md` snapshot files and visually scan for missing labels, broken landmarks, or unlabeled interactive elements

If the smoke run fails (page didn't load, agent errored), surface the failure in the final report. Do not block — the user can investigate and re-run.

## Step 5: Status report

Emit a single structured report summarizing the audit, Chromatic check, setup, and smoke run. Use ✅ / ⚠ / ❌ markers.

**Report template:**
```
== Storybook Onboard Report ==

Storybook:
  ✅ Version: <version> (<x.y is acceptable | recommended | requires upgrade>)
  ✅ Framework preset: <preset>
  <green or yellow or red marker> Required addons: <list of missing or all-present>

Chromatic:
  <marker> CHROMATIC_PROJECT_TOKEN: <present | MISSING>
  <marker> chromatic dep: <present | missing — run `npm install --save-dev chromatic`>
  ⚠  GitHub App install: manual confirmation required (https://github.com/apps/chromatic)
  ⚠  Approval rights: manual confirmation required (https://www.chromatic.com)

ralph-playwright:
  ✅ playwright-cli: <version>
  ✅ playwright-stories/: <present | created>

Smoke run:
  <marker> Session: <session-name>
  <marker> Story: <story-id>
  <marker> Console errors: <count>
  <marker> A11y violations: <count>

Next:
  <action items based on yellows and reds; if all green, suggest /ralph-playwright:storybook-review on the next component change>
```

**Worked example (all green except manual Chromatic confirmations):**
```
== Storybook Onboard Report ==

Storybook:
  ✅ Version: 9.0.4 (recommended)
  ✅ Framework preset: @storybook/angular
  ✅ Required addons: controls, interactions, a11y all present

Chromatic:
  ✅ CHROMATIC_PROJECT_TOKEN: present
  ✅ chromatic dep: present
  ⚠  GitHub App install: manual confirmation required (https://github.com/apps/chromatic)
  ⚠  Approval rights: manual confirmation required (https://www.chromatic.com)

ralph-playwright:
  ✅ playwright-cli: 1.49.0
  ✅ playwright-stories/: present

Smoke run:
  ✅ Session: 2026-04-30-storybook-onboard-smoke
  ✅ Story: button-component--default
  ✅ Console errors: 0
  ✅ A11y violations: 0

Next:
  1. Confirm Chromatic GitHub App is installed (https://github.com/apps/chromatic)
  2. Confirm your Chromatic account has approval rights on this project
  3. On your next component change, run: /ralph-playwright:storybook-review <story-id>
```

## Idempotency notes

This skill is safe to re-run. Each step detects already-completed state:
- Step 1 (Storybook detect) is read-only
- Step 2 (Chromatic) is read-only
- Step 3 (setup) skips if `playwright-cli` is already installed
- Step 4 (smoke run) writes a fresh session each time — old smoke sessions remain in `.playwright-cli/` (gitignored)
- Step 5 (report) is just output

## When to re-run

- After installing missing addons or upgrading Storybook
- After installing the Chromatic GitHub App
- If the smoke run failed and the user has fixed the underlying issue (e.g., started the Storybook dev server)
