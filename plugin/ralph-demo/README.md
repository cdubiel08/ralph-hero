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

CI runs the same `compositions` + `typecheck` pair. There are no unit tests: the
scaffold owns no logic, and the drift that actually happened was in the types.

Known flake: the first render on a fresh machine may need one retry after the
~94MB chrome-headless-shell download.

## Links

- Repository: <https://github.com/cdubiel08/ralph-hero>
- Remotion docs: <https://www.remotion.dev/docs>
