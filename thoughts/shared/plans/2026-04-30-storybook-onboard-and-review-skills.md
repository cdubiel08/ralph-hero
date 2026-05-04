---
date: 2026-04-30
status: draft
type: plan
tags: [ralph-playwright, storybook, angular, chromatic, component-verification]
---

# Storybook Onboard + Review Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the two new ralph-playwright skills (`storybook-onboard`, `storybook-review`) that serve as the user-facing entry points for the Angular + Storybook component verification loop spec.

**Architecture:** Each skill is a single `SKILL.md` file in `plugin/ralph-playwright/skills/<name>/`, following the existing skill convention (YAML frontmatter + procedural markdown body that Claude follows at runtime). `storybook-onboard` performs one-shot Day-Zero setup (audit Storybook, confirm Chromatic, delegate to existing `setup` skill, smoke-run `explorer-agent`, emit status report). `storybook-review` accepts a story-id / glob / `--changed` argument, dispatches `explorer-agent` against the resolved stories, and produces a sub-minute report.

**Tech Stack:** Markdown (procedural skill format), bash (inline validation and git/grep operations), Claude Code's `Skill` + `Agent` + `Bash` tools at skill runtime. No new build tooling. No new tests beyond grep-based structural validation (matches the rest of ralph-playwright, which has no skill-level test framework).

**Spec:** `docs/superpowers/specs/2026-04-30-angular-storybook-verification-loop-design.md`

**Scope (Phase 0 only):** This plan covers authoring the two new skills. Phases 1–3 in the spec describe the dev's adoption journey *consuming* these skills in their own Angular repo — that work happens downstream and isn't an implementation task here. The plan ends when both skills are authored, validated, and the README advertises them.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `plugin/ralph-playwright/skills/storybook-onboard/SKILL.md` | Create | One-shot Day-Zero setup skill |
| `plugin/ralph-playwright/skills/storybook-review/SKILL.md` | Create | Daily inner-loop verification skill |
| `plugin/ralph-playwright/README.md` | Modify (~ line 78) | Add two rows to the Skills table |

No new agents, schemas, hooks, or scripts are required — both skills wrap existing infrastructure (`setup` skill, `explorer-agent`, bash, git).

**Why no helper scripts:** the two new skills are coordination layers. Their per-step logic (parse args, run npx commands, grep package.json, dispatch agents) is all things Claude does inline at runtime when following a SKILL.md. This matches the established ralph-playwright pattern (e.g., `storybook-test/SKILL.md` is 53 lines of bash + commentary; no separate scripts).

**Why no test framework:** ralph-playwright skills are procedural prompts, not code. There is no existing skill-level test framework. Validation in this plan uses `grep` against the SKILL.md file structure — sufficient to catch frontmatter typos, missing required sections, and broken cross-references. End-to-end validation (actually invoking the skill against a real Angular + Storybook project) belongs to Phase 1 Day-Zero in the dev's repo and is out of scope here.

---

## Task 1: Author `storybook-onboard` skill

**Files:**
- Create: `plugin/ralph-playwright/skills/storybook-onboard/SKILL.md`

### Step 1.1: Create the skill directory and write the frontmatter

- [ ] Create the directory and a SKILL.md file containing only the frontmatter and the title heading.

```bash
mkdir -p plugin/ralph-playwright/skills/storybook-onboard
```

Then write `plugin/ralph-playwright/skills/storybook-onboard/SKILL.md` with this initial content:

```markdown
---
name: ralph-playwright:storybook-onboard
description: One-shot Day-Zero setup for the Angular + Storybook verification loop. Audits Storybook version + addons, confirms Chromatic access (project token, GitHub App, approval rights), delegates to the ralph-playwright setup skill, runs a smoke explorer-agent against one representative story, and emits a green/yellow/red status report. Idempotent — safe to re-run.
---

# Storybook Onboard — One-Shot Day-Zero Setup

This skill performs the Day-Zero kickoff for the Angular + Storybook component verification loop (see `docs/superpowers/specs/2026-04-30-angular-storybook-verification-loop-design.md`). Run it once when adopting the loop in a project. Re-running is safe — completed steps detect existing state and skip ahead.
```

Run validation:
```bash
test -f plugin/ralph-playwright/skills/storybook-onboard/SKILL.md && echo OK
```
Expected output: `OK`

### Step 1.2: Add the "Step 1: Detect Storybook setup" section

- [ ] Append the Storybook audit section to the SKILL.md body.

```markdown
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
```

### Step 1.3: Add the "Step 2: Confirm Chromatic access" section

- [ ] Append the Chromatic verification section.

```markdown
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
```

### Step 1.4: Add the "Step 3: Run ralph-playwright setup" section

- [ ] Append the section that delegates to the existing `setup` skill.

```markdown
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
```

### Step 1.5: Add the "Step 4: Smoke run" section

- [ ] Append the smoke-run section that fires `explorer-agent` against one representative story.

```markdown
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
```

### Step 1.6: Add the "Step 5: Status report" section

- [ ] Append the report section with a worked example.

```markdown
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
```

### Step 1.7: Validate `storybook-onboard/SKILL.md` structure

- [ ] Run grep checks confirming frontmatter and required sections exist.

```bash
# Frontmatter validation
grep -E "^name: ralph-playwright:storybook-onboard$" plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
grep -E "^description: " plugin/ralph-playwright/skills/storybook-onboard/SKILL.md

# Required sections
grep -E "^## Step 1: Detect Storybook setup$" plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
grep -E "^## Step 2: Confirm Chromatic access$" plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
grep -E "^## Step 3: Run ralph-playwright setup$" plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
grep -E "^## Step 4: Smoke run$" plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
grep -E "^## Step 5: Status report$" plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
```

Expected: every grep matches and prints exactly one line. If any returns nothing, that section was not added — re-do that step.

### Step 1.8: Commit `storybook-onboard` skill

- [ ] Stage and commit.

```bash
git add plugin/ralph-playwright/skills/storybook-onboard/SKILL.md
git commit -m "$(cat <<'EOF'
feat(ralph-playwright): add storybook-onboard skill

One-shot Day-Zero setup for the Angular + Storybook component
verification loop. Audits Storybook version + addons, confirms
Chromatic access (token, GitHub App, approval rights), delegates
to the ralph-playwright setup skill, runs a smoke explorer-agent
against one representative story, emits a green/yellow/red report.
Idempotent.

Spec: docs/superpowers/specs/2026-04-30-angular-storybook-verification-loop-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Author `storybook-review` skill

**Files:**
- Create: `plugin/ralph-playwright/skills/storybook-review/SKILL.md`

### Step 2.1: Create the skill directory and write the frontmatter

- [ ] Create directory and skeleton.

```bash
mkdir -p plugin/ralph-playwright/skills/storybook-review
```

Write `plugin/ralph-playwright/skills/storybook-review/SKILL.md`:

```markdown
---
name: ralph-playwright:storybook-review
description: Daily inner-loop verification of Storybook stories. Dispatches explorer-agent against a story-id, glob, or git-diff-derived story set; produces a sub-minute report with screenshots, console errors, a11y snapshot, and drift vs. local cached baseline. Use after every component change as the fast feedback loop before pushing.
---

# Storybook Review — Inner-Loop Component Verification

This skill is the dev's daily verification command for the Angular + Storybook component verification loop (see `docs/superpowers/specs/2026-04-30-angular-storybook-verification-loop-design.md`). Run it after every component change to get a fast (~30–60s) report on the affected stories.

## Prerequisites

- `/ralph-playwright:storybook-onboard` was run successfully at least once
- Storybook dev server is running (typically `npm run storybook` → `http://localhost:6006`)
- `playwright-cli` is installed and on PATH
```

### Step 2.2: Add the "Argument forms" section

- [ ] Append the argument-parsing documentation.

```markdown
## Argument Forms

The skill accepts one positional argument or one flag.

### Single story id

```
/ralph-playwright:storybook-review button-component--default
```

The argument matches a Storybook story id (the value used in the `?id=` URL parameter). Use this for a single targeted check.

### Component glob

```
/ralph-playwright:storybook-review button-component--*
```

A trailing `*` expands to all stories with the same component prefix. The skill resolves these via `npx storybook extract` (or by reading `storybook-static/index.json` if a build artifact exists) and runs the agent against each.

### `--changed` (auto-detect from git diff)

```
/ralph-playwright:storybook-review --changed
```

The skill walks the unstaged + staged git diff to identify affected stories. The detection rules:

1. Any changed `*.stories.{ts,tsx,js}` is **directly affected**
2. For any changed `*.component.{ts,html,scss}`, check the same directory and parent for `*.stories.*` and add to the affected set
3. For any changed file matching `src/**/<name>/(<name>.{ts,html,scss})`, check `src/**/<name>/<name>.stories.*` and add

Story ids are then derived from the affected `.stories.*` files via `npx storybook extract` (preferred) or by parsing the file's `title` export and named story exports as a fallback.

If `--changed` resolves to zero stories, the skill exits with: "No story files affected by current diff. Specify a story-id explicitly to force a review."
```

### Step 2.3: Add the "Resolve story IDs" section

- [ ] Append the resolution-logic section.

```markdown
## Step 1: Resolve story IDs

Convert the argument into a concrete list of story ids to review.

```bash
# Method A: Storybook is running and exposes index.json
curl -fsS http://localhost:6006/index.json -o /tmp/sb-index.json 2>/dev/null && \
  jq -r '.entries | keys[]' /tmp/sb-index.json > /tmp/sb-all-ids.txt

# Method B (fallback): build artifact exists
test -f storybook-static/index.json && \
  jq -r '.entries | keys[]' storybook-static/index.json > /tmp/sb-all-ids.txt

# Method C (last resort): parse *.stories.* files for `title` and named exports
# Only used when neither A nor B is available — accuracy is reduced
```

Filter `/tmp/sb-all-ids.txt` against the argument:
- **Exact id match:** `grep -Fx "<arg>" /tmp/sb-all-ids.txt`
- **Glob match (trailing `*`):** `grep -E "^<prefix>" /tmp/sb-all-ids.txt`
- **`--changed`:** the set of story ids derived from the affected files (see Argument Forms section)

If the resolved list is empty, exit with the message above. If the list has more than 25 entries, ask the user to confirm before proceeding (cost guardrail — each story is a separate agent run).
```

### Step 2.4: Add the "Dispatch explorer-agent" section

- [ ] Append the dispatch logic.

```markdown
## Step 2: Dispatch explorer-agent per story

`playwright-cli` requires a flat session name (no slashes), so each story gets its own session. Generate a parent slug for the invocation, then a per-story session under it:

- Parent invocation slug: `<date>-storybook-review-<short-arg>` (e.g., `2026-04-30-storybook-review-button` or `2026-04-30-storybook-review-changed`)
- Per-story session: `<parent-slug>__<sanitized-story-id>` where `sanitized-story-id` replaces any non-`[a-zA-Z0-9-]` character with `-`

Example: parent `2026-04-30-storybook-review-button` + story `button-component--default` → session `2026-04-30-storybook-review-button__button-component--default`.

For each resolved story id, **spawn `explorer-agent`** with:
- `url`: `http://localhost:6006/iframe.html?id=<story-id>&viewMode=story`
- `goal`: "Verify the story renders without console errors or a11y violations. Interact with any visible primary controls (buttons, inputs) and capture the result."
- `session`: the per-story session name (flat, no slashes)
- `mode`: `ref` (default — fast)

Run the agents **in parallel** (one Agent tool call per story, all in the same message). Each session writes to `.playwright-cli/<per-story-session>/`.

For the inner-loop time budget (sub-minute), cap parallelism at 5 concurrent agents. If the resolved list has more than 5 stories, batch into groups of 5.
```

### Step 2.5: Add the "Local cache compare" section

- [ ] Append the drift-detection section.

```markdown
## Step 3: Compare against local cached baseline

The skill maintains a local-only cache of the previous run's screenshots per story id, used purely for "did anything obviously change since I last ran this?" feedback. Cache location: `.playwright-cli/storybook-review-cache/<story-id>/screenshot.png`.

This cache is **NOT** the source of truth — Chromatic owns canonical baselines. The local cache is throwaway state for the dev's inner loop.

```bash
# .gitignore should already include .playwright-cli/ (added by ralph-playwright setup)
# If not, add it:
grep -q ".playwright-cli/" .gitignore || echo ".playwright-cli/" >> .gitignore
```

For each story id reviewed in this run:

1. Pick the **final** screenshot from the agent's session directory. The agent writes screenshots as `<index>_<slug>.png` (zero-padded index per step). The final screenshot has the highest index:
   ```bash
   FINAL_SCREENSHOT=$(ls .playwright-cli/<per-story-session>/[0-9]*_*.png 2>/dev/null | sort -V | tail -1)
   ```
2. Compare to cache:
   ```
   .playwright-cli/storybook-review-cache/<sanitized-story-id>/screenshot.png
   ```
3. If cache miss (first run for this story id): copy `$FINAL_SCREENSHOT` to the cache path as the new baseline. Mark in report as "🆕 first run".
4. If cache hit and content-hash differs: mark in report as "🔁 changed since last run" and surface both file paths so the user can `open` them. Update the cache by overwriting with `$FINAL_SCREENSHOT`.
5. If cache hit and content-hash matches: mark as "✅ unchanged".

Hashing:
```bash
shasum -a 256 "$FINAL_SCREENSHOT" | cut -d' ' -f1
```
```

### Step 2.6: Add the "Report" section

- [ ] Append the output formatting.

```markdown
## Step 4: Report

Emit a compact per-story report.

**Template:**
```
== Storybook Review (<arg>) ==

<story-id-1>: <state> | console errors: <n> | a11y violations: <n> | screenshot: <path>
<story-id-2>: <state> | console errors: <n> | a11y violations: <n> | screenshot: <path>
...

Summary: <total> stories | <pass> ✅ | <changed> 🔁 | <new> 🆕 | <fail> ❌
Session: .playwright-cli/<session-name>/

<if any 🔁>: Review the changed screenshots. If the change was intentional, push and let Chromatic CI become the canonical record. If unintentional, dig in.
<if any ❌>: Open the failing session directory for details: .playwright-cli/<session-name>/<story-id>/journey-trace.yaml
```

**Worked example:**
```
== Storybook Review (button-component--*) ==

button-component--default: ✅ unchanged | console errors: 0 | a11y violations: 0
button-component--primary: 🔁 changed since last run | console errors: 0 | a11y violations: 0 | screenshot: .playwright-cli/2026-04-30-storybook-review-button__button-component--primary/02_button.png
button-component--disabled: ✅ unchanged | console errors: 0 | a11y violations: 0
button-component--loading: 🆕 first run | console errors: 0 | a11y violations: 1 | screenshot: .playwright-cli/2026-04-30-storybook-review-button__button-component--loading/03_button.png

Summary: 4 stories | 2 ✅ | 1 🔁 | 1 🆕 | 0 ❌
Sessions: .playwright-cli/2026-04-30-storybook-review-button__*/

🔁 Review button-component--primary screenshot. If intentional, push and Chromatic CI becomes the canonical record.
🆕 button-component--loading recorded its first cache baseline; review the a11y violation before pushing.
```

## Cost notes

Each story is a separate `explorer-agent` invocation. For the inner-loop time budget, target 1–5 stories per invocation. The `--changed` mode is the recommended default daily usage — it scopes work to what the dev actually touched.

## Next steps

After review:
- For ✅ unchanged stories: nothing to do
- For 🔁 changed stories: visually inspect the screenshot diff; if intentional, push and let Chromatic CI take over
- For 🆕 first runs: this is a story new to your local cache; review the captured screenshot and accept it as the local baseline
- For ❌ failures: read the session's `journey-trace.yaml` and `signal-report.yaml` for details
```

### Step 2.7: Validate `storybook-review/SKILL.md` structure

- [ ] Run grep checks.

```bash
grep -E "^name: ralph-playwright:storybook-review$" plugin/ralph-playwright/skills/storybook-review/SKILL.md
grep -E "^description: " plugin/ralph-playwright/skills/storybook-review/SKILL.md
grep -E "^## Argument Forms$" plugin/ralph-playwright/skills/storybook-review/SKILL.md
grep -E "^## Step 1: Resolve story IDs$" plugin/ralph-playwright/skills/storybook-review/SKILL.md
grep -E "^## Step 2: Dispatch explorer-agent per story$" plugin/ralph-playwright/skills/storybook-review/SKILL.md
grep -E "^## Step 3: Compare against local cached baseline$" plugin/ralph-playwright/skills/storybook-review/SKILL.md
grep -E "^## Step 4: Report$" plugin/ralph-playwright/skills/storybook-review/SKILL.md
```

Expected: every grep matches and prints exactly one line.

### Step 2.8: Commit `storybook-review` skill

- [ ] Stage and commit.

```bash
git add plugin/ralph-playwright/skills/storybook-review/SKILL.md
git commit -m "$(cat <<'EOF'
feat(ralph-playwright): add storybook-review skill

Daily inner-loop verification for Storybook stories. Accepts a
story-id, glob, or --changed (git-diff-derived) argument; dispatches
explorer-agent against the resolved set; produces a sub-minute report
with screenshots, console errors, a11y snapshots, and drift vs. local
cached baseline. The local cache is throwaway state — Chromatic owns
canonical baselines; this is for the dev's fast inner-loop only.

Spec: docs/superpowers/specs/2026-04-30-angular-storybook-verification-loop-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Update `plugin/ralph-playwright/README.md` Skills table

**Files:**
- Modify: `plugin/ralph-playwright/README.md` (Skills table, ~ line 78)

### Step 3.1: Add the two new skills to the Skills table

- [ ] Append two rows immediately after the `visual-diff` row.

Find this block (lines ~70–78):
```markdown
| Skill | One-liner |
|-------|-----------|
| [setup](skills/setup/SKILL.md) | One-time install of playwright-cli, browser validation, and `playwright-stories/` directory scaffolding. |
| [story-gen](skills/story-gen/SKILL.md) | ... |
| [explore](skills/explore/SKILL.md) | ... |
| [test-e2e](skills/test-e2e/SKILL.md) | ... |
| [a11y-scan](skills/a11y-scan/SKILL.md) | ... |
| [storybook-test](skills/storybook-test/SKILL.md) | ... |
| [visual-diff](skills/visual-diff/SKILL.md) | Visual regression testing via Chromatic (default) or Applitools Eyes; detects unintended UI changes across Storybook stories. |
```

Append two rows after the `visual-diff` row:

```markdown
| [storybook-onboard](skills/storybook-onboard/SKILL.md) | One-shot Day-Zero setup for the Angular + Storybook verification loop — audits Storybook + addons, confirms Chromatic access, runs setup + smoke `explorer-agent`, emits a green/yellow/red report. |
| [storybook-review](skills/storybook-review/SKILL.md) | Daily inner-loop verification of Storybook stories — dispatches `explorer-agent` against a story-id, glob, or git-diff-derived set; sub-minute report with drift vs. local cached baseline. |
```

### Step 3.2: Validate the README change

- [ ] Confirm both new rows are present.

```bash
grep -E "\[storybook-onboard\]\(skills/storybook-onboard/SKILL.md\)" plugin/ralph-playwright/README.md
grep -E "\[storybook-review\]\(skills/storybook-review/SKILL.md\)" plugin/ralph-playwright/README.md
```

Expected: both grep commands return one match each.

### Step 3.3: Commit the README update

- [ ] Stage and commit.

```bash
git add plugin/ralph-playwright/README.md
git commit -m "$(cat <<'EOF'
docs(ralph-playwright): advertise storybook-onboard and storybook-review

Add the two new skills to the Skills table so they're discoverable
alongside the existing 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: End-to-end discoverability check

**Files:** None modified — this task verifies what was built.

### Step 4.1: List all ralph-playwright skill directories and confirm both new ones are present

- [ ] Verify the two new skills sit alongside the existing ones.

```bash
ls plugin/ralph-playwright/skills/
```

Expected output should include `storybook-onboard` and `storybook-review` alongside `a11y-scan`, `browser`, `capture`, `explore`, `reflect`, `setup`, `story-gen`, `storybook-test`, `test-e2e`, `ux-audit`, `visual-diff`.

### Step 4.2: Confirm both SKILL.md files have unique frontmatter names

- [ ] No two skills should share a `name:` field.

```bash
grep -h "^name: ralph-playwright:" plugin/ralph-playwright/skills/*/SKILL.md | sort | uniq -d
```

Expected output: empty (no duplicates).

### Step 4.3: Confirm the two new skills cross-reference the spec

- [ ] Each new SKILL.md should mention the spec doc by relative path so an engineer reading the skill can find context.

```bash
grep -l "2026-04-30-angular-storybook-verification-loop-design" \
  plugin/ralph-playwright/skills/storybook-onboard/SKILL.md \
  plugin/ralph-playwright/skills/storybook-review/SKILL.md
```

Expected output: both file paths printed (each contains the spec reference).

### Step 4.4: Confirm git status is clean and all three commits landed

- [ ] Three commits expected: storybook-onboard, storybook-review, README update.

```bash
git status
git log --oneline -5
```

Expected: working tree clean; the three new commits present in `git log`. Note: Phase 0 commits go to `main` directly (matching the existing ralph-playwright skill-authoring pattern). If your team uses feature branches for plugin changes, branch off main before Step 1.1 and open a PR after Step 4.4 instead of committing to main directly.

### Step 4.5: (Manual, deferred to Phase 1) Smoke-test the skills against a real Angular + Storybook project

- [ ] **NOT a step in this plan — out of scope.** The first true end-to-end validation is the dev's first invocation of `/ralph-playwright:storybook-onboard` against their Angular 21 repo. That's Phase 1 Day-Zero in the spec. If a regression is found there, file an issue and add a fix task to a follow-up plan.

---

## Spec coverage check

| Spec requirement | Plan task |
|---|---|
| New skill: `storybook-onboard` | Task 1 |
| `storybook-onboard` audits Storybook version + addons | Step 1.2 |
| `storybook-onboard` confirms Chromatic access | Step 1.3 |
| `storybook-onboard` delegates to existing `setup` skill | Step 1.4 |
| `storybook-onboard` runs smoke `explorer-agent` | Step 1.5 |
| `storybook-onboard` emits green/yellow/red status report | Step 1.6 |
| `storybook-onboard` is idempotent | Steps 1.4, 1.6 (idempotency notes) |
| New skill: `storybook-review` | Task 2 |
| `storybook-review` accepts single story-id arg | Step 2.2 |
| `storybook-review` accepts component glob arg | Step 2.2 |
| `storybook-review` accepts `--changed` arg | Step 2.2 |
| `storybook-review` dispatches `explorer-agent` | Step 2.4 |
| `storybook-review` produces sub-minute report | Steps 2.4 (parallelism cap), 2.6 |
| `storybook-review` compares against local cache | Step 2.5 |
| Surface skills in README so the dev can discover them | Task 3 |
| Skills cross-reference the spec | Step 4.3 |

All spec requirements have an implementing task. Phases 1–3 of the spec are downstream consumption (the dev's adoption journey in their own repo) and are explicitly out of scope here.

---

## Next steps (out of plan scope)

After this plan completes:

1. **Hand off to the dev** — share the spec + the two new skill names. Run a 15-min pairing session walking through `/ralph-playwright:storybook-onboard` on the dev's Angular repo.
2. **Phase 1 (dev's repo):** dev runs `storybook-onboard`, addresses any yellows/reds, completes the Storybook hygiene migration (args/argTypes), starts using `storybook-review` after every component change.
3. **Phase 2 (dev's repo):** dev adds `play` functions to high-value stories using `@storybook/test`. The `storybook-review` skill keeps working — its agent dispatches still find the stories whether they have play functions or not.
4. **Phase 3 (dev's repo):** dev wires the canonical CI: Chromatic GitHub Action + ralph-playwright `storybook-test` + `a11y-scan` jobs in `.github/workflows/`. `npm run verify` script for local pre-push runs.

If a meaningful gap is found during Phase 1 Day-Zero (e.g., the smoke run reveals a missing skill capability), capture it as a follow-up plan, not in this one.

---

## Prior Work

- Original superpowers artifact: `docs/superpowers/plans/2026-04-30-storybook-onboard-and-review-skills.md`
