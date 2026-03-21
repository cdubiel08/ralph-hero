---
name: ralph-playwright:explore
description: Explore a running website to discover user flows, analyze findings, and produce research notes with promoted screenshots. Uses the execute → reflect → act pipeline via playwright-cli. Works on localhost or any accessible URL.
allowed-tools:
  - Bash(playwright-cli *)
  - Agent
  - Read
  - Write
---

# Explore — Live URL → Research Notes + User Stories

## Prerequisites
- `playwright-cli` installed globally (see `/ralph-playwright:setup`)
- Target app running (e.g., `npm run dev` → `http://localhost:3000`)

## Process

### Step 1: Execute (freeform)

Generate a session name: `<date>-explore-<slug>` (e.g., `2026-03-21-explore-checkout-flow`)

Spawn `explorer-agent` with:
- `url`: The target URL (from arguments or ask)
- `goal`: Exploration objective (from arguments or ask, e.g., "discover all user flows on the checkout page")
- `session`: The generated session name
- `persona`: User role if relevant (optional)

The agent navigates the app via `playwright-cli`, captures screenshots and accessibility snapshots at each step, and writes a journey trace to `.playwright-cli/<session>/journey-trace.yaml`.

### Step 2: Reflect

Read the journey trace from `.playwright-cli/<session>/journey-trace.yaml`.

For each step, examine:
- The screenshot (read the PNG file to see what the page looked like)
- The accessibility snapshot (read the .md file for element structure)
- Console errors/warnings captured during the step

Produce a signal report identifying:
- **a11y_violation**: Missing labels, broken tab order, insufficient contrast
- **ux_issue**: Confusing navigation, dead-end pages, broken flows
- **error**: Console errors, failed navigations, broken interactions
- **anomaly**: Unexpected behavior, visual glitches observed in screenshots

Write the signal report to `.playwright-cli/<session>/signal-report.yaml` following the signal-report schema.

### Step 3: Act

Read the signal report. For each signal:

1. **Promote evidence screenshots** from tier 1 to tier 2:
   - Source: `.playwright-cli/<session>/<screenshot>`
   - Destination: `thoughts/local/assets/<session>/<meaningful-name>.png`
   - Create the destination directory: `mkdir -p thoughts/local/assets/<session>/`

2. **Write a research note** to `thoughts/shared/research/<date>-<slug>-exploration.md`:
   ```yaml
   ---
   date: <today>
   type: research
   tags: [ralph-playwright, exploration, <app-specific-tags>]
   assets:
     - thoughts/local/assets/<session>/<promoted-screenshot-1>.png
     - thoughts/local/assets/<session>/<promoted-screenshot-2>.png
   ---
   ```
   Include signal summary, findings, and inline screenshot references.

3. **Optionally generate user stories** from discovered flows:
   - Convert happy-path flows to user story YAML
   - Apply sad-path heuristics from `schemas/user-story.schema.yaml`
   - Save to `playwright-stories/<slug>-discovered.yaml`

4. Write the action log to `.playwright-cli/<session>/action-log.yaml` following the action-log schema.

### Step 4: Summary

Report:
- N steps explored, N signals found (by severity)
- Research note written to `thoughts/shared/research/<path>`
- N screenshots promoted
- N user stories generated (if any)
- Suggest: `/ralph-playwright:test-e2e` to run generated stories
