---
date: 2026-04-20
type: research
status: decided
tags: [ralph-playwright, bbox, annotation, renderer, spike, decision]
github_issue: 803
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/803
  - https://github.com/cdubiel08/ralph-hero/issues/790
  - https://github.com/cdubiel08/ralph-hero/issues/811
parent_plan: thoughts/shared/plans/2026-04-20-GH-0790-ralph-playwright-bbox-evidence-screenshots.md
---

# Bbox Renderer Design Decision — Spike (GH-803)

## Context

Feature F of the ralph-playwright Opus 4.7 vision epic (#784) needs to render annotated screenshots. Opus 4.7 produces pixel-accurate bounding-box coordinates; we need to draw rectangles + labels on PNG screenshots so signal evidence is visually obvious.

Parent issue #790 lists three candidate approaches:

| # | Approach | Pro | Con |
|---|----------|-----|-----|
| a | Extend `playwright-cli` with an `annotate` subcommand | In-process, no extra runtime | Couples annotation to CLI release cycle, requires forking external npm package |
| b | Node helper using `sharp` | Standalone, fast PNG manipulation | Adds native-bindings dep |
| c | SVG sidecar overlay files | Zero dependencies, editable | No `.annotated.png` output; requires viewer support |

## Evaluation Criteria

Inherited from the feature plan's shared constraints:

1. **Minimal-dependencies posture** — ralph-playwright ships no npm-built artifacts today. Any added dep must be justified.
2. **Deterministic output** — identical input must produce byte-identical `<stem>.annotated.png`. Non-determinism would poison downstream semantic diff (#791).
3. **Filename contract** — `<stem>.annotated.png` sibling to `<stem>.png`. This is referenced by #817 and cannot drift.
4. **Pixel coordinate system** — 1:1 with the PNG pixels (no DPR scaling, no downsample).
5. **Graceful degradation** — renderer exit 0 with no output when `bboxes` is empty.
6. **Reusability** — one entry point invoked by #817 from capture, explore, and test-e2e act paths.

## Option Analysis

### (a) Extend playwright-cli with an `annotate` subcommand

- `playwright-cli` is an external npm package installed via `/ralph-playwright:setup`. ralph-playwright's skills shell out to it.
- Adding a subcommand requires either (i) forking the package, or (ii) shipping a wrapper script that mimics a CLI surface.
- Option (ii) is effectively the same as (b) but with extra indirection (user types `playwright-cli annotate` instead of invoking our script directly).
- Option (i) is infeasible without sustained upstream coordination.
- **Verdict: rejected.** Couples annotation to an external release cycle we do not control; offers no technical advantage over (b).

### (b) Node helper using `sharp`

- `sharp` is a high-performance image processing library with native bindings (libvips).
- Adds a runtime dependency with native-binding install overhead (~50MB, platform-specific binaries).
- Proven PNG round-tripping; easy to draw rects + text via `composite` + SVG-as-input.
- Determinism: sharp's composite pipeline is deterministic for identical inputs.
- **Verdict: rejected for minimal-dep posture.** ralph-playwright's current posture is skills/agents only — adding a native-binding dep would be the first such dep in the plugin and requires justification we do not have when a pure-Node alternative exists.

### (c) SVG sidecar overlay files

- Produces `<stem>.annotated.svg` with `<image href="<stem>.png"/>` and `<rect>` + `<text>` overlays.
- Zero dependencies.
- **Breaks the filename contract** — the parent issue explicitly requires `.annotated.png`. Renderers consuming `.annotated.png` as PNG bytes (e.g., for inlining in notes, pasting into issue bodies, or rasterizing for OCR in #791) would need an SVG→PNG rasterizer anyway, reintroducing a dep.
- **Verdict: rejected as primary output.** SVG is useful as a debug artifact but fails the `.annotated.png` contract.

### (d) Pure-Node PNG writer — chosen approach

Not in the original three candidates but emerges naturally from the constraints. The Node standard library has `zlib` for DEFLATE and `Buffer` for binary manipulation — enough to write a valid PNG from scratch. The rendering workload is trivial:

1. Decode the input PNG to a raw RGBA pixel buffer (Node's `zlib.inflateSync` + PNG chunk parser).
2. Draw rectangles and text labels by mutating the pixel buffer directly (writing RGBA bytes at computed offsets).
3. Encode the resulting buffer back to PNG (`zlib.deflateSync` + PNG chunk writer).
4. Write to `<stem>.annotated.png`.

**Benefits:**
- Zero dependencies. Uses Node stdlib only (`fs`, `zlib`, `Buffer`, `path`).
- Deterministic by construction — `zlib.deflateSync` with fixed compression level produces byte-identical output for identical input.
- Controls the entire pixel pipeline — no DPR confusion, no font-rendering variability.
- Aligns with ralph-playwright's minimal-dep posture (zero runtime deps, like the rest of the plugin).

**Costs:**
- Implementing a minimal PNG decoder/encoder is ~200-300 LOC (IHDR, IDAT, IEND chunks; PLTE and tRNS are not needed since screenshots from Playwright are always RGBA). Ungzip → filter-revert → pixel mutate → filter → gzip → chunk out.
- Text rendering: to avoid shipping a font file, use a simple bitmap font (5x7 pixel glyphs for digits, uppercase A-Z, and punctuation) hard-coded as bit patterns. Sufficient for short notes.
- Labels are optional per the schema — when `note` is absent, we draw only the rectangle, avoiding most text-rendering complexity.

**Implementation location**: `plugin/ralph-playwright/scripts/annotate.mjs` — new ESM Node script, invoked as:

```bash
node /path/to/annotate.mjs --input foo.png --bboxes foo.bboxes.json --output foo.annotated.png
```

`bboxes.json` is a JSON array of `{screenshot, x, y, w, h, note?}` objects, matching the schema shape from #805.

## Renderer Interface

```
render(png_path: string, bboxes: BBox[], output_path?: string) -> annotated_png_path: string

BBox = {
  screenshot: string,  // filename of input PNG (for validation)
  x: number,           // integer >= 0, top-left X pixel
  y: number,           // integer >= 0, top-left Y pixel
  w: number,           // integer >= 1, width in pixels
  h: number,           // integer >= 1, height in pixels
  note?: string        // optional label rendered above the box
}
```

**Contract:**
- Output path defaults to `<stem>.annotated.png` sibling of input PNG.
- If `bboxes` is empty (zero length): emit no output, exit 0.
- If any bbox references a `screenshot` filename not matching the input PNG's basename: exit 1 with a readable error (consistent with validator hook in #808).
- Rectangle stroke: 3px, RGB `(255, 0, 0)` (red), fully opaque.
- Label (when `note` present): bitmap font, 5x7 glyphs at 2x scale (10x14 pixel chars), rendered above the box with a 2px padded solid-white background pill for legibility. If the box is at y=0, the label is rendered inside the top of the box instead.
- Output is byte-identical across runs (verified by repeated invocation in unit tests).

## Filename Convention

Sibling of the input PNG, `.annotated.png` suffix before the final extension:
- `00_page.png` → `00_page.annotated.png`
- `evidence_42.png` → `evidence_42.annotated.png`

Callers (#817) MUST produce the annotated file in the same directory as the original. The act-phase promotion then copies both to `thoughts/local/assets/<note-slug>/` preserving the naming.

## Out of Scope for the Renderer (Spike Scope)

- Multi-bbox overlap resolution — overlapping bboxes are drawn as-is, no merge/z-ordering.
- Bbox coordinate rounding — schema enforces integers; renderer does not coerce floats.
- Color/stroke customization — fixed constants for determinism.
- Font metrics beyond the 5x7 bitmap — longer labels are truncated at 40 chars with `...` suffix.
- Interactive SVG viewer — SVG sidecar is not produced.

## Downstream Impact

- **#811** (renderer impl) — implements `plugin/ralph-playwright/scripts/annotate.mjs` to this contract, adds unit tests for: one bbox, multiple bboxes, bbox at image edge, missing `note`, empty bboxes array.
- **#817** (act-phase promotion) — invokes the renderer via `node plugin/ralph-playwright/scripts/annotate.mjs ...` when processing a signal whose `evidence.bboxes[]` is non-empty, then promotes both original and annotated to `thoughts/local/assets/<note-slug>/`.
- **#791** (semantic diff, future) — explicitly skips `*.annotated.png` when walking a session (already planned in the feature plan's "What We're NOT Doing" section).

## Decision

**Chosen: (d) Pure-Node PNG writer** — ships as `plugin/ralph-playwright/scripts/annotate.mjs`, zero dependencies, deterministic output, respects the `.annotated.png` filename contract, aligns with ralph-playwright's skills-only posture.

Rejected (a), (b), (c) for reasons above.

## References

- Parent: [GH-790](https://github.com/cdubiel08/ralph-hero/issues/790)
- Epic: [GH-784](https://github.com/cdubiel08/ralph-hero/issues/784)
- This spike: [GH-803](https://github.com/cdubiel08/ralph-hero/issues/803)
- Downstream impl: [GH-811](https://github.com/cdubiel08/ralph-hero/issues/811)
- Feature plan: [thoughts/shared/plans/2026-04-20-GH-0790-ralph-playwright-bbox-evidence-screenshots.md](https://github.com/cdubiel08/ralph-hero/blob/main/thoughts/shared/plans/2026-04-20-GH-0790-ralph-playwright-bbox-evidence-screenshots.md)
- Research anchor: `thoughts/shared/research/2026-04-16-opus-4-7-ralph-playwright-vision.md` §Part 3 Item 6
