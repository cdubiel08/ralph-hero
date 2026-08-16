# Remotion, distilled

Everything here was run against the scaffold at `plugin/ralph-demo/remotion`
(Remotion 4.0.507) rather than recalled. Offline-complete on purpose: the demo
lane must work with no network beyond the one `pnpm install`, so nothing below
tells you to go read a docs page mid-render.

Optional equipment, granted and never prescribed: `npx skills add
remotion-dev/skills` installs Remotion's own official skills. They are better
than this file at breadth. This file is what you need to not get stuck.

## The one rule the framework is built on

**A frame is a pure function of its frame number.** `useCurrentFrame()` in,
pixels out. Renders run across parallel workers that jump straight to arbitrary
frames, so anything that remembers a previous frame — `useState` driven by a
timer, `setInterval`, a `<video>` element seeking itself, a random number drawn
at mount — renders one way in the studio and another way in the MP4. Every
Remotion API below exists to keep you inside that rule.

- `spring({ fps, frame, config: { damping: 120 } })` — entrances. Deterministic.
- `interpolate(frame, [inFrame, outFrame], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })`
  — everything else. **Clamp both ends**: unclamped is the default and a ramp
  that keeps going produces opacity 3 and offscreen transforms.
- `useVideoConfig()` — `fps`, `width`, `height`, `durationInFrames` of the
  composition you are inside.
- `<Sequence from={f} durationInFrames={n}>` — places a child on the timeline
  *and shifts its frame origin to 0*, so the child animates its own entrance
  without knowing where it sits. Prefer it to a conditional on the frame number.
- `<AbsoluteFill>` — a full-bleed absolutely-positioned div. Layers stack in
  document order; footage first, captions after.

`<TransitionSeries>` (crossfades, wipes) lives in `@remotion/transitions`, which
this scaffold does **not** install. `Sequence` plus an `interpolate`d opacity
covers the same ground for a demo; install the package only if you decide the
demo genuinely needs it, and say so in the close-out.

## Video footage: OffthreadVideo, never `<video>`

```tsx
import { OffthreadVideo, staticFile } from "remotion";
<OffthreadVideo src={staticFile("demo.webm")} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
```

`OffthreadVideo` extracts the exact frame being rendered outside the browser
tab. A plain `<video>` renders whichever frame it happened to have decoded —
the classic "looks right in the studio, stutters in the MP4".

`staticFile("x.webm")` resolves against `remotion/public/`. That directory is
not in the scaffold; create it and **copy the capture in** rather than pointing
at a path elsewhere on disk — a bundled render cannot reach outside the public
dir.

The captures this lane produces are 800x450 (playwright-cli caps recordings at
800px on the long edge) while the composition is 1920x1080. `objectFit:
"contain"` letterboxes; `cover` crops away the UI edges the demo exists to show.

## calculateMetadata — the rule that cost v1 its renders

Composition length is a property of the **input**, so it is computed from props,
never declared as a constant beside the composition. A hardcoded
`durationInFrames` truncated v1's renders at 495 frames. `Root.tsx` already has
the correct shape:

```tsx
<Composition
  id="Demo"
  component={Demo}
  fps={30}
  width={1920}
  height={1080}
  defaultProps={demoDefaultProps}
  calculateMetadata={({ props }) => ({ durationInFrames: props.durationInFrames })}
/>
```

Keep it. A composition whose duration does not come from props is the one edit
that reintroduces the bug class this scaffold was built to make unrepresentable.

Where the number comes from: `pnpm measure <clip.webm>` (see the scaffold
README). A Playwright WebM cannot answer at the stream level — `stream=duration`
and `stream=nb_frames` are both `N/A` (GH-1749) — so the measurement is a
decoded frame count, converted into composition frames for you.

## The commands, verified

```bash
cd plugin/ralph-demo/remotion
pnpm install                       # once; also fetches the vendored ffprobe
pnpm compositions                  # lists `Demo` — the cheapest "does it load"
pnpm typecheck                     # tsc --noEmit
pnpm measure <clip.webm>           # -> {"durationInFrames": N, ...}
pnpm dev                           # studio, for a human

# spot frame — the self-verification loop; Read the PNG, don't assume
npx remotion still src/index.ts Demo /tmp/f30.png --props=/tmp/props.json --frame=30

# the render — go through the hardened entry, not the bare CLI
bash scripts/render.sh --props /tmp/props.json --out /tmp/demo.mp4
```

Gotchas, all observed:

- **`npx remotion render --help` renders.** It does not print help; it runs a
  full render into `out/Demo.mp4` with default props. `npx remotion help render`
  is the help.
- **`--props` takes a path.** `--props=/tmp/props.json`. Passing JSON inline
  works for toys and dies on shell quoting for any real narration script.
- **Default output is `out/Demo.mp4`, default codec h264.** `out/` is gitignored.
- **First render on a fresh machine downloads chrome-headless-shell (~94MB)**
  and may fail once. That is the flake worth exactly one retry — and only once.
  `scripts/render.sh` deliberately does not retry for you: distinguishing the
  flake from a broken composition is a judgment, and a script that quietly
  retried would hide which one you had.

## Self-verification

Rendering a frame and *looking* at it is the only check that catches the
failures that matter here — a caption off the bottom edge, footage letterboxed
into a sliver, black frames where `staticFile` resolved to nothing. `tsc` and
`compositions` prove the code loads; they say nothing about whether the video is
watchable. Render two or three stills across the timeline, `Read` the PNGs, then
render.
