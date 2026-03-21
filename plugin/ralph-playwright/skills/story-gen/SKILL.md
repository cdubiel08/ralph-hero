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
