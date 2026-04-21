---
name: ralph-playwright:capture
description: Quick one-shot — screenshot a URL and optionally promote the screenshot to a research note in thoughts/. Runs execute (1-step) → reflect (minimal) → act (promote). Use for grabbing a screenshot of a specific page state.
allowed-tools:
  - Bash(playwright-cli *)
  - Read
  - Write
---

# Capture — Screenshot + Promote

## Input

From arguments or ask:
- `url`: The URL to screenshot (required)
- `note`: Path to an existing or new research note to attach the screenshot to (optional)
- `name`: Meaningful name for the screenshot (optional, derived from URL if omitted)
- `high_res`: Boolean, default `false`. When `true`, capture at higher pixel density (`--device-scale-factor 2`, clamped to 2576px longest-edge / 3.75MP area). Use for OCR-style captures of dense tables, receipts, charts, or small-type forms. Pairs best with Opus 4.7 reflect; wasted on Sonnet-at-1568px. Roughly 3.25x the image-token cost. See [browser/SKILL.md § High-resolution captures](../browser/SKILL.md#high-resolution-captures) for details.

## Process

### Step 1: Execute (1-step journey)

Generate session: `<date>-capture-<slug>`

```bash
mkdir -p ".playwright-cli/<session>"
playwright-cli -s=<session> open
playwright-cli -s=<session> goto "<url>"
playwright-cli -s=<session> snapshot --filename=".playwright-cli/<session>/00_page.md"

# When high_res=false (default):
playwright-cli -s=<session> screenshot --filename=".playwright-cli/<session>/00_page.png"

# When high_res=true:
playwright-cli --high-res -s=<session> screenshot --filename=".playwright-cli/<session>/00_page.png"

playwright-cli -s=<session> close
```

Write a minimal journey trace to `.playwright-cli/<session>/journey-trace.yaml`:
```yaml
id: "<uuid>"
timestamp: "<now>"
input:
  kind: freeform
  url: "<url>"
  goal: "Capture screenshot"
session: "<session>"
runtime:
  backend: cli
  version: "<version>"
steps:
  - index: 0
    action: navigate
    target: "<url>"
    outcome: pass
    screenshot: ".playwright-cli/<session>/00_page.png"
    snapshot: ".playwright-cli/<session>/00_page.md"
    console: []
    duration_ms: <ms>
    error: null
    # Include `capture` ONLY when high_res=true:
    # capture:
    #   resolution: "2560x1440"      # actual PNG dimensions
    #   device_scale_factor: 2
    #   mode: high-res
summary:
  total_steps: 1
  passed: 1
  failed: 0
  duration_ms: <ms>
```

### Step 2: Reflect (minimal)

Read the screenshot and snapshot. Produce a minimal signal report:
- If no issues observed: empty signals array, recommendation "No issues found"
- If issues noticed: classify and report them

Write to `.playwright-cli/<session>/signal-report.yaml`.

### Step 3: Act (promote)

If a `note` path was provided (or the user wants to save the screenshot):

1. Create asset directory:
```bash
mkdir -p "thoughts/local/assets/<note-slug>/"
```

2. Copy and rename the screenshot:
```bash
cp ".playwright-cli/<session>/00_page.png" "thoughts/local/assets/<note-slug>/<name>.png"
```

3. If the note doesn't exist, create it with frontmatter:
```yaml
---
date: <today>
type: research
assets:
  - thoughts/local/assets/<note-slug>/<name>.png
---
```

4. If the note exists, append the asset path to its `assets` frontmatter and add an inline reference.

5. Write action log to `.playwright-cli/<session>/action-log.yaml`.

### Summary

Report the screenshot location, resolution mode, and whether it was promoted:
- Screenshot saved: `.playwright-cli/<session>/00_page.png`
- Mode: `default` or `high-res` (echo the `high_res` input)
- Resolution: `<WxH>` (actual PNG dimensions — important so downstream reflect knows what detail is readable)
- Promoted to: `thoughts/local/assets/<note-slug>/<name>.png` (if promoted)
- Note: `<note-path>` (if attached to a note)
