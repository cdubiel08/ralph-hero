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
