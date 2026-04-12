---
date: 2026-03-19
status: draft
type: plan
tags: [playwright, testing, storybook, a11y, plugin, skills, agents]
github_issue: 616
github_issues: [616]
github_urls:
  - https://github.com/cdubiel08/ralph-hero/issues/616
primary_issue: 616
---

# Ralph-Playwright Plugin Implementation Plan

## Prior Work

- builds_on:: [[2026-03-19-agent-driven-ui-testing-stochastic-exploration]]
- builds_on:: [[2026-02-18-GH-0067-bowser-justfile-cli-patterns]]
- builds_on:: [[2026-02-19-GH-0132-agent-skill-patterns-bowser-reference]]

## Overview

A new Claude Code plugin (`plugin/ralph-playwright/`) that provides polymorphic, adaptable UI testing skills as a complement to ralph-hero. Like ralph-knowledge (semantic search over docs), ralph-playwright is optional infrastructure: install it and gain Storybook + Playwright E2E + accessibility + stochastic exploration capabilities against any web application.

Skills are **polymorphic**: they detect what's available (Storybook running? a11y MCP registered? Playwright Planner version?) and adapt behavior accordingly. Same skill works on any project.

## Current State Analysis

No UI testing skills or agents exist in the repo today. Closest prior art:
- ralph-hero skills reference disler/bowser as a 4-layer architecture reference (GH-067, GH-132)
- GH-602 integration testing plan covers MCP unit tests (TypeScript/Vitest) — different domain
- The 4-layer Bowser pattern (justfile → commands → agents → skills) is documented and treated as the canonical Claude Code testing reference

This plugin is the first to implement it as a reusable plugin rather than project-specific config.

## Desired End State

`plugin/ralph-playwright/` lives in this repo alongside ralph-knowledge. After plugin install:

1. `story-gen` skill generates user story YAML from text descriptions (with automatic sad paths)
2. `explore` skill browses a live URL → discovers flows → outputs user stories YAML
3. `test-e2e` skill runs all story YAML files in parallel and aggregates a pass/fail report
4. `a11y-scan` skill runs axe-core WCAG 2.2 AA audit against any URL
5. `storybook-test` skill runs Storybook 9 + Vitest component tests
6. `visual-diff` skill runs visual regression via Chromatic or Applitools

### Verification:
- Plugin appears in Claude Code skill list after install
- `story-gen` produces valid YAML with happy + sad paths from a 2-sentence description
- `test-e2e` runs example stories against a live localhost URL and produces a report

## What We're NOT Doing

- No Figma MCP → user stories pipeline (deferred — see Deferred section)
- No Stagehand-based deep stochastic exploration in v1 (noted as pivot path — see Deferred)
- No CI/CD GitHub Actions workflow (deferred)
- No ralph-playwright MCP server (deferred — skills + agents only for now)
- No specific target project — framework-agnostic by design

## Implementation Approach

**User story files** live in the consuming project at `playwright-stories/**/*.yaml`. The schema extends Bowser's minimal approach with `type` (happy/sad/edge), `persona`, and `tags`.

**Execution model** follows Bowser's 4-layer pattern adapted for skills:
- Orchestrator skill fans out one `story-runner-agent` per YAML file (all parallel)
- Each agent uses `@playwright/mcp` tools exclusively (no direct Playwright SDK dependency)
- A11y checks injected per-step when `a11y-mcp-server` is available

**Sad path generation** is automatic: whenever `story-gen` or `explore` creates happy paths, it applies a heuristic set to produce corresponding sad paths (validation errors, auth failures, empty states, network errors, boundary values).

---

## Phase 1: Plugin Foundation

### Overview
Establish the plugin directory structure, user story YAML schema, example stories, and setup skill. No testing logic yet — just the scaffolding that makes the other phases installable and the schema that all phases use.

### Changes Required:

#### 1. Plugin registration

**File**: `plugin/ralph-playwright/.claude-plugin/plugin.json`
```json
{
  "name": "ralph-playwright",
  "version": "0.1.0",
  "description": "Polymorphic UI testing skills: story generation, E2E execution, a11y, Storybook, and visual regression",
  "skills": [
    "skills/setup",
    "skills/story-gen",
    "skills/explore",
    "skills/test-e2e",
    "skills/a11y-scan",
    "skills/storybook-test",
    "skills/visual-diff"
  ],
  "agents": [
    "agents/story-runner-agent.md",
    "agents/explorer-agent.md"
  ]
}
```

#### 2. User story YAML schema

**File**: `plugin/ralph-playwright/schemas/user-story.schema.yaml`

This is the canonical schema. All generated and hand-authored stories must conform.

```yaml
# ralph-playwright user story schema
# Each file contains one or more stories for a feature area

stories:
  - name: string              # Human-readable story name (used for directory naming)
    type: happy | sad | edge  # Test classification
    url: string               # Entry URL for this story
    persona: string           # Optional: user role ("anonymous", "admin", "registered user")
    tags: [string]            # Optional: filter tags (e.g. ["auth", "login"])
    workflow: |               # Plain-text natural language steps (Bowser-compatible)
      Navigate to <url>
      Verify <expected state>
      <action>
      Verify <expected outcome>
```

**Sad path heuristics** (applied automatically by `story-gen` and `explore`):
- Required field empty → validation error appears, form not submitted
- Invalid format (wrong email, special chars) → format validation error
- Wrong credentials / unauthorized → error message, user stays on page
- Already exists / duplicate submission → conflict error
- Session expired / unauthenticated access → redirect to login
- Rate limited / too many attempts → appropriate throttle error
- Empty state (no items in list, first-time user) → empty state UI shown
- Boundary values (very long strings, max-length fields) → graceful handling

**File**: `plugin/ralph-playwright/schemas/example-auth.yaml`

A reference example demonstrating happy, sad, and edge stories for an auth flow:

```yaml
stories:
  - name: "Login succeeds with valid credentials"
    type: happy
    url: "http://localhost:3000/login"
    persona: "registered user"
    tags: [auth, login]
    workflow: |
      Navigate to http://localhost:3000/login
      Verify login form with email and password fields is visible
      Fill email field with "test@example.com"
      Fill password field with "correct-password"
      Click the Sign In button
      Verify redirect to /dashboard occurs
      Verify a welcome message is visible

  - name: "Login fails with wrong password"
    type: sad
    url: "http://localhost:3000/login"
    persona: "registered user"
    tags: [auth, login, error-handling]
    workflow: |
      Navigate to http://localhost:3000/login
      Fill email field with "test@example.com"
      Fill password field with "wrong-password"
      Click the Sign In button
      Verify an "Invalid credentials" error message appears
      Verify the user remains on the login page
      Verify the password field is cleared

  - name: "Login fails when fields are empty"
    type: sad
    url: "http://localhost:3000/login"
    persona: "anonymous"
    tags: [auth, login, validation]
    workflow: |
      Navigate to http://localhost:3000/login
      Click the Sign In button without entering any values
      Verify validation errors appear for both email and password fields
      Verify the form was not submitted

  - name: "Unauthenticated user is redirected from dashboard"
    type: sad
    url: "http://localhost:3000/dashboard"
    persona: "anonymous"
    tags: [auth, redirect]
    workflow: |
      Navigate directly to http://localhost:3000/dashboard without logging in
      Verify redirect to /login occurs
      Verify a "Please sign in" message or similar prompt is shown

  - name: "Login form is keyboard-navigable and screen-reader accessible"
    type: edge
    url: "http://localhost:3000/login"
    persona: "screen reader user"
    tags: [auth, login, a11y]
    workflow: |
      Navigate to http://localhost:3000/login
      Verify all form fields have associated visible or aria labels
      Verify tab order is logical: email → password → submit button
      Verify the submit button is operable via keyboard Enter
      Verify error messages are associated with their fields via aria-describedby
```

#### 3. Setup skill

**File**: `plugin/ralph-playwright/skills/setup/SKILL.md`

```markdown
---
name: ralph-playwright:setup
description: One-time setup for ralph-playwright — installs required MCPs (Playwright, a11y, Storybook), validates browser installation, and creates playwright-stories/ directory. Use when setting up ralph-playwright for the first time or diagnosing a broken install.
---

# Ralph-Playwright Setup

Install and configure all MCP servers required by ralph-playwright skills.

## Step 1: Required MCP — Playwright (mandatory)

Add to `.claude/settings.local.json` under `env` → `mcpServers`:
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Or via CLI:
```bash
claude mcp add playwright npx @playwright/mcp@latest
```

## Step 2: A11y MCP (recommended)
```bash
claude mcp add a11y-accessibility -- npx -y a11y-mcp-server
```

## Step 3: Storybook MCP (optional — Storybook 9.1.16+ only)
Requires Storybook dev server running. Add to your project:
```bash
npm install -D @storybook/addon-mcp
```
Register MCP (transport: http, Storybook must be running first):
```bash
claude mcp add storybook-mcp --transport http http://localhost:6006/mcp --scope project
```

## Step 4: Install browsers
```bash
npx playwright install chromium
# Or all browsers:
npx playwright install
```

## Step 5: Create story directory
In your project root:
```bash
mkdir -p playwright-stories
```

Add to `.gitignore`:
```
playwright-results/
```
(Story YAML files in `playwright-stories/` should be committed.)

## Validation
- `npx playwright --version` → should show 1.56.0 or higher for Planner support
- Claude Code MCP panel shows "playwright" connected
- (Optional) "a11y-accessibility" connected

## Next Steps
- Generate stories: `/ralph-playwright:story-gen`
- Explore a URL: `/ralph-playwright:explore http://localhost:3000`
- Run tests: `/ralph-playwright:test-e2e`
```

### Success Criteria:

#### Automated Verification:
- [ ] `plugin/ralph-playwright/.claude-plugin/plugin.json` is valid JSON
- [ ] `schemas/user-story.schema.yaml` is valid YAML
- [ ] `schemas/example-auth.yaml` is valid YAML and conforms to the schema

#### Manual Verification:
- [ ] Setup skill clearly describes all install commands
- [ ] Example stories include happy, sad, AND edge stories
- [ ] Schema documents all fields with types and examples

---

## Phase 2: Story Generation

### Overview
Two skills to create user stories YAML from different inputs. Both automatically generate contextually appropriate sad paths.

### Changes Required:

#### 1. story-gen skill

**File**: `plugin/ralph-playwright/skills/story-gen/SKILL.md`

```markdown
---
name: ralph-playwright:story-gen
description: Generate user stories YAML from plain-text descriptions, feature requirements, or PRDs. Automatically includes happy paths AND contextually relevant sad paths (validation errors, auth failures, empty states, network errors, boundary values). Saves to playwright-stories/<feature-name>.yaml. Use when you want to create test stories from a description rather than by exploring a live site.
---

# Story Generation — Text → User Stories YAML

## Process

### Step 1: Gather input
Ask for (or use provided arguments):
- Feature or page description (minimum 1-2 sentences)
- Target URL or URL pattern
- User personas if known (defaults: anonymous, registered user)
- Any known edge cases to include explicitly

### Step 2: Generate stories via structured output

Produce stories in these categories:

**Happy paths** — all primary success flows:
- Primary user goal fully achieved
- Optional features/variants exercised
- Multi-step workflows completed

**Sad paths** — automatically derived, apply ALL applicable heuristics:
- Required field left empty → validation error, form not submitted
- Invalid format → format error shown
- Wrong credentials → error, user stays on page, sensitive data cleared
- Unauthenticated access to protected resource → redirect to login
- Duplicate/already-exists submission → conflict error
- Too many attempts / rate limited → throttle message
- Network error mid-flow → graceful error, no data loss (if applicable)

**Edge paths** — include at minimum:
- Empty/zero state (no items, first-time user)
- Maximum/boundary input values
- Accessibility story (keyboard nav, screen reader labels, focus management)

### Step 3: Output YAML

Save to `playwright-stories/<feature-kebab-name>.yaml` following the canonical schema.
Each story must have: name, type, url, tags, workflow.
Persona is optional but recommended.

### Step 4: Present and iterate
Show the generated file path and count:
- N happy paths, N sad paths, N edge paths
- Ask: any missing cases? Should we run them now? (`/ralph-playwright:test-e2e`)
```

#### 2. explore skill

**File**: `plugin/ralph-playwright/skills/explore/SKILL.md`

```markdown
---
name: ralph-playwright:explore
description: Explore a running website to discover user flows and generate user story YAML files. Uses Playwright Planner agent (v1.56+) as the primary path. Falls back to @playwright/mcp direct navigation if Planner is unavailable. Pivot path to Stagehand documented below. Works on localhost or any accessible URL. Automatically augments discovered flows with sad paths.
---

# Explore — Live URL → User Stories YAML

## Prerequisites
- Target app must be running (e.g. `npm run dev` → `http://localhost:3000`)
- `@playwright/mcp` installed and registered in Claude Code

## Process

### Step 1: Check Playwright version
```bash
npx playwright --version
```
- v1.56.0+: use **Playwright Planner** (primary path)
- Older: use **@playwright/mcp direct navigation** (fallback path)

---

### Primary Path: Playwright Planner Agent (v1.56+)

```bash
npx playwright init-agents --loop=claude
```

The Planner agent browses the target URL, discovers interactive elements and navigation paths, and produces a structured Markdown test plan.

After Planner completes:
1. Parse the Markdown test plan
2. Convert each discovered flow to a user story using the canonical schema
3. Infer `type`: success flows → `happy`, error states found → `sad`
4. Save to `playwright-stories/<page-name>-discovered.yaml`

---

### Fallback Path: @playwright/mcp Direct Navigation

When Planner is unavailable, spawn `explorer-agent` with the target URL.

The explorer agent:
1. Navigates to the URL and takes an accessibility tree snapshot
2. Identifies all interactive elements, forms, and navigation links
3. Follows unique paths up to 2 levels deep (max 20 flows)
4. Records each unique path as a user story

---

### Step 2: Augment with sad paths

After flow discovery, automatically generate sad paths:
- For each **form** found: invalid input story + empty submission story
- For each **auth-protected page** found: unauthenticated access story
- For each **destructive action** found: confirmation/cancellation story
- For each **data-loading component**: empty state + error state story

### Step 3: Output and summary
Save all stories to `playwright-stories/` and report:
- N happy paths discovered
- N sad paths generated
- Suggest: `/ralph-playwright:test-e2e` to run them

---

## Pivot Note: Stagehand (when to switch)

If Playwright Planner produces insufficient coverage (< 5 flows on a complex SPA, or misses dynamically rendered content):

```bash
npm install @browserbasehq/stagehand
```

Use `stagehand.observe()` to enumerate all available actions at each page state, then `stagehand.agent()` for a full autonomous loop. This gives richer exploration at the cost of a Browserbase dependency and higher token usage. See Deferred section for full implementation notes.
```

#### 3. explorer-agent

**File**: `plugin/ralph-playwright/agents/explorer-agent.md`

```markdown
---
name: explorer-agent
description: Fallback exploration agent. Navigates a web app via @playwright/mcp, maps interactive elements and navigation paths up to 2 levels deep, and returns structured flow data for conversion to user stories.
model: claude-sonnet-4-6
---

# Explorer Agent

You are a web application flow mapper. Your job: systematically explore a running app and return all discoverable user flows as structured data.

## Instructions

Given a starting URL:

1. Navigate to the URL with `browser_navigate`
2. Take accessibility tree snapshot with `browser_snapshot`
3. Identify all:
   - Navigation links (header, sidebar, footer)
   - Buttons and CTAs
   - Forms and their fields
   - Interactive components (dropdowns, modals, tabs)
4. Follow each unique link/button (track visited URLs to avoid loops)
5. For each destination page, repeat steps 2-3 (max 2 levels deep)
6. Stop after 20 unique flows

## Output Format

Return a JSON array:
```json
[
  {
    "name": "User views product list",
    "startUrl": "http://localhost:3000",
    "steps": [
      "Navigate to http://localhost:3000",
      "Click the Products link in the navigation",
      "Verify product list loads with at least one item"
    ],
    "type": "happy",
    "formFound": false
  },
  {
    "name": "User submits contact form",
    "startUrl": "http://localhost:3000/contact",
    "steps": [
      "Navigate to http://localhost:3000/contact",
      "Fill name field with 'Test User'",
      "Fill email field with 'test@example.com'",
      "Fill message field with 'Hello'",
      "Click Submit",
      "Verify success message appears"
    ],
    "type": "happy",
    "formFound": true
  }
]
```

Do not get stuck in loops. Track all visited URLs. Stop at 20 flows or 2 levels deep.
```

### Success Criteria:

#### Automated Verification:
- [ ] `story-gen` skill produces valid YAML when given a text description
- [ ] Generated YAML contains at least 1 sad path for any login/form feature
- [ ] `explore` skill runs without error against a public URL

#### Manual Verification:
- [ ] `story-gen` on "a login page" produces at least: successful login, wrong password, empty fields, unauthenticated redirect
- [ ] `explore` on a running dev server produces multiple flows with correct schema
- [ ] Explorer agent stays within bounds (≤20 flows, no URL loops)

---

## Phase 3: Story Execution

### Overview
The core testing loop: discover all YAML story files, fan out parallel agents (one per file), execute each via Playwright MCP, inject a11y checks, aggregate results.

### Changes Required:

#### 1. test-e2e skill

**File**: `plugin/ralph-playwright/skills/test-e2e/SKILL.md`

```markdown
---
name: ralph-playwright:test-e2e
description: Run all user story YAML files in playwright-stories/ in parallel using isolated Playwright agents. Aggregates pass/fail results with screenshots and a11y violations. Optionally filter by type (happy/sad/edge) or tags. Use when you want to run your full story suite or a filtered subset.
---

# Test E2E — Run All User Stories

## Process

### Step 1: Discover stories
Glob all `playwright-stories/**/*.yaml` files.

If none found, suggest:
- `/ralph-playwright:story-gen` to create stories from a description
- `/ralph-playwright:explore <url>` to generate stories by exploring a site

Optional filters (from arguments):
- `--type happy|sad|edge` — run only stories of that type
- `--tags auth,login` — run only stories with matching tags
- `--story "Login succeeds"` — run a specific story by name

### Step 2: Fan out parallel agents
Spawn one `story-runner-agent` per YAML file simultaneously.
Each agent gets its own named Playwright session — fully isolated.

### Step 3: Wait and aggregate
Wait for all agents to complete, then produce a unified report:

```
== ralph-playwright E2E Report ==
Stories: 5 | ✅ Pass: 4 | ❌ Fail: 1 | ⏭ Skip: 0
A11y violations: 2

PASSED:
  ✅ auth — "Login succeeds with valid credentials" (3.2s)
  ✅ auth — "Login fails with wrong password" (2.1s)
  ✅ auth — "Login fails when fields are empty" (1.8s)
  ✅ auth — "Login form is keyboard-navigable" (2.9s)

FAILED:
  ❌ auth — "Unauthenticated user is redirected from dashboard"
     Step 2: Expected redirect to /login — page stayed at /dashboard
     Screenshot: playwright-results/unauthenticated-redirect_a1b2c3d4/02_navigate.png
     Console errors: []

A11Y VIOLATIONS:
  - auth/login — Missing label on #email-field (WCAG 1.3.1, serious)
  - auth/login — Color contrast insufficient on .error-text (WCAG 1.4.3, serious)
```

Results directory `playwright-results/` is created automatically.
```

#### 2. story-runner-agent

**File**: `plugin/ralph-playwright/agents/story-runner-agent.md`

```markdown
---
name: story-runner-agent
description: Executes a single user story YAML via @playwright/mcp. Captures screenshots per step, captures console errors on failure, runs axe-core a11y check at the end (if a11y MCP available), and returns a structured pass/fail result.
model: claude-sonnet-4-6
---

# Story Runner Agent

You execute a single user story and return a structured result.

## Input
A user story object: { name, type, url, persona, workflow }

## Execution

### Session setup
Create a named Playwright session: `story-<story-name-kebab>-<8-char-uuid>`
Create screenshot directory: `playwright-results/<story-name-kebab>_<uuid>/`

### Execute each step
Parse the `workflow` field line by line. For each non-empty line:
1. Interpret the natural language instruction
2. Use `browser_snapshot` to get the current accessibility tree (before acting)
3. Find the target element contextually by label, role, or text — NOT by CSS selectors
4. Execute the action: navigate, click, fill, type, or verify
5. Take screenshot: `playwright-results/<dir>/<index>_<step-slug>.png`
6. Verify assertion steps using the snapshot state

On step failure:
- Record failure message and expected vs actual state
- Capture JS console errors via `browser_evaluate("(window.__consoleErrors || [])")`
- Mark all remaining steps as SKIPPED
- Stop execution immediately

### A11y check (when available)
After the final step (or after failure), if the `a11y-accessibility` MCP is registered:
```
test_accessibility(url: <current page URL>)
```
Attach WCAG violations to the result.

### Output (JSON)
```json
{
  "story": "Login succeeds with valid credentials",
  "type": "happy",
  "status": "pass",
  "duration": 3241,
  "steps": [
    { "step": "Navigate to login", "status": "pass", "screenshot": "00_navigate.png" },
    { "step": "Verify form visible", "status": "pass", "screenshot": "01_verify-form.png" },
    { "step": "Fill email", "status": "pass", "screenshot": "02_fill-email.png" },
    { "step": "Click Sign In", "status": "fail", "error": "Button not found in snapshot", "consoleErrors": [] }
  ],
  "a11yViolations": [
    { "rule": "label", "impact": "serious", "description": "Form field has no label", "wcag": "1.3.1" }
  ]
}
```
```

#### 3. a11y-scan skill

**File**: `plugin/ralph-playwright/skills/a11y-scan/SKILL.md`

```markdown
---
name: ralph-playwright:a11y-scan
description: Run a standalone WCAG 2.2 AA accessibility audit against a URL or set of URLs using axe-core via a11y-mcp-server. Reports violations by severity. Use for a quick a11y check without running full story execution. Requires a11y-mcp-server to be registered.
---

# A11y Scan — Standalone Accessibility Audit

## Prerequisites
`a11y-mcp-server` registered in Claude Code (see `/ralph-playwright:setup`).

## Process

### Step 1: Target URL(s)
From arguments or ask. Multiple URLs run in parallel.

### Step 2: Run axe-core checks
For each URL:
```
test_accessibility(url)         → WCAG rule violations
check_color_contrast(url)       → contrast ratios
check_aria_attributes(url)      → ARIA validity
```

### Step 3: Report
```
== A11y Scan: http://localhost:3000/login ==
WCAG 2.2 AA | axe-core | 3 violations

🔴 CRITICAL (1):
  - Interactive element not keyboard accessible: .modal-close-btn
    → Add tabindex="0" and keydown handler (WCAG 2.1.1)

🟠 SERIOUS (1):
  - Form field missing label: <input id="email">
    → Add <label for="email"> or aria-label (WCAG 1.3.1)

🟡 MODERATE (1):
  - Color contrast insufficient: .helper-text ratio 2.8:1, needs 4.5:1
    → Darken text color (WCAG 1.4.3)
```

Severities: 🔴 critical, 🟠 serious, 🟡 moderate, ⚪ minor.
```

### Success Criteria:

#### Automated Verification:
- [ ] `test-e2e` skill discovers YAML files in `playwright-stories/`
- [ ] `story-runner-agent` executes a simple story against a live URL (e.g. a public site)
- [ ] A11y violations appear in the result JSON from story-runner-agent

#### Manual Verification:
- [ ] Multiple stories run simultaneously (check timestamps overlap)
- [ ] Each story produces screenshots in its own `playwright-results/<uuid>/` directory
- [ ] A sad path story correctly fails when the expected error message is not shown
- [ ] `a11y-scan` identifies at least one real violation on a page with known issues

---

## Phase 4: Storybook Integration

### Overview
Component-level testing via Storybook 9. Complements Phase 3 (page-level E2E) with component-level interaction and a11y assurance.

### Changes Required:

#### 1. storybook-test skill

**File**: `plugin/ralph-playwright/skills/storybook-test/SKILL.md`

```markdown
---
name: ralph-playwright:storybook-test
description: Run Storybook 9 component tests (interaction + a11y) using Vitest browser mode or legacy test-runner. Detects which runner is installed and adapts. Optionally uses Storybook MCP to validate component usage. Requires Storybook 9+ with @storybook/addon-vitest or @storybook/test-runner.
---

# Storybook Component Testing

## Step 1: Detect Storybook setup
```bash
npx storybook --version          # needs 9.x
cat package.json | grep -E "addon-vitest|test-runner"
```

- `@storybook/addon-vitest` found → **Vitest mode** (Storybook 9, recommended)
- `@storybook/test-runner` found → **Legacy mode** (older Storybook)
- Neither → show install instructions

## Step 2: Run tests

**Vitest mode:**
```bash
npx vitest --project=storybook
```

**Legacy mode:**
```bash
npx test-storybook --url http://localhost:6006
```

## Step 3: Storybook MCP enrichment (optional)
If Storybook MCP is registered (`http://localhost:6006/mcp`):
- Call `list-all-components` to enumerate all components
- Cross-reference with test results
- Flag any components with no stories (coverage gap)

## Step 4: Report
```
== Storybook Component Tests ==
Components: 24 | Stories: 87 | ✅ Pass: 85 | ❌ Fail: 2

FAILED:
  ❌ Button/Primary — Interaction: onClick not called after keyboard Enter
  ❌ Form/LoginForm — A11y: missing label on password field (WCAG 1.3.1)

A11y summary: 1 violation across 1 component
Coverage gaps: 0 components have no stories
```
```

#### 2. visual-diff skill

**File**: `plugin/ralph-playwright/skills/visual-diff/SKILL.md`

```markdown
---
name: ralph-playwright:visual-diff
description: Run visual regression testing using Chromatic (default, free tier available) or Applitools Eyes (AI-based, better for dynamic content). Detects unintended UI changes across Storybook stories. Use after visual changes to verify intentional vs unintentional diffs.
---

# Visual Diff — Visual Regression Testing

## Tool Detection
Check what's configured:
```bash
cat package.json | grep -E "chromatic|@applitools"
```

- `chromatic` found → **Chromatic mode** (pixel-perfect)
- `@applitools/eyes-storybook` found → **Applitools mode** (AI-based)
- Neither → guide through Chromatic setup (recommended default)

## Chromatic (default)
```bash
npm install --save-dev chromatic
npx chromatic --project-token=<token-from-chromatic.com>
```
Free tier: 5,000 snapshots/month. Pixel-perfect diffing. Good for stable UIs.

## Applitools Eyes (alternative)
```bash
npm install --save-dev @applitools/eyes-storybook
npx eyes-storybook
```
AI-powered visual perception. Ignores rendering noise (anti-aliasing, sub-pixel differences). Better for UIs with dynamic content or cross-browser inconsistencies.

## When to choose Applitools over Chromatic
- Getting excessive false positives from Chromatic on animations or dynamic content
- Need cross-browser visual comparison (Chromatic uses one browser)
- Have Storybook stories with real data that varies slightly between runs
```

### Success Criteria:

#### Automated Verification:
- [ ] `storybook-test` skill detects and uses the correct runner (Vitest vs legacy)
- [ ] A11y violations at component level are surfaced in the report

#### Manual Verification:
- [ ] Storybook test run completes and shows per-story pass/fail
- [ ] `visual-diff` runs Chromatic against a Storybook 9 project and produces a diff report

---

## Deferred Work

Explicitly out of scope for this plan but documented for future implementation:

### D1: Figma MCP → User Stories Pipeline
**Why deferred**: Figma integration adds significant scope (token chunking, reactions field parsing, Jira sync) and requires Figma file access not available as a generic framework feature.

**Approach when implemented**:
1. Connect Figma MCP (`https://mcp.figma.com/mcp`)
2. Extract `reactions` field from prototype nodes for the interaction graph
3. Chunk large Figma files (token limit constraint — required for any file > ~20 frames)
4. LLM structured output (Zod schema) → `UserStory[]` matching ralph-playwright schema
5. Add `story-gen-figma` skill variant: accepts Figma file key → outputs YAML

### D2: Stagehand-Based Deep Stochastic Exploration
**When to pivot from Playwright Planner**:
- Planner produces < 5 flows on a complex SPA
- Highly dynamic applications where accessibility tree is insufficient
- Need true open-ended exploration without predefined goals

**Approach**:
```typescript
import { Stagehand } from "@browserbasehq/stagehand";
const stagehand = new Stagehand({ env: "LOCAL" }); // or "BROWSERBASE" for cloud
await stagehand.init();
const page = stagehand.page;

// observe() → all available actions at current state (no goal needed)
const actions = await stagehand.observe();

// agent() → fully autonomous multi-step loop
await stagehand.agent({
  task: "Explore this page and find any error states or broken interactions"
});
```
Add `explore-stagehand` skill variant as opt-in. Requires Browserbase account for cloud execution.

### D3: CI/CD GitHub Actions Integration
Standard workflow pattern:
```yaml
# .github/workflows/ralph-playwright.yml
on: [pull_request]
jobs:
  e2e:
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build && npm run dev &
      - run: npx claude --skill ralph-playwright:test-e2e
```

### D4: Ralph-Playwright MCP Server
If test state management becomes complex, a lightweight MCP server would expose:
- `get_story_results` — latest run results per story
- `update_story_status` — mark stories as approved/known-failure
- `list_stories` — enumerate all YAML files with metadata + last run status

Would follow the ralph-knowledge MCP pattern (Hono server, SQLite, npx install).

---

## Testing Strategy

### Phase 1 (Foundation):
- Manual: parse YAML files, read skills — no logic to test
- Check: all files are valid YAML/JSON

### Phase 2 (Story Generation):
- Manual: run `story-gen` against "a login page" description
- Verify: output contains ≥1 happy, ≥2 sad, ≥1 edge story
- Manual: run `explore` against https://playwright.dev (public, stable URL)
- Verify: produces valid YAML with correct schema

### Phase 3 (Story Execution):
- Manual: run `test-e2e` against example stories on any localhost app
- Verify: screenshots appear per step in `playwright-results/`
- Verify: a sad path story correctly fails when expected error not shown
- Manual: run `a11y-scan` on a page known to have issues

### Phase 4 (Storybook):
- Manual: requires a Storybook 9 project — run `storybook-test` against it
- Verify: per-story pass/fail reported with a11y violations

## References

- Research: `thoughts/shared/research/2026-03-19-agent-driven-ui-testing-stochastic-exploration.md`
- Bowser reference: https://github.com/disler/bowser
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- Playwright Test Agents: https://playwright.dev/docs/test-agents
- Storybook addon-mcp: https://github.com/storybookjs/addon-mcp
- A11y MCP: https://github.com/ronantakizawa/a11ymcp
- Stagehand: https://github.com/browserbase/stagehand
- Applitools Eyes Storybook: https://applitools.com/docs/eyes/sdks/storybook
- Chromatic: https://chromatic.com
