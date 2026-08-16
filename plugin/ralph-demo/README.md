# ralph-demo

Demo-video scaffold for the [Ralph](https://github.com/cdubiel08/ralph-hero) workflow.

## Status

Rebuilding (epic #1748). The v1 framework — an OBS screen-capture skill, an 8-step
interview skill, and a JSON-contract layer over Remotion — was deleted in #1750: it
was specced twice and produced zero video artifacts, and the contract layer broke at
the render boundary. What remains is the scaffold the v2 pipeline
(capture → script → assemble → deliver) builds on. There is no working skill here yet.

`ralph-demo` is **not** published to npm — it ships as part of this repo.

## The scaffold

```
plugin/ralph-demo/remotion/
├── package.json
├── tsconfig.json
├── remotion.config.ts
├── scripts/
│   └── measure-clip.mjs   # captured clip -> durationInFrames
└── src/
    ├── index.ts     # registerRoot
    ├── Root.tsx     # one composition, `Demo`
    └── Demo.tsx     # blank stage
```

One composition. Duration comes from props via `calculateMetadata`, never from a
constant declared beside the composition — that is what truncated renders at 495
frames in v1.

```bash
cd plugin/ralph-demo/remotion
pnpm install
pnpm compositions   # lists `Demo`
pnpm typecheck
pnpm dev            # Remotion studio
```

## Measuring a captured clip (GH-2017)

`calculateMetadata` derives the composition length from props, so the assemble
stage has to supply a real number. A Playwright WebM cannot answer at the stream
level — `stream=duration` and `stream=nb_frames` are both `N/A` (GH-1749) — and
`ffprobe` is not on PATH on every machine. **Remotion vendors its own ffprobe**,
so the scaffold's existing dependencies are the whole answer; nothing else is
installed.

```bash
pnpm measure ../../../path/to/demo.webm            # 30 fps, the Demo composition
pnpm measure demo.webm --fps 25
# {"frames":96,"sourceFps":25,"seconds":3.84,"compositionFps":30,"durationInFrames":116}
```

It counts *decoded* frames — the one number that cannot disagree with itself —
and derives the rest. Every failure (no ffprobe, missing file, unreadable
stream, zero frames) exits non-zero with a named remedy and prints nothing: a
duration that could not be measured is never emitted as `0`.

CI runs `compositions` + `typecheck` + `test:measure`. The scaffold itself owns
no logic to unit-test — the drift that actually happened was in the types — but
`measure-clip.mjs` does, so it is tested against a WebM built at run time from
PNG frames (`pnpm test:measure`), which also proves the vendored toolchain is
present.

Known flake: the first render on a fresh machine may need one retry after the
~94MB chrome-headless-shell download.

## Links

- Repository: <https://github.com/cdubiel08/ralph-hero>
- Remotion docs: <https://www.remotion.dev/docs>
