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
