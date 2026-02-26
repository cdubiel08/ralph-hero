---
date: 2026-02-22
status: draft
github_issues: [364]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/364
primary_issue: 364
---

# Demo Recording Skills — Implementation Plan

## Overview

Add video recording capabilities to ralph-hero through custom skills that can capture product demos and attach video artifacts to outputs. Two modes: **autonomous** (records terminal during ralph workflows automatically) and **interactive** (human-driven with narration, screen + browser capture). This plan covers tool research, artifact pipeline design, and skill architecture.

## Current State Analysis

### Existing Artifacts Are Markdown-Only
All ralph-hero skill outputs today are `.md` files linked via the Artifact Comment Protocol (`plugin/ralph-hero/skills/shared/conventions.md:232-293`). Research docs, plans, reviews, and implementation summaries are written to `thoughts/shared/`, committed, and linked in GitHub issue comments with standardized `## Section Header` + blob URL format.

### Prior Art
- `thoughts/ideas/2026-02-21-showcase-demo-onboarding.md` — Draft idea for a split-screen demo of ralph-team processing issues end-to-end. Mentions asciinema, OBS, and Playwright MCP for board screenshots.
- The Playwright MCP server is already configured in the plugin (`.mcp.json`) and could capture browser state.

### No Video Infrastructure Exists
No skills produce non-text artifacts. No upload, conversion, or video linking patterns exist yet. This plan establishes the foundation.

## Desired End State

1. A **research document** at `thoughts/shared/research/2026-02-22-demo-recording-tools.md` compiling all tool findings
2. A **skill architecture spec** defining two recording modes with clear tool choices
3. Skeleton skill definitions ready for future implementation
4. An artifact pipeline design extending the Artifact Comment Protocol to support video links

### Verification
- Research doc exists and covers all 5 tools with automation matrix
- Plan is self-contained — a future `/implement-plan` can execute it without re-research
- Skill designs follow existing patterns in `plugin/ralph-hero/skills/`

## What We're NOT Doing

- Actually implementing the skills (this plan informs a future implementation plan)
- Building CI/CD video pipelines
- Purchasing or configuring SaaS accounts (Loom, Screen Studio, Descript)
- Modifying the MCP server or Artifact Comment Protocol (design only)
- Replacing existing text-based artifacts — video supplements, not replaces

## Implementation Approach

Research-first: compile tool findings into a durable document, then use those findings to design skills that fit ralph-hero's existing architecture.

---

## Phase 1: Research Document

### Overview
Compile all tool research into a single reference document covering capabilities, automation APIs, pricing, and suitability for each recording mode.

### Changes Required:

#### 1. Research Document
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
**Action**: Create new file

The document should follow the standard research format with YAML frontmatter and cover:

```markdown
---
date: 2026-02-22
status: complete
type: research
---

# Demo Recording Tools — Research Findings

## Purpose
Evaluate screen recording tools for integration into ralph-hero skills.
Two target modes: autonomous (terminal-only, headless) and interactive (screen + narration).

## Tools Evaluated

### 1. Loom
- **Type**: SaaS screen recorder (browser + desktop app)
- **CLI**: None
- **API**: No open API. Browser-only Record SDK (npm `@loomhq/record-sdk`)
- **Programmatic recording**: Not possible — requires explicit user click
- **Headless**: No
- **Pricing**: Free (limited) / $12.50/mo Business / $20/mo Business+AI
- **Automation verdict**: Poor. Browser-embedded widget only. Cannot be triggered from CLI or scripts.
- **Best for**: Human-initiated recordings shared via link. Not suitable for automation.

### 2. Screen Studio
- **Type**: macOS-only desktop app with polished output (auto-zoom, cursor effects)
- **CLI**: None
- **API**: None. No AppleScript dictionary, no URL scheme
- **Programmatic recording**: Indirect only — simulate global hotkeys via Keyboard Maestro or `osascript`
- **Headless**: No
- **Export**: MP4 via GUI only
- **Automation verdict**: Poor. Beautiful output but zero automation surface.
- **Best for**: Manual recording of polished product demos for marketing. Post-production tool.

### 3. Descript
- **Type**: Desktop app + cloud service for video/audio editing
- **CLI**: None
- **API**: Limited partner API (not self-service). Two endpoints: import media + get published metadata
- **Programmatic editing**: Not possible — no API for filler removal, cuts, or exports
- **Headless**: No
- **Automation verdict**: Poor for recording/editing. Useful only as a post-production destination.
- **Best for**: Human editing workflow. Import raw recordings, clean up with AI, export polished video.

### 4. asciinema
- **Type**: Terminal session recorder (CLI tool, open source)
- **CLI**: First-class. `asciinema rec`, `asciinema play`, `asciinema upload`
- **API**: CLI is the API. No REST API needed.
- **Programmatic recording**: Excellent. `asciinema rec -c "./script.sh" output.cast` — fully headless, stops when command exits
- **Headless**: Native. No display required.
- **Output formats**: `.cast` (asciicast v2 JSON) -> GIF via `agg` -> MP4 via `ffmpeg`
- **CI/CD**: Excellent. Text-based format diffs cleanly in git.
- **Automation library**: `asciinema-automation` (Python/pexpect) for scripted keystroke sequences with natural timing
- **Self-hosting**: Docker Compose server available for private hosting
- **Automation verdict**: Excellent. Purpose-built for automated terminal recording.
- **Best for**: Autonomous mode. Record ralph-hero terminal sessions headlessly.

### 5. OBS Studio
- **Type**: Open-source screen recorder / streaming tool (cross-platform)
- **CLI**: Launch flags (`--startrecording`, `--scene`, `--minimize-to-tray`)
- **API**: WebSocket v5 (built-in since OBS 28, port 4455). Full runtime control.
- **Programmatic recording**: Yes. Via `obs-cli` (Go binary) or `obsws-python`:
  - `obs-cli recording start` / `obs-cli recording stop`
  - Scene switching, source control, replay buffer
- **Headless**: Partial. Linux via Xvfb + software OpenGL (llvmpipe). No native headless flag.
- **Output formats**: MP4, MKV, FLV (configurable encoders)
- **Plugin ecosystem**: Extensive (Advanced Scene Switcher, obs-move-transition, NDI)
- **Scripting**: Built-in Python 3 + LuaJIT scripting engine
- **Automation verdict**: Good. Full programmatic control via WebSocket. Requires display (real or virtual).
- **Best for**: Interactive mode. Capture screen + browser + audio with scene management.

## Automation Capability Matrix

| Capability | Loom | Screen Studio | Descript | asciinema | OBS |
|---|---|---|---|---|---|
| CLI start/stop | - | - | - | Yes | Yes (WebSocket) |
| Headless recording | - | - | - | Yes | Partial (Xvfb) |
| Programmatic control | - | Hotkey sim | - | Full | Full (WebSocket) |
| CI/CD ready | - | - | - | Yes | With effort |
| Audio/narration | Yes | Yes | Yes (post) | - | Yes |
| Browser capture | Yes | Yes | - | - | Yes |
| Terminal capture | - | Yes | - | Yes | Yes |
| Post-production AI | - | Auto-zoom | Filler removal | - | - |
| Pricing | $$$ | $$ | $$$ | Free | Free |

## Recommendations

### Autonomous Mode: asciinema + agg + ffmpeg
- Record terminal with `asciinema rec -c "..." output.cast`
- Convert to GIF: `agg output.cast output.gif`
- Convert to MP4: `ffmpeg -i output.gif -movflags faststart output.mp4`
- Upload GIF to GitHub issue comment (inline image) or release asset

### Interactive Mode: OBS + obs-cli + Playwright MCP
- OBS captures screen (terminal + browser side-by-side)
- `obs-cli` starts/stops recording from skill
- Playwright MCP captures GitHub board screenshots at state transitions
- Human narrates via microphone
- Output: MP4 file

### Post-Production (Optional): Descript or Screen Studio
- Import raw OBS recording into Descript for filler word removal, chapter markers
- Or re-record key moments in Screen Studio for polished marketing videos
- These are manual human workflows, not automated by skills

## References
- [asciinema CLI docs](https://docs.asciinema.org/manual/cli/)
- [agg GIF generator](https://github.com/asciinema/agg)
- [asciinema-automation](https://github.com/PierreMarchand20/asciinema_automation)
- [OBS WebSocket protocol](https://github.com/obsproject/obs-websocket)
- [obs-cli](https://github.com/muesli/obs-cli)
- [obsws-python](https://github.com/aatikturk/obsws-python)
- [Loom Record SDK](https://dev.loom.com/docs/record-sdk/details/api)
- [Descript API](https://docs.descriptapi.com/)
- [Headless OBS on Debian](https://binblog.de/2025/04/03/headless-obs-on-debian/)
```

### Success Criteria:

#### Automated Verification:
- [ ] File exists at `thoughts/shared/research/2026-02-22-demo-recording-tools.md`
- [ ] Valid YAML frontmatter

#### Manual Verification:
- [ ] All 5 tools covered with consistent depth
- [ ] Automation matrix is accurate
- [ ] Recommendations are clear and actionable

---

## Phase 2: Skill Architecture Design

### Overview
Design two recording mode architectures that integrate with ralph-hero's existing skill/agent/hook system.

### Changes Required:

#### 1. Architecture Section in Research Doc
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md` (append)
**Action**: Add skill architecture design section

```markdown
## Skill Architecture Design

### Mode 1: Autonomous Recording (asciinema)

**Trigger**: Hook-based. A `PostToolUse` or skill-level hook starts recording when certain skills begin and stops when they complete.

**Flow**:
1. Skill starts (e.g., `ralph-impl`, `ralph-team`)
2. Pre-hook: `asciinema rec -c "$SKILL_COMMAND" recordings/GH-NNNN-impl.cast`
   - Wraps the actual skill execution inside an asciinema recording
3. Skill executes normally (all terminal output captured)
4. Skill completes -> recording stops automatically (command exit)
5. Post-hook: Convert `.cast` to GIF via `agg`
6. Post-hook: Upload GIF as GitHub issue comment attachment
7. Post-hook: Post comment with `## Demo Recording` header + embedded image

**Artifact Comment Protocol Extension**:
```
## Demo Recording

![Terminal recording](https://github.com/OWNER/REPO/assets/NNNN/recording.gif)

Recording of `ralph-impl #42` execution.
Duration: 3m 42s | Phases completed: 3/3
```

**Key Design Decisions**:
- Recordings are opt-in via environment variable: `RALPH_RECORD=true`
- `.cast` files stored in `recordings/` directory (gitignored) — ephemeral
- GIF is the durable artifact (uploaded to GitHub, linked in comment)
- Idle time compression (`-i 2.5`) keeps recordings concise
- No audio in autonomous mode (terminal only)

**Dependencies**:
- `asciinema` CLI installed
- `agg` binary installed (Rust, available via cargo or GitHub releases)
- `gh` CLI for asset upload (already available in ralph-hero workflows)

### Mode 2: Interactive Recording (OBS + obs-cli)

**Trigger**: Explicit skill invocation: `/ralph-hero:record-demo`

**Flow**:
1. User invokes `/ralph-hero:record-demo #NNN`
2. Skill checks OBS is running and WebSocket is reachable (via `obs-cli recording status`)
3. Skill prompts user: "Ready to record. Set up your screen layout, then confirm to start."
4. User confirms -> skill calls `obs-cli recording start`
5. Skill provides guided walkthrough prompts:
   - "Show the GitHub issue in your browser"
   - "Run the command now"
   - "Narrate what's happening"
   - "When done, confirm to stop recording"
6. User confirms -> skill calls `obs-cli recording stop`
7. Skill locates the output file (OBS default recording path)
8. Skill offers post-processing options:
   - Upload as-is to GitHub release asset
   - Trim start/end (via ffmpeg)
   - Generate thumbnail (via ffmpeg)
9. Skill posts `## Demo Recording` comment on the issue

**Key Design Decisions**:
- OBS must be pre-configured by the user (scenes, audio sources, output format)
- Skill does NOT configure OBS — only controls start/stop and provides prompts
- Interactive mode requires user presence (narration, manual triggers)
- Output format: MP4 (OBS default, widely compatible)
- Skill uses AskUserQuestion for pacing and confirmation

**Dependencies**:
- OBS Studio installed and running
- `obs-cli` installed (Go binary, `go install github.com/muesli/obs-cli@latest`)
- WebSocket server enabled in OBS settings (on by default since OBS 28)

### Shared: Video Artifact Pipeline

**Upload Path** (both modes):
1. Recording produced locally (`.cast`/`.gif` or `.mp4`)
2. Upload to GitHub release asset via `gh release upload` or issue attachment
3. Get public URL for the uploaded asset
4. Post issue comment with `## Demo Recording` header + asset link/embedded image

**GitHub Attachment Options**:
| Method | Pros | Cons |
|---|---|---|
| Issue comment drag-drop upload | GitHub hosts it, permanent URL | Requires browser or API workaround |
| Release asset (`gh release upload`) | CLI-friendly, versioned | Requires a release to exist |
| Git LFS | Versioned in repo | Adds repo weight, LFS quota |
| External hosting (asciinema.org, S3) | No GitHub limits | External dependency |

**Recommended**: Use `gh api` to upload via the issue comment attachment API for autonomous mode. For interactive mode, release assets via `gh release upload` since the user can verify before publishing.

### Skill File Inventory

| Skill | Mode | Context | Model | Key Tools |
|---|---|---|---|---|
| `record-demo` | Interactive | inline | sonnet | Bash, AskUserQuestion, Read |
| (hook integration) | Autonomous | fork | haiku | Bash |

The autonomous mode is NOT a standalone skill — it's a recording wrapper integrated via hooks into existing skills. The interactive mode is a new standalone skill.
```

### Success Criteria:

#### Automated Verification:
- [ ] Architecture section appended to research doc

#### Manual Verification:
- [ ] Both modes have clear flow diagrams
- [ ] Dependencies are explicit and installable
- [ ] Artifact Comment Protocol extension is consistent with existing conventions

---

## Phase 3: Artifact Pipeline Design

### Overview
Define how video artifacts are stored, converted, uploaded, and linked — extending the existing Artifact Comment Protocol.

### Changes Required:

#### 1. Pipeline Specification in Research Doc
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md` (append)
**Action**: Add artifact pipeline section

```markdown
## Artifact Pipeline Specification

### File Lifecycle

```
[Recording] -> [Local File] -> [Conversion] -> [Upload] -> [Comment Link]
```

#### Autonomous Mode Pipeline
```
asciinema rec -c "..." -i 2.5 recordings/GH-NNNN.cast
    |
    v
agg --theme monokai --cols 120 --rows 35 recordings/GH-NNNN.cast recordings/GH-NNNN.gif
    |
    v
gh api graphql (upload GIF as issue comment attachment)
    |
    v
ralph_hero__create_comment(number=NNN, body="## Demo Recording\n\n![...](URL)\n\n...")
```

#### Interactive Mode Pipeline
```
obs-cli recording start
    ... user records ...
obs-cli recording stop
    |
    v
ffmpeg -i input.mp4 -ss 00:00:02 -to END -c copy trimmed.mp4  (optional trim)
    |
    v
ffmpeg -i trimmed.mp4 -vf "select=eq(n\,0)" -q:v 2 thumb.jpg  (optional thumbnail)
    |
    v
gh release upload v0.0.0-demos trimmed.mp4 thumb.jpg
    |
    v
ralph_hero__create_comment(number=NNN, body="## Demo Recording\n\n[Watch demo](URL)\n\n...")
```

### Artifact Comment Protocol: `## Demo Recording`

New section header added to the protocol:

| Phase | Header | Content |
|-------|--------|---------|
| Recording | `## Demo Recording` | Video URL (GIF embed or MP4 link) + metadata |

**Comment format (autonomous)**:
```
## Demo Recording

![Terminal recording of ralph-impl #42](https://user-images.githubusercontent.com/.../GH-0042.gif)

- **Mode**: Autonomous (asciinema)
- **Skill**: ralph-impl
- **Duration**: 3m 42s
- **Phases**: 3/3 completed
```

**Comment format (interactive)**:
```
## Demo Recording

[Watch demo recording](https://github.com/OWNER/REPO/releases/download/demos/GH-0042-demo.mp4)

- **Mode**: Interactive (OBS)
- **Duration**: 8m 15s
- **Narrator**: @username
- **Covers**: Full lifecycle from issue to merged PR
```

### Storage & Cleanup

| Artifact | Location | Lifecycle |
|---|---|---|
| `.cast` files | `recordings/` (gitignored) | Ephemeral — delete after GIF conversion |
| `.gif` files | `recordings/` (gitignored) | Ephemeral — delete after upload |
| `.mp4` files | OBS output dir | User manages |
| Uploaded GIF | GitHub issue attachment | Permanent |
| Uploaded MP4 | GitHub release asset | Permanent |

Add to `.gitignore`:
```
recordings/
```
```

### Success Criteria:

#### Automated Verification:
- [ ] Pipeline section appended to research doc

#### Manual Verification:
- [ ] Upload paths are viable (tested with `gh api` for attachments)
- [ ] Comment format is consistent with existing Artifact Comment Protocol headers

---

## Phase 4: Skill Definitions

### Overview
Create skeleton skill files for the interactive recording skill and document the hook integration points for autonomous recording.

### Changes Required:

#### 1. Interactive Recording Skill
**File**: `plugin/ralph-hero/skills/record-demo/SKILL.md`
**Action**: Create new skill definition (skeleton)

```markdown
---
description: Record a product demo with narration and attach to a GitHub issue
context: inline
model: sonnet
allowed_tools:
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
```

#### 2. Autonomous Recording Hook Design
**File**: `thoughts/shared/research/2026-02-22-demo-recording-tools.md` (append)
**Action**: Document hook integration design (not implemented yet)

```markdown
## Autonomous Recording: Hook Integration Design

### Concept

Autonomous recording wraps skill execution inside an asciinema session.
This is NOT a standalone skill — it's a recording layer activated by environment variable.

### Environment Variable

```bash
export RALPH_RECORD=true        # Enable recording
export RALPH_RECORD_IDLE=2.5    # Idle compression threshold (seconds)
export RALPH_RECORD_THEME=monokai  # agg theme for GIF conversion
```

### Integration Point: Shell Script Wrapper

The simplest integration is a wrapper script that existing loop scripts
(`ralph-loop.sh`, `ralph-team-loop.sh`) can optionally invoke:

**`plugin/ralph-hero/scripts/ralph-record-wrap.sh`**:
```bash
#!/usr/bin/env bash
# Wrap a command in an asciinema recording session
# Usage: ralph-record-wrap.sh <issue-number> <skill-name> -- <command...>

ISSUE_NUM="$1"; shift
SKILL_NAME="$1"; shift
shift  # skip --

CAST_FILE="recordings/GH-$(printf '%04d' "$ISSUE_NUM")-${SKILL_NAME}.cast"
GIF_FILE="${CAST_FILE%.cast}.gif"

mkdir -p recordings

# Record the command
asciinema rec \
  -c "$*" \
  -i "${RALPH_RECORD_IDLE:-2.5}" \
  -t "ralph-${SKILL_NAME} #${ISSUE_NUM}" \
  --overwrite \
  "$CAST_FILE"

# Convert to GIF
agg \
  --theme "${RALPH_RECORD_THEME:-monokai}" \
  --cols 120 --rows 35 \
  "$CAST_FILE" "$GIF_FILE"

echo "Recording: $CAST_FILE"
echo "GIF: $GIF_FILE"
```

### Future: Hook-Based Auto-Recording

A more sophisticated approach uses PreToolUse/PostToolUse hooks on the `Skill` tool
to automatically wrap skill invocations. This is deferred to a future implementation plan
once the basic wrapper script is validated.

### Upload Script

**`plugin/ralph-hero/scripts/ralph-record-upload.sh`**:
```bash
#!/usr/bin/env bash
# Upload a recording GIF to a GitHub issue
# Usage: ralph-record-upload.sh <issue-number> <gif-path> <skill-name>

ISSUE_NUM="$1"
GIF_PATH="$2"
SKILL_NAME="$3"

# GitHub doesn't have a CLI for issue attachment upload directly.
# Workaround: use the gh api to create a comment with the GIF.
# For now, we upload to a "demos" release and link it.

RELEASE_TAG="demos"

# Ensure release exists
gh release view "$RELEASE_TAG" 2>/dev/null || \
  gh release create "$RELEASE_TAG" --title "Demo Recordings" --notes "Auto-generated demo recordings"

# Upload
gh release upload "$RELEASE_TAG" "$GIF_PATH" --clobber

# Get URL
ASSET_URL="https://github.com/${RALPH_GH_OWNER}/${RALPH_GH_REPO}/releases/download/${RELEASE_TAG}/$(basename "$GIF_PATH")"

echo "$ASSET_URL"
```
```

### Success Criteria:

#### Automated Verification:
- [ ] Skill skeleton exists at `plugin/ralph-hero/skills/record-demo/SKILL.md`
- [ ] Hook design documented in research doc
- [ ] All shell script examples are syntactically valid

#### Manual Verification:
- [ ] Skill follows existing SKILL.md patterns (frontmatter, steps, tool usage)
- [ ] Hook design is compatible with existing hook architecture in `plugin/ralph-hero/hooks/`
- [ ] The autonomous wrapper could be tested standalone with `asciinema` installed

---

## Testing Strategy

### Phase 1 (Research Doc):
- Review for accuracy against tool documentation
- Verify all URLs resolve

### Phase 2-3 (Architecture & Pipeline):
- Validate that `asciinema rec -c "echo hello" test.cast && agg test.cast test.gif` works
- Validate that `obs-cli recording status` works with a running OBS instance
- Validate `gh release upload` workflow with a test file

### Phase 4 (Skill Definitions):
- Validate SKILL.md frontmatter parses correctly (consistent with other skills)
- Dry-run the wrapper script with a simple command

## Performance Considerations

- asciinema `.cast` files are lightweight (text-based JSON, compresses well)
- GIF conversion via `agg` is fast (Rust, uses gifski encoder)
- OBS MP4 recordings can be large — recommend H.264 encoding with reasonable bitrate
- GitHub release assets have a 2GB limit per file — more than sufficient for demos
- `recordings/` directory should be cleaned periodically (gitignored, ephemeral)

## References

- Existing idea: `thoughts/ideas/2026-02-21-showcase-demo-onboarding.md`
- Artifact Comment Protocol: `plugin/ralph-hero/skills/shared/conventions.md:232-293`
- Skill structure patterns: `plugin/ralph-hero/skills/ralph-impl/SKILL.md` (representative)
- Hook architecture: `plugin/ralph-hero/hooks/scripts/`
- [asciinema docs](https://docs.asciinema.org/manual/cli/)
- [agg](https://github.com/asciinema/agg)
- [obs-cli](https://github.com/muesli/obs-cli)
- [obsws-python](https://github.com/aatikturk/obsws-python)
- [OBS WebSocket](https://github.com/obsproject/obs-websocket)
- [Loom Record SDK](https://dev.loom.com/docs/record-sdk/details/api)
- [Descript API](https://docs.descriptapi.com/)
