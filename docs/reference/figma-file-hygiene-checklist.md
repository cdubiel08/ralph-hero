---
date: 2026-03-10
status: draft
type: checklist
tags: [figma, design-system, ai-automation, design-team]
---

# Figma File Hygiene Checklist

> **Audience**: Designers and design leads
> **Purpose**: Ensure Figma files produce high-quality output when consumed by AI tools (Claude Code + Figma MCP). File quality directly determines code generation accuracy.
>
> **The rule**: Well-structured Figma files → ~90% code accuracy on first pass. Poorly structured files → ~50% accuracy with heavy manual cleanup. The 30 minutes you spend organizing a frame saves 3+ hours of developer cleanup.

## Before Every Handoff

Run through this checklist before marking any frame as dev-ready.

### Layout

- [ ] **Every container uses Auto Layout** — No absolute positioning except for overlays/modals. Auto Layout maps directly to CSS Flexbox, making it the most reliable part of AI translation.
- [ ] **Spacing uses Figma spacing tokens** — Not hardcoded pixel values. Use the spacing variable collection.
- [ ] **Padding is set on frames, not via spacer rectangles** — Auto Layout padding, not invisible spacer boxes.
- [ ] **Responsive constraints are defined** — Fill container vs. fixed width is explicitly set on every child.
- [ ] **No overlapping frames** — If elements overlap intentionally (badges, tooltips), use z-order within Auto Layout, not stacked absolute frames.

### Naming

- [ ] **Every layer has a semantic name** — `CardContainer`, `HeaderText`, `PrimaryButton` — not `Group 47`, `Frame 12`, `Rectangle 3`.
- [ ] **Names match code component names** — If the code component is `<app-project-card>`, the Figma component should be named `ProjectCard`, not `Card Variant 2`.
- [ ] **Boolean layers use descriptive names** — `HasIcon`, `ShowBadge`, `IsDisabled` — not `toggle1`, `layer_visible`.
- [ ] **No nested "Group" or "Frame" defaults** — Every level of nesting has a purpose and a name.

### Components

- [ ] **Reusable elements are Figma Components** — Not just grouped frames. Components enable Code Connect mapping.
- [ ] **All interactive states are represented as variants** — Default, Hover, Active, Focused, Disabled, Error, Loading. Don't just show the happy path.
- [ ] **Variant properties use meaningful names** — `State=Hover`, `Size=Large`, `Type=Primary` — not `Property 1=Variant 2`.
- [ ] **Variant property names match code prop names** — If the code prop is `variant`, the Figma property should be `Variant` (not `Style` or `Type`). This enables automatic Code Connect mapping.
- [ ] **Nested components are properly instantiated** — Use component instances, not detached copies. This lets Code Connect resolve the full component tree.

### Variables (Design Tokens)

- [ ] **All colors use Figma Variables** — No hardcoded hex values. Every color should reference a variable from the color collection.
- [ ] **All spacing uses Figma Variables** — Padding, gaps, and margins reference spacing variables, not raw pixel values.
- [ ] **Typography uses Figma Variables or Text Styles** — Font size, weight, and line height come from the type system, not ad hoc values.
- [ ] **Border radius uses variables** — Not hardcoded corner radius values.
- [ ] **Variables are organized in collections** — Color, Spacing, Typography, Radius at minimum. With modes for light/dark if applicable.
- [ ] **Variable names follow semantic conventions** — `color/action/primary`, `spacing/md`, `radius/lg` — not `blue-500` or `8px`.

### Annotations & Interactive Behavior

- [ ] **Hover states are documented** — AI cannot see Figma prototype interactions. Add a text annotation: "On hover: scale 1.02, shadow-lg, 200ms ease-out".
- [ ] **Transitions are annotated** — "Slide in from right, 300ms ease-out-expo" on panels, modals, drawers.
- [ ] **Conditional visibility is documented** — "Show badge when `count > 0`", "Hide section when `items.length === 0`".
- [ ] **Click actions are annotated** — "Opens modal", "Navigates to /settings", "Toggles dropdown".
- [ ] **Loading behavior is annotated** — "Shows skeleton while data loads", "Spinner replaces button text".
- [ ] **Form validation rules are annotated** — "Required, min 3 characters", "Must be valid email".
- [ ] **Keyboard shortcuts are documented** — "Escape closes modal", "Tab moves to next field".

### Accessibility

- [ ] **Color contrast passes WCAG AA** — Use Figma's built-in contrast checker or the Stark plugin. 4.5:1 for text, 3:1 for large text.
- [ ] **Touch targets are at least 44x44px** — Buttons and interactive elements meet minimum tap target size.
- [ ] **Focus order is logical** — If the design has a specific tab order, annotate it.
- [ ] **Icon-only buttons have labels annotated** — "aria-label: Close dialog", "aria-label: Open menu".
- [ ] **Decorative vs. meaningful images are marked** — "Decorative: aria-hidden=true", "Alt: Map showing well locations in Permian Basin".

### Organization

- [ ] **One component per frame for handoff** — Don't pack 15 variations into one massive frame. Separate concerns.
- [ ] **Frames are named with clear page/section context** — "Dashboard / Metric Card", "Settings / Profile Form" — not "Untitled".
- [ ] **Design specs page exists** — A dedicated page showing the token system, color palette, typography scale, spacing, and component inventory.
- [ ] **Version/date noted on major frames** — So developers know which version they're building against.

---

## File Structure Template

Organize your Figma file with these pages:

```
📄 Cover                    — Project name, version, status, links
📄 Tokens                   — Color palette, typography scale, spacing, radii, shadows
📄 Components               — All shared components with all variants
📄 Patterns                 — Common compositions (form layouts, card grids, navigation)
📄 [Feature] - Specs        — Per-feature design specs (one page per feature)
📄 [Feature] - Prototypes   — Interactive prototypes (if applicable)
📄 Archive                  — Old versions, explorations (keep out of active pages)
```

---

## Common Anti-Patterns

| Anti-Pattern | Why It's Bad | Fix |
|---|---|---|
| "Group 47" layer names | AI has zero context about what the element is | Name it `CardHeader`, `ActionButton`, etc. |
| Hardcoded hex colors | AI can't map to your token system | Use Figma Variables |
| Absolute positioning for layout | Generates `position: absolute` instead of flexbox | Use Auto Layout |
| Detached component instances | Code Connect can't resolve the component tree | Re-attach to source component |
| Missing hover/disabled states | AI generates only the default state | Add all variants |
| Giant frames with everything | AI gets confused by context bleed | One component/section per frame |
| Spacer rectangles for spacing | Generates empty `<div>` elements | Use Auto Layout gap and padding |
| "Final Final v3" page names | Nobody knows which is current | Use clear versioning or archive old work |
| No annotations for interactions | AI can't see prototype connections | Add text annotations |

---

## Quick Reference: Figma MCP Tools

When your files are clean, developers can use these Figma MCP tools effectively:

| Tool | What It Reads | Why File Hygiene Matters |
|---|---|---|
| `get_design_context` | Layout, styles, structure → generates code | Clean Auto Layout = clean flexbox. Semantic names = semantic HTML. |
| `get_variable_defs` | Color, spacing, typography tokens | Variables must be defined and applied — hardcoded values are invisible to this tool. |
| `get_screenshot` | Visual reference for layout fidelity | Clean frames with clear boundaries produce usable reference images. |
| `get_metadata` | Layer IDs, names, types, dimensions | Semantic layer names become meaningful metadata. "Group 47" is useless metadata. |
| `get_code_connect_map` | Component → code mappings | Only works when elements are proper component instances (not detached copies). |
| `create_design_system_rules` | Your conventions → persistent AI rules | Reads your actual variable names and structure — clean input = useful rules. |
