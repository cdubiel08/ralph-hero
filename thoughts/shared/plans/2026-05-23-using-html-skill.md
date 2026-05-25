---
date: 2026-05-23
status: ready
type: plan
topic: using-html skill
spec: thoughts/shared/research/2026-05-23-using-html-skill-design.md
---

# `using-html` Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author the personal `using-html` skill at `~/.claude/skills/using-html/` (SKILL.md + assets/theme.css + assets/skeleton.html) so Claude Code produces HTML artifacts — instead of long Markdown — for design comparisons and research syntheses, per the approved spec.

**Architecture:** Three files in a single personal-skill directory. `SKILL.md` carries the trigger description and per-workflow guidance in imperative voice. `assets/theme.css` holds the "marine ink on cream" palette + component styles so the visual identity doesn't drift across invocations. `assets/skeleton.html` is the doctype/meta shell the agent inlines theme.css into. No build step, no version control for the target files (personal skills live outside repos).

**Tech Stack:** Plain Markdown + YAML frontmatter (SKILL.md), CSS3 custom-properties (theme.css), HTML5 (skeleton.html). Verification via `playwright-cli` screenshots of a kitchen-sink fixture, then live invocation against three eval prompts after a session reload.

---

## File Structure

Personal skill directory (target — outside any git repo):

```
~/.claude/skills/using-html/
├── SKILL.md
└── assets/
    ├── theme.css         (palette vars + all component styles)
    └── skeleton.html     (doctype + meta + title + style placeholder)
```

Worktree artifacts (this repo — get committed):

```
thoughts/shared/plans/2026-05-23-using-html-skill.md            (this plan)
thoughts/shared/research/2026-05-23-using-html-skill-design.md  (the spec)
```

**A note on commits**: Because the target files live in `~/.claude/skills/`, not in any repo, the per-task `git commit` step from the writing-plans template doesn't apply. Each task ends with a verification step instead. After all tasks land, the plan + spec stay committed in the worktree.

---

## Task 1: Scaffold directory + SKILL.md frontmatter

**Files:**
- Create: `~/.claude/skills/using-html/`
- Create: `~/.claude/skills/using-html/assets/`
- Create: `~/.claude/skills/using-html/SKILL.md` (frontmatter + H1 + section stubs only)

- [ ] **Step 1: Create the directory tree**

```bash
mkdir -p ~/.claude/skills/using-html/assets
```

- [ ] **Step 2: Verify the directories exist**

```bash
ls -la ~/.claude/skills/using-html/
```

Expected: `assets/` directory present, no other entries yet.

- [ ] **Step 3: Write SKILL.md with frontmatter and section stubs**

Write the following to `~/.claude/skills/using-html/SKILL.md` exactly. Body sections are stubs that later tasks fill in.

```markdown
---
name: using-html
description: Use when producing multi-option design comparisons, research synthesis docs, status/incident reports, or any Claude Code output that would otherwise be a long Markdown document. Reach for this skill whenever the user asks to "compare", "explore options", "research", "summarize findings", "write up", "synthesize", or "explain how X works" — and especially when the output will exceed ~100 lines, contain side-by-side options, or be shared with another person. HTML beats Markdown for these by a wide margin (visual hierarchy, tables, SVG diagrams, navigability); default to invoking this skill even if the user doesn't explicitly ask for HTML.
---

# using-html

(intro filled in by Task 4)

## Core principles

(filled in by Task 4)

## File location & finisher

(filled in by Task 4)

## Workflow: Specs & design comparison

(filled in by Task 5)

## Workflow: Research reports

(filled in by Task 6)
```

- [ ] **Step 4: Verify SKILL.md is well-formed**

```bash
head -5 ~/.claude/skills/using-html/SKILL.md
test -f ~/.claude/skills/using-html/SKILL.md && echo "exists" || echo "MISSING"
```

Expected: frontmatter starts with `---`, `name: using-html` on line 2, `exists` printed.

---

## Task 2: Author `assets/theme.css`

**Files:**
- Create: `~/.claude/skills/using-html/assets/theme.css`

CSS is split into four blocks for clarity but lives in one file. Write all four blocks in sequence into the same file.

- [ ] **Step 1: Write the `:root` palette + reset + body baseline**

Write the following to `~/.claude/skills/using-html/assets/theme.css`. This is the foundation — every other rule references these custom properties.

```css
/* --- :root palette + type stacks (marine ink on cream) --- */
:root {
  --paper:    #f5f1e8;
  --ink:      #1b2329;
  --accent:   #2e5d7e;
  --rust:     #b35a2c;
  --moss:     #5a7847;
  --sand:     #e6dcc4;
  --slate:    #1f262b;
  --gray-150: #ece7db;
  --gray-300: #cdc6b7;
  --gray-500: #847d6c;
  --gray-700: #3a3a36;
  --white:    #ffffff;

  --serif: 'Iowan Old Style', Charter, ui-serif, Georgia, serif;
  --sans:  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:  'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--paper);
  color: var(--gray-700);
  font-family: var(--sans);
  font-size: 15px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
  padding: 56px 32px 96px;
}

.page { max-width: 1360px; margin: 0 auto; }

h1 {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 38px;
  line-height: 1.15;
  color: var(--ink);
  margin-bottom: 18px;
  letter-spacing: -0.01em;
}

h2 {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 22px;
  color: var(--ink);
  margin: 40px 0 14px;
  scroll-margin-top: 24px;
}

p { margin-bottom: 12px; max-width: 680px; }
code { font-family: var(--mono); font-size: 13px; }
a { color: var(--accent); text-decoration: none; border-bottom: 1px solid currentColor; }
ul { padding-left: 20px; max-width: 680px; }
li { margin-bottom: 6px; }
```

- [ ] **Step 2: Append the shared component styles (eyebrow, tldr, callout, card, details, tabs)**

Append the following to the same file.

```css
/* --- shared components used by both workflows --- */

.eyebrow {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--gray-500);
  margin-bottom: 10px;
}

.tldr {
  border: 1.5px solid var(--gray-300);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  background: var(--white);
  padding: 16px 18px;
  margin-bottom: 8px;
  max-width: 760px;
}
.tldr b { color: var(--ink); }

.callout {
  display: flex;
  gap: 12px;
  border: 1.5px solid var(--sand);
  background: rgba(230, 220, 196, 0.35);
  border-radius: 10px;
  padding: 14px 16px;
  margin: 18px 0;
  font-size: 14px;
  max-width: 760px;
}
.callout .ico { color: var(--accent); font-weight: 600; }

.card {
  background: var(--white);
  border: 1.5px solid var(--gray-300);
  border-radius: 12px;
  padding: 24px;
}

details {
  border: 1.5px solid var(--gray-300);
  border-radius: 10px;
  background: var(--white);
  margin: 14px 0;
  overflow: hidden;
  max-width: 760px;
}
details summary {
  list-style: none;
  cursor: pointer;
  padding: 14px 16px;
  font-family: var(--serif);
  font-size: 16px;
  color: var(--ink);
  display: flex;
  align-items: baseline;
  gap: 10px;
}
details summary::-webkit-details-marker { display: none; }
details summary::before {
  content: "▸";
  color: var(--accent);
  font-family: var(--sans);
  font-size: 12px;
  transition: transform 120ms;
}
details[open] summary::before { transform: rotate(90deg); }
details summary .where {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--gray-500);
  margin-left: auto;
}
details .body { padding: 0 16px 16px; }
details .body p { font-size: 14px; }

.tabs {
  border: 1.5px solid var(--gray-300);
  border-radius: 10px;
  background: var(--white);
  margin: 16px 0 8px;
  overflow: hidden;
  max-width: 760px;
}
.tabs .tabbar {
  display: flex;
  border-bottom: 1px solid var(--gray-300);
  background: var(--gray-150);
}
.tabs .tabbar button {
  appearance: none;
  border: none;
  background: none;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--gray-500);
  padding: 10px 16px;
  cursor: pointer;
  border-right: 1px solid var(--gray-300);
}
.tabs .tabbar button.on {
  background: var(--white);
  color: var(--ink);
  border-bottom: 2px solid var(--accent);
  margin-bottom: -1px;
}
.tabs pre {
  display: none;
  margin: 0;
  padding: 16px 18px;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink);
  overflow-x: auto;
}
.tabs pre.on { display: block; }
```

- [ ] **Step 3: Append the spec-workflow components (header band, approaches grid, tradeoffs, chips, reco, code panel)**

Append the following to the same file.

```css
/* --- spec workflow: comparison cards --- */

.prompt-box {
  background: var(--gray-150);
  border: 1.5px solid var(--gray-300);
  border-radius: 12px;
  padding: 16px 20px;
  font-size: 14.5px;
  color: var(--gray-700);
  max-width: 760px;
}
.prompt-box .label {
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--gray-500);
  display: block;
  margin-bottom: 6px;
}

.approaches {
  display: grid;
  gap: 28px;
  margin-bottom: 56px;
}
.approaches[data-n="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.approaches[data-n="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.approaches[data-n="4"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 1100px) {
  .approaches[data-n="2"],
  .approaches[data-n="3"],
  .approaches[data-n="4"] { grid-template-columns: 1fr; }
}

.approach {
  background: var(--white);
  border: 1.5px solid var(--gray-300);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.approach-head h2 {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 21px;
  color: var(--ink);
  margin-bottom: 6px;
}
.approach-head .num {
  display: inline-block;
  font-family: var(--mono);
  font-size: 12px;
  background: var(--sand);
  color: var(--ink);
  padding: 2px 8px;
  border-radius: 8px;
  margin-right: 8px;
  vertical-align: 3px;
}
.approach-head p {
  font-size: 14px;
  color: var(--gray-500);
}

/* code panel inside an approach card */
.code {
  background: var(--slate);
  border-radius: 12px;
  padding: 18px 20px;
  overflow-x: auto;
}
.code pre {
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.65;
  color: #E8E6DE;
  white-space: pre;
}
.code .kw  { color: var(--accent); }   /* keywords -> marine teal */
.code .str { color: var(--moss); }     /* strings  -> moss        */
.code .cm  { color: var(--gray-500); } /* comments -> warm gray   */
.code .fn  { color: #c9b98a; }         /* identifiers, warm tan   */

.tradeoffs {
  border: 1.5px solid var(--gray-300);
  border-radius: 8px;
  overflow: hidden;
  font-size: 13px;
}
.tradeoffs .row { display: grid; grid-template-columns: 1fr 1fr; }
.tradeoffs .row + .row { border-top: 1.5px solid var(--gray-300); }
.tradeoffs .cell { padding: 10px 14px; }
.tradeoffs .cell:first-child { border-right: 1.5px solid var(--gray-300); }
.tradeoffs .head {
  background: var(--gray-150);
  font-weight: 600;
  color: var(--ink);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.tradeoffs .pro::before,
.tradeoffs .con::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: 2px;
}
.tradeoffs .pro::before { background: var(--moss); }
.tradeoffs .con::before { background: var(--rust); }

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.chip {
  font-family: var(--mono);
  font-size: 11.5px;
  background: var(--gray-150);
  border: 1.5px solid var(--gray-300);
  color: var(--gray-700);
  padding: 5px 10px;
  border-radius: 8px;
  white-space: nowrap;
}
.chip strong { color: var(--ink); font-weight: 600; }

.reco {
  border-left: 4px solid var(--accent);
  background: var(--white);
  border-radius: 0 12px 12px 0;
  padding: 24px 28px;
  max-width: 860px;
}
.reco h2 {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 22px;
  color: var(--ink);
  margin-bottom: 10px;
}
.reco p { font-size: 15px; margin-bottom: 8px; }
.reco code {
  background: var(--gray-150);
  padding: 1px 6px;
  border-radius: 4px;
}
```

- [ ] **Step 4: Append the report-workflow components (sticky nav layout, FAQ)**

Append the following to the same file.

```css
/* --- report workflow: sticky-nav editorial layout --- */

.report {
  max-width: 1100px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 48px;
}
@media (max-width: 920px) {
  .report { grid-template-columns: 1fr; }
  .report nav { display: none; }
}

.report nav {
  position: sticky;
  top: 32px;
  align-self: start;
  font-size: 13px;
}
.report nav .label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--gray-500);
  margin-bottom: 12px;
}
.report nav a {
  display: block;
  padding: 5px 0 5px 12px;
  border-left: 2px solid var(--gray-300);
  color: var(--gray-700);
  text-decoration: none;
  border-bottom: none;
}
.report nav a:hover { color: var(--ink); border-color: var(--ink); }
.report nav a.l2 { padding-left: 24px; font-size: 12.5px; color: var(--gray-500); }
.report nav .files {
  margin-top: 28px;
  border-top: 1px solid var(--gray-300);
  padding-top: 16px;
}
.report nav .files code {
  display: block;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--gray-500);
  padding: 3px 0;
}

dl.faq { margin-top: 8px; max-width: 680px; }
dl.faq dt {
  font-family: var(--serif);
  font-size: 16px;
  color: var(--ink);
  margin-top: 18px;
}
dl.faq dd { font-size: 14px; margin: 4px 0 0; }
```

- [ ] **Step 5: Verify theme.css is complete**

```bash
wc -l ~/.claude/skills/using-html/assets/theme.css
grep -c '^}' ~/.claude/skills/using-html/assets/theme.css
```

Expected: ~270 lines, ~50 closing braces (one per rule block). If the closing-brace count is off by more than 2, scan for an unbalanced rule.

---

## Task 3: Author `assets/skeleton.html`

**Files:**
- Create: `~/.claude/skills/using-html/assets/skeleton.html`

- [ ] **Step 1: Write the skeleton with two named placeholders**

Write the following to `~/.claude/skills/using-html/assets/skeleton.html`. The placeholders `{{TITLE}}` and `{{THEME_CSS}}` are filled in by the agent at generation time.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<style>
{{THEME_CSS}}
</style>
</head>
<body>
<!-- agent fills body content here -->
</body>
</html>
```

- [ ] **Step 2: Verify skeleton is well-formed**

```bash
cat ~/.claude/skills/using-html/assets/skeleton.html
grep -c '{{TITLE}}' ~/.claude/skills/using-html/assets/skeleton.html
grep -c '{{THEME_CSS}}' ~/.claude/skills/using-html/assets/skeleton.html
```

Expected: both placeholders appear exactly once.

---

## Task 4: SKILL.md body — Intro, Core principles, File location & finisher

**Files:**
- Modify: `~/.claude/skills/using-html/SKILL.md`

This task replaces the three stub sections (`# using-html`, `## Core principles`, `## File location & finisher`) with imperative-voice instructions.

- [ ] **Step 1: Replace the intro section**

Use Edit to replace the line `(intro filled in by Task 4)` (immediately after `# using-html`) with the following content:

```markdown
You produce self-contained HTML artifacts in place of long Markdown when the output benefits from visual structure — side-by-side comparisons, sticky-nav navigability, callouts, diagrams, or anything a reader will share with someone else. The two workflows below cover the common shapes: a **comparison/specs** layout for ≥2-option decisions, and a **research report** layout for synthesis docs.

Every artifact is one HTML file — no CDNs, no external assets, no `<script src>`. It must work offline, as an email attachment, and after being uploaded to a wiki.

Read `assets/theme.css` and `assets/skeleton.html` from this skill directory before writing each artifact. Inline `assets/theme.css` into the `<style>` block of `assets/skeleton.html` (replacing the `{{THEME_CSS}}` placeholder), fill in the `{{TITLE}}` placeholder, then write the result as one file to the location specified below.
```

- [ ] **Step 2: Replace the Core principles section**

Replace `(filled in by Task 4)` under `## Core principles` with:

```markdown
- **One file, fully self-contained.** Inline CSS, inline SVG, inline vanilla JS only if interactive (≤ ~15 lines for tab switchers and similar). Zero CDNs, zero external assets, zero `fetch()`. If you find yourself reaching for a `<link rel>` or `<script src>`, stop — the artifact must keep working when uploaded or emailed.
- **Read the bundled assets every time.** Use the Read tool on `assets/theme.css` and `assets/skeleton.html` from this skill directory. Inline the CSS into the skeleton's `<style>` block. Don't reconstruct the palette from memory — that's where visual drift comes from.
- **JS posture.** Small inline vanilla JS is part of the toolkit (tab switching, no-op `<details>` is already native). No frameworks, no `<script src=...>`, no `import` from a CDN.
- **Syntax highlighting.** Hand-code `<span class="kw|str|cm|fn">` inside `<pre>` blocks. The theme defines those four classes against the slate code-panel background. Don't invoke Prism, highlight.js, or any other library — they break self-containment and produce colors that fight the palette.
- **Imperative voice in any prose.** This is an artifact, not a tutorial. Lead with what IS, not what the reader should do.
```

- [ ] **Step 3: Replace the File location & finisher section**

Replace `(filled in by Task 4)` under `## File location & finisher` with:

```markdown
Resolve the output path before writing. Prefer a project-local `thoughts/shared/html-out/` when running inside a repo that has a `thoughts/` directory (this gets the artifact into the user's corpus for later retrieval); otherwise write to `~/claude-html-out/`.

Run this bash snippet via the Bash tool (substituting `<topic-slug>` for a kebab-case short label of the artifact):

```bash
if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  if [ -d "$git_root/thoughts" ]; then
    out_dir="$git_root/thoughts/shared/html-out"
  fi
fi
out_dir="${out_dir:-$HOME/claude-html-out}"
mkdir -p "$out_dir"
date_part=$(date +%Y-%m-%d)
slug="<topic-slug>"
out="$out_dir/$date_part-$slug.html"
n=2
while [ -e "$out" ]; do
  out="$out_dir/$date_part-$slug-$n.html"
  n=$((n + 1))
done
echo "$out"
```

The final `echo "$out"` gives you the resolved path. Use it as the Write target.

After writing the file, finish the turn in this order:

1. Run `open "$out"` via Bash — opens in the default browser.
2. Restate the resolved path in chat on its own line so the user has it if they missed the `open` flash.

Don't summarize the artifact's contents in chat after opening — the artifact speaks for itself, and the chat summary just duplicates work.
```

- [ ] **Step 4: Verify the three sections now contain real content**

```bash
grep -c "filled in by Task" ~/.claude/skills/using-html/SKILL.md
wc -l ~/.claude/skills/using-html/SKILL.md
```

Expected: `grep` returns 2 (the two remaining workflow stubs), file is now ~80-100 lines.

---

## Task 5: SKILL.md body — Workflow: Specs & design comparison

**Files:**
- Modify: `~/.claude/skills/using-html/SKILL.md`

- [ ] **Step 1: Replace the Specs workflow stub**

Use Edit to replace `(filled in by Task 5)` under `## Workflow: Specs & design comparison` with the following.

```markdown
**Trigger this workflow when** the user says "compare these approaches", "tradeoffs between X and Y", "show me N ways to...", "what are my options for...", "side-by-side", "explore designs for...", or asks any question that produces ≥2 candidate solutions to a single decision.

### Page anatomy

Build the page in this order from top to bottom:

1. **Header band** — `.eyebrow` (mono uppercase, e.g. `Exploration · acme/web-client`) + `<h1>` (the question being decided in serif) + `.prompt-box` (the user's original question quoted verbatim under a mono "PROMPT" label).
2. **`.approaches` grid** — CSS grid of 2-4 cards. Set `data-n="3"` (or whatever N is) on the grid so the breakpoint matches the option count.
3. **Each `<article class="approach">` card** contains, in order:
   - `<header class="approach-head">` with a numbered badge (`<span class="num">01</span>`), an `<h2>` (the approach name), and a `<p>` dek (one-line summary).
   - **Code panel** (`<div class="code"><pre>...</pre></div>`) if the approach is code-shaped. Inside the `<pre>`, mark up keywords/strings/comments/identifiers with `<span class="kw">`, `<span class="str">`, `<span class="cm">`, `<span class="fn">`. Don't use a JS highlighter — the theme is already tuned to these four classes against the slate background.
   - **Tradeoffs grid** (`<div class="tradeoffs">`): one `.row.head` with "Pro" and "Con" cells, then 3-5 `.row` blocks each with a `.cell.pro` and a `.cell.con`. The colored dots come from the CSS — don't add emoji.
   - **Chips** (`<div class="chips">`): mono pills with concrete numbers — bundle size, latency, complexity rating, anything quantifiable. Use `<strong>` for the value within the chip.
4. **`.reco` aside** — accent left-border block at the bottom. Name the recommended approach by its number AND name in bold, explain in 1-3 sentences *why*, and note conditions under which a different choice becomes correct.

### Worked example — header + one card

```html
<header class="page-head">
  <div class="eyebrow">Exploration · acme/web-client</div>
  <h1>Three ways to debounce search</h1>
  <div class="prompt-box">
    <span class="label">PROMPT</span>
    Show me three different ways to implement debounced search for the
    task filter input, with tradeoffs for each.
  </div>
</header>

<section class="approaches" data-n="3">
  <article class="approach">
    <header class="approach-head">
      <h2><span class="num">01</span>Inline useEffect + setTimeout</h2>
      <p>Debounce logic lives directly inside the component that owns the input.</p>
    </header>
    <div class="code"><pre><span class="kw">export function</span> <span class="fn">TaskSearch</span>() {
  <span class="kw">const</span> [draft, setDraft] = <span class="fn">useState</span>(<span class="str">''</span>);
  <span class="cm">// ...</span>
}</pre></div>
    <div class="tradeoffs">
      <div class="row head">
        <div class="cell">Pro</div>
        <div class="cell">Con</div>
      </div>
      <div class="row">
        <div class="cell pro">Zero new abstractions</div>
        <div class="cell con">Logic duplicated wherever search exists</div>
      </div>
    </div>
    <div class="chips">
      <span class="chip">Bundle: <strong>+0 kb</strong></span>
      <span class="chip">Reuse: <strong>low</strong></span>
    </div>
  </article>
  <!-- two more <article class="approach"> cards -->
</section>

<aside class="reco">
  <h2>Recommendation</h2>
  <p>Go with <strong>approach 02, the custom <code>useDebounce</code> hook</strong>. There are already three places using the inline pattern, so extracting one shared hook removes duplication without taking on a new dependency.</p>
</aside>
```

### Anti-patterns (each with why)

- **Don't list "approaches" as bullet paragraphs without cards.** The grid is what makes side-by-side comparison glanceable; collapsed into bullets, the reader is back to sequential prose and we might as well have shipped Markdown.
- **Don't bury tradeoffs in prose.** Show them in the 2-column pro/con grid. Prose forces the reader to extract and mentally tabulate; the grid lets them scan across approaches in seconds — that scanning ability is the whole reason we went to HTML.
- **Don't use a 2-column grid when there are 3 options.** Set `data-n="3"` so the third card aligns under the heading. Two-up with one orphan card on row two breaks the comparison shape.
- **Don't conclude with "depends on context".** The reader came to make a decision. Pick the approach that best fits the stated constraints and name it. If genuinely no winner exists, write one sentence explaining why — that's still an answer.
- **Don't use a JS syntax highlighter or default-monospace `<code>` blocks.** The theme ships `.kw`/`.str`/`.cm`/`.fn` spans tuned to the palette; a generic highlighter (Prism, highlight.js) adds bytes, breaks self-containment, and produces colors that fight the slate background.

### Permitted variants

- **2 approaches** → `data-n="2"`; still keep the recommendation aside.
- **Non-code comparisons** (architecture choices, vendor selection) → drop the code panel, keep header/tradeoffs/chips.
- **Visual design directions** (palettes, layouts, empty-state treatments) → drop BOTH the code panel and the tradeoffs grid; replace with a stage that shows the actual visual. Reference: <https://thariqs.github.io/html-effectiveness/02-exploration-visual-designs.html>. The canon uses a card-per-direction grid where each card contains a `.stage` wrapping an `.artboard` (the live mockup canvas), a small `.rationale` paragraph underneath, and optional toolbar controls (`.toolbar` + `.seg` + `.field`) when the direction is tunable. Per-direction theme overrides — class hooks like `.es-a`/`.es-b`/`.es-c`/`.es-d` on each card — let every card render its own palette without changing the surrounding chrome. H1 stays descriptive ("Four visual directions for the empty state"); H2s per card are usually omitted in favor of `.title` + `.tag`.

> **Canon reference for this workflow:** <https://thariqs.github.io/html-effectiveness/01-exploration-code-approaches.html> is the worked example this anatomy is derived from. The plan's `data-n="N"` attribute is a flexibility enhancement — the canon hardcodes `grid-template-columns: repeat(3, 1fr)` per page since each demo knows its own card count. Both work; the plan's mechanism lets one stylesheet serve 2/3/4-card pages.
```

- [ ] **Step 2: Verify the Specs workflow section landed**

```bash
grep -A1 "## Workflow: Specs" ~/.claude/skills/using-html/SKILL.md | head -3
grep -c "filled in by Task" ~/.claude/skills/using-html/SKILL.md
```

Expected: section header followed by "Trigger this workflow when…"; `grep -c` returns 1 (only the Research stub remaining).

---

## Task 6: SKILL.md body — Workflow: Research reports

**Files:**
- Modify: `~/.claude/skills/using-html/SKILL.md`

- [ ] **Step 1: Replace the Research workflow stub**

Use Edit to replace `(filled in by Task 6)` under `## Workflow: Research reports` with the following.

```markdown
**Trigger this workflow when** the user says "research X and report back", "summarize what you found", "investigate Y", "write up your findings", "explain how Z works", "feature explainer for...", "incident timeline / postmortem of...", or asks for any synthesis of findings from multiple sources/files into one durable document.

### Page anatomy

Wrap the page in `<div class="report">` to activate the two-column grid layout:

1. **Sidebar (`<nav>`)** — sticky 200px, hidden under 920px (the CSS already handles the breakpoint). Inside:
   - `<div class="label">ON THIS PAGE</div>` + anchor `<a>` links for each H2. For nested step lists, add `class="l2"` to the child links so they indent.
   - **"Files read" footer** at the bottom — `<div class="files">` containing `<div class="label">FILES READ</div>` and one `<code>` per file path. Include this whenever the report is grounded in a codebase; it lets the reader verify by grepping the same paths.
2. **Main column (`<main>`)** in this order:
   - `<header>` with `.eyebrow` (e.g. `Research · feature summary`) + `<h1>` (may contain `<code>` for module/path names).
   - `.tldr` callout — one paragraph max, `<b>` on the most important claim.
   - `<h2>` sections with `id="..."` for the anchor links. The CSS gives them `scroll-margin-top: 24px` so anchors land below any sticky chrome.
3. **Inline content patterns** — use as fits:
   - **Accordions** for step-by-step or optional drill-down. `<details><summary>1 · Identify the caller <span class="where">middleware/ratelimit.ts:21</span></summary><div class="body"><p>…</p></div></details>`. The mono `.where` slot on the right is for the file:line citation.
   - **Tabs** for the same concept across config / call-site / response. Wrap in `<div class="tabs" data-tabs>` with a `.tabbar` of `<button data-t="0">` etc. and `<pre>` panes whose first carries `class="on"`. Then add this 10-line vanilla JS at the bottom of the body:

     ```html
     <script>
     document.querySelectorAll("[data-tabs]").forEach(box => {
       const btns = box.querySelectorAll("button");
       const panes = box.querySelectorAll("pre");
       btns.forEach(b => b.addEventListener("click", () => {
         btns.forEach(x => x.classList.remove("on"));
         panes.forEach(x => x.classList.remove("on"));
         b.classList.add("on");
         panes[+b.dataset.t].classList.add("on");
       }));
     });
     </script>
     ```
   - **Callouts** for tips and gotchas — `<div class="callout"><span class="ico">★</span><div>…</div></div>`.
   - **FAQ** — `<dl class="faq"><dt>Question?</dt><dd>Answer.</dd></dl>`. 3-6 entries max.
   - **Gotchas** — a plain `<ul>` with `<b>` on the leading clause of each `<li>`.

### Worked example — sidebar + header + TL;DR

```html
<div class="report">
  <nav>
    <div class="label">ON THIS PAGE</div>
    <a href="#tldr">TL;DR</a>
    <a href="#path">Request path</a>
    <a href="#path" class="l2">1. Identify</a>
    <a href="#path" class="l2">2. Bucket lookup</a>
    <a href="#config">Configuring a route</a>
    <div class="files">
      <div class="label">FILES READ</div>
      <code>middleware/ratelimit.ts</code>
      <code>lib/tokenBucket.ts</code>
      <code>config/limits.yaml</code>
    </div>
  </nav>

  <main>
    <header>
      <div class="eyebrow">Research · feature summary</div>
      <h1>How rate limiting works in <code>acme/api</code></h1>
      <div class="tldr" id="tldr">
        <b>TL;DR</b> — Every request runs <code>rateLimit()</code>, which resolves the caller to a bucket key and either consumes one token or returns <code>429</code>.
      </div>
    </header>

    <h2 id="path">The request path</h2>
    <details open>
      <summary>1 · Identify the caller <span class="where">middleware/ratelimit.ts:21</span></summary>
      <div class="body"><p>The middleware reduces the request to a <code>bucketKey</code>…</p></div>
    </details>
    <!-- more steps, more sections -->
  </main>
</div>
```

### Anti-patterns (each with why)

- **Don't write a Markdown-style linear wall of `<p>` tags.** A report that's just paragraphs down a single column is Markdown with extra steps. Use the structural patterns — TOC, sections with anchors, callouts, accordions — so the reader has entry points and signposts. Navigability is the point of going to HTML.
- **Don't put the sidebar nav in normal flow.** Without `position: sticky` (which `.report nav` already sets), it scrolls off and becomes useless on page two. The nav exists so the reader can jump between sections at any scroll position.
- **Don't omit the "Files read" footer on code-grounded reports.** Naming the files makes the report verifiable — the reader can grep the same paths and check the claims. Without it, the report is "trust me." With it, it's "here's exactly what I looked at."
- **Don't write a multi-paragraph TL;DR.** The TL;DR exists so a skimmer gets the headline claim in 10 seconds. If it takes two paragraphs, it isn't a TL;DR — it's the introduction, and you've defeated its purpose.
- **Don't hide must-read content inside `<details>`.** Accordions are for optional drill-down (steps, sub-procedures, less-common cases). If the reader *must* see something to understand the report, put it inline.
- **Don't end with a "Recommendation" aside.** Reports describe what IS — how a system works, what the data shows, what happened in an incident. Prescription belongs in the specs workflow, not here.

### Permitted variants

- **Status / weekly report** → drop the sidebar (omit `<div class="report">` wrapper, use `<main>` directly), single column. Reference: <https://thariqs.github.io/html-effectiveness/11-status-report.html>. Canon H2s are `Highlights / Shipped / Velocity / Carryover`. Use a `.summary-band` near the top, a small `.chart-panel` containing one inline `<svg>` velocity chart, `.stat-card` blocks with `.stat-num` + `.stat-label` + `.stat-delta` for KPI deltas (apply `.up`/`.warn` modifiers for direction), and `.carryover` rows containing `.carry-item` + `.carry-tag` pills with a `.risk-dot` (`.high`/`.med`/`.low`) per item.

- **Incident timeline / postmortem** → main is a left-rail timeline, NOT a vertical `<ol>`. Reference: <https://thariqs.github.io/html-effectiveness/12-incident-report.html>. Canon H2s are `Timeline / Root cause / Impact / Action items`. The timeline is a `<section class="timeline">` of `.tl-entry` rows, each with `.tl-time` (HH:MM), `.tl-dot`, and `.tl-body`. Log excerpts inside `.tl-body` go in a `.code-panel` using `.diff-line.add`/`.diff-line.del` for added/removed lines. Action items use an `.actions` grid of `.ai-row` blocks (`.ai-avatar` assignee + `.ai-desc` description + `.ai-due` date + `.ai-check` checkbox). Status pills (`.pill.mitigated`/`.pill.resolved`) plus a `.sev` severity tag sit in a `.meta-row` at the top. Sidebar's anchor list becomes "timeline at a glance" with timestamps.

- **Concept explainer** → centerpiece is an interactive `<svg>` demo, NOT a static diagram. Reference: <https://thariqs.github.io/html-effectiveness/15-research-concept-explainer.html>. Canon drops the sidebar entirely; layout is a single `.demo-grid` placing the SVG widget (`.ring`/`.node`/`.arc`/`.track`) next to `.controls` (sliders + buttons that mutate the SVG via inline JS). Often skips `.tldr` — a brief `.lead` paragraph carries the headline instead. Include a `<table>` for "X vs Y" comparison (use `.good`/`.bad` cells for visual contrast) and a glossary as `<dl>` with `.term` + `.lbl` entries for inline definitions. ~20 lines of vanilla JS to wire control → SVG updates is acceptable here; the interactivity IS the explainer.

> **Canon reference for this workflow:** <https://thariqs.github.io/html-effectiveness/14-research-feature-explainer.html> is the worked example. Note the canon uses `<div class="page">` for the two-column grid wrapper; this plan uses `<div class="report">` to keep that grid distinct from the wider 1360px `.page` used by the specs workflow. Both names work — pick whichever stays internally consistent.
```

- [ ] **Step 2: Verify the Research workflow section landed**

```bash
grep -A1 "## Workflow: Research" ~/.claude/skills/using-html/SKILL.md | head -3
grep -c "filled in by Task" ~/.claude/skills/using-html/SKILL.md
wc -l ~/.claude/skills/using-html/SKILL.md
```

Expected: section header followed by "Trigger this workflow when…"; `grep -c` returns 0; file is ~250-300 lines.

---

## Task 7: End-to-end verification — render kitchen-sink fixture, then run three eval prompts

**Files:**
- Create (temporary): `$CLAUDE_JOB_DIR/using-html-fixture.html`
- Create (temporary): `$CLAUDE_JOB_DIR/using-html-fixture.png`

This task verifies the skill works in two stages: (a) a static kitchen-sink fixture exercises every CSS rule and gets screenshotted for visual review, then (b) the user invokes the skill against the three eval prompts in a fresh session.

- [ ] **Step 1: Build the kitchen-sink fixture**

Write `$CLAUDE_JOB_DIR/using-html-fixture.html` exercising every component the skill produces — header band, prompt-box, 3-card approaches grid, code panel with all four span classes, tradeoffs grid, chips, reco aside, sidebar nav, tldr, details accordion, tabs, callout, FAQ. Inline the contents of `~/.claude/skills/using-html/assets/theme.css` into a `<style>` block.

A reasonable fixture is ~150-200 lines. Use the two worked examples from Task 5 and Task 6 as the seed content.

- [ ] **Step 2: Render the fixture and capture a screenshot**

```bash
playwright-cli screenshot \
  --url "file://$CLAUDE_JOB_DIR/using-html-fixture.html" \
  --output "$CLAUDE_JOB_DIR/using-html-fixture.png" \
  --width 1400 --height 2400 --full-page
```

Expected: PNG written. If playwright-cli's screenshot flags differ from the above, run `playwright-cli screenshot --help` and adapt.

- [ ] **Step 3: Read the screenshot back and visually verify**

Use the Read tool on `$CLAUDE_JOB_DIR/using-html-fixture.png`. Check the rendering for:
- Cream paper background, not pure white.
- Serif headings (Iowan Old Style on macOS) — visibly different from the sans body.
- Marine teal accent on `.eyebrow` underline, `.tldr` left-border, `.reco` left-border, `.kw` keywords.
- Moss-green pro dots vs. rust con dots in the tradeoffs grid.
- Sticky nav visible at the top of the report layout (the screenshot won't show stickiness, but the nav should be present in the 200px sidebar column).
- Code panel has slate background and the syntax-highlight spans show distinct colors.

If anything looks wrong, debug by editing `~/.claude/skills/using-html/assets/theme.css` and re-running steps 1-3.

- [ ] **Step 4: Reload plugins so the new skill is discoverable**

```bash
# In Claude Code, run the slash command:
#   /reload-plugins
# Or restart the session.
```

After reload, verify the skill is registered:

```
Available skills should list `using-html` with the description from SKILL.md frontmatter.
```

- [ ] **Step 5: Run eval prompt #1 — specs/code**

Invoke a fresh sub-agent (or new top-level turn) with the prompt:

> "Show me three ways to implement debounced search in a React component — with tradeoffs for each."

Expected: the agent invokes `using-html`, writes an HTML file to `<repo>/thoughts/shared/html-out/<date>-debounced-search.html` (or `~/claude-html-out/` if outside a repo), opens it, and restates the path. Open the file and check:
- 3-column `.approaches` grid (collapses to 1-column under 1100px).
- Each card has code panel + tradeoffs + chips.
- `.reco` aside at the bottom names one approach explicitly.

- [ ] **Step 6: Run eval prompt #2 — research/codebase**

Invoke with:

> "Investigate how the ralph-hero MCP server handles GitHub rate limits and write it up."

Expected: an HTML file using the `<div class="report">` layout. Open it and check:
- Sticky nav sidebar with anchor links and "Files read" footer naming the actual rate-limiter files (e.g. `plugin/ralph-hero/mcp-server/src/lib/rate-limiter.ts`).
- TL;DR callout near the top.
- At least one `<details>` accordion or tabs block.
- No "Recommendation" aside (this is the research shape, not specs).

- [ ] **Step 7: Run eval prompt #3 — specs/non-code**

Invoke with:

> "Compare Postgres vs DynamoDB for our event-log store and recommend one."

Expected: a 2-column `.approaches` grid (`data-n="2"`) with NO code panel (each card is just head + tradeoffs + chips), and a `.reco` aside picking one.

- [ ] **Step 8: Capture eval observations**

Write findings (passes, fails, surprises) into a follow-on research note at `thoughts/shared/research/2026-05-23-using-html-skill-eval.md` so we have a record of v1 behavior. Commit that note in this worktree (NOT the skill itself — that lives in `~/.claude/skills/`).

```bash
git add thoughts/shared/research/2026-05-23-using-html-skill-eval.md
git commit -m "docs(thoughts): using-html skill v1 eval results"
```

---

## Self-Review

**Spec coverage** (checking against `thoughts/shared/research/2026-05-23-using-html-skill-design.md`):

| Spec requirement | Plan task |
|---|---|
| Skill at `~/.claude/skills/using-html/SKILL.md` with `name`+`description` frontmatter | Task 1 |
| `assets/theme.css` bundling palette + components | Task 2 |
| `assets/skeleton.html` doctype shell | Task 3 |
| Imperative second-person voice in SKILL.md body | Tasks 4-6 instructions emphasize this |
| Core principles (one file, JS posture, syntax highlighting) | Task 4 step 2 |
| File location bash (project `thoughts/` → fallback `~/claude-html-out/`) | Task 4 step 3 |
| Finisher (write → open → restate path) | Task 4 step 3 |
| Workflow: Specs — anatomy, anti-patterns w/ why, worked example, variants | Task 5 |
| Workflow: Research — anatomy, anti-patterns w/ why, worked example, variants | Task 6 |
| Light mode only, marine-ink-on-cream palette | Task 2 step 1 |
| Component vocabulary (eyebrow, tldr, callout, details, tabs, sticky nav, card, syntax spans, H2 scroll-margin) | Tasks 2 steps 2-4 |
| Three eval prompts as acceptance criteria | Task 7 steps 5-7 |

No gaps identified.

**Placeholder scan**: Searched the plan for "TBD", "TODO", "implement later", "fill in details", "Add appropriate", "Similar to Task N" — none present. The `{{TITLE}}` and `{{THEME_CSS}}` strings in skeleton.html are intentional runtime placeholders, not authoring placeholders. The `(filled in by Task N)` stubs in Task 1's SKILL.md scaffold are filled by Tasks 4-6 and explicitly verified by greps.

**Type/name consistency**: Class names used consistently across tasks — `.eyebrow`, `.tldr`, `.callout`, `.card`, `.approaches`, `.approach`, `.approach-head`, `.code`, `.tradeoffs`, `.chips`, `.chip`, `.reco`, `.prompt-box`, `.report`, `.files`, `.where`, `.tabs`, `.tabbar`, `.faq`, `.kw`, `.str`, `.cm`, `.fn`, `.pro`, `.con`, `.head`, `.l2`, `.label`, `.num`, `.ico`. Custom property names consistent — `--paper`, `--ink`, `--accent`, `--rust`, `--moss`, `--sand`, `--slate`, `--gray-150/300/500/700`, `--white`, `--serif`, `--sans`, `--mono`. The `--slate` token is introduced in Task 2 step 1 specifically for the code panel background introduced in Task 2 step 3.

**Scope check**: One subsystem (one personal skill), three files, seven tasks. Single plan is appropriate.

---

## Execution Handoff

Plan complete and saved to `thoughts/shared/plans/2026-05-23-using-html-skill.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
