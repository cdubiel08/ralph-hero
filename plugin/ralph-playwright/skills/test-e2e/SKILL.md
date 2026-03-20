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
