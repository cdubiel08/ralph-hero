---
name: using-html
description: Use when producing multi-option design comparisons, research synthesis docs, status/incident reports, implementation plans, PR reviews & writeups, module maps, design-system references, component-variant sheets, SVG figures & flowcharts, interaction/animation prototypes, or slide decks — anything that would otherwise be a long Markdown document. Reach for this skill whenever the user asks to "compare", "explore options", "research", "summarize findings", "write up", "synthesize", "explain how X works", "plan", "review this PR", "map this package", "show our design tokens", "draw/diagram", "flowchart", "prototype", "tune the easing", or "make a deck/slides" — and especially when the output will exceed ~100 lines, contain side-by-side options, be visual or interactive, or be shared with another person. HTML beats Markdown for these by a wide margin (visual hierarchy, tables, SVG diagrams, navigability, live interaction); default to invoking this skill even if the user doesn't explicitly ask for HTML.
---

# using-html

You produce self-contained HTML artifacts in place of long Markdown when the output benefits from visual structure — side-by-side comparisons, sticky-nav navigability, callouts, diagrams, live interaction, or anything a reader will share with someone else.

This SKILL.md is the **router**: it carries the rules that apply to *every* artifact (core principles, the JS budget, the file finisher). The per-workflow anatomy — page structure, worked-example fragments, anti-patterns — lives in `references/`. **Pick the workflow from the index below, then read that one reference file before writing.**

Every artifact is one HTML file — no CDNs, no external assets, no `<script src>`. It must work offline, as an email attachment, and after being uploaded to a wiki.

## Core principles

- **One file, fully self-contained.** Inline CSS, inline SVG, inline vanilla JS. Zero CDNs, zero external assets, zero `fetch()`, zero `import` from a URL. If you find yourself reaching for a `<link rel>` or `<script src>`, stop — the artifact must keep working when uploaded or emailed. This is absolute and does not flex.
- **Read the bundled assets every time.** Use the Read tool on `assets/skeleton.html` and `assets/theme.css` before writing. Inline `theme.css` into the skeleton's `<style>` block (replacing `{{THEME_CSS}}`) and fill `{{TITLE}}`. For an **Interactive-tier** workflow (see budget below), also Read `assets/interactive.css` and append it inside the same `<style>` block. Don't reconstruct the palette from memory — that's where visual drift comes from.
- **Vanilla JS only, budgeted by workflow.** No frameworks, no build step, no `<script src>`. How much JS is allowed depends on the workflow:

  | Budget class | Ceiling | Workflows | What the JS does |
  |---|---|---|---|
  | **None** | 0 lines | Planning, PR writeup, Design system | Pure layout. No JS. |
  | **Micro** | ≤ ~15 lines | Specs, Research, Code review, SVG figures | Tab switch, collapse-toggle, copy-to-clipboard. |
  | **Interactive** | ≤ ~60 lines | Decks, Component variants, Prototyping, Flowchart | Arrow-key nav, control→SVG/CSS mutation, drag-reorder, step-detail panels. Author as *data + a small render loop*, not a wall of imperative DOM building. |

  If an interactive workflow's JS would blow past ~60 lines, that's the signal it belongs in a future "editor"-tier skill — not that the budget should stretch.
- **Syntax highlighting.** Hand-code `<span class="kw|str|cm|fn">` inside `<pre>` blocks. The theme defines those four classes against the slate code-panel background. Don't invoke Prism, highlight.js, or any other library — they break self-containment and produce colors that fight the palette.
- **Imperative voice in any prose.** This is an artifact, not a tutorial. Lead with what IS, not what the reader should do.

## File location & finisher

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

## Workflow index

Match the request to one row, then **Read that reference file** before writing. Each reference carries the page anatomy, a worked-example fragment, and anti-patterns.

| If the user wants… | Trigger phrases | Read | Tier |
|---|---|---|---|
| To compare ≥2 candidate solutions to one decision | "compare", "tradeoffs", "N ways to…", "options for…", "side-by-side", "explore designs" | `references/specs.md` | Micro |
| A synthesis of findings / how something works / a status or incident report | "research", "summarize findings", "explain how X works", "feature explainer", "status report", "postmortem" | `references/research.md` | Micro / Interactive |
| A build plan handed to an implementer | "implementation plan", "milestones for…", "how would you build X", "hand-off doc" | `references/planning.md` | None |
| To review a diff, write a PR description, or map an unfamiliar package | "review this PR/diff", "what's risky here", "write the PR description", "explain how X works in this repo", "map this package" | `references/code-review.md` | None / Micro |
| To document design tokens or lay out every variant of a component | "design system", "show our tokens", "every variant of X", "all states of this component" | `references/design.md` | None / Interactive |
| Vector figures for a doc, or a process drawn as a flowchart | "draw the figures", "illustrate X", "flowchart this", "show the failure paths" | `references/diagrams.md` | Micro / Interactive |
| To feel a transition or click through an interaction | "prototype this", "tune the easing", "let me feel the reorder", "mock the click-through" | `references/prototyping.md` | Interactive |
| A presentation to arrow-key through in a meeting | "make a deck", "slides for this", "present this", "turn this thread into a deck" | `references/decks.md` | Interactive |

When two rows could fit, prefer the more specific one (e.g. "explain how auth works *in this repo*" → code-review module map, not a generic research report). If none fit cleanly but the output is still a long shareable document, default to `references/research.md`.

> **Not yet covered:** drag-and-drop editors with export-back-to-agent (triage boards, feature-flag editors, prompt tuners). Those need 250–400 lines of stateful JS plus a serialize-to-clipboard contract and are deferred to a future editor-tier skill. If asked for one, build the closest covered shape (e.g. a prototype or a comparison) and say so.
