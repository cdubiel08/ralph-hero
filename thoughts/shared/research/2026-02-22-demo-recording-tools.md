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
