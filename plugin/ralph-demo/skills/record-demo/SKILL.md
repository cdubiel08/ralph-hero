---
name: record-demo
description: Capture an OBS-based screen demo for a GitHub issue — orchestrates obs-cli to record, optionally trim/thumbnail, then upload and post a `## Demo Recording` comment. Requires OBS Studio + obs-cli installed and OBS WebSocket server running. Use when the user wants to record a live screen demo (as opposed to generating a composited video from JSON — that is the `demo-video` skill in this plugin).
user-invocable: true
context: inline
model: sonnet
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - mcp__plugin_ralph_ralph-github__ralph_hero__get_issue
  - mcp__plugin_ralph_ralph-github__ralph_hero__create_comment
---

# Record Demo

Interactive skill for recording product demos with screen capture and narration.

> **Two demo paths in `ralph-demo`:** this skill (`record-demo`) drives a *live OBS screen capture* of a real session; the sibling `demo-video` skill *composites* a structured video from JSON input via Remotion. Pick `record-demo` when you want to film something happening on screen now; pick `demo-video` for a scripted sprint recap.

## Prerequisites

Before using this skill, ensure:
1. **OBS Studio** is installed and running ([download](https://obsproject.com/))
2. **`obs-cli`** is installed (`go install github.com/muesli/obs-cli@latest`) — see [obs-cli install instructions](https://github.com/muesli/obs-cli)
3. **OBS WebSocket server** is enabled (Settings > WebSocket Server)
4. **Scene** is configured in OBS (terminal + browser layout recommended)

> **Limitation**: If OBS is not available, this skill cannot proceed — no fallback capture path is implemented (no QuickTime, native macOS recorder, or other alternative). Either install/start OBS, or use a different capture workflow and paste the recording into the issue manually.

## Workflow

### Step 1: Setup Verification

Check that OBS is reachable:
```bash
obs-cli recording status
```

If this fails, guide the user to start OBS and enable WebSocket.

### Step 2: Issue Context (if provided)

If invoked with `#NNN`:
1. Fetch the full issue details for issue NNN.
2. Display issue title and current state
3. Suggest a demo script based on the issue type

### Step 3: Pre-Recording

Ask the user via AskUserQuestion:
- "Arrange your screen layout. Ready to start recording?"
- Options: "Start recording" / "Cancel"

### Step 4: Recording

Start recording:
```bash
obs-cli recording start
```

Provide pacing prompts via AskUserQuestion:
- "Recording started. Demonstrate the feature now."
- "When finished, select 'Stop recording'."
- Options: "Stop recording" / "Add chapter marker" / "Cancel (discard)"

### Step 5: Stop & Process

Stop recording:
```bash
obs-cli recording stop
```

Locate the recording file (OBS output path from settings).

Ask user:
- "Trim the recording?"
- "Generate thumbnail?"
- "Upload to GitHub?"

### Step 6: Upload & Link

If uploading:
1. Upload via `gh release upload` or issue attachment
2. Post a comment on issue NNN with header `## Demo Recording` and the upload URL and details.

### Step 7: Summary

Report:
- Recording file location
- Upload URL (if uploaded)
- Issue comment URL (if linked)
