# Reference: Implementation plan

**Canon:** <https://thariqs.github.io/html-effectiveness/16-implementation-plan.html>
**JS budget:** None. Pure layout.

**Trigger this workflow when** the user says "turn this into a plan", "implementation plan
for…", "milestones for…", "how would you build X", "write the hand-off doc", or after a
comparison has been decided and now needs sequencing. This is the doc you hand the implementer —
plan-shaped, not comparison-shaped. (If the user wants to *compare* options, that's
`references/specs.md`.)

## Page anatomy

Top → bottom:

1. **`.page-head`** — `.eyebrow` (e.g. `Plan · acme/web-client`) + `<h1>` (what's being built) +
   `.prompt-box` quoting the request.
2. **`.summary` grid** — 3–5 `.cell` k/v pairs giving the at-a-glance frame: scope, estimate,
   owner, risk level, dependencies. Use `.v.accent` on the one headline value.
3. **`.milestones`** — a left-rail timeline of `.milestone` rows (`.when` date · `.rail` with
   `.dot`/`.line` · `.ms-body`). Mark shipped/known-good milestones with `.dot.done`. Each
   `.ms-body` has an `<h3>`, a sentence of detail, and `.tags` (`.tag` pills for the touched
   areas).
4. **`.diagram`** — one inline `<svg>` data-flow showing how the pieces connect, with a
   `.caption`. Hand-draw it; don't paste a screenshot.
5. **`.mocks`** (optional) — a grid of `.mock` cards, each a `.mock-label` + `.mock-body` inline
   UI sketch of a screen the plan introduces.
6. **`.risks`** — a table of `.risk-row` (a `.sev` `.high/.med/.low` pill + a `.what` description
   whose `.mit` line states the mitigation). A plan with no called-out risks reads as naïve.
7. **`.open-q`** — unresolved questions, each `.oq` with a `.qt` question and an `.owner` who
   should answer it.

## Worked example — header + summary + one milestone + a risk

```html
<header class="page-head">
  <div class="eyebrow">Plan · acme/web-client</div>
  <h1>Comment threads on task cards</h1>
  <div class="prompt-box"><span class="label">PROMPT</span>
    Turn the threaded-comments comparison into an implementation plan.</div>
</header>

<div class="summary">
  <div class="cell"><div class="k">Scope</div><div class="v accent">4 milestones</div></div>
  <div class="cell"><div class="k">Estimate</div><div class="v">~1.5 weeks</div></div>
  <div class="cell"><div class="k">Risk</div><div class="v">Medium</div></div>
  <div class="cell"><div class="k">Owner</div><div class="v">web team</div></div>
</div>

<div class="milestones">
  <div class="milestone">
    <div class="when">May 26</div>
    <div class="rail"><div class="dot done"></div><div class="line"></div></div>
    <div class="ms-body">
      <h3>1 · Comment data model + API</h3>
      <p>Add the <code>comments</code> table and the read/write endpoints.</p>
      <div class="tags"><span class="tag">db</span><span class="tag">api</span></div>
    </div>
  </div>
  <!-- more milestones; last one drops the .line -->
</div>

<svg class="..." viewBox="0 0 600 140"><!-- inline data-flow diagram --></svg>

<div class="risks">
  <div class="risk-row">
    <span class="sev high">High</span>
    <div class="what">Realtime fan-out could swamp the socket server.
      <span class="mit">Mitigation: batch deliveries on a 250ms window; cap thread depth.</span></div>
  </div>
</div>

<div class="open-q">
  <div class="oq"><span class="qt">Soft-delete or hard-delete comments?</span>
    <span class="owner">— needs product</span></div>
</div>
```

## Anti-patterns (each with why)

- **Don't write the plan as a flat numbered list.** The timeline + risk table are what make it
  scannable and hand-off-able; a numbered list is Markdown with extra steps.
- **Don't omit the risk table.** A plan that names no risks reads as either naïve or
  over-confident. The `.sev` pills let a reviewer triage what to push back on in seconds.
- **Don't screenshot the architecture.** Hand-draw the data-flow as inline SVG so it stays
  self-contained and tweakable.
- **Don't bury open questions in prose.** Surface them as `.open-q` with an owner, so the reader
  knows exactly what's still undecided and who unblocks it.
