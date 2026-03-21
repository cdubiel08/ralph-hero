---
name: ralph-playwright:test-e2e
description: Run all user story YAML files in playwright-stories/ using the execute → reflect → act pipeline via playwright-cli. Aggregates pass/fail results with screenshots and signals. Optionally filter by type or tags.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# Test E2E — Run All User Stories

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running
- Story files in `playwright-stories/`

## Process

### Step 1: Discover stories

Glob all `playwright-stories/**/*.yaml` files.

If none found, suggest:
- `/ralph-playwright:story-gen` to create stories from a description
- `/ralph-playwright:explore <url>` to generate stories by exploring a site

Optional filters (from arguments):
- `--type happy|sad|edge` — run only stories of that type
- `--tags auth,login` — run only stories with matching tags
- `--story "Login succeeds"` — run a specific story by name

### Step 2: Execute (structured, per story)

For each story file, spawn a `story-runner-agent` with:
- The story object (name, type, url, persona, workflow)
- Session name: `<date>-test-e2e-<story-kebab>`

Spawn agents in parallel — each gets its own named playwright-cli session (fully isolated).

Each agent writes a journey trace to `.playwright-cli/<session>/journey-trace.yaml`.

### Step 3: Reflect (aggregate)

After all agents complete, read all journey traces.

For each trace, examine:
- Step outcomes (pass/fail/skip)
- Screenshots of failed steps
- Accessibility snapshots
- Console errors

Produce an aggregated signal report to `.playwright-cli/<date>-test-e2e/signal-report.yaml`:
- **error**: Test step failures with expected vs actual
- **a11y_violation**: Accessibility issues found during execution
- **anomaly**: Unexpected console errors even on passing steps

### Step 4: Act

Based on the signal report:

1. For `critical` or `high` severity signals: **create GitHub issues** via ralph-hero MCP (`ralph_hero__create_issue`) with:
   - Title prefixed by signal type (e.g., `a11y: Missing label on email field`)
   - Body includes step details, expected vs actual, console errors
   - Tags from the story's tags

2. **Promote failure screenshots** to `thoughts/local/assets/<date>-test-e2e/`

3. Write the action log to `.playwright-cli/<date>-test-e2e/action-log.yaml`

### Step 5: Report

```
== ralph-playwright E2E Report ==
Stories: N | Pass: N | Fail: N | Skip: N
Signals: N (critical: N, high: N, medium: N, low: N)

PASSED:
  ✅ auth — "Login succeeds with valid credentials" (3.2s)
  ...

FAILED:
  ❌ auth — "Unauthenticated user is redirected from dashboard"
     Step 2: Expected redirect to /login — page stayed at /dashboard
     Screenshot: .playwright-cli/<session>/02_navigate.png

SIGNALS:
  🔴 error: Redirect not implemented for /dashboard (critical)
  🟠 a11y_violation: Missing label on #email-field (high)

ACTIONS:
  📋 Issue #652 created: "error: Redirect not implemented for /dashboard"
  📸 2 screenshots promoted to thoughts/local/assets/
```
