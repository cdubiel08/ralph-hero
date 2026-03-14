---
name: demo-video
description: Generate sprint demo videos using Remotion. Use when the user wants to create a demo video, sprint recap video, presentation video, or any structured video from content like features, screenshots, and bullet points. Trigger on mentions of "demo video", "sprint video", "record a demo", "make a video", or "generate presentation".
---

# Demo Video Generator

Generate sprint demo videos using the Remotion project bundled in this plugin at `${CLAUDE_PLUGIN_ROOT}/remotion/`. This skill walks through collecting content, generating a JSON input file, validating it, previewing, and rendering the final video.

**Important:** The Remotion project must have its dependencies installed before first use. If `node_modules/` doesn't exist in the remotion directory, run `cd ${CLAUDE_PLUGIN_ROOT}/remotion && pnpm install` first.

## Workflow

### Step 1: Gather Sprint Info

If a sprint number was provided as an argument, use it. Otherwise ask:

> What sprint number is this for? (or press enter to skip for an ad-hoc video)

Also ask:
- **Team name**: What team is this demo for?
- **Date**: What date should appear? (default: today)

### Step 2: Collect Scenes

Ask the user what they want to demo. For each feature or topic, collect:

1. **Feature name** - short title
2. **Description** - one-line summary
3. **Icon** (optional) - emoji to display
4. **Screenshot path** (optional) - path to a screenshot image

Build up the scenes list interactively. Suggest a structure like:

```
Typical demo video structure:
1. Title slide (auto-generated from sprint info)
2. Feature slides (one per feature demoed)
3. Optional: bullet summary, flow diagram, before/after comparison
4. Outro slide (auto-generated)
```

Keep asking "Any more features to demo?" until the user says no.

### Step 3: Generate Input JSON

Assemble the collected data into a VideoInput JSON file. The schema supports these scene types:

- `title` - headline, optional subtitle and logo
- `feature` - name, description, optional icon and illustration
- `screenshot` - src path, optional highlights and caption
- `before-after` - before/after image paths, optional caption
- `bullets` - title and items array
- `flow` - steps array, optional direction and caption
- `outro` - closing text, optional CTA and links

Save to `${CLAUDE_PLUGIN_ROOT}/remotion/inputs/sprint-{N}.json` (or `${CLAUDE_PLUGIN_ROOT}/remotion/inputs/{date}-demo.json` for ad-hoc videos).

### Step 4: Validate

Run the test suite to confirm the JSON is valid:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/remotion && pnpm test
```

If tests fail, fix the JSON and re-run.

### Step 5: Preview

Offer to launch Remotion Studio for preview:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/remotion && npx remotion studio
```

Tell the user: "Remotion Studio is running. Open the browser to preview your video. The compositions available are: sprint-demo (16:9), social-square (1:1), social-reel (9:16), and presentation (16:9). Close the studio when you're happy with the preview."

### Step 6: Iterate

Ask: "Would you like to make any changes?"

If yes, modify the JSON file based on feedback and return to Step 4.

### Step 7: Render

Ask which format(s) to render:

- `sprint-demo` - 1920x1080 (default)
- `social-square` - 1080x1080
- `social-reel` - 1080x1920
- `presentation` - 1920x1080

Render the selected format:

```bash
cd ${CLAUDE_PLUGIN_ROOT}/remotion && npx remotion render sprint-demo --props inputs/sprint-{N}.json --output out/sprint-{N}-demo.mp4
```

Offer batch rendering to additional formats if desired.

### Step 8: Deliver

Report the output file location and offer to render additional formats.

## Available Themes

- `energetic` (default) - Dark background, vibrant accents, spring animations, speed 1.3x

## Scene Type Reference

| Type | Required Fields | Optional Fields |
|------|----------------|-----------------|
| title | headline | subtitle, logo, durationSeconds |
| feature | name, description | icon, illustration, durationSeconds |
| screenshot | src | highlights, caption, zoom, durationSeconds |
| before-after | before, after | caption, transition, durationSeconds |
| bullets | title, items | icon, durationSeconds |
| flow | steps (min 2) | direction, caption, durationSeconds |
| outro | text | cta, links, durationSeconds |

## Example Input

```json
{
  "sprint": 42,
  "date": "2026-03-12",
  "team": "Platform Team",
  "theme": "energetic",
  "format": "16:9",
  "scenes": [
    { "type": "title", "headline": "Sprint 42 Demo", "subtitle": "Pipeline Improvements" },
    { "type": "feature", "name": "Batch Processing", "description": "10x faster", "icon": "⚡" },
    { "type": "bullets", "title": "Highlights", "items": ["10x throughput", "40% less config"] },
    { "type": "outro", "text": "Questions? Reach out in #platform-team" }
  ]
}
```
