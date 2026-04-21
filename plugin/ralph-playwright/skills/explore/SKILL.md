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

## Modes

The skill accepts an optional mode flag that controls how `explorer-agent` picks next actions:

- **Default (ref mode)** — Without the flag, explore uses accessibility-snapshot-ref navigation (ref mode). The agent selects next actions from the element refs surfaced by the accessibility tree.
- **`--vision-first`** — When this flag is present, the agent reasons primarily about the current screenshot to pick the next target (naming it in human-readable form, e.g. "blue primary CTA, top-right"). The accessibility snapshot is still captured for the record but is not consulted for the decision.

The vision-first mode is opt-in and strictly additive; the default path is behaviorally unchanged. See epic context: [#795](https://github.com/cdubiel08/ralph-hero/issues/795).

## Process

### Step 1: Execute (freeform)

Generate a session name: `<date>-explore-<slug>` (e.g., `2026-03-21-explore-checkout-flow`)

**Parse mode from arguments**: If the invocation arguments contain `--vision-first`, set `mode: vision-first`; otherwise set `mode: ref` (the agent default — passing the key explicitly keeps the spawn payload self-describing).

Spawn `explorer-agent` with:
- `url`: The target URL (from arguments or ask)
- `goal`: Exploration objective (from arguments or ask, e.g., "discover all user flows on the checkout page")
- `session`: The generated session name
- `persona`: User role if relevant (optional)
- `mode`: `ref` (default) or `vision-first` when the `--vision-first` flag was passed

Backward compat: invocations without the flag produce the same spawn payload shape as before plus a `mode: ref` key. The agent treats an omitted `mode` and `mode: ref` identically.

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

#### Exploration Metrics

Before printing the human summary, compute per-session metrics and write them to `.playwright-cli/<session>/exploration-metrics.yaml`. Metrics are emitted for BOTH modes (`ref` and `vision-first`) so later runs can compare.

**Schema** (inline — no separate schema file):

```yaml
mode: ref | vision-first          # required; default `ref` if the trace has no `input.mode`
url: <starting URL>               # verbatim from input.url
goal: <verbatim goal string>     # verbatim from input.goal
session: <session name>           # for provenance when comparing across sessions
goal_achieved: <boolean>          # operator judgment; default false if uncertain
total_steps: <int>                # from journey-trace summary
passed: <int>                     # from journey-trace summary
failed: <int>                     # from journey-trace summary
duration_ms: <int>                # from journey-trace summary
unique_urls: <int>                # distinct URLs visited (navigate targets + starting URL)
dead_ends: <int>                  # approximated; see computation notes below
```

**Field computation**:

- `mode` — Read from `input.mode` on the journey-trace. Missing value records as `ref` (backward compat with legacy traces).
- `url`, `goal` — Verbatim from `input.url` and `input.goal`.
- `session` — The session name (the `.playwright-cli/` subdirectory).
- `goal_achieved` — `true` iff the terminal step's `outcome == pass` AND its `action`/`target` references a goal-fulfilling condition. This is operator judgment; default to `false` if uncertain. Document your reasoning briefly in the Step 3 research note if you set it to `true`.
- `total_steps`, `passed`, `failed`, `duration_ms` — Carried directly from `summary` in the journey-trace.
- `unique_urls` — Count of distinct URLs from steps where `action == "navigate"` (the `target` is a URL in that case), PLUS the starting `input.url`. De-duplicate exact string matches.
- `dead_ends` — Approximated: count of steps where the post-action snapshot path would equal the pre-action snapshot path AND no URL change occurred. We use filename-hash comparison as the cheap proxy (two consecutive snapshot files with identical content hashes and no intervening navigate action). Documented as an approximation because two different pages can theoretically hash-collide on snapshot content.

Write the metrics file at `.playwright-cli/<session>/exploration-metrics.yaml` BEFORE printing the human report below.

#### Prior-run Discovery and Comparison Table

After writing the current session's metrics, look for prior runs to compare against:

1. Walk sibling directories under `.playwright-cli/` for other `exploration-metrics.yaml` files.
2. Keep only files with the SAME `url` AND `goal` AND a DIFFERENT `mode` from the current run.
3. If any match, pick the MOST RECENT (by session directory mtime). Older matches are noted as "also found: N prior runs for this URL/goal" in the report line.
4. If none match, skip the comparison silently — no error, no warning. First-ever runs on a new goal are expected to have no prior.

When a prior run is paired, print a side-by-side comparison table in the Step 4 human report:

```
Metric          Ref    Vision-first
------          ---    ------------
goal_achieved   true   true
total_steps     12     14
passed          11     13
failed          1      1
duration_ms     45120  58300
unique_urls     6      7
dead_ends       2      0
```

The columns are ordered `ref` then `vision-first` regardless of which run is "current". The signs of rows are interpreted in the research note, not the table (we do not annotate "better"/"worse" — the metrics speak for themselves).

#### Report

Report (human-readable summary):
- N steps explored, N signals found (by severity)
- Research note written to `thoughts/shared/research/<path>`
- N screenshots promoted
- N user stories generated (if any)
- Metrics: `.playwright-cli/<session>/exploration-metrics.yaml`
- Compared against: `.playwright-cli/<prior-session>/exploration-metrics.yaml` (<prior mode>) — only if a prior run was discovered
- Suggest: `/ralph-playwright:test-e2e` to run generated stories
