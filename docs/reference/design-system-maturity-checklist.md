---
date: 2026-03-10
status: draft
type: plan
tags: [design-system, ai-automation, figma, maturity-checklist, portability]
---

# Design System Maturity Checklist — AI-Ready Edition

> **Author**: Chad Dubiel
> **Purpose**: A portable, framework-agnostic maturity checklist for evaluating and building AI-ready design systems. Grounded in lessons from the LandCrawler design system, industry research (Brad Frost, Atlassian, Shopify, GitHub), and the current Claude Code + Figma integration landscape as of March 2026.
>
> **Target use case**: Export this playbook to accelerate frontend development at an Angular-based company with a partial design system, using Claude Code as the primary AI development tool.

## The Problem This Solves

There is a massive gap between **planned webapp functionality** and **frontend execution** when developers manually create every component. The root cause isn't developer speed — it's the absence of a machine-readable, token-driven design system that AI tools can consume. Without it, every component is a bespoke creation. With it, component creation becomes assembly from verified parts.

## Architecture: Five Concentric Rings

```
                    ┌─────────────────────────────────┐
                    │     5. PORTABILITY & EXPORT      │
                    │  ┌───────────────────────────┐   │
                    │  │   4. QUALITY & GOVERNANCE  │   │
                    │  │  ┌─────────────────────┐   │  │
                    │  │  │  3. AI AUTOMATION    │   │  │
                    │  │  │  ┌───────────────┐   │  │  │
                    │  │  │  │ 2. DESIGN-CODE│   │  │  │
                    │  │  │  │    BRIDGE     │   │  │  │
                    │  │  │  │ ┌───────────┐ │   │  │  │
                    │  │  │  │ │1. FOUNDA- │ │   │  │  │
                    │  │  │  │ │   TION    │ │   │  │  │
                    │  │  │  │ └───────────┘ │   │  │  │
                    │  │  │  └───────────────┘   │  │  │
                    │  │  └─────────────────────┘   │  │
                    │  └───────────────────────────┘   │
                    └─────────────────────────────────┘
```

Each ring has **6 maturity tiers**:

| Tier | Label | Description |
|------|-------|-------------|
| 0 | **Not Started** | Capability doesn't exist |
| 1 | **Ad Hoc** | Exists informally, inconsistently applied |
| 2 | **Defined** | Documented, standardized, but manual |
| 3 | **Systematic** | Automated pipelines, CI/CD integrated |
| 4 | **AI-Ready** | Machine-readable, MCP-exposed, AI can consume |
| 5 | **Autonomous** | AI generates, validates, and proposes improvements within system constraints |

---

## Ring 1: Foundation

The structural core. Tokens, components, variants, and composition rules.

### 1.1 Design Tokens

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 1.1.1 | **Color palette** | Hardcoded hex values in components | CSS variables exist but inconsistent | Full semantic palette (primitive → semantic → component layers) | Palette generated from DTCG source, CI validates no hardcoded values | Palette queryable via MCP; AI can resolve token names | AI proposes new semantic tokens when usage patterns emerge |
| 1.1.2 | **Typography scale** | Ad hoc font sizes | CSS variables for sizes | Fluid scale with `clamp()`, weight/height/spacing tokens | Generated from token source, responsive breakpoints automated | AI reads type tokens to generate correctly-sized text | AI flags type scale violations in PRs |
| 1.1.3 | **Spacing system** | Random padding/margin values | Consistent base unit (4px/8px) | Full spacing scale as tokens (0–96+) | Spacing tokens enforced via linting (Stylelint/ESLint) | AI uses spacing tokens for layout generation | AI detects spacing inconsistencies in screenshots |
| 1.1.4 | **Shadow system** | Box-shadow strings duplicated | CSS variables for shadows | Semantic shadow tokens (sm/md/lg/xl) with elevation meaning | Shadow tokens in DTCG format | AI selects appropriate elevation contextually | AI proposes shadow adjustments based on depth hierarchy |
| 1.1.5 | **Motion/easing tokens** | Inline transition values | Shared easing curves | Named duration + easing tokens (fast/base/slow + ease curves) | Motion tokens respect `prefers-reduced-motion` | AI generates animations using motion tokens | AI generates accessible motion with reduced-motion fallbacks |
| 1.1.6 | **Border radius tokens** | Hardcoded values | Shared radius variables | Semantic radius tokens (none/sm/md/lg/full) | Radius tokens in DTCG | AI uses radius tokens correctly | AI maintains radius consistency across new components |
| 1.1.7 | **Z-index scale** | Magic numbers | Documented z-index values | Named z-index tokens (dropdown/modal/toast/tooltip) | Enforced via linting | AI uses z-index tokens for overlay creation | AI detects z-index stacking conflicts |
| 1.1.8 | **Token format** | No structured format | JS/TS object | JSON with semantic naming | W3C DTCG format (`.tokens.json`, `$type`/`$value`) | Tokens served via API/MCP | Tokens auto-sync between design tool and code |
| 1.1.9 | **Token layers** | Single layer | Two layers (primitive + semantic) | Three layers (primitive → semantic → component) | Layers auto-resolved, brand overrides via token resolvers | AI understands layer hierarchy, references correct layer | AI proposes layer promotions (component → semantic) when patterns repeat |
| 1.1.10 | **Dark mode / color schemes** | No dark mode | Manual dark mode CSS | Token-based scheme switching (light/dark as token sets) | Scheme tokens generated from single source, CI validates both | AI generates components that work in both schemes | AI tests both schemes automatically during generation |

### 1.2 Component Architecture

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 1.2.1 | **Component library exists** | No shared components | Scattered shared files | Dedicated package with barrel exports | Package published to registry with versioning | Components discoverable via MCP/registry API | Components self-document and auto-register |
| 1.2.2 | **Variant management** | Conditional classes | CSS modules / utility classes | CVA or equivalent (typed variants with defaults) | Variants exhaustively tested, storybook controls | AI reads variant schema, generates correct variant usage | AI proposes new variants when patterns emerge |
| 1.2.3 | **Prop typing** | No types | Partial TypeScript | Full TypeScript interfaces extending HTML attrs | Types exported, JSDoc descriptions on every prop | AI reads prop types + descriptions for accurate generation | AI generates new components with correct prop patterns |
| 1.2.4 | **Ref forwarding** | No ref support | Some components | All interactive components forward refs | Ref forwarding tested | AI generates ref-forwarded components by default | — |
| 1.2.5 | **Composition patterns** | Monolithic components | Slots via props | Compound components (Card + CardHeader + CardContent) | Composition rules documented, enforced | AI understands composition rules, assembles correctly | AI creates new compound components following patterns |
| 1.2.6 | **Icon system** | Inline SVGs | Icon component wrapping SVGs | Icon library (Lucide/Heroicons) with tree-shaking | Icons cataloged with semantic names | AI selects contextually appropriate icons | AI proposes icon alternatives based on usage context |
| 1.2.7 | **Form components** | Raw `<input>` elements | Styled input components | FormField composite (Label + Input + Helper + validation) | Form components integrate with form library (React Hook Form, Angular Reactive Forms) | AI generates complete forms with validation from schema | AI generates form + backend validation from API spec |
| 1.2.8 | **Layout primitives** | No layout components | Flex/Grid utility components | Full layout system (Stack, Grid, Container, ThreePane) | Layout components are responsive and configurable | AI selects appropriate layout for content type | AI proposes layout optimizations based on content analysis |
| 1.2.9 | **Loading/empty/error states** | No state handling | Skeleton components exist | All components have loading, empty, and error states | States are prop-driven and consistent | AI generates all states when creating new components | AI generates contextual loading states based on data source |
| 1.2.10 | **Component naming conventions** | Inconsistent | PascalCase components | Consistent naming (PascalCase components, kebab-case files, semantic names) | Naming enforced via linting rules | AI follows naming conventions automatically | AI flags naming violations in PRs |

### 1.3 Build & Distribution

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 1.3.1 | **Package build** | No build step | Single bundle | Multi-entry with subpath exports (buttons, cards, etc.) | Tree-shakeable ESM + CJS with declarations | Build includes component manifest for AI consumption | Build auto-generates changelog and migration guide |
| 1.3.2 | **Versioning** | No versioning | Manual version bumps | Semantic versioning with changelogs | Automated releases (changesets/semantic-release) | Version diffs machine-readable for AI migration assistance | AI generates migration scripts between versions |
| 1.3.3 | **Dependency management** | No peer deps declared | Peer deps listed | Peer deps with version ranges, no implicit deps | Dependency audit in CI, bundle size tracked | AI aware of dependency constraints when generating code | AI flags unnecessary dependency additions |

---

## Ring 2: Design-Code Bridge

The connection layer between design tools (Figma) and code.

### 2.1 Figma Integration

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 2.1.1 | **Figma component library** | No Figma library | Some components in Figma | Complete Figma library mirroring code components | Figma library versioned, synced with code releases | Figma library changes trigger code updates via pipeline | Bidirectional: code changes reflected in Figma via `generate_figma_design` |
| 2.1.2 | **Figma Variables** | Hardcoded styles in Figma | Some color variables | Full variable system (colors, spacing, typography, radii) | Variables organized in collections with modes (light/dark) | Variables exported in DTCG format | Variables auto-sync between Figma and code token source |
| 2.1.3 | **Auto Layout usage** | No Auto Layout | Partial Auto Layout | All components use Auto Layout | Auto Layout constraints map to CSS flex/grid | Auto Layout translates to pixel-perfect code via MCP | — |
| 2.1.4 | **Layer naming** | Default names (Group 47, Frame 12) | Some semantic naming | All layers semantically named (CardContainer, HeaderText) | Naming convention enforced, documented | Layer names map to component/prop names for AI | AI uses layer names as component structure hints |
| 2.1.5 | **Component variants in Figma** | No variants | Some variants | All states represented (default, hover, active, disabled, error) | Variant properties map to code props | AI reads Figma variants and generates matching code variants | AI proposes missing Figma variants based on code props |
| 2.1.6 | **Figma annotations** | No annotations | Comments on complex frames | Structured annotations for interactions, transitions, behavior | Annotations follow a standard format readable by AI | AI reads annotations and generates corresponding interaction code | — |

### 2.2 Code Connect & MCP Bridge

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 2.2.1 | **Figma MCP server** | Not configured | Installed, basic `get_design_context` usage | Regularly used for design-to-code generation | `get_variable_defs` + `get_screenshot` used in workflows | `create_design_system_rules` generated and maintained | Full bidirectional workflow: design→code→design |
| 2.2.2 | **Code Connect** | Not set up | Some component mappings | All core components mapped (Figma node → code import) | Mappings include prop translations | AI uses Code Connect to generate with real components, not hallucinated ones | Code Connect mappings auto-suggested and maintained |
| 2.2.3 | **Design system rules file** | None | Manual CLAUDE.md with some conventions | `create_design_system_rules` output maintained | Rules file updated on each design system release | Rules file is the single source of truth for AI behavior | Rules auto-generated from component manifest + tokens |
| 2.2.4 | **Code-to-canvas** | Not used | Occasional `generate_figma_design` for documentation | Regular use for design review of implemented features | Integrated into PR workflow (implement → push to Figma → designer reviews) | Automated: every PR generates Figma preview | — |

### 2.3 Token Pipeline

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 2.3.1 | **Token source of truth** | No single source | CSS files as source | Dedicated token files (JSON/TS) | W3C DTCG `.tokens.json` as single source | Token source published as separate package | Token source powers both Figma Variables and code |
| 2.3.2 | **Token transformation** | Manual copy between design and code | Partial automation | Style Dictionary v4 pipeline (DTCG → CSS + TS + platform outputs) | CI/CD runs token build on every commit | AI-triggered token regeneration on design changes | Full pipeline: Figma edit → CI → code tokens → PR |
| 2.3.3 | **Figma ↔ Code token sync** | Manual copy | Export from Figma, manual import | Tokens Studio plugin exports to repo | GitHub Action transforms and commits | Bidirectional sync (code token changes reflected in Figma) | Drift detection: CI alerts when Figma and code diverge |
| 2.3.4 | **Multi-platform output** | CSS only | CSS + JS/TS | CSS + TS + SCSS + JSON | iOS Swift + Android Kotlin outputs | All platform outputs from single DTCG source | Platform-specific token consumers auto-update |

---

## Ring 3: AI Automation

The layer where AI agents generate, validate, and evolve components.

### 3.1 Component Generation

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 3.1.1 | **AI-assisted component creation** | Developer writes from scratch | Claude Code with generic prompts | Claude Code with design system rules file | Claude Code + Figma MCP: design frame → component | Claude Code generates component + tests + storybook story + docs | AI proposes components when similar patterns detected in PRs |
| 3.1.2 | **Component registry** | No registry | Component list in docs | Machine-readable registry (`registry.json` / shadcn format) | Registry served via MCP server | AI browses registry, selects components for assembly | AI publishes new components to registry after review |
| 3.1.3 | **Scaffold/generator CLI** | No scaffolding | Manual template files | CLI scaffold (`ng generate component` with DS template) | Scaffold uses design system tokens and patterns | AI invokes scaffold as part of generation workflow | AI generates scaffold templates for new component categories |
| 3.1.4 | **Design-to-code fidelity** | N/A | ~50% accuracy, heavy manual cleanup | ~70% accuracy, moderate cleanup | ~80% accuracy, minor tweaks | ~90%+ accuracy, production-ready in most cases | AI self-verifies against screenshot comparison |
| 3.1.5 | **Component hydration via tokens** | Components have hardcoded styles | Components reference some CSS variables | All component styles derived from tokens (zero hardcoded values) | Token hydration verified in CI (lint for hardcoded values) | AI generates token-hydrated components by default | AI detects and refactors hardcoded values into tokens |

### 3.2 Design System MCP Server

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 3.2.1 | **Storybook + MCP** | No Storybook | Storybook with basic stories | Stories for all components with controls and docs | Storybook 10.1+ with Component Manifest addon | `@storybook/addon-mcp` serves component API to AI agents | AI generates stories for new components automatically |
| 3.2.2 | **Custom design system MCP** | None | Tokens available as JSON endpoint | Token + component metadata served via MCP | MCP serves tokens, components, usage guidelines, examples | MCP includes composition rules and pattern recommendations | MCP auto-updates when design system changes |
| 3.2.3 | **Claude Code rules** | No `.claude` configuration | Basic `CLAUDE.md` in repo | `CLAUDE.md` with component patterns, token usage, file conventions | `CLAUDE.md` + design system rules file from Figma | Component-specific CLAUDE.md per package directory | Rules auto-generated from component manifest |
| 3.2.4 | **AI skill/command library** | No custom commands | Basic scaffold command | Custom Claude Code skills for component creation | Skills for: create component, create page layout, create form, audit component | Skills chain: Figma → generate → test → storybook → PR | Skills self-improve based on generation success metrics |

### 3.3 Package Automation

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 3.3.1 | **Automated component packaging** | Manual export and publish | Script for building package | CI builds package on merge to main | CI publishes pre-release on PR, stable on merge | AI triggers package build after component changes | AI manages version bumps and changelogs |
| 3.3.2 | **Token package automation** | Tokens bundled with components | Separate token package | Token package auto-built from DTCG source | Token package published independently, components consume | AI updates token package when Figma Variables change | Full pipeline: Figma → DTCG → package → consumers |
| 3.3.3 | **Design system export** | No export capability | Manual zip/copy | Published npm packages with subpath exports | CDN distribution + npm + documentation site | Design system consumable via `npx` install or registry URL | Self-service: teams install and configure via CLI wizard |

### 3.4 AI Agent Maturity Checklist

Specific to evaluating how well AI agents can work with your design system.

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 3.4.1 | **Agent can discover components** | Agent guesses/hallucinates component names | Agent reads component list from docs | Agent queries registry/MCP for component metadata | Agent gets typed props, variants, usage examples | Agent understands composition rules and dependencies | Agent maps business requirements to component assemblies |
| 3.4.2 | **Agent can read tokens** | Agent uses hardcoded values | Agent reads CSS variable names | Agent reads DTCG token file with semantic meaning | Agent resolves token layers (primitive → semantic → component) | Agent selects tokens contextually (e.g., action vs. surface color) | Agent proposes token additions when gaps detected |
| 3.4.3 | **Agent can generate on-system** | Agent generates off-system code | Agent uses correct imports but wrong patterns | Agent generates code matching existing component patterns | Agent generates code that passes type-check and lint | Agent generates code + tests + docs matching all conventions | Agent output indistinguishable from senior developer's |
| 3.4.4 | **Agent can validate output** | No validation | Manual review only | Agent runs type-check and lint | Agent runs tests and checks accessibility | Agent compares screenshot to design, flags drift | Agent self-corrects and iterates until criteria met |
| 3.4.5 | **Agent understands context** | Zero context per session | CLAUDE.md with conventions | Design system rules file + CLAUDE.md | Component manifest + token manifest + composition rules via MCP | Full design context: Figma frame + tokens + existing patterns + usage analytics | Agent maintains cross-session learning about the design system |
| 3.4.6 | **Agent can propose improvements** | No upstream feedback | Agent flags inconsistencies in PRs | Agent suggests refactoring to use design system | Agent detects pattern duplication across codebase | Agent proposes new shared components when patterns repeat 3+ times | Agent opens PRs for design system improvements autonomously |

---

## Ring 4: Quality & Governance

### 4.1 Testing

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 4.1.1 | **Unit tests** | No tests | Some component tests | All components tested (render, variants, interactions) | Tests run in CI, coverage tracked | AI generates tests for new components | AI maintains test coverage as components evolve |
| 4.1.2 | **Visual regression testing** | No visual testing | Manual screenshot comparison | Automated snapshot testing (Chromatic/Percy/BackstopJS) | CI blocks merge on visual regression | AI-powered visual comparison (Applitools) distinguishes real regressions from noise | AI proposes visual fixes for regressions |
| 4.1.3 | **Accessibility testing** | No a11y testing | Manual screen reader testing | axe-core/jest-axe in unit tests | Storybook a11y addon + axe-playwright in CI | AI flags a11y issues during component generation | AI auto-fixes a11y issues and validates |
| 4.1.4 | **Cross-browser testing** | No cross-browser testing | Manual testing | Automated (Playwright/Cypress) on major browsers | CI matrix across Chrome/Firefox/Safari/Edge | AI generates cross-browser compatible code | AI detects and polyfills browser-specific issues |
| 4.1.5 | **Performance testing** | No perf tracking | Manual Lighthouse audits | Bundle size tracked per component | CI blocks merge if bundle size regresses | AI optimizes component bundle size | AI splits components when bundle size thresholds exceeded |

### 4.2 Governance

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 4.2.1 | **Contribution model** | No model | Ad hoc contributions | Documented contribution guidelines | PR template + review checklist for DS changes | AI pre-reviews contributions against guidelines | AI shepherds contributions through review process |
| 4.2.2 | **Design-code drift detection** | No detection | Manual audits (quarterly) | Automated token comparison (Figma vs code) | CI alerts on drift, blocks deployment | AI opens issues when drift detected | AI auto-fixes drift and proposes PR |
| 4.2.3 | **Component usage analytics** | No tracking | Manual adoption surveys | Import tracking (how many files import each component) | Dashboard showing component usage across products | AI uses usage data to prioritize improvements | AI deprecates unused components, proposes merges |
| 4.2.4 | **Breaking change management** | Unannounced changes | Changelog entries | Semantic versioning + migration guides | Codemods for automated migration | AI generates codemods for breaking changes | AI auto-migrates consumer code on major version bumps |

---

## Ring 5: Portability & Export

### 5.1 Multi-Brand & Theming

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 5.1.1 | **Theme architecture** | No theming | CSS class toggle (`.dark`) | Token-based theming (`data-theme` scoping) | Multi-brand via token layer swapping | Brand configuration file → full theme generation | AI generates brand themes from brand guidelines PDF |
| 5.1.2 | **White-label capability** | Not possible | Manual reskinning | Token overrides produce different brand | Brand package extends core tokens | CLI wizard: input brand colors/fonts → generate theme package | AI creates brand theme from screenshot or style guide |
| 5.1.3 | **Framework portability** | Single framework | CSS tokens portable, components aren't | Web Components layer for framework-agnostic consumption | Style Dictionary outputs for all target platforms | Design system usable from React, Angular, Vue, and Web Components | AI generates framework-specific wrappers from Web Component source |

### 5.2 Design System Export

| # | Checkpoint | Tier 0 | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|---|-----------|--------|--------|--------|--------|--------|--------|
| 5.2.1 | **Documentation site** | No docs | README files | Dedicated docs site (Zeroheight/Storybook/custom) | Searchable, versioned, with live code examples | Docs served via MCP for AI consumption | Docs auto-generated from component source + usage patterns |
| 5.2.2 | **Design system as npm package** | Not packaged | Single monolithic package | Scoped packages with subpath exports | Published to npm/private registry with CI/CD | Package includes component manifest for AI tools | Self-service installation with configuration wizard |
| 5.2.3 | **Figma library distribution** | No Figma library | Single team library | Published organization library | Library versioned, changelog maintained | Library auto-updated from code changes | Bidirectional sync: code ↔ Figma library |
| 5.2.4 | **Onboarding experience** | Tribal knowledge | Setup guide | Interactive getting started tutorial | Scaffold command creates consumer project | AI assists onboarding (answers DS questions via MCP) | AI configures design system integration automatically |

---

## Playbook: Exporting to an Angular Company

### Context

- Company has a **partial design system** (some shared components, inconsistent)
- Uses **Figma** with Dev seats / Organization plan
- Framework: **Angular** (likely Angular 17-19)
- Goal: Use **Claude Code** to accelerate frontend development dramatically

### The Angular Reality

The AI automation ring is **React-biased** in tooling. But switching frameworks is almost never worth the cost. Instead, invest in the **framework-agnostic layers** that make AI work regardless of framework:

| Layer | Framework Dependency | Angular Support |
|-------|---------------------|----------------|
| Design tokens (DTCG) | None | Full |
| Figma MCP server | None | Full |
| Code Connect | Framework-specific | Angular supported |
| Storybook | Framework-specific | Angular supported (Storybook for Angular) |
| Storybook MCP addon | Framework-agnostic | Works with Angular Storybook |
| shadcn registry | React-only | Not available (see alternative below) |
| Claude Code generation | Framework-aware | Good quality, not React-level |
| Figma Make | React-only | Not available |
| v0.app | React-only | Not available |

**Angular-specific alternatives:**
- Instead of shadcn registry: Build a custom **component manifest** (JSON describing all components, props, variants) and serve it via a simple MCP server
- Instead of Figma Make: Use Figma MCP `get_design_context` → Claude Code → Angular component
- Invest heavily in **CLAUDE.md** and **design system rules** — this is where Claude Code learns Angular patterns

### Prioritized Roadmap

#### Phase 0: Assessment (Week 1)
- [ ] Audit existing partial design system against this checklist
- [ ] Inventory all existing shared components
- [ ] Document current Figma usage (variables? auto layout? component library?)
- [ ] Assess Angular version and architecture (standalone components? signals?)
- [ ] Identify the 10 most-recreated components (the biggest time sinks)

#### Phase 1: Token Foundation (Weeks 2-3)
- [ ] Define token architecture: primitive → semantic → component layers
- [ ] Create W3C DTCG `.tokens.json` source of truth
- [ ] Set up Style Dictionary v4 pipeline: DTCG → CSS Custom Properties + TypeScript
- [ ] Migrate existing hardcoded values to tokens
- [ ] Set up Tokens Studio in Figma, sync variables to DTCG source
- [ ] Create GitHub Action: token change → rebuild → PR

#### Phase 2: Figma Bridge (Weeks 3-4)
- [ ] Configure Figma MCP server (remote mode: `https://mcp.figma.com/mcp`)
- [ ] Set up Code Connect: map top 20 Figma components to Angular code
- [ ] Run `create_design_system_rules` → save to `CLAUDE.md` / `.cursorrules`
- [ ] Document Figma file structure best practices for the design team
- [ ] Create Figma annotation conventions for interactive behaviors
- [ ] Test workflow: Figma frame → `get_design_context` → Claude Code → Angular component

#### Phase 3: AI Automation Layer (Weeks 4-6)
- [ ] Write comprehensive `CLAUDE.md` with Angular component patterns:
  - Standalone component template
  - Reactive Forms patterns
  - Signal-based state management
  - OnPush change detection conventions
  - Token usage rules
  - File naming and folder structure
- [ ] Set up Storybook for Angular with all existing components
- [ ] Install `@storybook/addon-mcp` (when Angular-compatible version available)
- [ ] Create Claude Code skills for component generation:
  - `create-component` (from description)
  - `create-from-figma` (from Figma frame URL)
  - `create-form` (from data schema)
  - `create-page` (from wireframe/layout)
- [ ] Build component manifest JSON (until shadcn-style registry exists for Angular):
  ```json
  {
    "components": [
      {
        "name": "Button",
        "import": "@company/design-system/button",
        "props": { "variant": ["primary", "secondary", "outline"], "size": ["sm", "md", "lg"] },
        "usage": "Use for all interactive actions. Never use <a> styled as button.",
        "figmaNodeId": "1234:5678"
      }
    ]
  }
  ```
- [ ] Create simple MCP server that serves this manifest to Claude Code

#### Phase 4: Quality Gates (Weeks 6-8)
- [ ] Set up visual regression testing (Chromatic or Percy)
- [ ] Add axe-core accessibility testing to Storybook
- [ ] Create CI pipeline: type-check + lint + test + visual regression + a11y
- [ ] Set up token drift detection (compare Figma Variables export to code tokens)
- [ ] Create PR template for design system changes

#### Phase 5: Scale & Iterate (Ongoing)
- [ ] Track component generation accuracy, iterate on rules/skills
- [ ] Expand Code Connect mappings as new components are built
- [ ] Set up code-to-canvas workflow for designer review
- [ ] Create onboarding guide: "How to create a component with Claude Code"
- [ ] Monthly design system health review against this checklist
- [ ] Graduate successful patterns into reusable Claude Code skills

### Expected Impact

Based on Atlassian's published data and industry benchmarks:

| Metric | Before | After Phase 3 | After Phase 5 |
|--------|--------|---------------|----------------|
| Time to create new component | 4-8 hours | 30-60 min | 10-20 min |
| Design-to-code accuracy | Manual, varies | ~70% first pass | ~85%+ first pass |
| Token consistency | Low (hardcoded values) | High (CI enforced) | Very high (AI enforced) |
| Component reuse rate | Low | Medium | High |
| Onboarding time for new dev | Weeks | Days | Hours (AI-assisted) |

---

## Key References

### Maturity Models
- Brad Frost: Crawl/Walk/Run — [bradfrost.com/blog/post/clarity-conf-crawl-walk-run](https://bradfrost.com/blog/post/clarity-conf-crawl-walk-run-the-evolution-of-a-design-system/)
- Brad Frost: Design System Ecosystem — [bradfrost.com/blog/post/the-design-system-ecosystem](https://bradfrost.com/blog/post/the-design-system-ecosystem/)
- InVision: Design Maturity Model — [invisionapp.com/design-better/design-maturity-model](https://www.invisionapp.com/design-better/design-maturity-model/)
- Sparkbox: Maturity Model — [sparkbox.com/foundry/design_system_maturity_model](https://sparkbox.com/foundry/design_system_maturity_model)

### Claude Code + Figma
- Figma MCP Server Guide — [help.figma.com/hc/en-us/articles/32132100833559](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
- Figma MCP Tools & Prompts — [developers.figma.com/docs/figma-mcp-server/tools-and-prompts](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/)
- Code Connect — [github.com/figma/code-connect](https://github.com/figma/code-connect)
- Code-to-Canvas — [figma.com/blog/introducing-claude-code-to-figma](https://www.figma.com/blog/introducing-claude-code-to-figma/)
- Design System Rules — [figma.com/blog/design-systems-ai-mcp](https://www.figma.com/blog/design-systems-ai-mcp/)

### Design Tokens
- W3C DTCG Spec (2025.10) — [designtokens.org/tr/2025.10/format](https://www.designtokens.org/tr/2025.10/format/)
- Style Dictionary v4 — [styledictionary.com](https://styledictionary.com/)
- Tokens Studio — [docs.tokens.studio](https://docs.tokens.studio/)
- Martin Fowler: Token-Based UI Architecture — [martinfowler.com/articles/design-token-based-ui-architecture](https://martinfowler.com/articles/design-token-based-ui-architecture.html)

### AI Integration
- Storybook + LLMs + MCP — [tympanus.net/codrops/2025/12/09/supercharge-your-design-system-with-llms-and-storybook-mcp](https://tympanus.net/codrops/2025/12/09/supercharge-your-design-system-with-llms-and-storybook-mcp/)
- Atlassian: Handoffs into Handshakes — [atlassian.com/blog/design/turning-handoffs-into-handshakes](https://www.atlassian.com/blog/design/turning-handoffs-into-handshakes-integrating-design-systems-for-ai-prototyping-at-scale)
- Supernova: AI-Ready Design Systems — [supernova.io/blog/ai-ready-design-systems](https://www.supernova.io/blog/ai-ready-design-systems-preparing-your-design-system-for-machine-powered-product-development)
- shadcn MCP — [ui.shadcn.com/docs/mcp](https://ui.shadcn.com/docs/mcp)
- 5 MCP Connections for DS Teams — [learn.thedesignsystem.guide/p/5-mcp-connections-every-design-system](https://learn.thedesignsystem.guide/p/5-mcp-connections-every-design-system)

### Industry Examples
- Shopify Polaris (Web Components, 2025) — [shopify.com/partners/blog/polaris-goes-stable](https://www.shopify.com/partners/blog/polaris-goes-stable-the-future-of-shopify-app-development-is-here)
- GitHub Primer — [primer.style](https://primer.style/)
- Atlassian Design System MCP — [atlassian.com/blog/design/turning-handoffs-into-handshakes](https://www.atlassian.com/blog/design/turning-handoffs-into-handshakes-integrating-design-systems-for-ai-prototyping-at-scale)
- Clearleft: Multi-Brand Tokens — [clearleft.com/thinking/designing-with-tokens-for-a-flexible-multi-brand-design-system](https://clearleft.com/thinking/designing-with-tokens-for-a-flexible-multi-brand-design-system)

### Tooling
- Figma Code Connect — [github.com/figma/code-connect](https://github.com/figma/code-connect)
- claude-talk-to-figma-mcp (write to Figma) — [github.com/arinspunk/claude-talk-to-figma-mcp](https://github.com/arinspunk/claude-talk-to-figma-mcp)
- Chromatic (visual regression) — [chromatic.com](https://www.chromatic.com/)
- axe-core (accessibility) — [github.com/dequelabs/axe-core](https://github.com/dequelabs/axe-core)
- Terrazzo (token tools) — [terrazzo.app](https://terrazzo.app/)
