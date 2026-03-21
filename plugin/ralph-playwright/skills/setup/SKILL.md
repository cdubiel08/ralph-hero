---
name: ralph-playwright:setup
description: One-time setup for ralph-playwright — installs playwright-cli globally, validates browser installation, and creates playwright-stories/ directory. Use when setting up ralph-playwright for the first time or diagnosing a broken install.
---

# Ralph-Playwright Setup

Install and configure `playwright-cli` for ralph-playwright skills.

## Step 1: Install playwright-cli (required)

```bash
npm install -g @playwright/cli@latest
```

Verify installation:
```bash
playwright-cli --version
```
Must show a version. If the command is not found, the global install failed — check your npm prefix (`npm config get prefix`) and ensure it's on your PATH.

## Step 2: Install browser binaries

```bash
playwright-cli install-browser --browser chrome
```

## Step 3: Create story directory

In your project root:
```bash
mkdir -p playwright-stories
```

Story YAML files in `playwright-stories/` should be committed to git.

## Step 4: Verify `.gitignore` entries

Confirm these entries exist (added by ralph-playwright plugin):
```
# Root .gitignore
.playwright-cli/

# thoughts/.gitignore
local/
```

## Validation Checklist
- `playwright-cli --version` → prints a version
- `which playwright-cli` → resolves to a path
- `playwright-stories/` directory exists
- `.playwright-cli/` is in `.gitignore`

## Next Steps
- Browse directly: `/ralph-playwright:browser`
- Generate stories: `/ralph-playwright:story-gen`
- Explore a URL: `/ralph-playwright:explore http://localhost:3000`
- Run tests: `/ralph-playwright:test-e2e`
