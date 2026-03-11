---
name: design-system-audit
description: Assess and score a design system's maturity for AI-driven frontend development using a 5-ring, 6-tier maturity model. Produces a scored report with a prioritized action plan tailored to the user's framework, team size, and goals. Use this skill whenever someone asks about design system readiness, AI readiness for frontend, design-to-code maturity, Figma-to-code pipeline health, component library quality, or wants to know "how ready is my design system for AI." Also trigger when users mention design tokens, Code Connect, Figma MCP, component registries, want to accelerate frontend development with Claude Code, or are migrating between frameworks (e.g., React to Angular) and want to set up their design system right. Trigger proactively if a user describes building a design system, setting up tokens, or connecting Figma to code — even if they don't say "audit." Covers React, Angular, Vue, Svelte, and framework-agnostic setups.
---

# Design System Audit

Assess a design system's maturity for AI-driven frontend development. Combine automated codebase scanning with targeted questions, score across 5 rings, and produce a report with a personalized action plan.

## Guiding Principles

**This is a consulting engagement, not a test.** Most design systems land at Tier 1-2 — that's normal and that's why the audit exists. Frame every gap as an opportunity with a concrete next step, never as a failure. Be specific ("extract your 5 most-used colors into CSS custom properties — that's a 2-hour task") rather than vague ("improve your token system").

**Scan first, ask second.** If the user is in a codebase, you can infer half the scores automatically by looking at files. Only ask questions the codebase can't answer. This respects the user's time and produces more accurate scores than self-assessment alone.

**Adapt to the scenario.** A solo dev building a side project needs different targets than a 15-person team migrating from React to Angular. The model, the questions, and the action plan all flex.

## The Model

Five concentric rings, six maturity tiers per ring:

| Ring | What It Covers |
|------|---------------|
| 1. Foundation | Tokens, components, variants, composition, build/distribution |
| 2. Design-Code Bridge | Figma integration, Code Connect, token pipeline |
| 3. AI Automation | Component generation, MCP servers, agent maturity |
| 4. Quality & Governance | Testing, visual regression, accessibility, contribution model |
| 5. Portability & Export | Theming, multi-brand, framework portability, documentation |

| Tier | Label | What It Looks Like |
|------|-------|--------------------|
| 0 | Not Started | Capability doesn't exist |
| 1 | Ad Hoc | Hardcoded values, scattered shared files, inconsistent manual processes |
| 2 | Defined | CSS variables, typed components, documented conventions — but still manual |
| 3 | Systematic | CI/CD pipelines, generated from source, linting enforced |
| 4 | AI-Ready | MCP-exposed, queryable registries, AI can consume and generate correctly |
| 5 | Autonomous | AI generates, validates, and proposes improvements within system constraints |

The full checklist with detailed tier definitions for all ~60 checkpoints is in the reference file. Read it before scoring — use Glob to locate the file:
```
Glob pattern: **/design-system-audit/references/maturity-checklist.md
```

## Workflow

### Step 1: Detect Mode and Gather Context

**Scan the codebase first** (if the user is in a project directory). Run these checks in parallel:

| What to Look For | How to Find It | What It Tells You |
|-----------------|----------------|-------------------|
| Framework | `angular.json`, `next.config.*`, `nuxt.config.*`, `svelte.config.*`, `vite.config.*` | Which framework-specific guidance to offer |
| Tokens | `*.tokens.json`, `tokens.ts`, `tokens.css`, `:root { --` in CSS files | Ring 1 token tier |
| AI config | `CLAUDE.md`, `.cursorrules`, design system rules files | Ring 3 baseline |
| Storybook | `.storybook/` directory, storybook in `package.json` | Ring 3 + Ring 4 |
| Component lib | `components/`, `shared/`, `ui/`, `design-system/` directories | Ring 1 component tier |
| Design packages | `package.json` deps: `cva`, `class-variance-authority`, `@radix-ui/*`, `tailwindcss`, `style-dictionary` | Ring 1 sophistication |
| Testing | `*.spec.*`, `*.test.*`, Chromatic/Percy config, `axe-core` in deps | Ring 4 |
| Figma MCP | Check if Figma MCP tools are available in the current session | Ring 2 — can verify Figma quality directly |

**Then ask what you couldn't infer:**

- **Framework** (if not detected)
- **Team size** — solo, small (2-5), medium (6-15), large (15+)
- **Primary goal** — speed up component creation, improve consistency, enable AI code generation, framework migration, all of the above
- **Design tool** — Figma (with Dev seats?), Sketch, Adobe XD, none
- **Migration?** — Migrating between frameworks? From what to what?

**Example exchange:**

> "I found Angular 18 (`angular.json`), no token files, a `shared/components/` folder with 12 components, and no CLAUDE.md. I don't see Storybook or any design system packages in `package.json`.
>
> A few questions before we score:
> 1. How big is your team?
> 2. Do you use Figma for designs?
> 3. Are you migrating from another framework, or is this a pure Angular project?"

**Target tiers based on team size:**
- Solo/small: Tier 3-4 for Rings 1-3, Tier 2-3 for Rings 4-5
- Medium: Tier 4 for Rings 1-3, Tier 3 for Rings 4-5
- Large: Tier 4-5 across all rings

**Fast tracks:**
- **No design system at all?** Skip the detailed assessment. Score everything Tier 0-1, and jump straight to the Quick Wins — the "If You Only Do 5 Things" list from the maturity checklist is exactly what they need.
- **No Figma?** Ring 2 scores 0 across the board. Adjust the action plan to start with "adopt Figma with Variables" or accept a manual design-to-code workflow and focus on Rings 1 and 3.

### Step 2: Ring-by-Ring Assessment

Walk through each ring combining scan results with targeted questions. Group related checkpoints — don't interrogate all 60 individually.

#### Ring 1: Foundation

**Scoring from evidence:**

| Evidence | Tier |
|----------|------|
| Hardcoded hex/px values throughout, no shared components | 0 |
| Some CSS variables, a `components/` folder, inconsistent patterns | 1 |
| Structured CSS custom properties, typed component props, documented conventions | 2 |
| DTCG token files, Style Dictionary pipeline, CI lint for hardcoded values | 3 |
| Tokens served via MCP, component registry queryable by AI | 4 |
| Tokens auto-sync with Figma, AI proposes new tokens from usage patterns | 5 |

**Ask if needed:**
- "How do you handle colors/spacing/typography — hardcoded values, CSS variables, or a formal token system?"
- "Do you have a shared component library? Separate package or just a folder?"
- "Do your components use a variant system (CVA, Angular input unions, etc.) or conditional CSS classes?"

**Example scoring:**
> User says: "We have CSS variables for our brand colors and some spacing, but typography is still ad hoc. Components are in a shared folder with TypeScript but no formal variant system."
>
> → Tokens: Tier 1-2 (partial CSS variables, no semantic layers)
> → Components: Tier 2 (typed but no variant management)
> → Build: Tier 1 (no separate package)

#### Ring 2: Design-Code Bridge

**If Figma MCP is available**, check the actual files:
- `get_variable_defs` — variables defined? How many collections? Semantic naming?
- `get_design_context` on a representative frame — Auto Layout? Semantic layer names?
- `get_code_connect_map` — any components mapped to code?

**If no Figma MCP**, ask:
- "Is your Figma library structured with Variables, Auto Layout, and semantic layer names — or mostly free-form?"
- "How do design tokens get from Figma into code — manual copy, plugin export, or automated pipeline?"

#### Ring 3: AI Automation

**Ask:**
- "Have you tried using Claude Code to generate components from designs? How accurate was the result?"
- "Do you have a CLAUDE.md or design system rules file?"
- "Can AI discover your components — via a registry, MCP, or Storybook?"

Most teams score Tier 0-1 here. That's expected — this is the newest ring and where the biggest gains are hiding.

#### Ring 4: Quality & Governance

**Scan for:** test files, `.storybook/`, Chromatic/Percy config, `axe-core` in deps, PR templates, CODEOWNERS.

**Ask if unclear:**
- "Do you have automated tests for components? Visual regression? Accessibility?"
- "How do you version the design system and communicate breaking changes?"

#### Ring 5: Portability & Export

**Ask:**
- "Do you support theming or multiple brands?"
- "Is the design system published as a package others install?"
- "How do new developers learn the system?"

### Step 2b: Migration Scenarios

When someone is migrating between frameworks (e.g., React → Angular), the key insight is: **Figma designs are framework-agnostic.** They're the one asset that transfers fully between any framework. This means the Figma files become the most valuable asset in the migration — their quality directly determines how fast the new framework gets populated with components.

**Score migrations this way:**

*Assets that survive (score based on current quality):*
- Figma designs and variables — framework-agnostic, fully transferable
- Design tokens in CSS/DTCG format — framework-agnostic
- Token pipeline (if it outputs CSS/DTCG) — reusable
- Test patterns and accessibility standards — specs transfer even if code doesn't

*Assets that don't survive (score at Tier 0-1 for the target framework):*
- Framework-specific components — must be rewritten from scratch
- Build tooling — must be reconfigured
- Framework-coupled Storybook/registry — needs rebuilding
- CLAUDE.md — needs rewriting for target framework patterns

**Migration action plan priority:**
1. Audit Figma file hygiene first — the designs are the bridge
2. Set up the target framework foundation (component patterns, CLAUDE.md)
3. Use Figma MCP to generate components in the new framework from existing designs
4. Don't try to "port" old framework patterns — build native for the target

### Step 3: Score and Analyze

Fill in the scoring template (from the maturity checklist reference file). For each checkpoint:
1. **Current Tier** (0-5) from scan + answers
2. **Target Tier** based on team size and goals
3. **Gap** = target - current
4. **Notes** with specific observations

Compute ring averages and overall score. The 3 highest-gap areas drive the action plan.

### Step 4: Generate the Report

Save as `./design-system-audit-report.md` (or ask user for preferred location).

**Report structure:**

```
# Design System Maturity Audit Report

Date, Framework, Team Size, Overall Score (X.X / 5.0)

## Executive Summary
2-3 sentences: where they are, biggest gaps, what fixing them unlocks.

## Ring Scores
Table: Ring | Score | Target | Gap | Priority (High/Med/Low)

## Detailed Scores
Full checkpoint tables per ring (from the maturity checklist template).

## Quick Wins — Do These First
Top 5 personalized actions with estimated time.
Draw from "If You Only Do 5 Things" in the maturity checklist
but adapt to what they already have.

## Prioritized Action Plan
Phased roadmap — adapt to scenario:
- Greenfield: Foundation → Figma Bridge → AI Enablement → Quality
- Migration: Stabilize Design Assets → New Framework Foundation → AI-Powered Migration → Parity

## Framework-Specific Guidance
- Angular: read the angular-playbook.md reference file, include CLAUDE.md template
  and component manifest schema
- React: note shadcn, v0, Figma Make ecosystem advantages
- Vue/Svelte/other: framework-agnostic strategies
- Migration: which assets transfer, which need rebuilding

## Design Team Handoff
Key points from the figma-hygiene.md reference file.
Frame as: "Hand this to your designers — file quality determines
AI code generation accuracy."

## Expected Impact
Personalized metrics table (time-to-component, accuracy, consistency)
adjusted for their current tier.
```

**Example Quick Win (personalized):**
> "1. **Write a CLAUDE.md** (2-4 hours) — You have 12 Angular components in `shared/` but no documentation telling AI how to use them. A 200-line CLAUDE.md with your component patterns, naming conventions, and token usage rules gives Claude Code more context than weeks of pair programming. This is the single highest-ROI action."

### Step 5: Present and Discuss

After saving the report:
1. Summarize the 3 key findings
2. State the #1 thing to do this week
3. Offer to deep-dive into any ring or execute the first quick win together
4. If Angular: offer the full Angular Acceleration Playbook
5. If Figma MCP available: offer to audit a specific frame right now

## Reference Files

Bundled in the `references/` directory alongside this SKILL.md. Use Glob to find them (`**/design-system-audit/references/<filename>`), then Read:

| File | When to Read | Contents |
|------|-------------|----------|
| `maturity-checklist.md` | Before Step 2 scoring | Full 5-ring checklist with tier definitions for all ~60 checkpoints, blank scoring template, key references |
| `angular-playbook.md` | Step 4 if Angular or migrating to Angular | Phased roadmap, CLAUDE.md template, component manifest JSON schema, expected impact metrics |
| `figma-hygiene.md` | Step 4 for design team handoff | Layout, naming, components, variables, annotations, accessibility — the checklist designers need |
