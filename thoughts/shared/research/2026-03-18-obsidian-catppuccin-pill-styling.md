---
date: 2026-03-18
topic: "How to restore Obsidian default pill styling for tags in Catppuccin Mocha"
tags: [research, obsidian, catppuccin, css, tags, typography]
status: complete
type: research
git_commit: 92b4a482b0950876bfb0155bdd6bce3e779af43c
---

# Research: Restoring Pill Tag Styling in Catppuccin Mocha

## Prior Work

- builds_on:: [[2026-03-18-catppuccin-mocha-obsidian-theme]]

## Research Question

The default Obsidian theme has pill-shaped tag badges. Catppuccin Mocha removes them. How do we restore just the pill styling without changing anything else?

## Summary

Catppuccin intentionally flattens tag styling by zeroing out padding and making the background transparent. The fix is a 5-line CSS snippet overriding four `--tag-*` CSS variables — the exact same values Catppuccin ships as its opt-in `.ctp-tag-pill` class. No selector hacks, no `!important`, no plugin required.

## Detailed Findings

### What Obsidian Default Pill Tags Look Like

The default Obsidian theme styles `a.tag` and `.cm-hashtag-*` spans via CSS variables:

```css
--tag-background:   hsla(var(--interactive-accent-hsl), 0.1);
--tag-padding-x:    0.65em;
--tag-padding-y:    0.25em;
--tag-radius:       2em;       /* 2em on a small element = full capsule/pill */
--tag-border-width: 0px;
```

The `2em` radius on an element with `0.25em` vertical padding produces the characteristic capsule shape.

### What Catppuccin Does to Tags

Catppuccin's base `:root` block (theme.css lines 488–505) overrides all four properties:

| Variable | Obsidian default | Catppuccin override |
|----------|-----------------|---------------------|
| `--tag-background` | `hsla(accent, 0.1)` | `transparent` |
| `--tag-background-hover` | `hsla(accent, 0.2)` | `0` |
| `--tag-padding-x` | `0.65em` | `0` |
| `--tag-padding-y` | `0.25em` | `0` |
| `--tag-radius` | `2em` | `0.8em` |

The result: no background, no padding — tags look like accented underlined text. The `0.8em` radius has no visible effect because there's nothing to round without padding + background.

### Catppuccin's Own Pill Toggle

Catppuccin actually ships this restoration as an opt-in toggle via the Style Settings plugin. The `.ctp-tag-pill` body class (theme.css lines 2377–2390) restores exactly Obsidian's defaults:

```css
.ctp-tag-pill {
  --tag-size:             var(--font-smaller);
  --tag-background:       hsla(var(--interactive-accent-hsl), 0.1);
  --tag-background-hover: hsla(var(--interactive-accent-hsl), 0.2);
  --tag-border-color:     hsla(var(--interactive-accent-hsl), 0.15);
  --tag-border-color-hover: hsla(var(--interactive-accent-hsl), 0.15);
  --tag-border-width:     0px;
  --tag-padding-x:        0.65em;
  --tag-padding-y:        0.25em;
  --tag-radius:           2em;
  --tag-weight:           inherit;
}
```

This is confirmed working because Catppuccin ships and tests it themselves.

### Fix: CSS Snippet (No Plugin Needed)

Rather than installing Style Settings, simply adding a CSS snippet with the same variable overrides on `body` achieves identical results:

```css
/* Restore Obsidian default pill styling for tags */
body {
  --tag-background:       hsla(var(--interactive-accent-hsl), 0.1);
  --tag-background-hover: hsla(var(--interactive-accent-hsl), 0.2);
  --tag-border-width:     0px;
  --tag-padding-x:        0.65em;
  --tag-padding-y:        0.25em;
  --tag-radius:           2em;
}
```

This overrides Catppuccin's `:root` defaults. No `!important` needed — `body` specificity beats `:root`.

## Code References

- `thoughts/.obsidian/themes/Catppuccin/theme.css:488–505` — Catppuccin's `:root` tag variable overrides
- `thoughts/.obsidian/themes/Catppuccin/theme.css:2377–2390` — Catppuccin's `.ctp-tag-pill` opt-in class
- `thoughts/.obsidian/snippets/typography.css` — existing snippet to extend with pill rules

## Implementation Options

1. **Add to existing `typography.css` snippet** — keeps all appearance tweaks in one file
2. **New `tag-pills.css` snippet** — more surgical, easier to toggle on/off independently

## Open Questions

- None — the fix is fully known and confirmed by Catppuccin's own source.
