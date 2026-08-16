---
date: 2026-08-15
issue: GH-1749
epic: GH-1748
topic: playwright-cli video capture — end-to-end validation
status: validated
---

# playwright-cli video capture: measured, not assumed

GH-1748's capture stage depends on `video-start`/`video-stop`, which were listed in
`plugin/ralph-playwright/skills/browser/SKILL.md` but had never been run in this repo.
This is the measurement pass. Environment: `@playwright/cli` 1.59.0-alpha-1771104257000,
macOS arm64, headless Chrome channel, a local static page on `http://localhost:8791/`
with three buttons (increment / background toggle / reset).

## Verdict

**The CLI path works and wins for v1.** Four captures produced playable, non-blank VP8
WebM files with real interaction frames. The one blocker for a polished artifact is
frame size: the CLI cannot ask for one, and Playwright's default caps it at 800x800.

## What the surface actually is

`video-start` takes **no arguments** — the issue body and the previous SKILL.md line both
implied `video-start <file>`. The path belongs to `video-stop --filename`. It also refuses
before a browser exists (`The browser '<s>' is not open`), so the order is
`open` → `video-start` → drive → `video-stop`.

**`video-chapter` does not exist.** It is not in `--help` and is rejected as
`Unknown command`. Nothing in the CLI marks positions inside a recording.

**Every error exits 0.** Measured: `video-stop` with no recording in progress prints
`### Error / Video recording has not been started.` and exits 0; a second `video-start`
prints `Video recording has already been started.` and exits 0; an unknown subcommand
dumps usage and exits 0 when its output is piped. (`video-chapter` exited 1 only when
stdout was redirected to `/dev/null` — the code is not a stable signal either way.)
A scripted pipeline must grep stdout for `### Error`. This is the repo's standing
"exit 0 is not evidence" rule showing up in a new place.

Omitting `--filename` writes `.playwright-cli/video-<ISO>.webm` at the root, outside the
session directory the skill's conventions promise. The session dir is caller-constructed
here exactly as it is for `screenshot`/`snapshot`.

## Measured artifact properties

| capture | duration (format) | frames | size | dimensions |
|---|---|---|---|---|
| CLI, 30 s idle+drive | 30.320 s | 758 | 250 572 B | 800x450 |
| CLI, 4 interactions | 8.200 s | 205 | 88 484 B | 800x450 |
| CLI, viewport resized to 1280x720 first | 4.120 s | — | 32 337 B | **800x450** |
| API, `video().start({size:1280x720})` | 3.840 s | 96 | 79 657 B | **1280x720** |

Constant across all: Matroska/WebM, **VP8**, **25 fps**, no audio track.

Frames extracted at several timestamps from the 8.2 s capture show the counter at
1 → 2 → 3 with the background toggle landing between them, so interactions are captured
faithfully under headless — not a blank or thumbnail-sized capture.

### Frame size is the real constraint

Playwright's `recordVideo` / `video().start()` default is "viewport scaled down to fit
into 800x800". `playwright-cli video-start` exposes no options at all, so that default is
unreachable-past. `resize 1280 720` before `video-start` genuinely changes the viewport
(the CLI echoes `page.setViewportSize`) and the recording still came out 800x450 —
the viewport sets the *aspect*, the 800px cap sets the *scale*.

`page.video().start({ size })` accepts explicit dimensions and produced a true 1280x720
file. So the documented epic fallback (`browser.newContext({recordVideo})`) is real and
available, but is only needed for resolution — not for correctness.

### Duration metadata: the caveat is real but misplaced

GH-1749 anticipated unreliable WebM duration. What is actually missing is at the
**stream** level: `stream=duration` and `stream=nb_frames` are both `N/A`, so the
obvious `ffprobe -show_entries stream=duration` returns empty and reads as a broken file.
The **format** duration is present and was exact in every capture — each equals decoded
frame count ÷ 25 to the millisecond.

For the assemble stage, prefer the decoded frame count; it is the one number that cannot
disagree with itself:

```bash
ffprobe -v error -count_frames -select_streams v:0 \
  -show_entries stream=nb_read_frames -of csv=p=0 demo.webm
```

Note `-count_frames` decodes the whole file. Fine at these sizes (a 30 s clip is 250 KB).

### ffprobe is not installed on this machine

No `ffmpeg`/`ffprobe` on PATH and no Homebrew keg. This validation used the npm-vendored
binaries (`@ffprobe-installer/ffprobe`, `@ffmpeg-installer/ffmpeg`). Any assemble stage
that measures durations needs to bring its own binary or declare the dependency —
tracked separately rather than assumed.

## Recommendation for GH-1748

Use the CLI path. It composes with the rest of the browser skill, the artifact is a
correct 25 fps VP8 WebM, and 800x450 is adequate for an inline PR/issue demo. Reach for
the API fallback only if the deliverable is specified at ≥720p. Segment with separate
clips rather than chapters. Never trust a `video-*` exit code.
