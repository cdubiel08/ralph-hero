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
