# ralph-demo

Demo-video scaffold for the [Ralph](https://github.com/cdubiel08/ralph-hero) workflow.

## Status

Epic #1748. The v1 framework — an OBS screen-capture skill, an 8-step interview
skill, and a JSON-contract layer over Remotion — was deleted in #1750: it was
specced twice and produced zero video artifacts, and the contract layer broke at
the render boundary. What replaced it is **one judgment skill on a five-file
scaffold** (#1751): `/ralph-demo:demo` captures browser footage, writes narration
grounded in the actual diff, writes a bespoke composition, verifies by looking at
rendered frames, and delivers a release asset plus a `## Demo` comment.

The first real demo video is #1752 — until that closes, this pipeline has been
run but not yet dogfooded end to end on shipped work.

`ralph-demo` is **not** published to npm — it ships as part of this repo.

## The skill

`skills/demo/SKILL.md` — goal and judgment, no phase choreography. Its
references are offline-complete:

- `references/remotion-idioms.md` — the distilled framework: the pure-function
  rule, `spring`/`interpolate`, `Sequence`, `OffthreadVideo`, the
  `calculateMetadata` rule, and the verified command set.
- `references/examples/` — `TitleCard.tsx` and `CaptionedClip.tsx`, idiom
  demonstrations rather than importable code. They are **typechecked**
  (`pnpm typecheck:examples`) against the real Remotion API, because the drift
  that actually happened in v1 was in the types.

There is deliberately no template layer, no preset list, and no JSON contract.
The composition for a given demo is written for that demo.

## The scaffold

```
plugin/ralph-demo/remotion/
├── package.json
├── tsconfig.json
├── remotion.config.ts
├── scripts/
│   ├── measure-clip.mjs   # captured clip -> durationInFrames
│   └── render.sh          # the one hardened entry: real exit codes
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

## Rendering (GH-1751)

`scripts/render.sh` is the one contract at the mutation path — gates are RUN,
not predicted, so nothing in this plugin reports a render it did not perform.

```bash
pnpm render --props /tmp/props.json --out /tmp/demo-GH-NNN.mp4
# stdout is the output path and nothing else; Remotion's progress goes to stderr
```

Exit codes: `2` bad input, nothing attempted · `1` the render failed · `3` it
exited 0 and wrote nothing · `0` the printed path is a real non-empty file.
`pnpm test:render` asserts every one of them, including a real 2-frame render
(~2s) — a suite that only proved the refusals would leave the claim that
matters unchecked.

It does **not** retry. The first render on a fresh machine can fail once on the
~94MB chrome-headless-shell download; a broken composition fails the same way,
and deciding which you have is a judgment the caller makes, not one a script
should hide.

CI runs `compositions` + `typecheck` + `test:measure` today; wiring
`typecheck:examples` and `test:render` in beside them is tracked on #2010, which
is the apply unit that owns this repo's demo CI job. The scaffold itself owns
no logic to unit-test — the drift that actually happened was in the types — but
`measure-clip.mjs` does, so it is tested against a WebM built at run time from
PNG frames (`pnpm test:measure`), which also proves the vendored toolchain is
present.

Known flake: the first render on a fresh machine may need one retry after the
~94MB chrome-headless-shell download.

## Links

- Repository: <https://github.com/cdubiel08/ralph-hero>
- Remotion docs: <https://www.remotion.dev/docs>
