# ralph-demo

Sprint-demo video generation for the [Ralph](https://github.com/cdubiel08/ralph-hero) workflow — record a live screen demo or composite a structured demo video from JSON content.

## Overview

`ralph-demo` is a Claude Code sub-plugin that turns sprint work into shareable demo media. It offers two complementary skills (live screen capture vs. programmatic video compositing) backed by a [Remotion](https://www.remotion.dev/) project (`remotion/`, the `demo-studio` package).

Unlike the other sub-plugins, `ralph-demo` is **not** published to npm — it ships as part of this repo.

## Skills

| Skill | Purpose |
|-------|---------|
| `record-demo` | Capture an OBS-based **live screen demo** for a GitHub issue — orchestrates `obs-cli` to record, optionally trim/thumbnail, upload, and post a `## Demo Recording` comment. Requires OBS Studio + `obs-cli` with the OBS WebSocket server running. |
| `demo-video` | Generate a **composited sprint-demo video** with Remotion from structured content (features, screenshots, bullet points). Trigger on "demo video", "sprint recap", "presentation video". |

Pick `record-demo` for a live screen-capture; pick `demo-video` to render a structured video from JSON without recording.

## Architecture

```
plugin/ralph-demo/
├── skills/
│   ├── record-demo/    # OBS screen-capture skill
│   └── demo-video/     # Remotion composited-video skill
└── remotion/           # `demo-studio` — the Remotion video generator (pnpm)
    ├── src/            # React-based video compositions
    ├── inputs/         # JSON content fed to the compositions
    └── remotion.config.ts
```

The `remotion/` project (`demo-studio`) is a [Remotion](https://www.remotion.dev/) app managed with **pnpm**:

```bash
cd plugin/ralph-demo/remotion
pnpm install
pnpm dev      # Remotion studio (preview/iterate)
pnpm build    # render the video
pnpm test     # vitest
```

## Usage

- **Live demo:** invoke the `record-demo` skill (e.g. "record a demo for #NNN") — ensure OBS Studio + `obs-cli` + the OBS WebSocket server are running first.
- **Composited video:** invoke the `demo-video` skill (e.g. "make a sprint demo video") — it feeds structured content (features/screenshots/bullets) into the `demo-studio` Remotion compositions and renders an MP4.

## Links

- Repository: <https://github.com/cdubiel08/ralph-hero>
- Remotion docs: <https://www.remotion.dev/docs>
