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
