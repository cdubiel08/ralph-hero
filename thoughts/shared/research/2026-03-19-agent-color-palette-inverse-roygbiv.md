---
date: 2026-03-19
topic: "Claude Code agent colors: available palette and inverse ROY G BIV assignment plan"
tags: [research, agents, colors, claude-code, plugin-configuration]
status: complete
type: research
git_commit: 81baef11ccfeebb9391f23197c61b1eafd8b31dc
---

# Research: Claude Code Agent Colors & Inverse ROY G BIV Spectrum

## Prior Work

None found — first research on agent color theming.

## Research Question

What colors are available in Claude Code agent definitions, and how can they be assigned to all ralph-hero marketplace plugin subagents using an inverse ROY G BIV spectrum?

## Summary

Claude Code supports exactly **8 hardcoded colors** in agent frontmatter: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. There are **13 agents** across 2 plugins (ralph-hero: 11, ralph-playwright: 2). Currently only 5 of 13 have colors assigned. The inverse ROY G BIV spectrum maps naturally to the available palette as: `purple → blue → cyan → green → yellow → orange → pink → red`.

## Detailed Findings

### Available Colors

The `color` field in agent `.md` frontmatter accepts exactly these 8 values:

| Color | ANSI mapping |
|-------|-------------|
| `purple` | Violet/magenta |
| `blue` | Full-brightness blue |
| `cyan` | Full-brightness cyan |
| `green` | Full-brightness green |
| `yellow` | Full-brightness yellow |
| `orange` | Full-brightness orange |
| `pink` | Full-brightness pink |
| `red` | Full-brightness red |

Custom values (hex codes, tmux 256-color numbers, CSS colors) are **silently ignored** with no warning. Sources: [Claude Code docs](https://code.claude.com/docs/en/sub-agents), [anthropics/claude-code#23691](https://github.com/anthropics/claude-code/issues/23691), [cclint linter](https://github.com/carlrannaberg/cclint).

### Inverse ROY G BIV → Available Palette Mapping

Standard ROY G BIV: Red → Orange → Yellow → Green → Blue → Indigo → Violet

**Inverse** (walking from violet to red): Violet → Indigo → Blue → Green → Yellow → Orange → [Rose] → Red

Mapped to available Claude Code colors:

```
purple → blue → cyan → green → yellow → orange → pink → red
  (V)     (I)    (B)    (G)     (Y)      (O)    (rose)  (R)
```

### Current Agent Inventory (13 agents, 2 plugins)

#### ralph-hero plugin — 11 agents

| Agent | Model | Current color | Has hooks |
|-------|-------|--------------|-----------|
| `ralph-analyst` | sonnet | `green` | yes |
| `ralph-builder` | sonnet | `cyan` | yes |
| `ralph-integrator` | haiku | `orange` | yes |
| `github-analyzer` | sonnet | `orange` | no |
| `github-lister` | sonnet | `cyan` | no |
| `codebase-analyzer` | sonnet | — | no |
| `codebase-locator` | haiku | — | no |
| `codebase-pattern-finder` | haiku | — | no |
| `thoughts-analyzer` | sonnet | — | no |
| `thoughts-locator` | haiku | — | no |
| `web-search-researcher` | sonnet | — | no |

#### ralph-playwright plugin — 2 agents

| Agent | Model | Current color |
|-------|-------|--------------|
| `explorer-agent` | sonnet | — |
| `story-runner-agent` | sonnet | — |

### Proposed Color Assignments — Inverse Spectrum Walk

Walking the inverse spectrum across functional groups, cool-to-warm:

| Spectrum position | Color | Agent | Rationale |
|------------------|-------|-------|-----------|
| Violet (coolest) | `purple` | `ralph-analyst` | Strategic analysis — deep thought at the violet end |
| Indigo | `blue` | `ralph-builder` | Construction — building in the deep blue |
| Blue | `cyan` | `ralph-integrator` | Integration — bridge between cool analysis and warm execution |
| Green | `green` | `codebase-locator` | Finding paths through the code forest |
| Green | `green` | `codebase-pattern-finder` | Spotting patterns in the canopy |
| Yellow | `yellow` | `codebase-analyzer` | Illuminating code — casting light on implementation |
| Yellow | `yellow` | `thoughts-locator` | Discovering knowledge — lantern in the archive |
| Orange | `orange` | `thoughts-analyzer` | Warm synthesis of found knowledge |
| Orange | `orange` | `web-search-researcher` | Warm outward reach into the web |
| Pink (rose) | `pink` | `github-lister` | Scanning the horizon — dawn-colored discovery |
| Pink (rose) | `pink` | `explorer-agent` | UI exploration — roaming the pink edge |
| Red (warmest) | `red` | `github-analyzer` | Hot distillation of findings |
| Red (warmest) | `red` | `story-runner-agent` | Test execution fire — pass/fail at the red end |

**Design principles:**
- Related agents share colors (pairs within functional groups)
- The 3 Ralph Team workers each get unique colors (purple/blue/cyan) for instant identification
- The spectrum walks cool→warm from strategic→tactical→execution
- 8 colors across 13 agents = max 2 agents per color, grouped by function

## Code References

- `plugin/ralph-hero/agents/ralph-analyst.md:6` — current `color: green`
- `plugin/ralph-hero/agents/ralph-builder.md:6` — current `color: cyan`
- `plugin/ralph-hero/agents/ralph-integrator.md:6` — current `color: orange`
- `plugin/ralph-hero/agents/github-analyzer.md:6` — current `color: orange`
- `plugin/ralph-hero/agents/github-lister.md:6` — current `color: cyan`
- `plugin/ralph-hero/agents/codebase-analyzer.md` — no color field
- `plugin/ralph-hero/agents/codebase-locator.md` — no color field
- `plugin/ralph-hero/agents/codebase-pattern-finder.md` — no color field
- `plugin/ralph-hero/agents/thoughts-analyzer.md` — no color field
- `plugin/ralph-hero/agents/thoughts-locator.md` — no color field
- `plugin/ralph-hero/agents/web-search-researcher.md` — no color field
- `plugin/ralph-playwright/agents/explorer-agent.md` — no color field
- `plugin/ralph-playwright/agents/story-runner-agent.md` — no color field

## Open Questions

- Should the 3 Ralph Team workers maintain unique colors as proposed, or share a single team color?
- Future agents: where on the spectrum should new agents land?
