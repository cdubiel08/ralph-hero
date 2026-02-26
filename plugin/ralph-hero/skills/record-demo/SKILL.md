---
description: Record a product demo with narration and attach to a GitHub issue
context: inline
model: sonnet
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
  - ralph_hero__get_issue
  - ralph_hero__create_comment
---

# Record Demo

Interactive skill for recording product demos with screen capture and narration.

## Prerequisites

Before using this skill, ensure:
1. OBS Studio is installed and running
2. `obs-cli` is installed (`go install github.com/muesli/obs-cli@latest`)
3. OBS WebSocket server is enabled (Settings > WebSocket Server)
4. Your desired scene is configured in OBS (terminal + browser layout recommended)

## Workflow

### Step 1: Setup Verification

Check that OBS is reachable:
```bash
obs-cli recording status
```

If this fails, guide the user to start OBS and enable WebSocket.

### Step 2: Issue Context (if provided)

If invoked with `#NNN`:
1. Fetch issue: `ralph_hero__get_issue(number=NNN)`
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
2. Post comment: `ralph_hero__create_comment(number=NNN, body="## Demo Recording\n\n...")`

### Step 7: Summary

Report:
- Recording file location
- Upload URL (if uploaded)
- Issue comment URL (if linked)
