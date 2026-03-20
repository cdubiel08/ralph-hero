---
name: ralph-playwright:setup
description: One-time setup for ralph-playwright — installs required MCPs (Playwright, a11y, Storybook), validates browser installation, and creates playwright-stories/ directory. Use when setting up ralph-playwright for the first time or diagnosing a broken install.
---

# Ralph-Playwright Setup

Install and configure all MCP servers required by ralph-playwright skills.

## Step 1: Required MCP — Playwright (mandatory)

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
