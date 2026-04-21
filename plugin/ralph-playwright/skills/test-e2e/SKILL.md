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
- Optional: `high_res_steps` — list of step indices that require high-resolution capture

Spawn agents in parallel — each gets its own named playwright-cli session (fully isolated).

Each agent writes a journey trace to `.playwright-cli/<session>/journey-trace.yaml`.

**Optional: high-resolution on critical assertion steps.** Story YAML files MAY declare `high_res_steps` when specific verification steps require reading fine detail from the rendered page — e.g., "verify the subtotal on the receipt is $42.17", "verify the chart legend shows April-2026", "verify the invoice line-items match the order". Default is OFF — omit `high_res_steps` entirely for stories that just need default-resolution captures. The story-runner-agent accepts this as an agent-level input (story workflow is free-text today, so it cannot be declared per-step inside the YAML). See [browser/SKILL.md § High-resolution captures](../browser/SKILL.md#high-resolution-captures) for cost and pairing guidance.

This feature does NOT auto-recapture failed steps at high-res. If a verification step fails at default resolution and you want to investigate with high-res, re-run the story manually with `high_res_steps` set, or use `/ralph-playwright:capture` on the failing URL. Automatic failure-driven escalation is tracked separately (#787).

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

2. **Render annotated siblings for failure screenshots that carry bboxes.** If the signal's `evidence.bboxes[]` is populated, invoke the zero-dep renderer to emit `<stem>.annotated.png` next to the original:
   ```bash
   yq '[.signals[].evidence.bboxes[]? | select(.screenshot == "<screenshot>")]' \
     ".playwright-cli/<date>-test-e2e/signal-report.yaml" -o=json > "/tmp/<screenshot>.bboxes.json"

   if [[ "$(jq 'length' "/tmp/<screenshot>.bboxes.json")" -gt 0 ]]; then
     node "${CLAUDE_PLUGIN_ROOT}/scripts/annotate.mjs" \
       --input ".playwright-cli/<session>/<screenshot>" \
       --bboxes "/tmp/<screenshot>.bboxes.json"
   fi
   ```
   Signals without `bboxes` produce no annotated sibling (no regression on the existing flow).

3. **Promote failure screenshots** to `thoughts/local/assets/<date>-test-e2e/`. If an annotated sibling was produced in step 2, copy it alongside the original with matching stem.

4. Write the action log to `.playwright-cli/<date>-test-e2e/action-log.yaml`. Emit ONE `screenshot_promoted` entry per file — so a failure screenshot with bboxes produces two entries (original + annotated).

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
