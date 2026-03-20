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

- `@storybook/addon-vitest` found → **Vitest mode** (Storybook 9+, recommended)
- `@storybook/test-runner` found → **Legacy mode** (Storybook 7/8, still works with 9)
- Neither → show install instructions

### Install instructions (if neither found)
```bash
npm install -D @storybook/addon-vitest
```
Then add `@storybook/addon-vitest` to your `.storybook/main.js` addons array.

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
