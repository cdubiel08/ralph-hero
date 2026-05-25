---
date: 2026-03-10
status: draft
type: playbook
tags: [angular, design-system, ai-automation, claude-code, figma]
---

# Angular Acceleration Playbook

> **Author**: Chad Dubiel
> **Purpose**: Standalone action plan for accelerating frontend development at an Angular-based company using Claude Code, Figma MCP, and a token-driven design system.
>
> **Prerequisites**: [Design System Maturity Checklist](./design-system-maturity-checklist.md) for the scoring framework this playbook builds on.

## Context

- Company has a **partial design system** (some shared components, inconsistent)
- Uses **Figma** with Dev seats / Organization plan
- Framework: **Angular** (17-19+)
- Goal: Use **Claude Code** to dramatically reduce time-to-component

## The Angular Reality

The AI automation layer is **React-biased** in tooling. But switching frameworks is almost never worth the cost. Instead, invest in the **framework-agnostic layers**:

| Layer | Framework Dependency | Angular Support |
|-------|---------------------|----------------|
| Design tokens (DTCG) | None | Full |
| Figma MCP server | None | Full |
| Code Connect | Framework-specific | Angular supported |
| Storybook | Framework-specific | Angular supported |
| Storybook MCP addon | Framework-agnostic | Works with Angular Storybook |
| shadcn registry | React-only | Not available (see alternative below) |
| Claude Code generation | Framework-aware | Good quality, not React-level |
| Figma Make | React-only | Not available |
| v0.app | React-only | Not available |

**Angular-specific alternatives:**
- Instead of shadcn registry: Build a custom **component manifest** (JSON) and serve via MCP server
- Instead of Figma Make: Use Figma MCP `get_design_context` → Claude Code → Angular component
- Invest heavily in **CLAUDE.md** and **design system rules** — this is where Claude Code learns Angular patterns

---

## Phased Roadmap

### Phase 0: Assessment (Week 1)

- [ ] Score existing design system against the [maturity checklist](./design-system-maturity-checklist.md#blank-scoring-template)
- [ ] Inventory all existing shared components (name, location, usage count)
- [ ] Document current Figma usage:
  - [ ] Are Figma Variables defined?
  - [ ] Is Auto Layout used consistently?
  - [ ] Is there a published component library?
  - [ ] How are layers named? (semantic vs. "Group 47")
- [ ] Assess Angular version and architecture:
  - [ ] Standalone components or NgModule?
  - [ ] Signals or zone-based change detection?
  - [ ] OnPush change detection?
  - [ ] Reactive Forms or Template-driven?
- [ ] Identify the **10 most-recreated components** (the biggest time sinks)
- [ ] Hand the [Figma File Hygiene Checklist](./figma-file-hygiene-checklist.md) to the design team

### Phase 1: Token Foundation (Weeks 2-3)

- [ ] Define token architecture: **primitive → semantic → component** layers
- [ ] Create W3C DTCG `.tokens.json` source of truth
- [ ] Set up Style Dictionary v4 pipeline: DTCG → CSS Custom Properties + TypeScript
- [ ] Migrate existing hardcoded values to tokens (start with colors, then spacing, then typography)
- [ ] Set up Tokens Studio in Figma, sync variables to DTCG source
- [ ] Create CI action: token change → rebuild → PR

### Phase 2: Figma Bridge (Weeks 3-4)

- [ ] Configure Figma MCP server: `claude mcp add --transport http figma https://mcp.figma.com/mcp`
- [ ] Set up Code Connect: map top 20 Figma components to Angular code
- [ ] Run `create_design_system_rules` → save output to `CLAUDE.md` or `.cursorrules`
- [ ] Distribute the [Figma File Hygiene Checklist](./figma-file-hygiene-checklist.md) to design team
- [ ] Create Figma annotation conventions for interactive behaviors
- [ ] Test end-to-end workflow: Figma frame → `get_design_context` → Claude Code → Angular component

### Phase 3: AI Automation Layer (Weeks 4-6)

- [ ] Write comprehensive `CLAUDE.md` for your Angular project (see [template below](#claudemd-template-for-angular))
- [ ] Set up Storybook for Angular with all existing components
- [ ] Install `@storybook/addon-mcp` (when Angular-compatible version available)
- [ ] Create Claude Code skills for component generation:
  - `create-component` (from description)
  - `create-from-figma` (from Figma frame URL)
  - `create-form` (from data schema)
  - `create-page` (from wireframe/layout)
- [ ] Build component manifest JSON (see [schema below](#component-manifest-schema))
- [ ] Create simple MCP server that serves this manifest to Claude Code

### Phase 4: Quality Gates (Weeks 6-8)

- [ ] Set up visual regression testing (Chromatic or Percy)
- [ ] Add axe-core accessibility testing to Storybook
- [ ] Create CI pipeline: type-check + lint + test + visual regression + a11y
- [ ] Set up token drift detection (compare Figma Variables export to code tokens)
- [ ] Create PR template for design system changes

### Phase 5: Scale & Iterate (Ongoing)

- [ ] Track component generation accuracy, iterate on rules/skills
- [ ] Expand Code Connect mappings as new components are built
- [ ] Set up code-to-canvas workflow for designer review
- [ ] Create onboarding guide: "How to create a component with Claude Code"
- [ ] Monthly design system health review against maturity checklist
- [ ] Graduate successful patterns into reusable Claude Code skills

---

## Expected Impact

Based on Atlassian's published data ([source](https://www.atlassian.com/blog/design/turning-handoffs-into-handshakes-integrating-design-systems-for-ai-prototyping-at-scale)) and industry benchmarks:

| Metric | Before | After Phase 3 | After Phase 5 |
|--------|--------|---------------|----------------|
| Time to create new component | 4-8 hours | 30-60 min | 10-20 min |
| Design-to-code accuracy | Manual, varies | ~70% first pass | ~85%+ first pass |
| Token consistency | Low (hardcoded values) | High (CI enforced) | Very high (AI enforced) |
| Component reuse rate | Low | Medium | High |
| Onboarding time for new dev | Weeks | Days | Hours (AI-assisted) |

---

## CLAUDE.md Template for Angular

Save this as `CLAUDE.md` in your project root. Customize the bracketed sections for your project.

```markdown
# [Project Name]

## Design System

### Component Patterns

All components MUST follow these conventions:

- **Standalone components only** — no NgModule declarations
- **OnPush change detection** on every component
- **Signals** for reactive state (not BehaviorSubject)
- **CSS Custom Properties** for all visual values — never hardcode colors, spacing, or typography

### File Structure

```
src/app/
├── shared/
│   ├── components/          # Shared UI components
│   │   └── [component-name]/
│   │       ├── [component-name].component.ts       # Component class + template + styles
│   │       ├── [component-name].component.spec.ts   # Tests
│   │       └── index.ts                             # Public barrel export
│   ├── directives/          # Shared directives
│   ├── pipes/               # Shared pipes
│   └── services/            # Shared services
├── features/
│   └── [feature-name]/
│       ├── components/      # Feature-specific components
│       ├── services/        # Feature-specific services
│       └── [feature-name].routes.ts
└── core/
    ├── services/            # Singleton services
    ├── guards/              # Route guards
    └── interceptors/        # HTTP interceptors
```

### Component Template

When creating a new component, follow this exact pattern:

```typescript
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

@Component({
  selector: 'app-[component-name]',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Template here -->
  `,
  styles: [`
    :host {
      display: block;
    }
    /* Use CSS Custom Properties from the token system */
    /* e.g., color: var(--color-text-primary); */
  `]
})
export class [ComponentName]Component {
  // Inputs use the input() signal function
  readonly label = input.required<string>();
  readonly variant = input<'primary' | 'secondary' | 'outline'>('primary');
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly disabled = input<boolean>(false);

  // Outputs use the output() function
  readonly clicked = output<void>();

  // Internal state uses signal()
  readonly isLoading = signal(false);
}
```

### Token Usage Rules

- **Colors**: Always use `var(--color-*)` — never hardcode hex/rgb/hsl
- **Spacing**: Always use `var(--spacing-*)` — never hardcode px/rem for margins/padding
- **Typography**: Always use `var(--font-size-*)`, `var(--font-weight-*)`, `var(--line-height-*)`
- **Shadows**: Always use `var(--shadow-*)`
- **Radii**: Always use `var(--radius-*)`
- **Transitions**: Always use `var(--duration-*)` and `var(--ease-*)`

### Form Patterns

Forms use Reactive Forms with typed FormGroups:

```typescript
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

// In component:
private fb = inject(FormBuilder);

form = this.fb.nonNullable.group({
  name: ['', [Validators.required, Validators.minLength(2)]],
  email: ['', [Validators.required, Validators.email]],
});
```

### Naming Conventions

- **Components**: `PascalCase` class, `kebab-case` selector with `app-` prefix
- **Files**: `kebab-case.component.ts`, `kebab-case.service.ts`
- **CSS classes**: `kebab-case`, BEM optional for complex components
- **Tokens**: `--category-property-variant` (e.g., `--color-text-primary`)
- **Signals**: camelCase, no `$` suffix (that's for Observables)

### Testing

- Every component needs a `.spec.ts` file
- Test all variants and states
- Use `TestBed` with standalone component imports
- Accessibility: include `axe-core` checks for interactive components

### What NOT To Do

- Do NOT create components inside NgModules
- Do NOT use `any` type — always type inputs and outputs
- Do NOT hardcode visual values — use design tokens
- Do NOT create new CSS variables — use existing tokens from the token system
- Do NOT use `ViewChild` for component communication — use signals and inputs/outputs
- Do NOT import `CommonModule` — import specific directives (`NgIf`, `NgFor`, `NgClass`) or use `@if`/`@for` control flow
```

---

## Component Manifest Schema

Until a shadcn-style registry exists for Angular, build this JSON manifest and serve it via a simple MCP server:

```json
{
  "$schema": "component-manifest-v1",
  "package": "@company/design-system",
  "framework": "angular",
  "components": [
    {
      "name": "Button",
      "selector": "app-button",
      "import": "@company/design-system/button",
      "inputs": {
        "variant": {
          "type": "string",
          "values": ["primary", "secondary", "outline", "ghost", "destructive"],
          "default": "primary"
        },
        "size": {
          "type": "string",
          "values": ["sm", "md", "lg"],
          "default": "md"
        },
        "disabled": {
          "type": "boolean",
          "default": false
        },
        "loading": {
          "type": "boolean",
          "default": false
        }
      },
      "outputs": {
        "clicked": { "type": "void" }
      },
      "usage": "Use for all interactive actions. Never use <a> styled as a button.",
      "figmaNodeId": "1234:5678",
      "tokens": ["--color-action-primary", "--radius-full", "--shadow-sm"]
    },
    {
      "name": "Input",
      "selector": "app-input",
      "import": "@company/design-system/input",
      "inputs": {
        "label": { "type": "string", "required": true },
        "placeholder": { "type": "string" },
        "type": {
          "type": "string",
          "values": ["text", "email", "password", "number", "tel"],
          "default": "text"
        },
        "error": { "type": "string", "description": "Error message to display" },
        "disabled": { "type": "boolean", "default": false }
      },
      "outputs": {
        "valueChange": { "type": "string" }
      },
      "usage": "Always use inside a Reactive Form with FormField wrapper for accessibility.",
      "figmaNodeId": "1234:9012"
    }
  ],
  "tokens": {
    "source": "src/styles/tokens.json",
    "format": "dtcg",
    "categories": ["color", "spacing", "typography", "shadow", "radius", "motion"]
  },
  "patterns": {
    "forms": "Always use Reactive Forms with typed FormGroups. Wrap inputs in FormField for label + error display.",
    "modals": "Use Angular CDK Dialog. Inject DialogRef for close actions.",
    "routing": "Lazy-load feature routes. Use route resolvers for data fetching.",
    "state": "Use signals for local state. Use NgRx SignalStore for shared state."
  }
}
```

**Serving via MCP**: Create a minimal MCP server that exposes a `get_component_manifest` tool returning this JSON. Claude Code can then query it before generating any component code.

---

## Key References

- [Design System Maturity Checklist](./design-system-maturity-checklist.md)
- [Figma File Hygiene Checklist](./figma-file-hygiene-checklist.md)
- [Atlassian: Handoffs into Handshakes](https://www.atlassian.com/blog/design/turning-handoffs-into-handshakes-integrating-design-systems-for-ai-prototyping-at-scale) — ~70% ADS accuracy, champions program, consolidated guidelines
- [Figma MCP Server Guide](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)
- [Figma Code Connect (Angular supported)](https://github.com/figma/code-connect)
- [W3C DTCG Spec (2025.10)](https://www.designtokens.org/tr/2025.10/format/)
- [Style Dictionary v4](https://styledictionary.com/)
- [Storybook for Angular](https://storybook.js.org/docs/get-started/frameworks/angular)
