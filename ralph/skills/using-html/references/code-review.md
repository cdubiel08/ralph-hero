# Reference: Code review & understanding

Three sub-shapes share this reference — pick the one that matches the request.

**Canon:** <https://thariqs.github.io/html-effectiveness/03-code-review-pr.html> (annotated
review) · <https://thariqs.github.io/html-effectiveness/17-pr-writeup.html> (PR writeup) ·
<https://thariqs.github.io/html-effectiveness/04-code-understanding.html> (module map)
**JS budget:** None (writeup) to Micro (≤ ~15 lines: file collapse, diagram-node click).

---

## (a) Annotated PR review — reviewer's side

**Trigger:** "review this PR", "review this diff", "what's risky in this change". Renders a diff
as something scannable — risk map up top, file cards with inline margin comments.

**Anatomy:** `.pr-head` (`.repo-line`, an `<h1>`, a `.meta-row` with `.branch`→`.branch`,
`.stat.add`/`.stat.del`, an `.avatar`) → **`.risk-map`** of `.file-chip`s (each a `.dot`
`.attention/.medium/.safe` + path) with a `.legend` → one **`.file-card`** per file
(`.file-head` with `.file-path` + `.sev` risk tag + `.file-delta`) whose `.body` holds a `.diff`
(`.hunk` header, `.diff-row` rows — `.add`/`.del`, each with `.ln` + `.code`, `.mark` for inline
highlights) and a `.comments` stack of `.bubble` (`.blocking` / `.nit` / `.ctx`, each with a mono
`.label`) → a `.next-steps` block with a `.checklist`. Micro JS: click a `.file-head` to
collapse its body.

```html
<div class="risk-map">
  <span class="file-chip"><span class="dot attention"></span>auth/session.ts</span>
  <span class="file-chip"><span class="dot safe"></span>README.md</span>
  <span class="legend">● blocking ● review ● safe</span>
</div>

<div class="file-card">
  <div class="file-head"><span class="file-path">auth/session.ts</span>
    <span class="sev high">High</span><span class="file-delta">+38 −4</span></div>
  <div class="body">
    <div class="diff">
      <div class="hunk">@@ rotateToken() @@</div>
      <div class="diff-row del"><span class="ln">21</span><span class="code">  return sign(payload)</span></div>
      <div class="diff-row add"><span class="ln">21</span><span class="code">  return sign(payload, { <span class="mark">expiresIn: '15m'</span> })</span></div>
    </div>
    <div class="comments">
      <div class="bubble blocking"><span class="label">Blocking</span>No refresh path — a 15m
        expiry logs everyone out mid-session.</div>
    </div>
  </div>
</div>

<div class="next-steps"><h2>Next steps</h2>
  <ul class="checklist"><li>Add a refresh-token path</li><li class="done">Expiry is configurable</li></ul>
</div>
```

---

## (b) PR writeup — author's side

**Trigger:** "write the PR description", "explain this change for reviewers", "write up this PR".
No JS — native `<details>`.

**Anatomy:** `.pr-head` + `.toc` chip row → `.tldr` + `.lede` → **`.ba`** before/after
(`.panel` + `.panel.after`) → a **file tour** of `<details>` accordions, each summarizing a file
with a `.why` paragraph (`<b>` the motivation) → **`.focus`** list of `.item` (`.n` + what + why)
telling reviewers where to look → **`.tests`** `.checklist` → **`.rollout`** of `.step` rows
(`.n` + `.when` + description).

```html
<div class="pr-head"><div class="repo-line">acme/api · PR #312</div>
  <h1>Move notification delivery onto a queue</h1></div>
<div class="toc"><a href="#why">Why</a><a href="#tour">File tour</a><a href="#focus">Where to look</a></div>
<div class="tldr"><b>TL;DR</b> — delivery moves from inline to a worker so a slow provider can't
  block the request path.</div>
<div class="ba">
  <div class="panel"><div class="label">Before</div>send happens inside the request</div>
  <div class="panel after"><div class="label">After</div>request enqueues; a worker delivers</div>
</div>
<div class="focus"><div class="item"><span class="n">1</span><div><b>Retry semantics</b> in
  worker.ts — confirm at-least-once is acceptable.</div></div></div>
```

---

## (c) Module map — code understanding

**Trigger:** "explain how X works in this repo", "map this package", "trace the auth flow".
Centerpiece is an SVG boxes-and-arrows diagram with the **hot path** highlighted.

**Anatomy:** `.repo-line` + a short summary → **`.diagram-panel`** holding the inline `<svg>`
module map (boxes + arrows; mark the hot path) → numbered **`.step`** call-path entries (`.badge`
number + body + `.step-loc` file:line) each with a `.snippet` (`.code` `<pre>`, `.dim` context
lines, `.hot` highlighted lines) → **`.key-files`** list of `.kf` (`.path` + description) →
**`.gotchas`** `<ul>` with `<b>` leading clauses. Micro JS: click a diagram box to scroll to its
step.

```html
<div class="diagram-panel"><svg viewBox="0 0 640 160"><!-- boxes + arrows, hot path in accent --></svg></div>
<div class="step"><span class="badge">1</span>
  <div><div class="step-loc">middleware/auth.ts:18</div>
    <p>Every request hits <code>requireUser()</code> first.</p>
    <div class="snippet"><pre><span class="dim">app.use(</span><span class="hot">requireUser</span><span class="dim">)</span></pre></div>
  </div></div>
<div class="key-files">
  <div class="kf"><span class="path">middleware/auth.ts</span><span>Entry gate; resolves the session.</span></div>
</div>
```

## Anti-patterns (group, each with why)

- **Don't render a diff as a plain `<pre>` block.** The margin comments, risk tags, and add/del
  coloring are the entire reason to leave the terminal. A monochrome `<pre>` is just a worse
  `git diff`.
- **Don't bury "where to focus" in prose.** Reviewers triage by it — make it a `.focus` list so
  they can jump straight to the parts that need judgment.
- **For a module map, the SVG must show the hot path**, not just every box. An undifferentiated
  box-and-line diagram carries no more meaning than a file listing; highlighting the path the code
  actually takes is the value.
- **Don't mix the reviewer view (a) and author view (b).** A review flags risk; a writeup sells
  the change. Pick the one the user asked for.
