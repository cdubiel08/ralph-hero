---
date: 2026-03-18
topic: "Can we add Catppuccin Mocha theme to the Obsidian vault?"
tags: [research, obsidian, catppuccin, theme, appearance]
status: complete
type: research
git_commit: f627eb067498a5316d8422f2bb98fda467d1af13
---

# Research: Adding Catppuccin Mocha Theme to Obsidian

## Prior Work

- builds_on:: [[2026-03-17-GH-0582-obsidian-integration]] (setup-obsidian skill)

## Research Question

Notes and markdown in Obsidian are a wall of text and hard to read. Can we add the Catppuccin Mocha color theme to improve readability?

## Summary

Yes — Catppuccin Mocha can be installed programmatically with three file operations and zero GUI interaction. Mocha is the **default dark flavor** of the Catppuccin theme, so no additional plugins (like Style Settings) are needed. The entire `thoughts/.obsidian/` directory is already gitignored, so this is a local-only change that won't affect the repository.

## Detailed Findings

### Current Obsidian Appearance State

The vault at `thoughts/.obsidian/` has an empty `appearance.json` (`{}`), meaning Obsidian uses its default theme. No custom theme is installed. The `setup-obsidian` skill (`plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md`) provisions `app.json` and `graph.json` but has no theme-related logic.

### Catppuccin Obsidian Theme

- **Official repo**: [catppuccin/obsidian](https://github.com/catppuccin/obsidian)
- **Theme type**: Single theme with four flavor variants (Latte, Frappe, Macchiato, Mocha)
- **Mocha is the default** when dark mode is active — no Style Settings plugin required

The theme uses Obsidian 1.0+ format requiring two files in a named subdirectory:

```
thoughts/.obsidian/themes/Catppuccin/
├── manifest.json    # Theme metadata (name, version, author)
└── theme.css        # All four flavors' CSS variables + styles
```

### Installation Requirements

Three file operations total:

1. **Download `theme.css`** from `https://raw.githubusercontent.com/catppuccin/obsidian/main/theme.css`
2. **Download `manifest.json`** from `https://raw.githubusercontent.com/catppuccin/obsidian/main/manifest.json`
3. **Update `appearance.json`** to activate the theme:

```json
{
  "cssTheme": "Catppuccin",
  "theme": "obsidian"
}
```

- `cssTheme` must exactly match the `name` field in the theme's `manifest.json` (i.e., `"Catppuccin"`)
- `theme: "obsidian"` forces dark mode (which defaults to Mocha)
- `theme: "moonstone"` would force light mode (defaults to Latte)

### Flavor Selection Without Style Settings

| Flavor | Mode | Default? |
|--------|------|----------|
| Latte | Light | Yes (when `theme: "moonstone"`) |
| Frappe | Dark | No |
| Macchiato | Dark | No |
| Mocha | Dark | **Yes** (when `theme: "obsidian"`) |

To switch to Frappe or Macchiato, the [obsidian-style-settings](https://github.com/obsidian-community/obsidian-style-settings) community plugin is needed. For Mocha, no extra plugin is necessary.

### Git Impact

`thoughts/.gitignore` contains `.obsidian/`, so the theme files and appearance changes are purely local. No repository changes needed.

### Setup Skill Compatibility

The `setup-obsidian` skill uses additive merging for `app.json` — it only writes keys that don't already exist. It does not touch `appearance.json` at all. Adding the theme will not conflict with re-running the setup skill.

## Code References

- `thoughts/.obsidian/appearance.json` — currently `{}`, needs `cssTheme` and `theme` keys
- `thoughts/.obsidian/app.json` — unaffected (wikilinks + frontmatter config)
- `thoughts/.gitignore:3` — `.obsidian/` is gitignored
- `plugin/ralph-knowledge/skills/setup-obsidian/SKILL.md` — no theme logic, no conflict

## Installation Script

```bash
mkdir -p thoughts/.obsidian/themes/Catppuccin
curl -sL "https://raw.githubusercontent.com/catppuccin/obsidian/main/theme.css" \
  -o thoughts/.obsidian/themes/Catppuccin/theme.css
curl -sL "https://raw.githubusercontent.com/catppuccin/obsidian/main/manifest.json" \
  -o thoughts/.obsidian/themes/Catppuccin/manifest.json
```

Then update `thoughts/.obsidian/appearance.json`:
```json
{
  "cssTheme": "Catppuccin",
  "theme": "obsidian"
}
```

## Open Questions

- Should the setup-obsidian skill be updated to provision Catppuccin Mocha as a default theme during setup?
- Would accent color customization be useful? (Catppuccin supports custom accent colors via Style Settings)
