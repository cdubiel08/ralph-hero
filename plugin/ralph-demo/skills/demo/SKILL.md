---
description: Produce a captioned MP4 demoing something just built — capture browser footage, write narration grounded in the actual diff, assemble a bespoke Remotion composition, self-verify by looking at rendered frames, deliver as a release asset plus a `## Demo` comment. Triggers on "demo this", "demo what we just did", "make a demo video", "record a demo of GH-NNN", or a PR/branch handed to ralph-demo.
argument-hint: "[<issue-number> | <pr-number> | <branch> | (empty = demo what this session just did)]"
context: inline
model: sonnet
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# /ralph-demo:demo — one captioned MP4, grounded in what actually shipped

Given something just built or tested, produce a captioned MP4 that explains it,
and attach it where the work lives.

This skill does not choreograph phases. It states what must be true of the
artifact and what the equipment is; you sequence capture, script, assembly and
delivery at the depth the change deserves. A one-screen UI tweak is a 20-second
clip with four captions. An epic is not — and if the change has no visible
surface at all, say so and produce slides rather than pretending.

**Everything is bespoke except the scaffold.** There is no template layer, no
JSON contract, no preset list. v1 had all three and produced zero videos across
two specs: a generator that renders the wrong product correctly is worse than no
generator. You write a composition for *this* change, in TSX, on the one
composition the scaffold owns.

## The two things that must be true

1. **The narration is grounded.** Every caption is a claim about the change, and
   every claim is checkable against the diff, the issue body, or the journey you
   actually drove. Read the diff. A demo that describes a feature the code does
   not have is worse than no demo, because it is confidently wrong at a glance.
2. **You looked at it.** Before rendering, render spot frames and `Read` the
   PNGs. Type-checking proves the code loads; it proves nothing about whether a
   caption sits off the bottom edge or the footage letterboxed into a sliver.

## Equipment

The scaffold is `plugin/ralph-demo/remotion` — five files, one composition
(`Demo`), duration derived from props via `calculateMetadata`. Read
[references/remotion-idioms.md](references/remotion-idioms.md) before writing
TSX; it is offline-complete and every command in it was run. The two examples in
[references/examples/](references/examples/) are **idiom demonstrations, not
importable code** — copy the shapes, write your own.

Optional, granted and never prescribed: `npx skills add remotion-dev/skills`
installs Remotion's official skills, which are broader than our reference.

### Capture

Browser footage comes from playwright-cli, whose conventions are
`plugin/ralph-playwright/skills/browser/SKILL.md`. The sequence, validated end
to end in GH-1749:

```bash
mkdir -p .playwright-cli/<session>
playwright-cli -s=<session> open <url>     # video-start refuses without an open browser
playwright-cli -s=<session> video-start    # takes NO arguments; recording starts HERE
# ... drive the journey you want on screen ...
playwright-cli -s=<session> video-stop --filename=".playwright-cli/<session>/demo.webm"
```

Four things bite:

- **Every `video-*` error exits 0.** A `video-stop` with nothing recording, a
  double `video-start`, a typo'd subcommand — all print `### Error` on stdout and
  exit 0. Grep the output; the exit code is not a signal.
- **The path is given only on `video-stop --filename`.** Omit it and the clip
  lands at `.playwright-cli/video-<ISO>.webm` in the repo root, outside the
  session convention, where you will not look for it.
- **Recording starts at `video-start`, not at `open`.** Navigate and let the page
  settle first unless the load is part of the story.
- **Output is 800x450, 25fps, VP8, no audio** — capped at 800px on the long edge
  and not configurable from the CLI (`resize` changes the viewport, not the
  recording). Fine for an inline PR demo. If the deliverable genuinely needs
  720p, the Playwright API fallback in the browser skill produces it; that is a
  judgment call worth one line in the close-out, not a default.

`video-chapter` does not exist. Segment by recording separate clips.

### Assemble

Copy the capture into `remotion/public/` — `staticFile()` resolves there and a
bundled render cannot reach outside it. Measure it, because a Playwright WebM
cannot state its own length (`stream=duration` and `stream=nb_frames` are both
`N/A`):

```bash
cd plugin/ralph-demo/remotion
pnpm install
pnpm measure public/demo.webm      # -> durationInFrames, in COMPOSITION frames
```

That number goes in the props file. It is the whole reason `calculateMetadata`
exists — a `durationInFrames` constant declared beside the composition is what
truncated v1's renders at 495 frames, so do not reintroduce one.

Write your composition into `remotion/src/` and wire it into `Demo`. Keep
`Root.tsx`'s `calculateMetadata` shape intact.

### Render — the one hardened entry

```bash
bash plugin/ralph-demo/remotion/scripts/render.sh --props /tmp/props.json --out /tmp/demo-GH-NNN.mp4
```

Gates are RUN, not predicted: never report a render you did not perform, and
never infer the outcome from the code. Real exit codes — `2` you passed
something wrong and nothing was attempted, `1` the render failed (Remotion's own
output is above it), `3` it claimed success and wrote nothing. On success the
path it prints is a file that exists.

It does **not** retry. The first render on a fresh machine can fail once on the
~94MB chrome-headless-shell download, and that is the one failure worth
re-running; a broken composition is not. Deciding which you have is yours,
which is why the script does not decide for you.

## The degradation ladder

Each rung is an honest artifact, not a failure. Say which rung you landed on.

- **No live UI to capture** — a CLI change, a library, a workflow, a board rule:
  slides plus captions. `TitleCard.tsx` shows the idiom. Do not fabricate a
  browser session to have footage; a demo of a thing that has no screen is a
  demo of nothing.
- **Capture failed, or the UI would not come up:** slides, and name the failure
  in the `## Demo` comment. A demo that quietly skips the part that did not work
  reads as a demo of a working system.
- **The render failed after one retry:** ship the WebM capture plus `script.md`
  (the narration, timestamped) as the artifact. The footage and the words are the
  content; the MP4 is the packaging.
- **Nothing renderable at all:** say so, in one line, with what you tried. Do not
  attach a placeholder.

## Delivery

GitHub's API cannot attach video to a comment, so the video is a **release
asset** and the comment links it:

```bash
gh release create demo-GH-NNN /tmp/demo-GH-NNN.mp4 \
  --title "Demo: GH-NNN <one clause>" --notes "Demo video for #NNN" 
gh issue comment NNN --body "$(cat <<'EOF'
## Demo

<one-paragraph what the video shows>

- Video: <release asset URL>
- Narration: <link to script.md, or inline it>
- Captured: <what was driven, against what>
EOF
)"
```

Comment on the PR instead when the change is in flight and the PR is where the
conversation is. One or the other — not both.

The narration you wrote is content, not scaffolding: keep it as `script.md`
beside the artifact or inline in the comment, so a reader who will not watch a
video still gets the explanation.

## Boundaries

This skill produces a demo of work that already exists. It does not change the
work. If driving the journey surfaces a bug, that is a **finding** — file it
(`board create`) or name it in the comment; do not fix it here and do not demo
around it silently. A demo that routes past a broken path is the one thing this
lane must never ship.

It also claims nothing and moves no board state. It is called *by* a session
that already holds the unit — `/ralph:work` may offer this lane at close-out on
a feature unit, granted and never prescribed — or by a human pointing at a
merged change.
